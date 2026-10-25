// Core of the procedural PBR texture library: deterministic RNG, cache,
// tileable noise (grid value noise, periodic), pixel buffer with
// height/roughness/metalness channels, height field → normal map, applyPbr().
//
// Conventions:
// - All buffers are in canvas order (y downwards). The texture's UV coordinate
//   v points UPWARDS (CanvasTexture flipY): v = 1 - (y + 0.5) / h.
// - Albedo values are sRGB (0..1) as in the canvas; only the `map` gets
//   SRGBColorSpace. Normal/roughness/metalness stay linear.
// - Normal maps: OpenGL convention (green = +v).

import * as THREE from "three";
import { mulberry32 } from "./noise";

export const TEX_ANISOTROPY = 8;

/** One PBR texture set for MeshStandard-/MeshPhysicalMaterial. */
export interface PbrMaps {
  map: THREE.Texture;
  normalMap?: THREE.Texture;
  roughnessMap?: THREE.Texture;
  metalnessMap?: THREE.Texture;
  normalScale?: number;
  /** Scalar defaults; map values are multiplied by them (default 1 if a map exists). */
  roughness?: number;
  metalness?: number;
  /** Material hints for sets with alpha (net, bag, label). */
  alphaTest?: number;
  transparent?: boolean;
  doubleSide?: boolean;
}

// ---------------------------------------------------------------------------
// RNG & Hash
// ---------------------------------------------------------------------------

/** Seeded RNG (mulberry32) – every texture is identical on every load. */
export class TexRng {
  private readonly f: () => number;
  constructor(seed: number) {
    this.f = mulberry32(seed);
  }
  next(): number {
    return this.f();
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.f();
  }
  int(n: number): number {
    return Math.floor(this.f() * n);
  }
  chance(p: number): boolean {
    return this.f() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.f() * arr.length)];
  }
  /** Roughly normally distributed in [-1, 1]. */
  gauss(): number {
    return (this.f() + this.f() + this.f()) / 1.5 - 1;
  }
}

