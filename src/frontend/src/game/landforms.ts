// Landforms and ground masks of the built places – the chapel knoll, the old
// tip, the bitten dune edge, the sunken lane, the pier abutment, the bothy
// clearing, the cable house and the wardens' boardwalk. Deliberately without a
// Three.js import (like terrain.ts): terrain.ts adds the heights, vegetation.ts
// and vegetation-pines.ts read the masks, trash.ts the tip's debris pocket and
// the place-*.ts modules dress what the terrain provides.
//
// All shapes are smooth analytic masks – the same technique as the dune
// ridges and the flat driving corridor. Anything that needs the inland
// distance receives `d = z - shoreZ(x)` from the caller, so this module never
// has to import terrain.ts (which imports it).

import { fbm, smoothstep } from "./noise";

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

/**
 * Chapel ruin on a gorse knoll, far-western hinterland. 13 m – a glacial
 * knoll standing above the 8–12 m dune ridges, so the gable shows over the
 * intervening ridge from the western beach and the always-flowering gorse
 * hill is the brightest thing on that horizon.
 */
export const CHANTRY_KNOLL = { x: -285, z: 330, r: 46, h: 13, top: 12 };
/**
 * The three switchback paths up the knoll (resolved world polylines of
 * place-chantry.ts PATH_KNOTS) – grass keeps off them like off the boardwalk.
 */
export const CHANTRY_PATHS: ReadonlyArray<
  ReadonlyArray<readonly [number, number]>
> = [
  [
    [-246.7, 302.7],
    [-248.5, 313.7],
    [-261.5, 306.8],
    [-262.2, 317.5],
    [-271.7, 315.7],
    [-273.4, 322.1],
    [-275.1, 325.2],
  ],
  [
    [-327.5, 350.1],
    [-324.5, 336.4],
    [-313.3, 347.0],
    [-310.5, 335.0],
    [-301.5, 339.5],
    [-297.9, 333.9],
    [-295.8, 332.1],
  ],
  [
    [-274.9, 374.9],
    [-286.9, 369.0],
    [-275.8, 360.7],
    [-285.2, 355.0],
    [-280.1, 347.8],
    [-284.1, 343.0],
    [-283.3, 340.9],
  ],
];
/**
 * Grassed-over landfill mound, far north-east; yaw = long axis rotation.
 * 13 m so the crown stands clear over the 14 m dune ridge 66 m seaward of
 * it – the tip has to announce itself on the approach.
 */
export const OLD_TIP = { x: 235, z: 350, rx: 27, rz: 19, h: 13, yaw: 0.35 };
/**
 * Collapsed foredune front on East Beach: a 4 m scarp along inland distance
 * `dFace`, the raised bench behind it rejoining the dunes past `dTop`.
 */
export const BITTEN_EDGE = { x0: 138, x1: 182, dFace: 58, dTop: 72, drop: 4 };
/** Sunken green lane continuing the driving corridor north to the world edge. */
export const LANES_END = {
  z0: 300,
  sunk: 1.5,
  bankH: 0.8,
  halfCore: 16,
  gate: { x: 88, z: 372 },
};
/** Drystone bothy in the western pine belt. */
export const KELD_BOTHY = { x: -155, z: 360, clearing: 18 };
/**
 * The lighthouse: a red/white banded tower on its own knoll behind Rocky
 * Cape – the eastern counterpart to the chapel hill, visible along the whole
 * coast. The keeper's key hangs in the bothy across the map.
 */
export const LIGHTHOUSE = { x: 330, z: 150, r: 32, h: 6, top: 9 };
/** Worn footpath from the Cape beach up the lighthouse knoll. */
export const LIGHTHOUSE_PATH: ReadonlyArray<readonly [number, number]> = [
  [300, -22],
  [310, 24],
  [303, 62],
  [316, 98],
  [324, 126],
  [330, 148],
];
/** Pier piles run shore-normal at x; deck walkable to zDeck, piles to zEnd. */
export const OLD_PIER = { x: -150, zLand: -52, zDeck: -87, zEnd: -103 };
/** Cable-landing hut at the top of East Beach + its pole line inland. */
export const CABLE_HOUSE = { x: 128, z: 16 };
export const POLE_LINE: ReadonlyArray<readonly [number, number]> = [
  [140, 55],
  [165, 356],
];
/**
 * Wardens' boardwalk from the beach up to the camp, then the bare desire path
 * that continues north. The camp clearing (campSite(), ≈ (-27.5, 165)) is
 * skirted on its west side – the route is hard-coded here because this module
 * must not import landmark-camp.ts (import cycle via terrain.ts).
 */
