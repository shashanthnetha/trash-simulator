// Trash Simulator – model, shell fur and gait of the collecting dog.
// The torso is a cylinder deformed along a profile; head/ears/tail and the four
// two-segment legs hang off it as groups. The fur markings (saddle, light
// chest, socks, dark muzzle) sit in vertex colours so that the whole dog gets
// by with a single fur material.
//
// SOLID BODY: every furry part is drawn TWICE – once as an opaque, depth-writing
// skin mesh (`fur` material, no blending, no alphaTest) and once as the shell
// stack on top. The skin is what guarantees the silhouette; the shells only add
// softness and can never open a hole, because at fur LOD 0 they are switched off
// entirely and the skin alone remains. Every dog mesh also RECEIVES shadows –
// without that the dog was the only lit object in the scene that never darkened,
// which together with a belly painted almost exactly sand-coloured made it read
// as translucent even though not a single pixel was ever blended.
//
// FUR: over every furry part sits a shell layer – N concentric copies of the
// same geometry, extruded along the normal in the vertex shader (one
// InstancedMesh per part, the shell index comes from gl_InstanceID, so a part
// stays one draw call). Each shell keeps only the cross-section of the hairs
// that are still longer than its own height (strand field from
// companions-textures.ts, sampled triplanar in object space so the hair size
// does not depend on the UV layout). The hairs are combed backwards, droop
// under gravity and sway in the wind; `aFur.x` per vertex makes the coat long
// on the flanks and short on muzzle, neck, legs and over the shoulder/hip
// masses, `aFur.y` makes the strands finer on thin parts such as the tail.
//
// LIMBS: neck and legs are continuous tapered tubes (`tube()`), not stacked
// cones. Every articulated joint carries a ball whose centre sits EXACTLY on the
// pivot and whose radius is a little larger than the two tube rims that meet
// there – so the silhouette stays closed at any bend angle and no ring seam can
// appear. The lower legs deliberately carry no shells; the upper-leg coat fades
// to zero length before the knee, so there is no fur edge either.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { FUR_TILE_M, furShellTexture, pbrFur } from "./companions-textures";
import { applyPbr, pbrSeatFabric } from "./textures";
import type { QualityId } from "./types";

export interface DogLeg {
  /** Shoulder/hip – swings the whole leg. */
  hip: THREE.Group;
  /** Elbow/hock – bends the lower leg. */
  knee: THREE.Group;
  front: boolean;
  /** Phase offset within the gait cycle (0..1), per gait. */
  offWalk: number;
  offTrot: number;
  offGallop: number;
}

/** Shared uniforms of the shell fur (one set for the whole dog). */
export interface FurUniforms {
  uFurTex: { value: THREE.Texture };
  uShells: { value: number };
  uLen: { value: number };
  uTime: { value: number };
  uWind: { value: number };
  uWindDir: { value: THREE.Vector2 };
  uSunDir: { value: THREE.Vector3 };
  uDensity: { value: number };
}

export interface DogModel {
  root: THREE.Group;
  /** Bounces and bobs while running. */
  body: THREE.Group;
  head: THREE.Group;
  ears: THREE.Group[];
  tail: THREE.Group[];
  legs: DogLeg[];
  /** Anchor point for carried trash (the muzzle). */
  mouth: THREE.Object3D;
  /** Fur shells (one InstancedMesh per furry part). */
  shells: THREE.InstancedMesh[];
  fur: FurUniforms;
  /** Shell count of the current quality tier (LOD upper bound). */
  shellMax: number;
  dispose(): void;
}

/** Shell count per quality tier. */
const SHELLS: Record<QualityId, number> = {
  ultra: 12,
  high: 8,
  medium: 5,
  low: 3,
};
/**
 * How far the shells reach: 3 = with the upper legs, 2 = plus tail,
 * 1 = torso/head/ears only. The LOWER legs never get shells – a short-haired
 * dog reads fine as texture there, and a shell stack that stops at the knee is
 * exactly what produced the ring seam the owner saw. Every part is one extra
 * draw call, so this also buys back four of them at "high".
 */
const SHELL_SCOPE: Record<QualityId, number> = {
  ultra: 3,
  high: 2,
  medium: 2,
  low: 1,
};
/** Length of the longest hair in metres (× aFur.x per vertex). */
const FUR_LEN = 0.026;

// Fur markings. C_CREAM is deliberately a good deal darker than the beach
// (rendered sand is ≈ 217,199,156): with the old #e2d2b2 the whole underside of
// the dog matched the sand to within a few units and disappeared into it.
const C_TAN = new THREE.Color("#b3803f");
const C_DARK = new THREE.Color("#6b4b28");
const C_CREAM = new THREE.Color("#d3bf98");
const C_MUZZLE = new THREE.Color("#4a341c");
// Neutral base tone of the fur texture – the vertex colour multiplies onto it
const FUR_BASE = new THREE.Color("#cfc6b6");

const TMP = new THREE.Color();

/** Set vertex colours from a function of the local position. */
function paint(
  g: THREE.BufferGeometry,
  fn: (x: number, y: number, z: number, out: THREE.Color) => void,
): THREE.BufferGeometry {
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const arr = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    fn(pos.getX(i), pos.getY(i), pos.getZ(i), TMP);
    arr[i * 3] = TMP.r / FUR_BASE.r;
    arr[i * 3 + 1] = TMP.g / FUR_BASE.g;
    arr[i * 3 + 2] = TMP.b / FUR_BASE.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return g;
}

function sstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ---------------------------------------------------------------------------
// Shell fur shader
// ---------------------------------------------------------------------------

const FUR_VERT_PARS = /* glsl */ `
uniform float uShells;
uniform float uLen;
uniform float uTime;
uniform float uWind;
uniform vec2 uWindDir;
uniform float uDensity;
// x = relative Haarlaenge, y = Strandichte-Faktor. Duenne Teile (Rute) bekommen
// feinere Straehnen, sonst saegezahnt der Schalenrand auf dem duennen Kegel.
attribute vec2 aFur;
varying float vShell;
varying float vFace;
varying vec3 vFurPos;
varying vec3 vFurNrm;
`;

/**
 * After <begin_vertex>: push the shell outwards. The direction is the normal
 * plus a comb (towards the tail), the gravity droop and the wind – all three
 * grow with the shell height, so the hairs bend instead of standing straight
 * up. The world vectors are rotated into object space by multiplying from the
 * left (modelMatrix has no scale, so transpose = inverse).
 */
