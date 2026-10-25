// The Old Tip – a grassed-over council landfill mound in the far north-east,
// its seaward flank eroding into a scar of rusted metal, drum lids, cable and
// glass. The mound itself is terrain (landforms.ts OLD_TIP) and the live,
// pickable trash pocket comes from trash.ts; this module builds everything
// static: the exposed refuse strata of the scar face, the old debris that is
// half buried in it, the slumped cones at its foot, the boundary posts, the
// vent pipe and the council sign on the crown.
//
// Construction – four draw calls in the main pass:
//   1. skin    a displaced sheet over the scar face + debris cones and the
//              talus fan, textured with the chaotic waste-face set (aperiodic
//              – no banding) under warped UVs, blended into the terrain sand
//              by a per-vertex weight (aBlend) plus world-space noise;
//              wet/cloud response mirrors the terrain
//   2. turf    a continuous sward skin over the dome cap and shoulders with a
//              wide dithered fade into sand and a gravelly haul-road track on
//              the bench
//   3. atlas   every hard prop merged into one mesh on the tip atlas (vertex
//              tints for lids/drum), double-sided for the thin sheets/bags
//   4. plants  dock/thistle rosettes, rushes and brambles (vertex colours)
//
// The skin follows the RENDERED terrain: the analytic terraces (~1 m wide,
// 2.7 m risers) are finer than the terrain grid (2.7 m cells on ultra), so the
// mesh smooths them away. The skin samples the same grid interpolation and
// only rises above it, so it never sinks into the ground and the convex
// terrace lips reappear as slumped ledges. A ground override (ground.ts, tag
// "tip") lets player, jeep and dog walk ON the refuse bulges and cones instead
// of wading through them. Colliders are registered under the tag "tip".

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  addBoxCollider,
  addCylinderCollider,
  beginColliderSet,
  clearColliderSet,
} from "./colliders";
import { registerGround, unregisterGround } from "./ground";
import { OLD_TIP } from "./landforms";
import { fbm, smoothstep } from "./noise";
import {
  type Region,
  TR,
  pbrTipAtlas,
  pbrTipStrata,
  pbrTipTurf,
  subRegion,
} from "./place-tip-textures";
import type { Environment } from "./sky";
import { terrainHeight } from "./terrain";
import {
  type PbrMaps,
  type Rgb,
  TexRng,
  applyPbr,
  sandAlbedo,
  sandNormal,
} from "./textures";
import type { QualityId } from "./types";

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

const TX = OLD_TIP.x;
const TZ = OLD_TIP.z;
const YAW = OLD_TIP.yaw;
const CY = Math.cos(YAW);
const SY = Math.sin(YAW);

/** Skin extent in tip-local metres (lx along the long axis, −lz = seaward). */
const SKIN_LX = 11;
const SKIN_Z0 = -7.5;
const SKIN_Z1 = -25;
/** How far the skin border dips under the sand. */
const EDGE_SINK = 0.25;
/** Waste-face texture tile (m). */
const STRATA_TILE = 6;
/** Turf texture tile (m). */
const TURF_TILE = 3;
/** Sand texture tiling of the terrain mesh (world.ts) – the blend matches it. */
const SAND_TILE_X = 820 / 70;
const SAND_TILE_Z = 560 / 48;
/** Terrain grid of world.ts inside the play zone (uniform, unfiltered). */
const GRID_X0 = -410;
const GRID_W = 820;
const GRID_Z0 = -90;
const GRID_ZSPAN = 510;
const GRID_ZFULL = 560;

/** Tip-local → world (x, z). */
function toWorld(lx: number, lz: number): [number, number] {
  return [TX + lx * CY - lz * SY, TZ + lx * SY + lz * CY];
}

/** Rendered terrain height: the same grid interpolation as the terrain mesh. */
function meshHeight(x: number, z: number, seg: number): number {
  const stepX = GRID_W / seg;
  const segZ = Math.floor(seg * 0.7);
  const nZ = Math.max(1, Math.round(GRID_ZSPAN / (GRID_ZFULL / segZ)));
  const stepZ = GRID_ZSPAN / nZ;
  const fx = (x - GRID_X0) / stepX;
  const i = Math.floor(fx);
  const tx = fx - i;
  const fz = (z - GRID_Z0) / stepZ;
  const j = Math.floor(fz);
  const tz = fz - j;
  const x0 = GRID_X0 + i * stepX;
  const x1 = x0 + stepX;
  const z0 = GRID_Z0 + j * stepZ;
  const z1 = z0 + stepZ;
  if (tx + tz <= 1) {
    const h00 = terrainHeight(x0, z0);
    return (
      h00 +
      (terrainHeight(x1, z0) - h00) * tx +
      (terrainHeight(x0, z1) - h00) * tz
    );
  }
  const h11 = terrainHeight(x1, z1);
  return (
    h11 +
    (terrainHeight(x0, z1) - h11) * (1 - tx) +
    (terrainHeight(x1, z0) - h11) * (1 - tz)
  );
}

// ---------------------------------------------------------------------------
// Skin field (shared by the geometry and the ground override)
// ---------------------------------------------------------------------------

/**
 * 1 in the core of the scar, 0 at the skin border. The border wanders by
 * ±1 m so the seam never reads as a rectangle cut into the sand.
 */
function coreMask(lx: number, lz: number): number {
  const wx = (fbm(lz * 0.35 + 4.2, lx * 0.05, 2) - 0.375) * 2.6;
  const ex = 1 - smoothstep(7.8, SKIN_LX - 0.4, Math.abs(lx) + wx);
  const wz = (fbm(lx * 0.3 + 1.7, 0.3, 2) - 0.375) * 2.2;
  const top = smoothstep(SKIN_Z0, SKIN_Z0 - 2.4, lz + wz);
  const bot = smoothstep(SKIN_Z1, SKIN_Z1 + 2.8, lz - wz);
  return ex * top * bot;
}

/**
 * Refuse relief standing proud of the terrain: broad slump lobes, small
 * lumps and erosion gullies carving down the face (up to ~0.8 m of relief,
 * clamped just above the rendered mesh so hollows never dip under it).
 */
function bulge(lx: number, lz: number): number {
  let b =
    0.08 +
    (0.5 * fbm(lx * 0.32 + 3.3, lz * 0.32 + 1.1, 3)) / 0.875 +
    (0.22 * fbm(lx * 1.1 + 9, lz * 1.1, 2)) / 0.75;
  const gully = smoothstep(
    0.62,
    0.88,
    fbm(lx * 0.55 + 13, lz * 0.16 + 4, 3) / 0.9375,
  );
  b -= gully * 0.4;
  return b > 0.04 ? b : 0.04;
}

/** The landform's wobbled ellipse coordinate at a tip-local point. */
function wobbledE(lx: number, lz: number): number {
  const [x, z] = toWorld(lx, lz);
  const e0 = Math.hypot(lx / OLD_TIP.rx, lz / OLD_TIP.rz);
  return e0 * (1 + (fbm(x * 0.045 + 3.7, z * 0.045, 2) - 0.4375) * 0.24);
}

/** Distance from a tip-local point to a segment (haul-road ramp). */
function segDist(
  lx: number,
  lz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((lx - ax) * dx + (lz - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(lx - (ax + dx * t), lz - (az + dz * t));
}

interface Cone {
  lx: number;
  lz: number;
  r: number;
  h: number;
}

/** Slumped debris cones at the foot of the face (+ one mid-face slump). */
const CONES: Cone[] = [
  { lx: -5.5, lz: -19.2, r: 2.0, h: 0.55 },
  { lx: -1.2, lz: -19.8, r: 1.6, h: 0.45 },
  { lx: 2.8, lz: -18.9, r: 2.3, h: 0.6 },
  { lx: 6.5, lz: -19.6, r: 1.5, h: 0.4 },
  { lx: 0.8, lz: -16.2, r: 1.2, h: 0.35 },
];

function coneAdd(lx: number, lz: number): number {
  let add = 0;
  for (const c of CONES) {
    const dx = (lx - c.lx) / c.r;
    const dz = (lz - c.lz) / (c.r * 0.8);
    const d2 = dx * dx + dz * dz;
    if (d2 >= 1) continue;
    const f = 1 - d2;
    add +=
      c.h *
      f *
      Math.sqrt(f) *
      (0.85 + (0.3 * fbm(lx * 1.5 + 5, lz * 1.5, 2)) / 0.75);
  }
  return add;
}

/** Talus fan of slumped refuse and sand along the foot of the face. */
function talusAdd(lx: number, lz: number): number {
  const along =
    smoothstep(-18.2, -20.4, lz) * (1 - smoothstep(-21.8, -24.6, lz));
  const across = 1 - smoothstep(7.5, 10.5, Math.abs(lx));
  const n = 0.7 + (0.6 * fbm(lx * 1.1 + 2, lz * 1.1, 2)) / 0.75;
  return 0.34 * along * across * n;
}

/**
 * 1 where the turf cap covers the dome (following the landform's wobbled
 * outline), fading WIDE into sand past the shoulder; cut out of the scar
 * wedge along soft, wandering borders. No hard edge anywhere.
 */
function turfMask(lx: number, lz: number): number {
  const eW = wobbledE(lx, lz);
  let m = 1 - smoothstep(0.66, 1.02, eW);
  const wx = (fbm(lz * 0.3 + 1, 0.5, 2) - 0.375) * 3;
  const inX = 1 - smoothstep(9.5, 13, Math.abs(lx) + wx);
  const wz = (fbm(lx * 0.25 + 5, 0.2, 2) - 0.375) * 2.5;
  const inZ = smoothstep(-5.8, -8.2, lz + wz);
  m *= 1 - inX * inZ;
  return m;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

type GeoList = THREE.BufferGeometry[];
type BagKey = "atlas" | "plant";

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

/** Remap one box face (+x,-x,+y,-y,+z,-z = 0..5) from 0..1 into a region. */
function mapBoxFaceUv(
  geo: THREE.BoxGeometry,
  face: number,
  r: Region,
): THREE.BoxGeometry {
  const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = face * 4; i < face * 4 + 4; i++) {
    uv.setXY(
      i,
      r[0] + uv.getX(i) * (r[2] - r[0]),
      r[1] + uv.getY(i) * (r[3] - r[1]),
    );
  }
  return geo;
}

/**
 * Like mapBoxFaceUv but rotated 90° for a PORTRAIT region whose content was
 * drawn sideways (TR.sign2): plate-u runs along the region's v axis.
 */
function mapBoxFaceUvRot(
  geo: THREE.BoxGeometry,
  face: number,
  r: Region,
): THREE.BoxGeometry {
  const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = face * 4; i < face * 4 + 4; i++) {
    const u0 = uv.getX(i);
    const v0 = uv.getY(i);
    uv.setXY(i, r[0] + (1 - v0) * (r[2] - r[0]), r[1] + u0 * (r[3] - r[1]));
  }
  return geo;
}

function box(
  w: number,
  h: number,
  d: number,
  r: Region,
  x = 0,
  y = 0,
  z = 0,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  mapUv(g, r);
  g.translate(x, y, z);
  return g;
}

const UP = new THREE.Vector3(0, 1, 0);
const TV = new THREE.Vector3();
const TQ = new THREE.Quaternion();

/** Cylinder between two points, UVs into a region (u around, v along). */
function cylBetween(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  radius: number,
  seg: number,
  r: Region,
): THREE.BufferGeometry {
  const len = Math.hypot(bx - ax, by - ay, bz - az) || 1e-4;
  const g = new THREE.CylinderGeometry(radius, radius, len, seg, 1, false);
  mapUv(g, r);
  TV.set(bx - ax, by - ay, bz - az).normalize();
  TQ.setFromUnitVectors(UP, TV);
  g.applyQuaternion(TQ);
  g.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  return g;
}

/** Per-vertex colour attribute from a function of the local position. */
function vertexTint(
  geo: THREE.BufferGeometry,
  fn: (x: number, y: number, z: number) => Rgb,
): THREE.BufferGeometry {
  const p = geo.getAttribute("position") as THREE.BufferAttribute;
  const arr = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const c = fn(p.getX(i), p.getY(i), p.getZ(i));
    arr[i * 3] = c[0];
    arr[i * 3 + 1] = c[1];
    arr[i * 3 + 2] = c[2];
  }
  geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return geo;
}