export const BOARDWALK: ReadonlyArray<readonly [number, number]> = [
  [-30, 8],
  [-22, 40],
  [-38, 72],
  [-26, 104],
  [-36, 128],
  [-30, 148],
];
export const DESIRE_PATH: ReadonlyArray<readonly [number, number]> = [
  [-30, 148],
  [-44, 162],
  [-42, 190],
  [-36, 230],
  [-35, 275],
];

/** Centre line of the driving corridor (terrain.ts flatZone). */
export function laneCentreX(z: number): number {
  return 86 + Math.sin((z - 60) * 0.012) * 10;
}

/** Distance from (x, z) to a polyline. */
export function polylineDistance(
  pts: ReadonlyArray<readonly [number, number]>,
  x: number,
  z: number,
): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 1 < pts.length; i++) {
    const ax = pts[i][0];
    const az = pts[i][1];
    const bx = pts[i + 1][0] - ax;
    const bz = pts[i + 1][1] - az;
    const len2 = bx * bx + bz * bz;
    let t = len2 > 0 ? ((x - ax) * bx + (z - az) * bz) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = x - (ax + bx * t);
    const dz = z - (az + bz * t);
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < best) best = d;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Height
// ---------------------------------------------------------------------------

const TIP_COS = Math.cos(OLD_TIP.yaw);
const TIP_SIN = Math.sin(OLD_TIP.yaw);
/** Scratch result of tipLocal – terrainHeight calls this ~100k times at boot. */
const TIP_LOCAL = { lx: 0, lz: 0 };

/** Tip-local coordinates: lx along the long axis, lz across (−lz = seaward). */
function tipLocal(x: number, z: number): { lx: number; lz: number } {
  const wx = x - OLD_TIP.x;
  const wz = z - OLD_TIP.z;
  TIP_LOCAL.lx = wx * TIP_COS + wz * TIP_SIN;
  TIP_LOCAL.lz = -wx * TIP_SIN + wz * TIP_COS;
  return TIP_LOCAL;
}

/** Inland distance of the bitten edge's scarp line at x (wanders ±4 m). */
export function edgeFaceD(x: number): number {
  return BITTEN_EDGE.dFace + (fbm(x * 0.045 + 7, 3.1, 2) - 0.5) * 8;
}

/** Height of the scarp at x – the storm bit deeper in places. */
export function edgeFaceDrop(x: number): number {
  return BITTEN_EDGE.drop * (0.8 + 0.5 * fbm(x * 0.09 + 41, 5.7, 2));
}

/**
 * Where the bitten edge's scarp actually stands at x: the storm did not cut a
 * ruler line, so the face wanders ±4 m and bites deeper in places. Allocates –
 * for the place module; the terrain path uses edgeFaceD/edgeFaceDrop.
 */
export function edgeFace(x: number): { d: number; drop: number } {
  return { d: edgeFaceD(x), drop: edgeFaceDrop(x) };
}

function knollT(x: number, z: number): number {
  const r = Math.hypot(x - CHANTRY_KNOLL.x, z - CHANTRY_KNOLL.z);
  if (r >= CHANTRY_KNOLL.r) return 0;
  return 1 - smoothstep(CHANTRY_KNOLL.top, CHANTRY_KNOLL.r, r);
}

function lightKnollT(x: number, z: number): number {
  const r = Math.hypot(x - LIGHTHOUSE.x, z - LIGHTHOUSE.z);
  if (r >= LIGHTHOUSE.r) return 0;
  return 1 - smoothstep(LIGHTHOUSE.top, LIGHTHOUSE.r, r);
}

/** 0..1 how much the dune relief is damped (knoll and tip sit on clean ground). */
export function landformDamp(x: number, z: number, _d: number): number {
  let damp = Math.max(knollT(x, z), lightKnollT(x, z));
  const { lx, lz } = tipLocal(x, z);
  // The tip sits on levelled ground that reaches ~60 m seaward (the old
  // access yard) – without it the dune ridge in front hides the whole mound
  // from anyone approaching along the beach.
  const ez = lz < 0 ? lz / (OLD_TIP.rz * 2.6) : lz / OLD_TIP.rz;
  const e = Math.hypot(lx / (OLD_TIP.rx * 1.2), ez);
  if (e < 1.3) damp = Math.max(damp, 1 - smoothstep(0.9, 1.3, e));
  return damp;
}

