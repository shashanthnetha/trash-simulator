// Textures of the Sealane Cable House (place-cable-house.ts). Two sets:
//
//   cableBrickPbr()  Victorian engineering brick in Flemish bond, tileable
//                    along u (one tile = 2.7 m of wall = 8 bond periods),
//                    clamped in v. Lower half of the sheet = exterior face
//                    (salt bleach, efflorescence, algae at the base), upper
//                    half = the limewashed interior face flaking off damp
//                    brick. v = y / 2.7 outside, 0.5 + y / 2.7 inside.
//   cableAtlasPbr()  One atlas for everything else: the four slate slopes
//                    (missing slates are alpha holes – the shadow pass cuts
//                    them too, so the sun falls through), ridge tiles, the
//                    plank door, stone dressings, rusty iron, weathered
//                    timber, porcelain, armoured cable, concrete and the
//                    telegraph pole shaft.
//   cablePlaquePbr() The cast plaque on its own small sheet so the relief
//                    lettering stays legible at arm's length.
//
// Regions are given on a 2048 design grid (CH); the atlas itself is 1024² on
// every tier (a 3.6 × 2.8 m hut does not earn more), the brick sheet
// 512×1024. Everything is deterministic (fixed seeds).

import type * as THREE from "three";
import {
  type PbrMaps,
  type Rgb,
  TexBuf,
  cacheKey,
  cachedPbr,
  cachedTex,
  hash01,
  heightToNormal,
  lerp3,
  makeCanvas,
  mix,
  noiseField,
  rgb,
  sstep,
  texFromCanvas,
} from "./textures-core";
import { rustColor } from "./textures-vehicle";

/** Atlas region [u0, v0, u1, v1] (v upwards). */
export type Region = readonly [number, number, number, number];

function R(x: number, y: number, w: number, h: number): Region {
  const S = 2048;
  return [x / S, 1 - (y + h) / S, (x + w) / S, 1 - y / S];
}

/** Metres the slope regions stand for (u: along the eaves, v: up the slope). */
export const SLOPE_LONG_W = 4.16;
export const SLOPE_HIP_W = 3.36;
export const SLOPE_H = 2.0;
/** Where the big hole in the front slope is (metres from the west eaves end / up the slope). */
export const FRONT_HOLE = { u: 2.3, s: 1.2, r: 0.42 };

export const CH = {
  slopeN: R(0, 0, 1024, 512),
  slopeS: R(0, 512, 1024, 512),
  hipE: R(1024, 0, 832, 512),
  hipW: R(1024, 512, 832, 512),
  ridge: R(1856, 0, 192, 192),
  slate: R(1856, 192, 192, 96),
  dark: R(1856, 288, 192, 96),
  door: R(384, 1024, 256, 512),
  stone: R(640, 1024, 384, 256),
  iron: R(1024, 1024, 384, 256),
  concrete: R(1408, 1024, 384, 384),
  pole: R(1792, 1024, 256, 1024),
  timber: R(640, 1280, 384, 256),
  cable: R(1024, 1280, 192, 128),
  porcelain: R(1216, 1280, 192, 128),
} as const;

interface Rect {
  x0: number;
  y0: number;
  w: number;
  h: number;
}

function rectOf(r: Region, w: number, h = w): Rect {
  const x0 = Math.round(r[0] * w);
  const y0 = Math.round((1 - r[3]) * h);
  return {
    x0,
    y0,
    w: Math.round(r[2] * w) - x0,
    h: Math.round((1 - r[1]) * h) - y0,
  };
}

/** Visit the pixels of a region: fx 0..1 to the right, fy 0..1 UPWARDS. */
function eachIn(
  buf: TexBuf,
  rc: Rect,
  fn: (i: number, fx: number, fy: number, x: number, y: number) => void,
): void {
  const iw = 1 / rc.w;
  const ih = 1 / rc.h;
  for (let y = 0; y < rc.h; y++) {
    const fy = 1 - (y + 0.5) * ih;
    const row = (rc.y0 + y) * buf.w + rc.x0;
    for (let x = 0; x < rc.w; x++) fn(row + x, (x + 0.5) * iw, fy, x, y);
  }
}

function tint(c: Rgb, k: number): Rgb {
  return [c[0] * k, c[1] * k, c[2] * k];
}

const RUST_DEEP: Rgb = rgb("#3e2a20");
const DARK_BASE: Rgb = rgb("#25272b");
const FOOT_HAZE: Rgb = rgb("#9a978c");
const CHIP: Rgb = rgb("#9d968a");

/** 2×2 box downsample of a field (canvas order). */
function halfField(f: Float32Array, w: number, h: number): Float32Array {
  const w2 = w >> 1;
  const h2 = h >> 1;
  const out = new Float32Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    const r0 = 2 * y * w;
    const r1 = r0 + w;
    const row = y * w2;
    for (let x = 0; x < w2; x++) {
      const x0 = 2 * x;
      out[row + x] =
        0.25 * (f[r0 + x0] + f[r0 + x0 + 1] + f[r1 + x0] + f[r1 + x0 + 1]);
    }
  }
  return out;
}

/** Old, weathered rust – the library's bright orange bloom knocked well back. */
function rustOld(nc: number, nf: number): Rgb {
  return lerp3(rustColor(nc, nf), RUST_DEEP, 0.5);
}

// ---------------------------------------------------------------------------
// Brick
// ---------------------------------------------------------------------------