const FUR_VERT_BODY = /* glsl */ `
vShell = (float(gl_InstanceID) + 1.0) / uShells;
vFurPos = position * (uDensity * aFur.y);
vFurNrm = objectNormal;
vec3 fDown = (vec4(0.0, -1.0, 0.0, 0.0) * modelMatrix).xyz;
vec3 fWind = (vec4(uWindDir.x, 0.0, uWindDir.y, 0.0) * modelMatrix).xyz;
float fSway = 0.62 + 0.38 * sin(uTime * 2.3 + position.z * 10.0 + position.x * 6.0);
vec3 fDir = objectNormal
  + vec3(0.0, 0.0, 0.46) * vShell
  + fDown * (0.40 * vShell)
  + fWind * (uWind * uWind * 0.85 * fSway * vShell);
transformed += normalize(fDir) * (uLen * aFur.x * vShell);
// 1 = looking straight into the coat (you see skin between the hairs anyway),
// 0 = grazing (you look ALONG the hairs and the coat has depth).
vec4 fMv = modelViewMatrix * vec4(transformed, 1.0);
vFace = abs(dot(normalize(normalMatrix * objectNormal), normalize(-fMv.xyz)));
`;

const FUR_FRAG_PARS = /* glsl */ `
uniform sampler2D uFurTex;
uniform vec3 uSunDir;
varying float vShell;
varying float vFace;
varying vec3 vFurPos;
varying vec3 vFurNrm;
`;

/**
 * Very first thing in main(): triplanar strand lookup (dominant axis, no
 * blending – averaging two random strand fields would only produce mush) and
 * the cut. Everything shorter than this shell has already ended.
 *
 * The lookup MUST use explicit gradients: where the dominant axis flips, the
 * uv jumps between two projections, the implicit derivative explodes and the
 * GPU falls back to the coarsest mip – which turned whole bands of the torso
 * into smooth grey. The gradients are taken from the continuous object-space
 * position instead, with the same axis selection.
 */
const FUR_FRAG_CUT = /* glsl */ `
vec3 fAbs = abs(vFurNrm);
vec3 fPdx = dFdx(vFurPos);
vec3 fPdy = dFdy(vFurPos);
vec2 fUv;
vec2 fGx;
vec2 fGy;
if (fAbs.x > fAbs.y && fAbs.x > fAbs.z) {
  fUv = vFurPos.zy; fGx = fPdx.zy; fGy = fPdy.zy;
} else if (fAbs.y > fAbs.z) {
  fUv = vFurPos.xz; fGx = fPdx.xz; fGy = fPdy.xz;
} else {
  fUv = vFurPos.xy; fGx = fPdx.xy; fGy = fPdy.xy;
}
vec3 fTex = texture2DGradEXT(uFurTex, fUv, fGx * 0.45, fGy * 0.45).rgb;
// Per-strand offset on the cut height. Without it every shell ends on the same
// iso-line of the strand field, and on a curved flank those iso-lines line up
// into the concentric "sausages" the owner saw over shoulder and hip. .g is the
// per-strand random, .b the clump density – both are constant per strand, so
// the rim gets ragged without a single pixel of noise flicker.
float fCut = vShell + (fTex.g - 0.5) * 0.17 + (fTex.b - 0.5) * 0.09;
// The two innermost shells always survive: they are the closed undercoat, so
// no bare skin can show through the gaps between the strands.
if (fTex.r < fCut && vShell > 0.18) discard;
`;

/**
 * After <color_fragment>: dark at the roots, per-hair brightness scatter.
 * The root darkening is faded out where the coat is seen face-on: there only
 * the innermost shell survives the cut, so a fixed gradient turned flanks and
 * back into a flat, grey, half-lit patch beside the fluffy, tip-lit shoulders –
 * which is a good part of why the body did not read as solid fur.
 */
const FUR_FRAG_COLOR = /* glsl */ `
float fRoot = mix(0.6 + 0.46 * vShell, 0.95 + 0.11 * vShell, vFace * vFace);
diffuseColor.rgb *= fRoot * (0.82 + 0.36 * fTex.g);
`;

/**
 * After <lights_fragment_end>, on BOTH the skin and the shells: a tiny light
 * floor that only opens up when almost nothing else reaches the surface. At
 * deep night the dog measured a mean luminance of 7 with 78 % of its pixels
 * within ΔRGB 60 of the sand – it simply was not there any more. The term is
 * keyed to the light that has actually arrived, so by day (and in the sun
 * shadow, which still gets ambient + hemisphere) it stays exactly 0.
 */
const NIGHT_LIFT = /* glsl */ `
{
  float fLum = dot(reflectedLight.directDiffuse + reflectedLight.indirectDiffuse,
    vec3(0.2126, 0.7152, 0.0722));
  vec3 fUp = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  // Shaped like a hemisphere light, not like a lamp inside the dog: the back
  // catches the sky, the belly stays dark, so the body keeps its volume.
  float fSky = 0.34 + 0.66 * (0.5 + 0.5 * dot(geometryNormal, fUp));
  reflectedLight.indirectDiffuse += diffuseColor.rgb
    * (0.40 * fSky * (1.0 - smoothstep(0.0, 0.045, fLum)));
}
`;

/**
 * After <lights_fragment_end>: what makes fur read as fur is the light that
 * passes THROUGH the hair tips. Backlight against the sun plus a narrow rim,
 * both only on the outer shells (vShell²). Deliberately restrained – at 0.85 the
 * tips bleached out to sand brightness and the coat lost its silhouette.
 */
const FUR_FRAG_LIGHT = /* glsl */ `
#if ( NUM_DIR_LIGHTS > 0 )
{
  vec3 fSunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
  float fBack = pow(saturate(dot(-geometryViewDir, fSunV)), 4.0);
  float fRim = pow(1.0 - saturate(dot(geometryNormal, geometryViewDir)), 3.0);
  reflectedLight.directDiffuse += diffuseColor.rgb * directionalLights[0].color
    * (fBack * 0.44 + fRim * 0.15) * vShell * vShell;
}
#endif
${NIGHT_LIFT}`;

function makeShellMaterial(u: FurUniforms): THREE.MeshStandardMaterial {
  // Explicitly opaque: no blending, no alphaTest, depth written. The coverage
  // comes solely from the discard in FUR_FRAG_CUT, and an opaque skin mesh sits
  // under every shell stack – nothing here may ever let the background through.
  const m = new THREE.MeshStandardMaterial({
    color: FUR_BASE,
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
    transparent: false,
    depthWrite: true,
    depthTest: true,
    alphaTest: 0,
  });
  m.customProgramCacheKey = () => "dog-fur-shell";
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", `#include <common>\n${FUR_VERT_PARS}`)
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>\n${FUR_VERT_BODY}`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>\n${FUR_FRAG_PARS}`)
      .replace(
        "#include <clipping_planes_fragment>",
        `#include <clipping_planes_fragment>\n${FUR_FRAG_CUT}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>\n${FUR_FRAG_COLOR}`,
      )
      .replace(
        "#include <lights_fragment_end>",
        `#include <lights_fragment_end>\n${FUR_FRAG_LIGHT}`,
      );
  };
  return m;
}