/** Metres added to the terrain at (x, z); d = inland distance from the shore. */
export function landformAdd(x: number, z: number, d: number): number {
  let add = 0;

  // Chapel knoll: smooth dome with a flat top
  add += CHANTRY_KNOLL.h * knollT(x, z);
  // Lighthouse knoll behind Rocky Cape (flat crown for the tower's apron)
  add += LIGHTHOUSE.h * lightKnollT(x, z);

  // Old tip: an engineered, capped landfill dome – NOT a natural dune. The
  // outline wobbles (nothing man-piled is a perfect oval), the crown is a
  // gently domed cap with a rounded shoulder, ONE bench (the old haul road)
  // interrupts the flank, and low-amplitude noise keeps the faces from
  // reading as glass-smooth pudding.
  const { lx, lz } = tipLocal(x, z);
  const e0 = Math.hypot(lx / OLD_TIP.rx, lz / OLD_TIP.rz);
  if (e0 < 1.2) {
    const e = e0 * (1 + (fbm(x * 0.045 + 3.7, z * 0.045, 2) - 0.4375) * 0.24);
    if (e < 1.08) {
      let tt = 1 - smoothstep(0.3, 1.02, e);
      // gentle dome on the cap instead of a snooker-table top
      tt += 0.06 * (1 - smoothstep(0, 0.45, e));
      // the bench: a flat shelf at ~60 % of the flank
      const bench = smoothstep(0.52, 0.58, e) * (1 - smoothstep(0.66, 0.73, e));
      const benchT = 1 - smoothstep(0.3, 1.02, 0.6);
      tt = tt * (1 - bench * 0.75) + benchT * bench * 0.75;
      // settlement lumps and gullies on the flanks
      tt +=
        (fbm(x * 0.11 + 9.2, z * 0.11, 3) - 0.4375) *
        0.05 *
        smoothstep(0.12, 0.45, e) *
        (1 - smoothstep(0.88, 1.06, e));
      if (tt > 0) add += OLD_TIP.h * tt;
    }
  }

  // Bitten edge: the foredune front stands as a 4 m scarp, the bench behind
  // it rejoins the normal dune profile further inland
  const B = BITTEN_EDGE;
  const xw =
    smoothstep(B.x0 - 10, B.x0 + 4, x) *
    (1 - smoothstep(B.x1 - 4, B.x1 + 10, x));
  if (xw > 0) {
    const fd = edgeFaceD(x);
    const face =
      smoothstep(fd - 1, fd + 1.5, d) *
      (1 - smoothstep(B.dTop + 4, B.dTop + 28, d));
    add += edgeFaceDrop(x) * face * xw;
  }

  // Lane's End: the corridor sinks between turf hedgebanks north of z0
  const L = LANES_END;
  if (z > L.z0) {
    const a = Math.abs(x - laneCentreX(z));
    const ramp = smoothstep(L.z0, L.z0 + 20, z);
    const core = 1 - smoothstep(L.halfCore, L.halfCore + 6, a);
    add -= L.sunk * core * ramp;
    const bank =
      smoothstep(L.halfCore + 1, L.halfCore + 5, a) *
      (1 - smoothstep(L.halfCore + 7, L.halfCore + 11, a));
    add += L.bankH * bank * ramp;
    // The cattle grid is a rigid deck: cancel the terrain's fine surface
    // noise (the same term terrain.ts adds) under and around it, or the bars
    // float over local dips.
    const grid =
      core *
      smoothstep(L.gate.z - 8, L.gate.z - 3, z) *
      (1 - smoothstep(L.gate.z + 3, L.gate.z + 8, z));
    if (grid > 0) add -= (fbm(x * 0.09, z * 0.09, 3) - 0.5) * 0.5 * grid;
  }

  return add;
}

// ---------------------------------------------------------------------------
// Masks
// ---------------------------------------------------------------------------

/**
 * Multiplier for the grass/ground-cover placement probability at (x, z);
 * d = inland distance. 0 = bare (ruin floor, scarp face, lane floor, paths),
 * > 1 = lusher (the grassed-over tip).
 */