export function hashU32(a: number): number {
  let h = a | 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Deterministic hash (0..1) for grid points / pixels. */
export function hash01(x: number, y: number, seed: number): number {
  return (
    hashU32(
      (Math.imul(x, 73856093) ^
        Math.imul(y, 19349663) ^
        Math.imul(seed | 0, 83492791)) |
        0,
    ) / 4294967296
  );
}

/** Pixel hash over the linear index (grain, sparkle). */
export function hashPix(i: number, seed: number): number {
  return (
    hashU32((Math.imul(i, 0x9e3779b1) ^ Math.imul(seed | 0, 0x85ebca6b)) | 0) /
    4294967296
  );
}

// ---------------------------------------------------------------------------
// Cache + timing
// ---------------------------------------------------------------------------

const pbrCache = new Map<string, PbrMaps>();
const texCache = new Map<string, THREE.Texture>();
let genMs = 0;
let genCount = 0;

export function cacheKey(name: string, args: unknown[]): string {
  return `${name}:${JSON.stringify(args)}`;
}

export function cachedPbr(key: string, build: () => PbrMaps): PbrMaps {
  const hit = pbrCache.get(key);
  if (hit) return hit;
  const t0 = performance.now();
  const maps = build();
  genMs += performance.now() - t0;
  genCount++;
  pbrCache.set(key, maps);
  return maps;
}

export function cachedTex(
  key: string,
  build: () => THREE.Texture,
): THREE.Texture {
  const hit = texCache.get(key);
  if (hit) return hit;
  const t0 = performance.now();
  const tex = build();
  genMs += performance.now() - t0;
  genCount++;
  texCache.set(key, tex);
  return tex;
}

/** Stats for the dev harness: number of generated sets and total time in ms. */
export function textureStats(): {
  sets: number;
  textures: number;
  generated: number;
  genMs: number;
} {
  return {
    sets: pbrCache.size,
    textures: texCache.size,
    generated: genCount,
    genMs: Math.round(genMs * 10) / 10,
  };
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

export type Rgb = [number, number, number];

const rgbCache = new Map<string | number, Rgb>();

/**
 * "#rrggbb" | 0xrrggbb → sRGB 0..1 (without color space conversion). Parsed
 * once per literal – several texture painters call this inside their pixel
 * loops (millions of parses at boot). Returns a fresh array, so callers may
 * still mutate the result.
 */
export function rgb(hex: string | number): Rgb {
  let c = rgbCache.get(hex);
  if (!c) {
    const n =
      typeof hex === "number"
        ? hex
        : Number.parseInt(hex.replace("#", "").slice(0, 6), 16);
    c = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    rgbCache.set(hex, c);
  }
  return [c[0], c[1], c[2]];
}

export function lerp3(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function sstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ---------------------------------------------------------------------------
// Tileable noise
// ---------------------------------------------------------------------------

export interface NoiseOpts {
  /** Cells of the base octave across the width (default 4). */
  freq?: number;
  /** Cells across the height (default: freq * h / w). */
  freqY?: number;
  oct?: number;
  gain?: number;
  mode?: "fbm" | "ridged" | "billow";
  /** Stretch min/max to 0..1 (default true). */
  normalize?: boolean;
}

/**
 * Periodic value-noise FBM as a field (w×h, canvas order), seamlessly
 * tileable on both axes. Grid values are precomputed per octave – only
 * 4 lookups + interpolation per pixel.
 *
 * Smooth fields are the boot's single biggest cost (the place atlases ask
 * for a dozen full-size fields each), so a field whose finest octave still
 * spans ≥ 16 px per cell is generated at 1/2 or 1/4 resolution and upsampled
 * bilinearly – within those cells the noise is a smooth interpolant already,
 * so the result is visually the same at a fraction of the work. Fields with
 * fine detail (high `freq`, many octaves) take the full-resolution path.
 */
export function noiseField(
  w: number,
  h: number,
  seed: number,
  o: NoiseOpts = {},
): Float32Array {
  const oct = o.oct ?? 5;
  const gain = o.gain ?? 0.5;
  const modeId = o.mode === "ridged" ? 1 : o.mode === "billow" ? 2 : 0;
  const cx0 = Math.max(1, Math.round(o.freq ?? 4));
  const cy0 = Math.max(1, Math.round(o.freqY ?? (cx0 * h) / w));

  // Cells of the finest octave that will actually be added
  let cxLast = cx0;
  let cyLast = cy0;
  for (let k = 1; k < oct; k++) {
    if (cxLast * 2 > w || cyLast * 2 > h) break;
    cxLast *= 2;
    cyLast *= 2;
  }
  // Reduction factor: finest cells keep ≥ 4 px at the reduced size
  let r = 1;
  while (
    r < 4 &&
    w % (r * 2) === 0 &&
    h % (r * 2) === 0 &&
    w / (r * 2) >= cxLast * 4 &&
    h / (r * 2) >= cyLast * 4
  )
    r *= 2;

  const lw = w / r;
  const lh = h / r;
  const low = r === 1 ? new Float32Array(w * h) : new Float32Array(lw * lh);
  let cx = cx0;
  let cy = cy0;
  let amp = 1;
  for (let k = 0; k < oct; k++) {
    if (cx > lw || cy > lh) break;
    addOctave(low, lw, lh, cx, cy, seed * 31 + k * 977, amp, modeId);
    amp *= gain;
    cx *= 2;
    cy *= 2;
  }
  if (o.normalize !== false) normalizeField(low);
  if (r === 1) return low;
  return upsampleField(low, lw, lh, w, h);
}

/** Bilinear, tileable upsample of a canvas-order field (pixel centres aligned). */
function upsampleField(
  low: Float32Array,
  lw: number,
  lh: number,
  w: number,
  h: number,
): Float32Array {
  const out = new Float32Array(w * h);
  const xi0 = new Int32Array(w);
  const xi1 = new Int32Array(w);
  const tx = new Float32Array(w);
  const sx = lw / w;
  for (let x = 0; x < w; x++) {
    let fx = (x + 0.5) * sx - 0.5;
    if (fx < 0) fx += lw;
    const i0 = Math.floor(fx);
    xi0[x] = i0 % lw;
    xi1[x] = (i0 + 1) % lw;
    tx[x] = fx - i0;
  }
  const sy = lh / h;
  for (let y = 0; y < h; y++) {
    let fy = (y + 0.5) * sy - 0.5;
    if (fy < 0) fy += lh;
    const j0 = Math.floor(fy);
    const r0 = (j0 % lh) * lw;
    const r1 = ((j0 + 1) % lh) * lw;
    const ty = fy - j0;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const a = low[r0 + xi0[x]];
      const b = low[r0 + xi1[x]];
      const c = low[r1 + xi0[x]];
      const d = low[r1 + xi1[x]];
      const t = tx[x];
      const top = a + (b - a) * t;
      out[row + x] = top + (c + (d - c) * t - top) * ty;
    }
  }
  return out;
}

/** One octave of periodic value noise added into `out` (small, easily optimized loops). */
function addOctave(
  out: Float32Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  seed: number,
  amp: number,
  modeId: number,
): void {
  const lat = new Float32Array(cx * cy);
  for (let j = 0; j < cy; j++)
    for (let i = 0; i < cx; i++) lat[j * cx + i] = hash01(i, j, seed);
  const xi0 = new Int32Array(w);
  const xi1 = new Int32Array(w);
  const tx = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const fx = ((x + 0.5) / w) * cx;
    const i0 = Math.floor(fx);
    xi0[x] = i0 % cx;
    xi1[x] = (i0 + 1) % cx;
    const t = fx - i0;
    tx[x] = t * t * (3 - 2 * t);
  }
  for (let y = 0; y < h; y++) {
    const fy = ((y + 0.5) / h) * cy;
    const j0 = Math.floor(fy);
    const r0 = (j0 % cy) * cx;
    const r1 = ((j0 + 1) % cy) * cx;
    const t0 = fy - j0;
    const vt = t0 * t0 * (3 - 2 * t0);
    const row = y * w;
    if (modeId === 0) {
      for (let x = 0; x < w; x++) {
        const a = lat[r0 + xi0[x]];
        const b = lat[r0 + xi1[x]];
        const c = lat[r1 + xi0[x]];
        const d = lat[r1 + xi1[x]];
        const t = tx[x];
        const top = a + (b - a) * t;
        out[row + x] += (top + (c + (d - c) * t - top) * vt) * amp;
      }
    } else if (modeId === 1) {
      for (let x = 0; x < w; x++) {
        const a = lat[r0 + xi0[x]];
        const b = lat[r0 + xi1[x]];
        const c = lat[r1 + xi0[x]];
        const d = lat[r1 + xi1[x]];
        const t = tx[x];
        const top = a + (b - a) * t;
        const n = top + (c + (d - c) * t - top) * vt;
        out[row + x] += (1 - Math.abs(2 * n - 1)) * amp;
      }
    } else {
      for (let x = 0; x < w; x++) {
        const a = lat[r0 + xi0[x]];
        const b = lat[r0 + xi1[x]];
        const c = lat[r1 + xi0[x]];
        const d = lat[r1 + xi1[x]];
        const t = tx[x];
        const top = a + (b - a) * t;
        const n = top + (c + (d - c) * t - top) * vt;
        out[row + x] += Math.abs(2 * n - 1) * amp;
      }
    }
  }
}

export function normalizeField(f: Float32Array): Float32Array {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < f.length; i++) {
    if (f[i] < lo) lo = f[i];
    if (f[i] > hi) hi = f[i];
  }
  const k = hi > lo ? 1 / (hi - lo) : 1;
  for (let i = 0; i < f.length; i++) f[i] = (f[i] - lo) * k;
  return f;
}