/** LOD: fewer shells at a distance (the strand texture blurs anyway). */
export function setDogFurLod(dog: DogModel, shells: number): void {
  const n = Math.max(0, Math.min(dog.shellMax, Math.round(shells)));
  if (dog.shells.length === 0) return;
  if (n > 0) dog.fur.uShells.value = n;
  for (const s of dog.shells) {
    s.count = Math.max(1, n);
    s.visible = n > 0;
  }
}

// ---------------------------------------------------------------------------
// Torso
// ---------------------------------------------------------------------------

/**
 * Profile (t = 0 neck base → 1 croup): half width, half height, mid height.
 * Slimmer than a barrel: deep but narrow brisket, a real tuck-up at the loin,
 * hips slightly wider than the chest. The old profile was 0.152 half-width at
 * the shoulder, which together with the ruff made the front of the dog a bulb.
 */
const PROFILE: Array<[number, number, number, number]> = [
  [0.0, 0.05, 0.06, 0.492],
  [0.09, 0.09, 0.126, 0.47],
  [0.24, 0.117, 0.162, 0.452],
  [0.44, 0.11, 0.15, 0.452],
  [0.62, 0.1, 0.132, 0.462],
  [0.8, 0.115, 0.15, 0.468],
  [0.92, 0.098, 0.12, 0.474],
  [1.0, 0.042, 0.048, 0.478],
];

const Z_FRONT = -0.34;
const Z_BACK = 0.44;

function profileAt(t: number): [number, number, number] {
  let i = 0;
  while (i < PROFILE.length - 2 && PROFILE[i + 1][0] < t) i++;
  const a = PROFILE[i];
  const b = PROFILE[i + 1];
  const k = Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0])));
  const s = k * k * (3 - 2 * k);
  return [
    a[1] + (b[1] - a[1]) * s,
    a[2] + (b[2] - a[2]) * s,
    a[3] + (b[3] - a[3]) * s,
  ];
}

function buildTorso(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(1, 1, 1, 14, 16, false);
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const cx = pos.getX(i);
    const cy = pos.getY(i);
    const cz = pos.getZ(i);
    const t = Math.min(1, Math.max(0, cy + 0.5));
    const [rx, ry, yc] = profileAt(t);
    // Belly a little flatter, back rounder
    const ky = cz < 0 ? 0.86 : 1.0;
    pos.setXYZ(i, cx * rx, yc + cz * ry * ky, Z_FRONT + t * (Z_BACK - Z_FRONT));
  }
  g.computeVertexNormals();
  return g;
}

/** Truncated cone between two points (neck, legs, tail). */
function limb(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  ra: number,
  rb: number,
  seg = 10,
): THREE.BufferGeometry {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.hypot(dx, dy, dz) || 1e-4;
  const g = new THREE.CylinderGeometry(rb, ra, len, seg, 1, false);
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(dx, dy, dz).normalize(),
  );
  g.applyQuaternion(q);
  g.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  return g;
}

function ellipsoid(
  rx: number,
  ry: number,
  rz: number,
  x = 0,
  y = 0,
  z = 0,
  wSeg = 14,
  hSeg = 10,
): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, wSeg, hSeg);
  g.scale(rx, ry, rz);
  g.translate(x, y, z);
  return g;
}

/**
 * Continuously tapered tube from A to B: the radius comes from `radius(t)`
 * (t = 0 at A, 1 at B), `bow` bends the middle sideways along `bowZ`/`bowX` so
 * a limb gets its natural curve without a second segment. Open-ended – both
 * mouths are always swallowed by a joint ball or a paw, which saves the caps
 * and, more importantly, means there is no flat disc that could show as a seam.
 */
