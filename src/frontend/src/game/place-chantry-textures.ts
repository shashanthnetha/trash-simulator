// Procedural textures for Chantry Knoll (place-chantry.ts): the drystone of
// the chapel ruin (a slate/granite face with orange and grey lichen crusts –
// every block samples its own window of it), the elder's corky grey bark and
// the foliage atlas shared by the gorse, the nettles and the elder: four
// alpha-tested card tiles in one 2×2 atlas, so all three species draw as a
// single instanced mesh. Deterministic like the rest of the PBR library.

import * as THREE from "three";
import { mulberry32 } from "./noise";
import {
  type PbrMaps,
  type Rgb,
  TEX_ANISOTROPY,
  TexBuf,
  TexRng,
  blurField,
  cacheKey,
  cachedPbr,
  hashPix,
  lerp3,
  makeCanvas,
  noiseField,
  rgb,
  sstep,
} from "./textures-core";

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Drystone face
// ---------------------------------------------------------------------------

/**
 * Weathered drystone face: blue-grey slate merging into warmer granite
 * patches, horizontal cleavage grooves on the slate, pale weathering, crusts
 * of grey Lecanora lichen with darker rims, orange Xanthoria rosettes in
 * clusters, black tar-spot dots, a faint algal film and mica sparkle. One
 * tile ≈ 1.5 m; the ruin gives every block a random window into it, so no
 * two stones read alike. map + normal + roughness, tileable.
 */
export function pbrChantryStone(size: 512 | 1024): PbrMaps {
  return cachedPbr(cacheKey("chantryStone", [size]), () => {
    const S = size;
    const k = S / 1024;
    const rng = new TexRng(0xc4a1);
    const SLATE: Rgb = rgb("#555b60");
    const GRANITE: Rgb = rgb("#7f786c");
    const PALE: Rgb = rgb("#a5a59c");
    const CRUST: Rgb = rgb("#babdaf");
    const CRUST_RIM: Rgb = rgb("#747d69");
    const ALGAE: Rgb = rgb("#5b6e46");
    const buf = new TexBuf(S, S, SLATE, 0.86, 0);
    const nPatch = noiseField(S, S, 901, { freq: 3, oct: 3 });
    const nGrain = noiseField(S, S, 902, { freq: 36, oct: 3 });
    const nCleave = noiseField(S, S, 903, {
      freq: 4,
      freqY: 34,
      oct: 3,
      mode: "ridged",
    });
    const nWeather = noiseField(S, S, 904, { freq: 6, oct: 4 });
    const nCrust = noiseField(S, S, 905, { freq: 9, oct: 4, mode: "billow" });
    const nAlgae = noiseField(S, S, 906, { freq: 5, oct: 3 });
    const nPit = noiseField(S, S, 907, { freq: 40, oct: 2, mode: "billow" });

    // Orange rosettes in clusters + tar-spot dots, with wrap copies
    const lichen = buf.layer((ctx) => {
      const stamp = (
        x: number,
        y: number,
        fn: (px: number, py: number) => void,
      ): void => {
        for (const [ox, oy] of [
          [0, 0],
          [S, 0],
          [-S, 0],
          [0, S],
          [0, -S],
        ]) {
          const px = x + ox;
          const py = y + oy;
          if (px < -40 * k || px > S + 40 * k) continue;
          if (py < -40 * k || py > S + 40 * k) continue;
          fn(px, py);
        }
      };
      for (let c = 0; c < 6; c++) {
        const cx = rng.next() * S;
        const cy = rng.next() * S;
        const n = 4 + rng.int(7);
        for (let i = 0; i < n; i++) {
          const x = cx + rng.gauss() * 60 * k;
          const y = cy + rng.gauss() * 60 * k;
          const r = (4 + rng.next() * 13) * k;
          const lobes = 5 + rng.int(4);
          const rot = rng.next() * TAU;
          stamp(x, y, (px, py) => {
            const g = ctx.createRadialGradient(px, py, r * 0.15, px, py, r);
            // Xanthoria: ochre-orange, well short of saturated
            g.addColorStop(0, "rgba(176,120,60,0.9)");
            g.addColorStop(0.7, "rgba(205,153,76,0.92)");
            g.addColorStop(1, "rgba(227,191,107,0.82)");
            ctx.fillStyle = g;
            ctx.beginPath();
            for (let a = 0; a <= 40; a++) {
              const th = rot + (a / 40) * TAU;
              const rr = r * (0.85 + 0.15 * Math.cos(th * lobes));
              const qx = px + Math.cos(th) * rr;
              const qy = py + Math.sin(th) * rr;
              if (a === 0) ctx.moveTo(qx, qy);
              else ctx.lineTo(qx, qy);
            }
            ctx.closePath();
            ctx.fill();
          });
        }
      }
      ctx.fillStyle = "rgba(24,24,22,0.9)";
      for (let i = 0; i < 200; i++) {
        const x = rng.next() * S;
        const y = rng.next() * S;
        const r = (1 + rng.next() * 2.2) * k;
        stamp(x, y, (px, py) => {
          ctx.beginPath();
          ctx.arc(px, py, r, 0, TAU);
          ctx.fill();
        });
      }
    });
    const lichenA = TexBuf.layerAlpha(lichen, buf.n);
    const lichenH = blurField(
      Float32Array.from(lichenA),
      S,
      S,
      Math.max(1, Math.round(2 * k)),
      true,
      true,
      1,
    );

    buf.each((i) => {
      const t = sstep(0.35, 0.65, nPatch[i]);
      let col = lerp3(SLATE, GRANITE, t);
      const g = 0.86 + nGrain[i] * 0.26 + (hashPix(i, 1) - 0.5) * 0.12;
      col = [col[0] * g, col[1] * g, col[2] * g];
      const cleave = sstep(0.74, 0.93, nCleave[i]) * (1 - t * 0.8);
      const cd = 1 - cleave * 0.42;
      col = [col[0] * cd, col[1] * cd, col[2] * cd];
      const weather = sstep(0.55, 0.82, nWeather[i]);
      col = lerp3(col, PALE, weather * 0.45);
      const cv = nCrust[i];
      const crust = sstep(0.6, 0.7, cv);
      const rim = sstep(0.56, 0.6, cv) * (1 - sstep(0.6, 0.64, cv));
      col = lerp3(col, CRUST, crust * 0.6);
      col = lerp3(col, CRUST_RIM, rim * 0.45);
      const algae = sstep(0.62, 0.86, nAlgae[i]) * (1 - crust);
      col = lerp3(col, ALGAE, algae * 0.32);
      const pit = sstep(0.8, 0.92, nPit[i]);
      const pd = 1 - pit * 0.3;
      col = [col[0] * pd, col[1] * pd, col[2] * pd];
      const spark = hashPix(i, 4) > 0.996 ? 1 : 0;
      if (spark) col = [col[0] * 1.3, col[1] * 1.3, col[2] * 1.28];
      buf.set(i, col);
      buf.hf[i] =
        nGrain[i] * 0.3 +
        (nPatch[i] - 0.5) * 0.25 -
        cleave * 0.7 +
        crust * 0.18 -
        pit * 0.5 +
        (hashPix(i, 7) - 0.5) * 0.1 +
        lichenH[i] * 0.35;
      buf.rough[i] =
        0.84 +
        crust * 0.1 +
        weather * 0.04 +
        cleave * 0.04 +
        pit * 0.06 -
        spark * 0.35 +
        lichenA[i] * 0.08;
    });
    buf.blendLayer(lichen, 0.88);
    return buf.build({ normal: 3, normalScale: 0.85 });
  });
}