/** Bilinear sampling with wrap; sx/sy in 0..1 (array order, y downwards). */
export function sampleF(
  f: Float32Array,
  w: number,
  h: number,
  sx: number,
  sy: number,
): number {
  const fx = (sx - Math.floor(sx)) * w;
  const fy = (sy - Math.floor(sy)) * h;
  const x0 = fx | 0;
  const y0 = fy | 0;
  const x1 = x0 + 1 < w ? x0 + 1 : 0;
  const y1 = y0 + 1 < h ? y0 + 1 : 0;
  const tx = fx - x0;
  const ty = fy - y0;
  const a = f[y0 * w + x0];
  const b = f[y0 * w + x1];
  const c = f[y1 * w + x0];
  const d = f[y1 * w + x1];
  const top = a + (b - a) * tx;
  return top + (c + (d - c) * tx - top) * ty;
}

/** Separable box blur (in place), wrap or clamp per axis. */
export function blurField(
  f: Float32Array,
  w: number,
  h: number,
  radius: number,
  wrapU = true,
  wrapV = true,
  passes = 2,
): Float32Array {
  const r = Math.max(1, Math.round(radius));
  const tmp = new Float32Array(w * h);
  const line = new Float32Array(Math.max(w, h) + 2 * r + 2);
  const norm = 1 / (2 * r + 1);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++)
      blurLine(f, tmp, y * w, 1, w, r, wrapU, line, norm);
    for (let x = 0; x < w; x++) blurLine(tmp, f, x, w, h, r, wrapV, line, norm);
  }
  return f;
}