function tube(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  radius: (t: number) => number,
  seg = 10,
  rings = 6,
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
    const t = Math.min(1, Math.max(0, 0.5 + y / len));
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

/**
 * Joint ball. Its centre MUST be the pivot of the group it lives in and its
 * radius a touch larger than the two tube rims that meet there – then the
 * silhouette stays closed at every bend angle of the gait.
 */
function joint(
  r: number,
  x = 0,
  y = 0,
  z = 0,
  wSeg = 10,
  hSeg = 6,
): THREE.BufferGeometry {
  return ellipsoid(r, r, r, x, y, z, wSeg, hSeg);
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

const LEG_X = 0.086;
const SHOULDER_Z = -0.19;
const HIP_Z = 0.275;
const SHOULDER_Y = 0.44;
const HIP_Y = 0.452;
const UPPER = 0.225;
const LOWER = 0.178;
/**
 * Length of the pastern column below the knee, front / hind. The shoulder pivot
 * sits 1.2 cm LOWER than the hip, so with one shared value the front paws sank
 * 3.3 cm into the sand while the hind ones only sank 1.4 – the front of the dog
 * permanently stood in a hole. Split, both ends now touch down at ≈ 0.8 cm.
 */
const FOOT_Y_F = -(LOWER + 0.009);
const FOOT_Y_B = -(LOWER + 0.029);
/** Rest pose of the head group (sniffing lowers it out of this). */
export const HEAD_REST_Y = 0.615;
export const HEAD_REST_Z = -0.468;

/** Where the neck leaves the ribcage (y, z) – it ends on the head pivot. */
const NECK_A: [number, number] = [0.462, -0.24];

/** Radii of the four leg joints – front / hind, hip ball and knee ball. */
const R_HIP_F = 0.048;
const R_HIP_B = 0.056;
const R_KNEE_F = 0.036;
const R_KNEE_B = 0.04;

/** Where the legs leave the torso – the coat is kept short around these. */
const LEG_ANCHORS: Array<[number, number, number]> = [
  [LEG_X, SHOULDER_Y, SHOULDER_Z],
  [-LEG_X, SHOULDER_Y, SHOULDER_Z],
  [LEG_X, HIP_Y, HIP_Z],
  [-LEG_X, HIP_Y, HIP_Z],
];

/** 1 right at a leg root, 0 away from it. */
function legNear(x: number, y: number, z: number): number {
  let m = 0;
  for (const [ax, ay, az] of LEG_ANCHORS) {
    const d = Math.hypot(x - ax, (y - ay) * 0.85, z - az);
    const v = sstep(0.2, 0.06, d);
    if (v > m) m = v;
  }
  return m;
}

/**
 * Shoulder blade and haunch as normalised ellipsoids (|x|, y, z, then the three
 * radii). Over these two masses the coat is combed short: they are the only
 * places where the torso curves away sharply, and a long shell stack on a
 * sharply curved surface lines its rims up into the concentric "sausages" the
 * owner saw. Short hair there – exactly the way a real dog's coat lies flat
 * over the scapula – and the bulge reads as muscle again instead of a lobe.
 */
const FUR_MASSES: Array<[number, number, number, number, number, number]> = [
  [0.078, SHOULDER_Y + 0.008, SHOULDER_Z, 0.046, 0.098, 0.108],
  [0.072, HIP_Y + 0.004, HIP_Z, 0.052, 0.108, 0.118],
];

/** 1 in the middle of a shoulder/hip mass, 0 outside it. */
function massNear(x: number, y: number, z: number): number {
  let m = 0;
  for (const [cx, cy, cz, rx, ry, rz] of FUR_MASSES) {
    const d = Math.hypot(
      (Math.abs(x) - cx) / (rx * 1.9),
      (y - cy) / (ry * 1.15),
      (z - cz) / (rz * 1.15),
    );
    const v = sstep(1.05, 0.35, d);
    if (v > m) m = v;
  }
  return m;
}

type FurLenFn = (x: number, y: number, z: number) => number;

export function buildDog(quality: QualityId = "high"): DogModel {
  const fur = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
  });
  applyPbr(fur, pbrFur(), [7, 5]);
  // Same night floor as the shells – otherwise the skin under the coat stays
  // black and the dog gets a bright outline around a dark hole.
  fur.customProgramCacheKey = () => "dog-fur-skin";
  fur.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      "#include <lights_fragment_end>",
      `#include <lights_fragment_end>\n${NIGHT_LIFT}`,
    );
  };
  const gloss = new THREE.MeshStandardMaterial({
    color: 0x15171b,
    roughness: 0.12,
    metalness: 0.05,
  });
  const cloth = new THREE.MeshStandardMaterial({ color: 0xffffff });
  applyPbr(cloth, pbrSeatFabric("#b8352c"), [3, 3]);
  const leather = new THREE.MeshStandardMaterial({
    color: 0x3b2a1c,
    roughness: 0.6,
  });
  const brass = new THREE.MeshStandardMaterial({
    color: 0xc9a227,
    roughness: 0.32,
    metalness: 0.9,
  });
  const furU: FurUniforms = {
    uFurTex: { value: furShellTexture() },
    uShells: { value: SHELLS[quality] },
    uLen: { value: FUR_LEN },
    uTime: { value: 0 },
    uWind: { value: 0.2 },
    uWindDir: { value: new THREE.Vector2(1, 0) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uDensity: { value: 1 / FUR_TILE_M },
  };
  const shellMat = makeShellMaterial(furU);
  const mats: THREE.Material[] = [fur, gloss, cloth, leather, brass, shellMat];
  const geos: THREE.BufferGeometry[] = [];
  const shells: THREE.InstancedMesh[] = [];
  const shellMax = SHELLS[quality];
  const scope = SHELL_SCOPE[quality];

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const mesh = (
    g: THREE.BufferGeometry,
    m: THREE.Material,
    parent: THREE.Object3D,
    shadow = true,
  ): THREE.Mesh => {
    geos.push(g);
    const me = new THREE.Mesh(g, m);
    me.castShadow = shadow;
    // The dog was the ONLY lit object in the world that never received a
    // shadow – no self-shadowing under the belly or between the legs, so the
    // body had no form and read as a flat, half-transparent decal on the sand.
    me.receiveShadow = true;
    parent.add(me);
    return me;
  };

  /**
   * Skin mesh + shell fur over the same geometry. `tier` gates by quality,
   * `dens` scales the strand frequency (> 1 = finer hairs on thin parts).
   */
  const furry = (
    g: THREE.BufferGeometry,
    parent: THREE.Object3D,
    len: FurLenFn,
    tier: number,
    shadow = true,
    dens = 1,
  ): void => {
    mesh(g, fur, parent, shadow);
    if (scope < tier || shellMax <= 0) return;
    const pos = g.getAttribute("position") as THREE.BufferAttribute;
    const arr = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      arr[i * 2] = len(pos.getX(i), pos.getY(i), pos.getZ(i));
      arr[i * 2 + 1] = dens;
    }
    g.setAttribute("aFur", new THREE.BufferAttribute(arr, 2));
    const im = new THREE.InstancedMesh(g, shellMat, shellMax);
    im.castShadow = false;
    im.receiveShadow = true;
    g.computeBoundingSphere();
    if (g.boundingSphere) {
      im.boundingSphere = g.boundingSphere.clone();
      im.boundingSphere.radius += FUR_LEN * 2.2;
    }
    parent.add(im);
    shells.push(im);
  };

  // --- Torso with neck; the shoulder and haunch masses belong to the rigid
  // torso, otherwise they swing along with the leg as loose spheres. The neck
  // is one continuous tube that starts deep inside the ribcage, so head →
  // neck → shoulders is a single flowing line instead of a bulb.
  const torsoParts = [
    buildTorso(),
    tube(
      0,
      NECK_A[0],
      NECK_A[1],
      0,
      HEAD_REST_Y,
      HEAD_REST_Z,
      (t) => mix(0.092, 0.062, sstep(0.0, 1.0, t)),
      12,
      5,
      0.012,
    ),
    // Rounded stump exactly on the head pivot: the head may turn and drop
    // (sniffing) without ever exposing the open mouth of the neck tube.
    joint(0.062, 0, HEAD_REST_Y, HEAD_REST_Z, 10, 6),
  ];
  for (const s of [-1, 1]) {
    // Shoulder blade and haunch: flat masses that drape OVER the leg root
    // instead of the fat spheres that used to stick out beside it.
    torsoParts.push(
      ellipsoid(
        0.046,
        0.098,
        0.108,
        s * 0.078,
        SHOULDER_Y + 0.008,
        SHOULDER_Z,
        9,
        5,
      ),
    );
    torsoParts.push(
      ellipsoid(0.052, 0.108, 0.118, s * 0.072, HIP_Y + 0.004, HIP_Z, 9, 5),
    );
  }
  const torsoAll = mergeGeometries(torsoParts, false);
  for (const g of torsoParts) g.dispose();
  if (!torsoAll) throw new Error("Dog: could not build the torso");
  paint(torsoAll, (x, y, z, out) => {
    const t = Math.min(1, Math.max(0, (z - Z_FRONT) / (Z_BACK - Z_FRONT)));
    const [rx, ry, yc] = profileAt(t);
    const flank = Math.abs(x) / Math.max(0.04, rx);
    // In the neck the torso profile says nothing – measure "up" against the
    // neck axis instead, otherwise the whole neck lands in the dark saddle.
    const nk = sstep(-0.25, -0.34, z);
    const kt = Math.min(
      1,
      Math.max(0, (z - NECK_A[1]) / (HEAD_REST_Z - NECK_A[1])),
    );
    const up = mix(
      (y - yc) / Math.max(0.04, ry),
      (y - mix(NECK_A[0], HEAD_REST_Y, kt)) / 0.078,
      nk,
    );
    // Saddle over back and flanks, light chest/belly
    const saddle = sstep(-0.55, 0.85, up) * sstep(1.0, 0.5, Math.abs(z + 0.05));
    const belly = sstep(-0.15, -0.85, up) * (1 - flank * 0.45);
    out.copy(C_TAN).lerp(C_DARK, saddle * 0.78);
    out.lerp(C_CREAM, belly * 0.62);
    // Baked occlusion: underside, armpits and groin. Without this the belly
    // sits at full sun brightness in a colour a hair off the beach – which is
    // exactly what made the torso look see-through. Kept gentle now that the
    // dog really receives the sun shadow as well.
    const ao =
      sstep(-0.2, -0.95, up) * 0.26 +
      sstep(0.6, 0.15, flank) * sstep(0.1, -0.6, up) * 0.18 +
      legNear(Math.abs(x), y, z) * 0.16;
    out.multiplyScalar(1 - Math.min(0.38, ao));
  });
  furry(
    torsoAll,
    body,
    (x, y, z) => {
      const t = Math.min(1, Math.max(0, (z - Z_FRONT) / (Z_BACK - Z_FRONT)));
      const [, ry, yc] = profileAt(t);
      const up = (y - yc) / Math.max(0.04, ry);
      // Long over flanks and croup, SHORT in the neck (the old +0.3 ruff at
      // the front was half of why the neck ballooned) and short where a leg
      // leaves the body, so the coat never ends in a collar around the limb.
      let len =
        0.85 +
        sstep(0.3, -0.7, up) * 0.3 +
        sstep(0.8, 1.0, t) * 0.25 -
        0.25 * sstep(0.15, 0.0, t);
      len = mix(len, 0.5, sstep(-0.26, -0.42, z));
      // Short over the scapula and the haunch (no shell contour rings) and
      // short where a leg leaves the body (no collar around the limb).
      len *= 1 - 0.72 * massNear(x, y, z);
      return len * (1 - 0.55 * legNear(Math.abs(x), y, z));
    },
    1,
  );

  // --- Head
  const head = new THREE.Group();
  head.position.set(0, HEAD_REST_Y, HEAD_REST_Z);
  body.add(head);
  const skull = ellipsoid(0.098, 0.093, 0.115, 0, 0.01, -0.005, 16, 12);
  const cheek = ellipsoid(0.083, 0.07, 0.07, 0, -0.028, -0.075, 12, 8);
  const muzzle = limb(0, -0.028, -0.09, 0, -0.048, -0.215, 0.063, 0.05, 12);
  const muzzleTip = ellipsoid(0.05, 0.043, 0.04, 0, -0.048, -0.212, 10, 8);
  const brow = ellipsoid(0.038, 0.02, 0.03, 0.055, 0.052, -0.082, 8, 6);
  const brow2 = ellipsoid(0.038, 0.02, 0.03, -0.055, 0.052, -0.082, 8, 6);
  const headAll = mergeGeometries(
    [skull, cheek, muzzle, muzzleTip, brow, brow2],
    false,
  );
  for (const g of [skull, cheek, muzzle, muzzleTip, brow, brow2]) g.dispose();
  if (!headAll) throw new Error("Dog: could not build the head");
  paint(headAll, (x, y, z, out) => {
    const mz = sstep(-0.06, -0.14, z);
    const under = sstep(-0.02, -0.07, y);
    out.copy(C_TAN);
    out.lerp(C_MUZZLE, mz * (1 - under * 0.7) * 0.9);
    out.lerp(C_CREAM, under * sstep(-0.05, -0.16, z) * 0.75);
    // Light blaze stripe on the forehead
    out.lerp(
      C_CREAM,
      sstep(0.03, 0.0, Math.abs(x)) * sstep(-0.02, 0.06, y) * 0.5,
    );
    // Throat and under-jaw sit in their own shadow
    out.multiplyScalar(1 - sstep(-0.03, -0.09, y) * 0.34);
  });
  furry(
    headAll,
    head,
    (_x, _y, z) => 0.52 * (1 - sstep(-0.03, -0.19, z) * 0.76),
    1,
  );

  // Nose, eyes, lips
  const nose = ellipsoid(0.031, 0.026, 0.022, 0, -0.036, -0.246, 10, 8);
  const eyeL = ellipsoid(0.021, 0.021, 0.018, 0.058, 0.028, -0.098, 8, 6);
  const eyeR = ellipsoid(0.021, 0.021, 0.018, -0.058, 0.028, -0.098, 8, 6);
  const lip = ellipsoid(0.05, 0.014, 0.055, 0, -0.068, -0.17, 8, 6);
  const glossAll = mergeGeometries([nose, eyeL, eyeR, lip], false);
  for (const g of [nose, eyeL, eyeR, lip]) g.dispose();
  if (!glossAll) throw new Error("Dog: head details missing");
  mesh(glossAll, gloss, head, false);

  // Ears (floppy, they flap while running)
  const ears: THREE.Group[] = [];
  for (const s of [-1, 1]) {
    const ear = new THREE.Group();
    ear.position.set(s * 0.082, 0.055, -0.005);
    ear.rotation.set(-0.2, 0, s * 0.42);
    head.add(ear);
    // Floppy ear: wider at the bottom, bent slightly forward
    const shape = ellipsoid(0.048, 0.105, 0.022, 0, -0.09, 0, 10, 8);
    const pos = shape.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const t = Math.min(1, Math.max(0, (-y - 0.02) / 0.16));
      pos.setX(i, pos.getX(i) * (0.72 + t * 0.5));
      pos.setZ(i, pos.getZ(i) - t * t * 0.045);
    }
    shape.computeVertexNormals();
    paint(shape, (_x, y, _z, out) => {
      out.copy(C_DARK).lerp(C_MUZZLE, sstep(-0.04, -0.16, y));
    });
    // No shadow from the ears – they are tiny and cost a shadow draw call
    furry(shape, ear, (_x, y) => 0.34 + sstep(-0.02, -0.18, y) * 0.3, 1, false);
    ears.push(ear);
  }

  // --- Collar with tag and bandana (tag + buckle in one mesh)
  const collar = new THREE.TorusGeometry(0.079, 0.014, 6, 14);
  collar.rotateX(0.62);
  collar.translate(0, 0.556, -0.386);
  mesh(collar, leather, body, false);
  const tag = new THREE.CylinderGeometry(0.02, 0.02, 0.006, 10);
  tag.rotateX(Math.PI / 2);
  tag.translate(0, 0.487, -0.431);
  const buckle = new THREE.BoxGeometry(0.028, 0.03, 0.024);
  buckle.translate(0.073, 0.562, -0.379);
  const trim = mergeGeometries([tag, buckle], false);
  tag.dispose();
  buckle.dispose();
  if (!trim) throw new Error("Dog: collar hardware missing");
  mesh(trim, brass, body, false);
  // Bandana: an open cone sleeve around the neck, widening downwards, hung
  // along the neck axis so it sits on the dog like a kerchief instead of
  // poking out of the throat.
  const scarf = new THREE.CylinderGeometry(0.076, 0.122, 0.135, 14, 1, true);
  scarf.scale(1, 1, 0.78);
  scarf.rotateX(-0.98);
  scarf.translate(0, 0.522, -0.336);
  mesh(scarf, cloth, body, false);

  // --- Legs
  const legs: DogLeg[] = [];
  // [side, front, walk, trot, gallop] – walk = lateral sequence LH→LF→RH→RF
  const LEGSET: Array<[number, boolean, number, number, number]> = [
    [-1, true, 0.25, 0.0, 0.0],
    [1, true, 0.75, 0.5, 0.12],
    [-1, false, 0.0, 0.5, 0.52],
    [1, false, 0.5, 0.0, 0.64],
  ];
  for (const [s, front, offWalk, offTrot, offGallop] of LEGSET) {
    const hip = new THREE.Group();
    hip.position.set(
      s * LEG_X,
      front ? SHOULDER_Y : HIP_Y,
      front ? SHOULDER_Z : HIP_Z,
    );
    body.add(hip);
    const knee = new THREE.Group();
    knee.position.set(0, -UPPER, 0);
    hip.add(knee);
    const rHip = front ? R_HIP_F : R_HIP_B;
    const rKnee = front ? R_KNEE_F : R_KNEE_B;
    // Foot: the metacarpus/metatarsus continues the shank, so the lower leg is
    // ONE tube down to the pastern and only the paw is a separate blob.
    const footY = front ? FOOT_Y_F : FOOT_Y_B;
    const footZ = front ? 0.014 : -0.03;

    // --- Upper leg: one continuous tube from the hip pivot to the knee pivot.
    // Both mouths have exactly the radius of the ball that sits on the pivot,
    // so the limb reads as one tapered mass at any bend angle.
    const upShaft = tube(
      0,
      0,
      0,
      0,
      -UPPER,
      0,
      (t) =>
        mix(rHip, rKnee, sstep(0.05, 1.0, t)) *
        (1 + (front ? 0.16 : 0.3) * Math.sin(Math.PI * Math.min(1, t / 0.7))),
      10,
      5,
      front ? 0.012 : 0.026,
    );
    const hipBall = joint(rHip * 1.04, 0, 0, 0, 9, 5);
    const kneeBallU = joint(rKnee * 1.08, 0, -UPPER, 0, 10, 5);
    const upAll = mergeGeometries([upShaft, hipBall, kneeBallU], false);
    for (const g of [upShaft, hipBall, kneeBallU]) g.dispose();
    if (!upAll) throw new Error("Dog: upper leg missing");
    paint(upAll, (x, y, _z, out) => {
      // Tan all the way down – the white sock only starts below the knee.
      out.copy(C_TAN).lerp(C_DARK, sstep(0.02, -0.1, y) * 0.34);
      out.lerp(C_CREAM, sstep(-0.17, -0.24, y) * 0.3);
      // Inner side of the leg lies in the body's shadow all day
      out.multiplyScalar(1 - sstep(0.0, -0.05, s * x) * 0.26);
    });
    // The coat fades to nothing well ABOVE the knee – that is what stops a fur
    // ring from forming where the shells used to end.
    furry(upAll, hip, (_x, y) => 0.58 * (1 - sstep(-0.02, -0.19, y)), 3);

    // --- Lower leg: shank + pastern in a single tube, paw merged on top of it.
    const loShaft = tube(
      0,
      0,
      0,
      0,
      footY,
      footZ,
      (t) =>
        rKnee *
        (t < 0.32
          ? mix(1.0, 0.84, sstep(0.0, 0.32, t))
          : mix(0.84, 0.66, sstep(0.32, 0.82, t))),
      10,
      5,
      front ? -0.008 : 0.022,
    );
    const kneeBallL = joint(rKnee * 1.08, 0, 0, 0, 10, 5);
    const paw = ellipsoid(
      0.036,
      0.026,
      0.05,
      0,
      footY - 0.01,
      footZ + (front ? 0.006 : 0.004),
      9,
      5,
    );
    const loAll = mergeGeometries([loShaft, kneeBallL, paw], false);
    for (const g of [loShaft, kneeBallL, paw]) g.dispose();
    if (!loAll) throw new Error("Dog: lower leg missing");
    // Soft transition into the light sock instead of a hard colour edge
    paint(loAll, (x, y, _z, out) => {
      // Tan below the knee fading into a light sock over the pastern and paw
      out
        .copy(C_TAN)
        .lerp(C_CREAM, sstep(-0.06, -0.19, y) * 0.62)
        .lerp(C_DARK, sstep(-0.19, -0.25, y) * 0.24);
      out.multiplyScalar(1 - sstep(0.0, -0.05, s * x) * 0.24);
    });
    // No shells and no shadow pass on the lower legs: short hair reads fine as
    // texture there, and a shell stack that starts at the knee is exactly the
    // ring seam the owner reported. Saves four draw calls in each pass.
    mesh(loAll, fur, knee, false);
    legs.push({ hip, knee, front, offWalk, offTrot, offGallop });
  }

  // --- Tail (two segments)
  const tail: THREE.Group[] = [];
  const t0 = new THREE.Group();
  t0.position.set(0, 0.478, 0.42);
  t0.rotation.x = -0.7;
  body.add(t0);
  const tailRoot = joint(0.038, 0, 0, 0, 8, 4);
  const seg0 = tube(
    0,
    0,
    0,
    0,
    0.15,
    0.02,
    (t) => mix(0.036, 0.026, sstep(0.0, 1.0, t)),
    8,
    3,
  );
  const seg0All = mergeGeometries([seg0, tailRoot], false);
  seg0.dispose();
  tailRoot.dispose();
  if (!seg0All) throw new Error("Dog: tail root missing");
  paint(seg0All, (_x, y, _z, out) => {
    out.copy(C_TAN).lerp(C_DARK, 0.42 - sstep(0.02, 0.14, y) * 0.1);
  });
  // The tail is the thinnest furry part (radius 36 → 11 mm): the old 1.1–1.5
  // hair length pushed the outer shell to four times the radius, so its rim
  // sawtoothed against the sky. Shorter hair AND finer strands (dens > 1).
  furry(seg0All, t0, () => 0.8, 2, false, 2.1);
  const t1 = new THREE.Group();
  t1.position.set(0, 0.15, 0.02);
  t0.add(t1);
  const seg1 = tube(
    0,
    0,
    0,
    0,
    0.15,
    0.01,
    (t) => mix(0.026, 0.011, sstep(0.0, 1.0, t)),
    8,
    3,
  );
  const tailJoint = joint(0.028, 0, 0, 0, 8, 4);
  const tailTip = joint(0.012, 0, 0.15, 0.01, 6, 4);
  const seg1All = mergeGeometries([seg1, tailJoint, tailTip], false);
  for (const g of [seg1, tailJoint, tailTip]) g.dispose();
  if (!seg1All) throw new Error("Dog: tail tip missing");
  // Only a hint of a light tip left: at 0.55 cream the tail sat within a few
  // units of the beach and read as a sand-coloured stick.
  paint(seg1All, (_x, y, _z, out) => {
    out
      .copy(C_TAN)
      .lerp(C_DARK, 0.34)
      .lerp(C_CREAM, sstep(0.05, 0.15, y) * 0.26);
  });
  furry(
    seg1All,
    t1,
    (_x, y) => 0.62 - sstep(0.02, 0.14, y) * 0.28,
    2,
    false,
    2.6,
  );
  tail.push(t0, t1);

  const mouth = new THREE.Object3D();
  mouth.position.set(0, -0.06, -0.27);
  head.add(mouth);

  return {
    root,
    body,
    head,
    ears,
    tail,
    legs,
    mouth,
    shells,
    fur: furU,
    shellMax,
    dispose() {
      for (const s of shells) s.dispose();
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Gait
// ---------------------------------------------------------------------------

/** Running state of the dog – lives in Companions, is advanced here. */
export interface DogGait {
  phase: number;
  bob: number;
  bobV: number;
  earLag: number;
  earV: number;
  wag: number;
  headTurn: number;
  /** Smoothed look direction of the head (local rad). */
  headYaw: number;
  headPitch: number;
  /** Bank angle into the curve. */
  bank: number;
  /** Weight shift after braking (damped spring). */
  settle: number;
  settleV: number;
  prevSpeed: number;
  breath: number;
}

export function newGait(): DogGait {
  return {
    phase: 0,
    bob: 0,
    bobV: 0,
    earLag: 0,
    earV: 0,
    wag: 0,
    headTurn: 0,
    headYaw: 0,
    headPitch: 0,
    bank: 0,
    settle: 0,
    settleV: 0,
    prevSpeed: 0,
    breath: 0,
  };
}

/** What the state machine hands over to the animation each frame. */
export interface DogPose {
  /** m/s along the ground. */
  speed: number;
  moving: boolean;
  /** 0..1 attention – lifts head and ears. */
  alert: number;
  /** 0..1 joy – tail. */
  happy: number;
  /** Yaw rate in rad/s (+ = turning left). */
  turn: number;
  /** Where the head should look, relative to the body (rad). */
  lookYaw: number;
  lookPitch: number;
  /** 0..1 crouch before sprinting off. */
  crouch: number;
  /** 0..1 sitting. */
  sit: number;
  /** 0..1 nose on the ground. */
  sniff: number;
  /** 0..1 decaying impulse of a bark. */
  bark: number;
  /** 0..1 wind (tail and ears drift). */
  wind: number;
}

export function newPose(): DogPose {
  return {
    speed: 0,
    moving: false,
    alert: 0,
    happy: 0,
    turn: 0,
    lookYaw: 0,
    lookPitch: 0,
    crouch: 0,
    sit: 0,
    sniff: 0,
    bark: 0,
    wind: 0,
  };
}

/** Hip and knee angle of one leg at time p (0..1 within the cycle). */
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
    const s = t / duty;
    hip = amp * (1 - 2 * s);
    knee = flex * 0.22 * Math.sin(Math.PI * s);
  } else {
    const s = (t - duty) / (1 - duty);
    hip = -amp * Math.cos(Math.PI * s);
    knee = flex * Math.sin(Math.PI * s) ** 0.8;
  }
  // The foreleg bends backwards, the hind leg pulls forward under the belly.
  // Deliberately shallower at the front – otherwise the lower leg sticks out
  // horizontally and looks detached from the body.
  return [hip, front ? -knee * 0.72 : knee * 1.05];
}

