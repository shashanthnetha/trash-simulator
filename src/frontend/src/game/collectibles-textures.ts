// Procedural texture sets for the rare collectibles (collectibles-models.ts).
// Unlike the shared trash/station libraries these sets are built fresh per
// model build and are NOT cached: a collectible exists at most once in the
// world plus once in the inspect viewer, and disposeCollectibleModel() must be
// able to free every texture without pulling maps from under another mesh.
//
// Coin faces follow the numismatic convention "white = raised": the relief is
// painted as an alpha layer, becomes the height field (normal map) and drives
// polish (high points bright and smooth) and patina (recesses dark and rough).

import * as THREE from "three";
import {
  type PbrMaps,
  type Rgb,
  TexBuf,
  TexRng,
  blurField,
  drawScratches,
  sstep,
} from "./textures-core";

// ---------------------------------------------------------------------------
// Material helper
// ---------------------------------------------------------------------------

/** Standard material from a per-build map set (textures owned by the caller). */
export function matFromMaps(
  maps: PbrMaps,
  extra: THREE.MeshStandardMaterialParameters = {},
): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    map: maps.map,
    normalMap: maps.normalMap ?? null,
    roughnessMap: maps.roughnessMap ?? null,
    metalnessMap: maps.metalnessMap ?? null,
    roughness: maps.roughnessMap ? (maps.roughness ?? 1) : 0.8,
    metalness: maps.metalnessMap ? (maps.metalness ?? 1) : 0,
    ...extra,
  });
  if (maps.normalMap) {
    const s = maps.normalScale ?? 1;
    m.normalScale.set(s, s);
  }
  if (maps.transparent) m.transparent = true;
  if (maps.doubleSide) m.side = THREE.DoubleSide;
  return m;
}

// ---------------------------------------------------------------------------
// Coins
// ---------------------------------------------------------------------------

interface MetalTone {
  base: Rgb;
  hi: Rgb;
  patina: Rgb;
  rough: number;
}

const METALS: Record<"silver" | "gold" | "bronze", MetalTone> = {
  silver: {
    base: [0.62, 0.64, 0.67],
    hi: [0.9, 0.92, 0.93],
    patina: [0.14, 0.15, 0.18],
    rough: 0.42,
  },
  gold: {
    base: [0.84, 0.65, 0.27],
    hi: [0.99, 0.84, 0.46],
    patina: [0.45, 0.32, 0.12],
    rough: 0.26,
  },
  bronze: {
    base: [0.45, 0.32, 0.2],
    hi: [0.66, 0.5, 0.3],
    patina: [0.33, 0.52, 0.42], // verdigris
    rough: 0.5,
  },
};

