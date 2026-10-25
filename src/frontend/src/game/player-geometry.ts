// Trash Simulator – viewmodel geometry: bucket, bail, gloves, sleeves,
// grabber and the mini objects that fill the bucket. Pure geometry builders
// (no materials), units in meters, Y up.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import {
  mergeGeometries,
  mergeVertices,
} from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { mulberry32 } from "./noise";

type Geo = THREE.BufferGeometry;

const M = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const E = new THREE.Euler();
const V = new THREE.Vector3();
const S = new THREE.Vector3();
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Transform a geometry in place: scale, Euler rotation (XYZ), translation. */
export function place(
  geo: Geo,
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = sx,
  sz = sx,
): Geo {
  Q.setFromEuler(E.set(rx, ry, rz));
  M.compose(V.set(x, y, z), Q, S.set(sx, sy, sz));
  geo.applyMatrix4(M);
  return geo;
}

export function placeQ(
  geo: Geo,
  pos: THREE.Vector3,
  q: THREE.Quaternion,
  s = 1,
): Geo {
  M.compose(pos, q, S.set(s, s, s));
  geo.applyMatrix4(M);
  return geo;
}

/** Rounded box, indexed (RoundedBoxGeometry is non-indexed otherwise). */
export function rbox(
  w: number,
  h: number,
  d: number,
  seg: number,
  r: number,
): Geo {
  const raw = new RoundedBoxGeometry(w, h, d, seg, r);
  const geo = mergeVertices(raw, 1e-5);
  raw.dispose();
  return geo;
}

/** Merge parts (mixed indexing → all non-indexed) and dispose of the sources. */
export function mergeParts(parts: Geo[], useGroups = false): Geo {
  const anyNonIndexed = parts.some((p) => p.getIndex() === null);
  const src = anyNonIndexed
    ? parts.map((p) => (p.getIndex() ? p.toNonIndexed() : p))
    : parts;
  const merged = mergeGeometries(src, useGroups);
  for (const p of parts) p.dispose();
  if (anyNonIndexed) for (const p of src) p.dispose();
  if (!merged) throw new Error("Viewmodel: mergeGeometries failed");
  return merged;
}

/** Reverse the triangle winding (after a mirroring). */
export function flipWinding(geo: Geo): Geo {
  const idx = geo.getIndex();
  if (idx) {
    for (let i = 0; i < idx.count; i += 3) {
      const b = idx.getX(i + 1);
      idx.setX(i + 1, idx.getX(i + 2));
      idx.setX(i + 2, b);
    }
    idx.needsUpdate = true;
    return geo;
  }
  const pos = geo.getAttribute("position");
  const nrm = geo.getAttribute("normal");
  const uv = geo.getAttribute("uv");
  const swap = (
    a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
    i: number,
    j: number,
  ) => {
    const x = a.getX(i);
    const y = a.getY(i);
    const z = a.itemSize > 2 ? a.getZ(i) : 0;
    if (a.itemSize > 2) a.setXYZ(i, a.getX(j), a.getY(j), a.getZ(j));
    else a.setXY(i, a.getX(j), a.getY(j));
    if (a.itemSize > 2) a.setXYZ(j, x, y, z);
    else a.setXY(j, x, y);
  };
  for (let i = 0; i < pos.count; i += 3) {
    swap(pos, i + 1, i + 2);
    if (nrm) swap(nrm, i + 1, i + 2);
    if (uv) swap(uv, i + 1, i + 2);
  }
  return geo;
}

/** Constant vertex color (gray value) as a `color` attribute. */
export function setColor(geo: Geo, k: number): Geo {
  const n = geo.getAttribute("position").count;
  geo.setAttribute(
    "color",
    new THREE.BufferAttribute(new Float32Array(n * 3).fill(k), 3),
  );
  return geo;
}

/** Map the UVs linearly into a sub-rectangle of the texture. */
export function remapUv(
  geo: Geo,
  u0: number,
  u1: number,
  v0: number,
  v1: number,
): Geo {
  const uv = geo.getAttribute("uv");
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  }
  uv.needsUpdate = true;
  return geo;
}

/**
 * Attach relative morph targets (position + normal) built from topologically
 * identical geometries; the target geometries are disposed of.
 */
export function addMorphs(base: Geo, targets: Geo[]): Geo {
  base.morphTargetsRelative = true;
  const mp: THREE.BufferAttribute[] = [];
  const mn: THREE.BufferAttribute[] = [];
  const bp = base.getAttribute("position");
  const bn = base.getAttribute("normal");
  for (const t of targets) {
    const tp = t.getAttribute("position");
    const tn = t.getAttribute("normal");
    if (tp.count !== bp.count)
      throw new Error("Viewmodel: morph topology does not match");
    const dp = new Float32Array(bp.count * 3);
    const dn = new Float32Array(bp.count * 3);
    for (let i = 0; i < bp.count; i++) {
      dp[i * 3] = tp.getX(i) - bp.getX(i);
      dp[i * 3 + 1] = tp.getY(i) - bp.getY(i);
      dp[i * 3 + 2] = tp.getZ(i) - bp.getZ(i);
      dn[i * 3] = tn.getX(i) - bn.getX(i);
      dn[i * 3 + 1] = tn.getY(i) - bn.getY(i);
      dn[i * 3 + 2] = tn.getZ(i) - bn.getZ(i);
    }
    mp.push(new THREE.BufferAttribute(dp, 3));
    mn.push(new THREE.BufferAttribute(dn, 3));
    t.dispose();
  }
  base.morphAttributes.position = mp;
  base.morphAttributes.normal = mn;
  return base;
}

