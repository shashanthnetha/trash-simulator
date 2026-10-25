// Textures of the Old Pier – procedural (TexBuf / Canvas 2D), cached, no
// asset files.
//
//   pilePbr(hi)  tar-blackened, rot-checked oak pile. v is WORLD HEIGHT: the
//                texture spans PILE_Y0..PILE_Y1 m, so every pile shares one
//                barnacle crust, algae band, weed skirt, tide grime and static
//                wet darkening at the wave line – pileV(y) maps a world height
//                to v, the mesh builder assigns it per vertex. u runs once
//                around the pile (tileable in u, clamped in v). The strip
//                above PILE_V_GRAIN is an end-grain patch for the sawn tops.
//   deckPbr(hi)  weathered deck timber: u = along the plank (one tile =
//                DECK_U_LEN m), v = DECK_SLOTS plank widths of DECK_SLOT_M m,
//                nail pairs at the stringer crossings DECK_NAIL_U so the nails
//                of a full-length plank land on the stringers.
//   ironPbr(hi)  rust-blistered wrought iron for the small fittings (tileable).
//   decalPbr(hi) alpha atlas: hanging wrack fronds, a rust streak, a grime
//                smudge (regions in DECAL_UV).
//
// `hi` = ultra/high sheets; medium/low get half the resolution on both axes
// (a quarter of the pixels – the sheets dominate the pier's boot cost). The
// size is part of the cache key. The pixel loops are allocation-free (colours
// parsed once per module, mixed in a scratch triple), everything that only
// depends on the row is precomputed per row, and the nails are stamped once
// instead of being tested per pixel.

import {
  type PbrMaps,
  type Rgb,
  TexBuf,
  TexRng,
  cachedPbr,
  drawLayer,
  mix,
  noiseField,
  rgb,
  sstep,
} from "./textures";

// ---------------------------------------------------------------------------
// Scratch colour (no allocations in the pixel loops)
// ---------------------------------------------------------------------------

const C: Rgb = [0, 0, 0];

/** C = lerp(a, b, t). */
function lerpC(a: Rgb, b: Rgb, t: number): void {
  C[0] = a[0] + (b[0] - a[0]) * t;
  C[1] = a[1] + (b[1] - a[1]) * t;
  C[2] = a[2] + (b[2] - a[2]) * t;
}

/** C += (b − C) · t. */
function toward(b: Rgb, t: number): void {
  C[0] += (b[0] - C[0]) * t;
  C[1] += (b[1] - C[1]) * t;
  C[2] += (b[2] - C[2]) * t;
}

/** C += (rgb − C) · t (scalar target). */
function toward3(r: number, g: number, b: number, t: number): void {
  C[0] += (r - C[0]) * t;
  C[1] += (g - C[1]) * t;
  C[2] += (b - C[2]) * t;
}

function scaleC(k: number): void {
  C[0] *= k;
  C[1] *= k;
  C[2] *= k;
}

// ---------------------------------------------------------------------------
// Pile
// ---------------------------------------------------------------------------

/** World height at v = 0 / v = PILE_V_GRAIN of the pile texture (m). */
export const PILE_Y0 = -3.2;
export const PILE_Y1 = 4.8;
/** v above this is the end-grain patch (pile tops). */
export const PILE_V_GRAIN = 0.965;
/** Circumference the u axis represents (m) – sets the pixel aspect. */
const PILE_CIRC = 1.04;

/** World height → v on the pile texture (clamped by the texture wrap). */
export function pileV(y: number): number {
  return ((y - PILE_Y0) / (PILE_Y1 - PILE_Y0)) * PILE_V_GRAIN;
}

/** Centre / radii of the end-grain patch in uv space. */
export const PILE_GRAIN_UV = {
  cu: 0.5,
  cv: (PILE_V_GRAIN + 1) / 2,
  ru: 0.48,
  rv: (1 - PILE_V_GRAIN) / 2 - 0.002,
};

const TAR_DARK: Rgb = rgb("#1f1a15");
const TAR_MID: Rgb = rgb("#3b3128");
const TAR_LIGHT: Rgb = rgb("#54483c");
const SILVER: Rgb = rgb("#8d8a82");
const SILVER_LT: Rgb = rgb("#aca8a0");
const ALGAE: Rgb = rgb("#3d5a28");
const ALGAE_LT: Rgb = rgb("#6c8a38");
const WEED: Rgb = rgb("#171a10");
const BARN_PALE: Rgb = rgb("#c1bcae");
const BARN_DARK: Rgb = rgb("#78736a");
const GRAIN_A: Rgb = rgb("#6d655a");
const GRAIN_B: Rgb = rgb("#433c35");

