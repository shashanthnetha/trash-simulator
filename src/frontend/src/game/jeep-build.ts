// Trash Simulator – build helpers for the jeep model: geometry collector (one
// mesh per material), UV projections, shapes/extrusions/tubes, materials from
// the procedural PBR library, environment map for paint/chrome/glass and the
// decal atlas (number plate, instruments, emblems, stickers).

import * as THREE from "three";
import {
  mergeGeometries,
  toCreasedNormals,
} from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  applyPbr,
  makeCanvas,
  pbrBrushedMetal,
  pbrCarPaint,
  pbrDashboard,
  pbrGlass,
  pbrRim,
  pbrRope,
  pbrScuffedMetal,
  pbrSeatFabric,
  pbrTire,
} from "./textures";

/** Vehicle dimensions (local: x right, y up, z rear; wheel centres at y = 0). */
export const JD = {
  wheelR: 0.46,
  wheelW: 0.3,
  rimR: 0.235,
  trackX: 0.8,
  axleF: -1.25,
  axleR: 1.25,
  ground: -0.48,
  floorY: 0.3,
  sillY: 0.55,
  tubTop: 0.92,
  hoodTop: 1.0,
  fenderTop: 0.82,
  tubHalfW: 0.84,
  hoodHalfW: 0.62,
  frontZ: -1.95,
  cowlZ: -0.885,
  doorZ0: -0.67,
  doorZ1: 0.43,
  bedZ0: 0.56,
  rearZ: 1.75,
  wsBaseY: 0.98,
  wsBaseZ: -0.72,
  wsTopY: 1.62,
  wsTopZ: -0.53,
  cageTopY: 1.86,
  hoopZ: 0.44,
  /** Paint color of the beach patrol. */
  paintHex: "#266f66",
} as const;

export type JeepMat =
  | "paint"
  | "trim"
  | "steel"
  | "chrome"
  | "lamp"
  | "glass"
  | "mirror"
  | "seat"
  | "decal"
  | "dial";

/** Lamp channel (alpha of the vertex color): emission strength per channel via uniform. */
export const LAMP_CH = {
  head: 0.1,
  tail: 0.3,
  reverse: 0.5,
  dash: 0.7,
  fixed: 0.9,
} as const;

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

const M = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const E = new THREE.Euler();
const V = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);

/** Rotate (Euler XYZ) and translate a geometry – in place. */
export function place(
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

/** Mirror at x = 0 (copy), the face orientation is corrected. */
export function mirrorX(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const c = g.index ? g.toNonIndexed() : g.clone();
  c.scale(-1, 1, 1);
  const pos = c.getAttribute("position") as THREE.BufferAttribute;
  const nor = c.getAttribute("normal") as THREE.BufferAttribute | undefined;
  const uv = c.getAttribute("uv") as THREE.BufferAttribute | undefined;
  for (let i = 0; i < pos.count; i += 3) swapVerts(i + 1, i + 2, pos, nor, uv);
  return c;
}

function swapVerts(
  a: number,
  b: number,
  pos: THREE.BufferAttribute,
  nor?: THREE.BufferAttribute,
  uv?: THREE.BufferAttribute,
): void {
  const px = pos.getX(a);
  const py = pos.getY(a);
  const pz = pos.getZ(a);
  pos.setXYZ(a, pos.getX(b), pos.getY(b), pos.getZ(b));
  pos.setXYZ(b, px, py, pz);
  if (nor) {
    const nx = nor.getX(a);
    const ny = nor.getY(a);
    const nz = nor.getZ(a);
    nor.setXYZ(a, nor.getX(b), nor.getY(b), nor.getZ(b));
    nor.setXYZ(b, nx, ny, nz);
  }
  if (uv) {
    const ux = uv.getX(a);
    const uy = uv.getY(a);
    uv.setXY(a, uv.getX(b), uv.getY(b));
    uv.setXY(b, ux, uy);
  }
}

/** Cylinder between two points (axis a→b). */
export function cylBetween(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  r: number,
  seg = 8,
  r2 = r,
): THREE.BufferGeometry {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.hypot(dx, dy, dz);
  const g = new THREE.CylinderGeometry(r2, r, len, seg, 1, false);
  V.set(dx, dy, dz).normalize();
  Q.setFromUnitVectors(UP, V);
  g.applyQuaternion(Q);
  g.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  return g;
}

/** Rivet/bolt head: flat hemisphere, +y along the surface normal. */
export function rivet(
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
  r = 0.008,
): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, 7, 4, 0, Math.PI * 2, 0, Math.PI / 2);
  g.scale(1, 0.55, 1);
  V.set(nx, ny, nz).normalize();
  Q.setFromUnitVectors(UP, V);
  g.applyQuaternion(Q);
  g.translate(x, y, z);
  return g;
}