/** Circular arc in the x-y plane (for TubeGeometry). */
export class ArcCurve extends THREE.Curve<THREE.Vector3> {
  private readonly radius: number;
  private readonly a0: number;
  private readonly a1: number;
  constructor(radius: number, a0: number, a1: number) {
    super();
    this.radius = radius;
    this.a0 = a0;
    this.a1 = a1;
  }
  getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    const a = this.a0 + (this.a1 - this.a0) * t;
    return target.set(Math.cos(a) * this.radius, Math.sin(a) * this.radius, 0);
  }
}

// ---------------------------------------------------------------------------
// Bucket (10 l): Ø 28 cm at the top, 22 cm at the bottom, 27 cm tall
// ---------------------------------------------------------------------------

export const BUCKET = {
  rTop: 0.14,
  rBot: 0.11,
  h: 0.27,
  earY: 0.235, // height of the bail ears above the bottom
  bailR: 0.152, // bail radius (ear → center of the grip)
  /**
   * Radius of the plastic grip sleeve on the bail (the fist has to wrap around
   * it). Molded sleeve ≈ 21 mm diameter, end beads ≈ 28 mm.
   */
  gripR: 0.0105,
  /** Half the length of the grip sleeve (slightly wider than the fist). */
  gripHalf: 0.052,
  /** Distance from the center of the grip (pendulum pivot) → bucket bottom */
  pivotH: 0.235 + 0.152,
} as const;

/** Outer wall radius at height y (bucket space, y = 0 at the bottom). */
export function bucketWallR(y: number): number {
  return BUCKET.rBot + (BUCKET.rTop - BUCKET.rBot) * (y / BUCKET.h);
}

/** Top of the inner bottom dish – nothing may drop below this. */
export const BUCKET_INNER_FLOOR = 0.02;
/** Height at which the inner wall ends and the rim opening begins. */
const BUCKET_RIM_Y = 0.266;
/** Radius of the rim opening (innermost point of the rim bead). */
const BUCKET_RIM_R = 0.1355;

/**
 * Radius of the INNER wall at height y (bucket space). Mirrors the inner half
 * of the lathe profile in bucketGeometry() – the fill clamp uses it to keep
 * the contents inside the shell. Dents are not included (see BUCKET_DENT_MAX).
 */
export function bucketInnerRadius(y: number): number {
  // Bottom dish: the inner wall starts 6 mm inside the outer wall
  if (y <= BUCKET_INNER_FLOOR) return bucketWallR(BUCKET_INNER_FLOOR) - 0.006;
  if (y <= 0.245) return bucketWallR(y) - 0.004;
  if (y >= BUCKET_RIM_Y) return BUCKET_RIM_R;
  // Flare into the rim bead
  const r0 = bucketWallR(0.245) - 0.004;
  return r0 + ((y - 0.245) / (BUCKET_RIM_Y - 0.245)) * (BUCKET_RIM_R - r0);
}

interface ProfilePt {
  r: number;
  y: number;
  v: number; // texture V (0 bottom → 1 rim)
  ao: number; // vertex color (interior shading)
  wall: boolean; // dents allowed
}

const BUCKET_DENTS: Array<{
  phi: number;
  y: number;
  w: number;
  hh: number;
  d: number;
}> = [
  { phi: 0.9, y: 0.11, w: 0.55, hh: 0.05, d: 0.006 },
  { phi: 2.7, y: 0.19, w: 0.45, hh: 0.04, d: 0.0045 },
  { phi: 4.5, y: 0.07, w: 0.6, hh: 0.045, d: 0.007 },
];

/**
 * Deepest dent. The dents also push the INNER wall inwards, so the fill clamp
 * keeps this much clear at every angle instead of evaluating the dent field.
 */
export const BUCKET_DENT_MAX = BUCKET_DENTS.reduce(
  (m, d) => Math.max(m, d.d),
  0,
);

/**
 * Double-walled lathe (outside + inside, rim bead, standing ring with a
 * recessed bottom), bail ears, plastic grip of the bail. Origin = center of
 * the grip (pendulum pivot); the bucket's bottom sits at y = -BUCKET.pivotH.
 * UV: u around the bucket, v = 0 bottom → 1 rim (pbrBucket); the inner wall
 * uses the dirty lower part of the texture. Vertex color = interior shading.
 */