export function pilePbr(hi = true): PbrMaps {
  const W = hi ? 512 : 256;
  const H = hi ? 1536 : 768;
  return cachedPbr(`pier-pile:${W}x${H}`, () => {
    const rng = new TexRng(0x91e7);
    const buf = new TexBuf(W, H, TAR_MID, 0.8, 0);
    const M_V = PILE_Y1 - PILE_Y0;
    const PX_U = W / PILE_CIRC;
    const PX_V = (H * PILE_V_GRAIN) / M_V;
    // Vertical grain, checks, weathering patches, mid/fine detail
    const nGr = noiseField(W, H, 601, {
      freq: 26,
      freqY: 5,
      oct: 4,
      gain: 0.55,
    });
    const nCr = noiseField(W, H, 602, {
      freq: 14,
      freqY: 4,
      oct: 3,
      mode: "ridged",
    });
    const nWe = noiseField(W, H, 603, { freq: 3, freqY: 6, oct: 4 });
    const nM = noiseField(W, H, 604, { freq: 8, freqY: 24, oct: 3 });
    const nAl = noiseField(W, H, 605, { freq: 5, freqY: 20, oct: 4 });
    const nF = noiseField(W, H, 606, { freq: 60, freqY: 180, oct: 2 });
    const nCl = noiseField(W, H, 607, { freq: 6, freqY: 12, oct: 3 });

    // ---- barnacle crust: cones with a central hole, stamped in the band ----
    const bH = new Float32Array(W * H);
    const bM = new Float32Array(W * H);
    const bS = new Float32Array(W * H).fill(1);
    const stamp = (
      px: number,
      py: number,
      rx: number,
      ry: number,
      phase: number,
    ): void => {
      const x0 = Math.floor(px - rx - 1);
      const x1 = Math.ceil(px + rx + 1);
      const y0 = Math.max(0, Math.floor(py - ry - 1));
      const y1 = Math.min(H - 1, Math.ceil(py + ry + 1));
      for (let y = y0; y <= y1; y++) {
        const dy = (y - py) / ry;
        for (let x = x0; x <= x1; x++) {
          const dx = (x - px) / rx;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d >= 1) continue;
          const xx = ((x % W) + W) % W;
          const i = y * W + xx;
          let h = (1 - d) ** 0.75;
          if (d < 0.28) h *= 0.3 + 0.7 * (d / 0.28);
          if (h <= bH[i]) continue;
          bH[i] = h;
          bM[i] = 1;
          const ang = Math.atan2(dy, dx);
          bS[i] =
            0.7 +
            0.3 * (0.5 + 0.5 * Math.cos(ang * 9 + phase)) * (d > 0.3 ? 1 : 0.6);
        }
      }
    };
    // Same crust density whatever the sheet size
    const area = (W * H) / (512 * 1536);
    let placed = 0;
    for (let n = 0; n < 14000 * area && placed < 3600 * area; n++) {
      const y = rng.range(-1.1, 0.8);
      const dens = sstep(-1.1, -0.65, y) * (1 - sstep(0.22, 0.7, y));
      const px = rng.next() * W;
      const py = (1 - pileV(y)) * H;
      const cl = nCl[(py | 0) * W + (px | 0)];
      if (rng.next() > dens * (0.2 + 0.8 * sstep(0.32, 0.72, cl))) continue;
      const rm = rng.range(0.006, 0.019) * (1 + 0.7 * sstep(0.5, 0.9, cl));
      stamp(px, py, rm * PX_U, rm * PX_V, rng.next() * 6.283);
      placed++;
    }

    // ---- everything that depends on the world height only, per row ----
    const rowBl = new Float32Array(H);
    const rowAlg = new Float32Array(H);
    const rowWd = new Float32Array(H);
    const rowWet = new Float32Array(H);
    const rowGr = new Float32Array(H);
    for (let y = 0; y < H; y++) {
      const v = 1 - (y + 0.5) / H;
      const wy = PILE_Y0 + (v / PILE_V_GRAIN) * M_V;
      rowBl[y] = sstep(0.95, 2.8, wy) * 0.9;
      rowAlg[y] = sstep(0.12, 0.45, wy) * (1 - sstep(0.8, 1.35, wy));
      rowWd[y] = sstep(-1.2, -0.7, wy) * (1 - sstep(-0.3, 0.05, wy));
      rowWet[y] = 1 - sstep(0.5, 1.05, wy);
      rowGr[y] = Math.exp(-(((wy - 0.95) / 0.13) ** 2));
    }

    const G = PILE_GRAIN_UV;
    buf.each((i, u, v, _x, y) => {
      // ---- end-grain patch (sawn pile tops) ----
      if (v > PILE_V_GRAIN) {
        const du = (u - G.cu) / G.ru;
        const dv = (v - G.cv) / G.rv;
        const d = Math.sqrt(du * du + dv * dv);
        const rings =
          0.5 + 0.5 * Math.sin(d * 6.283 * 7 + (nM[i] - 0.5) * 3 + nF[i]);
        const crack = sstep(0.82, 0.96, nCr[i]);
        lerpC(GRAIN_A, GRAIN_B, rings);
        scaleC((1 - crack * 0.6) * (0.9 + nF[i] * 0.2));
        if (d > 1) toward(TAR_DARK, 0.7);
        buf.set(i, C);
        buf.hf[i] = rings * 0.15 - crack * 0.45;
        buf.rough[i] = 0.9;
        return;
      }
      // ---- tarred oak with vertical grain ----
      const grain = nGr[i];
      lerpC(TAR_DARK, TAR_MID, grain);
      toward(TAR_LIGHT, sstep(0.7, 1, grain) * 0.6);
      let hgt = grain * 0.12;
      let ro = 0.78 + grain * 0.08;
      // ---- bleaching gradient toward the top (tar remnants in patches) ----
      const bl = rowBl[y] * (0.35 + 0.65 * sstep(0.3, 0.72, nWe[i]));
      toward3(
        SILVER[0] + (SILVER_LT[0] - SILVER[0]) * grain,
        SILVER[1] + (SILVER_LT[1] - SILVER[1]) * grain,
        SILVER[2] + (SILVER_LT[2] - SILVER[2]) * grain,
        bl,
      );
      ro = mix(ro, 0.9, bl);
      // ---- rot checks (deeper and more where the wood is bleached) ----
      const crack = sstep(0.86 - 0.08 * bl, 0.97, nCr[i]);
      scaleC(1 - crack * 0.7);
      hgt -= crack * 0.5;
      // ---- green algae in the splash zone ----
      const alg = rowAlg[y] * sstep(0.3, 0.7, nAl[i]);
      if (alg > 0) {
        const am = nM[i];
        toward3(
          ALGAE[0] + (ALGAE_LT[0] - ALGAE[0]) * am,
          ALGAE[1] + (ALGAE_LT[1] - ALGAE[1]) * am,
          ALGAE[2] + (ALGAE_LT[2] - ALGAE[2]) * am,
          alg * 0.85,
        );
        ro = mix(ro, 0.42, alg);
        hgt *= 1 - alg * 0.5;
      }
      // ---- dark weed / mussel skirt below the water line ----
      const wd = rowWd[y] * sstep(0.25, 0.6, nAl[i]);
      if (wd > 0) {
        toward(WEED, wd * 0.8);
        ro = mix(ro, 0.5, wd);
      }
      // ---- barnacle crust ----
      const bm = bM[i];
      if (bm > 0) {
        const s = 1 - bS[i];
        const k = 0.55 + 0.45 * sstep(0, 0.6, bH[i]);
        toward3(
          (BARN_PALE[0] + (BARN_DARK[0] - BARN_PALE[0]) * s) * k,
          (BARN_PALE[1] + (BARN_DARK[1] - BARN_PALE[1]) * s) * k,
          (BARN_PALE[2] + (BARN_DARK[2] - BARN_PALE[2]) * s) * k,
          bm,
        );
        hgt += bH[i] * 0.6;
        ro = mix(ro, 0.88, bm);
      }
      // ---- static wet darkening below the wave line ----
      const wet = rowWet[y];
      C[0] *= 1 - 0.45 * wet;
      C[1] *= 1 - 0.45 * wet;
      C[2] *= 1 - 0.42 * wet;
      ro *= 1 - 0.35 * wet;
      // ---- tide grime line at the top of the run-up ----
      const gr = rowGr[y] * (0.45 + 0.55 * nWe[i]);
      C[0] *= 1 - 0.35 * gr;
      C[1] *= 1 - 0.35 * gr;
      C[2] *= 1 - 0.3 * gr;
      // ---- fine grain ----
      scaleC(0.92 + 0.16 * nF[i]);
      buf.set(i, C);
      buf.hf[i] = hgt;
      buf.rough[i] = ro;
    });
    return buf.build({
      wrapU: true,
      wrapV: false,
      normal: 3,
      normalScale: 0.9,
    });
  });
}