/** Running-sum a single row/column with edge padding (wrap/clamp). */
function blurLine(
  src: Float32Array,
  dst: Float32Array,
  start: number,
  stride: number,
  n: number,
  r: number,
  wrap: boolean,
  line: Float32Array,
  norm: number,
): void {
  // line[k + r] = src[start + k*stride] for k in [-r, n + r]
  for (let k = 0; k < n; k++) line[k + r] = src[start + k * stride];
  for (let k = 1; k <= r + 1; k++) {
    line[r - k] = wrap ? line[r + n - k] : line[r];
    line[r + n - 1 + k] = wrap ? line[r + k - 1] : line[r + n - 1];
  }
  let sum = 0;
  for (let k = 0; k <= 2 * r; k++) sum += line[k];
  for (let k = 0; k < n; k++) {
    dst[start + k * stride] = sum * norm;
    sum += line[k + 2 * r + 1] - line[k];
  }
}

/**
 * Stamp soft blobs (Gaussian bells) additively into a field – dents,
 * paint chips, stains. `amp` may be negative.
 */
export function stampBlob(
  f: Float32Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  amp: number,
  wrap = true,
): void {
  const x0 = Math.floor(cx - rx * 1.6);
  const x1 = Math.ceil(cx + rx * 1.6);
  const y0 = Math.floor(cy - ry * 1.6);
  const y1 = Math.ceil(cy + ry * 1.6);
  for (let y = y0; y <= y1; y++) {
    const yy = wrap ? ((y % h) + h) % h : y;
    if (yy < 0 || yy >= h) continue;
    const dy = (y - cy) / ry;
    for (let x = x0; x <= x1; x++) {
      const xx = wrap ? ((x % w) + w) % w : x;
      if (xx < 0 || xx >= w) continue;
      const dx = (x - cx) / rx;
      const d2 = dx * dx + dy * dy;
      if (d2 > 2.6) continue;
      f[yy * w + xx] += amp * Math.exp(-d2 * 2.2);
    }
  }
}

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

export function makeCanvas(
  w: number,
  h: number,
): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D not available");
  return [c, ctx];
}

export function texFromCanvas(
  c: HTMLCanvasElement,
  srgb: boolean,
  wrapU = true,
  wrapV = true,
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = wrapU ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.wrapT = wrapV ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.anisotropy = TEX_ANISOTROPY;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Draws a vector layer (text, shapes) and returns RGBA pixels (y downwards). */
export function drawLayer(
  w: number,
  h: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
): Uint8ClampedArray {
  const [, ctx] = makeCanvas(w, h);
  ctx.clearRect(0, 0, w, h);
  draw(ctx);
  return ctx.getImageData(0, 0, w, h).data;
}

/** Greyscale field (0..1) → linearly encoded texture (roughness/metalness). */
export function grayToTexture(
  w: number,
  h: number,
  f: Float32Array,
  wrapU = true,
  wrapV = true,
): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(w, h);
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0, n = w * h; i < n; i++) {
    const v = f[i] < 0.02 ? 0.02 : f[i] > 0.98 ? 0.98 : f[i];
    const b = (v * 255 + 0.5) | 0;
    const j = i * 4;
    d[j] = b;
    d[j + 1] = b;
    d[j + 2] = b;
    d[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return texFromCanvas(c, false, wrapU, wrapV);
}

/**
 * Height field (canvas order, arbitrary units) → tangent-space normal map
 * (OpenGL, green = +v). `strength` scales the slope per pixel difference.
 * `wrap` as a boolean or [wrapU, wrapV].
 */
export function heightToNormal(
  height: Float32Array,
  size: number | [number, number],
  strength: number,
  wrap: boolean | [boolean, boolean] = true,
): THREE.Texture {
  const w = typeof size === "number" ? size : size[0];
  const h = typeof size === "number" ? size : size[1];
  const wu = typeof wrap === "boolean" ? wrap : wrap[0];
  const wv = typeof wrap === "boolean" ? wrap : wrap[1];
  const [c, ctx] = makeCanvas(w, h);
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const xl = new Int32Array(w);
  const xr = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    xl[x] = x > 0 ? x - 1 : wu ? w - 1 : 0;
    xr[x] = x < w - 1 ? x + 1 : wu ? 0 : w - 1;
  }
  for (let y = 0; y < h; y++) {
    const yu = (y > 0 ? y - 1 : wv ? h - 1 : 0) * w;
    const yd = (y < h - 1 ? y + 1 : wv ? 0 : h - 1) * w;
    const row = y * w;
    let j = row * 4;
    for (let x = 0; x < w; x++) {
      const nx = (height[row + xl[x]] - height[row + xr[x]]) * strength;
      // v points upwards (flipY): +v = smaller y
      const ny = (height[yd + x] - height[yu + x]) * strength;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      d[j] = (nx * inv * 0.5 + 0.5) * 255;
      d[j + 1] = (ny * inv * 0.5 + 0.5) * 255;
      d[j + 2] = (inv * 0.5 + 0.5) * 255;
      d[j + 3] = 255;
      j += 4;
    }
  }
  ctx.putImageData(img, 0, 0);
  return texFromCanvas(c, false, wu, wv);
}