export function bucketGeometry(): Geo {
  const { h, earY, pivotH } = BUCKET;
  const rw = bucketWallR;
  const P: ProfilePt[] = [];
  const pt = (r: number, y: number, v: number, ao = 1, wall = false) =>
    P.push({ r, y, v, ao, wall });
  // Bottom on the outside (slightly recessed) + standing ring
  pt(0, 0.006, 0.02, 0.8);
  pt(0.09, 0.006, 0.02, 0.8);
  pt(0.1, 0, 0.02, 0.85);
  pt(0.11, 0, 0.02, 0.9);
  pt(0.1115, 0.012, 0.045, 0.95);
  // Outer wall
  for (let k = 0; k <= 8; k++) {
    const y = 0.02 + k * 0.0275;
    pt(rw(y), y, y / h, 1, true);
  }
  // Rim bead
  pt(rw(0.25), 0.25, 0.91);
  pt(0.147, 0.256, 0.935);
  pt(0.151, 0.263, 0.96);
  pt(0.151, 0.271, 0.985);
  pt(0.146, 0.2755, 0.995);
  pt(0.139, 0.274, 1.0);
  // Inner wall (texture V in the lower, dirty range). The vertex color is a
  // baked shading: markedly darker towards the bottom.
  pt(0.1355, 0.266, 0.34, 0.86);
  for (let k = 0; k < 7; k++) {
    const y = 0.245 - k * 0.0355;
    const f = y / h;
    pt(rw(y) - 0.004, y, 0.03 + f * 0.31, 0.26 + 0.62 * f ** 1.25, true);
  }
  // Bottom on the inside: soft contact shadow under the contents (darkest in the middle)
  pt(rw(0.02) - 0.006, 0.02, 0.04, 0.27);
  pt(0.1, 0.016, 0.036, 0.24);
  pt(0.072, 0.0145, 0.034, 0.185);
  pt(0.04, 0.014, 0.032, 0.15);
  pt(0, 0.014, 0.03, 0.13);

  const SEG = 48;
  const N = P.length;
  const lathe = new THREE.LatheGeometry(
    P.map((p) => new THREE.Vector2(p.r, p.y)),
    SEG,
  );
  const pos = lathe.getAttribute("position");
  const uv = lathe.getAttribute("uv");
  const col = new Float32Array(pos.count * 3);
  for (let idx = 0; idx < pos.count; idx++) {
    const i = Math.floor(idx / N);
    const j = idx % N;
    const p = P[j];
    uv.setY(idx, p.v);
    col[idx * 3] = p.ao;
    col[idx * 3 + 1] = p.ao;
    col[idx * 3 + 2] = p.ao;
    if (!p.wall) continue;
    // Dents: radially inwards, fading out softly
    const phi = (i / SEG) * Math.PI * 2;
    let disp = 0;
    for (const d of BUCKET_DENTS) {
      let dphi = Math.abs(phi - d.phi);
      if (dphi > Math.PI) dphi = Math.PI * 2 - dphi;
      const q = (dphi / d.w) ** 2 + ((p.y - d.y) / d.hh) ** 2;
      if (q < 3) disp += d.d * Math.exp(-q * 1.6);
    }
    if (disp > 0) {
      const r = p.r - disp;
      pos.setXYZ(idx, r * Math.sin(phi), p.y, r * Math.cos(phi));
    }
  }
  lathe.setAttribute("color", new THREE.BufferAttribute(col, 3));
  lathe.computeVertexNormals();
  // Smooth the seam (segment 0 / SEG)
  const nrm = lathe.getAttribute("normal");
  for (let j = 0; j < N; j++) {
    const a = j;
    const b = SEG * N + j;
    const nx = nrm.getX(a) + nrm.getX(b);
    const ny = nrm.getY(a) + nrm.getY(b);
    const nz = nrm.getZ(a) + nrm.getZ(b);
    const l = Math.hypot(nx, ny, nz) || 1;
    nrm.setXYZ(a, nx / l, ny / l, nz / l);
    nrm.setXYZ(b, nx / l, ny / l, nz / l);
  }

  // Bail ears (molded-on lugs) at ±x
  const parts: Geo[] = [lathe];
  const earX = rw(earY) + 0.01;
  for (const sgn of [-1, 1]) {
    const ear = rbox(0.026, 0.046, 0.036, 2, 0.007);
    remapUv(ear, 0.5, 0.53, 0.68, 0.74);
    setColor(ear, 1);
    place(ear, sgn * earX, earY, 0);
    parts.push(ear);
  }
  // Plastic grip sleeve on the bail (bucket color), axis along x at grip
  // height: a molded tube with a slight bulge and flared end beads. The end
  // faces are wide enough that the bail wire stays inside and only emerges at
  // the end face.
  const gr = BUCKET.gripR;
  const gl = BUCKET.gripHalf;
  const gp: THREE.Vector2[] = [];
  for (const [f, dy] of [
    [0, 0],
    [1.2, 0],
    [1.32, 0.0022],
    [1.32, 0.0055],
    [1.03, 0.0105],
    [1.0, 0.016],
  ] as const) {
    gp.push(new THREE.Vector2(gr * f, -gl + dy));
  }
  gp.push(new THREE.Vector2(gr * 1.03, 0));
  for (let i = gp.length - 2; i >= 0; i--) {
    gp.push(new THREE.Vector2(gp[i].x, -gp[i].y));
  }
  const grip = new THREE.LatheGeometry(gp, 16);
  remapUv(grip, 0.55, 0.6, 0.66, 0.72);
  setColor(grip, 1);
  place(grip, 0, pivotH, 0, 0, 0, Math.PI / 2);
  parts.push(grip);

  const geo = mergeParts(parts);
  geo.translate(0, -pivotH, 0);
  return geo;
}

