// Procedural canvas textures for the maritime pines (vegetation-pines.ts):
// deeply fissured bark (albedo + normal map), a two-variant needle-plate atlas
// for the crown cards (outer plate + dense dark interior fill) and a
// two-variant whole-tree impostor atlas for the far LOD. Same house pattern as
// vegetation-textures.ts (deterministic, tileable where needed), kept in a
// separate file so the pines own their look completely.

import * as THREE from "three";
import { clamp, lerp, mulberry32 } from "./noise";
import { tileFbm } from "./vegetation-textures";

/** Needle palette (sRGB) – the card atlas and the impostor must match. */
const NEEDLE_COLS: ReadonlyArray<readonly [number, number, number]> = [
  [64, 88, 52],
  [80, 112, 62],
  [100, 128, 66],
  [68, 102, 74],
];

type Draw = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

function makeTexture(
  w: number,
  h: number,
  draw: Draw,
  srgb: boolean,
  repeat: boolean,
): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (ctx) draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(c);
  const wrap = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.wrapS = wrap;
  tex.wrapT = wrap;
  tex.anisotropy = 8;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Tangent-space normal map from a height field (same convention as the rocks). */
function normalFromHeight(
  hgt: Float32Array,
  w: number,
  h: number,
  strength: number,
): THREE.Texture {
  return makeTexture(
    w,
    h,
    (ctx) => {
      const img = ctx.createImageData(w, h);
      const d = img.data;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const l = hgt[y * w + ((x - 1 + w) % w)];
          const r = hgt[y * w + ((x + 1) % w)];
          const u = hgt[((y - 1 + h) % h) * w + x];
          const dn = hgt[((y + 1) % h) * w + x];
          const nx = (l - r) * strength;
          const ny = (u - dn) * strength;
          const len = Math.sqrt(nx * nx + ny * ny + 1);
          const i = (y * w + x) * 4;
          d[i] = ((nx / len) * 0.5 + 0.5) * 255;
          d[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
          d[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
          d[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    },
    false,
    true,
  );
}

/**
 * A fan of thin, slightly drooping needle strokes radiating from (cx,cy) –
 * clustered needles, not a blob. `dir`/`spread` confine the fan (spread π =
 * full circle, smaller values give an outward-pointing edge tuft), `shade`
 * scales the palette and `lw` the stroke width.
 */
function drawTuft(
  ctx: CanvasRenderingContext2D,
  rng: () => number,
  cx: number,
  cy: number,
  r: number,
  lw: number,
  shade: number,
  dir = 0,
  spread = Math.PI,
): void {
  ctx.lineCap = "round";
  const n = Math.round(16 + r * 0.85 + rng() * 12);
  for (let i = 0; i < n; i++) {
    const a = dir + (rng() - 0.5) * 2 * spread;
    const len = r * (0.45 + rng() * 0.55);
    const droop = len * (0.1 + rng() * 0.28);
    const ex = cx + Math.cos(a) * len;
    const ey = cy + Math.sin(a) * len + droop;
    const mx = cx + Math.cos(a) * len * 0.55;
    const my = cy + Math.sin(a) * len * 0.55 + droop * 0.3;
    const c = NEEDLE_COLS[Math.floor(rng() * NEEDLE_COLS.length)];
    const k = shade * (0.82 + rng() * 0.4);
    const cr = Math.round(clamp(c[0] * k, 0, 255));
    const cg = Math.round(clamp(c[1] * k, 0, 255));
    const cb = Math.round(clamp(c[2] * k, 0, 255));
    ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.92)`;
    ctx.lineWidth = lw * (0.7 + rng() * 0.6);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.quadraticCurveTo(mx, my, ex, ey);
    ctx.stroke();
  }
}

/**
 * Soft elliptical foliage mass – lays a solid-alpha core UNDER the needle
 * strokes so a card reads as a closed canopy at range instead of a bristly
 * star with sky holes (alphaTest keeps the core, erodes only the soft rim).
 */
function drawMass(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  shade: number,
  squash = 0.8,
): void {
  const cr = Math.round(clamp(56 * shade, 0, 255));
  const cg = Math.round(clamp(80 * shade, 0, 255));
  const cb = Math.round(clamp(48 * shade, 0, 255));
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, squash);
  const g = ctx.createRadialGradient(0, 0, r * 0.15, 0, 0, r);
  g.addColorStop(0, `rgba(${cr},${cg},${cb},0.96)`);
  g.addColorStop(0.6, `rgba(${cr},${cg},${cb},0.82)`);
  g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * One 256² needle-plate variant of the card atlas: brown twig hints, a solid
 * mass underlay, two needle passes (shadow + lit), a frayed rim of outward
 * tufts and a few sunlit tips. `dense` = the darker interior-fill variant
 * (rounder, more closed, less fray).
 */
function paintPlate(
  ctx: CanvasRenderingContext2D,
  rng: () => number,
  ox: number,
  dense: boolean,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, 0, 256, 256);
  ctx.clip();
  const cx = ox + 128;
  const cy = 122;
  // Twigs under everything – they peek through needle gaps near the centre
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(86,60,38,0.9)";
  for (let i = 0; i < 5; i++) {
    const a = rng() * Math.PI * 2;
    ctx.lineWidth = 3 + rng() * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(
      cx + Math.cos(a) * (40 + rng() * 55),
      cy + Math.sin(a) * (30 + rng() * 40),
    );
    ctx.stroke();
  }
  // Solid mass underlay – the closed core of the plate
  const nM = dense ? 24 : 18;
  for (let i = 0; i < nM; i++) {
    const a = rng() * Math.PI * 2;
    const rr = Math.sqrt(rng());
    drawMass(
      ctx,
      cx + Math.cos(a) * rr * (dense ? 96 : 108),
      cy + Math.sin(a) * rr * (dense ? 62 : 66),
      28 + rng() * (dense ? 22 : 16),
      (dense ? 0.55 : 0.78) + rng() * 0.18,
    );
  }
  // Needle tufts: darker shadow pass offset down-right, then the lit pass
  const pts: { x: number; y: number; r: number }[] = [];
  const nT = dense ? 26 : 24;
  for (let i = 0; i < nT; i++) {
    const a = rng() * Math.PI * 2;
    const rr = Math.sqrt(rng());
    pts.push({
      x: cx + Math.cos(a) * rr * (dense ? 88 : 100),
      y: cy + Math.sin(a) * rr * (dense ? 70 : 78),
      r: 24 + rng() * 16,
    });
  }
  for (const p of pts)
    drawTuft(ctx, rng, p.x + 2, p.y + 4, p.r, 2.3, dense ? 0.4 : 0.52);
  for (const p of pts) drawTuft(ctx, rng, p.x, p.y, p.r, 1.8, dense ? 0.74 : 1);
  // Frayed rim: tufts pointing outward along the plate boundary
  const nR = dense ? 8 : 14;
  for (let i = 0; i < nR; i++) {
    const a = (i / nR) * Math.PI * 2 + rng() * 0.5;
    drawTuft(
      ctx,
      rng,
      cx + Math.cos(a) * 106,
      cy + Math.sin(a) * 80,
      26 + rng() * 12,
      1.7,
      dense ? 0.6 : 0.9,
      a,
      0.6,
    );
  }
  // Sunlit tips on the upper face
  const nH = dense ? 4 : 7;
  for (let i = 0; i < nH; i++) {
    drawTuft(
      ctx,
      rng,
      cx + (rng() - 0.5) * 150,
      cy - 20 - rng() * 55,
      16 + rng() * 10,
      1.4,
      1.28,
    );
  }
  // Interior occlusion, kept inside the drawn alpha
  ctx.globalCompositeOperation = "source-atop";
  const g = ctx.createRadialGradient(cx, cy + 10, 14, cx, cy + 10, 150);
  g.addColorStop(0, "rgba(14,20,12,0.3)");
  g.addColorStop(1, "rgba(14,20,12,0)");
  ctx.fillStyle = g;
  ctx.fillRect(ox, 0, 256, 256);
  ctx.globalCompositeOperation = "source-over";
  ctx.restore();
}

/**
 * Crown plate atlas (512×256, alpha for alphaTest): two 256² variants side by
 * side – 0 = outer needle plate with a frayed silhouette, 1 = dense dark
 * interior fill. Solid mass cores under layered tufts make a single card read
 * as a closed foliage mass with a soft edge instead of a star with sky holes.
 */
export function pineNeedleTexture(): THREE.Texture {
  const rng = mulberry32(0x9147a3);
  return makeTexture(
    512,
    256,
    (ctx) => {
      paintPlate(ctx, rng, 0, false);
      paintPlate(ctx, rng, 256, true);
    },
    true,
    false,
  );
}

/**
 * Maritime pine bark (tileable, u around the trunk, v along it): reddish-brown
 * plates separated by deep, dark, slightly meandering vertical fissures, a few
 * horizontal cracks and grey patina patches. Height field drives a normal map.
 */
export function pineBarkTextures(): {
  map: THREE.Texture;
  normalMap: THREE.Texture;
} {
  const w = 160;
  const h = 320;
  const rng = mulberry32(0xba124);
  const hgt = new Float32Array(w * h);
  const map = makeTexture(
    w,
    h,
    (ctx) => {
      const img = ctx.createImageData(w, h);
      const d = img.data;
      for (let y = 0; y < h; y++) {
        const v = y / h;
        for (let x = 0; x < w; x++) {
          const u = x / w;
          const wob = tileFbm(u, v, 2, 2, 21) - 0.5;
          const wob2 = tileFbm(u, v, 4, 2, 22) - 0.5;
          // Two scales of vertical fissures, meandering with the noise
          const band =
            0.5 +
            0.5 * Math.sin(Math.PI * 2 * (u * 6 + wob * 1.1 + wob2 * 0.4));
          const band2 =
            0.5 + 0.5 * Math.sin(Math.PI * 2 * (u * 13 + wob * 1.7 + v * 0.6));
          const groove = smooth01((band - 0.76) / 0.2);
          const groove2 = smooth01((band2 - 0.84) / 0.13) * 0.6;
          // Occasional horizontal cracks where the plates break
          const hn = tileFbm(u, v, 3, 2, 23) - 0.5;
          const hband =
            0.5 + 0.5 * Math.sin(Math.PI * 2 * (v * 9 + hn * 2.2 + wob * 0.8));
          const hGate = smooth01((tileFbm(u, v, 2, 2, 24) - 0.55) / 0.2);
          const crack = Math.max(
            groove,
            Math.max(groove2, smooth01((hband - 0.9) / 0.08) * hGate * 0.9),
          );
          const plate = tileFbm(u, v, 6, 3, 25);
          const patina = smooth01((tileFbm(u, v, 3, 2, 26) - 0.58) / 0.14);
          let r =
            118 + (plate - 0.5) * 56 + smooth01((plate - 0.6) / 0.15) * 26;
          let g = 74 + (plate - 0.5) * 36 + smooth01((plate - 0.6) / 0.15) * 8;
          let b = 54 + (plate - 0.5) * 26;
          r = lerp(r, 124, patina * 0.45);
          g = lerp(g, 114, patina * 0.45);
          b = lerp(b, 106, patina * 0.45);
          const dark = 1 - crack * 0.72;
          const grain = (rng() - 0.5) * 14;
          const i = (y * w + x) * 4;
          d[i] = clamp(r * dark + grain, 0, 255);
          d[i + 1] = clamp(g * dark + grain, 0, 255);
          d[i + 2] = clamp(b * dark + grain, 0, 255);
          d[i + 3] = 255;
          hgt[y * w + x] =
            0.55 + (plate - 0.5) * 0.5 - crack * 0.9 + (rng() - 0.5) * 0.08;
        }
      }
      ctx.putImageData(img, 0, 0);
    },
    true,
    true,
  );
  return { map, normalMap: normalFromHeight(hgt, w, h, 3.0) };
}

/** smoothstep(0,1,t) with the edges already normalised out. */
function smooth01(t: number): number {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
}

/**
 * One 512×1024 impostor variant: thick tapering trunk that ends INSIDE the
 * crown, eight branches rising then flattening outward whose tips carry the
 * biggest foliage masses, and a closed umbrella canopy (solid mass cores with
 * needle fringes, darker below, sunlit fringe on top).
 */
function paintImpostorVariant(
  ctx: CanvasRenderingContext2D,
  rng: () => number,
  vi: number,
): void {
  const ox = vi * 512;
  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, 0, 512, 1024);
  ctx.clip();
  const cx = ox + 256;
  const crownHalf = vi === 0 ? 224 : 190;
  const crownTop = vi === 0 ? 58 : 40;
  const crownDepth = vi === 0 ? 380 : 470;
  const lean = vi === 0 ? 26 : -30;
  const trunkTopY = crownTop + crownDepth * 0.5;
  const trunkX = (t: number): number =>
    cx + lean * t * t + Math.sin(t * 3.8 + vi * 2.1) * 7;
  const trunkY = (t: number): number => lerp(1014, trunkTopY, t);
  ctx.lineCap = "round";
  // Trunk: dark outline pass then the reddish core, tapering curved segments
  for (let pass = 0; pass < 2; pass++) {
    for (let s = 0; s < 10; s++) {
      const t0 = s / 10;
      const t1 = (s + 1) / 10;
      const lw = lerp(54, 13, t0 ** 0.8);
      if (pass === 0) {
        ctx.strokeStyle = "rgb(44,31,24)";
        ctx.lineWidth = lw + 6;
      } else {
        const r = Math.round(lerp(106, 138, t0));
        const g = Math.round(lerp(64, 86, t0));
        const b = Math.round(lerp(48, 58, t0));
        ctx.strokeStyle = `rgb(${r},${g},${b})`;
        ctx.lineWidth = lw;
      }
      ctx.beginPath();
      ctx.moveTo(trunkX(t0), trunkY(t0));
      ctx.lineTo(trunkX(t1), trunkY(t1));
      ctx.stroke();
    }
  }
  // A few dark fissure strokes on the lower trunk
  ctx.strokeStyle = "rgba(40,28,22,0.55)";
  for (let i = 0; i < 6; i++) {
    const t0 = rng() * 0.5;
    const off = (rng() - 0.5) * 26;
    ctx.lineWidth = 3 + rng() * 3;
    ctx.beginPath();
    ctx.moveTo(trunkX(t0) + off, trunkY(t0));
    ctx.lineTo(trunkX(t0 + 0.2) + off * 0.8, trunkY(t0 + 0.2));
    ctx.stroke();
  }
  // Branches rising from the crown region, flattening outward – their tips
  // carry the biggest canopy masses so nothing floats
  const tips: { x: number; y: number }[] = [];
  for (let b = 0; b < 8; b++) {
    const t = 0.52 + (b / 7) * 0.42 + (rng() - 0.5) * 0.04;
    const sx = (b % 2 === 0 ? 1 : -1) * (rng() < 0.15 ? -1 : 1);
    const y0 = trunkY(t);
    const relC = clamp((y0 - crownTop) / crownDepth, 0, 1);
    const reach =
      crownHalf * (0.4 + 0.55 * Math.min(relC * 1.7, 1)) * (0.78 + rng() * 0.3);
    const x0 = trunkX(t);
    const x1 = x0 + sx * reach;
    const y1 = y0 - reach * (0.3 + rng() * 0.25);
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass === 0 ? "rgb(44,31,24)" : "rgb(96,64,46)";
      ctx.lineWidth = (pass === 0 ? 13 : 9) * (1 - relC * 0.25);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo(x0 + sx * reach * 0.45, y0 - reach * 0.42, x1, y1);
      ctx.stroke();
    }
    tips.push({ x: x1, y: y1 });
  }
  // Canopy: masses at the branch tips plus interior fill, bottom (darker)
  // first so the underside stays in shadow
  const pts: { x: number; y: number; r: number }[] = tips.map((p) => ({
    x: p.x,
    y: p.y,
    r: 46 + rng() * 18,
  }));
  for (let i = 0; i < 26; i++) {
    const rr = Math.sqrt(rng()) * crownHalf;
    const th = rng() * Math.PI * 2;
    const dome = (rr / crownHalf) ** 1.7;
    pts.push({
      x: clamp(cx + Math.cos(th) * rr, ox + 44, ox + 468),
      y: crownTop + dome * crownDepth * 0.4 + rng() * crownDepth * 0.5,
      r: 38 + rng() * 22,
    });
  }
  pts.sort((a, b) => b.y - a.y);
  for (const p of pts) {
    const rel = clamp((p.y - crownTop) / crownDepth, 0, 1);
    const shade = clamp(1.16 - 0.55 * rel, 0.5, 1.16);
    drawMass(ctx, p.x, p.y, p.r * 0.85, shade * 0.72, 0.72);
    drawTuft(ctx, rng, p.x + 2, p.y + 4, p.r, 1.9, shade * 0.55);
    drawTuft(ctx, rng, p.x, p.y, p.r, 1.6, shade);
  }
  // Sunlit fringe along the dome top
  for (let i = 0; i < 9; i++) {
    const a = -Math.PI / 2 + (i / 8 - 0.5) * 2.4;
    drawTuft(
      ctx,
      rng,
      cx + Math.cos(a) * crownHalf * 0.66,
      crownTop + crownDepth * 0.16 + Math.abs(Math.sin(a)) * crownDepth * 0.18,
      20 + rng() * 10,
      1.3,
      1.3,
    );
  }
  ctx.restore();
}

/**
 * Far-LOD impostor atlas (1024², two 512×1024 variants side by side) matching
 * the reworked near look – closed umbrella silhouette, no floating clumps.
 * Variant 0 is broad and flat-topped, variant 1 narrower and deeper.
 */
export function pineImpostorTexture(): THREE.Texture {
  const rng = mulberry32(0x1a70e5);
  return makeTexture(
    1024,
    1024,
    (ctx) => {
      paintImpostorVariant(ctx, rng, 0);
      paintImpostorVariant(ctx, rng, 1);
    },
    true,
    false,
  );
}
