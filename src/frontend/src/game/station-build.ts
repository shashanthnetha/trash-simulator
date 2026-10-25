// Trash Simulator – build helpers for the recycling station: geometry
// collector (one mesh per material), UV projection, shapes/tubes/rivets, the
// material set from the procedural PBR library and the decal atlas (signs,
// markings).

import * as THREE from "three";
import {
  mergeGeometries,
  toCreasedNormals,
} from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  applyPbr,
  makeCanvas,
  pbrBrushedMetal,
  pbrConcrete,
  pbrCorrugatedSheet,
  pbrPlastic,
  pbrRustyMetal,
  pbrScuffedMetal,
  pbrWood,
} from "./textures";

/** Station dimensions (local: x right, y up, +z towards the access road). */
export const SD = {
  apronX: 13.6,
  apronZ: 10.2,
  apronTop: 0.34,
  apronBase: -1.9,
  hallX0: -12.7,
  hallX1: -0.7,
  hallZ0: -7.6,
  hallZ1: 1.4,
  hallH: 6.1,
  eaveH: 5.5,
  doorW: 5,
  doorH: 4.3,
  doorCx: -7.4,
  plantCx: 8.2,
  plantCz: -3.6,
  drumR: 1.02,
  drumL: 4.6,
  drumY: 1.95,
  frameTop: 3.62,
  hopperY0: 3.3,
  hopperY1: 4.65,
  binZ: 6.2,
  binX0: 2.5,
  binDx: 3.02,
  binW: 2.4,
  binD: 1.7,
} as const;

export type StMat =
  | "concrete"
  | "wall"
  | "steel"
  | "chrome"
  | "paint"
  | "plastic"
  | "rubber"
  | "wood"
  | "rust"
  | "decal"
  | "lamp"
  | "glass"
  | "dark";

/** Lamp channel (alpha of the vertex color): emission per channel via uniform. */
export const LAMP_CH = {
  flood: 0.1,
  beacon: 0.3,
  interior: 0.5,
  panel: 0.7,
  fixed: 0.9,
} as const;

// ---------------------------------------------------------------------------
// Transforms and basic shapes
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

/** Axis-aligned box given by its centre coordinates. */
export function box(
  w: number,
  h: number,
  d: number,
  x = 0,
  y = 0,
  z = 0,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/** Box from two corner points (min/max per axis). */
export function boxFromTo(
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): THREE.BufferGeometry {
  return box(
    Math.abs(x1 - x0),
    Math.abs(y1 - y0),
    Math.abs(z1 - z0),
    (x0 + x1) / 2,
    (y0 + y1) / 2,
    (z0 + z1) / 2,
  );
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
  const len = Math.hypot(dx, dy, dz) || 1e-4;
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
  r = 0.035,
): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, 6, 3, 0, Math.PI * 2, 0, Math.PI / 2);
  g.scale(1, 0.5, 1);
  V.set(nx, ny, nz).normalize();
  Q.setFromUnitVectors(UP, V);
  g.applyQuaternion(Q);
  g.translate(x, y, z);
  return g;
}

export function roundedRectShape(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const hw = w / 2;
  const hh = h / 2;
  const rr = Math.max(0.001, Math.min(r, hw - 0.001, hh - 0.001));
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

/** Polygon shape from points (xy plane). */
export function polyShape(
  pts: readonly (readonly [number, number])[],
): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
  s.closePath();
  return s;
}

/** Extrusion with a bevel (soft edges), result in the shape plane, depth along +z. */
export function extrudeBevel(
  shape: THREE.Shape,
  depth: number,
  bevel: number,
  bevelSeg = 2,
  curveSeg = 6,
): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.0005, depth),
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
  return out;
}

/** Box with rounded corners (footprint w×d, height h), centre cx/cy/cz. */
export function roundedBox(
  w: number,
  h: number,
  d: number,
  r: number,
  bevel: number,
  cx = 0,
  cy = 0,
  cz = 0,
): THREE.BufferGeometry {
  const b = Math.min(bevel, w / 2 - 0.002, d / 2 - 0.002, h / 2 - 0.002);
  const shape = roundedRectShape(w - 2 * b, d - 2 * b, Math.max(0.003, r - b));
  const g = extrudeBevel(shape, h - 2 * b, b, 2, 5);
  g.rotateX(-Math.PI / 2);
  g.translate(cx, cy - h / 2 + b, cz);
  return g;
}

