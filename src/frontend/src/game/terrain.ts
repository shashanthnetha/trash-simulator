// Analytical terrain (shoreline, height field, sectors). JS and GLSL use the
// same formulas. Deliberately without a Three.js import, so that ocean,
// vegetation, birds and sky can access it without import cycles.
//
// Cross-shore profile (d = distance from the shoreline):
//   d < 0     sea floor, drops to -7 m
//   0..55     flat beach – the gameplay happens here, stays unchanged
//   55..150   foredune: low, short sequence of ridges
//   from 80   dune field: shore-parallel ridges, ~78 m spacing, 8..12 m high
// The ridges are wind-shaped: long shallow windward flank facing the sea, short
// steep slip face (lee side) inland. A driving corridor from the beach to the
// recycling station (96, 118) and the station's forecourt stay flat; north of
// the station the corridor continues as a sunken lane to the world edge.
// The built places add their own landforms on top (landforms.ts): the chapel
// knoll, the old tip, the bitten dune edge and the lane's hedgebanks.

import { landformAdd, landformDamp } from "./landforms";
import { fbm, smoothstep } from "./noise";
import { SECTORS } from "./types";
import type { SectorDef } from "./types";

export const WORLD_BOUNDS = { minX: -378, maxX: 378, minZ: -110, maxZ: 380 };

/** Saturation height of the smooth beach profile in m. */
const BEACH_TOP = 7.5;
/** Ridge spacing of the two dune sequences in m. */
const L_MAIN = 78;
const L_FORE = 29;

/** Z coordinate of the water line at position x (land is at z > shoreZ). */
export function shoreZ(x: number): number {
  return -46 + Math.sin(x * 0.012) * 12 + Math.sin(x * 0.031 + 2.0) * 6;
}

/** How far the waves currently run up the beach (distance from the shoreline). */
export function waveReach(t: number): number {
  return 4.2 + Math.sin(t * 0.5) * 1.6 + Math.sin(t * 0.23 + 1.0) * 1.2;
}

/** Smooth beach profile without dunes (reference for dune relief/vegetation). */
export function beachProfile(d: number): number {
  return d <= 0 ? 0 : BEACH_TOP * (1 - Math.exp(-d * 0.011));
}

/**
 * Asymmetric ridge profile, 0 in the trough, 1 on the crest. `u` is the phase
 * in ridge spacings, `c` the position of the crest within the period: c close
 * to 1 = long shallow windward flank (seaward) and a short steep slip face
 * behind it.
 */
function ridge(u: number, c: number): number {
  const s = u - Math.floor(u);
  const t = s < c ? s / c : (1 - s) / (1 - c);
  return t * t * (3 - 2 * t);
}

/** Flat zones: driving corridor beach → station and its forecourt (0..1). */
function flatZone(x: number, z: number): number {
  // Wind gap between the dunes, gently curving all the way to the station
  const cx = 86 + Math.sin((z - 60) * 0.012) * 10;
  // Past the station the lane runs on as Lane's End, out of the play zone
  // into the haze (landforms.ts sinks it between hedgebanks from z 300)
  const lane =
    (1 - smoothstep(16, 40, Math.abs(x - cx))) *
    smoothstep(20, 62, z) *
    (1 - smoothstep(400, 440, z));
  // Forecourt of the recycling station
  const pad = 1 - smoothstep(15, 34, Math.hypot(x - 96, z - 118));
  return Math.max(lane, pad);
}

/** Dune relief above the beach profile (0 at the beach, ~14 m on the crests). */
function dunes(x: number, z: number, d: number): number {
  const main = smoothstep(80, 190, d);
  const fore = smoothstep(55, 150, d);
  // Main ridges run parallel to the coast and meander along the beach
  const w1 = (fbm(x * 0.0042 + 5.3, z * 0.0012, 2) - 0.375) * 100;
  const a1 =
    0.25 + 0.75 * smoothstep(0.22, 0.6, fbm(x * 0.0075 + 41, z * 0.0045, 3));
  let h = ridge((d + w1) / L_MAIN, 0.62) * 11.5 * a1 * main;
  // Foredune / shorter secondary ridges on the windward flanks
  const w2 = (fbm(x * 0.016 + 77, z * 0.005, 2) - 0.375) * 30;
  const a2 =
    0.3 + 0.7 * smoothstep(0.2, 0.55, fbm(x * 0.011 + 3.1, z * 0.007, 2));
  h += ridge((d + w2) / L_FORE, 0.56) * 3.0 * a2 * fore;
  // Blowouts and coarse relief between the ridges
  h += (fbm(x * 0.026 + 19, z * 0.02, 3) - 0.4375) * 2.4 * main;
  return h;
}

export function terrainHeight(x: number, z: number): number {
  const d = z - shoreZ(x);
  if (d < 0) {
    const h = Math.max(-7, d * 0.075);
    return h + (fbm(x * 0.05, z * 0.05, 2) - 0.5) * 0.3;
  }
  let h = BEACH_TOP * (1 - Math.exp(-d * 0.011));
  h += (fbm(x * 0.09, z * 0.09, 3) - 0.5) * 0.5;
  if (d > 55)
    h +=
      dunes(x, z, d) *
      (1 - 0.92 * flatZone(x, z)) *
      (1 - landformDamp(x, z, d));
  h += landformAdd(x, z, d);
  return h;
}

export function sectorAt(x: number): SectorDef {
  for (const s of SECTORS) {
    if (x >= s.x0 && x < s.x1) return s;
  }
  return x < 0 ? SECTORS[0] : SECTORS[SECTORS.length - 1];
}

/** GLSL counterpart to shoreZ()/waveReach() for terrain and ocean shaders. */
export const SHORE_GLSL = `
  float shoreZf(float x) {
    return -46.0 + sin(x * 0.012) * 12.0 + sin(x * 0.031 + 2.0) * 6.0;
  }
  float waveReachF(float t) {
    return 4.2 + sin(t * 0.5) * 1.6 + sin(t * 0.23 + 1.0) * 1.2;
  }
`;
