// Keld Bothy – a one-room drystone bothy deep in the western pine belt: half
// the slate roof gone to exposed rafters and purlins, a cold hearth with a
// blackened crane and pot, a rusted iron bedframe with a rotten mattress husk,
// enamel plates on a shelf, initials and tally marks scratched beside the
// door, and the door itself hanging on its one remaining hinge, swaying in
// gusts. Outside: a collapsed, greyed woodpile at the open gable, a rusty
// bucket by the flagstone step, worn path stones towards the pines. The first
// roofed interior in the world outside the station – nothing is lit at night.
//
// Site: the analytic terrain cannot be flattened, so the bothy searches the
// spot within a few metres of landforms.ts KELD_BOTHY where the ground under
// its walls varies least, fits a plane there and builds LEVEL on that plane
// (a faint settlement lean of at most 1°), sunk a little. The drystone plinth
// runs down below the lowest ground under the walls, so the uphill side is
// buried and the downhill side shows a course or two more. The floor inside
// is the terrain itself (walkable); the floor drift, hearth and furniture
// conform to it point by point.
//
// Local frame: +x = the open, roofless half and the woodpile gable; −x = the
// hearth/chimney gable; +z = the front with the door and window. Registers its
// colliders under the tag "bothy". Budget: 8 draw calls (one merged mesh per
// material plus the animated door), ≈ 12k triangles at ultra.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  type ColliderFrame,
  addBoxCollider,
  addCylinderCollider,
  beginColliderSet,
  clearColliderSet,
} from "./colliders";
import { KELD_BOTHY } from "./landforms";
import { fbm } from "./noise";
import {
  BLOCK_DV,
  BLOCK_LEN_U,
  BLOCK_U0,
  BLOCK_V0,
  DECAL_UV,
  DRESS_UV,
  FOLIAGE_UV,
  LIME_TILE_U,
  STONE_TILE_U,
  STONE_TILE_V,
  type UvRegion,
  bothyDecalTexture,
  bothyDressPbr,
  bothyFoliageTexture,
  pbrBothyLimewash,
  pbrBothySlate,
  pbrBothyStone,
} from "./place-bothy-textures";
import type { Environment } from "./sky";
import { terrainHeight } from "./terrain";
import {
  TexRng,
  applyPbr,
  hash01,
  pbrRustyMetal,
  pbrSand,
  pbrWood,
  sstep,
} from "./textures";
import type { QualityId } from "./types";

// ---------------------------------------------------------------------------
// Dimensions (local metres, floor level y = 0)
// ---------------------------------------------------------------------------

/** Outer length (x) and width (z), wall thickness. */
const HL = 2.7;
const HW = 1.85;
const T = 0.5;
const EAVE_Y = 2.2;
const RIDGE_Y = 3.4;
/** Roof overhang beyond the walls at the eaves and gables. */
const OVER = 0.3;
const PITCH = Math.atan((RIDGE_Y - EAVE_Y) / HW);
const COS_P = Math.cos(PITCH);
const SIN_P = Math.sin(PITCH);
const TAN_P = Math.tan(PITCH);
const EAVE_Z = HW + OVER;
const EAVE_TIP_Y = RIDGE_Y - EAVE_Z * TAN_P;
/** Rafter length from the eave tip to the ridge. */
const SLOPE_LEN = EAVE_Z / COS_P;
/** Slates survive on the −x half; the ragged edge wanders about this x. */
const ROOF_EDGE_X = 0.15;
/** Gable stone rises this much above the roof timbers (skew). */
const SKEW = 0.22;
/** Roof timbers and slates end inside the gable stone at this |x|. */
const VERGE_X = HL - 0.08;

/** Front wall openings. */
const DOOR_X0 = 0.65;
const DOOR_X1 = 1.55;
const DOOR_H = 1.95;
const WIN_X0 = -1.5;
const WIN_X1 = -0.9;
const WIN_Y0 = 1.05;
const WIN_Y1 = 1.75;

/** Hearth in the −x gable: chimney breast, recess into the wall. */
const BREAST = 0.2;
const RECESS_D = 0.3;
const HEARTH_HW = 0.45;
const HEARTH_H = 0.85;
const GABLE_IN = -HL + T; // interior face of the hearth gable
const BREAST_X = GABLE_IN + BREAST; // room-side face of the breast
const RECESS_X = GABLE_IN - RECESS_D; // back of the fireplace

/** Door leaf. */
const DOOR_W = 0.86;
const DOOR_T = 0.04;
/** Droop of the leaf on its single hinge (rad). */
const DOOR_SAG = 0.061;
/**
 * Swing angles (rad from the closed position). The leaf carries a collider,
 * so at rest it hangs wide enough that a 0.7 m body passes between its far
 * edge and the opposite jamb; gusts shove it further open against the stop.
 */
const DOOR_REST = 1.15;
const DOOR_MIN = 0.7;
const DOOR_MAX = 1.5;

/** Sand texture tiling of the terrain mesh (world.ts) – the drifts match it. */
const SAND_TILE_X = 820 / 70;
const SAND_TILE_Z = 560 / 48;

/** Yard dyke: start at the open-half corner, unit direction, length (local). */
const DYKE = { x: HL + 0.15, z: HW + 0.2, dx: 0.42, dz: 0.9075, len: 8.4 };
/** Standing part of the dyke ends here (metres along it). */
const DYKE_STAND = 3.2;

/** How much of the ground plane's tilt the shell takes on, and its cap. */
const LEAN = 0.3;
const LEAN_MAX = Math.tan((1 * Math.PI) / 180);

const UP = new THREE.Vector3(0, 1, 0);
const TV = new THREE.Vector3();
const TQ = new THREE.Quaternion();
const TM = new THREE.Matrix4();

// ---------------------------------------------------------------------------
// Site
// ---------------------------------------------------------------------------

export interface BothySite {
  x: number;
  z: number;
  yaw: number;
  /** Floor level (world y). */
  floorY: number;
  /** Ground plane slopes along local x / z. */
  au: number;
  av: number;
}

function localToWorld(
  cx: number,
  cz: number,
  yaw: number,
  lx: number,
  lz: number,
): [number, number] {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [cx + lx * c + lz * s, cz - lx * s + lz * c];
}

/**
 * Deterministic site search: within ±4 m of the anchor and ±20° of facing
 * the sea, the spot whose wall line shows the smallest height range wins
 * (a level building wants the least plinth), with a slight pull towards the
 * anchor. The plane through the footprint gives the floor level and lean.
 */
function fitSite(): BothySite {
  const AX = KELD_BOTHY.x;
  const AZ = KELD_BOTHY.z;
  let bx = AX;
  let bz = AZ;
  let byaw = Math.PI;
  let best = Number.POSITIVE_INFINITY;
  for (let oz = -4; oz <= 4; oz += 1) {
    for (let ox = -4; ox <= 4; ox += 1) {
      for (let k = -4; k <= 4; k++) {
        const yaw = Math.PI + k * 0.0875;
        const cx = AX + ox;
        const cz = AZ + oz;
        let lo = Number.POSITIVE_INFINITY;
        let hi = Number.NEGATIVE_INFINITY;
        for (let j = -2; j <= 2; j++) {
          for (let i = -3; i <= 3; i++) {
            if (Math.abs(i) < 3 && Math.abs(j) < 2) continue; // wall line only
            const [wx, wz] = localToWorld(
              cx,
              cz,
              yaw,
              (i / 3) * (HL - T / 2),
              (j / 2) * (HW - T / 2),
            );
            const h = terrainHeight(wx, wz);
            if (h < lo) lo = h;
            if (h > hi) hi = h;
          }
        }
        const score =
          hi - lo + Math.hypot(ox, oz) * 0.025 + Math.abs(k) * 0.008;
        if (score < best) {
          best = score;
          bx = cx;
          bz = cz;
          byaw = yaw;
        }
      }
    }
  }
  // Least-squares plane over the whole footprint
  let sum = 0;
  let suh = 0;
  let svh = 0;
  let suu = 0;
  let svv = 0;
  let n = 0;
  for (let j = -2; j <= 2; j++) {
    for (let i = -3; i <= 3; i++) {
      const u = (i / 3) * HL;
      const v = (j / 2) * HW;
      const [wx, wz] = localToWorld(bx, bz, byaw, u, v);
      const h = terrainHeight(wx, wz);
      sum += h;
      suh += h * u;
      svh += h * v;
      suu += u * u;
      svv += v * v;
      n++;
    }
  }
  return {
    x: bx,
    z: bz,
    yaw: byaw,
    floorY: sum / n - 0.1,
    au: suh / suu,
    av: svh / svv,
  };
}

let cachedSite: BothySite | null = null;

/** The bothy's chosen site (deterministic, memoised). */
export function bothySite(): BothySite {
  if (!cachedSite) cachedSite = fitSite();
  return cachedSite;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

type BothyMat =
  | "stone"
  | "inner"
  | "slate"
  | "wood"
  | "rust"
  | "dress"
  | "decal"
  | "sand"
  | "foliage";
type Tint = readonly [number, number, number];

const COLOR_MATS: ReadonlySet<BothyMat> = new Set([
  "stone",
  "inner",
  "slate",
  "wood",
  "rust",
  "dress",
  "foliage",
]);

const WHITE: Tint = [1, 1, 1];

/** Collects geometries per material and merges them into one mesh each. */
class Bag {
  private readonly lists = new Map<BothyMat, THREE.BufferGeometry[]>();

  add(key: BothyMat, g: THREE.BufferGeometry, tint: Tint = WHITE): void {
    const geo = nonIndexed(g);
    const n = geo.getAttribute("position").count;
    if (COLOR_MATS.has(key)) {
      if (!geo.getAttribute("color")) {
        const arr = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          arr[i * 3] = tint[0];
          arr[i * 3 + 1] = tint[1];
          arr[i * 3 + 2] = tint[2];
        }
        geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
      }
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

  build(mats: Record<BothyMat, THREE.Material>): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [key, list] of this.lists) {
      if (list.length === 0) continue;
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) throw new Error(`Bothy: mergeGeometries (${key}) failed`);
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mats[key]);
      mesh.name = `bothy-${key}`;
      mesh.castShadow = key !== "decal" && key !== "sand";
      mesh.receiveShadow = true;
      out.push(mesh);
    }
    this.lists.clear();
    return out;
  }
}

function nonIndexed(g: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!g.index) return g;
  const out = g.toNonIndexed();
  g.dispose();
  return out;
}

function box(
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

function boxFromTo(
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

/** Box from a to b (its local z along the axis), cross-section w × h. */
function boxBetween(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  w: number,
  h: number,
): THREE.BufferGeometry {
  const len = Math.hypot(bx - ax, by - ay, bz - az) || 1e-4;
  const g = timberBox(
    w,
    h,
    len,
    hash01(Math.round(ax * 50), Math.round(bz * 50), 3) * 2,
  );
  TV.set(bx - ax, by - ay, bz - az).normalize();
  TQ.setFromUnitVectors(new THREE.Vector3(0, 0, 1), TV);
  g.applyQuaternion(TQ);
  g.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  return g;
}

/** Cylinder between two points, u along the axis (wood grain direction). */
function cylBetween(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  r0: number,
  seg: number,
  r1 = r0,
): THREE.BufferGeometry {
  const len = Math.hypot(bx - ax, by - ay, bz - az) || 1e-4;
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, false);
  const uvA = g.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < uvA.count; i++) {
    const u0 = uvA.getX(i);
    const v0 = uvA.getY(i);
    uvA.setXY(i, v0 * Math.max(0.4, len * 0.7), u0 * 0.4);
  }
  TV.set(bx - ax, by - ay, bz - az).normalize();
  TQ.setFromUnitVectors(UP, TV);
  g.applyQuaternion(TQ);
  g.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  return g;
}

/**
 * Per-triangle UV projection. `fn` receives the vertex and the face normal
 * and returns [u, v]. Converts to non-indexed (flat faces).
 */
