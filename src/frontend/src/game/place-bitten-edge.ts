// The Bitten Edge – a storm-collapsed foredune front on East Beach. The raw
// 4 m scarp is terrain (landforms.ts BITTEN_EDGE / edgeFace); this module
// dresses it and makes it solid:
//
//   skin      one strip mesh in (x, s) space (s = z - faceZ(x)) hugging the
//             rendered terrain: slumped sand cones at the foot, the torn face
//             itself (near-vertical, undercut below the root-mat lip), the
//             flat lip shelf and the drift banks against the cubes and the
//             pillbox. Two material groups: world-tiling sand (matches the
//             terrain texture and its rain/cloud response) and the strata
//             face (uv1: u along the face, v foot → lip).
//   wads      instanced root-mat lumps hanging over the lip with dead marram
//             on top and root fibres below.
//   concrete  the anti-tank cubes on their diagonal line up through the
//             breach (three toppled into the slump), the fallen hexagonal
//             pillbox at the foot with its three seaward embrasures and the
//             drifted doorway, the rusted stove-pipe stub – one atlas, one
//             draw call.
//
// The terrain mesh is a 2.7 m grid (ultra), so a 2.5 m-wide step renders
// nowhere near its analytic profile; TerrainGrid replicates world.ts'
// triangulation exactly so the skin never dips under the rendered sand and
// the ground override (registerGround "edge") lets the player walk on what
// they see – slumps, shelf and the sandy pillbox floor. Colliders (tag
// "edge"): a 12-box chain along the face (the step becomes a wall, the top
// stays reachable round the ends), every cube, the six pillbox walls with a
// 1 m clear doorway, the stove pipe.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  addBoxCollider,
  addCylinderCollider,
  beginColliderSet,
  clearColliderSet,
  colliderStats,
} from "./colliders";
import { registerGround, unregisterGround } from "./ground";
import { edgeFace } from "./landforms";
import { clamp, fbm, lerp, smoothstep } from "./noise";
import {
  ER,
  type Region,
  WR,
  edgeConcretePbr,
  lipWadPbr,
  scarpFacePbr,
} from "./place-bitten-edge-textures";
import type { Environment } from "./sky";
import { shoreZ, terrainHeight } from "./terrain";
import {
  TexRng,
  applyPbr,
  remapBoxUvAround,
  sandAlbedo,
  sandNormal,
} from "./textures";
import type { QualityId } from "./types";

const TAG = "edge";

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Skin strip extent along the beach. The landform fades out by x 128 / 192;
 * the strip (geometry AND ground override) starts at 134 so it never overlaps
 * the cable house site at (128, 16) – the wall boxes start at 133.5 anyway –
 * and its relief fades in over SX_FADE metres from that edge.
 */
const SX0 = 134;
const SX1 = 196;
const SX_FADE = 2.5;
/** Cross-face rows: s = z - faceZ(x). Apron (seaward) rows end at the foot. */
const APRON_ROWS = [
  -10.5, -9.2, -8.0, -7.0, -6.0, -5.1, -4.3, -3.6, -3.0, -2.5, -2.1, -1.75,
  -1.45, -1.15,
];
/** Foot of the designed face (the analytic toe is at s = -1). */
const FACE_S0 = -0.85;
/** Quads across the face (foot → lip). */
const FACE_STEPS = 13;
/** Shelf rows behind the lip row (which sits at lipS(x)). */
const SHELF_ROWS = [1.05, 1.3, 1.65, 2.1, 2.7, 3.4, 4.4];
const S_MIN = APRON_ROWS[0];
const S_MAX = SHELF_ROWS[SHELF_ROWS.length - 1];
const ROWS = APRON_ROWS.length + 1 + (FACE_STEPS - 1) + 1 + SHELF_ROWS.length;
/** Rise below which the strata material gives way to plain sand (the ends). */
const FACE_MIN_RISE = 1.4;
/** Face colliders cover x where the step is at least this high. */
const WALL_X0 = 133.5;
const WALL_X1 = 186.5;
const WALL_SEGMENTS = 12;

// Sand texture tiling of the terrain mesh (world.ts) – the skin matches it.
const SAND_TILE_X = 820 / 70;
const SAND_TILE_Z = 560 / 48;

/** The anti-tank line: beach → the breach → up the bench. */
const TEETH_P0: readonly [number, number] = [145, 8];
const TEETH_BREACH_X = 156.5;
const TEETH_P2: readonly [number, number] = [183, 62];
const TEETH_SPACING = 2.75;

/**
 * The fallen pillbox. Local -z = seaward (the three slit faces 3..5 look
 * SW / SSE / ESE after the yaw); the door is on face 2, the west-landward
 * face, so it opens along the shore where you can walk in from the beach
 * (the landward face stands 1.5 m off the scarp).
 */
const PB = {
  x: 162,
  z: 23.4,
  yaw: -0.26,
  doorFace: 2,
  /** Seaward tilt (rad) and sideways roll of the fallen box. */
  tilt: 0.14,
  roll: 0.045,
  /** Outer apothem (flat-to-flat 4.6 m), wall thickness, heights. */
  apothem: 2.3,
  wall: 0.4,
  wallH: 2.4,
  roofT: 0.3,
  slabT: 0.2,
  /** Floor top above the terrain at the centre. */
  floorLift: 0.1,
  /** Door and embrasure spans as fractions along their faces. */
  doorA0: 0.31,
  doorA1: 0.69,
  doorH: 2.15,
  slitY0: 1.62,
  slitY1: 1.98,
  slitA0: 0.3,
  slitA1: 0.7,
  slitB0: 0.2,
  slitB1: 0.8,
} as const;
const COS30 = Math.cos(Math.PI / 6);

// ---------------------------------------------------------------------------
// Terrain mesh replica
// ---------------------------------------------------------------------------

/** Grid segments of world.ts' terrain mesh per quality. */
const TERRAIN_SEG: Record<QualityId, number> = {
  ultra: 300,
  high: 240,
  medium: 170,
  low: 120,
};

/**
 * Height of the rendered terrain mesh (not the analytic field): world.ts
 * samples terrainHeight() on a uniform grid inside the play zone and splits
 * every cell along the (i, j+1)-(i+1, j) diagonal. Exact on the mesh planes.
 */
class TerrainGrid {
  private readonly stepX: number;
  private readonly stepZ: number;
  /** Grid-corner heights: ~8 skin vertices share a cell, the player too. */
  private readonly corners = new Map<number, number>();

  constructor(quality: QualityId) {
    const seg = TERRAIN_SEG[quality];
    this.stepX = 820 / seg;
    const segZ = Math.floor(seg * 0.7);
    const nZ = Math.max(1, Math.round(510 / (560 / segZ)));
    this.stepZ = 510 / nZ;
  }

  private corner(i: number, j: number): number {
    const key = (j + 1024) * 8192 + (i + 1024);
    const hit = this.corners.get(key);
    if (hit !== undefined) return hit;
    if (this.corners.size > 8192) this.corners.clear();
    const h = terrainHeight(-410 + i * this.stepX, -90 + j * this.stepZ);
    this.corners.set(key, h);
    return h;
  }

  height(x: number, z: number): number {
    const fx = (x + 410) / this.stepX;
    const fz = (z + 90) / this.stepZ;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const h00 = this.corner(i, j);
    const h01 = this.corner(i, j + 1);
    const h10 = this.corner(i + 1, j);
    if (tx + tz <= 1) return h00 + (h10 - h00) * tx + (h01 - h00) * tz;
    const h11 = this.corner(i + 1, j + 1);
    return h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
  }
}

// ---------------------------------------------------------------------------
// The face line
// ---------------------------------------------------------------------------

/** z of the scarp line at x (s = 0). */
function faceZ(x: number): number {
  return shoreZ(x) + edgeFace(x).d;
}

/** Height of the step at x (analytic lip minus toe). */
function riseAt(x: number): number {
  const zf = faceZ(x);
  return terrainHeight(x, zf + 1.6) - terrainHeight(x, zf - 1.0);
}