const BRICK_TILE = 2.7;
const PERIOD = BRICK_TILE / 8;
const STRETCHER = 0.215;
const HEADER = 0.1025;
const JOINT = 0.01;
const COURSE = 0.075;
const BRICK_H = 0.065;

const REDS: Rgb[] = [
  rgb("#7e3b2d"),
  rgb("#8f4b34"),
  rgb("#9b5b3d"),
  rgb("#70382f"),
  rgb("#a4674b"),
  rgb("#864432"),
];
const HEADERS: Rgb[] = [rgb("#5b3a3b"), rgb("#6a4440"), rgb("#4e3335")];

const BRICK_BASE: Rgb = rgb("#8a4a36");
const MORTAR: Rgb = rgb("#c4b9a6");
const MORTAR_DK: Rgb = rgb("#8d8376");
const ALGAE: Rgb = rgb("#4c6a34");
const ALGAE_DK: Rgb = rgb("#2f4426");
const EFF: Rgb = rgb("#e9e5db");
const SPALL: Rgb = rgb("#b47a5e");
const LIME: Rgb = rgb("#d8d2c3");
const LIME_DIRT: Rgb = rgb("#a39d90");
const MOULD: Rgb = rgb("#3f423a");

/**
 * Brick sheet: 512×1024 on ultra/high, 256×512 below. The per-pixel loop
 * works in place on the buffer's channels (no colour tuples allocated) and
 * the roughness stays a material scalar – the joints/brick contrast is not
 * worth a map at this size.
 */
export function cableBrickPbr(hi: boolean): PbrMaps {
  return cachedPbr(cacheKey("cable-brick", [hi]), () => {
    const W = hi ? 512 : 256;
    const H = W * 2;
    const buf = new TexBuf(W, H, BRICK_BASE, 0.72, 0);
    const nF = noiseField(W, H, 811, { freq: 64, oct: 2 });
    const nV = noiseField(W, H, 812, { freq: 6, oct: 3 });
    const nE = noiseField(W, H, 813, { freq: 3, oct: 3 });
    const nA = noiseField(W, H, 814, { freq: 7, oct: 3 });
    const nSp = noiseField(W, H, 815, { freq: 40, oct: 2 });
    const nL = noiseField(W, H, 816, { freq: 4, oct: 4, gain: 0.55 });
    const nD = noiseField(W, H, 817, { freq: 5, freqY: 2, oct: 3 });
    const R = buf.r;
    const G = buf.g;
    const B = buf.b;
    buf.each((i, u, v) => {
      const interior = v >= 0.5;
      const wy = (interior ? v - 0.5 : v) * 2 * BRICK_TILE;
      const wx = u * BRICK_TILE;
      const c = Math.floor(wy / COURSE);
      const t = wy - c * COURSE;
      const off = c & 1 ? PERIOD / 2 : 0;
      const pxRaw = (wx + off) % PERIOD;
      const px = pxRaw < 0 ? pxRaw + PERIOD : pxRaw;
      let kind = 2; // 0 stretcher, 1 header, 2 perpend joint
      let bx = 0;
      if (px < STRETCHER) {
        kind = 0;
        bx = px / STRETCHER;
      } else if (px >= STRETCHER + JOINT && px < STRETCHER + JOINT + HEADER) {
        kind = 1;
        bx = (px - STRETCHER - JOINT) / HEADER;
      }
      const joint = kind === 2 || t > BRICK_H;
      const period = Math.floor((wx + off) / PERIOD);
      const id = hash01(period * 2 + kind, c + 3, 71);
      const id2 = hash01(period * 5 + 1, c * 3 + 7, 72);
      let hgt: number;
      if (joint) {
        const eroded = interior ? 0 : (1 - sstep(0.1, 0.9, wy)) * 0.5;
        buf.set(i, MORTAR);
        buf.mixTo(i, MORTAR_DK, 0.35 * nV[i] + eroded);
        buf.mul(i, 0.92 + nF[i] * 0.16);
        hgt = 0.22 - eroded * 0.1 + nF[i] * 0.05;
      } else {
        const pal = kind === 1 ? HEADERS : REDS;
        buf.set(i, pal[Math.floor(id * pal.length)]);
        buf.mixTo(i, pal[Math.floor(id2 * pal.length)], 0.5);
        buf.mul(i, 0.86 + nV[i] * 0.22 + (nF[i] - 0.5) * 0.12);
        // Arris: soft rounding at the brick edges
        const ex = Math.min(bx, 1 - bx) * (kind === 1 ? HEADER : STRETCHER);
        const ey = Math.min(t, BRICK_H - t);
        const edge = Math.min(1, Math.min(ex, ey) / 0.006);
        hgt = 0.62 * edge + 0.22 * (1 - edge) + nF[i] * 0.06;
        // Frost spalling on the lower exterior courses
        if (!interior && wy < 1.5 && id < 0.14) {
          const sp = sstep(0.45, 0.6, nSp[i] + (1 - sstep(0.3, 1.5, wy)) * 0.2);
          buf.mixTo(i, SPALL, sp);
          hgt -= sp * 0.25;
        }
      }
      if (!interior) {
        // Decades of salt air: the reds lose some of their fire
        if (!joint) {
          const lum = 0.3 * R[i] + 0.59 * G[i] + 0.11 * B[i];
          R[i] += (lum - R[i]) * 0.2;
          G[i] += (lum - G[i]) * 0.2;
          B[i] += (lum - B[i]) * 0.2;
        }
        // Salt efflorescence in patches, strongest mid-height
        const eff =
          sstep(0.56, 0.78, nE[i]) *
          (0.35 + 0.65 * sstep(0.3, 0.9, wy) * (1 - sstep(1.6, 2.4, wy))) *
          (joint ? 0.9 : 0.55);
        buf.mixTo(i, EFF, eff * 0.7);
        // Green algae up from the ground, deepest in the joints
        const alg = Math.min(
          1,
          (1 - sstep(0.06, 0.62, wy)) *
            (0.45 + 0.55 * nA[i]) *
            (joint ? 1 : 0.6) *
            1.2,
        );
        buf.mixTo(i, ALGAE, alg);
        buf.mixTo(i, ALGAE_DK, alg * nA[i]);
        buf.mul(i, 1 - (1 - sstep(0, 0.18, wy)) * 0.3);
      } else {
        // Limewash: intact higher up, flaking off the damp lower courses;
        // soot haze on the bare brick underneath
        const cov = sstep(
          0.36,
          0.5,
          nL[i] + 0.3 * sstep(0.5, 2.2, wy) - 0.15 * (1 - sstep(0, 0.6, wy)),
        );
        const dampI = (1 - sstep(0.05, 0.8, wy)) * (0.5 + 0.5 * nD[i]);
        buf.mul(i, 0.85);
        buf.mixTo(i, LIME, cov);
        buf.mixTo(i, LIME_DIRT, cov * dampI);
        buf.mixTo(i, MOULD, cov * dampI * sstep(0.45, 0.7, nD[i]) * 0.8);
        buf.mul(i, 1 + (nF[i] * 0.12 - 0.06) * cov);
        hgt = mix(hgt, 0.58 + nF[i] * 0.04, cov);
      }
      buf.hf[i] = hgt;
    });
    return buf.build({
      wrapU: true,
      wrapV: false,
      normal: hi ? 3 : 2,
      normalScale: 1,
      rough: false,
    });
  });
}

