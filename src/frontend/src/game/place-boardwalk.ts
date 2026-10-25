// The Wardens' Boardwalk – a derelict one-plank boardwalk from the beach up
// through the foredunes towards the abandoned camp (route: landforms.ts
// BOARDWALK), and past it the bare desire path that continues north
// (DESIRE_PATH).
//
// Construction: transverse deck boards (0.6 × 0.14 m, bleached, some missing
// or sprung) nailed to two longitudinal bearers that rest on half-buried
// sleepers every 1.2 m. The seaward 40 m carry a leaning handrail with
// snapped posts and a rail broken in two places. Long stretches drown under
// wind-blown sand: the drift is one analytic height function shared by the
// drift meshes AND the ground override, so the feet stand on the same surface
// the eye sees. Two flights of sunken timber steps (riser boards on stakes,
// sand-choked treads) climb the steep dune shoulders; the walk ends in a
// sanded-over stub ≥ 18 m short of the camp. A faded aluminium sign leans at
// the beach end, a small arrow sign points inland further up.
//
// Draw calls: timber, sand, signs, path = 4. Colliders (tag "boardwalk") on
// the handrail and sign posts only; the deck itself is a registered ground
// surface (ground.ts, tag "boardwalk").

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  addCylinderCollider,
  beginColliderSet,
  clearColliderSet,
} from "./colliders";
import { registerGround, unregisterGround } from "./ground";
import { BOARDWALK, DESIRE_PATH } from "./landforms";
import { campSite } from "./landmark-camp";
import { fbm, smoothstep } from "./noise";
import {
  SIGN_UV,
  TIMBER_TILE_M,
  WOOD_ROW,
  WOOD_ROWS,
  pbrBoardwalkSign,
  pbrBoardwalkWood,
  pbrDesirePath,
} from "./place-boardwalk-textures";
import type { Environment } from "./sky";
import { terrainHeight } from "./terrain";
import { TexRng, applyPbr, sandAlbedo, sandNormal } from "./textures";
import type { QualityId } from "./types";

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

/** Centre-line sample spacing (m). */
const STEP = 0.5;
/** Extra samples past the route end (the stub drift runs on a little). */
const EXTEND = 6;
const HALF_W = 0.3;
const SLEEPER_PITCH = 1.2;
/** Sleeper top above the sand (the rest is buried). */
const SLEEPER_TOP = 0.02;
const SLEEPER_H = 0.12;
const SLEEPER_LEN = 0.8;
const BEARER_H = 0.045;
const BEARER_W = 0.05;
const BEARER_D = 0.19;
const BOARD_T = 0.025;
const BOARD_W = 0.14;
const BOARD_PITCH = 0.17;
/** Deck top above the sand at a sleeper. */
const DECK_LIFT = SLEEPER_TOP + BEARER_H + BOARD_T;
/** The handrail runs on the seaward stretch s < RAIL_END. */
const RAIL_END = 40;
const RAIL_PITCH = 1.5;
const RAIL_D = 0.42;
const POST_LEN = 1.45;
const POST_BURY = 0.55;
/** Rail centre along the post from its buried foot. */
const RAIL_UP = 1.37;
const RISER_H = 0.24;
const RISER_LEN = 0.7;
const RISER_T = 0.05;
/** Riser top above the sand it was set into. */
const RISER_STAND = 0.14;
/** Sand texture tiling of the terrain mesh (world.ts) – the drifts match it. */
const SAND_TILE_X = 820 / 70;
const SAND_TILE_Z = 560 / 48;
/** Sand sheets dip this far under the terrain where their lift runs out. */
const RIM_SINK = 0.05;
/** Sand spills this far off the first tread over the foot of a flight. */
const FOOT_SPILL = 0.9;
/** The planked walk keeps this far from the camp clearing. */
const CAMP_CLEAR = 18;
/** Desire-path texture: metres per u tile. */
const PATH_TILE = 3;
const PATH_STEP = 0.75;

/** Step flights [s0, s1, tread depth]; s0/s1 lie on the sleeper grid. */
const FLIGHT_SPANS: ReadonlyArray<readonly [number, number, number]> = [
  [66, 84, 0.58],
  [128.4, 146.4, 0.38],
];
/**
 * Drowned sections [s0, s1, amplitude, half width]; the stub drift is added.
 * Each span ramps up over its first 45 % (≈ 7 m), so the deck goes under
 * sleeper by sleeper, and stays over the deck for the middle 8–12 m.
 */
const DRIFT_SPANS: ReadonlyArray<readonly [number, number, number, number]> = [
  [-5, 5, 0.12, 1.5],
  [10, 27, 0.3, 2.1],
  [41, 58, 0.28, 2.0],
  [103, 121, 0.32, 2.3],
];

// ---------------------------------------------------------------------------
// Centre line
// ---------------------------------------------------------------------------

interface Line {
  n: number;
  step: number;
  x: Float32Array;
  z: Float32Array;
  s: Float32Array;
  tx: Float32Array;
  tz: Float32Array;
  /** Terrain height on the centre line. */
  ty: Float32Array;
  /** Arc length of the real route (samples beyond it extrapolate). */
  total: number;
}

interface Frame {
  x: number;
  z: number;
  tx: number;
  tz: number;
}

/**
 * Densify a polyline, round its corners with two box passes (a triangular
 * kernel `smooth` metres wide – the ends stay pinned, straight runs are
 * unchanged, corners cut by well under a metre), then resample by arc length.
 */
function buildLine(
  pts: ReadonlyArray<readonly [number, number]>,
  step: number,
  smooth: number,
  extend: number,
): Line {
  const fine = 0.25;
  const px: number[] = [];
  const pz: number[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(len / fine));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      px.push(ax + (bx - ax) * t);
      pz.push(az + (bz - az) * t);
    }
  }
  const last = pts[pts.length - 1];
  px.push(last[0]);
  pz.push(last[1]);
  const half = Math.max(1, Math.round(smooth / 2 / fine));
  const m = px.length;
  for (let pass = 0; pass < 2; pass++) {
    const sx = px.slice();
    const sz = pz.slice();
    for (let i = 0; i < m; i++) {
      let ax = 0;
      let az = 0;
      for (let k = -half; k <= half; k++) {
        const j = Math.min(m - 1, Math.max(0, i + k));
        ax += sx[j];
        az += sz[j];
      }
      px[i] = ax / (2 * half + 1);
      pz[i] = az / (2 * half + 1);
    }
    px[0] = pts[0][0];
    pz[0] = pts[0][1];
    px[m - 1] = last[0];
    pz[m - 1] = last[1];
  }
  const cum = new Float64Array(m);
  for (let i = 1; i < m; i++) {
    cum[i] = cum[i - 1] + Math.hypot(px[i] - px[i - 1], pz[i] - pz[i - 1]);
  }
  const total = cum[m - 1];
  const n = Math.floor((total + extend) / step) + 1;
  const x = new Float32Array(n);
  const z = new Float32Array(n);
  const s = new Float32Array(n);
  const tx = new Float32Array(n);
  const tz = new Float32Array(n);
  const ty = new Float32Array(n);
  let ex = px[m - 1] - px[m - 2];
  let ez = pz[m - 1] - pz[m - 2];
  const el = Math.hypot(ex, ez) || 1;
  ex /= el;
  ez /= el;
  let j = 0;
  for (let i = 0; i < n; i++) {
    const si = i * step;
    s[i] = si;
    if (si >= total) {
      x[i] = px[m - 1] + ex * (si - total);
      z[i] = pz[m - 1] + ez * (si - total);
      continue;
    }
    while (j + 1 < m - 1 && cum[j + 1] < si) j++;
    const t = (si - cum[j]) / Math.max(1e-6, cum[j + 1] - cum[j]);
    x[i] = px[j] + (px[j + 1] - px[j]) * t;
    z[i] = pz[j] + (pz[j + 1] - pz[j]) * t;
  }
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    const dx = x[b] - x[a];
    const dz = z[b] - z[a];
    const l = Math.hypot(dx, dz) || 1;
    tx[i] = dx / l;
    tz[i] = dz / l;
    ty[i] = terrainHeight(x[i], z[i]);
  }
  return { n, step, x, z, s, tx, tz, ty, total };
}

