// Procedural textures for the Wardens' Boardwalk: a bleached-timber atlas
// (deck boards with split ends and nail heads, tileable weathered timber for
// sleepers, bearers, posts and rails), the faded, rust-streaked aluminium
// signs and the compacted sand of the desire path with its faint footprint
// mottling. All sets are deterministic and cached like the rest of the PBR
// library.

import {
  type PbrMaps,
  type Rgb,
  TexBuf,
  TexRng,
  cacheKey,
  cachedPbr,
  clamp01,
  drawScratches,
  hashPix,
  lerp3,
  mix,
  noiseField,
  rgb,
  sstep,
} from "./textures-core";

// ---------------------------------------------------------------------------
// Timber atlas
// ---------------------------------------------------------------------------

/**
 * Atlas rows of the timber set (v bands, bottom → top). Rows 0–1 are deck
 * boards: u runs 0..1 over one 0.6 m board, so the split ends and the nail
 * heads land where they belong. Rows 2–3 are tileable weathered timber
 * (u wraps, one tile = TIMBER_TILE_M metres); row 3 is the damp, sand-stained
 * variant for the half-buried sleepers.
 */
export const WOOD_ROW = { deckA: 0, deckB: 1, timber: 2, timberDark: 3 };
export const WOOD_ROWS = 4;
export const TIMBER_TILE_M = 1.2;

interface Split {
  row: number;
  end: number;
  v: number;
  len: number;
  w: number;
}

/**
 * Bleached boardwalk timber, 1024×512 (`hi`) or 512×256, map + normal +
 * roughness. Silver-grey sun-bleached faces with raised grain, long checks,
 * protected browner patches, algae along the deck-board edges and rust
 * bleeding from the nails. All features are defined in u/v or metres, so
 * both sizes draw the same picture.
 */