// ---------------------------------------------------------------------------
// Pixel buffer
// ---------------------------------------------------------------------------

export interface BuildOpts {
  srgb?: boolean;
  wrapU?: boolean;
  wrapV?: boolean;
  /** Slope factor for heightToNormal; 0/undefined → no normal map. */
  normal?: number;
  normalScale?: number;
  rough?: boolean;
  metal?: boolean;
  alpha?: boolean;
  alphaTest?: number;
  transparent?: boolean;
  doubleSide?: boolean;
  roughness?: number;
  metalness?: number;
}

/**
 * Float buffer for albedo (sRGB 0..1), alpha, height, roughness and metalness
 * in canvas order. `each()` yields u (0..1 to the right) and v (0..1 UPWARDS).
 */
export class TexBuf {
  readonly n: number;
  readonly r: Float32Array;
  readonly g: Float32Array;
  readonly b: Float32Array;
  readonly a: Float32Array;
  readonly hf: Float32Array;
  readonly rough: Float32Array;
  readonly metal: Float32Array;

  constructor(
    readonly w: number,
    readonly h: number,
    fill: Rgb = [0.5, 0.5, 0.5],
    rough = 0.5,
    metal = 0,
  ) {
    this.n = w * h;
    this.r = new Float32Array(this.n).fill(fill[0]);
    this.g = new Float32Array(this.n).fill(fill[1]);
    this.b = new Float32Array(this.n).fill(fill[2]);
    this.a = new Float32Array(this.n).fill(1);
    this.hf = new Float32Array(this.n);
    this.rough = new Float32Array(this.n).fill(rough);
    this.metal = new Float32Array(this.n).fill(metal);
  }

  each(
    fn: (i: number, u: number, v: number, x: number, y: number) => void,
  ): void {
    const { w, h } = this;
    const iw = 1 / w;
    const ih = 1 / h;
    for (let y = 0; y < h; y++) {
      const v = 1 - (y + 0.5) * ih;
      const row = y * w;
      for (let x = 0; x < w; x++) fn(row + x, (x + 0.5) * iw, v, x, y);
    }
  }

  set(i: number, c: Rgb): void {
    this.r[i] = c[0];
    this.g[i] = c[1];
    this.b[i] = c[2];
  }

  /** Mix the albedo linearly towards the color. */
  mixTo(i: number, c: Rgb, t: number): void {
    this.r[i] += (c[0] - this.r[i]) * t;
    this.g[i] += (c[1] - this.g[i]) * t;
    this.b[i] += (c[2] - this.b[i]) * t;
  }

  mul(i: number, k: number): void {
    this.r[i] *= k;
    this.g[i] *= k;
    this.b[i] *= k;
  }

  /** Draw a vector layer at buffer size (RGBA, y downwards). */
  layer(draw: (ctx: CanvasRenderingContext2D) => void): Uint8ClampedArray {
    return drawLayer(this.w, this.h, draw);
  }

  /** Blend a layer into the albedo via its alpha (opacity as a factor). */
  blendLayer(layer: Uint8ClampedArray, opacity = 1): void {
    for (let i = 0; i < this.n; i++) {
      const j = i * 4;
      const t = (layer[j + 3] / 255) * opacity;
      if (t <= 0) continue;
      this.r[i] += (layer[j] / 255 - this.r[i]) * t;
      this.g[i] += (layer[j + 1] / 255 - this.g[i]) * t;
      this.b[i] += (layer[j + 2] / 255 - this.b[i]) * t;
    }
  }