/** Circular legend, letter by letter; ang 0 = top of the face, y-down canvas. */
export function ringText(
  ctx: CanvasRenderingContext2D,
  text: string,
  r: number,
  a0: number,
  a1: number,
  font: string,
  fill: string,
): void {
  ctx.save();
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = fill;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const a = n === 1 ? (a0 + a1) / 2 : a0 + ((a1 - a0) * i) / (n - 1);
    ctx.save();
    ctx.rotate(a);
    ctx.translate(0, -r);
    ctx.fillText(text[i], 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

export interface CoinSpec {
  seed: number;
  metal: "silver" | "gold" | "bronze";
  /** 0 crisp mint .. 1 relief nearly kissed away. */
  wear: number;
  /** 0 bright .. 1 heavy dark patina in the recesses. */
  patina: number;
  /** Milled (ridged) edge; hammered coins get an irregular plain edge. */
  milled: boolean;
  /** Relief of the two faces, white = raised, centred at 0,0 with radius R. */
  heads: (ctx: CanvasRenderingContext2D, R: number) => void;
  tails: (ctx: CanvasRenderingContext2D, R: number) => void;
  legendHeads?: string;
  legendTails?: string;
}

/**
 * 1024×512 sheet: heads circle centred at u 0.25, tails at u 0.75 (both at
 * v 0.47, radius 0.4 in v), edge strip along v 0.955..1 across the full width.
 * The coin geometry in collectibles-models.ts maps its caps/side to match.
 */
export function coinMaps(spec: CoinSpec): PbrMaps {
  const W = 1024;
  const H = 512;
  const tone = METALS[spec.metal];
  const rng = new TexRng(spec.seed);
  const t = new TexBuf(W, H, tone.base, tone.rough, 1);

  // Relief layer: rim, legend, face art
  const R = 200;
  const relief = t.layer((ctx) => {
    for (const [cx, side] of [
      [256, "heads"],
      [768, "tails"],
    ] as const) {
      ctx.save();
      ctx.translate(cx, 240);
      // raised rim with a beaded inner circle
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 13;
      ctx.beginPath();
      ctx.arc(0, 0, R - 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      for (let i = 0; i < 72; i++) {
        const a = (i / 72) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * (R - 26), Math.sin(a) * (R - 26), 3.2, 0, 7);
        ctx.fill();
      }
      const legend = side === "heads" ? spec.legendHeads : spec.legendTails;
      if (legend)
        ringText(
          ctx,
          legend,
          R - 52,
          -Math.PI * 0.82,
          Math.PI * 0.82,
          "bold 34px 'Times New Roman', serif",
          "rgba(255,255,255,0.8)",
        );
      (side === "heads" ? spec.heads : spec.tails)(ctx, R);
      ctx.restore();
    }
  });

  // Alpha → height, softened; wear flattens the peaks and rounds them off
  const hfRaw = TexBuf.layerAlpha(relief, t.n);
  blurField(hfRaw, W, H, 1.5 + spec.wear * 2.5, true, false, 2);
  const wearMask = new Float32Array(t.n);
  t.each((i, u, v, x, y) => {
    // uneven wear – one side of the coin always rubbed harder than the other
    wearMask[i] =
      spec.wear *
      (0.6 + 0.4 * Math.sin(u * 6.3 + spec.seed) * Math.sin(v * 4.1));
    t.hf[i] = hfRaw[i] ** (1 + spec.wear * 0.8) * (1 - wearMask[i] * 0.55);
    // hammered surface undulation outside the relief
    const wob =
      (Math.sin(x * 0.11 + spec.seed) * Math.sin(y * 0.13 - spec.seed) +
        Math.sin(x * 0.031) * Math.sin(y * 0.043 + 2)) *
      0.05;
    t.hf[i] += wob * (1 - hfRaw[i]);
  });

  // Edge strip: milled ridges or hammered irregularity
  t.each((i, u, v) => {
    if (v < 0.955) return;
    if (spec.milled) {
      const tooth = Math.abs(((u * 210) % 1) - 0.5) * 2;
      t.hf[i] = 0.25 + tooth * 0.5;
    } else {
      t.hf[i] = 0.3 + Math.sin(u * 97 + spec.seed) * 0.12;
    }
    t.set(i, tone.base);
    t.rough[i] = tone.rough + 0.12;
  });

  // Polish on the high points, patina in the recesses
  const grain = rng.next() * 100;
  t.each((i, _u, v, x, y) => {
    if (v >= 0.955) return;
    const h = Math.min(1, t.hf[i] * 1.4);
    t.mixTo(i, tone.hi, h * 0.32 + wearMask[i] * 0.06);
    const pat =
      spec.patina *
      (1 - h) *
      (0.55 +
        0.45 * Math.sin(x * 0.05 + grain) * Math.sin(y * 0.06 + grain * 1.7));
    t.mixTo(i, tone.patina, Math.min(1, pat * 2));
    t.rough[i] = tone.rough - h * 0.16 + pat * 0.4;
    t.metal[i] = 1 - pat * (spec.metal === "bronze" ? 0.55 : 0.3);
    // fine metal grain
    t.mul(i, 0.96 + 0.08 * Math.sin(x * 1.7 + y * 2.3 + grain));
  });

  return t.build({
    normal: 3.2,
    normalScale: 0.9,
    metal: true,
    wrapU: true,
    wrapV: false,
  });
}

// --- Face art (white = raised, centred, radius R) --------------------------

function castle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  s: number,
) {
  ctx.fillRect(x - s, y - s * 0.5, s * 2, s * 1.4);
  for (const dx of [-s, 0, s])
    ctx.fillRect(x + dx - s * 0.28, y - s, s * 0.56, s * 0.6);
}

function lion(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.lineWidth = s * 0.34;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-s * 0.7, s * 0.6);
  ctx.quadraticCurveTo(-s * 0.2, -s * 0.7, s * 0.5, -s * 0.4);
  ctx.quadraticCurveTo(s * 0.9, -s * 0.2, s * 0.6, s * 0.5);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(s * 0.55, -s * 0.55, s * 0.3, 0, 7);
  ctx.fill();
  ctx.restore();
}

/** Bare laureate profile facing left – denarius and sovereign heads. */
function profileHead(ctx: CanvasRenderingContext2D, R: number, bun: boolean) {
  const s = R / 100;
  ctx.save();
  ctx.scale(s, s);
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.beginPath();
  ctx.moveTo(18, 78); // base of neck
  ctx.quadraticCurveTo(26, 40, 22, 18); // throat up
  ctx.lineTo(14, 16); // chin
  ctx.quadraticCurveTo(8, 12, 12, 4); // lips
  ctx.lineTo(6, 2);
  ctx.quadraticCurveTo(2, -8, 10, -18); // nose
  ctx.quadraticCurveTo(16, -34, 30, -42); // forehead
  ctx.quadraticCurveTo(58, -52, 74, -32); // crown of the head
  ctx.quadraticCurveTo(84, -10, 76, 16); // back of head
  ctx.quadraticCurveTo(70, 44, 58, 78); // neck back
  ctx.closePath();
  ctx.fill();
  // laurel wreath / hair ties as a row of leaves along the crown
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  for (let i = 0; i < 9; i++) {
    const a = -2.1 + i * 0.24;
    const rx = 52 + Math.sin(i * 1.7) * 3;
    ctx.beginPath();
    ctx.ellipse(
      42 + Math.cos(a) * rx,
      -6 + Math.sin(a) * rx,
      7,
      3.2,
      a + 1.57,
      0,
      7,
    );
    ctx.fill();
  }
  if (bun) {
    ctx.beginPath();
    ctx.arc(74, 22, 12, 0, 7);
    ctx.fill();
  }
  ctx.restore();
}