export function pbrBoardwalkWood(hi = true): PbrMaps {
  return cachedPbr(cacheKey("boardwalkWood", [hi]), () => {
    const W = hi ? 1024 : 512;
    const H = hi ? 512 : 256;
    const rng = new TexRng(0xb0a7);
    const SILVER: Rgb = rgb("#b2afa6");
    const PALE: Rgb = rgb("#d0cdc2");
    const DARK: Rgb = rgb("#6a665c");
    const BROWN: Rgb = rgb("#8d7b61");
    const CRACK: Rgb = rgb("#3b3630");
    const ALGAE: Rgb = rgb("#7a8760");
    const SANDY: Rgb = rgb("#c4ae86");
    const NAIL: Rgb = rgb("#2d2823");
    const RUST: Rgb = rgb("#7b4c2a");
    const buf = new TexBuf(W, H, SILVER, 0.86, 0);
    const nGrain = noiseField(W, H, 901, {
      freq: 3,
      freqY: 72,
      oct: 4,
      gain: 0.55,
    });
    const nRings = noiseField(W, H, 902, { freq: 2, freqY: 8, oct: 3 });
    const nWeather = noiseField(W, H, 903, { freq: 5, oct: 4 });
    const nCheck = noiseField(W, H, 904, {
      freq: 4,
      freqY: 96,
      oct: 3,
      mode: "ridged",
    });
    const nFine = noiseField(W, H, 905, { freq: 96, oct: 2 });
    const nAlgae = noiseField(W, H, 906, { freq: 6, oct: 3 });
    const nKnot = noiseField(W, H, 907, { freq: 12, oct: 3 });

    // End splits of the deck boards: a few cracks running in from each end
    const splits: Split[] = [];
    for (const row of [0, 1]) {
      for (const end of [0, 1]) {
        const n = 2 + rng.int(3);
        for (let k = 0; k < n; k++) {
          splits.push({
            row,
            end,
            v: rng.range(0.1, 0.9),
            len: rng.range(0.05, 0.17),
            w: rng.range(0.008, 0.02),
          });
        }
      }
    }
    // Knots, two per row
    const knots: Array<[number, number, number]> = [];
    for (let row = 0; row < WOOD_ROWS; row++) {
      for (let k = 0; k < 2; k++) {
        knots.push([row, rng.next(), rng.range(0.2, 0.8)]);
      }
    }
    // Nail heads: two per bearer, the bearers sit at 0.16 / 0.84 of the board
    const NAILS_U = [0.165, 0.835];
    const NAILS_V = [0.28, 0.72];
    // Pixel size in metres: u over a 0.6 m board, v over a 0.14 m board
    const U_M = 0.6;
    const V_M = 0.14;
    const TWO_PI = Math.PI * 2;

    buf.each((i, u, v) => {
      const row = Math.min(WOOD_ROWS - 1, Math.floor(v * WOOD_ROWS));
      const rv = v * WOOD_ROWS - row;
      const deck = row <= 1;
      const rings =
        0.5 + 0.5 * Math.sin((rv * 4.5 + nRings[i] * 2.2 + u * 1.5) * TWO_PI);
      let grain = 0.62 * nGrain[i] + 0.38 * rings;
      let hgt = grain * 0.2;
      for (const [kr, ku, kv] of knots) {
        if (kr !== row) continue;
        let du = u - ku;
        if (du > 0.5) du -= 1;
        if (du < -0.5) du += 1;
        const d =
          Math.sqrt((du / 0.035) ** 2 + ((rv - kv) / 0.16) ** 2) +
          (nKnot[i] - 0.5) * 0.5;
        if (d < 2) {
          const kr2 = 0.5 + 0.5 * Math.sin(d * TWO_PI * 1.5 + nKnot[i] * 4);
          grain = mix(grain, kr2, (1 - sstep(1.1, 2, d)) * 0.42);
          const core = 1 - sstep(0.3, 0.8, d);
          hgt -= core * 0.2;
          grain -= core * 0.35;
        }
      }
      grain = clamp01(grain);
      let col = lerp3(DARK, SILVER, grain);
      col = lerp3(col, PALE, sstep(0.72, 1, grain) * 0.55);
      // Protected patches still show the timber's brown
      const shelter =
        sstep(0.55, 0.85, nWeather[i]) * (deck ? 0.3 : row === 3 ? 0.55 : 0.4);
      col = lerp3(col, BROWN, shelter);
      // Long checks along the grain
      const check = sstep(deck ? 0.86 : 0.83, 0.97, nCheck[i]);
      col = lerp3(col, CRACK, check * 0.75);
      hgt -= check * 0.55;
      let ro = 0.84 + grain * 0.06 + check * 0.05 - shelter * 0.04;
      if (deck) {
        // End grain: darker, rougher, split
        const du = Math.min(u, 1 - u);
        const endZone = 1 - sstep(0, 0.035, du);
        col = lerp3(col, DARK, endZone * 0.45);
        ro += endZone * 0.08;
        hgt -= endZone * 0.25;
        for (const sp of splits) {
          if (sp.row !== row) continue;
          const dd = sp.end === 0 ? u : 1 - u;
          if (dd >= sp.len) continue;
          const f = dd / sp.len;
          const cv = sp.v + (nRings[i] - 0.5) * 0.08 * f;
          const w = sp.w * (1 - f) + 0.002;
          const inSplit = 1 - sstep(w * 0.6, w, Math.abs(rv - cv));
          col = lerp3(col, CRACK, inSplit * 0.85);
          hgt -= inSplit * 0.8;
          ro += inSplit * 0.06;
        }
        for (const nu of NAILS_U) {
          for (const nv of NAILS_V) {
            const dum = (u - nu) * U_M;
            const dvm = (rv - nv) * V_M;
            const dm = Math.sqrt(dum * dum + dvm * dvm);
            if (dm > 0.016) continue;
            const head = 1 - sstep(0.0038, 0.0052, dm);
            const halo = (1 - sstep(0.006, 0.016, dm)) * (1 - head);
            col = lerp3(col, NAIL, head);
            col = lerp3(col, RUST, halo * 0.38);
            hgt -= head * 0.5;
            ro += halo * 0.08;
          }
        }
        // Algae along the board edges in damp patches
        const edge = 1 - sstep(0.04, 0.2, Math.min(rv, 1 - rv));
        const alg = sstep(0.55, 0.8, nAlgae[i]) * edge * 0.6;
        col = lerp3(col, ALGAE, alg);
        ro += alg * 0.04;
      } else if (row === 3) {
        // Damp, sand-stained lower timber
        const sand = sstep(0.45, 0.75, nAlgae[i]) * 0.35;
        col = lerp3(col, SANDY, sand);
        ro += 0.04;
      }
      const k = 1 + (nFine[i] - 0.5) * 0.12 + (hashPix(i, 17) - 0.5) * 0.06;
      buf.set(i, [col[0] * k, col[1] * k, col[2] * k]);
      buf.hf[i] = hgt + (nFine[i] - 0.5) * 0.1;
      buf.rough[i] = ro;
    });
    return buf.build({ normal: 3.5, normalScale: 0.85 });
  });
}

