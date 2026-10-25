// Procedural PBR sets for trash objects and the player's bucket.
// All brands/graphics are invented. The UV layout is documented above each
// function.

import {
  type PbrMaps,
  type Rgb,
  TexBuf,
  TexRng,
  blurField,
  cacheKey,
  cachedPbr,
  clamp01,
  drawBarcode,
  drawScratches,
  drawTextBlock,
  hashPix,
  lerp3,
  mix,
  noiseField,
  rgb,
  sstep,
  stampBlob,
} from "./textures-core";

const ALU: Rgb = rgb("#cfd2d4");
const SAND: Rgb = rgb("#c9b58f");
const GRIME: Rgb = rgb("#4a4034");
const WHITE_SCUFF: Rgb = [0.92, 0.92, 0.9];

// ---------------------------------------------------------------------------
// Cans
// ---------------------------------------------------------------------------

export type CanKind = "cola" | "beer" | "energy" | "soda";

interface CanTheme {
  bg: string;
  accent: string;
  accent2: string;
  brand: string;
  sub: string;
  ink: string;
}

const CAN_THEMES: Record<CanKind, CanTheme> = {
  cola: {
    bg: "#b5121b",
    accent: "#ffffff",
    accent2: "#3b0a0c",
    brand: "COLA MAX",
    sub: "ORIGINAL TASTE",
    ink: "#ffffff",
  },
  beer: {
    bg: "#e2bd52",
    accent: "#1f5a2e",
    accent2: "#fff4d0",
    brand: "DUNE BREW",
    sub: "PILSNER · 4.9% VOL",
    ink: "#1f5a2e",
  },
  energy: {
    bg: "#17181a",
    accent: "#9bff2e",
    accent2: "#2b2f33",
    brand: "VOLT RUSH",
    sub: "ENERGY DRINK",
    ink: "#9bff2e",
  },
  soda: {
    bg: "#f28c1e",
    accent: "#1d5fb5",
    accent2: "#ffe8b0",
    brand: "CITRO FIZZ",
    sub: "LEMON SODA",
    ink: "#ffffff",
  },
};

/**
 * Drinks can. UV: **u around the can** (tileable), **v = 0 bottom → 1 lid**.
 * Printed over v 0.06–0.93, with a narrow strip of bare aluminium below/above
 * (the lid/bottom itself comes from the modeller). Front at u ≈ 0.27, back
 * (text, barcode) at u ≈ 0.75. `crushed`: kinks/creases in the normal map.
 * 1024×512, map + normal + roughness + metalness.
 */
export function pbrCanLabel(
  kind: CanKind,
  opts: { crushed?: boolean; dents?: number } = {},
): PbrMaps {
  const crushed = opts.crushed === true;
  const dents = Math.max(0, Math.round(opts.dents ?? 3));
  return cachedPbr(cacheKey("can", [kind, crushed, dents]), () => {
    const W = 1024;
    const H = 512;
    const rng = new TexRng(0xc4a + kind.length * 131 + (crushed ? 7 : 0));
    const th = CAN_THEMES[kind];
    const buf = new TexBuf(W, H, rgb(th.bg), 0.35, 0.6);
    const yTop = (1 - 0.93) * H;
    const yBot = (1 - 0.06) * H;
    buf.blendLayer(
      buf.layer((ctx) => {
        ctx.fillStyle = "#c9ccce";
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = th.bg;
        ctx.fillRect(0, yTop, W, yBot - yTop);
        ctx.fillStyle = th.accent;
        ctx.beginPath();
        ctx.moveTo(0, H * 0.62);
        ctx.bezierCurveTo(W * 0.3, H * 0.45, W * 0.5, H * 0.85, W, H * 0.6);
        ctx.lineTo(W, H * 0.72);
        ctx.bezierCurveTo(W * 0.6, H * 0.95, W * 0.3, H * 0.6, 0, H * 0.74);
        ctx.closePath();
        ctx.fill();
        ctx.save();
        ctx.translate(W * 0.27, H * 0.42);
        ctx.rotate(-0.1);
        ctx.font = "italic bold 118px Impact, 'Arial Black', Arial, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = th.accent2;
        ctx.fillText(th.brand, 5, 6, W * 0.42);
        ctx.fillStyle = th.ink;
        ctx.fillText(th.brand, 0, 0, W * 0.42);
        ctx.font = "bold 34px Arial, Helvetica, sans-serif";
        ctx.fillText(th.sub, 0, 84);
        ctx.restore();
        ctx.beginPath();
        ctx.arc(W * 0.27, H * 0.8, 34, 0, Math.PI * 2);
        ctx.fillStyle = th.accent2;
        ctx.fill();
        ctx.fillStyle = th.ink;
        ctx.font = "bold 20px Arial, Helvetica, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("0.33 L", W * 0.27, H * 0.8);
        ctx.font = "bold 56px Impact, 'Arial Black', Arial, sans-serif";
        ctx.fillText(th.brand, W * 0.75, H * 0.2, W * 0.36);
        drawTextBlock(
          ctx,
          rng,
          W * 0.6,
          H * 0.33,
          W * 0.3,
          8,
          20,
          "15px Arial, Helvetica, sans-serif",
          th.ink,
        );
        drawBarcode(ctx, rng, W * 0.66, H * 0.68, 170, 80);
      }),
    );
    const nStreak = noiseField(W, H, 401, {
      freq: 2,
      freqY: 200,
      oct: 2,
      gain: 0.6,
    });
    const nGrime = noiseField(W, H, 402, { freq: 8, freqY: 4, oct: 4 });
    const scratchA = TexBuf.layerAlpha(
      buf.layer((ctx) =>
        drawScratches(ctx, rng, W, H, crushed ? 120 : 60, 110, 1, 0.9, 0.1),
      ),
      buf.n,
    );
    const dent = new Float32Array(buf.n);
    for (let k = 0; k < dents; k++) {
      stampBlob(
        dent,
        W,
        H,
        rng.next() * W,
        H * rng.range(0.15, 0.85),
        rng.range(30, 70),
        rng.range(25, 60),
        -1,
        true,
      );
    }
    let crease: Float32Array | null = null;
    let nCr: Float32Array | null = null;
    if (crushed) {
      for (let k = 0; k < 8; k++) {
        stampBlob(
          dent,
          W,
          H,
          rng.next() * W,
          H * rng.range(0.1, 0.9),
          rng.range(60, 140),
          rng.range(40, 90),
          rng.range(-1.4, -0.6),
          true,
        );
      }
      nCr = noiseField(W, H, 403, {
        freq: 6,
        freqY: 4,
        oct: 3,
        mode: "ridged",
        gain: 0.6,
      });
      crease = blurField(
        TexBuf.layerAlpha(
          buf.layer((ctx) => {
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = 3;
            for (let k = 0; k < 7; k++) {
              const x0 = rng.next() * W;
              const y0 = rng.next() * H;
              const ang = rng.next() * Math.PI;
              const L = rng.range(150, 500);
              ctx.beginPath();
              ctx.moveTo(x0, y0);
              ctx.lineTo(x0 + Math.cos(ang) * L, y0 + Math.sin(ang) * L);
              ctx.stroke();
            }
          }),
          buf.n,
        ),
        W,
        H,
        1,
        true,
        false,
        1,
      );
    }
    buf.each((i, _u, v) => {
      const band = v < 0.06 || v > 0.93;
      const st = nStreak[i];
      buf.mul(i, 0.96 + st * 0.08);
      let hgt = dent[i] * 0.5 + (hashPix(i, 4) - 0.5) * 0.006;
      let ro = (band ? 0.28 : 0.36) + (st - 0.5) * 0.06;
      let me = band ? 1 : 0.6;
      if (crease && nCr) {
        const c = sstep(0.72, 0.92, nCr[i]);
        hgt -= c * 0.5 + crease[i] * 0.6;
        ro += c * 0.15;
        buf.mixTo(i, ALU, c * 0.25);
        me = mix(me, 0.9, c * 0.3);
      }
      const sc = scratchA[i];
      if (sc > 0.01) {
        buf.mixTo(i, ALU, sc * 0.85);
        hgt -= sc * 0.1;
        ro = mix(ro, 0.3, sc);
        me = mix(me, 1, sc);
      }
      const grime =
        (1 - sstep(0.03, 0.3, v)) * sstep(0.4, 0.8, nGrime[i]) * 0.3;
      buf.mixTo(i, SAND, grime);
      buf.hf[i] = hgt;
      buf.rough[i] = ro + grime * 0.4;
      buf.metal[i] = me - grime * 0.4;
    });
    return buf.build({
      wrapV: false,
      normal: crushed ? 4 : 3,
      normalScale: 1,
      metal: true,
    });
  });
}