// ---------------------------------------------------------------------------
// Deck timber
// ---------------------------------------------------------------------------

/** One tile along u = one full plank length (m). */
export const DECK_U_LEN = 2.4;
/** Plank widths stacked along v, and the width of one (m). */
export const DECK_SLOTS = 6;
export const DECK_SLOT_M = 0.2;
/** u of the nail pairs (the stringer crossings of a full-length plank). */
export const DECK_NAIL_U: readonly number[] = [0.104, 0.5, 0.896];

const DECK_SILVER: Rgb = rgb("#8a857b");
const DECK_SILVER_LT: Rgb = rgb("#aaa499");
const DECK_SILVER_DK: Rgb = rgb("#66625a");
const DECK_TAR: Rgb = rgb("#3a3129");
const DECK_TAR_LT: Rgb = rgb("#5a4d40");
const MOULD: Rgb = rgb("#3a3a32");
const NAIL: Rgb = rgb("#2a2521");
const NAIL_RUST: Rgb = rgb("#7c4a24");

export function deckPbr(hi = true): PbrMaps {
  const W = hi ? 1024 : 512;
  const H = hi ? 512 : 256;
  return cachedPbr(`pier-deck:${W}x${H}`, () => {
    const rng = new TexRng(0xdec4);
    const buf = new TexBuf(W, H, DECK_SILVER, 0.86, 0);
    /** Pixel scale of the nail radii (authored at 1024 px). */
    const px = W / 1024;
    const nGr = noiseField(W, H, 611, {
      freq: 3,
      freqY: 48,
      oct: 4,
      gain: 0.55,
    });
    const nW = noiseField(W, H, 612, { freq: 2, freqY: 4, oct: 3 });
    const nWe = noiseField(W, H, 613, { freq: 3, freqY: 5, oct: 4 });
    const nCr = noiseField(W, H, 614, {
      freq: 2,
      freqY: 70,
      oct: 3,
      mode: "ridged",
    });
    const nSp = noiseField(W, H, 615, { freq: 40, oct: 2 });
    const nF = noiseField(W, H, 616, { freq: 120, freqY: 60, oct: 2 });
    // Nails: two per stringer crossing per plank slot, stamped once into
    // head/halo fields (instead of 36 distance tests per pixel)
    const nHead = new Float32Array(W * H);
    const nHalo = new Float32Array(W * H);
    const reach = 14 * px;
    for (let s = 0; s < DECK_SLOTS; s++) {
      for (const nu of DECK_NAIL_U) {
        for (const fv of [0.3, 0.7]) {
          const cx = (nu + rng.range(-0.006, 0.006)) * W;
          const cy = (1 - (s + fv + rng.range(-0.04, 0.04)) / DECK_SLOTS) * H;
          const x0 = Math.max(0, Math.floor(cx - reach));
          const x1 = Math.min(W - 1, Math.ceil(cx + reach));
          const y0 = Math.max(0, Math.floor(cy - reach));
          const y1 = Math.min(H - 1, Math.ceil(cy + reach));
          for (let y = y0; y <= y1; y++) {
            const dy = y + 0.5 - cy;
            for (let x = x0; x <= x1; x++) {
              const dx = x + 0.5 - cx;
              const d = Math.sqrt(dx * dx + dy * dy);
              if (d > reach) continue;
              const i = y * W + x;
              const head = 1 - sstep(2.6 * px, 4 * px, d);
              const halo = (1 - sstep(4 * px, 13 * px, d)) * (1 - head);
              if (head > nHead[i]) nHead[i] = head;
              if (halo > nHalo[i]) nHalo[i] = halo;
            }
          }
        }
      }
    }
    const TWO_PI = Math.PI * 2;
    buf.each((i, u, v) => {
      const fs = v * DECK_SLOTS - Math.floor(v * DECK_SLOTS);
      const edge = Math.min(fs, 1 - fs);
      const rings =
        0.5 + 0.5 * Math.sin((fs * 5 + nW[i] * 2.4 + u * 1.5) * TWO_PI);
      const grain = 0.62 * nGr[i] + 0.38 * rings;
      lerpC(DECK_SILVER_DK, DECK_SILVER, grain);
      toward(DECK_SILVER_LT, sstep(0.72, 1, grain) * 0.6);
      // Tar remnants where the weather has not yet scoured the plank
      const tr = sstep(0.55, 0.82, nWe[i]);
      toward3(
        DECK_TAR[0] + (DECK_TAR_LT[0] - DECK_TAR[0]) * grain,
        DECK_TAR[1] + (DECK_TAR_LT[1] - DECK_TAR[1]) * grain,
        DECK_TAR[2] + (DECK_TAR_LT[2] - DECK_TAR[2]) * grain,
        tr * 0.9,
      );
      let hgt = grain * 0.14;
      let ro = mix(0.88, 0.7, tr) + grain * 0.06;
      // Checks along the grain
      const crack = sstep(0.87, 0.97, nCr[i]);
      scaleC(1 - crack * 0.65);
      hgt -= crack * 0.5;
      // Rounded, greyed plank edges
      const e = 1 - sstep(0, 0.055, edge);
      scaleC(1 - e * 0.3);
      hgt -= e * 0.45;
      // Black mould specks
      const sp = sstep(0.8, 0.9, nSp[i]) * (1 - tr);
      toward(MOULD, sp * 0.55);
      // Nails
      const head = nHead[i];
      const halo = nHalo[i];
      if (head > 0 || halo > 0) {
        toward(NAIL, head);
        toward(NAIL_RUST, halo * 0.55 * (0.6 + 0.4 * nF[i]));
        hgt -= head * 0.35;
        ro += halo * 0.08;
      }
      scaleC(0.93 + 0.14 * nF[i]);
      buf.set(i, C);
      buf.hf[i] = hgt;
      buf.rough[i] = ro;
    });
    return buf.build({ normal: 3.5, normalScale: 0.9 });
  });
}

