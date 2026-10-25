// Texture sets for the Old Tip (place-tip.ts): the exposed landfill strata of
// the eroding scar face and one atlas for everything hard that sticks out of
// it or stands on the crown – rusted sheet, drum lids, cable, glass, bin bags,
// the tyre, the concrete boundary posts, the vent pipe and the council sign.
// Uses the core library from textures-core.ts; everything is cached like the
// other sets, so a quality change reuses the same GPU textures.

import {
  type PbrMaps,
  type Rgb,
  TexBuf,
  TexRng,
  cacheKey,
  cachedPbr,
  drawScratches,
  drawTextBlock,
  hashPix,
  lerp3,
  mix,
  noiseField,
  rgb,
  rustColor,
  sampleF,
  sstep,
  stampBlob,
} from "./textures";

/** Atlas region in UV space: [u0, v0, u1, v1], v upwards. */
export type Region = readonly [number, number, number, number];

/** Regions of the tip atlas (pbrTipAtlas). */
export const TR = {
  /** Painted corrugated sheet, heavily rusted (u along the sheet, v up). */
  sheet: [0, 0.5, 0.5, 1] as Region,
  /** Rust-through steel: bedstead, cable, drum rims, sign post. */
  steel: [0.5, 0.75, 1, 1] as Region,
  /** Galvanised steel with white rust and red rust at the foot (vent pipe). */
  galv: [0.875, 0, 1, 0.25] as Region,
  /** Gas warning sign, PORTRAIT (content rotated 90°; mapBoxFaceUvRot). */
  sign2: [0.75, 0, 0.875, 0.25] as Region,
  /** Drum lid, planar (bung at v ≈ 0.72); neutral paint for vertex tinting. */
  lid: [0.5, 0.5, 0.75, 0.75] as Region,
  /** Drum body wrap (u around, v up), two ribs and a faded label. */
  drum: [0.75, 0.5, 1, 0.75] as Region,
  /** Weathered concrete with lichen (boundary posts). */
  concrete: [0, 0.25, 0.25, 0.5] as Region,
  /** Enamel council sign, 2:1. */
  sign: [0.25, 0.25, 0.75, 0.5] as Region,
  /** Left half torn black bin bag, right half faded blue tarpaulin. */
  bag: [0.75, 0.25, 1, 0.5] as Region,
  /** Tyre: tread at the v ends (torus wrap), sidewall in the middle. */
  tyre: [0, 0, 0.5, 0.25] as Region,
  /** Bottle glass in three vertical strips: green, brown, clear. */
  glass: [0.5, 0, 0.75, 0.25] as Region,
};

/** Sub-region helper: a portion of `r` (fractions of its extent). */
export function subRegion(
  r: Region,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
): Region {
  const w = r[2] - r[0];
  const h = r[3] - r[1];
  return [r[0] + u0 * w, r[1] + v0 * h, r[0] + u1 * w, r[1] + v1 * h];
}

/** Iterate the pixels of a region; u/v are local 0..1 (v upwards). */
function eachIn(
  buf: TexBuf,
  r: Region,
  fn: (i: number, u: number, v: number, x: number, y: number) => void,
): void {
  const x0 = Math.round(r[0] * buf.w);
  const x1 = Math.round(r[2] * buf.w);
  const y0 = Math.round((1 - r[3]) * buf.h);
  const y1 = Math.round((1 - r[1]) * buf.h);
  const iw = 1 / (x1 - x0);
  const ih = 1 / (y1 - y0);
  for (let y = y0; y < y1; y++) {
    const v = (y1 - 1 - y + 0.5) * ih;
    const row = y * buf.w;
    for (let x = x0; x < x1; x++) fn(row + x, (x - x0 + 0.5) * iw, v, x, y);
  }
}

/** Pixel rectangle of a region on the canvas (y downwards). */
function pixRect(
  buf: TexBuf,
  r: Region,
): { x: number; y: number; w: number; h: number } {
  const x = Math.round(r[0] * buf.w);
  const y = Math.round((1 - r[3]) * buf.h);
  return {
    x,
    y,
    w: Math.round(r[2] * buf.w) - x,
    h: Math.round((1 - r[1]) * buf.h) - y,
  };
}

// ---------------------------------------------------------------------------
// Landfill strata
// ---------------------------------------------------------------------------

/** Muted fleck palette (weight per entry): plastic, paper, textile, foil. */
const WASTE_FLECKS: ReadonlyArray<readonly [string, number]> = [
  ["#cfc9bd", 0.14], // grubby white plastic
  ["#bfb397", 0.16], // paper / card
  ["#9aa0a6", 0.05], // foil
  ["#41618c", 0.12], // blue plastic
  ["#96412f", 0.11], // red plastic
  ["#b39a3d", 0.08], // faded yellow
  ["#4c6e42", 0.09], // green
  ["#26262a", 0.13], // black film
  ["#7a5a70", 0.06], // washed-out textile
  ["#a86a32", 0.06], // orange
];

/**
 * The exposed waste face, tileable, 6 m per tile: a chaotic matrix of
 * compacted refuse in low-contrast browns and greys, clustered flecks of
 * plastic, paper and textile, broken WAVY cover-soil lenses that pinch out
 * after a couple of metres, and dark leachate seeps bleeding down the face.
 * Deliberately aperiodic – a real waste face is a mess, not a layer cake.
 * map + normal + roughness.
 */