/**
 * Truncated pyramid with a square footprint (containers, hopper): top edge
 * `wTop`×`dTop`, bottom edge tapered by `bottom`, height h, centre at cy.
 */
export function taperBox(
  wTop: number,
  dTop: number,
  h: number,
  bottom: number,
  cx = 0,
  cy = 0,
  cz = 0,
  open = false,
): THREE.BufferGeometry {
  const R = Math.SQRT1_2;
  const g = new THREE.CylinderGeometry(R, R * bottom, h, 4, 1, open);
  g.rotateY(Math.PI / 4);
  g.scale(wTop, 1, dTop);
  g.translate(cx, cy, cz);
  return g;
}

/** Pull the top edge of a box onto a height profile (mono-pitch roof walls). */
export function slopeTop(
  g: THREE.BufferGeometry,
  yTop: number,
  f: (x: number, z: number) => number,
): THREE.BufferGeometry {
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) < yTop - 1e-3) continue;
    pos.setY(i, f(pos.getX(i), pos.getZ(i)));
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/** Tube along a polyline with rounded corners (hydraulics, cables). */
export function tubePath(
  pts: readonly (readonly [number, number, number])[],
  r: number,
  cornerR = 0.12,
  radial = 6,
  segPerMeter = 6,
): THREE.BufferGeometry {
  const v = pts.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
  const path = new THREE.CurvePath<THREE.Vector3>();
  let cur = v[0];
  let total = 0;
  for (let i = 1; i < v.length; i++) {
    const p = v[i];
    if (i < v.length - 1) {
      const n = v[i + 1];
      const d0 = p.distanceTo(cur) || 1e-4;
      const d1 = n.distanceTo(p) || 1e-4;
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
  const segs = Math.max(6, Math.round(total * segPerMeter));
  return new THREE.TubeGeometry(path, segs, r, radial, false);
}

/** Plane with its UVs mapped onto an atlas region (normal +z). */
export function decalQuad(
  region: DecalRegion,
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
// UV projection
// ---------------------------------------------------------------------------

/**
 * Box projection per triangle: u runs horizontally, v upwards (wall) or in
 * z (roof/lid). Corrugated-sheet ribs therefore stand vertically on walls and
 * run down towards the eaves on sloped roofs.
 */
function boxUv(g: THREE.BufferGeometry, su: number, sv: number): void {
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
    const up = ay >= ax && ay >= az;
    for (let k = 0; k < 3; k++) {
      const x = pos.getX(i + k);
      const y = pos.getY(i + k);
      const z = pos.getZ(i + k);
      const u = up ? x : ax >= az ? z : x;
      const v = up ? z : y;
      uv[(i + k) * 2] = u * su;
      uv[(i + k) * 2 + 1] = v * sv;
    }
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

/** Tiles per metre per material ([u, v]). */
const UV_SCALE: Record<StMat, [number, number]> = {
  concrete: [0.32, 0.32],
  wall: [1.15, 0.4],
  steel: [0.85, 0.85],
  chrome: [1.1, 1.1],
  paint: [0.7, 0.7],
  plastic: [0.5, 0.5],
  rubber: [1.3, 1.3],
  wood: [0.55, 1.4],
  rust: [0.45, 0.45],
  decal: [1, 1],
  lamp: [1, 1],
  glass: [0.6, 0.6],
  dark: [0.5, 0.5],
};

// ---------------------------------------------------------------------------
// Geometry collector
// ---------------------------------------------------------------------------

/** UV projection of a material onto a single geometry (mesh without a bag). */
export function applyMatUv(
  key: StMat,
  g: THREE.BufferGeometry,
  uv?: [number, number],
): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  if (geo !== g) g.dispose();
  const s = uv ?? UV_SCALE[key];
  boxUv(geo, s[0], s[1]);
  return geo;
}

/** Merge several geometries into one (the sources are disposed). */
export function mergeAll(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const src = list.map((g) => (g.index ? g.toNonIndexed() : g));
  const merged = mergeGeometries(src, false);
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== list[i]) list[i].dispose();
    if (src[i] !== merged) src[i].dispose();
  }
  if (!merged) throw new Error("Station: mergeAll failed");
  merged.computeBoundingSphere();
  return merged;
}

const TINT_BASE: Partial<Record<StMat, THREE.Color>> = {
  paint: new THREE.Color("#e8e8e6"),
  plastic: new THREE.Color("#d6d6d2"),
};
const TMP_COL = new THREE.Color();

/**
 * Vertex color that pulls the base tint of the material texture towards `hex`
 * (linear working color space – values > 1 are allowed).
 */
export function tint(
  key: StMat,
  hex: string | number,
): [number, number, number] {
  const base = TINT_BASE[key];
  TMP_COL.set(hex);
  if (!base) return [TMP_COL.r, TMP_COL.g, TMP_COL.b];
  return [TMP_COL.r / base.r, TMP_COL.g / base.g, TMP_COL.b / base.b];
}

export interface AddOpts {
  /** Keep the existing UVs (decals, lathe, cylinder shells). */
  keepUv?: boolean;
  /** Vertex color: rgb (paint/plastic) or rgba with a lamp channel (lamp). */
  color?: readonly [number, number, number, number?];
  /** Custom UV scale instead of the material default. */
  uv?: [number, number];
}

/** Collects geometries per material and merges them into one mesh each. */
export class StationBag {
  private lists = new Map<StMat, THREE.BufferGeometry[]>();

  add(key: StMat, g: THREE.BufferGeometry, opts: AddOpts = {}): void {
    let geo = g;
    if (opts.keepUv) {
      if (g.index) {
        geo = g.toNonIndexed();
        g.dispose();
      }
    } else {
      geo = applyMatUv(key, g, opts.uv);
    }
    if (opts.color) {
      const col = opts.color;
      const n = geo.getAttribute("position").count;
      const hasA = key === "lamp";
      const stride = hasA ? 4 : 3;
      const arr = new Float32Array(n * stride);
      for (let i = 0; i < n; i++) {
        arr[i * stride] = col[0];
        arr[i * stride + 1] = col[1];
        arr[i * stride + 2] = col[2];
        if (hasA) arr[i * stride + 3] = col[3] ?? LAMP_CH.fixed;
      }
      geo.setAttribute("color", new THREE.BufferAttribute(arr, stride));
    }
    let list = this.lists.get(key);
    if (!list) {
      list = [];
      this.lists.set(key, list);
    }
    list.push(geo);
  }

  /** Add both sides (mirrored at the plane x = axis). */
  addMirrored(
    key: StMat,
    g: THREE.BufferGeometry,
    axis: number,
    opts: AddOpts = {},
  ): void {
    this.add(key, mirrorAt(g), opts);
    this.add(key, g, opts);
    function mirrorAt(src: THREE.BufferGeometry): THREE.BufferGeometry {
      const m = src.index ? src.toNonIndexed() : src.clone();
      m.translate(-axis, 0, 0);
      m.scale(-1, 1, 1);
      m.translate(axis, 0, 0);
      swapWinding(m);
      return m;
    }
  }

  /** Merges everything; returns one mesh per material (empty keys are dropped). */
  build(mats: Record<StMat, THREE.Material>): Map<StMat, THREE.Mesh> {
    const out = new Map<StMat, THREE.Mesh>();
    for (const [key, list] of this.lists) {
      if (list.length === 0) continue;
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) throw new Error(`Station: mergeGeometries (${key}) failed`);
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mats[key]);
      mesh.name = `station-${key}`;
      // Also skipped in the shadow pass: "lamp" (lenses and interior strips
      // flush against larger surfaces), "dark" (drainage channel and weighbridge
      // sunk into the concrete, hall ceiling slab, bale straps - all inside or
      // level with something that already casts) and "rubber" (container
      // wheels, hose reel, conveyor belt - under or inside their own body).
      mesh.castShadow =
        key !== "decal" &&
        key !== "glass" &&
        key !== "lamp" &&
        key !== "dark" &&
        key !== "rubber";
      mesh.receiveShadow = true;
      out.set(key, mesh);
    }
    this.lists.clear();
    return out;
  }
}