// ---------------------------------------------------------------------------
// Iron
// ---------------------------------------------------------------------------

const IRON: Rgb = rgb("#463f38");
const RUST_DK: Rgb = rgb("#5a2d12");
const RUST_MD: Rgb = rgb("#b4581e");
const RUST_LT: Rgb = rgb("#d08a4a");

/**
 * Rust-blistered wrought iron for the small fittings (ring, bracket, straps,
 * bolts): a small tileable sheet of its own – the fittings are tiny, and the
 * shared 512² rusty-metal set would cost more to build than the whole pier
 * geometry. map + normal + roughness + metalness.
 */
export function ironPbr(hi = true): PbrMaps {
  const S = hi ? 256 : 128;
  return cachedPbr(`pier-iron:${S}`, () => {
    const buf = new TexBuf(S, S, IRON, 0.5, 0.9);
    const nR = noiseField(S, S, 631, { freq: 4, oct: 4, gain: 0.55 });
    const nC = noiseField(S, S, 632, { freq: 10, oct: 3 });
    const nP = noiseField(S, S, 633, { freq: 40, oct: 2 });
    buf.each((i) => {
      // Rust covers most of the surface, bare iron shows in the hollows
      const m = sstep(0.2, 0.5, nR[i]);
      const pit = sstep(0.82, 0.9, nP[i]);
      lerpC(RUST_DK, RUST_MD, sstep(0.3, 0.7, nC[i]));
      toward(RUST_LT, sstep(0.75, 0.95, nP[i]) * 0.5);
      C[0] = IRON[0] + (C[0] - IRON[0]) * m;
      C[1] = IRON[1] + (C[1] - IRON[1]) * m;
      C[2] = IRON[2] + (C[2] - IRON[2]) * m;
      scaleC(0.92 + 0.16 * nP[i]);
      buf.set(i, C);
      buf.hf[i] = m * nP[i] * 0.2 - pit * 0.4;
      buf.rough[i] = mix(0.45, 0.9, m) + pit * 0.1;
      buf.metal[i] = mix(0.9, 0.05, m);
    });
    return buf.build({ normal: 4, normalScale: 0.9, metal: true });
  });
}

