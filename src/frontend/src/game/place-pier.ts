// The Old Pier – a double row of barnacled, rot-blackened timber piles
// marching ~50 m out into the surf at x = -150. The landward 35 m of planked
// deck still stand and are WALKABLE (ground.ts registerGround "pier"): the
// railings are gone, planks are missing where they dropped through to the
// water, a few are sprung. Beyond the ragged deck end lone leaning piles
// continue seaward as a dotted line, the outermost wearing a rusted lamp
// bracket. The only place in the game you can stand over the sea and look
// back at the land.
//
// Construction (all procedural, merged into 5 draw calls):
//   1. piles     eroded cylinders, v = WORLD HEIGHT on a texture that carries
//                the barnacle/algae/weed band and the wet darkening, so the
//                band sits at the same height on every pile, leaning or not
//   2. deck      caps, stringers, individual planks (irregular gaps, 10–15 %
//                missing, hanging, sprung), rail stubs, bracing, abutment
//                timbers, bollards – one weathered-oak texture in plank slots
//   3. iron      mooring ring, lamp bracket + cage, straps, bolts, bands
//   4. decals    hanging wrack fronds at the wave line, a rust streak
//   5. fill      the timber-faced sand ramp of the abutment (terrain sand set)
//
// Ground: plank tops (deck line with a 0.15 m sag toward the middle), null in
// every missing-plank gap and off the deck; the abutment ramp interpolates
// from the terrain up to the deck. Colliders (tag "pier"): every pile, the
// proud pile tops, rail stubs, the two jeep-stopping bollards at the ramp
// foot, the ramp cheek walls and face, and an invisible box over every plank
// gap (over the shallows the sea floor would not stop a body by itself).

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  addBoxCollider,
  addCylinderCollider,
  beginColliderSet,
  clearColliderSet,
} from "./colliders";
import { registerGround, unregisterGround } from "./ground";
import { OLD_PIER } from "./landforms";
import { clamp, fbm, lerp, smoothstep } from "./noise";
import {
  DECAL_UV,
  DECK_NAIL_U,
  DECK_SLOTS,
  DECK_SLOT_M,
  DECK_U_LEN,
  PILE_GRAIN_UV,
  type UvRegion,
  decalPbr,
  deckPbr,
  ironPbr,
  pilePbr,
  pileV,
} from "./place-pier-textures";
import type { Environment } from "./sky";
import { SHORE_GLSL, terrainHeight } from "./terrain";
import { TexRng, applyPbr, sandAlbedo, sandNormal } from "./textures";
import type { QualityId } from "./types";

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const X = OLD_PIER.x;
/** First pile pair / start of the deck. */
const Z_LAND = OLD_PIER.zLand;
/** Ragged end of the deck. */
const Z_DECK = OLD_PIER.zDeck;
/** Outermost pile (lamp bracket). */
const Z_END = OLD_PIER.zEnd;
/** Foot of the abutment ramp (landward). */
const Z_FOOT = Z_LAND + 9;
/** The ramp is level from here to the first planks. */
const Z_RAMP_TOP = Z_LAND + 0.4;
/** Seaward face of the abutment fill. */
const Z_FACE = Z_LAND + 0.3;
/** Plank tops at the abutment. */
const DECK_Y = 3.15;
/** Deck half width (planks are 2.4 m). */
const HALF_W = 1.2;
/** Pile rows. */
const PILE_X = 1.32;
/** Spacing of the pile pairs: 8 spans under the deck. */
const SPAN = (Z_LAND - Z_DECK) / 8;
const PLANK_T = 0.05;
const STR_H = 0.25;
const STR_W = 0.15;
/** Stringer centre lines – derived from the nail rows of the deck texture. */
const STR_X: readonly number[] = DECK_NAIL_U.map((u) => (u - 0.5) * DECK_U_LEN);
const CAP_H = 0.28;
const CAP_W = 0.26;
const CAP_LEN = 3.3;
/** Ramp cheek walls. */
const WALL_X = 1.3;

/** z of pile pair k (k = 0 at the abutment). */
function capZ(k: number): number {
  return Z_LAND - k * SPAN;
}

/** Plank tops along the deck: a gentle sag toward the middle, a drooping end. */
function deckLine(z: number): number {
  const t = clamp((Z_LAND - z) / (Z_LAND - Z_DECK), 0, 1);
  return DECK_Y - 0.15 * Math.sin(Math.PI * t) - 0.08 * t * t;
}

function capTop(z: number): number {
  return deckLine(z) - PLANK_T - STR_H;
}

function pileTop(z: number): number {
  return capTop(z) - CAP_H;
}

/** Sand surface of the abutment ramp (walkable). */
function rampY(x: number, z: number): number {
  const t = clamp((Z_FOOT - z) / (Z_FOOT - Z_RAMP_TOP), 0, 1);
  return lerp(terrainHeight(x, z), DECK_Y - 0.06, t);
}

const QUALITY: Record<
  QualityId,
  {
    radial: number;
    rings: number;
    fronds: number;
    bolts: boolean;
    plankW: [number, number];
  }
> = {
  ultra: {
    radial: 18,
    rings: 14,
    fronds: 6,
    bolts: true,
    plankW: [0.17, 0.24],
  },
  high: { radial: 16, rings: 12, fronds: 6, bolts: true, plankW: [0.17, 0.24] },
  medium: {
    radial: 12,
    rings: 8,
    fronds: 4,
    bolts: false,
    plankW: [0.24, 0.32],
  },
  low: { radial: 10, rings: 6, fronds: 0, bolts: false, plankW: [0.26, 0.34] },
};

// ---------------------------------------------------------------------------
// Piles
// ---------------------------------------------------------------------------

interface Pile {
  x: number;
  z: number;
  /** Radius at the foot (m). */
  r: number;
  /** World y of the top and of the buried foot. */
  top: number;
  bottom: number;
  /** Lean (rad) and the azimuth the top moves toward: (cos az, ·, sin az). */
  lean: number;
  az: number;
  /** Snapped off at the wave line (jagged top). */
  stump: boolean;
  /** Rises above the deck (fender post). */
  proud: boolean;
  tint: number;
}

interface PileLayout {
  piles: Pile[];
  lamp: Pile;
  ring: Pile;
  brace: [Pile, Pile];
}

