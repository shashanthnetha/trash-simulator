// Chantry Knoll – a roofless drystone chapel ruin being swallowed by the
// dunes on a gorse-clad knoll in the far-western hinterland. The knoll itself
// is terrain (landforms.ts CHANTRY_KNOLL); this module builds the ruin, the
// sand that is burying it, the gorse, the nettles and the elder, and its
// colliders (tag "chantry").
//
// The ruin: a 9 × 5 m nave oriented east–west. The east gable stands complete
// to its apex (6.2 m) with an empty, splayed lancet framing the sky; the other
// walls are broken to stubs of 0.7–2.7 m, the south wall has collapsed into a
// breach, the west doorway lost its lintel (it lies across the threshold) and
// an elder has taken root in it. Every block of the walls is a real jittered
// hexahedron with its own window into one lichen-crusted slate/granite face
// texture; the broken tops come from the course generator itself, dark
// hearting closes the joints. Sand blown in through the west door by the
// prevailing (+x) wind banks against the inside of the gable; tongues run out
// of the door and the breach, a lee tail lies east of the gable, and two
// blank grave slabs lean in the sand south of the nave.
//
// Draw calls in the main pass: 4 – merged stone (walls, surround, slabs,
// lintel, tumbled stones, hearting), the sand sheets, the elder's bark and
// ONE instanced foliage mesh (gorse + nettles + elder cards share a 2×2
// atlas and a wind-sway vertex shader with per-instance stiffness).

import * as THREE from "three";
import {
  addBoxCollider,
  addCylinderCollider,
  beginColliderSet,
  clearColliderSet,
} from "./colliders";
import { CHANTRY_KNOLL, polylineDistance } from "./landforms";
import { clamp, fbm, mulberry32, smoothstep } from "./noise";
import {
  FOLIAGE_TILE,
  chantryFoliageAtlas,
  pbrChantryStone,
  pbrElderBark,
} from "./place-chantry-textures";
import type { Environment } from "./sky";
import { terrainHeight } from "./terrain";
import { applyPbr, pbrSand, pbrWood } from "./textures";
import type { QualityId } from "./types";

// ---------------------------------------------------------------------------
// Site and dimensions (nave frame: x = nave axis, +x = east gable; z across)
// ---------------------------------------------------------------------------

const SITE_X = CHANTRY_KNOLL.x + 0.6;
const SITE_Z = CHANTRY_KNOLL.z - 0.8;
const SITE_YAW = 0.21;
const SITE_C = Math.cos(SITE_YAW);
const SITE_S = Math.sin(SITE_YAW);

/** Interior half-lengths, wall thickness, outer half-lengths. */
const NAVE_HX = 4.5;
const NAVE_HZ = 2.5;
const T = 0.78;
const OUT_HX = NAVE_HX + T;
const OUT_HZ = NAVE_HZ + T;
/** Gable eaves and apex above the footing level. */
const EAVES_H = 2.9;
const APEX_H = 6.2;
/** West doorway (centre z, half width) and the breach in the south wall. */
const DOOR_Z = 0;
const DOOR_HZ = 0.62;
const BREACH_X = -0.7;
const BREACH_HX = 1.35;
/** Lancet: sill and springing above the footing, half-spans, ring depth. */
const WIN = { sill: 1.7, spring: 3.35, hwOut: 0.28, hwIn: 0.56, ring: 0.3 };
/** Dressed surround stands proud of the rubble face. */
const PROUD = 0.016;
/** Sand texture tiling of the terrain mesh (world.ts) – the drifts match it. */
const SAND_TILE_X = 820 / 70;
const SAND_TILE_Z = 560 / 48;
/** Metres per repeat of the stone face texture. */
const STONE_TILE = 1.5;
const TAU = Math.PI * 2;

interface Grave {
  x: number;
  z: number;
  yaw: number;
  lean: number;
  r: number;
  mound: number;
}
/** Grave slabs south (-z, the sunny side) of the nave. */
const GRAVES: readonly Grave[] = [
  { x: 0.9, z: -OUT_HZ - 2.3, yaw: 0.12, lean: 0.28, r: 0.95, mound: 0.13 },
  { x: -1.5, z: -OUT_HZ - 3.3, yaw: -0.22, lean: 0.5, r: 0.9, mound: 0.1 },
];

// ---------------------------------------------------------------------------
// Quality tiers
// ---------------------------------------------------------------------------

interface Tier {
  gorse: number;
  unitsMin: number;
  unitsMax: number;
  nettles: number;
  elderCards: number;
  loose: number;
  sheetRes: number;
  courseScale: number;
  /** Relative spread of the course heights (regular ashlar → rubble). */
  courseVar: number;
  foliageShadow: boolean;
  tex: 512 | 1024;
}

const TIERS: Record<QualityId, Tier> = {
  ultra: {
    gorse: 200,
    unitsMin: 5,
    unitsMax: 8,
    nettles: 48,
    elderCards: 46,
    loose: 60,
    sheetRes: 1,
    courseScale: 1,
    courseVar: 0.5,
    foliageShadow: true,
    tex: 1024,
  },
  high: {
    gorse: 165,
    unitsMin: 4,
    unitsMax: 7,
    nettles: 40,
    elderCards: 40,
    loose: 48,
    sheetRes: 1,
    courseScale: 1,
    courseVar: 0.5,
    foliageShadow: true,
    tex: 1024,
  },
  medium: {
    gorse: 140,
    unitsMin: 3,
    unitsMax: 5,
    nettles: 30,
    elderCards: 30,
    loose: 36,
    sheetRes: 0.7,
    courseScale: 1.2,
    courseVar: 0.55,
    foliageShadow: true,
    tex: 512,
  },
  low: {
    // The gorse IS the knoll's identity: keep the shrub count, drop the
    // interior cards instead (2–3 outer cards each)
    gorse: 120,
    unitsMin: 2,
    unitsMax: 3,
    nettles: 20,
    elderCards: 22,
    loose: 22,
    sheetRes: 0.5,
    courseScale: 1.25,
    courseVar: 0.7,
    foliageShadow: false,
    tex: 512,
  },
};

// ---------------------------------------------------------------------------
// Frame helpers
// ---------------------------------------------------------------------------

type V3 = [number, number, number];
type Rgb = [number, number, number];
type TintFn = (worldNormal: V3, y: number) => Rgb;

function toWorld(lx: number, lz: number): [number, number] {
  return [
    SITE_X + lx * SITE_C + lz * SITE_S,
    SITE_Z - lx * SITE_S + lz * SITE_C,
  ];
}

function toLocal(wx: number, wz: number): [number, number] {
  const dx = wx - SITE_X;
  const dz = wz - SITE_Z;
  return [dx * SITE_C - dz * SITE_S, dx * SITE_S + dz * SITE_C];
}

function groundL(lx: number, lz: number): number {
  const [wx, wz] = toWorld(lx, lz);
  return terrainHeight(wx, wz);
}

/** Piecewise-linear profile over [s, h] knots. */
function prof(
  pts: ReadonlyArray<readonly [number, number]>,
  s: number,
): number {
  if (s <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (s <= pts[i][0]) {
      const t = (s - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]);
      return pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t;
    }
  }
  return pts[pts.length - 1][1];
}

// ---------------------------------------------------------------------------
// Switchback paths through the gorse (world polylines)
// ---------------------------------------------------------------------------

/** (radius, angle) knots around the knoll centre; angle: x = cos, z = sin. */
const PATH_KNOTS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  // from the beach side (north-east foot) up to the south-east of the gable
  [
    [47, -0.62],
    [40, -0.42],
    [33, -0.78],
    [26, -0.5],
    [19.5, -0.82],
    [14, -0.6],
    [11, -0.45],
  ],
  // from the west foot up to the doorway side
  [
    [47, 2.7],
    [40, 2.98],
    [33, 2.6],
    [26, 2.95],
    [19, 2.62],
    [13.5, 2.85],
    [11, 2.95],
  ],
  // from the inland (+z) foot up behind the north wall
  [
    [46, 1.35],
    [39, 1.62],
    [32, 1.28],
    [25, 1.58],
    [18.5, 1.3],
    [13, 1.5],
    [11, 1.42],
  ],
];

/**
 * The three switchback paths as world polylines – the gorse keeps clear of
 * them (landforms.ts could mask the grass along them the same way).
 */
export const CHANTRY_PATHS: ReadonlyArray<
  ReadonlyArray<readonly [number, number]>
> = PATH_KNOTS.map((knots) =>
  knots.map(([r, a]) => [
    Math.round((CHANTRY_KNOLL.x + Math.cos(a) * r) * 10) / 10,
    Math.round((CHANTRY_KNOLL.z + Math.sin(a) * r) * 10) / 10,
  ]),
);