/** Wire bail (semicircle in the x-y plane), origin = center of the grip. */
export function bailGeometry(): Geo {
  const geo = new THREE.TubeGeometry(
    new ArcCurve(BUCKET.bailR, -0.12, Math.PI + 0.12),
    30,
    0.003,
    6,
    false,
  );
  geo.translate(0, -BUCKET.bailR, 0);
  return geo;
}

// ---------------------------------------------------------------------------
// Glove (work glove, gripping pose)
// ---------------------------------------------------------------------------

/** Cylinder in hand space (axis along x) that the fingers wrap around. */
export interface GripCyl {
  y: number;
  z: number;
  r: number;
}

export interface HandPose {
  /** Grip the fingers wrap around (prevents interpenetration). */
  grip: GripCyl;
  /** 0..1 fraction of the full wrap (middle, ring and little finger). */
  curl: number;
  /** Index finger: its own bend per phalanx (e.g. on the trigger); otherwise like curl. */
  index?: readonly [number, number, number];
  /** Thumb 0..1 (lies across underneath the grip and rolls over it). */
  thumb: number;
}

export interface GloveOpts {
  /**
   * Knuckle relief on the back of the hand: metacarpal heads, ridges between
   * the metacarpal bones and a slight curvature. Without it the back of the
   * hand is a flat slab (old behavior).
   */
  knuckles?: boolean;
  /**
   * The thumb lies lengthwise over the camera-facing flank of the grip (fist
   * on the bail) instead of across underneath it (old behavior, pistol grip).
   */
  thumbAcross?: boolean;
  /**
   * Direction towards the elbow IN HAND SPACE. The gauntlet follows it instead
   * of the hand axis, so it stays inside the sleeve's cuff even when the wrist
   * is bent. Without it, it points along −y as before.
   */
  cuffDir?: THREE.Vector3;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth01 = (v: number) => {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
};

// Three phalanges per finger (proximal, middle, distal)
const FINGER_X = [-0.0325, -0.011, 0.011, 0.0325];
const FINGER_LEN: number[][] = [
  [0.0387, 0.0275, 0.0198],
  [0.0414, 0.0294, 0.0212],
  [0.0378, 0.0269, 0.0193],
  [0.0302, 0.0214, 0.0154],
];
const FINGER_R = [0.009, 0.0092, 0.0088, 0.0079];
const SEG_R = [1, 0.93, 0.85];
const FINGER_SPREAD = [-0.07, -0.024, 0.024, 0.07];
/**
 * Metacarpal arch: the finger roots do not lie on a straight line – index and
 * middle finger sit higher and further back (back of the hand), the little
 * finger lower and closer to the palm. This offsets the fingers' wrapping
 * phases against each other so the individual phalanges stay readable.
 */
const FINGER_ROOT_Y = [0.0915, 0.0925, 0.089, 0.0838];
const FINGER_ROOT_Z = [0.0035, 0.003, 0.0008, -0.0018];
/** Slightly different wraps – the row of fingertips is staggered. */
const FINGER_CURL = [1, 0.995, 0.975, 0.95];

/**
 * Metacarpal heads (knuckles) on the rear top edge of the palm: sphere center
 * (y, z) and radius. They sit proximal to the finger roots – that is where the
 * knuckle bulges in a fist, while the finger root itself already dips away over
 * the edge. Index finger highest and furthest out, little finger flattest; the
 * notches remain between the spheres.
 */
const KNUCKLES: ReadonlyArray<readonly [number, number, number]> = [
  [0.083, 0.0094, 0.0098],
  [0.0826, 0.0094, 0.0096],
  [0.0817, 0.0092, 0.0091],
  [0.0806, 0.0087, 0.0084],
];

/**
 * Smooth the normals, welding by position only – the UV seams of the
 * RoundedBox are preserved while the shading still becomes continuous.
 */
function smoothNormals(geo: Geo): void {
  geo.computeVertexNormals();
  const pos = geo.getAttribute("position");
  const nrm = geo.getAttribute("normal");
  const map = new Map<string, number[]>();
  for (let i = 0; i < pos.count; i++) {
    const key = `${Math.round(pos.getX(i) * 1e5)},${Math.round(
      pos.getY(i) * 1e5,
    )},${Math.round(pos.getZ(i) * 1e5)}`;
    const a = map.get(key);
    if (a) a.push(i);
    else map.set(key, [i]);
  }
  for (const arr of map.values()) {
    if (arr.length < 2) continue;
    let x = 0;
    let y = 0;
    let z = 0;
    for (const i of arr) {
      x += nrm.getX(i);
      y += nrm.getY(i);
      z += nrm.getZ(i);
    }
    const l = Math.hypot(x, y, z) || 1;
    for (const i of arr) nrm.setXYZ(i, x / l, y / l, z / l);
  }
  nrm.needsUpdate = true;
}

/**
 * Taper the palm towards the wrist – without it the box stays a brick. Above
 * y ≈ 0.058 nothing changes, that is where the grip lies tangentially against
 * the palm side.
 */
function palmTaper(geo: Geo): Geo {
  const pos = geo.getAttribute("position");
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const u = smooth01((y - 0.008) / 0.05);
    pos.setXYZ(
      i,
      pos.getX(i) * (0.84 + 0.16 * u),
      y,
      pos.getZ(i) * (0.87 + 0.13 * u),
    );
  }
  pos.needsUpdate = true;
  smoothNormals(geo);
  return geo;
}