// ---------------------------------------------------------------------------
// Bottles
// ---------------------------------------------------------------------------

export type BottleKind = "glass_green" | "glass_brown" | "plastic_bottle";

interface BottleTheme {
  paper: boolean;
  bg: string;
  accent: string;
  accent2: string;
  brand: string;
  sub: string;
  ink: string;
}

const BOTTLE_THEMES: Record<BottleKind, BottleTheme> = {
  glass_green: {
    paper: true,
    bg: "#f4f1e6",
    accent: "#1d6fa8",
    accent2: "#2c9e6b",
    brand: "BLUEWELL",
    sub: "NATURAL MINERAL WATER · CLASSIC",
    ink: "#173f66",
  },
  glass_brown: {
    paper: true,
    bg: "#efe3c4",
    accent: "#8a2a1f",
    accent2: "#c9a24a",
    brand: "DUNE BREW",
    sub: "PALE LAGER · 0.5 L · 4.9 % VOL",
    ink: "#3d2413",
  },
  plastic_bottle: {
    paper: false,
    bg: "#1f6fc2",
    accent: "#ffffff",
    accent2: "#7fd0ff",
    brand: "TIDESPRING",
    sub: "STILL · 0.5 L",
    ink: "#ffffff",
  },
};

/**
 * Bottle label as a strip: **u around the bottle** (tileable), **v = label
 * bottom (0) → top (1)**. Put it on its own open cylinder (label height).
 * Front at u ≈ 0.27, back at u ≈ 0.75 (nutrition table, barcode).
 * Paper labels have alpha (torn corner at the glue seam u ≈ 0) – use a
 * material with alphaTest 0.5. Plastic: glossy film without alpha.
 * 1024×384, map + normal + roughness.
 */