  /** Alpha channel of a layer as a field (0..1). */
  static layerAlpha(layer: Uint8ClampedArray, n: number): Float32Array {
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = layer[i * 4 + 3] / 255;
    return f;
  }

  build(o: BuildOpts = {}): PbrMaps {
    const { w, h, n } = this;
    const wrapU = o.wrapU !== false;
    const wrapV = o.wrapV !== false;
    const [c, ctx] = makeCanvas(w, h);
    const img = ctx.createImageData(w, h);
    const d = img.data;
    const useA = o.alpha === true;
    for (let i = 0; i < n; i++) {
      const j = i * 4;
      d[j] = (clampAlbedo(this.r[i]) * 255 + 0.5) | 0;
      d[j + 1] = (clampAlbedo(this.g[i]) * 255 + 0.5) | 0;
      d[j + 2] = (clampAlbedo(this.b[i]) * 255 + 0.5) | 0;
      d[j + 3] = useA ? (clamp01(this.a[i]) * 255 + 0.5) | 0 : 255;
    }
    ctx.putImageData(img, 0, 0);
    const maps: PbrMaps = {
      map: texFromCanvas(c, o.srgb !== false, wrapU, wrapV),
    };
    if (o.normal && o.normal > 0) {
      maps.normalMap = heightToNormal(this.hf, [w, h], o.normal, [
        wrapU,
        wrapV,
      ]);
      maps.normalScale = o.normalScale ?? 1;
    }
    if (o.rough !== false) {
      maps.roughnessMap = grayToTexture(w, h, this.rough, wrapU, wrapV);
      maps.roughness = o.roughness ?? 1;
    }
    if (o.metal) {
      maps.metalnessMap = grayToTexture(w, h, this.metal, wrapU, wrapV);
      maps.metalness = o.metalness ?? 1;
    }
    if (o.alphaTest !== undefined) maps.alphaTest = o.alphaTest;
    if (o.transparent !== undefined) maps.transparent = o.transparent;
    if (o.doubleSide) maps.doubleSide = true;
    return maps;
  }
}

function clampAlbedo(v: number): number {
  // never pure black/white
  return v < 0.02 ? 0.02 : v > 0.97 ? 0.97 : v;
}

// ---------------------------------------------------------------------------
// applyPbr
// ---------------------------------------------------------------------------

/**
 * Apply maps to a material. `repeat` clones the (cached, shared) textures so
 * that different repeat settings do not affect each other (clones share the
 * GPU resource).
 */
export function applyPbr(
  mat: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial,
  maps: PbrMaps,
  repeat?: [number, number],
): void {
  const prep = (t?: THREE.Texture): THREE.Texture | null => {
    if (!t) return null;
    if (!repeat) return t;
    const c = t.clone();
    c.repeat.set(repeat[0], repeat[1]);
    return c;
  };
  mat.map = prep(maps.map);
  mat.normalMap = prep(maps.normalMap);
  mat.roughnessMap = prep(maps.roughnessMap);
  mat.metalnessMap = prep(maps.metalnessMap);
  if (maps.normalMap) {
    const s = maps.normalScale ?? 1;
    mat.normalScale.set(s, s);
  }
  if (maps.roughnessMap) mat.roughness = maps.roughness ?? 1;
  if (maps.metalnessMap) mat.metalness = maps.metalness ?? 1;
  if (maps.alphaTest !== undefined) mat.alphaTest = maps.alphaTest;
  if (maps.transparent !== undefined) mat.transparent = maps.transparent;
  if (maps.doubleSide) mat.side = THREE.DoubleSide;
  mat.needsUpdate = true;
}

/**
 * Remap the side faces of a BoxGeometry so that u runs once AROUND the box
 * (+z → +x → −z → −x, a quarter each), v stays bottom→top. Lid/bottom keep
 * their UVs. For canisters/cartons with "u around the body" textures.
 */
