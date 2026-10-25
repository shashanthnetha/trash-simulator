// Lane's End – the driving corridor continues north of the station as a
// sunken green lane between turf hedgebanks (terrain: landforms.ts LANES_END)
// and ends at a rusted five-bar gate standing open beside a cattle grid and a
// blank fingerpost, the lane fading on into the haze. This module dresses
// what the terrain provides: hawthorn and blackthorn scrub along both bank
// crests (instanced foliage cards, wind-sheared inland, dying back in places,
// thinning out past the gate into the fog), cow parsley and nettles at the
// lane foot, and the gate cluster – two chamfered granite gateposts with the
// sagging open gate on its hanging pins, a two-panel steel cattle grid over a
// dark silted pit, post-and-wire fences running from the grid to the hedges,
// a leaning fingerpost whose painted arms have weathered blank, a broken stone
// stile in the west bank and a faded "CATTLE GRID" sign. Colliders under the
// tag "lane"; the grid itself is never a blocker – the jeep rattles over it on
// the terrain.
//
// Budget: 7 draw calls in the main pass (hedge cards, herb cards, granite,
// steel, painted timber, bark stems, decals); ≈ 27k triangles on ultra, the
// hedge thins on medium/low. Placement is deterministic (fixed seeds).

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  addBoxCollider,
  addCylinderCollider,
  beginColliderSet,
  clearColliderSet,
} from "./colliders";
import { LANES_END, laneCentreX } from "./landforms";
import { clamp, fbm, mulberry32, smoothstep } from "./noise";
import {
  LANE_DECALS,
  hedgeCardAtlas,
  herbCardAtlas,
  laneDecalAtlas,
  pbrGranite,
  pbrLaneSteel,
  pbrPaintedTimber,
} from "./place-lanes-end-textures";
import type { Environment } from "./sky";
import { terrainHeight } from "./terrain";
import { applyPbr, hash01, pbrWood } from "./textures";
import type { QualityId } from "./types";

// ---------------------------------------------------------------------------
// Tiers and layout constants
// ---------------------------------------------------------------------------

interface LaneTier {
  /** Average foliage cards per hedge clump. */
  cards: number;
  /** Herb cards at the lane foot. */
  herbs: number;
  /** Woody stems under the clumps. */
  stems: boolean;
  cardShadow: boolean;
  herbShadow: boolean;
  /** Radial segments of the round steel. */
  seg: number;
  /**
   * Extra height of the cattle-grid deck over the analytic ground: the
   * rendered terrain mesh is coarser on lower tiers (6.8 m cells on low) and
   * can stand above the analytic surface between its vertices, which would
   * bury the bars.
   */
  deckLift: number;
}

const TIERS: Record<QualityId, LaneTier> = {
  ultra: {
    cards: 12,
    herbs: 280,
    stems: true,
    cardShadow: true,
    herbShadow: true,
    seg: 8,
    deckLift: 0.03,
  },
  high: {
    cards: 10,
    herbs: 220,
    stems: true,
    cardShadow: true,
    herbShadow: false,
    seg: 8,
    deckLift: 0.06,
  },
  medium: {
    cards: 7,
    herbs: 140,
    stems: true,
    cardShadow: true,
    herbShadow: false,
    seg: 6,
    deckLift: 0.14,
  },
  low: {
    cards: 5,
    herbs: 80,
    stems: false,
    cardShadow: false,
    herbShadow: false,
    seg: 6,
    deckLift: 0.3,
  },
};

const GX = LANES_END.gate.x;
const GZ = LANES_END.gate.z;
/** Hedge crest offset from the lane centre (landforms.ts bank mask). */
const CREST = 22;
const HEDGE_Z0 = 305;
const HEDGE_Z1 = 430;
/** Bodies are clamped at z ≤ 378 – nothing beyond needs a collider. */
const REACH_Z = 382;
/** West-bank stone stile (the hedge opens above it). */
const STILE_Z = 350;
/** Hinge and slam posts of the bypass gate, grid extents (world x). */
const HINGE_X = GX - 7;
const SLAM_X = GX - 2.7;
const GRID_X0 = GX - 2.2;
const GRID_X1 = GX + 5.8;
const GRID_HZ = 1.3;
const STRAINER_X = GRID_X1 + 0.6;
/** Gate leaf: length, open yaw (swung back ~110° from closed, tip to +z). */
const GATE_LEN = 4.2;
const GATE_YAW = -1.92;
/**
 * Long-term wind shear of the scrub: the sea lies to the south, so the crowns
 * lean inland (+z), skewed east with the prevailing wind of the dune grass.
 */
const LEAN_X = 0.5525;
const LEAN_Z = 0.8335;

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

interface ClumpDef {
  x: number;
  z: number;
  y: number;
  /** Crown height above the crest (m). */
  h: number;
  /** Width across the hedge (m). */
  w: number;
  /** Length along the hedge (m). */
  l: number;
  dead: boolean;
  /** 0 = hawthorn, 1 = blackthorn (atlas half). */
  species: number;
  tint: number;
  phase: number;
  /** Alpha erosion toward the far end (1 = solid). */
  fade: number;
  side: number;
}

interface HerbDef {
  x: number;
  z: number;
  y: number;
  h: number;
  /** 0 = cow parsley, 1 = nettle. */
  species: number;
  tint: number;
  phase: number;
  yaw: number;
}

/**
 * Deterministic hedge along both crest lines: a coarse vitality noise decides
 * how vigorous the scrub is (low = died back to a low brown stool), the
 * species come in runs, and past the gate the line thins out into the fog.
 * Spacing follows the clump size so the crowns overlap into one hedge.
 */
function placeHedge(): ClumpDef[] {
  const rng = mulberry32(0x4ed6e5);
  const out: ClumpDef[] = [];
  for (const side of [-1, 1]) {
    let z = HEDGE_Z0 + rng() * 1.5;
    while (z < HEDGE_Z1) {
      const cx = laneCentreX(z) + side * CREST;
      const vitN = fbm(z * 0.05 + (side > 0 ? 7.3 : 41.9), 3.7 + side, 2);
      let vit = smoothstep(0.22, 0.5, vitN);
      if (side < 0 && Math.abs(z - STILE_Z) < 1.3) vit = 0;
      const thin = 1 - smoothstep(398, 432, z);
      const dead = vit < 0.15;
      const skip = rng() > 0.3 + 0.7 * thin || (dead && rng() < 0.3);
      const h = dead
        ? 0.5 + rng() * 0.35
        : clamp(1.2 + vit * (0.4 + rng() * 0.8) + rng() * 0.25, 1.2, 2.5);
      if (!skip) {
        const x = cx + (rng() - 0.5) * 1.2;
        const zz = z + (rng() - 0.5) * 0.3;
        const species =
          fbm(z * 0.07 + side * 3.1, 9.1, 2) > 0.43 || dead ? 1 : 0;
        out.push({
          x,
          z: zz,
          y: terrainHeight(x, zz),
          h,
          w: h * (dead ? 1.3 : 1.1 + rng() * 0.3),
          l: h * (0.7 + rng() * 0.3),
          dead,
          species,
          tint: rng(),
          phase: rng(),
          fade: 1 - 0.8 * smoothstep(404, 432, z),
          side,
        });
      }
      // Crowns overlap into one continuous hedge (a third of the height)
      z += dead ? 0.9 + rng() * 0.6 : h * 0.3 + rng() * 0.2 + 0.1;
    }
  }
  return out;
}

/**
 * Herbs at the lane foot (bank toe and lower slope, both sides): cow parsley
 * and nettle in patches, plus nettle beds on the crest where the hedge has
 * died back. Budgeted by the quality tier.
 */