// ---------------------------------------------------------------------------
// Signs
// ---------------------------------------------------------------------------

const SIGN_W = 512;
const SIGN_H = 640;
type UvRect = readonly [number, number, number, number];
/** Canvas pixel rectangle (y down) → atlas [u0, v0, u1, v1] (v upwards). */
const signRect = (x0: number, y0: number, x1: number, y1: number): UvRect => [
  x0 / SIGN_W,
  1 - y1 / SIGN_H,
  x1 / SIGN_W,
  1 - y0 / SIGN_H,
];

/** Atlas rectangles of the sign set. */
export const SIGN_UV = {
  /** 0.9 × 0.6 m "DUNES CLOSED" plate, printed face. */
  main: signRect(0, 0, 512, 340),
  /** 0.55 × 0.18 m "WARDENS' CAMP" arrow plate. */
  arrow: signRect(0, 344, 400, 512),
  /** 0.5 × 0.16 m "BEACH" plate at the walk's end, facing north. */
  beach: signRect(0, 516, 400, 640),
  /** Plain weathered aluminium (backs and edges). */
  back: signRect(404, 344, 512, 640),
};

/**
 * Faded aluminium signs, 512×640 (`hi`) or 256×320, map + normal + roughness
 * + metalness. The print is chalked and peeling back to bare metal, rust
 * runs down from the steel bolts, a few bullet dents have spalled the paint
 * to a bright rim. The layout is authored in 512×640 canvas pixels and
 * scaled, so the atlas rectangles hold for both sizes.
 */