export function remapBoxUvAround(geo: THREE.BoxGeometry): THREE.BoxGeometry {
  const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
  const p = geo.parameters;
  const perFace = (p.widthSegments + 1) * (p.heightSegments + 1);
  // Order of the box faces: +x, -x, +y, -y, +z, -z
  const quarter: Record<number, number> = { 4: 0, 0: 1, 5: 2, 1: 3 };
  const faceVerts = [
    (p.depthSegments + 1) * (p.heightSegments + 1), // +x
    (p.depthSegments + 1) * (p.heightSegments + 1), // -x
    (p.widthSegments + 1) * (p.depthSegments + 1), // +y
    (p.widthSegments + 1) * (p.depthSegments + 1), // -y
    perFace, // +z
    perFace, // -z
  ];
  let start = 0;
  for (let f = 0; f < 6; f++) {
    const q = quarter[f];
    if (q !== undefined) {
      for (let i = start; i < start + faceVerts[f]; i++) {
        uv.setX(i, (q + uv.getX(i)) * 0.25);
      }
    }
    start += faceVerts[f];
  }
  uv.needsUpdate = true;
  return geo;
}

// ---------------------------------------------------------------------------
// Text/graphics helpers for labels
// ---------------------------------------------------------------------------

const SYL = [
  "the",
  "ter",
  "ing",
  "and",
  "con",
  "ver",
  "sta",
  "lin",
  "men",
  "dis",
  "por",
  "ral",
  "est",
  "tion",
  "ant",
  "ide",
  "mer",
  "cal",
  "tro",
  "son",
];

/** Invented words (pseudo-English) for body copy. */
export function fakeWords(rng: TexRng, count: number): string {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const syl = 1 + rng.int(3);
    let w = "";
    for (let k = 0; k < syl; k++) w += rng.pick(SYL);
    if (rng.chance(0.25)) w = w.charAt(0).toUpperCase() + w.slice(1);
    if (rng.chance(0.1)) w += ",";
    out.push(w);
  }
  return out.join(" ");
}

/** Several lines of invented body copy (justified look via line length). */
export function drawTextBlock(
  ctx: CanvasRenderingContext2D,
  rng: TexRng,
  x: number,
  y: number,
  width: number,
  lines: number,
  lineH: number,
  font: string,
  color: string,
): void {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  for (let l = 0; l < lines; l++) {
    let txt = fakeWords(rng, 14);
    const full = ctx.measureText(txt).width;
    if (full > width) {
      // shorten roughly proportionally, then measure again precisely
      txt = txt.slice(0, Math.max(4, Math.floor((txt.length * width) / full)));
      while (ctx.measureText(txt).width > width && txt.length > 4)
        txt = txt.slice(0, -1);
    }
    if (l === lines - 1 && rng.chance(0.7))
      txt = txt.slice(0, Math.ceil(txt.length * rng.range(0.3, 0.8)));
    ctx.fillText(txt, x, y + l * lineH);
  }
}

export function drawBarcode(
  ctx: CanvasRenderingContext2D,
  rng: TexRng,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  ctx.fillStyle = "#f2f0ea";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#1c1c1e";
  let px = x + w * 0.06;
  const end = x + w * 0.94;
  while (px < end) {
    const bw = Math.max(1, Math.round(rng.range(1, 4) * (w / 120)));
    ctx.fillRect(px, y + h * 0.1, bw, h * 0.66);
    px += bw + Math.round(rng.range(1, 3) * (w / 120));
  }
  ctx.font = `${Math.round(h * 0.16)}px monospace`;
  ctx.textAlign = "center";
  ctx.fillText("4 006381 333931", x + w / 2, y + h * 0.93);
}

/** Fine, slightly curved scratches as an alpha layer (white). */
export function drawScratches(
  ctx: CanvasRenderingContext2D,
  rng: TexRng,
  w: number,
  h: number,
  count: number,
  len: number,
  width: number,
  alpha: number,
  dir?: number,
): void {
  ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
  ctx.lineCap = "round";
  for (let k = 0; k < count; k++) {
    const x0 = rng.next() * w;
    const y0 = rng.next() * h;
    const ang =
      dir !== undefined ? dir + rng.gauss() * 0.25 : rng.next() * Math.PI;
    const L = len * rng.range(0.3, 1.3);
    const cxp = x0 + Math.cos(ang) * L * 0.5 + rng.gauss() * L * 0.12;
    const cyp = y0 + Math.sin(ang) * L * 0.5 + rng.gauss() * L * 0.12;
    ctx.lineWidth = width * rng.range(0.5, 1.4);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(
      cxp,
      cyp,
      x0 + Math.cos(ang) * L,
      y0 + Math.sin(ang) * L,
    );
    ctx.stroke();
  }
}