function projectUv(
  g: THREE.BufferGeometry,
  fn: (
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
  ) => [number, number],
): THREE.BufferGeometry {
  const geo = nonIndexed(g);
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const n = pos.count;
  const uv = new Float32Array(n * 2);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const e = new THREE.Vector3();
  for (let i = 0; i < n; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    e.subVectors(c, b);
    a.sub(b);
    e.cross(a).normalize();
    for (let k = 0; k < 3; k++) {
      const r = fn(
        pos.getX(i + k),
        pos.getY(i + k),
        pos.getZ(i + k),
        e.x,
        e.y,
        e.z,
      );
      uv[(i + k) * 2] = r[0];
      uv[(i + k) * 2 + 1] = r[1];
    }
  }
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return geo;
}

/** Drystone projection: u along the face, v from the plinth upwards. */
function stoneUv(
  g: THREE.BufferGeometry,
  yBase: number,
  uOff: number,
): THREE.BufferGeometry {
  return projectUv(g, (x, y, z, nx, ny, nz) => {
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);
    if (ay >= ax && ay >= az) {
      return [(x + uOff) / STONE_TILE_U, (z + HW) / STONE_TILE_V + 0.45];
    }
    const along = ax >= az ? z : x;
    return [(along + uOff) / STONE_TILE_U, (y - yBase) / STONE_TILE_V];
  });
}

/** Slate projection at ≈ 0.6 m per tile. */
function slateUv(g: THREE.BufferGeometry, off = 0): THREE.BufferGeometry {
  return projectUv(g, (x, y, z, nx, ny, nz) => {
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);
    if (ay >= ax && ay >= az) return [(x + off) / 0.6, z / 0.6];
    if (ax >= az) return [(z + off) / 0.6, y / 0.6];
    return [(x + off) / 0.6, y / 0.6];
  });
}

/** Box with the wood grain (u) running along its z length. */
function timberBox(
  w: number,
  h: number,
  len: number,
  uOff = 0,
): THREE.BufferGeometry {
  return projectUv(new THREE.BoxGeometry(w, h, len), (x, y, z) => [
    z / 1.1 + uOff,
    (x + y) / 0.35 + 0.3,
  ]);
}

/** Remap 0..1 UVs into an atlas region. */
function regionUv(
  g: THREE.BufferGeometry,
  region: UvRegion,
): THREE.BufferGeometry {
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  const [u0, v0, u1, v1] = region;
  for (let i = 0; i < uv.count; i++) {
    const u = Math.min(1, Math.max(0, uv.getX(i)));
    const v = Math.min(1, Math.max(0, uv.getY(i)));
    uv.setXY(i, u0 + u * (u1 - u0), v0 + v * (v1 - v0));
  }
  uv.needsUpdate = true;
  return g;
}

/** Plane w × h (normal +z) mapped onto a decal region. */
function decalQuad(
  region: UvRegion,
  w: number,
  h: number,
): THREE.BufferGeometry {
  return regionUv(new THREE.PlaneGeometry(w, h), region);
}

/**
 * Split a non-indexed geometry into the triangles whose face (centroid +
 * normal) satisfies `pred` and the rest. Either part may be null.
 */