export function pbrBoardwalkSign(hi = true): PbrMaps {
  return cachedPbr(cacheKey("boardwalkSign", [hi]), () => {
    const k = hi ? 1 : 0.5;
    const S = Math.round(SIGN_W * k);
    const H = Math.round(SIGN_H * k);
    const rng = new TexRng(0x51c4);
    const ALU: Rgb = rgb("#b3b6b1");
    const ALU_BRIGHT: Rgb = rgb("#d5d8d3");
    const CHALK: Rgb = rgb("#d9d6cc");
    const RUST: Rgb = rgb("#7a4a26");
    const RUST_DARK: Rgb = rgb("#4a2c16");
    const GRIME: Rgb = rgb("#6b685f");
    const buf = new TexBuf(S, H, ALU, 0.42, 0.65);
    const nFade = noiseField(S, H, 921, { freq: 4, oct: 4 });
    const nChalk = noiseField(S, H, 922, { freq: 7, oct: 4 });
    const nFine = noiseField(S, H, 923, { freq: 70, oct: 2 });
    const nStreak = noiseField(S, H, 924, { freq: 30, freqY: 4, oct: 3 });
    const nGrime = noiseField(S, H, 925, { freq: 3, oct: 3 });
    const nBrush = noiseField(S, H, 926, { freq: 2, freqY: 110, oct: 2 });

    const font = (w: string, px: number) =>
      `${w} ${px}px Arial, Helvetica, sans-serif`;
    // Printed faces (canvas y downwards): main plate 0..340, arrow 344..512,
    // beach plate 516..640 – authored at full size, scaled for the low tier
    const print = buf.layer((ctx) => {
      ctx.scale(k, k);
      // Shrink a line until it fits inside the plate's border
      const fit = (text: string, weight: string, px: number, maxW: number) => {
        let size = px;
        ctx.font = font(weight, size);
        while (size > 10 && ctx.measureText(text).width > maxW) {
          size -= 1;
          ctx.font = font(weight, size);
        }
      };
      ctx.fillStyle = "#ebe8df";
      ctx.fillRect(0, 0, 512, 340);
      ctx.strokeStyle = "#b8342a";
      ctx.lineWidth = 12;
      ctx.strokeRect(12, 12, 488, 316);
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = "#b8342a";
      fit("DUNES CLOSED", "900", 62, 430);
      ctx.fillText("DUNES CLOSED", 256, 98);
      ctx.fillStyle = "#262626";
      fit("FOR RESTORATION", "900", 46, 430);
      ctx.fillText("FOR RESTORATION", 256, 156);
      ctx.fillRect(60, 178, 392, 3);
      fit("CARNE COAST WARDENS", "bold", 30, 430);
      ctx.fillText("CARNE COAST WARDENS", 256, 222);
      ctx.fillStyle = "#3a3a3a";
      ctx.font = font("italic", 22);
      ctx.fillText("Please keep to the boardwalk", 256, 260);
      ctx.font = font("normal", 17);
      ctx.fillText("Marram planting in progress  ·  Dogs on leads", 256, 292);
      // Arrow plate
      ctx.fillStyle = "#ebe8df";
      ctx.fillRect(0, 344, 400, 168);
      ctx.strokeStyle = "#262626";
      ctx.lineWidth = 6;
      ctx.strokeRect(9, 353, 382, 150);
      ctx.fillStyle = "#262626";
      ctx.beginPath();
      ctx.moveTo(62, 372);
      ctx.lineTo(104, 420);
      ctx.lineTo(78, 420);
      ctx.lineTo(78, 488);
      ctx.lineTo(46, 488);
      ctx.lineTo(46, 420);
      ctx.lineTo(20, 420);
      ctx.closePath();
      ctx.fill();
      ctx.textAlign = "left";
      fit("WARDENS'", "900", 40, 200);
      ctx.fillText("WARDENS'", 126, 418);
      ctx.fillText("CAMP", 126, 470);
      ctx.font = font("bold", 22);
      ctx.fillText("100 m", 292, 470);
      // Beach plate (walk's end, faces north): arrow straight on
      ctx.fillStyle = "#ebe8df";
      ctx.fillRect(0, 516, 400, 124);
      ctx.strokeStyle = "#262626";
      ctx.lineWidth = 6;
      ctx.strokeRect(9, 525, 382, 106);
      ctx.fillStyle = "#262626";
      ctx.beginPath();
      ctx.moveTo(56, 536);
      ctx.lineTo(90, 574);
      ctx.lineTo(68, 574);
      ctx.lineTo(68, 622);
      ctx.lineTo(44, 622);
      ctx.lineTo(44, 574);
      ctx.lineTo(22, 574);
      ctx.closePath();
      ctx.fill();
      fit("BEACH", "900", 44, 170);
      ctx.fillText("BEACH", 108, 594);
      ctx.font = font("bold", 22);
      ctx.fillText("150 m", 290, 594);
    });
    const scratch = TexBuf.layerAlpha(
      buf.layer((ctx) =>
        drawScratches(ctx, rng, S, H, hi ? 80 : 40, 60 * k, 0.8, 0.6),
      ),
      buf.n,
    );
    // Bolt heads and bullet dents in authored (512×640) pixel coordinates
    const boltX = [256, 256, 200, 200, 200, 200];
    const boltY = [34, 306, 368, 488, 530, 626];
    const dentX = [150, 372, 302, 96, 330, 128];
    const dentY = [122, 96, 236, 270, 430, 560];
    const dentR = [9, 7, 8, 6, 6, 5];
    const invK = 1 / k;

    // Running colour of the current pixel, mixed in place (no per-pixel
    // allocations: the painter runs 200k–330k times)
    let r = 0;
    let g = 0;
    let b = 0;
    const to = (cr: number, cg: number, cb: number, t: number): void => {
      r += (cr - r) * t;
      g += (cg - g) * t;
      b += (cb - b) * t;
    };
    buf.each((i, _u, _v, x, y) => {
      const j = i * 4;
      const xs = x * invK;
      const ys = y * invK;
      const pa = print[j + 3] / 255;
      // Brushed aluminium
      const brush = 1 + (nBrush[i] - 0.5) * 0.07;
      r = ALU[0] * brush;
      g = ALU[1] * brush;
      b = ALU[2] * brush;
      let me = 0.65;
      let ro = 0.42;
      let hgt = 0;
      if (pa > 0.01) {
        // Faded: contrast pulled towards chalk, unevenly; peeling patches
        // reveal bare metal
        const fade = (0.3 + 0.45 * sstep(0.3, 0.8, nFade[i])) * 0.7;
        const peel = sstep(0.78, 0.9, nChalk[i]);
        let pr = print[j] / 255;
        let pg = print[j + 1] / 255;
        let pb = print[j + 2] / 255;
        pr += (CHALK[0] - pr) * fade;
        pg += (CHALK[1] - pg) * fade;
        pb += (CHALK[2] - pb) * fade;
        pr += (ALU[0] - pr) * peel;
        pg += (ALU[1] - pg) * peel;
        pb += (ALU[2] - pb) * peel;
        to(pr, pg, pb, pa);
        me += (mix(0.12, 0.6, peel) - me) * pa;
        ro += (0.6 - peel * 0.15 - ro) * pa;
        hgt += pa * (1 - peel) * 0.05;
      }
      // Bolts with rust running down from them
      for (let n = 0; n < boltX.length; n++) {
        const dx = xs - boltX[n];
        const dy = ys - boltY[n];
        const rr = Math.sqrt(dx * dx + dy * dy);
        if (rr < 9) {
          const head = 1 - sstep(7, 9, rr);
          to(RUST_DARK[0], RUST_DARK[1], RUST_DARK[2], head * 0.85);
          hgt += head * 0.9 * (1 - (rr / 9) ** 2);
          me += (0.1 - me) * head;
          ro += (0.8 - ro) * head;
        } else if (dy > 0 && dy < 190 && Math.abs(dx) < 20) {
          const spread = 3 + dy * 0.05;
          const across =
            1 -
            sstep(spread * 0.5, spread, Math.abs(dx + (nStreak[i] - 0.5) * 6));
          const along = (1 - sstep(60, 190, dy)) * sstep(0.45, 0.7, nStreak[i]);
          const st = clamp01(
            across * along * 0.8 + (1 - sstep(9, 16, rr)) * 0.7,
          );
          to(RUST[0], RUST[1], RUST[2], st);
          me += (0.08 - me) * st;
          ro += (0.85 - ro) * st;
        }
      }
      // Bullet dents: a bowl with a spalled bright rim
      for (let n = 0; n < dentX.length; n++) {
        const dx = xs - dentX[n];
        const dy = ys - dentY[n];
        const rr = Math.sqrt(dx * dx + dy * dy) / dentR[n];
        if (rr > 1.8) continue;
        const bowl = 1 - sstep(0.7, 1.05, rr);
        hgt -= bowl * 1.4 * (1 - rr * rr * 0.5);
        const rim = sstep(0.75, 1, rr) * (1 - sstep(1.2, 1.7, rr));
        to(ALU_BRIGHT[0], ALU_BRIGHT[1], ALU_BRIGHT[2], rim * 0.9);
        to(GRIME[0], GRIME[1], GRIME[2], bowl * 0.35);
        me += (0.7 - me) * rim;
        ro += (0.35 - ro) * rim;
      }
      // Scratches and a band of grime creeping up from the bottom edge
      const sc = scratch[i] * 0.5;
      to(ALU_BRIGHT[0], ALU_BRIGHT[1], ALU_BRIGHT[2], sc);
      me += (0.6 - me) * sc;
      // Height within the plate this pixel belongs to (0 = bottom edge)
      const local =
        ys < 342
          ? (342 - ys) / 342
          : ys < 514
            ? (514 - ys) / 172
            : (640 - ys) / 126;
      const gr =
        sstep(0.55, 0.85, nGrime[i]) * (1 - sstep(0, 0.5, local)) * 0.3;
      to(GRIME[0], GRIME[1], GRIME[2], gr);
      ro += gr * 0.15;
      const kk = 1 + (nFine[i] - 0.5) * 0.08 + (hashPix(i, 21) - 0.5) * 0.04;
      buf.r[i] = r * kk;
      buf.g[i] = g * kk;
      buf.b[i] = b * kk;
      buf.hf[i] = hgt + (nFine[i] - 0.5) * 0.04;
      buf.rough[i] = ro;
      buf.metal[i] = me;
    });
    return buf.build({
      wrapU: false,
      wrapV: false,
      normal: 3,
      normalScale: 0.8,
      metal: true,
    });
  });
}