// ---------------------------------------------------------------------------
// Elder bark
// ---------------------------------------------------------------------------

/**
 * Elder bark: grey-brown, deeply furrowed and corky along the stem (v = axis),
 * pale horizontal lenticels, a green algal tint in the damp furrows.
 * 256×512, map + normal + roughness, tileable.
 */
export function pbrElderBark(): PbrMaps {
  return cachedPbr(cacheKey("elderBark", []), () => {
    const W = 256;
    const H = 512;
    const rng = new TexRng(0xe1de);
    const BASE: Rgb = rgb("#7d7466");
    const DARK: Rgb = rgb("#4a4139");
    const PALE: Rgb = rgb("#b3a894");
    const ALGAE: Rgb = rgb("#6c7a55");
    const buf = new TexBuf(W, H, BASE, 0.9, 0);
    const nF = noiseField(W, H, 911, {
      freq: 10,
      freqY: 2,
      oct: 4,
      mode: "ridged",
    });
    const nP = noiseField(W, H, 912, { freq: 12, oct: 3 });
    const nA = noiseField(W, H, 913, { freq: 3, oct: 3 });
    const lent = buf.layer((ctx) => {
      ctx.fillStyle = "rgba(190,178,156,0.9)";
      for (let i = 0; i < 90; i++) {
        const x = rng.next() * W;
        const y = rng.next() * H;
        const rw = 2.5 + rng.next() * 3;
        const rh = 0.9 + rng.next() * 0.9;
        for (const ox of [0, W, -W]) {
          ctx.beginPath();
          ctx.ellipse(x + ox, y, rw, rh, 0, 0, TAU);
          ctx.fill();
        }
      }
    });
    const lentA = TexBuf.layerAlpha(lent, buf.n);
    buf.each((i) => {
      const fis = sstep(0.55, 0.9, nF[i]);
      buf.mixTo(i, DARK, fis * 0.75);
      buf.mul(i, 0.88 + nP[i] * 0.24 + (hashPix(i, 3) - 0.5) * 0.08);
      const pale = sstep(0.6, 0.85, nP[i]) * (1 - fis);
      buf.mixTo(i, PALE, pale * 0.3);
      const algae = sstep(0.6, 0.85, nA[i]) * (1 - fis * 0.5);
      buf.mixTo(i, ALGAE, algae * 0.45);
      buf.mixTo(i, PALE, lentA[i] * 0.8);
      buf.hf[i] = 0.6 - fis * 0.7 + nP[i] * 0.2 + lentA[i] * 0.2;
      buf.rough[i] = 0.9 - pale * 0.05 + algae * 0.03;
    });
    return buf.build({ normal: 3.5, normalScale: 0.9 });
  });
}