function layoutPiles(rng: TexRng): PileLayout {
  const piles: Pile[] = [];
  const add = (
    x: number,
    z: number,
    top: number,
    o: Partial<Pile> = {},
  ): Pile => {
    const p: Pile = {
      x,
      z,
      r: rng.range(0.15, 0.175),
      top,
      bottom: terrainHeight(x, z) - 1.0,
      lean: 0,
      az: rng.next() * Math.PI * 2,
      stump: false,
      proud: false,
      tint: rng.range(0.88, 1.08),
      ...o,
    };
    piles.push(p);
    return p;
  };
  // Nine pairs under the deck (k = 0 abutment … 8 ragged end)
  let ring: Pile | null = null;
  const bracePair: Pile[] = [];
  for (let k = 0; k <= 8; k++) {
    const z = capZ(k);
    for (const side of [-1, 1]) {
      const x = X + side * PILE_X + rng.range(-0.03, 0.03);
      const zz = z + (k === 0 ? 0 : rng.range(-0.04, 0.04));
      const proud = (k === 0 && side === 1) || (k === 8 && side === -1);
      const top = proud
        ? deckLine(z) + (k === 0 ? 0.95 : 0.6)
        : pileTop(z) + 0.02;
      const p = add(x, zz, top, { lean: rng.range(0, 0.025), proud });
      if (k === 1 && side === 1) ring = p;
      if (k === 4) bracePair.push(p);
    }
  }
  // Sister piles driven beside rotten ones
  add(X - PILE_X - 0.38, capZ(3) + 0.05, pileTop(capZ(3)) - 0.12, {
    lean: 0.035,
    az: Math.PI,
  });
  add(X + PILE_X + 0.36, capZ(6) - 0.06, pileTop(capZ(6)) + 0.02, {
    lean: 0.02,
    az: 0,
  });
  // Seaward orphans: the melancholy dotted line
  add(X - PILE_X + 0.08, Z_DECK - 2.3, 0.85, { stump: true, lean: 0.07 });
  add(X - PILE_X, capZ(9) + 0.1, 2.35, { lean: 0.14, az: -1.2 });
  add(X + PILE_X + 0.05, capZ(9) - 0.05, 1.55, { lean: 0.06, az: 0.4 });
  add(X + PILE_X, capZ(10), 2.05, { lean: 0.17, az: -2.2 });
  add(X - PILE_X + 0.04, capZ(10) + 0.08, 0.55, { stump: true, lean: 0.05 });
  add(X - PILE_X, capZ(11), 1.3, { lean: 0.12, az: 2.6 });
  add(X + PILE_X - 0.03, capZ(11) - 0.06, 0.38, { stump: true, lean: 0.03 });
  const lamp = add(X + PILE_X, Z_END, 2.3, { lean: 0.03, az: -1.6 });
  if (!ring || bracePair.length < 2) throw new Error("OldPier: pile layout");
  return { piles, lamp, ring, brace: [bracePair[0], bracePair[1]] };
}

/** World position of a pile's axis at world height y (leaning piles). */
function pileAxis(p: Pile, y: number, out: THREE.Vector3): THREE.Vector3 {
  const h = (y - p.bottom) / Math.cos(p.lean);
  const s = Math.sin(p.lean) * h;
  return out.set(p.x + s * Math.cos(p.az), y, p.z + s * Math.sin(p.az));
}

/** Pile radius at world height y (taper). */
function pileRadiusAt(p: Pile, y: number): number {
  const t = clamp((y - p.bottom) / (p.top - p.bottom), 0, 1);
  return p.r * (1 - 0.1 * t);
}

/**
 * Eroded, optionally leaning pile: radius noise for the rot, a jagged top on
 * stumps, a sawn end-grain cap otherwise. uv: u once around, v = world
 * height (pileV) so the wave-line band is shared by every pile.
 */
function pileGeometry(
  p: Pile,
  radial: number,
  rings: number,
  seed: number,
): THREE.BufferGeometry {
  const L = (p.top - p.bottom) / Math.cos(p.lean);
  const sinL = Math.sin(p.lean);
  const cosL = Math.cos(p.lean);
  const ca = Math.cos(p.az);
  const sa = Math.sin(p.az);
  const rTop = p.r * 0.9;
  const taper = (p.r - rTop) / L;
  const w = new THREE.Vector3();
  const rot = (lx: number, ly: number, lz: number, out: THREE.Vector3) => {
    const along = lx * ca + lz * sa;
    const perp = -lx * sa + lz * ca;
    const a2 = along * cosL + ly * sinL;
    const y2 = -along * sinL + ly * cosL;
    return out.set(a2 * ca - perp * sa, y2, a2 * sa + perp * ca);
  };
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const cols = radial + 1;
  const TWO_PI = Math.PI * 2;
  for (let j = 0; j <= rings; j++) {
    const s = (L * j) / rings;
    for (let i = 0; i <= radial; i++) {
      const a = (i / radial) * TWO_PI;
      const cx = Math.cos(a);
      const sz = Math.sin(a);
      const n = fbm(cx * 1.7 + seed, s * 1.3 + sz * 1.7 + seed * 0.37, 3);
      let rad = lerp(p.r, rTop, s / L) * (1 + (n - 0.5) * 0.16);
      let sy = s;
      if (j === rings) {
        if (p.stump) {
          sy = L + (fbm(cx * 2.3 + seed, sz * 2.3 - seed, 2) - 0.5) * 0.5;
          rad *= 0.93;
        }
      }
      rot(rad * cx, sy, rad * sz, w);
      pos.push(w.x + p.x, w.y + p.bottom, w.z + p.z);
      const wy = w.y + p.bottom;
      rot(cx, taper, sz, w).normalize();
      nor.push(w.x, w.y, w.z);
      uv.push(i / radial, pileV(wy));
    }
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < radial; i++) {
      const b0 = j * cols + i;
      const b1 = b0 + 1;
      const t0 = b0 + cols;
      const t1 = t0 + 1;
      idx.push(b0, t0, t1, b0, t1, b1);
    }
  }
  // Top: fan into the end-grain patch (sunken centre on stumps)
  const G = PILE_GRAIN_UV;
  const cIdx = pos.length / 3;
  rot(0, p.stump ? L - 0.05 : L, 0, w);
  pos.push(w.x + p.x, w.y + p.bottom, w.z + p.z);
  rot(0, 1, 0, w).normalize();
  const upX = w.x;
  const upY = w.y;
  const upZ = w.z;
  nor.push(upX, upY, upZ);
  uv.push(G.cu, G.cv);
  const rim0 = pos.length / 3;
  const topRow = rings * cols;
  for (let i = 0; i <= radial; i++) {
    const k = (topRow + i) * 3;
    pos.push(pos[k], pos[k + 1], pos[k + 2]);
    nor.push(upX, upY, upZ);
    const a = (i / radial) * TWO_PI;
    uv.push(G.cu + G.ru * Math.cos(a) * 0.95, G.cv + G.rv * Math.sin(a) * 0.95);
  }
  for (let i = 0; i < radial; i++) idx.push(cIdx, rim0 + i + 1, rim0 + i);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// ---------------------------------------------------------------------------
// Planks
// ---------------------------------------------------------------------------

/**
 * What is left of a plank. "gone" is a single plank missing between two whole
 * ones – a 20 cm slot you step over (the ground bridges it). "half" is a
 * plank broken off at the centre stringer, 2–4 of them in a row make a hole
 * you cannot cross on that side: the ground is null over the missing half and
 * an invisible box stands over it. The weather side (−x, facing the open
 * bay) took all the damage, so every hole is on that side and the east half
 * of the deck runs unbroken to the ragged end – it stays reachable.
 */
