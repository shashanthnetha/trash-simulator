// Maritime pines in the back dunes (d > 170 m inland): sparse, clustered
// stands in sheltered troughs and on leeward flanks – never on bare crests.
// Real tree architecture: 7–15 m trunks (0.32–0.58 m at the base, strong
// taper, slight sweep, ending INSIDE the crown – no bare leader spike) with a
// per-tree skeleton of 6–9 tapered primary branches that rise steeply from
// the trunk and flatten umbrella-fashion toward slightly downswept tips.
// Every needle plate of the crown is ANCHORED to that skeleton (branch tips,
// branch shafts, a dark interior fill ring and a cap over the leader), so the
// crown reads as a closed silhouette with nothing floating. Three main-pass
// draw calls: one merged world-space trunk+branch mesh, instanced crown
// plates (alpha-tested card triples) and a far-LOD cross-billboard impostor
// that takes over beyond ~180 m (both ends dissolve over the same window, so
// no popping silhouettes). Wind sway lives in the vertex shaders – trunks
// bend from about a third of their height, branches and plates follow the
// bend at their own height, plates add per-clump oscillation plus a
// high-frequency needle flutter; the amplitude follows the live wind with
// gust noise and stiffens markedly in a storm. Rain slowly darkens bark and
// foliage (wets fast, dries slow). Trunks register cylinder colliders so
// player and jeep collide. Placement is DETERMINISTIC with a fixed seed –
// identical for every player, like the landmark props.

import * as THREE from "three";
import {
  addCylinderCollider,
  beginColliderSet,
  clearColliderSet,
} from "./colliders";
import { landformKeepOut } from "./landforms";
import { campSite } from "./landmark-camp";
import { clamp, fbm, mulberry32, smoothstep } from "./noise";
import type { Environment } from "./sky";
import { shoreZ, terrainHeight } from "./terrain";
import type { QualityId } from "./types";
import {
  pineBarkTextures,
  pineImpostorTexture,
  pineNeedleTexture,
} from "./vegetation-pines-textures";

// ---------------------------------------------------------------------------
// Tiers and placement constants
// ---------------------------------------------------------------------------

interface PineTierCfg {
  /** Trees actually built (prefix of the fixed full placement). */
  trees: number;
  /** Average crown plates per tree (scales all per-tree plate counts). */
  cards: number;
  /** Crown casts shadows (the trunk always does). */
  crownShadow: boolean;
}

const TIERS: Record<QualityId, PineTierCfg> = {
  ultra: { trees: 60, cards: 48, crownShadow: true },
  high: { trees: 48, cards: 40, crownShadow: true },
  medium: { trees: 33, cards: 30, crownShadow: true },
  low: { trees: 21, cards: 20, crownShadow: false },
};

/** Full deterministic placement size; tiers take a prefix. */
const TREES_MAX = 60;
/** Pine belt: only this far behind the shoreline (deep dunes). */
const BELT_D = 170;

/** LOD crossfade: near meshes dissolve out ... impostor dissolves in. */
const FADE_NEAR = "smoothstep(172.0, 214.0, vPDist)";
const FADE_FAR = "smoothstep(156.0, 196.0, vPDist)";

interface TreeDef {
  x: number;
  z: number;
  /** Ground height at the trunk. */
  y: number;
  /** Tree height in m (7..15.6, mean ~10, a few emergents past 14). */
  h: number;
  yaw: number;
  leanX: number;
  leanZ: number;
  /** Trunk radius at the base in m (0.32..0.58). */
  baseR: number;
  /** Crown radius in m (the crown spans ~45–60 % of the height). */
  crownR: number;
  /** Crown base as a fraction of the height. */
  crownBase: number;
  tint: number;
  phase: number;
}

/** Areas the pines must keep out of (corridor, station, camp, container). */
function pineExcluded(x: number, z: number): boolean {
  const laneX = 86 + Math.sin((z - 60) * 0.012) * 10;
  if (z > 10 && z < 312 && Math.abs(x - laneX) < 45) return true;
  if (Math.hypot(x - 96, z - 118) < 45) return true;
  // The camp picks its own clearing near its anchor – keep out of the spot it
  // actually chose, not the anchor (they can be ~25 m apart).
  const camp = campSite();
  if (Math.hypot(x - camp.x, z - camp.z) < 20) return true;
  if (Math.hypot(x - 205, z - 2) < 15) return true;
  // The built places (chapel knoll, tip, bothy clearing, lane, pole line...)
  return landformKeepOut(x, z);
}

/**
 * Deterministic placement (fixed seed, NOT the world seed): cluster centres
 * are accepted preferentially where the ground lies below the surrounding
 * relief (troughs, leeward flanks – sampled on an 11 m ring), gated by a
 * coarse region noise so whole stretches of dune stay empty. Each centre
 * carries a loner or a clump of 2–5 trees ≥ ~5 m apart; steep slip faces and
 * spots well above their cluster stay bare. Always builds the full list –
 * quality tiers take a prefix, so lower tiers show a subset of the same trees.
 */