// ---------------------------------------------------------------------------
// Atlas painters
// ---------------------------------------------------------------------------

const GAUGE = 0.216;
const SLATE_W = 0.254;
const SLATES: Rgb[] = [
  rgb("#4a505a"),
  rgb("#565c66"),
  rgb("#5a5560"),
  rgb("#666a70"),
  rgb("#4f555c"),
  rgb("#6b5f58"),
];

interface SlopeOpts {
  seed: number;
  /** 0..1 how much moss (north slope = 1). */
  moss: number;
  /** Forced hole patch (metres from the region's bottom-left). */
  patch?: { u: number; s: number; r: number };
}

/**
 * Double-lap slating in the region: courses of GAUGE, stagger of half a
 * slate. A missing slate shows the unweathered heads of the course below; a
 * hole (alpha 0) opens only where that course is missing too – exactly as on
 * a real storm-stripped roof.
 */
const MOSS: Rgb = rgb("#4f6f2c");
const MOSS_LT: Rgb = rgb("#7d9a3d");
const LICHEN: Rgb = rgb("#a2a690");
const XANTH: Rgb = rgb("#c99236");
const NAIL_RUST: Rgb = rgb("#7a4a2a");
const BLEACH: Rgb = rgb("#8a8d8f");
const HOLE: Rgb = [0.1, 0.1, 0.1];