type PlankKind = "full" | "gone" | "half";
/** The surviving side of every half-deck hole. */
const HOLE_SIDE = 1;

interface Plank {
  zc: number;
  w: number;
  kind: PlankKind;
  /**
   * Dropped part still hanging (0 = it fell into the sea): "gone" → pivots on
   * the outer stringer of this side, "half" → the missing half hangs from
   * the centre stringer on this side.
   */
  hang: number;
  /** Top = deckLine(zc) + y0 + y1 · (x − X) (sprung planks). */
  y0: number;
  y1: number;
  /** Surviving extent across the deck (relative to X). */
  xl: number;
  xr: number;
  slot: number;
  tint: Tint;
}

function layoutPlanks(
  rng: TexRng,
  wRange: [number, number],
  piles: Pile[],
): Plank[] {
  const proud = piles.filter((p) => p.proud);
  const planks: Plank[] = [];
  let z = Z_LAND + 0.5;
  /** Planks still to come in the current half-deck hole. */
  let holeLeft = 0;
  /** Whole planks since the last hole, forced whole planks after a slot. */
  let fullSince = 99;
  let forceFull = 0;
  for (let i = 0; ; i++) {
    const w = rng.range(wRange[0], wRange[1]);
    if (z - w < Z_DECK - 0.3) break;
    const zc = z - w / 2;
    const t = (Z_LAND - zc) / (Z_LAND - Z_DECK);
    const ragged = zc < Z_DECK + 2.4;
    const pMiss = 0.03 + 0.06 * t ** 1.5 + (ragged ? 0.45 : 0);
    let kind: PlankKind = "full";
    if (holeLeft > 0) {
      kind = "half";
      holeLeft--;
    } else if (forceFull > 0) {
      forceFull--;
    } else if (i >= 3 && rng.chance(pMiss)) {
      if (!ragged && fullSince >= 1 && rng.chance(0.45)) {
        kind = "gone";
        forceFull = 1;
      } else {
        kind = "half";
        holeLeft = 1 + rng.int(ragged ? 3 : 2);
      }
    }
    fullSince = kind === "full" ? fullSince + 1 : 0;
    let hang = 0;
    if (kind === "gone" && zc < -64 && rng.chance(0.35))
      hang = rng.chance(0.5) ? 1 : -1;
    if (kind === "half" && zc < -63 && rng.chance(0.4)) hang = -HOLE_SIDE;
    let y0 = 0;
    let y1 = 0;
    if (kind === "full" && i > 3 && rng.chance(0.045)) {
      const lift = rng.range(0.035, 0.08);
      const side = rng.chance(0.5) ? 1 : -1;
      y0 = lift / 2;
      y1 = (lift * side) / (2 * HALF_W);
    }
    let xl = -HALF_W;
    let xr = HALF_W;
    if (kind === "half") {
      if (HOLE_SIDE > 0) xl = 0.02;
      else xr = -0.02;
    }
    for (const p of proud) {
      if (Math.abs(zc - p.z) < p.r + w / 2 + 0.03) {
        const inner = Math.abs(p.x - X) - p.r - 0.03;
        if (p.x > X) xr = Math.min(xr, inner);
        else xl = Math.max(xl, -inner);
      }
    }
    const k = rng.range(0.8, 1.12);
    planks.push({
      zc,
      w,
      kind,
      hang,
      y0,
      y1,
      xl,
      xr,
      slot: rng.int(DECK_SLOTS),
      tint: [k, k * rng.range(0.97, 1.01), k * rng.range(0.92, 1.0)],
    });
    z -=
      w + (rng.chance(0.12) ? rng.range(0.05, 0.09) : rng.range(0.012, 0.045));
  }
  return planks;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

type BagKey = "pile" | "deck" | "iron" | "decal";
type Tint = [number, number, number];
const WHITE: Tint = [1, 1, 1];

/** Collects non-indexed geometries per material and merges them. */
class GeoBag {
  readonly lists: Record<BagKey, THREE.BufferGeometry[]> = {
    pile: [],
    deck: [],
    iron: [],
    decal: [],
  };

  add(key: BagKey, g: THREE.BufferGeometry, tint: Tint = WHITE): void {
    let geo = g;
    if (g.index) {
      geo = g.toNonIndexed();
      g.dispose();
    }
    const n = geo.getAttribute("position").count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = tint[0];
      col[i * 3 + 1] = tint[1];
      col[i * 3 + 2] = tint[2];
    }
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    this.lists[key].push(geo);
  }

  merge(key: BagKey): THREE.BufferGeometry | null {
    const list = this.lists[key];
    if (list.length === 0) return null;
    const merged = mergeGeometries(list, false);
    for (const g of list) g.dispose();
    list.length = 0;
    if (!merged) throw new Error(`OldPier: mergeGeometries (${key}) failed`);
    merged.computeBoundingSphere();
    return merged;
  }
}

/**
 * Timber as BoxGeometry(len along x, thick along y, wide along z) mapped into
 * the deck texture: u along the length (uA..uB), v into plank slot `slot`;
 * the thin faces sample the slot's edge.
 */
function timberBox(
  len: number,
  thick: number,
  wide: number,
  slot: number,
  uA: number,
  uB: number,
): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(len, thick, wide);
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  const sv0 = slot / DECK_SLOTS + 0.004;
  const sv1 = (slot + 1) / DECK_SLOTS - 0.004;
  const tv = Math.min(thick, DECK_SLOT_M) / (DECK_SLOTS * DECK_SLOT_M);
  const wu = wide / DECK_U_LEN;
  const remap = (face: number, a: number, b: number, c: number, d: number) => {
    for (let i = face * 4; i < face * 4 + 4; i++) {
      uv.setXY(i, a + uv.getX(i) * (b - a), c + uv.getY(i) * (d - c));
    }
  };
  remap(2, uA, uB, sv0, sv1);
  remap(3, uA, uB, sv0, sv1);
  remap(4, uA, uB, sv0 + 0.003, sv0 + 0.003 + tv);
  remap(5, uA, uB, sv1 - 0.003 - tv, sv1 - 0.003);
  remap(0, uA, uA + wu, sv0 + 0.01, sv0 + 0.01 + tv);
  remap(1, uB - wu, uB, sv0 + 0.01, sv0 + 0.01 + tv);
  return g;
}

/** Timber with a random slot / u offset (non-plank members). */
function timber(
  rng: TexRng,
  len: number,
  thick: number,
  wide: number,
): THREE.BoxGeometry {
  const u0 = rng.next();
  return timberBox(
    len,
    thick,
    wide,
    rng.int(DECK_SLOTS),
    u0,
    u0 + len / DECK_U_LEN,
  );
}

/** Swap u/v and scale (cylinders: grain along the axis). */
function uvSwap(
  g: THREE.BufferGeometry,
  su: number,
  sv: number,
  ou: number,
  ov: number,
): void {
  const attr = g.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < attr.count; i++) {
    const u = attr.getX(i);
    const v = attr.getY(i);
    attr.setXY(i, ou + v * su, ov + u * sv);
  }
}