// ---------------------------------------------------------------------------
// Foliage atlas (gorse, nettle, elder)
// ---------------------------------------------------------------------------

/** Tile indices of the 2×2 atlas (0/1 = top row, 2/3 = bottom row). */
export const FOLIAGE_TILE = {
  gorse: 0,
  gorseInner: 1,
  nettle: 2,
  elder: 3,
} as const;

type Rng = () => number;

function rgbaStr(c: readonly number[], s: number, a: number): string {
  const r = Math.round(Math.min(255, c[0] * s));
  const g = Math.round(Math.min(255, c[1] * s));
  const b = Math.round(Math.min(255, c[2] * s));
  return `rgba(${r},${g},${b},${a})`;
}

/**
 * Whorls of short spines radiating from picked points – the gorse's foliage
 * is nothing but spines. `pick` returns a point (or null to skip).
 */
function spineWhorls(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  k: number,
  count: number,
  pick: () => [number, number] | null,
  cols: ReadonlyArray<readonly number[]>,
  alpha: number,
  lw: number,
  lenMin: number,
  lenMax: number,
  shade: number,
): void {
  for (let i = 0; i < count; i++) {
    const p = pick();
    if (!p) continue;
    const n = 3 + Math.floor(rng() * 4);
    const base = rng() * TAU;
    for (let j = 0; j < n; j++) {
      const a = base + (j * TAU) / n + (rng() - 0.5) * 0.5;
      const len = (lenMin + rng() * (lenMax - lenMin)) * k;
      const c = cols[Math.floor(rng() * cols.length)];
      ctx.strokeStyle = rgbaStr(c, shade * (0.8 + rng() * 0.4), alpha);
      ctx.lineWidth = lw * (0.75 + rng() * 0.5) * k;
      const ex = p[0] + Math.cos(a) * len;
      const ey = p[1] + Math.sin(a) * len;
      const bend = (rng() - 0.5) * 0.3 * len;
      const mx = p[0] + Math.cos(a) * len * 0.5 - Math.sin(a) * bend;
      const my = p[1] + Math.sin(a) * len * 0.5 + Math.cos(a) * bend;
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      ctx.quadraticCurveTo(mx, my, ex, ey);
      ctx.stroke();
    }
  }
}

const GORSE_GREENS: ReadonlyArray<readonly number[]> = [
  [30, 58, 28],
  [44, 78, 34],
  [60, 96, 40],
  [78, 110, 44],
  [36, 66, 30],
  [52, 88, 46],
  [96, 128, 50],
  [112, 140, 58],
];

/**
 * Gorse card: a dome of dark spine whorls over a few grey stems, dead brown
 * spines in the interior, chrome-yellow pea flowers clustered along the outer
 * shoots (`flowers` scales their number) and an interior occlusion. The dome
 * fills the lower 72 % of the tile – gorse is wider than tall.
 */