function placeHerbs(count: number, clumps: ClumpDef[]): HerbDef[] {
  const rng = mulberry32(0x8e7b21);
  const out: HerbDef[] = [];
  for (const c of clumps) {
    if (!c.dead || c.z > 400) continue;
    for (let k = 0; k < 2; k++) {
      const x = c.x + (rng() - 0.5) * 1.6;
      const z = c.z + (rng() - 0.5) * 1.4;
      out.push({
        x,
        z,
        y: terrainHeight(x, z),
        h: 0.55 + rng() * 0.35,
        species: 1,
        tint: rng(),
        phase: rng(),
        yaw: rng() * Math.PI * 2,
      });
    }
  }
  let guard = 0;
  while (out.length < count && guard++ < count * 8) {
    const side = rng() < 0.5 ? -1 : 1;
    const z = 302 + rng() * 104;
    const a = 16.4 + rng() ** 1.4 * 4.2;
    const x = laneCentreX(z) + side * a;
    const cluster = fbm(z * 0.06 + side * 5.5, 2.2, 2);
    if (rng() > 0.3 + 0.7 * smoothstep(0.3, 0.5, cluster)) continue;
    // Keep the grid, gate and fence line readable
    if (Math.abs(z - GZ) < 2.2 && x > HINGE_X - 1 && x < STRAINER_X + 1)
      continue;
    const nettle = fbm(z * 0.09 + 17.1, side * 4.4, 2) > 0.4;
    out.push({
      x,
      z,
      y: terrainHeight(x, z),
      h: nettle ? 0.6 + rng() * 0.4 : 0.8 + rng() * 0.5,
      species: nettle ? 1 : 0,
      tint: rng(),
      phase: rng(),
      yaw: rng() * Math.PI * 2,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// GLSL – wind sway of the cards (via onBeforeCompile)
// ---------------------------------------------------------------------------

/** Uniforms, per-instance attributes and gust noise – both card materials. */
const LANE_WIND_PARS = /* glsl */ `
uniform float uTime;
uniform float uWindAmp;
uniform float uGustSpeed;
uniform vec2 uWindDir;
uniform float uFlutterFreq;
uniform float uFlutterAmp;
uniform float uRooted;
attribute vec4 aClump;
attribute vec4 aCard;
attribute vec3 aCNrm;
float lnHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float lnNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = lnHash(i);
  float b = lnHash(i + vec2(1.0, 0.0));
  float c = lnHash(i + vec2(0.0, 1.0));
  float d = lnHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
`;

const LANE_VARY_PARS = /* glsl */ `
varying float vLTint;
varying float vLDead;
varying float vLFade;
varying float vLShade;
`;

/**
 * Card sway (also in the depth material): a gust field travelling with the
 * wind over the whole lane, a slow per-clump oscillation always leaning
 * downwind, scaled by the card's height in its clump (aClump.y) – or, for the
 * rooted herbs (uRooted = 1), by the square of the height along the card so
 * the base stays in the ground – plus a high-frequency leaf flutter along the
 * card normal. aClump.z = 1/instance scale (transpose(rot) carries a factor
 * s, hence 1/s²).
 */
const LANE_CARD_WIND = /* glsl */ `
#ifdef USE_INSTANCING
mat3 lRot = mat3(instanceMatrix);
vec3 lBase = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
#else
mat3 lRot = mat3(1.0);
vec3 lBase = modelMatrix[3].xyz;
#endif
vec2 lGp = lBase.xz * 0.02 - uWindDir * uTime * uGustSpeed;
float lGust = 0.3 + 0.7 * smoothstep(0.2, 0.8, lnNoise(lGp) * 0.6 + lnNoise(lGp * 2.7 + 11.3) * 0.4);
float lOsc = 0.4 + sin(uTime * 2.1 + aClump.x * 6.2832) * 0.42 + sin(uTime * 4.7 + aClump.x * 9.0) * 0.18;
float lRoot = mix(1.0, uv.y * uv.y, uRooted);
float lProf = aClump.y * lRoot;
vec3 lSwayW = vec3(uWindDir.x, 0.0, uWindDir.y) * (uWindAmp * lGust * lOsc * lProf);
float lInvS = aClump.z;
transformed += (transpose(lRot) * lSwayW) * (lInvS * lInvS);
float lFl = sin(uTime * uFlutterFreq + aCard.x * 21.0 + position.x * 5.0 + position.y * 4.0);
transformed += aCNrm * (lFl * uFlutterAmp * lInvS * (0.3 + 0.7 * clamp(length(position.xy), 0.0, 1.0)) * mix(1.0, uv.y, uRooted));
`;

/** Visible material only: per-instance tint, dead-wood flag, fade, shade. */
const LANE_CARD_VARY = /* glsl */ `
vLTint = aClump.w;
vLDead = step(1.5, aCard.y);
vLShade = 0.74 + 0.26 * clamp(aCard.y - vLDead * 2.0, 0.0, 1.0);
vLFade = aCard.w;
`;

const LANE_FRAG_PARS = /* glsl */ `
uniform float uLWet;
varying float vLTint;
varying float vLDead;
varying float vLFade;
varying float vLShade;
`;

/** Far-end erosion: the last clumps dissolve into the haze via the alpha test. */
const LANE_FRAG_ALPHA = /* glsl */ `
diffuseColor.a *= vLFade;
`;

/**
 * Per-clump hue (yellow-green ↔ blue-green), interior cards darker, died-back
 * scrub dry and brown, rain darkening.
 */
const LANE_FRAG_COLOR = /* glsl */ `
vec3 lCol = diffuseColor.rgb * mix(vec3(1.08, 1.03, 0.86), vec3(0.86, 0.98, 1.06), vLTint) * vLShade;
lCol = mix(lCol, (lCol * vec3(1.5, 1.15, 0.72) + vec3(0.05, 0.035, 0.02)) * 0.7, vLDead);
diffuseColor.rgb = lCol * mix(1.0, 0.62, uLWet * 0.65);
`;

const LANE_FRAG_ROUGH = /* glsl */ `
roughnessFactor = mix(roughnessFactor, 0.66, uLWet * 0.7);
`;

/** Atlas half selection (two species per texture). */
const LANE_UV = /* glsl */ `
#include <uv_vertex>
#ifdef USE_MAP
vMapUv.x = vMapUv.x * 0.5 + aCard.z;
#endif
`;

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const M = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const E = new THREE.Euler();
const V = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);
const TV = new THREE.Vector3();
const TQ = new THREE.Quaternion();

/** Rotate (Euler XYZ) and translate a geometry – in place. */
function place(
  g: THREE.BufferGeometry,
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
): THREE.BufferGeometry {
  E.set(rx, ry, rz, "XYZ");
  Q.setFromEuler(E);
  V.set(x, y, z);
  M.compose(V, Q, ONE);
  g.applyMatrix4(M);
  return g;
}

/**
 * Box whose face UVs are in metres × `tile` (default 1 m per texture tile), so
 * a long kerb or rail does not stretch one tile over its whole length.
 */
function boxMetres(
  w: number,
  h: number,
  d: number,
  tile = 1,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  // Face order +x, -x, +y, -y, +z, -z; four vertices each
  const dims: Array<[number, number]> = [
    [d, h],
    [d, h],
    [w, d],
    [w, d],
    [w, h],
    [w, h],
  ];
  for (let f = 0; f < 6; f++) {
    for (let i = f * 4; i < f * 4 + 4; i++) {
      uv.setXY(
        i,
        uv.getX(i) * dims[f][0] * tile,
        uv.getY(i) * dims[f][1] * tile,
      );
    }
  }
  return g;
}

/** Cylinder from a to b (r0 at a, r1 at b); u around, v along the axis in m. */
function cylBetween(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  r0: number,
  seg: number,
  r1 = r0,
  closed = true,
): THREE.BufferGeometry {
  const len = Math.hypot(bx - ax, by - ay, bz - az) || 1e-4;
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, !closed);
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  const around = Math.max(1, Math.round(r0 * Math.PI * 4));
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * around, uv.getY(i) * len * 0.8);
  }
  TV.set(bx - ax, by - ay, bz - az).normalize();
  TQ.setFromUnitVectors(UP, TV);
  g.applyQuaternion(TQ);
  g.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  return g;
}

/**
 * Granite gatepost: square section with chamfered arrises, a chamfered cap
 * and a flat top, from `bottom` (buried) to `top`. u runs around the post in
 * metres, v is the height, so the 1 m granite tile reads at true scale.
 */