function pathDistance(x: number, z: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (const p of CHANTRY_PATHS) {
    const d = polylineDistance(p, x, z);
    if (d < best) best = d;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Geometry writers
// ---------------------------------------------------------------------------

/**
 * Accumulates flat-shaded quads (position/normal/uv/colour) in the nave frame
 * and bakes them into world space; one non-indexed geometry per material.
 */
class MeshWriter {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly col: number[] = [];
  private readonly withColor: boolean;

  constructor(withColor: boolean) {
    this.withColor = withColor;
  }

  push(p: V3, n: V3, u: number, v: number, c: Rgb): void {
    this.pos.push(
      SITE_X + p[0] * SITE_C + p[2] * SITE_S,
      p[1],
      SITE_Z - p[0] * SITE_S + p[2] * SITE_C,
    );
    this.nrm.push(
      n[0] * SITE_C + n[2] * SITE_S,
      n[1],
      -n[0] * SITE_S + n[2] * SITE_C,
    );
    this.uv.push(u, v);
    if (this.withColor) this.col.push(c[0], c[1], c[2]);
  }

  /** Flat quad a-b-c-d (CCW seen from outside); u runs along the most horizontal edge. */
  quad(
    a: V3,
    b: V3,
    c: V3,
    d: V3,
    col: Rgb,
    uo: number,
    vo: number,
    tint?: TintFn,
    round?: readonly [number, number, number, number],
  ): void {
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const abz = b[2] - a[2];
    const acx = c[0] - a[0];
    const acy = c[1] - a[1];
    const acz = c[2] - a[2];
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    const adx = d[0] - a[0];
    const ady = d[1] - a[1];
    const adz = d[2] - a[2];
    const abl = Math.hypot(abx, aby, abz) || 1;
    const adl = Math.hypot(adx, ady, adz) || 1;
    let e1x: number;
    let e1y: number;
    let e1z: number;
    if (Math.abs(aby) / abl <= Math.abs(ady) / adl) {
      e1x = abx / abl;
      e1y = aby / abl;
      e1z = abz / abl;
    } else {
      e1x = adx / adl;
      e1y = ady / adl;
      e1z = adz / adl;
    }
    let e2x = ny * e1z - nz * e1y;
    let e2y = nz * e1x - nx * e1z;
    let e2z = nx * e1y - ny * e1x;
    if (e2y < 0) {
      e2x = -e2x;
      e2y = -e2y;
      e2z = -e2z;
    }
    const n: V3 = [nx, ny, nz];
    const wn: V3 = [nx * SITE_C + nz * SITE_S, ny, -nx * SITE_S + nz * SITE_C];
    const yc = (a[1] + b[1] + c[1] + d[1]) / 4;
    const cc = tint ? tint(wn, yc) : col;
    const uvOf = (p: V3): [number, number] => {
      const px = p[0] - a[0];
      const py = p[1] - a[1];
      const pz = p[2] - a[2];
      return [
        uo + (px * e1x + py * e1y + pz * e1z) / STONE_TILE,
        vo + (px * e2x + py * e2y + pz * e2z) / STONE_TILE,
      ];
    };
    const ua = uvOf(a);
    const ub = uvOf(b);
    const uc = uvOf(c);
    const ud = uvOf(d);
    // Rounded shading: bend the vertex normals towards the direction from
    // the block's centre, so the edges read as worn and spalled rather than
    // as the crisp arrises of a tile
    const nv = (p: V3): V3 => {
      if (!round) return n;
      const k = round[3];
      let dx = p[0] - round[0];
      let dy = p[1] - round[1];
      let dz = p[2] - round[2];
      const l = Math.hypot(dx, dy, dz) || 1;
      dx /= l;
      dy /= l;
      dz /= l;
      const rx = nx * (1 - k) + dx * k;
      const ry = ny * (1 - k) + dy * k;
      const rz = nz * (1 - k) + dz * k;
      const rl = Math.hypot(rx, ry, rz) || 1;
      return [rx / rl, ry / rl, rz / rl];
    };
    const na = nv(a);
    const nb = nv(b);
    const nc = nv(c);
    const nd = nv(d);
    this.push(a, na, ua[0], ua[1], cc);
    this.push(b, nb, ub[0], ub[1], cc);
    this.push(c, nc, uc[0], uc[1], cc);
    this.push(a, na, ua[0], ua[1], cc);
    this.push(c, nc, uc[0], uc[1], cc);
    this.push(d, nd, ud[0], ud[1], cc);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.withColor)
      g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}

/** Corner order: 0..3 bottom ring, 4..7 top ring (same loop direction). */
const HEX_FACES: ReadonlyArray<readonly number[]> = [
  [0, 1, 2, 3],
  [4, 7, 6, 5],
  [0, 4, 5, 1],
  [3, 2, 6, 7],
  [1, 5, 6, 2],
  [0, 3, 7, 4],
];

/** Hexahedron from 8 corners; faces are wound outwards automatically. */
function hexa(
  w: MeshWriter,
  P: V3[],
  col: Rgb,
  uo: number,
  vo: number,
  tint?: TintFn,
  skipBottom = false,
  round = 0,
): void {
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const p of P) {
    cx += p[0];
    cy += p[1];
    cz += p[2];
  }
  cx /= 8;
  cy /= 8;
  cz /= 8;
  const rd: readonly [number, number, number, number] | undefined =
    round > 0 ? [cx, cy, cz, round] : undefined;
  for (let f = 0; f < 6; f++) {
    if (skipBottom && f === 0) continue;
    const [i0, i1, i2, i3] = HEX_FACES[f];
    const a = P[i0];
    let b = P[i1];
    const c = P[i2];
    let d = P[i3];
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const abz = b[2] - a[2];
    const acx = c[0] - a[0];
    const acy = c[1] - a[1];
    const acz = c[2] - a[2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const fx = (a[0] + b[0] + c[0] + d[0]) / 4 - cx;
    const fy = (a[1] + b[1] + c[1] + d[1]) / 4 - cy;
    const fz = (a[2] + b[2] + c[2] + d[2]) / 4 - cz;
    if (nx * fx + ny * fy + nz * fz < 0) {
      const t = b;
      b = d;
      d = t;
    }
    w.quad(a, b, c, d, col, uo, vo, tint, rd);
  }
}

/** Pull the corners towards the centroid by random fractions: chipped, spalled edges. */
function spallCorners(P: V3[], rng: () => number, spall: number): void {
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const p of P) {
    cx += p[0];
    cy += p[1];
    cz += p[2];
  }
  cx /= P.length;
  cy /= P.length;
  cz /= P.length;
  for (const p of P) {
    const f = rng() * spall;
    p[0] += (cx - p[0]) * f;
    p[1] += (cy - p[1]) * f;
    p[2] += (cz - p[2]) * f;
  }
}

/** Indexed height sheets (the sand) with world-tiled sand UVs. */
class SheetWriter {
  readonly pos: number[] = [];
  readonly uv: number[] = [];
  readonly idx: number[] = [];

  /**
   * Grid over a nave-frame rectangle. `feather` = [minX, maxX, minZ, maxZ]:
   * edges that dissolve into the terrain; `h` is the sand height over the
   * ground (already feathered edges are sunk 4.5 cm below it).
   */
  grid(
    x0: number,
    x1: number,
    z0: number,
    z1: number,
    nx: number,
    nz: number,
    feather: readonly [boolean, boolean, boolean, boolean],
    h: (lx: number, lz: number) => number,
  ): void {
    const base = this.pos.length / 3;
    for (let j = 0; j <= nz; j++) {
      const lz = z0 + ((z1 - z0) * j) / nz;
      for (let i = 0; i <= nx; i++) {
        const lx = x0 + ((x1 - x0) * i) / nx;
        let f = 1;
        if (feather[0]) f *= smoothstep(0, 1.6, lx - x0);
        if (feather[1]) f *= smoothstep(0, 1.6, x1 - lx);
        if (feather[2]) f *= smoothstep(0, 1.6, lz - z0);
        if (feather[3]) f *= smoothstep(0, 1.6, z1 - lz);
        const hh = h(lx, lz) * f;
        const t = smoothstep(0.02, 0.12, hh);
        const y = groundL(lx, lz) + (-0.045 + (hh + 0.045) * t);
        const [wx, wz] = toWorld(lx, lz);
        this.pos.push(wx, y, wz);
        this.uv.push((wx + 410) / SAND_TILE_X, (420 - wz) / SAND_TILE_Z);
      }
    }
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const a = base + j * (nx + 1) + i;
        const b = a + nx + 1;
        this.idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * One foliage unit: two quads crossed at 90°, unit width (x ±0.5) and unit
 * height (y 0..1, base at the origin), each with a lengthwise fold (8 tris).
 * Normals are placeholders – the material uses the per-instance aCNrm.
 */
function buildCardGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const cols = [-0.5, 0, 0.5];
  for (let q = 0; q < 2; q++) {
    const yawQ = (q * Math.PI) / 2;
    const cy = Math.cos(yawQ);
    const sy = Math.sin(yawQ);
    const start = pos.length / 3;
    for (const ly of [0, 1]) {
      for (let ci = 0; ci < 3; ci++) {
        const lx = cols[ci];
        const lz = ci === 1 ? 0.1 : 0;
        pos.push(lx * cy + lz * sy, ly, -lx * sy + lz * cy);
        nrm.push(0, 1, 0);
        uv.push(lx + 0.5, ly);
      }
    }
    for (let ci = 0; ci < 2; ci++) {
      const a = start + ci;
      const b = start + 3 + ci;
      idx.push(a, a + 1, b + 1, a, b + 1, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// ---------------------------------------------------------------------------
// GLSL – foliage sway (onBeforeCompile), wet darkening
// ---------------------------------------------------------------------------

const FOL_VERT_PARS = /* glsl */ `
uniform float uCkTime;
uniform float uCkWind;
uniform vec2 uCkDir;
attribute vec4 aCard;
attribute vec3 aCNrm;
float ckHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float ckNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = ckHash(i);
  float b = ckHash(i + vec2(1.0, 0.0));
  float c = ckHash(i + vec2(0.0, 1.0));
  float d = ckHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
`;

/**
 * Sway: gusts travel with the wind across the knoll; each card bends from its
 * base (profile y²) downwind with a per-instance phase, a smaller cross-wind
 * wobble and – for the stiff species – a fast tremble. aCard = (phase,
 * softness 0..1, atlas tile, 1/scale); the transpose(rot)/s² trick maps the
 * world displacement back into the card's frame.
 */
const FOL_VERT_BODY = /* glsl */ `
#ifdef USE_INSTANCING
mat3 ckRot = mat3(instanceMatrix);
vec3 ckBase = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
#else
mat3 ckRot = mat3(1.0);
vec3 ckBase = modelMatrix[3].xyz;
#endif
float ckH = clamp(position.y, 0.0, 1.0);
float ckSoft = aCard.y;
vec2 ckGp = ckBase.xz * 0.045 - uCkDir * uCkTime * (0.35 + 1.4 * uCkWind);
float ckGust = 0.3 + 0.7 * smoothstep(0.2, 0.8, ckNoise(ckGp) * 0.6 + ckNoise(ckGp * 2.7 + 5.1) * 0.4);
float ckFreq = (1.5 + 2.4 * uCkWind) * (1.25 - 0.55 * ckSoft);
float ckPh = uCkTime * ckFreq + aCard.x * 6.2832;
float ckOsc = sin(ckPh) * 0.7 + sin(ckPh * 2.13 + 1.1) * 0.3;
float ckAmp = uCkWind * uCkWind * (0.015 + 0.13 * ckSoft) * ckGust;
vec3 ckSway = vec3(uCkDir.x, 0.0, uCkDir.y) * ckAmp * (0.6 + 0.4 * ckOsc);
vec2 ckPerp = vec2(-uCkDir.y, uCkDir.x);
ckSway += vec3(ckPerp.x, 0.0, ckPerp.y) * ckAmp * 0.4 * sin(ckPh * 1.37 + aCard.x * 9.0);
float ckTrem = sin(uCkTime * (7.0 + 10.0 * uCkWind) + aCard.x * 17.0 + position.x * 5.0)
             * uCkWind * (0.004 + 0.016 * (1.0 - ckSoft)) * ckGust;
ckSway += vec3(uCkDir.x, 0.0, uCkDir.y) * ckTrem;
float ckInv = aCard.w;
transformed += (transpose(ckRot) * ckSway) * (ckH * ckH * ckInv * ckInv);
`;

/** Atlas tile select (2×2): tiles 0/1 top row, 2/3 bottom row. */
const FOL_UV = /* glsl */ `
vMapUv = uv * 0.476 + 0.012 + vec2(mod(aCard.z, 2.0) * 0.5, aCard.z < 1.5 ? 0.5 : 0.0);
`;

const FOL_FRAG_PARS = /* glsl */ `
uniform float uCkWet;
varying float vCkDist;
`;

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

interface Unit {
  x: number;
  y: number;
  z: number;
  yaw: number;
  tiltX: number;
  tiltZ: number;
  /** Optional pre-rotation that sits the card on the slope. */
  slope?: THREE.Quaternion;
  s: number;
  tile: number;
  phase: number;
  soft: number;
  nrm: THREE.Vector3;
}

interface Shrub {
  x: number;
  z: number;
  y: number;
  h: number;
  phase: number;
}

/** A block laid in a course (wall frame), for the hearting behind it. */
interface Placed {
  o0: number;
  o1: number;
  i0: number;
  i1: number;
  y0: number;
  y1: number;
}

interface Hole {
  o0: number;
  o1: number;
  i0: number;
  i1: number;
}

interface WallDef {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  nx: number;
  nz: number;
  dx: number;
  dz: number;
  len: number;
  /** Absolute wall-top height at s (the broken profile). */
  top: (s: number) => number;
  /** Courses stop here (absolute). */
  maxTop: number;
  /** s-ranges kept free between y0 and y1 (outer/inner face may differ). */
  openings: Array<(y0: number, y1: number) => Hole | null>;
  /** Course tops snap to these levels (sill, springing). */
  snaps: number[];
  /** Gable: half-width of the rake at absolute y. */
  rake?: (y: number) => number;
  /** Called per course before its stones (dressed surround). */
  onCourse?: (course: number, y0: number, y1: number) => void;
  seed: number;
}

/** Half-width of a two-centred arch ring at height h above the springing. */
function archHW(h: number, a: number, R: number): number {
  if (h >= R) return -1;
  return Math.sqrt(R * R - h * h) - a;
}

const UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// The place
// ---------------------------------------------------------------------------

export class ChantryKnoll {
  protected readonly parent: THREE.Group;
  protected readonly quality: QualityId;

  /** Nave frame in the world (for tests and other spawners). */
  readonly site = { x: SITE_X, z: SITE_Z, yaw: SITE_YAW };
  /** Build statistics (dev harness). */
  readonly info = {
    stones: 0,
    units: 0,
    gorse: 0,
    nettles: 0,
    elderCards: 0,
    colliders: 0,
    hearting: 0,
    baseY: 0,
  };

  private readonly tier: Tier;
  private readonly group = new THREE.Group();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly textures: THREE.Texture[] = [];
  private readonly u = {
    uCkTime: { value: 0 },
    uCkWind: { value: 0.2 },
    uCkDir: { value: new THREE.Vector2(1, 0) },
    uCkWet: { value: 0 },
    uWet: { value: 0 },
    uCloud: { value: 0 },
  };
  private wetInit = false;
  private baseY = 0;
  private readonly units: Unit[] = [];
  private readonly gorse: Shrub[] = [];

  constructor(parent: THREE.Group, quality: QualityId) {
    this.parent = parent;
    this.quality = quality;
    this.tier = TIERS[quality];
    this.group.name = "place-chantry";
    parent.add(this.group);

    this.baseY = this.footing();
    this.info.baseY = this.baseY;
    const stone = new MeshWriter(true);
    const bark = new MeshWriter(false);
    const sand = new SheetWriter();

    this.buildWalls(stone);
    this.buildLintel(stone);
    this.buildGraves(stone);
    this.buildLooseStones(stone);
    this.buildSand(sand);
    this.buildElder(bark);
    this.buildNettles();
    this.placeGorse();
    this.buildGorseUnits();

    this.addMesh(
      stone.build(),
      this.stoneMaterial(),
      "chantry-stone",
      true,
      true,
    );
    this.addMesh(
      sand.build(),
      this.sandMaterial(),
      "chantry-sand",
      false,
      true,
    );
    this.addMesh(bark.build(), this.barkMaterial(), "chantry-bark", true, true);
    this.buildFoliageMesh();
    this.buildColliders();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  update(dt: number, env: Environment, _camPos: THREE.Vector3): void {
    const u = this.u;
    u.uCkTime.value = env.envTime;
    const w = clamp(env.wind, 0, 1);
    const target = env.weather === "storm" ? Math.min(1, w * 1.1 + 0.05) : w;
    u.uCkWind.value += (target - u.uCkWind.value) * Math.min(1, dt * 1.5);
    // Same slowly meandering direction as the dune grass and the pines
    const a = 0.28 * Math.sin(env.envTime * 0.045);
    u.uCkDir.value.set(Math.cos(a), Math.sin(a));
    // Wets fast, dries slow (like the terrain's uWet)
    if (this.wetInit) {
      const rate = env.rain > u.uCkWet.value ? 0.5 : 0.04;
      u.uCkWet.value += (env.rain - u.uCkWet.value) * Math.min(1, dt * rate);
    } else {
      u.uCkWet.value = env.rain;
      this.wetInit = true;
    }
    u.uWet.value = u.uCkWet.value;
    u.uCloud.value = env.cloud;
  }

  dispose(): void {
    clearColliderSet("chantry");
    this.parent.remove(this.group);
    this.group.traverse((o) => {
      const im = o as THREE.InstancedMesh;
      if (im.isInstancedMesh) im.dispose();
      const mesh = o as THREE.Mesh;
      if (mesh.customDepthMaterial) mesh.customDepthMaterial.dispose();
    });
    for (const g of this.geometries) g.dispose();
    this.geometries.length = 0;
    // The stone/bark/sand PBR sets stay in the shared texture cache (house
    // convention); the foliage atlas is ours alone.
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
    for (const t of this.textures) t.dispose();
    this.textures.length = 0;
    this.units.length = 0;
    this.gorse.length = 0;
  }

  private addMesh(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    name: string,
    cast: boolean,
    receive: boolean,
  ): void {
    this.geometries.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    this.group.add(mesh);
  }

  // -------------------------------------------------------------------------
  // Ground and sand
  // -------------------------------------------------------------------------

  /** Common footing level: the lowest ground under the four walls. */
  private footing(): number {
    let lo = Number.POSITIVE_INFINITY;
    for (let s = -OUT_HX; s <= OUT_HX; s += 0.5) {
      lo = Math.min(
        lo,
        groundL(s, OUT_HZ - T / 2),
        groundL(s, -OUT_HZ + T / 2),
      );
    }
    for (let s = -OUT_HZ; s <= OUT_HZ; s += 0.5) {
      lo = Math.min(
        lo,
        groundL(OUT_HX - T / 2, s),
        groundL(-OUT_HX + T / 2, s),
      );
    }
    return lo - 0.05;
  }

  /**
   * Sand over the ground at a nave-frame point: the half-buried nave floor
   * banked against the east gable (the +x wind blows in through the west
   * door), the windward ramp and door tongue at the west wall, the lee tail
   * east of the gable, the aprons along the long walls, the breach tongue and
   * the mounds at the grave slabs. Metres above the terrain.
   */
  private sandH(lx: number, lz: number): number {
    const inside = Math.abs(lx) < NAVE_HX + 0.2 && Math.abs(lz) < NAVE_HZ + 0.2;
    let h: number;
    if (inside) {
      h =
        0.42 +
        0.58 * Math.exp(-(NAVE_HX - lx) / 1.25) +
        0.2 * Math.exp(-(NAVE_HZ - Math.abs(lz)) / 0.8) +
        0.28 *
          Math.exp(-Math.hypot(NAVE_HX - lx, NAVE_HZ - Math.abs(lz)) / 1.4) -
        0.1 *
          Math.exp(-(((lx - BREACH_X) / 1.3) ** 2)) *
          Math.exp(-Math.max(0, NAVE_HZ + lz) / 1.2);
      // scoured funnel just inside the doorway
      const wDoor = smoothstep(-NAVE_HX - 0.2, -NAVE_HX + 1.2, lx);
      h = 0.34 + (h - 0.34) * wDoor;
    } else {
      h = 0;
      const dW = -OUT_HX - lx;
      const dE = lx - OUT_HX;
      const dN = lz - OUT_HZ;
      const dS = -OUT_HZ - lz;
      if (lx < -NAVE_HX + 0.3 && Math.abs(lz) < OUT_HZ + 2.5) {
        const d = Math.max(0, dW);
        const doorG = Math.exp(-(((lz - DOOR_Z) / (0.85 + 0.4 * d)) ** 2));
        const ramp =
          0.5 *
          Math.exp(-d / 0.9) *
          (1 - smoothstep(OUT_HZ, OUT_HZ + 2.2, Math.abs(lz)));
        const tongue = 0.45 * Math.exp(-d / 2.8);
        h += ramp * (1 - doorG) + tongue * doorG;
      }
      if (dE > -0.3)
        h +=
          0.55 *
          Math.exp(-Math.max(0, dE) / 2.6) *
          Math.exp(-((lz / 2.4) ** 2));
      if (Math.abs(lx) < OUT_HX + 0.6) {
        if (dN > -0.4) h += 0.16 * Math.exp(-Math.max(0, dN) / 1.1);
        if (dS > -0.4) h += 0.16 * Math.exp(-Math.max(0, dS) / 1.1);
      }
      if (lz < -NAVE_HZ + 0.3) {
        const d = Math.max(0, -NAVE_HZ - lz);
        const w = BREACH_HX * 0.85 + 0.5 * d;
        h +=
          0.36 * Math.exp(-d / 2.2) * Math.exp(-(((lx - BREACH_X) / w) ** 2));
      }
      for (const g of GRAVES) {
        const dd = ((lx - g.x) ** 2 + (lz - g.z) ** 2) / (g.r * g.r);
        h += g.mound * Math.exp(-dd);
      }
    }
    if (h > 0.05)
      h +=
        (fbm(lx * 1.7 + 3.3, lz * 1.7 + 8.1, 2) - 0.5) *
        0.07 *
        Math.min(1, h / 0.3);
    return h;
  }

  /** Walkable/visible surface at a nave-frame point (ground or sand). */
  private surfaceL(lx: number, lz: number): number {
    return groundL(lx, lz) + Math.max(0, this.sandH(lx, lz));
  }

  private buildSand(w: SheetWriter): void {
    const r = this.tier.sheetRes;
    const n = (v: number): number => Math.max(3, Math.round(v * r));
    const h = (lx: number, lz: number): number => this.sandH(lx, lz);
    // Nave floor (runs 0.1 m into the walls)
    w.grid(
      -NAVE_HX - 0.1,
      NAVE_HX + 0.1,
      -NAVE_HZ - 0.1,
      NAVE_HZ + 0.1,
      n(30),
      n(18),
      [false, false, false, false],
      h,
    );
    const X0 = -OUT_HX - 7.5;
    const X1 = OUT_HX + 6.5;
    // North (+z) strip incl. the wall footprint
    w.grid(
      X0,
      X1,
      NAVE_HZ + 0.05,
      OUT_HZ + 4.5,
      n(46),
      n(10),
      [true, true, false, true],
      h,
    );
    // South (-z) strip with the breach tongue and the graves
    w.grid(
      X0,
      X1,
      -OUT_HZ - 6.5,
      -NAVE_HZ - 0.05,
      n(46),
      n(14),
      [true, true, true, false],
      h,
    );
    // West strip: door tongue and windward ramp
    w.grid(
      X0,
      -NAVE_HX - 0.05,
      -NAVE_HZ - 0.05,
      NAVE_HZ + 0.05,
      n(16),
      n(10),
      [true, false, false, false],
      h,
    );
    // East strip: lee tail behind the gable
    w.grid(
      NAVE_HX + 0.05,
      X1,
      -NAVE_HZ - 0.05,
      NAVE_HZ + 0.05,
      n(14),
      n(10),
      [false, true, false, false],
      h,
    );
  }

  // -------------------------------------------------------------------------
  // Walls
  // -------------------------------------------------------------------------

  private buildWalls(w: MeshWriter): void {
    const baseY = this.baseY;
    const eavesY = baseY + EAVES_H;
    const apexY = baseY + APEX_H;
    const mk = (
      ax: number,
      az: number,
      bx: number,
      bz: number,
      nx: number,
      nz: number,
      seed: number,
      profile: ReadonlyArray<readonly [number, number]>,
      maxTop: number,
    ): WallDef => {
      const len = Math.hypot(bx - ax, bz - az);
      const dx = (bx - ax) / len;
      const dz = (bz - az) / len;
      return {
        ax,
        az,
        bx,
        bz,
        nx,
        nz,
        dx,
        dz,
        len,
        top: (s) =>
          groundL(ax + dx * s, az + dz * s) +
          prof(profile, s) +
          (fbm(s * 0.9 + seed * 0.37, seed * 0.11 + 1.7, 2) - 0.5) * 0.5,
        maxTop: baseY + maxTop,
        openings: [],
        snaps: [],
        seed,
      };
    };

    // North (+z, shaded) wall: stepping down from the gable towards the west
    const north = mk(
      -OUT_HX,
      NAVE_HZ + T / 2,
      NAVE_HX,
      NAVE_HZ + T / 2,
      0,
      1,
      11,
      [
        [0, 0.85],
        [1.6, 1.15],
        [3.3, 1.95],
        [4.7, 1.55],
        [6.3, 2.3],
        [7.9, 2.55],
        [9.78, 2.7],
      ],
      3.1,
    );
    // South (-z) wall: collapsed into a breach around BREACH_X
    const south = mk(
      -OUT_HX,
      -NAVE_HZ - T / 2,
      NAVE_HX,
      -NAVE_HZ - T / 2,
      0,
      -1,
      23,
      [
        [0, 1.45],
        [1.4, 1.2],
        [2.5, 0.75],
        [3.15, 0.1],
        [5.95, 0.1],
        [6.4, 0.6],
        [7.2, 1.35],
        [8.5, 2.2],
        [9.78, 2.6],
      ],
      3.0,
    );
    // West wall between the long walls, with the doorway
    const west = mk(
      -NAVE_HX - T / 2,
      -NAVE_HZ,
      -NAVE_HX - T / 2,
      NAVE_HZ,
      -1,
      0,
      37,
      [
        [0, 1.55],
        [1.0, 1.4],
        [1.88, 1.35],
        [3.12, 1.1],
        [3.9, 0.95],
        [5, 1.4],
      ],
      1.9,
    );
    const doorS = NAVE_HZ + DOOR_Z;
    west.openings.push(() => ({
      o0: doorS - DOOR_HZ,
      o1: doorS + DOOR_HZ,
      i0: doorS - DOOR_HZ,
      i1: doorS + DOOR_HZ,
    }));

    // East gable: complete to the apex, rake clipping, lancet surround
    const gable = mk(
      NAVE_HX + T / 2,
      -OUT_HZ,
      NAVE_HX + T / 2,
      OUT_HZ,
      1,
      0,
      53,
      [[0, 99]],
      APEX_H,
    );
    gable.top = () => apexY + 1;
    gable.rake = (y) =>
      y <= eavesY ? OUT_HZ : OUT_HZ * (1 - (y - eavesY) / (apexY - eavesY));
    const sc = gable.len / 2;
    const sillY0 = baseY + WIN.sill - 0.16;
    const sillY1 = baseY + WIN.sill;
    const springY = baseY + WIN.spring;
    gable.snaps.push(sillY0, sillY1, springY);
    const st = { jambExt: 0.98, sillDone: false };
    const rngG = mulberry32(0x9ab1e);
    gable.onCourse = (course, y0, y1) => {
      if (y0 >= sillY0 - 1e-3 && y1 <= sillY1 + 1e-3 && !st.sillDone) {
        st.sillDone = true;
        this.sill(w, gable, sc, sillY0, sillY1, rngG);
      }
      if (y0 >= sillY1 - 1e-3 && y1 <= springY + 1e-3) {
        st.jambExt = course % 2 === 0 ? 0.98 : 0.8;
        this.jambs(w, gable, sc, st.jambExt, y0, y1, rngG);
      }
    };
    gable.openings.push((y0, y1) => {
      if (y1 <= sillY0 + 1e-3) return null;
      if (y0 < sillY1 - 1e-3) {
        return { o0: sc - 0.7, o1: sc + 0.7, i0: sc - 0.7, i1: sc + 0.7 };
      }
      if (y0 < springY - 1e-3) {
        const e = st.jambExt;
        return { o0: sc - e, o1: sc + e, i0: sc - e, i1: sc + e };
      }
      // Arch zone: the course stones end at the ring's extrados evaluated at
      // their top, so they overlap into the (proud) ring – never into the
      // opening – and no dark wedges open next to the voussoirs.
      const hh = y1 - springY;
      const hwO = Math.max(0, archHW(hh, WIN.hwOut, 2 * WIN.hwOut + WIN.ring));
      const hwI = Math.max(0, archHW(hh, WIN.hwIn, 2 * WIN.hwIn + WIN.ring));
      if (hwO <= 0 && hwI <= 0) return null;
      return { o0: sc - hwO, o1: sc + hwO, i0: sc - hwI, i1: sc + hwI };
    });

    for (const def of [north, south, west, gable]) this.courses(w, def);
    this.arch(w, gable, sc, springY, rngG);
    this.tabling(w, gable, eavesY, apexY, rngG);
  }

  /** Lay the courses of one wall: stones, broken top, openings, burial. */
  private courses(w: MeshWriter, def: WallDef): void {
    const rng = mulberry32(0x570e + def.seed * 977);
    const baseY = this.baseY;
    const tier = this.tier;
    let y = baseY - 0.3;
    let course = 0;
    while (y < def.maxTop) {
      const rel = clamp((y - baseY) / 6, 0, 1);
      let ch =
        (0.32 - 0.14 * rel) *
        (1 - tier.courseVar / 2 + tier.courseVar * rng()) *
        tier.courseScale;
      let yt = y + ch;
      for (const sn of def.snaps) {
        if (y < sn - 1e-3 && yt > sn - 0.08) {
          yt = sn;
          break;
        }
      }
      ch = yt - y;
      if (ch < 0.06) {
        y = yt;
        continue;
      }
      let s0 = 0;
      let s1 = def.len;
      if (def.rake) {
        const hw = def.rake(y + ch * 0.4);
        if (hw < 0.12) break;
        s0 = def.len / 2 - hw;
        s1 = def.len / 2 + hw;
      }
      def.onCourse?.(course, y, yt);
      const holes: Hole[] = [];
      for (const op of def.openings) {
        const h = op(y, yt);
        if (h) holes.push(h);
      }
      const placed: Placed[] = [];
      let s = s0 - rng() * 0.4;
      while (s < s1 - 0.05) {
        let len = 0.24 + rng() * 0.34;
        if (rng() < 0.07) len += 0.3;
        const e = s + len;
        const st = Math.max(s, s0);
        const en = Math.min(e, s1);
        s = e;
        if (en - st < 0.1) continue;
        let pieces: Array<[number, number, number, number]> = [
          [st, en, st, en],
        ];
        for (const h of holes) {
          const next: Array<[number, number, number, number]> = [];
          const lo = Math.min(h.o0, h.i0);
          const hi = Math.max(h.o1, h.i1);
          for (const p of pieces) {
            if (p[1] <= lo || p[0] >= hi) {
              next.push(p);
              continue;
            }
            if (p[0] < lo - 0.08) next.push([p[0], h.o0, p[2], h.i0]);
            if (p[1] > hi + 0.08) next.push([h.o1, p[1], h.i1, p[3]]);
          }
          pieces = next;
        }
        for (const p of pieces) {
          const pl = this.courseStone(w, def, p, y, yt, rng, course);
          if (pl) placed.push(pl);
        }
      }
      this.courseHearting(w, def, placed, rng);
      y = yt;
      course++;
    }
  }

  private courseStone(
    w: MeshWriter,
    def: WallDef,
    p: [number, number, number, number],
    y0: number,
    y1: number,
    rng: () => number,
    course: number,
  ): Placed | null {
    const sc = (p[0] + p[1] + p[2] + p[3]) / 4;
    const top = def.top(sc);
    if (y0 + (y1 - y0) * 0.5 > top) return null;
    const lx = def.ax + def.dx * sc;
    const lz = def.az + def.dz * sc;
    const surf = this.surfaceL(lx, lz);
    if (y1 < surf - 0.1) return null;
    const isTop = y1 + 0.12 > top;
    // Rubble faces are never coplanar: every block sits a little proud or shy
    let t0 = -T / 2 + (rng() - 0.5) * 0.04;
    let t1 = T / 2 + (rng() - 0.5) * 0.04;
    let dy = 0;
    let roll = 0;
    if (isTop) {
      if (rng() < 0.1) return null; // fallen
      if (rng() < 0.35) {
        // never narrower than the hearting behind it (9 cm inside the faces)
        const shrink = rng() * 0.07;
        if (rng() < 0.5) t1 -= shrink;
        else t0 += shrink;
      }
      if (rng() < 0.3) {
        roll = (rng() - 0.5) * 0.1;
        dy = -rng() * 0.03;
      }
    }
    // Per-block value and hue: pale weathered slate to dark ironstone, warm
    // ochre to cool blue-grey
    let tone = 0.78 + rng() * 0.4;
    if (rng() < 0.12) tone *= 0.72;
    const hue = rng();
    const col: Rgb = [
      tone * (0.9 + 0.18 * hue),
      tone * (0.97 + 0.04 * hue),
      tone * (1.1 - 0.2 * hue),
    ];
    const tint = this.stoneTint(col, surf, rng());
    this.wallStone(
      w,
      def,
      p[0],
      p[1],
      p[2],
      p[3],
      t0,
      t1,
      y0 + dy,
      y1 + dy,
      roll,
      0.028,
      rng,
      col,
      tint,
      course > 0,
      0.08,
      0.45,
    );
    return { o0: p[0], o1: p[1], i0: p[2], i1: p[3], y0: y0 + dy, y1: y1 + dy };
  }

  /**
   * Vertex tint of a block: moss on the shade line (world +z faces – the sun
   * stays over the sea, on -z), fading out above the sand, damp darkening at
   * the sand line.
   */
  private stoneTint(col: Rgb, surf: number, mossR: number): TintFn {
    return (n, yc) => {
      const above = yc - surf;
      let m = smoothstep(0.1, 0.7, n[2]) * (0.55 + 0.45 * mossR);
      m += 0.12 * smoothstep(0.6, 1, n[1]);
      m *= 1 - smoothstep(0.4, 2.0, above);
      const damp = 1 - 0.2 * (1 - smoothstep(0, 0.35, above));
      const mm = Math.min(0.75, m * 0.8);
      const r = col[0] * damp;
      const g = col[1] * damp;
      const b = col[2] * damp;
      return [r * (1 - mm * 0.4), g * (1 - mm * 0.1), b * (1 - mm * 0.55)];
    };
  }

  /** (s, t, y) corners in the wall frame → nave-frame hexahedron. */
  private wallHexa(
    w: MeshWriter,
    def: WallDef,
    cs: ReadonlyArray<readonly [number, number, number]>,
    jitter: number,
    rng: () => number,
    col: Rgb,
    tint: TintFn | undefined,
    skipBottom: boolean,
    spall = 0,
    round = 0,
    count = true,
  ): void {
    const P: V3[] = [];
    for (const [s, t, y] of cs) {
      P.push([
        def.ax + def.dx * s + def.nx * t + (rng() - 0.5) * 2 * jitter,
        y + (rng() - 0.5) * 2 * jitter,
        def.az + def.dz * s + def.nz * t + (rng() - 0.5) * 2 * jitter,
      ]);
    }
    if (spall > 0) spallCorners(P, rng, spall);
    hexa(w, P, col, rng() * 3, rng() * 3, tint, skipBottom, round);
    if (count) this.info.stones++;
  }

  /** Block spanning the wall; outer-face s-range (o) may differ from the inner (i). */
  private wallStone(
    w: MeshWriter,
    def: WallDef,
    o0: number,
    o1: number,
    i0: number,
    i1: number,
    t0: number,
    t1: number,
    y0: number,
    y1: number,
    roll: number,
    jitter: number,
    rng: () => number,
    col: Rgb,
    tint: TintFn | undefined,
    skipBottom: boolean,
    spall = 0,
    round = 0,
    count = true,
  ): void {
    const tc = (t0 + t1) / 2;
    const yc = (y0 + y1) / 2;
    const cr = Math.cos(roll);
    const sr = Math.sin(roll);
    const R = (t: number, y: number): [number, number] => [
      tc + (t - tc) * cr - (y - yc) * sr,
      yc + (t - tc) * sr + (y - yc) * cr,
    ];
    const cs: Array<[number, number, number]> = [];
    for (const yy of [y0, y1]) {
      const a = R(t1, yy);
      const b = R(t0, yy);
      cs.push(
        [o0, a[0], a[1]],
        [o1, a[0], a[1]],
        [i1, b[0], b[1]],
        [i0, b[0], b[1]],
      );
    }
    this.wallHexa(
      w,
      def,
      cs,
      jitter,
      rng,
      col,
      tint,
      skipBottom,
      spall,
      round,
      count,
    );
  }

  /**
   * Dark rubble core behind every block of a course: 9 cm inside both faces,
   * from 6 cm below the block to 3.5 cm under its top, and overlapping 12 cm
   * into each neighbour that actually touches it (per face – never past a
   * jamb, the arch head, a breach edge or a wall end), so that no joint,
   * however the blocks are jittered or spalled, ever shows daylight.
   */
  private courseHearting(
    w: MeshWriter,
    def: WallDef,
    placed: Placed[],
    rng: () => number,
  ): void {
    placed.sort((a, b) => a.o0 - b.o0);
    const col: Rgb = [0.3, 0.29, 0.27];
    const EXT = 0.12;
    for (let i = 0; i < placed.length; i++) {
      const p = placed[i];
      const prev = i > 0 ? placed[i - 1] : null;
      const next = i + 1 < placed.length ? placed[i + 1] : null;
      const lO = prev && prev.o1 > p.o0 - 0.04 ? EXT : 0;
      const lI = prev && prev.i1 > p.i0 - 0.04 ? EXT : 0;
      const rO = next && next.o0 < p.o1 + 0.04 ? EXT : 0;
      const rI = next && next.i0 < p.i1 + 0.04 ? EXT : 0;
      this.wallStone(
        w,
        def,
        p.o0 - lO,
        p.o1 + rO,
        p.i0 - lI,
        p.i1 + rI,
        -T / 2 + 0.09,
        T / 2 - 0.09,
        p.y0 - 0.06,
        p.y1 - 0.035,
        0,
        0,
        rng,
        col,
        undefined,
        true,
        0,
        0,
        false,
      );
      this.info.hearting++;
    }
  }

  // -------------------------------------------------------------------------
  // The lancet and the gable
  // -------------------------------------------------------------------------

  private dressed(rng: () => number): Rgb {
    const t = 1.0 + rng() * 0.08;
    return [t * 0.99, t * 0.985, t * 0.96];
  }

  /** Weathered sill: a through-slab whose top slopes outward. */
  private sill(
    w: MeshWriter,
    def: WallDef,
    sc: number,
    y0: number,
    y1: number,
    rng: () => number,
  ): void {
    const tO = T / 2 + PROUD;
    const tI = -T / 2 - PROUD;
    this.wallHexa(
      w,
      def,
      [
        [sc - 0.7, tO, y0],
        [sc + 0.7, tO, y0],
        [sc + 0.7, tI, y0],
        [sc - 0.7, tI, y0],
        [sc - 0.7, tO, y1 - 0.07],
        [sc + 0.7, tO, y1 - 0.07],
        [sc + 0.7, tI, y1],
        [sc - 0.7, tI, y1],
      ],
      0.003,
      rng,
      this.dressed(rng),
      this.stoneTint(this.dressed(rng), this.baseY, rng()),
      false,
    );
  }

  /** Splayed jamb stones of one course (long-short work via `ext`). */
  private jambs(
    w: MeshWriter,
    def: WallDef,
    sc: number,
    ext: number,
    y0: number,
    y1: number,
    rng: () => number,
  ): void {
    const tO = T / 2 + PROUD;
    const tI = -T / 2 - PROUD;
    for (const side of [-1, 1]) {
      const col = this.dressed(rng);
      const tint = this.stoneTint(col, this.baseY, rng());
      const o0 = side < 0 ? sc - ext : sc + WIN.hwOut;
      const o1 = side < 0 ? sc - WIN.hwOut : sc + ext;
      const i0 = side < 0 ? sc - ext : sc + WIN.hwIn;
      const i1 = side < 0 ? sc - WIN.hwIn : sc + ext;
      this.wallStone(
        w,
        def,
        o0,
        o1,
        i0,
        i1,
        tI,
        tO,
        y0,
        y1,
        0,
        0.003,
        rng,
        col,
        tint,
        false,
      );
    }
  }

  /** Two-centred (equilateral) arch: five splayed voussoirs per half. */
  private arch(
    w: MeshWriter,
    def: WallDef,
    sc: number,
    springY: number,
    rng: () => number,
  ): void {
    const tO = T / 2 + PROUD;
    const tI = -T / 2 - PROUD;
    const aO = WIN.hwOut;
    const RO = 2 * aO;
    const aI = WIN.hwIn;
    const RI = 2 * aI;
    const N = 5;
    for (const side of [-1, 1]) {
      const arc = (a: number, R: number, f: number): [number, number] => [
        sc - side * (a - R * Math.cos(f)),
        springY + R * Math.sin(f),
      ];
      for (let i = 0; i < N; i++) {
        const f0 = (i / N) * (Math.PI / 3);
        const f1 = ((i + 1) / N) * (Math.PI / 3);
        const cs: Array<[number, number, number]> = [];
        for (const ring of [0, WIN.ring]) {
          const o0 = arc(aO, RO + ring, f0);
          const o1 = arc(aO, RO + ring, f1);
          const i0 = arc(aI, RI + ring, f0);
          const i1 = arc(aI, RI + ring, f1);
          cs.push(
            [o0[0], tO, o0[1]],
            [o1[0], tO, o1[1]],
            [i1[0], tI, i1[1]],
            [i0[0], tI, i0[1]],
          );
        }
        const col = this.dressed(rng);
        this.wallHexa(
          w,
          def,
          cs,
          0.003,
          rng,
          col,
          this.stoneTint(col, this.baseY, rng()),
          false,
        );
      }
    }
  }

  /** Skew tabling: coping slabs along both rakes, an apex block, a few fallen. */
  private tabling(
    w: MeshWriter,
    def: WallDef,
    eavesY: number,
    apexY: number,
    rng: () => number,
  ): void {
    const L = def.len;
    const rise = apexY - eavesY;
    const run = L / 2;
    const len = Math.hypot(run, rise);
    const tO = T / 2 + 0.08;
    const tI = -T / 2 - 0.08;
    const nSlab = Math.floor(len / 0.56);
    for (const side of [-1, 1]) {
      const s0 = side < 0 ? 0 : L;
      const us = (side < 0 ? run : -run) / len;
      const uy = rise / len;
      const vs = side < 0 ? -uy : uy;
      const vy = run / len;
      for (let k = 0; k < nSlab; k++) {
        if (k >= 1 && k < nSlab - 2 && rng() < 0.15) continue; // fallen slab
        // slabs overlap a touch so no seam through the coping shows sky
        const a0 = k * 0.56 - 0.005;
        const a1 = Math.min(len, (k + 1) * 0.56 + 0.012);
        const cs: Array<[number, number, number]> = [];
        for (const b of [0, 0.14]) {
          const p0s = s0 + us * a0 + vs * b;
          const p0y = eavesY + uy * a0 + vy * b;
          const p1s = s0 + us * a1 + vs * b;
          const p1y = eavesY + uy * a1 + vy * b;
          cs.push(
            [p0s, tO, p0y],
            [p1s, tO, p1y],
            [p1s, tI, p1y],
            [p0s, tI, p0y],
          );
        }
        const col = this.dressed(rng);
        this.wallHexa(
          w,
          def,
          cs,
          0.004,
          rng,
          col,
          this.stoneTint(col, this.baseY, rng()),
          false,
        );
      }
    }
    // Packing under the coping: a dark wedge just under each rake line fills
    // the stair-step voids between the clipped courses and the slabs, so the
    // rakes never show sky through them
    for (const side of [-1, 1]) {
      const s0 = side < 0 ? 0 : L;
      const us = (side < 0 ? run : -run) / len;
      const uy = rise / len;
      const vs = side < 0 ? -uy : uy;
      const vy = run / len;
      const tP = T / 2 - 0.05;
      const cs: Array<[number, number, number]> = [];
      for (const b of [-0.5, -0.006]) {
        const a0 = 0.03;
        const a1 = len + 0.02;
        const p0s = s0 + us * a0 + vs * b;
        const p0y = eavesY + uy * a0 + vy * b;
        const p1s = s0 + us * a1 + vs * b;
        const p1y = eavesY + uy * a1 + vy * b;
        cs.push(
          [p0s, tP, p0y],
          [p1s, tP, p1y],
          [p1s, -tP, p1y],
          [p0s, -tP, p0y],
        );
      }
      this.wallHexa(
        w,
        def,
        cs,
        0,
        rng,
        [0.3, 0.29, 0.27],
        undefined,
        true,
        0,
        0,
        false,
      );
      this.info.hearting++;
    }
    const col = this.dressed(rng);
    this.wallHexa(
      w,
      def,
      [
        [L / 2 - 0.22, tO, apexY - 0.03],
        [L / 2 + 0.22, tO, apexY - 0.03],
        [L / 2 + 0.22, tI, apexY - 0.03],
        [L / 2 - 0.22, tI, apexY - 0.03],
        [L / 2 - 0.16, tO, apexY + 0.2],
        [L / 2 + 0.16, tO, apexY + 0.2],
        [L / 2 + 0.16, tI, apexY + 0.2],
        [L / 2 - 0.16, tI, apexY + 0.2],
      ],
      0.004,
      rng,
      col,
      this.stoneTint(col, this.baseY, rng()),
      false,
    );
  }

  // -------------------------------------------------------------------------
  // Free-standing stones
  // -------------------------------------------------------------------------

  /** Oriented box (nave frame) with per-corner jitter. */
  private orientedBox(
    w: MeshWriter,
    cx: number,
    cy: number,
    cz: number,
    hl: number,
    hh: number,
    hd: number,
    yaw: number,
    pitch: number,
    roll: number,
    jitter: number,
    rng: () => number,
    col: Rgb,
    tint: TintFn | undefined,
    topW = 1,
    spall = 0,
    round = 0,
  ): void {
    const q = new THREE.Quaternion()
      .setFromAxisAngle(UP, yaw)
      .multiply(
        new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 0, 1),
          pitch,
        ),
      )
      .multiply(
        new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(1, 0, 0),
          roll,
        ),
      );
    const P: V3[] = [];
    const v = new THREE.Vector3();
    for (const sy of [-1, 1]) {
      const wf = sy < 0 ? 1 : topW;
      for (const [sx, sz] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        v.set(sx * hl * wf, sy * hh, sz * hd).applyQuaternion(q);
        P.push([
          cx + v.x + (rng() - 0.5) * 2 * jitter,
          cy + v.y + (rng() - 0.5) * 2 * jitter,
          cz + v.z + (rng() - 0.5) * 2 * jitter,
        ]);
      }
    }
    if (spall > 0) spallCorners(P, rng, spall);
    hexa(w, P, col, rng() * 3, rng() * 3, tint, false, round);
    this.info.stones++;
  }

  private looseStone(
    w: MeshWriter,
    lx: number,
    lz: number,
    rng: () => number,
  ): void {
    const hl = 0.12 + rng() * 0.2;
    const hh = 0.06 + rng() * 0.09;
    const hd = 0.09 + rng() * 0.13;
    const surf = this.surfaceL(lx, lz);
    const buried = hh * (0.5 + rng() * 0.9);
    let tone = 0.8 + rng() * 0.38;
    if (rng() < 0.12) tone *= 0.72;
    const hue = rng();
    const col: Rgb = [
      tone * (0.9 + 0.18 * hue),
      tone * (0.97 + 0.04 * hue),
      tone * (1.1 - 0.2 * hue),
    ];
    this.orientedBox(
      w,
      lx,
      surf + hh - buried,
      lz,
      hl,
      hh,
      hd,
      rng() * TAU,
      (rng() - 0.5) * 0.5,
      (rng() - 0.5) * 0.5,
      0.045,
      rng,
      col,
      this.stoneTint(col, surf, rng()),
      1,
      0.16,
      0.5,
    );
  }

  /** Tumbled blocks: the collapsed breach, the door, the wall feet, the nave. */
  private buildLooseStones(w: MeshWriter): void {
    const rng = mulberry32(0x10053);
    const spots: Array<[number, number, number, number, number]> = [
      // [cx, cz, rx, rz, share]
      [BREACH_X, -OUT_HZ - 1.3, 2.3, 1.3, 0.3],
      [BREACH_X + 0.2, -NAVE_HZ + 0.9, 1.5, 0.7, 0.09],
      [-OUT_HX - 1.2, 0.2, 1.0, 1.6, 0.11],
      [0.5, -OUT_HZ - 0.6, 4.5, 0.4, 0.13],
      [0.5, OUT_HZ + 0.6, 4.5, 0.4, 0.1],
      [OUT_HX + 0.9, 0, 0.5, 3.2, 0.09],
      [1.5, 0, 2.5, 1.4, 0.06],
      [-1, -7, 6, 3, 0.12],
    ];
    const total = this.tier.loose;
    for (const [cx, cz, rx, rz, share] of spots) {
      const n = Math.max(1, Math.round(total * share));
      for (let k = 0; k < n; k++) {
        const lx = cx + (rng() + rng() - 1) * rx;
        const lz = cz + (rng() + rng() - 1) * rz;
        this.looseStone(w, lx, lz, rng);
      }
    }
  }

  /** The fallen lintel across the west threshold. */
  private buildLintel(w: MeshWriter): void {
    const rng = mulberry32(0x11a7e);
    const ax = -NAVE_HX - 0.2;
    const az = 0.32;
    const bx = -OUT_HX - 1.55;
    const bz = -0.5;
    const ya = this.surfaceL(ax, az) + 0.1;
    const yb = this.surfaceL(bx, bz) - 0.05;
    const dx = bx - ax;
    const dz = bz - az;
    const horiz = Math.hypot(dx, dz);
    const len = Math.hypot(horiz, yb - ya);
    const col: Rgb = [1.0, 0.99, 0.97];
    this.orientedBox(
      w,
      (ax + bx) / 2,
      (ya + yb) / 2,
      (az + bz) / 2,
      len / 2,
      0.12,
      0.15,
      Math.atan2(-dz, dx),
      Math.atan2(yb - ya, horiz),
      0.12,
      0.006,
      rng,
      col,
      this.stoneTint(col, (ya + yb) / 2 - 0.2, rng()),
    );
  }

  /** Two blank slabs leaning in the sand south of the nave. */
  private buildGraves(w: MeshWriter): void {
    const rng = mulberry32(0x6a4e);
    for (const g of GRAVES) {
      const surf = this.surfaceL(g.x, g.z);
      const H = 1.5;
      const q = new THREE.Quaternion()
        .setFromAxisAngle(UP, g.yaw)
        .multiply(
          new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(1, 0, 0),
            g.lean,
          ),
        );
      const P: V3[] = [];
      const v = new THREE.Vector3();
      for (const yy of [0, H]) {
        const hw = yy === 0 ? 0.43 : 0.35;
        for (const [sx, sz] of [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ]) {
          v.set(sx * hw, yy, sz * 0.06).applyQuaternion(q);
          P.push([g.x + v.x, surf - 0.35 + v.y, g.z + v.z]);
        }
      }
      const col: Rgb = [1.0, 0.995, 0.97];
      hexa(w, P, col, rng() * 3, rng() * 3, this.stoneTint(col, surf, rng()));
      this.info.stones++;
    }
  }

  // -------------------------------------------------------------------------
  // Elder
  // -------------------------------------------------------------------------

  /** Smooth tapering tube along `pts` (nave frame): u around, v along. */
  private tube(
    w: MeshWriter,
    pts: THREE.Vector3[],
    r0: number,
    r1: number,
    radial: number,
  ): void {
    const n = pts.length;
    const rings: V3[][] = [];
    const norms: V3[][] = [];
    const vs: number[] = [];
    const ref = new THREE.Vector3(1, 0, 0);
    const t = new THREE.Vector3();
    const b = new THREE.Vector3();
    const nn = new THREE.Vector3();
    let vAcc = 0;
    for (let i = 0; i < n; i++) {
      t.subVectors(
        pts[Math.min(i + 1, n - 1)],
        pts[Math.max(i - 1, 0)],
      ).normalize();
      ref.addScaledVector(t, -ref.dot(t));
      if (ref.lengthSq() < 1e-6) ref.set(0, 0, 1).addScaledVector(t, -t.z);
      ref.normalize();
      b.crossVectors(t, ref);
      const r = r0 + (r1 - r0) * (i / (n - 1));
      const ring: V3[] = [];
      const nr: V3[] = [];
      for (let j = 0; j <= radial; j++) {
        const th = (j / radial) * TAU;
        nn.copy(ref)
          .multiplyScalar(Math.cos(th))
          .addScaledVector(b, Math.sin(th));
        ring.push([
          pts[i].x + nn.x * r,
          pts[i].y + nn.y * r,
          pts[i].z + nn.z * r,
        ]);
        nr.push([nn.x, nn.y, nn.z]);
      }
      if (i > 0) vAcc += pts[i].distanceTo(pts[i - 1]);
      rings.push(ring);
      norms.push(nr);
      vs.push(vAcc / 0.45);
    }
    const c: Rgb = [1, 1, 1];
    for (let i = 0; i + 1 < n; i++) {
      for (let j = 0; j < radial; j++) {
        const u0 = j / radial;
        const u1 = (j + 1) / radial;
        w.push(rings[i][j], norms[i][j], u0, vs[i], c);
        w.push(rings[i + 1][j], norms[i + 1][j], u0, vs[i + 1], c);
        w.push(rings[i + 1][j + 1], norms[i + 1][j + 1], u1, vs[i + 1], c);
        w.push(rings[i][j], norms[i][j], u0, vs[i], c);
        w.push(rings[i + 1][j + 1], norms[i + 1][j + 1], u1, vs[i + 1], c);
        w.push(rings[i][j + 1], norms[i][j + 1], u1, vs[i], c);
      }
    }
  }

  /** Multi-stemmed elder rooted in the doorway, arching out over the tongue. */
  private buildElder(w: MeshWriter): void {
    const rng = mulberry32(0xe1de4);
    const rx = -OUT_HX - 0.2;
    const rz = 0.3;
    const ry = this.surfaceL(rx, rz) - 0.12;
    const radial = this.quality === "low" ? 6 : 8;
    const crown = new THREE.Vector3(rx - 0.55, ry + 1.85, rz - 0.05);
    for (let i = 0; i < 4; i++) {
      const a = Math.PI + (i - 1.5) * 0.55 + (rng() - 0.5) * 0.3;
      const dx = Math.cos(a);
      const dz = -Math.sin(a);
      const ox = (rng() - 0.5) * 0.16;
      const oz = (rng() - 0.5) * 0.16;
      const hTop = 2.1 + rng() * 0.45;
      const pts = [
        new THREE.Vector3(rx + ox, ry, rz + oz),
        new THREE.Vector3(rx + ox + dx * 0.22, ry + 0.75, rz + oz + dz * 0.22),
        new THREE.Vector3(rx + ox + dx * 0.7, ry + 1.5, rz + oz + dz * 0.7),
        new THREE.Vector3(rx + ox + dx * 1.15, ry + hTop, rz + oz + dz * 1.15),
      ];
      const curve = new THREE.CatmullRomCurve3(pts);
      this.tube(w, curve.getPoints(8), 0.052, 0.014, radial);
      // A side branch from the second bend
      const ba = a + (rng() < 0.5 ? 1 : -1) * (0.9 + rng() * 0.4);
      const bdx = Math.cos(ba);
      const bdz = -Math.sin(ba);
      const from = pts[2];
      const br = [
        from.clone(),
        new THREE.Vector3(
          from.x + bdx * 0.35,
          from.y + 0.28,
          from.z + bdz * 0.35,
        ),
        new THREE.Vector3(
          from.x + bdx * 0.72,
          from.y + 0.5,
          from.z + bdz * 0.72,
        ),
      ];
      this.tube(
        w,
        new THREE.CatmullRomCurve3(br).getPoints(5),
        0.02,
        0.008,
        Math.max(5, radial - 2),
      );
    }
    // Foliage cards in an ellipsoid crown
    const n = this.tier.elderCards;
    for (let k = 0; k < n; k++) {
      const th = rng() * TAU;
      const ph = Math.acos(1 - 2 * rng());
      const rad = 0.5 + 0.5 * Math.sqrt(rng());
      const px = crown.x + Math.cos(th) * Math.sin(ph) * 1.15 * rad;
      const py = crown.y + Math.cos(ph) * 0.75 * rad;
      const pz = crown.z + Math.sin(th) * Math.sin(ph) * 1.05 * rad;
      const s = 0.55 + rng() * 0.25;
      const nrm = new THREE.Vector3(
        px - crown.x,
        py - crown.y + 0.4,
        pz - crown.z,
      );
      if (nrm.lengthSq() < 1e-4) nrm.set(0, 1, 0);
      const [wx, wz] = toWorld(px, pz);
      const nw = new THREE.Vector3(
        nrm.x * SITE_C + nrm.z * SITE_S,
        nrm.y,
        -nrm.x * SITE_S + nrm.z * SITE_C,
      ).normalize();
      this.units.push({
        x: wx,
        y: py - s * 0.5,
        z: wz,
        yaw: rng() * TAU,
        tiltX: (rng() - 0.5) * 1.0,
        tiltZ: (rng() - 0.5) * 0.4,
        s,
        tile: FOLIAGE_TILE.elder,
        phase: rng(),
        soft: 0.8,
        nrm: nw,
      });
      this.info.elderCards++;
    }
  }

  // -------------------------------------------------------------------------
  // Nettles and gorse
  // -------------------------------------------------------------------------

  private nettleClump(
    lx: number,
    lz: number,
    h: number,
    rng: () => number,
  ): void {
    const y = this.surfaceL(lx, lz) - 0.06;
    const [wx, wz] = toWorld(lx, lz);
    const yaw = rng() * TAU;
    const phase = rng();
    for (const dy of [0, Math.PI / 4]) {
      this.units.push({
        x: wx,
        y,
        z: wz,
        yaw: yaw + dy,
        tiltX: (rng() - 0.5) * 0.2,
        tiltZ: (rng() - 0.5) * 0.2,
        s: h,
        tile: FOLIAGE_TILE.nettle,
        phase: phase + dy * 0.1,
        soft: 0.55,
        nrm: new THREE.Vector3(
          (rng() - 0.5) * 0.4,
          1,
          (rng() - 0.5) * 0.4,
        ).normalize(),
      });
    }
    this.info.nettles++;
  }

  /** Nettles fill the nave in patches (they mark the old settlement soil). */
  private buildNettles(): void {
    const rng = mulberry32(0x4e771e);
    const total = this.tier.nettles;
    let placed = 0;
    // Patches inside the nave, denser along the damp walls
    const patches = 12;
    for (let p = 0; p < patches && placed < total; p++) {
      const cx = -NAVE_HX + 0.7 + rng() * (2 * NAVE_HX - 1.6);
      const cz = -NAVE_HZ + 0.5 + rng() * (2 * NAVE_HZ - 1.0);
      const n = 2 + Math.floor(rng() * 4);
      for (let k = 0; k < n && placed < total; k++) {
        const lx = clamp(
          cx + (rng() - 0.5) * 1.6,
          -NAVE_HX + 0.4,
          NAVE_HX - 0.5,
        );
        const lz = clamp(
          cz + (rng() - 0.5) * 1.4,
          -NAVE_HZ + 0.35,
          NAVE_HZ - 0.35,
        );
        const nearWall =
          Math.min(NAVE_HX - Math.abs(lx), NAVE_HZ - Math.abs(lz)) < 1.0;
        const h = 0.5 + rng() * 0.42 + (nearWall ? 0.12 : 0);
        this.nettleClump(lx, lz, h, rng);
        placed++;
      }
    }
    // A few outside the door and along the shaded north foot
    const outside: Array<[number, number]> = [
      [-OUT_HX - 0.9, -1.1],
      [-OUT_HX - 1.6, 1.3],
      [-OUT_HX - 0.5, 1.6],
      [-2.2, OUT_HZ + 0.55],
      [0.4, OUT_HZ + 0.7],
      [2.9, OUT_HZ + 0.5],
    ];
    for (const [lx, lz] of outside) {
      if (placed >= total + 4) break;
      this.nettleClump(
        lx + (rng() - 0.5) * 0.4,
        lz + (rng() - 0.5) * 0.3,
        0.55 + rng() * 0.3,
        rng,
      );
      placed++;
    }
  }

  /**
   * Deterministic gorse placement: a belt around r ≈ 27 m on the flanks, two
   * shrubs deep, clumped by a region noise, thinning onto the plateau and the
   * foot, clear of the three paths and the ruin's forecourt. Satellites make
   * touching clumps. The full list is built; tiers take a prefix.
   */
  private placeGorse(): void {
    const rng = mulberry32(0xc0a5e);
    const cx = CHANTRY_KNOLL.x;
    const cz = CHANTRY_KNOLL.z;
    const out = this.gorse;
    const MAX = 200;
    const accept = (x: number, z: number, h: number): boolean => {
      if (pathDistance(x, z) < 1.35) return false;
      const [lx, lz] = toLocal(x, z);
      if (Math.abs(lx) < OUT_HX + 2.6 && Math.abs(lz) < OUT_HZ + 2.6)
        return false;
      const R = 0.66 * h;
      for (const q of out) {
        const d = Math.hypot(q.x - x, q.z - z);
        if (d < 0.42 * (R + 0.66 * q.h)) return false;
      }
      return true;
    };
    let guard = 0;
    while (out.length < MAX && guard++ < 30000) {
      const th = rng() * TAU;
      const r = 12.5 + 34 * rng() ** 0.9;
      let p = 0.2 + 0.8 * Math.exp(-(((r - 27) / 10.5) ** 2));
      p *= 0.15 + 0.85 * smoothstep(13, 17, r);
      p *= 1 - 0.6 * smoothstep(40, 46.5, r);
      const x = cx + Math.cos(th) * r;
      const z = cz + Math.sin(th) * r;
      p *=
        0.3 +
        0.7 * smoothstep(0.35, 0.6, fbm(x * 0.09 + 7.7, z * 0.09 + 3.1, 2));
      if (rng() > p) continue;
      let h = 0.6 + rng() ** 1.2 * 1.0;
      h *= 0.72 + 0.28 * smoothstep(14, 22, r);
      h *= 1 - 0.2 * smoothstep(38, 46, r);
      if (!accept(x, z, h)) continue;
      out.push({ x, z, y: terrainHeight(x, z), h, phase: rng() });
      if (rng() < 0.55) {
        const n = 1 + Math.floor(rng() * 3);
        for (let k = 0; k < n && out.length < MAX; k++) {
          const a = rng() * TAU;
          const d = 0.9 + rng() * 1.1;
          const sx = x + Math.cos(a) * d;
          const sz = z + Math.sin(a) * d;
          const sh = clamp(h * (0.7 + 0.4 * rng()), 0.55, 1.6);
          if (!accept(sx, sz, sh)) continue;
          out.push({
            x: sx,
            z: sz,
            y: terrainHeight(sx, sz),
            h: sh,
            phase: rng(),
          });
        }
      }
    }
    out.length = Math.min(out.length, this.tier.gorse);
    this.info.gorse = out.length;
  }

  /** Card units of every shrub: a darker core, a ring of flowering cards. */
  private buildGorseUnits(): void {
    const rng = mulberry32(0x60a5e);
    const tier = this.tier;
    for (const sh of this.gorse) {
      const span = tier.unitsMax - tier.unitsMin;
      let n = tier.unitsMin + Math.floor(rng() * (span + 1));
      n = Math.max(3, Math.round(n * (0.8 + 0.4 * (sh.h - 0.6))));
      const s0 = 1.61 * sh.h; // the tile's dome is 0.62 of the card height
      const lean = 0.05 + rng() * 0.1; // wind-pruned, downwind (+x)
      const put = (
        px: number,
        pz: number,
        s: number,
        tile: number,
        tilt: number,
        yaw: number,
      ): void => {
        // Sit the card on the slope (three-quarters of the way to the
        // terrain normal): the knoll's flanks are steep, and a flat card's
        // downhill edge would float
        const gx = terrainHeight(px + 0.5, pz) - terrainHeight(px - 0.5, pz);
        const gz = terrainHeight(px, pz + 0.5) - terrainHeight(px, pz - 0.5);
        const tn = new THREE.Vector3(-gx, 1, -gz).normalize();
        const slope = new THREE.Quaternion().setFromUnitVectors(
          UP,
          UP.clone().lerp(tn, 0.75).normalize(),
        );
        const nrm = new THREE.Vector3(px - sh.x, 0.55 * sh.h, pz - sh.z);
        if (nrm.lengthSq() < 1e-4) nrm.set(0, 1, 0);
        nrm.normalize();
        this.units.push({
          x: px,
          y: terrainHeight(px, pz) - 0.16 * sh.h - 0.06,
          z: pz,
          yaw,
          tiltX: tilt * Math.sin(yaw) + (rng() - 0.5) * 0.1,
          tiltZ: lean + tilt * Math.cos(yaw) * 0.5,
          slope,
          s,
          tile,
          phase: sh.phase + rng() * 0.2,
          soft: 0.12,
          nrm,
        });
      };
      put(
        sh.x,
        sh.z,
        s0,
        n > 3 ? FOLIAGE_TILE.gorseInner : FOLIAGE_TILE.gorse,
        0,
        rng() * TAU,
      );
      const ring = n - 1;
      const a0 = rng() * TAU;
      for (let k = 0; k < ring; k++) {
        const a = a0 + (k / ring) * TAU + (rng() - 0.5) * 0.5;
        const d = 0.42 * sh.h * (0.7 + 0.6 * rng());
        put(
          sh.x + Math.cos(a) * d,
          sh.z + Math.sin(a) * d,
          s0 * (0.88 + 0.17 * rng()),
          FOLIAGE_TILE.gorse,
          0.15,
          a + Math.PI / 2 + (rng() - 0.5) * 0.8,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Materials and meshes
  // -------------------------------------------------------------------------

  private stoneMaterial(): THREE.Material {
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true });
    applyPbr(mat, pbrChantryStone(this.tier.tex));
    const u = this.u;
    mat.customProgramCacheKey = () => "chantry-stone";
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uCkWet = u.uCkWet;
      shader.fragmentShader = `uniform float uCkWet;\n${shader.fragmentShader}`
        .replace(
          "#include <color_fragment>",
          "#include <color_fragment>\ndiffuseColor.rgb *= mix(1.0, 0.6, uCkWet * 0.85);",
        )
        .replace(
          "#include <roughnessmap_fragment>",
          "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.5, uCkWet * 0.75);",
        );
    };
    this.materials.push(mat);
    return mat;
  }

  /** Terrain sand set at world tiling, wet/cloud response like world.ts. */
  private sandMaterial(): THREE.Material {
    const mat = new THREE.MeshStandardMaterial();
    applyPbr(mat, pbrSand());
    const u = this.u;
    mat.customProgramCacheKey = () => "chantry-drift";
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uWet = u.uWet;
      shader.uniforms.uCloud = u.uCloud;
      shader.vertexShader =
        `varying vec3 vWorldPos;\n${shader.vertexShader}`.replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\n vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;",
        );
      shader.fragmentShader = `varying vec3 vWorldPos;
        uniform float uWet;
        uniform float uCloud;
        float ckdHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float ckdNoise(vec2 p) {
          vec2 i = floor(p); vec2 f = p - i;
          f = f * f * (3.0 - 2.0 * f);
          float a = ckdHash(i), b = ckdHash(i + vec2(1.0, 0.0));
          float c = ckdHash(i + vec2(0.0, 1.0)), d = ckdHash(i + vec2(1.0, 1.0));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }
        ${shader.fragmentShader}`.replace(
        "#include <map_fragment>",
        `#include <map_fragment>
         float pud = ckdNoise(vWorldPos.xz * 0.085) * 0.65
                   + ckdNoise(vWorldPos.xz * 0.31) * 0.35;
         float rainWet = uWet * (0.5 + 0.5 * smoothstep(0.32, 0.68, pud)) * 0.85;
         diffuseColor.rgb *= mix(1.0, 0.6, rainWet);
         float cGrey = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
         diffuseColor.rgb = mix(
           diffuseColor.rgb,
           vec3(cGrey) * vec3(0.97, 0.99, 1.05),
           uCloud * 0.42);`,
      );
    };
    this.materials.push(mat);
    return mat;
  }

  private barkMaterial(): THREE.Material {
    const mat = new THREE.MeshStandardMaterial();
    applyPbr(mat, this.quality === "low" ? pbrWood("branch") : pbrElderBark());
    const u = this.u;
    mat.customProgramCacheKey = () => "chantry-bark";
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uCkWet = u.uCkWet;
      shader.fragmentShader =
        `uniform float uCkWet;\n${shader.fragmentShader}`.replace(
          "#include <color_fragment>",
          "#include <color_fragment>\ndiffuseColor.rgb *= mix(1.0, 0.62, uCkWet * 0.8);",
        );
    };
    this.materials.push(mat);
    return mat;
  }

  /** One instanced mesh for gorse, nettles and elder cards. */
  private buildFoliageMesh(): void {
    const tex = chantryFoliageAtlas(this.tier.tex);
    this.textures.push(tex);
    const u = this.u;
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      alphaTest: 0.4,
      side: THREE.DoubleSide,
      roughness: 0.85,
      metalness: 0,
    });
    mat.customProgramCacheKey = () => "chantry-foliage";
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, {
        uCkTime: u.uCkTime,
        uCkWind: u.uCkWind,
        uCkDir: u.uCkDir,
        uCkWet: u.uCkWet,
      });
      shader.vertexShader =
        `${FOL_VERT_PARS}varying float vCkDist;\n${shader.vertexShader}`
          .replace("#include <uv_vertex>", `#include <uv_vertex>\n${FOL_UV}`)
          .replace(
            "#include <beginnormal_vertex>",
            "#include <beginnormal_vertex>\nobjectNormal = normalize(mix(aCNrm, vec3(0.0, 1.0, 0.0), 0.5));",
          )
          .replace(
            "#include <begin_vertex>",
            `#include <begin_vertex>\n${FOL_VERT_BODY}vCkDist = distance(cameraPosition, ckBase);\n`,
          );
      shader.fragmentShader = `${FOL_FRAG_PARS}${shader.fragmentShader}`
        .replace(
          "#include <alphatest_fragment>",
          "diffuseColor.a *= 1.0 + 0.8 * smoothstep(25.0, 120.0, vCkDist);\n#include <alphatest_fragment>",
        )
        .replace(
          "#include <color_fragment>",
          "#include <color_fragment>\ndiffuseColor.rgb *= mix(1.0, 0.66, uCkWet * 0.7);",
        )
        .replace(
          "#include <roughnessmap_fragment>",
          "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.6, uCkWet * 0.6);",
        );
    };
    this.materials.push(mat);

    const geo = buildCardGeometry();
    this.geometries.push(geo);
    const units = this.units;
    const n = units.length;
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, n));
    const aCard = new Float32Array(Math.max(1, n) * 4);
    const aCNrm = new Float32Array(Math.max(1, n) * 3);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const qi = new THREE.Quaternion();
    const e = new THREE.Euler();
    const p = new THREE.Vector3();
    const sc = new THREE.Vector3();
    const ln = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const c = units[i];
      e.set(c.tiltX, c.yaw, c.tiltZ);
      q.setFromEuler(e);
      if (c.slope) q.premultiply(c.slope);
      p.set(c.x, c.y, c.z);
      sc.set(c.s, c.s, c.s);
      m.compose(p, q, sc);
      mesh.setMatrixAt(i, m);
      aCard[i * 4] = c.phase;
      aCard[i * 4 + 1] = c.soft;
      aCard[i * 4 + 2] = c.tile;
      aCard[i * 4 + 3] = 1 / c.s;
      qi.copy(q).invert();
      ln.copy(c.nrm).applyQuaternion(qi);
      aCNrm[i * 3] = ln.x;
      aCNrm[i * 3 + 1] = ln.y;
      aCNrm[i * 3 + 2] = ln.z;
    }
    geo.setAttribute("aCard", new THREE.InstancedBufferAttribute(aCard, 4));
    geo.setAttribute("aCNrm", new THREE.InstancedBufferAttribute(aCNrm, 3));
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = this.tier.foliageShadow;
    mesh.receiveShadow = true;
    if (this.tier.foliageShadow) {
      const depth = new THREE.MeshDepthMaterial({
        depthPacking: THREE.RGBADepthPacking,
        map: tex,
        alphaTest: 0.4,
        side: THREE.DoubleSide,
      });
      depth.customProgramCacheKey = () => "chantry-foliage-depth";
      depth.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, {
          uCkTime: u.uCkTime,
          uCkWind: u.uCkWind,
          uCkDir: u.uCkDir,
        });
        shader.vertexShader = `${FOL_VERT_PARS}${shader.vertexShader}`
          .replace("#include <uv_vertex>", `#include <uv_vertex>\n${FOL_UV}`)
          .replace(
            "#include <begin_vertex>",
            `#include <begin_vertex>\n${FOL_VERT_BODY}`,
          );
      };
      mesh.customDepthMaterial = depth;
    }
    mesh.computeBoundingSphere();
    mesh.name = "chantry-foliage";
    this.group.add(mesh);
    this.info.units = n;
  }

  // -------------------------------------------------------------------------
  // Colliders (nave frame; gorse converted)
  // -------------------------------------------------------------------------

  private buildColliders(): void {
    beginColliderSet("chantry", { x: SITE_X, y: 0, z: SITE_Z, yaw: SITE_YAW });
    const b = this.baseY;
    const y0 = b - 1;
    let n = 0;
    const box = (
      cx: number,
      cz: number,
      hx: number,
      hz: number,
      yaw: number,
      top: number,
    ): void => {
      addBoxCollider(cx, cz, hx, hz, yaw, y0, top);
      n++;
    };
    // North wall, gable, south wall either side of the breach, west stubs
    box(
      (NAVE_HX - OUT_HX) / 2,
      NAVE_HZ + T / 2,
      (NAVE_HX + OUT_HX) / 2 + 0.05,
      T / 2 + 0.06,
      0,
      b + 3.2,
    );
    box(NAVE_HX + T / 2, 0, T / 2 + 0.06, OUT_HZ + 0.05, 0, b + 6.6);
    const bw = -2.2;
    box(
      (-OUT_HX + bw) / 2,
      -NAVE_HZ - T / 2,
      (bw + OUT_HX) / 2,
      T / 2 + 0.06,
      0,
      b + 2.2,
    );
    const be = 0.5;
    box(
      (be + NAVE_HX) / 2,
      -NAVE_HZ - T / 2,
      (NAVE_HX - be) / 2,
      T / 2 + 0.06,
      0,
      b + 3.0,
    );
    const wx = -NAVE_HX - T / 2;
    const dn = DOOR_Z - DOOR_HZ;
    const ds = DOOR_Z + DOOR_HZ;
    box(wx, (-NAVE_HZ + dn) / 2, T / 2 + 0.06, (dn + NAVE_HZ) / 2, 0, b + 2.0);
    box(wx, (ds + NAVE_HZ) / 2, T / 2 + 0.06, (NAVE_HZ - ds) / 2, 0, b + 2.0);
    // Fallen lintel, elder, grave slabs
    const lax = -NAVE_HX - 0.2;
    const lbx = -OUT_HX - 1.55;
    const laz = 0.32;
    const lbz = -0.5;
    const lg = this.surfaceL((lax + lbx) / 2, (laz + lbz) / 2);
    addBoxCollider(
      (lax + lbx) / 2,
      (laz + lbz) / 2,
      Math.hypot(lbx - lax, lbz - laz) / 2 + 0.05,
      0.2,
      Math.atan2(-(lbz - laz), lbx - lax),
      lg - 0.5,
      lg + 0.4,
    );
    n++;
    const eg = this.surfaceL(-OUT_HX - 0.2, 0.3);
    addCylinderCollider(-OUT_HX - 0.2, 0.3, 0.42, eg - 0.6, eg + 2.2);
    n++;
    for (const g of GRAVES) {
      const gs = this.surfaceL(g.x, g.z);
      addBoxCollider(g.x, g.z, 0.5, 0.32, g.yaw, gs - 0.5, gs + 1.2);
      n++;
    }
    // Spiny gorse: the biggest shrubs block (the paths stay clear by placement)
    const big = this.gorse
      .filter((s) => s.h >= 0.95)
      .sort((p, q) => q.h - p.h)
      .slice(0, 60);
    for (const s of big) {
      const [lx, lz] = toLocal(s.x, s.z);
      addCylinderCollider(
        lx,
        lz,
        clamp(0.42 * s.h, 0.4, 0.6),
        s.y - 0.5,
        s.y + s.h,
      );
      n++;
    }
    this.info.colliders = n;
  }
}