function paintSlope(buf: TexBuf, r: Region, wM: number, o: SlopeOpts): void {
  const rc = rectOf(r, buf.w, buf.h);
  const hM = SLOPE_H;
  const nC = noiseField(rc.w, rc.h, o.seed * 7 + 1, { freq: 3, oct: 2 });
  const nF = noiseField(rc.w, rc.h, o.seed * 7 + 2, { freq: 60, oct: 2 });
  const nM = noiseField(rc.w, rc.h, o.seed * 7 + 3, { freq: 8, oct: 3 });
  const nL = noiseField(rc.w, rc.h, o.seed * 7 + 4, { freq: 90, oct: 1 });
  const missProb = (mx: number, my: number, x: number, y: number): number => {
    let p = 0.025 + 0.5 * sstep(0.6, 0.78, nC[y * rc.w + x]);
    if (o.patch) {
      const dx = mx - o.patch.u;
      const dy = my - o.patch.s;
      p +=
        0.97 * (1 - sstep(0.6, 1.05, Math.sqrt(dx * dx + dy * dy) / o.patch.r));
    }
    return p;
  };
  // In-place on the buffer channels: no colour tuples per pixel
  eachIn(buf, rc, (i, fx, fy, x, y) => {
    const mx = fx * wM;
    const my = fy * hM;
    const c = Math.floor(my / GAUGE);
    const t = my - c * GAUGE;
    const sx = c & 1 ? SLATE_W / 2 : 0;
    const k = Math.floor((mx + sx) / SLATE_W);
    const u = mx + sx - k * SLATE_W;
    const id = hash01(k + 11, c + 5, o.seed);
    const pm = missProb(mx, my, x, y);
    const missing = id < pm;
    const fine = nF[y * rc.w + x];
    let hgt: number;
    let ro = 0.72;
    let jointU = u;
    if (!missing) {
      buf.set(i, SLATES[Math.floor(id * SLATES.length)]);
      buf.mixTo(
        i,
        SLATES[Math.floor(hash01(k + 3, c + 9, o.seed + 1) * SLATES.length)],
        0.4,
      );
      buf.mul(i, 0.9 + fine * 0.2);
      // Salt-bleached and greyer towards the eaves
      buf.mixTo(i, BLEACH, (1 - sstep(0.1, 0.7, fy)) * 0.25);
      hgt = 0.5 + id * 0.05 + 0.18 * (1 - t / GAUGE);
      // Shadow of the overlapping course above
      buf.mul(i, 1 - sstep(GAUGE - 0.03, GAUGE, t) * 0.35);
    } else {
      // Heads of the course below (offset half a slate), never weathered
      const sx2 = (c - 1) & 1 ? SLATE_W / 2 : 0;
      const k2 = Math.floor((mx + sx2) / SLATE_W);
      const id2 = hash01(k2 + 11, c + 4, o.seed);
      const pm2 = missProb(mx, my - GAUGE, x, Math.min(rc.h - 1, y + 2));
      if (c === 0 || id2 < pm2) {
        // Hole through to the battens
        buf.a[i] = 0;
        buf.set(i, HOLE);
        buf.hf[i] = 0.2;
        return;
      }
      jointU = mx + sx2 - k2 * SLATE_W;
      buf.set(i, SLATES[Math.floor(id2 * SLATES.length)]);
      buf.mul(i, 0.78 + fine * 0.12);
      hgt = 0.34 + fine * 0.02;
      ro = 0.8;
      // Nail hole of the exposed head
      const nd = Math.hypot(jointU - SLATE_W * 0.5, t - GAUGE * 0.55);
      if (nd < 0.006) {
        buf.mul(i, 0.35);
        hgt -= 0.2;
      } else if (nd < 0.03) {
        buf.mixTo(i, NAIL_RUST, 0.5 * (1 - sstep(0.006, 0.03, nd)));
      }
    }
    // Vertical joint between neighbouring slates
    const jd = Math.min(jointU, SLATE_W - jointU);
    if (jd < 0.004) {
      buf.mul(i, 0.45);
      hgt -= 0.3;
    }
    const nm = nM[y * rc.w + x];
    // Lichen: pale rosettes, a few orange ones
    const lich = sstep(0.9, 0.97, nL[y * rc.w + x]) * sstep(0.45, 0.6, nm);
    if (lich > 0) {
      buf.mixTo(i, LICHEN, lich * 0.8);
      if (hash01(k + 17, c + 23, o.seed + 4) < 0.18) {
        buf.mixTo(i, XANTH, lich * 0.7);
      }
    }
    // Moss: along the lower edges of the slates and in the joints, thick
    // near the eaves on the shaded slope
    const mossBand = Math.max(
      1 - sstep(0.0, 0.035, t),
      1 - sstep(0.002, 0.012, jd),
    );
    const moss =
      o.moss *
      sstep(0.42, 0.62, nm) *
      (0.35 + 0.65 * (1 - sstep(0.2, 0.9, fy))) *
      (0.35 + 0.65 * mossBand);
    if (moss > 0) {
      const mt = Math.min(1, moss * 1.3);
      buf.mixTo(i, MOSS, mt);
      buf.mixTo(i, MOSS_LT, mt * fine);
      hgt += moss * 0.12;
    }
    ro = mix(ro, 0.9, Math.min(1, moss + lich));
    buf.hf[i] = hgt;
    buf.rough[i] = ro;
  });
}

function paintRidge(buf: TexBuf, r: Region): void {
  const rc = rectOf(r, buf.w, buf.h);
  const nF = noiseField(rc.w, rc.h, 831, { freq: 12, oct: 3 });
  const nL = noiseField(rc.w, rc.h, 832, { freq: 30, oct: 1 });
  const CLAY = rgb("#5c4238");
  const CLAY_DK = rgb("#3f2f2b");
  const MORTAR = rgb("#b8ad9b");
  const LICHEN = rgb("#a8a48e");
  eachIn(buf, rc, (i, fx, fy, x, y) => {
    const n = nF[y * rc.w + x];
    let col = lerp3(CLAY, CLAY_DK, n);
    // Half-round tile on a CylinderGeometry: u runs around, v along the
    // tile – so the mortar joints sit at v 0/1, the lower edges at u 0/1
    const joint = Math.min(fy, 1 - fy) < 0.025;
    let hgt = 0.55 + n * 0.08;
    if (joint) {
      col = lerp3(col, MORTAR, 0.85);
      hgt = 0.35;
    }
    const lich = sstep(0.86, 0.95, nL[y * rc.w + x]);
    col = lerp3(col, LICHEN, lich * 0.75);
    const edge = 1 - sstep(0.04, 0.2, Math.min(fx, 1 - fx));
    col = tint(col, 1 - edge * 0.25);
    buf.set(i, col);
    buf.hf[i] = hgt;
    buf.rough[i] = 0.85 + lich * 0.1;
  });
}

function paintSlateSingle(buf: TexBuf, r: Region): void {
  const rc = rectOf(r, buf.w, buf.h);
  const nF = noiseField(rc.w, rc.h, 841, { freq: 30, oct: 2 });
  eachIn(buf, rc, (i, fx, fy, x, y) => {
    const n = nF[y * rc.w + x];
    let col = lerp3(SLATES[0], SLATES[3], n);
    const hole =
      Math.hypot(fx - 0.3, fy - 0.82) < 0.05 ||
      Math.hypot(fx - 0.7, fy - 0.82) < 0.05;
    if (hole) col = tint(col, 0.3);
    const edge = 1 - sstep(0.01, 0.04, Math.min(fx, 1 - fx, fy, 1 - fy));
    col = tint(col, 1 - edge * 0.2);
    buf.set(i, col);
    buf.hf[i] = 0.5 + n * 0.05 - (hole ? 0.3 : 0);
    buf.rough[i] = 0.7;
  });
}