function chamferedPost(
  w: number,
  top: number,
  bottom: number,
  ch: number,
): THREE.BufferGeometry {
  const hw = w / 2;
  const ring: Array<[number, number]> = [
    [-hw + ch, -hw],
    [hw - ch, -hw],
    [hw, -hw + ch],
    [hw, hw - ch],
    [hw - ch, hw],
    [-hw + ch, hw],
    [-hw, hw - ch],
    [-hw, -hw + ch],
  ];
  const capH = 0.09;
  const inset = 0.07;
  const yCap = top - capH;
  const ringTop = ring.map(
    ([x, z]) =>
      [(x * (hw - inset)) / hw, (z * (hw - inset)) / hw] as [number, number],
  );
  const pos: number[] = [];
  const uv: number[] = [];
  const push = (x: number, y: number, z: number, u: number, v: number) => {
    pos.push(x, y, z);
    uv.push(u, v);
  };
  let perim = 0;
  for (let i = 0; i < 8; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % 8];
    const a2 = ringTop[i];
    const b2 = ringTop[(i + 1) % 8];
    const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const u0 = perim;
    const u1 = perim + segLen;
    // Side: (a_bottom, a_top, b_bottom), (a_top, b_top, b_bottom)
    push(a[0], bottom, a[1], u0, bottom);
    push(a[0], yCap, a[1], u0, yCap);
    push(b[0], bottom, b[1], u1, bottom);
    push(a[0], yCap, a[1], u0, yCap);
    push(b[0], yCap, b[1], u1, yCap);
    push(b[0], bottom, b[1], u1, bottom);
    // Cap chamfer
    push(a[0], yCap, a[1], u0, yCap);
    push(a2[0], top, a2[1], u0, top);
    push(b[0], yCap, b[1], u1, yCap);
    push(a2[0], top, a2[1], u0, top);
    push(b2[0], top, b2[1], u1, top);
    push(b[0], yCap, b[1], u1, yCap);
    // Flat top (fan, +y)
    push(0, top, 0, 0.5, 0.5);
    push(b2[0], top, b2[1], 0.5 + b2[0], 0.5 + b2[1]);
    push(a2[0], top, a2[1], 0.5 + a2[0], 0.5 + a2[1]);
    perim = u1;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/**
 * Prism from a convex polygon in the xy plane (CCW seen from +z), `th` thick
 * along z. Front/back u = x, v = y; sides u along the edge, v across.
 */
function prism(
  pts: ReadonlyArray<readonly [number, number]>,
  th: number,
): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const hz = th / 2;
  const push = (x: number, y: number, z: number, u: number, v: number) => {
    pos.push(x, y, z);
    uv.push(u, v);
  };
  const n = pts.length;
  for (let i = 1; i + 1 < n; i++) {
    push(pts[0][0], pts[0][1], hz, pts[0][0], pts[0][1]);
    push(pts[i][0], pts[i][1], hz, pts[i][0], pts[i][1]);
    push(pts[i + 1][0], pts[i + 1][1], hz, pts[i + 1][0], pts[i + 1][1]);
    push(pts[0][0], pts[0][1], -hz, pts[0][0], pts[0][1]);
    push(pts[i + 1][0], pts[i + 1][1], -hz, pts[i + 1][0], pts[i + 1][1]);
    push(pts[i][0], pts[i][1], -hz, pts[i][0], pts[i][1]);
  }
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    push(a[0], a[1], hz, 0, 0);
    push(a[0], a[1], -hz, 0, th);
    push(b[0], b[1], hz, len, 0);
    push(a[0], a[1], -hz, 0, th);
    push(b[0], b[1], -hz, len, th);
    push(b[0], b[1], hz, len, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/** Hash jitter of the vertices about the local origin (rough-hewn stone). */
function roughen(geo: THREE.BufferGeometry, amp: number, seed: number): void {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const k =
      1 +
      (hash01(
        Math.round(x * 200) + 17 * Math.round(y * 200),
        Math.round(z * 200),
        seed,
      ) -
        0.5) *
        2 *
        amp;
    pos.setXYZ(i, x * k, y * k, z * k);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

/**
 * Slide a geometry's UVs by a hashed offset so identical parts (grid bars,
 * gate rails) do not repeat the same rust patch in the same place.
 */
function uvShift(
  geo: THREE.BufferGeometry,
  seed: number,
): THREE.BufferGeometry {
  const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
  const du = hash01(seed, 11, 0x51);
  const dv = hash01(seed, 29, 0x52) * 4;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) + du, uv.getY(i) + dv);
  }
  return geo;
}

/** Remap a geometry's 0..1 UVs into a rectangle of the decal atlas. */
function remapUv(
  geo: THREE.BufferGeometry,
  r: { u0: number; v0: number; u1: number; v1: number },
): THREE.BufferGeometry {
  const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(
      i,
      r.u0 + uv.getX(i) * (r.u1 - r.u0),
      r.v0 + uv.getY(i) * (r.v1 - r.v0),
    );
  }
  return geo;
}

/**
 * One foliage card: two quads crossed at 90°, each with a lengthwise fold
 * (8 triangles), spanning ±1 in x and y with uv 0..1. Normals are placeholders
 * – the materials replace them with the per-instance aCNrm.
 */
function buildCardGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const cols = [-1, 0, 1];
  const rows = [-1, 1];
  for (let q = 0; q < 2; q++) {
    const yawQ = (q * Math.PI) / 2;
    const cy = Math.cos(yawQ);
    const sy = Math.sin(yawQ);
    const start = pos.length / 3;
    for (let ri = 0; ri < rows.length; ri++) {
      for (let ci = 0; ci < cols.length; ci++) {
        const lx = cols[ci];
        const ly = rows[ri];
        const lz = ci === 1 ? 0.2 : 0;
        pos.push(lx * cy + lz * sy, ly, -lx * sy + lz * cy);
        nrm.push(0, 1, 0);
        uv.push((lx + 1) / 2, (ly + 1) / 2);
      }
    }
    for (let ci = 0; ci < 2; ci++) {
      const a = start + ci;
      const b = start + 3 + ci;
      idx.push(a, a + 1, b + 1, a, b + 1, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// ---------------------------------------------------------------------------
// Geometry bag – one merged mesh per material
// ---------------------------------------------------------------------------

type LaneMat = "granite" | "steel" | "timber" | "bark" | "core" | "decal";

class LaneBag {
  private readonly lists = new Map<LaneMat, THREE.BufferGeometry[]>();

  add(key: LaneMat, g: THREE.BufferGeometry): void {
    let geo = g;
    if (g.index) {
      geo = g.toNonIndexed();
      g.dispose();
    }
    if (!geo.getAttribute("normal")) geo.computeVertexNormals();
    for (const name of Object.keys(geo.attributes)) {
      if (name !== "position" && name !== "normal" && name !== "uv")
        geo.deleteAttribute(name);
    }
    let list = this.lists.get(key);
    if (!list) {
      list = [];
      this.lists.set(key, list);
    }
    list.push(geo);
  }

  build(mats: Record<LaneMat, THREE.Material>): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [key, list] of this.lists) {
      if (list.length === 0) continue;
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged)
        throw new Error(`Lane's End: mergeGeometries (${key}) failed`);
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mats[key]);
      mesh.name = `lane-${key}`;
      mesh.castShadow = key !== "decal";
      mesh.receiveShadow = true;
      out.push(mesh);
    }
    this.lists.clear();
    return out;
  }
}

/** Card instance record shared by hedge and herb builders. */
interface CardInst {
  m: THREE.Matrix4;
  phase: number;
  prof: number;
  invS: number;
  tint: number;
  flutter: number;
  /** inner 0..1 (+2 when dead). */
  shade: number;
  uvOff: number;
  fade: number;
  nrm: THREE.Vector3;
}

interface CardUniforms {
  uTime: THREE.IUniform<number>;
  uWindAmp: THREE.IUniform<number>;
  uGustSpeed: THREE.IUniform<number>;
  uWindDir: THREE.IUniform<THREE.Vector2>;
  uFlutterFreq: THREE.IUniform<number>;
  uFlutterAmp: THREE.IUniform<number>;
  uRooted: THREE.IUniform<number>;
  uLWet: THREE.IUniform<number>;
}

// ---------------------------------------------------------------------------
// Lane's End
// ---------------------------------------------------------------------------