// ---------------------------------------------------------------------------
// Shapes & extrusions
// ---------------------------------------------------------------------------

export function roundedRectShape(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const hw = w / 2;
  const hh = h / 2;
  const rr = Math.min(r, hw, hh);
  s.moveTo(-hw + rr, -hh);
  s.lineTo(hw - rr, -hh);
  s.absarc(hw - rr, -hh + rr, rr, -Math.PI / 2, 0, false);
  s.lineTo(hw, hh - rr);
  s.absarc(hw - rr, hh - rr, rr, 0, Math.PI / 2, false);
  s.lineTo(-hw + rr, hh);
  s.absarc(-hw + rr, hh - rr, rr, Math.PI / 2, Math.PI, false);
  s.lineTo(-hw, -hh + rr);
  s.absarc(-hw + rr, -hh + rr, rr, Math.PI, Math.PI * 1.5, false);
  s.closePath();
  return s;
}

/** Polygon shape from points. */
export function polyShape(pts: readonly (readonly [number, number])[]) {
  const s = new THREE.Shape();
  s.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
  s.closePath();
  return s;
}

/**
 * Extrusion with a bevel (rounded edges, soft normals). The result lies in the
 * shape plane (XY), extruded along +z from -bevel to depth+bevel; the walls are
 * offset outwards by `bevel`.
 */
export function extrudeBevel(
  shape: THREE.Shape,
  depth: number,
  bevel: number,
  bevelSeg = 4,
  curveSeg = 10,
): THREE.BufferGeometry {
  const d = Math.max(0.0005, depth);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: d,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: 0,
    bevelSegments: bevelSeg,
    curveSegments: curveSeg,
    steps: 1,
  });
  const out = toCreasedNormals(g, Math.PI / 3);
  if (out !== g) g.dispose();
  const b = bevel > 0 ? bevel : 0;
  flattenCaps(out, -b, d + b);
  return out;
}

/**
 * The cap faces of an extrusion only have border vertices – toCreasedNormals
 * averages them with the bevel and thereby tilts the whole face. Two adjacent
 * parts (door/tub) end up with different tilts and a visible vertical color
 * step appears. That is why the caps are forced to exactly ±z.
 */
function flattenCaps(g: THREE.BufferGeometry, z0: number, z1: number): void {
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const nor = g.getAttribute("normal") as THREE.BufferAttribute | undefined;
  if (!nor) return;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    if (Math.abs(z - z0) < 1e-6) nor.setXYZ(i, 0, 0, -1);
    else if (Math.abs(z - z1) < 1e-6) nor.setXYZ(i, 0, 0, 1);
  }
  nor.needsUpdate = true;
}

/**
 * Box with rounded corners (footprint w×d, height h) and bevelled edges,
 * centre (cx, cy, cz). Walls exactly at w×d, top exactly at cy+h/2.
 */
export function roundedBox(
  w: number,
  h: number,
  d: number,
  r: number,
  bevel: number,
  cx = 0,
  cy = 0,
  cz = 0,
  bevelSeg = 2,
  curveSeg = 5,
): THREE.BufferGeometry {
  const b = Math.min(bevel, w / 2 - 0.001, d / 2 - 0.001, h / 2 - 0.001);
  const shape = roundedRectShape(w - 2 * b, d - 2 * b, Math.max(0.002, r - b));
  const g = extrudeBevel(shape, h - 2 * b, b, bevelSeg, curveSeg);
  // shape-y → world -z, extrusion → +y
  g.rotateX(-Math.PI / 2);
  g.translate(cx, cy - h / 2 + b, cz);
  return g;
}

/**
 * Extrude a side view (x = world z, y = world y) along x: outer face at
 * xOuter, thickness inwards (towards 0). For the left side (xOuter < 0) the
 * result is mirrored.
 */