function partition(
  geo: THREE.BufferGeometry,
  pred: (
    cx: number,
    cy: number,
    cz: number,
    nx: number,
    ny: number,
    nz: number,
  ) => boolean,
): [THREE.BufferGeometry | null, THREE.BufferGeometry | null] {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const nor = geo.getAttribute("normal") as THREE.BufferAttribute;
  const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
  const yes: number[] = [];
  const no: number[] = [];
  for (let i = 0; i < pos.count; i += 3) {
    const cx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
    const cy = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    const cz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
    const hit = pred(cx, cy, cz, nor.getX(i), nor.getY(i), nor.getZ(i));
    (hit ? yes : no).push(i);
  }
  const pick = (tris: number[]): THREE.BufferGeometry | null => {
    if (tris.length === 0) return null;
    const n = tris.length * 3;
    const p = new Float32Array(n * 3);
    const nn = new Float32Array(n * 3);
    const t = new Float32Array(n * 2);
    let k = 0;
    for (const i of tris) {
      for (let j = 0; j < 3; j++) {
        p[k * 3] = pos.getX(i + j);
        p[k * 3 + 1] = pos.getY(i + j);
        p[k * 3 + 2] = pos.getZ(i + j);
        nn[k * 3] = nor.getX(i + j);
        nn[k * 3 + 1] = nor.getY(i + j);
        nn[k * 3 + 2] = nor.getZ(i + j);
        t[k * 2] = uv.getX(i + j);
        t[k * 2 + 1] = uv.getY(i + j);
        k++;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(p, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(nn, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(t, 2));
    return g;
  };
  return [pick(yes), pick(no)];
}

/**
 * Dressed block: every face is mapped onto one of the wall texture's fixed
 * through-stones (stone k), so no joint crosses it. (x0, y0, z0) is the
 * block's minimum corner.
 */
function blockUv(
  g: THREE.BufferGeometry,
  x0: number,
  y0: number,
  z0: number,
  k: number,
): THREE.BufferGeometry {
  const u0 = BLOCK_U0(k);
  return projectUv(g, (x, y, z, nx, ny, nz) => {
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);
    if (ay >= ax && ay >= az) {
      return [
        u0 + Math.min(BLOCK_LEN_U, (x - x0) / STONE_TILE_U),
        BLOCK_V0 + Math.min(BLOCK_DV, (z - z0) / STONE_TILE_V),
      ];
    }
    const along = ax >= az ? z - z0 : x - x0;
    return [
      u0 + Math.min(BLOCK_LEN_U, along / STONE_TILE_U),
      BLOCK_V0 + Math.min(BLOCK_DV, (y - y0) / STONE_TILE_V),
    ];
  });
}

/** Block between two corners with block UVs and a slight random set. */
function blockBox(
  rng: TexRng,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  k: number,
  wobble = 0.012,
): THREE.BufferGeometry {
  const g = blockUv(
    boxFromTo(x0, y0, z0, x1, y1, z1),
    Math.min(x0, x1),
    Math.min(y0, y1),
    Math.min(z0, z1),
    k,
  );
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const cz = (z0 + z1) / 2;
  g.translate(-cx, -cy, -cz);
  g.rotateX(rng.gauss() * wobble);
  g.rotateZ(rng.gauss() * wobble);
  g.rotateY(rng.gauss() * wobble);
  g.translate(cx, cy, cz);
  return g;
}

/** Radial hash jitter about the origin (irregular stones). */
function jitter(geo: THREE.BufferGeometry, amp: number, seed: number): void {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const k =
      1 +
      (hash01(
        Math.round(x * 140) + 31 * Math.round(y * 140),
        Math.round(z * 140),
        seed,
      ) -
        0.5) *
        2 *
        amp;
    pos.setXYZ(i, x * k, y * k, z * k);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

function setTint(geo: THREE.BufferGeometry, t: Tint): void {
  const n = geo.getAttribute("position").count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = t[0];
    arr[i * 3 + 1] = t[1];
    arr[i * 3 + 2] = t[2];
  }
  geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
}

interface SheetVertex {
  x: number;
  y: number;
  z: number;
  u: number;
  v: number;
  r: number;
  g: number;
  b: number;
}

/** Subdivided sheet (nx × ny quads) filled by `fn` per grid point. */
function makeSheet(
  nx: number,
  ny: number,
  fn: (ti: number, tj: number, out: SheetVertex) => void,
): THREE.BufferGeometry {
  const cols = nx + 1;
  const rows = ny + 1;
  const n = cols * rows;
  const pos = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const col = new Float32Array(n * 3);
  const o: SheetVertex = { x: 0, y: 0, z: 0, u: 0, v: 0, r: 1, g: 1, b: 1 };
  let p = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      o.r = 1;
      o.g = 1;
      o.b = 1;
      fn(i / nx, j / ny, o);
      pos[p * 3] = o.x;
      pos[p * 3 + 1] = o.y;
      pos[p * 3 + 2] = o.z;
      uv[p * 2] = o.u;
      uv[p * 2 + 1] = o.v;
      col[p * 3] = o.r;
      col[p * 3 + 1] = o.g;
      col[p * 3 + 2] = o.b;
      p++;
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Prism between x0 and x1 over a convex polygon in the (z, y) plane – the
 * gable walls. Flat normals, no shared vertices across edges.
 */
function prismX(
  pts: ReadonlyArray<readonly [number, number]>,
  x0: number,
  x1: number,
): THREE.BufferGeometry {
  const lo = Math.min(x0, x1);
  const hi = Math.max(x0, x1);
  const pos: number[] = [];
  const nor: number[] = [];
  const tri = (
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
  ) => {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    for (const p of [a, b, c]) {
      pos.push(p[0], p[1], p[2]);
      nor.push(nx, ny, nz);
    }
  };
  const m = pts.length;
  // Caps: the polygon is counter-clockwise in (z, y) seen from +x, so the
  // +x cap keeps that order reversed into (x, y, z) and the −x cap flips it
  for (let k = 1; k + 1 < m; k++) {
    tri(
      [hi, pts[0][1], pts[0][0]],
      [hi, pts[k + 1][1], pts[k + 1][0]],
      [hi, pts[k][1], pts[k][0]],
    );
    tri(
      [lo, pts[0][1], pts[0][0]],
      [lo, pts[k][1], pts[k][0]],
      [lo, pts[k + 1][1], pts[k + 1][0]],
    );
  }
  // Sides, outward for a counter-clockwise polygon
  for (let k = 0; k < m; k++) {
    const a = pts[k];
    const b = pts[(k + 1) % m];
    const p0: [number, number, number] = [lo, a[1], a[0]];
    const p1: [number, number, number] = [hi, a[1], a[0]];
    const p2: [number, number, number] = [hi, b[1], b[0]];
    const p3: [number, number, number] = [lo, b[1], b[0]];
    tri(p0, p1, p2);
    tri(p0, p2, p3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(pos), 3),
  );
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(nor), 3));
  g.setAttribute(
    "uv",
    new THREE.BufferAttribute(new Float32Array((pos.length / 3) * 2), 2),
  );
  return g;
}

/** Point on the rafter underside: side s, slope distance d from the eave tip, offset n along the roof normal. */
function slopePoint(
  s: number,
  d: number,
  n: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  return out.set(
    0,
    EAVE_TIP_Y + d * SIN_P + n * COS_P,
    s * (EAVE_Z - d * COS_P) + s * n * SIN_P,
  );
}

/** Box lying along the roof slope (its z along the fall line), centred at slope distance d. */
function slopeBox(
  w: number,
  thick: number,
  len: number,
  s: number,
  d: number,
  n: number,
  x: number,
  uOff = 0,
): THREE.BufferGeometry {
  const g = timberBox(w, thick, len, uOff);
  g.rotateX(s * PITCH);
  slopePoint(s, d, n, TV);
  g.translate(x, TV.y, TV.z);
  return g;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------------------------------------------------------------------------
// The bothy
// ---------------------------------------------------------------------------

export class KeldBothy {
  protected readonly parent: THREE.Group;
  protected readonly quality: QualityId;

  private readonly group = new THREE.Group();
  private readonly mats: Record<BothyMat, THREE.Material>;
  private readonly meshes: THREE.Mesh[] = [];
  private readonly site: BothySite;
  private readonly det: number;
  /** Settlement lean of the built shell (walls, roof, door frame). */
  private readonly shellM = new THREE.Matrix4();
  /** Bottom of the drystone plinth (local y, below the lowest ground). */
  private readonly yPlinth: number;
  private sandMat: THREE.MeshStandardMaterial | null = null;
  private door: THREE.Mesh | null = null;
  private doorOpen = DOOR_REST;
  private doorVel = 0;
  /** Hinge (local) and leaf height – the leaf collider follows the swing. */
  private doorHx = 0;
  private doorHz = 0;
  private doorHingeY = 0;
  private doorLeafH = 0;
  /** Swing angle the leaf collider was last registered at. */
  private doorRegistered = Number.NaN;
  private windSmooth = 0.2;
  /** Wetness of the drifts, smoothed like the terrain's (world.ts). */
  private wet = 0;
  /** Collider frame of the bothy (both collider tags use it). */
  private readonly frame: ColliderFrame;
  private readonly qSag = new THREE.Quaternion();
  private readonly qSwing = new THREE.Quaternion();

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
    this.site = bothySite();
    this.frame = {
      x: this.site.x,
      y: this.site.floorY,
      z: this.site.z,
      yaw: this.site.yaw,
    };
    this.group.position.set(this.site.x, this.site.floorY, this.site.z);
    this.group.rotation.y = this.site.yaw;
    parent.add(this.group);

    // Lean: a fraction of the ground plane's tilt, capped at 1°
    const lx = Math.max(-LEAN_MAX, Math.min(LEAN_MAX, this.site.au * LEAN));
    const lz = Math.max(-LEAN_MAX, Math.min(LEAN_MAX, this.site.av * LEAN));
    TV.set(-lx, 1, -lz).normalize();
    TQ.setFromUnitVectors(UP, TV);
    this.shellM.makeRotationFromQuaternion(TQ);

    // Plinth: below the lowest ground under the wall line
    let lo = Number.POSITIVE_INFINITY;
    for (let j = -2; j <= 2; j++) {
      for (let i = -3; i <= 3; i++) {
        if (Math.abs(i) < 3 && Math.abs(j) < 2) continue;
        const g = this.groundLocal((i / 3) * HL, (j / 2) * HW);
        if (g < lo) lo = g;
      }
    }
    this.yPlinth = lo - 0.3;
    this.qSag.setFromAxisAngle(new THREE.Vector3(0, 0, 1), DOOR_SAG);

    this.mats = this.makeMaterials();
    this.build();
  }

  update(dt: number, env: Environment, _camPos: THREE.Vector3): void {
    const target =
      env.weather === "storm" ? Math.min(1, env.wind * 1.1 + 0.05) : env.wind;
    this.windSmooth += (target - this.windSmooth) * Math.min(1, dt * 1.5);
    // The terrain darkens when wet (uWet in world.ts) – follow with the drifts
    // The sand wets within seconds and dries over minutes (world.ts) – the
    // drifts follow the terrain's curve and its depth (≈ 0.74 at full rain)
    const rate = env.rain > this.wet ? 0.5 : 0.02;
    this.wet += (env.rain - this.wet) * Math.min(1, dt * rate);
    if (this.sandMat) this.sandMat.color.setScalar(1 - this.wet * 0.26);
    if (this.door) this.swingDoor(Math.min(dt, 0.05), env.envTime);
  }

  dispose(): void {
    clearColliderSet("bothy");
    clearColliderSet("bothy-door");
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      this.group.remove(mesh);
    }
    this.meshes.length = 0;
    this.door = null;
    for (const m of Object.values(this.mats)) m.dispose();
    this.parent.remove(this.group);
    // Textures stay in the shared cache (same convention as station/camp).
  }

  // -------------------------------------------------------------------------
  // Door on one hinge
  // -------------------------------------------------------------------------

  /**
   * The leaf hangs from its top pintle and droops; gravity on the bent pin
   * gives it a rest angle (a spring), the corner dragging on the floor damps
   * it. Gusts – a bursty function of the environment time scaled by wind² –
   * shove it further open with sharp onsets; it bangs against the stops
   * rather than ever spinning.
   */
  private swingDoor(dt: number, t: number): void {
    if (!this.door) return;
    const w = this.windSmooth;
    const w2 = w * w;
    const a =
      Math.sin(t * 0.9) * Math.sin(t * 0.37 + 1.3) +
      0.5 * Math.sin(t * 2.3 + 0.4);
    let g = clamp01((a - 0.1) / 0.8);
    g *= g;
    const flutter = 0.5 + 0.5 * Math.sin(t * 7.1) * Math.sin(t * 3.3 + 0.7);
    const force = w2 * (g * 4.6 - 0.55 + 0.6 * g * flutter);
    const acc = 3.0 * (DOOR_REST - this.doorOpen) - 1.1 * this.doorVel + force;
    this.doorVel += acc * dt;
    this.doorOpen += this.doorVel * dt;
    if (this.doorOpen < DOOR_MIN) {
      this.doorOpen = DOOR_MIN;
      this.doorVel = -this.doorVel * 0.15;
    } else if (this.doorOpen > DOOR_MAX) {
      this.doorOpen = DOOR_MAX;
      this.doorVel = -this.doorVel * 0.15;
    }
    this.qSwing.setFromAxisAngle(UP, -this.doorOpen);
    this.door.quaternion.copy(this.qSwing).multiply(this.qSag);
    if (Math.abs(this.doorOpen - this.doorRegistered) > 0.087) {
      this.registerDoorCollider();
    }
  }

  /**
   * Thin box following the leaf, under its own tag ("bothy-door") so the
   * static set stays untouched; re-registered once the swing has moved more
   * than ~5° from the last registration.
   */
  private registerDoorCollider(): void {
    const open = this.doorOpen;
    beginColliderSet("bothy-door", this.frame);
    addBoxCollider(
      this.doorHx - (DOOR_W / 2) * Math.cos(open),
      this.doorHz - (DOOR_W / 2) * Math.sin(open),
      DOOR_W / 2,
      DOOR_T / 2 + 0.02,
      -open,
      this.doorHingeY - this.doorLeafH,
      this.doorHingeY,
    );
    this.doorRegistered = open;
  }

  // -------------------------------------------------------------------------
  // Frame helpers
  // -------------------------------------------------------------------------

  private seg(n: number, min = 3): number {
    return Math.max(min, Math.round(n * this.det));
  }

  /** Terrain height under a local point, relative to the floor level. */
  private groundLocal(lx: number, lz: number): number {
    const [wx, wz] = localToWorld(
      this.site.x,
      this.site.z,
      this.site.yaw,
      lx,
      lz,
    );
    return terrainHeight(wx, wz) - this.site.floorY;
  }

  private worldXZ(lx: number, lz: number): [number, number] {
    return localToWorld(this.site.x, this.site.z, this.site.yaw, lx, lz);
  }

  /** Height of the floor drift above the terrain (metres) at a local point. */
  private litterHeight(x: number, z: number): number {
    const fan = Math.exp(-((x - 1.0) ** 2 + (z - 0.45) ** 2) / 1.5);
    let h =
      0.018 +
      0.075 * fan +
      0.03 * sstep(0.3, 1, fbm(x * 0.9 + 3, z * 0.9, 2)) +
      0.02 * sstep(0.45, 1, fbm(x * 2.2 + 9, z * 2.2 + 1, 2));
    const edge = Math.min(2.1 - Math.abs(x), 1.3 - Math.abs(z));
    h -= (1 - sstep(0, 0.2, edge)) * 0.07;
    return h;
  }

  // -------------------------------------------------------------------------
  // Materials
  // -------------------------------------------------------------------------

  private makeMaterials(): Record<BothyMat, THREE.Material> {
    // Texture sheets by quality tier: 1024 / 768 / 512 px wide (the sets
    // derive their heights and all scales from the width)
    const size =
      this.quality === "ultra" ? 1024 : this.quality === "high" ? 768 : 512;

    const stone = new THREE.MeshStandardMaterial({ vertexColors: true });
    applyPbr(stone, pbrBothyStone(size));

    const slate = new THREE.MeshStandardMaterial({ vertexColors: true });
    applyPbr(slate, pbrBothySlate(size / 2));

    const wood = new THREE.MeshStandardMaterial({ vertexColors: true });
    applyPbr(wood, pbrWood("driftwood"));

    const rust = new THREE.MeshStandardMaterial({ vertexColors: true });
    applyPbr(rust, pbrRustyMetal("#4a4744", 0.6, { edges: false }));
    // No env map out here – keep the metal response low so it stays legible
    rust.metalness = 0.3;

    const dress = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
    });
    applyPbr(dress, bothyDressPbr(size));

    const decal = new THREE.MeshStandardMaterial({
      map: bothyDecalTexture(size),
      transparent: true,
      depthWrite: false,
      roughness: 0.95,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });

    const sand = new THREE.MeshStandardMaterial();
    applyPbr(sand, pbrSand());
    this.sandMat = sand;

    // Interior wall faces: limewash, sooted per vertex towards the hearth
    const inner = new THREE.MeshStandardMaterial({ vertexColors: true });
    applyPbr(inner, pbrBothyLimewash(size));

    // Nettle and dock leaves: alpha-tested cutouts, lit from both sides
    const foliage = new THREE.MeshStandardMaterial({
      map: bothyFoliageTexture(),
      alphaTest: 0.45,
      side: THREE.DoubleSide,
      roughness: 0.85,
      metalness: 0,
      vertexColors: true,
    });

    return { stone, inner, slate, wood, rust, dress, decal, sand, foliage };
  }

  // -------------------------------------------------------------------------
  // Build
  // -------------------------------------------------------------------------

  private build(): void {
    const bag = new Bag();
    beginColliderSet("bothy", this.frame);

    this.buildWalls(bag);
    this.buildRoof(bag);
    this.buildSlates(bag);
    this.buildHearth(bag);
    this.buildWindow(bag);
    this.buildBed(bag);
    this.buildShelf(bag);
    this.buildStool(bag);
    this.buildFloor(bag);
    this.buildYard(bag);
    this.buildWoodpile(bag);
    this.buildRubble(bag);
    this.buildQuoins(bag);
    this.buildDyke(bag);
    this.buildFoliage(bag);

    for (const mesh of bag.build(this.mats)) {
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
    this.buildDoor();

    // Colliders (bothy frame, y relative to the floor level)
    const F = HW - T / 2;
    const wall = (cx: number, cz: number, hx: number, hz: number) =>
      addBoxCollider(cx, cz, hx, hz, 0, -1.5, 3.6);
    wall((-HL + DOOR_X0) / 2, F, (DOOR_X0 + HL) / 2, T / 2); // front, east of the door
    wall((DOOR_X1 + HL) / 2, F, (HL - DOOR_X1) / 2, T / 2); // front, west of the door
    wall(0, -F, HL, T / 2); // back
    wall(HL - T / 2, 0, T / 2, HW); // open gable
    wall(-HL + T / 2, 0, T / 2, HW); // hearth gable
    wall(-HL - 0.1, 0, 0.12, 0.47); // chimney stack
    wall((GABLE_IN + BREAST_X) / 2, 0, BREAST / 2 + 0.02, 0.8); // chimney breast
    addBoxCollider(1.15, -HW + T + 0.45, 0.97, 0.45, 0, -1, 0.95); // bedframe
    addBoxCollider(HL + 0.6, 0.1, 0.72, 0.85, 0, -1, 0.7); // woodpile
    addCylinderCollider(-1.35, 0.55, 0.2, -1, 0.5); // stool
    addCylinderCollider(1.95, HW + 0.78, 0.17, -1, 0.35); // bucket
    // Standing stretch of the yard dyke (the tumble is low enough to step over)
    addBoxCollider(
      DYKE.x + (DYKE.dx * DYKE_STAND) / 2,
      DYKE.z + (DYKE.dz * DYKE_STAND) / 2,
      DYKE_STAND / 2 + 0.05,
      0.24,
      Math.atan2(-DYKE.dz, DYKE.dx),
      -1,
      0.8,
    );
  }

  // -------------------------------------------------------------------------
  // Walls, gables, chimney
  // -------------------------------------------------------------------------

  /**
   * Wall piece: faces on the outside get the lichened drystone set, faces
   * that look into the room or the fireplace the limewashed set, sooted per
   * vertex towards the hearth.
   */
  private stone(
    bag: Bag,
    g: THREE.BufferGeometry,
    uOff: number,
    tint: Tint = WHITE,
  ): void {
    const geo = stoneUv(g, this.yPlinth, uOff);
    const [inner, outer] = partition(geo, (cx, cy, cz, nx, ny, nz) =>
      this.isInterior(cx + nx * 0.12, cy + ny * 0.12, cz + nz * 0.12),
    );
    geo.dispose();
    if (outer) {
      outer.applyMatrix4(this.shellM);
      bag.add("stone", outer, tint);
    }
    if (inner) {
      const yBase = this.yPlinth + 0.3;
      const lime = projectUv(inner, (x, y, z, nx, ny, nz) => {
        const ax = Math.abs(nx);
        const ay = Math.abs(ny);
        const az = Math.abs(nz);
        if (ay >= ax && ay >= az) {
          return [(x + uOff) / LIME_TILE_U, 0.5 + (z + HW) / STONE_TILE_V];
        }
        const along = ax >= az ? z : x;
        return [(along + uOff) / LIME_TILE_U, (y - yBase) / STONE_TILE_V];
      });
      this.sootTint(lime);
      lime.applyMatrix4(this.shellM);
      bag.add("inner", lime);
    }
  }

  /** Does a point lie in the room or in the fireplace recess? */
  private isInterior(x: number, y: number, z: number): boolean {
    if (y < this.yPlinth + 0.05) return false;
    if (Math.abs(x) < HL - T + 0.02 && Math.abs(z) < HW - T + 0.02) return true;
    return (
      x > RECESS_X - 0.03 &&
      x < BREAST_X + 0.03 &&
      Math.abs(z) < HEARTH_HW + 0.03 &&
      y < HEARTH_H + 0.05
    );
  }

  /** Per-vertex soot: black in the fireplace, spreading up and out from the hearth gable. */
  private sootTint(geo: THREE.BufferGeometry): void {
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      let soot =
        0.6 *
        clamp01((-0.7 - x) / 1.5) *
        (0.55 + 0.45 * clamp01((y + 0.2) / 2.2));
      if (
        x < BREAST_X + 0.05 &&
        Math.abs(z) < HEARTH_HW + 0.1 &&
        y < HEARTH_H + 0.2
      ) {
        soot = 0.85;
      }
      const k = 1 - soot;
      col[i * 3] = k;
      col[i * 3 + 1] = k * 0.97;
      col[i * 3 + 2] = k * 0.93;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  }

  /**
   * Dressed quoins at the four corners (long and short faces alternating,
   * proud of both wall faces) and at the door and window jambs (through-
   * stones alternating with half-depth ones).
   */
  private buildQuoins(bag: Bag): void {
    const rng = new TexRng(0x900a);
    let k = 0;
    const put = (
      x0: number,
      y0: number,
      z0: number,
      x1: number,
      y1: number,
      z1: number,
    ) => {
      const g = blockBox(rng, x0, y0, z0, x1, y1, z1, k++);
      g.applyMatrix4(this.shellM);
      const tone = rng.range(0.78, 1.02);
      bag.add("stone", g, [tone, tone, tone * 1.01]);
    };
    const P = 0.02;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const xc = sx * (HL + P);
        const zc = sz * (HW + P);
        let y = this.yPlinth + 0.25;
        let long = sx + sz > 0;
        while (y < EAVE_Y + SKEW - 0.1) {
          const h = rng.range(0.17, 0.21);
          const lx = long ? rng.range(0.42, 0.52) : rng.range(0.26, 0.32);
          const lz = long ? rng.range(0.26, 0.32) : rng.range(0.42, 0.52);
          put(xc, y, zc, xc - sx * lx, y + h, zc - sz * lz);
          y += h + 0.012;
          long = !long;
        }
      }
    }
    // Door jambs: sx points from the jamb into the opening
    for (const [xj, sx] of [
      [DOOR_X0, 1],
      [DOOR_X1, -1],
    ]) {
      let y = 0;
      let through = true;
      while (y < DOOR_H - 0.06) {
        const h = Math.min(rng.range(0.17, 0.21), DOOR_H - 0.02 - y);
        const z0 = through ? HW - T - P : HW - 0.3;
        put(xj + sx * 0.008, y, z0, xj - sx * 0.28, y + h, HW + P);
        y += h + 0.012;
        through = !through;
      }
    }
    for (const [xj, sx] of [
      [WIN_X0, 1],
      [WIN_X1, -1],
    ]) {
      let y = WIN_Y0;
      while (y < WIN_Y1 - 0.05) {
        const h = Math.min(rng.range(0.16, 0.2), WIN_Y1 - 0.01 - y);
        put(xj + sx * 0.008, y, HW - T - P, xj - sx * 0.24, y + h, HW + P);
        y += h + 0.01;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Yard dyke
  // -------------------------------------------------------------------------

  /**
   * Drystone dyke running off the open-half corner towards the pines: a
   * standing double-skin stretch with upright copes, then the courses give
   * out over a few metres into a tumble of fallen blocks half-buried in sand.
   */
  private buildDyke(bag: Bag): void {
    const rng = new TexRng(0xd1ce);
    const { dx, dz } = DYKE;
    const nx = -dz;
    const nz = dx;
    const COURSE = 0.15;
    const yawD = Math.atan2(-dz, dx);
    const courses = (s: number): number =>
      s < 2.2 ? 4 : s < DYKE_STAND ? 3 : s < 5.4 ? 2 : s < 7.4 ? 1 : 0;
    let k = 0;
    const at = (s: number, lat: number): [number, number] => [
      DYKE.x + dx * s + nx * lat,
      DYKE.z + dz * s + nz * lat,
    ];
    const block = (
      s: number,
      lat: number,
      y: number,
      len: number,
      h: number,
      dep: number,
      yaw: number,
      tilt: number,
    ) => {
      const [px, pz] = at(s, lat);
      const g = blockUv(
        boxFromTo(-len / 2, 0, -dep / 2, len / 2, h, dep / 2),
        -len / 2,
        0,
        -dep / 2,
        k++,
      );
      g.rotateX(rng.gauss() * tilt);
      g.rotateZ(rng.gauss() * tilt);
      g.rotateY(yaw);
      g.translate(px, y, pz);
      // Field stones vary a lot more than dressed quoins: tone and cast
      const tone = rng.range(0.58, 1.02);
      const cast = rng.range(-0.05, 0.05);
      bag.add("stone", g, [tone + cast, tone, tone - cast * 0.6]);
    };
    // Laid courses, two skins, following the ground
    for (let c = 0; c < 4; c++) {
      for (const sk of [-1, 1]) {
        let s = c % 2 === 0 ? 0.02 : 0.17;
        while (s < DYKE.len) {
          const len = rng.range(0.24, 0.4);
          if (courses(s + len / 2) > c) {
            const [px, pz] = at(s + len / 2, sk * 0.15);
            block(
              s + len / 2,
              sk * 0.15 + rng.gauss() * 0.012,
              this.groundLocal(px, pz) - 0.03 + c * COURSE,
              len - 0.012,
              COURSE * rng.range(0.9, 1.08),
              0.26,
              yawD + rng.gauss() * 0.03,
              0.03 + c * 0.012,
            );
          }
          s += len;
        }
      }
    }
    // Upright copes on the standing stretch, a few slipped off the end
    for (let s = 0.08; s < 2.25; s += 0.16) {
      const [px, pz] = at(s, 0);
      block(
        s,
        rng.gauss() * 0.02,
        this.groundLocal(px, pz) - 0.03 + 4 * COURSE,
        0.12,
        rng.range(0.2, 0.26),
        0.2,
        yawD + rng.gauss() * 0.06,
        0.08,
      );
    }
    for (let j = 0; j < 3; j++) {
      const s = 2.3 + j * 0.45;
      const lat = (j % 2 === 0 ? 1 : -1) * rng.range(0.28, 0.42);
      const [px, pz] = at(s, lat);
      block(
        s,
        lat,
        this.groundLocal(px, pz) - 0.05,
        0.22,
        0.1,
        0.2,
        rng.next() * Math.PI,
        0.25,
      );
    }
    // The fallen blocks of the missing courses, spilled either side
    for (let s = 2.0; s < DYKE.len; s += 0.3) {
      const missing = 4 - courses(s) + (s > 2.3 ? 1 : 0);
      for (let j = 0; j < missing; j++) {
        if (rng.chance(0.25)) continue;
        const lat = (rng.chance(0.5) ? 1 : -1) * rng.range(0.22, 0.85);
        const ss = s + rng.gauss() * 0.15;
        const [px, pz] = at(ss, lat);
        block(
          ss,
          lat,
          this.groundLocal(px, pz) - 0.045,
          rng.range(0.22, 0.4),
          rng.range(0.11, 0.16),
          rng.range(0.18, 0.26),
          rng.next() * Math.PI * 2,
          0.3,
        );
      }
    }
    // Sand banked along the tumble on both sides
    const [mx, mz] = at(5.7, 0);
    this.buildDrift(bag, mx, mz, 5.2, 0.9, 0.13, nx, nz);
    this.buildDrift(bag, mx, mz, 5.2, 0.9, 0.13, -nx, -nz);
  }

  // -------------------------------------------------------------------------
  // Nettles and docks
  // -------------------------------------------------------------------------

  /** Nettle clump: leaning stems with pairs of drooping serrated leaves. */
  private nettle(bag: Bag, rng: TexRng, x: number, z: number, lift = 0): void {
    const g0 = this.groundLocal(x, z) + lift;
    const n = 4 + rng.int(3);
    const tone = rng.range(0.85, 1.1);
    for (let k = 0; k < n; k++) {
      const bx = x + rng.gauss() * 0.09;
      const bz = z + rng.gauss() * 0.09;
      const h = rng.range(0.45, 0.72);
      const tx = bx + rng.gauss() * 0.09;
      const tz = bz + rng.gauss() * 0.09;
      bag.add(
        "wood",
        cylBetween(bx, g0 - 0.02, bz, tx, g0 + h, tz, 0.006, 5, 0.004),
        [0.3, 0.38, 0.2],
      );
      const az0 = rng.next() * Math.PI * 2;
      for (let p = 0; p < 3; p++) {
        const f = 0.45 + p * 0.22;
        const lx = bx + (tx - bx) * f;
        const ly = g0 + h * f;
        const lz = bz + (tz - bz) * f;
        const size = 0.085 * (1 - p * 0.12) * rng.range(0.9, 1.1);
        for (const side of [0, Math.PI]) {
          const leaf = regionUv(
            new THREE.PlaneGeometry(size * 0.8, size),
            FOLIAGE_UV.nettle,
          );
          leaf.translate(0, size / 2, 0);
          leaf.rotateX(-(Math.PI / 2 + rng.range(0.15, 0.45)));
          leaf.rotateY(az0 + p * 1.25 + side + rng.gauss() * 0.2);
          leaf.translate(lx, ly, lz);
          bag.add("foliage", leaf, [tone, tone * 1.02, tone * 0.95]);
        }
      }
    }
  }

  /** Dock: a rosette of broad leaves rising from the base and arching over. */
  private dock(bag: Bag, rng: TexRng, x: number, z: number, lift = 0): void {
    const g0 = this.groundLocal(x, z) + lift;
    const n = 6 + rng.int(3);
    const tone = rng.range(0.85, 1.05);
    const az0 = rng.next() * Math.PI * 2;
    for (let k = 0; k < n; k++) {
      const len = rng.range(0.22, 0.34);
      const leaf = regionUv(
        new THREE.PlaneGeometry(len * 0.48, len, 1, 4),
        FOLIAGE_UV.dock,
      );
      leaf.translate(0, len / 2, 0);
      const pos = leaf.getAttribute("position") as THREE.BufferAttribute;
      const bend = rng.range(0.9, 1.6);
      for (let i = 0; i < pos.count; i++) {
        const t = pos.getY(i) / len;
        pos.setZ(i, pos.getZ(i) - t * t * len * 0.55 * bend);
        pos.setY(i, pos.getY(i) * (1 - t * t * 0.3 * bend));
      }
      leaf.computeVertexNormals();
      leaf.rotateX(-rng.range(0.55, 1.05));
      leaf.rotateY(az0 + (k / n) * Math.PI * 2 + rng.gauss() * 0.25);
      leaf.translate(x + rng.gauss() * 0.02, g0 - 0.01, z + rng.gauss() * 0.02);
      bag.add("foliage", leaf, [tone, tone, tone * 0.96]);
    }
  }

  private buildFoliage(bag: Bag): void {
    const rng = new TexRng(0xf0f1);
    // Either side of the door step
    this.nettle(bag, rng, 0.3, HW + 0.3);
    this.nettle(bag, rng, DOOR_X1 + 0.85, HW + 0.22);
    this.dock(bag, rng, 0.05, HW + 0.7);
    // Along the north wall, lifted where the sand drift lies against it
    const backZ = -HW - 0.28;
    this.nettle(bag, rng, -2.15, backZ);
    this.dock(bag, rng, -1.15, backZ - 0.05);
    this.nettle(bag, rng, -0.2, backZ);
    this.nettle(bag, rng, 1.0, backZ, 0.05);
    this.dock(bag, rng, 1.9, backZ + 0.02, 0.05);
    this.nettle(bag, rng, 2.55, backZ - 0.1);
    // Odd clumps at the open gable and by the woodpile
    this.nettle(bag, rng, HL + 0.5, 1.45);
    this.dock(bag, rng, HL + 1.1, -1.05);
  }

  private slate(
    bag: Bag,
    g: THREE.BufferGeometry,
    off: number,
    tint: Tint,
  ): void {
    const geo = slateUv(g, off);
    geo.applyMatrix4(this.shellM);
    bag.add("slate", geo, tint);
  }

  private buildWalls(bag: Bag): void {
    const yP = this.yPlinth;
    const F0 = HW - T;
    const F1 = HW;

    // Front wall around the door and the window
    const front: Array<[number, number, number, number]> = [
      [-HL, yP, WIN_X0, EAVE_Y],
      [WIN_X0, yP, WIN_X1, WIN_Y0],
      [WIN_X0, WIN_Y1, WIN_X1, EAVE_Y],
      [WIN_X1, yP, DOOR_X0, EAVE_Y],
      [DOOR_X0, DOOR_H, DOOR_X1, EAVE_Y],
      [DOOR_X1, yP, HL, EAVE_Y],
    ];
    for (const [x0, y0, x1, y1] of front) {
      this.stone(bag, boxFromTo(x0, y0, F0, x1, y1, F1), 0.35);
    }
    // Back wall
    this.stone(bag, boxFromTo(-HL, yP, -HW, HL, EAVE_Y, -HW + T), 2.3);

    // Open gable (+x): full pentagon
    // Skew gables: the stone rises a course above the roof timbers, so the
    // purlin and ridge ends are built into the wall rather than showing
    const gablePts = (yb: number): Array<[number, number]> => [
      [-HW, yb],
      [HW, yb],
      [HW, EAVE_Y + SKEW],
      [0, RIDGE_Y + SKEW],
      [-HW, EAVE_Y + SKEW],
    ];
    this.stone(bag, prismX(gablePts(yP), HL - T, HL), 1.2);

    // Hearth gable (−x): piers beside the fireplace, recess back, pentagon above
    this.stone(
      bag,
      boxFromTo(-HL, yP, -HW, GABLE_IN, HEARTH_H, -HEARTH_HW),
      3.1,
    );
    this.stone(bag, boxFromTo(-HL, yP, HEARTH_HW, GABLE_IN, HEARTH_H, HW), 3.1);
    this.stone(
      bag,
      boxFromTo(-HL, yP, -HEARTH_HW, RECESS_X, HEARTH_H, HEARTH_HW),
      3.1,
      [0.3, 0.29, 0.28],
    );
    this.stone(bag, prismX(gablePts(HEARTH_H), -HL, GABLE_IN), 3.1);
    // Chimney breast into the room
    this.stone(
      bag,
      boxFromTo(BREAST_X, yP, -0.8, GABLE_IN, HEARTH_H, -HEARTH_HW),
      0.9,
      [0.6, 0.58, 0.57],
    );
    this.stone(
      bag,
      boxFromTo(BREAST_X, yP, HEARTH_HW, GABLE_IN, HEARTH_H, 0.8),
      0.9,
      [0.6, 0.58, 0.57],
    );
    this.stone(
      bag,
      boxFromTo(BREAST_X, HEARTH_H, -0.8, GABLE_IN, EAVE_Y, 0.8),
      0.9,
    );
    // Chimney stack straddling the gable, sooted at the top
    this.stone(
      bag,
      boxFromTo(-HL - 0.2, EAVE_Y - 0.3, -0.45, GABLE_IN + 0.05, 4.05, 0.45),
      1.7,
      [0.88, 0.87, 0.86],
    );
    this.slate(
      bag,
      boxFromTo(-HL - 0.28, 4.05, -0.53, GABLE_IN + 0.13, 4.11, 0.53),
      0.2,
      [0.8, 0.8, 0.82],
    );

    // Lintels and sill: single slabs of slate
    this.slate(
      bag,
      boxFromTo(
        DOOR_X0 - 0.1,
        DOOR_H,
        F0 - 0.02,
        DOOR_X1 + 0.1,
        DOOR_H + 0.14,
        F1 + 0.02,
      ),
      0.5,
      [0.85, 0.85, 0.87],
    );
    this.slate(
      bag,
      boxFromTo(
        WIN_X0 - 0.1,
        WIN_Y1 - 0.01,
        F0 - 0.02,
        WIN_X1 + 0.1,
        WIN_Y1 + 0.12,
        F1 + 0.02,
      ),
      0.9,
      [0.85, 0.85, 0.87],
    );
    this.slate(
      bag,
      boxFromTo(
        WIN_X0 - 0.08,
        WIN_Y0 - 0.06,
        F0 - 0.03,
        WIN_X1 + 0.08,
        WIN_Y0,
        F1 + 0.07,
      ),
      1.3,
      [1.02, 1.02, 1.04],
    );
    this.slate(
      bag,
      boxFromTo(
        RECESS_X + 0.05,
        HEARTH_H,
        -0.55,
        BREAST_X + 0.03,
        HEARTH_H + 0.17,
        0.55,
      ),
      1.6,
      [0.62, 0.6, 0.6],
    );

    // Scratched initials and tally marks beside the door, inside
    const marks = decalQuad(DECAL_UV.marks, 0.55, 0.55);
    marks.rotateY(Math.PI);
    marks.translate(DOOR_X0 - 0.36, 1.35, F0 - 0.006);
    marks.applyMatrix4(this.shellM);
    bag.add("decal", marks);
  }

  // -------------------------------------------------------------------------
  // Roof timbers
  // -------------------------------------------------------------------------

  private wood(
    bag: Bag,
    g: THREE.BufferGeometry,
    tint: Tint,
    shell = true,
  ): void {
    if (shell) g.applyMatrix4(this.shellM);
    bag.add("wood", g, tint);
  }

  private buildRoof(bag: Bag): void {
    const TIMBER: Tint = [0.92, 0.9, 0.86];
    const DARK: Tint = [0.62, 0.6, 0.56];
    const SARK: Tint = [0.5, 0.48, 0.45];
    const rng = new TexRng(0x51a7e);

    // Wall plates and ridge board
    for (const s of [-1, 1]) {
      this.wood(
        bag,
        timberBox(0.12, 0.08, HL * 2 - 0.1, s + 2)
          .rotateY(Math.PI / 2)
          .translate(0, EAVE_Y + 0.04, s * (HW - 0.14)),
        TIMBER,
      );
    }
    this.wood(
      bag,
      timberBox(0.04, 0.16, VERGE_X * 2, 0.7)
        .rotateY(Math.PI / 2)
        .translate(0, RIDGE_Y + 0.02, 0),
      TIMBER,
    );

    // Rafter pairs every 0.62 m; the open half has lost and broken members
    const NR = 9;
    for (let k = 0; k < NR; k++) {
      const x = -2.48 + k * 0.62;
      for (const s of [-1, 1]) {
        const tone = rng.range(0.9, 1.05);
        const tint: Tint = [
          TIMBER[0] * tone,
          TIMBER[1] * tone,
          TIMBER[2] * tone,
        ];
        if (k === 7 && s > 0) continue; // gone
        if (k === 6 && s > 0) {
          // Broken: a stub hangs from the ridge, the rest lies on the floor
          const stub = timberBox(0.06, 0.12, 1.15, 1.3);
          stub.rotateX(s * PITCH);
          slopePoint(s, SLOPE_LEN - 0.03 - 0.575, 0.06, TV);
          stub.translate(x, TV.y, TV.z);
          slopePoint(s, SLOPE_LEN - 0.03, 0.06, TV);
          stub.translate(-x, -TV.y, -TV.z);
          stub.rotateX(s * 0.42);
          stub.translate(x, TV.y, TV.z);
          this.wood(bag, stub, tint);
          const gA = this.groundLocal(0.7, 1.0);
          const gB = this.groundLocal(1.9, -0.3);
          this.wood(
            bag,
            boxBetween(0.7, gA + 0.1, 1.0, 1.9, gB + 0.07, -0.3, 0.06, 0.12),
            [0.7, 0.68, 0.64],
            false,
          );
          continue;
        }
        this.wood(
          bag,
          slopeBox(
            0.06,
            0.12,
            SLOPE_LEN - 0.06,
            s,
            SLOPE_LEN / 2 - 0.03,
            0.06,
            x,
            k * 0.4,
          ),
          tint,
        );
      }
    }

    // Purlins on the rafters: the upper pair runs from the roofed verge to
    // the open gable (built into it), the lower front one is broken off over
    // the open half
    const upperX0 = -VERGE_X;
    const upperX1 = VERGE_X;
    for (const s of [-1, 1]) {
      const len = upperX1 - upperX0;
      this.wood(
        bag,
        slopeBox(
          len,
          0.1,
          0.08,
          s,
          1.72,
          0.17,
          (upperX0 + upperX1) / 2,
          s * 0.9,
        ).rotateY(0),
        TIMBER,
      );
    }
    // slopeBox lays its length along the slope – purlins run along x instead
    this.purlin(bag, -1, 0.85, upperX0, upperX1, TIMBER);
    this.purlin(bag, 1, 0.85, upperX0, 1.3, TIMBER);
    slopePoint(1, 0.85, 0.17, TV);
    this.wood(
      bag,
      boxBetween(1.3, TV.y, TV.z, 1.78, TV.y - 0.42, TV.z + 0.12, 0.08, 0.1),
      DARK,
    );

    // Collar ties in the roofed half, one hanging broken in the open half
    const cy = EAVE_Y + 0.75;
    const chz = (RIDGE_Y - cy) / TAN_P;
    for (const x of [-1.86, -1.24, -0.62]) {
      this.wood(
        bag,
        timberBox(0.05, 0.1, chz * 2 + 0.08, x).translate(x + 0.055, cy, 0),
        TIMBER,
      );
    }
    this.wood(
      bag,
      boxBetween(
        1.24 + 0.055,
        cy,
        -chz,
        1.24 + 0.09,
        cy - 0.62,
        -chz + 0.42,
        0.05,
        0.1,
      ),
      DARK,
    );

    // Sarking boards under the surviving slates (dark from inside)
    const sx0 = -VERGE_X + 0.02;
    const sx1 = ROOF_EDGE_X - 0.25;
    for (const s of [-1, 1]) {
      this.wood(
        bag,
        slopeBox(
          sx1 - sx0,
          0.02,
          SLOPE_LEN - 0.12,
          s,
          SLOPE_LEN / 2 - 0.04,
          0.13,
          (sx0 + sx1) / 2,
          0.3,
        ),
        SARK,
      );
    }
  }

  /** Purlin along x, lying on the rafters at slope distance d. */
  private purlin(
    bag: Bag,
    s: number,
    d: number,
    x0: number,
    x1: number,
    tint: Tint,
  ): void {
    const g = timberBox(0.1, 0.08, x1 - x0, s * 2.1);
    g.rotateY(Math.PI / 2);
    g.rotateX(s * PITCH);
    slopePoint(s, d, 0.17, TV);
    g.translate((x0 + x1) / 2, TV.y, TV.z);
    this.wood(bag, g, tint);
  }

  // -------------------------------------------------------------------------
  // Slates
  // -------------------------------------------------------------------------

  private buildSlates(bag: Bag): void {
    const rng = new TexRng(0x51a7e5);
    const SL = 0.5;
    const SW = 0.3;
    const ST = 0.013;
    const ROW = 0.22;
    const axis = new THREE.Vector3();
    for (const s of [-1, 1]) {
      for (let r = 0; ; r++) {
        const d = 0.14 + r * ROW;
        if (d > SLOPE_LEN - SL / 2 + 0.06) break;
        const dc = Math.min(d, SLOPE_LEN - SL / 2 + 0.02);
        const edge =
          ROOF_EDGE_X + (hash01(r, s + 2, 5) - 0.5) * 0.9 + (r % 2) * 0.1;
        const x0 = -VERGE_X + SW / 2 + (r % 2) * (SW / 2);
        for (let x = x0; x < VERGE_X - SW / 4; x += SW + 0.008) {
          let keep = x < edge;
          let slipped = false;
          if (!keep && x < edge + 1.1) {
            keep = rng.chance(0.22);
            slipped = rng.chance(0.5);
          } else if (!keep && d < 0.5 && rng.chance(0.06)) {
            keep = true;
            slipped = rng.chance(0.5);
          }
          if (!keep) {
            rng.next();
            continue;
          }
          const drop = slipped ? rng.range(0.08, 0.26) : 0;
          const n = 0.16 + (slipped ? 0.012 : 0) + rng.range(-0.002, 0.002);
          const g = new THREE.BoxGeometry(SW - 0.006, ST, SL);
          // Each slate samples its own patch of the tileable slate set
          const uv = g.getAttribute("uv") as THREE.BufferAttribute;
          const du = rng.next();
          const dv = rng.next();
          for (let i = 0; i < uv.count; i++) {
            uv.setXY(i, du + uv.getX(i) * 0.5, dv + uv.getY(i) * 0.8);
          }
          g.rotateX(s * PITCH);
          slopePoint(s, dc - drop, n, TV);
          const ang = slipped ? rng.range(-0.3, 0.3) : rng.range(-0.02, 0.02);
          axis.set(0, COS_P, s * SIN_P);
          TM.makeRotationAxis(axis, ang);
          g.applyMatrix4(TM);
          g.translate(x, TV.y, TV.z);
          g.applyMatrix4(this.shellM);
          const tone = rng.range(0.85, 1.12);
          bag.add("slate", g, [tone, tone, tone * 1.02]);
        }
      }
      // Ridge caps over the roofed half
      for (let x = -VERGE_X + 0.12; x < ROOF_EDGE_X - 0.1; x += 0.3) {
        const g = new THREE.BoxGeometry(0.28, 0.02, 0.22);
        g.rotateX(s * PITCH);
        slopePoint(s, SLOPE_LEN - 0.08, 0.175, TV);
        g.translate(x, TV.y, TV.z);
        g.applyMatrix4(this.shellM);
        bag.add("slate", g, [0.72, 0.72, 0.74]);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Hearth
  // -------------------------------------------------------------------------

  private buildHearth(bag: Bag): void {
    const cg = this.groundLocal(GABLE_IN, 0);
    const SOOT: Tint = [0.22, 0.21, 0.2];

    // Hearth slab, flush with the floor, and the ash bed on it
    const slab = slateUv(
      boxFromTo(
        RECESS_X - 0.02,
        cg - 0.1,
        -0.55,
        BREAST_X + 0.22,
        cg + 0.03,
        0.55,
      ),
      2.4,
    );
    bag.add("slate", slab, [0.75, 0.75, 0.76]);
    const na = this.seg(8, 5);
    const ash = makeSheet(na, na, (ti, tj, o) => {
      const ax = (ti * 2 - 1) * 0.3;
      const az = (tj * 2 - 1) * 0.28;
      const rn = Math.min(1, Math.hypot(ax / 0.3, az / 0.28));
      o.x = BREAST_X - 0.12 + ax;
      o.z = -0.06 + az;
      o.y =
        cg +
        0.03 +
        (1 - rn * rn) * 0.06 +
        (fbm(ax * 7 + 2, az * 7, 2) - 0.5) * 0.02 * (1 - rn);
      const [u0, v0, u1, v1] = DRESS_UV.ash;
      o.u = u0 + ti * (u1 - u0);
      o.v = v0 + tj * (v1 - v0);
      const k = 0.85 + 0.3 * (1 - rn);
      o.r = k;
      o.g = k;
      o.b = k;
    });
    bag.add("dress", ash);
    // Two charred log ends left in the ash
    for (const [ax, az, bx, bz] of [
      [BREAST_X + 0.05, 0.2, GABLE_IN - 0.2, 0.05],
      [BREAST_X - 0.02, -0.25, RECESS_X + 0.1, -0.12],
    ]) {
      const g = cylBetween(
        ax,
        cg + 0.05,
        az,
        bx,
        cg + 0.06,
        bz,
        0.035,
        this.seg(8, 5),
        0.028,
      );
      bag.add("wood", g, [0.2, 0.18, 0.17]);
    }

    // Iron crane: post in the pier, arm, brace, hook – all blackened
    const px = RECESS_X + 0.14;
    const pz = HEARTH_HW - 0.06;
    const top = HEARTH_H + 0.04;
    bag.add(
      "rust",
      cylBetween(px, cg - 0.05, pz, px, top, pz, 0.018, this.seg(8, 6)),
      SOOT,
    );
    bag.add(
      "rust",
      cylBetween(
        px,
        top - 0.12,
        pz,
        px + 0.05,
        top - 0.12,
        pz - 0.7,
        0.014,
        this.seg(7, 5),
      ),
      SOOT,
    );
    bag.add(
      "rust",
      cylBetween(px, top - 0.5, pz, px + 0.04, top - 0.14, pz - 0.52, 0.009, 5),
      SOOT,
    );
    const hook = new THREE.TorusGeometry(
      0.03,
      0.006,
      5,
      this.seg(10, 7),
      Math.PI * 1.5,
    );
    hook.rotateY(Math.PI / 2);
    hook.translate(px + 0.04, top - 0.17, pz - 0.55);
    bag.add("rust", hook, SOOT);
    // Pot hanging on its bail over the cold ash
    const potX = px + 0.04;
    const potZ = pz - 0.56;
    const bail = new THREE.TorusGeometry(
      0.11,
      0.007,
      5,
      this.seg(14, 9),
      Math.PI,
    );
    bail.rotateY(Math.PI / 2);
    bail.translate(potX, top - 0.3, potZ);
    bag.add("rust", bail, SOOT);
    const profile: Array<[number, number]> = [
      [0.002, 0],
      [0.085, 0.003],
      [0.12, 0.04],
      [0.132, 0.11],
      [0.126, 0.18],
      [0.115, 0.2],
      [0.1, 0.2],
      [0.1, 0.185],
      [0.108, 0.1],
      [0.09, 0.03],
      [0.002, 0.03],
    ];
    const pot = new THREE.LatheGeometry(
      profile.map(([r, y]) => new THREE.Vector2(r, y)),
      this.seg(22, 12),
    );
    pot.translate(potX, top - 0.3 - 0.2, potZ);
    bag.add("rust", pot, SOOT);
    for (const s of [-1, 1]) {
      const lug = cylBetween(
        potX,
        top - 0.32,
        potZ + s * 0.11,
        potX,
        top - 0.3,
        potZ + s * 0.13,
        0.008,
        5,
      );
      bag.add("rust", lug, SOOT);
    }

    // Soot: the recess back and the plume up the breast
    const back = decalQuad(DECAL_UV.soot, 0.88, 0.8);
    back.rotateY(Math.PI / 2);
    back.translate(RECESS_X + 0.006, cg + 0.44, 0);
    back.applyMatrix4(this.shellM);
    bag.add("decal", back);
    const plume = decalQuad(DECAL_UV.soot, 1.0, 1.05);
    plume.rotateY(Math.PI / 2);
    plume.translate(BREAST_X + 0.006, HEARTH_H + 0.17 + 0.52, 0);
    plume.applyMatrix4(this.shellM);
    bag.add("decal", plume);
  }

  // -------------------------------------------------------------------------
  // Window with its broken frame
  // -------------------------------------------------------------------------

  private buildWindow(bag: Bag): void {
    const FRAME: Tint = [0.72, 0.7, 0.66];
    const z = HW - 0.16;
    const h = WIN_Y1 - WIN_Y0;
    // Intact stile, broken stile (lower part + splintered tip), head
    this.wood(
      bag,
      timberBox(0.05, 0.05, h - 0.02, 0.2)
        .rotateX(-Math.PI / 2)
        .translate(WIN_X1 - 0.03, (WIN_Y0 + WIN_Y1) / 2, z),
      FRAME,
    );
    this.wood(
      bag,
      timberBox(0.05, 0.05, 0.34, 0.5)
        .rotateX(-Math.PI / 2)
        .translate(WIN_X0 + 0.03, WIN_Y0 + 0.17, z),
      FRAME,
    );
    this.wood(
      bag,
      boxBetween(
        WIN_X0 + 0.03,
        WIN_Y0 + 0.33,
        z,
        WIN_X0 + 0.06,
        WIN_Y0 + 0.46,
        z + 0.03,
        0.03,
        0.02,
      ),
      FRAME,
    );
    this.wood(
      bag,
      timberBox(0.05, 0.05, WIN_X1 - WIN_X0, 0.8)
        .rotateY(Math.PI / 2)
        .translate((WIN_X0 + WIN_X1) / 2, WIN_Y1 - 0.025, z),
      FRAME,
    );
    // Glazing bar hanging from the head
    const mx = (WIN_X0 + WIN_X1) / 2;
    this.wood(
      bag,
      boxBetween(
        mx,
        WIN_Y1 - 0.05,
        z,
        mx + 0.24,
        WIN_Y0 + 0.1,
        z - 0.06,
        0.03,
        0.03,
      ),
      FRAME,
    );
  }

  // -------------------------------------------------------------------------
  // Bed, shelf, stool
  // -------------------------------------------------------------------------

  private buildBed(bag: Bag): void {
    const IRON: Tint = [0.5, 0.46, 0.43];
    const x0 = 0.2;
    const x1 = 2.1;
    const z0 = -HW + T + 0.05;
    const z1 = z0 + 0.85;
    let gMax = Number.NEGATIVE_INFINITY;
    for (const [x, z] of [
      [x0, z0],
      [x0, z1],
      [x1, z0],
      [x1, z1],
    ]) {
      gMax = Math.max(gMax, this.groundLocal(x, z));
    }
    const fy = gMax + 0.42;
    const seg = this.seg(8, 6);
    // Legs and the taller head/foot posts
    for (const [x, z, h] of [
      [x0, z0, 0.65],
      [x0, z1, 0.65],
      [x1, z0, 0.95],
      [x1, z1, 0.95],
    ]) {
      bag.add(
        "rust",
        cylBetween(
          x,
          this.groundLocal(x, z) - 0.04,
          z,
          x,
          fy + h - 0.42,
          z,
          0.018,
          seg,
        ),
        IRON,
      );
    }
    // Head and foot rails with their uprights
    for (const [x, h, n] of [
      [x1, 0.95, 4],
      [x0, 0.65, 3],
    ]) {
      const ty = fy + h - 0.42;
      bag.add("rust", cylBetween(x, ty, z0, x, ty, z1, 0.014, seg), IRON);
      bag.add(
        "rust",
        cylBetween(x, fy + 0.1, z0, x, fy + 0.1, z1, 0.012, seg),
        IRON,
      );
      for (let k = 1; k <= n; k++) {
        const z = z0 + ((z1 - z0) * k) / (n + 1);
        bag.add("rust", cylBetween(x, fy + 0.1, z, x, ty, z, 0.007, 5), IRON);
      }
    }
    // Side rails (angle iron) and the wire lattice
    for (const z of [z0, z1]) {
      bag.add("rust", box(x1 - x0, 0.05, 0.035, (x0 + x1) / 2, fy, z), IRON);
    }
    for (let k = 0; k < 5; k++) {
      const z = z0 + 0.08 + ((z1 - z0 - 0.16) * k) / 4;
      bag.add(
        "rust",
        cylBetween(
          x0 + 0.03,
          fy + 0.005,
          z,
          x1 - 0.03,
          fy + 0.005,
          z,
          0.004,
          4,
        ),
        IRON,
      );
    }
    const nx = this.seg(9, 5);
    for (let k = 0; k <= nx; k++) {
      const x = x0 + 0.06 + ((x1 - x0 - 0.12) * k) / nx;
      bag.add(
        "rust",
        cylBetween(
          x,
          fy + 0.012,
          z0 + 0.02,
          x,
          fy + 0.012,
          z1 - 0.02,
          0.004,
          4,
        ),
        IRON,
      );
    }

    // Rotten mattress husk: a slab sagging through the lattice, torn and
    // collapsed at the exposed end under the open roof
    const mx = (x0 + x1) / 2;
    const mz = (z0 + z1) / 2;
    const mat = new THREE.BoxGeometry(1.8, 0.09, 0.74, 12, 1, 6);
    const pos = mat.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = pos.getY(i);
      const sag = 0.07 * (1 - (x / 0.9) ** 2) * (1 - (z / 0.37) ** 2);
      const collapse = 0.035 * sstep(0.3, 0.9, x / 0.9);
      const wr = (fbm(x * 3 + 5, z * 4 + 2, 3) - 0.5) * 0.03;
      pos.setY(i, y * (1 - collapse * 6) - sag - collapse + wr);
    }
    pos.needsUpdate = true;
    mat.computeVertexNormals();
    const [u0, v0, u1, v1] = DRESS_UV.ticking;
    const husk = projectUv(mat, (x, y, z, _nx, ny) => {
      if (Math.abs(ny) > 0.5) {
        return [
          u0 + ((x + 0.9) / 1.8) * (u1 - u0),
          v0 + ((z + 0.37) / 0.74) * (v1 - v0),
        ];
      }
      return [
        u0 + ((x + z + 1.3) / 2.6) * (u1 - u0),
        v0 + (0.02 + (y + 0.1) * 0.5) * (v1 - v0),
      ];
    });
    const hn = husk.getAttribute("position").count;
    const col = new Float32Array(hn * 3);
    const hp = husk.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < hn; i++) {
      const x = hp.getX(i);
      const z = hp.getZ(i);
      const rot =
        0.45 * sstep(0.4, 0.8, fbm(x * 1.6 + 7, z * 2.4, 3)) +
        0.3 * sstep(0.3, 0.9, x / 0.9);
      const k = 1 - rot;
      col[i * 3] = k;
      col[i * 3 + 1] = k * 0.97;
      col[i * 3 + 2] = k * 0.92;
    }
    husk.setAttribute("color", new THREE.BufferAttribute(col, 3));
    husk.translate(mx, fy + 0.07, mz);
    bag.add("dress", husk);
  }

  private buildShelf(bag: Bag): void {
    const PLANK: Tint = [0.82, 0.8, 0.75];
    const x0 = -1.9;
    const x1 = -0.6;
    const zw = -HW + T;
    const y = 1.4;
    bag.add(
      "wood",
      timberBox(0.22, 0.03, x1 - x0, 1.1)
        .rotateY(Math.PI / 2)
        .translate((x0 + x1) / 2, y, zw + 0.11),
      PLANK,
    );
    for (const x of [x0 + 0.2, x1 - 0.2]) {
      bag.add(
        "wood",
        boxBetween(x, y - 0.02, zw + 0.02, x, y - 0.2, zw + 0.19, 0.03, 0.03),
        PLANK,
      );
      bag.add(
        "wood",
        boxBetween(x, y - 0.24, zw + 0.02, x, y - 0.2, zw + 0.19, 0.03, 0.03),
        PLANK,
      );
    }
    // Three chipped enamel plates leaning against the wall, and a mug
    const seg = this.seg(24, 14);
    const profile = [
      new THREE.Vector2(0.002, 0),
      new THREE.Vector2(0.072, 0.004),
      new THREE.Vector2(0.104, 0.02),
      new THREE.Vector2(0.116, 0.03),
      new THREE.Vector2(0.119, 0.035),
    ];
    let k = 0;
    for (const x of [x0 + 0.32, x0 + 0.62, x0 + 0.9]) {
      const plate = regionUv(
        new THREE.LatheGeometry(profile, seg),
        DRESS_UV.enamel,
      );
      plate.rotateX(Math.PI / 2 - 0.22 - k * 0.04);
      plate.rotateY((k - 1) * 0.12);
      plate.translate(x, y + 0.015 + 0.117, zw + 0.035 + k * 0.012);
      const tone = 1 - k * 0.04;
      bag.add("dress", plate, [tone, tone, tone * 0.98]);
      k++;
    }
    const mug = regionUv(
      new THREE.CylinderGeometry(0.04, 0.037, 0.09, this.seg(16, 10)),
      DRESS_UV.enamel,
    );
    mug.translate(x1 - 0.14, y + 0.015 + 0.045, zw + 0.11);
    bag.add("dress", mug, [0.96, 0.95, 0.92]);
    const handle = regionUv(
      new THREE.TorusGeometry(0.024, 0.006, 5, this.seg(12, 8), Math.PI),
      DRESS_UV.enamel,
    );
    handle.rotateZ(-Math.PI / 2);
    handle.rotateY(-0.6);
    handle.translate(x1 - 0.14 + 0.05, y + 0.015 + 0.045, zw + 0.11 + 0.02);
    bag.add("dress", handle, [0.96, 0.95, 0.92]);
  }

  private buildStool(bag: Bag): void {
    const STOOL: Tint = [0.85, 0.8, 0.72];
    const cx = -1.35;
    const cz = 0.55;
    const g0 = this.groundLocal(cx, cz);
    const sy = g0 + 0.42;
    const seat = new THREE.CylinderGeometry(
      0.17,
      0.165,
      0.035,
      this.seg(14, 9),
    );
    seat.rotateZ(0.03);
    seat.translate(cx, sy, cz);
    bag.add("wood", seat, STOOL);
    for (let k = 0; k < 3; k++) {
      const a = 0.4 + (k * Math.PI * 2) / 3;
      const lx = cx + Math.cos(a) * 0.2;
      const lz = cz + Math.sin(a) * 0.2;
      bag.add(
        "wood",
        cylBetween(
          cx + Math.cos(a) * 0.1,
          sy - 0.02,
          cz + Math.sin(a) * 0.1,
          lx,
          this.groundLocal(lx, lz) - 0.02,
          lz,
          0.02,
          this.seg(7, 5),
          0.024,
        ),
        STOOL,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Floor drift
  // -------------------------------------------------------------------------

  private buildFloor(bag: Bag): void {
    const nx = this.seg(30, 14);
    const nz = this.seg(18, 9);
    const [u0, v0, u1, v1] = DRESS_UV.litter;
    const sheet = makeSheet(nx, nz, (ti, tj, o) => {
      const x = (ti * 2 - 1) * 2.1;
      const z = (tj * 2 - 1) * 1.3;
      o.x = x;
      o.z = z;
      o.y = this.groundLocal(x, z) + this.litterHeight(x, z);
      // Mirror the atlas region at x = 0 so the needles stay near isotropic
      const mu = x < 0 ? (x + 2.1) / 2.1 : 1 - x / 2.1;
      o.u = u0 + mu * (u1 - u0);
      o.v = v0 + tj * (v1 - v0);
      // Darker under the surviving roof, bleached where the rain gets in
      const shade = 1 - 0.14 * sstep(0.4, -0.6, x);
      const k = shade * (0.94 + 0.12 * fbm(x * 1.3 + 4, z * 1.5 + 8, 2));
      o.r = k;
      o.g = k;
      o.b = k;
    });
    bag.add("dress", sheet);
  }

  // -------------------------------------------------------------------------
  // Yard: step, path, bucket, drifts
  // -------------------------------------------------------------------------

  private buildYard(bag: Bag): void {
    // Flagstone step at the door, worn hollow in the middle
    const sx = (DOOR_X0 + DOOR_X1) / 2;
    const sz = HW + 0.34;
    const sg = this.groundLocal(sx, sz);
    const step = new THREE.BoxGeometry(1.15, 0.1, 0.62, 4, 1, 3);
    const sp = step.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < sp.count; i++) {
      if (sp.getY(i) > 0) {
        const x = sp.getX(i);
        const z = sp.getZ(i);
        sp.setY(i, 0.05 - 0.018 * Math.exp(-(x * x * 3 + z * z * 8)));
      }
    }
    sp.needsUpdate = true;
    step.computeVertexNormals();
    step.rotateY(0.04);
    step.translate(sx, sg + 0.02, sz);
    bag.add("slate", slateUv(step, 3.3), [0.95, 0.95, 0.96]);
    const needles = decalQuad(DECAL_UV.needles, 1.0, 0.55);
    needles.rotateX(-Math.PI / 2);
    needles.rotateY(0.04);
    needles.translate(sx, sg + 0.074, sz);
    bag.add("decal", needles);

    // Worn path: a ribbon of compacted-sand decal from the step towards the
    // pines, alongside the dyke, hugging the terrain
    const P = (t: number): [number, number] => [
      sx + 3.5 * t + 0.4 * Math.sin(t * 3),
      sz + 0.4 + 6.0 * t,
    ];
    const [u0, v0, u1, v1] = DECAL_UV.path;
    const path = makeSheet(this.seg(28, 14), 4, (ti, tj, o) => {
      const [px, pz] = P(ti);
      const [qx, qz] = P(Math.min(1, ti + 0.01));
      const tx = qx - px;
      const tz = qz - pz;
      const tl = Math.hypot(tx, tz) || 1;
      const w = (tj * 2 - 1) * 0.6;
      const lx = px + (-tz / tl) * w;
      const lz = pz + (tx / tl) * w;
      o.x = lx;
      o.z = lz;
      o.y = this.groundLocal(lx, lz) + 0.012;
      o.u = u0 + ti * (u1 - u0);
      o.v = v0 + tj * (v1 - v0);
    });
    bag.add("decal", path);

    // Rusty bucket on its side by the step
    const bx = 1.95;
    const bz = HW + 0.78;
    const bg = this.groundLocal(bx, bz);
    const prof: Array<[number, number]> = [
      [0.002, 0],
      [0.12, 0],
      [0.125, 0.02],
      [0.148, 0.27],
      [0.15, 0.285],
      [0.138, 0.285],
      [0.135, 0.26],
      [0.112, 0.02],
      [0.002, 0.02],
    ];
    const bucket = new THREE.LatheGeometry(
      prof.map(([r, y]) => new THREE.Vector2(r, y)),
      this.seg(22, 12),
    );
    const bail = new THREE.TorusGeometry(
      0.15,
      0.007,
      5,
      this.seg(14, 9),
      Math.PI,
    );
    bail.rotateZ(-0.35);
    bail.translate(0, 0.28, 0);
    const bq = new THREE.Quaternion()
      .setFromAxisAngle(UP, 2.4)
      .multiply(
        new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 0, 1),
          1.5,
        ),
      );
    const bm = new THREE.Matrix4().compose(
      new THREE.Vector3(bx, bg + 0.14, bz),
      bq,
      new THREE.Vector3(1, 1, 1),
    );
    for (const g of [bucket, bail]) {
      g.applyMatrix4(bm);
      bag.add("rust", g, [0.46, 0.41, 0.37]);
    }

    // Sand drifts banked against the front wall and the back wall's open end
    this.buildDrift(bag, 1.5, HW, 2.6, 1.0, 0.24, 0, 1);
    this.buildDrift(bag, 1.2, -HW, 2.4, 0.9, 0.18, 0, -1);
  }

  /**
   * Wind-blown sand drift against a wall line through (cx, cz) with outward
   * direction (ox, oz): a low mound that hugs the terrain, sunk at the edges
   * so it never floats, textured like the terrain at the same world tiling.
   */
  private buildDrift(
    bag: Bag,
    cx: number,
    cz: number,
    len: number,
    dep: number,
    hgt: number,
    ox: number,
    oz: number,
  ): void {
    // Tangent chosen so the sheet's winding faces up (out × tangent = +y)
    const tx = oz;
    const tz = -ox;
    const nx = this.seg(12, 7);
    const nb = this.seg(6, 4);
    const drift = makeSheet(nx, nb, (ti, tj, o) => {
      const a = (ti * 2 - 1) * (len / 2);
      const b = -0.08 + tj * (dep + 0.08);
      const bf = clamp01(b / dep);
      const af = a / (len / 2);
      const h =
        hgt *
        Math.max(0, 1 - af * af) ** 1.3 *
        (1 - bf) ** 1.7 *
        (0.85 + 0.3 * fbm(a * 2 + 3, b * 2, 2));
      const lx = cx + tx * a + ox * b;
      const lz = cz + tz * a + oz * b;
      o.x = lx;
      o.z = lz;
      o.y = this.groundLocal(lx, lz) + h - 0.035;
      const [wx, wz] = this.worldXZ(lx, lz);
      o.u = (wx + 410) / SAND_TILE_X;
      o.v = (420 - wz) / SAND_TILE_Z;
    });
    bag.add("sand", drift);
  }

  // -------------------------------------------------------------------------
  // Woodpile
  // -------------------------------------------------------------------------

  private buildWoodpile(bag: Bag): void {
    const rng = new TexRng(0x100d);
    const seg = this.seg(10, 6);
    const count =
      this.quality === "ultra" || this.quality === "high"
        ? 24
        : this.quality === "medium"
          ? 18
          : 14;
    const log = (
      x: number,
      y: number,
      z: number,
      yaw: number,
      tilt: number,
      len: number,
      r: number,
      tint: Tint,
    ) => {
      const dx = Math.cos(yaw) * Math.cos(tilt) * (len / 2);
      const dz = Math.sin(yaw) * Math.cos(tilt) * (len / 2);
      const dy = Math.sin(tilt) * (len / 2);
      bag.add(
        "wood",
        cylBetween(
          x - dx,
          y - dy,
          z - dz,
          x + dx,
          y + dy,
          z + dz,
          r,
          seg,
          r * rng.range(0.85, 1),
        ),
        tint,
      );
    };
    const tintOf = (): Tint => {
      if (rng.chance(0.2)) return [0.52, 0.47, 0.4];
      const k = rng.range(0.85, 1.1);
      return [0.86 * k, 0.83 * k, 0.77 * k];
    };
    // The bottom rows still stacked against the gable, then the collapse
    let placed = 0;
    const rows = [4, 3, 2];
    let y = 0;
    for (let row = 0; row < rows.length; row++) {
      const r = 0.075;
      const x = HL + 0.13 + row * 0.02 + rng.gauss() * 0.01;
      for (let k = 0; k < rows[row]; k++) {
        const z = -0.5 + row * 0.15 + k * 0.31 + rng.gauss() * 0.02;
        const gy = this.groundLocal(x, z);
        log(
          x,
          gy + r + y,
          z,
          Math.PI / 2 + rng.gauss() * 0.05,
          rng.gauss() * 0.03,
          rng.range(0.48, 0.58),
          r,
          tintOf(),
        );
        placed++;
      }
      y += r * 1.75;
    }
    while (placed < count) {
      const a = rng.next() * Math.PI * 2;
      const rr = Math.sqrt(rng.next());
      const x = HL + 0.75 + Math.cos(a) * rr * 0.95;
      const z = 0.15 + Math.sin(a) * rr * 1.1;
      if (x < HL + 0.12) continue;
      const r = rng.range(0.045, 0.085);
      const gy = this.groundLocal(x, z);
      log(
        x,
        gy + r * 0.85,
        z,
        rng.next() * Math.PI,
        rng.gauss() * 0.12,
        rng.range(0.42, 0.6),
        r,
        tintOf(),
      );
      placed++;
    }
    // A few split logs, flat side down
    for (let k = 0; k < 3; k++) {
      const x = HL + rng.range(0.4, 1.3);
      const z = rng.range(-0.9, 1.1);
      const len = rng.range(0.42, 0.55);
      const g = new THREE.CylinderGeometry(
        0.07,
        0.07,
        len,
        seg,
        1,
        false,
        0,
        Math.PI,
      );
      g.rotateZ(Math.PI / 2);
      g.rotateY(rng.next() * Math.PI);
      g.translate(x, this.groundLocal(x, z) + 0.005, z);
      bag.add("wood", g, [0.95, 0.9, 0.82]);
    }
  }

  // -------------------------------------------------------------------------
  // Tumbled stones from the wall heads
  // -------------------------------------------------------------------------

  private rock(
    bag: Bag,
    x: number,
    y: number,
    z: number,
    size: number,
    seed: number,
    tone: number,
  ): void {
    const rng = new TexRng(seed);
    const detail = this.det >= 0.9 ? 1 : 0;
    const g = new THREE.IcosahedronGeometry(size, detail);
    g.scale(
      1 + rng.next() * 0.5,
      0.55 + rng.next() * 0.3,
      0.8 + rng.next() * 0.35,
    );
    jitter(g, 0.14, seed);
    g.rotateY(rng.next() * Math.PI * 2);
    g.rotateX((rng.next() - 0.5) * 0.5);
    g.computeBoundingBox();
    const bb = g.boundingBox;
    const h = bb ? bb.max.y - bb.min.y : size;
    const minY = bb ? bb.min.y : -size;
    g.translate(x, y - minY - h * 0.3, z);
    bag.add("stone", stoneUv(g, this.yPlinth - 1.5, x + z), [tone, tone, tone]);
  }

  private buildRubble(bag: Bag): void {
    const rng = new TexRng(0xb0b1e);
    const n = this.seg(16, 9);
    for (let k = 0; k < n; k++) {
      // Outside the open half and inside along its walls
      let x: number;
      let z: number;
      if (k % 3 === 0) {
        x = rng.range(-0.3, 2.0);
        z = rng.chance(0.5) ? rng.range(-1.25, -0.6) : rng.range(0.4, 1.2);
      } else {
        x = rng.range(-0.5, HL + 0.9);
        z = (rng.chance(0.5) ? 1 : -1) * (HW + rng.range(0.25, 1.4));
        if (x > HL + 0.2) z = rng.range(-HW, HW);
      }
      const size = rng.range(0.09, 0.19);
      this.rock(
        bag,
        x,
        this.groundLocal(x, z),
        z,
        size,
        700 + k,
        rng.range(0.85, 1.05),
      );
    }
    // Displaced copes still up on the open half's wall heads
    for (let k = 0; k < 5; k++) {
      const x = rng.range(0.3, HL - 0.2);
      const z = (k % 2 === 0 ? 1 : -1) * (HW - T / 2) + rng.gauss() * 0.08;
      this.rock(
        bag,
        x,
        EAVE_Y,
        z,
        rng.range(0.1, 0.16),
        800 + k,
        rng.range(0.9, 1.05),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Door
  // -------------------------------------------------------------------------

  private buildDoor(): void {
    const rng = new TexRng(0xd00e);
    const hx = DOOR_X1 - 0.06;
    const hz = HW - T + 0.05;
    const hingeY = DOOR_H - 0.07;
    // Ground under the leaf's sweep decides how tall the leaf can hang
    let gMax = Number.NEGATIVE_INFINITY;
    for (const a of [DOOR_MIN, 0.5, 0.8, 1.1, DOOR_MAX]) {
      for (const f of [0.5, 1]) {
        const px = hx - DOOR_W * f * Math.cos(a);
        const pz = hz - DOOR_W * f * Math.sin(a);
        const g =
          this.groundLocal(px, pz) + Math.max(0, this.litterHeight(px, pz));
        if (g > gMax) gMax = g;
      }
    }
    const leafH = Math.max(
      1.5,
      Math.min(1.76, hingeY - DOOR_W * Math.sin(DOOR_SAG) - (gMax + 0.05)),
    );

    const parts: THREE.BufferGeometry[] = [];
    const add = (g: THREE.BufferGeometry, tint: Tint) => {
      const geo = nonIndexed(g);
      setTint(geo, tint);
      parts.push(geo);
    };
    // Five vertical planks, uneven at the foot, greyed
    const pw = DOOR_W / 5;
    for (let k = 0; k < 5; k++) {
      const ph = leafH - rng.range(0, 0.06);
      const g = timberBox(pw - 0.006, DOOR_T, ph, k * 0.37);
      g.rotateX(-Math.PI / 2);
      g.translate(-(k + 0.5) * pw, -ph / 2, 0);
      const tone = rng.range(0.74, 0.9);
      add(g, [tone, tone, tone * 0.98]);
    }
    // Three ledges on the room side, one brace
    for (const y of [-0.2, -leafH / 2, -leafH + 0.2]) {
      const g = timberBox(0.12, 0.03, DOOR_W - 0.08, 2.2 + y);
      g.rotateY(Math.PI / 2);
      g.translate(-DOOR_W / 2, y, -DOOR_T / 2 - 0.015);
      add(g, [0.7, 0.68, 0.64]);
    }
    add(
      boxBetween(
        -0.1,
        -0.26,
        -DOOR_T / 2 - 0.045,
        -DOOR_W + 0.1,
        -leafH / 2 + 0.05,
        -DOOR_T / 2 - 0.045,
        0.1,
        0.025,
      ),
      [0.68, 0.66, 0.62],
    );
    // Strap hinge on the pintle (the lower one is long gone)
    add(
      box(0.4, 0.05, 0.008, -0.2, -0.08, DOOR_T / 2 + 0.005),
      [0.28, 0.26, 0.24],
    );
    add(
      new THREE.CylinderGeometry(0.02, 0.02, 0.08, 8).translate(
        0.005,
        -0.08,
        0,
      ),
      [0.28, 0.26, 0.24],
    );

    const merged = mergeGeometries(parts, false);
    for (const g of parts) g.dispose();
    if (!merged) throw new Error("Bothy: door merge failed");
    merged.computeBoundingSphere();
    const door = new THREE.Mesh(merged, this.mats.wood);
    door.name = "bothy-door";
    door.castShadow = true;
    door.receiveShadow = true;
    TV.set(hx, hingeY, hz).applyMatrix4(this.shellM);
    door.position.copy(TV);
    this.door = door;
    this.doorHx = hx;
    this.doorHz = hz;
    this.doorHingeY = hingeY;
    this.doorLeafH = leafH;
    this.registerDoorCollider();
    this.meshes.push(door);
    this.group.add(door);
    // Pintle stubs on the jamb (both), fixed to the shell
    this.swingDoor(0, 0);
  }
}