/** Frame (position + unit tangent) at arc length s; allocation-free. */
function frameAt(line: Line, s: number, out: Frame): Frame {
  const f = s / line.step;
  let i = Math.floor(f);
  if (i < 0) i = 0;
  if (i > line.n - 2) i = line.n - 2;
  const t = Math.min(1, Math.max(0, f - i));
  out.x = line.x[i] + (line.x[i + 1] - line.x[i]) * t;
  out.z = line.z[i] + (line.z[i + 1] - line.z[i]) * t;
  const tx = line.tx[i] + (line.tx[i + 1] - line.tx[i]) * t;
  const tz = line.tz[i] + (line.tz[i + 1] - line.tz[i]) * t;
  const l = Math.hypot(tx, tz) || 1;
  out.tx = tx / l;
  out.tz = tz / l;
  return out;
}

/** Terrain height on the centre line at s (interpolated samples). */
function lineTerrain(line: Line, s: number): number {
  const f = s / line.step;
  let i = Math.floor(f);
  if (i < 0) i = 0;
  if (i > line.n - 2) i = line.n - 2;
  const t = Math.min(1, Math.max(0, f - i));
  return line.ty[i] + (line.ty[i + 1] - line.ty[i]) * t;
}

interface Hit {
  s: number;
  /** Signed lateral offset along L = (-tz, tx). */
  d: number;
}

/** Nearest point of the line to (x, z) among samples i0..i1; returns the distance. */
function projectLine(
  line: Line,
  x: number,
  z: number,
  i0: number,
  i1: number,
  out: Hit,
): number {
  let best = Number.POSITIVE_INFINITY;
  let bs = 0;
  let bd = 0;
  for (let i = i0; i < i1; i++) {
    const ax = line.x[i];
    const az = line.z[i];
    const bx = line.x[i + 1] - ax;
    const bz = line.z[i + 1] - az;
    const l2 = bx * bx + bz * bz;
    if (l2 < 1e-9) continue;
    let t = ((x - ax) * bx + (z - az) * bz) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = x - (ax + bx * t);
    const dz = z - (az + bz * t);
    const d2 = dx * dx + dz * dz;
    if (d2 < best) {
      best = d2;
      const l = Math.sqrt(l2);
      bs = line.s[i] + t * l;
      bd = (-bz * dx + bx * dz) / l;
    }
  }
  out.s = bs;
  out.d = bd;
  return Math.sqrt(best);
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

type BagKey = "wood" | "sand" | "sign";

/** Collects non-indexed geometries per material and merges them. */
class Bag {
  private readonly lists = new Map<BagKey, THREE.BufferGeometry[]>();

  add(key: BagKey, g: THREE.BufferGeometry): void {
    let geo = g;
    if (g.index) {
      geo = g.toNonIndexed();
      g.dispose();
    }
    if (key === "wood") {
      if (!geo.getAttribute("color")) tint(geo, 1, 1, 1);
    } else if (geo.getAttribute("color")) {
      geo.deleteAttribute("color");
    }
    let list = this.lists.get(key);
    if (!list) {
      list = [];
      this.lists.set(key, list);
    }
    list.push(geo);
  }

  build(mats: Record<BagKey, THREE.Material>): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [key, list] of this.lists) {
      if (list.length === 0) continue;
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged)
        throw new Error(`Boardwalk: mergeGeometries (${key}) failed`);
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mats[key]);
      mesh.name = `boardwalk-${key}`;
      mesh.castShadow = key !== "sand";
      mesh.receiveShadow = true;
      out.push(mesh);
    }
    this.lists.clear();
    return out;
  }
}

/** Flat vertex colour. */
function tint(
  geo: THREE.BufferGeometry,
  r: number,
  g: number,
  b: number,
): void {
  const n = geo.getAttribute("position").count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = r;
    arr[i * 3 + 1] = g;
    arr[i * 3 + 2] = b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
}

/** Accumulates quads into a non-indexed geometry (position, normal, uv). */
class Quads {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly uv: number[] = [];

  /**
   * Quad centred at c with half-edges a (u direction) and b (v direction);
   * the front face looks along a × b.
   */
  face(
    cx: number,
    cy: number,
    cz: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    uA: number,
    uB: number,
    vA: number,
    vB: number,
  ): void {
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    const p = [
      [cx - ax - bx, cy - ay - by, cz - az - bz, uA, vA],
      [cx + ax - bx, cy + ay - by, cz + az - bz, uB, vA],
      [cx + ax + bx, cy + ay + by, cz + az + bz, uB, vB],
      [cx - ax + bx, cy - ay + by, cz - az + bz, uA, vB],
    ];
    for (const k of [0, 1, 2, 0, 2, 3]) {
      const q = p[k];
      this.pos.push(q[0], q[1], q[2]);
      this.nor.push(nx / nl, ny / nl, nz / nl);
      this.uv.push(q[3], q[4]);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(this.pos), 3),
    );
    g.setAttribute(
      "normal",
      new THREE.BufferAttribute(new Float32Array(this.nor), 3),
    );
    g.setAttribute(
      "uv",
      new THREE.BufferAttribute(new Float32Array(this.uv), 2),
    );
    return g;
  }
}

/**
 * Timber slab: length along local x, thickness h along y, width w along z.
 * UVs sit in one atlas row: u along the length (`uPerM` per metre from
 * `u0`), v across the width.
 */
function slab(
  len: number,
  h: number,
  w: number,
  row: number,
  uPerM: number,
  u0: number,
): THREE.BufferGeometry {
  const hx = len / 2;
  const hy = h / 2;
  const hz = w / 2;
  const band = 1 / WOOD_ROWS;
  const m = band * 0.05;
  const v0 = row * band + m;
  const v1 = (row + 1) * band - m;
  const uA = u0;
  const uB = u0 + len * uPerM;
  const sideV1 = v0 + Math.min(0.9, h / w) * (v1 - v0);
  const endU1 = u0 + Math.min(len, w) * uPerM;
  const q = new Quads();
  q.face(0, hy, 0, hx, 0, 0, 0, 0, -hz, uA, uB, v0, v1);
  q.face(0, -hy, 0, hx, 0, 0, 0, 0, hz, uA, uB, v0, v1);
  q.face(0, 0, hz, hx, 0, 0, 0, hy, 0, uA, uB, v0, sideV1);
  q.face(0, 0, -hz, hx, 0, 0, 0, -hy, 0, uA, uB, sideV1, v0);
  q.face(hx, 0, 0, 0, 0, -hz, 0, hy, 0, uA, endU1, v0, sideV1);
  q.face(-hx, 0, 0, 0, 0, hz, 0, hy, 0, uA, endU1, v0, sideV1);
  return q.build();
}

/** Round stake along local x with the timber row's UVs (u along the length). */
function stake(
  len: number,
  r0: number,
  r1: number,
  seg: number,
  row: number,
  u0: number,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, false);
  const band = 1 / WOOD_ROWS;
  const v0 = row * band + band * 0.08;
  const v1 = (row + 1) * band - band * 0.08;
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const around = uv.getX(i);
    const along = uv.getY(i);
    uv.setXY(i, u0 + (along * len) / TIMBER_TILE_M, v0 + (v1 - v0) * around);
  }
  g.rotateZ(-Math.PI / 2);
  return g;
}