export function extrudeSide(
  shape: THREE.Shape,
  xOuter: number,
  thickness: number,
  bevel: number,
  bevelSeg = 3,
): THREE.BufferGeometry {
  const g = extrudeBevel(shape, thickness - 2 * bevel, bevel, bevelSeg, 14);
  g.rotateY(-Math.PI / 2); // extrusion +z → world -x, shape-x → world +z
  g.translate(Math.abs(xOuter) - bevel, 0, 0);
  if (xOuter < 0) {
    const m = mirrorX(g);
    g.dispose();
    return m;
  }
  return g;
}

/** Extrude a front view (x = world x, y = world y) along +z from zFront. */
export function extrudeFront(
  shape: THREE.Shape,
  zFront: number,
  thickness: number,
  bevel: number,
  bevelSeg = 3,
): THREE.BufferGeometry {
  const g = extrudeBevel(shape, thickness - 2 * bevel, bevel, bevelSeg, 12);
  g.translate(0, 0, zFront + bevel);
  return g;
}

/** Tube along a polyline with rounded corners. */
export function tubePath(
  pts: readonly (readonly [number, number, number])[],
  r: number,
  cornerR = 0.08,
  radial = 10,
  segPerMeter = 26,
): THREE.BufferGeometry {
  const v = pts.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
  const path = new THREE.CurvePath<THREE.Vector3>();
  let cur = v[0];
  let total = 0;
  for (let i = 1; i < v.length; i++) {
    const p = v[i];
    if (i < v.length - 1) {
      const n = v[i + 1];
      const d0 = p.distanceTo(cur);
      const d1 = n.distanceTo(p);
      const cr = Math.min(cornerR, d0 * 0.45, d1 * 0.45);
      const a = p.clone().lerp(cur, cr / d0);
      const b = p.clone().lerp(n, cr / d1);
      path.add(new THREE.LineCurve3(cur, a));
      path.add(new THREE.QuadraticBezierCurve3(a, p.clone(), b));
      total += cur.distanceTo(a) + cr * 1.6;
      cur = b;
    } else {
      path.add(new THREE.LineCurve3(cur, p));
      total += cur.distanceTo(p);
    }
  }
  const segs = Math.max(4, Math.round(total * segPerMeter));
  return new THREE.TubeGeometry(path, segs, r, radial, false);
}

class Helix extends THREE.Curve<THREE.Vector3> {
  constructor(
    private r: number,
    private turns: number,
    private height: number,
  ) {
    super();
  }
  getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    const a = t * this.turns * Math.PI * 2;
    return target.set(
      Math.cos(a) * this.r,
      t * this.height - this.height / 2,
      Math.sin(a) * this.r,
    );
  }
}

/** Coil spring (axis y, centred on 0). */
export function coilSpring(
  r: number,
  wire: number,
  turns: number,
  height: number,
): THREE.BufferGeometry {
  return new THREE.TubeGeometry(
    new Helix(r, turns, height),
    Math.round(turns * 14),
    wire,
    7,
    false,
  );
}

/**
 * Slightly convex pane (normal +z): the fanned-out normals make the
 * environment map travel across the surface – a flat quad by contrast looks
 * like an evenly bright piece of card.
 */
export function convexGlass(
  w: number,
  h: number,
  bulge: number,
): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h, 4, 3);
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) / (w / 2);
    const y = pos.getY(i) / (h / 2);
    pos.setZ(i, bulge * (1 - 0.5 * (x * x + y * y)));
  }
  g.computeVertexNormals();
  return g;
}

/** Plane with its UVs mapped onto an atlas region (normal +z). */
export function decalQuad(
  region: readonly [number, number, number, number],
  w: number,
  h: number,
): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  const [u0, v0, u1, v1] = region;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  }
  return g;
}

// ---------------------------------------------------------------------------
// UV projections
// ---------------------------------------------------------------------------

