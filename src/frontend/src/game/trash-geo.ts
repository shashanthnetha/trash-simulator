// Geometry helpers for the trash models: lathes with height-based UV, tubes
// with a variable radius along curves, deformation (dents/creases),
// position-based normal smoothing, UV remapping and merging by material.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

// ---------------------------------------------------------------------------
// Noise (3D value noise, deterministic)
// ---------------------------------------------------------------------------

function hash3(x: number, y: number, z: number): number {
  let h =
    Math.imul(x, 374761393) +
    Math.imul(y, 668265263) +
    Math.imul(z, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function sm(t: number): number {
  return t * t * (3 - 2 * t);
}

export function noise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const u = sm(x - xi);
  const v = sm(y - yi);
  const w = sm(z - zi);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c00 = l(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), u);
  const c10 = l(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), u);
  const c01 = l(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), u);
  const c11 = l(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), u);
  return l(l(c00, c10, v), l(c01, c11, v), w);
}

export function fbm3(x: number, y: number, z: number, oct = 3): number {
  let a = 0.5;
  let f = 1;
  let s = 0;
  let norm = 0;
  for (let i = 0; i < oct; i++) {
    s += a * noise3(x * f + i * 17.3, y * f + i * 5.1, z * f - i * 9.7);
    norm += a;
    a *= 0.5;
    f *= 2.1;
  }
  return s / norm;
}

/** Ridged noise 0..1 (kinks, creases). */
export function ridged3(x: number, y: number, z: number, oct = 3): number {
  let a = 0.5;
  let f = 1;
  let s = 0;
  let norm = 0;
  for (let i = 0; i < oct; i++) {
    s +=
      a *
      (1 -
        Math.abs(
          2 * noise3(x * f + i * 3.7, y * f - i * 11.1, z * f + i * 7.9) - 1,
        ));
    norm += a;
    a *= 0.5;
    f *= 2;
  }
  return s / norm;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Transformation / deformation
// ---------------------------------------------------------------------------

export function xform(
  geo: THREE.BufferGeometry,
  pos?: [number, number, number],
  rot?: [number, number, number],
  scale?: number | [number, number, number],
): THREE.BufferGeometry {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(rot?.[0] ?? 0, rot?.[1] ?? 0, rot?.[2] ?? 0),
  );
  const s =
    scale === undefined
      ? new THREE.Vector3(1, 1, 1)
      : typeof scale === "number"
        ? new THREE.Vector3(scale, scale, scale)
        : new THREE.Vector3(scale[0], scale[1], scale[2]);
  m.compose(
    new THREE.Vector3(pos?.[0] ?? 0, pos?.[1] ?? 0, pos?.[2] ?? 0),
    q,
    s,
  );
  geo.applyMatrix4(m);
  return geo;
}

/**
 * Displace vertices. `fn` gets position and normal and returns either a
 * scalar (displacement along the normal) or a vector (absolute
 * displacement). Normals are NOT recomputed afterwards (see
 * weldNormals / computeVertexNormals).
 */
export function displace(
  geo: THREE.BufferGeometry,
  fn: (p: THREE.Vector3, n: THREE.Vector3, i: number) => number | THREE.Vector3,
): THREE.BufferGeometry {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const nor = geo.getAttribute("normal") as THREE.BufferAttribute | undefined;
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    if (nor) n.fromBufferAttribute(nor, i);
    else n.set(0, 1, 0);
    const d = fn(p, n, i);
    if (typeof d === "number") p.addScaledVector(n, d);
    else p.add(d);
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  pos.needsUpdate = true;
  return geo;
}

/**
 * Smooth normals via position equality (works across UV seams and on
 * non-indexed geometry too). For boxes (hard edges) use
 * computeVertexNormals() instead.
 */