/**
 * Collects geometries per material. Everything is handed over in tip-local
 * absolute coordinates and converted to world space here, so the merged
 * meshes sit at the origin.
 */
class TipBag {
  private readonly lists = new Map<BagKey, GeoList>();

  add(key: BagKey, g: THREE.BufferGeometry, color?: Rgb): void {
    let geo = g;
    if (g.index) {
      geo = g.toNonIndexed();
      g.dispose();
    }
    if (!geo.getAttribute("normal")) geo.computeVertexNormals();
    // Plants are vertex-coloured only: drop UVs so every part merges
    if (key === "plant" && geo.getAttribute("uv")) geo.deleteAttribute("uv");
    if (key === "atlas" && !geo.getAttribute("color")) {
      const n = geo.getAttribute("position").count;
      const c = color ?? [1, 1, 1];
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        arr[i * 3] = c[0];
        arr[i * 3 + 1] = c[1];
        arr[i * 3 + 2] = c[2];
      }
      geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
    }
    geo.rotateY(-YAW);
    geo.translate(TX, 0, TZ);
    let list = this.lists.get(key);
    if (!list) {
      list = [];
      this.lists.set(key, list);
    }
    list.push(geo);
  }

  build(key: BagKey): THREE.BufferGeometry | null {
    const list = this.lists.get(key);
    if (!list || list.length === 0) return null;
    const merged = mergeGeometries(list, false);
    for (const g of list) g.dispose();
    list.length = 0;
    if (!merged) throw new Error(`OldTip: mergeGeometries (${key}) failed`);
    merged.computeBoundingSphere();
    return merged;
  }
}

// ---------------------------------------------------------------------------
// Prop builders (item-local, base at y = 0)
// ---------------------------------------------------------------------------

interface TipDetail {
  hi: boolean;
  seg: number;
  atlas: number;
  skinNX: number;
  skinNZ: number;
  radial: number;
  sheetCols: number;
  sheetRows: number;
  sheets: number;
  lids: number;
  shards: number;
  cables: number;
  bags: number;
  plants: number;
  tubeSeg: number;
  turfNX: number;
  turfNZ: number;
  rushes: number;
  brambles: number;
  clasts: number;
}

function detailFor(quality: QualityId): TipDetail {
  const ultra = quality === "ultra";
  const hi = ultra || quality === "high";
  const med = quality === "medium";
  return {
    hi,
    seg: ultra ? 300 : hi ? 240 : med ? 170 : 120,
    atlas: hi ? 1024 : 512,
    skinNX: ultra ? 66 : hi ? 56 : med ? 44 : 34,
    skinNZ: ultra ? 51 : hi ? 43 : med ? 34 : 26,
    turfNX: ultra ? 96 : hi ? 76 : med ? 56 : 42,
    turfNZ: ultra ? 68 : hi ? 54 : med ? 40 : 30,
    rushes: ultra ? 40 : hi ? 30 : med ? 16 : 8,
    brambles: ultra ? 10 : hi ? 8 : med ? 4 : 2,
    clasts: ultra ? 50 : hi ? 40 : med ? 24 : 12,
    radial: hi ? 16 : 10,
    sheetCols: hi ? 4 : 2,
    sheetRows: hi ? 4 : 2,
    sheets: hi ? 6 : 4,
    lids: hi ? 8 : 5,
    shards: ultra ? 26 : hi ? 20 : 12,
    cables: hi ? 4 : 2,
    bags: hi ? 5 : 3,
    plants: ultra ? 30 : hi ? 22 : med ? 12 : 6,
    tubeSeg: hi ? 26 : 14,
  };
}

/**
 * Corrugated sheet in the XY plane (x along `len`, y up, profile in z) with
 * a mild storm warp and, optionally, a folded-over top corner.
 */
function corrSheet(
  len: number,
  h: number,
  cols: number,
  rows: number,
  seed: number,
  bent: boolean,
): THREE.BufferGeometry {
  const period = 0.076;
  const amp = 0.014;
  const periods = Math.max(2, Math.round(len / period));
  const n = periods * cols;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const r = TR.sheet;
  for (let c = 0; c <= n; c++) {
    const x = -len / 2 + (c / n) * len;
    const phase = (c / cols) * Math.PI * 2;
    for (let k = 0; k <= rows; k++) {
      const y = -h / 2 + (k / rows) * h;
      let z = amp * Math.sin(phase);
      z += (fbm(x * 2.2 + seed, y * 2.2, 2) - 0.375) * 0.05;
      if (bent && x > len * 0.15 && y > h * 0.1) {
        const f =
          ((x - len * 0.15) / (len * 0.35)) * ((y - h * 0.1) / (h * 0.4));
        z += f * f * 0.35;
      }
      pos.push(x, y, z);
      uv.push(
        r[0] + ((x + len / 2) / len) * (r[2] - r[0]),
        r[1] + ((y + h / 2) / h) * (r[3] - r[1]),
      );
    }
  }
  for (let c = 0; c < n; c++) {
    for (let k = 0; k < rows; k++) {
      const a = c * (rows + 1) + k;
      const b = a + rows + 1;
      idx.push(a, b, b + 1, a, b + 1, a + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // base at y = 0 (sheet stands on its lower edge)
  geo.translate(0, h / 2, 0);
  return geo;
}

/** Drum lid lying flat (faces +y), rim ring, base at y = 0. */
function drumLidParts(radial: number): GeoList {
  const disc = new THREE.CircleGeometry(0.29, radial);
  mapUv(disc, TR.lid);
  disc.rotateX(-Math.PI / 2);
  disc.translate(0, 0.04, 0);
  const rim = new THREE.CylinderGeometry(0.3, 0.3, 0.045, radial, 1, true);
  mapUv(rim, TR.steel);
  rim.translate(0, 0.022, 0);
  return [disc, rim];
}

/** Crushed 200 l drum lying on its side along x, base at y = 0. */
function crushedDrumParts(radial: number, seed: number): GeoList {
  const g = new THREE.CylinderGeometry(0.29, 0.29, 0.88, radial, 3, false);
  const sideCount = (radial + 1) * 4;
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const r = i < sideCount ? TR.drum : TR.lid;
    uv.setXY(
      i,
      r[0] + uv.getX(i) * (r[2] - r[0]),
      r[1] + uv.getY(i) * (r[3] - r[1]),
    );
  }
  g.rotateZ(Math.PI / 2);
  // Squash + dents
  const p = g.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i) * 0.58;
    const z = p.getZ(i) * 1.12;
    const dent =
      smoothstep(0.55, 0.8, fbm(x * 3 + seed, z * 3 + y * 2, 2) / 0.75) * 0.07;
    const rr = Math.hypot(y, z) || 1;
    p.setXYZ(i, x, y - (y / rr) * dent, z - (z / rr) * dent);
  }
  g.computeVertexNormals();
  g.translate(0, 0.29 * 0.58 + 0.01, 0);
  return [g];
}

/** Iron bedstead end: uprights with knobs, two rails, five bars. */
function bedsteadParts(seg: number): GeoList {
  const parts: GeoList = [];
  const r = TR.steel;
  for (const sx of [-0.45, 0.45]) {
    parts.push(cylBetween(sx, 0, 0, sx, 1.08, 0, 0.022, seg, r));
    const knob = new THREE.SphereGeometry(0.038, seg, Math.max(4, seg >> 1));
    mapUv(knob, r);
    knob.translate(sx, 1.11, 0);
    parts.push(knob);
  }
  parts.push(cylBetween(-0.45, 1.02, 0, 0.45, 1.02, 0, 0.02, seg, r));
  parts.push(cylBetween(-0.45, 0.42, 0, 0.45, 0.42, 0, 0.02, seg, r));
  for (let k = 0; k < 5; k++) {
    const x = -0.3 + k * 0.15;
    parts.push(
      cylBetween(x, 0.42, 0, x, 1.02, 0, 0.011, Math.max(5, seg >> 1), r),
    );
  }
  return parts;
}