// ---------------------------------------------------------------------------
// Desire path
// ---------------------------------------------------------------------------

/**
 * Compacted path sand, 512×256: u runs along the path (one tile = 3 m),
 * v across it (1.5 m, clamped). Darker than the loose beach sand, crusted in
 * patches, with overlapping footprint depressions clustered on the centre
 * line, a few pebbles and twigs. map + normal + roughness.
 */
export function pbrDesirePath(hi = true): PbrMaps {
  return cachedPbr(cacheKey("desirePath", [hi]), () => {
    const k = hi ? 1 : 0.5;
    const W = Math.round(512 * k);
    const H = Math.round(256 * k);
    const rng = new TexRng(0xde51);
    const base: Rgb = rgb("#c8ad7f");
    const buf = new TexBuf(W, H, base, 0.86, 0);
    const nMid = noiseField(W, H, 931, { freq: 6, oct: 4 });
    const nHi = noiseField(W, H, 932, { freq: 40, oct: 3 });
    const nCrust = noiseField(W, H, 933, { freq: 3, oct: 3 });
    const prints = new Float32Array(W * H);
    const rim = new Float32Array(W * H);
    // Rotated ellipse stamp, wrapping in u
    const stamp = (
      cx: number,
      cy: number,
      rx: number,
      ry: number,
      ang: number,
      depth: number,
    ) => {
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const reach = Math.max(rx, ry) * 1.5;
      for (let y = Math.floor(cy - reach); y <= Math.ceil(cy + reach); y++) {
        if (y < 0 || y >= H) continue;
        for (let x = Math.floor(cx - reach); x <= Math.ceil(cx + reach); x++) {
          const xx = ((x % W) + W) % W;
          const dx = x - cx;
          const dy = y - cy;
          const lx = (dx * c + dy * s) / rx;
          const ly = (-dx * s + dy * c) / ry;
          const r = Math.sqrt(lx * lx + ly * ly);
          const idx = y * W + xx;
          if (r < 1) {
            const d = depth * (1 - r ** 4);
            if (d > prints[idx]) prints[idx] = d;
          } else if (r < 1.45) {
            const e = (1 - sstep(1.15, 1.45, r)) * sstep(1, 1.12, r);
            if (e > rim[idx]) rim[idx] = e;
          }
        }
      }
    };
    for (let k = 0; k < 34; k++) {
      const cx = rng.next() * W;
      const cy = H * (0.5 + rng.gauss() * 0.16);
      const ang = rng.gauss() * 0.3;
      const dir = rng.chance(0.5) ? 1 : -1;
      const depth = 0.55 + rng.next() * 0.35;
      stamp(cx, cy, 24 * k, 9 * k, ang, depth);
      stamp(
        cx - dir * Math.cos(ang) * 25 * k,
        cy - dir * Math.sin(ang) * 25 * k,
        10 * k,
        8 * k,
        ang,
        depth * 1.1,
      );
    }
    // Pebbles and twigs, authored at 512×256 and scaled
    const bits = buf.layer((ctx) => {
      ctx.scale(k, k);
      const STONE = ["#8a7f6e", "#6e6255", "#9c9283", "#5d5449"];
      for (let n = 0; n < 14; n++) {
        ctx.fillStyle = rng.pick(STONE);
        ctx.beginPath();
        ctx.ellipse(
          rng.next() * 512,
          rng.next() * 256,
          rng.range(1.5, 3.5),
          rng.range(1.2, 2.5),
          rng.next() * Math.PI,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      ctx.strokeStyle = "#7a6650";
      ctx.lineCap = "round";
      for (let n = 0; n < 5; n++) {
        const x0 = rng.next() * 512;
        const y0 = rng.next() * 256;
        const a = rng.next() * Math.PI;
        const l = rng.range(10, 26);
        ctx.lineWidth = rng.range(1, 2);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x0 + Math.cos(a) * l, y0 + Math.sin(a) * l);
        ctx.stroke();
      }
    });
    buf.each((i) => {
      const crust = sstep(0.35, 0.7, nCrust[i]);
      const p = prints[i];
      let k =
        1 +
        (nMid[i] - 0.5) * 0.08 +
        (nHi[i] - 0.5) * 0.05 +
        (hashPix(i, 3) - 0.5) * 0.07;
      k -= crust * 0.05;
      k -= p * 0.045;
      k += rim[i] * 0.025;
      const warm = (nMid[i] - 0.5) * 0.03;
      buf.set(i, [base[0] * (k + warm), base[1] * k, base[2] * (k - warm)]);
      const j = i * 4;
      const ba = bits[j + 3] / 255;
      if (ba > 0.02) {
        buf.mixTo(i, [bits[j] / 255, bits[j + 1] / 255, bits[j + 2] / 255], ba);
      }
      buf.hf[i] =
        -p * 0.6 +
        rim[i] * 0.2 +
        (nHi[i] - 0.5) * 0.12 +
        (hashPix(i, 5) - 0.5) * 0.1 +
        ba * 0.5;
      buf.rough[i] = 0.86 - crust * 0.06 + p * 0.06 - ba * 0.25;
    });
    return buf.build({ wrapV: false, normal: 2.5, normalScale: 0.8 });
  });
}
