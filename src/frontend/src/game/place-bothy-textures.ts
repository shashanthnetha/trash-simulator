// Procedural textures for Keld Bothy (place-bothy.ts):
//
// pbrBothyStone()     1024² drystone granite/slate rubble in courses – u tiles
//                     every STONE_TILE_U metres, v is clamped and spans
//                     STONE_TILE_V metres from the plinth up: moss and damp in
//                     the joints of the lowest half metre, grey and orange
//                     lichen on the exposed faces, quartz flecks, tight dark
//                     joints with a real bevel in the height field.
// pbrBothySlate()     512² tileable roof slate: laminated blue-grey stone with
//                     rust-brown weathering and pale lichen discs.
// bothyDressPbr()     1024² opaque atlas: chipped enamel (plates, mug), rotten
//                     mattress ticking, cold hearth ash and the sand-and-needle
//                     litter of the floor drift.
// pbrBothyLimewash()  1024 × 512 limewashed interior wall (same rubble under
//                     a worn coat of lime; soot is applied per vertex).
// bothyDecalTexture() 1024 × 512 alpha atlas: the soot plume above the hearth,
//                     the scratched initials/tally marks beside the door, a
//                     loose scatter of pine needles and the worn path ribbon.
// bothyFoliageTexture() 256² alpha cutouts: nettle and dock leaves.
// All sets are deterministic and cached like the rest of the PBR library.

import type * as THREE from "three";
import {
  type PbrMaps,
  type Rgb,
  TexBuf,
  TexRng,
  blurField,
  cacheKey,
  cachedPbr,
  cachedTex,
  clamp01,
  drawScratches,
  hashPix,
  makeCanvas,
  noiseField,
  rgb,
  sstep,
  texFromCanvas,
} from "./textures-core";

/** Metres covered by one tile of the wall texture (u wraps, v clamps). */
export const STONE_TILE_U = 4.4;
export const STONE_TILE_V = 5.0;
/** Metres per u tile of the limewashed interior set (same v span). */
export const LIME_TILE_U = 8.8;

/**
 * One course of the exterior set is laid as fixed 0.6 m through-stones so
 * that quoins and dyke blocks can map each face onto a single clean stone:
 * BLOCK_U0(k) is the u of the k-th stone's inset start (0 ≤ k < BLOCK_N),
 * faces span at most BLOCK_LEN_U along u and BLOCK_DV up from BLOCK_V0.
 */
const BLOCK_LEN_M = 0.6;
const BLOCK_GAP_M = 0.02;
const BLOCK_H_M = 0.22;
const BLOCK_BOTTOM_V = 0.48;
export const BLOCK_N = 7;
export const BLOCK_V0 = BLOCK_BOTTOM_V + 0.012 / STONE_TILE_V;
export const BLOCK_DV = (BLOCK_H_M - 0.024) / STONE_TILE_V;
export const BLOCK_LEN_U = (BLOCK_LEN_M - 0.03) / STONE_TILE_U;
export function BLOCK_U0(k: number): number {
  return ((k % BLOCK_N) * (BLOCK_LEN_M + BLOCK_GAP_M) + 0.015) / STONE_TILE_U;
}

export type UvRegion = readonly [number, number, number, number];

/** Regions [u0, v0, u1, v1] (v upwards) of the opaque dressing atlas. */
export const DRESS_UV = {
  enamel: [0, 0.5, 0.5, 1] as UvRegion,
  ticking: [0.5, 0.5, 1, 1] as UvRegion,
  ash: [0, 0, 0.5, 0.5] as UvRegion,
  litter: [0.5, 0, 1, 0.5] as UvRegion,
} as const;

/** Regions of the alpha decal atlas (1024 × 512). */
export const DECAL_UV = {
  soot: [0, 0, 0.25, 1] as UvRegion,
  marks: [0.25, 0.5, 0.5, 1] as UvRegion,
  needles: [0.25, 0, 0.5, 0.5] as UvRegion,
  /** Worn path: u along the path, v across it. */
  path: [0.5, 0, 1, 1] as UvRegion,
} as const;

/** Regions of the foliage cutout atlas (leaf base at v = 0, tip at v = 1). */
export const FOLIAGE_UV = {
  nettle: [0, 0, 0.5, 1] as UvRegion,
  dock: [0.5, 0, 1, 1] as UvRegion,
} as const;

// ---------------------------------------------------------------------------
// Drystone wall
// ---------------------------------------------------------------------------

const STONE_PAL = [
  "#7f7b74",
  "#8a857b",
  "#6f6e6e",
  "#76736c",
  "#8b8479",
  "#6b6a68",
  "#7a7570",
  "#857f78",
  "#5f6266",
  "#8c8880",
  "#736f6a",
  "#9a948a",
];

interface StonePoly {
  pts: number[];
  cx: number;
  cy: number;
  /** Horizontal extent (canvas px) – decides whether it crosses the u seam. */
  x0: number;
  x1: number;
  col: string;
}

/** Fill a stone, repeating it across the u seam only where it crosses one. */
function fillWrapped(
  ctx: CanvasRenderingContext2D,
  s: StonePoly,
  W: number,
  scale: number,
): void {
  fillPoly(ctx, s, 0, scale);
  if (s.x0 < 4) fillPoly(ctx, s, W, scale);
  if (s.x1 > W - 4) fillPoly(ctx, s, -W, scale);
}