/** Irregular flat glass shard standing on one edge (XY plane). */
function shardGeo(rng: TexRng): THREE.BufferGeometry {
  const n = 4 + rng.int(2);
  const size = rng.range(0.05, 0.16);
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const strip = rng.int(3);
  const r = subRegion(TR.glass, strip / 3, 0, (strip + 1) / 3, 1);
  pos.push(0, 0, 0);
  uv.push((r[0] + r[2]) / 2, (r[1] + r[3]) / 2);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const rad = size * rng.range(0.45, 1);
    const x = Math.cos(a) * rad;
    const y = Math.sin(a) * rad;
    pos.push(x, y, 0);
    uv.push(
      r[0] + (x / (2 * size) + 0.5) * (r[2] - r[0]),
      r[1] + (y / (2 * size) + 0.5) * (r[3] - r[1]),
    );
  }
  for (let k = 0; k < n; k++) idx.push(0, 1 + k, 1 + ((k + 1) % n));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.translate(0, size * 0.55, 0);
  return geo;
}

/** Concrete boundary post: square shaft with a pyramid top, base at y = 0. */
function postParts(height: number, broken: boolean): GeoList {
  const parts: GeoList = [];
  const shaftH = broken ? height : height - 0.14;
  parts.push(box(0.22, shaftH, 0.22, TR.concrete, 0, shaftH / 2, 0));
  if (!broken) {
    const cap = new THREE.CylinderGeometry(0.05, 0.156, 0.14, 4, 1, false);
    mapUv(cap, TR.concrete);
    cap.rotateY(Math.PI / 4);
    cap.translate(0, shaftH + 0.07, 0);
    parts.push(cap);
  }
  return parts;
}