function drawGorseTile(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  T: number,
  rng: Rng,
  flowers: number,
  shade: number,
): void {
  const k = T / 512;
  const cx = ox + T * 0.5;
  const baseY = oy + T * 0.965;
  const domeH = T * 0.62;
  const cy = baseY - domeH * 0.5;
  const rx = T * 0.41; // leaves room for the rim tips inside the tile
  const ry = domeH * 0.56;
  const pick = (): [number, number, number] => {
    for (let guard = 0; guard < 64; guard++) {
      const px = cx + (rng() * 2 - 1) * rx;
      const py = cy + (rng() * 2 - 1) * ry;
      const dx = (px - cx) / rx;
      const dy = (py - cy) / ry;
      const e = dx * dx + dy * dy;
      if (e < 0.98 && rng() < 1 - e * 0.35) return [px, py, e];
    }
    return [cx, cy, 0];
  };
  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, oy, T, T);
  ctx.clip();
  ctx.lineCap = "round";
  // Woody base
  for (let i = 0; i < 6; i++) {
    const x0 = cx + (rng() - 0.5) * T * 0.25;
    const ang = -Math.PI / 2 + (rng() - 0.5) * 1.2;
    const len = domeH * (0.35 + rng() * 0.35);
    ctx.strokeStyle = rgbaStr([72, 60, 46], shade, 0.95);
    ctx.lineWidth = (4 + rng() * 5) * k;
    ctx.beginPath();
    ctx.moveTo(x0, baseY + 4 * k);
    ctx.quadraticCurveTo(
      x0 + Math.cos(ang) * len * 0.5 + (rng() - 0.5) * 30 * k,
      baseY + Math.sin(ang) * len * 0.5,
      x0 + Math.cos(ang) * len,
      baseY + Math.sin(ang) * len,
    );
    ctx.stroke();
  }
  // Dead interior spines
  spineWhorls(
    ctx,
    rng,
    k,
    Math.round(120 * k),
    () => {
      const p = pick();
      return p[2] < 0.5 ? [p[0], p[1]] : null;
    },
    [
      [104, 82, 46],
      [84, 66, 38],
    ],
    0.9,
    2,
    12,
    22,
    shade,
  );
  // Shadow pass, then the green whorls
  spineWhorls(
    ctx,
    rng,
    k,
    Math.round(720 * k),
    () => {
      const p = pick();
      return [p[0] + 2 * k, p[1] + 4 * k];
    },
    [[12, 24, 10]],
    0.8,
    3.4,
    13,
    24,
    1,
  );
  spineWhorls(
    ctx,
    rng,
    k,
    Math.round(1400 * k),
    () => {
      const p = pick();
      return [p[0], p[1]];
    },
    GORSE_GREENS,
    0.93,
    2,
    14,
    30,
    shade,
  );
  // Rim: shoot tips bristle outwards beyond the dome – gorse is spiky, never
  // a sphere
  const nTips = Math.round(220 * k);
  for (let i = 0; i < nTips; i++) {
    const a = rng() * TAU;
    const e0 = 0.8 + rng() * 0.18;
    const sx = cx + Math.cos(a) * rx * e0;
    const sy = cy + Math.sin(a) * ry * e0;
    if (sy > baseY - domeH * 0.08) continue;
    const len = (18 + rng() * 20) * k;
    const dir = a + (rng() - 0.5) * 0.7;
    const c = GORSE_GREENS[Math.floor(rng() * GORSE_GREENS.length)];
    ctx.strokeStyle = rgbaStr(c, shade * (0.95 + rng() * 0.4), 0.95);
    ctx.lineWidth = (1.6 + rng() * 1.2) * k;
    const ex = sx + Math.cos(dir) * len;
    const ey = sy + Math.sin(dir) * len;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(
      sx + Math.cos(dir) * len * 0.55 + (rng() - 0.5) * 6 * k,
      sy + Math.sin(dir) * len * 0.55 + (rng() - 0.5) * 6 * k,
      ex,
      ey,
    );
    ctx.stroke();
    for (let j = 0; j < 3; j++) {
      const t = 0.3 + rng() * 0.6;
      const px = sx + Math.cos(dir) * len * t;
      const py = sy + Math.sin(dir) * len * t;
      const sa = dir + (rng() < 0.5 ? 1 : -1) * (0.6 + rng() * 0.5);
      const sl = (7 + rng() * 7) * k;
      ctx.lineWidth = (1.1 + rng() * 0.8) * k;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + Math.cos(sa) * sl, py + Math.sin(sa) * sl);
      ctx.stroke();
    }
  }
  // Flowers: clusters along the outer shoots, favouring the upper half
  const nCl = Math.round(48 * flowers * k);
  for (let c = 0; c < nCl; c++) {
    let p = pick();
    for (let guard = 0; guard < 20; guard++) {
      if (p[2] >= 0.3 && (p[1] < cy + ry * 0.45 || rng() < 0.3)) break;
      p = pick();
    }
    const n = 2 + Math.floor(rng() * 4);
    for (let j = 0; j < n; j++) {
      const fx = p[0] + (rng() - 0.5) * 26 * k;
      const fy = p[1] + (rng() - 0.5) * 26 * k;
      const rot = rng() * Math.PI;
      const r1 = (4.2 + rng() * 2.2) * k;
      const r2 = r1 * 0.62;
      if (rng() < 0.22) {
        ctx.fillStyle = "rgba(226,146,32,0.95)";
        ctx.beginPath();
        ctx.ellipse(fx, fy, r1 * 0.55, r2 * 0.6, rot, 0, TAU);
        ctx.fill();
        continue;
      }
      const g = ctx.createLinearGradient(
        fx - Math.cos(rot) * r1,
        fy - Math.sin(rot) * r1,
        fx + Math.cos(rot) * r1,
        fy + Math.sin(rot) * r1,
      );
      g.addColorStop(0, "rgba(222,156,26,0.97)");
      g.addColorStop(0.45, "rgba(250,210,40,0.97)");
      g.addColorStop(1, "rgba(255,226,70,0.97)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(fx, fy, r1, r2, rot, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = "rgba(200,130,20,0.7)";
      ctx.lineWidth = 1 * k;
      ctx.beginPath();
      ctx.moveTo(fx - Math.cos(rot) * r1 * 0.6, fy - Math.sin(rot) * r1 * 0.6);
      ctx.lineTo(fx + Math.cos(rot) * r1 * 0.5, fy + Math.sin(rot) * r1 * 0.5);
      ctx.stroke();
    }
  }
  // A few spines over the flowers so they sit inside the bush
  spineWhorls(
    ctx,
    rng,
    k,
    Math.round(140 * k),
    () => {
      const p = pick();
      return [p[0], p[1]];
    },
    GORSE_GREENS,
    0.9,
    1.8,
    10,
    20,
    shade,
  );
  // Frayed base: the lowest spines thin out, so a card on sloping ground
  // never shows a cut edge where it meets the sand
  ctx.globalCompositeOperation = "destination-out";
  const fade = ctx.createLinearGradient(0, baseY - domeH * 0.1, 0, baseY + 2);
  fade.addColorStop(0, "rgba(0,0,0,0)");
  fade.addColorStop(1, "rgba(0,0,0,0.85)");
  ctx.fillStyle = fade;
  ctx.fillRect(ox, baseY - domeH * 0.1, T, domeH * 0.1 + 4);
  ctx.globalCompositeOperation = "source-over";
  // Interior occlusion, kept inside the drawn alpha
  ctx.globalCompositeOperation = "source-atop";
  const g = ctx.createRadialGradient(
    cx,
    baseY - domeH * 0.3,
    domeH * 0.08,
    cx,
    baseY - domeH * 0.3,
    domeH * 0.75,
  );
  g.addColorStop(0, "rgba(8,16,6,0.38)");
  g.addColorStop(1, "rgba(8,16,6,0)");
  ctx.fillStyle = g;
  ctx.fillRect(ox, oy, T, T);
  ctx.globalCompositeOperation = "source-over";
  ctx.restore();
}