/** Irregular 8-point stone outline inside a rectangle (canvas px). */
function stonePoly(
  rng: TexRng,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): StonePoly {
  const h = y1 - y0;
  const w = x1 - x0;
  const jx = Math.min(w, h) * 0.07;
  const jy = h * 0.06;
  const c = [
    [x0 + rng.range(0, jx), y0 + rng.range(0, jy)],
    [x1 - rng.range(0, jx), y0 + rng.range(0, jy)],
    [x1 - rng.range(0, jx), y1 - rng.range(0, jy)],
    [x0 + rng.range(0, jx), y1 - rng.range(0, jy)],
  ];
  const pts: number[] = [];
  for (let k = 0; k < 4; k++) {
    const a = c[k];
    const b = c[(k + 1) % 4];
    pts.push(a[0], a[1]);
    // Bulge the edge midpoint outwards a little
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    const nx = b[1] - a[1];
    const ny = -(b[0] - a[0]);
    const nl = Math.hypot(nx, ny) || 1;
    const bulge = rng.range(0, 0.03) * Math.min(w, h);
    pts.push(mx + (nx / nl) * bulge, my + (ny / nl) * bulge);
  }
  // Each stone gets its own tone on top of the palette pick
  const base = rgb(STONE_PAL[rng.int(STONE_PAL.length)]);
  const k = rng.range(0.86, 1.1);
  const warm = rng.range(-0.02, 0.025);
  const ch = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return {
    pts,
    cx: (x0 + x1) / 2,
    cy: (y0 + y1) / 2,
    x0,
    x1,
    col: `#${ch(base[0] * k + warm)}${ch(base[1] * k)}${ch(base[2] * k - warm)}`,
  };
}