/** Dock (broad, droopy) or thistle (narrow, spiky) rosette, vertex colours. */
function rosetteGeo(rng: TexRng, dock: boolean): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const leaves = dock ? 6 + rng.int(3) : 8 + rng.int(4);
  const red = dock && rng.chance(0.5);
  const c0: Rgb = dock ? [0.1, 0.19, 0.07] : [0.3, 0.4, 0.28];
  const c1: Rgb = dock
    ? red
      ? [0.42, 0.22, 0.12]
      : [0.32, 0.47, 0.16]
    : [0.56, 0.63, 0.5];
  for (let i = 0; i < leaves; i++) {
    const yaw = (i / leaves) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const len = dock ? rng.range(0.2, 0.34) : rng.range(0.14, 0.24);
    const w = dock ? rng.range(0.08, 0.12) : rng.range(0.03, 0.045);
    const hm = dock ? rng.range(0.06, 0.1) : rng.range(0.05, 0.09);
    const ht = hm + rng.range(-0.03, 0.05);
    const bright = rng.range(0.8, 1.15);
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const base = pos.length / 3;
    const push = (x: number, y: number, z: number, k: number): void => {
      pos.push(x * cy + z * sy, y, -x * sy + z * cy);
      col.push(
        (c0[0] + (c1[0] - c0[0]) * k) * bright,
        (c0[1] + (c1[1] - c0[1]) * k) * bright,
        (c0[2] + (c1[2] - c0[2]) * k) * bright,
      );
    };
    if (dock) {
      push(-0.012, 0.01, 0.02, 0);
      push(0.012, 0.01, 0.02, 0);
      push(-w / 2, hm, len * 0.5, 0.5);
      push(w / 2, hm, len * 0.5, 0.5);
      push(0, ht, len, 1);
      idx.push(base, base + 3, base + 1);
      idx.push(base, base + 2, base + 3);
      idx.push(base + 2, base + 4, base + 3);
    } else {
      push(-0.006, 0.01, 0.01, 0); // 0 L0
      push(0.006, 0.01, 0.01, 0); // 1 R0
      push(-w / 2, hm * 0.6, len * 0.35, 0.4); // 2 Lmid
      push(w / 2, hm * 0.6, len * 0.35, 0.4); // 3 Rmid
      push(-w * 1.3, hm * 0.75, len * 0.55, 0.75); // 4 spike L
      push(w * 1.3, hm * 0.75, len * 0.55, 0.75); // 5 spike R
      push(-w * 0.35, hm * 0.9, len * 0.7, 0.8); // 6 Lup
      push(w * 0.35, hm * 0.9, len * 0.7, 0.8); // 7 Rup
      push(0, ht, len, 1); // 8 tip
      idx.push(base, base + 3, base + 1);
      idx.push(base, base + 2, base + 3);
      idx.push(base + 2, base + 7, base + 3);
      idx.push(base + 2, base + 6, base + 7);
      idx.push(base + 6, base + 8, base + 7);
      idx.push(base + 2, base + 4, base + 6);
      idx.push(base + 3, base + 7, base + 5);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Soft-rush clump: a fan of stiff blades, dark green with straw dead ones. */
function rushGeo(rng: TexRng): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const blades = 10 + rng.int(8);
  for (let i = 0; i < blades; i++) {
    const yaw = rng.range(0, Math.PI * 2);
    const lean = rng.range(0.05, 0.4);
    const h = rng.range(0.35, 0.75);
    const w = rng.range(0.008, 0.014);
    const r0 = rng.range(0, 0.06);
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const dead = rng.chance(0.25);
    const c0: Rgb = dead ? [0.45, 0.4, 0.25] : [0.16, 0.26, 0.12];
    const c1: Rgb = dead ? [0.62, 0.55, 0.32] : [0.36, 0.45, 0.2];
    const base = pos.length / 3;
    const push = (x: number, y: number, z: number, k: number): void => {
      pos.push(x * cy + z * sy, y, -x * sy + z * cy);
      col.push(
        c0[0] + (c1[0] - c0[0]) * k,
        c0[1] + (c1[1] - c0[1]) * k,
        c0[2] + (c1[2] - c0[2]) * k,
      );
    };
    const mid = h * 0.55;
    push(-w, 0, r0, 0);
    push(w, 0, r0, 0);
    push(-w * 0.8, mid, r0 + lean * mid, 0.5);
    push(w * 0.8, mid, r0 + lean * mid, 0.5);
    push(0, h, r0 + lean * h * 1.3, 1);
    idx.push(base, base + 1, base + 3, base, base + 3, base + 2);
    idx.push(base + 2, base + 3, base + 4);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Bramble clump: arching purple-brown canes with paired leaves. */
function brambleParts(rng: TexRng, reach: number): GeoList {
  const parts: GeoList = [];
  const canes = 3 + rng.int(3);
  for (let c = 0; c < canes; c++) {
    const yaw = rng.range(0, Math.PI * 2);
    const len = reach * rng.range(0.6, 1.1);
    const hMax = rng.range(0.3, 0.6);
    const pts: THREE.Vector3[] = [];
    for (let s = 0; s <= 4; s++) {
      const t = s / 4;
      const d = t * len;
      const y = Math.sin(t * Math.PI) * hMax * (1 - t * 0.3) + 0.02;
      pts.push(
        new THREE.Vector3(
          Math.cos(yaw) * d + rng.range(-0.05, 0.05),
          y,
          Math.sin(yaw) * d + rng.range(-0.05, 0.05),
        ),
      );
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const tube = new THREE.TubeGeometry(curve, 8, 0.012, 4, false);
    const caneK = rng.range(0.85, 1.15);
    vertexTint(tube, () => [0.36 * caneK, 0.2 * caneK, 0.26 * caneK]);
    parts.push(tube);
    for (let l = 1; l <= 5; l++) {
      const p = curve.getPoint(l / 6);
      for (const side of [-1, 1]) {
        const leaf = new THREE.PlaneGeometry(0.09, 0.07);
        leaf.rotateX(-Math.PI / 2 + rng.range(-0.4, 0.4));
        leaf.rotateY(yaw + side * 1.2 + rng.range(-0.3, 0.3));
        leaf.translate(
          p.x + Math.cos(yaw + side * 1.57) * 0.05,
          p.y + 0.02,
          p.z + Math.sin(yaw + side * 1.57) * 0.05,
        );
        const lk = rng.range(0.8, 1.2);
        vertexTint(leaf, () => [0.17 * lk, 0.3 * lk, 0.13 * lk]);
        parts.push(leaf);
      }
    }
  }
  return parts;
}

/** Dock seed spike (rusty brown) with three short side branches. */
function dockSpikeParts(rng: TexRng): GeoList {
  const parts: GeoList = [];
  const h = rng.range(0.45, 0.8);
  const spike = new THREE.CylinderGeometry(0.006, 0.014, h, 5);
  spike.translate(0, h / 2, 0);
  const tilt = rng.range(-0.2, 0.2);
  spike.rotateX(tilt);
  const tint: Rgb = [0.45, 0.25, 0.12];
  vertexTint(spike, () => tint);
  parts.push(spike);
  for (let b = 0; b < 3; b++) {
    const y0 = h * rng.range(0.35, 0.75);
    const a = rng.range(0, Math.PI * 2);
    const br = new THREE.CylinderGeometry(0.008, 0.012, 0.14, 4);
    br.translate(0, 0.07, 0);
    br.rotateZ(0.8);
    br.rotateY(a);
    br.translate(0, y0, -Math.sin(tilt) * y0 * 0.5);
    vertexTint(br, () => tint);
    parts.push(br);
  }
  return parts;
}

const TIP_NOISE_GLSL = `
float tipHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float tipNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = p - i;
  f = f * f * (3.0 - 2.0 * f);
  float a = tipHash(i), b = tipHash(i + vec2(1.0, 0.0));
  float c = tipHash(i + vec2(0.0, 1.0)), d = tipHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}`;

// ---------------------------------------------------------------------------
// The place
// ---------------------------------------------------------------------------

export class OldTip {
  protected readonly parent: THREE.Group;
  protected readonly quality: QualityId;

  private readonly group = new THREE.Group();
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly det: TipDetail;
  /** Skin shader uniforms – kept in step with the terrain's wet/cloud look. */
  private readonly uWet: THREE.IUniform<number> = { value: 0 };
  private readonly uCloud: THREE.IUniform<number> = { value: 0 };
  private wetInit = false;
  /** Tip-local positions of the standing posts (plants keep clear). */
  private readonly postPos: Array<[number, number]> = [];

  constructor(parent: THREE.Group, quality: QualityId) {
    this.parent = parent;
    this.quality = quality;
    this.det = detailFor(quality);
    this.group.name = "place-tip";
    parent.add(this.group);

    // The walkable surface first: props and colliders sit on it
    registerGround("tip", (x, z) => this.skinGround(x, z));
    beginColliderSet("tip");

    this.buildSkin();
    this.buildTurf();
    const bag = new TipBag();
    const rng = new TexRng(0x71d0);
    this.buildScar(bag, rng);
    this.buildCrown(bag, rng);
    this.buildPlants(bag, rng);

    const atlasMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
    });
    applyPbr(atlasMat, pbrTipAtlas(this.det.atlas));
    this.materials.push(atlasMat);
    const atlasGeo = bag.build("atlas");
    if (atlasGeo) {
      this.geometries.push(atlasGeo);
      const mesh = new THREE.Mesh(atlasGeo, atlasMat);
      mesh.name = "tip-debris";
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }

    const plantMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.85,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    this.materials.push(plantMat);
    const plantGeo = bag.build("plant");
    if (plantGeo) {
      this.geometries.push(plantGeo);
      const mesh = new THREE.Mesh(plantGeo, plantMat);
      mesh.name = "tip-plants";
      mesh.castShadow = this.det.hi;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
  }

  // -------------------------------------------------------------------------
  // Ground
  // -------------------------------------------------------------------------

  /** Skin surface height (no cones) in tip-local coords; th = terrain there. */
  private skinY(
    lx: number,
    lz: number,
    x: number,
    z: number,
    th: number,
  ): number {
    const m = coreMask(lx, lz);
    const base = Math.max(th, meshHeight(x, z, this.det.seg));
    return base + bulge(lx, lz) * m - (1 - m) * EDGE_SINK;
  }

  /** Ground override: the refuse skin and the cones, null off the scar. */
  private skinGround(x: number, z: number): number | null {
    const wx = x - TX;
    const wz = z - TZ;
    if (wx * wx + wz * wz > 30 * 30) return null;
    const lx = wx * CY + wz * SY;
    const lz = -wx * SY + wz * CY;
    if (lx < -SKIN_LX || lx > SKIN_LX || lz > SKIN_Z0 || lz < SKIN_Z1) {
      return null;
    }
    const th = terrainHeight(x, z);
    const y = this.skinY(lx, lz, x, z, th) + coneAdd(lx, lz) + talusAdd(lx, lz);
    return y > th ? y : th;
  }

  /** Surface height under a tip-local point (skin where it exists). */
  private groundLocal(lx: number, lz: number): number {
    const [x, z] = toWorld(lx, lz);
    return this.skinGround(x, z) ?? terrainHeight(x, z);
  }

  // -------------------------------------------------------------------------
  // Skin
  // -------------------------------------------------------------------------

  private buildSkin(): void {
    const { skinNX: NX, skinNZ: NZ } = this.det;
    const pos: number[] = [];
    const uv: number[] = [];
    const blend: number[] = [];
    const idx: number[] = [];
    for (let j = 0; j <= NZ; j++) {
      const lz = SKIN_Z0 + (j / NZ) * (SKIN_Z1 - SKIN_Z0);
      for (let i = 0; i <= NX; i++) {
        const lx = -SKIN_LX + (i / NX) * 2 * SKIN_LX;
        const [x, z] = toWorld(lx, lz);
        const th = terrainHeight(x, z);
        const m = coreMask(lx, lz);
        const tal = talusAdd(lx, lz);
        const y = this.skinY(lx, lz, x, z, th) + tal;
        pos.push(x, y, z);
        // Warped UVs so the 6 m tile never repeats along a straight line
        uv.push(
          lx / STRATA_TILE + (fbm(lx * 0.23 + 3, lz * 0.23, 2) - 0.375) * 0.5,
          y / STRATA_TILE + (fbm(lx * 0.31 + 11, lz * 0.31, 2) - 0.375) * 0.5,
        );
        // Sand: the border, the flats (cover slumps onto the terraces) and a
        // patchy wash; erosion rills expose more refuse
        const gx = terrainHeight(x + 0.5, z) - terrainHeight(x - 0.5, z);
        const gz = terrainHeight(x, z + 0.5) - terrainHeight(x, z - 0.5);
        const slope = Math.hypot(gx, gz);
        const flat = 1 - smoothstep(0.35, 0.85, slope);
        const wash = (fbm(lx * 0.45 + 2, lz * 0.45 + 7, 2) - 0.375) * 0.9;
        const rill = smoothstep(
          0.55,
          0.8,
          fbm(lx * 0.8 + 11, lz * 0.15, 2) / 0.75,
        );
        // Fully sand well before the border dips under the terrain (the
        // surfaces cross at m ≈ 0.55), so the crossing line never shows
        const mB = smoothstep(0.5, 0.95, m);
        let b = 1 - mB + (0.6 * flat + 0.22 + wash - 0.3 * rill) * mB;
        b -= tal * 0.8; // the talus is loose refuse, not clean sand
        b = b < 0 ? 0 : b > 1 ? 1 : b;
        blend.push(b);
      }
    }
    // Winding: +i runs along +lx, +j seaward (−lz); (a, a+1, c) faces up
    for (let j = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const a = j * (NX + 1) + i;
        const c = a + NX + 1;
        idx.push(a, a + 1, c, a + 1, c + 1, c);
      }
    }
    // Debris cones: radial fans with planar UVs (they are loose heaps, not
    // strata); the outer ring dips under the skin so the rim never z-fights
    const RINGS = [0.36, 0.7, 1];
    const SEG = this.det.hi ? 18 : 12;
    for (const c of CONES) {
      const base = pos.length / 3;
      const push = (lx: number, lz: number, drop: number, bl: number): void => {
        const [x, z] = toWorld(lx, lz);
        const th = terrainHeight(x, z);
        const y =
          this.skinY(lx, lz, x, z, th) +
          coneAdd(lx, lz) +
          talusAdd(lx, lz) -
          drop;
        pos.push(x, y, z);
        uv.push(
          lx / STRATA_TILE +
            0.37 +
            (fbm(lx * 0.23 + 3, lz * 0.23, 2) - 0.375) * 0.5,
          lz / STRATA_TILE + (fbm(lx * 0.31 + 11, lz * 0.31, 2) - 0.375) * 0.5,
        );
        blend.push(bl);
      };
      push(c.lx, c.lz, 0, 0.15);
      for (const rr of RINGS) {
        for (let k = 0; k < SEG; k++) {
          const a = (k / SEG) * Math.PI * 2;
          const wob = 1 + (fbm(k * 0.9 + c.lx, c.lz, 1) - 0.5) * 0.25;
          const lx = c.lx + Math.cos(a) * c.r * rr * wob;
          const lz = c.lz + Math.sin(a) * c.r * 0.8 * rr * wob;
          push(lx, lz, rr >= 1 ? 0.04 : 0, rr >= 1 ? 0.45 : 0.15 + rr * 0.15);
        }
      }
      // Fans run anticlockwise in (lx, lz); reversed order so they face up
      for (let k = 0; k < SEG; k++) {
        const k1 = (k + 1) % SEG;
        idx.push(base, base + 1 + k1, base + 1 + k);
        for (let ring = 0; ring + 1 < RINGS.length; ring++) {
          const r0 = base + 1 + ring * SEG;
          const r1 = r0 + SEG;
          idx.push(r0 + k, r1 + k1, r1 + k, r0 + k, r0 + k1, r1 + k1);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute("aBlend", new THREE.Float32BufferAttribute(blend, 1));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    this.geometries.push(geo);

    const mat = this.makeBlendMaterial(
      pbrTipStrata(this.det.atlas),
      "tip-skin",
      0.3,
      0.7,
      0.7,
    );
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "tip-skin";
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  /**
   * Strata/turf material: the set's own maps, blended into the terrain sand
   * by the vertex weight aBlend and world-space noise – a soft three-octave
   * edge plus a thin sand dusting on the refuse – with the terrain's
   * wet/cloud response (world.ts).
   */
  private makeBlendMaterial(
    maps: PbrMaps,
    key: string,
    edge0: number,
    edge1: number,
    noiseAmp: number,
  ): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial();
    applyPbr(mat, maps);
    mat.customProgramCacheKey = () => key;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uWet = this.uWet;
      shader.uniforms.uCloud = this.uCloud;
      shader.uniforms.uSandMap = { value: sandAlbedo() };
      shader.uniforms.uSandNormal = { value: sandNormal() };
      shader.vertexShader =
        `attribute float aBlend;\nvarying float vBlend;\nvarying vec3 vWorldPos;\n${shader.vertexShader}`.replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\n vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\n vBlend = aBlend;",
        );
      const normalChunk = THREE.ShaderChunk.normal_fragment_maps
        .split("texture2D( normalMap, vNormalMapUv ).xyz")
        .join(
          "mix( texture2D( normalMap, vNormalMapUv ).xyz, texture2D( uSandNormal, tipSandUv ).xyz, tipSand )",
        );
      shader.fragmentShader = `varying float vBlend;
        varying vec3 vWorldPos;
        uniform float uWet;
        uniform float uCloud;
        uniform sampler2D uSandMap;
        uniform sampler2D uSandNormal;
        ${TIP_NOISE_GLSL}
        float tipSand;
        float tipWet;
        vec2 tipSandUv;
        ${shader.fragmentShader}`
        .replace(
          "#include <map_fragment>",
          `#include <map_fragment>
         tipSandUv = vec2((vWorldPos.x + 410.0) / ${SAND_TILE_X.toFixed(5)}, (420.0 - vWorldPos.z) / ${SAND_TILE_Z.toFixed(5)});
         float tn = tipNoise(vWorldPos.xz * 0.8) * 0.5 + tipNoise(vWorldPos.xz * 3.1) * 0.3 + tipNoise(vWorldPos.xz * 9.3) * 0.2;
         float sEdge = smoothstep(${edge0.toFixed(2)}, ${edge1.toFixed(2)}, vBlend + (tn - 0.5) * ${noiseAmp.toFixed(2)});
         float dust = 0.14 * tipNoise(vWorldPos.xz * 6.7) * smoothstep(0.05, 0.4, vBlend);
         tipSand = mix(dust, 1.0, sEdge);
         vec3 sandCol = texture2D(uSandMap, tipSandUv).rgb;
         diffuseColor.rgb = mix(diffuseColor.rgb, sandCol, tipSand);
         float pud = tipNoise(vWorldPos.xz * 0.085) * 0.65 + tipNoise(vWorldPos.xz * 0.31) * 0.35;
         tipWet = uWet * (0.5 + 0.5 * smoothstep(0.32, 0.68, pud)) * 0.85;
         diffuseColor.rgb *= mix(1.0, 0.6, tipWet);
         float cGrey = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
         diffuseColor.rgb = mix(
           diffuseColor.rgb,
           vec3(cGrey) * vec3(0.97, 0.99, 1.05),
           uCloud * 0.42 * mix(0.5, 1.0, tipSand));`,
        )
        .replace(
          "#include <roughnessmap_fragment>",
          `#include <roughnessmap_fragment>
         roughnessFactor = mix(roughnessFactor, 0.92, tipSand);
         roughnessFactor = mix(roughnessFactor, 0.35, tipWet);`,
        )
        .replace("#include <normal_fragment_maps>", normalChunk);
    };
    this.materials.push(mat);
    return mat;
  }

  // -------------------------------------------------------------------------
  // Turf cap
  // -------------------------------------------------------------------------

  /**
   * Terrain-hugging turf over the crown and upper flanks (e < ~0.8), cut out
   * of the scar wedge, following the rendered grid like the scar skin. Bare
   * sandy patches and the rim blend into the terrain sand. No colliders –
   * the flanks stay drivable.
   */
  private buildTurf(): void {
    const { turfNX: NX, turfNZ: NZ } = this.det;
    const LX = OLD_TIP.rx * 1.02;
    const LZ = OLD_TIP.rz * 1.02;
    const cols = NX + 1;
    const pos: number[] = [];
    const uv: number[] = [];
    const blend: number[] = [];
    const idx: number[] = [];
    const keep = new Uint8Array(cols * (NZ + 1));
    for (let j = 0; j <= NZ; j++) {
      const lz = -LZ + (j / NZ) * 2 * LZ;
      for (let i = 0; i <= NX; i++) {
        const lx = -LX + (i / NX) * 2 * LX;
        const e = Math.hypot(lx / OLD_TIP.rx, lz / OLD_TIP.rz);
        keep[j * cols + i] = e < 1.08 ? 1 : 0;
        const [x, z] = toWorld(lx, lz);
        const th = terrainHeight(x, z);
        const m = turfMask(lx, lz);
        const base = Math.max(th, meshHeight(x, z, this.det.seg));
        const bump = (0.07 * fbm(lx * 1.3 + 4, lz * 1.3 + 2, 2)) / 0.75;
        const y = base + 0.03 + bump * m - (1 - m) * 0.2;
        pos.push(x, y, z);
        uv.push(lx / TURF_TILE, lz / TURF_TILE);
        // Continuous sward: only subtle wear inside, a wide dithered fade at
        // the rim, and the old haul road as a gravelly track on the bench
        const mB = smoothstep(0.3, 0.9, m);
        const wear =
          0.2 *
          smoothstep(0.55, 0.8, fbm(lx * 0.35 + 7, lz * 0.35 + 2, 3) / 0.875);
        const eW = wobbledE(lx, lz);
        const bench =
          smoothstep(0.53, 0.6, eW) * (1 - smoothstep(0.64, 0.72, eW));
        const ramp =
          1 - smoothstep(2.2, 3.6, segDist(lx, lz, -16.5, 2.5, -29, 7.5));
        const track = Math.max(bench * 0.8, ramp * 0.85);
        let b = 1 - mB + (0.05 + wear + track) * mB;
        b = b < 0 ? 0 : b > 1 ? 1 : b;
        blend.push(b);
      }
    }
    // +i runs along +lx, +j along +lz: (a, c, a+1) faces up
    for (let j = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const a = j * cols + i;
        const c = a + cols;
        if (!(keep[a] || keep[a + 1] || keep[c] || keep[c + 1])) continue;
        idx.push(a, c, a + 1, a + 1, c, c + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute("aBlend", new THREE.Float32BufferAttribute(blend, 1));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    this.geometries.push(geo);
    const mat = this.makeBlendMaterial(
      pbrTipTurf(this.det.atlas),
      "tip-turf",
      0.08,
      0.92,
      1.15,
    );
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "tip-turf";
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  // -------------------------------------------------------------------------
  // Scar debris
  // -------------------------------------------------------------------------

  /**
   * Place item-local parts (base at y = 0) at a tip-local point on the ground:
   * tilt, yaw (π = facing seaward), then sink into the surface.
   */
  private place(
    bag: TipBag,
    key: BagKey,
    parts: GeoList,
    lx: number,
    lz: number,
    yaw: number,
    sink: number,
    tiltX = 0,
    tiltZ = 0,
    color?: Rgb,
  ): number {
    const y = this.groundLocal(lx, lz) - sink;
    for (const g of parts) {
      if (tiltX) g.rotateX(tiltX);
      if (tiltZ) g.rotateZ(tiltZ);
      g.rotateY(yaw);
      g.translate(lx, y, lz);
      bag.add(key, g, color);
    }
    return y;
  }

  /** Box collider for an item placed with place(): world frame, tip yaw. */
  private boxCollider(
    lx: number,
    lz: number,
    hx: number,
    hz: number,
    yaw: number,
    y0: number,
    y1: number,
  ): void {
    const [x, z] = toWorld(lx, lz);
    addBoxCollider(x, z, hx, hz, yaw - YAW, y0, y1);
  }

  private cylCollider(
    lx: number,
    lz: number,
    r: number,
    y0: number,
    y1: number,
  ): void {
    const [x, z] = toWorld(lx, lz);
    addCylinderCollider(x, z, r, y0, y1);
  }

  private buildScar(bag: TipBag, rng: TexRng): void {
    const det = this.det;
    const F = Math.PI; // facing seaward
    const steelTint: Rgb = [1, 1, 1];

    // Half-buried corrugated sheets leaning out of the risers
    const sheets: Array<
      [number, number, number, number, number, number, number, boolean]
    > = [
      [-6.6, -9.5, 0.3, 1.9, 0.9, 0.55, 0.42, true],
      [3.4, -9.8, 0.15, 1.7, 0.9, 0.65, 0.5, false],
      [-2.0, -12.3, -0.4, 1.4, 0.8, 0.35, 0.38, false],
      [1.2, -17.6, 1.6, 2.0, 0.9, 1.45, 0.3, true],
      [6.8, -13.6, 0.9, 1.2, 0.7, 1.25, 0.25, false],
      [-4.4, -15.2, -0.2, 1.6, 0.85, 0.5, 0.4, false],
    ];
    for (let k = 0; k < Math.min(det.sheets, sheets.length); k++) {
      const [lx, lz, dy, len, h, tilt, sink, bent] = sheets[k];
      const g = corrSheet(len, h, det.sheetCols, det.sheetRows, k * 3.7, bent);
      const y = this.place(bag, "atlas", [g], lx, lz, F + dy, sink, tilt, 0);
      if (k < 2) {
        this.boxCollider(lx, lz, len / 2, 0.25, F + dy, y - 0.2, y + h * 0.5);
      }
    }

    // Drum lids embedded like coins
    const lidTints: Rgb[] = [
      [0.45, 0.6, 0.85],
      [0.85, 0.35, 0.3],
      [0.4, 0.62, 0.4],
      [1, 1, 1],
      [0.9, 0.8, 0.35],
    ];
    const lids: Array<[number, number]> = [
      [-8, -11],
      [-3.2, -10.2],
      [0.5, -13.7],
      [2.2, -11.1],
      [5.5, -11.9],
      [-1.1, -16.5],
      [7.6, -16.9],
      [-6.2, -17.3],
    ];
    for (let k = 0; k < Math.min(det.lids, lids.length); k++) {
      const [lx, lz] = lids[k];
      const parts = drumLidParts(det.radial);
      this.place(
        bag,
        "atlas",
        parts,
        lx,
        lz,
        F + rng.range(-1, 1),
        rng.range(0.06, 0.16),
        rng.range(0.45, 1.25),
        rng.range(-0.3, 0.3),
        lidTints[k % lidTints.length],
      );
    }

    // Crushed drum at the foot
    {
      const parts = crushedDrumParts(det.hi ? 20 : 12, 4.1);
      const y = this.place(
        bag,
        "atlas",
        parts,
        4.6,
        -18.2,
        F + 0.4,
        0.14,
        0,
        0.05,
        [0.5, 0.62, 0.8],
      );
      this.boxCollider(4.6, -18.2, 0.5, 0.36, F + 0.4, y - 0.2, y + 0.42);
    }

    // Cable tangles: loose loops of rusted wire rope in and out of the strata
    const cableAt: Array<[number, number, number]> = [
      [-7.2, -13.9, 0.9],
      [1.8, -15.4, 0.75],
      [5.2, -10.6, 0.65],
      [-3.6, -8.9, 0.8],
    ];
    for (let k = 0; k < Math.min(det.cables, cableAt.length); k++) {
      const [cx, cz, cr] = cableAt[k];
      const pts: THREE.Vector3[] = [];
      const n = 7;
      for (let p = 0; p < n; p++) {
        const a = (p / n) * Math.PI * 2 + rng.range(-0.25, 0.25);
        const rr = cr * rng.range(0.5, 1.2);
        const lx = cx + Math.cos(a) * rr;
        const lz = cz + Math.sin(a) * rr * 0.7;
        const y = this.groundLocal(lx, lz) + rng.range(-0.08, 0.2);
        pts.push(new THREE.Vector3(lx, y, lz));
      }
      const curve = new THREE.CatmullRomCurve3(pts, true, "catmullrom", 0.6);
      const tube = new THREE.TubeGeometry(
        curve,
        det.tubeSeg,
        0.016,
        det.hi ? 6 : 4,
        true,
      );
      mapUv(tube, TR.steel);
      bag.add("atlas", tube, steelTint);
    }

    // Glass shards glinting in the face
    for (let k = 0; k < det.shards; k++) {
      const lx = rng.range(-8.5, 8.5);
      const lz = rng.range(-18.6, -9);
      this.place(
        bag,
        "atlas",
        [shardGeo(rng)],
        lx,
        lz,
        rng.range(0, Math.PI * 2),
        0.02,
        rng.range(-0.6, 0.6),
        rng.range(-0.5, 0.5),
      );
    }

    // Torn bin-bag remnants (and one half-buried tarpaulin) draped over the
    // surface – the last entry is the tarp, on the talus at the foot
    const bagAt: Array<[number, number, number, number]> = [
      [-5.0, -12.5, 0.5, 0],
      [2.9, -15.2, 0.42, 0],
      [-0.6, -10.8, 0.38, 0],
      [7.0, -17.0, 0.46, 0],
      [-7.8, -17.6, 0.4, 0],
      [4.9, -19.8, 1.2, 1],
    ];
    for (let k = 0; k < Math.min(det.bags + 1, bagAt.length); k++) {
      const [cx, cz, br, tarp] = bagAt[k];
      const SEG = det.hi ? 14 : 10;
      const RINGS = [0.45, 0.8, 1];
      const pos: number[] = [];
      const uv: number[] = [];
      const idx: number[] = [];
      const r = tarp
        ? subRegion(TR.bag, 0.5, 0, 1, 1)
        : subRegion(TR.bag, 0, 0, 0.5, 1);
      const pushV = (lx: number, lz: number, lift: number): void => {
        const y = this.groundLocal(lx, lz) + 0.012 + lift;
        pos.push(lx, y, lz);
        uv.push(
          r[0] + ((lx - cx) / (2 * br) + 0.5) * (r[2] - r[0]),
          r[1] + ((lz - cz) / (2 * br) + 0.5) * (r[3] - r[1]),
        );
      };
      pushV(cx, cz, 0.05 + rng.range(0, 0.04));
      for (const rr of RINGS) {
        for (let s = 0; s < SEG; s++) {
          const a = (s / SEG) * Math.PI * 2;
          const torn = rr >= 1 ? rng.range(0.55, 1.15) : 1;
          const lx = cx + Math.cos(a) * br * rr * torn;
          const lz = cz + Math.sin(a) * br * rr * torn * 0.85;
          const crease =
            (fbm(lx * 6 + k, lz * 6, 2) - 0.375) * 0.06 * (1 - rr * 0.7);
          pushV(lx, lz, rr >= 1 ? 0 : 0.03 * (1 - rr) + crease);
        }
      }
      for (let s = 0; s < SEG; s++) {
        const s1 = (s + 1) % SEG;
        idx.push(0, 1 + s1, 1 + s);
        for (let ring = 0; ring + 1 < RINGS.length; ring++) {
          const r0 = 1 + ring * SEG;
          const r1 = r0 + SEG;
          idx.push(r0 + s, r1 + s1, r1 + s, r0 + s, r0 + s1, r1 + s1);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      bag.add("atlas", g, [1, 1, 1]);
    }

    // Bedstead end leaning out of the middle riser
    {
      const y = this.place(
        bag,
        "atlas",
        bedsteadParts(det.hi ? 8 : 6),
        -2.6,
        -13.4,
        F + 0.2,
        0.5,
        0.55,
        0.06,
      );
      this.boxCollider(-2.6, -13.4, 0.5, 0.14, F + 0.2, y - 0.2, y + 0.75);
    }

    // Tyre half sunk into the lower riser
    {
      const torus = new THREE.TorusGeometry(
        0.28,
        0.1,
        det.hi ? 10 : 7,
        det.hi ? 28 : 18,
      );
      mapUv(torus, TR.tyre);
      torus.rotateX(Math.PI / 2);
      torus.translate(0, 0.1, 0);
      const y = this.place(
        bag,
        "atlas",
        [torus],
        5.8,
        -17.4,
        F + 0.3,
        0.12,
        0.5,
        0.1,
        [1, 1, 1],
      );
      this.cylCollider(5.8, -17.4, 0.36, y - 0.2, y + 0.28);
    }

    // A boundary post that toppled off the rim and slid onto the top riser
    {
      const parts = postParts(1.25, false);
      for (const g of parts) g.rotateZ(Math.PI / 2 - 0.08); // lying along +x
      const yaw = F + 1.25;
      const lx = 2.0;
      const lz = -10.0;
      const hx = Math.cos(yaw) * 0.6;
      const hz = -Math.sin(yaw) * 0.6;
      const tiltZ = Math.atan2(
        this.groundLocal(lx + hx, lz + hz) - this.groundLocal(lx - hx, lz - hz),
        1.2,
      );
      const y = this.place(
        bag,
        "atlas",
        parts,
        lx,
        lz,
        yaw,
        0.06,
        0,
        tiltZ,
        [0.92, 0.92, 0.9],
      );
      this.boxCollider(lx, lz, 0.65, 0.14, yaw, y - 0.2, y + 0.24);
    }

    // Debris pushing OUT of the face – two more tyres (edge-on, half out),
    // a drum end-on, open pipe ends and sheet corners: depth, not decal
    const tyreAt: Array<[number, number, number, number, number]> = [
      [-0.4, -11.9, F + Math.PI / 2, 0.25, 0.3],
      [7.3, -12.6, F - 0.5, 1.2, 0.12],
    ];
    for (const [lx, lz, yw, tilt, sink] of tyreAt) {
      const t = new THREE.TorusGeometry(
        0.34,
        0.11,
        det.hi ? 10 : 7,
        det.hi ? 28 : 18,
      );
      mapUv(t, TR.tyre);
      t.translate(0, 0.45, 0);
      const y = this.place(
        bag,
        "atlas",
        [t],
        lx,
        lz,
        yw,
        sink,
        tilt,
        0,
        [1, 1, 1],
      );
      this.cylCollider(lx, lz, 0.4, y - 0.2, y + 0.6);
    }
    {
      const R = det.hi ? 20 : 12;
      const g = new THREE.CylinderGeometry(0.29, 0.29, 0.88, R, 1, false);
      const sideCount = (R + 1) * 2;
      const duv = g.getAttribute("uv") as THREE.BufferAttribute;
      for (let i = 0; i < duv.count; i++) {
        const r = i < sideCount ? TR.drum : TR.lid;
        duv.setXY(
          i,
          r[0] + duv.getX(i) * (r[2] - r[0]),
          r[1] + duv.getY(i) * (r[3] - r[1]),
        );
      }
      // axis out of the face, 40° above horizontal
      g.rotateX(0.88);
      g.translate(0, 0.12, 0);
      const y = this.place(
        bag,
        "atlas",
        [g],
        -5.2,
        -12.8,
        F + 0.15,
        0.34,
        0,
        0.08,
        [0.62, 0.36, 0.3],
      );
      this.boxCollider(-5.2, -12.8, 0.34, 0.34, F + 0.15, y - 0.2, y + 0.5);
    }
    const pipeAt: Array<[number, number, number, number, number]> = [
      [3.9, -14.9, 0.1, 0.55, 0.25],
      [-7.6, -9.2, 0.14, 0.45, 0.5],
      [0.9, -9.4, 0.065, 0.65, 0.15],
    ];
    for (const [lx, lz, pr, len, down] of pipeAt) {
      const R = det.hi ? 12 : 8;
      const tube = new THREE.CylinderGeometry(pr, pr, len, R, 1, true);
      mapUv(tube, TR.steel);
      const bore = new THREE.CylinderGeometry(
        pr * 0.88,
        pr * 0.88,
        len * 0.6,
        R,
        1,
        true,
      );
      mapUv(bore, TR.steel);
      bore.translate(0, len * 0.2, 0);
      vertexTint(bore, () => [0.12, 0.1, 0.09]);
      const back = new THREE.CircleGeometry(pr * 0.88, R);
      mapUv(back, TR.steel);
      back.rotateX(-Math.PI / 2);
      back.translate(0, -len * 0.1, 0);
      vertexTint(back, () => [0.06, 0.05, 0.05]);
      const parts = [tube, bore, back];
      for (const p of parts) {
        p.rotateX(Math.PI / 2 + down); // +y → out of the face, tipping down
        p.translate(0, pr + 0.03, 0);
      }
      this.place(bag, "atlas", parts, lx, lz, F + rng.range(-0.4, 0.4), 0);
    }
    const cornerAt: Array<[number, number, number, number]> = [
      [6.2, -9.6, F + 0.6, 0.9],
      [-3.0, -16.3, F - 0.4, 0.75],
    ];
    for (const [lx, lz, yw, tilt] of cornerAt) {
      const g = corrSheet(0.7, 0.55, det.sheetCols, 2, 7.7, false);
      this.place(bag, "atlas", [g], lx, lz, yw, 0.28, tilt, 0.3);
    }

    // Crushed white goods – two dented washer-sized blocks part-buried
    const goodsAt: Array<[number, number, number, number]> = [
      [2.4, -17.2, F + 0.5, 0.26],
      [-6.9, -14.4, F - 0.7, 0.34],
    ];
    for (const [lx, lz, yw, sink] of goodsAt) {
      const g = new THREE.BoxGeometry(0.62, 0.64, 0.62, 2, 2, 2);
      mapUv(g, TR.galv);
      const p = g.getAttribute("position") as THREE.BufferAttribute;
      for (let vi = 0; vi < p.count; vi++) {
        const px = p.getX(vi);
        const py = p.getY(vi);
        const pz = p.getZ(vi);
        const d = (fbm(px * 4 + lx, py * 4 + pz * 3, 2) - 0.375) * 0.14;
        p.setXYZ(
          vi,
          px - Math.sign(px) * Math.abs(d) * 0.6,
          py - Math.abs(d) * 0.4,
          pz - Math.sign(pz) * Math.abs(d),
        );
      }
      g.computeVertexNormals();
      g.translate(0, 0.3, 0);
      const y = this.place(
        bag,
        "atlas",
        [g],
        lx,
        lz,
        yw,
        sink,
        rng.range(-0.2, 0.2),
        rng.range(-0.3, 0.3),
        [0.98, 0.98, 0.96],
      );
      this.boxCollider(lx, lz, 0.36, 0.36, yw, y - 0.2, y + 0.55);
    }

    // Rebar tangle sprung out of a shattered concrete lump
    {
      const cx = -0.9;
      const cz = -15.6;
      const lump = box(0.5, 0.3, 0.4, TR.concrete);
      lump.translate(0, 0.12, 0);
      const parts: GeoList = [lump];
      for (let n = 0; n < 7; n++) {
        const a = rng.range(0, Math.PI * 2);
        const curve = new THREE.CatmullRomCurve3([
          new THREE.Vector3(
            rng.range(-0.15, 0.15),
            0.15,
            rng.range(-0.12, 0.12),
          ),
          new THREE.Vector3(
            Math.cos(a) * 0.45,
            rng.range(0.3, 0.7),
            Math.sin(a) * 0.4,
          ),
          new THREE.Vector3(
            Math.cos(a) * rng.range(0.6, 1.0),
            rng.range(0.05, 0.5),
            Math.sin(a) * rng.range(0.5, 0.9),
          ),
        ]);
        const tube = new THREE.TubeGeometry(curve, 6, 0.013, 4, false);
        mapUv(tube, TR.steel);
        parts.push(tube);
      }
      const y = this.place(bag, "atlas", parts, cx, cz, F + 0.9, 0.1, 0.1, 0);
      this.boxCollider(cx, cz, 0.4, 0.35, F + 0.9, y - 0.2, y + 0.4);
    }

    // Gas warning sign at the seaward toe, facing the beach approach
    {
      const R = Math.max(8, det.radial >> 1);
      const post = new THREE.CylinderGeometry(0.03, 0.03, 1.5, R);
      mapUv(post, TR.steel);
      post.translate(0, 0.75, 0);
      const plate = new THREE.BoxGeometry(0.85, 0.55, 0.018);
      for (let f = 0; f < 6; f++) {
        if (f === 4) mapBoxFaceUvRot(plate, f, TR.sign2);
        else mapBoxFaceUv(plate, f, TR.steel);
      }
      plate.translate(0, 1.18, 0.025);
      const y = this.place(
        bag,
        "atlas",
        [post, plate],
        -6.5,
        -23.4,
        Math.PI + YAW - 0.2,
        0.35,
        0.06,
        -0.04,
      );
      this.cylCollider(-6.5, -23.4, 0.09, y - 0.3, y + 1.4);
    }

    // Talus: clasts of concrete, brick and clinker slumped at the foot
    for (let k = 0; k < det.clasts; k++) {
      const lx = rng.range(-9, 9);
      const lz = -17.3 - rng.range(0, 4.6) * (1 - Math.abs(lx) / 12);
      const s = rng.range(0.1, 0.32);
      const g = box(
        s,
        s * rng.range(0.5, 0.9),
        s * rng.range(0.6, 1.1),
        TR.concrete,
      );
      const brick = rng.chance(0.3);
      const tint: Rgb = brick
        ? [0.72, 0.4, 0.32]
        : [rng.range(0.5, 0.85), rng.range(0.5, 0.8), rng.range(0.45, 0.75)];
      this.place(
        bag,
        "atlas",
        [g],
        lx,
        lz,
        rng.range(0, 6.3),
        s * 0.25,
        rng.range(-0.5, 0.5),
        rng.range(-0.5, 0.5),
        tint,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Crown
  // -------------------------------------------------------------------------

  private buildCrown(bag: TipBag, rng: TexRng): void {
    const det = this.det;

    // Concrete boundary posts around the crown edge (the seaward one fell)
    /** [k, lx, lz, yTop] of each standing, unbroken post – for the fence. */
    const fencePts: Array<[number, number, number, number]> = [];
    const N = 9;
    for (let k = 0; k < N; k++) {
      const th = (k / N) * Math.PI * 2 + 0.2 + rng.range(-0.12, 0.12);
      const lx = 0.4 * OLD_TIP.rx * Math.cos(th);
      const lz = 0.4 * OLD_TIP.rz * Math.sin(th);
      if (k === 6) continue; // the seaward one – it fell down the scar
      const broken = k === 4;
      const height = broken ? 0.7 : 1.35;
      const lean = k === 2 ? 0.14 : k === 6 ? 0.19 : rng.range(-0.03, 0.03);
      const tint = rng.range(0.86, 1);
      const y = this.place(
        bag,
        "atlas",
        postParts(height, broken),
        lx,
        lz,
        rng.range(0, Math.PI * 2),
        0.3,
        lean,
        rng.range(-0.04, 0.04),
        [tint, tint, tint * 0.98],
      );
      this.cylCollider(lx, lz, 0.17, y - 0.3, y + height - 0.2);
      this.postPos.push([lx, lz]);
      if (!broken) fencePts.push([k, lx, lz, y + height]);
    }

    // Remnant perimeter fence: two sagging wire strands between neighbouring
    // posts (some strands gone), plus one fallen panel slid onto the scar rim
    for (let f = 0; f + 1 < fencePts.length; f++) {
      const [ka, ax, az, ay] = fencePts[f];
      const [kb, bx, bz, by] = fencePts[f + 1];
      if (kb - ka !== 1) continue;
      for (const drop of [0.22, 0.68]) {
        if (rng.chance(0.28)) continue;
        const y0 = ay - drop;
        const y1 = by - drop;
        const sag = 0.16 + rng.range(0, 0.12);
        const tube = new THREE.TubeGeometry(
          new THREE.CatmullRomCurve3([
            new THREE.Vector3(ax, y0, az),
            new THREE.Vector3(
              (ax + bx) / 2,
              (y0 + y1) / 2 - sag,
              (az + bz) / 2,
            ),
            new THREE.Vector3(bx, y1, bz),
          ]),
          det.hi ? 8 : 5,
          det.hi ? 0.009 : 0.012,
          4,
          false,
        );
        mapUv(tube, TR.steel);
        bag.add("atlas", tube, [1, 1, 1]);
      }
    }
    {
      const parts: GeoList = [];
      const fw = 1.7;
      const fh = 0.85;
      const t = 0.035;
      parts.push(box(fw, t, t, TR.steel, 0, 0.02, 0));
      parts.push(box(fw, t, t, TR.steel, 0, 0.02, fh));
      for (const px of [-fw / 2 + 0.02, fw / 2 - 0.02])
        parts.push(box(t, t, fh, TR.steel, px, 0.02, fh / 2));
      for (let wxi = 0; wxi < 4; wxi++) {
        const px = -fw / 2 + 0.2 + wxi * 0.42;
        parts.push(
          cylBetween(px, 0.02, 0, px + 0.12, 0.02, fh, 0.006, 4, TR.steel),
        );
      }
      const y = this.place(
        bag,
        "atlas",
        parts,
        -3.3,
        -9.2,
        YAW + 0.9,
        0.05,
        0.25,
        0.1,
        [1, 1, 1],
      );
      this.boxCollider(-3.3, -9.2, 0.9, 0.5, YAW + 0.9, y - 0.1, y + 0.35);
    }

    // Rusted vent pipe with cowl + capped gas wellheads
    {
      const R = det.radial;
      const parts: GeoList = [];
      const pipe = new THREE.CylinderGeometry(0.15, 0.15, 2.5, R, 1, true);
      mapUv(pipe, TR.galv);
      pipe.translate(0, 1.25, 0);
      // rust creeping up from the foot as a vertex tint
      vertexTint(pipe, (_x, y) => {
        const t = 1 - smoothstep(0.1, 1.1, y);
        return [1 - t * 0.45, 1 - t * 0.6, 1 - t * 0.7];
      });
      parts.push(pipe);
      const flange = new THREE.CylinderGeometry(0.27, 0.27, 0.06, R);
      mapUv(flange, TR.steel);
      flange.translate(0, 0.03, 0);
      parts.push(flange);
      const collar = new THREE.CylinderGeometry(0.17, 0.17, 0.12, R, 1, true);
      mapUv(collar, TR.galv);
      collar.translate(0, 2.5, 0);
      parts.push(collar);
      for (let s = 0; s < 3; s++) {
        const a = (s / 3) * Math.PI * 2;
        parts.push(
          cylBetween(
            Math.cos(a) * 0.13,
            2.52,
            Math.sin(a) * 0.13,
            Math.cos(a) * 0.16,
            2.7,
            Math.sin(a) * 0.16,
            0.012,
            5,
            TR.steel,
          ),
        );
      }
      const cowl = new THREE.CylinderGeometry(0.02, 0.31, 0.2, R);
      mapUv(cowl, TR.galv);
      cowl.translate(0, 2.78, 0);
      parts.push(cowl);
      const y = this.place(bag, "atlas", parts, 2.5, 1.5, 0.3, 0, 0, 0.015);
      this.cylCollider(2.5, 1.5, 0.24, y - 0.4, y + 2.9);
    }
    for (const [lx, lz] of [
      [-6.0, -1.5],
      [5.5, 4.0],
      [0.8, 7.6],
    ]) {
      const R = Math.max(8, det.radial >> 1);
      const stub = new THREE.CylinderGeometry(0.075, 0.075, 0.62, R, 1, true);
      mapUv(stub, TR.galv);
      stub.translate(0, 0.31, 0);
      vertexTint(stub, (_x, y) => {
        const t = 1 - smoothstep(0.05, 0.45, y);
        return [1 - t * 0.4, 1 - t * 0.55, 1 - t * 0.65];
      });
      const cap = new THREE.CylinderGeometry(0.095, 0.095, 0.05, R);
      mapUv(cap, TR.steel);
      cap.translate(0, 0.65, 0);
      // capped tee + valve spindle wheel: it reads as a gas wellhead
      const tee = cylBetween(0, 0.42, 0, 0.24, 0.42, 0, 0.045, R, TR.steel);
      const teeCap = new THREE.CylinderGeometry(0.055, 0.055, 0.04, R);
      mapUv(teeCap, TR.steel);
      teeCap.rotateZ(Math.PI / 2);
      teeCap.translate(0.26, 0.42, 0);
      const wheel = new THREE.TorusGeometry(0.055, 0.011, 5, 10);
      mapUv(wheel, TR.steel);
      wheel.rotateX(Math.PI / 2);
      wheel.translate(0, 0.72, 0);
      const y = this.place(
        bag,
        "atlas",
        [stub, cap, tee, teeCap, wheel],
        lx,
        lz,
        rng.range(0, 3),
        0.02,
        rng.range(-0.05, 0.05),
        rng.range(-0.05, 0.05),
      );
      this.cylCollider(lx, lz, 0.16, y - 0.3, y + 0.7);
      this.postPos.push([lx, lz]);
    }

    // Landfill-gas flare stack: a 4 m shrouded stack on a concrete pad with
    // a knock-out pot, gas line, guy wires and a control cabinet – the tip's
    // skyline cue from the seaward approach
    {
      const R = det.radial;
      const parts: GeoList = [];
      const FX = -4.5;
      const FZ = 3.5;
      const FYAW = 0.4;
      parts.push(box(2.6, 0.16, 2.6, TR.concrete, 0, 0.08, 0));
      const flange = new THREE.CylinderGeometry(0.42, 0.42, 0.1, R);
      mapUv(flange, TR.steel);
      flange.translate(0, 0.21, 0);
      parts.push(flange);
      const stack = new THREE.CylinderGeometry(0.25, 0.27, 5.5, R, 1, true);
      mapUv(stack, TR.galv);
      stack.translate(0, 2.95, 0);
      vertexTint(stack, (_x, y) => {
        const t = 1 - smoothstep(0.3, 1.6, y);
        return [0.34 + t * 0.25, 0.35 + t * 0.1, 0.37 - t * 0.05];
      });
      parts.push(stack);
      const shroud = new THREE.CylinderGeometry(0.46, 0.42, 1.0, R, 1, true);
      mapUv(shroud, TR.galv);
      shroud.translate(0, 6.2, 0);
      vertexTint(shroud, () => [0.3, 0.3, 0.32]);
      parts.push(shroud);
      const shroudIn = new THREE.CylinderGeometry(0.4, 0.36, 0.9, R, 1, true);
      mapUv(shroudIn, TR.steel);
      shroudIn.translate(0, 6.2, 0);
      vertexTint(shroudIn, () => [0.12, 0.1, 0.09]);
      parts.push(shroudIn);
      const rim = new THREE.TorusGeometry(0.46, 0.03, 6, R);
      mapUv(rim, TR.steel);
      rim.rotateX(Math.PI / 2);
      rim.translate(0, 6.7, 0);
      parts.push(rim);
      const plate = new THREE.CircleGeometry(0.4, R);
      mapUv(plate, TR.steel);
      plate.rotateX(-Math.PI / 2);
      plate.translate(0, 5.8, 0);
      vertexTint(plate, () => [0.1, 0.09, 0.08]);
      parts.push(plate);
      // knock-out pot + gas line with an elbow into the stack
      const pot = new THREE.CylinderGeometry(0.28, 0.28, 0.9, R);
      mapUv(pot, TR.drum);
      pot.translate(1.5, 0.61, -0.2);
      vertexTint(pot, () => [0.55, 0.58, 0.55]);
      parts.push(pot);
      parts.push(
        cylBetween(1.5, 1.06, -0.2, 1.5, 1.35, -0.2, 0.06, 8, TR.steel),
      );
      parts.push(cylBetween(1.5, 1.35, -0.2, 0.25, 1.35, 0, 0.06, 8, TR.steel));
      const elbow = new THREE.SphereGeometry(0.075, 8, 6);
      mapUv(elbow, TR.steel);
      elbow.translate(1.5, 1.35, -0.2);
      parts.push(elbow);
      // guy wires to three ground anchors
      for (let s = 0; s < 3; s++) {
        const a = (s / 3) * Math.PI * 2 + 0.6;
        const ax = Math.cos(a) * 3.2;
        const az = Math.sin(a) * 3.2;
        parts.push(
          cylBetween(
            Math.cos(a) * 0.27,
            5.3,
            Math.sin(a) * 0.27,
            ax,
            0.25,
            az,
            0.008,
            4,
            TR.steel,
          ),
        );
        parts.push(box(0.12, 0.5, 0.12, TR.steel, ax, 0.1, az));
      }
      // control cabinet on two legs
      const cab = box(0.7, 0.9, 0.35, TR.sheet, -1.4, 1.05, 0.6);
      vertexTint(cab, () => [0.5, 0.6, 0.5]);
      parts.push(cab);
      parts.push(box(0.05, 0.6, 0.05, TR.steel, -1.7, 0.3, 0.6));
      parts.push(box(0.05, 0.6, 0.05, TR.steel, -1.1, 0.3, 0.6));
      const y = this.place(bag, "atlas", parts, FX, FZ, FYAW, 0.05, 0, 0.012);
      // colliders: stack, pot and cabinet (offsets rotated by the item yaw)
      const rot = (ox: number, oz: number): [number, number] => [
        FX + ox * Math.cos(FYAW) + oz * Math.sin(FYAW),
        FZ - ox * Math.sin(FYAW) + oz * Math.cos(FYAW),
      ];
      this.cylCollider(FX, FZ, 0.45, y - 0.4, y + 7.0);
      const [px, pz] = rot(1.5, -0.2);
      this.cylCollider(px, pz, 0.32, y - 0.4, y + 1.1);
      const [cx, cz] = rot(-1.4, 0.6);
      this.boxCollider(cx, cz, 0.38, 0.2, FYAW, y - 0.4, y + 1.5);
    }

    // Enamel council sign on a steel post at the south-western rim
    {
      const R = Math.max(8, det.radial >> 1);
      const post = new THREE.CylinderGeometry(0.035, 0.035, 2.1, R);
      mapUv(post, TR.steel);
      post.translate(0, 1.05, 0);
      const plate = new THREE.BoxGeometry(1.0, 0.62, 0.02);
      // Each face from its pristine 0..1 UVs: enamel on +z, steel elsewhere
      for (let f = 0; f < 6; f++) {
        mapBoxFaceUv(plate, f, f === 4 ? TR.sign : TR.steel);
      }
      plate.translate(0, 1.62, 0.03);
      // clamps
      const clampA = box(0.12, 0.05, 0.05, TR.steel, 0, 1.36, 0.01);
      const clampB = box(0.12, 0.05, 0.05, TR.steel, 0, 1.88, 0.01);
      const yawWorld = -2.356; // faces south-west, towards the approach
      const yaw = yawWorld + YAW;
      const y = this.place(
        bag,
        "atlas",
        [post, plate, clampA, clampB],
        -10.5,
        -2.5,
        yaw,
        0.4,
        0.05,
        -0.03,
      );
      this.cylCollider(-10.5, -2.5, 0.1, y - 0.3, y + 2.0);
    }
  }

  // -------------------------------------------------------------------------
  // Plants
  // -------------------------------------------------------------------------

  /** A free spot for a plant: off the scar, clear of the built props. */
  private plantSpot(
    rng: TexRng,
    eMin: number,
    eMax: number,
  ): [number, number] | null {
    for (let tries = 0; tries < 40; tries++) {
      const lx = rng.range(-OLD_TIP.rx * 0.82, OLD_TIP.rx * 0.82);
      const lz = rng.range(-OLD_TIP.rz * 0.82, OLD_TIP.rz * 0.82);
      const e = Math.hypot(lx / OLD_TIP.rx, lz / OLD_TIP.rz);
      if (e < eMin || e > eMax) continue;
      if (lz < 0 && Math.abs(lx) < 11.5 && e > 0.42) continue; // the scar
      if (Math.hypot(lx - 2.5, lz - 1.5) < 0.9) continue; // vent pipe
      if (Math.hypot(lx + 4.5, lz - 3.5) < 3.6) continue; // flare stack
      if (Math.hypot(lx + 10.5, lz + 2.5) < 0.9) continue; // sign
      let clear = true;
      for (const [px, pz] of this.postPos) {
        if (Math.hypot(lx - px, lz - pz) < 0.5) {
          clear = false;
          break;
        }
      }
      if (clear) return [lx, lz];
    }
    return null;
  }

  /** Place plant parts (base at y = 0) on the terrain at a tip-local spot. */
  private plantAt(
    bag: TipBag,
    parts: GeoList,
    lx: number,
    lz: number,
    yaw: number,
    s: number,
  ): void {
    const [x, z] = toWorld(lx, lz);
    const y = terrainHeight(x, z) - 0.01;
    for (const g of parts) {
      g.scale(s, s, s);
      g.rotateY(yaw);
      g.translate(lx, y, lz);
      bag.add("plant", g);
    }
  }

  private buildPlants(bag: TipBag, rng: TexRng): void {
    const det = this.det;
    // Dock and thistle rosettes on the crown, half the docks gone to seed
    for (let n = 0; n < det.plants; n++) {
      const spot = this.plantSpot(rng, 0, 0.74);
      if (!spot) continue;
      const dock = rng.chance(0.55);
      const parts: GeoList = [rosetteGeo(rng, dock)];
      if (dock && rng.chance(0.5)) parts.push(...dockSpikeParts(rng));
      this.plantAt(
        bag,
        parts,
        spot[0],
        spot[1],
        rng.range(0, Math.PI * 2),
        rng.range(0.8, 1.3),
      );
    }
    // Soft rush in the damper hollows of the terraces and the crown
    for (let n = 0; n < det.rushes; n++) {
      const spot = this.plantSpot(rng, 0.2, 0.78);
      if (!spot) continue;
      this.plantAt(
        bag,
        [rushGeo(rng)],
        spot[0],
        spot[1],
        rng.range(0, Math.PI * 2),
        rng.range(0.8, 1.25),
      );
    }
    // Bramble clumps sprawling over the crown and upper flank
    for (let n = 0; n < det.brambles; n++) {
      const spot = this.plantSpot(rng, 0, 0.6);
      if (!spot) continue;
      const e = Math.hypot(spot[0] / OLD_TIP.rx, spot[1] / OLD_TIP.rz);
      const reach = e < 0.42 ? rng.range(1.0, 1.6) : rng.range(0.6, 0.9);
      this.plantAt(
        bag,
        brambleParts(rng, reach),
        spot[0],
        spot[1],
        rng.range(0, Math.PI * 2),
        1,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(dt: number, env: Environment, _camPos: THREE.Vector3): void {
    // Static set dressing – only the skin's wet/cloud response follows the
    // weather (soaks quickly, dries slowly, like the terrain).
    if (this.wetInit) {
      const w = this.uWet.value;
      const rate = env.rain > w ? 0.6 : 0.05;
      this.uWet.value = w + (env.rain - w) * Math.min(1, dt * rate);
    } else {
      this.uWet.value = env.rain;
      this.wetInit = true;
    }
    this.uCloud.value = env.cloud;
  }

  dispose(): void {
    this.parent.remove(this.group);
    this.group.clear();
    for (const g of this.geometries) g.dispose();
    // Textures stay in the shared cache (textures-core); only materials go.
    for (const m of this.materials) m.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    clearColliderSet("tip");
    unregisterGround("tip");
  }
}