/** 0..1 how much of a scarp there is at x (fades out at both ends). */
function riseFactor(x: number): number {
  return clamp(riseAt(x) / 3.6, 0, 1);
}

/** s of the lip row: the root mat overhangs the face by up to 30 cm. */
function lipS(x: number): number {
  return 0.9 - 0.3 * riseFactor(x) * (0.55 + 0.45 * fbm(x * 0.8 + 5, 0.3, 2));
}

/**
 * The face line tabulated once per skin column (faceZ, rise factor, lip row
 * s, analytic lip height): every skin vertex and every ground query used to
 * recompute these – 3 terrainHeight calls and 3 fbm each. Queries between
 * columns interpolate linearly (the columns are 0.34–1 m apart, the line
 * wanders on a 20 m wavelength, so the error is sub-millimetre).
 */
class FaceTable {
  readonly n: number;
  private readonly inv: number;
  private readonly zfA: Float64Array;
  private readonly rfA: Float64Array;
  private readonly lsA: Float64Array;
  private readonly lipA: Float64Array;

  constructor(
    private readonly x0: number,
    x1: number,
    dx: number,
  ) {
    this.n = Math.round((x1 - x0) / dx) + 1;
    this.inv = 1 / dx;
    this.zfA = new Float64Array(this.n);
    this.rfA = new Float64Array(this.n);
    this.lsA = new Float64Array(this.n);
    this.lipA = new Float64Array(this.n);
    for (let c = 0; c < this.n; c++) {
      const x = x0 + c * dx;
      const zf = faceZ(x);
      this.zfA[c] = zf;
      this.rfA[c] = riseFactor(x);
      this.lsA[c] = lipS(x);
      this.lipA[c] = terrainHeight(x, zf + 1.6);
    }
  }

  private at(arr: Float64Array, x: number): number {
    let f = (x - this.x0) * this.inv;
    if (f <= 0) return arr[0];
    if (f >= this.n - 1) return arr[this.n - 1];
    const i = Math.floor(f);
    f -= i;
    return arr[i] + (arr[i + 1] - arr[i]) * f;
  }

  /** Column x for the geometry build. */
  x(c: number): number {
    return this.x0 + c / this.inv;
  }

  zf(x: number): number {
    return this.at(this.zfA, x);
  }

  rf(x: number): number {
    return this.at(this.rfA, x);
  }

  ls(x: number): number {
    return this.at(this.lsA, x);
  }

  lipY(x: number): number {
    return this.at(this.lipA, x);
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

type GeoList = THREE.BufferGeometry[];

/** Remap a geometry's 0..1 UVs into an atlas region. */
function mapUv(geo: THREE.BufferGeometry, r: Region): THREE.BufferGeometry {
  const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(
      i,
      r[0] + uv.getX(i) * (r[2] - r[0]),
      r[1] + uv.getY(i) * (r[3] - r[1]),
    );
  }
  return geo;
}

function inRegion(r: Region, u: number, v: number): [number, number] {
  return [r[0] + u * (r[2] - r[0]), r[1] + v * (r[3] - r[1])];
}

/**
 * Box with its four sides mapped once around `side` (u shifted by
 * `uShift` quarters so cubes differ) and top/bottom into `top`.
 */
function atlasBox(
  w: number,
  h: number,
  d: number,
  side: Region,
  top: Region,
  uShift: number,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d, 1, 3, 1);
  remapBoxUvAround(g);
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  const p = g.parameters;
  const counts = [
    (p.depthSegments + 1) * (p.heightSegments + 1),
    (p.depthSegments + 1) * (p.heightSegments + 1),
    (p.widthSegments + 1) * (p.depthSegments + 1),
    (p.widthSegments + 1) * (p.depthSegments + 1),
    (p.widthSegments + 1) * (p.heightSegments + 1),
    (p.widthSegments + 1) * (p.heightSegments + 1),
  ];
  let start = 0;
  for (let f = 0; f < 6; f++) {
    const r = f === 2 || f === 3 ? top : side;
    for (let i = start; i < start + counts[f]; i++) {
      let u = uv.getX(i);
      if (f !== 2 && f !== 3) {
        u += uShift * 0.25;
        u -= Math.floor(u + 1e-6);
      }
      const [su, sv] = inRegion(r, u, uv.getY(i));
      uv.setXY(i, su, sv);
    }
    start += counts[f];
  }
  return g;
}

/**
 * Flat-shaded quad (two triangles) with an explicit normal direction: the
 * winding is flipped if the geometric normal points against `want`.
 */
function pushQuad(
  pos: number[],
  nor: number[],
  uv: number[],
  p: ReadonlyArray<readonly [number, number, number]>,
  uvs: ReadonlyArray<readonly [number, number]>,
  want: readonly [number, number, number],
): void {
  const ax = p[1][0] - p[0][0];
  const ay = p[1][1] - p[0][1];
  const az = p[1][2] - p[0][2];
  const bx = p[3][0] - p[0][0];
  const by = p[3][1] - p[0][1];
  const bz = p[3][2] - p[0][2];
  let nx = ay * bz - az * by;
  let ny = az * bx - ax * bz;
  let nz = ax * by - ay * bx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len;
  ny /= len;
  nz /= len;
  const flip = nx * want[0] + ny * want[1] + nz * want[2] < 0;
  if (flip) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  const order = flip ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
  for (const k of order) {
    pos.push(p[k][0], p[k][1], p[k][2]);
    nor.push(nx, ny, nz);
    uv.push(uvs[k][0], uvs[k][1]);
  }
}

function geoFromArrays(
  pos: number[],
  nor: number[],
  uv: number[],
): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  // Indexed like the Three primitives it is merged with
  const index: number[] = [];
  for (let i = 0; i < pos.length / 3; i++) index.push(i);
  g.setIndex(index);
  return g;
}

/** Rusted round bar between two points. */
function bar(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  r: number,
): THREE.BufferGeometry {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const g = new THREE.CylinderGeometry(r, r, len, 6, 1);
  mapUv(g, ER.rust);
  const dir = new THREE.Vector3(
    b[0] - a[0],
    b[1] - a[1],
    b[2] - a[2],
  ).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    dir,
  );
  g.applyQuaternion(q);
  g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  return g;
}

// ---------------------------------------------------------------------------
// The pillbox frame
// ---------------------------------------------------------------------------

class PillboxFrame {
  readonly cy: number;
  readonly q = new THREE.Quaternion();
  private readonly e: ArrayLike<number>;
  private readonly cosYaw = Math.cos(PB.yaw);
  private readonly sinYaw = Math.sin(PB.yaw);
  /** Circumradius of the outer / inner hexagon. */
  readonly rOuter = PB.apothem / COS30;
  readonly rInner = (PB.apothem - PB.wall) / COS30;
  /** World y of the drifted sand at the door line (sill + drift). */
  readonly doorSandY: number;
  /** Outward normal / tangent of the door face in local xz. */
  private readonly dnx = Math.cos(Math.PI / 6 + (PB.doorFace * Math.PI) / 3);
  private readonly dnz = Math.sin(Math.PI / 6 + (PB.doorFace * Math.PI) / 3);