// ---------------------------------------------------------------------------
// Decal atlas (alpha)
// ---------------------------------------------------------------------------

export type UvRegion = readonly [number, number, number, number];

export const DECAL_UV: Record<"weed" | "rust" | "grime", UvRegion> = {
  weed: [0, 0.5, 1, 1],
  rust: [0.02, 0.02, 0.48, 0.5],
  grime: [0.52, 0.02, 0.98, 0.5],
};

const WEED_COLS = [
  "#3a3820",
  "#4b4726",
  "#2b2c18",
  "#56532e",
  "#3f3d22",
  "#605a30",
];

export function decalPbr(hi = true): PbrMaps {
  const W = hi ? 256 : 128;
  const H = hi ? 512 : 256;
  return cachedPbr(`pier-decal:${W}x${H}`, () => {
    const rng = new TexRng(0xd3ca1);
    /** Pixel scale of the strokes (authored at 256 px wide). */
    const px = W / 256;
    const layer = drawLayer(W, H, (ctx) => {
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      // ---- wrack fronds hanging from the top edge (v 1 → 0.5) ----
      for (let k = 0; k < 40; k++) {
        const x0 = rng.range(4, W - 4);
        const len = rng.range(110, 240) * px;
        const wTop = rng.range(6, 14) * px;
        const drift = rng.range(-30, 30) * px;
        const ph = rng.next() * 6.28;
        ctx.strokeStyle = rng.pick(WEED_COLS);
        let x = x0;
        let y = -4;
        const segs = 9;
        for (let s = 0; s < segs; s++) {
          const t1 = (s + 1) / segs;
          ctx.lineWidth = wTop * (1 - t1 * 0.82);
          const nx = x0 + drift * t1 + Math.sin(t1 * 6 + ph) * 9 * px;
          const ny = len * t1;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(nx, ny);
          ctx.stroke();
          // Side blades
          if (s > 1 && s < segs - 1 && rng.chance(0.5)) {
            const side = rng.chance(0.5) ? 1 : -1;
            ctx.lineWidth = wTop * 0.45 * (1 - t1 * 0.6);
            ctx.beginPath();
            ctx.moveTo(nx, ny);
            ctx.lineTo(
              nx + side * rng.range(8, 20) * px,
              ny + rng.range(10, 28) * px,
            );
            ctx.stroke();
          }
          x = nx;
          y = ny;
        }
      }
      // ---- rust streak (u 0..0.5, v 0..0.5) ----
      const rg = ctx.createLinearGradient(0, H / 2, 0, H - 8 * px);
      rg.addColorStop(0, "rgba(138,74,31,0.92)");
      rg.addColorStop(0.35, "rgba(112,58,26,0.7)");
      rg.addColorStop(1, "rgba(70,36,18,0)");
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.moveTo(W * 0.25 - 26 * px, H / 2);
      ctx.lineTo(W * 0.25 + 26 * px, H / 2);
      ctx.lineTo(W * 0.25 + 7 * px, H - 10 * px);
      ctx.lineTo(W * 0.25 - 5 * px, H - 10 * px);
      ctx.closePath();
      ctx.fill();
      // ---- grime smudge (u 0.5..1, v 0..0.5) ----
      const gg = ctx.createRadialGradient(
        W * 0.75,
        H * 0.75,
        4 * px,
        W * 0.75,
        H * 0.75,
        W * 0.23,
      );
      gg.addColorStop(0, "rgba(26,24,18,0.7)");
      gg.addColorStop(1, "rgba(26,24,18,0)");
      ctx.fillStyle = gg;
      ctx.fillRect(W / 2, H / 2, W / 2, H / 2);
    });
    const buf = new TexBuf(W, H, WEED, 0.55, 0);
    const nS = noiseField(W, H, 621, { freq: 24, freqY: 3, oct: 3 });
    const nF = noiseField(W, H, 622, { freq: 30, oct: 2 });
    buf.each((i, u, v) => {
      const j = i * 4;
      let a = layer[j + 3] / 255;
      C[0] = layer[j] / 255;
      C[1] = layer[j + 1] / 255;
      C[2] = layer[j + 2] / 255;
      if (v < 0.5 && u < 0.5) {
        // Streaky rust: vertical strands of varying opacity
        a *= 0.5 + 0.5 * sstep(0.3, 0.75, nS[i]);
        buf.rough[i] = 0.92;
      } else if (v >= 0.5) {
        // Wet, slimy weed
        buf.rough[i] = 0.5 + 0.15 * nF[i];
        scaleC(0.85 + 0.3 * nF[i]);
      } else {
        buf.rough[i] = 0.85;
      }
      buf.set(i, C);
      buf.a[i] = a;
    });
    return buf.build({
      wrapU: false,
      wrapV: false,
      alpha: true,
      alphaTest: 0.42,
      doubleSide: true,
      rough: true,
    });
  });
}