const COIN_SPECS: Record<string, Omit<CoinSpec, "seed">> = {
  coin_real: {
    metal: "silver",
    wear: 0.55,
    patina: 0.75,
    milled: false,
    legendHeads: "·PHILIPPVS·IIII·D·G·",
    legendTails: "·HISPANIARVM·REX·",
    heads: (ctx, R) => {
      // quartered arms: castles and lions between the arms of a bold cross
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      const w = R * 0.14;
      ctx.fillRect(-w / 2, -R * 0.58, w, R * 1.16);
      ctx.fillRect(-R * 0.58, -w / 2, R * 1.16, w);
      castle(ctx, -R * 0.3, -R * 0.3, R * 0.11);
      castle(ctx, R * 0.3, R * 0.3, R * 0.11);
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      lion(ctx, R * 0.3, -R * 0.3, R * 0.12);
      lion(ctx, -R * 0.3, R * 0.3, R * 0.12);
    },
    tails: (ctx, R) => {
      // crowned Habsburg shield
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = R * 0.055;
      ctx.beginPath();
      ctx.moveTo(-R * 0.34, -R * 0.34);
      ctx.lineTo(R * 0.34, -R * 0.34);
      ctx.lineTo(R * 0.34, R * 0.12);
      ctx.quadraticCurveTo(R * 0.34, R * 0.42, 0, R * 0.5);
      ctx.quadraticCurveTo(-R * 0.34, R * 0.42, -R * 0.34, R * 0.12);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -R * 0.34);
      ctx.lineTo(0, R * 0.48);
      ctx.moveTo(-R * 0.34, 0.06 * R);
      ctx.lineTo(R * 0.34, 0.06 * R);
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      for (const dx of [-R * 0.2, 0, R * 0.2])
        ctx.fillRect(dx - R * 0.035, -R * 0.52, R * 0.07, R * 0.16);
    },
  },
  coin_denarius: {
    metal: "silver",
    wear: 0.75,
    patina: 0.45,
    milled: false,
    legendHeads: "CAESAR·AVGVSTVS",
    legendTails: "PONTIF·MAXIM",
    heads: (ctx, R) => profileHead(ctx, R * 0.92, false),
    tails: (ctx, R) => {
      // seated figure with a long sceptre
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineCap = "round";
      ctx.lineWidth = R * 0.07;
      ctx.beginPath();
      ctx.moveTo(-R * 0.05, -R * 0.34);
      ctx.lineTo(-R * 0.1, R * 0.05);
      ctx.lineTo(R * 0.2, R * 0.12);
      ctx.lineTo(R * 0.18, R * 0.42);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(R * 0.34, -R * 0.45);
      ctx.lineTo(R * 0.34, R * 0.42);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(-R * 0.03, -R * 0.44, R * 0.09, 0, 7);
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fill();
      ctx.lineWidth = R * 0.05;
      ctx.beginPath();
      ctx.moveTo(-R * 0.42, R * 0.46);
      ctx.lineTo(R * 0.42, R * 0.46);
      ctx.stroke();
    },
  },
  coin_doubloon: {
    metal: "gold",
    wear: 0.25,
    patina: 0.12,
    milled: true,
    legendHeads: "·CAROLVS·III·DEI·GRATIA·",
    legendTails: "·IN·VTROQ·FELIX·AVSPICE·DEO·",
    heads: (ctx, R) => {
      // cross fleury in a quatrefoil
      ctx.strokeStyle = "rgba(255,255,255,0.92)";
      ctx.lineWidth = R * 0.06;
      ctx.beginPath();
      for (let k = 0; k < 4; k++) {
        const a = (k * Math.PI) / 2 + Math.PI / 4;
        ctx.arc(
          Math.cos(a) * R * 0.26,
          Math.sin(a) * R * 0.26,
          R * 0.3,
          a + Math.PI * 0.62,
          a - Math.PI * 0.62,
          true,
        );
      }
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      const w = R * 0.11;
      ctx.fillRect(-w / 2, -R * 0.42, w, R * 0.84);
      ctx.fillRect(-R * 0.42, -w / 2, R * 0.84, w);
      for (let k = 0; k < 4; k++) {
        const a = (k * Math.PI) / 2;
        ctx.beginPath();
        ctx.arc(
          Math.cos(a) * R * 0.46,
          Math.sin(a) * R * 0.46,
          R * 0.075,
          0,
          7,
        );
        ctx.fill();
      }
    },
    tails: (ctx, R) => {
      // crowned quartered shield
      ctx.strokeStyle = "rgba(255,255,255,0.92)";
      ctx.lineWidth = R * 0.05;
      ctx.strokeRect(-R * 0.3, -R * 0.28, R * 0.6, R * 0.5);
      ctx.beginPath();
      ctx.moveTo(0, -R * 0.28);
      ctx.lineTo(0, R * 0.22);
      ctx.moveTo(-R * 0.3, -R * 0.03);
      ctx.lineTo(R * 0.3, -R * 0.03);
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      for (let i = 0; i < 5; i++) {
        ctx.beginPath();
        ctx.arc(-R * 0.24 + i * R * 0.12, -R * 0.4, R * 0.05, 0, 7);
        ctx.fill();
      }
      ctx.fillRect(-R * 0.3, -R * 0.37, R * 0.6, R * 0.045);
    },
  },
  coin_penny: {
    metal: "silver",
    wear: 0.6,
    patina: 0.55,
    milled: false,
    legendHeads: "EDW·R·ANGL·DNS·HYB",
    legendTails: "CIVITAS·LONDON",
    heads: (ctx, R) => {
      // crude facing bust with a trefoil crown
      ctx.strokeStyle = "rgba(255,255,255,0.88)";
      ctx.fillStyle = "rgba(255,255,255,0.88)";
      ctx.lineWidth = R * 0.05;
      ctx.beginPath();
      ctx.arc(0, R * 0.02, R * 0.3, 0, 7);
      ctx.stroke();
      for (const dx of [-R * 0.11, R * 0.11]) {
        ctx.beginPath();
        ctx.arc(dx, -R * 0.04, R * 0.035, 0, 7);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.moveTo(-R * 0.09, R * 0.16);
      ctx.quadraticCurveTo(0, R * 0.24, R * 0.09, R * 0.16);
      ctx.stroke();
      // crown: band + three points
      ctx.fillRect(-R * 0.26, -R * 0.36, R * 0.52, R * 0.07);
      for (const dx of [-R * 0.18, 0, R * 0.18]) {
        ctx.beginPath();
        ctx.moveTo(dx - R * 0.05, -R * 0.36);
        ctx.lineTo(dx, -R * 0.52);
        ctx.lineTo(dx + R * 0.05, -R * 0.36);
        ctx.fill();
      }
      // wavy hair either side
      for (const sgn of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(sgn * R * 0.3, -R * 0.1);
        ctx.quadraticCurveTo(sgn * R * 0.42, R * 0.1, sgn * R * 0.32, R * 0.32);
        ctx.stroke();
      }
    },
    tails: (ctx, R) => {
      // voided long cross with three pellets per quarter
      ctx.strokeStyle = "rgba(255,255,255,0.88)";
      ctx.lineWidth = R * 0.045;
      for (const off of [-R * 0.05, R * 0.05]) {
        ctx.beginPath();
        ctx.moveTo(off, -R * 0.62);
        ctx.lineTo(off, R * 0.62);
        ctx.moveTo(-R * 0.62, off);
        ctx.lineTo(R * 0.62, off);
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(255,255,255,0.88)";
      for (const sx of [-1, 1])
        for (const sy of [-1, 1])
          for (let p = 0; p < 3; p++) {
            const a = p * 2.1 + 0.5;
            ctx.beginPath();
            ctx.arc(
              sx * (R * 0.28 + Math.cos(a) * R * 0.09),
              sy * (R * 0.28 + Math.sin(a) * R * 0.09),
              R * 0.05,
              0,
              7,
            );
            ctx.fill();
          }
    },
  },
  coin_sovereign: {
    metal: "gold",
    wear: 0.2,
    patina: 0.08,
    milled: true,
    legendHeads: "VICTORIA·DEI·GRATIA",
    legendTails: "·1887·",
    heads: (ctx, R) => profileHead(ctx, R * 0.9, true),
    tails: (ctx, R) => {
      // St George on horseback, lance down
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.lineCap = "round";
      // horse body
      ctx.beginPath();
      ctx.ellipse(-R * 0.02, R * 0.02, R * 0.3, R * 0.14, -0.15, 0, 7);
      ctx.fill();
      // neck + head rearing
      ctx.lineWidth = R * 0.1;
      ctx.beginPath();
      ctx.moveTo(-R * 0.26, -R * 0.02);
      ctx.quadraticCurveTo(-R * 0.42, -R * 0.22, -R * 0.34, -R * 0.34);
      ctx.stroke();
      // legs
      ctx.lineWidth = R * 0.05;
      for (const [x0, y0, x1, y1] of [
        [-R * 0.2, R * 0.1, -R * 0.34, R * 0.38],
        [-R * 0.08, R * 0.12, -R * 0.1, R * 0.42],
        [R * 0.12, R * 0.12, R * 0.22, R * 0.4],
        [R * 0.24, R * 0.06, R * 0.4, R * 0.26],
      ]) {
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
      // rider
      ctx.beginPath();
      ctx.arc(R * 0.02, -R * 0.32, R * 0.07, 0, 7);
      ctx.fill();
      ctx.lineWidth = R * 0.07;
      ctx.beginPath();
      ctx.moveTo(0, -R * 0.26);
      ctx.quadraticCurveTo(R * 0.06, -R * 0.12, -R * 0.02, -R * 0.04);
      ctx.stroke();
      // lance
      ctx.lineWidth = R * 0.035;
      ctx.beginPath();
      ctx.moveTo(R * 0.12, -R * 0.4);
      ctx.lineTo(R * 0.34, R * 0.34);
      ctx.stroke();
      // ground line
      ctx.lineWidth = R * 0.04;
      ctx.beginPath();
      ctx.moveTo(-R * 0.45, R * 0.44);
      ctx.lineTo(R * 0.45, R * 0.44);
      ctx.stroke();
    },
  },
};

/** Face/edge sheet for one of the round catalog coins. */
export function coinMapsFor(id: string, seed: number): PbrMaps {
  const spec = COIN_SPECS[id];
  return coinMaps({ seed, ...(spec ?? COIN_SPECS.coin_real) });
}

/**
 * Single-face sheet for the cast cash coin (square hole, both sides alike):
 * raised outer rim, raised square rim and four invented character glyphs,
 * heavy verdigris. Planar-mapped by the extruded geometry.
 */
export function cashCoinMaps(seed: number): PbrMaps {
  const S = 512;
  const tone = METALS.bronze;
  const t = new TexBuf(S, S, tone.base, tone.rough, 1);
  const relief = t.layer((ctx) => {
    ctx.translate(S / 2, S / 2);
    const R = S * 0.46;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = S * 0.05;
    ctx.beginPath();
    ctx.arc(0, 0, R - S * 0.03, 0, Math.PI * 2);
    ctx.stroke();
    const hole = S * 0.14;
    ctx.strokeRect(
      -hole - S * 0.02,
      -hole - S * 0.02,
      (hole + S * 0.02) * 2,
      (hole + S * 0.02) * 2,
    );
    // four invented glyphs (top, bottom, right, left)
    ctx.lineWidth = S * 0.024;
    ctx.lineCap = "round";
    const rng = new TexRng(seed ^ 0x77);
    for (let g = 0; g < 4; g++) {
      const a = (g * Math.PI) / 2 - Math.PI / 2;
      ctx.save();
      ctx.translate(Math.cos(a) * S * 0.3, Math.sin(a) * S * 0.3);
      const strokes = 3 + rng.int(3);
      for (let k = 0; k < strokes; k++) {
        const x0 = rng.range(-S * 0.07, S * 0.07);
        const y0 = rng.range(-S * 0.08, S * 0.04);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        if (rng.chance(0.5))
          ctx.lineTo(
            x0 + rng.range(S * 0.04, S * 0.13),
            y0 + rng.range(-S * 0.02, S * 0.02),
          );
        else
          ctx.lineTo(
            x0 + rng.range(-S * 0.02, S * 0.02),
            y0 + rng.range(S * 0.05, S * 0.12),
          );
        ctx.stroke();
      }
      ctx.restore();
    }
  });
  const hf = TexBuf.layerAlpha(relief, t.n);
  blurField(hf, S, S, 2, false, false, 2);
  t.each((i, _u, _v, x, y) => {
    t.hf[i] = hf[i];
    const h = Math.min(1, hf[i] * 1.4);
    t.mixTo(i, tone.hi, h * 0.45);
    const pat =
      (1 - h) *
      (0.55 + 0.45 * Math.sin(x * 0.045 + seed) * Math.sin(y * 0.052 - seed));
    t.mixTo(i, tone.patina, Math.min(1, pat * 1.3));
    t.rough[i] = tone.rough + pat * 0.35 - h * 0.1;
    t.metal[i] = 1 - pat * 0.6;
  });
  return t.build({ normal: 3, metal: true, wrapU: false, wrapV: false });
}

// ---------------------------------------------------------------------------
// Stone / fossils
// ---------------------------------------------------------------------------

export interface StoneOpts {
  base: Rgb;
  band?: Rgb;
  /** Band frequency along u (ammonite growth bands); 0 = no bands. */
  bandFreq?: number;
  /** Fine striation frequency along u pressed into the normal map. */
  striae?: number;
  rough?: number;
  fleck?: number;
}

/** Mottled stone with optional growth banding along u. */
export function stoneMaps(seed: number, o: StoneOpts): PbrMaps {
  const W = 512;
  const H = 256;
  const t = new TexBuf(W, H, o.base, o.rough ?? 0.75, 0);
  const rng = new TexRng(seed);
  const ph1 = rng.range(0, 9);
  const ph2 = rng.range(0, 9);
  t.each((i, u, v, x, y) => {
    const warp = Math.sin(v * 9 + ph1) * 0.04 + Math.sin(v * 23 + ph2) * 0.015;
    if (o.band && o.bandFreq) {
      const b = 0.5 + 0.5 * Math.sin((u + warp) * o.bandFreq * Math.PI * 2);
      t.mixTo(i, o.band, sstep(0.35, 0.85, b) * 0.55);
    }
    const mottle =
      Math.sin(x * 0.07 + ph1 * 3) * Math.sin(y * 0.09 + ph2 * 2) * 0.5 +
      Math.sin(x * 0.21 + y * 0.17 + ph1) * 0.3;
    t.mul(i, 0.9 + mottle * 0.14);
    if (o.striae)
      t.hf[i] += Math.sin((u + warp) * o.striae * Math.PI * 2) * 0.1;
    t.hf[i] += mottle * 0.12;
    t.rough[i] = (o.rough ?? 0.75) + mottle * 0.1;
    if (
      o.fleck &&
      Math.sin(x * 3.1 + y * 4.7 + ph2 * 9) *
        Math.sin(x * 1.3 - y * 2.1 + ph1 * 7) >
        1 - o.fleck * 0.06
    ) {
      t.mul(i, 1.3);
      t.rough[i] -= 0.2;
    }
  });
  return t.build({ normal: 1.6 });
}

/** Split shale slab with a pressed-in fern frond (planar UV over the slab). */
export function fernShaleMaps(seed: number): PbrMaps {
  const S = 512;
  const base: Rgb = [0.33, 0.31, 0.27];
  const t = new TexBuf(S, S, base, 0.82, 0);
  const rng = new TexRng(seed);
  // sedimentary layering + mottle
  t.each((i, _u, v, x, y) => {
    const lay = Math.sin(v * 46 + Math.sin(x * 0.02) * 2) * 0.5;
    t.mul(i, 0.92 + lay * 0.09 + Math.sin(x * 0.05 + y * 0.04) * 0.05);
    t.hf[i] += lay * 0.06;
  });
  // the frond: central rachis with paired tapering pinnae, carbon black
  const frond = t.layer((ctx) => {
    ctx.translate(S * 0.5, S * 0.82);
    ctx.rotate(rng.range(-0.15, 0.15));
    ctx.strokeStyle = "rgba(30,26,22,0.85)";
    ctx.lineCap = "round";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(S * 0.04, -S * 0.36, -S * 0.02, -S * 0.66);
    ctx.stroke();
    const pinnae = 16;
    for (let k = 1; k <= pinnae; k++) {
      const tt = k / pinnae;
      const yy = -tt * S * 0.64;
      const xx = Math.sin(tt * 2.4) * S * 0.035;
      const len =
        S * 0.16 * Math.sin(Math.PI * Math.min(1, tt * 1.15)) + S * 0.02;
      for (const sgn of [-1, 1]) {
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(xx, yy);
        ctx.quadraticCurveTo(
          xx + sgn * len * 0.55,
          yy - len * 0.18,
          xx + sgn * len,
          yy - len * 0.34,
        );
        ctx.stroke();
        // leaflets along the pinna
        for (let l = 1; l <= 5; l++) {
          const lt = l / 5.5;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(xx + sgn * len * lt, yy - len * 0.32 * lt);
          ctx.lineTo(
            xx + sgn * len * lt + sgn * 4,
            yy - len * 0.32 * lt - 6 - lt * 4,
          );
          ctx.stroke();
        }
      }
    }
  });
  const mask = TexBuf.layerAlpha(frond, t.n);
  blurField(mask, S, S, 1.2, false, false, 1);
  t.blendLayer(frond, 0.9);
  for (let i = 0; i < t.n; i++) {
    t.hf[i] -= mask[i] * 0.5; // imprint sits below the surface
    t.rough[i] += mask[i] * 0.1;
  }
  return t.build({ normal: 2.4, wrapU: false, wrapV: false });
}

/** Flint heart urchin: five pore rows over the dome (spherical UV). */
export function urchinMaps(seed: number): PbrMaps {
  const W = 512;
  const H = 256;
  const base: Rgb = [0.5, 0.46, 0.38];
  const t = new TexBuf(W, H, base, 0.68, 0);
  const rng = new TexRng(seed);
  const ph = rng.range(0, 9);
  t.each((i, u, v, x, y) => {
    const mottle = Math.sin(x * 0.06 + ph) * Math.sin(y * 0.08 - ph) * 0.5;
    t.mul(i, 0.92 + mottle * 0.1);
    t.hf[i] += mottle * 0.08;
    // five ambulacra: paired pore rows converging on the apex (v = 1)
    const arm = Math.abs((((u * 5 + 0.5) % 1) - 0.5) * 2); // 0 on an arm centre
    const nearArm = 1 - sstep(0.06, 0.3, arm);
    const petal = nearArm * sstep(0.25, 0.6, v);
    if (petal > 0.02) {
      const pore = Math.sin(v * 120) * Math.sin(u * 640);
      t.mixTo(i, [0.45, 0.42, 0.36], petal * 0.5);
      t.hf[i] -= Math.max(0, pore) * petal * 0.22;
    }
    // scattered tubercle dots on the flanks
    if (Math.sin(x * 2.9 + ph) * Math.sin(y * 3.7 - ph) > 0.93 && v < 0.75) {
      t.hf[i] += 0.3;
      t.mul(i, 1.1);
    }
  });
  return t.build({ normal: 2.2, wrapV: false });
}

// ---------------------------------------------------------------------------
// Glass, paper, cork
// ---------------------------------------------------------------------------

export interface GlassOpts {
  tint: Rgb;
  /** Base opacity of the wall (alpha channel of the map). */
  opacity: number;
  /** 0..1 barnacle / salt crust on the outside. */
  crust?: number;
  seed: number;
}

/**
 * Glass wall sheet: per-pixel alpha (transmission look without the expensive
 * physical transmission), salt bloom towards the base, streaks, optional
 * barnacle discs. u around the bottle, v = bottom → top.
 */
export function glassMaps(o: GlassOpts): PbrMaps {
  const W = 512;
  const H = 256;
  const t = new TexBuf(W, H, o.tint, 0.08, 0);
  const rng = new TexRng(o.seed);
  const ph = rng.range(0, 9);
  t.each((i, u, v, x, y) => {
    const streak = Math.sin(u * 90 + Math.sin(v * 7 + ph) * 2) * 0.5 + 0.5;
    const bloom = (1 - sstep(0.05, 0.5, v)) * 0.5; // salt haze near the base
    t.a[i] = Math.min(1, o.opacity + bloom * 0.35 + streak * 0.06);
    t.mixTo(i, [0.9, 0.92, 0.9], bloom * 0.5);
    t.rough[i] = 0.06 + bloom * 0.5 + streak * 0.05;
    t.hf[i] = Math.sin(x * 0.15 + ph) * Math.sin(y * 0.2 - ph) * 0.06;
  });
  if (o.crust && o.crust > 0) {
    const discs = Math.round(26 * o.crust);
    for (let k = 0; k < discs; k++) {
      const cx = rng.int(W);
      const cy = H - rng.int(Math.round(H * 0.7));
      const r = rng.range(4, 12);
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const d = Math.hypot(dx, dy) / r;
          if (d > 1) continue;
          const xx = (((cx + dx) % W) + W) % W;
          const yy = cy + dy;
          if (yy < 0 || yy >= H) continue;
          const i = yy * W + xx;
          const ring = 0.65 + 0.35 * Math.sin(d * 9);
          t.set(i, [0.82 * ring, 0.8 * ring, 0.74 * ring]);
          t.a[i] = 0.97;
          t.rough[i] = 0.85;
          t.hf[i] = (1 - d) * 0.7;
        }
    }
  }
  return t.build({ normal: 1.4, alpha: true, transparent: true, wrapV: false });
}

/** Rolled letter: aged cream paper, faint ruling and handwriting shadow. */
export function paperMaps(seed: number): PbrMaps {
  const W = 256;
  const H = 128;
  const t = new TexBuf(W, H, [0.85, 0.78, 0.62], 0.85, 0);
  const rng = new TexRng(seed);
  const layer = t.layer((ctx) => {
    ctx.strokeStyle = "rgba(90,74,52,0.5)";
    ctx.lineWidth = 1;
    for (let l = 0; l < 7; l++) {
      const y = 18 + l * 14 + rng.range(-1, 1);
      ctx.beginPath();
      ctx.moveTo(8, y);
      // wobbly handwriting suggestion instead of a straight rule
      for (let x = 8; x < W - 8; x += 7)
        ctx.lineTo(x, y + Math.sin(x * 0.6 + l * 3 + seed) * 2.2);
      ctx.stroke();
    }
  });
  t.blendLayer(layer, 0.65);
  t.each((i, _u, v, x, y) => {
    const stain = Math.sin(x * 0.05 + seed) * Math.sin(y * 0.1 - seed);
    t.mixTo(i, [0.62, 0.5, 0.34], Math.max(0, stain) * 0.3);
    // browned edges of the roll
    const edge = 1 - sstep(0.06, 0.2, Math.min(v, 1 - v));
    t.mixTo(i, [0.5, 0.38, 0.24], edge * 0.55);
    t.hf[i] = Math.sin(x * 1.8) * 0.03;
  });
  return t.build({ normal: 0.8, wrapV: false });
}

/** Cork: tan base with dark lenticel pores. */
export function corkMaps(seed: number): PbrMaps {
  const S = 128;
  const t = new TexBuf(S, S, [0.62, 0.46, 0.3], 0.9, 0);
  const rng = new TexRng(seed);
  for (let k = 0; k < 90; k++) {
    const cx = rng.int(S);
    const cy = rng.int(S);
    const w = rng.range(1, 3);
    const h = rng.range(2, 7);
    for (let dy = 0; dy < h; dy++)
      for (let dx = 0; dx < w; dx++) {
        const i = ((cy + dy) % S) * S + ((cx + dx) % S);
        t.mul(i, 0.55);
        t.hf[i] -= 0.4;
      }
  }
  return t.build({ normal: 1.2 });
}

// ---------------------------------------------------------------------------
// Jewellery
// ---------------------------------------------------------------------------

export interface WornMetalOpts {
  base: Rgb;
  hi: Rgb;
  tarnish: Rgb;
  /** 0..1 tarnish coverage. */
  amount: number;
  rough: number;
  scratches?: number;
  /** Engraving drawn as a vector layer (white = cut INTO the metal). */
  engrave?: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
  seed: number;
}

/** Scratched / tarnished precious metal for rings, cases and chains. */
export function wornMetalMaps(o: WornMetalOpts): PbrMaps {
  const W = 512;
  const H = 256;
  const t = new TexBuf(W, H, o.base, o.rough, 1);
  const rng = new TexRng(o.seed);
  const ph = rng.range(0, 9);
  const scratchLayer = t.layer((ctx) => {
    drawScratches(ctx, rng, W, H, o.scratches ?? 60, 60, 1.1, 0.5, 0.1);
  });
  const scratch = TexBuf.layerAlpha(scratchLayer, t.n);
  let engraveMask: Float32Array | null = null;
  if (o.engrave) {
    const lay = t.layer((ctx) => o.engrave?.(ctx, W, H));
    engraveMask = TexBuf.layerAlpha(lay, t.n);
    blurField(engraveMask, W, H, 1, true, false, 1);
  }
  t.each((i, _u, v, x, y) => {
    const tarn =
      o.amount *
      sstep(
        0.45,
        0.8,
        0.5 +
          0.5 * Math.sin(x * 0.04 + ph) * Math.sin(y * 0.05 + ph * 2) +
          Math.sin(x * 0.013 - ph) * 0.25,
      );
    t.mixTo(i, o.tarnish, Math.min(1, tarn * 1.2));
    t.mixTo(i, o.hi, (1 - tarn) * 0.25 * (0.5 + 0.5 * Math.sin(v * 6.3)));
    t.rough[i] = o.rough + tarn * 0.4 + scratch[i] * 0.25;
    t.metal[i] = 1 - tarn * 0.25;
    t.hf[i] = -scratch[i] * 0.3;
    if (engraveMask) {
      const e = engraveMask[i];
      t.hf[i] -= e * 0.8;
      t.mixTo(i, o.tarnish, e * 0.6); // dirt settles in the cut
      t.rough[i] += e * 0.2;
    }
    t.mul(i, 0.97 + 0.06 * Math.sin(x * 1.3 + y * 1.9 + ph));
  });
  return t.build({ normal: 2, metal: true });
}

export const GOLD: Pick<WornMetalOpts, "base" | "hi" | "tarnish"> = {
  base: [0.84, 0.66, 0.28],
  hi: [0.99, 0.85, 0.48],
  tarnish: [0.42, 0.3, 0.12],
};

export const SILVER: Pick<WornMetalOpts, "base" | "hi" | "tarnish"> = {
  base: [0.7, 0.72, 0.74],
  hi: [0.94, 0.96, 0.97],
  tarnish: [0.15, 0.16, 0.19],
};

/** Soft cream nacre with faint rose/green interference blotches. */
export function nacreMaps(seed: number): PbrMaps {
  const S = 256;
  const t = new TexBuf(S, S, [0.8, 0.76, 0.7], 0.16, 0);
  const rng = new TexRng(seed);
  const ph = rng.range(0, 9);
  t.each((i, _u, _v, x, y) => {
    const a = Math.sin(x * 0.05 + ph) * Math.sin(y * 0.06 - ph);
    const b = Math.sin(x * 0.11 - ph * 2) * Math.sin(y * 0.09 + ph);
    t.mixTo(i, [0.95, 0.82, 0.84], Math.max(0, a) * 0.35);
    t.mixTo(i, [0.82, 0.9, 0.86], Math.max(0, b) * 0.3);
    t.rough[i] = 0.12 + Math.abs(a) * 0.06;
    t.hf[i] = Math.sin(x * 0.9 + ph) * Math.sin(y * 1.1) * 0.03;
  });
  return t.build({ normal: 0.5 });
}

/** Aged watch dial: minute track, Roman numerals, frozen hands, foxing. */
export function dialMaps(seed: number): PbrMaps {
  const S = 512;
  const t = new TexBuf(S, S, [0.76, 0.7, 0.56], 0.55, 0);
  const rng = new TexRng(seed);
  const layer = t.layer((ctx) => {
    ctx.translate(S / 2, S / 2);
    const R = S * 0.46;
    ctx.strokeStyle = "rgba(40,34,28,0.9)";
    ctx.fillStyle = "rgba(40,34,28,0.9)";
    // minute track
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.94, 0, Math.PI * 2);
    ctx.stroke();
    for (let m = 0; m < 60; m++) {
      const a = (m / 60) * Math.PI * 2;
      const len = m % 5 === 0 ? R * 0.07 : R * 0.03;
      ctx.lineWidth = m % 5 === 0 ? 3 : 1.5;
      ctx.beginPath();
      ctx.moveTo(
        Math.sin(a) * (R * 0.94 - len),
        -Math.cos(a) * (R * 0.94 - len),
      );
      ctx.lineTo(Math.sin(a) * R * 0.94, -Math.cos(a) * R * 0.94);
      ctx.stroke();
    }
    // Roman numerals
    const numerals = [
      "XII",
      "I",
      "II",
      "III",
      "IIII",
      "V",
      "VI",
      "VII",
      "VIII",
      "IX",
      "X",
      "XI",
    ];
    ctx.font = `bold ${Math.round(S * 0.085)}px 'Times New Roman', serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let n = 0; n < 12; n++) {
      const a = (n / 12) * Math.PI * 2;
      ctx.fillText(
        numerals[n],
        Math.sin(a) * R * 0.72,
        -Math.cos(a) * R * 0.72,
      );
    }
    // small seconds circle
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, R * 0.42, R * 0.16, 0, Math.PI * 2);
    ctx.stroke();
    // hands frozen at 7:38 (the moment the sea took it)
    const hour = ((7 + 38 / 60) / 12) * Math.PI * 2;
    const minute = (38 / 60) * Math.PI * 2;
    ctx.lineCap = "round";
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.sin(hour) * R * 0.42, -Math.cos(hour) * R * 0.42);
    ctx.stroke();
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.sin(minute) * R * 0.66, -Math.cos(minute) * R * 0.66);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.045, 0, Math.PI * 2);
    ctx.fill();
  });
  t.blendLayer(layer, 0.95);
  const ph = rng.range(0, 9);
  t.each((i, u, v, x, y) => {
    // foxing stains and the tide line across the dial
    const fox = Math.sin(x * 0.035 + ph) * Math.sin(y * 0.03 - ph * 2);
    t.mixTo(i, [0.5, 0.38, 0.22], Math.max(0, fox - 0.12) * 1.1);
    if (v < 0.38 + Math.sin(u * 9 + ph) * 0.03)
      t.mixTo(i, [0.44, 0.38, 0.28], 0.45);
    t.rough[i] = 0.55 + Math.max(0, fox) * 0.3;
  });
  return t.build({ normal: 0.6, wrapU: false, wrapV: false });
}

/** Amber body: warm gradient with swirls and dark specks (used transparent). */
export function amberMaps(seed: number): PbrMaps {
  const S = 256;
  const t = new TexBuf(S, S, [0.78, 0.44, 0.1], 0.16, 0);
  const rng = new TexRng(seed);
  const ph = rng.range(0, 9);
  t.each((i, _u, v, x, y) => {
    const swirl =
      Math.sin(x * 0.06 + Math.sin(y * 0.04 + ph) * 3) *
      Math.sin(y * 0.05 - ph);
    t.mixTo(i, [0.92, 0.62, 0.2], Math.max(0, swirl) * 0.5);
    t.mixTo(i, [0.55, 0.24, 0.05], Math.max(0, -swirl) * 0.4);
    t.a[i] = 0.82 + swirl * 0.06;
    // tiny organic specks
    if (Math.sin(x * 5.1 + ph) * Math.sin(y * 4.3 - ph) > 0.965) {
      t.mixTo(i, [0.2, 0.1, 0.03], 0.8);
      t.a[i] = 0.95;
    }
    t.rough[i] = 0.14 + Math.abs(swirl) * 0.08 + (1 - v) * 0.06;
  });
  return t.build({ normal: 0, alpha: true, transparent: true });
}