function paintDark(buf: TexBuf, r: Region): void {
  const rc = rectOf(r, buf.w, buf.h);
  const nF = noiseField(rc.w, rc.h, 851, { freq: 6, oct: 3 });
  eachIn(buf, rc, (i, _fx, _fy, x, y) => {
    const n = nF[y * rc.w + x];
    buf.set(i, DARK_BASE);
    buf.mul(i, 0.8 + n * 0.4);
    buf.hf[i] = 0.5;
    buf.rough[i] = 0.92;
  });
}

function paintPlaque(buf: TexBuf, r: Region): void {
  const rc = rectOf(r, buf.w, buf.h);
  const nR = noiseField(rc.w, rc.h, 861, { freq: 5, oct: 4 });
  const nF = noiseField(rc.w, rc.h, 862, { freq: 40, oct: 2 });
  const PAINT = rgb("#1d2a25");
  eachIn(buf, rc, (i, fx, fy, x, y) => {
    const n = nR[y * rc.w + x];
    const f = nF[y * rc.w + x];
    const e = Math.min(fx, 1 - fx, fy, 1 - fy);
    const m = Math.min(1, sstep(0.6, 0.8, n) + (1 - sstep(0, 0.07, e)) * 0.6);
    const col = lerp3(tint(PAINT, 0.9 + f * 0.2), rustOld(n, f), m);
    buf.set(i, col);
    buf.hf[i] = 0.5 + f * 0.03 - m * 0.05;
    buf.rough[i] = 0.5 + m * 0.4;
    buf.metal[i] = 0.55 * (1 - m);
  });
  const layer = buf.layer((ctx) => {
    ctx.save();
    ctx.translate(rc.x0, rc.y0);
    const s = rc.w / 384;
    ctx.scale(s, s);
    const ink = "#ddd8c6";
    ctx.strokeStyle = ink;
    ctx.lineWidth = 7;
    ctx.strokeRect(11, 11, 362, 234);
    ctx.lineWidth = 2.5;
    ctx.strokeRect(23, 23, 338, 210);
    ctx.fillStyle = ink;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 52px 'Times New Roman', Georgia, serif";
    ctx.fillText("SEALANE", 192, 70);
    ctx.font = "bold 38px 'Times New Roman', Georgia, serif";
    ctx.fillText("TELEGRAPH Co.", 192, 122);
    ctx.font = "bold 21px 'Times New Roman', Georgia, serif";
    ctx.fillText("SHORE-END STATION  No. 2", 192, 176);
    ctx.font = "19px 'Times New Roman', Georgia, serif";
    ctx.fillText("EAST BEACH  •  1878", 192, 208);
    ctx.restore();
  });
  const WHITE = rgb("#d9d4c3");
  eachIn(buf, rc, (i, _fx, _fy, x, y) => {
    const t = layer[i * 4 + 3] / 255;
    if (t <= 0) return;
    const n = nR[y * rc.w + x];
    const worn = sstep(0.42, 0.66, n);
    const col = lerp3(WHITE, rustOld(n, nF[y * rc.w + x]), worn * 0.85);
    buf.mixTo(i, col, t);
    buf.hf[i] += 0.4 * t;
    buf.rough[i] = mix(buf.rough[i], 0.45 + worn * 0.4, t);
    buf.metal[i] = mix(buf.metal[i], 0.2, t);
  });
}

function paintDoor(buf: TexBuf, r: Region): void {
  const rc = rectOf(r, buf.w, buf.h);
  const nG = noiseField(rc.w, rc.h, 871, { freq: 3, freqY: 40, oct: 4 });
  const nP = noiseField(rc.w, rc.h, 872, { freq: 4, oct: 4, gain: 0.55 });
  const nF = noiseField(rc.w, rc.h, 873, { freq: 50, oct: 2 });
  const PAINT = rgb("#4c6a4d");
  const PAINT_LT = rgb("#6d8a6a");
  const WOOD = rgb("#8b8474");
  const WOOD_DK = rgb("#5f5a4e");
  const IRON = rgb("#2c2825");
  const PLANKS = 5;
  eachIn(buf, rc, (i, fx, fy, x, y) => {
    const g = nG[y * rc.w + x];
    const f = nF[y * rc.w + x];
    const pk = fx * PLANKS;
    const plank = Math.floor(pk);
    const pu = pk - plank;
    const gap = Math.min(pu, 1 - pu) < 0.03;
    const bead = pu > 0.04 && pu < 0.09;
    const pid = hash01(plank, 1, 77);
    let wood = lerp3(WOOD_DK, WOOD, g);
    wood = tint(wood, 0.9 + pid * 0.2 + (f - 0.5) * 0.1);
    // Paint survives in the upper/middle field, flakes from the foot and edges
    const flake = sstep(
      0.4,
      0.55,
      nP[y * rc.w + x] + (1 - sstep(0.02, 0.35, fy)) * 0.35,
    );
    let col = lerp3(lerp3(PAINT, PAINT_LT, g * 0.5), wood, flake);
    let hgt = 0.55 + g * 0.06 - flake * 0.06;
    let ro = mix(0.6, 0.85, flake);
    if (gap) {
      col = tint(col, 0.35);
      hgt = 0.2;
    } else if (bead) {
      hgt += 0.08;
    }
    // Two T-hinge straps from the hinge edge, a keyhole plate
    const strap =
      (Math.abs(fy - 0.2) < 0.03 || Math.abs(fy - 0.8) < 0.03) &&
      fx < 0.62 - 0.1 * sstep(0.5, 0.62, fx);
    const plate = Math.hypot((fx - 0.86) * 0.44, (fy - 0.48) * 1) < 0.04;
    if (strap || plate) {
      const rust = sstep(0.5, 0.75, nP[y * rc.w + x]);
      col = lerp3(IRON, rustOld(nP[y * rc.w + x], f), rust);
      hgt = 0.68;
      ro = 0.55 + rust * 0.35;
      buf.metal[i] = 0.5 * (1 - rust);
      if (plate && Math.hypot((fx - 0.86) * 0.44, fy - 0.48) < 0.012) {
        col = [0.03, 0.03, 0.03];
        hgt = 0.3;
      }
    }
    // Weathered grey haze at the foot
    col = lerp3(col, FOOT_HAZE, (1 - sstep(0, 0.12, fy)) * 0.4);
    buf.set(i, col);
    buf.hf[i] = hgt;
    buf.rough[i] = ro;
  });
}