/** Thin sign plate; front (+z) and back carry atlas rectangles. */
function plate(
  w: number,
  h: number,
  t: number,
  front: readonly [number, number, number, number],
  back: readonly [number, number, number, number],
): THREE.BufferGeometry {
  const hx = w / 2;
  const hy = h / 2;
  const hz = t / 2;
  const q = new Quads();
  q.face(0, 0, hz, hx, 0, 0, 0, hy, 0, front[0], front[2], front[1], front[3]);
  q.face(0, 0, -hz, hx, 0, 0, 0, -hy, 0, back[0], back[2], back[3], back[1]);
  const eu = back[0] + (back[2] - back[0]) * 0.1;
  const ev = back[1] + (back[3] - back[1]) * 0.1;
  q.face(hx, 0, 0, 0, 0, -hz, 0, hy, 0, back[0], eu, back[1], ev);
  q.face(-hx, 0, 0, 0, 0, hz, 0, hy, 0, back[0], eu, back[1], ev);
  q.face(0, hy, 0, hx, 0, 0, 0, 0, -hz, back[0], eu, back[1], ev);
  q.face(0, -hy, 0, hx, 0, 0, 0, 0, hz, back[0], eu, back[1], ev);
  return q.build();
}

const UP = new THREE.Vector3(0, 1, 0);
const VX = new THREE.Vector3();
const VY = new THREE.Vector3();
const VZ = new THREE.Vector3();
const M4 = new THREE.Matrix4();
const F: Frame = { x: 0, z: 0, tx: 0, tz: 0 };

/**
 * Right-handed frame with local x along `xAxis` and local z as close to
 * `zHint` as possible, placed at p. Returns the shared matrix.
 */
function basis(
  p: THREE.Vector3,
  xAxis: THREE.Vector3,
  zHint: THREE.Vector3,
): THREE.Matrix4 {
  VX.copy(xAxis).normalize();
  VZ.copy(zHint).addScaledVector(VX, -VX.dot(zHint));
  if (VZ.lengthSq() < 1e-8) VZ.set(VX.y, -VX.x, 0);
  VZ.normalize();
  VY.crossVectors(VZ, VX);
  return M4.makeBasis(VX, VY, VZ).setPosition(p);
}

// ---------------------------------------------------------------------------
// The place
// ---------------------------------------------------------------------------

interface Flight {
  s0: number;
  s1: number;
  tread: number;
  /** Riser tops (world y); riser k stands at s0 + k · tread. */
  tops: number[];
}

interface Drift {
  s0: number;
  s1: number;
  amp: number;
  hw: number;
}

interface Post {
  s: number;
  foot: THREE.Vector3;
  dir: THREE.Vector3;
  len: number;
  snapped: boolean;
  /** Where the rail is nailed (or would be, on a snapped post). */
  attach: THREE.Vector3;
}

export class WardensBoardwalk {
  protected readonly parent: THREE.Group;
  protected readonly quality: QualityId;

  private readonly group = new THREE.Group();
  private readonly meshes: THREE.Mesh[] = [];
  private readonly mats: Record<BagKey, THREE.Material>;
  private readonly sandMat: THREE.MeshStandardMaterial;
  private readonly pathMat: THREE.MeshStandardMaterial;
  private readonly det: number;
  private readonly rng = new TexRng(0xb0a2d);
  private readonly line: Line;
  private readonly pathLine: Line;
  private readonly sleeperY: Float32Array;
  private readonly flights: Flight[] = [];
  private readonly drifts: Drift[] = [];
  private readonly walkEnd: number;
  /** Bounds of the walk for the ground override's early out. */
  private readonly bounds = { x0: 0, x1: 0, z0: 0, z1: 0 };
  /** Cumulative arc length of the BOARDWALK polyline (coarse s estimate). */
  private readonly polyS: number[] = [];
  private readonly hit: Hit = { s: 0, d: 0 };
  /** Smoothed rain wetness of the sand, same rates as the terrain. */
  private wet = 0;
  private wetInit = false;
  /** env.cloud for the terrain-matching desaturation of the sand. */
  private readonly uCloud: THREE.IUniform<number> = { value: 0 };

  constructor(parent: THREE.Group, quality: QualityId) {
    this.parent = parent;
    this.quality = quality;
    this.det =
      quality === "ultra"
        ? 1
        : quality === "high"
          ? 0.9
          : quality === "medium"
            ? 0.65
            : 0.45;
    this.group.name = "wardens-boardwalk";
    parent.add(this.group);

    this.line = buildLine(BOARDWALK, STEP, 5, EXTEND);
    let acc = 0;
    this.polyS.push(0);
    for (let i = 0; i + 1 < BOARDWALK.length; i++) {
      acc += Math.hypot(
        BOARDWALK[i + 1][0] - BOARDWALK[i][0],
        BOARDWALK[i + 1][1] - BOARDWALK[i][1],
      );
      this.polyS.push(acc);
    }
    let x0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let z0 = Number.POSITIVE_INFINITY;
    let z1 = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < this.line.n; i++) {
      x0 = Math.min(x0, this.line.x[i]);
      x1 = Math.max(x1, this.line.x[i]);
      z0 = Math.min(z0, this.line.z[i]);
      z1 = Math.max(z1, this.line.z[i]);
    }
    this.bounds.x0 = x0 - 3;
    this.bounds.x1 = x1 + 3;
    this.bounds.z0 = z0 - 3;
    this.bounds.z1 = z1 + 3;

    // The planked walk ends on the sleeper grid, ≥ CAMP_CLEAR from the camp
    const camp = campSite();
    let end = FLIGHT_SPANS[1][1];
    while (end > FLIGHT_SPANS[1][0] + 6) {
      frameAt(this.line, end, F);
      if (Math.hypot(F.x - camp.x, F.z - camp.z) >= CAMP_CLEAR) break;
      end -= SLEEPER_PITCH;
    }
    this.walkEnd = end;

    // Sleeper tops along the whole walk
    const nS = Math.round(this.walkEnd / SLEEPER_PITCH) + 1;
    this.sleeperY = new Float32Array(nS);
    for (let k = 0; k < nS; k++) {
      this.sleeperY[k] =
        lineTerrain(this.line, k * SLEEPER_PITCH) + SLEEPER_TOP;
    }
    for (const [d0, d1, amp, hw] of DRIFT_SPANS) {
      this.drifts.push({ s0: d0, s1: d1, amp, hw });
    }
    this.drifts.push({
      s0: this.walkEnd - 8.4,
      s1: this.walkEnd + 5,
      amp: 0.34,
      hw: 2.4,
    });
    for (const [s0, s1raw, tread] of FLIGHT_SPANS) {
      const s1 = Math.min(s1raw, this.walkEnd);
      const n = Math.max(2, Math.round((s1 - s0) / tread));
      const t = (s1 - s0) / n;
      const tops: number[] = [];
      for (let k = 0; k <= n; k++) {
        const s = s0 + k * t;
        let y = lineTerrain(this.line, s) + RISER_STAND;
        if (k === 0) y = Math.max(y, this.deckAt(s0) + 0.1);
        if (k === n && s1 < this.walkEnd - 0.1) y = this.deckAt(s1);
        if (k > 0) y = Math.max(y, tops[k - 1] + 0.08);
        tops.push(y);
      }
      this.flights.push({ s0, s1, tread: t, tops });
    }

    // Desire path: from the sanded-over stub past the camp and north
    frameAt(this.line, this.walkEnd + 0.6, F);
    const pathPts: Array<readonly [number, number]> = [[F.x, F.z]];
    const lastBw = BOARDWALK[BOARDWALK.length - 1];
    if (Math.hypot(lastBw[0] - F.x, lastBw[1] - F.z) > 1.5)
      pathPts.push(lastBw);
    for (let i = 1; i < DESIRE_PATH.length; i++) pathPts.push(DESIRE_PATH[i]);
    this.pathLine = buildLine(pathPts, PATH_STEP, 6, 0);