// Sitting pose (blended over the gait). The four limb angles are given as WORLD
// angles measured from "straight down", positive = swung forward (−z); the body
// pitch is taken back out again on the hip, so the legs keep their pose no
// matter how the torso is tipped.
//
// The old pose tipped the torso by only 26° and dropped it by 3.8 cm: the croup
// still floated 13 cm over the sand while the hind legs stuck out backwards –
// the dog hung in the air as if held up by its tail. The torso has to tip far
// enough (42°) for the croup to reach the ground while the shoulder stays high
// enough that the forelegs remain straight. The hind femur then lies almost
// horizontally forward and the shank folds back down under the haunch, which is
// how a dog really folds up when it sits.
const SIT_PITCH = 0.73;
/** Fine adjustment of the body height on top of the pitch. */
const SIT_DROP = 0.012;
/** Foreleg: femur and pastern stay vertical, the paws stay under the chest. */
const SIT_FEMUR_F = 0.06;
const SIT_SHANK_F = 0.02;
/** Hind leg: femur nearly horizontal forward, shank folded back onto the sand. */
const SIT_FEMUR_B = 1.85;
const SIT_SHANK_B = -0.74;
/** The hocks splay outwards while sitting. */
const SIT_SPLAY = 0.13;

/**
 * One animation step. The gait blends walk → trot → gallop by speed; the
 * stride phase runs off the actual distance covered, so the paws do not slide.
 */
