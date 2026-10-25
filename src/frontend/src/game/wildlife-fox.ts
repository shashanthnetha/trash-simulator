// A red fox that occasionally crosses the dunes: procedural model, terrain-
// following gait, flees when the player comes close. Deliberately rare –
// most of the time it does not exist at all.
//
// MODEL: one SkinnedMesh over a hand-built 17-bone skeleton (spine/chest,
// neck, head, two ears, three tail segments, four two-segment legs). Every
// part is authored in the bind pose, weighted to exactly one bone (joint
// balls sit ON the pivots so the silhouette stays closed, the dog's trick)
// and merged – the whole fox is ONE draw call, plus a tiny vertex-coloured
// gloss mesh (amber eyes, black nose) hung off the head bone. No shell fur:
// the coat is vertex-colour markings × a canvas strand/mottle texture that
// doubles as bump map, plus a sun-backlight rim in the fragment shader.
//
// BEHAVIOUR: a scheduler rolls an appearance on average every 3–7 minutes,
// biased to dawn/dusk/night (foxes are crepuscular) and suppressed in storms
// and heavy rain. An appearance picks a crossing route through the dune belt
// that passes 15–30 m from the player, trots along it at 3–4 m/s with the
// occasional stop-and-look, and despawns past the route or beyond ~90 m.
// If the player (or the fast jeep) gets close, it breaks into a flat-out
// serpentine run directly away and is gone. Silent, registers no colliders of
// its own, but slides its body circle out of the static ones (tents, pine
// trunks) and plans its routes clear of the station and the camp clearing.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { resolveCircle } from "./colliders";
import { campSite } from "./landmark-camp";
import type { Environment } from "./sky";
import { WORLD_BOUNDS, shoreZ, terrainHeight } from "./terrain";
import type { QualityId } from "./types";

// ---------------------------------------------------------------------------
// Small helpers (kept local – companions.ts does not export its copies)
// ---------------------------------------------------------------------------

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

function sstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function wrapPi(a: number): number {
  let d = a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function approach(cur: number, to: number, rate: number, dt: number): number {
  return cur + (to - cur) * Math.min(1, rate * dt);
}

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

// ---------------------------------------------------------------------------
// Coat colours (vertex colours; multiplied onto the neutral strand texture)
// ---------------------------------------------------------------------------

/** Saturated rust of the spine and upper flanks. */
const C_RUST = new THREE.Color("#a34a16");
/** Paler orange of the lower flanks and thighs. */
const C_RUST_L = new THREE.Color("#c87a38");
/** White of throat, chest, underside and tail tip (kept off pure white). */
const C_CREAM = new THREE.Color("#eee7d8");
/** Black stockings and ear backs. */
const C_BLACK = new THREE.Color("#221b15");
/** Dark grizzle (shoulder wash, tail top, pre-tip band). */
const C_DUSK = new THREE.Color("#6b3d1a");
/** Pale grey of the inner ear fringe. */
const C_EAR_IN = new THREE.Color("#d9d0c1");
/** Neutral base tone of the coat texture – vertex colours divide by this. */
const FOX_BASE = new THREE.Color("#b1a897");

const TMP_C = new THREE.Color();

/** Set vertex colours from a function of the (current) vertex position. */
function paint(
  g: THREE.BufferGeometry,
  fn: (x: number, y: number, z: number, out: THREE.Color) => void,
): THREE.BufferGeometry {
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const arr = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    fn(pos.getX(i), pos.getY(i), pos.getZ(i), TMP_C);
    arr[i * 3] = TMP_C.r / FOX_BASE.r;
    arr[i * 3 + 1] = TMP_C.g / FOX_BASE.g;
    arr[i * 3 + 2] = TMP_C.b / FOX_BASE.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return g;
}

/** Plain vertex colours (gloss mesh – no texture to normalise against). */
function paintRaw(
  g: THREE.BufferGeometry,
  fn: (x: number, y: number, z: number, out: THREE.Color) => void,
): THREE.BufferGeometry {
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const arr = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    fn(pos.getX(i), pos.getY(i), pos.getZ(i), TMP_C);
    arr[i * 3] = TMP_C.r;
    arr[i * 3 + 1] = TMP_C.g;
    arr[i * 3 + 2] = TMP_C.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return g;
}

/**
 * Assign skin weights. `fn` returns [boneA, weightA, boneB] – weightB is the
 * remainder. Most parts belong to exactly one bone (weightA = 1).
 */
function skin(
  g: THREE.BufferGeometry,
  fn: (x: number, y: number, z: number) => [number, number, number],
): THREE.BufferGeometry {
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const idx = new Uint16Array(pos.count * 4);
  const wgt = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    const [a, wa, b] = fn(pos.getX(i), pos.getY(i), pos.getZ(i));
    idx[i * 4] = a;
    idx[i * 4 + 1] = b;
    wgt[i * 4] = wa;
    wgt[i * 4 + 1] = 1 - wa;
  }
  g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(idx, 4));
  g.setAttribute("skinWeight", new THREE.BufferAttribute(wgt, 4));
  return g;
}

// ---------------------------------------------------------------------------
// Geometry builders (adapted from the dog: tubes + joint balls on the pivots)
// ---------------------------------------------------------------------------

function ellipsoid(
  rx: number,
  ry: number,
  rz: number,
  x = 0,
  y = 0,
  z = 0,
  wSeg = 12,
  hSeg = 8,
): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, wSeg, hSeg);
  g.scale(rx, ry, rz);
  g.translate(x, y, z);
  return g;
}

function joint(
  r: number,
  x = 0,
  y = 0,
  z = 0,
  wSeg = 9,
  hSeg = 6,
): THREE.BufferGeometry {
  return ellipsoid(r, r, r, x, y, z, wSeg, hSeg);
}

/**
 * Continuously tapered open tube from A to B; `bow` bends the middle along
 * z/x so a limb gets its natural curve. Both mouths are always swallowed by
 * a joint ball or a paw.
 */
function tube(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  radius: (t: number) => number,
  seg = 9,
  rings = 5,
  bowZ = 0,
  bowX = 0,
): THREE.BufferGeometry {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.hypot(dx, dy, dz) || 1e-4;
  const g = new THREE.CylinderGeometry(1, 1, len, seg, rings, true);
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = clamp(0.5 + y / len, 0, 1);
    const r = radius(t);
    const s = Math.sin(Math.PI * t);
    pos.setXYZ(i, pos.getX(i) * r + bowX * s, y, pos.getZ(i) * r + bowZ * s);
  }
  g.computeVertexNormals();
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(dx, dy, dz).normalize(),
  );
  g.applyQuaternion(q);
  g.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  return g;
}

// ---------------------------------------------------------------------------
// Coat texture: neutral fur strands + mottle, tiling, doubles as bump map
// ---------------------------------------------------------------------------

