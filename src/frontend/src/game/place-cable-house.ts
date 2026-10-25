// Sealane Cable House – a small brick cable-landing hut at the top of East
// Beach and the line of leaning, wireless telegraph poles marching inland
// from it (landforms.ts CABLE_HOUSE / POLE_LINE). A landed cable implies a
// whole absent world beyond the sea; the poles are the built breadcrumb trail
// that leads explorers into the empty north-east.
//
// Construction (8 draw calls):
//   1. brick     Flemish-bond walls inside and out, door/window reveals
//   2. atlas     hipped slate roof (alpha holes where slates are missing –
//                the shadow pass cuts them too), battens/rafters/ridge tiles,
//                stone plinth/lintels/sill, broken door, gutter stub, the
//                interior (terminal frame, insulators, cable coil, duct,
//                bench, fallen slates)
//   3. plaque    the cast plaque on its own small sheet (legible lettering)
//   4. drift     sand banked against the walls and blown in through the door
//   5. poles     8 standing poles as one InstancedMesh
//   6. specials  the stripped pole with its crossarm and the salvaged wire
//                coil at its foot, the snapped pole, two fallen poles
//   7. wires     LineSegments: the line was cut and salvaged, not never
//                strung – catenaries survive on a few spans (ultra/high),
//                cut tails hang from the insulators, wire trails from the
//                fallen crossarms
//   8. beam      additive shaft of light through the big roof hole (daytime)
//
// Colliders under the tag "cable" (walls with the doorway gap, door leaf,
// fittings, poles); the hut floor and the sand tongue in the doorway are
// registered as a walkable ground override.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  addBoxCollider,
  addCylinderCollider,
  beginColliderSet,
  clearColliderSet,
} from "./colliders";
import { registerGround, unregisterGround } from "./ground";
import { CABLE_HOUSE, POLE_LINE } from "./landforms";
import { fbm, mulberry32 } from "./noise";
import {
  CH,
  FRONT_HOLE,
  type Region,
  SLOPE_H,
  cableAtlasPbr,
  cableBeamTexture,
  cableBrickPbr,
  cablePlaquePbr,
} from "./place-cable-house-textures";
import type { Environment } from "./sky";
import { terrainHeight } from "./terrain";
import { applyPbr, sandAlbedo, sandNormal, sstep } from "./textures";
import type { QualityId } from "./types";

const TAG = "cable";

// --- Hut dimensions (hut-local metres; x = long side, front = -z) ----------
const L = 3.6;
const D = 2.8;
const T = 0.23;
const H = 2.4;
const WALL_BOTTOM = -0.5;
const DOOR_X = -0.85;
const DOOR_W = 0.9;
const DOOR_H = 2.0;
const WIN_Z = 0.1;
const WIN_W = 0.5;
const WIN_Y0 = 1.25;
const WIN_Y1 = 1.85;
const OVERHANG = 0.28;
const PITCH = (33 * Math.PI) / 180;
const EAVES_Y = H + 0.06;
const EX = L / 2 + OVERHANG;
const EZ = D / 2 + OVERHANG;
const RISE = EZ * Math.tan(PITCH);
const RIDGE_Y = EAVES_Y + RISE;
const RIDGE_HALF = (L - D) / 2;
const SLOPE_LEN = EZ / Math.cos(PITCH);
const GAUGE = 0.216;
/** Brick sheet: one tile = 2.7 m of wall length and 2.7 m of height. */
const BRICK_TILE = 2.7;
const DUCT = { x: 0.25, z: 0.75, half: 0.18 };
const COIL = { x: 0.9, z: 0.3, r: 0.36 };

// Sand texture tiling of the terrain mesh (world.ts) – the drift matches it.
const SAND_TILE_X = 820 / 70;
const SAND_TILE_Z = 560 / 48;

// --- Poles ------------------------------------------------------------------
const POLE_COUNT = 12;
const POLE_H = 7.0;
const POLE_R_TOP = 0.085;
const POLE_R_BOT = 0.135;
const POLE_SINK = 0.25;
/** Pole stripped of its crossarm (lies at its foot beside the salvaged wire coil). */
const BARE_POLE = 4;
/** Pole snapped mid-height, the top hanging down to the ground. */
const SNAPPED_POLE = 8;
/** Poles rotted through at the tar line, lying full length in the sand. */
const FALLEN_POLES: readonly number[] = [3, 9];
const SPECIAL = new Set<number>([BARE_POLE, SNAPPED_POLE, ...FALLEN_POLES]);
const STUMP_H = 3.1;
/** Spans that still carry wire (ultra/high); everything else was cut or came down. */
const WIRED_SPANS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 2],
  [5, 6],
  [6, 7],
  [10, 11],
];
const UP = new THREE.Vector3(0, 1, 0);

type GeoList = THREE.BufferGeometry[];
/** Sub-window of a region as fractions [u0, u1, v0, v1]. */
type Win = readonly [number, number, number, number];
const FULL: Win = [0, 1, 0, 1];
/** A stand-alone texture used whole (the plaque sheet). */
const WHOLE: Region = [0, 0, 1, 1];

interface Detail {
  hi: boolean;
  radial: number;
  cupSegs: number;
  driftStep: number;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function mapUv(
  geo: THREE.BufferGeometry,
  r: Region,
  w: Win = FULL,
  i0 = 0,
  i1 = -1,
): THREE.BufferGeometry {
  const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
  const u0 = r[0] + (r[2] - r[0]) * w[0];
  const u1 = r[0] + (r[2] - r[0]) * w[1];
  const v0 = r[1] + (r[3] - r[1]) * w[2];
  const v1 = r[1] + (r[3] - r[1]) * w[3];
  const end = i1 < 0 ? uv.count : i1;
  for (let i = i0; i < end; i++) {
    uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  }
  return geo;
}

/**
 * Map one face of an unsegmented BoxGeometry (+x,-x,+y,-y,+z,-z = 0..5) to
 * a region, starting again from the face's canonical 0..1 layout (so it can
 * be called after box() has mapped the whole box elsewhere).
 */
function mapBoxFace(
  geo: THREE.BoxGeometry,
  face: number,
  r: Region,
  w: Win = FULL,
): THREE.BoxGeometry {
  const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
  const b = face * 4;
  uv.setXY(b, 0, 1);
  uv.setXY(b + 1, 1, 1);
  uv.setXY(b + 2, 0, 0);
  uv.setXY(b + 3, 1, 0);
  mapUv(geo, r, w, b, b + 4);
  return geo;
}

function withColor(geo: THREE.BufferGeometry, k: number): THREE.BufferGeometry {
  const n = geo.getAttribute("position").count;
  const c = new Float32Array(n * 3).fill(k);
  geo.setAttribute("color", new THREE.BufferAttribute(c, 3));
  return geo;
}

/** Box (w along x, h along y, d along z) mapped to a region window. */
function box(
  w: number,
  h: number,
  d: number,
  r: Region,
  win: Win = FULL,
): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  mapUv(g, r, win);
  return g;
}

/** Bake position + Y rotation into a geometry. */
function put(
  g: THREE.BufferGeometry,
  x: number,
  y: number,
  z: number,
  yaw = 0,
): THREE.BufferGeometry {
  if (yaw) g.rotateY(yaw);
  g.translate(x, y, z);
  return g;
}

/**
 * Orient a geometry built along +x so that x runs along `dir`; `up` steers
 * the roll (the geometry's +y goes as close to `up` as possible).
 */
function alongDir(
  g: THREE.BufferGeometry,
  dir: THREE.Vector3,
  up: THREE.Vector3,
  at: THREE.Vector3,
): THREE.BufferGeometry {
  const X = dir.clone().normalize();
  const Z = new THREE.Vector3().crossVectors(X, up).normalize();
  const Y = new THREE.Vector3().crossVectors(Z, X);
  const m = new THREE.Matrix4().makeBasis(X, Y, Z).setPosition(at);
  g.applyMatrix4(m);
  return g;
}

/** Flat polygon (3–4 points) with explicit UVs; winding fixed to `wantUp`. */
function poly(
  pts: THREE.Vector3[],
  uvs: number[][],
  wantUp: boolean,
): THREE.BufferGeometry {
  const n = new THREE.Vector3()
    .subVectors(pts[1], pts[0])
    .cross(new THREE.Vector3().subVectors(pts[2], pts[0]));
  const order = pts.map((_, i) => i);
  if (n.y > 0 !== wantUp) order.reverse();
  const pos: number[] = [];
  const uv: number[] = [];
  for (const i of order) {
    pos.push(pts[i].x, pts[i].y, pts[i].z);
    uv.push(uvs[i][0], uvs[i][1]);
  }
  const idx = pts.length === 3 ? [0, 1, 2] : [0, 1, 2, 0, 2, 3];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Half-round tile/gutter: axis along x, bulge towards +y. */
function halfRound(
  r: number,
  len: number,
  segs: number,
  region: Region,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, len, segs, 1, true, 0, Math.PI);
  g.rotateZ(Math.PI / 2);
  mapUv(g, region);
  return g;
}

/**
 * Ping-pong UV u so a short atlas region repeats `n` times along a tube
 * without a seam (the armour pattern is mirror-symmetric).
 */