export class LanesEnd {
  protected readonly parent: THREE.Group;
  protected readonly quality: QualityId;

  private readonly group = new THREE.Group();
  private readonly tier: LaneTier;
  private readonly windDir = new THREE.Vector2(1, 0);
  private readonly uHedge: CardUniforms;
  private readonly uHerb: CardUniforms;
  private readonly disposables: Array<{ dispose(): void }> = [];
  /** Full-size texture sheets on ultra/high, halved on medium/low. */
  private readonly hi: boolean;
  private hedgeMesh: THREE.InstancedMesh | null = null;
  private herbMesh: THREE.InstancedMesh | null = null;
  private wet = 0;
  private wetInit = false;
  /** Boot cost (ms): texture generation alone, and the whole construction. */
  readonly textureMs: number;
  readonly buildMs: number;

  constructor(parent: THREE.Group, quality: QualityId) {
    this.parent = parent;
    this.quality = quality;
    this.tier = TIERS[quality];
    this.hi = quality === "ultra" || quality === "high";
    this.uHedge = this.makeUniforms(0);
    this.uHerb = this.makeUniforms(1);
    this.group.name = "lanesEnd";
    parent.add(this.group);

    const t0 = performance.now();
    const hi = this.hi;
    hedgeCardAtlas(hi);
    herbCardAtlas(hi);
    pbrGranite(hi);
    pbrLaneSteel(hi);
    pbrPaintedTimber(hi);
    laneDecalAtlas(hi);
    this.textureMs = performance.now() - t0;

    beginColliderSet("lane");
    const clumps = placeHedge();
    const herbs = placeHerbs(this.tier.herbs, clumps);
    this.buildHedge(clumps);
    this.buildHerbs(herbs);
    this.buildCluster(clumps);
    this.buildMs = performance.now() - t0;
  }

  private makeUniforms(rooted: number): CardUniforms {
    return {
      uTime: { value: 0 },
      uWindAmp: { value: 0.01 },
      uGustSpeed: { value: 1 },
      uWindDir: { value: this.windDir },
      uFlutterFreq: { value: 6 },
      uFlutterAmp: { value: 0.01 },
      uRooted: { value: rooted },
      uLWet: { value: 0 },
    };
  }

  // -------------------------------------------------------------------------
  // Card materials
  // -------------------------------------------------------------------------

