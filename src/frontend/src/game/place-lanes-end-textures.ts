// Procedural canvas textures for Lane's End (place-lanes-end.ts): the
// hawthorn/blackthorn foliage-card atlas of the hedgebanks, the cow-parsley/
// nettle herb atlas of the lane foot, weathered granite for the gateposts and
// the stile, flaking painted timber for the fingerpost and the decal atlas
// (faded cattle-grid warning sign, its plate and the dark pit under the grid
// bars). Deterministic and cached like the rest of the texture library.

import * as THREE from "three";
import { clamp, mulberry32 } from "./noise";
import {
  type PbrMaps,
  type Rgb,
  TexBuf,
  cacheKey,
  cachedPbr,
  cachedTex,
  clamp01,
  makeCanvas,
  mix,
  noiseField,
  rgb,
  sstep,
  stampBlob,
  texFromCanvas,
} from "./textures-core";
import { tileFbm } from "./vegetation-textures";

type Rng = () => number;

/** Sheet size for a quality tier: full on ultra/high, halved on medium/low. */
function sheet(hi: boolean, full: number): number {
  return hi ? full : full >> 1;
}

// Scalar working colour for the pixel loops: lerp3() allocates a fresh
// array per call, which adds up to millions of allocations over a 512² set.
let mr = 0;
let mg = 0;
let mb = 0;
function mixInto(t: Rgb, k: number): void {
  mr += (t[0] - mr) * k;
  mg += (t[1] - mg) * k;
  mb += (t[2] - mb) * k;
}

function rgba(r: number, g: number, b: number, a = 1): string {
  return `rgba(${Math.round(clamp(r, 0, 255))},${Math.round(clamp(g, 0, 255))},${Math.round(clamp(b, 0, 255))},${a})`;
}

// ---------------------------------------------------------------------------
// Leaves
// ---------------------------------------------------------------------------

interface LeafStyle {
  /** Lobes per side (0 = entire oval); the tip always counts as a lobe. */
  lobes: number;
  lobeAmp: number;
  /** Half-width as a fraction of the length. */
  width: number;
  /** Serrated edge amplitude (nettle). */
  serrate: number;
  /** Envelope exponent: < 1 = broad base (heart-shaped). */
  bulge: number;
}

const HAWTHORN_LEAF: LeafStyle = {
  lobes: 3,
  lobeAmp: 0.5,
  width: 0.42,
  serrate: 0,
  bulge: 0.75,
};
const BLACKTHORN_LEAF: LeafStyle = {
  lobes: 0,
  lobeAmp: 0,
  width: 0.3,
  serrate: 0,
  bulge: 0.9,
};
const NETTLE_LEAF: LeafStyle = {
  lobes: 0,
  lobeAmp: 0,
  width: 0.4,
  serrate: 0.11,
  bulge: 0.55,
};

/**
 * One leaf from its base (x, y), axis along `ang`, drawn as a polygon whose
 * half-width follows a sine envelope modulated by lobes/serrations, plus a
 * lighter midrib. Small enough that the polygon is cheap (22 steps per side).
 */