export function landformVegetation(x: number, z: number, d: number): number {
  let m = 1;
  // Chapel: bare nave (under its sand sheet) and forecourt on the plateau,
  // worn switchback paths
  const rk = Math.hypot(x - CHANTRY_KNOLL.x, z - CHANTRY_KNOLL.z);
  if (rk < 9) m = 0;
  else if (rk < 20) m *= 0.15 + 0.85 * smoothstep(14, 20, rk);
  if (rk < 60) {
    let pp = Number.POSITIVE_INFINITY;
    for (const p of CHANTRY_PATHS) {
      const d0 = polylineDistance(p, x, z);
      if (d0 < pp) pp = d0;
    }
    if (pp < 2) m *= pp < 1.2 ? 0 : 0.4;
  }
  // Old tip: coarse grass at full density on the crown, bare eroded scar on
  // the seaward flank
  const { lx, lz } = tipLocal(x, z);
  const e = Math.hypot(lx / OLD_TIP.rx, lz / OLD_TIP.rz);
  if (e < 1.1) {
    // A grassed-over tip: sward on the crown, thick on the terraces
    m *= e < 0.6 ? 3.5 : 2;
    if (lz < 0 && Math.abs(lx) < 9 && e > 0.45) m *= 0;
  }
  // Bitten edge: raw scarp face
  const B = BITTEN_EDGE;
  if (x > B.x0 - 6 && x < B.x1 + 6) {
    const fd = edgeFaceD(x);
    if (d > fd - 3 && d < fd + 6) m *= 0;
  }
  // Lane's End: bare lane floor, turf on the hedgebanks
  const L = LANES_END;
  if (z > L.z0) {
    const a = Math.abs(x - laneCentreX(z));
    if (a < L.halfCore + 1) m *= 0;
    else if (a < L.halfCore + 11) m *= 2;
  }
  // Boardwalk + desire path ribbon
  const pb = Math.min(
    polylineDistance(BOARDWALK, x, z),
    polylineDistance(DESIRE_PATH, x, z),
  );
  if (pb < 2) m *= pb < 1.2 ? 0 : 0.4;
  // Bothy floor and yard, pier abutment, cable house
  const rb = Math.hypot(x - KELD_BOTHY.x + 2, z - KELD_BOTHY.z - 3);
  if (rb < 4.5) m = 0;
  else if (rb < 9) m *= 0.25;
  // Lighthouse: bare concrete apron on the crown, worn path up the knoll
  const rl = Math.hypot(x - LIGHTHOUSE.x, z - LIGHTHOUSE.z);
  if (rl < 9) m = 0;
  else if (rl < 60) {
    const pl = polylineDistance(LIGHTHOUSE_PATH, x, z);
    if (pl < 2) m *= pl < 1.2 ? 0 : 0.4;
  }
  if (Math.hypot(x - OLD_PIER.x, z - OLD_PIER.zLand) < 5) m *= 0;
  if (Math.hypot(x - CABLE_HOUSE.x, z - CABLE_HOUSE.z) < 5) m *= 0;
  return m;
}

/** Pines keep out of the places (and the lane's northern continuation). */
export function landformKeepOut(x: number, z: number): boolean {
  if (Math.hypot(x - CHANTRY_KNOLL.x, z - CHANTRY_KNOLL.z) < 50) return true;
  if (Math.hypot(x - OLD_TIP.x, z - OLD_TIP.z) < 42) return true;
  if (Math.hypot(x - KELD_BOTHY.x, z - KELD_BOTHY.z) < KELD_BOTHY.clearing)
    return true;
  if (z > 290 && z < 440 && Math.abs(x - laneCentreX(z)) < 45) return true;
  if (polylineDistance(POLE_LINE, x, z) < 4) return true;
  if (polylineDistance(DESIRE_PATH, x, z) < 4) return true;
  // The walk's top reaches into the belt's inland ramp
  if (polylineDistance(BOARDWALK, x, z) < 4) return true;
  // The lighthouse knoll and its footpath
  if (Math.hypot(x - LIGHTHOUSE.x, z - LIGHTHOUSE.z) < 44) return true;
  if (polylineDistance(LIGHTHOUSE_PATH, x, z) < 4) return true;
  return false;
}

/**
 * A point on the tip's eroded seaward flank for the debris pocket (trash.ts):
 * the landfill bleeding out of the sand is where the metal and chemicals come
 * from.
 */
export function tipPocketPoint(rng: () => number): [number, number] {
  const lx = (rng() - 0.5) * OLD_TIP.rx * 1.1;
  const lz = -(OLD_TIP.rz * 0.55 + rng() * OLD_TIP.rz * 0.75);
  // Items are booked to East Beach (x < 240): keep them inside the sector so
  // the per-sector counts match where they lie.
  const x = Math.min(239, OLD_TIP.x + lx * TIP_COS - lz * TIP_SIN);
  return [x, OLD_TIP.z + lx * TIP_SIN + lz * TIP_COS];
}