/**
 * One leaf: ovate (or heart-based) outline with serrated margins, filled
 * with a base→tip gradient, a dark outline, midrib and lateral veins.
 * `ang` is the direction of the midrib (canvas radians), `L` its length.
 */
function drawLeaf(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  ang: number,
  L: number,
  W: number,
  fill: readonly [readonly number[], readonly number[]],
  vein: readonly number[],
  shade: number,
  teeth: number,
  heart: boolean,
  k: number,
): void {
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const P = (s: number, w: number): [number, number] => [
    x + ca * s * L - sa * w,
    y + sa * s * L + ca * w,
  ];
  const N = 26;
  const hw: number[] = [];
  for (let i = 0; i <= N; i++) {
    const s = i / N;
    let w = Math.sin(Math.PI * s ** 0.8) ** 0.85 * W;
    if (heart && s < 0.12) w *= 0.35 + 5.4 * s;
    const tp = s * teeth;
    const saw = tp - Math.floor(tp);
    w *= 1 + 0.15 * (saw < 0.7 ? saw / 0.7 : (1 - saw) / 0.3) - 0.075;
    hw.push(w);
  }
  ctx.beginPath();
  for (let i = 0; i <= N; i++) {
    const [px, py] = P(i / N, hw[i]);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  for (let i = N; i >= 0; i--) {
    const [px, py] = P(i / N, -hw[i]);
    ctx.lineTo(px, py);
  }
  ctx.closePath();
  const [ax, ay] = P(0, 0);
  const [bx, by] = P(1, 0);
  const g = ctx.createLinearGradient(ax, ay, bx, by);
  g.addColorStop(0, rgbaStr(fill[0], shade, 1));
  g.addColorStop(1, rgbaStr(fill[1], shade, 1));
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = rgbaStr([22, 42, 18], shade, 0.8);
  ctx.lineWidth = 1 * k;
  ctx.stroke();
  // Midrib + lateral veins
  ctx.strokeStyle = rgbaStr(vein, shade, 0.85);
  ctx.lineWidth = 1.4 * k;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  const [tx, ty] = P(0.96, 0);
  ctx.lineTo(tx, ty);
  ctx.stroke();
  ctx.lineWidth = 0.8 * k;
  ctx.strokeStyle = rgbaStr(vein, shade, 0.55);
  for (let j = 0; j < 5; j++) {
    const s0 = 0.12 + j * 0.16;
    const s1 = Math.min(0.97, s0 + 0.14);
    const wj = hw[Math.round(s1 * N)] * 0.8;
    for (const sg of [1, -1]) {
      const [x0, y0] = P(s0, 0);
      const [x1, y1] = P(s1, sg * wj);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
  }
}

/** Point and tangent on a quadratic Bézier. */
function bez(
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  t: number,
): { x: number; y: number; tx: number; ty: number } {
  const u = 1 - t;
  const x = u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0];
  const y = u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1];
  const tx = 2 * u * (p1[0] - p0[0]) + 2 * t * (p2[0] - p1[0]);
  const ty = 2 * u * (p1[1] - p0[1]) + 2 * t * (p2[1] - p1[1]);
  const l = Math.hypot(tx, ty) || 1;
  return { x, y, tx: tx / l, ty: ty / l };
}

/**
 * Nettle clump: six stems fanning from the base, decussate pairs of
 * heart-based, coarsely toothed leaves (side pairs alternate with a
 * foreshortened forward leaf), drooping seed strings on the upper nodes.
 */