export function pbrTipStrata(size = 1024): PbrMaps {
  return cachedPbr(cacheKey("tipStrata", [size]), () => {
    const S = size;
    const rng = new TexRng(0x71b5);
    const BROWN: Rgb = rgb("#4d3d2e");
    const UMBER: Rgb = rgb("#5f4b38");
    const GREY: Rgb = rgb("#68625a");
    const DARK: Rgb = rgb("#3c352d");
    const SEEP: Rgb = rgb("#2a1f16");
    const buf = new TexBuf(S, S, BROWN, 0.88, 0);
    const nPatch = noiseField(S, S, 811, { freq: 4, oct: 4 });
    const nPatch2 = noiseField(S, S, 815, { freq: 6, oct: 3 });
    const nWarp = noiseField(S, S, 814, { freq: 3, oct: 3 });
    const nMid = noiseField(S, S, 812, { freq: 14, oct: 4 });
    const nHi = noiseField(S, S, 813, { freq: 60, oct: 3 });
    const nLump = noiseField(S, S, 818, { freq: 20, oct: 3, mode: "billow" });
    const k = S / 1024;
    const wrap: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [S, 0],
      [-S, 0],
      [0, S],
      [0, -S],
      [S, S],
      [-S, -S],
      [S, -S],
      [-S, S],
    ];

    // Clustered flecks – rubbish concentrates in pockets, never evenly
    const pickFleck = (): string => {
      let r = rng.next();
      for (const [c, p] of WASTE_FLECKS) {
        r -= p;
        if (r <= 0) return c;
      }
      return WASTE_FLECKS[0][0];
    };
    const flecks = buf.layer((ctx) => {
      const clusters = Math.round(46 * k * k);
      for (let c = 0; c < clusters; c++) {
        const cx = rng.next() * S;
        const cy = rng.next() * S;
        const spread = rng.range(18, 60) * k;
        const count = 6 + rng.int(16);
        for (let n = 0; n < count; n++) {
          const px0 = cx + rng.gauss() * spread;
          const py0 = cy + rng.gauss() * spread;
          const textile = rng.chance(0.15);
          const rx =
            (rng.chance(0.08) ? rng.range(9, 16) : rng.range(2, 7)) * k;
          const ry = rx * (textile ? rng.range(0.25, 0.4) : rng.range(0.4, 1));
          const rot = rng.next() * Math.PI;
          ctx.fillStyle = pickFleck();
          ctx.globalAlpha = rng.range(0.4, 0.85);
          for (const [ox, oy] of wrap) {
            const px = px0 + ox;
            const py = py0 + oy;
            if (px < -30 || px > S + 30 || py < -30 || py > S + 30) continue;
            ctx.save();
            ctx.translate(px, py);
            ctx.rotate(rot);
            ctx.beginPath();
            if (textile) ctx.rect(-rx * 1.6, -ry, rx * 3.2, ry * 2);
            else ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
        }
      }
      ctx.globalAlpha = 1;
    });

    // Cover-soil lenses: wavy tapered streaks that pinch out – never bands
    const LENS_COLS = ["#c2ad83", "#a77a42", "#8d8a82"];
    const lenses = buf.layer((ctx) => {
      const NPT = 8;
      const xs = new Float32Array(NPT + 1);
      const ys = new Float32Array(NPT + 1);
      for (let n = 0; n < 14; n++) {
        const long = n < 9;
        const L = S * (long ? rng.range(0.2, 0.45) : rng.range(0.06, 0.14));
        const x0 = rng.next() * S;
        let yy = rng.next() * S;
        const wMax = rng.range(5, 15) * k;
        const tilt = rng.range(-0.2, 0.2);
        for (let p = 0; p <= NPT; p++) {
          xs[p] = x0 + (p / NPT) * L;
          ys[p] = yy + tilt * (p / NPT) * L;
          yy += rng.range(-8, 8) * k;
        }
        ctx.fillStyle = rng.pick(LENS_COLS);
        ctx.globalAlpha = rng.range(0.75, 0.95);
        for (const [ox, oy] of wrap) {
          if (x0 + ox > S + 20 || x0 + L + ox < -20) continue;
          ctx.beginPath();
          for (let p = 0; p <= NPT; p++) {
            const hw = wMax * Math.sin((p / NPT) * Math.PI) ** 0.7 + 0.3;
            if (p === 0) ctx.moveTo(xs[p] + ox, ys[p] + oy - hw);
            else ctx.lineTo(xs[p] + ox, ys[p] + oy - hw);
          }
          for (let p = NPT; p >= 0; p--) {
            const hw = wMax * Math.sin((p / NPT) * Math.PI) ** 0.7 + 0.3;
            ctx.lineTo(xs[p] + ox, ys[p] + oy + hw);
          }
          ctx.closePath();
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    });

    // Leachate seeps bleeding down the face
    const seeps = buf.layer((ctx) => {
      for (let n = 0; n < 9; n++) {
        const x0 = rng.next() * S;
        const y0 = rng.next() * S;
        const len = S * rng.range(0.12, 0.3);
        const w = rng.range(7, 20) * k;
        for (const [ox, oy] of wrap) {
          const g = ctx.createLinearGradient(0, y0 + oy, 0, y0 + oy + len);
          g.addColorStop(0, "rgba(34,24,16,0.6)");
          g.addColorStop(1, "rgba(34,24,16,0)");
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.moveTo(x0 + ox - w * 0.35, y0 + oy);
          ctx.lineTo(x0 + ox + w * 0.35, y0 + oy);
          ctx.lineTo(x0 + ox + w * 0.6, y0 + oy + len);
          ctx.lineTo(x0 + ox - w * 0.6, y0 + oy + len);
          ctx.closePath();
          ctx.fill();
        }
      }
    });
    const lensA = TexBuf.layerAlpha(lenses, buf.n);
    const seepA = TexBuf.layerAlpha(seeps, buf.n);

    buf.each((i, _u, _v, x, y) => {
      const w = (nWarp[i] - 0.5) * 0.2;
      const patch = sampleF(nPatch, S, S, x / S + w, y / S - w * 0.7);
      const patch2 = sampleF(nPatch2, S, S, x / S - w * 0.6, y / S + w);
      const lump = nLump[i];
      const grain = hashPix(i, 7) - 0.5;
      let col = lerp3(BROWN, UMBER, sstep(0.35, 0.68, patch));
      col = lerp3(col, GREY, sstep(0.58, 0.85, patch2) * 0.75);
      col = lerp3(col, DARK, (1 - sstep(0.12, 0.4, lump)) * 0.45);
      const kk =
        0.92 +
        (nMid[i] - 0.5) * 0.24 +
        (nHi[i] - 0.5) * 0.16 +
        grain * 0.08 +
        lump * 0.1;
      col = [col[0] * kk, col[1] * kk, col[2] * kk];
      let hgt =
        lump * 0.45 +
        (nMid[i] - 0.5) * 0.22 +
        (nHi[i] - 0.5) * 0.18 +
        grain * 0.08;
      let ro = 0.9 + (nHi[i] - 0.5) * 0.06;
      const j = i * 4;
      const fa = (flecks[j + 3] / 255) * 0.92;
      if (fa > 0.02) {
        const fc: Rgb = [
          flecks[j] / 255,
          flecks[j + 1] / 255,
          flecks[j + 2] / 255,
        ];
        col = lerp3(col, lerp3(fc, BROWN, 0.3), fa);
        hgt += fa * 0.22;
        ro = mix(ro, 0.6, fa * 0.8);
      }
      const la = lensA[i];
      if (la > 0.02) {
        const lc: Rgb = [
          lenses[j] / 255,
          lenses[j + 1] / 255,
          lenses[j + 2] / 255,
        ];
        const lk = 0.9 + (nHi[i] - 0.5) * 0.24;
        col = lerp3(col, [lc[0] * lk, lc[1] * lk, lc[2] * lk], la * 0.9);
        hgt += la * 0.18;
        ro = mix(ro, 0.86, la);
      }
      const sa = seepA[i];
      if (sa > 0.02) {
        col = lerp3(col, SEEP, sa * 0.7);
        ro -= sa * 0.3;
      }
      buf.set(i, col);
      buf.hf[i] = hgt;
      buf.rough[i] = ro;
    });
    return buf.build({ normal: 4, normalScale: 0.8 });
  });
}

// ---------------------------------------------------------------------------
// Turf cap
// ---------------------------------------------------------------------------

/**
 * Coarse reclaimed-ground turf, tileable, 3 m per tile: a dull green-brown
 * sward with thatch and dead-straw patches, bare sandy soil breaking through,
 * mole hills and a fine blade grain. map + normal + roughness.
 */
export function pbrTipTurf(size = 1024): PbrMaps {
  return cachedPbr(cacheKey("tipTurf", [size]), () => {
    const S = size;
    const rng = new TexRng(0x7f0e);
    const SWARD: Rgb = rgb("#56622f");
    const SWARD_DRY: Rgb = rgb("#7d7c46");
    const SWARD_LUSH: Rgb = rgb("#4a6a2c");
    const THATCH: Rgb = rgb("#a89c66");
    const BARE_SOIL: Rgb = rgb("#8a7a58");
    const MOLE: Rgb = rgb("#4a3c2c");
    const CLOVER: Rgb = rgb("#8fa050");
    const buf = new TexBuf(S, S, SWARD, 0.9, 0);
    const nLow = noiseField(S, S, 831, { freq: 3, oct: 3 });
    const nMid = noiseField(S, S, 832, { freq: 10, oct: 4 });
    const nThatch = noiseField(S, S, 833, { freq: 7, oct: 4 });
    const nBare = noiseField(S, S, 834, { freq: 4, oct: 3 });
    const nBlade = noiseField(S, S, 835, { freq: 90, freqY: 140, oct: 2 });
    const nFine = noiseField(S, S, 836, { freq: 200, oct: 1 });
    // Mole hills: a few soft domes of dark soil
    const hills = new Float32Array(buf.n);
    const k = S / 1024;
    for (let n = 0; n < 2; n++) {
      const r = rng.range(52, 72) * k;
      stampBlob(
        hills,
        S,
        S,
        rng.next() * S,
        rng.next() * S,
        r,
        r * rng.range(0.8, 1),
        1,
        true,
      );
    }
    buf.each((i) => {
      const dry = sstep(0.4, 0.7, nLow[i]);
      let col = lerp3(
        lerp3(SWARD, SWARD_DRY, dry),
        SWARD_LUSH,
        sstep(0.55, 0.8, nMid[i]) * (1 - dry),
      );
      const kk =
        1 +
        (nBlade[i] - 0.5) * 0.24 +
        (nFine[i] - 0.5) * 0.1 +
        (hashPix(i, 13) - 0.5) * 0.08;
      col = [col[0] * kk, col[1] * kk, col[2] * kk];
      let hgt =
        (nBlade[i] - 0.5) * 0.3 +
        (nFine[i] - 0.5) * 0.1 +
        (nMid[i] - 0.5) * 0.2;
      let ro = 0.9 + (nFine[i] - 0.5) * 0.06;
      const thatch = sstep(0.58, 0.76, nThatch[i]);
      col = lerp3(col, THATCH, thatch * 0.65);
      hgt += thatch * 0.15;
      // Worn/dried patches: a subtle tone shift INSIDE the sward, never a
      // cut-out – the camouflage-blotch look came from hard bare patches
      const bare = sstep(0.6, 0.82, nBare[i] + (nFine[i] - 0.5) * 0.04) * 0.4;
      const soilK = 0.9 + nFine[i] * 0.2;
      col = lerp3(
        col,
        lerp3(
          SWARD_DRY,
          [BARE_SOIL[0] * soilK, BARE_SOIL[1] * soilK, BARE_SOIL[2] * soilK],
          0.5,
        ),
        bare,
      );
      hgt -= bare * 0.12;
      ro = mix(ro, 0.85, bare);
      const hill = Math.min(1, hills[i]);
      if (hill > 0.03) {
        col = lerp3(
          col,
          MOLE,
          sstep(0.08, 0.35, hill) * 0.7 * (0.85 + nFine[i] * 0.3),
        );
        hgt += hill * 0.9;
        ro = mix(ro, 0.95, hill);
      }
      if (hashPix(i, 17) > 0.994 && bare < 0.5) col = lerp3(col, CLOVER, 0.7);
      buf.set(i, col);
      buf.hf[i] = hgt;
      buf.rough[i] = ro;
    });
    return buf.build({ normal: 4, normalScale: 0.8 });
  });
}

// ---------------------------------------------------------------------------
// Debris / prop atlas
// ---------------------------------------------------------------------------

const PAINT_SHEET: Rgb = rgb("#6b7568");
const BARE: Rgb = rgb("#8f9294");
const RUST_FLAKE: Rgb = rgb("#3a2416");
const GALV: Rgb = rgb("#9aa3a6");
const WHITE_RUST: Rgb = rgb("#c9cdcb");
const LID_PAINT: Rgb = rgb("#b9bcb8");
const CONCRETE: Rgb = rgb("#a09c94");
const LICHEN_G: Rgb = rgb("#8a9a5a");
const LICHEN_Y: Rgb = rgb("#c9c26a");
const ALGAE: Rgb = rgb("#5a5f52");
const BAG: Rgb = rgb("#141416");
const DUST: Rgb = rgb("#4a4640");
const ENAMEL: Rgb = rgb("#e8e2cf");
const GLASS_GREEN: Rgb = rgb("#1f4d2a");
const GLASS_BROWN: Rgb = rgb("#5a3414");
const GLASS_CLEAR: Rgb = rgb("#b8c8b8");
const GRIME: Rgb = rgb("#5a5248");

/**
 * The tip atlas – see TR for the regions. 1024² (512² on medium/low),
 * map + normal + roughness + metalness. Several regions are painted neutral
 * so the mesh can tint them per item via vertex colours (drum lids, drum).
 */
export function pbrTipAtlas(size = 1024): PbrMaps {
  return cachedPbr(cacheKey("tipAtlas", [size]), () => {
    const S = size;
    const rng = new TexRng(0x7a71);
    const buf = new TexBuf(S, S, BARE, 0.6, 0.3);
    const nA = noiseField(S, S, 821, { freq: 6, oct: 5, gain: 0.55 });
    const nB = noiseField(S, S, 822, { freq: 24, oct: 3 });
    const nC = noiseField(S, S, 823, { freq: 72, oct: 2 });
    const nR = noiseField(S, S, 824, { freq: 14, oct: 4, mode: "ridged" });
    const nS = noiseField(S, S, 825, { freq: 64, freqY: 4, oct: 3 });
    const nW = noiseField(S, S, 826, { freq: 4, oct: 3 });
    const nCell = noiseField(S, S, 827, { freq: 30, oct: 1 });
    const k = S / 1024;

    // ---- vector layers: sign, tyre tread, drum label, lid ring ------------
    const sign = pixRect(buf, TR.sign);
    const tyre = pixRect(buf, TR.tyre);
    const drum = pixRect(buf, TR.drum);
    const lid = pixRect(buf, TR.lid);
    const layer = buf.layer((ctx) => {
      // Enamel sign
      {
        const { x, y, w, h } = sign;
        ctx.fillStyle = "#e8e2cf";
        ctx.fillRect(x, y, w, h);
        ctx.lineWidth = 12 * k;
        ctx.strokeStyle = "#1f3a63";
        ctx.strokeRect(x + 6 * k, y + 6 * k, w - 12 * k, h - 12 * k);
        ctx.fillStyle = "#1f3a63";
        ctx.fillRect(x + 12 * k, y + 12 * k, w - 24 * k, h * 0.24);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#f4f1e6";
        ctx.font = `bold ${Math.round(30 * k)}px Arial, Helvetica, sans-serif`;
        ctx.fillText(
          "CARNE DISTRICT COUNCIL",
          x + w / 2,
          y + 12 * k + h * 0.12,
          w * 0.9,
        );
        ctx.fillStyle = "#1f3a63";
        ctx.font = `bold ${Math.round(56 * k)}px Arial, Helvetica, sans-serif`;
        ctx.fillText("LANDFILL SITE", x + w / 2, y + h * 0.5, w * 0.9);
        ctx.fillStyle = "#a8251e";
        ctx.font = `bold ${Math.round(46 * k)}px Arial, Helvetica, sans-serif`;
        ctx.fillText("NO TIPPING", x + w / 2, y + h * 0.72, w * 0.9);
        ctx.fillStyle = "#2b2b2b";
        ctx.font = `${Math.round(17 * k)}px Arial, Helvetica, sans-serif`;
        ctx.fillText(
          "CONTROLLED WASTE  ·  KEEP OUT  ·  BY ORDER",
          x + w / 2,
          y + h * 0.9,
          w * 0.9,
        );
        // Fixing holes
        ctx.fillStyle = "#2a1c12";
        for (const [hx, hy] of [
          [0.05, 0.1],
          [0.95, 0.1],
          [0.05, 0.9],
          [0.95, 0.9],
        ]) {
          ctx.beginPath();
          ctx.arc(x + w * hx, y + h * hy, 5 * k, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // Tyre tread: blocks along u at the v ends (torus wrap), sidewall middle
      {
        const { x, y, w, h } = tyre;
        ctx.fillStyle = "#1e1e1f";
        ctx.fillRect(x, y, w, h);
        const blocks = 26;
        const bw = w / blocks;
        ctx.fillStyle = "#0c0c0d";
        for (let b = 0; b < blocks; b++) {
          const bx = x + b * bw;
          // grooves between the blocks (top and bottom tread bands)
          ctx.fillRect(bx, y, bw * 0.18, h * 0.24);
          ctx.fillRect(bx + bw * 0.5, y + h * 0.05, bw * 0.12, h * 0.14);
          ctx.fillRect(bx, y + h * 0.76, bw * 0.18, h * 0.24);
          ctx.fillRect(bx + bw * 0.5, y + h * 0.81, bw * 0.12, h * 0.14);
        }
        // circumferential grooves
        ctx.fillRect(x, y + h * 0.1, w, h * 0.025);
        ctx.fillRect(x, y + h * 0.875, w, h * 0.025);
        // sidewall bead lines
        ctx.fillStyle = "#2a2a2b";
        ctx.fillRect(x, y + h * 0.4, w, h * 0.02);
        ctx.fillRect(x, y + h * 0.58, w, h * 0.02);
      }
      // Drum label (faded)
      {
        const { x, y, w, h } = drum;
        ctx.fillStyle = "#d9d2bc";
        ctx.fillRect(x + w * 0.28, y + h * 0.28, w * 0.36, h * 0.34);
        ctx.fillStyle = "#8c2a22";
        ctx.fillRect(x + w * 0.28, y + h * 0.28, w * 0.36, h * 0.08);
        drawTextBlock(
          ctx,
          rng,
          x + w * 0.31,
          y + h * 0.43,
          w * 0.3,
          4,
          h * 0.045,
          `${Math.round(9 * k)}px Arial, Helvetica, sans-serif`,
          "#3a3a3a",
        );
      }
      // Lid: embossed ring + bung boss outline
      {
        const { x, y, w, h } = lid;
        const cx = x + w / 2;
        const cy = y + h / 2;
        ctx.strokeStyle = "rgba(60,60,60,0.55)";
        ctx.lineWidth = 3 * k;
        ctx.beginPath();
        ctx.arc(cx, cy, w * 0.3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = "#6a6a68";
        ctx.beginPath();
        ctx.arc(cx, y + h * 0.28, w * 0.075, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#3a3a38";
        ctx.beginPath();
        ctx.arc(cx, y + h * 0.28, w * 0.045, 0, Math.PI * 2);
        ctx.fill();
      }
      // Gas warning sign – drawn landscape, rotated into the portrait region
      {
        const r2 = pixRect(buf, TR.sign2);
        ctx.save();
        ctx.translate(r2.x + r2.w / 2, r2.y + r2.h / 2);
        ctx.rotate(-Math.PI / 2);
        const w = r2.h; // landscape extents after the rotation
        const h = r2.w;
        ctx.fillStyle = "#d8c22a";
        ctx.fillRect(-w / 2, -h / 2, w, h);
        ctx.lineWidth = 6 * k;
        ctx.strokeStyle = "#1d1d1d";
        ctx.strokeRect(-w / 2 + 4 * k, -h / 2 + 4 * k, w - 8 * k, h - 8 * k);
        ctx.fillStyle = "#a8251e";
        ctx.fillRect(-w / 2 + 8 * k, -h / 2 + 8 * k, w - 16 * k, h * 0.3);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#f4f1e6";
        ctx.font = `bold ${Math.round(30 * k)}px Arial, Helvetica, sans-serif`;
        ctx.fillText("DANGER", 0, -h / 2 + 8 * k + h * 0.15, w * 0.85);
        ctx.fillStyle = "#1d1d1d";
        ctx.font = `bold ${Math.round(21 * k)}px Arial, Helvetica, sans-serif`;
        ctx.fillText("ACTIVE LANDFILL GAS", 0, h * 0.06, w * 0.9);
        ctx.font = `bold ${Math.round(17 * k)}px Arial, Helvetica, sans-serif`;
        ctx.fillText("KEEP OFF THE FACE", 0, h * 0.28, w * 0.9);
        ctx.restore();
      }
    });
    const scratchA = TexBuf.layerAlpha(
      buf.layer((ctx) => drawScratches(ctx, rng, S, S, 260, 90 * k, 1, 0.55)),
      buf.n,
    );
    // Rust blooms on the sign (fixing holes, edges) as a stamped field
    const signRust = new Float32Array(buf.n);
    for (const [hx, hy] of [
      [0.05, 0.1],
      [0.95, 0.1],
      [0.05, 0.9],
      [0.95, 0.9],
    ]) {
      stampBlob(
        signRust,
        S,
        S,
        sign.x + sign.w * hx,
        sign.y + sign.h * hy,
        16 * k,
        20 * k,
        1.1,
        false,
      );
      // streak below the hole
      for (let s = 1; s < 5; s++)
        stampBlob(
          signRust,
          S,
          S,
          sign.x + sign.w * hx,
          sign.y + sign.h * hy + s * 12 * k,
          5 * k,
          14 * k,
          0.5 - s * 0.08,
          false,
        );
    }
    for (let n = 0; n < 26; n++) {
      const ex = rng.chance(0.5) ? rng.range(0, 0.06) : rng.range(0.94, 1);
      const ey = rng.next();
      const px = sign.x + sign.w * (rng.chance(0.5) ? ex : ey);
      const py = sign.y + sign.h * (rng.chance(0.5) ? ey : ex);
      stampBlob(
        signRust,
        S,
        S,
        px,
        py,
        rng.range(4, 10) * k,
        rng.range(4, 10) * k,
        rng.range(0.6, 1),
        false,
      );
    }

    const warped = (f: Float32Array, i: number, x: number, y: number): number =>
      sampleF(
        f,
        S,
        S,
        x / S + (nW[i] - 0.5) * 0.12,
        y / S - (nW[i] - 0.5) * 0.08,
      );

    // ---- sheet ------------------------------------------------------------
    eachIn(buf, TR.sheet, (i, u, v, x, y) => {
      const rw = warped(nA, i, x, y);
      let m = sstep(0.42, 0.68, rw);
      const e = Math.min(u, 1 - u, v, 1 - v);
      m = Math.max(m, (1 - sstep(0, 0.1, e)) * sstep(0.2, 0.5, nB[i]));
      const pit = sstep(0.8, 0.88, nC[i]);
      m = Math.min(1, m + sstep(0.66, 0.8, nC[i]) * 0.7);
      const tv = 1 + (nB[i] - 0.5) * 0.1;
      let col = lerp3(
        [PAINT_SHEET[0] * tv, PAINT_SHEET[1] * tv, PAINT_SHEET[2] * tv],
        rustColor(nB[i], nC[i]),
        m,
      );
      const streak =
        sstep(0.62, 0.82, nS[i]) * (1 - m) * sstep(1, 0.3, v) * 0.6;
      col = lerp3(col, rustColor(0.4, nC[i]), streak);
      const chip = hashPix(i, 11) > 0.996 ? 1 : 0;
      col = lerp3(col, BARE, chip * 0.8);
      col = [
        col[0] * (1 - pit * 0.5),
        col[1] * (1 - pit * 0.5),
        col[2] * (1 - pit * 0.5),
      ];
      buf.set(i, col);
      buf.hf[i] = m * nC[i] * 0.16 - pit * 0.4 + (nC[i] - 0.5) * 0.03;
      buf.rough[i] = mix(0.5, 0.92, m) + pit * 0.05 + streak * 0.2;
      buf.metal[i] = mix(0.75, 0.06, m) - streak * 0.3;
    });

    // ---- steel (rust-through) --------------------------------------------
    eachIn(buf, TR.steel, (i, _u, _v, x, y) => {
      const rw = warped(nA, i, x, y);
      let col = rustColor(rw, nC[i]);
      const flake = sstep(0.55, 0.72, nB[i]);
      col = lerp3(col, RUST_FLAKE, flake * 0.7);
      const bare = sstep(0.84, 0.92, nA[i]);
      col = lerp3(col, BARE, bare * 0.7);
      const sc = scratchA[i];
      col = lerp3(col, BARE, sc * 0.35);
      buf.set(i, col);
      buf.hf[i] = nC[i] * 0.14 + flake * 0.12 - sc * 0.05;
      buf.rough[i] = 0.9 - bare * 0.35 - sc * 0.2;
      buf.metal[i] = 0.12 + bare * 0.6 + sc * 0.3;
    });

    // ---- galvanised -------------------------------------------------------
    eachIn(buf, TR.galv, (i, _u, v) => {
      const cell = hashPix(Math.floor(nCell[i] * 60) + 5, 9);
      const kk = 1 + (cell - 0.5) * 0.12 + (nC[i] - 0.5) * 0.05;
      let col: Rgb = [GALV[0] * kk, GALV[1] * kk, GALV[2] * kk];
      const white = sstep(0.6, 0.8, nB[i]);
      col = lerp3(col, WHITE_RUST, white * 0.6);
      const foot = (1 - sstep(0.05, 0.3, v)) * sstep(0.3, 0.55, nA[i]);
      const streak = sstep(0.68, 0.85, nS[i]) * (1 - sstep(0.2, 0.6, v)) * 0.6;
      const rust = Math.min(1, foot + streak);
      col = lerp3(col, rustColor(nB[i], nC[i]), rust);
      buf.set(i, col);
      buf.hf[i] = (nC[i] - 0.5) * 0.04 + white * 0.03 + rust * nC[i] * 0.08;
      buf.rough[i] = 0.45 + white * 0.3 + rust * 0.4;
      buf.metal[i] = 0.85 - white * 0.3 - rust * 0.75;
    });

    // ---- drum lid ---------------------------------------------------------
    eachIn(buf, TR.lid, (i, u, v) => {
      const d = Math.hypot(u - 0.5, v - 0.5) * 2;
      const rim = d > 0.86;
      let col: Rgb;
      let m: number;
      if (rim || d > 1) {
        col = rustColor(nB[i], nC[i]);
        m = 1;
      } else {
        const tv = 1 + (nB[i] - 0.5) * 0.08;
        col = [LID_PAINT[0] * tv, LID_PAINT[1] * tv, LID_PAINT[2] * tv];
        m = sstep(0.5, 0.7, nA[i]);
        m = Math.max(m, sstep(0.66, 0.86, d) * sstep(0.3, 0.6, nB[i]));
        m = Math.min(1, m + sstep(0.7, 0.82, nC[i]) * 0.6);
        col = lerp3(col, rustColor(nB[i], nC[i]), m);
      }
      const j = i * 4;
      const la = layer[j + 3] / 255;
      if (la > 0.02)
        col = lerp3(
          col,
          [layer[j] / 255, layer[j + 1] / 255, layer[j + 2] / 255],
          la * 0.85,
        );
      // embossed ring and the rolled rim as height
      const ring = Math.exp(-(((d - 0.6) * 40) ** 2));
      const rimH = rim ? 0.3 : 0;
      buf.set(i, col);
      buf.hf[i] = ring * 0.25 + rimH + m * nC[i] * 0.1;
      buf.rough[i] = mix(0.45, 0.9, m);
      buf.metal[i] = mix(0.7, 0.08, m);
    });

    // ---- drum body --------------------------------------------------------
    eachIn(buf, TR.drum, (i, _u, v, x, y) => {
      const tv = 1 + (nB[i] - 0.5) * 0.08;
      let col: Rgb = [LID_PAINT[0] * tv, LID_PAINT[1] * tv, LID_PAINT[2] * tv];
      const rw = warped(nA, i, x, y);
      let m = sstep(0.5, 0.72, rw);
      m = Math.max(m, (1 - sstep(0.04, 0.28, v)) * sstep(0.25, 0.55, nB[i]));
      m = Math.max(m, (1 - sstep(0, 0.06, 1 - v)) * 0.8);
      const streak = sstep(0.66, 0.84, nS[i]) * (1 - sstep(0.3, 0.7, v)) * 0.7;
      m = Math.min(1, m + streak + sstep(0.72, 0.84, nC[i]) * 0.5);
      col = lerp3(col, rustColor(nB[i], nC[i]), m);
      const j = i * 4;
      const la = (layer[j + 3] / 255) * (1 - m * 0.7);
      if (la > 0.02)
        col = lerp3(
          col,
          [layer[j] / 255, layer[j + 1] / 255, layer[j + 2] / 255],
          la * 0.8,
        );
      const rib =
        Math.exp(-(((v - 0.33) * 60) ** 2)) +
        Math.exp(-(((v - 0.67) * 60) ** 2));
      col = [
        col[0] * (1 - rib * 0.12),
        col[1] * (1 - rib * 0.12),
        col[2] * (1 - rib * 0.12),
      ];
      buf.set(i, col);
      buf.hf[i] = rib * 0.35 + m * nC[i] * 0.12 + (nC[i] - 0.5) * 0.02;
      buf.rough[i] = mix(0.45, 0.9, m);
      buf.metal[i] = mix(0.7, 0.08, m);
    });

    // ---- concrete with lichen --------------------------------------------
    eachIn(buf, TR.concrete, (i, _u, v) => {
      let kk = 1 + (nA[i] - 0.5) * 0.18 + (nC[i] - 0.5) * 0.08;
      const hp = hashPix(i, 5);
      if (hp > 0.985) kk += 0.18;
      else if (hp < 0.012) kk -= 0.2;
      let col: Rgb = [CONCRETE[0] * kk, CONCRETE[1] * kk, CONCRETE[2] * kk];
      const pore = sstep(0.8, 0.88, nC[i]);
      col = [
        col[0] * (1 - pore * 0.45),
        col[1] * (1 - pore * 0.45),
        col[2] * (1 - pore * 0.45),
      ];
      const lg = sstep(0.62, 0.78, nB[i]) * sstep(0.4, 0.6, nA[i]);
      const ly = sstep(0.7, 0.84, nR[i]) * sstep(0.5, 0.7, nB[i]);
      col = lerp3(col, LICHEN_G, lg * 0.8);
      col = lerp3(col, LICHEN_Y, ly * 0.7);
      // Black algae streaks running down from the top
      const alg = sstep(0.6, 0.82, nS[i]) * sstep(0.2, 0.9, v) * 0.5;
      col = lerp3(col, ALGAE, alg);
      const crack = sstep(0.93, 0.98, nR[i]);
      col = [
        col[0] * (1 - crack * 0.5),
        col[1] * (1 - crack * 0.5),
        col[2] * (1 - crack * 0.5),
      ];
      buf.set(i, col);
      buf.hf[i] =
        (nA[i] - 0.5) * 0.12 +
        (nC[i] - 0.5) * 0.06 -
        pore * 0.3 -
        crack * 0.4 +
        lg * 0.08;
      buf.rough[i] = 0.9 + (nC[i] - 0.5) * 0.06 - alg * 0.1;
      buf.metal[i] = 0;
    });

    // ---- enamel sign ------------------------------------------------------
    eachIn(buf, TR.sign, (i, _u, v) => {
      const j = i * 4;
      let col: Rgb = [layer[j] / 255, layer[j + 1] / 255, layer[j + 2] / 255];
      // Fade + grime towards the bottom
      col = lerp3(col, ENAMEL, 0.12 + (nA[i] - 0.5) * 0.1);
      const grime =
        sstep(0.55, 0.85, nB[i]) * 0.25 + (1 - sstep(0, 0.25, v)) * 0.25;
      col = lerp3(col, GRIME, grime);
      const chip = Math.min(1, signRust[i]);
      const chipCore = sstep(0.35, 0.7, chip);
      col = lerp3(col, rustColor(nB[i], nC[i]), chipCore);
      const halo = sstep(0.08, 0.35, chip) * (1 - chipCore);
      col = lerp3(col, rustColor(0.7, nC[i]), halo * 0.5);
      const sc = scratchA[i];
      col = lerp3(col, [0.9, 0.88, 0.82], sc * 0.3);
      buf.set(i, col);
      buf.hf[i] = -chipCore * 0.3 + (nC[i] - 0.5) * 0.015 - sc * 0.04;
      buf.rough[i] = 0.25 + grime * 0.4 + chipCore * 0.6 + halo * 0.2;
      buf.metal[i] = chipCore * 0.1;
    });

    // ---- weathering over the gas sign -------------------------------------
    eachIn(buf, TR.sign2, (i, _u, v) => {
      const j = i * 4;
      let col: Rgb = [layer[j] / 255, layer[j + 1] / 255, layer[j + 2] / 255];
      const grime =
        sstep(0.5, 0.85, nB[i]) * 0.3 + (1 - sstep(0, 0.3, v)) * 0.2;
      col = lerp3(col, GRIME, grime);
      const chip = sstep(0.8, 0.92, nA[i]);
      col = lerp3(col, rustColor(nB[i], nC[i]), chip * 0.8);
      const sc = scratchA[i];
      col = lerp3(col, [0.88, 0.85, 0.78], sc * 0.35);
      buf.set(i, col);
      buf.hf[i] = (nC[i] - 0.5) * 0.02 - chip * 0.2 - sc * 0.04;
      buf.rough[i] = 0.4 + grime * 0.35 + chip * 0.5;
      buf.metal[i] = chip * 0.1;
    });

    // ---- bin bag (left half) / faded tarpaulin (right half) ---------------
    const TARP: Rgb = rgb("#4b5a63");
    const TARP_FADE: Rgb = rgb("#76858d");
    eachIn(buf, TR.bag, (i, u) => {
      const crease = sstep(0.55, 0.95, nR[i]);
      const dust = sstep(0.6, 0.85, nB[i]) * sstep(0.4, 0.7, nA[i]);
      if (u < 0.5) {
        const kk = 1 + (nC[i] - 0.5) * 0.15 + crease * 0.4;
        let col: Rgb = [BAG[0] * kk, BAG[1] * kk, BAG[2] * kk];
        col = lerp3(col, DUST, dust * 0.6);
        buf.set(i, col);
        buf.hf[i] = crease * 0.35 + (nB[i] - 0.5) * 0.1;
        buf.rough[i] = 0.32 + crease * 0.15 + dust * 0.5 + (nC[i] - 0.5) * 0.05;
      } else {
        let col = lerp3(TARP, TARP_FADE, sstep(0.35, 0.75, nA[i]));
        const kk = 1 + (nC[i] - 0.5) * 0.1 + crease * 0.22;
        col = [col[0] * kk, col[1] * kk, col[2] * kk];
        col = lerp3(col, DUST, dust * 0.5);
        buf.set(i, col);
        buf.hf[i] = crease * 0.3 + (nB[i] - 0.5) * 0.08;
        buf.rough[i] = 0.55 + crease * 0.1 + dust * 0.3;
      }
      buf.metal[i] = 0;
    });

    // ---- tyre -------------------------------------------------------------
    eachIn(buf, TR.tyre, (i) => {
      const j = i * 4;
      let col: Rgb = [layer[j] / 255, layer[j + 1] / 255, layer[j + 2] / 255];
      const groove = 1 - sstep(0.06, 0.12, col[0]); // dark grooves painted darker
      const dust = sstep(0.62, 0.85, nB[i]) * 0.5;
      col = lerp3(col, DUST, dust * 0.7);
      col = [
        col[0] * (1 + (nC[i] - 0.5) * 0.15),
        col[1] * (1 + (nC[i] - 0.5) * 0.15),
        col[2] * (1 + (nC[i] - 0.5) * 0.15),
      ];
      buf.set(i, col);
      buf.hf[i] = -groove * 0.5 + (nC[i] - 0.5) * 0.04;
      buf.rough[i] = 0.72 + dust * 0.25 - groove * 0.1;
      buf.metal[i] = 0;
    });

    // ---- glass ------------------------------------------------------------
    eachIn(buf, TR.glass, (i, u) => {
      const base =
        u < 1 / 3 ? GLASS_GREEN : u < 2 / 3 ? GLASS_BROWN : GLASS_CLEAR;
      const kk = 1 + (nC[i] - 0.5) * 0.12;
      let col: Rgb = [base[0] * kk, base[1] * kk, base[2] * kk];
      const dust = sstep(0.65, 0.85, nB[i]);
      col = lerp3(col, DUST, dust * 0.35);
      const sc = scratchA[i];
      col = lerp3(col, [0.85, 0.88, 0.85], sc * 0.2);
      buf.set(i, col);
      buf.hf[i] = (nC[i] - 0.5) * 0.01 - sc * 0.03;
      buf.rough[i] = 0.06 + dust * 0.5 + sc * 0.2;
      buf.metal[i] = 0;
    });

    return buf.build({
      wrapU: false,
      wrapV: false,
      normal: 4,
      normalScale: 0.9,
      metal: true,
    });
  });
}