/**
 * A single phalanx: a conical lathe with a knuckle bead at its base (covering
 * the kink to the previous phalanx), a notch behind it and a taper towards the
 * tip. Axis +y, centered on the origin. Only the distal phalanx gets a rounded
 * fingertip.
 */
function fingerSegment(
  rBase: number,
  rTip: number,
  len: number,
  roundTip: boolean,
): Geo {
  const pts: THREE.Vector2[] = [
    new THREE.Vector2(rBase * 0.86, -0.3 * rBase),
    new THREE.Vector2(rBase * 1.0, 0.14 * rBase),
    new THREE.Vector2(rBase * 0.92, 0.32 * len),
    new THREE.Vector2(rBase * 0.45 + rTip * 0.55, 0.68 * len),
  ];
  if (roundTip) {
    const y1 = len - rTip;
    pts.push(new THREE.Vector2(rTip, y1));
    for (let k = 1; k <= 3; k++) {
      const a = (k / 3) * (Math.PI / 2);
      pts.push(new THREE.Vector2(rTip * Math.cos(a), y1 + rTip * Math.sin(a)));
    }
  } else {
    pts.push(new THREE.Vector2(rTip, len));
  }
  const g = new THREE.LatheGeometry(pts, 9);
  g.translate(0, -len / 2, 0);
  return g;
}

/**
 * Bend per phalanx so the chain wraps around the grip cylinder from the
 * OUTSIDE: every phalanx lies tangentially against the contour offset by the
 * finger radius. `k` < 1 straightens the fingers (opens the hand, always
 * outwards). `dir` = −1 wraps the other way round (thumb), `pad` enlarges the
 * substitute radius per phalanx (e.g. so the thumb lies on top of the fingers
 * that are already wrapped around the grip).
 */
function wrapBends(
  rootY: number,
  rootZ: number,
  grip: GripCyl,
  lens: readonly number[],
  radii: readonly number[],
  k: number,
  dir = 1,
  pad?: readonly number[],
): number[] {
  let py = rootY;
  let pz = rootZ;
  let total = 0;
  const out: number[] = [];
  for (let s = 0; s < lens.length; s++) {
    const re = grip.r + radii[s] + 0.0012 + (pad ? pad[s] : 0);
    const dy = grip.y - py;
    const dz = grip.z - pz;
    const d = Math.max(re + 1e-4, Math.hypot(dy, dz));
    const beta = Math.asin(re / d) * dir;
    const c = Math.cos(beta);
    const sn = Math.sin(beta);
    const ty = (dy / d) * c - (dz / d) * sn;
    const tz = (dy / d) * sn + (dz / d) * c;
    // Unwrap the angle continuously – the wrap goes beyond 180°
    let ang = Math.atan2(-tz, ty);
    while (ang < total - Math.PI) ang += Math.PI * 2;
    while (ang > total + Math.PI) ang -= Math.PI * 2;
    out.push(ang - total);
    total = ang;
    py += lens[s] * ty;
    pz += lens[s] * tz;
  }
  return out.map((b) => b * k);
}

function fingerChain(
  parts: Geo[],
  base: THREE.Vector3,
  q0: THREE.Quaternion,
  lens: number[],
  radii: number[],
  bends: number[],
): void {
  const p = base.clone();
  const q = q0.clone();
  const qb = new THREE.Quaternion();
  for (let s = 0; s < lens.length; s++) {
    qb.setFromAxisAngle(X_AXIS, -bends[s]);
    q.multiply(qb);
    const L = lens[s];
    const seg = fingerSegment(
      radii[s],
      radii[s] * 0.88,
      L,
      s === lens.length - 1,
    );
    const center = p
      .clone()
      .add(new THREE.Vector3(0, L / 2, 0).applyQuaternion(q));
    placeQ(seg, center, q);
    parts.push(seg);
    p.add(new THREE.Vector3(0, L, 0).applyQuaternion(q));
  }
}

/** Thumb placement over the grip (fist on the bail): root, angles, phalanges. */
const THUMB = {
  // slightly inside the end of the sleeve so the grip's bead stays visible
  // next to the thumb
  x: -0.043,
  y: 0.04,
  z: -0.014,
  /** Inclination against the grip axis: 0 = across, π/2 = lengthwise. */
  psi: 0.72,
  /**
   * Extra clearance per phalanx: the proximal phalanx rests directly on the
   * grip sleeve (where it protrudes next to the fist), the distal phalanx
   * wraps on the outside over the fingers already laid around the grip.
   */
  pad: [0.001, 0.01],
  lens: [0.036, 0.028],
  radii: [0.0126, 0.0106],
} as const;