function paintStone(buf: TexBuf, r: Region): void {
  const rc = rectOf(r, buf.w, buf.h);
  const nB = noiseField(rc.w, rc.h, 881, { freq: 2, freqY: 10, oct: 3 });
  const nF = noiseField(rc.w, rc.h, 882, { freq: 30, oct: 3 });
  const nL = noiseField(rc.w, rc.h, 883, { freq: 8, oct: 2 });
  const nS = noiseField(rc.w, rc.h, 884, { freq: 3, oct: 3 });
  const BUFF = rgb("#b5a58b");
  const BUFF_DK = rgb("#8e7f68");
  const LICHEN = rgb("#8f9a7a");
  const SOOT = rgb("#4a463f");
  eachIn(buf, rc, (i, fx, fy, x, y) => {
    const j = y * rc.w + x;
    let col = lerp3(BUFF_DK, BUFF, 0.4 + nB[j] * 0.6);
    col = tint(col, 0.9 + nF[j] * 0.2);
    // Tooling: fine diagonal chisel lines
    const tool = 0.5 + 0.5 * Math.sin((fx * 60 + fy * 22) * Math.PI * 2);
    let hgt = 0.5 + nB[j] * 0.08 + tool * 0.04 + nF[j] * 0.06;
    const pit = sstep(0.82, 0.9, nF[j]);
    hgt -= pit * 0.2;
    col = tint(col, 1 - pit * 0.3);
    const lich = sstep(0.62, 0.8, nL[j]) * sstep(0.4, 0.6, nS[j]);
    col = lerp3(col, LICHEN, lich * 0.6);
    // Black weathering streaks on the lower part
    const soot = sstep(0.5, 0.8, nS[j]) * (1 - sstep(0.1, 0.55, fy));
    col = lerp3(col, SOOT, soot * 0.6);
    buf.set(i, col);
    buf.hf[i] = hgt;
    buf.rough[i] = 0.88 + lich * 0.08;
  });
}

function paintIron(buf: TexBuf, r: Region): void {
  const rc = rectOf(r, buf.w, buf.h);
  const nR = noiseField(rc.w, rc.h, 891, { freq: 4, oct: 5, gain: 0.55 });
  const nC = noiseField(rc.w, rc.h, 892, { freq: 12, oct: 4 });
  const nF = noiseField(rc.w, rc.h, 893, { freq: 70, oct: 2 });
  const nP = noiseField(rc.w, rc.h, 894, { freq: 40, oct: 2 });
  const PAINT = rgb("#2b2a2c");
  eachIn(buf, rc, (i, _fx, _fy, x, y) => {
    const j = y * rc.w + x;
    const m = sstep(0.3, 0.6, nR[j]);
    const pit = sstep(0.78, 0.88, nP[j]);
    let col = lerp3(tint(PAINT, 0.9 + nF[j] * 0.2), rustOld(nC[j], nF[j]), m);
    col = tint(col, 1 - pit * 0.4);
    buf.set(i, col);
    buf.hf[i] = 0.5 + m * nF[j] * 0.15 - pit * 0.35;
    buf.rough[i] = mix(0.5, 0.92, m) + pit * 0.05;
    buf.metal[i] = mix(0.75, 0.08, m);
  });
}