  private cardMaterial(
    tex: THREE.Texture,
    u: CardUniforms,
    key: string,
  ): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      alphaTest: 0.35,
      side: THREE.DoubleSide,
      roughness: 0.86,
      metalness: 0,
    });
    mat.customProgramCacheKey = () => key;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.vertexShader =
        `${LANE_WIND_PARS}${LANE_VARY_PARS}${shader.vertexShader}`
          .replace(
            "#include <beginnormal_vertex>",
            // Outward clump normal blended toward up: pure side-lighting turns
            // the shadow side of a leaf card into a black pancake.
            "#include <beginnormal_vertex>\nobjectNormal = normalize(mix(aCNrm, vec3(0.0, 1.0, 0.0), 0.6));",
          )
          .replace("#include <uv_vertex>", LANE_UV)
          .replace(
            "#include <begin_vertex>",
            `#include <begin_vertex>\n${LANE_CARD_WIND}${LANE_CARD_VARY}`,
          );
      shader.fragmentShader = `${LANE_FRAG_PARS}${shader.fragmentShader}`
        .replace(
          "#include <normal_fragment_begin>",
          // The clump normal is a lighting fiction shared by both faces of a
          // card: undo the double-sided flip, or every card seen from behind
          // lights as if it faced the ground.
          "#include <normal_fragment_begin>\nnormal = normalize(vNormal);\nnonPerturbedNormal = normal;",
        )
        .replace(
          "#include <alphatest_fragment>",
          `${LANE_FRAG_ALPHA}#include <alphatest_fragment>`,
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>\n${LANE_FRAG_COLOR}`,
        )
        .replace(
          "#include <roughnessmap_fragment>",
          `#include <roughnessmap_fragment>\n${LANE_FRAG_ROUGH}`,
        );
    };
    this.disposables.push(mat);
    return mat;
  }

  /** Depth material with the same sway and atlas half (shadow casting). */
  private cardDepthMaterial(
    tex: THREE.Texture,
    u: CardUniforms,
    key: string,
  ): THREE.MeshDepthMaterial {
    const depth = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      map: tex,
      alphaTest: 0.35,
      side: THREE.DoubleSide,
    });
    depth.customProgramCacheKey = () => key;
    depth.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.vertexShader = `${LANE_WIND_PARS}${shader.vertexShader}`
        .replace("#include <uv_vertex>", LANE_UV)
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>\n${LANE_CARD_WIND}`,
        );
    };
    this.disposables.push(depth);
    return depth;
  }

  private cardMesh(
    cards: CardInst[],
    tex: THREE.Texture,
    u: CardUniforms,
    key: string,
    shadow: boolean,
  ): THREE.InstancedMesh {
    const geo = buildCardGeometry();
    const mesh = new THREE.InstancedMesh(
      geo,
      this.cardMaterial(tex, u, key),
      Math.max(cards.length, 1),
    );
    const aClump = new Float32Array(cards.length * 4);
    const aCard = new Float32Array(cards.length * 4);
    const aCNrm = new Float32Array(cards.length * 3);
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      mesh.setMatrixAt(i, c.m);
      aClump[i * 4] = c.phase;
      aClump[i * 4 + 1] = c.prof;
      aClump[i * 4 + 2] = c.invS;
      aClump[i * 4 + 3] = c.tint;
      aCard[i * 4] = c.flutter;
      aCard[i * 4 + 1] = c.shade;
      aCard[i * 4 + 2] = c.uvOff;
      aCard[i * 4 + 3] = c.fade;
      aCNrm[i * 3] = c.nrm.x;
      aCNrm[i * 3 + 1] = c.nrm.y;
      aCNrm[i * 3 + 2] = c.nrm.z;
    }
    geo.setAttribute("aClump", new THREE.InstancedBufferAttribute(aClump, 4));
    geo.setAttribute("aCard", new THREE.InstancedBufferAttribute(aCard, 4));
    geo.setAttribute("aCNrm", new THREE.InstancedBufferAttribute(aCNrm, 3));
    mesh.count = cards.length;
    mesh.castShadow = shadow;
    mesh.receiveShadow = false;
    if (shadow) {
      mesh.customDepthMaterial = this.cardDepthMaterial(tex, u, `${key}-depth`);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.name = key;
    this.group.add(mesh);
    this.disposables.push(geo, mesh);
    return mesh;
  }

  // -------------------------------------------------------------------------
  // Hedge
  // -------------------------------------------------------------------------

  /**
   * Cards fill a wind-sheared ellipsoid over each clump (the crown shifted
   * inland with height), biased to the shell so the hedge has a surface;
   * roughly upright with a random yaw and tilt because the atlas sprigs grow
   * upward. Interior cards are darker, the far end erodes into the haze.
   */
  private buildHedge(clumps: ClumpDef[]): void {
    const cards: CardInst[] = [];
    const cfg = this.tier;
    const world = new THREE.Vector3();
    const centre = new THREE.Vector3();
    for (let i = 0; i < clumps.length; i++) {
      const c = clumps[i];
      const rng = mulberry32(0x1c3a5 + i * 7919);
      const n = Math.max(
        2,
        Math.round(
          cfg.cards *
            (0.8 + 0.4 * rng()) *
            (0.6 + 0.4 * (c.h / 2.5)) *
            (c.dead ? 0.4 : 1),
        ),
      );
      // Foliage right down to the bank – a hedge, not shrubs on stems
      const base = c.y + 0.1;
      const crownH = c.h - 0.1;
      centre.set(c.x, base + crownH * 0.5, c.z);
      // Along-hedge axis follows the crest line locally
      const dxdz = (laneCentreX(c.z + 1) - laneCentreX(c.z - 1)) / 2;
      const alen = Math.hypot(dxdz, 1);
      const ax = dxdz / alen;
      const az = 1 / alen;
      const shear = c.dead ? 0.1 : 0.32;
      for (let k = 0; k < n; k++) {
        const rr = 0.35 + 0.65 * Math.sqrt(rng());
        const th = rng() * Math.PI * 2;
        const ph = Math.acos(1 - 2 * rng());
        const ex = Math.sin(ph) * Math.cos(th) * rr;
        const ey = Math.cos(ph) * rr;
        const ez = Math.sin(ph) * Math.sin(th) * rr;
        const along = ex * (c.l * 0.5);
        const across = ez * (c.w * 0.5);
        const up = ey * crownH * 0.5;
        const yRel = (up + crownH * 0.5) / crownH;
        world.set(
          c.x + ax * along - az * across + LEAN_X * shear * c.h * yRel,
          base + crownH * 0.5 + up,
          c.z + az * along + ax * across + LEAN_Z * shear * c.h * yRel,
        );
        const s =
          (0.42 + 0.3 * rng()) * (0.7 + 0.3 * (c.h / 2.5)) * (c.dead ? 0.8 : 1);
        const quat = new THREE.Quaternion().setFromEuler(
          new THREE.Euler(
            (rng() - 0.5) * 0.9,
            rng() * Math.PI * 2,
            (rng() - 0.5) * 0.9,
          ),
        );
        const nrmW = world
          .clone()
          .sub(centre)
          .add(new THREE.Vector3(0, crownH * 0.3, 0));
        if (nrmW.lengthSq() < 1e-4) nrmW.set(0, 1, 0);
        nrmW.normalize();
        cards.push({
          m: new THREE.Matrix4().compose(
            world.clone(),
            quat,
            new THREE.Vector3(s, s, s),
          ),
          phase: c.phase,
          prof: (0.15 + 0.85 * yRel) ** 1.5 * (c.dead ? 0.5 : 1),
          invS: 1 / s,
          tint: c.species === 1 ? 0.7 + 0.3 * c.tint : c.tint,
          flutter: rng(),
          shade: clamp(rr, 0, 1) + (c.dead ? 2 : 0),
          uvOff: c.species === 1 ? 0.5 : 0,
          fade: c.fade,
          nrm: nrmW.applyQuaternion(quat.clone().invert()),
        });
      }
    }
    this.hedgeMesh = this.cardMesh(
      cards,
      hedgeCardAtlas(this.hi),
      this.uHedge,
      "laneHedge",
      cfg.cardShadow,
    );
  }

  private buildHerbs(herbs: HerbDef[]): void {
    const cards: CardInst[] = [];
    const rng = mulberry32(0x77a1);
    for (const hb of herbs) {
      const s = hb.h * 0.5;
      const quat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler((rng() - 0.5) * 0.16, hb.yaw, (rng() - 0.5) * 0.16),
      );
      cards.push({
        m: new THREE.Matrix4().compose(
          new THREE.Vector3(hb.x, hb.y + s - 0.04, hb.z),
          quat,
          new THREE.Vector3(
            s * (0.85 + rng() * 0.3),
            s,
            s * (0.85 + rng() * 0.3),
          ),
        ),
        phase: hb.phase,
        prof: 1,
        invS: 1 / s,
        tint: hb.tint,
        flutter: rng(),
        shade: 0.85,
        uvOff: hb.species === 1 ? 0.5 : 0,
        fade: 1,
        nrm: new THREE.Vector3(0, 0.35, 1).normalize(),
      });
    }
    this.herbMesh = this.cardMesh(
      cards,
      herbCardAtlas(this.hi),
      this.uHerb,
      "laneHerbs",
      this.tier.herbShadow,
    );
  }

  // -------------------------------------------------------------------------
  // Gate cluster
  // -------------------------------------------------------------------------

  private makeMaterials(): Record<LaneMat, THREE.Material> {
    const hi = this.hi;
    const granite = new THREE.MeshStandardMaterial();
    applyPbr(granite, pbrGranite(hi));
    const steel = new THREE.MeshStandardMaterial();
    applyPbr(steel, pbrLaneSteel(hi));
    const timber = new THREE.MeshStandardMaterial();
    applyPbr(timber, pbrPaintedTimber(hi));
    const bark = new THREE.MeshStandardMaterial();
    applyPbr(bark, pbrWood("branch"));
    // Hedge core: the dark tangle of stems behind the leaf cards – the bark
    // set tinted to a shadowed olive-brown, seen from the lane and the field
    const core = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
    applyPbr(core, pbrWood("branch"), [1, 1]);
    core.color.setHex(0x4e5a36);
    // Blended, not alpha-tested: the wheel ruts and grass median need soft
    // edges on the sand; the sign faces and the pit are opaque in alpha anyway
    const decal = new THREE.MeshStandardMaterial({
      map: laneDecalAtlas(hi),
      transparent: true,
      depthWrite: false,
      alphaTest: 0.02,
      roughness: 0.7,
      metalness: 0.05,
      side: THREE.DoubleSide,
    });
    const mats = { granite, steel, timber, bark, core, decal };
    this.disposables.push(granite, steel, timber, bark, core, decal);
    return mats;
  }

  private buildCluster(clumps: ClumpDef[]): void {
    const bag = new LaneBag();
    const seg = this.tier.seg;
    this.buildHedgeCore(bag);
    this.buildTrack(bag);
    if (this.tier.stems) this.buildStems(bag, clumps);
    this.buildGateposts(bag, seg);
    this.buildGate(bag, seg);
    this.buildGrid(bag, seg);
    this.buildFences(bag);
    this.buildFingerpost(bag);
    this.buildSign(bag, seg);
    this.buildStile(bag);
    this.hedgeColliders(clumps);
    const meshes = bag.build(this.makeMaterials());
    for (const m of meshes) {
      this.group.add(m);
      this.disposables.push(m.geometry);
    }
  }

  /**
   * Continuous hedge core along both crests: a low ridge of dark stem tangle
   * behind the leaf cards, so a gap between crowns shows the inside of the
   * hedge and not the sky. Follows the same vitality noise as the clumps
   * (lower where the hedge died back, open over the stile, gone into the fog).
   */
  private buildHedgeCore(bag: LaneBag): void {
    const STEP = 1.5;
    for (const side of [-1, 1]) {
      const pos: number[] = [];
      const uv: number[] = [];
      const idx: number[] = [];
      let row = 0;
      for (let z = HEDGE_Z0 - 1; z <= HEDGE_Z1 + 2; z += STEP, row++) {
        const cx = laneCentreX(z) + side * CREST;
        const y = terrainHeight(cx, z);
        const vitN = fbm(z * 0.05 + (side > 0 ? 7.3 : 41.9), 3.7 + side, 2);
        let vit = smoothstep(0.22, 0.5, vitN);
        if (side < 0 && Math.abs(z - STILE_Z) < 1.3) vit = 0;
        const thin = 1 - smoothstep(402, 428, z);
        const hCore =
          (vit < 0.15 ? 0.28 : 0.5 + 0.55 * vit) *
          thin *
          (z < HEDGE_Z0 ? 0.4 : 1);
        const half = vit < 0.15 ? 0.55 : 0.85;
        const dxdz = (laneCentreX(z + 1) - laneCentreX(z - 1)) / 2;
        const len = Math.hypot(1, dxdz);
        const nx = 1 / len;
        const nz = -dxdz / len;
        const u = z * 0.5;
        pos.push(cx - nx * half, y - 0.35, z - nz * half);
        uv.push(u, 0);
        pos.push(cx + nx * 0.05 * side, y + hCore, z);
        uv.push(u, 0.5);
        pos.push(cx + nx * half, y - 0.35, z + nz * half);
        uv.push(u, 1);
        if (row > 0) {
          const a = (row - 1) * 3;
          const b = row * 3;
          idx.push(a, b, a + 1, a + 1, b, b + 1);
          idx.push(a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      bag.add("core", g);
    }
  }

  /**
   * The used track down the lane: a terrain-hugging ribbon carrying the rut
   * and grass-median decal, wandering a little as driving lines do and
   * pulling over to the grid at the gate. 4 m segments so the decal tiles.
   */
  private buildTrack(bag: LaneBag): void {
    const Z0 = 294;
    const Z1 = 434;
    const SEG = 4;
    const gridCx = (GRID_X0 + GRID_X1) / 2;
    const trackX = (z: number): number => {
      const natural = laneCentreX(z) + Math.sin(z * 0.045) * 0.9;
      const toGrid = smoothstep(336, 364, z) * (1 - smoothstep(380, 402, z));
      return natural + (gridCx - natural) * toGrid;
    };
    const cols = [-1.8, -0.6, 0.6, 1.8];
    for (let zs = Z0; zs < Z1; zs += SEG) {
      const pos: number[] = [];
      const uv: number[] = [];
      const idx: number[] = [];
      for (let r = 0; r < 3; r++) {
        const z = zs + (r * SEG) / 2;
        const tx = trackX(z);
        const dxdz = (trackX(z + 1) - trackX(z - 1)) / 2;
        const len = Math.hypot(1, dxdz);
        const nx = 1 / len;
        const nz = -dxdz / len;
        for (let c = 0; c < cols.length; c++) {
          const x = tx + nx * cols[c];
          const zz = z + nz * cols[c];
          pos.push(x, terrainHeight(x, zz) + 0.03, zz);
          uv.push(c / (cols.length - 1), r / 2);
        }
      }
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c + 1 < cols.length; c++) {
          const a = r * cols.length + c;
          const b = a + cols.length;
          idx.push(a, b, a + 1, a + 1, b, b + 1);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      bag.add("decal", remapUv(g, LANE_DECALS.track));
    }
  }

  /** Gnarled stems under the crowns; bare taller stools where the hedge died. */
  private buildStems(bag: LaneBag, clumps: ClumpDef[]): void {
    const rng = mulberry32(0x5e3d);
    for (const c of clumps) {
      if (c.z > 415) continue;
      const n = c.dead ? 3 : c.h > 1.8 ? 2 : 1 + (rng() < 0.4 ? 1 : 0);
      for (let k = 0; k < n; k++) {
        const x0 = c.x + (rng() - 0.5) * c.l * 0.5;
        const z0 = c.z + (rng() - 0.5) * c.l * 0.5;
        const top = c.dead
          ? c.h * (0.7 + rng() * 0.35)
          : c.h * (0.35 + rng() * 0.2);
        const tilt = (c.dead ? 0.35 : 0.22) * rng();
        const ta = rng() * Math.PI * 2;
        const x1 = x0 + Math.cos(ta) * tilt * top + LEAN_X * 0.12 * top;
        const z1 = z0 + Math.sin(ta) * tilt * top + LEAN_Z * 0.12 * top;
        const r = c.dead ? 0.022 + rng() * 0.02 : 0.03 + rng() * 0.03;
        bag.add(
          "bark",
          cylBetween(
            x0,
            c.y - 0.15,
            z0,
            x1,
            c.y + top,
            z1,
            r,
            6,
            r * 0.55,
            false,
          ),
        );
        if (c.dead && rng() < 0.7) {
          // A snapped side branch
          const by = c.y + top * (0.5 + rng() * 0.3);
          const ba = rng() * Math.PI * 2;
          const bl = 0.25 + rng() * 0.3;
          const bx = x0 + (x1 - x0) * 0.6;
          const bz = z0 + (z1 - z0) * 0.6;
          bag.add(
            "bark",
            cylBetween(
              bx,
              by,
              bz,
              bx + Math.cos(ba) * bl,
              by + bl * 0.6,
              bz + Math.sin(ba) * bl,
              r * 0.6,
              5,
              r * 0.25,
              false,
            ),
          );
        }
      }
    }
  }

  private buildGateposts(bag: LaneBag, seg: number): void {
    const posts: Array<[number, number, number, number]> = [
      // x, z, lean about z (top toward +x when negative), lean about x
      [HINGE_X, GZ, -0.05, 0.02],
      [SLAM_X, GZ, 0.025, -0.015],
    ];
    for (let i = 0; i < posts.length; i++) {
      const [x, z, rz, rx] = posts[i];
      const y = terrainHeight(x, z);
      const post = chamferedPost(0.36, 1.55, -0.45, 0.04);
      place(post, x, y, z, rx, 0, rz);
      bag.add("granite", post);
      addCylinderCollider(x, z, 0.3, y - 0.5, y + 1.8);
    }
    // Hanging pins on the hinge post: L brackets let into the stone, pin up
    const hy = terrainHeight(HINGE_X, GZ);
    for (const dy of [0.36, 1.12]) {
      bag.add(
        "steel",
        cylBetween(
          HINGE_X + 0.12,
          hy + dy,
          GZ,
          HINGE_X + 0.3,
          hy + dy,
          GZ,
          0.018,
          seg,
        ),
      );
      bag.add(
        "steel",
        cylBetween(
          HINGE_X + 0.3,
          hy + dy - 0.02,
          GZ,
          HINGE_X + 0.3,
          hy + dy + 0.11,
          GZ,
          0.016,
          seg,
        ),
      );
    }
    // Slam post: the catch strap and a loose chain hanging from it
    const sy = terrainHeight(SLAM_X, GZ);
    bag.add(
      "steel",
      place(boxMetres(0.05, 0.16, 0.03, 2), SLAM_X - 0.2, sy + 0.96, GZ),
    );
    for (let k = 0; k < 6; k++) {
      const t = k / 6;
      const cx = SLAM_X - 0.2 - t * 0.06;
      const cy = sy + 0.9 - t * 0.42;
      bag.add(
        "steel",
        cylBetween(
          cx,
          cy,
          GZ + 0.02,
          cx - 0.01,
          cy - 0.07,
          GZ + 0.02,
          0.012,
          5,
        ),
      );
    }
  }

  /**
   * Five-bar tubular steel gate on the hinge post, standing open, sagging on
   * its pins so the head end nearly touches the ground. Built flat in the
   * closed pose (x along the leaf), dropped by the sag angle, swung to the
   * open yaw and hung on the hinge axis just off the post face.
   */
  private buildGate(bag: LaneBag, seg: number): void {
    const hx = HINGE_X + 0.29;
    const hz = GZ;
    const hy = terrainHeight(hx, hz);
    const dirX = Math.cos(GATE_YAW);
    const dirZ = -Math.sin(GATE_YAW);
    const tipX = hx + dirX * GATE_LEN;
    const tipZ = hz + dirZ * GATE_LEN;
    const tipGround = terrainHeight(tipX, tipZ);
    // Bottom rail at 0.3 above the hinge base; the tip drops until its rail
    // sits a hand above the ground there (never buried)
    const sag = clamp((hy + 0.3 - (tipGround + 0.09)) / GATE_LEN, 0.02, 0.085);
    const parts: THREE.BufferGeometry[] = [];
    const rail = (
      x0: number,
      y0: number,
      x1: number,
      y1: number,
      r: number,
    ): void => {
      parts.push(
        uvShift(cylBetween(x0, y0, 0, x1, y1, 0, r, seg), 900 + parts.length),
      );
    };
    const L = GATE_LEN;
    // Hanging and head stiles
    rail(0.05, 0.26, 0.05, 1.3, 0.036);
    rail(L - 0.05, 0.26, L - 0.05, 1.28, 0.036);
    // Top rail heavier than the four below
    rail(0, 1.24, L, 1.24, 0.03);
    for (const y of [0.98, 0.74, 0.52, 0.3]) rail(0, y, L, y, 0.021);
    // Three intermediate verticals and one diagonal brace
    for (const x of [1.05, 2.1, 3.15]) rail(x, 0.3, x, 1.24, 0.02);
    rail(0.14, 1.2, L - 0.12, 0.34, 0.02);
    // Hinge eyes on the hanging stile
    for (const y of [0.36, 1.12]) {
      parts.push(cylBetween(0.05, y - 0.03, 0, 0.05, y + 0.05, 0, 0.05, seg));
    }
    for (const g of parts) {
      g.rotateZ(-sag);
      g.rotateY(GATE_YAW);
      g.translate(hx, hy, hz);
      bag.add("steel", g);
    }
    addBoxCollider(
      hx + (dirX * L) / 2,
      hz + (dirZ * L) / 2,
      L / 2,
      0.08,
      GATE_YAW,
      hy - 0.5,
      hy + 1.6,
    );
  }

  /**
   * Cattle grid: two rigid 4 m panels, each on the best-fit plane of its own
   * footprint and raised so no bar dips below the analytic ground; a channel
   * frame skirts down to hide where the track dips away, the dark pit decal
   * shows between the bars. No collider – the terrain stays the road.
   */
  private buildGrid(bag: LaneBag, seg: number): void {
    const panels = 2;
    const pw = (GRID_X1 - GRID_X0) / panels;
    const hz = GRID_HZ;
    const ex = new THREE.Vector3();
    const ey = new THREE.Vector3();
    const ez = new THREE.Vector3();
    const basis = new THREE.Matrix4();
    for (let p = 0; p < panels; p++) {
      const pcx = GRID_X0 + pw * (p + 0.5);
      let sum = 0;
      let sxh = 0;
      let szh = 0;
      let sxx = 0;
      let szz = 0;
      let n = 0;
      const samples: Array<[number, number, number]> = [];
      for (let j = -1; j <= 1; j++) {
        for (let i = -2; i <= 2; i++) {
          const dx = (i * pw) / 4.4;
          const dz = j * hz * 0.85;
          const h = terrainHeight(pcx + dx, GZ + dz);
          samples.push([dx, dz, h]);
          sum += h;
          sxh += h * dx;
          szh += h * dz;
          sxx += dx * dx;
          szz += dz * dz;
          n++;
        }
      }
      const mean = sum / n;
      const bx = sxh / sxx;
      const bz = szh / szz;
      let above = 0;
      for (const [dx, dz, h] of samples) {
        const res = h - (mean + bx * dx + bz * dz);
        if (res > above) above = res;
      }
      const lift = this.tier.deckLift;
      const deckY = mean + above + lift;
      ex.set(1, bx, 0).normalize();
      ez.set(0, bz, 1).normalize();
      ey.crossVectors(ez, ex).normalize();
      ez.crossVectors(ex, ey).normalize();
      basis.makeBasis(ex, ey, ez).setPosition(pcx, deckY, GZ);
      const parts: Array<[LaneMat, THREE.BufferGeometry]> = [];
      const bars = 16;
      for (let b = 0; b < bars; b++) {
        const z = -hz + 0.12 + (b * (2 * hz - 0.24)) / (bars - 1);
        parts.push([
          "steel",
          uvShift(
            cylBetween(
              -pw / 2 + 0.05,
              0.04,
              z,
              pw / 2 - 0.05,
              0.04,
              z,
              0.03,
              seg,
            ),
            p * 100 + b,
          ),
        ]);
      }
      for (const sx of [-1, 1]) {
        parts.push([
          "steel",
          boxMetres(0.08, 0.34 + lift, 2 * hz, 2).translate(
            sx * (pw / 2 - 0.04),
            -0.11 - lift / 2,
            0,
          ),
        ]);
      }
      for (const sz of [-1, 1]) {
        parts.push([
          "steel",
          boxMetres(pw, 0.06, 0.1, 2).translate(0, 0.04, sz * (hz - 0.05)),
        ]);
      }
      const pit = new THREE.PlaneGeometry(pw - 0.16, 2 * hz - 0.2);
      pit.rotateX(-Math.PI / 2);
      pit.translate(0, -0.05, 0);
      parts.push(["decal", remapUv(pit, LANE_DECALS.pit)]);
      for (const [key, g] of parts) {
        g.applyMatrix4(basis);
        bag.add(key, g);
      }
    }
    // Granite wing kerbs at both ends of the pit
    for (const x of [GRID_X0 - 0.22, GRID_X1 + 0.22]) {
      const y = terrainHeight(x, GZ);
      const kerb = boxMetres(0.3, 0.6, 2 * hz + 0.5);
      roughen(kerb, 0.03, 0x2b);
      place(kerb, x, y - 0.06, GZ, 0, 0, (x < GX ? -1 : 1) * 0.03);
      bag.add("granite", kerb);
    }
  }

  /**
   * Post-and-wire fences from the gate cluster to both hedges, so the grid and
   * the open gate are the only ways through. Angle-iron posts follow the
   * ground; three strands sag a little between them.
   */
  private buildFences(bag: LaneBag): void {
    const cx0 = laneCentreX(GZ);
    const runs: Array<[number, number]> = [
      [HINGE_X - 0.35, cx0 - CREST + 1.2],
      [STRAINER_X, cx0 + CREST - 1.2],
    ];
    for (let r = 0; r < runs.length; r++) {
      const [xa, xb] = runs[r];
      const len = Math.abs(xb - xa);
      const nPost = Math.max(2, Math.round(len / 3.0) + 1);
      const dir = Math.sign(xb - xa);
      const posts: Array<[number, number]> = [];
      let yMin = Number.POSITIVE_INFINITY;
      let yMax = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < nPost; i++) {
        const x = xa + (dir * len * i) / (nPost - 1);
        const z = GZ + Math.sin(i * 2.3 + r) * 0.06;
        const y = terrainHeight(x, z);
        posts.push([x, y]);
        yMin = Math.min(yMin, y);
        yMax = Math.max(yMax, y);
        const strainer = i === 0 && r === 1;
        const post = boxMetres(
          strainer ? 0.09 : 0.05,
          1.55,
          strainer ? 0.09 : 0.05,
          2,
        );
        place(
          post,
          x,
          y + 0.4,
          z,
          (hash01(i, r, 3) - 0.5) * 0.08,
          0,
          (hash01(i, r, 5) - 0.5) * 0.08,
        );
        bag.add("steel", post);
        if (strainer) addCylinderCollider(x, z, 0.12, y - 0.5, y + 1.3);
      }
      for (let i = 0; i + 1 < posts.length; i++) {
        const [x0, y0] = posts[i];
        const [x1, y1] = posts[i + 1];
        for (const h of [0.35, 0.7, 1.05]) {
          const mx = (x0 + x1) / 2;
          const my = (y0 + y1) / 2 + h - 0.035;
          bag.add(
            "steel",
            cylBetween(x0, y0 + h, GZ, mx, my, GZ, 0.011, 4, 0.011, false),
          );
          bag.add(
            "steel",
            cylBetween(mx, my, GZ, x1, y1 + h, GZ, 0.011, 4, 0.011, false),
          );
        }
      }
      addBoxCollider(
        (xa + xb) / 2,
        GZ,
        len / 2 + 0.1,
        0.06,
        0,
        yMin - 1,
        yMax + 1.3,
      );
    }
  }

  /** Leaning oak fingerpost on the east verge, two blank pointed arms. */
  private buildFingerpost(bag: LaneBag): void {
    // On the bank toe, clear of the 16 m flat core a verge-hugging jeep uses
    const x = laneCentreX(368) + 17.2;
    const z = 368;
    const y = terrainHeight(x, z);
    const parts: Array<[LaneMat, THREE.BufferGeometry]> = [];
    const post = boxMetres(0.13, 2.95, 0.13);
    post.translate(0, 2.95 / 2 - 0.45, 0);
    parts.push(["timber", post]);
    parts.push([
      "timber",
      new THREE.SphereGeometry(0.075, 8, 6).translate(0, 2.56, 0),
    ]);
    const armShape: Array<[number, number]> = [
      [0, -0.08],
      [0.8, -0.08],
      [0.96, 0],
      [0.8, 0.08],
      [0, 0.08],
    ];
    const arms: Array<[number, number, number]> = [
      // height, direction (x, z) the arm points
      [2.22, -0.25, 0.97],
      [1.96, -0.95, -0.3],
    ];
    for (const [ay, dx, dz] of arms) {
      const yaw = Math.atan2(-dz, dx);
      const arm = prism(armShape, 0.03);
      arm.translate(0.065, 0, 0);
      arm.rotateY(yaw);
      arm.translate(0, ay, 0);
      parts.push(["timber", arm]);
      // Iron collar holding the arm
      parts.push(["steel", boxMetres(0.16, 0.05, 0.16, 2).translate(0, ay, 0)]);
    }
    for (const [key, g] of parts) {
      place(g, x, y, z, -0.05, 0, 0.11);
      bag.add(key, g);
    }
    addCylinderCollider(x, z, 0.14, y - 0.5, y + 2.4);
  }

  /** Faded warning sign on the approach, on the driver's left (east verge). */
  private buildSign(bag: LaneBag, seg: number): void {
    // On the bank toe, clear of the 16 m flat core a verge-hugging jeep uses
    const x = laneCentreX(356) + 17.4;
    const z = 356;
    const y = terrainHeight(x, z);
    const parts: Array<[LaneMat, THREE.BufferGeometry]> = [];
    parts.push(["steel", cylBetween(0, -0.45, 0, 0, 2.35, 0, 0.03, seg)]);
    // Triangle plate: triangular steel backing, the decal face on the south side
    const backing = prism(
      [
        [-0.4, -0.35],
        [0.4, -0.35],
        [0, 0.36],
      ],
      0.012,
    );
    backing.translate(0, 1.99, -0.022);
    parts.push(["steel", backing]);
    const face = new THREE.PlaneGeometry(0.8, 0.8);
    face.rotateY(Math.PI);
    face.translate(0, 1.99, -0.031);
    parts.push(["decal", remapUv(face, LANE_DECALS.sign)]);
    parts.push([
      "steel",
      boxMetres(0.6, 0.29, 0.012, 2).translate(0, 1.44, -0.022),
    ]);
    const plate = new THREE.PlaneGeometry(0.62, 0.31);
    plate.rotateY(Math.PI);
    plate.translate(0, 1.44, -0.031);
    parts.push(["decal", remapUv(plate, LANE_DECALS.plate)]);
    // Clamp brackets on the pole
    for (const by of [1.7, 2.24, 1.44]) {
      parts.push(["steel", boxMetres(0.09, 0.04, 0.07, 2).translate(0, by, 0)]);
    }
    for (const [key, g] of parts) {
      place(g, x, y, z, 0.04, 0.08, -0.03);
      bag.add(key, g);
    }
    addCylinderCollider(x, z, 0.08, y - 0.5, y + 2.3);
  }

  /**
   * Stone stile through the west bank: two upright throughs on the crest,
   * three step slabs set into the slope, the top one cracked and half fallen,
   * a broken fragment lying at the bank foot.
   */
  private buildStile(bag: LaneBag): void {
    const z = STILE_Z;
    const at = (a: number): [number, number] => {
      const x = laneCentreX(z) - a;
      return [x, terrainHeight(x, z)];
    };
    const slope = (a: number): number => {
      const [, y0] = at(a - 0.35);
      const [, y1] = at(a + 0.35);
      return Math.atan2(y1 - y0, 0.7);
    };
    let k = 0;
    const steps: Array<[number, number, number]> = [
      // bank offset, sink, yaw jitter
      [17.6, 0.02, 0.06],
      [19.1, 0.03, -0.05],
    ];
    for (const [a, sink, yawJ] of steps) {
      const [x, y] = at(a);
      const slab = boxMetres(0.7, 0.11, 0.42);
      roughen(slab, 0.04, 0x40 + k++);
      place(slab, x, y + 0.06 - sink, z, 0, yawJ, slope(a));
      bag.add("granite", slab);
      addBoxCollider(x, z, 0.35, 0.21, yawJ, y - 0.3, y + 0.16);
    }
    // Top step: cracked – two halves at different angles
    {
      const [x, y] = at(20.6);
      for (const [dz, tilt, drop] of [
        [-0.13, 0.05, 0.0],
        [0.15, -0.22, 0.05],
      ] as const) {
        const half = boxMetres(0.66, 0.11, 0.22);
        roughen(half, 0.05, 0x50 + k++);
        place(
          half,
          x + (dz > 0 ? 0.08 : 0),
          y + 0.1 - drop,
          z + dz,
          tilt,
          0.04,
          slope(20.6) + (dz > 0 ? 0.12 : 0),
        );
        bag.add("granite", half);
      }
      addBoxCollider(x, z, 0.35, 0.28, 0, y - 0.3, y + 0.2);
    }
    // Uprights on the crest either side of the gap
    for (const dz of [-0.5, 0.5]) {
      const [x, y] = at(21.7);
      const up = boxMetres(0.16, 1.05, 0.5);
      roughen(up, 0.04, 0x60 + k++);
      place(
        up,
        x,
        y + 0.32,
        z + dz,
        dz > 0 ? 0.08 : -0.04,
        0,
        dz > 0 ? 0.06 : -0.1,
      );
      bag.add("granite", up);
      addBoxCollider(x, z + dz, 0.12, 0.28, 0, y - 0.5, y + 1);
    }
    // Fallen fragment at the foot
    {
      const [x, y] = at(16.7);
      const frag = boxMetres(0.42, 0.11, 0.3);
      roughen(frag, 0.06, 0x70);
      place(frag, x - 0.2, y + 0.05, z + 0.55, 0.25, 0.7, 0.1);
      bag.add("granite", frag);
    }
  }

  /**
   * Cylinder colliders along both hedge lines so neither jeep nor player can
   * push through the scrub – spaced so a 2.2 m jeep body cannot slip between,
   * never below z 382 (bodies are clamped short of it) and never on the lane
   * floor (the clumps sit 22 m off the centre, the floor ends at 16).
   */
  private hedgeColliders(clumps: ClumpDef[]): void {
    for (const side of [-1, 1]) {
      let lastZ = Number.NEGATIVE_INFINITY;
      const line = clumps
        .filter((c) => c.side === side && c.z <= REACH_Z)
        .sort((a, b) => a.z - b.z);
      for (const c of line) {
        if (c.z - lastZ < 2.5) continue;
        addCylinderCollider(
          c.x,
          c.z,
          c.dead ? 0.65 : 0.9,
          c.y - 0.6,
          c.y + 2.2,
        );
        lastZ = c.z;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(dt: number, env: Environment, camPos: THREE.Vector3): void {
    const w = clamp(env.wind, 0, 1);
    const storm = env.weather === "storm";
    // The cards cast shadows only while the camera is within ~60 m of the
    // hedge band: from the beach or the station they would only burn
    // depth-pass fill for shadows nobody can see.
    const cz = clamp(camPos.z, HEDGE_Z0, HEDGE_Z1);
    const dz = camPos.z - cz;
    const dx = Math.max(0, Math.abs(camPos.x - laneCentreX(cz)) - CREST - 3);
    const near = dx * dx + dz * dz < 60 * 60;
    if (this.hedgeMesh)
      this.hedgeMesh.castShadow = near && this.tier.cardShadow;
    if (this.herbMesh) this.herbMesh.castShadow = near && this.tier.herbShadow;
    // Same slowly meandering direction as the dune grass and the pines
    const a = 0.28 * Math.sin(env.envTime * 0.045);
    this.windDir.set(Math.cos(a), Math.sin(a));
    const h = this.uHedge;
    h.uTime.value = env.envTime;
    h.uWindAmp.value = (0.01 + 0.16 * w * w) * (storm ? 1.5 : 1);
    h.uGustSpeed.value = 0.5 + 2.5 * w;
    h.uFlutterFreq.value = 5 + 7 * w;
    h.uFlutterAmp.value = (0.005 + 0.035 * w * w) * (storm ? 1.3 : 1);
    const b = this.uHerb;
    b.uTime.value = env.envTime;
    b.uWindAmp.value = (0.02 + 0.32 * w * w) * (storm ? 1.3 : 1);
    b.uGustSpeed.value = 0.6 + 2.8 * w;
    b.uFlutterFreq.value = 4 + 6 * w;
    b.uFlutterAmp.value = 0.01 + 0.05 * w * w;
    // Wets fast, dries slow (like the terrain and the pines)
    if (this.wetInit) {
      const rate = env.rain > this.wet ? 0.5 : 0.03;
      this.wet += (env.rain - this.wet) * Math.min(1, dt * rate);
    } else {
      this.wet = env.rain;
      this.wetInit = true;
    }
    h.uLWet.value = this.wet;
    b.uLWet.value = this.wet;
  }

  dispose(): void {
    clearColliderSet("lane");
    this.parent.remove(this.group);
    this.group.clear();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    // Textures stay in the shared cache (same convention as station/camp).
  }
}