/** Box projection per triangle (dominant face normal), `scale` tiles/m. */
function boxUv(g: THREE.BufferGeometry, scale: number): void {
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const n = pos.count;
  const uv = new Float32Array(n * 2);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const fn = new THREE.Vector3();
  for (let i = 0; i < n; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    fn.subVectors(c, b).cross(a.clone().sub(b));
    const ax = Math.abs(fn.x);
    const ay = Math.abs(fn.y);
    const az = Math.abs(fn.z);
    for (let k = 0; k < 3; k++) {
      const x = pos.getX(i + k);
      const y = pos.getY(i + k);
      const z = pos.getZ(i + k);
      let u: number;
      let v: number;
      if (ax >= ay && ax >= az) {
        u = z;
        v = y;
      } else if (ay >= az) {
        u = x;
        v = z;
      } else {
        u = x;
        v = y;
      }
      uv[(i + k) * 2] = u * scale;
      uv[(i + k) * 2 + 1] = v * scale;
    }
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

/**
 * Paint projection: v = height (0 bottom → 1 top, dirt at the bottom), u along
 * the surface; on upward faces it is blended smoothly into a clean zone.
 */
function paintUv(g: THREE.BufferGeometry): void {
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const nor = g.getAttribute("normal") as THREE.BufferAttribute;
  const n = pos.count;
  const uv = new Float32Array(n * 2);
  const S = 0.55;
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nx = nor.getX(i);
    const ny = nor.getY(i);
    const nz = nor.getZ(i);
    const uSide = (Math.abs(nx) > Math.abs(nz) ? z : x) * S + 0.5;
    const vSide = (y - 0.2) / 0.85;
    const uTop = x * S + 0.5;
    const vTop = 0.66 + 0.3 * ((z + 2.1) / 4.4);
    const w = sstep(0.35, 0.75, ny);
    const wDown = sstep(-0.35, -0.75, ny);
    let u = uSide + (uTop - uSide) * w;
    let v = vSide + (vTop - vSide) * w;
    v = v + (0.04 - v) * wDown;
    u = u + (x * S + z * S - u) * wDown;
    uv[i * 2] = u;
    uv[i * 2 + 1] = Math.min(0.985, Math.max(0.015, v));
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

function sstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

const UV_SCALE: Partial<Record<JeepMat, number>> = {
  trim: 1.6,
  steel: 1.3,
  chrome: 0.9,
  glass: 0.8,
  seat: 2.0,
};

// ---------------------------------------------------------------------------
// Geometry collector
// ---------------------------------------------------------------------------

export interface AddOpts {
  /** Keep the existing UVs (lathe, decals, cylinder labels). */
  keepUv?: boolean;
  /** Vertex color (rgb + lamp channel) – for the lamp material. */
  color?: readonly [number, number, number, number];
}

/** Collects geometries per material and merges them into one mesh each. */
export class PartBag {
  private lists = new Map<JeepMat, THREE.BufferGeometry[]>();

  add(key: JeepMat, g: THREE.BufferGeometry, opts: AddOpts = {}): void {
    let geo = g;
    if (g.index) {
      geo = g.toNonIndexed();
      g.dispose();
    }
    if (!opts.keepUv) {
      if (key === "paint") paintUv(geo);
      else if (key !== "lamp" && key !== "decal" && key !== "dial")
        boxUv(geo, UV_SCALE[key] ?? 1);
    }
    if (key === "lamp") {
      const col = opts.color ?? [1, 1, 1, LAMP_CH.fixed];
      const n = geo.getAttribute("position").count;
      const arr = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        arr[i * 4] = col[0];
        arr[i * 4 + 1] = col[1];
        arr[i * 4 + 2] = col[2];
        arr[i * 4 + 3] = col[3];
      }
      geo.setAttribute("color", new THREE.BufferAttribute(arr, 4));
    }
    let list = this.lists.get(key);
    if (!list) {
      list = [];
      this.lists.set(key, list);
    }
    list.push(geo);
  }

  /** Add both sides (mirrored in x). */
  addMirrored(key: JeepMat, g: THREE.BufferGeometry, opts: AddOpts = {}) {
    const m = mirrorX(g);
    this.add(key, g, opts);
    this.add(key, m, opts);
  }

  /** Merges everything; returns one mesh per material (empty keys are dropped). */
  build(mats: Record<JeepMat, THREE.Material>): Map<JeepMat, THREE.Mesh> {
    const out = new Map<JeepMat, THREE.Mesh>();
    for (const [key, list] of this.lists) {
      if (list.length === 0) continue;
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) throw new Error(`Jeep: mergeGeometries (${key}) failed`);
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mats[key]);
      mesh.name = `jeep-${key}`;
      // "lamp" too: head-/tail-light lenses sit flush in the body panels, so
      // their shadow is already contained in the body's - one draw call less.
      const shadowCaster =
        key !== "glass" &&
        key !== "decal" &&
        key !== "dial" &&
        key !== "mirror" &&
        key !== "lamp";
      mesh.castShadow = shadowCaster;
      mesh.receiveShadow = true;
      out.set(key, mesh);
    }
    this.lists.clear();
    return out;
  }
}