function foxCoatTexture(size: number): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  if (ctx) {
    const k = size / 256;
    ctx.fillStyle = "#b1a897";
    ctx.fillRect(0, 0, size, size);
    // Soft large mottle so the coat never reads as one flat tone
    for (let i = 0; i < 30; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const r = (18 + Math.random() * 46) * k;
      const dark = Math.random() < 0.5;
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
      const a = 0.05 + Math.random() * 0.05;
      grad.addColorStop(
        0,
        dark ? `rgba(60,48,36,${a})` : `rgba(235,228,214,${a})`,
      );
      grad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = grad;
      // Wrap copies keep the tile seamless
      for (const [ox, oy] of [
        [0, 0],
        [size, 0],
        [-size, 0],
        [0, size],
        [0, -size],
      ]) {
        ctx.save();
        ctx.translate(ox, oy);
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
        ctx.restore();
      }
    }
    // Fur flow: short, mostly vertical strands with jitter
    ctx.lineCap = "round";
    const strand = (
      n: number,
      len0: number,
      len1: number,
      width: number,
      alpha: number,
      light: boolean,
    ): void => {
      for (let i = 0; i < n; i++) {
        const x = Math.random() * size;
        const y = Math.random() * size;
        const len = (len0 + Math.random() * (len1 - len0)) * k;
        const slope = (Math.random() - 0.5) * 4 * k;
        const l = light ? 62 + Math.random() * 22 : 26 + Math.random() * 20;
        ctx.strokeStyle = `hsla(32,${8 + Math.random() * 14}%,${l}%,${alpha})`;
        ctx.lineWidth = width * k;
        for (const [ox, oy] of [
          [0, 0],
          [0, size],
          [0, -size],
          [size, 0],
          [-size, 0],
        ]) {
          ctx.beginPath();
          ctx.moveTo(x + ox, y + oy);
          ctx.quadraticCurveTo(
            x + ox + slope * 0.6,
            y + oy + len * 0.5,
            x + ox + slope,
            y + oy + len,
          );
          ctx.stroke();
        }
      }
    };
    strand(900, 7, 16, 1.1, 0.1, true);
    strand(900, 7, 16, 1.1, 0.09, false);
    // Sparse darker guard-hair ticking
    strand(140, 12, 22, 1.3, 0.14, false);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// Coat material: rim/backlight so the coat edge glows like lit fur, plus the
// same keyed night floor the dog uses (the fox is mostly a dusk/night animal
// and must not vanish into the dark dunes).
// ---------------------------------------------------------------------------

const COAT_FRAG_PARS = /* glsl */ `
uniform vec3 uSunDir;
`;

const COAT_FRAG_LIGHT = /* glsl */ `
#if ( NUM_DIR_LIGHTS > 0 )
{
  vec3 fSunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
  float fBack = pow(saturate(dot(-geometryViewDir, fSunV)), 4.0);
  float fRim = pow(1.0 - saturate(dot(geometryNormal, geometryViewDir)), 3.0);
  reflectedLight.directDiffuse += diffuseColor.rgb * directionalLights[0].color
    * (fBack * 0.34 + fRim * 0.2);
}
#endif
{
  float fLum = dot(reflectedLight.directDiffuse + reflectedLight.indirectDiffuse,
    vec3(0.2126, 0.7152, 0.0722));
  vec3 fUp = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  float fSky = 0.34 + 0.66 * (0.5 + 0.5 * dot(geometryNormal, fUp));
  reflectedLight.indirectDiffuse += diffuseColor.rgb
    * (0.36 * fSky * (1.0 - smoothstep(0.0, 0.045, fLum)));
}
`;

// ---------------------------------------------------------------------------
// Skeleton layout (bind pose, fox faces -z, ground y = 0, metres)
// ---------------------------------------------------------------------------

// Bone indices in the skeleton array
const B_BODY = 0;
const B_CHEST = 1;
const B_NECK = 2;
const B_HEAD = 3;
// 4/5 = ears, 6..8 = tail, 9.. = legs (hip, knee) FL FR BL BR

// World bind positions of the joints
const BODY_W: [number, number, number] = [0, 0.3, 0.1];
const CHEST_W: [number, number, number] = [0, 0.305, -0.185];
const NECK_W: [number, number, number] = [0, 0.36, -0.235];
const HEAD_W: [number, number, number] = [0, 0.42, -0.33];
const EAR_W: [number, number, number] = [0.03, 0.462, -0.32];
const TAIL1_W: [number, number, number] = [0, 0.303, 0.235];
const TAIL2_W: [number, number, number] = [0, 0.281, 0.37];
const TAIL3_W: [number, number, number] = [0, 0.265, 0.505];
const TAIL_TIP: [number, number, number] = [0, 0.253, 0.632];
const HIPF_W: [number, number, number] = [0.055, 0.285, -0.19];
const KNEEF_W: [number, number, number] = [0.055, 0.14, -0.185];
const FOOTF_W: [number, number, number] = [0.055, 0.006, -0.178];
const HIPB_W: [number, number, number] = [0.058, 0.292, 0.185];
const KNEEB_W: [number, number, number] = [0.058, 0.144, 0.196];
const FOOTB_W: [number, number, number] = [0.058, 0.006, 0.18];

/** Torso profile front→croup: [t, half width, half height, mid height]. */
const PROFILE: Array<[number, number, number, number]> = [
  [0.0, 0.035, 0.045, 0.315],
  [0.1, 0.055, 0.075, 0.305],
  [0.25, 0.062, 0.088, 0.298],
  [0.45, 0.056, 0.078, 0.3],
  [0.65, 0.05, 0.068, 0.305],
  [0.85, 0.056, 0.072, 0.303],
  [1.0, 0.026, 0.034, 0.3],
];
const Z_FRONT = -0.265;
const Z_BACK = 0.235;

function profileAt(t: number): [number, number, number] {
  let i = 0;
  while (i < PROFILE.length - 2 && PROFILE[i + 1][0] < t) i++;
  const a = PROFILE[i];
  const b = PROFILE[i + 1];
  const s = sstep(a[0], b[0], t);
  return [mix(a[1], b[1], s), mix(a[2], b[2], s), mix(a[3], b[3], s)];
}

function buildTorso(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(1, 1, 1, 12, 12, false);
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const cx = pos.getX(i);
    const cy = pos.getY(i);
    const cz = pos.getZ(i);
    const t = clamp(cy + 0.5, 0, 1);
    const [rx, ry, yc] = profileAt(t);
    const ky = cz < 0 ? 0.88 : 1.0; // belly a little flatter
    pos.setXYZ(i, cx * rx, yc + cz * ry * ky, Z_FRONT + t * (Z_BACK - Z_FRONT));
  }
  g.computeVertexNormals();
  return g;
}

interface FoxLeg {
  hip: THREE.Bone;
  knee: THREE.Bone;
  front: boolean;
  offTrot: number;
  offGallop: number;
  /** Bind z of the hip bone (scapular glide is added on top). */
  hipZ0: number;
}

interface FoxModel {
  root: THREE.Group;
  mesh: THREE.SkinnedMesh;
  body: THREE.Bone;
  chest: THREE.Bone;
  neck: THREE.Bone;
  head: THREE.Bone;
  earL: THREE.Bone;
  earR: THREE.Bone;
  tail: [THREE.Bone, THREE.Bone, THREE.Bone];
  legs: FoxLeg[];
  sunDir: { value: THREE.Vector3 };
  dispose(): void;
}

function bone(
  parent: THREE.Bone | null,
  x: number,
  y: number,
  z: number,
): THREE.Bone {
  const b = new THREE.Bone();
  b.position.set(x, y, z);
  parent?.add(b);
  return b;
}

// ---------------------------------------------------------------------------
// Model assembly
// ---------------------------------------------------------------------------