function pingPongU(g: THREE.BufferGeometry, n: number): THREE.BufferGeometry {
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const t = uv.getX(i) * n;
    const f = t - Math.floor(t / 2) * 2;
    uv.setX(i, f <= 1 ? f : 2 - f);
  }
  return g;
}

/** Porcelain insulator cup (lathe), base at y = 0. */
function cup(segs: number): THREE.BufferGeometry {
  const pts = [
    new THREE.Vector2(0.012, 0),
    new THREE.Vector2(0.032, 0),
    new THREE.Vector2(0.038, 0.03),
    new THREE.Vector2(0.026, 0.05),
    new THREE.Vector2(0.04, 0.075),
    new THREE.Vector2(0.044, 0.1),
    new THREE.Vector2(0.028, 0.122),
    new THREE.Vector2(0.001, 0.13),
  ];
  const g = new THREE.LatheGeometry(pts, segs);
  mapUv(g, CH.porcelain);
  return g;
}

// ---------------------------------------------------------------------------
// Brick walls
// ---------------------------------------------------------------------------

/** Outward direction of a wall slab's exterior face. */
type Out = "-z" | "+z" | "-x" | "+x";

/**
 * A wall slab spanning the given hut-local box. Brick UVs follow the height
 * (v = y / tile) and the length along each face; the exterior face reads the
 * lower band of the sheet, the interior face the limewashed upper band,
 * reveals and the (hidden) top/bottom the exterior band. Vertex colours
 * darken the interior towards the floor and the roof space.
 */
function wallSlab(
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
  out: Out,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const nrm = g.getAttribute("normal") as THREE.BufferAttribute;
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const ox = out === "+x" ? 1 : out === "-x" ? -1 : 0;
  const oz = out === "+z" ? 1 : out === "-z" ? -1 : 0;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nx = nrm.getX(i);
    const ny = nrm.getY(i);
    const nz = nrm.getZ(i);
    const dot = nx * ox + nz * oz;
    const interior = dot < -0.5;
    // Each band of the sheet is BRICK_TILE metres tall (half the sheet). No
    // clamping at the vertices – below y = 0 the sheet's clamp-to-edge shows
    // the algae row outside (hidden by the plinth) and plain brick inside
    // (under the floor slab).
    let u: number;
    let v: number;
    if (Math.abs(ny) > 0.5) {
      u = (x + 0.37) / BRICK_TILE;
      v = 0.3 + ((((z + 5) % 1) + 1) % 1) * 0.1;
    } else if (Math.abs(nz) > 0.5) {
      u = (x + 0.37) / BRICK_TILE;
      v = y / (2 * BRICK_TILE);
    } else {
      u = (z + 1.13) / BRICK_TILE;
      v = y / (2 * BRICK_TILE);
    }
    if (interior) v = 0.5 + Math.min(0.495, v);
    else v = Math.min(0.495, v);
    uv.setXY(i, u, v);
    let k: number;
    if (interior) {
      k =
        0.74 *
        (0.5 + 0.5 * sstep(-0.1, 0.7, y)) *
        (1 - 0.35 * sstep(1.9, 2.4, y));
    } else if (dot > 0.5) {
      k = 1 - 0.1 * sstep(2.05, 2.4, y);
    } else {
      k = 0.86;
    }
    col[i * 3] = k;
    col[i * 3 + 1] = k;
    col[i * 3 + 2] = k;
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return g;
}

function buildWalls(): GeoList {
  const list: GeoList = [];
  const dl = DOOR_X - DOOR_W / 2;
  const dr = DOOR_X + DOOR_W / 2;
  // Front (-z): left of the door, right of the door, over the lintel
  list.push(wallSlab(-L / 2, dl, WALL_BOTTOM, H, -D / 2, -D / 2 + T, "-z"));
  list.push(wallSlab(dr, L / 2, WALL_BOTTOM, H, -D / 2, -D / 2 + T, "-z"));
  list.push(wallSlab(dl, dr, DOOR_H + 0.15, H, -D / 2, -D / 2 + T, "-z"));
  // Rear (+z)
  list.push(wallSlab(-L / 2, L / 2, WALL_BOTTOM, H, D / 2 - T, D / 2, "+z"));
  // West (-x)
  list.push(
    wallSlab(-L / 2, -L / 2 + T, WALL_BOTTOM, H, -D / 2 + T, D / 2 - T, "-x"),
  );
  // East (+x) with the barred window
  const wl = WIN_Z - WIN_W / 2;
  const wr = WIN_Z + WIN_W / 2;
  const ex0 = L / 2 - T;
  list.push(wallSlab(ex0, L / 2, WALL_BOTTOM, H, -D / 2 + T, wl, "+x"));
  list.push(wallSlab(ex0, L / 2, WALL_BOTTOM, H, wr, D / 2 - T, "+x"));
  list.push(wallSlab(ex0, L / 2, WALL_BOTTOM, WIN_Y0, wl, wr, "+x"));
  list.push(wallSlab(ex0, L / 2, WIN_Y1 + 0.12, H, wl, wr, "+x"));
  return list;
}

// ---------------------------------------------------------------------------
// Roof
// ---------------------------------------------------------------------------

/** A roof slope: origin on the eaves line, A along the eaves, S up the slope, N outward. */
interface Slope {
  o: THREE.Vector3;
  A: THREE.Vector3;
  S: THREE.Vector3;
  N: THREE.Vector3;
  /** Half width along A at height s. */
  w: (s: number) => number;
  region: Region;
  hip: boolean;
}

function slopes(): Slope[] {
  const sp = Math.sin(PITCH);
  const cp = Math.cos(PITCH);
  const long = (s: number): number =>
    EX - (EX - RIDGE_HALF) * Math.min(1, s / SLOPE_LEN);
  const hip = (s: number): number => EZ * Math.max(0, 1 - s / SLOPE_LEN);
  return [
    {
      o: new THREE.Vector3(0, EAVES_Y, -EZ),
      A: new THREE.Vector3(1, 0, 0),
      S: new THREE.Vector3(0, sp, cp),
      N: new THREE.Vector3(0, cp, -sp),
      w: long,
      region: CH.slopeS,
      hip: false,
    },
    {
      o: new THREE.Vector3(0, EAVES_Y, EZ),
      A: new THREE.Vector3(-1, 0, 0),
      S: new THREE.Vector3(0, sp, -cp),
      N: new THREE.Vector3(0, cp, sp),
      w: long,
      region: CH.slopeN,
      hip: false,
    },
    {
      o: new THREE.Vector3(EX, EAVES_Y, 0),
      A: new THREE.Vector3(0, 0, 1),
      S: new THREE.Vector3(-cp, sp, 0),
      N: new THREE.Vector3(sp, cp, 0),
      w: hip,
      region: CH.hipE,
      hip: true,
    },
    {
      o: new THREE.Vector3(-EX, EAVES_Y, 0),
      A: new THREE.Vector3(0, 0, -1),
      S: new THREE.Vector3(cp, sp, 0),
      N: new THREE.Vector3(-sp, cp, 0),
      w: hip,
      region: CH.hipW,
      hip: true,
    },
  ];
}

function slopePoint(sl: Slope, a: number, s: number, n: number): THREE.Vector3 {
  return sl.o
    .clone()
    .addScaledVector(sl.A, a)
    .addScaledVector(sl.S, s)
    .addScaledVector(sl.N, n);
}

/** Place a box built along +x in a slope frame (x → A or S, y → N). */
function inSlope(
  g: THREE.BufferGeometry,
  sl: Slope,
  a: number,
  s: number,
  n: number,
  alongEaves: boolean,
): THREE.BufferGeometry {
  const X = alongEaves ? sl.A : sl.S;
  const Z = alongEaves ? sl.S : sl.A.clone().negate();
  const m = new THREE.Matrix4()
    .makeBasis(X, sl.N, Z)
    .setPosition(slopePoint(sl, a, s, n));
  g.applyMatrix4(m);
  return g;
}