function paintTimber(buf: TexBuf, r: Region): void {
  const rc = rectOf(r, buf.w, buf.h);
  const nG = noiseField(rc.w, rc.h, 901, {
    freq: 3,
    freqY: 36,
    oct: 4,
    gain: 0.55,
  });
  const nC = noiseField(rc.w, rc.h, 902, {
    freq: 2,
    freqY: 60,
    oct: 3,
    mode: "ridged",
  });
  const nW = noiseField(rc.w, rc.h, 903, { freq: 4, oct: 3 });
  const nF = noiseField(rc.w, rc.h, 904, { freq: 50, oct: 2 });
  const SILVER = rgb("#9a9486");
  const BROWN = rgb("#7a6a52");
  const DARK = rgb("#4a4034");
  eachIn(buf, rc, (i, fx, fy, x, y) => {
    const j = y * rc.w + x;
    const g = nG[j];
    let col = lerp3(DARK, BROWN, g);
    // Weathered silver on the exposed faces
    const w = sstep(0.3, 0.7, nW[j]) * 0.75 + 0.15;
    col = lerp3(col, lerp3(DARK, SILVER, g), w);
    col = tint(col, 0.92 + nF[j] * 0.16);
    const crack = sstep(0.85, 0.97, nC[j]);
    col = tint(col, 1 - crack * 0.55);
    let hgt = 0.5 + g * 0.1 - crack * 0.35;
    // Two knots
    for (const [kx, ky] of [
      [0.28, 0.62],
      [0.74, 0.3],
    ]) {
      const d = Math.hypot((fx - kx) * 1.5, fy - ky) / 0.05;
      if (d < 2) {
        const k = 1 - sstep(0.4, 1.4, d);
        col = lerp3(col, DARK, k * 0.7);
        hgt -= k * 0.1;
      }
    }
    buf.set(i, col);
    buf.hf[i] = hgt;
    buf.rough[i] = 0.82 + w * 0.08;
  });
}

function paintPole(buf: TexBuf, r: Region): void {
  const rc = rectOf(r, buf.w, buf.h);
  const nCk = noiseField(rc.w, rc.h, 911, {
    freq: 10,
    freqY: 2,
    oct: 3,
    mode: "ridged",
  });
  const nG = noiseField(rc.w, rc.h, 912, { freq: 3, freqY: 30, oct: 4 });
  const nW = noiseField(rc.w, rc.h, 913, { freq: 2, oct: 3 });
  const nF = noiseField(rc.w, rc.h, 914, { freq: 40, oct: 2 });
  const TAR = rgb("#16130f");
  const CREO = rgb("#6a5641");
  const CREO_DK = rgb("#42352a");
  const SILVER = rgb("#8e887b");
  eachIn(buf, rc, (i, fx, fy, x, y) => {
    const j = y * rc.w + x;
    const g = nG[j];
    const f = nF[j];
    // Tar band at the foot with a ragged, dripped top edge
    const tarTop = 0.17 + 0.02 * Math.sin(fx * Math.PI * 6) + nW[j] * 0.025;
    const tar = 1 - sstep(tarTop - 0.006, tarTop + 0.006, fy);
    let col = lerp3(CREO_DK, CREO, g);
    // Creosote fades to silver-grey up the pole
    col = lerp3(
      col,
      lerp3(CREO_DK, SILVER, g),
      sstep(0.25, 0.95, fy) * (0.5 + 0.5 * nW[j]),
    );
    col = tint(col, 0.9 + f * 0.2);
    const check = sstep(0.8, 0.96, nCk[j]) * sstep(0.2, 0.3, fy);
    col = tint(col, 1 - check * 0.6);
    col = lerp3(col, tint(TAR, 0.9 + f * 0.3), tar);
    buf.set(i, col);
    buf.hf[i] = 0.5 + g * 0.08 - check * 0.35 + tar * 0.05;
    buf.rough[i] = mix(0.85, 0.5, tar);
  });
}

function paintCable(buf: TexBuf, r: Region): void {
  const rc = rectOf(r, buf.w, buf.h);
  const nF = noiseField(rc.w, rc.h, 921, { freq: 20, oct: 2 });
  const nR = noiseField(rc.w, rc.h, 922, { freq: 3, oct: 3 });
  const LEAD = rgb("#6f7276");
  const LEAD_DK = rgb("#45474a");
  const TARC = rgb("#1e1c19");
  const WIRES = 10;
  eachIn(buf, rc, (i, fx, fy, x, y) => {
    const j = y * rc.w + x;
    const ridge = 0.5 + 0.5 * Math.cos((fy * WIRES + fx * 0.4) * Math.PI * 2);
    let col = lerp3(LEAD_DK, LEAD, ridge);
    col = tint(col, 0.9 + nF[j] * 0.2);
    const rust = sstep(0.55, 0.75, nR[j]) * (1 - ridge);
    col = lerp3(col, rustOld(nR[j], nF[j]), rust * 0.8);
    const tar = sstep(0.72, 0.85, nR[j]);
    col = lerp3(col, TARC, tar);
    buf.set(i, col);
    buf.hf[i] = 0.3 + ridge * 0.35;
    buf.rough[i] = mix(0.55, 0.85, Math.max(rust, tar));
    buf.metal[i] = 0.55 * (1 - rust) * (1 - tar);
  });
}

function paintPorcelain(buf: TexBuf, r: Region): void {
  const rc = rectOf(r, buf.w, buf.h);
  const nF = noiseField(rc.w, rc.h, 931, { freq: 6, oct: 3 });
  const nC = noiseField(rc.w, rc.h, 932, { freq: 24, oct: 2, mode: "ridged" });
  const WHITE = rgb("#ece7da");
  const CREAM = rgb("#d8d0bc");
  const CRAZE = rgb("#6b5a44");
  eachIn(buf, rc, (i, fx, fy, x, y) => {
    const j = y * rc.w + x;
    let col = lerp3(WHITE, CREAM, nF[j] * 0.6);
    const craze = sstep(0.93, 0.98, nC[j]) * sstep(0.5, 0.7, nF[j]);
    col = lerp3(col, CRAZE, craze * 0.6);
    // A chip near one corner
    const chip = 1 - sstep(0.06, 0.1, Math.hypot(fx - 0.15, fy - 0.2));
    col = lerp3(col, CHIP, chip);
    buf.set(i, col);
    buf.hf[i] = 0.5 - chip * 0.2;
    buf.rough[i] = 0.22 + craze * 0.2 + chip * 0.5;
  });
}