// ---------------------------------------------------------------------------
// Environment map (static beach surroundings for reflections)
// ---------------------------------------------------------------------------

/** Equirect environment: blue sky, bright horizon, sun, sand at the bottom. */
export function makeEnvMap(): THREE.Texture {
  const W = 256;
  const H = 128;
  const [c, ctx] = makeCanvas(W, H);
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, "#3d74c4");
  sky.addColorStop(0.3, "#7fb0e6");
  sky.addColorStop(0.48, "#dbe7ef");
  sky.addColorStop(0.5, "#e8e2d2");
  sky.addColorStop(0.56, "#cbb58c");
  sky.addColorStop(1, "#8f7d5c");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  // Sea band below the horizon (one half of the panorama)
  const sea = ctx.createLinearGradient(0, H * 0.5, 0, H * 0.6);
  sea.addColorStop(0, "rgba(90,150,170,0.9)");
  sea.addColorStop(1, "rgba(90,150,170,0)");
  ctx.fillStyle = sea;
  ctx.fillRect(0, H * 0.5, W * 0.5, H * 0.1);
  // Sun
  const sx = W * 0.3;
  const sy = H * 0.28;
  const sun = ctx.createRadialGradient(sx, sy, 0, sx, sy, 26);
  sun.addColorStop(0, "rgba(255,250,235,1)");
  sun.addColorStop(0.25, "rgba(255,245,215,0.9)");
  sun.addColorStop(1, "rgba(255,240,200,0)");
  ctx.fillStyle = sun;
  ctx.fillRect(sx - 30, sy - 30, 60, 60);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Decal atlas
// ---------------------------------------------------------------------------

export type DecalRegion = readonly [number, number, number, number];

export interface DecalAtlas {
  tex: THREE.Texture;
  plate: DecalRegion;
  speedo: DecalRegion;
  fuel: DecalRegion;
  temp: DecalRegion;
  emblem: DecalRegion;
  number: DecalRegion;
  tree: DecalRegion;
  radio: DecalRegion;
  sticker: DecalRegion;
  stripe: DecalRegion;
  dark: DecalRegion;
  water: DecalRegion;
}

const ATLAS = 1024;

function region(x0: number, y0: number, x1: number, y1: number): DecalRegion {
  return [x0 / ATLAS, 1 - y1 / ATLAS, x1 / ATLAS, 1 - y0 / ATLAS];
}

function dial(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  max: number,
  step: number,
  label: string,
  ticksOnly = false,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = "#1b1d20";
  ctx.fill();
  ctx.lineWidth = r * 0.06;
  ctx.strokeStyle = "#5a5e63";
  ctx.stroke();
  const a0 = (-225 * Math.PI) / 180;
  const a1 = (45 * Math.PI) / 180;
  const n = max / step;
  ctx.strokeStyle = "#e9e6dc";
  ctx.fillStyle = "#e9e6dc";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `bold ${Math.round(r * 0.22)}px Arial, Helvetica, sans-serif`;
  for (let i = 0; i <= n * 2; i++) {
    const a = a0 + ((a1 - a0) * i) / (n * 2);
    const major = i % 2 === 0;
    const rIn = r * (major ? 0.72 : 0.8);
    ctx.lineWidth = major ? r * 0.035 : r * 0.02;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * rIn, cy + Math.sin(a) * rIn);
    ctx.lineTo(cx + Math.cos(a) * r * 0.88, cy + Math.sin(a) * r * 0.88);
    ctx.stroke();
    if (major && !ticksOnly) {
      const val = (i / 2) * step;
      ctx.fillText(
        `${val}`,
        cx + Math.cos(a) * r * 0.56,
        cy + Math.sin(a) * r * 0.56,
      );
    }
  }
  ctx.font = `${Math.round(r * 0.16)}px Arial, Helvetica, sans-serif`;
  ctx.fillStyle = "#b9b5a8";
  ctx.fillText(label, cx, cy + r * 0.33);
  // Hub
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.08, 0, Math.PI * 2);
  ctx.fillStyle = "#3a3d41";
  ctx.fill();
  ctx.restore();
}