export function pbrBottleLabel(kind: BottleKind): PbrMaps {
  return cachedPbr(cacheKey("bottle", [kind]), () => {
    const W = 1024;
    const H = 384;
    const rng = new TexRng(0xb07 + kind.length * 17);
    const th = BOTTLE_THEMES[kind];
    const buf = new TexBuf(W, H, rgb(th.bg), th.paper ? 0.8 : 0.28, 0);
    buf.blendLayer(
      buf.layer((ctx) => {
        ctx.fillStyle = th.bg;
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = th.accent;
        ctx.fillRect(0, 0, W, 7);
        ctx.fillRect(0, H - 7, W, 7);
        // Emblem: circle with a wave
        const ex = W * 0.27;
        const ey = H * 0.34;
        ctx.lineWidth = 5;
        ctx.strokeStyle = th.accent;
        ctx.beginPath();
        ctx.arc(ex, ey, 54, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = th.accent2;
        ctx.beginPath();
        ctx.moveTo(ex - 40, ey + 10);
        ctx.bezierCurveTo(ex - 20, ey - 25, ex, ey + 25, ex + 40, ey - 5);
        ctx.lineTo(ex + 40, ey + 22);
        ctx.lineTo(ex - 40, ey + 22);
        ctx.closePath();
        ctx.fill();
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = th.accent;
        ctx.font = th.paper
          ? "bold 78px Georgia, 'Times New Roman', serif"
          : "italic bold 84px Arial, Helvetica, sans-serif";
        ctx.fillText(th.brand, ex, H * 0.64, W * 0.42);
        ctx.fillStyle = th.ink;
        ctx.font = "bold 20px Arial, Helvetica, sans-serif";
        ctx.fillText(th.sub, ex, H * 0.84, W * 0.42);
        // Back
        ctx.font = "bold 26px Arial, Helvetica, sans-serif";
        ctx.textAlign = "left";
        ctx.fillText("Nutrition per 100 ml", W * 0.56, H * 0.14);
        drawTextBlock(
          ctx,
          rng,
          W * 0.56,
          H * 0.27,
          W * 0.38,
          7,
          21,
          "16px Arial, Helvetica, sans-serif",
          th.ink,
        );
        drawBarcode(ctx, rng, W * 0.62, H * 0.66, 180, 72);
        ctx.font = "13px Arial, Helvetica, sans-serif";
        ctx.fillText("Returnable · Please give back", W * 0.56, H * 0.93);
      }),
    );
    const nF = noiseField(W, H, 411, { freq: 3, freqY: 200, oct: 2 });
    const nS = noiseField(W, H, 412, { freq: 6, freqY: 3, oct: 4 });
    const nW = noiseField(W, H, 413, {
      freq: 5,
      freqY: 3,
      oct: 3,
      mode: "ridged",
    });
    const tear = new Float32Array(buf.n);
    if (th.paper) {
      stampBlob(tear, W, H, 0, H, 90, 70, 1, true);
      stampBlob(tear, W, H, W * 0.2, 0, 40, 30, 0.8, true);
    }
    const scratchA = th.paper
      ? null
      : TexBuf.layerAlpha(
          buf.layer((ctx) => drawScratches(ctx, rng, W, H, 30, 80, 1, 0.6)),
          buf.n,
        );
    const STAIN: Rgb = rgb("#b99a5e");
    buf.each((i, u) => {
      let hgt = 0;
      let ro = th.paper ? 0.8 : 0.28;
      if (th.paper) {
        buf.mul(i, 0.96 + nF[i] * 0.08);
        hgt = (nF[i] - 0.5) * 0.03;
        const stain = sstep(0.62, 0.9, nS[i]) * 0.4;
        buf.mixTo(i, STAIN, stain);
        ro -= stain * 0.15;
        ro += (nF[i] - 0.5) * 0.06;
        buf.a[i] = 1 - sstep(0.45, 0.65, tear[i] + (nW[i] - 0.5) * 0.3);
        // Glue seam (overlap)
        const seam = sstep(0.955, 0.965, u) * (1 - sstep(0.985, 0.995, u));
        buf.mul(i, 1 - seam * 0.12);
        hgt += seam * 0.06;
      } else {
        const wr = sstep(0.7, 0.95, nW[i]);
        hgt = -wr * 0.2 + (nF[i] - 0.5) * 0.01;
        ro += wr * 0.15;
        const sc = scratchA ? scratchA[i] : 0;
        buf.mixTo(i, WHITE_SCUFF, sc * 0.5);
        ro += sc * 0.2;
      }
      buf.hf[i] = hgt;
      buf.rough[i] = ro;
    });
    return th.paper
      ? buf.build({
          wrapV: false,
          normal: 4,
          normalScale: 0.5,
          alpha: true,
          alphaTest: 0.5,
        })
      : buf.build({ wrapV: false, normal: 4, normalScale: 0.7 });
  });
}

/**
 * Glass: almost white `map` (multiplied by the material color), roughness with
 * smears/fingerprints and dust, very faint normal map (waviness). Tileable,
 * 512². Intended for MeshPhysicalMaterial (transmission/clearcoat).
 */
export function pbrGlass(): PbrMaps {
  return cachedPbr(cacheKey("glass", []), () => {
    const S = 512;
    const buf = new TexBuf(S, S, [0.95, 0.96, 0.96], 0.05, 0);
    const nS = noiseField(S, S, 421, { freq: 3, oct: 4 });
    const nW = noiseField(S, S, 422, { freq: 4, oct: 3 });
    const nD = noiseField(S, S, 423, { freq: 120, oct: 1 });
    buf.each((i) => {
      const smudge = sstep(0.55, 0.85, nS[i]);
      const dust = hashPix(i, 2) > 0.985 ? 0.2 : 0;
      buf.mul(i, 1 - smudge * 0.05);
      buf.rough[i] = 0.04 + smudge * 0.22 + dust + (nD[i] - 0.5) * 0.03;
      buf.hf[i] = nW[i] * 0.05;
    });
    return buf.build({ normal: 2, normalScale: 0.15 });
  });
}

// ---------------------------------------------------------------------------
// Plastic
// ---------------------------------------------------------------------------

/**
 * Sun-bleached plastic (bucket, crate, flip-flop strap, canister cap).
 * Tileable, 512², map + normal + roughness. `print`: "stripes" = two color
 * bands at v 0.30–0.38 / 0.62–0.70, "logo" = round emblem in the middle.
 */
export function pbrPlastic(
  colorHex: string | number,
  opts: { wear?: number; print?: "none" | "stripes" | "logo" } = {},
): PbrMaps {
  const wear = clamp01(opts.wear ?? 0.5);
  const print = opts.print ?? "none";
  return cachedPbr(cacheKey("plastic", [colorHex, wear, print]), () => {
    const S = 512;
    const rng = new TexRng(0x9a5 + Math.round(wear * 97));
    const base = rgb(colorHex);
    const buf = new TexBuf(S, S, base, 0.42, 0);
    const nB = noiseField(S, S, 431, { freq: 3, oct: 4 });
    const nF = noiseField(S, S, 432, { freq: 90, oct: 2 });
    const nD = noiseField(S, S, 433, { freq: 6, oct: 4 });
    const nG = noiseField(S, S, 434, { freq: 5, oct: 4 });
    const scratchA = TexBuf.layerAlpha(
      buf.layer((ctx) =>
        drawScratches(
          ctx,
          rng,
          S,
          S,
          Math.round(40 + 120 * wear),
          90,
          1.2,
          0.7,
        ),
      ),
      buf.n,
    );
    const dirtIn = blurField(Float32Array.from(scratchA), S, S, 2);
    const lum = base[0] * 0.3 + base[1] * 0.59 + base[2] * 0.11;
    const inkCss = lum > 0.5 ? "#2a2a2e" : "#f4f4f2";
    const ink: Rgb = rgb(inkCss);
    const printA =
      print === "none"
        ? null
        : TexBuf.layerAlpha(
            buf.layer((ctx) => {
              ctx.fillStyle = inkCss;
              ctx.strokeStyle = inkCss;
              if (print === "stripes") {
                ctx.fillRect(0, S * 0.62, S, S * 0.08);
                ctx.fillRect(0, S * 0.3, S, S * 0.08);
              } else {
                ctx.lineWidth = 7;
                ctx.beginPath();
                ctx.arc(S / 2, S / 2, S * 0.18, 0, Math.PI * 2);
                ctx.stroke();
                ctx.font = "bold 46px Arial, Helvetica, sans-serif";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText("PLASTO", S / 2, S * 0.5);
                ctx.lineWidth = 4;
                ctx.beginPath();
                ctx.moveTo(S / 2, S * 0.36);
                ctx.lineTo(S * 0.56, S * 0.44);
                ctx.lineTo(S * 0.44, S * 0.44);
                ctx.closePath();
                ctx.stroke();
              }
            }),
            buf.n,
          );
    const bleached = lerp3(base, [0.85, 0.83, 0.78], 0.55);
    buf.each((i) => {
      const bleach = wear * 0.45 * sstep(0.3, 0.8, nB[i]);
      buf.mixTo(i, bleached, bleach);
      if (printA) {
        const t = printA[i] * 0.85 * (1 - wear * 0.6 * sstep(0.3, 0.7, nD[i]));
        buf.mixTo(i, ink, t);
      }
      buf.mul(i, 1 + (nF[i] - 0.5) * 0.05);
      let hgt = (nF[i] - 0.5) * 0.03;
      let ro = 0.42 + wear * 0.12 + (nF[i] - 0.5) * 0.06;
      const sc = scratchA[i];
      buf.mixTo(i, WHITE_SCUFF, 0.5 * sc);
      hgt -= 0.2 * sc;
      ro += 0.3 * sc;
      const di = dirtIn[i] * sstep(0.4, 0.8, nD[i]) * wear;
      buf.mixTo(i, GRIME, 0.35 * di);
      const gp = sstep(0.62, 0.9, nG[i]) * wear;
      buf.mixTo(i, GRIME, 0.25 * gp);
      ro += 0.2 * gp;
      buf.hf[i] = hgt;
      buf.rough[i] = ro;
    });
    return buf.build({ normal: 4, normalScale: 0.6 });
  });
}

/**
 * Yellow HDPE canister. UV: **u around the body in four quarters** (+z front →
 * +x → −z → −x, see `remapBoxUvAround`), **v = 0 bottom → 1 top**.
 * Front: hazard pictogram + brand; sides: embossed ribs + litre scale;
 * back: warning text + barcode. 1024×512, map + normal + roughness.
 */
export function pbrCanister(colorHex: string | number = "#d8b93c"): PbrMaps {
  return cachedPbr(cacheKey("canister", [colorHex]), () => {
    const W = 1024;
    const H = 512;
    const rng = new TexRng(0xca9);
    const base = rgb(colorHex);
    const buf = new TexBuf(W, H, base, 0.5, 0);
    const Q = W / 4;
    // Print
    buf.blendLayer(
      buf.layer((ctx) => {
        // Front: hazard label
        const cx = Q * 0.5;
        const cy = H * 0.42;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = "#f2f2ee";
        ctx.fillRect(-72, -72, 144, 144);
        ctx.lineWidth = 9;
        ctx.strokeStyle = "#c81e1e";
        ctx.strokeRect(-72, -72, 144, 144);
        ctx.restore();
        // Symbol: circle + crossed bars (abstract)
        ctx.fillStyle = "#151515";
        ctx.beginPath();
        ctx.arc(cx, cy - 18, 26, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#f2f2ee";
        ctx.beginPath();
        ctx.arc(cx - 9, cy - 22, 5, 0, Math.PI * 2);
        ctx.arc(cx + 9, cy - 22, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#151515";
        ctx.lineWidth = 9;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(cx - 34, cy + 6);
        ctx.lineTo(cx + 34, cy + 42);
        ctx.moveTo(cx + 34, cy + 6);
        ctx.lineTo(cx - 34, cy + 42);
        ctx.stroke();
        ctx.fillStyle = "#151515";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = "bold 44px Arial, Helvetica, sans-serif";
        ctx.fillText("CORROSOL", cx, H * 0.7, Q * 0.9);
        ctx.font = "bold 30px Arial, Helvetica, sans-serif";
        ctx.fillText("5 L · TECHNICAL", cx, H * 0.78, Q * 0.9);
        ctx.font = "14px Arial, Helvetica, sans-serif";
        drawTextBlock(
          ctx,
          rng,
          Q * 0.08,
          H * 0.86,
          Q * 0.84,
          3,
          16,
          "13px Arial, Helvetica, sans-serif",
          "#151515",
        );
        // Back: warning text + barcode
        ctx.fillStyle = "#151515";
        ctx.textAlign = "left";
        ctx.font = "bold 24px Arial, Helvetica, sans-serif";
        ctx.fillText("HAZMAT · CLASS 8", Q * 2.08, H * 0.2);
        drawTextBlock(
          ctx,
          rng,
          Q * 2.08,
          H * 0.3,
          Q * 0.84,
          9,
          19,
          "14px Arial, Helvetica, sans-serif",
          "#151515",
        );
        drawBarcode(ctx, rng, Q * 2.2, H * 0.7, 150, 66);
        // Side 3: recycling triangle + "02 PE-HD"
        const tx = Q * 3.5;
        const ty = H * 0.3;
        ctx.strokeStyle = "#151515";
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(tx, ty - 34);
        ctx.lineTo(tx + 30, ty + 20);
        ctx.lineTo(tx - 30, ty + 20);
        ctx.closePath();
        ctx.stroke();
        ctx.textAlign = "center";
        ctx.font = "bold 18px Arial, Helvetica, sans-serif";
        ctx.fillText("02", tx, ty + 4);
        ctx.fillText("PE-HD", tx, ty + 42);
      }),
    );
    // Embossing (ribs, scale) as a height layer
    const emboss = blurField(
      TexBuf.layerAlpha(
        buf.layer((ctx) => {
          ctx.fillStyle = "#fff";
          for (const q of [1, 3]) {
            for (let k = 0; k < 6; k++) {
              const y = H * (0.2 + k * 0.1);
              ctx.fillRect(Q * q + 14, y - 3, Q - 28, 6);
            }
            ctx.font = "bold 22px Arial, Helvetica, sans-serif";
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            for (let l = 1; l <= 5; l++) {
              const y = H * (1 - (0.14 + l * 0.14));
              ctx.fillRect(Q * q + Q * 0.86, y - 2, 22, 4);
              ctx.fillText(`${l}`, Q * q + Q * 0.86 + 28, y);
            }
          }
          // Grip recess at the top of the front
          ctx.fillRect(Q * 0.15, H * 0.05, Q * 0.7, 18);
        }),
        buf.n,
      ),
      W,
      H,
      1,
      true,
      false,
      1,
    );
    const nG = noiseField(W, H, 441, { freq: 6, freqY: 3, oct: 5 });
    const nF = noiseField(W, H, 442, { freq: 80, freqY: 40, oct: 2 });
    const nB = noiseField(W, H, 443, { freq: 3, freqY: 2, oct: 3 });
    const scratchA = TexBuf.layerAlpha(
      buf.layer((ctx) => drawScratches(ctx, rng, W, H, 70, 90, 1.2, 0.7)),
      buf.n,
    );
    const bleached = lerp3(base, [0.9, 0.87, 0.75], 0.5);
    buf.each((i, _u, v) => {
      buf.mixTo(i, bleached, sstep(0.4, 0.95, v) * 0.35 * (0.5 + nB[i] * 0.5));
      buf.mul(i, 1 + (nF[i] - 0.5) * 0.05);
      let hgt = emboss[i] * 0.35 + (nF[i] - 0.5) * 0.02;
      let ro = 0.5 + (nF[i] - 0.5) * 0.06;
      const grime =
        sstep(0.55, 0.85, nG[i]) * 0.3 +
        (1 - sstep(0.02, 0.22, v)) * 0.35 * nG[i];
      buf.mixTo(i, GRIME, grime);
      ro += grime * 0.3;
      const sc = scratchA[i];
      buf.mixTo(i, WHITE_SCUFF, sc * 0.5);
      hgt -= sc * 0.15;
      ro += sc * 0.25;
      buf.hf[i] = hgt;
      buf.rough[i] = ro;
    });
    return buf.build({ wrapV: false, normal: 5, normalScale: 0.8 });
  });
}

// ---------------------------------------------------------------------------
// Paper / cardboard
// ---------------------------------------------------------------------------

/**
 * Corrugated cardboard: planar per box side (u across, v upwards), tileable.
 * Crease at v ≈ 0.62, packing tape v 0.44–0.56, printed shipping marks,
 * soaked corner at the bottom left. 512², map + normal + roughness.
 */
export function pbrCardboard(): PbrMaps {
  return cachedPbr(cacheKey("cardboard", []), () => {
    const S = 512;
    const rng = new TexRng(0xcab);
    const base = rgb("#b08c62");
    const buf = new TexBuf(S, S, base, 0.85, 0);
    const nFib = noiseField(S, S, 451, { freq: 6, freqY: 200, oct: 3 });
    const nM = noiseField(S, S, 452, { freq: 5, oct: 4 });
    const nInk = noiseField(S, S, 453, { freq: 30, oct: 3 });
    const nW = noiseField(S, S, 454, { freq: 6, oct: 3, mode: "ridged" });
    const print = buf.layer((ctx) => {
      ctx.fillStyle = "#1c1a18";
      ctx.strokeStyle = "#1c1a18";
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.font = "bold 40px Arial, Helvetica, sans-serif";
      ctx.fillText("FRAGILE", 34, 60);
      ctx.lineWidth = 6;
      for (const x of [300, 350]) {
        ctx.beginPath();
        ctx.moveTo(x, 84);
        ctx.lineTo(x, 36);
        ctx.moveTo(x - 16, 52);
        ctx.lineTo(x, 36);
        ctx.lineTo(x + 16, 52);
        ctx.stroke();
      }
      ctx.lineWidth = 4;
      ctx.strokeRect(34, 110, 200, 70);
      ctx.font = "bold 26px Arial, Helvetica, sans-serif";
      ctx.fillText("CRATEWORKS", 52, 138);
      ctx.font = "16px Arial, Helvetica, sans-serif";
      ctx.fillText("Packaging · No. 4471", 52, 164);
      ctx.fillStyle = "#f4f2ec";
      ctx.fillRect(330, 380, 150, 100);
      drawBarcode(ctx, rng, 340, 388, 130, 56);
      ctx.fillStyle = "#1c1a18";
      ctx.font = "12px Arial, Helvetica, sans-serif";
      ctx.fillText("BX-24 · 2 / 3 · 6.4 kg", 340, 466);
    });
    const TAPE: Rgb = rgb("#8a5a33");
    const TWO_PI = Math.PI * 2;
    buf.each((i, u, v) => {
      let k = 1 + (nFib[i] - 0.5) * 0.1 + (nM[i] - 0.5) * 0.12;
      const hp = hashPix(i, 6);
      if (hp > 0.994) k -= 0.35;
      else if (hp < 0.006) k += 0.22;
      const flute = Math.sin(u * TWO_PI * 48);
      k += flute * 0.01;
      buf.mul(i, k);
      let hgt = flute * 0.02 + (nFib[i] - 0.5) * 0.04;
      let ro = 0.85 + (nFib[i] - 0.5) * 0.06;
      // Creases
      const f1 = Math.exp(-((((v - 0.62) * S) / 2.5) ** 2));
      const f2 = Math.exp(-((((u - 0.3) * S) / 2) ** 2));
      hgt -= f1 * 0.3 + f2 * 0.18;
      buf.mul(i, 1 - f1 * 0.12 - f2 * 0.08);
      // Print (unevenly rubbed off)
      const j = i * 4;
      const inkA =
        (print[j + 3] / 255) * (0.55 + 0.45 * sstep(0.3, 0.7, nInk[i]));
      if (inkA > 0.01) {
        buf.mixTo(
          i,
          [print[j] / 255, print[j + 1] / 255, print[j + 2] / 255],
          inkA,
        );
        ro -= inkA * 0.1 * (print[j] > 200 ? 1 : 0.3);
      }
      // Packing tape
      const tape = sstep(0.44, 0.45, v) * (1 - sstep(0.555, 0.565, v));
      if (tape > 0) {
        buf.mixTo(i, TAPE, tape * 0.6);
        const wr = sstep(0.65, 0.95, nW[i]) * tape;
        hgt += tape * 0.05 - wr * 0.08;
        ro = mix(ro, 0.28 + wr * 0.25, tape);
      }
      // Soaked corner at the bottom left
      const d = Math.sqrt(u * u + v * v);
      const sog = (1 - sstep(0.15, 0.55, d)) * (0.6 + 0.4 * nM[i]);
      buf.mul(i, 1 - sog * 0.32);
      ro -= sog * 0.3;
      hgt += (nW[i] - 0.5) * 0.15 * sog;
      buf.hf[i] = hgt;
      buf.rough[i] = ro;
    });
    return buf.build({ normal: 4, normalScale: 0.7 });
  });
}

/**
 * Newspaper page, planar (u across, v upwards, aspect ratio 4:3): masthead,
 * headline, four text columns, photo block, centre fold at u = 0.5, slightly
 * yellowed. 1024×768, map + normal + roughness; DoubleSide hint.
 */
export function pbrNewspaper(): PbrMaps {
  return cachedPbr(cacheKey("newspaper", []), () => {
    const W = 1024;
    const H = 768;
    const rng = new TexRng(0x2e1);
    const buf = new TexBuf(W, H, rgb("#ebe4d1"), 0.92, 0);
    const photo = { x0: 560, y0: 300, x1: 984, y1: 560 };
    buf.blendLayer(
      buf.layer((ctx) => {
        const ink = "#1e1d1f";
        ctx.fillStyle = ink;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = "bold 92px Georgia, 'Times New Roman', serif";
        ctx.fillText("COAST COURIER", W / 2, 78);
        ctx.fillRect(40, 130, W - 80, 3);
        ctx.fillRect(40, 138, W - 80, 1);
        ctx.font = "16px Georgia, 'Times New Roman', serif";
        ctx.textAlign = "left";
        ctx.fillText("No. 187 · Independent daily for the bay", 40, 156);
        ctx.textAlign = "right";
        ctx.fillText("Price 1.80", W - 40, 156);
        ctx.textAlign = "left";
        ctx.font = "bold 42px Georgia, 'Times New Roman', serif";
        ctx.fillText(
          "Beach clean-up: volunteers set a record",
          40,
          200,
          W - 80,
        );
        ctx.font = "italic 20px Georgia, 'Times New Roman', serif";
        ctx.fillText(
          "Over two tonnes of litter in one week – council plans further drives",
          40,
          236,
        );
        ctx.fillRect(40, 258, W - 80, 1);
        const colW = 220;
        const gap = 28;
        for (let c = 0; c < 4; c++) {
          const x = 40 + c * (colW + gap);
          const yStart = 286;
          const lines = c >= 2 ? 3 : 32;
          drawTextBlock(
            ctx,
            rng,
            x,
            yStart,
            colW,
            lines,
            15,
            "12px Georgia, 'Times New Roman', serif",
            ink,
          );
          if (c >= 2) {
            drawTextBlock(
              ctx,
              rng,
              x,
              600,
              colW,
              10,
              15,
              "12px Georgia, 'Times New Roman', serif",
              ink,
            );
          }
          if (c > 0) ctx.fillRect(x - gap / 2, 280, 1, 460);
        }
        ctx.font = "bold 22px Georgia, 'Times New Roman', serif";
        ctx.fillText("Council argues over parking fees", 40, 590);
        ctx.font = "italic 13px Georgia, 'Times New Roman', serif";
        ctx.fillText(
          "Photo: helpers at Dune Edge, Sunday morning.",
          photo.x0,
          photo.y1 + 14,
        );
        ctx.fillRect(40, 740, W - 80, 1);
      }),
    );
    const nY = noiseField(W, H, 461, { freq: 3, oct: 3 });
    const nF = noiseField(W, H, 462, { freq: 5, freqY: 160, oct: 2 });
    const nP = noiseField(W, H, 463, { freq: 8, freqY: 6, oct: 4 });
    const YELLOW: Rgb = rgb("#d9c69c");
    buf.each((i, u, v, x, y) => {
      const e = Math.min(u, 1 - u, v, 1 - v);
      const yel = 0.35 * nY[i] + 0.35 * (1 - sstep(0, 0.14, e));
      buf.mixTo(i, YELLOW, yel * 0.9);
      buf.mul(i, 1 + (nF[i] - 0.5) * 0.05);
      let hgt = (nF[i] - 0.5) * 0.02;
      let ro = 0.92 + (nF[i] - 0.5) * 0.04;
      if (x >= photo.x0 && x < photo.x1 && y >= photo.y0 && y < photo.y1) {
        const px = (x - photo.x0) / (photo.x1 - photo.x0);
        const py = (y - photo.y0) / (photo.y1 - photo.y0);
        // Motif: bright sky at the top, darker sand with noise below
        let grey = 0.75 - py * 0.45 + (nP[i] - 0.5) * 0.35;
        grey +=
          0.12 *
          sstep(0.35, 0.6, px) *
          (1 - sstep(0.7, 0.9, px)) *
          sstep(0.3, 0.5, py);
        const dots = 0.5 + 0.5 * Math.sin(x * 1.1) * Math.sin(y * 1.1);
        grey = clamp01(grey) * (0.82 + 0.3 * dots);
        const c = 0.12 + grey * 0.8;
        buf.mixTo(i, [c, c * 0.99, c * 0.97], 0.92);
        ro -= 0.08;
      }
      // Centre fold + diagonal crease
      const fold = Math.exp(-((((u - 0.5) * W) / 4) ** 2));
      const fold2 = Math.exp(-((((v - 0.25 - u * 0.15) * H) / 3) ** 2));
      hgt -= fold * 0.4 + fold2 * 0.15;
      buf.mul(i, 1 - fold * 0.1 - fold2 * 0.04);
      buf.hf[i] = hgt;
      buf.rough[i] = ro;
    });
    return buf.build({
      wrapU: false,
      wrapV: false,
      normal: 5,
      normalScale: 0.6,
      doubleSide: true,
    });
  });
}

/**
 * Crumpled paper: tileable, strong crease normal map, cavity darkening in the
 * valleys. 512², map + normal + roughness.
 */
export function pbrPaperCrumpled(): PbrMaps {
  return cachedPbr(cacheKey("paperCrumpled", []), () => {
    const S = 512;
    const buf = new TexBuf(S, S, rgb("#ece9e0"), 0.9, 0);
    const nR1 = noiseField(S, S, 471, {
      freq: 6,
      oct: 4,
      gain: 0.55,
      mode: "ridged",
    });
    const nR2 = noiseField(S, S, 472, { freq: 16, oct: 3, mode: "ridged" });
    const nB = noiseField(S, S, 473, { freq: 3, oct: 3 });
    const nF = noiseField(S, S, 474, { freq: 120, oct: 1 });
    buf.each((i) => {
      const h = 0.55 * nR1[i] + 0.3 * (1 - nR2[i]) + 0.15 * nB[i];
      const cav = 1 - sstep(0.3, 0.6, h);
      buf.mul(i, 1 - cav * 0.08 + (nF[i] - 0.5) * 0.04);
      const ridge = sstep(0.85, 0.98, nR1[i]);
      buf.mul(i, 1 - ridge * 0.04);
      buf.hf[i] = h;
      buf.rough[i] = 0.9 + (nF[i] - 0.5) * 0.06 + ridge * 0.05;
    });
    return buf.build({ normal: 16, normalScale: 1 });
  });
}

// ---------------------------------------------------------------------------
// Films / foils
// ---------------------------------------------------------------------------

/**
 * Crisp packet (metallised film), planar over the front (u across, v upwards;
 * back is identical). Sealed seams at v < 0.06 / v > 0.94 are ribbed.
 * 1024×768, map + normal + roughness + metalness.
 */
export function pbrChipsBag(
  colorHex: string | number,
  accentHex: string | number,
): PbrMaps {
  return cachedPbr(cacheKey("chips", [colorHex, accentHex]), () => {
    const W = 1024;
    const H = 768;
    const base = rgb(colorHex);
    const accent = rgb(accentHex);
    const buf = new TexBuf(W, H, base, 0.14, 0.75);
    const accCss = `rgb(${Math.round(accent[0] * 255)},${Math.round(accent[1] * 255)},${Math.round(accent[2] * 255)})`;
    const lum = base[0] * 0.3 + base[1] * 0.59 + base[2] * 0.11;
    const dark = lum > 0.5 ? "#2a1a10" : "#140c08";
    buf.blendLayer(
      buf.layer((ctx) => {
        ctx.fillStyle = accCss;
        ctx.beginPath();
        ctx.moveTo(0, H * 0.7);
        ctx.bezierCurveTo(W * 0.35, H * 0.55, W * 0.6, H * 0.95, W, H * 0.68);
        ctx.lineTo(W, H);
        ctx.lineTo(0, H);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = dark;
        ctx.beginPath();
        ctx.ellipse(
          W * 0.5,
          H * 0.4,
          W * 0.36,
          H * 0.17,
          -0.08,
          0,
          Math.PI * 2,
        );
        ctx.fill();
        ctx.save();
        ctx.translate(W * 0.5, H * 0.4);
        ctx.rotate(-0.08);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = "italic bold 112px Impact, 'Arial Black', Arial, sans-serif";
        ctx.lineWidth = 8;
        ctx.strokeStyle = accCss;
        ctx.strokeText("CRISPY KRAX", 0, -12, W * 0.66);
        ctx.fillStyle = "#fff9ee";
        ctx.fillText("CRISPY KRAX", 0, -12, W * 0.66);
        ctx.font = "bold 40px Arial, Helvetica, sans-serif";
        ctx.fillStyle = accCss;
        ctx.fillText("SMOKY PAPRIKA", 0, 70);
        ctx.restore();
        // Crisps illustration
        for (let k = 0; k < 6; k++) {
          const x = W * (0.55 + k * 0.07);
          const y = H * (0.82 - (k % 2) * 0.06);
          ctx.fillStyle = "#e8b53a";
          ctx.beginPath();
          ctx.ellipse(x, y, 62, 40, 0.5 + k * 0.4, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = "#b8811f";
          ctx.lineWidth = 5;
          ctx.stroke();
        }
        ctx.fillStyle = "#fff9ee";
        ctx.beginPath();
        ctx.arc(W * 0.14, H * 0.82, 58, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = dark;
        ctx.font = "bold 34px Arial, Helvetica, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("150 g", W * 0.14, H * 0.82);
        ctx.font = "bold 22px Arial, Helvetica, sans-serif";
        ctx.fillStyle = "#fff9ee";
        ctx.fillText("WITH SEA SALT", W * 0.5, H * 0.13);
      }),
    );
    const nC1 = noiseField(W, H, 481, {
      freq: 5,
      freqY: 4,
      oct: 4,
      mode: "ridged",
    });
    const nC2 = noiseField(W, H, 482, {
      freq: 14,
      freqY: 10,
      oct: 3,
      mode: "ridged",
    });
    const nB = noiseField(W, H, 483, { freq: 4, freqY: 3, oct: 3 });
    const nF = noiseField(W, H, 484, { freq: 100, freqY: 75, oct: 1 });
    const TWO_PI = Math.PI * 2;
    buf.each((i, u, v) => {
      const seal = v < 0.06 || v > 0.94;
      const c1 = sstep(0.6, 0.95, nC1[i]);
      const c2 = sstep(0.7, 0.95, nC2[i]);
      let hgt =
        -c1 * 0.5 - c2 * 0.25 + (nB[i] - 0.5) * 0.2 + (nF[i] - 0.5) * 0.01;
      let ro = 0.14 + c1 * 0.25 + c2 * 0.12 + (nF[i] - 0.5) * 0.04;
      let me = 0.75;
      buf.mul(i, 1 + c1 * 0.05);
      if (seal) {
        buf.mixTo(i, ALU, 0.9);
        hgt = 0.25 * Math.sin(u * TWO_PI * 120) + (nF[i] - 0.5) * 0.02;
        ro = 0.35;
        me = 0.9;
      }
      buf.hf[i] = hgt;
      buf.rough[i] = ro;
      buf.metal[i] = me;
    });
    return buf.build({
      wrapU: false,
      wrapV: false,
      normal: 10,
      normalScale: 0.8,
      metal: true,
    });
  });
}

/**
 * Thin plastic bag: whitish-blue, semi-transparent (alpha in the map),
 * crinkle normal map, faded shop print in the middle of the tile. Tileable,
 * 512², map(+alpha) + normal + roughness; transparent + DoubleSide hint.
 */
export function pbrPlasticBag(): PbrMaps {
  return cachedPbr(cacheKey("plasticBag", []), () => {
    const S = 512;
    const buf = new TexBuf(S, S, rgb("#e9eef0"), 0.35, 0);
    const printA = TexBuf.layerAlpha(
      buf.layer((ctx) => {
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.beginPath();
        ctx.roundRect(S * 0.28, S * 0.4, S * 0.44, S * 0.2, 18);
        ctx.fill();
        ctx.font = "bold 28px Arial, Helvetica, sans-serif";
        ctx.globalCompositeOperation = "destination-out";
        ctx.fillText("BEACHMART", S / 2, S * 0.49);
        ctx.font = "14px Arial, Helvetica, sans-serif";
        ctx.fillText("Thank you for shopping", S / 2, S * 0.55);
      }),
      buf.n,
    );
    const nC = noiseField(S, S, 491, { freq: 4, oct: 4, mode: "ridged" });
    const nC2 = noiseField(S, S, 492, { freq: 12, oct: 3, mode: "ridged" });
    const nT = noiseField(S, S, 493, { freq: 3, oct: 4 });
    const nF = noiseField(S, S, 494, { freq: 90, oct: 1 });
    const PRINT: Rgb = rgb("#2b63b8");
    const TINT: Rgb = rgb("#cfe0ea");
    buf.each((i) => {
      const c1 = sstep(0.62, 0.95, nC[i]);
      const c2 = sstep(0.7, 0.95, nC2[i]);
      buf.mixTo(i, TINT, sstep(0.4, 0.8, nT[i]) * 0.5);
      buf.mixTo(i, PRINT, printA[i] * 0.6);
      buf.hf[i] =
        -c1 * 0.5 - c2 * 0.25 + (nT[i] - 0.5) * 0.2 + (nF[i] - 0.5) * 0.02;
      buf.a[i] = 0.55 + 0.3 * sstep(0.3, 0.8, nT[i]) + (c1 + c2) * 0.2;
      buf.rough[i] = 0.35 + (c1 + c2) * 0.15 + (nF[i] - 0.5) * 0.06;
    });
    return buf.build({
      normal: 9,
      normalScale: 0.8,
      alpha: true,
      transparent: true,
      doubleSide: true,
    });
  });
}

// ---------------------------------------------------------------------------
// Wood
// ---------------------------------------------------------------------------

/**
 * Wood. "plank": grain/cracks **along u** (u = board length, v = width; edges
 * at v 0/1 greyed), knot holes, nail holes. "driftwood": bleached silver-grey,
 * deep cracks along u. "branch": bark, furrows **along v** (CylinderGeometry:
 * v = axis). All tileable, 512², map + normal + roughness.
 */
export function pbrWood(kind: "plank" | "driftwood" | "branch"): PbrMaps {
  return cachedPbr(cacheKey("wood", [kind]), () => {
    const S = 512;
    const rng = new TexRng(0x300d + kind.length);
    if (kind === "branch") {
      const buf = new TexBuf(S, S, rgb("#6b4b2e"), 0.9, 0);
      const nB = noiseField(S, S, 501, {
        freq: 24,
        freqY: 3,
        oct: 4,
        mode: "ridged",
      });
      const nP = noiseField(S, S, 502, { freq: 30, oct: 3 });
      const nL = noiseField(S, S, 503, { freq: 4, oct: 3 });
      const DARK: Rgb = rgb("#3a2716");
      const LICHEN: Rgb = rgb("#7f8a62");
      buf.each((i) => {
        const fis = sstep(0.55, 0.9, nB[i]);
        buf.mixTo(i, DARK, fis * 0.8);
        buf.mul(i, 0.9 + nP[i] * 0.2);
        const lichen = sstep(0.68, 0.85, nL[i]) * (1 - fis);
        buf.mixTo(i, LICHEN, lichen * 0.65);
        buf.hf[i] = 0.7 - fis * 0.6 + nP[i] * 0.15;
        buf.rough[i] = 0.9 - lichen * 0.1;
      });
      return buf.build({ normal: 4, normalScale: 1 });
    }
    const drift = kind === "driftwood";
    const base: Rgb = drift ? rgb("#a8a297") : rgb("#9c7a4e");
    const dark: Rgb = drift ? rgb("#6d675d") : rgb("#5e4325");
    const grey: Rgb = rgb("#9a9488");
    const light: Rgb = drift ? rgb("#cdc7ba") : rgb("#b9975f");
    const buf = new TexBuf(S, S, base, 0.82, 0);
    const nGr = noiseField(S, S, 511, {
      freq: 2,
      freqY: 24,
      oct: 4,
      gain: 0.55,
    });
    const nW = noiseField(S, S, 512, { freq: 2, oct: 3 });
    const nM = noiseField(S, S, 513, { freq: 5, oct: 4 });
    const nWe = noiseField(S, S, 514, { freq: 3, oct: 4 });
    const nCr = noiseField(S, S, 515, {
      freq: 2,
      freqY: 40,
      oct: 3,
      mode: "ridged",
    });
    const knots: Array<[number, number]> = [];
    for (let k = 0; k < (drift ? 1 : 2); k++)
      knots.push([rng.range(0.15, 0.85), rng.range(0.25, 0.75)]);
    const nails: Array<[number, number]> = [];
    if (!drift)
      for (let k = 0; k < 5; k++) nails.push([rng.next(), rng.range(0.2, 0.8)]);
    const KNOT: Rgb = rgb("#3c2916");
    const NAIL: Rgb = rgb("#2a1e14");
    const NAIL_RUST: Rgb = rgb("#7a4a25");
    const TWO_PI = Math.PI * 2;
    buf.each((i, u, v) => {
      const rings =
        0.5 + 0.5 * Math.sin((v * 8 + nW[i] * 2.5 + u * 0.6) * TWO_PI);
      let grain = 0.6 * nGr[i] + 0.4 * rings;
      let hgt = grain * (drift ? 0.25 : 0.12);
      // Knot holes: warped distance, a few irregular rings
      let knot = 0;
      for (let kk = 0; kk < knots.length; kk++) {
        const dx = (u - knots[kk][0]) / 0.07;
        const dy = (v - knots[kk][1]) / 0.045;
        const d = Math.sqrt(dx * dx + dy * dy) + (nM[i] - 0.5) * 0.7;
        if (d < 2) {
          // wavy, interrupted rings instead of a bullseye
          const kr =
            0.5 +
            0.5 * Math.sin(d * TWO_PI * 1.6 + (nM[i] - 0.5) * 5 + nW[i] * 3);
          grain = mix(grain, kr, (1 - sstep(1.1, 2, d)) * 0.65);
          knot = Math.max(knot, 1 - sstep(0.3, 0.75, d));
          hgt -= (1 - sstep(0.5, 1, d)) * 0.15;
        }
      }
      let col = lerp3(dark, base, grain);
      col = lerp3(col, light, sstep(0.75, 1, grain) * 0.5);
      col = lerp3(col, KNOT, knot * 0.8);
      col = [
        col[0] * (1 + (nM[i] - 0.5) * 0.12),
        col[1] * (1 + (nM[i] - 0.5) * 0.12),
        col[2] * (1 + (nM[i] - 0.5) * 0.12),
      ];
      const weather =
        (drift ? 0.55 : 0.35) * sstep(0.4, 0.8, nWe[i]) +
        (drift ? 0 : 0.5 * (1 - sstep(0, 0.12, Math.min(v, 1 - v))));
      col = lerp3(col, grey, weather);
      let ro = 0.8 + grain * 0.1 + weather * 0.08;
      const crack = sstep(drift ? 0.8 : 0.86, 0.97, nCr[i]);
      col = [
        col[0] * (1 - crack * 0.6),
        col[1] * (1 - crack * 0.6),
        col[2] * (1 - crack * 0.6),
      ];
      hgt -= crack * (drift ? 0.6 : 0.35);
      for (let kk = 0; kk < nails.length; kk++) {
        const ddx = (u - nails[kk][0]) * S;
        const ddy = (v - nails[kk][1]) * S;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 > 100) continue;
        const d = Math.sqrt(d2);
        const hole = 1 - sstep(2.5, 4, d);
        const halo = (1 - sstep(4, 9, d)) * (1 - hole);
        col = lerp3(col, NAIL, hole);
        col = lerp3(col, NAIL_RUST, halo * 0.5);
        hgt -= hole * 0.4;
        ro += halo * 0.1;
      }
      buf.set(i, col);
      buf.hf[i] = hgt;
      buf.rough[i] = ro;
    });
    return buf.build({ normal: 4, normalScale: 0.9 });
  });
}

// ---------------------------------------------------------------------------
// Rope, net, rubber
// ---------------------------------------------------------------------------

/**
 * Twisted rope: **u along the rope** (tileable, 4 lays per tile), **v around
 * the cross-section** (TubeGeometry: u = path, v = circumference). 512×256,
 * map + normal + roughness.
 */
export function pbrRope(colorHex: string | number = "#d9d2c0"): PbrMaps {
  return cachedPbr(cacheKey("rope", [colorHex]), () => {
    const W = 512;
    const H = 256;
    const base = rgb(colorHex);
    const buf = new TexBuf(W, H, base, 0.85, 0);
    const nF = noiseField(W, H, 521, { freq: 60, freqY: 30, oct: 2 });
    const nG = noiseField(W, H, 522, { freq: 3, freqY: 2, oct: 3 });
    const TWO_PI = Math.PI * 2;
    buf.each((i, u, v) => {
      const p = 3 * v - u * 4;
      const strand = 0.5 + 0.5 * Math.cos(p * TWO_PI);
      const s = strand ** 0.6;
      const fib = 0.5 + 0.5 * Math.sin((p * 9 + u * 40) * TWO_PI);
      buf.mul(i, 0.65 + s * 0.35 + (fib - 0.5) * 0.06 + (nF[i] - 0.5) * 0.08);
      buf.mixTo(i, GRIME, sstep(0.55, 0.85, nG[i]) * 0.3);
      if (hashPix(i, 3) > 0.995) buf.mul(i, 1.15);
      buf.hf[i] = s * 0.6 + fib * 0.04 + (nF[i] - 0.5) * 0.04;
      buf.rough[i] = 0.85 + (nF[i] - 0.5) * 0.08;
    });
    return buf.build({ normal: 3, normalScale: 1 });
  });
}

/**
 * Scrap of net: diamond meshes as an alpha cutout (alphaTest 0.5, DoubleSide),
 * knots at the crossings, bleached green-blue. Tileable (6 meshes per tile),
 * 512², map(+alpha) + normal + roughness.
 */
export function pbrNet(colorHex: string | number = "#4f8f7f"): PbrMaps {
  return cachedPbr(cacheKey("net", [colorHex]), () => {
    const S = 512;
    const base = rgb(colorHex);
    const buf = new TexBuf(S, S, base, 0.8, 0);
    const nV = noiseField(S, S, 531, { freq: 4, oct: 4 });
    const nF = noiseField(S, S, 532, { freq: 80, oct: 2 });
    const N = 6;
    const wT = 0.07;
    const BLEACH: Rgb = rgb("#b9c9b6");
    const ALGAE: Rgb = rgb("#2e4f3a");
    buf.each((i, u, v) => {
      const a = (u + v) * N;
      const b = (u - v) * N;
      const fa = a - Math.floor(a);
      const fb = b - Math.floor(b);
      const d1 = Math.min(fa, 1 - fa);
      const d2 = Math.min(fb, 1 - fb);
      const d = Math.min(d1, d2);
      const dk = Math.sqrt(d1 * d1 + d2 * d2);
      const knot = dk < 0.13 ? 1 - sstep(0.09, 0.13, dk) : 0;
      const twine = Math.max(1 - sstep(wT * 0.85, wT, d), knot);
      const prof = d < wT ? Math.sqrt(Math.max(0, 1 - (d / wT) ** 2)) : 0;
      const along = d1 < d2 ? b : a;
      const twist =
        0.5 + 0.5 * Math.sin(along * Math.PI * 10 + (d1 < d2 ? fa : fb) * 6);
      buf.mul(i, 0.85 + twist * 0.15 + (nF[i] - 0.5) * 0.1);
      buf.mixTo(i, BLEACH, sstep(0.55, 0.85, nV[i]) * 0.5);
      buf.mixTo(i, ALGAE, knot * 0.35 + sstep(0.2, 0.05, nV[i]) * 0.4);
      buf.a[i] = twine;
      buf.hf[i] = Math.max(prof, knot * 1.3) * 0.5;
      buf.rough[i] = 0.8 + (nF[i] - 0.5) * 0.1;
    });
    return buf.build({
      normal: 3,
      normalScale: 0.8,
      alpha: true,
      alphaTest: 0.5,
      doubleSide: true,
    });
  });
}

/**
 * Flip-flop sole (EVA foam): planar over the sole, **u across, v = heel (0)
 * → toes (1)**. Pores, a dark worn-in footprint, sun bleaching.
 * 512², map + normal + roughness.
 */
export function pbrRubber(colorHex: string | number = "#e86aa0"): PbrMaps {
  return cachedPbr(cacheKey("rubber", [colorHex]), () => {
    const S = 512;
    const base = rgb(colorHex);
    const buf = new TexBuf(S, S, base, 0.85, 0);
    const nP = noiseField(S, S, 541, { freq: 48, oct: 2 });
    const nF = noiseField(S, S, 542, { freq: 3, oct: 3 });
    const wear = new Float32Array(buf.n);
    stampBlob(wear, S, S, S * 0.5, S * 0.8, S * 0.2, S * 0.14, 1, false);
    stampBlob(wear, S, S, S * 0.5, S * 0.34, S * 0.27, S * 0.2, 1, false);
    for (let t = 0; t < 5; t++) {
      stampBlob(
        wear,
        S,
        S,
        S * (0.26 + t * 0.12),
        S * (0.1 + Math.abs(t - 1) * 0.02),
        S * 0.045,
        S * 0.05,
        0.9,
        false,
      );
    }
    blurField(wear, S, S, 6, false, false, 2);
    const WORN: Rgb = rgb("#6b4a55");
    const bleached = lerp3(base, [0.9, 0.86, 0.84], 0.5);
    buf.each((i) => {
      const w = Math.min(1, wear[i] * 1.1);
      buf.mixTo(i, bleached, sstep(0.5, 0.9, nF[i]) * 0.4 * (1 - w));
      buf.mixTo(i, WORN, w * 0.45);
      buf.mul(i, 1 + (hashPix(i, 5) - 0.5) * 0.06);
      const pore = sstep(0.72, 0.8, nP[i]) * (1 - w * 0.6);
      buf.mul(i, 1 - pore * 0.12);
      buf.hf[i] = -pore * 0.2 - w * 0.1 + (hashPix(i, 8) - 0.5) * 0.01;
      buf.rough[i] = 0.85 - w * 0.3 + pore * 0.05;
    });
    return buf.build({
      wrapU: false,
      wrapV: false,
      normal: 4,
      normalScale: 0.6,
    });
  });
}

/**
 * Player's bucket. UV: **u around the bucket** (tileable), **v = 0 bottom →
 * 1 rim**. Rim bead at v > 0.9, ribs below it, embossed lettering on the front
 * (u ≈ 0.25), recycling mark on the back, crust of sand at the bottom, sun
 * bleaching at the top. 1024×512, map + normal + roughness.
 */
export function pbrBucket(colorHex: string | number = "#e8762c"): PbrMaps {
  return cachedPbr(cacheKey("bucket", [colorHex]), () => {
    const W = 1024;
    const H = 512;
    const rng = new TexRng(0xe1e);
    const base = rgb(colorHex);
    const buf = new TexBuf(W, H, base, 0.42, 0);
    const emboss = blurField(
      TexBuf.layerAlpha(
        buf.layer((ctx) => {
          ctx.fillStyle = "#fff";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.font = "bold 88px Arial, Helvetica, sans-serif";
          ctx.fillText("PLASTOMAX", W * 0.25, H * 0.45, W * 0.4);
          ctx.font = "bold 56px Arial, Helvetica, sans-serif";
          ctx.fillText("10 L", W * 0.25, H * 0.6);
          const tx = W * 0.75;
          const ty = H * 0.5;
          ctx.lineWidth = 6;
          ctx.strokeStyle = "#fff";
          ctx.beginPath();
          ctx.moveTo(tx, ty - 40);
          ctx.lineTo(tx + 36, ty + 24);
          ctx.lineTo(tx - 36, ty + 24);
          ctx.closePath();
          ctx.stroke();
          ctx.font = "bold 22px Arial, Helvetica, sans-serif";
          ctx.fillText("05", tx, ty + 4);
          ctx.fillText("PP", tx, ty + 50);
          for (let k = 0; k < 12; k++) {
            ctx.fillRect((k / 12) * W + 20, H * 0.1, 6, H * 0.08);
          }
        }),
        buf.n,
      ),
      W,
      H,
      1,
      true,
      false,
      1,
    );
    const nB = noiseField(W, H, 551, { freq: 4, freqY: 2, oct: 4 });
    const nG = noiseField(W, H, 552, { freq: 8, freqY: 4, oct: 4 });
    const nS = noiseField(W, H, 553, { freq: 40, freqY: 2, oct: 3 });
    const nF = noiseField(W, H, 554, { freq: 80, freqY: 40, oct: 2 });
    const scratchA = TexBuf.layerAlpha(
      buf.layer((ctx) => {
        drawScratches(ctx, rng, W, H, 60, 70, 1.2, 0.6);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, H * 0.55, W, H * 0.45);
        ctx.clip();
        drawScratches(ctx, rng, W, H, 120, 60, 1.3, 0.7);
        ctx.restore();
      }),
      buf.n,
    );
    const bleached = lerp3(base, [0.92, 0.86, 0.78], 0.5);
    buf.each((i, _u, v) => {
      buf.mixTo(i, bleached, 0.3 * sstep(0.4, 1, v) * (0.6 + 0.4 * nB[i]));
      buf.mul(i, 1 + (nF[i] - 0.5) * 0.04);
      let hgt = emboss[i] * 0.25 + (nF[i] - 0.5) * 0.015;
      const rim = sstep(0.9, 0.93, v);
      hgt += rim * 0.4 + Math.exp(-((((v - 0.86) * H) / 3) ** 2)) * 0.15;
      let ro = 0.42 + (nF[i] - 0.5) * 0.05;
      buf.mul(i, 1 - emboss[i] * sstep(0.4, 0.7, nG[i]) * 0.1);
      const sc = scratchA[i];
      buf.mixTo(i, WHITE_SCUFF, sc * 0.55);
      hgt -= sc * 0.15;
      ro += sc * 0.25;
      const grime = 0.55 * (1 - sstep(0.02, 0.3, v)) * (0.5 + 0.5 * nG[i]);
      const drip = sstep(0.6, 0.85, nS[i]) * (1 - sstep(0.25, 0.6, v)) * 0.25;
      buf.mixTo(i, SAND, Math.min(0.85, grime + drip));
      ro = mix(ro, 0.75, grime + drip);
      buf.hf[i] = hgt;
      buf.rough[i] = ro;
    });
    return buf.build({ wrapV: false, normal: 5, normalScale: 0.8 });
  });
}