function fillPoly(
  ctx: CanvasRenderingContext2D,
  s: StonePoly,
  dx: number,
  scale: number,
): void {
  ctx.beginPath();
  for (let k = 0; k < s.pts.length; k += 2) {
    const x = s.cx + (s.pts[k] - s.cx) * scale + dx;
    const y = s.cy + (s.pts[k + 1] - s.cy) * scale;
    if (k === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

/**
 * Lay out the coursed rubble deterministically (canvas px, y downwards).
 * With `blockCourse` one course at BLOCK_BOTTOM_V is laid as fixed
 * through-stones (see BLOCK_U0).
 */
function layStones(
  rng: TexRng,
  W: number,
  H: number,
  tileU: number,
  tileV: number,
  blockCourse: boolean,
): StonePoly[] {
  const pxU = W / tileU;
  const pxV = H / tileV;
  const out: StonePoly[] = [];
  let y = H + 4;
  let blocksDone = !blockCourse;
  while (y > -60) {
    if (!blocksDone && y <= H * (1 - BLOCK_BOTTOM_V)) {
      const ch = BLOCK_H_M * pxV;
      for (let k = 0; k < BLOCK_N; k++) {
        const x0 = k * (BLOCK_LEN_M + BLOCK_GAP_M) * pxU;
        out.push(stonePoly(rng, x0, y - ch, x0 + BLOCK_LEN_M * pxU, y));
      }
      y -= ch + 2.5;
      blocksDone = true;
      continue;
    }
    const ch = (0.075 + rng.next() ** 1.3 * 0.14) * pxV;
    const gap = 1.4 + rng.next() * 2;
    let x = -rng.next() * 70;
    while (x < W) {
      const len = (0.11 + rng.next() ** 1.7 * 0.38) * pxU;
      // A pinning: two thin stones stacked in one slot
      if (rng.chance(0.32) && ch > 0.14 * pxV) {
        const mid = y - ch * rng.range(0.4, 0.6);
        out.push(stonePoly(rng, x, mid + gap * 0.5, x + len, y));
        out.push(stonePoly(rng, x, y - ch, x + len, mid - gap * 0.5));
      } else {
        out.push(stonePoly(rng, x, y - ch, x + len, y));
      }
      x += len + gap;
    }
    y -= ch + gap;
  }
  return out;
}

/**
 * Coursed drystone wall. u tiles horizontally every STONE_TILE_U m, v is
 * clamped and covers STONE_TILE_V m from the plinth (v = 0) upwards.
 * 1024², map + normal + roughness.
 */
export function pbrBothyStone(size = 1024): PbrMaps {
  return cachedPbr(cacheKey("bothyStone", [size]), () => {
    const W = size;
    const H = size;
    const rng = new TexRng(0xb07a1);
    const stones = layStones(rng, W, H, STONE_TILE_U, STONE_TILE_V, true);
    const JOINT: Rgb = rgb("#56514a");
    const WARM: Rgb = rgb("#8f8474");
    const COOL: Rgb = rgb("#6f7580");
    const QUARTZ: Rgb = rgb("#d8d4cc");
    const LICHEN: Rgb = rgb("#a3a892");
    const LICHEN_DARK: Rgb = rgb("#6e7a5c");
    const ORANGE: Rgb = rgb("#c9913c");
    const MOSS: Rgb = rgb("#4e5c2f");
    const buf = new TexBuf(W, H, JOINT, 0.9, 0);

    // Colour layer: every stone with its own tint, wrapped across the u seam
    const colL = buf.layer((ctx) => {
      for (const s of stones) {
        ctx.fillStyle = s.col;
        fillWrapped(ctx, s, W, 1);
      }
    });
    // Height layer: stepped insets → a bevelled, slightly domed face
    // Bevel: the stone presence blurred a few pixels gives a soft ramp at
    // every edge (no extra fill passes per stone – canvas paths are the
    // expensive part of this set)
    const mask = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) mask[i] = colL[i * 4 + 3] > 128 ? 1 : 0;
    blurField(mask, W, H, Math.max(1, Math.round(W / 340)), true, false, 2);

    const nFine = noiseField(W, H, 861, { freq: 90, oct: 2 });
    const nMid = noiseField(W, H, 862, { freq: 14, oct: 3 });
    const nLow = noiseField(W, H, 863, { freq: 3, oct: 3 });
    const nLich = noiseField(W, H, 864, { freq: 9, oct: 3 });
    const nLich2 = noiseField(W, H, 865, { freq: 4, oct: 2 });
    const nSpeck = noiseField(W, H, 866, { freq: 60, oct: 2, mode: "billow" });
    const nMoss = noiseField(W, H, 867, { freq: 12, oct: 3 });

    // Per-pixel pass on plain numbers – no allocations inside the loop
    buf.each((i, _u, v) => {
      const j = i * 4;
      const stone = colL[j + 3] > 128 ? 1 : 0;
      const m = mask[i];
      let r: number;
      let g: number;
      let b: number;
      let hgt: number;
      let ro: number;
      if (stone) {
        const k =
          0.84 +
          nFine[i] * 0.24 +
          (nMid[i] - 0.5) * 0.18 +
          (hashPix(i, 3) - 0.5) * 0.08;
        r = (colL[j] / 255) * k;
        g = (colL[j + 1] / 255) * k;
        b = (colL[j + 2] / 255) * k;
        const t = nLow[i];
        const tint = t > 0.5 ? WARM : COOL;
        const tw = Math.abs(t - 0.5) * 0.7;
        r += (tint[0] - r) * tw;
        g += (tint[1] - g) * tw;
        b += (tint[2] - b) * tw;
        if (hashPix(i, 7) > 0.989) {
          r += (QUARTZ[0] - r) * 0.55;
          g += (QUARTZ[1] - g) * 0.55;
          b += (QUARTZ[2] - b) * 0.55;
        }
        if (hashPix(i, 9) > 0.995) {
          r *= 0.5;
          g *= 0.5;
          b *= 0.52;
        }
        hgt = m * 0.85 + (nFine[i] - 0.5) * 0.1 + (hashPix(i, 11) - 0.5) * 0.05;
        ro = 0.8 - m * 0.05;
      } else {
        const k = 0.7 + nFine[i] * 0.45 + (nMid[i] - 0.5) * 0.2;
        r = JOINT[0] * k;
        g = JOINT[1] * k;
        b = JOINT[2] * k;
        hgt = (nFine[i] - 0.5) * 0.15 - 0.2;
        ro = 0.95;
      }
      // Lichen on the exposed faces, in colonies
      const colony = 0.35 + 0.65 * sstep(0.4, 0.62, nLich2[i]);
      const lic =
        sstep(0.6, 0.78, nLich[i]) * stone * sstep(0.25, 0.6, m) * colony;
      const lw = lic * 0.75;
      r += (LICHEN[0] - r) * lw;
      g += (LICHEN[1] - g) * lw;
      b += (LICHEN[2] - b) * lw;
      const dw = sstep(0.78, 0.9, nLich[i]) * stone * 0.35;
      r += (LICHEN_DARK[0] - r) * dw;
      g += (LICHEN_DARK[1] - g) * dw;
      b += (LICHEN_DARK[2] - b) * dw;
      const ow =
        sstep(0.86, 0.94, nSpeck[i]) * stone * colony * (1 - lic) * 0.6;
      r += (ORANGE[0] - r) * ow;
      g += (ORANGE[1] - g) * ow;
      b += (ORANGE[2] - b) * ow;
      hgt += lic * 0.06;
      ro += lic * 0.1;
      // Moss and damp in the lowest half metre, mostly in the joints
      const low = 1 - sstep(0.03, 0.13, v);
      const moss =
        low *
        (0.3 + 0.7 * (1 - stone * sstep(0.2, 0.6, m))) *
        sstep(0.3, 0.65, nMoss[i]);
      const mw = clamp01(moss * 1.2);
      r += (MOSS[0] - r) * mw;
      g += (MOSS[1] - g) * mw;
      b += (MOSS[2] - b) * mw;
      buf.r[i] = r * (1 - low * 0.2);
      buf.g[i] = g * (1 - low * 0.18);
      buf.b[i] = b * (1 - low * 0.17);
      buf.hf[i] = hgt + moss * 0.12;
      buf.rough[i] = ro + moss * 0.12;
    });
    return buf.build({ normal: 2.4, normalScale: 0.75, wrapV: false });
  });
}

/**
 * Limewashed interior wall: the same rubble under a patchy coat of lime that
 * has worn through to the stone in places, filled and softened joints,
 * dirt streaks running down, mould and damp in the lowest half metre. The
 * soot near the hearth is applied per vertex by the bothy. 1024 × 512,
 * u tiles every LIME_TILE_U m, v clamps over STONE_TILE_V m.
 */
export function pbrBothyLimewash(size = 1024): PbrMaps {
  return cachedPbr(cacheKey("bothyLimewash", [size]), () => {
    const W = size;
    const H = size / 2;
    const rng = new TexRng(0x11e5);
    const stones = layStones(rng, W, H, LIME_TILE_U, STONE_TILE_V, false);
    const JOINT: Rgb = rgb("#6a655c");
    const LIME: Rgb = rgb("#d9d4c6");
    const LIME_WARM: Rgb = rgb("#e0d7c4");
    const LIME_COOL: Rgb = rgb("#ccceca");
    const GRIME: Rgb = rgb("#8c877c");
    const DAMP: Rgb = rgb("#6f7462");
    const buf = new TexBuf(W, H, JOINT, 0.9, 0);
    const colL = buf.layer((ctx) => {
      for (const s of stones) {
        ctx.fillStyle = s.col;
        fillWrapped(ctx, s, W, 1);
      }
    });
    // Bevel: the stone presence blurred a few pixels gives a soft ramp at
    // every edge (no extra fill passes per stone – canvas paths are the
    // expensive part of this set)
    const mask = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) mask[i] = colL[i * 4 + 3] > 128 ? 1 : 0;
    blurField(mask, W, H, Math.max(1, Math.round(W / 340)), true, false, 2);

    const nFine = noiseField(W, H, 901, { freq: 90, oct: 2 });
    const nMid = noiseField(W, H, 902, { freq: 14, oct: 3 });
    const nWear = noiseField(W, H, 903, { freq: 5, oct: 4 });
    const nLow = noiseField(W, H, 904, { freq: 3, oct: 3 });
    const nStreak = noiseField(W, H, 905, { freq: 60, freqY: 3, oct: 2 });
    const nDamp = noiseField(W, H, 906, { freq: 10, oct: 3 });
    buf.each((i, _u, v) => {
      const j = i * 4;
      const stone = colL[j + 3] > 128 ? 1 : 0;
      const m = mask[i];
      let r: number;
      let g: number;
      let b: number;
      if (stone) {
        const k = 0.86 + nFine[i] * 0.2 + (nMid[i] - 0.5) * 0.14;
        r = (colL[j] / 255) * k;
        g = (colL[j + 1] / 255) * k;
        b = (colL[j + 2] / 255) * k;
      } else {
        const k = 0.8 + nFine[i] * 0.35;
        r = JOINT[0] * k;
        g = JOINT[1] * k;
        b = JOINT[2] * k;
      }
      // Lime coat, worn through in patches and thinner over the bevels
      const wear =
        sstep(0.26, 0.48, nWear[i]) *
        (stone ? 0.75 + 0.25 * (1 - sstep(0.7, 1, m)) : 1);
      const t = nLow[i];
      const tint = t > 0.5 ? LIME_WARM : LIME_COOL;
      const tw = Math.abs(t - 0.5) * 1.4;
      const lk = 0.94 + nFine[i] * 0.1 + (hashPix(i, 31) - 0.5) * 0.04;
      const lr = (LIME[0] + (tint[0] - LIME[0]) * tw) * lk;
      const lg = (LIME[1] + (tint[1] - LIME[1]) * tw) * lk;
      const lb = (LIME[2] + (tint[2] - LIME[2]) * tw) * lk;
      const cw = wear * (stone ? 0.9 : 0.82);
      r += (lr - r) * cw;
      g += (lg - g) * cw;
      b += (lb - b) * cw;
      // Dirt streaks running down, grime in the worn patches
      const gw = sstep(0.62, 0.84, nStreak[i]) * 0.2 + (1 - wear) * 0.25;
      r += (GRIME[0] - r) * gw;
      g += (GRIME[1] - g) * gw;
      b += (GRIME[2] - b) * gw;
      if (hashPix(i, 37) > 0.997) {
        r *= 0.7;
        g *= 0.7;
        b *= 0.68;
      }
      // Damp and mould low down
      const low = 1 - sstep(0.04, 0.14, v);
      const dw = low * (0.35 + 0.4 * sstep(0.4, 0.7, nDamp[i]));
      r += (DAMP[0] - r) * dw;
      g += (DAMP[1] - g) * dw;
      b += (DAMP[2] - b) * dw;
      buf.r[i] = r * (1 - low * 0.15);
      buf.g[i] = g * (1 - low * 0.13);
      buf.b[i] = b * (1 - low * 0.14);
      buf.hf[i] =
        (stone ? m * 0.5 : -0.1) * (0.45 + 0.55 * (1 - wear)) +
        (nFine[i] - 0.5) * 0.06 +
        wear * nMid[i] * 0.05;
      buf.rough[i] =
        0.88 - wear * 0.02 + low * 0.06 + (1 - wear) * (stone ? -0.06 : 0.05);
    });
    return buf.build({ normal: 2.0, normalScale: 0.6, wrapV: false });
  });
}

// ---------------------------------------------------------------------------
// Roof slate
// ---------------------------------------------------------------------------

/** Laminated blue-grey slate with rust weathering and lichen discs. 512². */
export function pbrBothySlate(size = 512): PbrMaps {
  return cachedPbr(cacheKey("bothySlate", [size]), () => {
    const S = size;
    const BASE: Rgb = rgb("#4b5058");
    const RUST: Rgb = rgb("#6e5d4d");
    const PURPLE: Rgb = rgb("#575062");
    const LICHEN: Rgb = rgb("#aaab9c");
    const buf = new TexBuf(S, S, BASE, 0.74, 0);
    const nLam = noiseField(S, S, 871, { freq: 3, freqY: 44, oct: 3 });
    const nW = noiseField(S, S, 872, { freq: 4, oct: 3 });
    const nLich = noiseField(S, S, 873, { freq: 11, oct: 2, mode: "billow" });
    const nFine = noiseField(S, S, 874, { freq: 70, oct: 2 });
    buf.each((i) => {
      const k = 0.85 + nFine[i] * 0.2 + (nLam[i] - 0.5) * 0.28;
      let r = BASE[0] * k;
      let g = BASE[1] * k;
      let b = BASE[2] * k;
      const rw = sstep(0.6, 0.85, nW[i]) * 0.45;
      r += (RUST[0] - r) * rw;
      g += (RUST[1] - g) * rw;
      b += (RUST[2] - b) * rw;
      const pw = sstep(0.3, 0.5, nW[i]) * (1 - sstep(0.5, 0.7, nW[i])) * 0.4;
      r += (PURPLE[0] - r) * pw;
      g += (PURPLE[1] - g) * pw;
      b += (PURPLE[2] - b) * pw;
      const lic = sstep(0.8, 0.9, nLich[i]);
      const lw = hashPix(i, 13) > 0.996 ? Math.max(lic * 0.8, 0.5) : lic * 0.8;
      r += (LICHEN[0] - r) * lw;
      g += (LICHEN[1] - g) * lw;
      b += (LICHEN[2] - b) * lw;
      buf.r[i] = r;
      buf.g[i] = g;
      buf.b[i] = b;
      buf.hf[i] = (nLam[i] - 0.5) * 0.4 + (nFine[i] - 0.5) * 0.15 + lic * 0.1;
      buf.rough[i] = 0.72 + lic * 0.15 + (nW[i] - 0.5) * 0.1;
    });
    return buf.build({ normal: 3, normalScale: 0.6 });
  });
}

// ---------------------------------------------------------------------------
// Dressing atlas (opaque)
// ---------------------------------------------------------------------------

const NEEDLE_PAL = ["#8a5a2e", "#a06f3a", "#6e4a25", "#b58b55", "#7c5a33"];

/** Pine needles, twigs and a few cone scales into a canvas rectangle. */
function drawNeedles(
  ctx: CanvasRenderingContext2D,
  rng: TexRng,
  x0: number,
  y0: number,
  w: number,
  h: number,
  count: number,
  alpha: number,
): void {
  ctx.lineCap = "round";
  // Thousands of needles in ten stroke calls: one Path2D per colour and
  // weight (a stroke() per needle was the slowest thing in the whole set)
  const paths: Path2D[] = [];
  for (let k = 0; k < NEEDLE_PAL.length * 2; k++) paths.push(new Path2D());
  for (let k = 0; k < count; k++) {
    const x = x0 + rng.next() * w;
    const y = y0 + rng.next() * h;
    const ang = rng.next() * Math.PI + rng.gauss() * 0.4;
    const len = 8 + rng.next() ** 1.3 * 14;
    const bend = rng.gauss() * 3;
    const p = paths[rng.int(NEEDLE_PAL.length) * 2 + (rng.chance(0.5) ? 1 : 0)];
    p.moveTo(x, y);
    p.quadraticCurveTo(
      x + Math.cos(ang) * len * 0.5 - Math.sin(ang) * bend,
      y + Math.sin(ang) * len * 0.5 + Math.cos(ang) * bend,
      x + Math.cos(ang) * len,
      y + Math.sin(ang) * len,
    );
  }
  for (let k = 0; k < paths.length; k++) {
    ctx.strokeStyle = NEEDLE_PAL[k >> 1];
    ctx.globalAlpha = alpha * (k % 2 === 0 ? 0.62 : 0.85);
    ctx.lineWidth = k % 2 === 0 ? 1.2 : 1.7;
    ctx.stroke(paths[k]);
  }
  // Twigs
  const twigs = new Path2D();
  for (let k = 0; k < count / 60; k++) {
    const x = x0 + rng.next() * w;
    const y = y0 + rng.next() * h;
    const ang = rng.next() * Math.PI;
    const len = 22 + rng.next() * 34;
    twigs.moveTo(x, y);
    twigs.lineTo(
      x + Math.cos(ang) * len + rng.gauss() * 4,
      y + Math.sin(ang) * len + rng.gauss() * 4,
    );
  }
  ctx.strokeStyle = "#5f4d3a";
  ctx.globalAlpha = alpha * 0.85;
  ctx.lineWidth = 2.3;
  ctx.stroke(twigs);
  // Cone scales
  const scales = new Path2D();
  for (let k = 0; k < count / 30; k++) {
    const x = x0 + rng.next() * w;
    const y = y0 + rng.next() * h;
    scales.moveTo(x, y);
    scales.ellipse(
      x,
      y,
      rng.range(3, 5),
      rng.range(2, 3),
      rng.next() * Math.PI,
      0,
      Math.PI * 2,
    );
  }
  ctx.fillStyle = "#664f38";
  ctx.globalAlpha = alpha;
  ctx.fill(scales);
  ctx.globalAlpha = 1;
}

/**
 * Opaque dressing atlas: chipped cream enamel with a navy rim (top left,
 * v = 1 is the rim), rotten blue-striped ticking (top right), cold ash
 * (bottom left) and the floor litter of sand and pine needles (bottom right).
 * 1024², map + normal + roughness.
 */
export function bothyDressPbr(size = 1024): PbrMaps {
  return cachedPbr(cacheKey("bothyDress", [size]), () => {
    const S = size;
    const HALF = S / 2;
    /** Vector layers are drawn in 512-px region coordinates and scaled. */
    const f = HALF / 512;
    const rng = new TexRng(0xd4e55);
    const CREAM: Rgb = rgb("#e8e4d8");
    const NAVY: Rgb = rgb("#232a3a");
    const RUST_STAIN: Rgb = rgb("#8a5a36");
    const OFFWHITE: Rgb = rgb("#cbc4b3");
    const BLUE: Rgb = rgb("#6f7f92");
    const BROWN: Rgb = rgb("#6a5238");
    const DARK_BROWN: Rgb = rgb("#4a3826");
    const HOLE: Rgb = rgb("#241f1a");
    const ASH: Rgb = rgb("#a09c96");
    const ASH_PALE: Rgb = rgb("#c8c4bd");
    const CHAR: Rgb = rgb("#1c1a18");
    const SAND: Rgb = rgb("#cbb389");
    const SAND_DAMP: Rgb = rgb("#a8916c");
    const buf = new TexBuf(S, S, CREAM, 0.6, 0);

    // Vector layers: enamel chips + scratches (top left), needles (bottom right)
    const chipL = buf.layer((ctx) => {
      ctx.save();
      ctx.scale(f, f);
      for (let k = 0; k < 70; k++) {
        // more chips towards the rim (top of the region)
        const t = rng.next() ** 2.2;
        const x = rng.next() * 512;
        const y = t * 512 * 0.9;
        const r = rng.range(2, 11);
        ctx.fillStyle = "rgba(244,242,234,0.9)";
        ctx.beginPath();
        ctx.ellipse(
          x,
          y,
          r + 1.6,
          r * rng.range(0.5, 1) + 1.6,
          rng.next() * Math.PI,
          0,
          Math.PI * 2,
        );
        ctx.fill();
        ctx.fillStyle = "rgba(30,34,43,1)";
        ctx.beginPath();
        ctx.ellipse(
          x,
          y,
          r,
          r * rng.range(0.5, 1),
          rng.next() * Math.PI,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      ctx.beginPath();
      ctx.rect(0, 0, 512, 512);
      ctx.clip();
      drawScratches(ctx, rng, 512, 512, 60, 60, 1.1, 0.35);
      ctx.restore();
    });
    const needleL = buf.layer((ctx) => {
      ctx.save();
      ctx.translate(HALF, HALF);
      ctx.scale(f, f);
      ctx.beginPath();
      ctx.rect(0, 0, 512, 512);
      ctx.clip();
      drawNeedles(ctx, rng, -20, -20, 552, 552, 1500, 0.95);
      ctx.restore();
    });

    const nFine = noiseField(S, S, 881, { freq: 80, oct: 2 });
    // Fields only one or two quadrants read are quadrant-sized and indexed
    // with the quadrant-local pixel index q (a quarter of the work each)
    const nMid = noiseField(HALF, HALF, 882, { freq: 4, oct: 4 });
    const nRot = noiseField(HALF, HALF, 883, { freq: 2.5, oct: 4 });
    const nHole = noiseField(HALF, HALF, 884, {
      freq: 3.5,
      oct: 3,
      mode: "billow",
    });
    const nCrack = noiseField(HALF, HALF, 885, {
      freq: 6,
      oct: 4,
      mode: "ridged",
    });
    const nAsh = noiseField(HALF, HALF, 886, {
      freq: 3,
      oct: 3,
      mode: "billow",
    });
    const nSand = noiseField(HALF, HALF, 887, { freq: 5, oct: 4 });

    // Per-pixel pass on plain numbers – no allocations inside the loop
    buf.each((i, u, v, x, y) => {
      const j = i * 4;
      const q = (y % HALF) * HALF + (x % HALF);
      let r: number;
      let g: number;
      let b: number;
      let hgt = 0;
      let ro = 0.9;
      if (v >= 0.5) {
        if (u < 0.5) {
          // Enamel: cream with fine crazing, navy rim, chips through to iron
          const t = (v - 0.5) * 2;
          const k = 0.95 + nFine[i] * 0.06 + (nMid[q] - 0.5) * 0.04;
          r = CREAM[0] * k;
          g = CREAM[1] * k;
          b = CREAM[2] * k;
          const rim = sstep(0.945, 0.955, t);
          r += (NAVY[0] - r) * rim;
          g += (NAVY[1] - g) * rim;
          b += (NAVY[2] - b) * rim;
          const stain =
            sstep(0.72, 0.85, nRot[q]) * (1 - sstep(0.6, 0.85, t)) * 0.45;
          r += (RUST_STAIN[0] - r) * stain;
          g += (RUST_STAIN[1] - g) * stain;
          b += (RUST_STAIN[2] - b) * stain;
          const chip = chipL[j + 3] / 255;
          if (chip > 0.01) {
            r += (chipL[j] / 255 - r) * chip;
            g += (chipL[j + 1] / 255 - g) * chip;
            b += (chipL[j + 2] / 255 - b) * chip;
          }
          const dark = chipL[j] < 100 && chip > 0.5 ? 1 : 0;
          hgt = -dark * 0.4 + (nFine[i] - 0.5) * 0.03;
          ro =
            0.3 +
            dark * 0.45 +
            stain * 0.78 +
            rim * 0.05 +
            chip * (1 - dark) * 0.15;
        } else {
          // Ticking: two blue stripes per period, faded, rot-stained, holed
          const s = (u - 0.5) * 2;
          const p = s * 14 - Math.floor(s * 14);
          const stripe = (p < 0.16 ? 1 : p >= 0.5 && p < 0.58 ? 1 : 0) * 0.8;
          const weave = 0.92 + nFine[i] * 0.14 + (hashPix(i, 17) - 0.5) * 0.08;
          r = (OFFWHITE[0] + (BLUE[0] - OFFWHITE[0]) * stripe) * weave;
          g = (OFFWHITE[1] + (BLUE[1] - OFFWHITE[1]) * stripe) * weave;
          b = (OFFWHITE[2] + (BLUE[2] - OFFWHITE[2]) * stripe) * weave;
          const rr = nRot[q];
          const fill = sstep(0.55, 0.62, rr) * (1 - sstep(0.72, 0.8, rr));
          const rim =
            sstep(0.53, 0.56, rr) * (1 - sstep(0.56, 0.6, rr)) +
            sstep(0.78, 0.8, rr) * (1 - sstep(0.8, 0.83, rr));
          const fw = fill * 0.5;
          r += (BROWN[0] - r) * fw;
          g += (BROWN[1] - g) * fw;
          b += (BROWN[2] - b) * fw;
          const rw = rim * 0.6;
          r += (DARK_BROWN[0] - r) * rw;
          g += (DARK_BROWN[1] - g) * rw;
          b += (DARK_BROWN[2] - b) * rw;
          if (hashPix(i, 19) > 0.995) {
            r *= 0.4;
            g *= 0.4;
            b *= 0.4;
          }
          const hole = sstep(0.88, 0.93, nHole[q]);
          r += (HOLE[0] - r) * hole;
          g += (HOLE[1] - g) * hole;
          b += (HOLE[2] - b) * hole;
          const grime = 0.72 + 0.28 * nMid[q];
          r *= grime;
          g *= grime;
          b *= grime;
          hgt = (nFine[i] - 0.5) * 0.12 - hole * 0.35 + fill * 0.03;
          ro = 0.9 + hole * 0.05;
        }
      } else if (u < 0.5) {
        // Cold ash: grey powder, pale drifts, charcoal cracks and bits
        const pale = sstep(0.45, 0.75, nAsh[q]);
        const pw = pale * 0.8;
        r = ASH[0] + (ASH_PALE[0] - ASH[0]) * pw;
        g = ASH[1] + (ASH_PALE[1] - ASH[1]) * pw;
        b = ASH[2] + (ASH_PALE[2] - ASH[2]) * pw;
        const crack = sstep(0.7, 0.9, nCrack[q]);
        const cw = hashPix(i, 23) > 0.997 ? 0.9 : crack * 0.85;
        r += (CHAR[0] - r) * cw;
        g += (CHAR[1] - g) * cw;
        b += (CHAR[2] - b) * cw;
        const k = 0.9 + nFine[i] * 0.18;
        r *= k;
        g *= k;
        b *= k;
        hgt = -crack * 0.5 + pale * 0.2 + (nFine[i] - 0.5) * 0.15;
        ro = 0.95 - crack * 0.05;
      } else {
        // Floor litter: sand darkened by the roof shade, needles on top
        const k = 0.9 + nFine[i] * 0.16 + (hashPix(i, 29) - 0.5) * 0.1;
        const dw = sstep(0.55, 0.8, nSand[q]) * 0.5;
        r = (SAND[0] + (SAND_DAMP[0] - SAND[0]) * dw) * k;
        g = (SAND[1] + (SAND_DAMP[1] - SAND[1]) * dw) * k;
        b = (SAND[2] + (SAND_DAMP[2] - SAND[2]) * dw) * k;
        const a = needleL[j + 3] / 255;
        if (a > 0.01) {
          r += (needleL[j] / 255 - r) * a;
          g += (needleL[j + 1] / 255 - g) * a;
          b += (needleL[j + 2] / 255 - b) * a;
        }
        hgt = (nFine[i] - 0.5) * 0.1 + a * 0.35;
        ro = 0.9 - a * 0.08;
      }
      buf.r[i] = r;
      buf.g[i] = g;
      buf.b[i] = b;
      buf.hf[i] = hgt;
      buf.rough[i] = ro;
    });
    return buf.build({
      normal: 3,
      normalScale: 0.7,
      wrapU: false,
      wrapV: false,
    });
  });
}

// ---------------------------------------------------------------------------
// Decal atlas (alpha)
// ---------------------------------------------------------------------------

/** Scratched marks: light scratch with a thin dark shadow, jittered strokes. */
function scratchText(
  ctx: CanvasRenderingContext2D,
  rng: TexRng,
  text: string,
  x: number,
  y: number,
  size: number,
  rot: number,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.font = `bold ${size}px 'Segoe Print', 'Bradley Hand', 'Comic Sans MS', cursive`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(28,26,23,0.55)";
  ctx.lineWidth = 1.6;
  ctx.strokeText(text, 1.2, 1.4);
  ctx.strokeStyle = "rgba(218,214,204,0.8)";
  for (let k = 0; k < 3; k++) {
    ctx.lineWidth = 1.1 + rng.next() * 0.6;
    ctx.strokeText(text, rng.gauss() * 0.7, rng.gauss() * 0.7);
  }
  ctx.restore();
}

function tallyGroup(
  ctx: CanvasRenderingContext2D,
  rng: TexRng,
  x: number,
  y: number,
  n: number,
): void {
  const h = 22;
  const sp = 7.5;
  const line = (x0: number, y0: number, x1: number, y1: number) => {
    ctx.strokeStyle = "rgba(28,26,23,0.5)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x0 + 1, y0 + 1.2);
    ctx.lineTo(x1 + 1, y1 + 1.2);
    ctx.stroke();
    ctx.strokeStyle = "rgba(220,216,206,0.85)";
    ctx.lineWidth = 1.3 + rng.next() * 0.5;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  };
  for (let k = 0; k < Math.min(4, n); k++) {
    const jx = rng.gauss() * 1.2;
    line(
      x + k * sp + jx,
      y + rng.gauss(),
      x + k * sp + jx + rng.gauss() * 1.5,
      y + h,
    );
  }
  if (n >= 5) line(x - 3, y + h - 3, x + 3 * sp + 4, y + 4);
}

/**
 * Alpha decal atlas (1024 × 512): soot plume (left quarter, rises with v),
 * scratched initials and tally marks, loose pine needles, and the worn
 * compacted-sand path (right half: u along, v across). Colour + alpha,
 * clamped both ways.
 */
export function bothyDecalTexture(size = 1024): THREE.Texture {
  return cachedTex(cacheKey("bothyDecal", [size]), () => {
    const W = size;
    const S = size / 2;
    const H2 = S / 2;
    /** Vector work is drawn in 512-px atlas coordinates and scaled. */
    const f = S / 512;
    const rng = new TexRng(0xdeca1);
    const [c, ctx] = makeCanvas(W, S);
    ctx.clearRect(0, 0, W, S);

    // Soot plume: pixel pass on the left quarter
    const img = ctx.createImageData(H2, S);
    const d = img.data;
    const nS = noiseField(H2, S, 891, { freq: 6, freqY: 3, oct: 3 });
    const nF = noiseField(H2, S, 892, { freq: 20, freqY: 40, oct: 2 });
    for (let y = 0; y < S; y++) {
      const t = 1 - (y + 0.5) / S; // 0 at the lintel, 1 at the top
      for (let x = 0; x < H2; x++) {
        const i = y * H2 + x;
        const s = (x + 0.5) / H2;
        const w = 0.5 * (1 - 0.42 * t) * (0.85 + 0.3 * nS[i]);
        const core = clamp01(1 - Math.abs(s - 0.5) / w) ** 1.3;
        const fade = (1 - t) ** 0.9 * (0.4 + 0.6 * (1 - sstep(0.7, 1, t)));
        let a = core * fade * (0.5 + 0.5 * nS[i]) * (0.85 + 0.3 * nF[i]);
        a = Math.max(a, core * (1 - sstep(0, 0.14, t)) * 0.92);
        a = clamp01(a * 0.95);
        const j = i * 4;
        const tone = 18 + nF[i] * 14;
        d[j] = tone;
        d[j + 1] = tone * 0.92;
        d[j + 2] = tone * 0.8;
        d[j + 3] = a * 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    // Scratched marks (region right of the soot, upper half)
    ctx.save();
    ctx.translate(H2, 0);
    ctx.scale(f, f);
    scratchText(ctx, rng, "A.K.", 22, 62, 42, -0.06);
    scratchText(ctx, rng, "1953", 130, 68, 34, 0.04);
    scratchText(ctx, rng, "T.R.", 34, 126, 36, 0.05);
    scratchText(ctx, rng, "KELD", 128, 132, 26, -0.03);
    for (let g = 0; g < 5; g++) {
      tallyGroup(ctx, rng, 26 + g * 44, 178, g < 4 ? 5 : 3);
    }
    tallyGroup(ctx, rng, 26, 214, 5);
    tallyGroup(ctx, rng, 70, 214, 2);
    ctx.restore();

    // Loose needles (below the marks)
    ctx.save();
    ctx.translate(H2, H2);
    ctx.scale(f, f);
    ctx.beginPath();
    ctx.rect(0, 0, 256, 256);
    ctx.clip();
    drawNeedles(ctx, rng, 0, 0, 256, 256, 420, 0.92);
    ctx.restore();

    // Worn path (right half): a wandering ribbon of compacted, greyer sand,
    // soft at the sides and both ends, with boot smudges along the middle.
    // Along = 8 m over 512 px, across = 1.2 m over 512 px.
    const pimg = ctx.createImageData(S, S);
    const pd = pimg.data;
    const nM = noiseField(S, S, 893, { freq: 40, freqY: 6, oct: 3 });
    const nG = noiseField(S, S, 894, { freq: 120, freqY: 18, oct: 2 });
    const nW = noiseField(S, 1, 895, { freq: 3, freqY: 1, oct: 2 });
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const along = (x + 0.5) / S;
        const across = ((y + 0.5) / S) * 2 - 1 + (nW[x] - 0.5) * 0.4;
        const side = sstep(0.05, 0.5, 1 - Math.abs(across));
        const ends = sstep(0, 0.1, along) * (1 - sstep(0.86, 1, along));
        const a = clamp01(side * ends * (0.55 + 0.45 * nM[i]) * 0.6);
        const k = 0.9 + nG[i] * 0.2;
        const j = i * 4;
        pd[j] = 170 * k;
        pd[j + 1] = 146 * k;
        pd[j + 2] = 108 * k;
        pd[j + 3] = a * 255;
      }
    }
    ctx.putImageData(pimg, S, 0);
    ctx.save();
    ctx.translate(S, 0);
    ctx.scale(f, f);
    ctx.beginPath();
    ctx.rect(0, 0, 512, 512);
    ctx.clip();
    for (let k = 0; k < 44; k++) {
      const px = 30 + rng.next() * 452;
      const py =
        256 + (k % 2 === 0 ? -1 : 1) * rng.range(14, 46) + rng.gauss() * 10;
      ctx.fillStyle = `rgba(78,60,38,${rng.range(0.16, 0.3)})`;
      ctx.beginPath();
      ctx.ellipse(
        px,
        py,
        rng.range(7, 10),
        rng.range(22, 30),
        rng.gauss() * 0.15,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
    ctx.restore();

    return texFromCanvas(c, true, false, false);
  });
}

// ---------------------------------------------------------------------------
// Foliage cutouts
// ---------------------------------------------------------------------------

/** Leaf outline as a closed path: half-width profile w(t) from base (t = 0) to tip. */
function leafPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yBase: number,
  yTip: number,
  w: (t: number) => number,
): void {
  const N = 48;
  ctx.beginPath();
  ctx.moveTo(cx, yBase);
  for (let k = 1; k <= N; k++) {
    const t = k / N;
    ctx.lineTo(cx + w(t), yBase + (yTip - yBase) * t);
  }
  for (let k = N - 1; k >= 1; k--) {
    const t = k / N;
    ctx.lineTo(cx - w(t), yBase + (yTip - yBase) * t);
  }
  ctx.closePath();
}

/**
 * Foliage atlas: a serrated nettle leaf (left) and a broad dock leaf with a
 * red midrib and rust spots (right). Leaf base at the bottom (v = 0), tip at
 * the top. 256², colour + alpha, for an alpha-tested material.
 */
export function bothyFoliageTexture(): THREE.Texture {
  return cachedTex(cacheKey("bothyFoliage", []), () => {
    const S = 256;
    const H2 = S / 2;
    const rng = new TexRng(0xf01a);
    const [c, ctx] = makeCanvas(S, S);
    ctx.clearRect(0, 0, S, S);

    // Nettle: ovate, coarsely serrated, dark green with pale veins
    const serr = (t: number) =>
      3.2 *
      (Math.floor(t * 26) % 2 === 0 ? 1 : -1) *
      sstep(0.08, 0.3, t) *
      (1 - sstep(0.85, 1, t));
    const nw = (t: number) =>
      46 * Math.sin(Math.PI * t ** 0.75) ** 0.85 * (1 - 0.12 * t) + serr(t);
    leafPath(ctx, H2 / 2, S - 6, 6, nw);
    const ng = ctx.createLinearGradient(0, S, 0, 0);
    ng.addColorStop(0, "#3a5726");
    ng.addColorStop(1, "#4f7434");
    ctx.fillStyle = ng;
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = "rgba(150,178,110,0.75)";
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(H2 / 2, S - 6);
    ctx.lineTo(H2 / 2, 12);
    ctx.stroke();
    ctx.lineWidth = 1.2;
    for (let k = 0; k < 7; k++) {
      const y = S - 30 - k * 30;
      for (const sgn of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(H2 / 2, y);
        ctx.quadraticCurveTo(
          H2 / 2 + sgn * 18,
          y - 14,
          H2 / 2 + sgn * 40,
          y - 26,
        );
        ctx.stroke();
      }
    }
    // Fine hair dots
    ctx.fillStyle = "rgba(200,215,170,0.5)";
    for (let k = 0; k < 90; k++) {
      ctx.fillRect(rng.next() * H2, rng.next() * S, 1, 1);
    }
    ctx.restore();
    // Petiole
    ctx.fillStyle = "#4b6a33";
    ctx.fillRect(H2 / 2 - 3, S - 14, 6, 14);

    // Dock: broad oblong, wavy edge, red-brown midrib, rust blotches, browned tip
    const dw = (t: number) =>
      54 * Math.sin(Math.PI * t ** 0.65) ** 0.6 * (1 - 0.05 * t) +
      2.5 * Math.sin(t * 31);
    leafPath(ctx, H2 + H2 / 2, S - 4, 4, dw);
    const dg = ctx.createLinearGradient(0, S, 0, 0);
    dg.addColorStop(0, "#4c6c31");
    dg.addColorStop(0.75, "#5a7a3a");
    dg.addColorStop(1, "#7a6a34");
    ctx.fillStyle = dg;
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = "rgba(140,64,42,0.9)";
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(H2 + H2 / 2, S - 4);
    ctx.lineTo(H2 + H2 / 2, 10);
    ctx.stroke();
    ctx.strokeStyle = "rgba(120,140,80,0.5)";
    ctx.lineWidth = 1.2;
    for (let k = 0; k < 9; k++) {
      const y = S - 24 - k * 25;
      for (const sgn of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(H2 + H2 / 2, y);
        ctx.quadraticCurveTo(
          H2 + H2 / 2 + sgn * 22,
          y - 10,
          H2 + H2 / 2 + sgn * 50,
          y - 14,
        );
        ctx.stroke();
      }
    }
    for (let k = 0; k < 11; k++) {
      ctx.fillStyle = `rgba(118,58,30,${rng.range(0.45, 0.8)})`;
      ctx.beginPath();
      ctx.ellipse(
        H2 + rng.range(20, 108),
        rng.range(30, 220),
        rng.range(3, 8),
        rng.range(2.5, 6),
        rng.next() * Math.PI,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
    ctx.restore();
    ctx.fillStyle = "#6e4a2c";
    ctx.fillRect(H2 + H2 / 2 - 4, S - 14, 8, 14);

    return texFromCanvas(c, true, false, false);
  });
}