    // Materials – full-size texture sheets on ultra/high, halved below
    const hi = this.det >= 0.9;
    const wood = new THREE.MeshStandardMaterial({ vertexColors: true });
    applyPbr(wood, pbrBoardwalkWood(hi));
    // Same maps and parameters as the terrain material (world.ts), so the
    // drifts and the sand around them are one surface
    const sand = new THREE.MeshStandardMaterial({
      map: sandAlbedo(),
      normalMap: sandNormal(),
      normalScale: new THREE.Vector2(0.7, 0.7),
      roughness: 0.95,
      metalness: 0,
    });
    this.patchCloud(sand);
    const sign = new THREE.MeshStandardMaterial();
    applyPbr(sign, pbrBoardwalkSign(hi));
    const path = new THREE.MeshStandardMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    applyPbr(path, pbrDesirePath(hi));
    this.patchCloud(path);
    this.sandMat = sand;
    this.pathMat = path;
    this.mats = { wood, sand, sign };

    this.build();
    registerGround("boardwalk", (x, z) => this.groundAt(x, z));
  }

  update(dt: number, env: Environment, _camPos: THREE.Vector3): void {
    // Follow the terrain's rain wetness (world.ts): the sand soaks within
    // seconds and dries over minutes, and darkens to ≈ 0.74 at full rain
    // (mix(1, 0.6, uWet · 0.85 · puddle noise) averaged over the noise).
    if (this.wetInit) {
      const rate = env.rain > this.wet ? 0.5 : 0.02;
      this.wet += (env.rain - this.wet) * Math.min(1, dt * rate);
    } else {
      this.wet = env.rain;
      this.wetInit = true;
    }
    const k = 1 - 0.26 * this.wet;
    this.sandMat.color.setScalar(k);
    this.pathMat.color.setScalar(k);
    this.uCloud.value = env.cloud;
    // Wet sand is smoother (the terrain mixes its roughness towards 0.3)
    this.sandMat.roughness = 0.95 - 0.42 * this.wet;
  }

  dispose(): void {
    unregisterGround("boardwalk");
    clearColliderSet("boardwalk");
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      this.group.remove(mesh);
    }
    this.meshes.length = 0;
    for (const m of Object.values(this.mats)) m.dispose();
    this.pathMat.dispose();
    this.parent.remove(this.group);
    // Textures stay in the shared cache (same convention as the landmarks).
  }

  /**
   * Under a closed cloud deck the terrain desaturates and cools its sand
   * (world.ts); the drifts and the path use the identical snippet so they
   * never read sunnier than the beach around them.
   */
  private patchCloud(mat: THREE.MeshStandardMaterial): void {
    const uCloud = this.uCloud;
    mat.customProgramCacheKey = () => "boardwalk-cloud";
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uCloud = uCloud;
      shader.fragmentShader =
        `uniform float uCloud;\n${shader.fragmentShader}`.replace(
          "#include <color_fragment>",
          `#include <color_fragment>
           { float grey = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
             diffuseColor.rgb = mix(diffuseColor.rgb,
               vec3(grey) * vec3(0.97, 0.99, 1.05), uCloud * 0.42); }`,
        );
    };
  }

  // -------------------------------------------------------------------------
  // Surfaces
  // -------------------------------------------------------------------------

  private seg(n: number, min = 3): number {
    return Math.max(min, Math.round(n * this.det));
  }

  /** Deck top on the centre line at s (boards over bearers over sleepers). */
  private deckAt(s: number): number {
    const K = this.sleeperY.length - 1;
    const f = s / SLEEPER_PITCH;
    let i = Math.floor(f);
    if (i < 0) i = 0;
    if (i > K - 1) i = K - 1;
    const t = Math.min(1, Math.max(0, f - i));
    return (
      this.sleeperY[i] +
      (this.sleeperY[i + 1] - this.sleeperY[i]) * t +
      BEARER_H +
      BOARD_T
    );
  }

  private flightAt(s: number): Flight | null {
    for (const f of this.flights) if (s >= f.s0 && s <= f.s1) return f;
    return null;
  }

  /** Sand level of a sand-choked tread at s (flat-ish, banked up at the next riser). */
  private treadAt(f: Flight, s: number): number {
    const u = (s - f.s0) / f.tread;
    let k = Math.floor(u);
    const last = f.tops.length - 2;
    if (k < 0) k = 0;
    if (k > last) k = last;
    const t = Math.min(1, Math.max(0, u - k));
    const a = f.tops[k] - 0.03;
    const b = f.tops[k + 1] - 0.11;
    return a + (b - a) * t;
  }

  /**
   * Sand above the terrain at (s, lateral d): the drowned-section drifts and
   * the tread fill of the step flights. One function for the meshes and the
   * ground override.
   */
  private liftAt(s: number, d: number): number {
    let h = 0;
    const ad = Math.abs(d);
    for (const dr of this.drifts) {
      if (s <= dr.s0 || s >= dr.s1 || ad >= dr.hw) continue;
      // Long windward ramp, a plateau, a shorter lee tail: the sleepers go
      // under one after another instead of all at once
      const t = (s - dr.s0) / (dr.s1 - dr.s0);
      const bell = smoothstep(0, 0.45, t) * (1 - smoothstep(0.62, 1, t));
      // Feathered edge: the half width wanders along the drift, per side
      const hw =
        dr.hw *
        (0.72 + 0.5 * fbm(s * 0.33 + dr.s0 * 0.7, d > 0 ? 4.5 : 9.5, 2));
      if (ad >= hw) continue;
      const lat = (1 - (ad / hw) ** 2) ** 1.4;
      const noise = 0.85 + 0.3 * fbm(s * 0.6 + dr.s0, d * 0.8 + 3, 2);
      const v = dr.amp * bell * lat * noise;
      if (v > h) h = v;
    }
    if (ad < 0.92) {
      const lat = 1 - smoothstep(0.4, 0.92, ad);
      const f = this.flightAt(s);
      if (f) {
        const lift = this.treadAt(f, s) - lineTerrain(this.line, s);
        const v = lift * lat;
        if (v > h) h = v;
      } else {
        // Sand spilled off the first tread over the foot of the flight
        for (const g of this.flights) {
          if (s < g.s0 - FOOT_SPILL || s >= g.s0) continue;
          const lift = this.treadAt(g, g.s0) - lineTerrain(this.line, s);
          const v = lift * lat * smoothstep(g.s0 - FOOT_SPILL, g.s0, s);
          if (v > h) h = v;
        }
      }
    }
    return h;
  }

  /** Ground override: deck top or sand surface, null off the walk. */
  private groundAt(x: number, z: number): number | null {
    const b = this.bounds;
    if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) return null;
    // Coarse arc length from the source polyline, then a local refinement
    let best = Number.POSITIVE_INFINITY;
    let sEst = 0;
    for (let i = 0; i + 1 < BOARDWALK.length; i++) {
      const ax = BOARDWALK[i][0];
      const az = BOARDWALK[i][1];
      const bx = BOARDWALK[i + 1][0] - ax;
      const bz = BOARDWALK[i + 1][1] - az;
      const l2 = bx * bx + bz * bz;
      let t = ((x - ax) * bx + (z - az) * bz) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - (ax + bx * t);
      const dz = z - (az + bz * t);
      const d2 = dx * dx + dz * dz;
      if (d2 < best) {
        best = d2;
        sEst = this.polyS[i] + t * Math.sqrt(l2);
      }
    }
    if (best > 16) return null;
    const line = this.line;
    const i0 = Math.max(0, Math.floor((sEst - 10) / line.step));
    const i1 = Math.min(line.n - 1, Math.ceil((sEst + 10) / line.step));
    const dist = projectLine(line, x, z, i0, i1, this.hit);
    if (dist > 2.6) return null;
    const s = this.hit.s;
    const d = this.hit.d;
    let y: number | null = null;
    if (
      s >= 0 &&
      s <= this.walkEnd &&
      Math.abs(d) <= HALF_W + 0.06 &&
      !this.flightAt(s)
    ) {
      y = this.deckAt(s);
    }
    const h = this.liftAt(s, d);
    if (h > 0.004) {
      const sy = terrainHeight(x, z) + h;
      if (y === null || sy > y) y = sy;
    }
    return y;
  }

  // -------------------------------------------------------------------------
  // Build
  // -------------------------------------------------------------------------

  private build(): void {
    const bag = new Bag();
    beginColliderSet("boardwalk");
    this.buildDeck(bag);
    this.buildFlights(bag);
    this.buildHandrail(bag);
    this.buildSigns(bag);
    this.buildEndStub(bag);
    this.buildSand(bag);
    this.buildRemnants(bag);
    for (const mesh of bag.build(this.mats)) {
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
    const path = this.buildPath();
    this.meshes.push(path);
    this.group.add(path);
  }

  /** World point at (s, lateral d, height y). */
  private point(
    s: number,
    d: number,
    y: number,
    out: THREE.Vector3,
  ): THREE.Vector3 {
    frameAt(this.line, s, F);
    return out.set(F.x - F.tz * d, y, F.z + F.tx * d);
  }

  /** Grey timber tint with a little per-piece variation. */
  private greyTint(geo: THREE.BufferGeometry, k0: number, k1: number): void {
    const k = this.rng.range(k0, k1);
    const warm = (this.rng.next() - 0.5) * 0.05;
    tint(geo, k * (1 + warm), k, k * (1 - warm));
  }

  // -------------------------------------------------------------------------
  // Deck: sleepers, bearers, boards
  // -------------------------------------------------------------------------

  private buildDeck(bag: Bag): void {
    const rng = this.rng;
    const uT = 1 / TIMBER_TILE_M;
    const L = new THREE.Vector3();
    const T = new THREE.Vector3();
    const P0 = new THREE.Vector3();
    const P1 = new THREE.Vector3();
    const nS = this.sleeperY.length;

    // Sleepers on every grid point except inside the flights
    for (let k = 0; k < nS; k++) {
      const s = k * SLEEPER_PITCH;
      const f = this.flightAt(s);
      if (f && s > f.s0 + 0.01 && s < f.s1 - 0.01) continue;
      const lift = this.liftAt(s, 0);
      if (lift > DECK_LIFT + 0.03) continue;
      frameAt(this.line, s, F);
      L.set(-F.tz, 0, F.tx);
      T.set(F.tx, 0, F.tz);
      let roll = (rng.next() - 0.5) * 0.08;
      let yaw = (rng.next() - 0.5) * 0.12;
      let top = this.sleeperY[k];
      if (lift > SLEEPER_TOP) {
        // In a drift the sand has scoured one end free and buried the other
        roll = (rng.chance(0.5) ? 1 : -1) * (0.18 + rng.next() * 0.16);
        yaw = (rng.next() - 0.5) * 0.4;
        top = lineTerrain(this.line, s) + lift - 0.025;
      }
      L.applyAxisAngle(UP, yaw);
      L.y = roll;
      L.normalize();
      this.point(s, 0, top - SLEEPER_H / 2, P0);
      const g = slab(
        SLEEPER_LEN,
        SLEEPER_H,
        0.1,
        WOOD_ROW.timberDark,
        uT,
        rng.next(),
      );
      g.applyMatrix4(basis(P0, L, T.negate()));
      this.greyTint(g, 0.72, 0.9);
      bag.add("wood", g);
    }

    // Bearers per bay, boards per bay
    for (let k = 0; k + 1 < nS; k++) {
      const s0 = k * SLEEPER_PITCH;
      const s1 = s0 + SLEEPER_PITCH;
      const mid = (s0 + s1) / 2;
      if (this.flightAt(mid)) continue;
      const buried0 = this.liftAt(s0, 0) > DECK_LIFT;
      const buried1 = this.liftAt(s1, 0) > DECK_LIFT;
      if (!(buried0 && buried1)) {
        for (const side of [-1, 1]) {
          const y0 = this.sleeperY[k] + BEARER_H / 2;
          const y1 = this.sleeperY[k + 1] + BEARER_H / 2;
          this.point(s0, side * BEARER_D, y0, P0);
          this.point(s1, side * BEARER_D, y1, P1);
          T.subVectors(P1, P0);
          const len = T.length() + 0.02;
          frameAt(this.line, mid, F);
          L.set(-F.tz, 0, F.tx);
          const g = slab(
            len,
            BEARER_H,
            BEARER_W,
            WOOD_ROW.timber,
            uT,
            rng.next(),
          );
          P0.lerp(P1, 0.5);
          g.applyMatrix4(basis(P0, T, L));
          this.greyTint(g, 0.8, 0.95);
          bag.add("wood", g);
        }
      }
      // Boards: transverse, 0.17 m pitch, some missing or sprung
      for (let s = s0 + BOARD_PITCH * 0.5; s < s1 - 0.01; s += BOARD_PITCH) {
        if (rng.chance(0.07)) continue;
        const lift = this.liftAt(s, 0);
        const deck = this.deckAt(s);
        if (lift > deck - lineTerrain(this.line, s) + 0.006) {
          // Buried deck: a third of the boards were lifted by the wind and
          // lie loose on the drift at odd angles, half sunk
          if (rng.chance(0.32))
            this.loosePlank(bag, s, (rng.next() - 0.5) * 1.4);
          continue;
        }
        frameAt(this.line, s, F);
        L.set(-F.tz, 0, F.tx);
        const slope = (this.deckAt(s + 0.3) - this.deckAt(s - 0.3)) / 0.6;
        T.set(F.tx, slope, F.tz).normalize();
        let y = deck - BOARD_T / 2;
        let roll = (rng.next() - 0.5) * 0.02;
        const sprung = rng.chance(0.06);
        if (sprung) {
          roll = (rng.chance(0.5) ? 1 : -1) * rng.range(0.1, 0.24);
          y += 0.03;
        }
        const yaw = (rng.next() - 0.5) * 0.05;
        const dLat = (rng.next() - 0.5) * 0.04;
        L.applyAxisAngle(UP, yaw);
        L.applyAxisAngle(T, roll);
        this.point(s, dLat, y, P0);
        const len = 0.6 + (rng.next() - 0.5) * 0.04;
        const row = rng.chance(0.5) ? WOOD_ROW.deckA : WOOD_ROW.deckB;
        const g = slab(
          len,
          BOARD_T,
          BOARD_W,
          row,
          1 / 0.6,
          rng.chance(0.5) ? 0 : 0.5,
        );
        g.applyMatrix4(basis(P0, L, T.negate()));
        this.greyTint(g, sprung ? 0.78 : 0.86, 1.06);
        bag.add("wood", g);
      }
    }

    // A few boards torn off and lying beside the walk
    for (const [s, d, yaw] of [
      [30.5, 0.85, 0.7],
      [95.2, -0.9, -1.1],
      [122.4, 0.95, 2.4],
    ]) {
      frameAt(this.line, s, F);
      L.set(-F.tz, 0, F.tx).applyAxisAngle(UP, yaw);
      this.point(s, d, 0, P0);
      P0.y = terrainHeight(P0.x, P0.z) + 0.004;
      const g = slab(0.6, BOARD_T, BOARD_W, WOOD_ROW.deckA, 1 / 0.6, 0);
      T.set(F.tx, 0, F.tz).applyAxisAngle(UP, yaw);
      L.applyAxisAngle(T, 0.12);
      g.applyMatrix4(basis(P0, L, T.negate()));
      this.greyTint(g, 0.9, 1.05);
      bag.add("wood", g);
    }
  }

  /** A deck board lying loose on the sand, one end dipping in. */
  private loosePlank(bag: Bag, s: number, d: number): void {
    const rng = this.rng;
    frameAt(this.line, s, F);
    const yaw = (rng.next() - 0.5) * 1.3;
    const L = new THREE.Vector3(-F.tz, 0, F.tx).applyAxisAngle(UP, yaw);
    const T = new THREE.Vector3(-L.z, 0, L.x);
    const P = this.point(s, d, 0, new THREE.Vector3());
    P.y = terrainHeight(P.x, P.z) + this.liftAt(s, d) - 0.006;
    L.applyAxisAngle(T, (rng.chance(0.5) ? 1 : -1) * rng.range(0.08, 0.28));
    const g = slab(
      0.6 + (rng.next() - 0.5) * 0.06,
      BOARD_T,
      BOARD_W,
      rng.chance(0.5) ? WOOD_ROW.deckA : WOOD_ROW.deckB,
      1 / 0.6,
      rng.chance(0.5) ? 0 : 0.5,
    );
    g.applyMatrix4(basis(P, L, T));
    this.greyTint(g, 0.92, 1.08);
    bag.add("wood", g);
  }

  /**
   * Terminal cue where the planked walk dies under the stub drift: the last
   * sleeper pair and the bearer ends poke out of the sand and a broken end
   * post leans beside them (the "BEACH" plate stands on its own post, see
   * buildSigns).
   */
  private buildEndStub(bag: Bag): void {
    const rng = this.rng;
    const uT = 1 / TIMBER_TILE_M;
    const L = new THREE.Vector3();
    const T = new THREE.Vector3();
    const P = new THREE.Vector3();
    const end = this.walkEnd;
    const sandAt = (s: number, d: number): number => {
      this.point(s, d, 0, P);
      return terrainHeight(P.x, P.z) + this.liftAt(s, d);
    };
    // Last two sleepers, each with one end scoured free
    for (const [s, side] of [
      [end - SLEEPER_PITCH, 1],
      [end, -1],
    ]) {
      frameAt(this.line, s, F);
      L.set(-F.tz, 0, F.tx).applyAxisAngle(UP, (rng.next() - 0.5) * 0.3);
      T.set(F.tx, 0, F.tz);
      L.y = side * 0.26;
      L.normalize();
      const y = sandAt(s, 0) - 0.02 - SLEEPER_H / 2;
      this.point(s, 0, y, P);
      const g = slab(
        SLEEPER_LEN,
        SLEEPER_H,
        0.1,
        WOOD_ROW.timberDark,
        uT,
        rng.next(),
      );
      g.applyMatrix4(basis(P, L, T.negate()));
      this.greyTint(g, 0.72, 0.9);
      bag.add("wood", g);
    }
    // Bearer ends rising out of the drift
    for (const side of [-1, 1]) {
      const d = side * BEARER_D;
      const a = this.point(end - 1.0, d, 0, new THREE.Vector3());
      a.y = sandAt(end - 1.0, d) - 0.06;
      const b = this.point(end - 0.2, d, 0, new THREE.Vector3());
      b.y = sandAt(end - 0.2, d) + 0.05;
      const dirV = b.clone().sub(a);
      frameAt(this.line, end - 0.6, F);
      L.set(-F.tz, 0, F.tx);
      const g = slab(
        dirV.length(),
        BEARER_H,
        BEARER_W,
        WOOD_ROW.timber,
        uT,
        rng.next(),
      );
      g.applyMatrix4(basis(a.lerp(b, 0.5), dirV, L));
      this.greyTint(g, 0.8, 0.95);
      bag.add("wood", g);
    }
    // Broken end post, splintered, leaning out
    frameAt(this.line, end + 0.3, F);
    L.set(-F.tz, 0, F.tx);
    T.set(F.tx, 0, F.tz);
    const dir = new THREE.Vector3()
      .copy(UP)
      .addScaledVector(L, -0.22)
      .addScaledVector(T, 0.08)
      .normalize();
    const ground = sandAt(end + 0.3, -0.5);
    const foot = new THREE.Vector3(P.x, ground - 0.5, P.z);
    const len = 1.05;
    const post = slab(len, 0.1, 0.1, WOOD_ROW.timber, uT, rng.next());
    post.applyMatrix4(
      basis(P.copy(foot).addScaledVector(dir, len / 2), dir, T),
    );
    this.greyTint(post, 0.78, 0.92);
    bag.add("wood", post);
    const shard = slab(0.18, 0.035, 0.06, WOOD_ROW.timber, uT, rng.next());
    const sd = dir.clone().applyAxisAngle(T, 0.5);
    shard.applyMatrix4(
      basis(
        P.copy(foot).addScaledVector(dir, len).addScaledVector(sd, 0.07),
        sd,
        T,
      ),
    );
    this.greyTint(shard, 0.7, 0.85);
    bag.add("wood", shard);
    addCylinderCollider(foot.x, foot.z, 0.09, ground - 0.3, ground + 0.6);
  }

  // -------------------------------------------------------------------------
  // Step flights
  // -------------------------------------------------------------------------

  private buildFlights(bag: Bag): void {
    const rng = this.rng;
    const uT = 1 / TIMBER_TILE_M;
    const L = new THREE.Vector3();
    const T = new THREE.Vector3();
    const D = new THREE.Vector3();
    const P = new THREE.Vector3();
    for (const f of this.flights) {
      for (let k = 0; k < f.tops.length; k++) {
        const s = f.s0 + k * f.tread;
        const top = f.tops[k];
        if (top < lineTerrain(this.line, s) + this.liftAt(s, 0) - 0.02)
          continue;
        frameAt(this.line, s, F);
        L.set(-F.tz, 0, F.tx);
        T.set(F.tx, 0, F.tz);
        const rotten = rng.chance(0.12);
        const roll = rotten
          ? (rng.next() - 0.5) * 0.14
          : (rng.next() - 0.5) * 0.03;
        L.applyAxisAngle(T, roll);
        this.point(s, 0, top - RISER_H / 2 - (rotten ? 0.03 : 0), P);
        const g = slab(
          RISER_LEN,
          RISER_H,
          RISER_T,
          WOOD_ROW.timber,
          uT,
          rng.next(),
        );
        g.applyMatrix4(basis(P, L, T.negate()));
        this.greyTint(g, rotten ? 0.7 : 0.82, rotten ? 0.85 : 1);
        bag.add("wood", g);
        // Two stakes on the downhill face
        for (const side of [-1, 1]) {
          const lean = (rng.next() - 0.5) * 0.12;
          D.set(
            -F.tx * 0.06 + L.x * lean,
            1,
            -F.tz * 0.06 + L.z * lean,
          ).normalize();
          this.point(
            s - 0.055,
            side * 0.27 + (rng.next() - 0.5) * 0.03,
            top - 0.42,
            P,
          );
          const st = stake(
            0.4,
            0.03,
            0.024,
            this.seg(8, 5),
            WOOD_ROW.timberDark,
            rng.next(),
          );
          st.applyMatrix4(basis(P.addScaledVector(D, 0.2), D, T));
          this.greyTint(st, 0.72, 0.9);
          bag.add("wood", st);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Handrail
  // -------------------------------------------------------------------------

  private buildHandrail(bag: Bag): void {
    const rng = this.rng;
    const uT = 1 / TIMBER_TILE_M;
    const L = new THREE.Vector3();
    const T = new THREE.Vector3();
    const P = new THREE.Vector3();
    const posts: Post[] = [];
    const count = Math.floor((RAIL_END - 0.6) / RAIL_PITCH) + 1;
    const snappedIdx = new Set<number>();
    while (snappedIdx.size < 5) {
      const i = 2 + rng.int(count - 3);
      snappedIdx.add(i);
    }
    // Two broken bays, not adjacent, away from the ends
    const broken = new Set<number>();
    while (broken.size < 2) {
      const b = 4 + rng.int(count - 9);
      if (![...broken].some((o) => Math.abs(o - b) < 2)) broken.add(b);
    }
    for (let i = 0; i < count; i++) {
      const s = 0.6 + i * RAIL_PITCH;
      frameAt(this.line, s, F);
      L.set(-F.tz, 0, F.tx);
      T.set(F.tx, 0, F.tz);
      // Outward lean growing along the stretch, plus per-post scatter
      const lean =
        0.1 + 0.12 * smoothstep(0, RAIL_END, s) + (rng.next() - 0.5) * 0.1;
      const leanS = (rng.next() - 0.5) * 0.08;
      const dir = new THREE.Vector3()
        .copy(UP)
        .addScaledVector(L, lean)
        .addScaledVector(T, leanS)
        .normalize();
      this.point(s, RAIL_D, 0, P);
      const ground = terrainHeight(P.x, P.z);
      const foot = new THREE.Vector3(P.x, ground - POST_BURY, P.z);
      const snapped = snappedIdx.has(i);
      const len = snapped ? POST_BURY + rng.range(0.22, 0.48) : POST_LEN;
      const attach = foot
        .clone()
        .addScaledVector(dir, RAIL_UP)
        .addScaledVector(L, -0.06);
      if (snapped) attach.y -= 0.26;
      posts.push({ s, foot, dir, len, snapped, attach });

      const g = slab(len, 0.08, 0.08, WOOD_ROW.timber, uT, rng.next());
      g.applyMatrix4(basis(P.copy(foot).addScaledVector(dir, len / 2), dir, T));
      this.greyTint(g, 0.84, 1);
      bag.add("wood", g);
      if (snapped) {
        // Splintered top: a short shard still standing off the break
        const shard = slab(0.14, 0.03, 0.05, WOOD_ROW.timber, uT, rng.next());
        const sd = dir.clone().applyAxisAngle(T, (rng.next() - 0.5) * 0.7);
        shard.applyMatrix4(
          basis(
            P.copy(foot).addScaledVector(dir, len).addScaledVector(sd, 0.05),
            sd,
            T,
          ),
        );
        this.greyTint(shard, 0.7, 0.85);
        bag.add("wood", shard);
      }
      addCylinderCollider(
        foot.x,
        foot.z,
        0.07,
        ground - 0.3,
        ground + (snapped ? len - POST_BURY : 1.0),
      );
    }
    // Rail: one board from post to post, sagging over the snapped ones,
    // broken in two bays where the ends droop towards the sand
    for (let i = 0; i + 1 < posts.length; i++) {
      const a = posts[i].attach;
      const b = posts[i + 1].attach;
      if (broken.has(i)) {
        const dir = b.clone().sub(a);
        const e1 = a.clone().addScaledVector(dir, 0.46);
        e1.y -= 0.34;
        this.railPiece(bag, a, e1);
        const e2 = b.clone().addScaledVector(dir, -0.22);
        e2.y -= 0.16;
        this.railPiece(bag, b, e2);
        continue;
      }
      this.railPiece(bag, a, b);
    }
  }

  private railPiece(bag: Bag, a: THREE.Vector3, b: THREE.Vector3): void {
    const T = new THREE.Vector3().subVectors(b, a);
    const len = T.length();
    const mid = a.clone().lerp(b, 0.5);
    const hint = new THREE.Vector3(-T.z, 0, T.x);
    const g = slab(
      len + 0.03,
      0.1,
      0.04,
      WOOD_ROW.timber,
      1 / TIMBER_TILE_M,
      this.rng.next(),
    );
    g.applyMatrix4(basis(mid, T, hint));
    this.greyTint(g, 0.86, 1.02);
    bag.add("wood", g);
  }

  // -------------------------------------------------------------------------
  // Signs
  // -------------------------------------------------------------------------

  private buildSigns(bag: Bag): void {
    const uT = 1 / TIMBER_TILE_M;
    const L = new THREE.Vector3();
    const T = new THREE.Vector3();
    const P = new THREE.Vector3();
    const specs: Array<{
      s: number;
      d: number;
      size: number;
      len: number;
      bury: number;
      w: number;
      h: number;
      /** Plate centre above the ground along the post. */
      at: number;
      lean: number;
      leanS: number;
      /** -1 = plate faces the sea (read walking inland), +1 = faces north. */
      facing: number;
      rect: readonly [number, number, number, number];
    }> = [
      {
        s: -0.6,
        d: 1.0,
        size: 0.1,
        len: 2.6,
        bury: 0.6,
        w: 0.9,
        h: 0.6,
        at: 1.55,
        lean: 0.16,
        leanS: -0.05,
        facing: -1,
        rect: SIGN_UV.main,
      },
      {
        s: 58,
        d: -0.8,
        size: 0.08,
        len: 1.75,
        bury: 0.5,
        w: 0.55,
        h: 0.18,
        at: 1.1,
        lean: -0.05,
        leanS: 0.03,
        facing: -1,
        rect: SIGN_UV.arrow,
      },
      {
        s: this.walkEnd + 0.9,
        d: 0.7,
        size: 0.07,
        len: 1.6,
        bury: 0.5,
        w: 0.5,
        h: 0.16,
        at: 0.92,
        lean: 0.08,
        leanS: 0.06,
        facing: 1,
        rect: SIGN_UV.beach,
      },
    ];
    for (const sp of specs) {
      frameAt(this.line, sp.s, F);
      L.set(-F.tz, 0, F.tx);
      T.set(F.tx, 0, F.tz);
      const dir = new THREE.Vector3()
        .copy(UP)
        .addScaledVector(L, sp.lean)
        .addScaledVector(T, sp.leanS)
        .normalize();
      this.point(sp.s, sp.d, 0, P);
      // Posts stand in whatever the sand surface is here, drift included
      const ground = terrainHeight(P.x, P.z) + this.liftAt(sp.s, sp.d);
      const foot = new THREE.Vector3(P.x, ground - sp.bury, P.z);
      const post = slab(
        sp.len,
        sp.size,
        sp.size,
        WOOD_ROW.timber,
        uT,
        this.rng.next(),
      );
      post.applyMatrix4(
        basis(P.copy(foot).addScaledVector(dir, sp.len / 2), dir, T),
      );
      this.greyTint(post, 0.82, 0.96);
      bag.add("wood", post);
      // Plate on the facing side; reading direction = the reader's right
      const xAxis = L.clone().multiplyScalar(-sp.facing);
      const centre = foot
        .clone()
        .addScaledVector(dir, sp.bury + sp.at)
        .addScaledVector(T, sp.facing * (sp.size / 2 + 0.006));
      const pl = plate(sp.w, sp.h, 0.006, sp.rect, SIGN_UV.back);
      const zAxis = new THREE.Vector3().crossVectors(xAxis, dir).normalize();
      const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
      pl.applyMatrix4(
        new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis).setPosition(centre),
      );
      bag.add("sign", pl);
      addCylinderCollider(
        foot.x,
        foot.z,
        sp.size * 0.9,
        ground - 0.3,
        ground + sp.len - sp.bury,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Sand: drifts over the drowned sections and the tread fill of the flights
  // -------------------------------------------------------------------------

  private buildSand(bag: Bag): void {
    // Merge overlapping spans (the stub drift covers the top of flight 2)
    const spans: Array<{ s0: number; s1: number; hw: number }> = [];
    for (const d of this.drifts) spans.push({ s0: d.s0, s1: d.s1, hw: d.hw });
    for (const f of this.flights) {
      spans.push({ s0: f.s0 - FOOT_SPILL, s1: f.s1, hw: 1.3 });
    }
    spans.sort((a, b) => a.s0 - b.s0);
    const merged: typeof spans = [];
    for (const sp of spans) {
      const last = merged[merged.length - 1];
      if (last && sp.s0 <= last.s1 + 0.01) {
        last.s1 = Math.max(last.s1, sp.s1);
        last.hw = Math.max(last.hw, sp.hw);
      } else {
        merged.push({ ...sp });
      }
    }
    const along = this.det >= 0.65 ? 0.5 : 0.75;
    for (const sp of merged) {
      // Row positions: dense along s, with a pair of rows hugging every riser
      // so the tread steps stay sharp
      const rows: number[] = [];
      for (let s = sp.s0; s < sp.s1; s += along) rows.push(s);
      rows.push(sp.s1);
      for (const f of this.flights) {
        if (f.s1 < sp.s0 || f.s0 > sp.s1) continue;
        for (let k = 0; k < f.tops.length; k++) {
          const s = f.s0 + k * f.tread;
          rows.push(s - 0.012, s + 0.012, s + f.tread * 0.5);
        }
      }
      rows.sort((a, b) => a - b);
      const clean: number[] = [];
      for (const r of rows) {
        if (clean.length === 0 || r - clean[clean.length - 1] > 0.004)
          clean.push(r);
      }
      this.sandSheet(bag, clean, sp.hw);
    }
  }

  private sandSheet(bag: Bag, rows: number[], hw: number): void {
    const cols = this.seg(12, 6);
    const nr = rows.length;
    const nv = nr * (cols + 1);
    const pos = new Float32Array(nv * 3);
    const uv = new Float32Array(nv * 2);
    let p = 0;
    for (let r = 0; r < nr; r++) {
      const s = rows[r];
      frameAt(this.line, s, F);
      for (let c = 0; c <= cols; c++) {
        const d = -hw + (2 * hw * c) / cols;
        const x = F.x - F.tz * d;
        const z = F.z + F.tx * d;
        const h = this.liftAt(s, d);
        // Rim: sink under the terrain where the lift runs out, by a noisy
        // amount so the meeting line with the terrain wanders
        const sink = RIM_SINK * (0.6 + 0.8 * fbm(x * 0.7 + 2, z * 0.7, 2));
        const y = terrainHeight(x, z) + h - sink * (1 - smoothstep(0, 0.1, h));
        pos[p * 3] = x;
        pos[p * 3 + 1] = y;
        pos[p * 3 + 2] = z;
        uv[p * 2] = (x + 410) / SAND_TILE_X;
        uv[p * 2 + 1] = (420 - z) / SAND_TILE_Z;
        p++;
      }
    }
    const idx: number[] = [];
    for (let r = 0; r + 1 < nr; r++) {
      for (let c = 0; c < cols; c++) {
        const a = r * (cols + 1) + c;
        const b = a + cols + 1;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    bag.add("sand", g);
  }

  // -------------------------------------------------------------------------
  // Desire path
  // -------------------------------------------------------------------------

  private buildPath(): THREE.Mesh {
    const line = this.pathLine;
    const OFFS = [-1.35, -0.55, 0, 0.55, 1.35];
    const ALPHA = [0, 0.8, 1, 0.8, 0];
    const DARK = [1, 0.9, 0.84, 0.9, 1];
    const nr = Math.floor(line.total / line.step) + 1;
    const nv = nr * 5;
    const pos = new Float32Array(nv * 3);
    const uv = new Float32Array(nv * 2);
    const col = new Float32Array(nv * 4);
    let p = 0;
    for (let r = 0; r < nr; r++) {
      const s = Math.min(line.total, r * line.step);
      frameAt(line, s, F);
      const hw = 0.62 + 0.3 * (fbm(s * 0.07 + 11, 2.5, 2) - 0.5);
      const fade =
        smoothstep(0, 7, s) * smoothstep(line.total, line.total - 12, s);
      for (let c = 0; c < 5; c++) {
        const d = OFFS[c] * hw;
        const x = F.x - F.tz * d;
        const z = F.z + F.tx * d;
        pos[p * 3] = x;
        pos[p * 3 + 1] = terrainHeight(x, z) + 0.05;
        pos[p * 3 + 2] = z;
        uv[p * 2] = s / PATH_TILE;
        uv[p * 2 + 1] = c / 4;
        col[p * 4] = DARK[c];
        col[p * 4 + 1] = DARK[c];
        col[p * 4 + 2] = DARK[c];
        col[p * 4 + 3] = ALPHA[c] * fade;
        p++;
      }
    }
    const idx: number[] = [];
    for (let r = 0; r + 1 < nr; r++) {
      for (let c = 0; c < 4; c++) {
        const a = r * 5 + c;
        const b = a + 5;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setAttribute("color", new THREE.BufferAttribute(col, 4));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, this.pathMat);
    mesh.name = "boardwalk-path";
    mesh.renderOrder = 1;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    return mesh;
  }

  /** Half-buried board fragments and one old peg along the desire path. */
  private buildRemnants(bag: Bag): void {
    const rng = this.rng;
    const line = this.pathLine;
    const L = new THREE.Vector3();
    const T = new THREE.Vector3();
    const P = new THREE.Vector3();
    const place = (s: number, d: number, out: THREE.Vector3): void => {
      frameAt(line, s, F);
      out.set(F.x - F.tz * d, 0, F.z + F.tx * d);
      out.y = terrainHeight(out.x, out.z);
    };
    for (const [s, d] of [
      [9, 0.7],
      [27, -0.8],
      [41, 0.5],
      [63, -0.6],
      [88, 0.9],
      [104, -0.5],
      [121, 0.75],
    ]) {
      place(s + (rng.next() - 0.5) * 3, d, P);
      const yaw = rng.next() * Math.PI;
      L.set(Math.cos(yaw), 0, Math.sin(yaw));
      T.set(-L.z, 0, L.x);
      const len = rng.range(0.3, 0.58);
      const g = slab(
        len,
        BOARD_T,
        BOARD_W,
        rng.chance(0.5) ? WOOD_ROW.deckA : WOOD_ROW.deckB,
        1 / 0.6,
        rng.chance(0.5) ? 0 : 0.5,
      );
      // One end dives into the sand
      L.applyAxisAngle(T, (rng.chance(0.5) ? 1 : -1) * rng.range(0.08, 0.2));
      P.y += 0.002;
      g.applyMatrix4(basis(P, L, T));
      this.greyTint(g, 0.9, 1.08);
      bag.add("wood", g);
    }
    // A sleeper end and a peg
    place(52, 0.9, P);
    L.set(0.3, 0, 0.95).normalize();
    T.set(-L.z, 0, L.x);
    L.applyAxisAngle(T, 0.1);
    const sl = slab(
      0.5,
      0.1,
      0.1,
      WOOD_ROW.timberDark,
      1 / TIMBER_TILE_M,
      rng.next(),
    );
    P.y -= 0.03;
    sl.applyMatrix4(basis(P, L, T));
    this.greyTint(sl, 0.72, 0.85);
    bag.add("wood", sl);
    place(15, -0.55, P);
    const D = new THREE.Vector3(0.25, 1, 0.1).normalize();
    const peg = stake(
      0.24,
      0.011,
      0.02,
      this.seg(6, 5),
      WOOD_ROW.timber,
      rng.next(),
    );
    peg.applyMatrix4(basis(P.addScaledVector(D, 0.04), D, T));
    this.greyTint(peg, 0.72, 0.85);
    bag.add("wood", peg);
  }
}