function paintConcrete(buf: TexBuf, r: Region): void {
  const rc = rectOf(r, buf.w, buf.h);
  const nF = noiseField(rc.w, rc.h, 941, { freq: 40, oct: 3 });
  const nS = noiseField(rc.w, rc.h, 942, { freq: 3, oct: 3 });
  const nC = noiseField(rc.w, rc.h, 943, { freq: 4, oct: 3, mode: "ridged" });
  const GREY = rgb("#8a8882");
  const GREY_DK = rgb("#5f5e5a");
  const SAND = rgb("#c7b48f");
  eachIn(buf, rc, (i, _fx, _fy, x, y) => {
    const j = y * rc.w + x;
    let col = lerp3(GREY_DK, GREY, 0.5 + nF[j] * 0.5);
    const sand = sstep(0.5, 0.75, nS[j]);
    col = lerp3(col, SAND, sand * 0.8);
    const crack = sstep(0.9, 0.97, nC[j]) * (1 - sand);
    col = tint(col, 1 - crack * 0.5);
    const damp = sstep(0.2, 0.4, nS[j]) * (1 - sstep(0.4, 0.55, nS[j]));
    col = tint(col, 1 - damp * 0.25);
    buf.set(i, col);
    buf.hf[i] = 0.5 + nF[j] * 0.06 - crack * 0.3 + sand * 0.03;
    buf.rough[i] = 0.9;
  });
}

/**
 * The atlas: slate slopes (alpha holes), ridge tile, loose slate, dark
 * undersides, plaque, door, stone, iron, timber, pole shaft, cable,
 * porcelain, concrete. map + normal + roughness + metalness, alphaTest 0.5.
 */
export function cableAtlasPbr(hi: boolean): PbrMaps {
  return cachedPbr(cacheKey("cable-atlas", [hi]), () => {
    const S = hi ? 1024 : 512;
    const buf = new TexBuf(S, S, [0.3, 0.3, 0.3], 0.8, 0);
    paintSlope(buf, CH.slopeS, SLOPE_LONG_W, {
      seed: 1,
      moss: 0.12,
      patch: FRONT_HOLE,
    });
    paintSlope(buf, CH.slopeN, SLOPE_LONG_W, { seed: 2, moss: 1 });
    paintSlope(buf, CH.hipE, SLOPE_HIP_W, { seed: 3, moss: 0.4 });
    paintSlope(buf, CH.hipW, SLOPE_HIP_W, { seed: 4, moss: 0.55 });
    paintRidge(buf, CH.ridge);
    paintSlateSingle(buf, CH.slate);
    paintDark(buf, CH.dark);
    paintDoor(buf, CH.door);
    paintStone(buf, CH.stone);
    paintIron(buf, CH.iron);
    paintTimber(buf, CH.timber);
    paintPole(buf, CH.pole);
    paintCable(buf, CH.cable);
    paintPorcelain(buf, CH.porcelain);
    paintConcrete(buf, CH.concrete);
    const maps = buf.build({
      wrapU: false,
      wrapV: false,
      alpha: true,
      alphaTest: 0.5,
      metal: true,
    });
    // The normal map at half resolution: the relief here is slate courses,
    // plank gaps and brick-sized detail – nothing a 2 px texel would carry
    maps.normalMap = heightToNormal(halfField(buf.hf, S, S), S >> 1, 2, false);
    maps.normalScale = 0.9;
    return maps;
  });
}

/** The cast plaque alone: 512×344 (0.6 × 0.42 m; half that below high), map + normal + roughness + metalness. */
export function cablePlaquePbr(hi: boolean): PbrMaps {
  return cachedPbr(cacheKey("cable-plaque", [hi]), () => {
    const buf = new TexBuf(
      hi ? 512 : 256,
      hi ? 344 : 172,
      [0.12, 0.14, 0.13],
      0.6,
      0.4,
    );
    paintPlaque(buf, [0, 0, 1, 1]);
    return buf.build({
      wrapU: false,
      wrapV: false,
      normal: 3,
      normalScale: 0.9,
      metal: true,
    });
  });
}

/** Soft additive ribbon for the shaft of light through the roof hole. */
export function cableBeamTexture(): THREE.Texture {
  return cachedTex("cable-beam", () => {
    const W = 64;
    const H = 256;
    const [c, ctx] = makeCanvas(W, H);
    const img = ctx.createImageData(W, H);
    const d = img.data;
    for (let y = 0; y < H; y++) {
      const fy = y / (H - 1);
      // bright where it enters (top), fading towards the floor
      const along = (1 - fy) * (0.35 + 0.65 * (1 - sstep(0.75, 1, fy)));
      for (let x = 0; x < W; x++) {
        const fx = (x + 0.5) / W;
        const across = Math.exp(-((fx - 0.5) * (fx - 0.5)) / 0.06);
        const streak = 0.85 + 0.15 * Math.sin(fx * 40 + fy * 3);
        const a = Math.min(1, along * across * streak);
        const j = (y * W + x) * 4;
        d[j] = 255;
        d[j + 1] = 244;
        d[j + 2] = 214;
        d[j + 3] = (a * 255) | 0;
      }
    }
    ctx.putImageData(img, 0, 0);
    return texFromCanvas(c, true, false, false);
  });
}