function drawNettleTile(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  T: number,
  rng: Rng,
): void {
  const k = T / 512;
  const cx = ox + T * 0.5;
  const baseY = oy + T * 0.965;
  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, oy, T, T);
  ctx.clip();
  ctx.lineCap = "round";
  const FRONT: readonly [readonly number[], readonly number[]] = [
    [44, 78, 34],
    [66, 102, 46],
  ];
  const VEIN = [88, 118, 62];
  interface Stem {
    p0: [number, number];
    p1: [number, number];
    p2: [number, number];
    h: number;
  }
  const stems: Stem[] = [];
  const nS = 6;
  for (let i = 0; i < nS; i++) {
    const x0 = cx + (i - (nS - 1) / 2) * 24 * k + (rng() - 0.5) * 14 * k;
    const h = T * (0.6 + rng() * 0.36);
    const lean = (rng() - 0.5) * 0.4 + ((x0 - cx) / T) * 1.1;
    stems.push({
      p0: [x0, baseY],
      p1: [x0 + Math.sin(lean) * h * 0.12, baseY - h * 0.55],
      p2: [x0 + Math.sin(lean) * h * 0.4, baseY - h * 0.97],
      h,
    });
  }
  const nodes = [0.3, 0.47, 0.63, 0.78, 0.9];
  // Back leaves (darker) then stems then front leaves
  for (let pass = 0; pass < 3; pass++) {
    for (let si = 0; si < stems.length; si++) {
      const st = stems[si];
      if (pass === 1) {
        ctx.strokeStyle = rgbaStr([44, 70, 34], 1, 1);
        ctx.lineWidth = 5 * k;
        ctx.beginPath();
        ctx.moveTo(st.p0[0], st.p0[1]);
        ctx.quadraticCurveTo(st.p1[0], st.p1[1], st.p2[0], st.p2[1]);
        ctx.stroke();
        ctx.strokeStyle = rgbaStr([80, 110, 54], 1, 1);
        ctx.lineWidth = 3 * k;
        ctx.stroke();
        continue;
      }
      for (let ni = 0; ni < nodes.length; ni++) {
        const f = nodes[ni];
        const q = bez(st.p0, st.p1, st.p2, f);
        const tang = Math.atan2(q.ty, q.tx);
        const L = (98 - f * 58) * k * (st.h / (T * 0.8));
        const W = L * 0.36;
        const side = (ni + si) % 2 === 0;
        const back = pass === 0;
        if (side) {
          // one side leaf per pass: the back pass draws the far one darker
          const sg = back ? -1 : 1;
          const a = tang + sg * (1.4 + rng() * 0.3);
          drawLeaf(
            ctx,
            q.x,
            q.y,
            a,
            L,
            W,
            FRONT,
            VEIN,
            back ? 0.72 : 1,
            9,
            true,
            k,
          );
        } else if (!back) {
          // forward leaf, foreshortened, pointing down towards the viewer
          const a = tang + Math.PI * (0.88 + (rng() - 0.5) * 0.2);
          drawLeaf(
            ctx,
            q.x,
            q.y,
            a,
            L * 0.62,
            W * 1.15,
            FRONT,
            VEIN,
            1.05,
            9,
            true,
            k,
          );
        }
        // Seed strings on the upper nodes
        if (!back && ni >= 3 && rng() < 0.8) {
          const n = 1 + Math.floor(rng() * 2);
          for (let s = 0; s < n; s++) {
            const dir = tang + (rng() < 0.5 ? 1 : -1) * (1.2 + rng() * 0.5);
            const len = (28 + rng() * 22) * k;
            const ex = q.x + Math.cos(dir) * len;
            const ey = q.y + Math.sin(dir) * len + len * 0.55;
            ctx.strokeStyle = "rgba(128,146,96,0.9)";
            ctx.lineWidth = 1.2 * k;
            ctx.beginPath();
            ctx.moveTo(q.x, q.y);
            ctx.quadraticCurveTo(
              q.x + Math.cos(dir) * len * 0.6,
              q.y + Math.sin(dir) * len * 0.6,
              ex,
              ey,
            );
            ctx.stroke();
            ctx.fillStyle = "rgba(152,166,112,0.92)";
            for (let d = 0; d < 8; d++) {
              const t = 0.15 + (d / 8) * 0.85;
              const b = bez(
                [q.x, q.y],
                [
                  q.x + Math.cos(dir) * len * 0.6,
                  q.y + Math.sin(dir) * len * 0.6,
                ],
                [ex, ey],
                t,
              );
              ctx.beginPath();
              ctx.arc(b.x, b.y, 1.7 * k, 0, TAU);
              ctx.fill();
            }
          }
        }
      }
    }
  }
  ctx.globalCompositeOperation = "source-atop";
  const g = ctx.createRadialGradient(
    cx,
    baseY - T * 0.25,
    T * 0.05,
    cx,
    baseY - T * 0.25,
    T * 0.55,
  );
  g.addColorStop(0, "rgba(8,16,6,0.32)");
  g.addColorStop(1, "rgba(8,16,6,0)");
  ctx.fillStyle = g;
  ctx.fillRect(ox, oy, T, T);
  ctx.globalCompositeOperation = "source-over";
  ctx.restore();
}