function placeTrees(): TreeDef[] {
  const rng = mulberry32(0x51e77a);
  const out: TreeDef[] = [];
  let guard = 0;
  while (out.length < TREES_MAX && guard < 8000) {
    guard++;
    const cx = (rng() - 0.5) * 736;
    const sz = shoreZ(cx);
    const minZ = sz + BELT_D;
    if (minZ > 366) continue;
    const cz = minZ + rng() ** 0.85 * (370 - minZ);
    if (pineExcluded(cx, cz)) continue;
    const h0 = terrainHeight(cx, cz);
    let ring = 0;
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      ring += terrainHeight(cx + Math.cos(a) * 11, cz + Math.sin(a) * 11);
    }
    const hollow = smoothstep(-1.1, 1.5, ring / 6 - h0);
    const region = fbm(cx * 0.0055 + 31.7, cz * 0.0055 + 8.2, 2);
    let p =
      (0.05 + 0.95 * hollow) * (0.15 + 0.85 * smoothstep(0.42, 0.56, region));
    p *= smoothstep(BELT_D, BELT_D + 26, cz - sz);
    p *= 1 - 0.7 * smoothstep(330, 372, Math.abs(cx));
    if (rng() > p) continue;
    const n = rng() < 0.32 ? 1 : 2 + Math.floor(rng() * 4);
    for (let k = 0; k < n && out.length < TREES_MAX; k++) {
      const a = rng() * Math.PI * 2;
      const r = k === 0 ? 0 : 5 + rng() * 8;
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      if (Math.abs(x) > 370 || z > 372) continue;
      if (z - shoreZ(x) < BELT_D || pineExcluded(x, z)) continue;
      let clear = true;
      for (const q of out) {
        const dx = q.x - x;
        const dz = q.z - z;
        if (dx * dx + dz * dz < 27) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      const h = terrainHeight(x, z);
      if (h - h0 > 3) continue; // do not climb from the trough onto a crest
      const gx = terrainHeight(x + 2, z) - terrainHeight(x - 2, z);
      const gz = terrainHeight(x, z + 2) - terrainHeight(x, z - 2);
      if (Math.hypot(gx, gz) / 4 > 0.62) continue; // slip faces stay bare
      const base = clamp(
        7 + rng() ** 1.15 * 5.4 * (0.7 + 0.5 * hollow),
        7,
        13.6,
      );
      const height = rng() < 0.06 ? 14.2 + rng() * 1.4 : base;
      const girth = 0.85 + rng() * 0.45;
      out.push({
        x,
        z,
        y: h,
        h: height,
        yaw: rng() * Math.PI * 2,
        leanX: (rng() - 0.5) * 0.14,
        leanZ: (rng() - 0.5) * 0.14,
        baseR: clamp((0.24 + height * 0.016) * girth, 0.32, 0.58),
        crownR: height * (0.225 + rng() * 0.075),
        crownBase: 0.45 + rng() * 0.12,
        tint: rng(),
        phase: rng(),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Branch skeleton (shared by the forest mesh and the crown plates)
// ---------------------------------------------------------------------------

/** One primary branch: row points and radii in tree-local unit-height space. */
interface PineBranch {
  pts: THREE.Vector3[];
  radii: number[];
}

/** Per-tree branch skeleton plus the trunk centreline sweep parameters. */
interface PineSkeleton {
  branches: PineBranch[];
  sweepX: number;
  sweepZ: number;
  wobPhase: number;
}

const BRANCH_ROWS = 4;
const TRUNK_ROWS = 9;
const TRUNK_RADIAL = 9;
const BRANCH_RADIAL = 7;
/** The trunk shaft ends here – INSIDE the crown, no bare leader spike. */
const TRUNK_TOP = 0.965;

/** Trunk centreline offsets (unit height) – slight sweep plus a wobble. */
function trunkCX(sk: PineSkeleton, t: number): number {
  return sk.sweepX * t * t + 0.016 * Math.sin(t * 4.6 + sk.wobPhase) * t;
}
function trunkCZ(sk: PineSkeleton, t: number): number {
  return sk.sweepZ * t * t + 0.016 * Math.sin(t * 3.1 + sk.wobPhase * 1.7) * t;
}

/** World-space trunk radius (m) at height fraction t: strong taper, root flare. */
function trunkRadiusW(tree: TreeDef, t: number): number {
  return (
    tree.baseR * (0.16 + 0.84 * (1 - t) ** 1.5) * (1 + 0.4 * Math.exp(-t * 15))
  );
}

/** Wind bend profile at unit height y – flat below a third, quadratic above. */
function bendProfile(y: number): number {
  const s = smoothstep(0.3, 1.05, Math.min(y, 1.05));
  return s * s;
}

/**
 * 6–9 primary branches on a golden-angle spiral through the crown: they leave
 * the trunk steeply (~30°), flatten outward and – on tall old trees – sweep
 * slightly down at the tip. Length follows the umbrella profile (longest near
 * the crown base, short at the top).
 */
function buildSkeleton(tree: TreeDef, rng: () => number): PineSkeleton {
  const sk: PineSkeleton = {
    branches: [],
    sweepX: (rng() - 0.5) * 0.1,
    sweepZ: (rng() - 0.5) * 0.1,
    wobPhase: rng() * Math.PI * 2,
  };
  const nB = 6 + Math.floor(rng() * 4);
  const cB = tree.crownBase;
  const old = tree.h > 11;
  for (let b = 0; b < nB; b++) {
    const u = b / (nB - 1);
    const t0 = clamp(
      cB * 0.96 + u * (0.93 - cB * 0.96) + (rng() - 0.5) * 0.035,
      cB * 0.86,
      0.95,
    );
    const az = b * 2.39996 + rng() * 0.8;
    const uu = clamp((t0 - cB) / (1 - cB), 0, 1);
    const lenW = tree.crownR * (1.04 - 0.66 * uu * uu) * (0.82 + 0.36 * rng());
    const len = lenW / tree.h;
    const e0 = 0.5 + rng() * 0.3;
    const droop = 0.3 + 0.22 * rng() + (old ? 0.09 : 0);
    const ca = Math.cos(az);
    const sa = Math.sin(az);
    const bx = trunkCX(sk, t0);
    const bz = trunkCZ(sk, t0);
    const r0 = clamp(trunkRadiusW(tree, t0) * 0.62, 0.045, 0.16);
    const pts: THREE.Vector3[] = [];
    const radii: number[] = [];
    for (let ri = 0; ri < BRANCH_ROWS; ri++) {
      const s = ri / (BRANCH_ROWS - 1);
      pts.push(
        new THREE.Vector3(
          bx + ca * len * s,
          t0 + len * (e0 * s - droop * s * s),
          bz + sa * len * s,
        ),
      );
      radii.push((r0 * (1 - 0.78 * s) + 0.012) / tree.h);
    }
    sk.branches.push({ pts, radii });
  }
  return sk;
}

/** Point on a branch centreline at parameter s ∈ 0..1. */
function sampleBranch(br: PineBranch, s: number): THREE.Vector3 {
  const fi = clamp(s, 0, 1) * (BRANCH_ROWS - 1);
  const i0 = Math.min(Math.floor(fi), BRANCH_ROWS - 2);
  return new THREE.Vector3().lerpVectors(br.pts[i0], br.pts[i0 + 1], fi - i0);
}

// ---------------------------------------------------------------------------
// GLSL – wind sway, LOD dissolve, wet darkening (via onBeforeCompile)
// ---------------------------------------------------------------------------

/** Uniforms, the shared pine attribute and gust noise – all pine materials. */
const PINE_WIND_PARS = /* glsl */ `
uniform float uTime;
uniform float uWindAmp;
uniform float uGustSpeed;
uniform vec2 uWindDir;
attribute vec4 aPine;
float pnHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float pnNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = pnHash(i);
  float b = pnHash(i + vec2(1.0, 0.0));
  float c = pnHash(i + vec2(0.0, 1.0));
  float d = pnHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
// Gust factor 0.35..1 travelling with the wind across the belt
float pineGust(vec2 wp) {
  vec2 gp = wp * 0.016 - uWindDir * uTime * uGustSpeed;
  float n = pnNoise(gp) * 0.62 + pnNoise(gp * 2.9 + 13.7) * 0.38;
  return 0.35 + 0.65 * smoothstep(0.18, 0.82, n);
}
// World-space sway of the crown top of a tree of height h: slow trunk-scale
// oscillation (big trees sway slower) always leaning downwind, times the gust.
vec3 pineSwayW(vec3 base, float h, float phase, out float gustOut) {
  float g = pineGust(base.xz);
  gustOut = g;
  float freq = 5.5 / sqrt(h + 3.0);
  float osc = sin(uTime * freq + phase * 6.2832) * 0.6
            + sin(uTime * freq * 2.3 + phase * 9.0) * 0.25;
  float amp = uWindAmp * h * g * (0.65 + 0.45 * osc);
  return vec3(uWindDir.x, 0.0, uWindDir.y) * amp;
}
`;

/** Extra per-vertex attribute of the merged trunk+branch forest mesh. */
const PINE_FOREST_PARS = /* glsl */ `
attribute vec3 aBase;
`;

/** Extra uniforms/attributes of the crown plates only. */
const PINE_CARD_PARS = /* glsl */ `
uniform float uFlutterFreq;
uniform float uFlutterAmp;
attribute vec4 aCard;
attribute vec3 aCNrm;
attribute float aCUv;
`;

/** Varyings of the visible materials (not the depth materials). */
const PINE_VARY_PARS = /* glsl */ `
varying float vPDist;
varying float vPTint;
varying float vPShade;
`;

/**
 * Trunk + branch bend (also in the depth material): the whole belt is one
 * merged world-space mesh, so per-vertex attributes carry the tree base
 * (aBase) and the precomputed bend profile (aPine.z – flat below a third of
 * the height, quadratic above, evaluated at each vertex's own height so the
 * branches follow the trunk bend exactly like the crown plates do).
 */
const PINE_TRUNK_WIND = /* glsl */ `
vec3 pBase = modelMatrix[3].xyz + aBase;
float pGust;
vec3 pSwayW = pineSwayW(pBase, aPine.y, aPine.x, pGust);
transformed += pSwayW * aPine.z;
`;

/**
 * Crown plate sway (also in the card depth material): follows the trunk bend
 * at the plate's height (aPine.z = precomputed bend profile) plus a SMALL
 * independent per-clump oscillation slightly off the wind direction (kept
 * small so plates stay glued to their branch) and a high-frequency needle
 * flutter along the card normal. aCard.w = 1/instance scale (the
 * transpose(rot) trick, uniform card scale s → factor 1/s²).
 */
const PINE_CARD_WIND = /* glsl */ `
#ifdef USE_INSTANCING
mat3 pRot = mat3(instanceMatrix);
vec3 pBase = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
#else
mat3 pRot = mat3(1.0);
vec3 pBase = modelMatrix[3].xyz;
#endif
float pGust;
vec3 pSwayW = pineSwayW(pBase, aPine.y, aPine.x, pGust) * aPine.z;
vec2 pPerp = vec2(-uWindDir.y, uWindDir.x);
vec2 pDir2 = normalize(uWindDir + pPerp * (aCard.z * 2.0 - 1.0) * 0.9);
float pFreq2 = 9.9 / sqrt(aPine.y + 3.0);
float pOsc2 = sin(uTime * pFreq2 + aCard.x * 6.2832);
pSwayW += vec3(pDir2.x, 0.0, pDir2.y)
        * (uWindAmp * aPine.y * 0.22 * pGust * pOsc2 * aPine.z);
float pInvS = aCard.w;
transformed += (transpose(pRot) * pSwayW) * (pInvS * pInvS);
float pFl = sin(uTime * uFlutterFreq + aCard.x * 21.0 + position.x * 6.0 + position.y * 4.0);
transformed += aCNrm * (pFl * uFlutterAmp
  * (0.35 + 0.65 * clamp(length(position.xy), 0.0, 1.0)) * pInvS);
`;

/** Card atlas: two 256² variants side by side – aCUv selects the half. */
const PINE_CARD_UV = /* glsl */ `
vMapUv.x = vMapUv.x * 0.5 + aCUv;
`;

/**
 * Impostor sway: the cross-billboard top swings with the same formula so the
 * far silhouette moves like the near tree it replaces. aPine.z = 1/sx² of the
 * non-uniform instance scale (the displacement is horizontal, r1·W = 0).
 */
const PINE_FAR_WIND = /* glsl */ `
#ifdef USE_INSTANCING
mat3 pRot = mat3(instanceMatrix);
vec3 pBase = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
#else
mat3 pRot = mat3(1.0);
vec3 pBase = modelMatrix[3].xyz;
#endif
float pGust;
vec3 pSwayW = pineSwayW(pBase, aPine.y, aPine.x, pGust);
float pProf = uv.y * uv.y;
transformed += (transpose(pRot) * pSwayW) * (pProf * aPine.z * 0.8);
`;

const PINE_TRUNK_VARY = /* glsl */ `
vPDist = distance(cameraPosition, pBase);
vPTint = aPine.w;
vPShade = 1.0;
`;

const PINE_CARD_VARY = /* glsl */ `
vPDist = distance(cameraPosition, pBase);
vPTint = aPine.w;
vPShade = 0.8 + 0.25 * aCard.y;
`;

const PINE_FRAG_PARS = /* glsl */ `
uniform float uPWet;
varying float vPDist;
varying float vPTint;
varying float vPShade;
float pfHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
`;

/** Bark: rain soaks it dark; slightly smoother when wet. */
const PINE_TRUNK_FRAG_COLOR = /* glsl */ `
diffuseColor.rgb *= mix(1.0, 0.62, uPWet * 0.8);
`;
const PINE_TRUNK_FRAG_ROUGH = /* glsl */ `
roughnessFactor = mix(roughnessFactor, 0.6, uPWet * 0.7);
`;

/** Opaque trunk dissolves with a screen-door dither instead of popping. */
const PINE_TRUNK_FRAG_DISSOLVE = /* glsl */ `
float pFade = 1.0 - ${FADE_NEAR};
if (pfHash(gl_FragCoord.xy) > pFade) discard;
`;

/** Cards erode via their alpha (alphaTest cuts progressively – organic). */
const PINE_CARD_FRAG_ALPHA = /* glsl */ `
diffuseColor.a *= 1.0 - ${FADE_NEAR};
`;
const PINE_FAR_FRAG_ALPHA = /* glsl */ `
diffuseColor.a *= ${FADE_FAR};
`;

/**
 * Foliage: per-tree hue variation (yellow-green ↔ blue-green), interior cards
 * darker (vPShade), and a slight saturation-preserving darkening when wet.
 */
const PINE_NEEDLE_FRAG_COLOR = /* glsl */ `
diffuseColor.rgb *= mix(vec3(1.06, 1.04, 0.88), vec3(0.88, 0.97, 1.05), vPTint) * vPShade;
diffuseColor.rgb *= mix(1.0, 0.6, uPWet * 0.65);
`;
const PINE_NEEDLE_FRAG_ROUGH = /* glsl */ `
roughnessFactor = mix(roughnessFactor, 0.68, uPWet * 0.7);
`;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * The whole pine belt as ONE merged world-space mesh: per tree a gently swept,
 * strongly tapered trunk shaft with lumpy bark rings (ending inside the
 * crown) plus its 6–9 tapered branch tubes, transformed by the tree matrix.
 * Per-vertex aPine carries (phase, height, bend profile, tint) and aBase the
 * tree base, so the wind shader bends every branch with the trunk.
 */
function buildForestGeometry(
  trees: TreeDef[],
  matrices: THREE.Matrix4[],
  skeletons: PineSkeleton[],
): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const aPine: number[] = [];
  const aBase: number[] = [];
  const idx: number[] = [];
  const v = new THREE.Vector3();
  const nv = new THREE.Vector3();
  const tPos = new THREE.Vector3();
  const tQuat = new THREE.Quaternion();
  const tScl = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const dTan = new THREE.Vector3();
  const side = new THREE.Vector3();
  const up2 = new THREE.Vector3();
  for (let i = 0; i < trees.length; i++) {
    const t = trees[i];
    const sk = skeletons[i];
    matrices[i].decompose(tPos, tQuat, tScl);
    const vRep = t.h / 2.7;
    const push = (
      lx: number,
      ly: number,
      lz: number,
      nx: number,
      ny: number,
      nz: number,
      tu: number,
      tv: number,
    ): void => {
      v.set(lx, ly, lz).applyMatrix4(matrices[i]);
      nv.set(nx, ny, nz).normalize().applyQuaternion(tQuat);
      pos.push(v.x, v.y, v.z);
      nrm.push(nv.x, nv.y, nv.z);
      uv.push(tu, tv);
      aPine.push(t.phase, t.h, bendProfile(ly), t.tint);
      aBase.push(tPos.x, tPos.y, tPos.z);
    };
    // Trunk shaft
    const ringStart = pos.length / 3;
    for (let ri = 0; ri < TRUNK_ROWS; ri++) {
      const tt = (ri / (TRUNK_ROWS - 1)) * TRUNK_TOP;
      const cxl = trunkCX(sk, tt);
      const czl = trunkCZ(sk, tt);
      const radU = trunkRadiusW(t, tt) / t.h;
      for (let j = 0; j <= TRUNK_RADIAL; j++) {
        const th = (j / TRUNK_RADIAL) * Math.PI * 2;
        const lump =
          1 +
          (fbm(Math.cos(th) + 2 + i * 0.37, Math.sin(th) + tt * 5, 2) - 0.5) *
            0.22;
        push(
          cxl + Math.cos(th) * radU * lump,
          tt,
          czl + Math.sin(th) * radU * lump,
          Math.cos(th),
          0.08,
          Math.sin(th),
          j / TRUNK_RADIAL,
          tt * vRep,
        );
      }
    }
    for (let ri = 0; ri < TRUNK_ROWS - 1; ri++) {
      for (let j = 0; j < TRUNK_RADIAL; j++) {
        const a = ringStart + ri * (TRUNK_RADIAL + 1) + j;
        const b = a + TRUNK_RADIAL + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const tipIdx = pos.length / 3;
    push(trunkCX(sk, 0.99), 0.99, trunkCZ(sk, 0.99), 0, 1, 0, 0.5, vRep);
    const lastRing = ringStart + (TRUNK_ROWS - 1) * (TRUNK_RADIAL + 1);
    for (let j = 0; j < TRUNK_RADIAL; j++) {
      idx.push(lastRing + j, tipIdx, lastRing + j + 1);
    }
    // Branch tubes
    for (const br of sk.branches) {
      const bStart = pos.length / 3;
      for (let ri = 0; ri < BRANCH_ROWS; ri++) {
        const p = br.pts[ri];
        dTan
          .subVectors(
            br.pts[Math.min(ri + 1, BRANCH_ROWS - 1)],
            br.pts[Math.max(ri - 1, 0)],
          )
          .normalize();
        side.crossVectors(dTan, up);
        if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
        else side.normalize();
        up2.crossVectors(side, dTan);
        const rad = br.radii[ri];
        for (let j = 0; j <= BRANCH_RADIAL; j++) {
          const th = (j / BRANCH_RADIAL) * Math.PI * 2;
          const co = Math.cos(th);
          const si = Math.sin(th);
          push(
            p.x + (side.x * co + up2.x * si) * rad,
            p.y + (side.y * co + up2.y * si) * rad,
            p.z + (side.z * co + up2.z * si) * rad,
            side.x * co + up2.x * si + dTan.x * 0.12,
            side.y * co + up2.y * si + dTan.y * 0.12,
            side.z * co + up2.z * si + dTan.z * 0.12,
            j / BRANCH_RADIAL,
            (ri / (BRANCH_ROWS - 1)) * 1.4,
          );
        }
      }
      for (let ri = 0; ri < BRANCH_ROWS - 1; ri++) {
        for (let j = 0; j < BRANCH_RADIAL; j++) {
          const a = bStart + ri * (BRANCH_RADIAL + 1) + j;
          const b = a + BRANCH_RADIAL + 1;
          idx.push(a, b, a + 1, a + 1, b, b + 1);
        }
      }
      const last = br.pts[BRANCH_ROWS - 1];
      dTan.subVectors(last, br.pts[BRANCH_ROWS - 2]).normalize();
      const tipR = br.radii[BRANCH_ROWS - 1];
      const bTip = pos.length / 3;
      push(
        last.x + dTan.x * tipR * 3,
        last.y + dTan.y * tipR * 3,
        last.z + dTan.z * tipR * 3,
        dTan.x,
        dTan.y,
        dTan.z,
        0.5,
        1.5,
      );
      const bLast = bStart + (BRANCH_ROWS - 1) * (BRANCH_RADIAL + 1);
      for (let j = 0; j < BRANCH_RADIAL; j++) {
        idx.push(bLast + j, bTip, bLast + j + 1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("aPine", new THREE.Float32BufferAttribute(aPine, 4));
  g.setAttribute("aBase", new THREE.Float32BufferAttribute(aBase, 3));
  g.setIndex(idx);
  return g;
}

/**
 * One crown plate: two quads crossed at 90° (each with a lengthwise fold)
 * plus a gently domed horizontal quad – 16 triangles that read as a foliage
 * mass from every angle. Normals are placeholders – the visible material
 * replaces them with the per-instance outward normal aCNrm for rounded crown
 * shading.
 */
function buildCardGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const cols = [-1, 0, 1];
  const rows = [-0.42, 0.55];
  for (let q = 0; q < 2; q++) {
    const yawQ = (q * Math.PI) / 2;
    const cy = Math.cos(yawQ);
    const sy = Math.sin(yawQ);
    const start = pos.length / 3;
    for (let ri = 0; ri < rows.length; ri++) {
      for (let ci = 0; ci < cols.length; ci++) {
        const lx = cols[ci];
        const ly = rows[ri];
        const lz = ci === 1 ? 0.22 : 0;
        pos.push(lx * cy + lz * sy, ly, -lx * sy + lz * cy);
        nrm.push(0, 1, 0);
        uv.push((lx + 1) / 2, (ly + 0.42) / 0.97);
      }
    }
    for (let ci = 0; ci < 2; ci++) {
      const a = start + ci;
      const b = start + 3 + ci;
      idx.push(a, a + 1, b + 1, a, b + 1, b);
    }
  }
  // Horizontal dome plate (3×3 grid, centre raised)
  const gx = [-1, 0, 1];
  const gz = [-0.78, 0, 0.78];
  const hStart = pos.length / 3;
  for (let zi = 0; zi < 3; zi++) {
    for (let xi = 0; xi < 3; xi++) {
      const lx = gx[xi];
      const lz = gz[zi];
      const lift = (xi === 1 ? 0.13 : 0) + (zi === 1 ? 0.11 : 0);
      pos.push(lx, 0.04 + lift, lz);
      nrm.push(0, 1, 0);
      uv.push((lx + 1) / 2, (lz + 0.78) / 1.56);
    }
  }
  for (let zi = 0; zi < 2; zi++) {
    for (let xi = 0; xi < 2; xi++) {
      const a = hStart + zi * 3 + xi;
      const b = a + 3;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/**
 * Far-LOD cross billboard: two perpendicular quads, unit width ±1 and height
 * 0..1, split once vertically so the top can bend in the wind. Normals point
 * up so both faces take the same sky/sun light (no bright/dark quad pair).
 */
function buildFarGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const rows = [0, 0.5, 1];
  for (let q = 0; q < 2; q++) {
    const yawQ = (q * Math.PI) / 2;
    const cy = Math.cos(yawQ);
    const sy = Math.sin(yawQ);
    const start = pos.length / 3;
    for (let ri = 0; ri < rows.length; ri++) {
      for (const lx of [-1, 1]) {
        pos.push(lx * cy, rows[ri], -lx * sy);
        nrm.push(0, 1, 0);
        uv.push((lx + 1) / 2, rows[ri]);
      }
    }
    for (let ri = 0; ri < 2; ri++) {
      const a = start + ri * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
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
// Pines
// ---------------------------------------------------------------------------

export class Pines {
  readonly group = new THREE.Group();
  private parent: THREE.Object3D;
  private textures: THREE.Texture[] = [];
  private u = {
    uTime: { value: 0 },
    uWindAmp: { value: 0.01 },
    uGustSpeed: { value: 1 },
    uWindDir: { value: new THREE.Vector2(1, 0) },
    uFlutterFreq: { value: 6 },
    uFlutterAmp: { value: 0.01 },
    uPWet: { value: 0 },
  };
  private wet = 0;
  private wetInit = false;

  constructor(parent: THREE.Object3D, quality: QualityId) {
    this.parent = parent;
    parent.add(this.group);
    const cfg = TIERS[quality];
    const trees = placeTrees().slice(0, cfg.trees);
    const matrices = trees.map((t) => {
      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(t.x, t.y - 0.02 * t.h, t.z),
        new THREE.Quaternion().setFromEuler(
          new THREE.Euler(t.leanX, t.yaw, t.leanZ),
        ),
        new THREE.Vector3(t.h, t.h, t.h),
      );
      return m;
    });
    const skeletons = trees.map((t, i) =>
      buildSkeleton(t, mulberry32(0x7c33d1 + i * 104729)),
    );
    this.buildForest(trees, matrices, skeletons);
    this.buildCrowns(trees, matrices, skeletons, cfg);
    this.buildFar(trees);
    beginColliderSet("pines");
    for (const t of trees) {
      addCylinderCollider(
        t.x,
        t.z,
        clamp(t.baseR * 0.95, 0.33, 0.52),
        t.y - 0.5,
        t.y + 4,
      );
    }
  }

  /** Shared onBeforeCompile plumbing of the three visible materials. */
  private patchVisible(
    mat: THREE.MeshStandardMaterial,
    vertPars: string,
    vertBody: string,
    uvPatch: string,
    fragAlpha: string,
    fragColor: string,
    fragRough: string,
    cardNormal: boolean,
    key: string,
  ): void {
    // All three visible materials share this closure, so the default cache key
    // (the closure's source) cannot tell their programs apart.
    mat.customProgramCacheKey = () => key;
    const u = this.u;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      let vs = `${vertPars}${PINE_VARY_PARS}${shader.vertexShader}`;
      if (cardNormal) {
        vs = vs.replace(
          "#include <beginnormal_vertex>",
          // Blend the outward crown normal toward up: full side-lighting on
          // needle cards reads as black pancakes on the shadow side.
          "#include <beginnormal_vertex>\nobjectNormal = normalize(mix(aCNrm, vec3(0.0, 1.0, 0.0), 0.55));",
        );
      }
      if (uvPatch) {
        vs = vs.replace(
          "#include <uv_vertex>",
          `#include <uv_vertex>\n${uvPatch}`,
        );
      }
      shader.vertexShader = vs.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>\n${vertBody}`,
      );
      shader.fragmentShader = `${PINE_FRAG_PARS}${shader.fragmentShader}`
        .replace(
          "#include <alphatest_fragment>",
          `${fragAlpha}#include <alphatest_fragment>`,
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>\n${fragColor}`,
        )
        .replace(
          "#include <roughnessmap_fragment>",
          `#include <roughnessmap_fragment>\n${fragRough}`,
        );
    };
  }

  /** Depth material with the same wind deformation (shadow casting). */
  private depthMaterial(
    vertPars: string,
    vertBody: string,
    tex: THREE.Texture | undefined,
    uvPatch: string,
    key: string,
  ): THREE.MeshDepthMaterial {
    const depth = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      // Material.setValues warns on undefined values, so the trunk's "no map"
      // must be an explicit null.
      map: tex ?? null,
      alphaTest: tex ? 0.35 : 0,
      side: tex ? THREE.DoubleSide : THREE.FrontSide,
    });
    depth.customProgramCacheKey = () => key;
    const u = this.u;
    depth.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      let vs = `${vertPars}${shader.vertexShader}`;
      if (uvPatch) {
        vs = vs.replace(
          "#include <uv_vertex>",
          `#include <uv_vertex>\n${uvPatch}`,
        );
      }
      shader.vertexShader = vs.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>\n${vertBody}`,
      );
    };
    return depth;
  }

  private buildForest(
    trees: TreeDef[],
    matrices: THREE.Matrix4[],
    skeletons: PineSkeleton[],
  ): void {
    const { map, normalMap } = pineBarkTextures();
    this.textures.push(map, normalMap);
    const mat = new THREE.MeshStandardMaterial({
      map,
      normalMap,
      normalScale: new THREE.Vector2(0.85, 0.85),
      roughness: 0.9,
      metalness: 0,
    });
    this.patchVisible(
      mat,
      `${PINE_WIND_PARS}${PINE_FOREST_PARS}`,
      `${PINE_TRUNK_WIND}${PINE_TRUNK_VARY}`,
      "",
      PINE_TRUNK_FRAG_DISSOLVE,
      PINE_TRUNK_FRAG_COLOR,
      PINE_TRUNK_FRAG_ROUGH,
      false,
      "pine-trunk",
    );
    const geo = buildForestGeometry(trees, matrices, skeletons);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.customDepthMaterial = this.depthMaterial(
      `${PINE_WIND_PARS}${PINE_FOREST_PARS}`,
      PINE_TRUNK_WIND,
      undefined,
      "",
      "pine-depth-trunk",
    );
    geo.computeBoundingSphere();
    mesh.name = "pineTrunks";
    this.group.add(mesh);
  }

  private buildCrowns(
    trees: TreeDef[],
    matrices: THREE.Matrix4[],
    skeletons: PineSkeleton[],
    cfg: PineTierCfg,
  ): void {
    interface CardDef {
      m: THREE.Matrix4;
      phase: number;
      h: number;
      prof: number;
      tint: number;
      flutter: number;
      inner: number;
      swayRand: number;
      invS: number;
      nrm: THREE.Vector3;
      uvOff: number;
    }
    const cards: CardDef[] = [];
    const f = cfg.cards / 48;
    for (let i = 0; i < trees.length; i++) {
      const t = trees[i];
      const sk = skeletons[i];
      const rng = mulberry32(0x0cad51 + i * 7919);
      const center = new THREE.Vector3(
        trunkCX(sk, 0.78),
        0.78,
        trunkCZ(sk, 0.78),
      ).applyMatrix4(matrices[i]);
      const sizeK = 0.85 + 0.022 * t.h;
      const pushCard = (
        local: THREE.Vector3,
        s: number,
        uvOff: number,
        inner: number,
      ): void => {
        const world = local.clone().applyMatrix4(matrices[i]);
        const quat = new THREE.Quaternion().setFromEuler(
          new THREE.Euler(
            (rng() - 0.5) * 0.55,
            rng() * Math.PI * 2,
            (rng() - 0.5) * 0.4,
          ),
        );
        const nrmW = world
          .clone()
          .sub(center)
          .add(new THREE.Vector3(0, t.h * 0.12, 0));
        if (nrmW.lengthSq() < 1e-4) nrmW.set(0, 1, 0);
        nrmW.normalize();
        cards.push({
          m: new THREE.Matrix4().compose(
            world,
            quat,
            new THREE.Vector3(s, s, s),
          ),
          phase: t.phase,
          h: t.h,
          prof: bendProfile(local.y),
          tint: t.tint,
          flutter: rng(),
          inner,
          swayRand: rng(),
          invS: 1 / s,
          nrm: nrmW.applyQuaternion(quat.clone().invert()),
          uvOff,
        });
      };
      // Every branch carries a big plate at its TIP plus plates along the
      // outer shaft – the crown hangs on the skeleton, nothing floats.
      for (const br of sk.branches) {
        const tip = br.pts[BRANCH_ROWS - 1];
        const dir = tip
          .clone()
          .sub(br.pts[BRANCH_ROWS - 2])
          .normalize();
        pushCard(
          tip.clone().addScaledVector(dir, 0.22 / t.h),
          (0.8 + 0.28 * rng()) * sizeK,
          0,
          0.7 + 0.3 * rng(),
        );
        const nMid = Math.round(f * (1.6 + rng() * 1.8));
        for (let m = 0; m < nMid; m++) {
          const p = sampleBranch(br, 0.38 + rng() * 0.45);
          p.x += ((rng() - 0.5) * 0.36) / t.h;
          p.y += ((rng() - 0.35) * 0.3) / t.h;
          p.z += ((rng() - 0.5) * 0.36) / t.h;
          pushCard(p, (0.55 + 0.22 * rng()) * sizeK, 0, 0.35 + 0.4 * rng());
        }
      }
      // Interior fill ring (dense dark atlas variant) closes the crown core
      const nFill = Math.round(f * (13 + rng() * 6));
      for (let k = 0; k < nFill; k++) {
        const tY = t.crownBase + (0.06 + 0.82 * rng()) * (0.96 - t.crownBase);
        const rr = ((0.18 + rng() * 0.38) * t.crownR) / t.h;
        const th = rng() * Math.PI * 2;
        pushCard(
          new THREE.Vector3(
            trunkCX(sk, tY) + Math.cos(th) * rr,
            tY,
            trunkCZ(sk, tY) + Math.sin(th) * rr,
          ),
          (0.8 + 0.3 * rng()) * sizeK,
          0.5,
          0.05 + 0.25 * rng(),
        );
      }
      // Cap over the trunk tip – the leader never sticks past the foliage
      const nCap = 2 + (rng() < f * 0.9 ? 1 : 0);
      for (let k = 0; k < nCap; k++) {
        const tY = 0.93 + rng() * 0.1;
        const rr = (rng() * 0.25) / t.h;
        const th = rng() * Math.PI * 2;
        pushCard(
          new THREE.Vector3(
            trunkCX(sk, tY) + Math.cos(th) * rr,
            tY,
            trunkCZ(sk, tY) + Math.sin(th) * rr,
          ),
          (0.5 + 0.2 * rng()) * sizeK,
          0,
          0.8 + 0.2 * rng(),
        );
      }
    }
    const tex = pineNeedleTexture();
    this.textures.push(tex);
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      alphaTest: 0.35,
      side: THREE.DoubleSide,
      roughness: 0.85,
      metalness: 0,
    });
    this.patchVisible(
      mat,
      `${PINE_WIND_PARS}${PINE_CARD_PARS}`,
      `${PINE_CARD_WIND}${PINE_CARD_VARY}`,
      PINE_CARD_UV,
      PINE_CARD_FRAG_ALPHA,
      PINE_NEEDLE_FRAG_COLOR,
      PINE_NEEDLE_FRAG_ROUGH,
      true,
      "pine-card",
    );
    const geo = buildCardGeometry();
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(cards.length, 1));
    const aPine = new Float32Array(cards.length * 4);
    const aCard = new Float32Array(cards.length * 4);
    const aCNrm = new Float32Array(cards.length * 3);
    const aCUv = new Float32Array(cards.length);
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      mesh.setMatrixAt(i, c.m);
      aPine[i * 4] = c.phase;
      aPine[i * 4 + 1] = c.h;
      aPine[i * 4 + 2] = c.prof;
      aPine[i * 4 + 3] = c.tint;
      aCard[i * 4] = c.flutter;
      aCard[i * 4 + 1] = c.inner;
      aCard[i * 4 + 2] = c.swayRand;
      aCard[i * 4 + 3] = c.invS;
      aCNrm[i * 3] = c.nrm.x;
      aCNrm[i * 3 + 1] = c.nrm.y;
      aCNrm[i * 3 + 2] = c.nrm.z;
      aCUv[i] = c.uvOff;
    }
    geo.setAttribute("aPine", new THREE.InstancedBufferAttribute(aPine, 4));
    geo.setAttribute("aCard", new THREE.InstancedBufferAttribute(aCard, 4));
    geo.setAttribute("aCNrm", new THREE.InstancedBufferAttribute(aCNrm, 3));
    geo.setAttribute("aCUv", new THREE.InstancedBufferAttribute(aCUv, 1));
    mesh.count = cards.length;
    mesh.castShadow = cfg.crownShadow;
    mesh.receiveShadow = false;
    if (cfg.crownShadow) {
      mesh.customDepthMaterial = this.depthMaterial(
        `${PINE_WIND_PARS}${PINE_CARD_PARS}`,
        PINE_CARD_WIND,
        tex,
        PINE_CARD_UV,
        "pine-depth-card",
      );
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.name = "pineCrowns";
    this.group.add(mesh);
  }

  private buildFar(trees: TreeDef[]): void {
    const tex = pineImpostorTexture();
    this.textures.push(tex);
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      alphaTest: 0.35,
      side: THREE.DoubleSide,
      roughness: 0.9,
      metalness: 0,
    });
    mat.customProgramCacheKey = () => "pine-far";
    const u = this.u;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.vertexShader =
        `${PINE_WIND_PARS}${PINE_VARY_PARS}attribute float aUvOff;\n${shader.vertexShader}`
          .replace(
            "#include <uv_vertex>",
            "#include <uv_vertex>\nvMapUv.x = vMapUv.x * 0.5 + aUvOff;",
          )
          .replace(
            "#include <begin_vertex>",
            `#include <begin_vertex>\n${PINE_FAR_WIND}${PINE_TRUNK_VARY}`,
          );
      shader.fragmentShader = `${PINE_FRAG_PARS}${shader.fragmentShader}`
        .replace(
          "#include <alphatest_fragment>",
          `${PINE_FAR_FRAG_ALPHA}#include <alphatest_fragment>`,
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>\n${PINE_NEEDLE_FRAG_COLOR}`,
        );
    };
    const geo = buildFarGeometry();
    const mesh = new THREE.InstancedMesh(geo, mat, trees.length);
    const aPine = new Float32Array(trees.length * 4);
    const aUvOff = new Float32Array(trees.length);
    const m = new THREE.Matrix4();
    for (let i = 0; i < trees.length; i++) {
      const t = trees[i];
      const sx = t.crownR * 1.14;
      m.compose(
        new THREE.Vector3(t.x, t.y - 0.05, t.z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, t.yaw, 0)),
        new THREE.Vector3(sx, t.h * 1.04, sx),
      );
      mesh.setMatrixAt(i, m);
      aPine[i * 4] = t.phase;
      aPine[i * 4 + 1] = t.h;
      aPine[i * 4 + 2] = 1 / (sx * sx);
      aPine[i * 4 + 3] = t.tint;
      // Variant 0 broad and flat-topped, variant 1 narrower and deeper
      aUvOff[i] = t.crownR / t.h > 0.2625 ? 0 : 0.5;
    }
    geo.setAttribute("aPine", new THREE.InstancedBufferAttribute(aPine, 4));
    geo.setAttribute("aUvOff", new THREE.InstancedBufferAttribute(aUvOff, 1));
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.name = "pineFar";
    this.group.add(mesh);
  }

  update(dt: number, env: Environment, _camPos: THREE.Vector3): void {
    const u = this.u;
    const w = clamp(env.wind, 0, 1);
    const storm = env.weather === "storm";
    u.uTime.value = env.envTime;
    // Same slowly meandering direction as the dune grass (toward +x)
    const a = 0.28 * Math.sin(env.envTime * 0.045);
    u.uWindDir.value.set(Math.cos(a), Math.sin(a));
    let amp = 0.006 + 0.055 * w * w;
    if (storm) amp *= 1.45;
    u.uWindAmp.value = amp;
    u.uGustSpeed.value = 0.5 + 2.5 * w;
    u.uFlutterFreq.value = 5 + 7 * w;
    u.uFlutterAmp.value = (0.008 + 0.05 * w * w) * (storm ? 1.35 : 1);
    // Wets fast, dries slow (like the terrain's uWet)
    if (this.wetInit) {
      const rate = env.rain > this.wet ? 0.5 : 0.03;
      this.wet += (env.rain - this.wet) * Math.min(1, dt * rate);
    } else {
      this.wet = env.rain;
      this.wetInit = true;
    }
    u.uPWet.value = this.wet;
  }

  dispose(): void {
    clearColliderSet("pines");
    this.parent.remove(this.group);
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as
        | THREE.Material
        | THREE.Material[]
        | undefined;
      if (mat) for (const mm of Array.isArray(mat) ? mat : [mat]) mm.dispose();
      if (mesh.customDepthMaterial) mesh.customDepthMaterial.dispose();
      const im = o as THREE.InstancedMesh;
      if (im.isInstancedMesh) im.dispose();
    });
    for (const t of this.textures) t.dispose();
    this.textures.length = 0;
  }
}