/**
 * Reverse the triangle orientation – needed after mirroring (scale(-1,1,1)
 * already flips the normals, but not the winding order).
 * Expects a non-indexed geometry.
 */
function swapWinding(g: THREE.BufferGeometry): void {
  for (const name of ["position", "normal", "uv"]) {
    const a = g.getAttribute(name) as THREE.BufferAttribute | undefined;
    if (!a) continue;
    const three = a.itemSize > 2;
    for (let i = 0; i < a.count; i += 3) {
      const x = a.getX(i + 1);
      const y = a.getY(i + 1);
      const z = three ? a.getZ(i + 1) : 0;
      a.setX(i + 1, a.getX(i + 2));
      a.setY(i + 1, a.getY(i + 2));
      if (three) a.setZ(i + 1, a.getZ(i + 2));
      a.setX(i + 2, x);
      a.setY(i + 2, y);
      if (three) a.setZ(i + 2, z);
    }
    a.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Decal atlas
// ---------------------------------------------------------------------------

export type DecalRegion = readonly [number, number, number, number];

const ATLAS = 1024;

function region(x0: number, y0: number, x1: number, y1: number): DecalRegion {
  return [x0 / ATLAS, 1 - y1 / ATLAS, x1 / ATLAS, 1 - y0 / ATLAS];
}

export interface StationAtlas {
  tex: THREE.Texture;
  logo: DecalRegion;
  bins: DecalRegion[];
  chevron: DecalRegion;
  hatch: DecalRegion;
  arrow: DecalRegion;
  bayLine: DecalRegion;
  joint: DecalRegion;
  panel: DecalRegion;
  display: DecalRegion;
  plate: DecalRegion;
  gauge: DecalRegion;
  annahme: DecalRegion;
  waage: DecalRegion;
  warn: DecalRegion;
  hazard: DecalRegion;
}

/** Draw diagonal warning hatching (seamless in u) into a rectangle. */
function chevronStrip(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  a: string,
  b: string,
  pitch: number,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = a;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = b;
  ctx.lineWidth = 0;
  for (let px = -h; px < w + h; px += pitch * 2) {
    ctx.beginPath();
    ctx.moveTo(x + px, y + h);
    ctx.lineTo(x + px + pitch, y + h);
    ctx.lineTo(x + px + pitch + h, y);
    ctx.lineTo(x + px + h, y);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** Möbius recycling mark: three arrow bands on the sides of a triangle. */
function recycleMark(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  color: string,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = color;
  for (let k = 0; k < 3; k++) {
    ctx.save();
    ctx.rotate((k * Math.PI * 2) / 3);
    ctx.beginPath();
    ctx.moveTo(-r * 0.62, r * 0.3);
    ctx.lineTo(r * 0.14, r * 0.3);
    ctx.lineTo(r * 0.14, r * 0.12);
    ctx.lineTo(r * 0.62, r * 0.47);
    ctx.lineTo(r * 0.14, r * 0.82);
    ctx.lineTo(r * 0.14, r * 0.64);
    ctx.lineTo(-r * 0.62, r * 0.64);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

/** Fit text into `max` width (scale the font size down). */
function fitText(
  ctx: CanvasRenderingContext2D,
  txt: string,
  x: number,
  y: number,
  max: number,
  size: number,
  weight = "bold",
): void {
  let s = size;
  ctx.font = `${weight} ${Math.round(s)}px Arial, Helvetica, sans-serif`;
  while (ctx.measureText(txt).width > max && s > 6) {
    s -= 1;
    ctx.font = `${weight} ${Math.round(s)}px Arial, Helvetica, sans-serif`;
  }
  ctx.fillText(txt, x, y);
}

function labelPlate(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  bg: string,
  fg: string,
  title: string,
  sub: string,
): void {
  ctx.fillStyle = "#20242a";
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 10);
  ctx.fill();
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(x + 5, y + 5, w - 10, h - 10, 7);
  ctx.fill();
  recycleMark(ctx, x + h * 0.42, y + h * 0.42, h * 0.26, fg);
  ctx.fillStyle = fg;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const tx = x + h * 0.78;
  const max = w - (tx - x) - 12;
  fitText(ctx, title, tx, y + h * 0.52, max, h * 0.4);
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(tx, y + h * 0.62);
  ctx.lineTo(x + w - 12, y + h * 0.62);
  ctx.stroke();
  ctx.globalAlpha = 0.85;
  fitText(ctx, sub, tx, y + h * 0.82, max, h * 0.17, "");
  ctx.globalAlpha = 1;
}

/** Atlas of all printed surfaces (1024², sRGB, alpha for cutouts). */
export function makeStationAtlas(): StationAtlas {
  const [c, ctx] = makeCanvas(ATLAS, ATLAS);
  ctx.clearRect(0, 0, ATLAS, ATLAS);
  ctx.textBaseline = "alphabetic";

  // --- Hall sign: "RECYCLING" (0,0)–(760,190)
  ctx.fillStyle = "#0d5c6b";
  ctx.beginPath();
  ctx.roundRect(0, 0, 760, 190, 8);
  ctx.fill();
  ctx.fillStyle = "#f2f4f1";
  ctx.fillRect(0, 150, 760, 8);
  ctx.fillRect(0, 166, 760, 4);
  recycleMark(ctx, 92, 74, 62, "#8fd6a0");
  ctx.fillStyle = "#f2f4f1";
  ctx.textAlign = "left";
  fitText(ctx, "RECYCLING", 180, 100, 560, 92);
  ctx.globalAlpha = 0.85;
  fitText(ctx, "RECOVERY YARD · DUNE EDGE", 182, 136, 560, 30);
  ctx.globalAlpha = 1;

  // --- Hazard triangle (780,0)–(900,110)
  ctx.fillStyle = "#f2c132";
  ctx.beginPath();
  ctx.moveTo(840, 4);
  ctx.lineTo(898, 106);
  ctx.lineTo(782, 106);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#1a1a1c";
  ctx.lineWidth = 7;
  ctx.stroke();
  ctx.fillStyle = "#1a1a1c";
  ctx.font = "bold 54px Arial, Helvetica, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("!", 840, 96);

  // --- Container signs (4×250×120) at y = 210
  const BINS: Array<[string, string, string, string]> = [
    ["#2f9e44", "#f2f6f2", "GLASS", "Bottles · Broken glass"],
    ["#e8b81c", "#2a2410", "PLASTIC", "Film · Cups · PET"],
    ["#7f8b96", "#12191f", "METAL", "Cans · Scrap"],
    ["#1e6fbf", "#f0f5fb", "PAPER", "Card · Cartons"],
  ];
  const bins: DecalRegion[] = [];
  for (let i = 0; i < 4; i++) {
    const bx = i * 256;
    labelPlate(
      ctx,
      bx,
      210,
      250,
      120,
      BINS[i][0],
      BINS[i][1],
      BINS[i][2],
      BINS[i][3],
    );
    bins.push(region(bx, 210, bx + 250, 330));
  }

  // --- Warning hatching (machinery) and floor hatching
  chevronStrip(ctx, 0, 344, 1024, 72, "#e8b81c", "#1a1a1c", 46);
  chevronStrip(ctx, 0, 428, 1024, 72, "#e2c34a", "#c8a92c", 52);

  // --- Floor arrow (0,516)–(300,596)
  ctx.fillStyle = "#e6dfcb";
  ctx.beginPath();
  ctx.moveTo(6, 540);
  ctx.lineTo(196, 540);
  ctx.lineTo(196, 520);
  ctx.lineTo(294, 556);
  ctx.lineTo(196, 592);
  ctx.lineTo(196, 572);
  ctx.lineTo(6, 572);
  ctx.closePath();
  ctx.fill();

  // --- Bay line (320,516)–(560,536) and expansion joint (600,516)–(1000,530)
  ctx.fillStyle = "#e0d7bd";
  ctx.fillRect(320, 516, 240, 20);
  ctx.fillStyle = "#4c4a45";
  ctx.fillRect(600, 518, 400, 12);

  // --- Control cabinet front (0,610)–(320,750)
  ctx.fillStyle = "#2b3138";
  ctx.beginPath();
  ctx.roundRect(0, 610, 320, 140, 8);
  ctx.fill();
  ctx.fillStyle = "#161a1e";
  ctx.fillRect(14, 624, 180, 46);
  ctx.fillStyle = "#7ef0a8";
  ctx.font = "bold 22px monospace";
  ctx.textAlign = "left";
  ctx.fillText("THROUGHPUT OK", 22, 656);
  const BTN: Array<[string, string]> = [
    ["#3ba55d", "START"],
    ["#c0392b", "STOP"],
    ["#d8a629", "MANUAL"],
  ];
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = BTN[i][0];
    ctx.beginPath();
    ctx.arc(40 + i * 62, 706, 21, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#0e1114";
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.fillStyle = "#cfd4d8";
    ctx.font = "bold 14px Arial, Helvetica, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(BTN[i][1], 40 + i * 62, 740);
  }
  ctx.textAlign = "left";
  ctx.fillStyle = "#9aa3ab";
  ctx.font = "13px Arial, Helvetica, sans-serif";
  ctx.fillText("SORTER ST-40", 214, 640);
  ctx.fillText("BELT 1", 214, 660);
  ctx.fillText("E-STOP", 214, 700);
  ctx.fillStyle = "#c0392b";
  ctx.beginPath();
  ctx.arc(262, 722, 18, 0, Math.PI * 2);
  ctx.fill();

  // --- Weighbridge display (340,610)–(600,720)
  ctx.fillStyle = "#1c2126";
  ctx.beginPath();
  ctx.roundRect(340, 610, 260, 110, 8);
  ctx.fill();
  ctx.fillStyle = "#0b0f12";
  ctx.fillRect(352, 622, 236, 58);
  ctx.fillStyle = "#ff8b3d";
  ctx.font = "bold 44px monospace";
  ctx.textAlign = "right";
  ctx.fillText("1.284 t", 578, 666);
  ctx.textAlign = "left";
  ctx.fillStyle = "#8b949c";
  ctx.font = "bold 16px Arial, Helvetica, sans-serif";
  ctx.fillText("GROSS", 354, 704);
  ctx.fillText("VERIFIED 2029", 452, 704);

  // --- Type plate (620,610)–(820,700)
  ctx.fillStyle = "#8d949a";
  ctx.beginPath();
  ctx.roundRect(620, 610, 200, 90, 5);
  ctx.fill();
  ctx.strokeStyle = "#5a6167";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = "#232a30";
  ctx.font = "bold 20px Arial, Helvetica, sans-serif";
  ctx.fillText("DUNE TECHNICS", 632, 636);
  ctx.font = "13px monospace";
  ctx.fillText("TYPE ST-40 / 7.5 kW", 632, 658);
  ctx.fillText("SN 4711-2029", 632, 676);
  ctx.fillText("400V 3~ 50Hz", 632, 692);

  // --- Fill-level scale (860,610)–(960,760)
  ctx.fillStyle = "#1b2026";
  ctx.beginPath();
  ctx.roundRect(860, 610, 100, 150, 6);
  ctx.fill();
  ctx.strokeStyle = "#c9cfd4";
  ctx.lineWidth = 2;
  ctx.fillStyle = "#c9cfd4";
  ctx.font = "11px Arial, Helvetica, sans-serif";
  ctx.textAlign = "left";
  for (let i = 0; i <= 4; i++) {
    const yy = 748 - i * 32;
    ctx.beginPath();
    ctx.moveTo(866, yy);
    ctx.lineTo(886, yy);
    ctx.stroke();
    ctx.fillText(`${i * 25}`, 890, yy + 4);
  }
  ctx.font = "bold 12px Arial, Helvetica, sans-serif";
  ctx.fillText("FILL", 864, 626);

  // --- "DROP-OFF" (0,770)–(420,880)
  ctx.fillStyle = "#12506b";
  ctx.beginPath();
  ctx.roundRect(0, 770, 420, 110, 8);
  ctx.fill();
  ctx.fillStyle = "#f0f4f6";
  fitText(ctx, "DROP-OFF", 22, 830, 262, 58);
  ctx.beginPath();
  ctx.moveTo(300, 806);
  ctx.lineTo(370, 806);
  ctx.lineTo(370, 792);
  ctx.lineTo(404, 820);
  ctx.lineTo(370, 848);
  ctx.lineTo(370, 834);
  ctx.lineTo(300, 834);
  ctx.closePath();
  ctx.fill();
  fitText(ctx, "Mon–Sat 07:00–19:00", 24, 866, 270, 19);

  // --- "SCALE" (440,770)–(740,880)
  ctx.fillStyle = "#e6e2d6";
  ctx.beginPath();
  ctx.roundRect(440, 770, 300, 110, 8);
  ctx.fill();
  ctx.strokeStyle = "#22262a";
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.fillStyle = "#22262a";
  ctx.font = "bold 46px Arial, Helvetica, sans-serif";
  ctx.fillText("SCALE", 462, 824);
  ctx.font = "bold 24px Arial, Helvetica, sans-serif";
  ctx.fillText("max. 40 t", 464, 858);

  // --- Warning board (760,770)–(1020,880)
  ctx.fillStyle = "#e8b81c";
  ctx.beginPath();
  ctx.roundRect(760, 770, 260, 110, 8);
  ctx.fill();
  ctx.fillStyle = "#1a1a1c";
  ctx.font = "bold 26px Arial, Helvetica, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("WARNING", 890, 806);
  ctx.font = "bold 16px Arial, Helvetica, sans-serif";
  ctx.fillText("Plant starts automatically", 890, 834);
  ctx.fillText("Wear helmet & hi-vis vest", 890, 858);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return {
    tex,
    logo: region(0, 0, 760, 190),
    bins,
    chevron: region(0, 344, 1024, 416),
    hatch: region(0, 428, 1024, 500),
    arrow: region(0, 516, 300, 596),
    bayLine: region(320, 516, 560, 536),
    joint: region(600, 516, 1000, 530),
    panel: region(0, 610, 320, 750),
    display: region(340, 610, 600, 720),
    plate: region(620, 610, 820, 700),
    gauge: region(860, 610, 960, 760),
    annahme: region(0, 770, 420, 880),
    waage: region(440, 770, 740, 880),
    warn: region(760, 770, 1020, 880),
    hazard: region(780, 0, 900, 110),
  };
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

export interface StationMaterials {
  mats: Record<StMat, THREE.Material>;
  /** x floodlight, y status light, z hall light, w control cabinet. */
  lampI: { value: THREE.Vector4 };
  atlas: StationAtlas;
  /** Conveyor belt (own texture instance, gets scrolled). */
  belt: THREE.MeshStandardMaterial;
  gauge: THREE.MeshStandardMaterial;
  pool: THREE.MeshBasicMaterial;
  /** Couple the reflection strength to the time of day (1 = noon). */
  setEnvIntensity(k: number): void;
  dispose(): void;
}

/**
 * Static beach surroundings as an equirect map. Without it the metallic sets
 * (corrugated sheet, steel, chrome) render almost black.
 */
function makeStationEnvMap(): THREE.Texture {
  const W = 256;
  const H = 128;
  const [c, ctx] = makeCanvas(W, H);
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, "#4a7cc4");
  sky.addColorStop(0.32, "#8bb6e6");
  sky.addColorStop(0.48, "#dde8ef");
  sky.addColorStop(0.5, "#e9e3d3");
  sky.addColorStop(0.58, "#cdb98f");
  sky.addColorStop(1, "#96835f");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  const sea = ctx.createLinearGradient(0, H * 0.5, 0, H * 0.62);
  sea.addColorStop(0, "rgba(92,152,172,0.9)");
  sea.addColorStop(1, "rgba(92,152,172,0)");
  ctx.fillStyle = sea;
  ctx.fillRect(0, H * 0.5, W * 0.5, H * 0.12);
  const sx = W * 0.34;
  const sy = H * 0.26;
  const sun = ctx.createRadialGradient(sx, sy, 0, sx, sy, 28);
  sun.addColorStop(0, "rgba(255,251,238,1)");
  sun.addColorStop(0.28, "rgba(255,246,218,0.9)");
  sun.addColorStop(1, "rgba(255,240,200,0)");
  ctx.fillStyle = sun;
  ctx.fillRect(sx - 32, sy - 32, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Soft light field for the floodlights' pools of light on the ground. */
function poolTexture(): THREE.Texture {
  const [c, ctx] = makeCanvas(128, 128);
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,236,196,0.85)");
  g.addColorStop(0.45, "rgba(255,226,170,0.35)");
  g.addColorStop(1, "rgba(255,220,160,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export function makeStationMaterials(): StationMaterials {
  const atlas = makeStationAtlas();
  const lampI = { value: new THREE.Vector4(0, 0, 0, 0.35) };
  const envMap = makeStationEnvMap();

  const concrete = new THREE.MeshStandardMaterial({ color: 0xffffff });
  applyPbr(concrete, pbrConcrete());

  // Cool tint: damps the orange rust of the corrugated-sheet/rust sets
  const wall = new THREE.MeshStandardMaterial({
    color: 0xc4d0d6,
    envMap,
    envMapIntensity: 0.75,
  });
  applyPbr(wall, pbrCorrugatedSheet());
  wall.metalness = 0.65;
  // Draw the ribs more clearly – otherwise the sheet looks like a flat panel
  wall.normalScale.set(2.1, 2.1);

  const steel = new THREE.MeshStandardMaterial({
    color: 0xc0c7cd,
    envMap,
    envMapIntensity: 0.8,
  });
  applyPbr(steel, pbrScuffedMetal("#5b6167"));
  steel.metalness = 0.78;

  const chrome = new THREE.MeshStandardMaterial({
    color: 0xdde2e6,
    envMap,
    envMapIntensity: 0.7,
  });
  applyPbr(chrome, pbrBrushedMetal("#b9c0c6"));

  const paint = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    envMap,
    envMapIntensity: 0.5,
  });
  applyPbr(paint, pbrScuffedMetal("#e8e8e6"));
  paint.metalness = 0.25;

  const plastic = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    envMap,
    envMapIntensity: 0.35,
  });
  applyPbr(plastic, pbrPlastic("#d6d6d2", { wear: 0.45 }));

  const rubber = new THREE.MeshStandardMaterial({ color: 0xffffff });
  applyPbr(rubber, pbrPlastic("#3a3e43", { wear: 0.65 }));

  const wood = new THREE.MeshStandardMaterial({ color: 0xffffff });
  applyPbr(wood, pbrWood("plank"));

  const rust = new THREE.MeshStandardMaterial({
    color: 0xb2b6b8,
    envMap,
    envMapIntensity: 0.4,
  });
  applyPbr(rust, pbrRustyMetal("#7a8087", 0.4, { edges: false }));
  rust.metalness = 0.5;

  const dark = new THREE.MeshStandardMaterial({
    color: 0x3a3c3f,
    roughness: 0.94,
    metalness: 0.05,
  });

  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x9fb6bd,
    roughness: 0.16,
    metalness: 0,
    transparent: true,
    opacity: 0.42,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
    side: THREE.DoubleSide,
    depthWrite: false,
    envMap,
    envMapIntensity: 1.1,
  });

  const decal = new THREE.MeshStandardMaterial({
    map: atlas.tex,
    roughness: 0.6,
    metalness: 0,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });

  const lamp = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.28,
    metalness: 0,
  });
  lamp.customProgramCacheKey = () => "station-lamp";
  lamp.onBeforeCompile = (shader) => {
    shader.uniforms.uLampI = lampI;
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec4 uLampI;")
      .replace("#include <color_fragment>", "diffuseColor.rgb *= vColor.rgb;")
      .replace(
        "vec3 totalEmissiveRadiance = emissive;",
        [
          "float lch = vColor.a;",
          "float lk = lch < 0.2 ? uLampI.x : (lch < 0.4 ? uLampI.y : (lch < 0.6 ? uLampI.z : (lch < 0.8 ? uLampI.w : 0.25)));",
          "vec3 totalEmissiveRadiance = vColor.rgb * lk;",
        ].join("\n"),
      );
  };

  const belt = new THREE.MeshStandardMaterial({ color: 0xffffff });
  applyPbr(belt, pbrPlastic("#4c5157", { wear: 0.75 }), [1, 1]);

  const gauge = new THREE.MeshStandardMaterial({
    color: 0x37b24d,
    emissive: 0x0f3d1c,
    roughness: 0.35,
    metalness: 0,
  });

  const poolTex = poolTexture();
  const pool = new THREE.MeshBasicMaterial({
    map: poolTex,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
  });

  const mats: Record<StMat, THREE.Material> = {
    concrete,
    wall,
    steel,
    chrome,
    paint,
    plastic,
    rubber,
    wood,
    rust,
    decal,
    lamp,
    glass,
    dark,
  };
  const withEnv = [wall, steel, chrome, paint, plastic, rust, glass];
  const envBase = withEnv.map((m) => m.envMapIntensity);
  return {
    mats,
    lampI,
    atlas,
    belt,
    gauge,
    pool,
    setEnvIntensity(k) {
      for (let i = 0; i < withEnv.length; i++)
        withEnv[i].envMapIntensity = envBase[i] * k;
    },
    dispose() {
      for (const m of Object.values(mats)) m.dispose();
      belt.dispose();
      gauge.dispose();
      pool.dispose();
      poolTex.dispose();
      envMap.dispose();
      atlas.tex.dispose();
    },
  };
}