/**
 * Elder card: seven pinnate compound leaves (5–7 finely serrated leaflets on
 * a stalk) fanning from the base, three drooping umbels of purple-black
 * berries on red-purple pedicels hanging in front – late-summer elder.
 */
function drawElderTile(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  T: number,
  rng: Rng,
): void {
  const k = T / 512;
  const cx = ox + T * 0.5;
  const baseY = oy + T * 0.965;
  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, oy, T, T);
  ctx.clip();
  ctx.lineCap = "round";
  const FILL: readonly [readonly number[], readonly number[]] = [
    [46, 82, 34],
    [74, 110, 48],
  ];
  const VEIN = [102, 132, 72];
  interface Compound {
    x0: number;
    y0: number;
    ang: number;
    R: number;
    shade: number;
  }
  const leaves: Compound[] = [];
  for (let i = 0; i < 7; i++) {
    const ang = -Math.PI + ((i + 0.5) / 7) * Math.PI + (rng() - 0.5) * 0.25;
    leaves.push({
      x0: cx + (rng() - 0.5) * 50 * k,
      y0: baseY - rng() * 46 * k - 6 * k,
      ang,
      R: T * (0.4 + rng() * 0.17),
      shade: i % 2 === 0 ? 0.78 : 1,
    });
  }
  leaves.sort((a, b) => a.shade - b.shade);
  for (const lf of leaves) {
    const ca = Math.cos(lf.ang);
    const sa = Math.sin(lf.ang);
    const bend = (rng() - 0.5) * 0.5;
    const p0: [number, number] = [lf.x0, lf.y0];
    const p2: [number, number] = [lf.x0 + ca * lf.R, lf.y0 + sa * lf.R];
    const p1: [number, number] = [
      lf.x0 + ca * lf.R * 0.5 - sa * bend * lf.R * 0.4,
      lf.y0 + sa * lf.R * 0.5 + ca * bend * lf.R * 0.4,
    ];
    ctx.strokeStyle = rgbaStr([78, 96, 54], lf.shade, 1);
    ctx.lineWidth = 2.4 * k;
    ctx.beginPath();
    ctx.moveTo(p0[0], p0[1]);
    ctx.quadraticCurveTo(p1[0], p1[1], p2[0], p2[1]);
    ctx.stroke();
    const pairs = rng() < 0.5 ? [0.3, 0.55, 0.78] : [0.36, 0.66];
    for (const s of pairs) {
      const q = bez(p0, p1, p2, s);
      const tang = Math.atan2(q.ty, q.tx);
      const Ll = lf.R * (0.36 - s * 0.08);
      for (const sg of [-1, 1]) {
        drawLeaf(
          ctx,
          q.x,
          q.y,
          tang + sg * (0.72 + rng() * 0.25),
          Ll,
          Ll * 0.24,
          FILL,
          VEIN,
          lf.shade * (0.9 + rng() * 0.2),
          14,
          false,
          k,
        );
      }
    }
    const q = bez(p0, p1, p2, 0.97);
    drawLeaf(
      ctx,
      q.x,
      q.y,
      Math.atan2(q.ty, q.tx),
      lf.R * 0.3,
      lf.R * 0.075,
      FILL,
      VEIN,
      lf.shade,
      14,
      false,
      k,
    );
  }
  // Berry umbels
  for (let c = 0; c < 3; c++) {
    const hx = cx + (c - 1) * T * 0.24 + (rng() - 0.5) * T * 0.14;
    const hy = baseY - T * (0.46 + rng() * 0.2);
    ctx.strokeStyle = "rgba(130,48,64,1)";
    ctx.lineWidth = 3 * k;
    ctx.beginPath();
    ctx.moveTo(cx + (hx - cx) * 0.3, baseY - 20 * k);
    ctx.quadraticCurveTo(hx - 10 * k, hy + 60 * k, hx, hy);
    ctx.stroke();
    interface Berry {
      x: number;
      y: number;
      r: number;
    }
    const berries: Berry[] = [];
    const n = 14 + Math.floor(rng() * 5);
    for (let i = 0; i < n; i++) {
      const a = Math.PI * (0.12 + (i / (n - 1)) * 0.76) + (rng() - 0.5) * 0.12;
      const len = (18 + rng() * 26) * k;
      const ex = hx + Math.cos(a) * len;
      const ey = hy + Math.sin(a) * len;
      ctx.strokeStyle = "rgba(152,58,74,0.95)";
      ctx.lineWidth = 1.5 * k;
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      const nb = 1 + Math.floor(rng() * 3);
      for (let b = 0; b < nb; b++) {
        berries.push({
          x: ex + (rng() - 0.5) * 7 * k,
          y: ey + (rng() - 0.5) * 7 * k,
          r: (4 + rng() * 1.6) * k,
        });
      }
    }
    for (const b of berries) {
      ctx.fillStyle = "rgba(28,12,32,1)";
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "rgba(96,74,104,0.8)";
      ctx.beginPath();
      ctx.arc(b.x - b.r * 0.3, b.y - b.r * 0.3, b.r * 0.3, 0, TAU);
      ctx.fill();
    }
  }
  ctx.globalCompositeOperation = "source-atop";
  const g = ctx.createRadialGradient(
    cx,
    baseY - T * 0.2,
    T * 0.04,
    cx,
    baseY - T * 0.2,
    T * 0.5,
  );
  g.addColorStop(0, "rgba(8,16,6,0.3)");
  g.addColorStop(1, "rgba(8,16,6,0)");
  ctx.fillStyle = g;
  ctx.fillRect(ox, oy, T, T);
  ctx.globalCompositeOperation = "source-over";
  ctx.restore();
}