function buildFox(quality: QualityId): FoxModel {
  const texSize = quality === "low" || quality === "medium" ? 128 : 256;
  const coatTex = foxCoatTexture(texSize);
  const sunDir = { value: new THREE.Vector3(0, 1, 0) };
  const coat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: coatTex,
    bumpMap: coatTex,
    bumpScale: 0.6,
    roughness: 0.93,
    metalness: 0,
  });
  coat.customProgramCacheKey = () => "fox-coat";
  coat.onBeforeCompile = (sh) => {
    sh.uniforms.uSunDir = sunDir;
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>\n${COAT_FRAG_PARS}`)
      .replace(
        "#include <lights_fragment_end>",
        `#include <lights_fragment_end>\n${COAT_FRAG_LIGHT}`,
      );
  };
  const gloss = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.22,
    metalness: 0,
  });

  // --- Bones -------------------------------------------------------------
  const body = bone(null, BODY_W[0], BODY_W[1], BODY_W[2]);
  const chest = bone(
    body,
    CHEST_W[0] - BODY_W[0],
    CHEST_W[1] - BODY_W[1],
    CHEST_W[2] - BODY_W[2],
  );
  const neck = bone(
    chest,
    NECK_W[0] - CHEST_W[0],
    NECK_W[1] - CHEST_W[1],
    NECK_W[2] - CHEST_W[2],
  );
  const head = bone(
    neck,
    HEAD_W[0] - NECK_W[0],
    HEAD_W[1] - NECK_W[1],
    HEAD_W[2] - NECK_W[2],
  );
  const earL = bone(
    head,
    -EAR_W[0] - HEAD_W[0],
    EAR_W[1] - HEAD_W[1],
    EAR_W[2] - HEAD_W[2],
  );
  const earR = bone(
    head,
    EAR_W[0] - HEAD_W[0],
    EAR_W[1] - HEAD_W[1],
    EAR_W[2] - HEAD_W[2],
  );
  const tail1 = bone(
    body,
    TAIL1_W[0] - BODY_W[0],
    TAIL1_W[1] - BODY_W[1],
    TAIL1_W[2] - BODY_W[2],
  );
  const tail2 = bone(
    tail1,
    TAIL2_W[0] - TAIL1_W[0],
    TAIL2_W[1] - TAIL1_W[1],
    TAIL2_W[2] - TAIL1_W[2],
  );
  const tail3 = bone(
    tail2,
    TAIL3_W[0] - TAIL2_W[0],
    TAIL3_W[1] - TAIL2_W[1],
    TAIL3_W[2] - TAIL2_W[2],
  );
  const bones: THREE.Bone[] = [
    body,
    chest,
    neck,
    head,
    earL,
    earR,
    tail1,
    tail2,
    tail3,
  ];
  const legs: FoxLeg[] = [];
  // [side, front, trot offset, gallop offset] – trot = diagonal pairs,
  // gallop = rotary-ish bound (front pair close, hind pair close, half apart)
  const LEGSET: Array<[number, boolean, number, number]> = [
    [-1, true, 0.0, 0.0],
    [1, true, 0.5, 0.13],
    [-1, false, 0.5, 0.52],
    [1, false, 0.0, 0.64],
  ];
  for (const [side, front, offTrot, offGallop] of LEGSET) {
    const hw = front ? HIPF_W : HIPB_W;
    const kw = front ? KNEEF_W : KNEEB_W;
    const parent = front ? chest : body;
    const pw = front ? CHEST_W : BODY_W;
    const hip = bone(
      parent,
      side * hw[0] - pw[0],
      hw[1] - pw[1],
      hw[2] - pw[2],
    );
    const knee = bone(hip, 0, kw[1] - hw[1], kw[2] - hw[2]);
    bones.push(hip, knee);
    legs.push({ hip, knee, front, offTrot, offGallop, hipZ0: hip.position.z });
  }

  // --- Geometry parts ----------------------------------------------------
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry): void => {
    parts.push(g);
  };

  // Torso: chest→croup, blended between chest and body bone for spine flex
  const torso = buildTorso();
  paint(torso, (x, y, z, out) => {
    const t = clamp((z - Z_FRONT) / (Z_BACK - Z_FRONT), 0, 1);
    const [rx, ry, yc] = profileAt(t);
    const up = (y - yc) / Math.max(0.03, ry);
    const flank = Math.abs(x) / Math.max(0.03, rx);
    // Saturated rust along the spine, paler orange low on the flanks
    out.copy(C_RUST_L).lerp(C_RUST, sstep(-0.25, 0.7, up));
    // Faint dark shoulder wash (the "cross" many red foxes carry)
    out.lerp(
      C_DUSK,
      0.3 * sstep(0.3, 0.9, up) * sstep(0.35, 0.05, Math.abs(z + 0.13)),
    );
    // White underside, wide white chest bib at the front
    const bib = sstep(-0.1, -0.55, up) * sstep(-0.13, -0.21, z);
    out.lerp(C_CREAM, Math.max(sstep(-0.45, -0.95, up), bib) * 0.95);
    // Baked occlusion under the belly and in the armpits
    const ao =
      sstep(-0.3, -1.0, up) * 0.22 +
      sstep(0.75, 0.2, flank) * sstep(-0.2, -0.8, up) * 0.1;
    out.multiplyScalar(1 - Math.min(0.3, ao));
  });
  skin(torso, (_x, _y, z) => {
    const w = sstep(0.06, -0.14, z);
    return [B_CHEST, w, B_BODY];
  });
  add(torso);

  // Neck: one tube from inside the ribcage to the head pivot
  const neckG = tube(
    0,
    0.31,
    -0.2,
    HEAD_W[0],
    HEAD_W[1],
    HEAD_W[2],
    (t) => mix(0.05, 0.037, sstep(0, 1, t)),
    10,
    5,
    0.006,
  );
  paint(neckG, (_x, y, z, out) => {
    const t = clamp((z + 0.2) / (HEAD_W[2] + 0.2), 0, 1);
    const axisY = mix(0.31, HEAD_W[1], t);
    const under = sstep(0.005, -0.03, y - axisY);
    out.copy(C_RUST).lerp(C_CREAM, under * 0.95);
    out.multiplyScalar(1 - under * 0.12);
  });
  skin(neckG, (_x, _y, z) => {
    const w = sstep(-0.21, -0.3, z);
    return [B_NECK, w, B_CHEST];
  });
  add(neckG);

  // Head: ball on the pivot (closes the neck at any angle), narrow skull,
  // cheek ruff, slender muzzle. All 100 % head bone.
  const headBall = joint(0.048, HEAD_W[0], HEAD_W[1], HEAD_W[2], 10, 7);
  const skull = ellipsoid(0.047, 0.044, 0.06, 0, 0.428, -0.345, 14, 10);
  const cheeks = ellipsoid(0.054, 0.034, 0.046, 0, 0.402, -0.348, 12, 8);
  const muzzle = tube(
    0,
    0.408,
    -0.37,
    0,
    0.388,
    -0.47,
    (t) => mix(0.026, 0.013, sstep(0, 1, t)),
    9,
    4,
    0,
    0,
  );
  const muzzleTip = joint(0.014, 0, 0.388, -0.468, 8, 6);
  const jaw = ellipsoid(0.018, 0.012, 0.034, 0, 0.38, -0.405, 8, 6);
  const headAll = mergeGeometries(
    [headBall, skull, cheeks, muzzle, muzzleTip, jaw],
    false,
  );
  for (const g of [headBall, skull, cheeks, muzzle, muzzleTip, jaw])
    g.dispose();
  if (!headAll) throw new Error("Fox: could not build the head");
  paint(headAll, (x, y, z, out) => {
    const ax = Math.abs(x);
    // Rust crown fading to a paler face
    out.copy(C_RUST).lerp(C_RUST_L, 0.4 * sstep(0.45, 0.41, y));
    // White muzzle sides, chin and lower cheeks (the fox "mask")
    const low = sstep(0.414, 0.396, y);
    const fore = sstep(-0.345, -0.4, z);
    out.lerp(C_CREAM, Math.min(1, low * (0.35 + fore * 0.65)) * 0.92);
    // Rust bridge stays on top of the muzzle
    out.lerp(
      C_RUST,
      sstep(0.4, 0.415, y) * fore * sstep(0.02, 0.006, ax) * 0.8,
    );
    // Dark tear line between eye and muzzle
    const tear = Math.hypot(
      (ax - 0.026) / 0.013,
      (y - 0.407) / 0.016,
      (z + 0.398) / 0.034,
    );
    out.lerp(C_DUSK, sstep(1.25, 0.45, tear) * 0.5);
    // Throat shadow
    out.multiplyScalar(1 - sstep(0.39, 0.372, y) * 0.18);
  });
  skin(headAll, () => [B_HEAD, 1, B_HEAD]);
  add(headAll);

  // Ears: big triangular, black backs, pale inner fringe
  for (const side of [-1, 1]) {
    const ear = new THREE.ConeGeometry(0.034, 0.098, 7, 1, false);
    ear.translate(0, 0.049, 0);
    ear.scale(1.2, 1, 0.45);
    paint(ear, (_x, y, z, out) => {
      if (z < -0.002)
        out.copy(C_EAR_IN).lerp(C_BLACK, sstep(0.02, 0.085, y) * 0.35);
      else out.copy(C_BLACK);
      // Rusty base blends the ear into the crown
      out.lerp(C_RUST, sstep(0.03, 0.0, y) * 0.55);
    });
    ear.rotateX(0.14);
    ear.rotateZ(side * -0.24);
    ear.translate(side * EAR_W[0], EAR_W[1], EAR_W[2]);
    skin(ear, () => [side < 0 ? 4 : 5, 1, B_HEAD]);
    add(ear);
  }

  // Tail: three segments, bushy brush, dark top, white tip
  const tailPaint = (
    _x: number,
    y: number,
    z: number,
    out: THREE.Color,
  ): void => {
    out.copy(C_RUST).lerp(C_RUST_L, 0.35);
    // Duskier along the top and towards the tip
    out.lerp(
      C_DUSK,
      0.28 * sstep(-0.01, 0.03, y - mix(0.3, 0.256, sstep(0.235, 0.632, z))),
    );
    out.lerp(C_DUSK, sstep(0.44, 0.53, z) * 0.4);
    // White tip (last ~9 cm)
    out.lerp(C_CREAM, sstep(0.545, 0.6, z) * 0.96);
    out.multiplyScalar(1 - 0.12 * sstep(-0.02, -0.05, y - 0.28));
  };
  const t1G = mergeGeometries(
    [
      joint(0.026, TAIL1_W[0], TAIL1_W[1], TAIL1_W[2], 8, 5),
      tube(
        TAIL1_W[0],
        TAIL1_W[1],
        TAIL1_W[2],
        TAIL2_W[0],
        TAIL2_W[1],
        TAIL2_W[2],
        (t) => mix(0.024, 0.046, sstep(0, 0.9, t)),
        9,
        4,
        0,
        0,
      ),
    ],
    false,
  );
  const t2G = mergeGeometries(
    [
      joint(0.047, TAIL2_W[0], TAIL2_W[1], TAIL2_W[2], 9, 6),
      tube(
        TAIL2_W[0],
        TAIL2_W[1],
        TAIL2_W[2],
        TAIL3_W[0],
        TAIL3_W[1],
        TAIL3_W[2],
        (t) => mix(0.046, 0.038, t),
        9,
        4,
      ),
    ],
    false,
  );
  const t3G = mergeGeometries(
    [
      joint(0.039, TAIL3_W[0], TAIL3_W[1], TAIL3_W[2], 9, 6),
      tube(
        TAIL3_W[0],
        TAIL3_W[1],
        TAIL3_W[2],
        TAIL_TIP[0],
        TAIL_TIP[1],
        TAIL_TIP[2],
        (t) => mix(0.038, 0.011, sstep(0.15, 1, t)),
        9,
        4,
        -0.006,
      ),
      joint(0.012, TAIL_TIP[0], TAIL_TIP[1], TAIL_TIP[2], 7, 5),
    ],
    false,
  );
  if (!t1G || !t2G || !t3G) throw new Error("Fox: could not build the tail");
  for (const [g, b] of [
    [t1G, 6],
    [t2G, 7],
    [t3G, 8],
  ] as const) {
    paint(g, tailPaint);
    skin(g, () => [b, 1, b]);
    add(g);
  }

  // Legs: slender tubes, joint balls on the pivots, black stockings
  for (const leg of legs) {
    const side = leg.hip.position.x < 0 ? -1 : 1;
    const hw = leg.front ? HIPF_W : HIPB_W;
    const kw = leg.front ? KNEEF_W : KNEEB_W;
    const fw = leg.front ? FOOTF_W : FOOTB_W;
    const rHip = leg.front ? 0.031 : 0.042;
    const rKnee = leg.front ? 0.017 : 0.019;
    const bulge = leg.front ? 0.14 : 0.3;
    const hx = side * hw[0];
    const upper = mergeGeometries(
      [
        joint(rHip * 1.04, hx, hw[1], hw[2], 9, 6),
        tube(
          hx,
          hw[1],
          hw[2],
          side * kw[0],
          kw[1],
          kw[2],
          (t) =>
            mix(rHip, rKnee, sstep(0.05, 1, t)) *
            (1 + bulge * Math.sin(Math.PI * Math.min(1, t / 0.72))),
          9,
          5,
          leg.front ? 0.008 : 0.02,
        ),
      ],
      false,
    );
    if (!upper) throw new Error("Fox: upper leg missing");
    paint(upper, (_x, y, _z, out) => {
      out.copy(C_RUST).lerp(C_RUST_L, leg.front ? 0.25 : 0.45);
      // Stocking already creeping up towards the elbow/hock
      out.lerp(C_BLACK, sstep(0.2, 0.13, y) * 0.55);
      out.multiplyScalar(1 - 0.14 * sstep(0.26, 0.2, y));
    });
    const hipIdx = 9 + legs.indexOf(leg) * 2;
    skin(upper, () => [hipIdx, 1, hipIdx]);
    add(upper);

    const lower = mergeGeometries(
      [
        joint(rKnee * 1.08, side * kw[0], kw[1], kw[2], 8, 6),
        tube(
          side * kw[0],
          kw[1],
          kw[2],
          side * fw[0],
          fw[1] + 0.012,
          fw[2],
          (t) => mix(rKnee * 0.82, 0.01, sstep(0, 0.85, t)),
          8,
          4,
          leg.front ? -0.004 : 0.014,
        ),
        ellipsoid(
          0.015,
          0.012,
          0.024,
          side * fw[0],
          fw[1] + 0.006,
          fw[2] - 0.006,
          8,
          5,
        ),
      ],
      false,
    );
    if (!lower) throw new Error("Fox: lower leg missing");
    paint(lower, (_x, y, _z, out) => {
      // Black stocking, fading to rust just under the knee
      out.copy(C_BLACK).lerp(C_RUST, sstep(0.1, 0.15, y) * 0.55);
    });
    skin(lower, () => [hipIdx + 1, 1, hipIdx + 1]);
    add(lower);
  }

  // --- Merge + skinned mesh ---------------------------------------------
  const all = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  if (!all) throw new Error("Fox: merge failed");
  all.computeBoundingSphere();
  if (all.boundingSphere) all.boundingSphere.radius += 0.35;
  const mesh = new THREE.SkinnedMesh(all, coat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.add(body);
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones));

  // Gloss details: amber eyes + black nose, one little mesh on the head bone
  const eyeL = ellipsoid(0.011, 0.011, 0.009, -0.033, 0.427, -0.38, 8, 6);
  const eyeR = ellipsoid(0.011, 0.011, 0.009, 0.033, 0.427, -0.38, 8, 6);
  const nose = ellipsoid(0.012, 0.01, 0.01, 0, 0.386, -0.474, 8, 6);
  const glossAll = mergeGeometries([eyeL, eyeR, nose], false);
  for (const g of [eyeL, eyeR, nose]) g.dispose();
  if (!glossAll) throw new Error("Fox: gloss details missing");
  paintRaw(glossAll, (_x, y, _z, out) => {
    if (y < 0.4)
      out.set(0.03, 0.025, 0.022); // nose
    else out.set(0.42, 0.24, 0.06); // amber iris
  });
  glossAll.translate(-HEAD_W[0], -HEAD_W[1], -HEAD_W[2]);
  const glossMesh = new THREE.Mesh(glossAll, gloss);
  glossMesh.castShadow = false;
  glossMesh.receiveShadow = true;
  head.add(glossMesh);

  const root = new THREE.Group();
  root.add(mesh);

  return {
    root,
    mesh,
    body,
    chest,
    neck,
    head,
    earL,
    earR,
    tail: [tail1, tail2, tail3],
    legs,
    sunDir,
    dispose() {
      all.dispose();
      glossAll.dispose();
      coat.dispose();
      gloss.dispose();
      coatTex.dispose();
      mesh.skeleton.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Gait: hip and knee angle of one leg at cycle time p (0..1)
// ---------------------------------------------------------------------------

function stride(
  p: number,
  duty: number,
  amp: number,
  flex: number,
  front: boolean,
): [number, number] {
  const t = p - Math.floor(p);
  let hip: number;
  let knee: number;
  if (t < duty) {
    // Stance: foot on the ground, sweeps front → back linearly (no slide)
    const s = t / duty;
    hip = amp * (1 - 2 * s);
    knee = flex * 0.16 * Math.sin(Math.PI * s);
  } else {
    // Swing: leg folds and reaches forward again
    const s = (t - duty) / (1 - duty);
    hip = -amp * Math.cos(Math.PI * s);
    knee = flex * Math.sin(Math.PI * s) ** 0.85;
  }
  // Carpus folds backwards, hock pulls forward under the belly
  return [hip, front ? -knee * 0.8 : knee];
}

// ---------------------------------------------------------------------------
// Behaviour tuning
// ---------------------------------------------------------------------------

/** Base seconds between appearance rolls (divided by the activity weight). */
const NEXT_MIN = 190;
const NEXT_MAX = 360;
/** Trot cruise speed range (m/s) – rolled once per appearance. */
const TROT_MIN = 3.2;
const TROT_MAX = 3.9;
/** Flat-out flight speed (m/s). */
const FLEE_SPEED = 6.5;
/** Closer than this → flee, no matter what. */
const FLEE_PANIC = 12;
/** Closer than this AND the player closing in → flee. */
const FLEE_NEAR = 18;
/** Anything approaching faster than this within FLEE_FAR → flee (the jeep). */
const FLEE_FAR = 28;
const FAST_APPROACH = 6.2;
/** The appearance ends (slot freed) beyond this distance. */
const DESPAWN_D = 92;
/** Crossing route passes this close to the player (m). */
const PASS_MIN = 15;
const PASS_MAX = 30;
/** Spawn distance from the player (m) – edge of visibility. */
const SPAWN_MIN = 48;
const SPAWN_VAR = 18;
/** Station forecourt to avoid. */
const STATION_X = 96;
const STATION_Z = 118;
const STATION_R = 46;
/** Keep-out radius around the abandoned camp clearing (centre = campSite()). */
const CAMP_R = 20;
/** Body circle pushed out of the static colliders (tents, pine trunks). */
const BODY_R = 0.25;
/** Minimum inland distance (d = z − shoreZ) for waypoints / the pass point. */
const DUNE_MIN = 72;
const PASS_DUNE = 82;
/** Keep this far inside the world bounds. */
const BOUND_M = 20;

/**
 * Crepuscular activity weight: dawn/dusk ≈ 1.65, night ≈ 1.25, midday 0.65.
 * Divides the rolled interval, so the fox shows up every ~3 min at dawn and
 * every ~7 min in the middle of the day.
 */
function activity(env: Environment): number {
  const h = env.timeOfDay;
  const dawn = sstep(4.2, 5.2, h) * (1 - sstep(7.8, 9, h));
  const dusk = sstep(16.2, 17.2, h) * (1 - sstep(19.8, 21, h));
  const twil = Math.max(dawn, dusk);
  const night = Math.max(1 - sstep(4, 6, h), sstep(19.5, 21.5, h));
  return 0.65 + twil + 0.6 * night * (1 - twil);
}

function weatherBlocks(env: Environment): boolean {
  return env.weather === "storm" || env.rain > 0.6;
}

type FoxState = "hidden" | "cross" | "pause" | "flee";

export class Fox {
  private readonly scene: THREE.Scene;
  private readonly quality: QualityId;

  private model: FoxModel | null = null;
  private state: FoxState = "hidden";
  private nextTry: number;

  // Route (world xz waypoints, reused)
  private readonly wps = [
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
  ];
  private wpIndex = 1;
  private routeTotal = 0;
  private distAlong = 0;
  private cruise = 3.5;
  private pausesLeft = 0;
  private nextPauseAt = 0;
  private pauseTimer = 0;
  private appearTime = 0;

  // Motion
  private readonly pos = new THREE.Vector3();
  private yaw = 0;
  private speed = 0;
  private turnRate = 0;
  private pitch = 0;

  // Gait/secondary animation state
  private phase = 0;
  private bob = 0;
  private alertB = 0;
  private fleeB = 0;
  private headYaw = 0;
  private headPitch = 0;
  private bank = 0;
  private tailSway = 0;
  private sniffT = 0;
  private earFlick = 0;
  private earFlickSide = 1;
  private nextFlick = 3;
  private serpT = 0;
  private time = 0;

  // Player tracking (to detect the fast jeep without knowing which it is)
  private readonly lastPlayer = new THREE.Vector3();
  private playerSpeed = 0;
  private playerVx = 0;
  private playerVz = 0;
  private playerInit = false;
  /** Dev harness: a standing debug fox ignores the flee triggers. */
  private debugHold = false;
  /** Dev harness: why the last appearance ended. */
  private endReason = "";

  // Reused temporaries
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();

  constructor(scene: THREE.Scene, quality: QualityId) {
    this.scene = scene;
    this.quality = quality;
    this.nextTry = rand(NEXT_MIN, NEXT_MAX);
  }

  /** Runs only while the game is running; playerPos = player or jeep. */
  update(dt0: number, playerPos: THREE.Vector3, env: Environment): void {
    const dt = Math.min(dt0, 0.1);
    if (dt <= 0) return;
    this.time += dt;

    // Player speed estimate (teleports from the dev harness are ignored)
    if (!this.playerInit) {
      this.lastPlayer.copy(playerPos);
      this.playerInit = true;
    }
    const mvx = playerPos.x - this.lastPlayer.x;
    const mvz = playerPos.z - this.lastPlayer.z;
    const moved = Math.hypot(mvx, mvz);
    if (moved < 3) {
      this.playerSpeed = approach(this.playerSpeed, moved / dt, 6, dt);
      this.playerVx = approach(this.playerVx, mvx / dt, 6, dt);
      this.playerVz = approach(this.playerVz, mvz / dt, 6, dt);
    }
    this.lastPlayer.copy(playerPos);

    if (this.state === "hidden") {
      this.nextTry -= dt * activity(env);
      if (this.nextTry <= 0) {
        if (weatherBlocks(env)) {
          this.nextTry = rand(30, 60);
        } else if (this.tryAppear(playerPos.x, playerPos.z)) {
          // Appearance started
        } else {
          this.nextTry = rand(20, 45);
        }
      }
      return;
    }

    const model = this.model;
    if (!model) return;
    this.appearTime += dt;
    const dist = Math.hypot(playerPos.x - this.pos.x, playerPos.z - this.pos.z);
    // How fast the PLAYER moves towards the fox (their velocity projected on
    // the axis) – the fox's own approach to its route must not scare itself.
    const closing =
      dist > 1e-3
        ? (this.playerVx * (this.pos.x - playerPos.x) +
            this.playerVz * (this.pos.z - playerPos.z)) /
          dist
        : 0;

    // Flee triggers: instant and one-way. A standing player may watch a
    // close pass – only an APPROACH (or the fast jeep) breaks the crossing.
    if (this.state !== "flee" && !this.debugHold) {
      if (
        dist < FLEE_PANIC ||
        (dist < FLEE_NEAR && closing > 0.8) ||
        (dist < FLEE_FAR && this.playerSpeed > FAST_APPROACH)
      ) {
        this.state = "flee";
        this.serpT = 0;
        this.pausesLeft = 0;
      }
    }

    const prevYaw = this.yaw;
    switch (this.state) {
      case "cross": {
        const wp = this.wps[this.wpIndex];
        this.tmp.set(wp.x - this.pos.x, 0, wp.z - this.pos.z);
        const d = this.tmp.length();
        if (d < 1.5) {
          if (this.wpIndex >= this.wps.length - 1) {
            this.endAppearance("route done");
            return;
          }
          this.wpIndex++;
        } else {
          const wantYaw = Math.atan2(-this.tmp.x, -this.tmp.z);
          this.yaw += wrapPi(wantYaw - this.yaw) * Math.min(1, dt * 4);
          this.speed = approach(this.speed, this.cruise, 2.2, dt);
        }
        // Scheduled stop-and-look
        if (this.pausesLeft > 0 && this.distAlong > this.nextPauseAt) {
          this.state = "pause";
          this.pauseTimer = rand(1, 2);
          this.sniffT = 0;
          this.pausesLeft--;
        }
        break;
      }
      case "pause": {
        this.speed = approach(this.speed, 0, 6, dt);
        this.pauseTimer -= dt;
        this.sniffT += dt;
        if (this.pauseTimer <= 0) {
          this.state = "cross";
          this.nextPauseAt = this.distAlong + this.routeTotal * rand(0.15, 0.4);
        }
        break;
      }
      case "flee": {
        this.serpT += dt;
        // Straight away from the player, steered off the sea, the station
        // forecourt and the world edge; a slight serpentine on top.
        this.tmp.set(this.pos.x - playerPos.x, 0, this.pos.z - playerPos.z);
        if (this.tmp.lengthSq() < 1e-4) this.tmp.set(0, 0, 1);
        this.tmp.normalize();
        const dShore = this.pos.z - shoreZ(this.pos.x);
        if (dShore < 70) this.tmp.z += (70 - dShore) * 0.04;
        const sx = this.pos.x - STATION_X;
        const sz = this.pos.z - STATION_Z;
        const sd = Math.hypot(sx, sz);
        if (sd < STATION_R + 14) {
          this.tmp.x += (sx / Math.max(1, sd)) * 1.4;
          this.tmp.z += (sz / Math.max(1, sd)) * 1.4;
        }
        const camp = campSite();
        const cx = this.pos.x - camp.x;
        const cz = this.pos.z - camp.z;
        const cd = Math.hypot(cx, cz);
        if (cd < CAMP_R + 12) {
          this.tmp.x += (cx / Math.max(1, cd)) * 1.4;
          this.tmp.z += (cz / Math.max(1, cd)) * 1.4;
        }
        if (this.pos.x < WORLD_BOUNDS.minX + 30) this.tmp.x += 1;
        if (this.pos.x > WORLD_BOUNDS.maxX - 30) this.tmp.x -= 1;
        if (this.pos.z > WORLD_BOUNDS.maxZ - 30) this.tmp.z -= 1;
        const wantYaw =
          Math.atan2(-this.tmp.x, -this.tmp.z) +
          Math.sin(this.serpT * 2.4) * 0.28;
        this.yaw += wrapPi(wantYaw - this.yaw) * Math.min(1, dt * 5);
        this.speed = approach(this.speed, FLEE_SPEED, 3.5, dt);
        if (dist > DESPAWN_D) {
          this.endAppearance("flee far");
          return;
        }
        break;
      }
      default:
        break;
    }

    // Despawn rules for the crossing itself
    if (this.state === "cross" || this.state === "pause") {
      if (
        (dist > DESPAWN_D && this.distAlong > this.routeTotal * 0.45) ||
        dist > 118 ||
        this.appearTime > 80
      ) {
        this.endAppearance(
          this.appearTime > 80 ? "timeout" : `far d=${dist.toFixed(0)}`,
        );
        return;
      }
    }

    // Move along the heading, slide the body circle out of the static
    // colliders (tents, pine trunks – same query the player uses), then
    // snap to the terrain at the corrected spot
    const step = this.speed * dt;
    this.pos.x -= Math.sin(this.yaw) * step;
    this.pos.z -= Math.cos(this.yaw) * step;
    this.distAlong += step;
    const gy = terrainHeight(this.pos.x, this.pos.z);
    const hit = resolveCircle(this.pos.x, this.pos.z, BODY_R, gy, gy + 0.8);
    this.pos.x = hit.x;
    this.pos.z = hit.z;
    this.pos.y = terrainHeight(this.pos.x, this.pos.z) - 0.012;
    model.root.position.copy(this.pos);
    model.root.rotation.y = this.yaw;
    this.turnRate = approach(
      this.turnRate,
      dt > 1e-4 ? wrapPi(this.yaw - prevYaw) / dt : 0,
      8,
      dt,
    );

    // Slope pitch from the terrain ahead/behind
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const hA = terrainHeight(this.pos.x + fx * 0.3, this.pos.z + fz * 0.3);
    const hB = terrainHeight(this.pos.x - fx * 0.3, this.pos.z - fz * 0.3);
    this.pitch = approach(this.pitch, Math.atan2(hA - hB, 0.6), 6, dt);

    this.animate(dt, playerPos, env, dist);
  }

  // ------------------------------------------------------------------
  // Appearance lifecycle
  // ------------------------------------------------------------------

  private ensureModel(): FoxModel {
    if (!this.model) {
      this.model = buildFox(this.quality);
      this.model.root.visible = false;
      this.scene.add(this.model.root);
    }
    return this.model;
  }

  /**
   * Clamp a waypoint into the dune belt, the bounds and off the station and
   * the camp clearing.
   */
  private clampSpot(v: THREE.Vector3, minDune: number): void {
    v.x = clamp(v.x, WORLD_BOUNDS.minX + BOUND_M, WORLD_BOUNDS.maxX - BOUND_M);
    const zMin = shoreZ(v.x) + minDune;
    if (v.z < zMin) v.z = zMin;
    v.z = Math.min(v.z, WORLD_BOUNDS.maxZ - BOUND_M);
    const dx = v.x - STATION_X;
    const dz = v.z - STATION_Z;
    const d = Math.hypot(dx, dz);
    let pushed = false;
    if (d < STATION_R) {
      const k = STATION_R / Math.max(0.5, d);
      v.x = STATION_X + dx * k;
      v.z = STATION_Z + dz * k;
      pushed = true;
    }
    const camp = campSite();
    let cx = v.x - camp.x;
    let cz = v.z - camp.z;
    let cd = Math.hypot(cx, cz);
    if (cd < CAMP_R) {
      if (cd < 0.5) {
        // A point at the very centre has no direction – push inland
        cx = 0;
        cz = 1;
        cd = 1;
      }
      v.x = camp.x + (cx / cd) * CAMP_R;
      v.z = camp.z + (cz / cd) * CAMP_R;
      pushed = true;
    }
    if (pushed) {
      v.x = clamp(
        v.x,
        WORLD_BOUNDS.minX + BOUND_M,
        WORLD_BOUNDS.maxX - BOUND_M,
      );
      v.z = Math.min(
        Math.max(v.z, shoreZ(v.x) + minDune),
        WORLD_BOUNDS.maxZ - BOUND_M,
      );
    }
  }

  /**
   * Build a crossing route whose middle waypoint passes 15–30 m from the
   * player (or exactly through the debug anchor) and start the appearance.
   */
  private tryAppear(
    px: number,
    pz: number,
    anchorX?: number,
    anchorZ?: number,
    stand = false,
  ): boolean {
    // Route direction: roughly shore-parallel with a random slant
    const along = Math.random() < 0.5 ? 1 : -1;
    const slant = (Math.random() - 0.5) * 0.8;
    const dl = Math.hypot(along, slant);
    const dirX = along / dl;
    const dirZ = slant / dl;
    const perpX = -dirZ;
    const perpZ = dirX;

    const pass = this.wps[2];
    if (anchorX !== undefined && anchorZ !== undefined) {
      pass.set(anchorX, 0, anchorZ);
    } else {
      // Pick the side of the player that lands deeper in the dunes and
      // further from the station
      const passD = rand(PASS_MIN, PASS_MAX);
      let best = -1;
      for (const side of [-1, 1]) {
        this.tmp.set(px + perpX * passD * side, 0, pz + perpZ * passD * side);
        this.clampSpot(this.tmp, PASS_DUNE);
        const dDune = this.tmp.z - shoreZ(this.tmp.x);
        const dStat = Math.hypot(
          this.tmp.x - STATION_X,
          this.tmp.z - STATION_Z,
        );
        const score = Math.min(dDune, 150) + Math.min(dStat, 90);
        if (score > best) {
          best = score;
          pass.copy(this.tmp);
        }
      }
    }
    this.clampSpot(pass, PASS_DUNE);
    // The route must still pass reasonably close to the player
    const passDist = Math.hypot(pass.x - px, pass.z - pz);
    if (anchorX === undefined && (passDist < 10 || passDist > 45)) {
      this.endReason = `no spot (pass ${passDist.toFixed(0)}m)`;
      return false;
    }

    const spawnD = SPAWN_MIN + Math.random() * SPAWN_VAR;
    const back = Math.sqrt(
      Math.max(spawnD * spawnD - passDist * passDist, 30 * 30),
    );
    this.wps[0].set(pass.x - dirX * back, 0, pass.z - dirZ * back);
    this.wps[4].set(
      pass.x + dirX * rand(58, 76),
      0,
      pass.z + dirZ * rand(58, 76),
    );
    const j1 = rand(-5, 5);
    const j3 = rand(-5, 5);
    this.wps[1]
      .copy(this.wps[0])
      .lerp(pass, 0.45)
      .addScaledVector(this.tmp.set(perpX, 0, perpZ), j1);
    this.wps[3]
      .copy(pass)
      .lerp(this.wps[4], 0.5)
      .addScaledVector(this.tmp.set(perpX, 0, perpZ), j3);
    this.clampSpot(this.wps[0], DUNE_MIN);
    this.clampSpot(this.wps[1], DUNE_MIN);
    this.clampSpot(this.wps[3], DUNE_MIN);
    this.clampSpot(this.wps[4], DUNE_MIN);
    this.routeTotal = 0;
    for (let i = 1; i < this.wps.length; i++) {
      const seg = Math.hypot(
        this.wps[i].x - this.wps[i - 1].x,
        this.wps[i].z - this.wps[i - 1].z,
      );
      if (seg < 4) {
        // Clamping collapsed the route – skip this appearance
        this.endReason = `no route (seg ${i} = ${seg.toFixed(1)}m)`;
        return false;
      }
      this.routeTotal += seg;
    }

    // Spawn
    const model = this.ensureModel();
    const start = stand ? pass : this.wps[0];
    this.pos.set(start.x, terrainHeight(start.x, start.z), start.z);
    this.wpIndex = stand ? 3 : 1;
    this.yaw = Math.atan2(-dirX, -dirZ);
    this.speed = 0;
    this.distAlong = stand ? back : 0;
    this.cruise = rand(TROT_MIN, TROT_MAX);
    this.appearTime = 0;
    this.pausesLeft = Math.random() < 0.75 ? (Math.random() < 0.35 ? 2 : 1) : 0;
    this.nextPauseAt = this.routeTotal * rand(0.25, 0.55);
    this.state = stand ? "pause" : "cross";
    this.debugHold = stand;
    this.pauseTimer = stand ? 6 : 0;
    this.sniffT = 0;
    this.phase = Math.random();
    this.fleeB = 0;
    this.alertB = 0;
    model.root.position.copy(this.pos);
    model.root.rotation.y = this.yaw;
    model.root.visible = true;
    return true;
  }

  private endAppearance(reason: string): void {
    if (this.model) this.model.root.visible = false;
    this.state = "hidden";
    this.debugHold = false;
    this.endReason = reason;
    this.nextTry = rand(NEXT_MIN, NEXT_MAX);
  }

  // ------------------------------------------------------------------
  // Animation
  // ------------------------------------------------------------------

  private animate(
    dt: number,
    playerPos: THREE.Vector3,
    env: Environment,
    dist: number,
  ): void {
    const m = this.model;
    if (!m) return;
    const speed = this.speed;
    const moving = speed > 0.15;
    const paused = this.state === "pause";
    const fleeing = this.state === "flee";
    this.fleeB = approach(this.fleeB, fleeing ? 1 : 0, 4, dt);
    this.alertB = approach(
      this.alertB,
      paused ? 1 : moving ? 0.35 : 0.15,
      4,
      dt,
    );

    // Gait blending: stand → trot → gallop
    const trotB = sstep(0.35, 1.5, speed);
    const galB = sstep(4.4, 5.8, speed);
    const duty = mix(mix(0.62, 0.5, trotB), 0.32, galB);
    const strideLen = mix(mix(0.34, 0.92, trotB), 1.85, galB);
    if (moving) this.phase += (speed / strideLen) * dt;
    else this.phase += dt * 0.2;
    const cyc = this.phase * Math.PI * 2;
    const amp = moving
      ? Math.min(0.62, 0.14 + speed * 0.1) * (1 + galB * 0.22)
      : 0.02;
    const flex = moving ? 0.42 + trotB * 0.32 + galB * 0.55 : 0.05;
    const glide = 0.02 * trotB + 0.012 * galB;

    for (const leg of m.legs) {
      const off = mix(leg.offTrot, leg.offGallop, galB);
      const [hip, knee] = stride(this.phase + off, duty, amp, flex, leg.front);
      const rest = leg.front ? 0.04 : -0.05;
      const kneeRest = leg.front ? -0.1 : 0.17;
      leg.hip.rotation.x = hip + rest;
      leg.knee.rotation.x = knee + kneeRest;
      // Scapular glide: the leg anchor slides opposite the swing, which buys
      // stride length a small skeleton cannot reach with rotation alone
      leg.hip.position.z = leg.hipZ0 - (amp > 1e-3 ? hip / amp : 0) * glide;
    }

    // Body: bounce (2/cycle at a trot, 1/cycle bound at the gallop), slope
    // pitch, gallop stretch, bank into the turn
    const bounce = moving
      ? (1 - galB) * Math.sin(cyc * 2) * (0.006 + trotB * 0.008) +
        galB * Math.sin(cyc) * 0.042
      : Math.sin(this.time * 1.1) * 0.0025;
    this.bob = approach(this.bob, bounce, 24, dt);
    m.body.position.y = BODY_W[1] + this.bob;
    const bankT = clamp(
      this.turnRate * Math.min(speed, 7) * 0.045,
      -0.24,
      0.24,
    );
    this.bank = approach(this.bank, bankT, 5, dt);
    m.body.rotation.x =
      this.pitch +
      (moving ? Math.sin(cyc + 0.7) * (0.012 + galB * 0.085) : 0) -
      galB * 0.03;
    m.body.rotation.z = this.bank;
    // Spine flex: chest counter-rotates, strongest in the bound
    m.chest.rotation.x =
      (moving ? Math.sin(cyc + 2.2) * (0.02 + galB * 0.1) : 0) - galB * 0.02;

    // Head look: towards the player while pausing, else down the track
    let lookYaw = 0;
    let lookPitch = 0;
    if (paused || (!fleeing && dist < 40)) {
      this.tmp2.set(playerPos.x - this.pos.x, 0, playerPos.z - this.pos.z);
      if (this.tmp2.lengthSq() > 0.1) {
        const bearing = wrapPi(
          Math.atan2(-this.tmp2.x, -this.tmp2.z) - this.yaw,
        );
        const k = paused ? 0.85 : 0.3;
        lookYaw = clamp(bearing, -1.1, 1.1) * k;
        lookPitch = paused ? 0.06 : 0.02;
      }
    }
    this.headYaw = approach(this.headYaw, lookYaw, paused ? 5 : 3, dt);
    this.headPitch = approach(this.headPitch, lookPitch, 4, dt);
    // Sniff: a couple of small nose bobs while standing
    const sniffWin =
      paused && this.sniffT > 0.5 && this.sniffT < 1.6
        ? Math.sin(((this.sniffT - 0.5) * Math.PI) / 1.1)
        : 0;
    const sniffBob = sniffWin * Math.sin(this.sniffT * 18) * 0.06;
    m.neck.rotation.x =
      this.alertB * 0.16 -
      m.body.rotation.x * 0.6 -
      this.fleeB * 0.22 +
      (moving ? Math.sin(cyc * 2 + 1.2) * 0.02 * trotB : 0);
    m.neck.rotation.y = this.headYaw * 0.35;
    m.head.rotation.x =
      this.headPitch +
      sniffBob -
      (moving ? Math.sin(cyc * 2 + 1.2) * 0.025 * (trotB + galB) : 0) +
      this.fleeB * 0.1;
    m.head.rotation.y = this.headYaw * 0.65;
    m.head.rotation.z = -this.bank * 0.4;

    // Ears: track the player when attentive, flatten when fleeing, flick
    this.nextFlick -= dt;
    if (this.nextFlick <= 0) {
      this.nextFlick = rand(2.5, 7);
      this.earFlick = 1;
      this.earFlickSide = Math.random() < 0.5 ? 0 : 1;
    }
    this.earFlick *= Math.exp(-9 * dt);
    const earTrack = clamp(lookYaw - this.headYaw * 0.6, -0.35, 0.35);
    const earX = -0.12 * this.alertB + this.fleeB * 0.65;
    const earY = earTrack * 0.5;
    const earZ = 0.06 - this.alertB * 0.1 + this.fleeB * 0.3;
    const flick = this.earFlick * 0.5;
    m.earL.rotation.x = earX + (this.earFlickSide === 0 ? flick : 0);
    m.earL.rotation.y = earY;
    m.earL.rotation.z = -earZ;
    m.earR.rotation.x = earX + (this.earFlickSide === 1 ? flick : 0);
    m.earR.rotation.y = earY;
    m.earR.rotation.z = earZ;

    // Tail: low and loose at the trot, streaming straight when fleeing
    this.tailSway += dt * (3 + speed * 0.8);
    const sway =
      Math.sin(this.tailSway) * (0.05 + trotB * 0.05) * (1 - this.fleeB);
    const lag = clamp(-this.turnRate * 0.16, -0.3, 0.3);
    m.tail[0].rotation.x =
      0.08 * (1 - this.fleeB) -
      this.fleeB * 0.3 +
      Math.sin(cyc * 2) * 0.03 * trotB +
      galB * Math.sin(cyc + 1) * 0.1;
    m.tail[0].rotation.y = sway + lag;
    m.tail[1].rotation.x = 0.05 - this.fleeB * 0.1;
    m.tail[1].rotation.y =
      Math.sin(this.tailSway - 0.7) *
        (0.07 + trotB * 0.06) *
        (1 - this.fleeB * 0.7) +
      lag * 0.6;
    m.tail[2].rotation.x = 0.04 - this.fleeB * 0.06;
    m.tail[2].rotation.y =
      Math.sin(this.tailSway - 1.3) *
      (0.09 + trotB * 0.07) *
      (1 - this.fleeB * 0.7);

    // Coat rim light follows the key light
    m.sunDir.value.copy(env.isDay ? env.sunDir : env.moonDir);
  }

  // ------------------------------------------------------------------
  // Dev harness only
  // ------------------------------------------------------------------

  /**
   * Dev harness only: force an appearance. The route passes through (x, z)
   * (default: picked around the player as usual); `stand` starts the fox
   * paused at that point, looking at the player – for close-up screenshots.
   * Debug appearances never flee on their own (debugFlee() forces it), so a
   * camera parked right next to the route does not break the crossing.
   */
  debugAppear(x?: number, z?: number, stand = false): boolean {
    if (this.state !== "hidden") this.endAppearance("debug restart");
    const ok = this.tryAppear(
      this.lastPlayer.x,
      this.lastPlayer.z,
      x,
      z,
      stand,
    );
    if (ok) this.debugHold = true;
    return ok;
  }

  /** Dev harness only: force the active appearance into flee. */
  debugFlee(): void {
    if (this.state === "cross" || this.state === "pause") {
      this.state = "flee";
      this.debugHold = false;
      this.serpT = 0;
      this.pausesLeft = 0;
    }
  }

  /** Dev harness only: state snapshot for the screenshot scripts. */
  debugInfo(): {
    state: FoxState;
    x: number;
    z: number;
    speed: number;
    nextTry: number;
    endReason: string;
  } {
    return {
      state: this.state,
      x: this.pos.x,
      z: this.pos.z,
      speed: this.speed,
      nextTry: this.nextTry,
      endReason: this.endReason,
    };
  }

  dispose(): void {
    if (this.model) {
      this.scene.remove(this.model.root);
      this.model.dispose();
      this.model = null;
    }
    this.state = "hidden";
  }
}