export function weldNormals(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const count = pos.count;
  const idx = geo.index;
  const triCount = idx ? idx.count / 3 : count / 3;
  const key = new Array<string>(count);
  const acc = new Map<string, THREE.Vector3>();
  for (let i = 0; i < count; i++) {
    const k = `${Math.round(pos.getX(i) * 20000)},${Math.round(pos.getY(i) * 20000)},${Math.round(pos.getZ(i) * 20000)}`;
    key[i] = k;
    if (!acc.has(k)) acc.set(k, new THREE.Vector3());
  }
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const fn = new THREE.Vector3();
  for (let t = 0; t < triCount; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3;
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    b.sub(a);
    c.sub(a);
    fn.crossVectors(b, c); // area-weighted
    acc.get(key[i0])?.add(fn);
    acc.get(key[i1])?.add(fn);
    acc.get(key[i2])?.add(fn);
  }
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const n = acc.get(key[i]);
    if (!n) continue;
    const l = n.length();
    if (l > 1e-12) {
      out[i * 3] = n.x / l;
      out[i * 3 + 1] = n.y / l;
      out[i * 3 + 2] = n.z / l;
    } else {
      out[i * 3 + 1] = 1;
    }
  }
  geo.setAttribute("normal", new THREE.BufferAttribute(out, 3));
  return geo;
}

export function remapUv(
  geo: THREE.BufferGeometry,
  fn: (u: number, v: number, p: THREE.Vector3) => [number, number],
): THREE.BufferGeometry {
  const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const p = new THREE.Vector3();
  for (let i = 0; i < uv.count; i++) {
    p.fromBufferAttribute(pos, i);
    const r = fn(uv.getX(i), uv.getY(i), p);
    uv.setXY(i, r[0], r[1]);
  }
  uv.needsUpdate = true;
  return geo;
}

/** Planar UV over the bounding box: u along `ua`, v along `va`. */
export function planarUv(
  geo: THREE.BufferGeometry,
  ua: "x" | "y" | "z",
  va: "x" | "y" | "z",
  repeat: [number, number] = [1, 1],
): THREE.BufferGeometry {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  if (!bb) return geo;
  const su = bb.max[ua] - bb.min[ua] || 1;
  const sv = bb.max[va] - bb.min[va] || 1;
  return remapUv(geo, (_u, _v, p) => [
    ((p[ua] - bb.min[ua]) / su) * repeat[0],
    ((p[va] - bb.min[va]) / sv) * repeat[1],
  ]);
}

/**
 * Map the UV of a single box face (0 +x, 1 −x, 2 +y, 3 −y, 4 +z, 5 −z) into a
 * rectangle [u0, v0, u1, v1] of the texture.
 */
export function boxFaceUv(
  box: THREE.BoxGeometry,
  face: number,
  rect: [number, number, number, number],
): THREE.BoxGeometry {
  const p = box.parameters;
  const counts = [
    (p.depthSegments + 1) * (p.heightSegments + 1),
    (p.depthSegments + 1) * (p.heightSegments + 1),
    (p.widthSegments + 1) * (p.depthSegments + 1),
    (p.widthSegments + 1) * (p.depthSegments + 1),
    (p.widthSegments + 1) * (p.heightSegments + 1),
    (p.widthSegments + 1) * (p.heightSegments + 1),
  ];
  let start = 0;
  for (let f = 0; f < face; f++) start += counts[f];
  const uv = box.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = start; i < start + counts[face]; i++) {
    uv.setXY(
      i,
      rect[0] + uv.getX(i) * (rect[2] - rect[0]),
      rect[1] + uv.getY(i) * (rect[3] - rect[1]),
    );
  }
  uv.needsUpdate = true;
  return box;
}

// ---------------------------------------------------------------------------
// Lathes
// ---------------------------------------------------------------------------

/**
 * Lathe from a profile [(r, y), ...] (bottom to top so the normals point
 * outwards). `vByHeight`: v = height 0..1 instead of the point index
 * (for labels: "v = bottom → cap").
 */
export function lathe(
  profile: Array<[number, number]>,
  seg: number,
  opts: { vByHeight?: boolean; vRange?: [number, number] } = {},
): THREE.BufferGeometry {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(r, 0), y));
  const geo = new THREE.LatheGeometry(pts, seg);
  if (opts.vByHeight || opts.vRange) {
    let y0 = Number.POSITIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (const p of pts) {
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
    if (opts.vRange) {
      y0 = opts.vRange[0];
      y1 = opts.vRange[1];
    }
    const span = y1 - y0 || 1;
    remapUv(geo, (u, _v, p) => [
      u,
      Math.max(0, Math.min(1, (p.y - y0) / span)),
    ]);
  }
  return geo;
}