  constructor(private readonly grid: TerrainGrid) {
    // The floor rides on the RENDERED sand under the footprint: on the coarse
    // grids of the lower qualities the toe of the scarp is a broad ramp that
    // would otherwise swallow the box.
    let base = terrainHeight(PB.x, PB.z);
    for (let k = 0; k < 7; k++) {
      const a = (k * Math.PI) / 3;
      const r = k === 6 ? 0 : 2.0;
      const wx = this.worldX(Math.cos(a) * r, Math.sin(a) * r);
      const wz = this.worldZ(Math.cos(a) * r, Math.sin(a) * r);
      base = Math.max(base, grid.height(wx, wz) - 0.12);
    }
    this.cy = base + PB.floorLift;
    this.q
      .setFromAxisAngle(new THREE.Vector3(0, 1, 0), PB.yaw)
      .multiply(
        new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(1, 0, 0),
          -PB.tilt,
        ),
      )
      .multiply(
        new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 0, 1),
          PB.roll,
        ),
      );
    this.e = new THREE.Matrix4().makeRotationFromQuaternion(this.q).elements;
    const m = PB.apothem - PB.wall / 2;
    this.doorSandY = this.floorTop(this.dnx * m, this.dnz * m) + 0.13;
  }

  /** Distance of a local point along the door face's outward normal. */
  doorAlong(lx: number, lz: number): number {
    return lx * this.dnx + lz * this.dnz;
  }

  /** Sideways offset of a local point from the door axis. */
  doorAcross(lx: number, lz: number): number {
    return -lx * this.dnz + lz * this.dnx;
  }

  /** Local point on the door axis at `along` from the centre. */
  doorLocalX(along: number): number {
    return this.dnx * along;
  }

  doorLocalZ(along: number): number {
    return this.dnz * along;
  }

  toWorld(lx: number, ly: number, lz: number): THREE.Vector3 {
    return new THREE.Vector3(lx, ly, lz)
      .applyQuaternion(this.q)
      .add(new THREE.Vector3(PB.x, this.cy, PB.z));
  }

  /** Plan projection world → local (the small tilt is ignored). */
  localX(x: number, z: number): number {
    return (x - PB.x) * this.cosYaw - (z - PB.z) * this.sinYaw;
  }

  localZ(x: number, z: number): number {
    return (x - PB.x) * this.sinYaw + (z - PB.z) * this.cosYaw;
  }

  worldX(lx: number, lz: number): number {
    return PB.x + lx * this.cosYaw + lz * this.sinYaw;
  }

  worldZ(lx: number, lz: number): number {
    return PB.z - lx * this.sinYaw + lz * this.cosYaw;
  }

  /** World y of a point on the local plane y = ly at (lx, lz). */
  planeY(lx: number, ly: number, lz: number): number {
    return this.cy + this.e[1] * lx + this.e[5] * ly + this.e[9] * lz;
  }

  /** World y of the floor slab top at local (lx, lz). */
  floorTop(lx: number, lz: number): number {
    return this.planeY(lx, 0, lz);
  }

  /** Hexagon "apothem distance" (flat faces at 30° + k·60°). */
  hexDist(lx: number, lz: number): number {
    let m = 0;
    for (let k = 0; k < 3; k++) {
      const a = Math.PI / 6 + (k * Math.PI) / 3;
      const d = Math.abs(lx * Math.cos(a) + lz * Math.sin(a));
      if (d > m) m = d;
    }
    return m;
  }

  /** True inside the inner room or in the doorway (ground override zone). */
  insideRoom(lx: number, lz: number): boolean {
    if (this.hexDist(lx, lz) < PB.apothem - PB.wall + 0.05) return true;
    const along = this.doorAlong(lx, lz);
    return (
      Math.abs(this.doorAcross(lx, lz)) < 0.56 &&
      along >= 1.5 &&
      along < PB.apothem + 0.2
    );
  }

  /**
   * World y of the sand inside: the tilted concrete floor, never below the
   * rendered terrain, a drift tongue fanning in through the door and a level
   * pool where the sand has run down to the low seaward side.
   */
  interiorY(lx: number, lz: number): number {
    const floor = this.floorTop(lx, lz) + 0.02;
    const wx = this.worldX(lx, lz);
    const wz = this.worldZ(lx, lz);
    const m = this.grid.height(wx, wz) + 0.04;
    const inward = PB.apothem - PB.wall / 2 - this.doorAlong(lx, lz);
    const across = this.doorAcross(lx, lz);
    const tw = 0.5 + 0.45 * Math.max(0, inward);
    const tongue =
      floor -
      0.02 +
      0.13 *
        Math.exp(-((across / tw) ** 2)) *
        (1 - smoothstep(0.1, 2.0, inward));
    const pool =
      this.floorTop(0, -(PB.apothem - PB.wall)) +
      0.22 +
      (fbm(wx * 0.9, wz * 0.9, 2) - 0.5) * 0.04;
    return Math.max(floor, m, tongue, pool);
  }
}

// ---------------------------------------------------------------------------
// Anti-tank cubes
// ---------------------------------------------------------------------------

interface Tooth {
  x: number;
  z: number;
  w: number;
  h: number;
  d: number;
  yaw: number;
  rx: number;
  rz: number;
  sink: number;
  pyramid: boolean;
  /** 0 beach, 1 dune, 2 toppled into the slump. */
  kind: number;
  /** Ground under the cube (filled once the skin is known). */
  y: number;
}

function planTeeth(rng: TexRng): Tooth[] {
  const p1: [number, number] = [TEETH_BREACH_X, faceZ(TEETH_BREACH_X)];
  const legs: Array<[readonly [number, number], readonly [number, number]]> = [
    [TEETH_P0, p1],
    [p1, TEETH_P2],
  ];
  const out: Tooth[] = [];
  let carry = 0;
  for (const [a, b] of legs) {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    const yaw = Math.atan2(-dz, dx);
    for (let t = carry; t <= len; t += TEETH_SPACING) {
      const x = a[0] + (dx / len) * t + rng.gauss() * 0.12;
      const z = a[1] + (dz / len) * t + rng.gauss() * 0.12;
      const s = z - faceZ(x);
      if (s > -2.9 && s < 2.6) continue; // the breach: these came down
      const beach = s <= -2.9;
      const w = rng.range(1.2, 1.5);
      const nearGap = Math.abs(s) < 4.4;
      out.push({
        x,
        z,
        w,
        h: w * rng.range(0.95, 1.05),
        d: w * rng.range(0.96, 1.04),
        yaw: yaw + rng.gauss() * 0.14,
        rx: nearGap ? -rng.range(0.1, 0.18) : rng.gauss() * 0.03,
        rz: nearGap ? rng.gauss() * 0.06 : rng.gauss() * 0.025,
        sink: beach ? rng.range(0.14, 0.24) : rng.range(0.1, 0.18),
        pyramid: rng.chance(0.4),
        kind: beach ? 0 : 1,
        y: 0,
      });
    }
    carry = ((len - carry) % TEETH_SPACING) - TEETH_SPACING;
    carry = -carry;
  }
  // Toppled where the scarp collapsed: rolled into the slump at the foot
  const xc = TEETH_BREACH_X;
  // (east of the last standing beach cube, clear of the pillbox door approach)
  const fallen: Array<[number, number, number, number, number, number]> = [
    // dx, s, yaw, rx, rz, sink
    [-0.5, -1.8, 0.3, 0.2, Math.PI / 2 + 0.12, 0.3],
    [0.4, -3.6, 0.6, 0.55, 0.1, 0.42],
    [2.7, -1.6, -0.4, 0.75, 0.35, 0.5],
  ];
  for (const [dx, s, yaw, rx, rz, sink] of fallen) {
    const x = xc + dx;
    const w = rng.range(1.25, 1.45);
    out.push({
      x,
      z: faceZ(x) + s,
      w,
      h: w,
      d: w * 1.02,
      yaw,
      rx,
      rz,
      sink,
      pyramid: rng.chance(0.5),
      kind: 2,
      y: 0,
    });
  }
  return out;
}