/** Base green written into the empty texels of each tile (see below). */
const TILE_FILL: ReadonlyArray<readonly number[]> = [
  [38, 66, 32],
  [30, 52, 26],
  [44, 76, 36],
  [48, 82, 38],
];

/**
 * Colour the transparent texels: bilinear filtering and every mip level blend
 * a card's edge with its empty neighbours, and a canvas stores those as black
 * – dark fringes up close, black blobs at a distance. The foliage colours are
 * dilated outwards a few texels (within the tile) and the rest of each tile
 * is filled with its base green; the alpha stays 0.
 */
function dilateColours(
  d: Uint8ClampedArray,
  w: number,
  h: number,
  passes: number,
): void {
  const n = w * h;
  const hw = w / 2;
  const hh = h / 2;
  let filled = new Uint8Array(n);
  for (let i = 0; i < n; i++) filled[i] = d[i * 4 + 3] >= 8 ? 1 : 0;
  const rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    rgb[i * 3] = d[i * 4];
    rgb[i * 3 + 1] = d[i * 4 + 1];
    rgb[i * 3 + 2] = d[i * 4 + 2];
  }
  for (let p = 0; p < passes; p++) {
    const next = new Uint8Array(filled);
    for (let y = 1; y < h - 1; y++) {
      const tileRow = y < hh ? 0 : 1;
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (filled[i]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let cnt = 0;
        for (const j of [i - 1, i + 1, i - w, i + w]) {
          if (!filled[j]) continue;
          // stay inside the tile
          const jy = (j / w) | 0;
          const jx = j - jy * w;
          if ((jy < hh ? 0 : 1) !== tileRow) continue;
          if ((jx < hw ? 0 : 1) !== (x < hw ? 0 : 1)) continue;
          r += rgb[j * 3];
          g += rgb[j * 3 + 1];
          b += rgb[j * 3 + 2];
          cnt++;
        }
        if (cnt === 0) continue;
        rgb[i * 3] = r / cnt;
        rgb[i * 3 + 1] = g / cnt;
        rgb[i * 3 + 2] = b / cnt;
        next[i] = 1;
      }
    }
    filled = next;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!filled[i]) {
        const f = TILE_FILL[(y < hh ? 0 : 2) + (x < hw ? 0 : 1)];
        rgb[i * 3] = f[0];
        rgb[i * 3 + 1] = f[1];
        rgb[i * 3 + 2] = f[2];
      }
      d[i * 4] = rgb[i * 3];
      d[i * 4 + 1] = rgb[i * 3 + 1];
      d[i * 4 + 2] = rgb[i * 3 + 2];
    }
  }
}

/**
 * The foliage atlas (RGBA, sRGB, clamped): 2×2 tiles – gorse in flower,
 * darker interior gorse with few flowers, a nettle clump and an elder
 * leaf-and-berry card. Uploaded as raw, non-premultiplied data so the empty
 * texels can carry colour. NOT cached: the knoll owns and disposes it.
 */
export function chantryFoliageAtlas(size: 512 | 1024): THREE.Texture {
  const [, ctx] = makeCanvas(size, size);
  ctx.clearRect(0, 0, size, size);
  const T = size / 2;
  drawGorseTile(ctx, 0, 0, T, mulberry32(0x60a5e), 1, 1);
  drawGorseTile(ctx, T, 0, T, mulberry32(0x60a5f), 0.3, 0.78);
  drawNettleTile(ctx, 0, T, T, mulberry32(0x4e771e));
  drawElderTile(ctx, T, T, T, mulberry32(0xe1de7));
  const img = ctx.getImageData(0, 0, size, size);
  dilateColours(img.data, size, size, 5);
  const tex = new THREE.DataTexture(
    img.data,
    size,
    size,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  // Canvas order is top row first – flip like a CanvasTexture would
  tex.flipY = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = TEX_ANISOTROPY;
  tex.needsUpdate = true;
  return tex;
}