export function animateDog(
  dog: DogModel,
  g: DogGait,
  dt: number,
  p: DogPose,
): void {
  const speed = p.speed;
  // Gait blending: two overlapping cross-fades, never a hard switch
  const trotB = sstep(1.5, 3.1, speed);
  const galB = sstep(5.0, 7.2, speed);
  const duty = mix(mix(0.66, 0.55, trotB), 0.34, galB);
  const strideLen = mix(mix(0.42, 0.8, trotB), 1.45, galB);
  if (p.moving) g.phase += (speed / Math.max(0.1, strideLen)) * dt;
  else g.phase += dt * 0.22;
  const stand = 1 - p.sit;
  const amp = p.moving
    ? Math.min(0.52, 0.1 + speed * 0.058) * (1 + galB * 0.25)
    : 0.025;
  const flex = p.moving ? 0.34 + trotB * 0.4 + galB * 0.55 : 0.06;

  for (const leg of dog.legs) {
    const off = mix(mix(leg.offWalk, leg.offTrot, trotB), leg.offGallop, galB);
    const [hip, knee] = stride(g.phase + off, duty, amp, flex, leg.front);
    const rest = leg.front ? 0.02 : -0.05;
    const cr = p.crouch * (leg.front ? 0.12 : 0.3);
    let hipA = hip + rest - cr;
    let kneeA = knee + (leg.front ? -0.08 : 0.22) + cr * 1.4;
    if (p.sit > 0.001) {
      // Sitting: prescribe the WORLD angle of both segments and take the body
      // pitch back out of the hip, so the forelegs stay vertical under the
      // tipped-up chest and the hind legs fold under the haunch.
      const femur = leg.front ? SIT_FEMUR_F : SIT_FEMUR_B;
      const shank = leg.front ? SIT_SHANK_F : SIT_SHANK_B;
      hipA = mix(hipA, femur - SIT_PITCH, p.sit);
      kneeA = mix(kneeA, shank - femur, p.sit);
    }
    leg.hip.rotation.x = hipA;
    leg.knee.rotation.x = kneeA;
    // Legs splay slightly outwards when sniffing, the hocks a good deal more
    // while sitting – otherwise the folded shank cuts into the belly.
    const side = leg.hip.position.x < 0 ? -1 : 1;
    leg.hip.rotation.z =
      (leg.front ? 0.02 : 0.03) * p.sniff +
      (leg.front ? 0.02 : side * SIT_SPLAY) * p.sit;
  }

  // Body bounce: twice per cycle at a trot, once at a gallop, gentle at a walk
  const cyc = g.phase * Math.PI * 2;
  g.breath += dt * 1.15;
  const bounce = p.moving
    ? (1 - galB) * Math.sin(cyc * 2) * (0.008 + trotB * 0.011) +
      galB * Math.sin(cyc) * 0.055
    : Math.sin(g.breath) * 0.0035;
  const target = bounce * Math.min(1, 0.35 + speed * 0.14) * stand;
  g.bobV += (target - g.bob) * 60 * dt;
  g.bobV *= Math.exp(-9 * dt);
  g.bob += g.bobV * dt;

  // Weight shift when braking: kick a damped spring
  const dec = (g.prevSpeed - speed) / Math.max(dt, 1e-4);
  if (dec > 4 && p.sit < 0.5) g.settleV += Math.min(dec, 22) * 0.0055;
  g.prevSpeed = speed;
  g.settleV -= g.settle * 46 * dt;
  g.settleV *= Math.exp(-4.2 * dt);
  g.settle += g.settleV * dt;

  // Bank into the curve (dog leans towards the inside of the turn)
  const bankT = Math.max(
    -0.28,
    Math.min(0.28, p.turn * Math.min(speed, 8) * 0.052),
  );
  g.bank += (bankT * stand - g.bank) * Math.min(1, dt * 5);

  dog.body.position.y =
    g.bob -
    p.crouch * 0.05 -
    p.sniff * 0.045 +
    p.bark * 0.012 -
    p.sit * SIT_DROP;
  dog.body.rotation.x =
    (p.moving ? Math.sin(cyc + 0.6) * (0.02 + galB * 0.1) : 0) -
    galB * 0.04 -
    p.crouch * 0.1 +
    p.sit * SIT_PITCH +
    g.settle * 1.4 -
    p.sniff * 0.06;
  dog.body.rotation.z =
    (p.moving ? Math.sin(cyc) * 0.045 * (1 - galB) * (1 - trotB * 0.4) : 0) +
    g.bank;

  // Head: look-at with lag, counter-bob, low while sniffing
  g.headYaw += (p.lookYaw - g.headYaw) * Math.min(1, dt * 4.5);
  g.headPitch += (p.lookPitch - g.headPitch) * Math.min(1, dt * 4);
  g.headTurn +=
    (Math.sin(g.breath * 0.41) * 0.1 * (1 - galB) - g.headTurn) *
    Math.min(1, dt * 2.4);
  // The head is counter-rotated against the sit pitch – a sitting dog carries
  // its muzzle level, not pointing 42° at the sky.
  dog.head.rotation.x =
    0.04 +
    g.headPitch -
    Math.sin(cyc * 2 + 1.1) * 0.04 * (p.moving ? 1 : 0.2) -
    p.sniff * 0.62 +
    p.bark * 0.3 -
    g.settle * 0.9 -
    p.sit * 0.62;
  dog.head.rotation.y = g.headYaw + g.headTurn * (p.moving ? 0.25 : 1);
  dog.head.rotation.z =
    Math.sin(cyc) * 0.03 * (1 - galB) * (p.moving ? 1 : 0) - g.bank * 0.45;
  dog.head.position.y = HEAD_REST_Y - p.sniff * 0.17 + p.sit * 0.02;
  dog.head.position.z = HEAD_REST_Z - p.sniff * 0.05;

  // The ears lag behind the body acceleration and flap in the wind
  const earDrive = -g.bobV * 3.4 - dec * 0.012;
  g.earV += (earDrive - g.earLag) * 42 * dt;
  g.earV *= Math.exp(-7 * dt);
  g.earLag += g.earV * dt;
  const flutter = Math.sin(g.breath * 5.3) * 0.05 * p.wind * p.wind;
  for (let i = 0; i < dog.ears.length; i++) {
    const s = i === 0 ? -1 : 1;
    dog.ears[i].rotation.x =
      -0.25 - g.earLag * 0.9 - p.alert * 0.5 + p.sniff * 0.28 - p.bark * 0.2;
    dog.ears[i].rotation.z =
      s * (0.35 - p.alert * 0.22 + g.earLag * 0.25 + flutter);
  }

  // Tail: posture by mood, wag speed by joy
  g.wag += dt * (2.4 + p.happy * 9 + p.alert * 2.6 + speed * 0.45);
  const wagAmp =
    0.08 +
    p.happy * 0.52 +
    p.alert * 0.1 +
    (p.moving ? 0.07 : 0) +
    p.wind * 0.04;
  dog.tail[0].rotation.x =
    -0.5 -
    p.alert * 0.42 -
    p.happy * 0.55 +
    galB * 0.7 +
    p.sit * 1.0 +
    p.sniff * 0.2 +
    Math.sin(cyc * 2) * 0.05 * (p.moving ? 1 : 0);
  dog.tail[0].rotation.y = Math.sin(g.wag) * wagAmp;
  dog.tail[0].rotation.z = Math.sin(g.wag) * wagAmp * 0.35;
  dog.tail[1].rotation.y = Math.sin(g.wag - 0.7) * wagAmp * 1.3;
  dog.tail[1].rotation.x = 0.25 - galB * 0.35 + Math.sin(g.breath * 0.8) * 0.04;
}