/**
 * Thumb that runs lengthwise over the camera-facing flank of the grip: the
 * wrap is computed in the y-z plane tangentially to the grip just like for the
 * fingers (using the phalanx lengths projected onto that plane), the remaining
 * length runs along the grip axis (x). Because the distance to an axis
 * parallel to x is independent of x, the tangency is preserved exactly.
 */
function thumbChain(parts: Geo[], grip: GripCyl, t: number): void {
  const cs = Math.cos(THUMB.psi);
  const sn = Math.sin(THUMB.psi);
  const rootY = THUMB.y - 0.004 * (1 - t);
  const bends = wrapBends(
    rootY,
    THUMB.z,
    grip,
    THUMB.lens.map((l) => l * cs),
    THUMB.radii,
    0.9 + 0.1 * t,
    -1,
    THUMB.pad,
  );
  const p = new THREE.Vector3(THUMB.x, rootY, THUMB.z);
  const dir = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const yAxis = new THREE.Vector3(0, 1, 0);
  let ang = 0;
  for (let s = 0; s < THUMB.lens.length; s++) {
    ang += bends[s];
    dir.set(sn, cs * Math.cos(ang), -cs * Math.sin(ang));
    q.setFromUnitVectors(yAxis, dir);
    const L = THUMB.lens[s];
    const seg = fingerSegment(
      THUMB.radii[s],
      THUMB.radii[s] * 0.86,
      L,
      s === THUMB.lens.length - 1,
    );
    placeQ(seg, p.clone().addScaledVector(dir, L / 2), q);
    parts.push(seg);
    p.addScaledVector(dir, L);
  }
}

/**
 * Glove in hand space: origin = center of the wrist, +y towards the fingers,
 * palm faces −z, thumb at −x (right hand). `left` mirrors it.
 * The gauntlet ends at y ≈ −0.05 and disappears under the sleeve's cuff –
 * hence no hard seam.
 */
export function gloveGeometry(
  left: boolean,
  pose: HandPose,
  opts: GloveOpts = {},
): Geo {
  const parts: Geo[] = [];
  // Palm with a modelled back of the hand, heel of the hand, gauntlet
  const palm = place(
    rbox(0.082, 0.088, 0.031, opts.knuckles ? 4 : 2, 0.014),
    0,
    0.05,
    0,
  );
  parts.push(opts.knuckles ? palmTaper(palm) : palm);
  if (opts.knuckles) {
    for (let f = 0; f < 4; f++) {
      // Metacarpal bones: flat ridges on the back of the hand that converge
      // towards the wrist. The tendon valleys remain between them – that is
      // what tells the back of the hand apart from a plank.
      parts.push(
        place(
          new THREE.CapsuleGeometry(0.011, 0.032, 3, 10),
          FINGER_X[f] * 0.8,
          0.048,
          0.0146,
          0.06,
          0,
          -FINGER_X[f] * 7,
          0.78,
          1,
          0.3,
        ),
      );
      // Metacarpal head: the knuckle itself
      const k = KNUCKLES[f];
      parts.push(
        place(
          new THREE.SphereGeometry(k[2], 12, 8),
          FINGER_X[f],
          k[0],
          k[1],
          0,
          0,
          0,
          1,
          0.86,
          0.94,
        ),
      );
    }
  }
  // Heel of the hand – narrower than before so it stays under the slimmer
  // sleeve cuff and does not build over the taper of the palm
  parts.push(
    place(
      new THREE.CapsuleGeometry(0.0175, 0.038, 3, 10),
      0,
      0.013,
      0,
      0,
      0,
      Math.PI / 2,
      1,
      1,
      0.8,
    ),
  );
  // Gauntlet: follows the forearm direction so it stays inside the sleeve cuff
  const gauntlet = place(
    new THREE.CylinderGeometry(0.0285, 0.0305, 0.042, 16, 1, true),
    0,
    -0.018,
    0,
    0,
    0,
    0,
    1.02,
    1,
    0.92,
  );
  if (opts.cuffDir) {
    const cd = opts.cuffDir.clone().normalize();
    if (left) cd.x = -cd.x;
    gauntlet.applyQuaternion(
      Q.setFromUnitVectors(new THREE.Vector3(0, -1, 0), cd),
    );
  }
  parts.push(gauntlet);
  // Ball of the thumb (thenar) – carries the thumb root out past the edge of the hand
  parts.push(
    place(
      new THREE.CapsuleGeometry(0.0148, 0.028, 3, 9),
      -0.031,
      0.031,
      -0.005,
      0,
      0,
      0.62,
    ),
  );
  // Four fingers: bend derived analytically from the grip cylinder
  for (let f = 0; f < 4; f++) {
    const radii = SEG_R.map((k) => FINGER_R[f] * k);
    const bends =
      f === 0 && pose.index
        ? [pose.index[0], pose.index[1], pose.index[2]]
        : wrapBends(
            FINGER_ROOT_Y[f],
            FINGER_ROOT_Z[f],
            pose.grip,
            FINGER_LEN[f],
            radii,
            pose.curl * FINGER_CURL[f],
          );
    const q0 = new THREE.Quaternion().setFromAxisAngle(
      Z_AXIS,
      FINGER_SPREAD[f],
    );
    fingerChain(
      parts,
      new THREE.Vector3(FINGER_X[f], FINGER_ROOT_Y[f], FINGER_ROOT_Z[f]),
      q0,
      FINGER_LEN[f],
      radii,
      bends,
    );
  }
  const t = pose.thumb;
  if (opts.thumbAcross) {
    // The thumb lies lengthwise over the camera-facing flank of the grip, its
    // tip pointing at the middle phalanx of the index finger – a classic fist.
    thumbChain(parts, pose.grip, t);
  } else {
    // Thumb: crosses the palm below the grip and rolls with `thumb` against
    // its underside – it does not cross the fingers and stays on the outside.
    const qt = new THREE.Quaternion()
      .setFromAxisAngle(Z_AXIS, -1.25)
      .multiply(
        new THREE.Quaternion().setFromAxisAngle(X_AXIS, -0.2 - t * 0.15),
      );
    fingerChain(
      parts,
      new THREE.Vector3(-0.034, 0.03, -0.01),
      qt,
      [0.045, 0.033],
      [0.0125, 0.0112],
      [0, 0.1 + 0.18 * t],
    );
  }
  const geo = mergeParts(parts);
  if (left) {
    geo.scale(-1, 1, 1);
    flipWinding(geo);
  }
  return geo;
}