function drawLeaf(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  len: number,
  ang: number,
  st: LeafStyle,
  fill: string,
  rib: string | null,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  const N = 22;
  const wMax = len * st.width;
  ctx.beginPath();
  for (let side = 0; side < 2; side++) {
    for (let k = 0; k <= N; k++) {
      const i = side === 0 ? k : N - k;
      const t = i / N;
      let w = wMax * Math.sin(Math.PI * t) ** st.bulge;
      if (st.lobes > 0) {
        w *= 1 + st.lobeAmp * Math.cos(Math.PI * 2 * st.lobes * t + Math.PI);
      }
      if (st.serrate > 0 && t > 0.12 && t < 0.96) {
        w *= 1 + st.serrate * (i % 2 === 0 ? 1 : -1);
      }
      const px = t * len;
      const py = side === 0 ? w : -w;
      if (side === 0 && k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (rib) {
    ctx.strokeStyle = rib;
    ctx.lineWidth = Math.max(0.6, len * 0.05);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(len * 0.05, 0);
    ctx.lineTo(len * 0.86, 0);
    ctx.stroke();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Hedge card atlas – hawthorn (left half) and blackthorn (right half)
// ---------------------------------------------------------------------------

interface Twig {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  mx: number;
  my: number;
}

/**
 * Woody sprig skeleton: a few origins low in the card, each with forked twigs
 * fanning upward and outward. Returned so the leaves can sit on the twigs.
 */
function drawTwigs(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  ox: number,
  w: number,
  h: number,
  colour: string,
  thorns: boolean,
  lw: number,
): Twig[] {
  const twigs: Twig[] = [];
  const origins = [
    [0.5, 0.86, 4],
    [0.27, 0.74, 3],
    [0.73, 0.76, 3],
    [0.5, 0.56, 3],
  ];
  ctx.lineCap = "round";
  ctx.strokeStyle = colour;
  for (const [fx, fy, n] of origins) {
    const x0 = ox + fx * w;
    const y0 = fy * h;
    for (let k = 0; k < n; k++) {
      // Upward fan (canvas y grows downward): -160° .. -20°
      const a = -Math.PI * (0.12 + 0.76 * ((k + rng() * 0.8) / n));
      const len = h * (0.22 + rng() * 0.2);
      const x1 = x0 + Math.cos(a) * len;
      const y1 = y0 + Math.sin(a) * len;
      const mx = (x0 + x1) / 2 + (rng() - 0.5) * len * 0.35;
      const my = (y0 + y1) / 2 + (rng() - 0.5) * len * 0.35;
      ctx.lineWidth = lw * (1.1 + rng() * 0.6);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo(mx, my, x1, y1);
      ctx.stroke();
      twigs.push({ x0, y0, x1, y1, mx, my });
      // One fork per twig
      const ft = 0.45 + rng() * 0.3;
      const fx0 = (1 - ft) ** 2 * x0 + 2 * (1 - ft) * ft * mx + ft * ft * x1;
      const fy0 = (1 - ft) ** 2 * y0 + 2 * (1 - ft) * ft * my + ft * ft * y1;
      const fa = a + (rng() - 0.5) * 1.3;
      const fl = len * (0.35 + rng() * 0.3);
      const fx1 = fx0 + Math.cos(fa) * fl;
      const fy1 = fy0 + Math.sin(fa) * fl;
      ctx.lineWidth = lw * 0.8;
      ctx.beginPath();
      ctx.moveTo(fx0, fy0);
      ctx.lineTo(fx1, fy1);
      ctx.stroke();
      twigs.push({
        x0: fx0,
        y0: fy0,
        x1: fx1,
        y1: fy1,
        mx: (fx0 + fx1) / 2,
        my: (fy0 + fy1) / 2,
      });
      if (thorns) {
        // Short sharp ticks off the twig
        ctx.lineWidth = lw * 0.55;
        for (let s = 0; s < 3; s++) {
          const tt = 0.25 + rng() * 0.7;
          const tx = (1 - tt) ** 2 * x0 + 2 * (1 - tt) * tt * mx + tt * tt * x1;
          const ty = (1 - tt) ** 2 * y0 + 2 * (1 - tt) * tt * my + tt * tt * y1;
          const ta = a + (rng() < 0.5 ? 1 : -1) * (0.9 + rng() * 0.5);
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(tx + Math.cos(ta) * 4, ty + Math.sin(ta) * 4);
          ctx.stroke();
        }
      }
    }
  }
  return twigs;
}

/** Point on a twig at parameter t (quadratic Bézier). */
function twigPoint(tw: Twig, t: number): [number, number, number] {
  const u = 1 - t;
  const x = u * u * tw.x0 + 2 * u * t * tw.mx + t * t * tw.x1;
  const y = u * u * tw.y0 + 2 * u * t * tw.my + t * t * tw.y1;
  const dx = 2 * u * (tw.mx - tw.x0) + 2 * t * (tw.x1 - tw.mx);
  const dy = 2 * u * (tw.my - tw.y0) + 2 * t * (tw.y1 - tw.my);
  return [x, y, Math.atan2(dy, dx)];
}

function drawScrubCard(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  ox: number,
  w: number,
  h: number,
  blackthorn: boolean,
): void {
  const style = blackthorn ? BLACKTHORN_LEAF : HAWTHORN_LEAF;
  const palette: ReadonlyArray<Rgb> = blackthorn
    ? [
        [48, 74, 46],
        [58, 88, 54],
        [42, 64, 40],
        [66, 96, 60],
      ]
    : [
        [60, 98, 42],
        [76, 114, 50],
        [94, 132, 58],
        [72, 106, 48],
        [106, 136, 60],
      ];
  const leafLen = blackthorn ? [8, 12] : [11, 17];
  const twigCol = blackthorn ? "rgb(46,40,38)" : "rgb(78,64,50)";
  // Shadow pass: the same skeleton and leaves, dark and offset – gives the
  // sprig depth without a second geometry layer.
  const seedTwigs = mulberry32(0x3a7 + (blackthorn ? 1 : 0));
  const passTwigs = (dx: number, dy: number, col: string): Twig[] => {
    ctx.save();
    ctx.translate(dx, dy);
    const r = mulberry32(seedTwigs() * 1e9);
    const t = drawTwigs(ctx, r, ox, w, h, col, true, 1.6);
    ctx.restore();
    return t;
  };
  passTwigs(3, 4, "rgba(26,38,20,0.55)");
  const twigs = passTwigs(0, 0, twigCol);

  const leafCount = blackthorn ? 210 : 175;
  const leaves: Array<[number, number, number, number, number]> = [];
  for (let i = 0; i < leafCount; i++) {
    const tw = twigs[Math.floor(rng() * twigs.length)];
    const [px, py, ta] = twigPoint(tw, 0.2 + rng() * 0.8);
    const side = rng() < 0.5 ? 1 : -1;
    const ang = ta + side * (0.55 + rng() * 0.75) + (rng() - 0.5) * 0.4;
    const len = leafLen[0] + rng() * (leafLen[1] - leafLen[0]);
    const jx = px + (rng() - 0.5) * 5;
    const jy = py + (rng() - 0.5) * 5;
    // Keep tips inside the card so alpha-test edges never cut a leaf
    const tx = jx + Math.cos(ang) * len;
    const ty = jy + Math.sin(ang) * len;
    if (tx < ox + 4 || tx > ox + w - 4 || ty < 4 || ty > h - 4) continue;
    leaves.push([jx, jy, len, ang, rng()]);
  }
  for (const [x, y, len, ang] of leaves) {
    drawLeaf(ctx, x + 3, y + 4, len, ang, style, "rgba(26,40,20,0.5)", null);
  }
  for (const [x, y, len, ang, k] of leaves) {
    const c = palette[Math.floor(k * palette.length)];
    const shade = 0.82 + rng() * 0.4;
    const fill = rgba(c[0] * shade, c[1] * shade, c[2] * shade, 0.96);
    const rib = rgba(
      c[0] * shade + 40,
      c[1] * shade + 44,
      c[2] * shade + 26,
      0.55,
    );
    drawLeaf(ctx, x, y, len, ang, style, fill, rib);
  }
  // Fruit: sparse red haws in twos and threes on the hawthorn, a couple of
  // bloomed sloes on the blackthorn.
  const clusters = blackthorn ? 3 : 7;
  for (let c = 0; c < clusters; c++) {
    const tw = twigs[Math.floor(rng() * twigs.length)];
    const [px, py] = twigPoint(tw, 0.7 + rng() * 0.3);
    const n = blackthorn
      ? 1 + Math.floor(rng() * 2)
      : 2 + Math.floor(rng() * 3);
    for (let k = 0; k < n; k++) {
      const bx = px + (rng() - 0.5) * 9;
      const by = py + (rng() - 0.5) * 9;
      const r = blackthorn ? 3 + rng() * 1.2 : 2.6 + rng() * 1.3;
      if (bx < ox + 6 || bx > ox + w - 6 || by < 6 || by > h - 6) continue;
      ctx.beginPath();
      ctx.arc(bx, by, r, 0, Math.PI * 2);
      ctx.fillStyle = blackthorn ? "rgb(36,34,58)" : "rgb(148,26,22)";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(bx - r * 0.3, by - r * 0.35, r * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = blackthorn
        ? "rgba(150,160,190,0.5)"
        : "rgba(255,150,140,0.55)";
      ctx.fill();
    }
  }
}

/**
 * Foliage-card atlas of the hedgebank scrub (512×256, alpha for alphaTest):
 * left half hawthorn – deeply lobed small leaves on thorny grey-brown twigs
 * with sparse red haws; right half blackthorn – smaller dark oval leaves on
 * black thorny twigs with a bloomed sloe or two. Sprigs grow upward from low
 * origins, so cards are placed roughly upright.
 */
export function hedgeCardAtlas(hi = true): THREE.Texture {
  return cachedTex(`lane-hedge-atlas:${hi ? 512 : 256}`, () => {
    const W = sheet(hi, 512);
    const H = sheet(hi, 256);
    const [, ctx] = makeCanvas(W, H);
    ctx.clearRect(0, 0, W, H);
    // Drawn in 512×256 space whatever the sheet size
    ctx.scale(W / 512, H / 256);
    drawScrubCard(ctx, mulberry32(0x4a3e7d), 0, 256, 256, false);
    drawScrubCard(ctx, mulberry32(0x7e11c2), 256, 256, 256, true);
    // Interior occlusion (inside the drawn alpha only)
    ctx.globalCompositeOperation = "source-atop";
    for (const ox of [0, 256]) {
      const g = ctx.createRadialGradient(ox + 128, 184, 10, ox + 128, 184, 170);
      g.addColorStop(0, "rgba(10,16,8,0.2)");
      g.addColorStop(1, "rgba(10,16,8,0)");
      ctx.fillStyle = g;
      ctx.fillRect(ox, 0, 256, 256);
    }
    ctx.globalCompositeOperation = "source-over";
    return atlasTexture(ctx, W, H, [60, 92, 44]);
  });
}

/**
 * Alpha-tested card atlas from a canvas. Canvas 2D stores premultiplied
 * pixels, so every fully transparent texel is black – and the GPU averages
 * that black into the mip chain, which turns foliage cards into silhouettes
 * at distance. The pixels are pulled out, transparent texels are filled with
 * a foliage colour (alpha stays 0) and the result goes up as a DataTexture,
 * flipped like a CanvasTexture so the drawing coordinates keep their meaning.
 */
function atlasTexture(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  fill: Rgb,
): THREE.Texture {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 10) {
      d[i] = fill[0];
      d[i + 1] = fill[1];
      d[i + 2] = fill[2];
      d[i + 3] = 0;
    }
  }
  const tex = new THREE.DataTexture(
    new Uint8Array(d.buffer),
    w,
    h,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  tex.flipY = true;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Herb card atlas – cow parsley (left) and nettle (right)
// ---------------------------------------------------------------------------

function drawCowParsley(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  ox: number,
  w: number,
  h: number,
): void {
  ctx.lineCap = "round";
  const stems = [
    [0.3, 0.2],
    [0.5, 0.1],
    [0.68, 0.24],
  ];
  const umbels: Array<[number, number, number]> = [];
  for (const [fx, top] of stems) {
    const x0 = ox + fx * w;
    const x1 = x0 + (rng() - 0.5) * 30;
    const y1 = h * (top + rng() * 0.08);
    const mx = (x0 + x1) / 2 + (rng() - 0.5) * 24;
    // Hollow ridged stem: darker outline then a lighter core
    for (const [col, lw] of [
      ["rgba(60,86,40,0.9)", 4],
      ["rgb(132,164,92)", 2.2],
    ] as const) {
      ctx.strokeStyle = col;
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(x0, h);
      ctx.quadraticCurveTo(mx, h * 0.55, x1, y1);
      ctx.stroke();
    }
    umbels.push([x1, y1, 1]);
    // Side umbels on shorter stalks from the upper stem
    const nSide = 1 + Math.floor(rng() * 2);
    for (let k = 0; k < nSide; k++) {
      const t = 0.55 + rng() * 0.3;
      const u = 1 - t;
      const sx = u * u * x0 + 2 * u * t * mx + t * t * x1;
      const sy = u * u * h + 2 * u * t * h * 0.55 + t * t * y1;
      const dir = rng() < 0.5 ? -1 : 1;
      const ex = sx + dir * (16 + rng() * 22);
      const ey = sy - (14 + rng() * 22);
      ctx.strokeStyle = "rgb(122,152,86)";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo((sx + ex) / 2 + dir * 4, sy - 8, ex, ey);
      ctx.stroke();
      umbels.push([ex, ey, 0.7]);
    }
    // Feathery pinnate leaves along the lower two thirds
    const nLeaf = 3 + Math.floor(rng() * 2);
    for (let k = 0; k < nLeaf; k++) {
      const t = 0.1 + rng() * 0.55;
      const u = 1 - t;
      const lx = u * u * x0 + 2 * u * t * mx + t * t * x1;
      const ly = u * u * h + 2 * u * t * h * 0.55 + t * t * y1;
      const dir = k % 2 === 0 ? -1 : 1;
      const ang = -Math.PI * 0.5 + dir * (0.95 + rng() * 0.5);
      const len = 22 + rng() * 16;
      const ex = lx + Math.cos(ang) * len;
      const ey = ly + Math.sin(ang) * len;
      ctx.strokeStyle = "rgb(78,116,54)";
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      // Leaflets: short paired dabs, shrinking to the tip
      const pairs = 5 + Math.floor(rng() * 3);
      for (let p = 1; p <= pairs; p++) {
        const s = p / (pairs + 1);
        const px = lx + Math.cos(ang) * len * s;
        const py = ly + Math.sin(ang) * len * s;
        const ll = (7 - s * 4) * (0.8 + rng() * 0.4);
        for (const side of [-1, 1]) {
          const la = ang + side * 1.1;
          ctx.strokeStyle = rgba(86 + rng() * 20, 128 + rng() * 20, 60, 0.95);
          ctx.lineWidth = 2.1;
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(px + Math.cos(la) * ll, py + Math.sin(la) * ll);
          ctx.stroke();
        }
      }
    }
  }
  // Umbels: rays from a point fanning upward, each ending in a floret cluster
  for (const [ux, uy, scale] of umbels) {
    const rays = 9 + Math.floor(rng() * 5);
    for (let r = 0; r < rays; r++) {
      const a = -Math.PI * 0.5 + ((r / (rays - 1)) * 2 - 1) * 1.15;
      const len = (13 + rng() * 9) * scale;
      const ex = ux + Math.cos(a) * len;
      const ey = uy + Math.sin(a) * len * 0.75;
      ctx.strokeStyle = "rgb(150,176,116)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ux, uy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      const n = 4 + Math.floor(rng() * 4);
      for (let f = 0; f < n; f++) {
        const fx = ex + (rng() - 0.5) * 7 * scale;
        const fy = ey + (rng() - 0.5) * 5 * scale;
        if (fx < ox + 3 || fx > ox + w - 3 || fy < 3) continue;
        const k = 0.86 + rng() * 0.14;
        ctx.fillStyle = rgba(244 * k, 242 * k, 226 * k, 0.96);
        ctx.beginPath();
        ctx.arc(fx, fy, (1.5 + rng() * 0.8) * scale, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function drawNettle(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  ox: number,
  w: number,
  h: number,
): void {
  ctx.lineCap = "round";
  const stems = [
    [0.36, 0.14],
    [0.54, 0.08],
    [0.7, 0.2],
  ];
  for (const [fx, top] of stems) {
    const x0 = ox + fx * w;
    const x1 = x0 + (rng() - 0.5) * 14;
    const y1 = h * (top + rng() * 0.06);
    // Square stem – straight, reddish at the base
    const grad = ctx.createLinearGradient(0, h, 0, y1);
    grad.addColorStop(0, "rgb(104,70,58)");
    grad.addColorStop(0.35, "rgb(72,96,52)");
    grad.addColorStop(1, "rgb(96,124,68)");
    ctx.strokeStyle = grad;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x0, h);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    // Opposite leaf pairs, each pair turned 90° – on a card one pair reads
    // as a wide V, the next as a narrow one
    const pairs = 5 + Math.floor(rng() * 2);
    for (let p = 0; p < pairs; p++) {
      const t = 0.12 + (p / pairs) * 0.8;
      const px = x0 + (x1 - x0) * t;
      const py = h + (y1 - h) * t;
      const narrow = p % 2 === 1;
      const len = (20 - p * 1.6) * (0.85 + rng() * 0.3);
      for (const side of [-1, 1]) {
        const ang =
          -Math.PI * 0.5 +
          side * (narrow ? 0.55 : 1.25) +
          (rng() - 0.5) * 0.3 +
          0.25 * side * (p / pairs);
        const shade = 0.85 + rng() * 0.3;
        drawLeaf(
          ctx,
          px,
          py,
          len,
          ang,
          NETTLE_LEAF,
          rgba(52 * shade, 86 * shade, 44 * shade, 0.96),
          rgba(110, 146, 88, 0.6),
        );
      }
      // Drooping flower strings from the upper axils
      if (p >= 3 && rng() < 0.8) {
        for (const side of [-1, 1]) {
          ctx.strokeStyle = "rgba(168,178,140,0.9)";
          ctx.lineWidth = 1.2;
          ctx.setLineDash([1.5, 2]);
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.quadraticCurveTo(
            px + side * 10,
            py + 2,
            px + side * (12 + rng() * 6),
            py + 14 + rng() * 8,
          );
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }
  }
  // Sanity clamp: nothing drawn beyond the card; alpha-tested cards must not
  // end in hard edges
  ctx.clearRect(ox, 0, 3, h);
  ctx.clearRect(ox + w - 3, 0, 3, h);
}

/**
 * Herb atlas of the lane foot (512×256, alpha): left half cow parsley – tall
 * ridged stems, feathery pinnate leaves and flat white umbels; right half
 * stinging nettle – square stems with opposite serrated leaves and drooping
 * flower strings. Both grow up from the bottom edge (rooted cards).
 */
export function herbCardAtlas(hi = true): THREE.Texture {
  return cachedTex(`lane-herb-atlas:${hi ? 512 : 256}`, () => {
    const W = sheet(hi, 512);
    const H = sheet(hi, 256);
    const [, ctx] = makeCanvas(W, H);
    ctx.clearRect(0, 0, W, H);
    ctx.scale(W / 512, H / 256);
    drawCowParsley(ctx, mulberry32(0x5c0f1e), 0, 256, 256);
    drawNettle(ctx, mulberry32(0x9d21b4), 256, 256, 256);
    return atlasTexture(ctx, W, H, [98, 132, 66]);
  });
}

// ---------------------------------------------------------------------------
// Granite and painted timber
// ---------------------------------------------------------------------------

/**
 * Weathered grey granite for the gateposts, kerbs and the stile: mineral
 * speckle (quartz, dark mica, a little pink feldspar), grey-green crustose
 * lichen and small orange lichen rosettes, a few pits. Tileable at 1 m,
 * 512², map + normal + roughness.
 */
export function pbrGranite(hi = true): PbrMaps {
  const S = sheet(hi, 512);
  return cachedPbr(cacheKey("lane-granite", [S]), () => {
    const k = S / 512;
    const BASE: Rgb = rgb("#9c9992");
    const buf = new TexBuf(S, S, BASE, 0.78, 0);
    const nFine = noiseField(S, S, 811, { freq: 150, oct: 2 });
    const nMid = noiseField(S, S, 812, { freq: 10, oct: 3 });
    const nLich = noiseField(S, S, 813, { freq: 9, oct: 3, gain: 0.5 });
    const nLich2 = noiseField(S, S, 814, { freq: 14, oct: 2 });
    const nWeather = noiseField(S, S, 815, { freq: 2, oct: 3 });
    const pits = noiseField(S, S, 816, { freq: 3, oct: 2 });
    for (let p = 0; p < 14; p++) {
      const cx = (((p * 97) % 512) + (p % 3) * 40) * k;
      const cy = (((p * 151) % 512) + (p % 2) * 60) * k;
      stampBlob(
        pits,
        S,
        S,
        cx,
        cy,
        (6 + (p % 4) * 3) * k,
        (5 + (p % 3) * 3) * k,
        -0.9,
      );
    }
    const MICA: Rgb = rgb("#2e2f33");
    const QUARTZ: Rgb = rgb("#c9c6bf");
    const FELDSPAR: Rgb = rgb("#b09a90");
    const LICHEN: Rgb = rgb("#9aa27c");
    const LICHEN_DARK: Rgb = rgb("#5f6a4a");
    const ORANGE: Rgb = rgb("#d59a2c");
    const DAMP: Rgb = rgb("#5c5b57");
    buf.each((i) => {
      const f = nFine[i];
      const nm = nMid[i];
      const we = nWeather[i];
      mr = BASE[0];
      mg = BASE[1];
      mb = BASE[2];
      // Fine, low-contrast mineral speckle – a granite reads as one grey
      // stone with grain, never as blotches
      mixInto(QUARTZ, sstep(0.62, 0.9, f) * 0.35);
      mixInto(MICA, sstep(0.08, 0.2, 1 - f) * 0.4 * (nm > 0.4 ? 1 : 0.5));
      mixInto(FELDSPAR, sstep(0.58, 0.72, nm) * (1 - f) * 0.25);
      const tone = 0.96 + nm * 0.08;
      mr *= tone;
      mg *= tone;
      mb *= tone;
      // Weathered/damp mottling
      mixInto(DAMP, sstep(0.55, 0.85, we) * 0.1);
      let hgt = (f - 0.5) * 0.18 + (nm - 0.5) * 0.12;
      let ro = 0.74 + (0.5 - f) * 0.12 + sstep(0.58, 0.8, we) * 0.08;
      // Crustose lichen: flat grey-green plates with a darker rim
      const l = nLich[i];
      const plate = sstep(0.74, 0.79, l);
      const rim = sstep(0.7, 0.74, l) * (1 - plate);
      mixInto(LICHEN, plate * 0.5);
      mixInto(LICHEN_DARK, rim * 0.3);
      hgt += plate * 0.06;
      ro += plate * 0.14;
      // Small orange rosettes
      const o = sstep(0.86, 0.9, nLich2[i]) * (1 - plate * 0.5);
      mixInto(ORANGE, o * 0.6);
      hgt += o * 0.04;
      const pit = sstep(0.05, 0.4, -pits[i] + 0.4);
      const pk = 1 - pit * 0.25;
      buf.r[i] = mr * pk;
      buf.g[i] = mg * pk;
      buf.b[i] = mb * pk;
      buf.hf[i] = hgt - pit * 0.4;
      buf.rough[i] = ro;
    });
    return buf.build({ normal: 3.2 * k, normalScale: 0.8 });
  });
}

/**
 * Lane steel: old galvanised tube gone to dark oxide, rust blooming in broad
 * muted patches (mask at 2 cells per tile, so no repeat reads along a 4 m
 * bar) with fine pitting and streaks running down the tube. Desaturated on
 * purpose – the grid and gate should read as weathered iron, not fresh
 * orange. Tileable, 512², map + normal + roughness + metalness.
 */
export function pbrLaneSteel(hi = true): PbrMaps {
  const S = sheet(hi, 512);
  return cachedPbr(cacheKey("lane-steel", [S]), () => {
    const BASE: Rgb = rgb("#34363a");
    const buf = new TexBuf(S, S, BASE, 0.62, 0.6);
    const nMask = noiseField(S, S, 831, { freq: 2, oct: 4, gain: 0.55 });
    const nMask2 = noiseField(S, S, 832, { freq: 5, oct: 3 });
    const nPit = noiseField(S, S, 833, { freq: 60, oct: 2 });
    const nFine = noiseField(S, S, 834, { freq: 24, oct: 3 });
    const nStreak = noiseField(S, S, 835, { freq: 16, freqY: 2, oct: 3 });
    const RUST: Rgb = rgb("#6b4a36");
    const RUST_DARK: Rgb = rgb("#4a3328");
    const RUST_LIGHT: Rgb = rgb("#86664a");
    const GALV: Rgb = rgb("#5e6266");
    const rc: Rgb = [0, 0, 0];
    buf.each((i) => {
      const fine = nFine[i];
      const np = nPit[i];
      const m = sstep(0.5, 0.68, nMask[i] * 0.7 + nMask2[i] * 0.3);
      const pit = sstep(0.78, 0.9, np);
      // Rust colour of this texel: dark → mid by the fine noise, lightened
      // where the surface is pitted
      const lk = sstep(0.6, 0.9, np) * 0.5;
      rc[0] = RUST_DARK[0] + (RUST[0] - RUST_DARK[0]) * fine;
      rc[1] = RUST_DARK[1] + (RUST[1] - RUST_DARK[1]) * fine;
      rc[2] = RUST_DARK[2] + (RUST[2] - RUST_DARK[2]) * fine;
      rc[0] += (RUST_LIGHT[0] - rc[0]) * lk;
      rc[1] += (RUST_LIGHT[1] - rc[1]) * lk;
      rc[2] += (RUST_LIGHT[2] - rc[2]) * lk;
      mr = BASE[0];
      mg = BASE[1];
      mb = BASE[2];
      // Remnants of the galvanising as a slightly lighter grey
      mixInto(GALV, sstep(0.55, 0.85, fine) * 0.35);
      mixInto(rc, m);
      mixInto(RUST_DARK, pit * 0.7);
      const streak = sstep(0.68, 0.85, nStreak[i]) * (1 - m) * 0.4;
      mixInto(RUST, streak);
      buf.r[i] = mr;
      buf.g[i] = mg;
      buf.b[i] = mb;
      buf.hf[i] = (fine - 0.5) * 0.04 + m * fine * 0.12 - pit * 0.35;
      buf.rough[i] = mix(0.58, 0.9, m) + pit * 0.08 + streak * 0.15;
      buf.metal[i] = clamp01(mix(0.55, 0.08, m) - streak * 0.3);
    });
    return buf.build({ normal: (4 * S) / 512, normalScale: 0.8, metal: true });
  });
}

/**
 * Fingerpost timber: silvered oak grain along u with white paint that has
 * flaked back to bare wood over half the surface; the paint stands a little
 * proud, its edges ragged and grimy. Tileable, 512², map + normal + roughness.
 */
export function pbrPaintedTimber(hi = true): PbrMaps {
  const S = sheet(hi, 512);
  return cachedPbr(cacheKey("lane-painted-timber", [S]), () => {
    const buf = new TexBuf(S, S, rgb("#7f7568"), 0.82, 0);
    const nGr = noiseField(S, S, 821, {
      freq: 2,
      freqY: 28,
      oct: 4,
      gain: 0.55,
    });
    const nCr = noiseField(S, S, 822, {
      freq: 2,
      freqY: 44,
      oct: 3,
      mode: "ridged",
    });
    const nPaint = noiseField(S, S, 823, { freq: 3, oct: 4, gain: 0.55 });
    const nPaint2 = noiseField(S, S, 824, { freq: 9, oct: 3 });
    const nGrime = noiseField(S, S, 825, { freq: 5, oct: 3 });
    const nVar = noiseField(S, S, 826, { freq: 3, oct: 2 });
    const DARK: Rgb = rgb("#4f4437");
    const LIGHT: Rgb = rgb("#a39a8b");
    const PAINT: Rgb = rgb("#d9d5cb");
    const PAINT_OLD: Rgb = rgb("#b9b3a4");
    const GRIME: Rgb = rgb("#5a564d");
    const pcol: Rgb = [0, 0, 0];
    buf.each((i, _u, v) => {
      const grain = nGr[i];
      const crack = sstep(0.84, 0.97, nCr[i]);
      const grime = sstep(0.55, 0.85, nGrime[i]);
      const dk = 1 - crack * 0.55;
      mr = (DARK[0] + (LIGHT[0] - DARK[0]) * grain) * dk;
      mg = (DARK[1] + (LIGHT[1] - DARK[1]) * grain) * dk;
      mb = (DARK[2] + (LIGHT[2] - DARK[2]) * grain) * dk;
      let hgt = grain * 0.12 - crack * 0.35;
      let ro = 0.84 + grain * 0.06;
      // Paint coverage: large islands with ragged noisy edges, more lost
      // along the grain cracks and near the edges of the face
      const edge = 1 - sstep(0, 0.1, Math.min(v, 1 - v));
      const cover =
        nPaint[i] * 0.72 + nPaint2[i] * 0.28 - crack * 0.25 - edge * 0.12;
      const paint = sstep(0.47, 0.52, cover);
      const flakeRim = sstep(0.43, 0.47, cover) * (1 - paint);
      const age = sstep(0.4, 0.7, nVar[i]);
      const gk = grime * 0.4 + crack * 0.3;
      pcol[0] = PAINT[0] + (PAINT_OLD[0] - PAINT[0]) * age;
      pcol[1] = PAINT[1] + (PAINT_OLD[1] - PAINT[1]) * age;
      pcol[2] = PAINT[2] + (PAINT_OLD[2] - PAINT[2]) * age;
      pcol[0] += (GRIME[0] - pcol[0]) * gk;
      pcol[1] += (GRIME[1] - pcol[1]) * gk;
      pcol[2] += (GRIME[2] - pcol[2]) * gk;
      mixInto(pcol, paint);
      // Bare wood right beside a flake edge is darker (the old primer)
      mixInto(DARK, flakeRim * 0.4);
      hgt += paint * 0.07;
      ro = ro * (1 - paint) + (0.58 + grime * 0.2) * paint;
      buf.r[i] = mr;
      buf.g[i] = mg;
      buf.b[i] = mb;
      buf.hf[i] = hgt;
      buf.rough[i] = ro;
    });
    return buf.build({ normal: (4.5 * S) / 512, normalScale: 0.9 });
  });
}

// ---------------------------------------------------------------------------
// Decal atlas – warning sign, plate and grid pit
// ---------------------------------------------------------------------------

/** UV rectangles of the decal atlas (u right, v up) for the geometry builder. */
export const LANE_DECALS = {
  /** Warning triangle, square region (alpha outside the triangle). */
  sign: { u0: 0, v0: 0.5, u1: 0.5, v1: 1 },
  /** "CATTLE GRID" supplementary plate, 2:1. */
  plate: { u0: 0.5, v0: 0.75, u1: 1, v1: 1 },
  /** Dark pit under the grid bars, 2:1. */
  pit: { u0: 0, v0: 0, u1: 1, v1: 0.5 },
  /**
   * Wheel ruts + grass median of the lane track: u across 3.6 m, v along
   * 4 m, drawn so consecutive ribbon segments join without a seam.
   */
  track: { u0: 0.5, v0: 0.5, u1: 1, v1: 0.75 },
} as const;

function fadeNoiseLayer(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  x: number,
  y: number,
  w: number,
  h: number,
  count: number,
  alpha: number,
): void {
  // Bleached patches and grime blotches over a sign face
  for (let k = 0; k < count; k++) {
    const bx = x + rng() * w;
    const by = y + rng() * h;
    const r = 8 + rng() * 26;
    const g = ctx.createRadialGradient(bx, by, 0, bx, by, r);
    const light = rng() < 0.6;
    const c = light ? "235,232,222" : "70,62,52";
    g.addColorStop(0, `rgba(${c},${alpha * (light ? 1 : 0.55)})`);
    g.addColorStop(1, `rgba(${c},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(bx - r, by - r, r * 2, r * 2);
  }
}

function rustStreaks(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  x: number,
  y: number,
  w: number,
  h: number,
  count: number,
): void {
  ctx.lineCap = "round";
  for (let k = 0; k < count; k++) {
    const sx = x + rng() * w;
    const sy = y + rng() * h * 0.5;
    const len = h * (0.15 + rng() * 0.45);
    ctx.strokeStyle = `rgba(122,66,30,${0.18 + rng() * 0.3})`;
    ctx.lineWidth = 1.5 + rng() * 3;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(
      sx + (rng() - 0.5) * 6,
      sy + len * 0.5,
      sx + (rng() - 0.5) * 4,
      sy + len,
    );
    ctx.stroke();
  }
}

/**
 * Decal atlas (512², alpha): top-left the faded red-bordered warning
 * triangle with the cattle-grid pictogram, top-right the sun-bleached
 * "CATTLE GRID" plate, bottom half the dark silted pit with leaf litter and
 * rust flakes that shows between the grid bars.
 */
export function laneDecalAtlas(hi = true): THREE.Texture {
  const S = sheet(hi, 512);
  return cachedTex(`lane-decal-atlas:${S}`, () => {
    const rng = mulberry32(0x6b1d2f);
    const [c, ctx] = makeCanvas(S, S);
    ctx.clearRect(0, 0, S, S);
    // Vector parts are drawn in 512² space; the pit's pixel loop and its
    // putImageData (which ignores the transform) use the real sheet size
    ctx.scale(S / 512, S / 512);

    // ---- Warning triangle (0..256, 0..256), apex up ----
    {
      const cx = 128;
      const top = 18;
      const bottom = 236;
      const half = 116;
      const tri = (inset: number): void => {
        const k = inset * 1.9;
        ctx.beginPath();
        ctx.moveTo(cx, top + k * 1.15);
        ctx.lineTo(cx + half - k, bottom - inset);
        ctx.lineTo(cx - half + k, bottom - inset);
        ctx.closePath();
      };
      ctx.lineJoin = "round";
      // Red border, faded toward salmon
      tri(0);
      ctx.fillStyle = "rgb(178,72,60)";
      ctx.fill();
      ctx.lineWidth = 14;
      ctx.strokeStyle = "rgb(178,72,60)";
      ctx.stroke();
      // White face
      tri(24);
      ctx.fillStyle = "rgb(226,222,210)";
      ctx.fill();
      // Pictogram: cattle grid – a bar frame with five rails
      ctx.fillStyle = "rgb(24,24,26)";
      const gx = cx - 50;
      const gy = 118;
      const gw = 100;
      const gh = 76;
      ctx.fillRect(gx, gy, gw, 6);
      ctx.fillRect(gx, gy + gh - 6, gw, 6);
      ctx.fillRect(gx, gy, 6, gh);
      ctx.fillRect(gx + gw - 6, gy, 6, gh);
      for (let r = 1; r <= 4; r++) {
        ctx.fillRect(gx + 6, gy + (gh * r) / 5 - 2.5, gw - 12, 5);
      }
      // Weathering
      ctx.save();
      tri(0);
      ctx.clip();
      fadeNoiseLayer(ctx, rng, 0, 0, 256, 256, 26, 0.35);
      rustStreaks(ctx, rng, 20, 30, 216, 210, 9);
      // A dent: soft shadow crescent
      const dg = ctx.createRadialGradient(170, 150, 4, 170, 150, 34);
      dg.addColorStop(0, "rgba(40,36,30,0.28)");
      dg.addColorStop(0.6, "rgba(40,36,30,0.1)");
      dg.addColorStop(1, "rgba(40,36,30,0)");
      ctx.fillStyle = dg;
      ctx.fillRect(130, 110, 90, 90);
      ctx.restore();
    }

    // ---- Plate "CATTLE GRID" (256..512, 0..128) ----
    {
      const x = 262;
      const y = 8;
      const w = 244;
      const h = 112;
      ctx.fillStyle = "rgb(222,218,206)";
      ctx.fillRect(x, y, w, h);
      ctx.lineWidth = 6;
      ctx.strokeStyle = "rgb(28,28,30)";
      ctx.strokeRect(x + 3, y + 3, w - 6, h - 6);
      ctx.fillStyle = "rgb(30,30,32)";
      ctx.font = "bold 46px 'Arial Narrow', Arial, Helvetica, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("CATTLE GRID", x + w / 2, y + h / 2 + 3, w - 30);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      fadeNoiseLayer(ctx, rng, x, y, w, h, 16, 0.4);
      rustStreaks(ctx, rng, x + 8, y, w - 16, h, 6);
      // Peeled corner: bare grey metal
      ctx.fillStyle = "rgb(128,124,118)";
      ctx.beginPath();
      ctx.moveTo(x + w, y + h - 34);
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x + w - 40, y + h);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // ---- Pit (0..512, 256..512) ----
    {
      const y0 = 256;
      const PH = S >> 1;
      const img = ctx.createImageData(S, PH);
      const d = img.data;
      const prng = mulberry32(0x44c1);
      for (let yy = 0; yy < PH; yy++) {
        const v = yy / PH;
        for (let xx = 0; xx < S; xx++) {
          const u = xx / S;
          const n1 = tileFbm(u, v, 3, 3, 61);
          const n2 = tileFbm(u, v, 14, 3, 62);
          const wet = sstep(0.55, 0.8, tileFbm(u, v, 2, 2, 63));
          let r = 42 + (n1 - 0.5) * 30 + (n2 - 0.5) * 22;
          let g = 36 + (n1 - 0.5) * 24 + (n2 - 0.5) * 18;
          let b = 28 + (n1 - 0.5) * 18 + (n2 - 0.5) * 14;
          // Standing water: darker, bluer
          r -= wet * 14;
          g -= wet * 10;
          b -= wet * 2;
          const grain = (prng() - 0.5) * 10;
          const i = (yy * S + xx) * 4;
          d[i] = clamp(r + grain, 0, 255);
          d[i + 1] = clamp(g + grain, 0, 255);
          d[i + 2] = clamp(b + grain, 0, 255);
          d[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, PH);
      // Leaf litter and rust flakes
      for (let k = 0; k < 90; k++) {
        const lx = 6 + rng() * 500;
        const ly = y0 + 6 + rng() * 244;
        const len = 5 + rng() * 7;
        const brown = rng();
        const fill = rgba(
          92 + brown * 50,
          62 + brown * 34,
          28 + brown * 14,
          0.85,
        );
        drawLeaf(
          ctx,
          lx,
          ly,
          len,
          rng() * Math.PI * 2,
          BLACKTHORN_LEAF,
          fill,
          null,
        );
      }
      for (let k = 0; k < 40; k++) {
        ctx.fillStyle = rgba(150 + rng() * 40, 70 + rng() * 30, 22, 0.7);
        ctx.beginPath();
        ctx.arc(rng() * 512, y0 + rng() * 256, 1 + rng() * 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ---- Lane track (256..512, 128..256): two wheel ruts of compacted damp
    // sand with faint tread, and a patchy grass median. The ruts run the full
    // height so the 4 m ribbon segments tile; tufts keep off the edges.
    {
      const x0 = 256;
      const y0 = 128;
      const w = 256;
      const h = 128;
      ctx.clearRect(x0, y0, w, h);
      for (const fx of [0.22, 0.78]) {
        const cx = x0 + fx * w;
        const g = ctx.createLinearGradient(cx - 16, 0, cx + 16, 0);
        g.addColorStop(0, "rgba(96,82,60,0)");
        g.addColorStop(0.35, "rgba(96,82,60,0.42)");
        g.addColorStop(0.65, "rgba(96,82,60,0.42)");
        g.addColorStop(1, "rgba(96,82,60,0)");
        ctx.fillStyle = g;
        ctx.fillRect(cx - 16, y0, 32, h);
        // Tread: short dashes, alternating sides of the rut
        ctx.fillStyle = "rgba(70,58,42,0.28)";
        for (let y = y0; y < y0 + h; y += 6) {
          const side = ((y - y0) / 6) % 2 === 0 ? -1 : 1;
          ctx.fillRect(cx + side * 5 - 4, y, 8, 2.5);
        }
      }
      for (let k = 0; k < 70; k++) {
        const median = rng() < 0.72;
        const tx = median
          ? x0 + w * (0.38 + rng() * 0.24)
          : x0 + w * (rng() < 0.5 ? 0.03 + rng() * 0.08 : 0.89 + rng() * 0.08);
        const ty = y0 + 8 + rng() * (h - 16);
        const n = 4 + Math.floor(rng() * 4);
        for (let b = 0; b < n; b++) {
          const a = -Math.PI / 2 + (rng() - 0.5) * 1.6;
          const len = 4 + rng() * 5;
          const g2 = 96 + rng() * 30;
          ctx.strokeStyle = rgba(g2 * 0.7, g2, g2 * 0.42, 0.85);
          ctx.lineWidth = 1.4;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(tx + Math.cos(a) * len, ty + Math.sin(a) * len);
          ctx.stroke();
        }
      }
    }

    return texFromCanvas(c, true, false, false);
  });
}