function buildRoof(atlas: GeoList): void {
  const sls = slopes();
  for (const sl of sls) {
    const w0 = sl.w(0);
    const pts = sl.hip
      ? [
          slopePoint(sl, -w0, 0, 0),
          slopePoint(sl, w0, 0, 0),
          slopePoint(sl, 0, SLOPE_LEN, 0),
        ]
      : [
          slopePoint(sl, -w0, 0, 0),
          slopePoint(sl, w0, 0, 0),
          slopePoint(sl, sl.w(SLOPE_LEN), SLOPE_LEN, 0),
          slopePoint(sl, -sl.w(SLOPE_LEN), SLOPE_LEN, 0),
        ];
    const uvs = sl.hip
      ? [
          [0, 0],
          [1, 0],
          [0.5, 1],
        ]
      : [
          [0, 0],
          [1, 0],
          [0.5 + sl.w(SLOPE_LEN) / (2 * w0), 1],
          [0.5 - sl.w(SLOPE_LEN) / (2 * w0), 1],
        ];
    atlas.push(withColor(mapUv(poly(pts, uvs, true), sl.region), 1));
    // Underside (seen from inside through the open roof space)
    const under = pts.map((p) => p.clone().addScaledVector(sl.N, -0.012));
    atlas.push(withColor(mapUv(poly(under, uvs, false), sl.region), 0.28));
    // Battens across the slope, one per course
    for (let c = 0; c < 9; c++) {
      const s = c * GAUGE + 0.11;
      const len = 2 * sl.w(s) - 0.04;
      if (len < 0.15) continue;
      const g = box(len, 0.025, 0.05, CH.timber, [0, 1, 0.3, 0.42]);
      atlas.push(withColor(inSlope(g, sl, 0, s, -0.03, true), 0.5));
    }
    // Rafters up the slope, jack rafters shortened at the hips
    const span = sl.hip ? 1.2 : 1.8;
    for (let a = -span; a <= span + 1e-6; a += 0.6) {
      const sMax = sl.hip
        ? SLOPE_LEN * (1 - Math.abs(a) / EZ)
        : Math.min(
            SLOPE_LEN,
            (SLOPE_LEN * (EX - Math.abs(a))) / (EX - RIDGE_HALF),
          );
      const len = sMax - 0.02;
      if (len < 0.2) continue;
      const g = box(len, 0.1, 0.05, CH.timber, [0, 1, 0.55, 0.7]);
      atlas.push(withColor(inSlope(g, sl, a, len / 2, -0.1, false), 0.48));
    }
  }
  // Ridge board + ridge tiles
  atlas.push(
    withColor(
      put(
        box(2 * RIDGE_HALF + 0.12, 0.16, 0.035, CH.timber, [0, 1, 0.7, 0.85]),
        0,
        RIDGE_Y - 0.13,
        0,
      ),
      0.5,
    ),
  );
  // Ridge tiles sit down into the roof plane so their rims meet the slates
  // (the slopes fall 6 cm across the tile's width), butted end to end
  const ridgeTiles = 3;
  const rl = (2 * RIDGE_HALF + 0.1) / ridgeTiles;
  for (let k = 0; k < ridgeTiles; k++) {
    const g = halfRound(0.095, rl + 0.004, 6, CH.ridge);
    atlas.push(
      withColor(
        put(g, -RIDGE_HALF - 0.05 + (k + 0.5) * rl, RIDGE_Y - 0.062, 0),
        1,
      ),
    );
  }
  // Hips: rafter below, tiles on top
  const corners: Array<[number, number, Slope, Slope]> = [
    [EX, -EZ, sls[0], sls[2]],
    [EX, EZ, sls[1], sls[2]],
    [-EX, EZ, sls[1], sls[3]],
    [-EX, -EZ, sls[0], sls[3]],
  ];
  for (const [cx, cz, s1, s2] of corners) {
    const from = new THREE.Vector3(cx, EAVES_Y, cz);
    const to = new THREE.Vector3(Math.sign(cx) * RIDGE_HALF, RIDGE_Y, 0);
    const dir = to.clone().sub(from);
    const len = dir.length();
    const nAvg = s1.N.clone().add(s2.N).normalize();
    const mid = from.clone().add(to).multiplyScalar(0.5);
    const raft = box(len - 0.1, 0.12, 0.06, CH.timber, [0, 1, 0.1, 0.25]);
    atlas.push(
      withColor(
        alongDir(raft, dir, nAvg, mid.clone().addScaledVector(nAvg, -0.11)),
        0.48,
      ),
    );
    const tiles = 8;
    const tl = len / tiles;
    for (let k = 0; k < tiles; k++) {
      const g = halfRound(0.09, tl + 0.004, 6, CH.ridge);
      const at = from
        .clone()
        .addScaledVector(dir, (k + 0.5) / tiles)
        .addScaledVector(nAvg, -0.048);
      atlas.push(withColor(alongDir(g, dir, nAvg, at), 1));
    }
  }
  // Fascia boards along the eaves
  for (const sz of [-1, 1]) {
    atlas.push(
      withColor(
        put(
          box(2 * EX + 0.05, 0.15, 0.025, CH.timber, [0, 1, 0.4, 0.55]),
          0,
          EAVES_Y - 0.08,
          sz * (EZ + 0.012),
        ),
        0.9,
      ),
    );
  }
  for (const sx of [-1, 1]) {
    atlas.push(
      withColor(
        put(
          box(2 * EZ + 0.05, 0.15, 0.025, CH.timber, [0, 1, 0.4, 0.55]),
          sx * (EX + 0.012),
          EAVES_Y - 0.08,
          0,
          Math.PI / 2,
        ),
        0.9,
      ),
    );
  }
  // Cast-iron gutter stub on the front eave (the rest fell off long ago)
  const gutter = halfRound(0.065, 1.4, 7, CH.iron);
  gutter.rotateX(Math.PI);
  atlas.push(withColor(put(gutter, -1.25, EAVES_Y - 0.19, -EZ - 0.07), 1));
  for (const gx of [-1.85, -0.7]) {
    atlas.push(
      withColor(
        put(box(0.04, 0.03, 0.1, CH.iron), gx, EAVES_Y - 0.13, -EZ - 0.06),
        1,
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Dressings, door, interior
// ---------------------------------------------------------------------------

function stoneWin(rng: () => number): Win {
  const u0 = rng() * 0.45;
  return [u0, u0 + 0.55, 0, 1];
}

function buildDressings(atlas: GeoList, rng: () => number): void {
  // Plinth: projecting stone blocks around the base, gap at the threshold
  const front: Array<[number, number]> = [
    [-L / 2 - 0.03, DOOR_X - DOOR_W / 2],
    [DOOR_X + DOOR_W / 2, 0.55],
    [0.55, 1.2],
    [1.2, L / 2 + 0.03],
  ];
  for (const [a, b] of front) {
    atlas.push(
      withColor(
        put(
          box(b - a - 0.006, 0.75, 0.08, CH.stone, stoneWin(rng)),
          (a + b) / 2,
          WALL_BOTTOM + 0.375,
          -D / 2 + 0.01,
        ),
        1,
      ),
    );
  }
  for (let k = 0; k < 4; k++) {
    const a = -L / 2 - 0.03 + (k * (L + 0.06)) / 4;
    const b = a + (L + 0.06) / 4;
    atlas.push(
      withColor(
        put(
          box(b - a - 0.006, 0.75, 0.08, CH.stone, stoneWin(rng)),
          (a + b) / 2,
          WALL_BOTTOM + 0.375,
          D / 2 - 0.01,
        ),
        1,
      ),
    );
  }
  for (const sx of [-1, 1]) {
    for (let k = 0; k < 3; k++) {
      const a = -D / 2 + 0.05 + (k * (D - 0.1)) / 3;
      const b = a + (D - 0.1) / 3;
      atlas.push(
        withColor(
          put(
            box(b - a - 0.006, 0.75, 0.08, CH.stone, stoneWin(rng)),
            sx * (L / 2 - 0.01),
            WALL_BOTTOM + 0.375,
            (a + b) / 2,
            Math.PI / 2,
          ),
          1,
        ),
      );
    }
  }
  // Threshold
  atlas.push(
    withColor(
      put(
        box(DOOR_W + 0.2, 0.06, 0.34, CH.stone, stoneWin(rng)),
        DOOR_X,
        0.0,
        -D / 2 + 0.1,
      ),
      0.9,
    ),
  );
  // Door lintel, window lintel + sill
  atlas.push(
    withColor(
      put(
        box(1.25, 0.15, T + 0.04, CH.stone, stoneWin(rng)),
        DOOR_X,
        DOOR_H + 0.075,
        -D / 2 + T / 2,
      ),
      1,
    ),
  );
  atlas.push(
    withColor(
      put(
        box(0.76, 0.12, T + 0.04, CH.stone, stoneWin(rng)),
        L / 2 - T / 2,
        WIN_Y1 + 0.06,
        WIN_Z,
        Math.PI / 2,
      ),
      1,
    ),
  );
  atlas.push(
    withColor(
      put(
        box(0.76, 0.08, T + 0.08, CH.stone, stoneWin(rng)),
        L / 2 - T / 2 + 0.02,
        WIN_Y0 - 0.04,
        WIN_Z,
        Math.PI / 2,
      ),
      1,
    ),
  );
  // Window bars
  for (const dz of [-0.13, 0, 0.13]) {
    atlas.push(
      withColor(
        put(
          box(0.02, WIN_Y1 - WIN_Y0 + 0.04, 0.02, CH.iron, [0.2, 0.3, 0, 1]),
          L / 2 - T / 2,
          (WIN_Y0 + WIN_Y1) / 2,
          WIN_Z + dz,
        ),
        0.9,
      ),
    );
  }
}

/** Cast plaque on the front wall, right of the door (own texture, own mesh). */
function buildPlaque(): THREE.BufferGeometry {
  // Sides read the dark border strip of the sheet, the face the lettering
  const g = box(0.6, 0.42, 0.03, WHOLE, [0, 0.03, 0, 1]);
  mapBoxFace(g, 5, WHOLE);
  return put(g, 0.95, 1.55, -D / 2 - 0.015);
}

/** Door leaf hanging inward off its top hinge; returns the leaf's centre + yaw for the collider. */
function buildDoor(atlas: GeoList): { cx: number; cz: number; yaw: number } {
  const leafW = 0.86;
  const leafH = 1.95;
  const parts: GeoList = [];
  const leaf = box(leafW, leafH, 0.045, CH.timber, [0, 0.2, 0.3, 0.4]);
  mapBoxFace(leaf, 4, CH.door);
  mapBoxFace(leaf, 5, CH.door);
  parts.push(leaf);
  for (const ly of [0.25, 0.97, 1.7]) {
    parts.push(
      put(
        box(0.78, 0.11, 0.03, CH.timber, [0, 1, 0.2, 0.35]),
        0,
        ly - leafH / 2,
        0.037,
      ),
    );
  }
  // Hinge point: top of the +x edge. Droop in plane, then swing 105° inward.
  const swing = (105 * Math.PI) / 180;
  const m = new THREE.Matrix4()
    .makeTranslation(DOOR_X + DOOR_W / 2 - 0.02, 1.88, -D / 2 + T / 2)
    .multiply(new THREE.Matrix4().makeRotationY(swing))
    .multiply(new THREE.Matrix4().makeRotationZ(0.14))
    .multiply(new THREE.Matrix4().makeTranslation(-leafW / 2, -0.9, 0));
  for (const g of parts) {
    g.applyMatrix4(m);
    atlas.push(withColor(g, 0.85));
  }
  const c = new THREE.Vector3(0, 0, 0).applyMatrix4(m);
  return { cx: c.x, cz: c.z, yaw: swing };
}

function buildInterior(atlas: GeoList, det: Detail, rng: () => number): void {
  const IN = 0.8;
  // Floor slab with the duct opening
  const fx0 = -L / 2 + T;
  const fx1 = L / 2 - T;
  const fz0 = -D / 2 + T;
  const fz1 = D / 2 - T;
  const dz0 = DUCT.z - DUCT.half;
  const dz1 = DUCT.z + DUCT.half;
  const dx0 = DUCT.x - DUCT.half;
  const dx1 = DUCT.x + DUCT.half;
  const floorQuad = (x0: number, x1: number, z0: number, z1: number): void => {
    const pts = [
      new THREE.Vector3(x0, 0, z0),
      new THREE.Vector3(x1, 0, z0),
      new THREE.Vector3(x1, 0, z1),
      new THREE.Vector3(x0, 0, z1),
    ];
    const uvOf = (x: number, z: number): number[] => [
      (x - fx0) / (fx1 - fx0),
      (z - fz0) / (fz1 - fz0),
    ];
    const uvs = pts.map((p) => uvOf(p.x, p.z));
    atlas.push(withColor(mapUv(poly(pts, uvs, true), CH.concrete), 0.62));
  };
  floorQuad(fx0, fx1, fz0, dz0);
  floorQuad(fx0, fx1, dz1, fz1);
  floorQuad(fx0, dx0, dz0, dz1);
  floorQuad(dx1, fx1, dz0, dz1);
  // Duct: inside-out pit, iron kerb
  const pit = new THREE.BoxGeometry(2 * DUCT.half, 0.5, 2 * DUCT.half);
  pit.scale(-1, 1, 1);
  pit.computeVertexNormals();
  mapUv(pit, CH.dark);
  atlas.push(withColor(put(pit, DUCT.x, -0.25, DUCT.z), 0.5));
  for (const [ox, oz, yaw] of [
    [0, -DUCT.half, 0],
    [0, DUCT.half, 0],
    [-DUCT.half, 0, Math.PI / 2],
    [DUCT.half, 0, Math.PI / 2],
  ]) {
    atlas.push(
      withColor(
        put(
          box(2 * DUCT.half + 0.04, 0.03, 0.04, CH.iron, [0.3, 0.9, 0.4, 0.5]),
          DUCT.x + ox,
          0.015,
          DUCT.z + oz,
          yaw,
        ),
        IN,
      ),
    );
  }
  // Terminal frame against the rear wall: angle-iron uprights, rails,
  // rows of porcelain insulators, a diagonal brace, a test box on the wall
  const fz = D / 2 - T - 0.16;
  for (const ux of [0.35, 1.35]) {
    atlas.push(
      withColor(
        put(box(0.05, 1.95, 0.05, CH.iron, [0.5, 0.6, 0, 1]), ux, 0.975, fz),
        IN,
      ),
    );
    atlas.push(
      withColor(
        put(
          box(0.04, 0.03, 0.16, CH.iron, [0.6, 0.7, 0.2, 0.3]),
          ux,
          1.7,
          fz + 0.08,
        ),
        IN,
      ),
    );
  }
  for (const ry of [0.55, 1.05, 1.55]) {
    atlas.push(
      withColor(
        put(box(1.05, 0.05, 0.05, CH.iron, [0, 1, 0.6, 0.7]), 0.85, ry, fz),
        IN,
      ),
    );
    for (let k = 0; k < 5; k++) {
      if (rng() < 0.12) continue; // a few knocked off
      const c = cup(det.cupSegs);
      atlas.push(withColor(put(c, 0.45 + k * 0.2, ry + 0.025, fz), IN));
    }
  }
  const brace = box(1.15, 0.03, 0.006, CH.iron, [0, 1, 0.7, 0.8]);
  atlas.push(
    withColor(
      alongDir(
        brace,
        new THREE.Vector3(1, 1.1, 0),
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(0.85, 1.05, fz + 0.035),
      ),
      IN,
    ),
  );
  atlas.push(
    withColor(
      put(
        box(0.36, 0.46, 0.12, CH.iron, [0.1, 0.9, 0.1, 0.9]),
        -0.6,
        1.35,
        D / 2 - T - 0.06,
      ),
      IN,
    ),
  );
  atlas.push(
    withColor(put(cup(det.cupSegs), -0.6, 1.58, D / 2 - T - 0.12), IN),
  );
  // Cable coil (three turns) and the tail dropping into the duct
  for (let k = 0; k < 3; k++) {
    const g = new THREE.TorusGeometry(COIL.r - k * 0.004, 0.02, 6, 30);
    pingPongU(g, 7);
    mapUv(g, CH.cable);
    g.rotateX(Math.PI / 2);
    atlas.push(
      withColor(
        put(g, COIL.x + (k % 2) * 0.01, 0.022 + k * 0.038, COIL.z + k * 0.008),
        IN,
      ),
    );
  }
  const tail = new THREE.CatmullRomCurve3([
    new THREE.Vector3(COIL.x - 0.2, 0.14, COIL.z + 0.3),
    new THREE.Vector3(COIL.x - 0.45, 0.17, COIL.z + 0.42),
    new THREE.Vector3(DUCT.x + 0.08, 0.07, DUCT.z + 0.02),
    new THREE.Vector3(DUCT.x, -0.15, DUCT.z),
    new THREE.Vector3(DUCT.x - 0.02, -0.42, DUCT.z),
  ]);
  const tube = new THREE.TubeGeometry(tail, 22, 0.02, 6, false);
  pingPongU(tube, 5);
  mapUv(tube, CH.cable);
  atlas.push(withColor(tube, IN));
  // Bench along the west wall
  const bx = -L / 2 + T + 0.2;
  atlas.push(
    withColor(
      put(
        box(1.3, 0.04, 0.34, CH.timber, [0, 1, 0.5, 0.8]),
        bx,
        0.44,
        0.3,
        Math.PI / 2,
      ),
      IN,
    ),
  );
  for (const dz of [-0.55, 0.55]) {
    atlas.push(
      withColor(
        put(
          box(0.3, 0.42, 0.04, CH.timber, [0, 0.4, 0.1, 0.5]),
          bx,
          0.21,
          0.3 + dz,
        ),
        IN,
      ),
    );
  }
  atlas.push(
    withColor(
      put(
        box(1.05, 0.08, 0.03, CH.timber, [0, 1, 0.75, 0.9]),
        bx,
        0.12,
        0.3,
        Math.PI / 2,
      ),
      IN,
    ),
  );
  // Fallen slates on the floor, one leaning against the wall
  const slateAt = (
    x: number,
    y: number,
    z: number,
    yaw: number,
    tiltX: number,
    tiltZ: number,
  ): void => {
    const g = box(0.254, 0.008, 0.508, CH.slate);
    if (tiltX) g.rotateX(tiltX);
    if (tiltZ) g.rotateZ(tiltZ);
    atlas.push(withColor(put(g, x, y, z, yaw), IN));
  };
  slateAt(-0.3, 0.004, -0.6, 0.4, 0, 0);
  slateAt(0.65, 0.004, -0.9, 2.1, 0, 0);
  slateAt(0.55, 0.012, -0.8, 1.7, 0, 0.03);
  slateAt(-1.4, 0.25, -0.75, Math.PI / 2, 0, 1.15);
}

// ---------------------------------------------------------------------------
// Sand drift
// ---------------------------------------------------------------------------

interface DriftShape {
  /** Inside the room (between the inner wall faces). */
  inner: (lx: number, lz: number) => boolean;
  /**
   * Sand surface (hut-local y) at (lx, lz), feathered into the terrain at the
   * rim of the patch; null outside it. `terrainLocal` is the terrain height
   * there relative to the floor. The drift mesh and the walkable ground both
   * read this, so a body stands exactly on what is drawn.
   */
  surface: (lx: number, lz: number, terrainLocal: number) => number | null;
}

/** Extent of the drift patch in hut-local metres. */
const DRIFT = { x0: -3.0, x1: 3.0, z0: -3.5, z1: 2.4 };

function driftShape(): DriftShape {
  const inner = (lx: number, lz: number): boolean =>
    Math.abs(lx) < L / 2 - T && Math.abs(lz) < D / 2 - T;
  const tongue = (lx: number, lz: number): number => {
    const t = (lz + D / 2) / 1.7;
    const g = Math.exp(-(((lx - DOOR_X) / (0.5 + 0.7 * t)) ** 2));
    const amp = 0.26 * (1 - sstep(0, 1, t));
    const film = 0.014 * (1 - sstep(0.7, 1.6, lz + D / 2)) * (0.6 + 0.4 * g);
    return amp * g + film + (fbm(lx * 2.3 + 9, lz * 2.3, 2) - 0.5) * 0.012;
  };
  const bank = (lx: number, lz: number): number => {
    const ax = Math.abs(lx);
    const az = Math.abs(lz);
    const front = lz < -D / 2 ? Math.exp(-(((-D / 2 - lz) / 0.85) ** 2)) : 1;
    const bf =
      0.3 *
      front *
      (1 - sstep(L / 2 + 0.2, L / 2 + 1.1, ax)) *
      (lz < -D / 2 + T ? 1 : 0);
    const side = ax > L / 2 ? Math.exp(-(((ax - L / 2) / 0.65) ** 2)) : 1;
    const bs =
      (lx < 0 ? 0.24 : 0.14) *
      side *
      (1 - sstep(D / 2 + 0.2, D / 2 + 0.9, az)) *
      (ax > L / 2 - T ? 1 : 0);
    const rear = lz > D / 2 ? Math.exp(-(((lz - D / 2) / 0.5) ** 2)) : 1;
    const br =
      0.1 *
      rear *
      (1 - sstep(L / 2 + 0.1, L / 2 + 0.7, ax)) *
      (lz > D / 2 - T ? 1 : 0);
    const b = Math.max(bf, bs, br);
    return b * (0.8 + 0.4 * fbm(lx * 1.7 + 3, lz * 1.7 + 1, 2));
  };
  const raw = (lx: number, lz: number, terrainLocal: number): number => {
    if (inner(lx, lz)) return tongue(lx, lz);
    const outside = terrainLocal + bank(lx, lz);
    // Across the front wall band the outside bank meets the inner tongue
    if (
      Math.abs(lx - DOOR_X) < DOOR_W / 2 + 0.3 &&
      lz >= -D / 2 &&
      lz < -D / 2 + T
    ) {
      const k = (lz + D / 2) / T;
      return outside * (1 - k) + tongue(lx, lz) * k;
    }
    return outside;
  };
  return {
    inner,
    surface: (lx, lz, terrainLocal) => {
      if (lx < DRIFT.x0 || lx > DRIFT.x1 || lz < DRIFT.z0 || lz > DRIFT.z1)
        return null;
      const edge =
        (1 - sstep(DRIFT.x1 - 0.7, DRIFT.x1, Math.abs(lx))) *
        (1 - sstep(DRIFT.z1 - 0.6, DRIFT.z1, lz)) *
        (1 - sstep(-DRIFT.z0 - 0.7, -DRIFT.z0, -lz));
      return terrainLocal + (raw(lx, lz, terrainLocal) - terrainLocal) * edge;
    },
  };
}

function buildDrift(
  shape: DriftShape,
  step: number,
  toWorld: (lx: number, lz: number) => [number, number],
  floorY: number,
): THREE.BufferGeometry {
  const cols = Math.ceil((DRIFT.x1 - DRIFT.x0) / step);
  const rows = Math.ceil((DRIFT.z1 - DRIFT.z0) / step);
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= rows; j++) {
    const lz = DRIFT.z0 + ((DRIFT.z1 - DRIFT.z0) * j) / rows;
    for (let i = 0; i <= cols; i++) {
      const lx = DRIFT.x0 + ((DRIFT.x1 - DRIFT.x0) * i) / cols;
      const [wx, wz] = toWorld(lx, lz);
      const tl = terrainHeight(wx, wz) - floorY;
      // A hair below the surface bodies stand on, so the rim and the
      // fading film inside disappear under terrain and slab
      const h = (shape.surface(lx, lz, tl) ?? tl) - 0.013;
      pos.push(wx, floorY + h, wz);
      uv.push((wx + 410) / SAND_TILE_X, (420 - wz) / SAND_TILE_Z);
    }
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * (cols + 1) + i;
      const b = a + cols + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

// ---------------------------------------------------------------------------
// Poles
// ---------------------------------------------------------------------------

interface PoleOpts {
  height: number;
  crossarm: boolean;
  topPin: boolean;
  /** Part of the shaft texture this shaft covers (0 = foot, 1 = top). */
  v0: number;
  v1: number;
  rBot: number;
  rTop: number;
}

/** Pole parts in a local frame: base at the origin, up = +y, crossarm along x. */
function poleParts(det: Detail, o: PoleOpts): GeoList {
  const list: GeoList = [];
  const shaft = new THREE.CylinderGeometry(
    o.rTop,
    o.rBot,
    o.height,
    det.radial,
    1,
    false,
  );
  shaft.translate(0, o.height / 2, 0);
  mapUv(shaft, CH.pole, [0, 1, o.v0, o.v1]);
  list.push(shaft);
  if (o.topPin) {
    const cone = new THREE.CylinderGeometry(0.004, o.rTop, 0.1, det.radial);
    cone.translate(0, o.height + 0.05, 0);
    mapUv(cone, CH.pole, [0, 1, 0.9, 1]);
    list.push(cone);
    list.push(
      put(
        new THREE.CylinderGeometry(0.012, 0.012, 0.12, 6),
        0,
        o.height + 0.14,
        0,
      ),
    );
    mapUv(list[list.length - 1], CH.iron, [0.4, 0.5, 0.4, 0.5]);
    list.push(put(cup(det.cupSegs), 0, o.height + 0.18, 0));
  }
  if (o.crossarm) {
    const ay = o.height - 0.45;
    list.push(
      put(box(1.7, 0.08, 0.1, CH.timber, [0, 1, 0.1, 0.3]), 0, ay, 0.07),
    );
    for (const sx of [-1, 1]) {
      const strap = box(0.62, 0.03, 0.006, CH.iron, [0, 1, 0.55, 0.62]);
      list.push(
        alongDir(
          strap,
          new THREE.Vector3(sx * 0.45, 0.43, 0),
          new THREE.Vector3(0, 0, 1),
          new THREE.Vector3(sx * 0.225, ay - 0.255, 0.125),
        ),
      );
    }
    for (const px of [-0.72, -0.32, 0.32, 0.72]) {
      list.push(
        put(
          new THREE.CylinderGeometry(0.011, 0.011, 0.1, 6),
          px,
          ay + 0.08,
          0.07,
        ),
      );
      mapUv(list[list.length - 1], CH.iron, [0.4, 0.5, 0.4, 0.5]);
      list.push(put(cup(det.cupSegs), px, ay + 0.1, 0.07));
    }
  }
  return list;
}

function mergeList(list: GeoList, name: string): THREE.BufferGeometry {
  const merged = mergeGeometries(list, false);
  for (const g of list) g.dispose();
  if (!merged) throw new Error(`CableHouse: ${name} merge failed`);
  merged.computeBoundingSphere();
  return merged;
}

interface PoleDef {
  x: number;
  z: number;
  y: number;
  yaw: number;
  h: number;
  lean: number;
  leanDir: number;
}

function placePoles(): PoleDef[] {
  const rng = mulberry32(0xcab1e5);
  const [ax, az] = POLE_LINE[0];
  const [bx, bz] = POLE_LINE[1];
  const len = Math.hypot(bx - ax, bz - az);
  const dx = (bx - ax) / len;
  const dz = (bz - az) / len;
  const lineYaw = Math.atan2(dx, dz);
  const out: PoleDef[] = [];
  for (let i = 0; i < POLE_COUNT; i++) {
    let along = (i / (POLE_COUNT - 1)) * len + (rng() - 0.5) * 3;
    along = Math.max(0.5, Math.min(len - 0.5, along));
    const side = (rng() - 0.5) * 1.2;
    const x = ax + dx * along + dz * side;
    const z = az + dz * along - dx * side;
    out.push({
      x,
      z,
      y: terrainHeight(x, z) - POLE_SINK,
      yaw: lineYaw + (rng() - 0.5) * 0.18,
      h: 6.5 + rng(),
      // 3–8°: every pole visibly off plumb, none alike
      lean: 0.05 + rng() * 0.09,
      leanDir: rng() * Math.PI * 2,
    });
  }
  return out;
}

function poleQuaternion(p: PoleDef): THREE.Quaternion {
  const axis = new THREE.Vector3(Math.cos(p.leanDir), 0, -Math.sin(p.leanDir));
  return new THREE.Quaternion()
    .setFromAxisAngle(axis, p.lean)
    .multiply(
      new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        p.yaw,
      ),
    );
}

// ---------------------------------------------------------------------------
// Wire
// ---------------------------------------------------------------------------

/**
 * Wire seats (the insulator grooves) of a pole in its local frame: the four
 * crossarm slots, then the top pin. Built for the geometry's own height –
 * the instance matrix (with its y scale) takes them to the world.
 */
function wireSeats(height: number, crossarm: boolean): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  if (crossarm) {
    const ay = height - 0.45;
    for (const px of [-0.72, -0.32, 0.32, 0.72]) {
      out.push(new THREE.Vector3(px, ay + 0.21, 0.07));
    }
  }
  out.push(new THREE.Vector3(0, height + 0.29, 0));
  return out;
}

/** Slack span between two seats: a parabola with `sag` metres of belly. */
function catenary(
  a: THREE.Vector3,
  b: THREE.Vector3,
  sag: number,
  out: number[],
): void {
  const N = 14;
  let px = a.x;
  let py = a.y;
  let pz = a.z;
  for (let k = 1; k <= N; k++) {
    const t = k / N;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t - 4 * sag * t * (1 - t);
    const z = a.z + (b.z - a.z) * t;
    out.push(px, py, pz, x, y, z);
    px = x;
    py = y;
    pz = z;
  }
}

/** Cut wire hanging from a seat: drifts a little sideways, kinks near the end. */
function tail(
  seat: THREE.Vector3,
  len: number,
  dx: number,
  dz: number,
  kink: number,
  out: number[],
): void {
  const pts = [
    [0, 0, 0],
    [dx * 0.1 * len, -0.4 * len, dz * 0.1 * len],
    [dx * 0.22 * len, -0.8 * len, dz * 0.22 * len],
    [dx * 0.4 * len + kink, -len, dz * 0.4 * len - kink * 0.6],
  ];
  for (let k = 0; k + 1 < pts.length; k++) {
    out.push(
      seat.x + pts[k][0],
      seat.y + pts[k][1],
      seat.z + pts[k][2],
      seat.x + pts[k + 1][0],
      seat.y + pts[k + 1][1],
      seat.z + pts[k + 1][2],
    );
  }
}

/** Wire lying on the sand from a fallen crossarm, wandering off for `len` m. */
function trail(
  from: THREE.Vector3,
  dir: number,
  len: number,
  wobble: number,
  out: number[],
): void {
  const N = 8;
  const dx = Math.sin(dir);
  const dz = Math.cos(dir);
  let px = from.x;
  let py = from.y;
  let pz = from.z;
  for (let k = 1; k <= N; k++) {
    const t = k / N;
    const side = Math.sin(t * Math.PI * 2.3 + wobble) * 0.35 * t;
    const x = from.x + dx * len * t + dz * side;
    const z = from.z + dz * len * t - dx * side;
    const y = terrainHeight(x, z) + 0.015;
    out.push(px, py, pz, x, y, z);
    px = x;
    py = y;
    pz = z;
  }
}

// ---------------------------------------------------------------------------
// The place
// ---------------------------------------------------------------------------

export class CableHouse {
  protected readonly parent: THREE.Group;
  protected readonly quality: QualityId;
  private readonly group = new THREE.Group();
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly sandUniforms = { uWet: { value: 0 }, uCloud: { value: 0 } };
  /** Light shaft through the big hole in the front slope. */
  private readonly beam: THREE.Mesh;
  private readonly beamMat: THREE.MeshBasicMaterial;
  private readonly beamPos: THREE.BufferAttribute;
  private readonly instanced: THREE.InstancedMesh;
  private readonly holeWorld = new THREE.Vector3();
  private readonly holeNormal = new THREE.Vector3();
  private readonly floorY: number;
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpC = new THREE.Vector3();
  /** Pole definitions (dev harness / report). */
  readonly poles: PoleDef[];
  /** Build cost of this construction in ms (dev harness): everything / the texture sets alone. */
  readonly buildMs: number;
  readonly textureMs: number;

  constructor(parent: THREE.Group, quality: QualityId) {
    const t0 = performance.now();
    this.parent = parent;
    this.quality = quality;
    this.group.name = "place-cable-house";
    parent.add(this.group);

    const hi = quality === "ultra" || quality === "high";
    const det: Detail = {
      hi,
      radial: hi ? 10 : 7,
      cupSegs: hi ? 8 : 6,
      driftStep: hi ? 0.15 : 0.22,
    };
    const rng = mulberry32(0x5ea1a);

    // --- Site: the hut turns its back on the pole line -----------------------
    const CX = CABLE_HOUSE.x;
    const CZ = CABLE_HOUSE.z;
    const yaw = Math.atan2(POLE_LINE[0][0] - CX, POLE_LINE[0][1] - CZ);
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const toWorld = (lx: number, lz: number): [number, number] => [
      CX + lx * cy + lz * sy,
      CZ - lx * sy + lz * cy,
    ];
    let ground = Number.NEGATIVE_INFINITY;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const [wx, wz] = toWorld((i * L) / 2, (j * D) / 2);
        ground = Math.max(ground, terrainHeight(wx, wz));
      }
    }
    const floorY = ground + 0.06;
    this.floorY = floorY;
    const hutMatrix = new THREE.Matrix4()
      .makeRotationY(yaw)
      .setPosition(CX, floorY, CZ);

    // --- Hut: brick + atlas --------------------------------------------------
    const brick = buildWalls();
    const atlas: GeoList = [];
    buildRoof(atlas);
    buildDressings(atlas, rng);
    const door = buildDoor(atlas);
    buildInterior(atlas, det, rng);
    for (const g of brick) g.applyMatrix4(hutMatrix);
    for (const g of atlas) g.applyMatrix4(hutMatrix);

    let tx = performance.now();
    const brickMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.72,
    });
    applyPbr(brickMat, cableBrickPbr(hi));
    let textureMs = performance.now() - tx;
    this.materials.push(brickMat);
    const brickGeo = mergeList(brick, "brick");
    this.geometries.push(brickGeo);
    const brickMesh = new THREE.Mesh(brickGeo, brickMat);
    brickMesh.castShadow = true;
    brickMesh.receiveShadow = true;
    this.group.add(brickMesh);

    tx = performance.now();
    const plaqueMat = new THREE.MeshStandardMaterial();
    applyPbr(plaqueMat, cablePlaquePbr(hi));
    textureMs += performance.now() - tx;
    this.materials.push(plaqueMat);
    const plaqueGeo = buildPlaque();
    plaqueGeo.applyMatrix4(hutMatrix);
    plaqueGeo.computeBoundingSphere();
    this.geometries.push(plaqueGeo);
    const plaqueMesh = new THREE.Mesh(plaqueGeo, plaqueMat);
    plaqueMesh.castShadow = true;
    plaqueMesh.receiveShadow = true;
    this.group.add(plaqueMesh);

    tx = performance.now();
    const atlasMat = new THREE.MeshStandardMaterial({ vertexColors: true });
    applyPbr(atlasMat, cableAtlasPbr(hi));
    textureMs += performance.now() - tx;
    this.textureMs = textureMs;
    this.materials.push(atlasMat);

    // --- Poles: the specials share the atlas; loose slates outside too -------
    this.poles = placePoles();
    const specials: GeoList = [];
    /** World wire seats per pole: hanging (standing poles) and on the ground (fallen). */
    const seats: Array<THREE.Vector3[] | undefined> = [];
    const fallenSeats: Array<THREE.Vector3[] | undefined> = [];
    const fallenBoxes: Array<{
      x: number;
      z: number;
      half: number;
      yaw: number;
      y: number;
    }> = [];
    for (const [i, p] of this.poles.entries()) {
      if (!SPECIAL.has(i)) continue;
      const q = poleQuaternion(p);
      const base = new THREE.Vector3(p.x, p.y, p.z);
      if (i === BARE_POLE) {
        const parts = poleParts(det, {
          height: p.h,
          crossarm: false,
          topPin: true,
          v0: 0,
          v1: 1,
          rBot: POLE_R_BOT,
          rTop: POLE_R_TOP,
        });
        const m = new THREE.Matrix4().compose(
          base,
          q,
          new THREE.Vector3(1, 1, 1),
        );
        for (const g of parts) specials.push(g.applyMatrix4(m));
        seats[i] = wireSeats(p.h, false).map((v) => v.applyMatrix4(m));
        // The salvaged wire, coiled up and abandoned beside the stripped pole
        const cx = p.x - 1.1;
        const cz = p.z + 0.6;
        const cy = terrainHeight(cx, cz);
        for (let k = 0; k < 3; k++) {
          const ring = new THREE.TorusGeometry(0.34 + k * 0.025, 0.006, 4, 40);
          mapUv(ring, CH.iron, [0.6, 0.9, 0.3, 0.6]);
          ring.rotateX(Math.PI / 2 + (k - 1) * 0.07);
          ring.rotateY(k * 0.7);
          specials.push(put(ring, cx + k * 0.02, cy + 0.02 + k * 0.014, cz));
        }
        // The crossarm lies at the foot, one cup knocked off
        const arm: GeoList = [];
        arm.push(box(1.7, 0.08, 0.1, CH.timber, [0, 1, 0.1, 0.3]));
        for (const px of [-0.72, -0.32, 0.72]) {
          arm.push(
            put(new THREE.CylinderGeometry(0.011, 0.011, 0.1, 6), px, 0.08, 0),
          );
          mapUv(arm[arm.length - 1], CH.iron, [0.4, 0.5, 0.4, 0.5]);
          arm.push(put(cup(det.cupSegs), px, 0.1, 0));
        }
        const gy = terrainHeight(p.x + 0.9, p.z + 0.5);
        const am = new THREE.Matrix4()
          .makeRotationFromEuler(new THREE.Euler(0.55, p.yaw + 0.7, 0.06))
          .setPosition(p.x + 0.9, gy + 0.03, p.z + 0.5);
        for (const g of arm) specials.push(g.applyMatrix4(am));
        const loose = cup(det.cupSegs);
        loose.rotateX(Math.PI / 2 + 0.3);
        specials.push(
          put(
            loose,
            p.x - 0.4,
            terrainHeight(p.x - 0.4, p.z + 1.1) + 0.04,
            p.z + 1.1,
            1.2,
          ),
        );
      } else if (i === SNAPPED_POLE) {
        // Snapped: the stump with splinters, the top hanging down to the ground
        const stump = poleParts(det, {
          height: STUMP_H,
          crossarm: false,
          topPin: false,
          v0: 0,
          v1: STUMP_H / POLE_H,
          rBot: POLE_R_BOT,
          rTop: POLE_R_BOT + ((POLE_R_TOP - POLE_R_BOT) * STUMP_H) / POLE_H,
        });
        const m = new THREE.Matrix4().compose(
          base,
          q,
          new THREE.Vector3(1, 1, 1),
        );
        for (const g of stump) specials.push(g.applyMatrix4(m));
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * Math.PI * 2 + 0.4;
          const sp = box(0.03, 0.55, 0.04, CH.pole, [0.2, 0.35, 0.4, 0.5]);
          sp.translate(0, 0.2, 0);
          sp.rotateX(0.12 + k * 0.08);
          sp.rotateY(a);
          sp.translate(Math.cos(a) * 0.08, STUMP_H - 0.05, Math.sin(a) * 0.08);
          specials.push(sp.applyMatrix4(m));
        }
        const upper = poleParts(det, {
          height: p.h - STUMP_H + 0.4,
          crossarm: true,
          topPin: true,
          v0: STUMP_H / POLE_H,
          v1: 1,
          rBot: POLE_R_BOT + ((POLE_R_TOP - POLE_R_BOT) * STUMP_H) / POLE_H,
          rTop: POLE_R_TOP,
        });
        const fallDir = p.yaw + 1.2;
        const fx = Math.sin(fallDir);
        const fz = Math.cos(fallDir);
        const topY = STUMP_H - 0.15;
        const ulen = p.h - STUMP_H + 0.4;
        const drop =
          topY -
          0.05 -
          (terrainHeight(p.x + fx * ulen * 0.7, p.z + fz * ulen * 0.7) - p.y);
        const beta = Math.asin(Math.min(0.95, drop / ulen));
        const axis = new THREE.Vector3(
          Math.cos(beta) * fx,
          -Math.sin(beta),
          Math.cos(beta) * fz,
        );
        const uq = new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          axis,
        );
        const um = new THREE.Matrix4().compose(
          new THREE.Vector3(p.x + fx * 0.2, p.y + topY, p.z + fz * 0.2),
          uq,
          new THREE.Vector3(1, 1, 1),
        );
        for (const g of upper) specials.push(g.applyMatrix4(um));
        seats[i] = wireSeats(ulen, true).map((v) => v.applyMatrix4(um));
      } else {
        // Fallen: rotted through at the tar line – a short stub still in the
        // ground, the pole lying full length in the sand, crossarm and cups
        // still on, following the ground between its two ends
        const fallDir = p.yaw + 0.9 + (i % 2) * 1.6;
        const fx = Math.sin(fallDir);
        const fz = Math.cos(fallDir);
        const stub = poleParts(det, {
          height: 0.55,
          crossarm: false,
          topPin: false,
          v0: 0,
          v1: 0.55 / POLE_H,
          rBot: POLE_R_BOT,
          rTop: POLE_R_BOT - 0.006,
        });
        const stubQ = new THREE.Quaternion()
          .setFromAxisAngle(new THREE.Vector3(fz, 0, -fx), 0.3)
          .multiply(new THREE.Quaternion().setFromAxisAngle(UP, p.yaw));
        const sm = new THREE.Matrix4().compose(
          base,
          stubQ,
          new THREE.Vector3(1, 1, 1),
        );
        for (const g of stub) specials.push(g.applyMatrix4(sm));
        const plen = p.h - 0.5;
        const b0 = new THREE.Vector3(p.x + fx * 0.7, 0, p.z + fz * 0.7);
        b0.y = terrainHeight(b0.x, b0.z) + 0.1;
        const b1 = new THREE.Vector3(
          p.x + fx * (0.7 + plen),
          0,
          p.z + fz * (0.7 + plen),
        );
        b1.y = terrainHeight(b1.x, b1.z) + 0.1;
        const axis = b1.clone().sub(b0).normalize();
        // Crossarm horizontal, its face (local +z) up
        const X = new THREE.Vector3().crossVectors(axis, UP).normalize();
        const Z = new THREE.Vector3().crossVectors(X, axis);
        const fm = new THREE.Matrix4().makeBasis(X, axis, Z).setPosition(b0);
        const lying = poleParts(det, {
          height: plen,
          crossarm: true,
          topPin: true,
          v0: 0.5 / POLE_H,
          v1: 1,
          rBot: POLE_R_BOT - 0.004,
          rTop: POLE_R_TOP,
        });
        for (const g of lying) specials.push(g.applyMatrix4(fm));
        fallenSeats[i] = wireSeats(plen, true).map((v) => v.applyMatrix4(fm));
        fallenBoxes.push({
          x: (b0.x + b1.x) / 2,
          z: (b0.z + b1.z) / 2,
          half: plen / 2,
          yaw: fallDir - Math.PI / 2,
          y: Math.min(b0.y, b1.y) - 0.15,
        });
      }
    }
    // Two slates blown off the roof, lying outside
    for (const [lx, lz, yw] of [
      [-2.45, -2.25, 0.7],
      [1.95, -2.7, 2.4],
    ]) {
      const [wx, wz] = toWorld(lx, lz);
      const g = box(0.254, 0.008, 0.508, CH.slate);
      g.rotateZ(0.05);
      specials.push(put(g, wx, terrainHeight(wx, wz) + 0.02, wz, yaw + yw));
    }
    for (const g of specials) withColor(g, 1);

    const atlasGeo = mergeList(atlas, "atlas");
    this.geometries.push(atlasGeo);
    const atlasMesh = new THREE.Mesh(atlasGeo, atlasMat);
    atlasMesh.castShadow = true;
    atlasMesh.receiveShadow = true;
    this.group.add(atlasMesh);

    const specialGeo = mergeList(specials, "specials");
    this.geometries.push(specialGeo);
    const specialMesh = new THREE.Mesh(specialGeo, atlasMat);
    specialMesh.castShadow = true;
    specialMesh.receiveShadow = true;
    this.group.add(specialMesh);

    // Standard poles: one instanced draw call
    const poleGeo = mergeList(
      poleParts(det, {
        height: POLE_H,
        crossarm: true,
        topPin: true,
        v0: 0,
        v1: 1,
        rBot: POLE_R_BOT,
        rTop: POLE_R_TOP,
      }).map((g) => withColor(g, 1)),
      "pole",
    );
    this.geometries.push(poleGeo);
    const instanced = new THREE.InstancedMesh(
      poleGeo,
      atlasMat,
      POLE_COUNT - SPECIAL.size,
    );
    this.instanced = instanced;
    const im = new THREE.Matrix4();
    let n = 0;
    for (const [i, p] of this.poles.entries()) {
      if (SPECIAL.has(i)) continue;
      im.compose(
        new THREE.Vector3(p.x, p.y, p.z),
        poleQuaternion(p),
        new THREE.Vector3(1, p.h / POLE_H, 1),
      );
      instanced.setMatrixAt(n++, im);
      seats[i] = wireSeats(POLE_H, true).map((v) => v.applyMatrix4(im));
    }
    instanced.instanceMatrix.needsUpdate = true;
    instanced.computeBoundingSphere();
    instanced.castShadow = true;
    instanced.receiveShadow = true;
    this.group.add(instanced);

    // --- Wire: cut and salvaged, not never strung --------------------------
    const wrng = mulberry32(0x3175);
    const wire: number[] = [];
    const wired = new Set<string>();
    if (hi) {
      for (const [a, b] of WIRED_SPANS) {
        const sa = seats[a];
        const sb = seats[b];
        if (!sa || !sb) continue;
        const slots = wrng() < 0.5 ? [0, 1, 2, 3] : [0, 1, 3];
        if (wrng() < 0.5) slots.push(4);
        for (const k of slots) {
          catenary(sa[k], sb[k], 0.7 + wrng() * 0.6, wire);
          wired.add(`${a}:${k}`);
          wired.add(`${b}:${k}`);
        }
      }
    }
    const pTail = hi ? 0.45 : 0.32;
    for (const [i, s] of seats.entries()) {
      if (!s) continue;
      for (const [k, seat] of s.entries()) {
        if (wired.has(`${i}:${k}`) || wrng() > pTail) continue;
        const a = wrng() * Math.PI * 2;
        tail(
          seat,
          0.5 + wrng() * 0.9,
          Math.sin(a),
          Math.cos(a),
          (wrng() - 0.5) * 0.3,
          wire,
        );
      }
    }
    for (const [i, s] of fallenSeats.entries()) {
      if (!s) continue;
      for (const k of [0, 3]) {
        trail(
          s[k],
          this.poles[i].yaw + wrng() * 2.4 - 1.2,
          3 + wrng() * 2.5,
          wrng() * 6,
          wire,
        );
      }
    }
    const wireGeo = new THREE.BufferGeometry();
    wireGeo.setAttribute("position", new THREE.Float32BufferAttribute(wire, 3));
    wireGeo.computeBoundingSphere();
    this.geometries.push(wireGeo);
    const wireMat = new THREE.LineBasicMaterial({ color: 0x1b1916 });
    this.materials.push(wireMat);
    this.group.add(new THREE.LineSegments(wireGeo, wireMat));

    // --- Sand drift ----------------------------------------------------------
    const shape = driftShape();
    const driftGeo = buildDrift(shape, det.driftStep, toWorld, floorY);
    this.geometries.push(driftGeo);
    const sandMat = new THREE.MeshStandardMaterial({
      map: sandAlbedo(),
      normalMap: sandNormal(),
      normalScale: new THREE.Vector2(0.7, 0.7),
      roughness: 0.95,
      metalness: 0,
    });
    sandMat.customProgramCacheKey = () => "cable-drift";
    sandMat.onBeforeCompile = (shader) => {
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
        float chHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float chNoise(vec2 p) {
          vec2 i = floor(p); vec2 f = p - i;
          f = f * f * (3.0 - 2.0 * f);
          float a = chHash(i), b = chHash(i + vec2(1.0, 0.0));
          float c = chHash(i + vec2(0.0, 1.0)), d = chHash(i + vec2(1.0, 1.0));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }
        ${shader.fragmentShader}`.replace(
        "#include <map_fragment>",
        `#include <map_fragment>
         float pud = chNoise(vWorldPos.xz * 0.085) * 0.65
                   + chNoise(vWorldPos.xz * 0.31) * 0.35;
         float rainWet = uWet * (0.5 + 0.5 * smoothstep(0.32, 0.68, pud)) * 0.85;
         diffuseColor.rgb *= mix(1.0, 0.6, rainWet);
         float cGrey = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
         diffuseColor.rgb = mix(
           diffuseColor.rgb,
           vec3(cGrey) * vec3(0.97, 0.99, 1.05),
           uCloud * 0.42);`,
      );
    };
    this.materials.push(sandMat);
    const drift = new THREE.Mesh(driftGeo, sandMat);
    drift.receiveShadow = true;
    this.group.add(drift);

    // Walkable floor, doorway tongue and the banks outside – exactly the
    // surface the drift mesh draws. Allocation-free: this runs for every
    // moving body every frame, so a squared-distance early-out comes first.
    registerGround(TAG, (wx, wz) => {
      const dx = wx - CX;
      const dz = wz - CZ;
      if (dx * dx + dz * dz > 25) return null;
      const lx = dx * cy - dz * sy;
      const lz = dx * sy + dz * cy;
      const h = shape.surface(lx, lz, terrainHeight(wx, wz) - floorY);
      if (h === null) return null;
      // Inside, the film sinks below the slab where it fades out – stand on
      // the concrete there, not 6 mm under it
      return floorY + (shape.inner(lx, lz) ? Math.max(0, h) : h);
    });

    // --- Light shaft through the big hole in the front slope -----------------
    const sl = slopes()[0];
    const hole = slopePoint(
      sl,
      FRONT_HOLE.u - EX,
      (FRONT_HOLE.s / SLOPE_H) * SLOPE_LEN,
      0,
    );
    this.holeWorld.copy(hole).applyMatrix4(hutMatrix);
    this.holeNormal
      .copy(sl.N)
      .applyMatrix4(new THREE.Matrix4().makeRotationY(yaw));
    const beamGeo = new THREE.BufferGeometry();
    this.beamPos = new THREE.BufferAttribute(new Float32Array(12), 3);
    this.beamPos.setUsage(THREE.DynamicDrawUsage);
    beamGeo.setAttribute("position", this.beamPos);
    beamGeo.setAttribute(
      "uv",
      new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2),
    );
    beamGeo.setIndex([0, 1, 2, 0, 2, 3]);
    beamGeo.boundingSphere = new THREE.Sphere(this.holeWorld.clone(), 6);
    this.geometries.push(beamGeo);
    this.beamMat = new THREE.MeshBasicMaterial({
      map: cableBeamTexture(),
      color: new THREE.Color(1, 0.93, 0.8),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.materials.push(this.beamMat);
    this.beam = new THREE.Mesh(beamGeo, this.beamMat);
    this.beam.frustumCulled = false;
    this.beam.visible = false;
    this.group.add(this.beam);

    // --- Colliders -----------------------------------------------------------
    beginColliderSet(TAG, { x: CX, y: floorY, z: CZ, yaw });
    const dl = DOOR_X - DOOR_W / 2;
    const dr = DOOR_X + DOOR_W / 2;
    const y0 = WALL_BOTTOM;
    const y1 = H + 0.3;
    addBoxCollider(
      (-L / 2 + dl) / 2,
      -D / 2 + T / 2,
      (dl + L / 2) / 2,
      T / 2,
      0,
      y0,
      y1,
    );
    addBoxCollider(
      (dr + L / 2) / 2,
      -D / 2 + T / 2,
      (L / 2 - dr) / 2,
      T / 2,
      0,
      y0,
      y1,
    );
    addBoxCollider(0, D / 2 - T / 2, L / 2, T / 2, 0, y0, y1);
    addBoxCollider(-L / 2 + T / 2, 0, T / 2, D / 2, 0, y0, y1);
    addBoxCollider(L / 2 - T / 2, 0, T / 2, D / 2, 0, y0, y1);
    addBoxCollider(door.cx, door.cz, 0.44, 0.04, door.yaw, 0, 2);
    addBoxCollider(0.85, D / 2 - T - 0.16, 0.56, 0.12, 0, 0, 2);
    addBoxCollider(-L / 2 + T + 0.2, 0.3, 0.18, 0.66, 0, 0, 0.5);
    addCylinderCollider(COIL.x, COIL.z, COIL.r + 0.05, 0, 0.3);
    addBoxCollider(
      DUCT.x,
      DUCT.z,
      DUCT.half + 0.03,
      DUCT.half + 0.03,
      0,
      -0.5,
      0.2,
    );
    // Poles (world coordinates)
    beginColliderSet(`${TAG}-poles`);
    for (const [i, p] of this.poles.entries()) {
      const top = FALLEN_POLES.includes(i)
        ? 0.6
        : i === SNAPPED_POLE
          ? STUMP_H
          : p.h;
      addCylinderCollider(p.x, p.z, 0.18, p.y, p.y + top);
    }
    for (const b of fallenBoxes) {
      addBoxCollider(b.x, b.z, b.half, 0.22, b.yaw, b.y, b.y + 0.45);
    }
    const sp = this.poles[SNAPPED_POLE];
    const fallDir = sp.yaw + 1.2;
    const fx = Math.sin(fallDir);
    const fz = Math.cos(fallDir);
    addBoxCollider(
      sp.x + fx * 2.9,
      sp.z + fz * 2.9,
      0.9,
      0.9,
      -fallDir,
      sp.y,
      sp.y + 1.3,
    );
    this.buildMs = performance.now() - t0;
  }

  update(dt: number, env: Environment, camPos: THREE.Vector3): void {
    // Drift: soaks quickly, dries slowly (like the terrain)
    const w = this.sandUniforms.uWet.value;
    const rate = env.rain > w ? 0.6 : 0.05;
    this.sandUniforms.uWet.value = w + (env.rain - w) * Math.min(1, dt * rate);
    this.sandUniforms.uCloud.value = env.cloud;

    // Light shaft: only with the sun on the front slope and a clear sky
    const d = env.sunDir;
    const facing = this.holeNormal.dot(d);
    const vis =
      sstep(0.12, 0.45, facing) *
      sstep(0.08, 0.3, d.y) *
      env.dayI *
      (1 - env.cloud) ** 1.6;
    if (vis < 0.01) {
      this.beam.visible = false;
      return;
    }
    const hole = this.holeWorld;
    const len = (hole.y - this.floorY) / d.y;
    const end = this.tmpA.copy(hole).addScaledVector(d, -len);
    const axis = this.tmpB.subVectors(end, hole).normalize();
    const side = this.tmpC.subVectors(camPos, hole).cross(axis);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    const p = this.beamPos;
    p.setXYZ(
      0,
      hole.x - side.x * 0.32,
      hole.y - side.y * 0.32,
      hole.z - side.z * 0.32,
    );
    p.setXYZ(
      1,
      hole.x + side.x * 0.32,
      hole.y + side.y * 0.32,
      hole.z + side.z * 0.32,
    );
    p.setXYZ(
      2,
      end.x + side.x * 0.55,
      end.y + side.y * 0.55,
      end.z + side.z * 0.55,
    );
    p.setXYZ(
      3,
      end.x - side.x * 0.55,
      end.y - side.y * 0.55,
      end.z - side.z * 0.55,
    );
    p.needsUpdate = true;
    this.beamMat.opacity = 0.2 * vis;
    this.beam.visible = true;
  }

  dispose(): void {
    this.parent.remove(this.group);
    this.instanced.dispose();
    for (const g of this.geometries) g.dispose();
    // Textures stay in the shared cache (textures-core); only materials go.
    for (const m of this.materials) m.dispose();
    clearColliderSet(TAG);
    clearColliderSet(`${TAG}-poles`);
    unregisterGround(TAG);
  }
}