// ---------------------------------------------------------------------------
// Sleeve (forearm with fabric folds + knitted cuff)
// ---------------------------------------------------------------------------

export const SLEEVE_LEN = 0.42;

/**
 * Forearm along −y (elbow at y = −SLEEVE_LEN, wrist at y = 0), a lathe with
 * draped folds and a ribbed cuff at the wrist. It is stretched along −y at
 * runtime when the arm extends. The cuff is wider than the glove's gauntlet
 * and sits over it – there is no hard seam.
 */
export function sleeveGeometry(seed: number): Geo {
  const rng = mulberry32(seed);
  const ph1 = rng() * 6.28;
  const ph2 = rng() * 6.28;
  const pts: THREE.Vector2[] = [new THREE.Vector2(0, -SLEEVE_LEN)];
  const n = 22;
  for (let k = 0; k <= n; k++) {
    const t = k / n; // 0 elbow → 1 wrist
    const y = -SLEEVE_LEN + t * (SLEEVE_LEN - 0.055);
    // markedly slimmer towards the wrist – a forearm is thinner there than the
    // hand is wide, otherwise the sleeve swallows the fist
    let r = 0.058 - 0.017 * t;
    r += 0.0034 * Math.sin(t * 27 + ph1) * (0.35 + 0.65 * t);
    r += 0.0013 * Math.sin(t * 59 + ph2);
    pts.push(new THREE.Vector2(r, y));
  }
  // soft transition into the cuff (no step)
  pts.push(new THREE.Vector2(0.0455, -0.05));
  const sleeve = new THREE.LatheGeometry(pts, 26);
  // Knitted cuff with lengthwise ribs, tapering towards the glove
  const cuff = new THREE.CylinderGeometry(0.0405, 0.0465, 0.06, 28, 1, true);
  const cp = cuff.getAttribute("position");
  const cu = cuff.getAttribute("uv");
  for (let i = 0; i < cp.count; i++) {
    const a = cu.getX(i) * Math.PI * 2;
    const x = cp.getX(i);
    const z = cp.getZ(i);
    const r = Math.hypot(x, z);
    if (r < 1e-6) continue;
    const k = (r + 0.0016 * Math.cos(a * 14)) / r;
    cp.setXYZ(i, x * k, cp.getY(i), z * k);
  }
  cuff.computeVertexNormals();
  place(cuff, 0, -0.026, 0);
  // rolled cuff edge at the wrist
  const lip = new THREE.TorusGeometry(0.0396, 0.0039, 6, 28);
  place(lip, 0, 0.0035, 0, Math.PI / 2);
  return mergeParts([sleeve, cuff, lip]);
}

// ---------------------------------------------------------------------------
// Grabber (pistol grip, telescopic tube, two jaws with rubber pads)
// ---------------------------------------------------------------------------

export const GRABBER = {
  /** Center of the grip in grabber space (that is where the hand closes) */
  gripCenter: new THREE.Vector3(0, -0.07, 0.02),
  /** Grip axis (top → bottom), tilted slightly backwards */
  gripAxis: new THREE.Vector3(0, -0.955, 0.296),
  /** Radius of the pistol grip (the fist has to wrap around it). */
  gripR: 0.017,
  extend: 0.3, // telescope travel
} as const;

/**
 * Grabber in grabber space: origin = center of the housing, shaft towards −z.
 * `open` 0..1 opens the jaws (and releases the trigger lever), `ext` 0..1
 * extends the inner tube. Groups: 0 = metal, 1 = plastic.
 */