/** Densify a profile with evenly spaced intermediate points (for deformations). */
export function densify(
  profile: Array<[number, number]>,
  step: number,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < profile.length - 1; i++) {
    const [r0, y0] = profile[i];
    const [r1, y1] = profile[i + 1];
    const len = Math.hypot(r1 - r0, y1 - y0);
    const n = Math.max(1, Math.round(len / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push([r0 + (r1 - r0) * t, y0 + (y1 - y0) * t]);
    }
  }
  out.push(profile[profile.length - 1]);
  return out;
}

// ---------------------------------------------------------------------------
// Tubes along curves
// ---------------------------------------------------------------------------

export interface TubeOpts {
  /** Radius as a function of t (0..1) and angle (0..2π). */
  radius: (t: number, ang: number) => number;
  segs: number;
  radial: number;
  /** "around": u around the circumference, v lengthwise; "along": u lengthwise, v around the circumference. */
  uvMode?: "around" | "along";
  /** Tile length in meters along the path (default: curve length → 1 tile). */
  tileLen?: number;
  caps?: boolean;
  closed?: boolean;
}

export function tube(
  curve: THREE.Curve<THREE.Vector3>,
  o: TubeOpts,
): THREE.BufferGeometry {
  const segs = o.segs;
  const radial = o.radial;
  const closed = o.closed === true;
  const frames = curve.computeFrenetFrames(segs, closed);
  const length = curve.getLength();
  const tile = o.tileLen ?? length;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const rows = segs + 1;
  for (let i = 0; i < rows; i++) {
    const t = i / segs;
    curve.getPointAt(t, p);
    const N = frames.normals[i];
    const B = frames.binormals[i];
    for (let j = 0; j <= radial; j++) {
      const ang = (j / radial) * Math.PI * 2;
      const cs = Math.cos(ang);
      const sn = Math.sin(ang);
      n.set(N.x * cs + B.x * sn, N.y * cs + B.y * sn, N.z * cs + B.z * sn);
      const r = o.radius(t, ang);
      positions.push(p.x + n.x * r, p.y + n.y * r, p.z + n.z * r);
      normals.push(n.x, n.y, n.z);
      const along = (t * length) / tile;
      if (o.uvMode === "along") uvs.push(along, j / radial);
      else uvs.push(j / radial, along);
    }
  }
  const stride = radial + 1;
  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * stride + j;
      const b = a + stride;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  if (o.caps && !closed) {
    for (const end of [0, 1]) {
      const row = end === 0 ? 0 : segs;
      curve.getPointAt(end, p);
      const T = frames.tangents[row].clone().multiplyScalar(end === 0 ? -1 : 1);
      const ci = positions.length / 3;
      positions.push(p.x, p.y, p.z);
      normals.push(T.x, T.y, T.z);
      uvs.push(0.5, 0.5);
      for (let j = 0; j <= radial; j++) {
        const src = row * stride + j;
        positions.push(
          positions[src * 3],
          positions[src * 3 + 1],
          positions[src * 3 + 2],
        );
        normals.push(T.x, T.y, T.z);
        const ang = (j / radial) * Math.PI * 2;
        uvs.push(0.5 + Math.cos(ang) * 0.45, 0.5 + Math.sin(ang) * 0.45);
      }
      for (let j = 0; j < radial; j++) {
        const a = ci + 1 + j;
        const b = ci + 1 + j + 1;
        if (end === 0) indices.push(ci, b, a);
        else indices.push(ci, a, b);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

export function catmull(
  pts: Array<[number, number, number]>,
  closed = false,
  tension = 0.5,
): THREE.CatmullRomCurve3 {
  return new THREE.CatmullRomCurve3(
    pts.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
    closed,
    "catmullrom",
    tension,
  );
}

// ---------------------------------------------------------------------------
// Discs / sheets
// ---------------------------------------------------------------------------

/**
 * Flat round disc (top/bottom faces built from rings, plus a rim) in the XZ
 * plane, bottom at y = 0, planar UV (u = x, v = z). The rings allow bending.
 */
export function disc(
  r: number,
  h: number,
  theta: number,
  rings: number,
): THREE.BufferGeometry {
  const top = new THREE.RingGeometry(r * 0.02, r, theta, rings);
  top.rotateX(-Math.PI / 2);
  top.translate(0, h, 0);
  const bottom = new THREE.RingGeometry(r * 0.02, r, theta, rings);
  bottom.rotateX(Math.PI / 2);
  const side = new THREE.CylinderGeometry(r, r, h, theta, 1, true);
  side.translate(0, h / 2, 0);
  const merged = mergeGeometries(
    [top, bottom, side].map((g) => (g.index ? g.toNonIndexed() : g)),
    false,
  );
  const geo = merged ?? top;
  return planarUv(geo, "x", "z");
}

// ---------------------------------------------------------------------------
// Decimation (LOD)
// ---------------------------------------------------------------------------

/**
 * Coarse decimation via vertex clustering: space is divided into `cells` cells
 * along the longest axis, all vertices of a cell collapse onto their
 * centroid, and degenerate and duplicate triangles are dropped.
 * ~1000 triangles become ~40–90 – enough for the silhouette beyond 25 m.
 *
 * The bounding box is stretched back to that of the original afterwards, so
 * size and resting height (restFor) match the full geometry exactly.
 * Result: non-indexed, position/normal/uv, a single group.
 */
export function decimate(
  geo: THREE.BufferGeometry,
  cells: number,
): THREE.BufferGeometry {
  const src = geo.index ? geo.toNonIndexed() : geo;
  const pos = src.getAttribute("position") as THREE.BufferAttribute;
  const uvA = src.getAttribute("uv") as THREE.BufferAttribute | undefined;
  const p = pos.array as ArrayLike<number>;
  const n = pos.count;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let z0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  let z1 = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const j = i * 3;
    if (p[j] < x0) x0 = p[j];
    if (p[j] > x1) x1 = p[j];
    if (p[j + 1] < y0) y0 = p[j + 1];
    if (p[j + 1] > y1) y1 = p[j + 1];
    if (p[j + 2] < z0) z0 = p[j + 2];
    if (p[j + 2] > z1) z1 = p[j + 2];
  }
  const sx = x1 - x0;
  const sy = y1 - y0;
  const sz = z1 - z0;
  // Subdivision per axis: the longest gets `cells` cells, thin axes
  // proportionally fewer but at least two – otherwise a branch/plank collapses
  // into a line across its short direction and vanishes entirely.
  const maxS = Math.max(sx, sy, sz, 1e-6);
  const lo = cells >= 4 ? 3 : 2;
  const div = (s: number): number =>
    s < 1e-5
      ? 1
      : Math.max(lo, Math.min(cells, Math.round(cells * (s / maxS) ** 0.35)));
  const nx = div(sx);
  const ny = div(sy);
  const nz = div(sz);
  const cx0 = sx / nx || 1;
  const cy0 = sy / ny || 1;
  const cz0 = sz / nz || 1;
  const cell = new Int32Array(n);
  const ids = new Map<number, number>();
  const acc: number[] = []; // per cluster: x, y, z, u, v, count
  const q = (v: number, lo: number, cs: number, m: number) =>
    Math.max(0, Math.min(m - 1, Math.floor((v - lo) / cs)));
  for (let i = 0; i < n; i++) {
    const j = i * 3;
    const key =
      (q(p[j], x0, cx0, nx) * ny + q(p[j + 1], y0, cy0, ny)) * nz +
      q(p[j + 2], z0, cz0, nz);
    let c = ids.get(key);
    if (c === undefined) {
      c = acc.length / 6;
      ids.set(key, c);
      acc.push(0, 0, 0, 0, 0, 0);
    }
    cell[i] = c;
    const o = c * 6;
    acc[o] += p[j];
    acc[o + 1] += p[j + 1];
    acc[o + 2] += p[j + 2];
    if (uvA) {
      acc[o + 3] += uvA.getX(i);
      acc[o + 4] += uvA.getY(i);
    }
    acc[o + 5]++;
  }
  const cc = acc.length / 6;
  const cp = new Float32Array(cc * 3);
  const cu = new Float32Array(cc * 2);
  let bx0 = Number.POSITIVE_INFINITY;
  let by0 = Number.POSITIVE_INFINITY;
  let bz0 = Number.POSITIVE_INFINITY;
  let bx1 = Number.NEGATIVE_INFINITY;
  let by1 = Number.NEGATIVE_INFINITY;
  let bz1 = Number.NEGATIVE_INFINITY;
  for (let c = 0; c < cc; c++) {
    const o = c * 6;
    const k = 1 / acc[o + 5];
    const vx = acc[o] * k;
    const vy = acc[o + 1] * k;
    const vz = acc[o + 2] * k;
    cp[c * 3] = vx;
    cp[c * 3 + 1] = vy;
    cp[c * 3 + 2] = vz;
    cu[c * 2] = acc[o + 3] * k;
    cu[c * 2 + 1] = acc[o + 4] * k;
    if (vx < bx0) bx0 = vx;
    if (vx > bx1) bx1 = vx;
    if (vy < by0) by0 = vy;
    if (vy > by1) by1 = vy;
    if (vz < bz0) bz0 = vz;
    if (vz > bz1) bz1 = vz;
  }
  // Centroids shrink the hull – stretch it back to the original size
  const fit = (
    v: number,
    lo: number,
    hi: number,
    lo0: number,
    size: number,
  ): number =>
    hi - lo < 1e-9 ? lo0 + size * 0.5 : lo0 + ((v - lo) / (hi - lo)) * size;
  for (let c = 0; c < cc; c++) {
    cp[c * 3] = fit(cp[c * 3], bx0, bx1, x0, sx);
    cp[c * 3 + 1] = fit(cp[c * 3 + 1], by0, by1, y0, sy);
    cp[c * 3 + 2] = fit(cp[c * 3 + 2], bz0, bz1, z0, sz);
  }
  const outP: number[] = [];
  const outU: number[] = [];
  const seen = new Set<number>();
  const tri = n / 3;
  for (let t = 0; t < tri; t++) {
    const a0 = cell[t * 3];
    const a1 = cell[t * 3 + 1];
    const a2 = cell[t * 3 + 2];
    if (a0 === a1 || a1 === a2 || a0 === a2) continue;
    const s0 = Math.min(a0, a1, a2);
    const s2 = Math.max(a0, a1, a2);
    const s1 = a0 + a1 + a2 - s0 - s2;
    const key = (s0 * 1024 + s1) * 1024 + s2;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const c of [a0, a1, a2]) {
      outP.push(cp[c * 3], cp[c * 3 + 1], cp[c * 3 + 2]);
      outU.push(cu[c * 2], cu[c * 2 + 1]);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(outP, 3));
  out.setAttribute("uv", new THREE.Float32BufferAttribute(outU, 2));
  weldNormals(out);
  return out;
}

// ---------------------------------------------------------------------------
// Merging by material
// ---------------------------------------------------------------------------

export interface Part {
  geo: THREE.BufferGeometry;
  /** Index into the type's material list. */
  mat: number;
}

/**
 * Merge the parts per material and return a single geometry with groups
 * (materialIndex = material index). All parts are made non-indexed.
 */
export function assemble(
  parts: Part[],
  matCount: number,
): THREE.BufferGeometry {
  const byMat: THREE.BufferGeometry[][] = [];
  for (let m = 0; m < matCount; m++) byMat.push([]);
  for (const p of parts) {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
    if (!g.getAttribute("uv")) {
      const n = g.getAttribute("position").count;
      g.setAttribute(
        "uv",
        new THREE.BufferAttribute(new Float32Array(n * 2), 2),
      );
    }
    if (!g.getAttribute("normal")) g.computeVertexNormals();
    byMat[Math.min(p.mat, matCount - 1)].push(g);
  }
  const perMat: THREE.BufferGeometry[] = [];
  const matIdx: number[] = [];
  for (let m = 0; m < matCount; m++) {
    if (byMat[m].length === 0) continue;
    const merged =
      byMat[m].length === 1 ? byMat[m][0] : mergeGeometries(byMat[m], false);
    if (merged) {
      perMat.push(merged);
      matIdx.push(m);
    }
  }
  const out =
    perMat.length === 1
      ? perMat[0]
      : (mergeGeometries(perMat, true) ?? perMat[0]);
  // Rewrite the groups to the real material indices
  if (perMat.length === 1) {
    out.clearGroups();
    out.addGroup(0, out.getAttribute("position").count, matIdx[0]);
  } else {
    for (let g = 0; g < out.groups.length; g++)
      out.groups[g].materialIndex = matIdx[g];
  }
  return out;
}