/**
 * Vertical quad hanging from its top edge centre (cx, cy, cz), facing the
 * horizontal normal (nx, nz), the bottom edge pushed out by `flare`.
 */
function hangingQuad(
  cx: number,
  cy: number,
  cz: number,
  nx: number,
  nz: number,
  w: number,
  h: number,
  flare: number,
  r: UvRegion,
  u0: number,
  u1: number,
): THREE.BufferGeometry {
  const tx = -nz * w * 0.5;
  const tz = nx * w * 0.5;
  const ua = r[0] + (r[2] - r[0]) * u0;
  const ub = r[0] + (r[2] - r[0]) * u1;
  const p = [
    cx - tx,
    cy,
    cz - tz,
    cx + tx,
    cy,
    cz + tz,
    cx + tx + nx * flare,
    cy - h,
    cz + tz + nz * flare,
    cx - tx + nx * flare,
    cy - h,
    cz - tz + nz * flare,
  ];
  const t = [ua, r[3], ub, r[3], ub, r[1], ua, r[1]];
  const order = [0, 2, 1, 0, 3, 2];
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  for (const k of order) {
    pos.push(p[k * 3], p[k * 3 + 1], p[k * 3 + 2]);
    nor.push(nx, 0, nz);
    uv.push(t[k * 2], t[k * 2 + 1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

/** Sand tiling of the terrain mesh (world.ts) – the fill matches it. */
const SAND_TILE_X = 820 / 70;
const SAND_TILE_Z = 560 / 48;

// ---------------------------------------------------------------------------
// The place
// ---------------------------------------------------------------------------

export class OldPier {
  private readonly parent: THREE.Group;
  private readonly root = new THREE.Group();
  private readonly materials: THREE.Material[] = [];
  // Ground lookup: 2 cm cells along the deck → plank index or -1
  private static readonly CELL = 0.02;
  private static readonly Z_CELL_TOP = Z_LAND + 0.6;
  private static readonly Z_CELL_BOT = Z_DECK - 1.5;
  private readonly cells: Int16Array;
  private readonly plankZ: Float32Array;
  private readonly plankY0: Float32Array;
  private readonly plankY1: Float32Array;
  private readonly plankXl: Float32Array;
  private readonly plankXr: Float32Array;

  /** Construction cost in ms (whole constructor / the texture sheets). */
  readonly buildMs: number;
  readonly textureMs: number;

  constructor(parent: THREE.Group, quality: QualityId) {
    const t0 = performance.now();
    this.parent = parent;
    this.root.name = "old-pier";
    const q = QUALITY[quality];
    const rng = new TexRng(0x01d91e7);

    const layout = layoutPiles(rng);
    const planks = layoutPlanks(rng, q.plankW, layout.piles);

    // ---- geometry --------------------------------------------------------
    const bag = new GeoBag();
    this.buildPiles(bag, layout, q.radial, q.rings, rng);
    this.buildDeck(bag, layout, planks, q.bolts, rng);
    this.buildFittings(bag, layout, q.fronds, rng);
    this.buildAbutment(bag, rng);

    // ---- materials -------------------------------------------------------
    const mk = (
      maps: ReturnType<typeof pilePbr>,
    ): THREE.MeshStandardMaterial => {
      const m = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 1,
        metalness: 0,
      });
      applyPbr(m, maps);
      this.materials.push(m);
      return m;
    };
    // Half-size sheets on medium/low – the textures dominate the boot cost
    const hi = quality === "ultra" || quality === "high";
    const tTex = performance.now();
    const mats: Record<BagKey, THREE.Material> = {
      pile: mk(pilePbr(hi)),
      deck: mk(deckPbr(hi)),
      iron: mk(ironPbr(hi)),
      decal: mk(decalPbr(hi)),
    };
    this.textureMs = performance.now() - tTex;
    for (const key of ["pile", "deck", "iron", "decal"] as BagKey[]) {
      const geo = bag.merge(key);
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, mats[key]);
      mesh.name = `pier-${key}`;
      mesh.castShadow = key !== "decal";
      mesh.receiveShadow = true;
      this.root.add(mesh);
    }
    // The fill wears the terrain's own look (world.ts): the same maps, flat
    // roughness and the wet-sand / rain / cloud tint of the terrain shader,
    // so the drift is not a pale patch on a wet or overcast beach
    const sandMat = new THREE.MeshStandardMaterial({
      map: sandAlbedo(),
      normalMap: sandNormal(),
      normalScale: new THREE.Vector2(0.7, 0.7),
      roughness: 0.95,
      metalness: 0,
    });
    this.patchSand(sandMat);
    this.materials.push(sandMat);
    this.root.add(this.buildFill(sandMat));
    parent.add(this.root);

    // ---- ground ----------------------------------------------------------
    const n =
      Math.ceil((OldPier.Z_CELL_TOP - OldPier.Z_CELL_BOT) / OldPier.CELL) + 1;
    this.cells = new Int16Array(n).fill(-1);
    this.plankZ = new Float32Array(planks.length);
    this.plankY0 = new Float32Array(planks.length);
    this.plankY1 = new Float32Array(planks.length);
    this.plankXl = new Float32Array(planks.length);
    this.plankXr = new Float32Array(planks.length);
    for (let i = 0; i < planks.length; i++) {
      const p = planks[i];
      this.plankZ[i] = p.zc;
      this.plankY0[i] = p.y0;
      this.plankY1[i] = p.y1;
      this.plankXl[i] = p.xl;
      this.plankXr[i] = p.xr;
      // Every plank owns the deck up to the middle of the seams on both
      // sides; a single missing plank is bridged by its landward neighbour
      const idx = p.kind === "gone" ? i - 1 : i;
      const prev = i > 0 ? planks[i - 1] : null;
      const next = i + 1 < planks.length ? planks[i + 1] : null;
      const z1 = prev
        ? (prev.zc - prev.w / 2 + p.zc + p.w / 2) / 2
        : p.zc + p.w / 2 + 0.01;
      const z0 = next
        ? (next.zc + next.w / 2 + p.zc - p.w / 2) / 2
        : p.zc - p.w / 2 - 0.01;
      const c0 = Math.max(
        0,
        Math.floor((OldPier.Z_CELL_TOP - z1) / OldPier.CELL),
      );
      const c1 = Math.min(
        n - 1,
        Math.floor((OldPier.Z_CELL_TOP - z0) / OldPier.CELL),
      );
      for (let c = c0; c <= c1; c++) this.cells[c] = idx;
    }
    registerGround("pier", this.groundAt);

    // ---- colliders (world coordinates) -----------------------------------
    beginColliderSet("pier");
    for (const p of layout.piles) {
      addCylinderCollider(p.x, p.z, p.r + 0.03, p.bottom, p.top);
    }
    // Nothing gets beneath the deck: one box per bay from the sea floor up to
    // just under the planks. A wader (or the jeep, in the shallow landward
    // bays) walking in under the deck would otherwise be lifted onto the
    // planks by the ground function. Bodies ON the deck stand above the band;
    // the ramp joins the deck landward of the first bay, so it is unaffected.
    for (let k = 0; k < 8; k++) {
      const zm = (capZ(k) + capZ(k + 1)) / 2;
      addBoxCollider(
        X,
        zm,
        WALL_X,
        SPAN / 2,
        0,
        terrainHeight(X, zm) - 1,
        deckLine(zm) - 0.3,
      );
    }
    // Half-deck holes: a wall over the missing half for a body on the deck,
    // nothing for one underneath (the band starts just below the planks)
    let runStart = -1;
    for (let i = 0; i <= planks.length; i++) {
      const p = i < planks.length ? planks[i] : null;
      const side = p ? Math.sign(p.xl + p.xr) : 0;
      const cont =
        p !== null &&
        p.kind === "half" &&
        (runStart < 0 ||
          side === Math.sign(planks[runStart].xl + planks[runStart].xr));
      if (runStart >= 0 && !cont) {
        const a = planks[runStart];
        const b = planks[i - 1];
        const zTop = a.zc + a.w / 2;
        const zBot = b.zc - b.w / 2;
        const zm = (zTop + zBot) / 2;
        const dl = deckLine(zm);
        const m = -Math.sign(a.xl + a.xr);
        addBoxCollider(
          X + m * 0.75,
          zm,
          0.72,
          (zTop - zBot) / 2 + 0.02,
          0,
          dl - 0.25,
          dl + 1.7,
        );
        runStart = -1;
      }
      if (p !== null && p.kind === "half" && runStart < 0) runStart = i;
    }
    for (const s of this.railStubs) {
      addCylinderCollider(s[0], s[1], 0.09, s[2] - 0.3, s[2] + s[3]);
    }
    // Abutment: cheek walls, face, the two bollards that stop the jeep, the
    // mooring bollard beside the ramp
    const gFoot = terrainHeight(X, Z_FOOT);
    const zWallMid = (Z_FOOT + 0.5 + Z_FACE) / 2;
    const wallHalf = (Z_FOOT + 0.5 - Z_FACE) / 2;
    for (const side of [-1, 1]) {
      addBoxCollider(
        X + side * WALL_X,
        zWallMid,
        0.06,
        wallHalf,
        0,
        gFoot - 1.5,
        DECK_Y + 1.3,
      );
      addCylinderCollider(
        X + side * 0.62,
        Z_FOOT - 0.1,
        0.11,
        gFoot - 1,
        gFoot + 1.3,
      );
    }
    addBoxCollider(X, Z_FACE, 1.5, 0.07, 0, gFoot - 2, DECK_Y - 0.4);
    addCylinderCollider(X + 2.2, Z_FOOT - 0.9, 0.22, gFoot - 1, gFoot + 1);
    this.buildMs = performance.now() - t0;
  }

  /** Rail stubs [x, z, deckY, height] – filled by buildDeck for the colliders. */
  private readonly railStubs: Array<[number, number, number, number]> = [];

  private readonly groundAt = (x: number, z: number): number | null => {
    const dx = x - X;
    if (dx < -HALF_W || dx > HALF_W || z < OldPier.Z_CELL_BOT || z > Z_FOOT)
      return null;
    if (z < OldPier.Z_CELL_TOP) {
      const c = ((OldPier.Z_CELL_TOP - z) / OldPier.CELL) | 0;
      const p = this.cells[c];
      if (p >= 0) {
        if (dx < this.plankXl[p] || dx > this.plankXr[p]) return null;
        return (
          deckLine(this.plankZ[p]) + this.plankY0[p] + this.plankY1[p] * dx
        );
      }
      if (z < Z_LAND + 0.15) return null;
    }
    return rampY(x, z);
  };

  // -------------------------------------------------------------------------

  private buildPiles(
    bag: GeoBag,
    layout: PileLayout,
    radial: number,
    rings: number,
    rng: TexRng,
  ): void {
    const v = new THREE.Vector3();
    for (let i = 0; i < layout.piles.length; i++) {
      const p = layout.piles[i];
      const k = p.tint;
      const tint: Tint = p.stump
        ? [k * 0.9, k * 0.88, k * 0.8]
        : [k, k * 0.99, k * 0.97];
      bag.add("pile", pileGeometry(p, radial, rings, i * 3.7 + 1.3), tint);
      // Rusted iron straps: the fender posts and a few pile heads
      const strap = p.proud || (!p.stump && p.top > 1.5 && rng.chance(0.3));
      if (strap) {
        const y = p.proud ? p.top - 0.14 : p.top - 0.1;
        pileAxis(p, y, v);
        const r = pileRadiusAt(p, y) + 0.014;
        const g = new THREE.CylinderGeometry(r, r, 0.08, 14, 1, true);
        g.rotateX(p.lean * Math.sin(p.az));
        g.rotateZ(-p.lean * Math.cos(p.az));
        g.translate(v.x, v.y, v.z);
        bag.add("iron", g, [0.9, 0.9, 0.9]);
      }
    }
  }

  private buildDeck(
    bag: GeoBag,
    layout: PileLayout,
    planks: Plank[],
    bolts: boolean,
    rng: TexRng,
  ): void {
    // ---- pile caps ---------------------------------------------------------
    for (let k = 0; k <= 8; k++) {
      const z = capZ(k);
      const top = capTop(z);
      const g = timber(rng, CAP_LEN, CAP_H, CAP_W);
      g.translate(X, top - CAP_H / 2, z);
      bag.add("deck", g, [0.82, 0.8, 0.76]);
      if (bolts) {
        for (const side of [-1, 1]) {
          const b = new THREE.CylinderGeometry(0.022, 0.022, 0.03, 8);
          b.translate(X + side * PILE_X, top + 0.01, z);
          bag.add("iron", b);
        }
      }
    }
    // ---- stringers, span by span (the deck sags, so each span is pitched) --
    for (let k = 0; k < 8; k++) {
      const zA = capZ(k);
      const zB = capZ(k + 1);
      const yA = deckLine(zA) - PLANK_T;
      const yB = deckLine(zB) - PLANK_T;
      const len = zA - zB;
      const pitch = Math.atan2(yB - yA, len);
      for (const sx of STR_X) {
        const g = timber(rng, len, STR_H, STR_W);
        g.translate(0, -STR_H / 2, 0);
        g.rotateY(Math.PI / 2);
        g.rotateX(pitch);
        g.translate(X + sx, (yA + yB) / 2, (zA + zB) / 2);
        bag.add("deck", g, [0.86, 0.84, 0.8]);
      }
    }
    // Ragged end: the middle stringer runs on past the last cap, splintered
    {
      const z0 = capZ(8);
      const ext = 1.35;
      const g = timber(rng, ext, STR_H, STR_W);
      const pos = g.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        if (pos.getX(i) > 0) {
          pos.setY(
            i,
            pos.getY(i) * 0.3 - STR_H * 0.3 + (rng.next() - 0.5) * 0.04,
          );
          pos.setZ(i, pos.getZ(i) * 0.7);
        }
      }
      g.translate(ext / 2, -STR_H / 2, 0);
      g.rotateY(Math.PI / 2);
      g.translate(X, deckLine(z0) - PLANK_T, z0);
      bag.add("deck", g, [0.8, 0.78, 0.74]);
    }
    // ---- planks -------------------------------------------------------------
    for (const p of planks) {
      if (p.kind !== "gone") {
        const g = timberBox(
          p.xr - p.xl,
          PLANK_T,
          p.w,
          p.slot,
          (p.xl + HALF_W) / DECK_U_LEN,
          (p.xr + HALF_W) / DECK_U_LEN,
        );
        g.translate((p.xl + p.xr) / 2, 0, 0);
        if (p.y1 !== 0) g.rotateZ(Math.atan(p.y1));
        g.translate(X, deckLine(p.zc) - PLANK_T / 2 + p.y0, p.zc);
        bag.add("deck", g, p.tint);
      }
      if (p.hang === 0) continue;
      const dark: Tint = [p.tint[0] * 0.8, p.tint[1] * 0.8, p.tint[2] * 0.78];
      if (p.kind === "gone") {
        // Dropped through: pivots on the outer stringer, hangs into the water
        const side = p.hang;
        const g = timberBox(2 * HALF_W, PLANK_T, p.w, p.slot, 0, 1);
        const pivot = side * (STR_X[2] + STR_W / 2);
        g.translate(-pivot, -PLANK_T / 2, 0);
        g.rotateZ(side * (1.05 + rng.range(-0.15, 0.15)));
        g.translate(X + pivot, deckLine(p.zc) - PLANK_T, p.zc);
        bag.add("deck", g, dark);
      } else {
        // The broken-off half hangs from the centre stringer by its nails
        const m = p.hang;
        const len = HALF_W - 0.06;
        const g = timberBox(
          len,
          PLANK_T,
          p.w,
          p.slot,
          m > 0 ? (HALF_W + 0.06) / DECK_U_LEN : 0,
          m > 0 ? 1 : (HALF_W - 0.06) / DECK_U_LEN,
        );
        g.translate((m * len) / 2, -PLANK_T / 2, 0);
        g.rotateZ(-m * (1.2 + rng.range(-0.15, 0.15)));
        g.translate(X + m * 0.06, deckLine(p.zc) - PLANK_T, p.zc);
        bag.add("deck", g, dark);
      }
    }
    // ---- rail stubs, one hanging rail -------------------------------------
    for (let k = 1; k <= 7; k++) {
      const z = capZ(k);
      for (const side of [-1, 1]) {
        if (rng.chance(0.28)) continue;
        const h = rng.range(0.3, 0.8);
        const dl = deckLine(z);
        const x = X + side * 1.1;
        const g = timber(rng, h + 0.32, 0.1, 0.1);
        g.translate((h + 0.32) / 2, 0, 0);
        g.rotateZ(Math.PI / 2);
        g.rotateY(rng.range(-0.06, 0.06));
        g.translate(x, dl - 0.32, z);
        bag.add("deck", g, [0.9, 0.88, 0.84]);
        this.railStubs.push([x, z, dl, h]);
        if (bolts) {
          const b = new THREE.CylinderGeometry(0.02, 0.02, 0.03, 8);
          b.rotateZ(Math.PI / 2);
          b.translate(x + side * 0.05, dl - 0.16, z);
          bag.add("iron", b);
        }
        if (k === 3 && side === -1) {
          // The one rail still bolted at the post top, its far end in the sea
          const len = 2.2;
          const r = timber(rng, len, 0.12, 0.06);
          r.translate(len / 2, 0, 0);
          r.rotateY(Math.PI / 2);
          r.rotateX(-0.95);
          r.translate(x, dl + h - 0.05, z);
          bag.add("deck", r, [0.88, 0.86, 0.82]);
        }
      }
    }
    // ---- broken stanchions carrying the abutment rails on along the edge --
    const stubs: ReadonlyArray<readonly [number, number, number]> = [
      [-1, -52.45, 0.34],
      [1, -53.35, 0.18],
      [-1, -54.55, 0.26],
      [1, -55.5, 0.12],
    ];
    for (const [side, z, h] of stubs) {
      const dl = deckLine(z);
      const x = X + side * 1.1;
      const g = timber(rng, h + 0.32, 0.1, 0.1);
      g.translate((h + 0.32) / 2, 0, 0);
      g.rotateZ(Math.PI / 2);
      g.rotateX(rng.range(-0.12, 0.12));
      g.rotateZ(side * rng.range(-0.1, 0.02));
      g.translate(x, dl - 0.32, z);
      bag.add("deck", g, [0.86, 0.84, 0.8]);
      this.railStubs.push([x, z, dl, h]);
    }
    // ---- the one surviving bracing pair (X-brace on a pile pair) ----------
    {
      const [a, b] = layout.brace;
      const z = (a.z + b.z) / 2;
      const yLow = 0.85;
      const yHigh = pileTop(z) - 0.3;
      const dx = b.x - a.x;
      const dy = yHigh - yLow;
      const len = Math.hypot(dx, dy) + 0.3;
      const ang = Math.atan2(dy, dx);
      // Bolted to the landward / seaward faces of the two piles
      const off = Math.max(a.r, b.r) + 0.055;
      for (const dir of [1, -1]) {
        const g = timber(rng, len, 0.2, 0.1);
        g.rotateZ(dir * ang);
        g.translate(X, (yLow + yHigh) / 2, z + dir * off);
        bag.add("deck", g, [0.78, 0.76, 0.72]);
        if (bolts) {
          for (const e of [-1, 1]) {
            const bx = X + (e * dir * dx) / 2;
            const by = (yLow + yHigh) / 2 + (e * dy) / 2;
            const bolt = new THREE.CylinderGeometry(0.02, 0.02, 0.03, 8);
            bolt.rotateX(Math.PI / 2);
            bolt.translate(bx, by, z + dir * (off + 0.06));
            bag.add("iron", bolt);
          }
        }
      }
    }
  }

  private buildFittings(
    bag: GeoBag,
    layout: PileLayout,
    fronds: number,
    rng: TexRng,
  ): void {
    const v = new THREE.Vector3();
    // ---- mooring ring on a landward pile (outer face) ----------------------
    {
      const p = layout.ring;
      const y = 1.6;
      pileAxis(p, y, v);
      const r = pileRadiusAt(p, y);
      const plate = new THREE.BoxGeometry(0.02, 0.16, 0.12);
      plate.translate(v.x + r + 0.005, y, v.z);
      bag.add("iron", plate);
      const ring = new THREE.TorusGeometry(0.1, 0.017, 7, 20);
      ring.rotateY(Math.PI / 2);
      ring.rotateZ(0.12);
      ring.translate(v.x + r + 0.038, y - 0.1, v.z);
      bag.add("iron", ring, [0.95, 0.95, 0.95]);
      // Rust bleeding down the timber below the plate
      bag.add(
        "decal",
        hangingQuad(
          v.x + r + 0.006,
          y - 0.07,
          v.z,
          1,
          0,
          0.26,
          0.75,
          0,
          DECAL_UV.rust,
          0,
          1,
        ),
      );
    }
    // ---- lamp bracket on the outermost pile --------------------------------
    {
      const p = layout.lamp;
      const yTop = p.top;
      pileAxis(p, yTop - 0.3, v);
      const r = pileRadiusAt(p, yTop - 0.3);
      const zf = v.z - r;
      const strap = new THREE.BoxGeometry(0.05, 0.6, 0.015);
      strap.translate(v.x, yTop - 0.25, zf - 0.005);
      bag.add("iron", strap);
      const arm = new THREE.CatmullRomCurve3([
        new THREE.Vector3(v.x, yTop - 0.05, zf - 0.01),
        new THREE.Vector3(v.x, yTop + 0.22, zf - 0.16),
        new THREE.Vector3(v.x, yTop + 0.44, zf - 0.4),
        new THREE.Vector3(v.x, yTop + 0.44, zf - 0.55),
        new THREE.Vector3(v.x, yTop + 0.42, zf - 0.575),
      ]);
      bag.add("iron", new THREE.TubeGeometry(arm, 12, 0.015, 6, false));
      // Empty lamp cage swinging from the hook: two rings, four bars, a roof
      const cx = v.x + 0.01;
      const cz = zf - 0.575;
      const yc = yTop + 0.3;
      for (const dy of [0, -0.26]) {
        const rg = new THREE.TorusGeometry(0.085, 0.008, 5, 16);
        rg.rotateX(Math.PI / 2);
        rg.translate(cx, yc + dy, cz);
        bag.add("iron", rg);
      }
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.4;
        const bar = new THREE.CylinderGeometry(0.006, 0.006, 0.26, 5);
        bar.translate(
          cx + Math.cos(a) * 0.085,
          yc - 0.13,
          cz + Math.sin(a) * 0.085,
        );
        bag.add("iron", bar);
      }
      const roof = new THREE.ConeGeometry(0.11, 0.07, 12);
      roof.translate(cx, yc + 0.035, cz);
      bag.add("iron", roof);
      const hook = new THREE.CylinderGeometry(0.008, 0.008, 0.09, 5);
      hook.translate(cx, yc + 0.08, cz);
      bag.add("iron", hook);
    }
    // ---- wrack fronds hanging from the wave line of the piles in the water --
    if (fronds > 0) {
      for (const p of layout.piles) {
        if (p.z > -62) continue;
        const yTop = 0.14;
        pileAxis(p, yTop, v);
        const r = pileRadiusAt(p, yTop);
        for (let i = 0; i < fronds; i++) {
          const a = ((i + rng.range(-0.3, 0.3)) / fronds) * Math.PI * 2;
          const nx = Math.cos(a);
          const nz = Math.sin(a);
          const u0 = rng.range(0, 0.6);
          const k = rng.range(0.8, 1.15);
          bag.add(
            "decal",
            hangingQuad(
              v.x + nx * (r + 0.02),
              yTop + rng.range(-0.05, 0.1),
              v.z + nz * (r + 0.02),
              nx,
              nz,
              rng.range(0.22, 0.3),
              rng.range(0.5, 0.72),
              rng.range(0.06, 0.14),
              DECAL_UV.weed,
              u0,
              u0 + 0.4,
            ),
            [k, k, k],
          );
        }
      }
    }
  }

  /** Timber-faced sand ramp: cheek walls, kerb rails, face, sleepers, bollards. */
  private buildAbutment(bag: GeoBag, rng: TexRng): void {
    const zTop = Z_FACE;
    const zFoot = Z_FOOT + 0.5;
    const yFoot = rampY(X, zFoot);
    const railY = (z: number): number =>
      lerp(yFoot, DECK_Y, (zFoot - z) / (zFoot - zTop)) + 0.16;
    // ---- cheek walls: vertical boards + capping rail -----------------------
    for (const side of [-1, 1]) {
      const x = X + side * WALL_X;
      for (let z = zFoot - 0.1; z > zTop + 0.05; z -= 0.21) {
        const top = railY(z) - 0.02;
        const bottom = rampY(X, z) - 0.75;
        const h = top - bottom;
        const g = timber(rng, h, 0.04, 0.2);
        g.translate(h / 2, 0, 0);
        g.rotateZ(Math.PI / 2);
        g.translate(x, bottom, z - 0.1);
        const k = rng.range(0.82, 1.05);
        bag.add("deck", g, [k, k * 0.98, k * 0.94]);
      }
      const len = zFoot - zTop;
      const pitch = Math.atan2(railY(zTop) - railY(zFoot), len);
      const rail = timber(rng, len, 0.08, 0.14);
      rail.rotateY(Math.PI / 2);
      rail.rotateX(pitch);
      rail.translate(
        x,
        (railY(zTop) + railY(zFoot)) / 2 - 0.04,
        (zTop + zFoot) / 2,
      );
      bag.add("deck", rail, [0.88, 0.86, 0.8]);
    }
    // ---- seaward face under the first planks --------------------------------
    for (let x = -1.45; x < 1.45; x += 0.21) {
      const wx = X + x + 0.1;
      const bottom = terrainHeight(wx, zTop) - 0.7;
      const top = DECK_Y - PLANK_T - 0.02;
      const h = top - bottom;
      const g = timber(rng, h, 0.05, 0.2);
      g.translate(h / 2, 0, 0);
      g.rotateZ(Math.PI / 2);
      g.rotateY(Math.PI / 2);
      g.translate(wx, bottom, zTop);
      const k = rng.range(0.78, 1.0);
      bag.add("deck", g, [k, k * 0.98, k * 0.94]);
    }
    // ---- sleeper steps set into the sand ----------------------------------
    for (let z = Z_FOOT - 0.9; z > Z_RAMP_TOP + 0.5; z -= 1.0) {
      const g = timber(rng, 2.36, 0.09, 0.16);
      g.translate(X, rampY(X, z) - 0.015, z);
      bag.add("deck", g, [0.72, 0.7, 0.66]);
    }
    // ---- bollards at the ramp foot (the jeep stops here) -------------------
    for (const side of [-1, 1]) {
      const x = X + side * 0.62;
      const z = Z_FOOT - 0.1;
      const gy = terrainHeight(x, z);
      const g = timber(rng, 1.2, 0.16, 0.16);
      g.translate(0.6, 0, 0);
      g.rotateZ(Math.PI / 2);
      g.rotateY(rng.range(-0.1, 0.1));
      g.translate(x, gy - 0.35, z);
      bag.add("deck", g, [0.95, 0.93, 0.88]);
      const band = new THREE.BoxGeometry(0.2, 0.05, 0.2);
      band.translate(x, gy + 0.72, z);
      bag.add("iron", band);
    }
    // ---- the bleached mooring bollard beside the ramp ----------------------
    {
      const x = X + 2.2;
      const z = Z_FOOT - 0.9;
      const gy = terrainHeight(x, z);
      const g = new THREE.CylinderGeometry(0.17, 0.2, 1.1, 14, 1, false);
      uvSwap(g, 1.1 / DECK_U_LEN, 1 / DECK_SLOTS, 0.1, 2 / DECK_SLOTS);
      g.rotateZ(0.06);
      g.translate(x, gy + 0.3, z);
      bag.add("deck", g, [1.12, 1.1, 1.04]);
      const band = new THREE.CylinderGeometry(0.185, 0.185, 0.06, 14, 1, true);
      band.rotateZ(0.06);
      band.translate(x - 0.04, gy + 0.72, z);
      bag.add("iron", band);
    }
  }

  /** The sand of the ramp between the cheek walls (world space, terrain-matched). */
  /**
   * The sand of the ramp between the cheek walls and the drift that spills
   * from its foot onto the beach (world space, terrain-matched). The grid is
   * a fan – just past the walls along the ramp, wide at the foot – and the
   * drift lobe ends in a noisy rim. Normals come from the height function
   * itself, so the rim shades like the beach around it instead of drawing a
   * line.
   */
  private buildFill(mat: THREE.Material): THREE.Mesh {
    const NA = 52;
    const NB = 16;
    const z0 = Z_FOOT + 3.2;
    const z1 = Z_FACE - 0.05;
    const halfW = (z: number): number =>
      1.36 + smoothstep(Z_FOOT - 1.6, Z_FOOT + 0.4, z);
    const height = (wx: number, z: number): number => {
      const lx = wx - X;
      const t = terrainHeight(wx, z);
      const inside = 1 - smoothstep(1.2, 1.34, Math.abs(lx));
      const onRamp = 1 - smoothstep(Z_FOOT - 0.4, Z_FOOT + 0.5, z);
      const body = inside * onRamp;
      let y = lerp(t + 0.012, rampY(wx, z) + 0.02, body);
      // Drift lobe spreading from the foot, its rim wandering with noise
      const rx = lx / 2.3;
      const rz = (z - (Z_FOOT - 0.4)) / 3.1;
      const n = fbm(wx * 0.7 + 3.1, z * 0.7 + 7.7, 3) - 0.5;
      const r = Math.hypot(rx, rz) + n * 0.5;
      const drift = 1 - smoothstep(0.25, 0.85, r);
      y += 0.075 * drift * drift * (1 - body);
      return y;
    };
    const pos = new Float32Array((NA + 1) * (NB + 1) * 3);
    const nor = new Float32Array((NA + 1) * (NB + 1) * 3);
    const uv = new Float32Array((NA + 1) * (NB + 1) * 2);
    const e = 0.08;
    let vi = 0;
    for (let j = 0; j <= NB; j++) {
      const s = (2 * j) / NB - 1;
      for (let i = 0; i <= NA; i++) {
        const z = lerp(z0, z1, i / NA);
        const wx = X + s * halfW(z);
        const y = height(wx, z);
        const dx = (height(wx + e, z) - height(wx - e, z)) / (2 * e);
        const dz = (height(wx, z + e) - height(wx, z - e)) / (2 * e);
        const inv = 1 / Math.sqrt(dx * dx + dz * dz + 1);
        pos[vi * 3] = wx;
        pos[vi * 3 + 1] = y;
        pos[vi * 3 + 2] = z;
        nor[vi * 3] = -dx * inv;
        nor[vi * 3 + 1] = inv;
        nor[vi * 3 + 2] = -dz * inv;
        uv[vi * 2] = (wx + 410) / SAND_TILE_X;
        uv[vi * 2 + 1] = (420 - z) / SAND_TILE_Z;
        vi++;
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < NB; j++) {
      for (let i = 0; i < NA; i++) {
        const a = j * (NA + 1) + i;
        const b = a + NA + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "pier-fill";
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    return mesh;
  }

  /** Sand tint uniforms of the fill – mirror world.ts's terrainUniforms. */
  private readonly sandU = {
    uTime: { value: 0 },
    uWet: { value: 0 },
    uCloud: { value: 0 },
  };
  /** Smoothed rain wetness, same dynamics as the terrain (−1 = unset). */
  private wet = -1;

  /** The terrain shader's wet-sand / rain / cloud tint (world.ts) on the fill. */
  private patchSand(mat: THREE.MeshStandardMaterial): void {
    const u = this.sandU;
    mat.customProgramCacheKey = () => "pier-sand";
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = u.uTime;
      sh.uniforms.uWet = u.uWet;
      sh.uniforms.uCloud = u.uCloud;
      sh.vertexShader = `varying vec3 vPierPos;\n${sh.vertexShader}`.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\n vPierPos = (modelMatrix * vec4(transformed, 1.0)).xyz;",
      );
      sh.fragmentShader =
        `varying vec3 vPierPos;\nuniform float uTime;\nuniform float uWet;\nuniform float uCloud;\n${SHORE_GLSL}
        float pHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float pNoise(vec2 p) {
          vec2 i = floor(p); vec2 f = p - i;
          f = f * f * (3.0 - 2.0 * f);
          float a = pHash(i), b = pHash(i + vec2(1.0, 0.0));
          float c = pHash(i + vec2(0.0, 1.0)), d = pHash(i + vec2(1.0, 1.0));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }
        ${sh.fragmentShader}`.replace(
          "#include <color_fragment>",
          `#include <color_fragment>
        { float dShore = vPierPos.z - shoreZf(vPierPos.x);
          float reach = waveReachF(uTime);
          float wetSand = 1.0 - smoothstep(reach, reach + 6.0, dShore);
          wetSand = max(wetSand, 1.0 - smoothstep(-0.5, 0.4, dShore));
          float pud = pNoise(vPierPos.xz * 0.085) * 0.65 + pNoise(vPierPos.xz * 0.31) * 0.35;
          wetSand = max(wetSand, uWet * (0.5 + 0.5 * smoothstep(0.32, 0.68, pud)) * 0.85);
          diffuseColor.rgb *= mix(1.0, 0.6, wetSand);
          float grey = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(grey) * vec3(0.97, 0.99, 1.05), uCloud * 0.42); }`,
        );
    };
  }

  update(dt: number, env: Environment, _camPos: THREE.Vector3): void {
    // Nothing moves – only the sand of the abutment follows the weather,
    // exactly as the terrain does (wets within seconds, dries over minutes)
    const u = this.sandU;
    u.uTime.value = env.envTime;
    if (this.wet < 0) this.wet = env.rain;
    else {
      const rate = env.rain > this.wet ? 0.5 : 0.02;
      this.wet += (env.rain - this.wet) * Math.min(1, dt * rate);
    }
    u.uWet.value = this.wet;
    u.uCloud.value = env.cloud;
  }

  dispose(): void {
    unregisterGround("pier");
    clearColliderSet("pier");
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    for (const m of this.materials) m.dispose();
    this.parent.remove(this.root);
  }
}