/** Atlas of all printed surfaces (1024², sRGB, alpha for cutouts). */
export function makeDecalAtlas(): DecalAtlas {
  const [c, ctx] = makeCanvas(ATLAS, ATLAS);
  ctx.clearRect(0, 0, ATLAS, ATLAS);

  // Number plate (invented): white, narrow dark field on the left
  ctx.fillStyle = "#f2f1ec";
  ctx.beginPath();
  ctx.roundRect(0, 0, 340, 80, 6);
  ctx.fill();
  ctx.strokeStyle = "#2a2c30";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = "#1f3f7a";
  ctx.fillRect(3, 3, 34, 74);
  ctx.fillStyle = "#f2f1ec";
  ctx.font = "bold 16px Arial, Helvetica, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("BP", 20, 40);
  ctx.fillStyle = "#1c1d20";
  ctx.font = "bold 54px Arial, Helvetica, sans-serif";
  ctx.fillText("DN · BP 42", 190, 42);

  // Instruments
  dial(ctx, 128, 224, 124, 80, 10, "km/h");
  dial(ctx, 320, 160, 56, 1, 0.5, "", true);
  ctx.fillStyle = "#e9e6dc";
  ctx.font = "bold 16px Arial, Helvetica, sans-serif";
  ctx.fillText("E", 292, 178);
  ctx.fillText("F", 348, 178);
  ctx.fillText("FUEL", 320, 190);
  dial(ctx, 320, 288, 56, 1, 0.5, "", true);
  ctx.fillText("C", 292, 306);
  ctx.fillText("H", 348, 306);
  ctx.fillText("°C", 320, 318);

  // Emblem: round badge with a wave and a sun
  const ex = 560;
  const ey = 256;
  const er = 150;
  ctx.beginPath();
  ctx.arc(ex, ey, er, 0, Math.PI * 2);
  ctx.fillStyle = "#efe6cc";
  ctx.fill();
  ctx.lineWidth = 10;
  ctx.strokeStyle = "#1f3f5a";
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(ex, ey, er * 0.62, 0, Math.PI * 2);
  ctx.fillStyle = "#7fb7d8";
  ctx.fill();
  ctx.fillStyle = "#f4c04a";
  ctx.beginPath();
  ctx.arc(ex + 20, ey - 30, 34, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#1f5f8a";
  ctx.beginPath();
  ctx.moveTo(ex - er * 0.62, ey + 20);
  ctx.bezierCurveTo(ex - 40, ey - 30, ex, ey + 60, ex + er * 0.62, ey + 10);
  ctx.lineTo(ex + er * 0.62, ey + er * 0.62);
  ctx.lineTo(ex - er * 0.62, ey + er * 0.62);
  ctx.closePath();
  ctx.save();
  ctx.beginPath();
  ctx.arc(ex, ey, er * 0.62, 0, Math.PI * 2);
  ctx.clip();
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = "#1f3f5a";
  ctx.font = "bold 30px Arial, Helvetica, sans-serif";
  const txt = "BEACH PATROL · DUNE EDGE · ";
  const stepA = (Math.PI * 2) / txt.length;
  for (let k = 0; k < txt.length; k++) {
    ctx.save();
    ctx.translate(ex, ey);
    ctx.rotate(k * stepA - Math.PI / 2);
    ctx.fillText(txt[k], 0, -er * 0.8);
    ctx.restore();
  }

  // Large number 42 (doors/bonnet)
  ctx.fillStyle = "#efe6cc";
  ctx.font = "bold 190px Impact, 'Arial Black', Arial, sans-serif";
  ctx.strokeStyle = "#1f3f5a";
  ctx.lineWidth = 10;
  ctx.strokeText("42", 870, 300);
  ctx.fillText("42", 870, 300);

  // Air freshener tree
  ctx.fillStyle = "#2f8a4a";
  ctx.beginPath();
  ctx.moveTo(820, 440);
  ctx.lineTo(880, 520);
  ctx.lineTo(860, 520);
  ctx.lineTo(905, 585);
  ctx.lineTo(880, 585);
  ctx.lineTo(925, 650);
  ctx.lineTo(715, 650);
  ctx.lineTo(760, 585);
  ctx.lineTo(735, 585);
  ctx.lineTo(780, 520);
  ctx.lineTo(760, 520);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#5a3a1e";
  ctx.fillRect(808, 650, 24, 22);
  ctx.fillStyle = "#f5efd8";
  ctx.font = "bold 22px Arial, Helvetica, sans-serif";
  ctx.fillText("DUNE", 820, 590);
  ctx.fillText("SCENT", 820, 615);

  // Radio
  ctx.fillStyle = "#151719";
  ctx.beginPath();
  ctx.roundRect(0, 420, 400, 130, 8);
  ctx.fill();
  ctx.fillStyle = "#284a3a";
  ctx.fillRect(20, 436, 240, 54);
  ctx.fillStyle = "#9df0b8";
  // 20px keeps the longer station name inside the green display field
  ctx.font = "bold 20px monospace";
  ctx.textAlign = "left";
  ctx.fillText("FM 101.3 COASTWAVE", 28, 468);
  ctx.fillStyle = "#c8c5bb";
  ctx.font = "13px Arial, Helvetica, sans-serif";
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = "#3a3d41";
    ctx.beginPath();
    ctx.roundRect(20 + i * 40, 500, 32, 30, 4);
    ctx.fill();
    ctx.fillStyle = "#c8c5bb";
    ctx.fillText(`${i + 1}`, 32 + i * 40, 516);
  }
  ctx.fillStyle = "#3a3d41";
  ctx.beginPath();
  ctx.arc(320, 480, 36, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#c8c5bb";
  ctx.fillRect(318, 450, 4, 22);

  // Sticker: warning notice
  ctx.fillStyle = "#f2c132";
  ctx.beginPath();
  ctx.roundRect(420, 440, 260, 70, 8);
  ctx.fill();
  ctx.fillStyle = "#1c1d20";
  ctx.font = "bold 22px Arial, Helvetica, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("WALKING PACE ONLY", 550, 465);
  ctx.font = "bold 15px Arial, Helvetica, sans-serif";
  ctx.fillText("Beach reserve · 4×4 · observe restricted zone", 550, 492, 240);

  // Stripe (cream) and dark field (cord etc.) – with a margin so that the
  // mipmaps do not blend with transparent black
  ctx.fillStyle = "#efe6cc";
  ctx.fillRect(880, 0, 144, 96);
  ctx.fillStyle = "#1a1a1c";
  ctx.fillRect(880, 100, 144, 90);

  // Water canister sticker
  ctx.fillStyle = "#1f5f8a";
  ctx.beginPath();
  ctx.roundRect(420, 540, 260, 90, 10);
  ctx.fill();
  ctx.fillStyle = "#f4f4f2";
  ctx.font = "bold 40px Arial, Helvetica, sans-serif";
  ctx.fillText("WATER", 550, 575);
  ctx.font = "bold 18px Arial, Helvetica, sans-serif";
  ctx.fillText("DRINKING WATER · 20 L", 550, 610, 240);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return {
    tex,
    plate: region(0, 0, 340, 80),
    speedo: region(0, 96, 256, 352),
    fuel: region(260, 100, 380, 220),
    temp: region(260, 228, 380, 348),
    emblem: region(400, 96, 720, 416),
    number: region(750, 195, 990, 395),
    tree: region(700, 430, 940, 680),
    radio: region(0, 420, 400, 550),
    sticker: region(420, 440, 680, 510),
    stripe: region(912, 16, 1000, 76),
    dark: region(912, 116, 1000, 176),
    water: region(420, 540, 680, 630),
  };
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

export interface JeepMaterials {
  mats: Record<JeepMat, THREE.Material>;
  tire: THREE.MeshStandardMaterial;
  rim: THREE.MeshStandardMaterial;
  rope: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  /** Mirror glass: tint `color` from the sky at runtime. */
  mirror: THREE.MeshStandardMaterial;
  /** Instruments: emissiveIntensity = illumination at night. */
  dial: THREE.MeshStandardMaterial;
  /** Lamp uniform: x headlights, y tail/brake, z reverse, w instruments. */
  lampI: { value: THREE.Vector4 };
  envMap: THREE.Texture;
  atlas: DecalAtlas;
  setEnvIntensity(k: number): void;
  dispose(): void;
}

export function makeJeepMaterials(): JeepMaterials {
  const envMap = makeEnvMap();
  const atlas = makeDecalAtlas();
  const lampI = { value: new THREE.Vector4(0, 0, 0, 0) };

  const paint = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    clearcoat: 1,
    clearcoatRoughness: 0.12,
    envMap,
    envMapIntensity: 1,
  });
  applyPbr(paint, pbrCarPaint(JD.paintHex, { dirt: 0.65, scratches: 0.5 }));

  const trim = new THREE.MeshStandardMaterial({ color: 0xffffff, envMap });
  applyPbr(trim, pbrDashboard("#25272a"));

  const steel = new THREE.MeshStandardMaterial({ color: 0xffffff, envMap });
  applyPbr(steel, pbrScuffedMetal("#4b4f53"));

  const chrome = new THREE.MeshStandardMaterial({ color: 0xffffff, envMap });
  applyPbr(chrome, pbrBrushedMetal("#d4d8dc"));

  const seat = new THREE.MeshStandardMaterial({ color: 0xffffff });
  applyPbr(seat, pbrSeatFabric("#5c5e55"));

  // Tinted glass instead of a milky pane: dark base color + low opacity so the
  // view through the windscreen stays clear; the reflection comes from the
  // environment map.
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x28343a,
    transparent: true,
    opacity: 0.22,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    side: THREE.DoubleSide,
    depthWrite: false,
    envMap,
    envMapIntensity: 2.6,
  });
  applyPbr(glass, pbrGlass());
  glass.roughness = 0.5;

  // Mirror glass: dark tinted metal, its color follows the sky at runtime
  const mirror = new THREE.MeshStandardMaterial({
    color: 0x39464e,
    roughness: 0.07,
    metalness: 0.95,
    envMap,
    envMapIntensity: 1.3,
  });

  const decal = new THREE.MeshStandardMaterial({
    map: atlas.tex,
    roughness: 0.45,
    metalness: 0,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  const dial = new THREE.MeshStandardMaterial({
    map: atlas.tex,
    emissiveMap: atlas.tex,
    emissive: 0xffffff,
    emissiveIntensity: 0,
    roughness: 0.5,
    metalness: 0,
    alphaTest: 0.5,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  const lamp = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.18,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
    envMap,
    envMapIntensity: 1,
  });
  lamp.customProgramCacheKey = () => "jeep-lamp";
  lamp.onBeforeCompile = (shader) => {
    shader.uniforms.uLampI = lampI;
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec4 uLampI;")
      .replace("#include <color_fragment>", "diffuseColor.rgb *= vColor.rgb;")
      .replace(
        "vec3 totalEmissiveRadiance = emissive;",
        [
          "float lch = vColor.a;",
          "float lk = lch < 0.2 ? uLampI.x : (lch < 0.4 ? uLampI.y : (lch < 0.6 ? uLampI.z : (lch < 0.8 ? uLampI.w : 0.22)));",
          "vec3 totalEmissiveRadiance = vColor.rgb * lk;",
        ].join("\n"),
      );
  };

  const tire = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    envMap,
    envMapIntensity: 0.4,
  });
  applyPbr(tire, pbrTire());
  // Pure black swallows all modelling – lift the albedo to ≈ #2a2a2c and show
  // the tread relief more clearly.
  tire.color.setRGB(1.45, 1.42, 1.4);
  tire.normalScale.set(1.5, 1.5);
  const rim = new THREE.MeshStandardMaterial({ color: 0xffffff, envMap });
  applyPbr(rim, pbrRim({ colorHex: "#3d4043" }));
  const rope = new THREE.MeshStandardMaterial({ color: 0xffffff });
  applyPbr(rope, pbrRope("#c8bc9c"));

  const mats: Record<JeepMat, THREE.Material> = {
    paint,
    trim,
    steel,
    chrome,
    lamp,
    glass,
    mirror,
    seat,
    decal,
    dial,
  };
  const withEnv: THREE.MeshStandardMaterial[] = [
    paint,
    trim,
    steel,
    chrome,
    lamp,
    glass,
    mirror,
    rim,
    tire,
  ];
  const envBase = withEnv.map((m) => m.envMapIntensity);
  return {
    mats,
    tire,
    rim,
    rope,
    glass,
    mirror,
    dial,
    lampI,
    envMap,
    atlas,
    setEnvIntensity(k) {
      for (let i = 0; i < withEnv.length; i++)
        withEnv[i].envMapIntensity = envBase[i] * k;
    },
    dispose() {
      for (const m of Object.values(mats)) m.dispose();
      tire.dispose();
      rim.dispose();
      rope.dispose();
      envMap.dispose();
      atlas.tex.dispose();
    },
  };
}