/** Cube (centred on its base centre, base at y = 0) with rebar stubs. */
function toothParts(t: Tooth, rng: TexRng): GeoList {
  const side = t.kind === 0 ? ER.teethBeach : ER.teethDune;
  const parts: GeoList = [];
  const body = atlasBox(t.w, t.h, t.d, side, ER.teethTop, rng.int(4));
  body.translate(0, t.h / 2, 0);
  parts.push(body);
  if (t.pyramid) {
    const rb = (t.w / 2) * Math.SQRT2 * 0.995;
    const ph = t.w * 0.28;
    const top = new THREE.CylinderGeometry(rb * 0.32, rb, ph, 4, 1);
    mapUv(top, ER.teethTop);
    top.rotateY(Math.PI / 4);
    top.translate(0, t.h + ph / 2, 0);
    parts.push(top);
  }
  const topY = t.h + (t.pyramid ? t.w * 0.28 : 0);
  const stubs = 1 + rng.int(2);
  for (let k = 0; k < stubs; k++) {
    const px = rng.range(-0.25, 0.25) * (t.pyramid ? 0.4 : 1);
    const pz = rng.range(-0.25, 0.25) * (t.pyramid ? 0.4 : 1);
    const up = rng.range(0.1, 0.22);
    const ang = rng.next() * Math.PI * 2;
    const bend = rng.range(0.1, 0.24);
    parts.push(bar([px, topY - 0.05, pz], [px, topY + up, pz], 0.014));
    parts.push(
      bar(
        [px, topY + up, pz],
        [
          px + Math.cos(ang) * bend,
          topY + up + bend * 0.35,
          pz + Math.sin(ang) * bend,
        ],
        0.013,
      ),
    );
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Pillbox geometry (local coordinates, floor top at y = 0)
// ---------------------------------------------------------------------------

interface WallPiece {
  face: number;
  a0: number;
  a1: number;
  b0: number;
  b1: number;
  y0: number;
  y1: number;
}

function hexVertex(r: number, k: number): [number, number] {
  const a = (k * Math.PI) / 3;
  return [Math.cos(a) * r, Math.sin(a) * r];
}

function buildPillbox(frame: PillboxFrame): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const rO = frame.rOuter;
  const rI = frame.rInner;

  const piece = (p: WallPiece): void => {
    const o0 = hexVertex(rO, p.face);
    const o1 = hexVertex(rO, p.face + 1);
    const i0 = hexVertex(rI, p.face);
    const i1 = hexVertex(rI, p.face + 1);
    const O = (a: number): [number, number] => [
      o0[0] + (o1[0] - o0[0]) * a,
      o0[1] + (o1[1] - o0[1]) * a,
    ];
    const I = (b: number): [number, number] => [
      i0[0] + (i1[0] - i0[0]) * b,
      i0[1] + (i1[1] - i0[1]) * b,
    ];
    const oa = O(p.a0);
    const ob = O(p.a1);
    const ia = I(p.b0);
    const ib = I(p.b1);
    const mid = [(oa[0] + ob[0]) / 2, (oa[1] + ob[1]) / 2];
    const nOut: [number, number, number] = [mid[0], 0, mid[1]];
    const vExt = (y: number) => y / 2.7;
    const vInt = (y: number) => y / 2.4;
    const uExt = (a: number) => (p.face + a) / 6;
    // Outer face
    pushQuad(
      pos,
      nor,
      uv,
      [
        [oa[0], p.y0, oa[1]],
        [ob[0], p.y0, ob[1]],
        [ob[0], p.y1, ob[1]],
        [oa[0], p.y1, oa[1]],
      ],
      [
        inRegion(ER.extWall, uExt(p.a0), vExt(p.y0)),
        inRegion(ER.extWall, uExt(p.a1), vExt(p.y0)),
        inRegion(ER.extWall, uExt(p.a1), vExt(p.y1)),
        inRegion(ER.extWall, uExt(p.a0), vExt(p.y1)),
      ],
      nOut,
    );
    // Inner face
    pushQuad(
      pos,
      nor,
      uv,
      [
        [ia[0], p.y0, ia[1]],
        [ib[0], p.y0, ib[1]],
        [ib[0], p.y1, ib[1]],
        [ia[0], p.y1, ia[1]],
      ],
      [
        inRegion(ER.intWall, uExt(p.b0), vInt(p.y0)),
        inRegion(ER.intWall, uExt(p.b1), vInt(p.y0)),
        inRegion(ER.intWall, uExt(p.b1), vInt(p.y1)),
        inRegion(ER.intWall, uExt(p.b0), vInt(p.y1)),
      ],
      [-nOut[0], 0, -nOut[2]],
    );
    // End faces (reveals of door / embrasures, hidden inside at corners)
    const tang: [number, number, number] = [ob[0] - oa[0], 0, ob[1] - oa[1]];
    for (const [pa, pb, dir] of [
      [oa, ia, -1],
      [ob, ib, 1],
    ] as const) {
      pushQuad(
        pos,
        nor,
        uv,
        [
          [pa[0], p.y0, pa[1]],
          [pb[0], p.y0, pb[1]],
          [pb[0], p.y1, pb[1]],
          [pa[0], p.y1, pa[1]],
        ],
        [
          inRegion(ER.reveal, 0.05, vInt(p.y0)),
          inRegion(ER.reveal, 0.95, vInt(p.y0)),
          inRegion(ER.reveal, 0.95, vInt(p.y1)),
          inRegion(ER.reveal, 0.05, vInt(p.y1)),
        ],
        [tang[0] * dir, 0, tang[2] * dir],
      );
    }
    // Top and bottom
    for (const [y, dir] of [
      [p.y1, 1],
      [p.y0, -1],
    ] as const) {
      pushQuad(
        pos,
        nor,
        uv,
        [
          [oa[0], y, oa[1]],
          [ob[0], y, ob[1]],
          [ib[0], y, ib[1]],
          [ia[0], y, ia[1]],
        ],
        [
          inRegion(ER.plain, 0.1, 0.1),
          inRegion(ER.plain, 0.9, 0.1),
          inRegion(ER.plain, 0.9, 0.4),
          inRegion(ER.plain, 0.1, 0.4),
        ],
        [0, dir, 0],
      );
    }
  };

  const full = (face: number, y0: number, y1: number): void =>
    piece({ face, a0: 0, a1: 1, b0: 0, b1: 1, y0, y1 });
  const doorFace: number = PB.doorFace;
  const slitFaces = [3, 4, 5];
  const door = (y0: number, y1: number): void => {
    piece({
      face: doorFace,
      a0: 0,
      a1: PB.doorA0,
      b0: 0,
      b1: PB.doorA0,
      y0,
      y1,
    });
    piece({
      face: doorFace,
      a0: PB.doorA1,
      a1: 1,
      b0: PB.doorA1,
      b1: 1,
      y0,
      y1,
    });
  };
  const bands: Array<[number, number, boolean]> = [
    [0, PB.slitY0, false],
    [PB.slitY0, PB.slitY1, true],
    [PB.slitY1, PB.doorH, false],
  ];
  for (const [y0, y1, slit] of bands) {
    for (let k = 0; k < 6; k++) {
      if (k === doorFace) {
        door(y0, y1);
      } else if (slit && slitFaces.includes(k)) {
        piece({ face: k, a0: 0, a1: PB.slitA0, b0: 0, b1: PB.slitB0, y0, y1 });
        piece({ face: k, a0: PB.slitA1, a1: 1, b0: PB.slitB1, b1: 1, y0, y1 });
      } else {
        full(k, y0, y1);
      }
    }
  }
  for (let k = 0; k < 6; k++) full(k, PB.doorH, PB.wallH);

  // Roof slab (small overhang) and floor slab: hexagon prisms
  const slab = (
    r: number,
    y0: number,
    y1: number,
    top: Region,
    bottom: Region,
    side: Region,
  ): void => {
    const planar = (v: [number, number], reg: Region): [number, number] =>
      inRegion(reg, v[0] / (2 * r) + 0.5, v[1] / (2 * r) + 0.5);
    for (let k = 0; k < 6; k++) {
      const a = hexVertex(r, k);
      const b = hexVertex(r, k + 1);
      // Fan triangles as quads that repeat the LAST corner (centre, a, b, b):
      // p1-p0 × p3-p0 = a × b is a real normal, so pushQuad() can flip the
      // winding (hexVertex() runs clockwise seen from above). Repeating the
      // centre instead gave a zero cross product and a culled roof/floor.
      pushQuad(
        pos,
        nor,
        uv,
        [
          [0, y1, 0],
          [a[0], y1, a[1]],
          [b[0], y1, b[1]],
          [b[0], y1, b[1]],
        ],
        [planar([0, 0], top), planar(a, top), planar(b, top), planar(b, top)],
        [0, 1, 0],
      );
      pushQuad(
        pos,
        nor,
        uv,
        [
          [0, y0, 0],
          [a[0], y0, a[1]],
          [b[0], y0, b[1]],
          [b[0], y0, b[1]],
        ],
        [
          planar([0, 0], bottom),
          planar(a, bottom),
          planar(b, bottom),
          planar(b, bottom),
        ],
        [0, -1, 0],
      );
      pushQuad(
        pos,
        nor,
        uv,
        [
          [a[0], y0, a[1]],
          [b[0], y0, b[1]],
          [b[0], y1, b[1]],
          [a[0], y1, a[1]],
        ],
        [
          inRegion(side, 0.05, 0.55),
          inRegion(side, 0.95, 0.55),
          inRegion(side, 0.95, 0.75),
          inRegion(side, 0.05, 0.75),
        ],
        [a[0] + b[0], 0, a[1] + b[1]],
      );
    }
  };
  slab(
    rO + 0.07,
    PB.wallH,
    PB.wallH + PB.roofT,
    ER.roofTop,
    ER.roofUnder,
    ER.plain,
  );
  slab(rI + 0.3, -PB.slabT, 0, ER.floor, ER.plain, ER.plain);

  const shell = geoFromArrays(pos, nor, uv);

  // Rusted stove-pipe stub near the seaward-left wall, elbow toward the wall
  const px = -0.8;
  const pz = -1.5;
  const pipe = [
    bar([px, -0.05, pz], [px + 0.02, 1.05, pz - 0.02], 0.065),
    bar([px + 0.02, 1.05, pz - 0.02], [px + 0.05, 1.22, pz - 0.2], 0.062),
    new THREE.CylinderGeometry(0.085, 0.085, 0.06, 8).translate(
      px + 0.01,
      0.55,
      pz - 0.01,
    ),
  ];
  mapUv(pipe[2], ER.rust);
  const merged = mergeGeometries([shell, ...pipe], false);
  shell.dispose();
  for (const g of pipe) g.dispose();
  if (!merged) throw new Error("BittenEdge: pillbox merge failed");
  merged.applyQuaternion(frame.q);
  merged.translate(PB.x, frame.cy, PB.z);
  return merged;
}

// ---------------------------------------------------------------------------
// The place
// ---------------------------------------------------------------------------

export class BittenEdge {
  protected readonly parent: THREE.Group;
  protected readonly quality: QualityId;
  private readonly group = new THREE.Group();
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly sandUniforms = {
    uWet: { value: 0 },
    uCloud: { value: 0 },
  };
  private readonly grid: TerrainGrid;
  private readonly face: FaceTable;
  private readonly pill: PillboxFrame;
  private readonly teeth: Tooth[];
  private wadMesh: THREE.InstancedMesh | null = null;
  private wadCount = 0;
  /** Construction time in ms (textures included on a cold cache). */
  readonly buildMs: number;
  /** Per-phase construction times in ms (dev diagnostics). */
  private readonly phases: Record<string, number> = {};

  constructor(parent: THREE.Group, quality: QualityId) {
    const t0 = performance.now();
    let tPhase = t0;
    const phase = (name: string): void => {
      const now = performance.now();
      this.phases[name] = Math.round((now - tPhase) * 10) / 10;
      tPhase = now;
    };
    this.parent = parent;
    this.quality = quality;
    this.group.name = "place-bitten-edge";
    parent.add(this.group);
    const hi = quality === "ultra" || quality === "high";
    // Concrete atlas height: 2048×1024 only on ultra, halved on high and
    // again on medium/low (the biggest boot item of the place)
    const atlas = quality === "ultra" ? 1024 : quality === "high" ? 512 : 256;
    const dx =
      quality === "ultra"
        ? 0.34
        : quality === "high"
          ? 0.5
          : quality === "medium"
            ? 0.75
            : 1;
    this.grid = new TerrainGrid(quality);
    this.face = new FaceTable(SX0, SX1, dx);
    this.pill = new PillboxFrame(this.grid);
    phase("table");
    const rng = new TexRng(0xb1773);
    this.teeth = planTeeth(rng);
    for (const t of this.teeth) t.y = this.groundBare(t.x, t.z);
    phase("teeth");

    // --- Skin: sand + strata, one geometry, two groups ---------------------
    const sandMat = new THREE.MeshStandardMaterial({
      map: sandAlbedo(),
      normalMap: sandNormal(),
      normalScale: new THREE.Vector2(0.7, 0.7),
      roughness: 0.95,
      metalness: 0,
    });
    this.weatherise(sandMat, "edge-sand");
    const faceMat = new THREE.MeshStandardMaterial();
    // The strata maps are read through uv1. Passing a `repeat` makes
    // applyPbr() assign CLONES of the cached textures (they share the GPU
    // image), so switching `channel` below cannot leak into other users of
    // the cached set.
    applyPbr(faceMat, scarpFacePbr(quality === "ultra" ? 512 : 256), [1, 1]);
    for (const t of [faceMat.map, faceMat.normalMap, faceMat.roughnessMap]) {
      if (t) t.channel = 1;
    }
    this.weatherise(faceMat, "edge-face");
    this.materials.push(sandMat, faceMat);
    phase("faceTexture");
    const skinGeo = this.buildSkin(rng);
    phase("skin");
    this.geometries.push(skinGeo);
    const skin = new THREE.Mesh(skinGeo, [sandMat, faceMat]);
    skin.castShadow = true;
    skin.receiveShadow = true;
    this.group.add(skin);

    // --- Root-mat wads along the lip ---------------------------------------
    const wadMat = new THREE.MeshStandardMaterial();
    applyPbr(wadMat, lipWadPbr());
    this.materials.push(wadMat);
    phase("wadTexture");
    this.wadMesh = this.buildWads(wadMat, rng, hi ? 0.85 : 1.3);
    this.group.add(this.wadMesh);
    phase("wads");

    // --- Concrete: cubes + pillbox -----------------------------------------
    const concMat = new THREE.MeshStandardMaterial();
    applyPbr(concMat, edgeConcretePbr(atlas));
    this.materials.push(concMat);
    phase("concreteTexture");
    const parts: GeoList = [];
    for (const t of this.teeth) {
      const list = toothParts(t, rng);
      for (const g of list) {
        g.translate(0, -t.h / 2, 0);
        g.rotateX(t.rx);
        g.rotateZ(t.rz);
        g.rotateY(t.yaw);
        g.translate(t.x, t.y + t.h / 2 - t.sink, t.z);
        parts.push(g);
      }
    }
    parts.push(buildPillbox(this.pill));
    const concGeo = mergeGeometries(parts, false);
    for (const g of parts) g.dispose();
    if (!concGeo) throw new Error("BittenEdge: concrete merge failed");
    concGeo.computeBoundingSphere();
    this.geometries.push(concGeo);
    const conc = new THREE.Mesh(concGeo, concMat);
    conc.castShadow = true;
    conc.receiveShadow = true;
    this.group.add(conc);
    phase("concrete");

    this.buildColliders();
    registerGround(TAG, (x, z) => this.groundAt(x, z));
    phase("colliders");
    this.buildMs = performance.now() - t0;
  }

  // ---------------------------------------------------------------------------
  // Heights
  // ---------------------------------------------------------------------------

  /** Wind-blown banks against the cubes (windward side) with a lee scour. */
  private banks(x: number, z: number): number {
    let h = 0;
    for (const t of this.teeth) {
      if (t.kind === 2) continue;
      const dx = x - t.x;
      const dz = z - t.z;
      if (dx * dx + dz * dz > 7) continue;
      const rw = t.w * 0.5 + 0.5;
      h += 0.34 * Math.exp(-((dx / rw) ** 2 + ((dz + 0.85) / 0.72) ** 2));
      h -= 0.07 * Math.exp(-((dx / 0.9) ** 2 + ((dz - 1.05) / 0.6) ** 2));
    }
    return h;
  }

  /** Drift ring round the pillbox and the tongue through its door. */
  private pillRelief(x: number, z: number, ana: number): number {
    const p = this.pill;
    const lx = p.localX(x, z);
    const lz = p.localZ(x, z);
    const hd = p.hexDist(lx, lz);
    const rho = hd - PB.apothem;
    if (rho > 3.8) return 0;
    const seaw = clamp(-lz / Math.max(0.6, hd), -1, 1);
    let h =
      0.5 *
      Math.exp(-((Math.max(rho, 0) / 1.15) ** 2)) *
      (0.8 + 0.4 * fbm(x * 0.9 + 1, z * 0.9, 2)) *
      (0.8 + 0.3 * seaw);
    const along = p.doorAlong(lx, lz);
    const doorT =
      (1 - smoothstep(0.75, 1.5, Math.abs(p.doorAcross(lx, lz)))) *
      smoothstep(1.0, 2.0, along);
    h *= 1 - 0.85 * doorT;
    h +=
      Math.max(0, p.doorSandY - ana) *
      doorT *
      (1 - smoothstep(2.3, 4.6, along));
    return h;
  }

  /** Sand rows of the skin (apron s ≤ FACE_S0, shelf s ≥ lipS). */
  private sandY(x: number, s: number, withBanks = true): number {
    const zf = this.face.zf(x);
    const z = zf + s;
    const ana = terrainHeight(x, z);
    const m = this.grid.height(x, z);
    const rf = this.face.rf(x);
    let relief = this.pillRelief(x, z, ana);
    if (withBanks) relief += this.banks(x, z);
    let edge: number;
    if (s <= FACE_S0) {
      // Slumped cones at the foot, decaying seaward
      const k = clamp((FACE_S0 - s) / 2.45, 0, 1);
      const coneVar = clamp(
        0.35 + (fbm(x * 0.5 + 3, 0.7, 2) - 0.45) * 2.2,
        0.15,
        1,
      );
      const slump =
        0.6 *
        rf *
        coneVar *
        (1 - k) *
        (1 - k) *
        (1 + 0.3 * (fbm(x * 1.7, s * 1.7, 2) - 0.5));
      relief += slump;
      edge = 1 - smoothstep(S_MIN, S_MIN + 1.6, s);
    } else {
      // Flat lip shelf at the full lip height, then the bench
      const lipY = this.face.lipY(x);
      relief += Math.max(0, lipY - ana) * (1 - smoothstep(1.4, 2.2, s));
      relief +=
        0.07 *
        rf *
        (fbm(x * 1.3, s * 1.3 + 7, 2) - 0.5) *
        (1 - smoothstep(2.5, 4.0, s));
      edge = smoothstep(S_MAX - 1.4, S_MAX, s);
    }
    // Western edge of the strip: relief fades in from the rendered sand
    edge = Math.max(edge, 1 - smoothstep(SX0, SX0 + SX_FADE, x));
    let y = ana + Math.max(relief, m - ana + 0.03);
    y = lerp(y, m - 0.015, edge);
    // (No tuck under the pillbox here: the strip has a hole there and the
    // hexagon-aligned local grid owns the wall crossing – see buildSkin.)
    return y;
  }

  /** Full skin height for any s (face rows interpolate without wobble). */
  private skinY(x: number, s: number): number {
    if (s <= FACE_S0) return this.sandY(x, s);
    const ls = this.face.ls(x);
    if (s >= ls) return this.sandY(x, s);
    const t = (s - FACE_S0) / (ls - FACE_S0);
    const yFoot = this.sandY(x, FACE_S0);
    const yLip = this.sandY(x, ls);
    const y = yFoot + (yLip - yFoot) * t;
    return Math.max(y, this.grid.height(x, this.face.zf(x) + s) + 0.04);
  }

  /** Ground for placing cubes: the skin without their own banks. */
  private groundBare(x: number, z: number): number {
    if (x >= SX0 && x <= SX1) {
      const s = z - this.face.zf(x);
      if (s > S_MIN && s < S_MAX) {
        if (s <= FACE_S0 || s >= this.face.ls(x))
          return this.sandY(x, s, false);
        return this.skinY(x, s);
      }
    }
    return Math.max(terrainHeight(x, z), this.grid.height(x, z));
  }

  /** Ground override: what the player stands on here (null = terrain). */
  private groundAt(x: number, z: number): number | null {
    if (x < SX0 || x > SX1) return null;
    const lx = this.pill.localX(x, z);
    const lz = this.pill.localZ(x, z);
    if (this.pill.insideRoom(lx, lz)) return this.pill.interiorY(lx, lz);
    const s = z - this.face.zf(x);
    if (s > S_MIN + 0.4 && s < S_MAX - 0.4) {
      const y = this.skinY(x, s);
      // At the strip's edges the skin lies on the RENDERED mesh while the
      // game's ground outside is the analytic terrain (they differ by up to
      // ~15 cm near the toe): blend so the hand-over has no step.
      const w =
        smoothstep(SX0, SX0 + SX_FADE, x) *
        (1 - smoothstep(SX1 - SX_FADE, SX1, x)) *
        smoothstep(S_MIN + 0.4, S_MIN + 2.0, s) *
        (1 - smoothstep(S_MAX - 1.8, S_MAX - 0.4, s));
      return w >= 1 ? y : lerp(terrainHeight(x, z), y, w);
    }
    if (s <= S_MIN + 0.4 && z > -20) {
      const b = this.banks(x, z);
      if (b > 0.01) return this.grid.height(x, z) + b - 0.012;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Skin geometry
  // ---------------------------------------------------------------------------

  private buildSkin(rng: TexRng): THREE.BufferGeometry {
    const pos: number[] = [];
    const uv: number[] = [];
    const uv1: number[] = [];
    const idxSand: number[] = [];
    const idxFace: number[] = [];
    const sandUv = (x: number, z: number): void => {
      uv.push((x + 410) / SAND_TILE_X, (420 - z) / SAND_TILE_Z);
    };
    const cols = this.face.n;
    const faceOk: boolean[] = [];
    // Strip vertices inside the pillbox footprint: the quads touching them
    // are dropped (a hole) and the local grid below takes over, so no strip
    // quad ever plunges from the drift ring down under the floor slab.
    const inPill: boolean[] = [];
    const pillHole = (x: number, z: number): boolean =>
      this.pill.hexDist(this.pill.localX(x, z), this.pill.localZ(x, z)) <
      PB.apothem + 0.02;
    for (let c = 0; c < cols; c++) {
      const x = this.face.x(c);
      const zf = this.face.zf(x);
      const rf = this.face.rf(x);
      const ls = this.face.ls(x);
      const yFoot = this.sandY(x, FACE_S0);
      const yLip = this.sandY(x, ls);
      // rf = clamp(rise / 3.6, 0, 1): identical to rise >= FACE_MIN_RISE
      faceOk.push(rf >= FACE_MIN_RISE / 3.6);
      // Strata uv: a slow world-space phase drift along x and a vertical warp
      // of the bands (zero at foot and lip) break the 8 m tile repeat
      const uFace = x / 8 + (fbm(x * 0.02 + 11, 1, 2) - 0.5) * 0.6;
      const vWarp = (fbm(x * 0.035 + 3, 0.5, 2) - 0.5) * 0.16;
      const push = (z: number, y: number, v: number): void => {
        pos.push(x, y, z);
        sandUv(x, z);
        uv1.push(uFace, clamp(v + vWarp * Math.sin(Math.PI * v), 0, 1));
        inPill.push(pillHole(x, z));
      };
      for (const s of APRON_ROWS) push(zf + s, this.sandY(x, s), 0);
      push(zf + FACE_S0, yFoot, 0);
      for (let k = 1; k < FACE_STEPS; k++) {
        const t = k / FACE_STEPS;
        const wobble =
          (fbm(x * 0.45 + 2, t * 2.2, 2) - 0.5) *
            0.5 *
            Math.sin(Math.PI * t) *
            rf +
          0.28 * rf * smoothstep(0.55, 0.85, t) * (1 - smoothstep(0.85, 1, t));
        const s = lerp(FACE_S0, ls, t) + wobble;
        const p = clamp(
          t +
            (fbm(x * 0.7, t * 2.5 + 9, 2) - 0.5) *
              0.1 *
              Math.sin(Math.PI * t) *
              rf,
          0,
          1,
        );
        let y = yFoot + (yLip - yFoot) * p;
        y = Math.max(y, this.grid.height(x, zf + s) + 0.04);
        push(zf + s, y, clamp((y - yFoot) / Math.max(0.2, yLip - yFoot), 0, 1));
      }
      push(zf + ls, yLip, 1);
      for (const s of SHELF_ROWS) push(zf + s, this.sandY(x, s), 1);
    }
    const faceRow0 = APRON_ROWS.length; // foot row
    const faceRow1 = faceRow0 + FACE_STEPS; // lip row
    for (let c = 0; c < cols - 1; c++) {
      for (let r = 0; r < ROWS - 1; r++) {
        const a = c * ROWS + r;
        const b = a + ROWS;
        if (inPill[a] || inPill[a + 1] || inPill[b] || inPill[b + 1]) continue;
        const face =
          r >= faceRow0 && r < faceRow1 && faceOk[c] && faceOk[c + 1];
        const idx = face ? idxFace : idxSand;
        idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }

    // Banks of the cubes out on the beach (beyond the strip): small patches
    for (const t of this.teeth) {
      if (t.kind !== 0 || t.z - faceZ(t.x) > S_MIN) continue;
      const N = 9;
      const R = 2.2;
      const base = pos.length / 3;
      for (let i = 0; i <= N; i++) {
        const x = t.x - R + (2 * R * i) / N;
        for (let j = 0; j <= N; j++) {
          const z = t.z - R - 0.6 + (2 * R * j) / N;
          const y =
            this.grid.height(x, z) + Math.max(0, this.banks(x, z)) - 0.012;
          pos.push(x, y, z);
          sandUv(x, z);
          uv1.push(0, 0);
        }
      }
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          const a = base + i * (N + 1) + j;
          const b = a + N + 1;
          idxSand.push(a, a + 1, b, b, a + 1, b + 1);
        }
      }
    }

    // Sand in and around the pillbox: a hexagon-aligned local grid (0.2 m)
    // that owns the interior (floor / tongue / pool), the drift ring outside
    // the walls (the same skin function, a hair below the strip where the two
    // overlap) and – crucially – the step between the two, which it keeps
    // inside the 0.4 m wall band so nothing visible plunges.
    {
      const p = this.pill;
      const step = 0.2;
      const half = 4.4;
      const n = Math.round((2 * half) / step);
      const base = pos.length / 3;
      for (let i = 0; i <= n; i++) {
        const lx = -half + i * step;
        for (let j = 0; j <= n; j++) {
          const lz = -half + j * step;
          const wx = p.worldX(lx, lz);
          const wz = p.worldZ(lx, lz);
          const hd = p.hexDist(lx, lz);
          const along = p.doorAlong(lx, lz);
          const inHex = hd < PB.apothem - 0.24;
          const inDoor =
            Math.abs(p.doorAcross(lx, lz)) < 0.62 &&
            along >= PB.apothem - PB.wall - 0.01 &&
            hd < PB.apothem + 0.62;
          const s = wz - faceZ(wx);
          const outside =
            this.skinY(wx, clamp(s, S_MIN + 0.5, S_MAX - 0.5)) - 0.005;
          let y: number;
          if (inHex || inDoor) {
            y = p.interiorY(lx, lz);
            if (along > PB.apothem) {
              y = lerp(
                y,
                outside,
                smoothstep(PB.apothem + 0.05, PB.apothem + 0.6, along),
              );
            }
          } else {
            y = outside;
          }
          pos.push(wx, y, wz);
          sandUv(wx, wz);
          uv1.push(0, 0);
        }
      }
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const a = base + i * (n + 1) + j;
          const b = a + n + 1;
          idxSand.push(a, a + 1, b, b, a + 1, b + 1);
        }
      }
    }

    // Slight grain on the apron so the slump does not read as a smooth sheet
    void rng;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute("uv1", new THREE.Float32BufferAttribute(uv1, 2));
    geo.setIndex([...idxSand, ...idxFace]);
    geo.addGroup(0, idxSand.length, 0);
    geo.addGroup(idxSand.length, idxFace.length, 1);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }

  // ---------------------------------------------------------------------------
  // Wads
  // ---------------------------------------------------------------------------

  private buildWads(
    mat: THREE.Material,
    rng: TexRng,
    spacing: number,
  ): THREE.InstancedMesh {
    // One wad: a low, wide root mat sunk into the lip (not a ball), two
    // sparse root strips hanging seaward, three crossed dead-marram cards on
    // top leaning out over the face.
    const parts: GeoList = [];
    const lump = new THREE.SphereGeometry(0.5, 8, 5);
    lump.scale(1.35, 0.15, 0.95);
    mapUv(lump, WR.lump);
    lump.translate(0, -0.02, -0.1);
    parts.push(lump);
    for (let k = 0; k < 2; k++) {
      const strip = new THREE.PlaneGeometry(0.34, 0.55);
      mapUv(strip, WR.fibres);
      strip.translate(0, -0.26, 0);
      strip.rotateY(k * 0.9 - 0.35);
      strip.translate(k * 0.24 - 0.12, 0.0, -0.42 - k * 0.05);
      parts.push(strip);
    }
    for (let k = 0; k < 3; k++) {
      const fan = new THREE.PlaneGeometry(0.8, 1.05);
      mapUv(fan, WR.tuft);
      fan.translate(0, 0.5, 0);
      fan.rotateX(-0.5);
      fan.rotateY((k * Math.PI) / 3 + 0.2);
      fan.translate(0, 0.02, -0.06);
      parts.push(fan);
    }
    const geo = mergeGeometries(parts, false);
    for (const g of parts) g.dispose();
    if (!geo) throw new Error("BittenEdge: wad merge failed");
    this.geometries.push(geo);

    const placements: THREE.Matrix4[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    // Clustered, not a picket fence: uneven spacing and a third of the slots
    // left empty, so the lip reads as torn turf rather than a hedge
    for (
      let x = WALL_X0 + 0.6;
      x < WALL_X1 - 0.6;
      x += spacing * rng.range(0.45, 1.7)
    ) {
      const rf = this.face.rf(x);
      if (rf < 0.45 || rng.chance(0.3)) continue;
      const s = this.face.ls(x) + 0.06;
      const y = this.skinY(x, s) - 0.03;
      const slope = this.face.zf(x + 0.5) - this.face.zf(x - 0.5);
      e.set(
        rng.gauss() * 0.12 - 0.08,
        Math.atan(slope) + rng.gauss() * 0.35,
        rng.gauss() * 0.1,
      );
      q.setFromEuler(e);
      const sc = rng.range(0.55, 1.45);
      m.compose(
        new THREE.Vector3(x, y, this.face.zf(x) + s),
        q,
        new THREE.Vector3(sc, sc * rng.range(0.85, 1.2), sc),
      );
      placements.push(m.clone());
    }
    // A few turf clods that have slid part-way down the face, tipped outward
    for (
      let x = WALL_X0 + 2.5;
      x < WALL_X1 - 2.5;
      x += spacing * rng.range(3.5, 7.5)
    ) {
      const rf = this.face.rf(x);
      if (rf < 0.6) continue;
      const t = rng.range(0.45, 0.8);
      const ls = this.face.ls(x);
      const s = lerp(FACE_S0, ls, t) - 0.08;
      const y = this.skinY(x, s) - 0.02;
      const slope = this.face.zf(x + 0.5) - this.face.zf(x - 0.5);
      e.set(
        -rng.range(0.9, 1.35),
        Math.atan(slope) + rng.gauss() * 0.4,
        rng.gauss() * 0.25,
      );
      q.setFromEuler(e);
      const sc = rng.range(0.6, 1.0);
      m.compose(
        new THREE.Vector3(x, y, this.face.zf(x) + s),
        q,
        new THREE.Vector3(sc, sc, sc),
      );
      placements.push(m.clone());
    }
    const mesh = new THREE.InstancedMesh(geo, mat, placements.length);
    for (let i = 0; i < placements.length; i++)
      mesh.setMatrixAt(i, placements[i]);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    this.wadCount = placements.length;
    return mesh;
  }

  // ---------------------------------------------------------------------------
  // Colliders
  // ---------------------------------------------------------------------------

  private buildColliders(): void {
    beginColliderSet(TAG);
    // The face: a chain of boxes following the scarp line
    const sMid = (FACE_S0 + 0.9) / 2;
    const segLen = (WALL_X1 - WALL_X0) / WALL_SEGMENTS;
    for (let k = 0; k < WALL_SEGMENTS; k++) {
      const xa = WALL_X0 + k * segLen;
      const xb = xa + segLen;
      const xm = (xa + xb) / 2;
      const za = faceZ(xa) + sMid;
      const zb = faceZ(xb) + sMid;
      const len = Math.hypot(xb - xa, zb - za);
      const yaw = Math.atan2(-(zb - za), xb - xa);
      let y0 = Number.POSITIVE_INFINITY;
      let y1 = Number.NEGATIVE_INFINITY;
      for (const x of [xa, xm, xb]) {
        const zf = faceZ(x);
        y0 = Math.min(y0, terrainHeight(x, zf - 1.0));
        y1 = Math.max(y1, terrainHeight(x, zf + 1.6));
      }
      addBoxCollider(
        (xa + xb) / 2,
        (za + zb) / 2,
        len / 2 + 0.15,
        0.875 + 0.25,
        yaw,
        y0 - 0.6,
        y1 + 0.5,
      );
    }
    // Cubes
    for (const t of this.teeth) {
      if (t.kind === 2) {
        const r = Math.max(t.w, t.h, t.d) * 0.55;
        addBoxCollider(t.x, t.z, r, r, t.yaw, t.y - 0.6, t.y + 1.3);
      } else {
        addBoxCollider(
          t.x,
          t.z,
          t.w / 2 + 0.03,
          t.d / 2 + 0.03,
          t.yaw,
          t.y - 0.6,
          t.y + t.h + 0.4,
        );
      }
    }
    // Pillbox walls (door face split, ≥ 1.0 m clear), stove pipe
    const p = this.pill;
    const side = p.rOuter; // side length equals the circumradius
    for (let k = 0; k < 6; k++) {
      const a = Math.PI / 6 + (k * Math.PI) / 3;
      const nx = Math.cos(a);
      const nz = Math.sin(a);
      const mid = PB.apothem - PB.wall / 2;
      const tx = -nz;
      const tz = nx;
      const spans: Array<[number, number]> =
        k === PB.doorFace
          ? [
              [-0.06, PB.doorA0],
              [PB.doorA1, 1.06],
            ]
          : [[-0.06, 1.06]];
      for (const [a0, a1] of spans) {
        const c = ((a0 + a1) / 2 - 0.5) * side;
        const lx = nx * mid + tx * c;
        const lz = nz * mid + tz * c;
        const wx = p.worldX(lx, lz);
        const wz = p.worldZ(lx, lz);
        const twx = tx * Math.cos(PB.yaw) + tz * Math.sin(PB.yaw);
        const twz = -tx * Math.sin(PB.yaw) + tz * Math.cos(PB.yaw);
        const yaw = Math.atan2(-twz, twx);
        addBoxCollider(
          wx,
          wz,
          ((a1 - a0) * side) / 2,
          PB.wall / 2 + 0.05,
          yaw,
          p.cy - 1.6,
          p.cy + 3.2,
        );
      }
    }
    const pipe = p.toWorld(-0.8, 0.5, -1.5);
    addCylinderCollider(pipe.x, pipe.z, 0.13, p.cy - 1, p.cy + 1.4);
  }

  // ---------------------------------------------------------------------------
  // Weather response, update, dispose, diagnostics
  // ---------------------------------------------------------------------------

  /** Rain-wet darkening and cloud grey-out, in step with the terrain sand. */
  private weatherise(mat: THREE.MeshStandardMaterial, key: string): void {
    mat.customProgramCacheKey = () => key;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uWet = this.sandUniforms.uWet;
      shader.uniforms.uCloud = this.sandUniforms.uCloud;
      shader.vertexShader =
        `varying vec3 vWorldPos;\n${shader.vertexShader}`.replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\n vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;",
        );
      shader.fragmentShader = `varying vec3 vWorldPos;
        uniform float uWet;
        uniform float uCloud;
        float beHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float beNoise(vec2 p) {
          vec2 i = floor(p); vec2 f = p - i;
          f = f * f * (3.0 - 2.0 * f);
          float a = beHash(i), b = beHash(i + vec2(1.0, 0.0));
          float c = beHash(i + vec2(0.0, 1.0)), d = beHash(i + vec2(1.0, 1.0));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }
        ${shader.fragmentShader}`.replace(
        "#include <map_fragment>",
        `#include <map_fragment>
         float pud = beNoise(vWorldPos.xz * 0.085) * 0.65
                   + beNoise(vWorldPos.xz * 0.31) * 0.35;
         float rainWet = uWet * (0.5 + 0.5 * smoothstep(0.32, 0.68, pud)) * 0.85;
         diffuseColor.rgb *= mix(1.0, 0.6, rainWet);
         float cGrey = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
         diffuseColor.rgb = mix(
           diffuseColor.rgb,
           vec3(cGrey) * vec3(0.97, 0.99, 1.05),
           uCloud * 0.42);`,
      );
    };
  }

  update(dt: number, env: Environment, _camPos: THREE.Vector3): void {
    const w = this.sandUniforms.uWet.value;
    const rate = env.rain > w ? 0.6 : 0.05;
    this.sandUniforms.uWet.value = w + (env.rain - w) * Math.min(1, dt * rate);
    this.sandUniforms.uCloud.value = env.cloud;
  }

  dispose(): void {
    this.parent.remove(this.group);
    // Instance attributes go with the InstancedMesh, the rest with the lists
    this.wadMesh?.dispose();
    this.wadMesh = null;
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    unregisterGround(TAG);
    clearColliderSet(TAG);
  }

  /** Dev harness: placement facts and the walk-in headroom of the pillbox. */
  debugInfo(): {
    pillbox: { x: number; z: number; floorY: number; doorSandY: number };
    headroom: Array<{
      lz: number;
      ground: number;
      ceiling: number;
      clear: number;
    }>;
    teeth: Array<{ x: number; z: number; y: number; kind: number }>;
    wads: number;
    buildMs: number;
    phases: Record<string, number>;
    colliders: Record<string, { boxes: number; cylinders: number }>;
  } {
    const p = this.pill;
    const headroom: Array<{
      lz: number;
      ground: number;
      ceiling: number;
      clear: number;
    }> = [];
    // Along the door axis (distance from the centre along the door normal)
    for (const lz of [2.6, 2.3, 2.1, 1.6, 1.0, 0.5, 0, -0.5, -1.0, -1.4]) {
      const lx0 = p.doorLocalX(lz);
      const lz0 = p.doorLocalZ(lz);
      const wx = p.worldX(lx0, lz0);
      const wz = p.worldZ(lx0, lz0);
      const ground = this.groundAt(wx, wz) ?? terrainHeight(wx, wz);
      const ceiling =
        lz > PB.apothem
          ? Number.POSITIVE_INFINITY
          : lz > PB.apothem - PB.wall
            ? p.planeY(lx0, PB.doorH, lz0)
            : p.planeY(lx0, PB.wallH, lz0);
      headroom.push({
        lz,
        ground: Math.round(ground * 100) / 100,
        ceiling: Math.round(ceiling * 100) / 100,
        clear: Math.round((ceiling - ground) * 100) / 100,
      });
    }
    return {
      pillbox: { x: PB.x, z: PB.z, floorY: p.cy, doorSandY: p.doorSandY },
      headroom,
      teeth: this.teeth.map((t) => ({
        x: Math.round(t.x * 10) / 10,
        z: Math.round(t.z * 10) / 10,
        y: Math.round(t.y * 100) / 100,
        kind: t.kind,
      })),
      wads: this.wadCount,
      buildMs: Math.round(this.buildMs * 10) / 10,
      phases: { ...this.phases },
      colliders: colliderStats(),
    };
  }
}