export function grabberGeometry(open: number, ext: number): Geo {
  const metal: Geo[] = [];
  const plastic: Geo[] = [];
  const tubeY = 0.008;
  const shift = -GRABBER.extend * ext;
  // Outer tube
  metal.push(
    place(
      new THREE.CylinderGeometry(0.0115, 0.0115, 0.5, 12),
      0,
      tubeY,
      -0.28,
      Math.PI / 2,
    ),
  );
  // Inner tube (telescope)
  metal.push(
    place(
      new THREE.CylinderGeometry(0.0085, 0.0085, 0.46, 10),
      0,
      tubeY,
      -0.53 + shift,
      Math.PI / 2,
    ),
  );
  // Head
  const zHead = -0.76 + shift;
  metal.push(
    place(new THREE.BoxGeometry(0.028, 0.022, 0.03), 0, tubeY, zHead - 0.015),
  );
  const zFront = zHead - 0.03;
  // Magnet tip
  metal.push(
    place(
      new THREE.CylinderGeometry(0.0095, 0.0095, 0.006, 12),
      0,
      tubeY,
      zFront - 0.003,
      Math.PI / 2,
    ),
  );
  // Jaws: pivot on the front edges of the head, opening outwards about y
  for (const sgn of [-1, 1]) {
    const ang = sgn * (0.06 + open * 0.62);
    const hx = sgn * 0.012;
    const hz = zFront + 0.004;
    const arm = new THREE.BoxGeometry(0.007, 0.015, 0.085);
    place(arm, 0, 0, -0.0425);
    place(arm, hx, tubeY, hz, 0, ang);
    metal.push(arm);
    const pad = new THREE.BoxGeometry(0.005, 0.013, 0.04);
    place(pad, -sgn * 0.0055, 0, -0.064);
    place(pad, hx, tubeY, hz, 0, ang);
    plastic.push(pad);
  }
  // Housing, cable slot, grip, trigger lever
  plastic.push(place(rbox(0.038, 0.05, 0.09, 2, 0.009), 0, 0, 0));
  plastic.push(
    place(new THREE.BoxGeometry(0.005, 0.003, 0.47), 0, tubeY + 0.0125, -0.28),
  );
  const gripTop = new THREE.Vector3(0, -0.02, 0.005);
  const gripCenter = gripTop.clone().addScaledVector(GRABBER.gripAxis, 0.052);
  const qGrip = new THREE.Quaternion().setFromAxisAngle(X_AXIS, -0.3);
  plastic.push(
    placeQ(
      new THREE.CapsuleGeometry(GRABBER.gripR, 0.07, 3, 12),
      gripCenter,
      qGrip,
    ),
  );
  const lever = new THREE.BoxGeometry(0.013, 0.058, 0.007);
  place(lever, 0, -0.029, 0);
  place(lever, 0, -0.022, -0.026, 0.15 - (1 - open) * 0.4);
  plastic.push(lever);

  const m = mergeParts(metal);
  const p = mergeParts(plastic);
  return mergeParts([m, p], true);
}

// ---------------------------------------------------------------------------
// Fill objects (lying with their long axis along x, origin at the center)
// ---------------------------------------------------------------------------

export type FillKind = "can" | "bottle" | "box" | "crumple" | "plank";
export const FILL_KINDS: FillKind[] = [
  "can",
  "bottle",
  "box",
  "crumple",
  "plank",
];

function latheAlongX(profile: number[][], seg: number, len: number): Geo {
  const geo = new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(r, y)),
    seg,
  );
  geo.translate(0, -len / 2, 0);
  geo.rotateZ(-Math.PI / 2);
  return geo;
}

export function fillKindGeometry(kind: FillKind): Geo {
  switch (kind) {
    case "can":
      return latheAlongX(
        [
          [0, 0],
          [0.026, 0],
          [0.031, 0.004],
          [0.033, 0.012],
          [0.033, 0.1],
          [0.031, 0.108],
          [0.027, 0.114],
          [0.027, 0.118],
          [0, 0.118],
        ],
        12,
        0.118,
      );
    case "bottle":
      return latheAlongX(
        [
          [0, 0],
          [0.03, 0],
          [0.033, 0.006],
          [0.033, 0.13],
          [0.028, 0.16],
          [0.014, 0.19],
          [0.013, 0.205],
          [0.015, 0.215],
          [0.015, 0.225],
          [0, 0.225],
        ],
        10,
        0.225,
      );
    case "box":
      return new THREE.BoxGeometry(0.11, 0.07, 0.085);
    case "plank":
      return new THREE.BoxGeometry(0.16, 0.014, 0.042);
    default: {
      // Crumpled ball: icosahedron with its corners displaced deterministically
      // (angular, like paper)
      const geo = new THREE.IcosahedronGeometry(0.032, 1);
      const pos = geo.getAttribute("position");
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = pos.getZ(i);
        const qx = Math.round(x * 1e4);
        const qy = Math.round(y * 1e4);
        const qz = Math.round(z * 1e4);
        const s =
          Math.sin(qx * 12.9898 + qy * 78.233 + qz * 37.719) * 43758.5453;
        const k = 1 + (s - Math.floor(s) - 0.5) * 0.55;
        pos.setXYZ(i, x * k, y * k * 0.85, z * k * 1.1);
      }
      geo.computeVertexNormals();
      return geo;
    }
  }
}
