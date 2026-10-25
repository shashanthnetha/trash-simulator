// Procedural canvas textures for dune grass, rocks and shells. Tileable
// (periodic value noise) and deterministic; deliberately independent of
// textures.ts so that vegetation.ts does not depend on changes made elsewhere.

import * as THREE from "three";
import { clamp, lerp, mulberry32, smoothstep } from "./noise";

/** Hash on a periodic lattice – the basis for tileable value noise. */
function tileHash(x: number, y: number, period: number, seed: number): number {
  const xi = ((x % period) + period) % period;
  const yi = ((y % period) + period) % period;
  let h =
    Math.imul(xi, 374761393) +
    Math.imul(yi, 668265263) +
    Math.imul(seed + 1, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function tileNoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = tileHash(xi, yi, period, seed);
  const b = tileHash(xi + 1, yi, period, seed);
  const c = tileHash(xi, yi + 1, period, seed);
  const d = tileHash(xi + 1, yi + 1, period, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Tileable FBM; x, y in [0,1), `freq` integer periods per tile. */
export function tileFbm(
  x: number,
  y: number,
  freq: number,
  octaves: number,
  seed = 0,
): number {
  let amp = 0.5;
  let f = freq;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * tileNoise(x * f, y * f, f, seed + i * 17);
    norm += amp;
    f *= 2;
    amp *= 0.5;
  }
  return sum / norm;
}

type Draw = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

function makeTexture(
  w: number,
  h: number,
  draw: Draw,
  srgb: boolean,
  repeat = true,
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

/** Tangent-space normal map from a height field (same convention as sandNormal). */
function normalFromHeight(
  hgt: Float32Array,
  w: number,
  h: number,
  strength: number,
  repeat: boolean,
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
    repeat,
  );
}

/**
 * Blade texture (u across, v along): longitudinal veins, slightly darker edges
 * and an alpha channel that frays the edges via alphaTest. Not tiling.
 */
export function grassBladeStripes(): THREE.Texture {
  const rng = mulberry32(31);
  return makeTexture(
    64,
    128,
    (ctx, w, h) => {
      const img = ctx.createImageData(w, h);
      const d = img.data;
      for (let y = 0; y < h; y++) {
        const v = y / h;
        const wob = tileFbm(0.37, v, 4, 2, 5) - 0.5;
        for (let x = 0; x < w; x++) {
          const u = (x + 0.5) / w;
          const edge = Math.min(u, 1 - u);
          const e0 = 0.07 + wob * 0.06;
          const alpha = smoothstep(e0, e0 + 0.07, edge);
          const veins =
            1 - 0.22 * Math.abs(Math.sin(u * Math.PI * 4 + wob * 1.5)) ** 6;
          const grain = (rng() - 0.5) * 0.08;
          const edgeDark = 1 - 0.18 * (1 - smoothstep(e0, e0 + 0.12, edge));
          const l = clamp((0.94 + grain) * veins * edgeDark, 0, 1);
          const i = (y * w + x) * 4;
          d[i] = l * 255;
          d[i + 1] = l * 255;
          d[i + 2] = l * 246;
          d[i + 3] = alpha * 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    },
    true,
    false,
  );
}

/**
 * Broad-leaf texture of the second grass species (u across, v along): a strong
 * midrib, darker edges and an alpha channel that pulls the leaf in toward the
 * tip – making it look broad and rounded instead of like a second blade. Not
 * tiling.
 */
export function broadLeafTexture(): THREE.Texture {
  const rng = mulberry32(53);
  return makeTexture(
    64,
    128,
    (ctx, w, h) => {
      const img = ctx.createImageData(w, h);
      const d = img.data;
      for (let y = 0; y < h; y++) {
        const v = y / h;
        const wob = tileFbm(0.21, v, 3, 2, 17) - 0.5;
        // The leaf only tapers in the last quarter -> rounded tip
        const taper = 1 - 0.7 * smoothstep(0.74, 1, v);
        for (let x = 0; x < w; x++) {
          const u = (x + 0.5) / w;
          const mid = Math.min(u, 1 - u) * 2; // 0 = edge, 1 = center
          const e0 = 1 - taper;
          const alpha = smoothstep(e0, e0 + 0.16, mid + wob * 0.09);
          const rib = 1 + 0.14 * Math.exp(-((u - 0.5) ** 2) / 0.0022);
          const shade = 0.76 + 0.24 * mid;
          const grain = (rng() - 0.5) * 0.07;
          const l = clamp((0.92 + grain) * rib * shade, 0, 1);
          const i = (y * w + x) * 4;
          d[i] = l * 244;
          d[i + 1] = l * 255;
          d[i + 2] = l * 231;
          d[i + 3] = alpha * 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    },
    true,
    false,
  );
}

/** Rock: albedo (mottling, weathering, lichen, dark cracks) + normal map. */
export function rockTextures(): {
  map: THREE.Texture;
  normalMap: THREE.Texture;
} {
  const s = 256;
  const rng = mulberry32(77);
  const hgt = new Float32Array(s * s);
  const map = makeTexture(
    s,
    s,
    (ctx, w, h) => {
      const img = ctx.createImageData(w, h);
      const d = img.data;
      for (let y = 0; y < h; y++) {
        const v = y / h;
        for (let x = 0; x < w; x++) {
          const u = x / w;
          // Large-scale, weak color drift + fine grain (granite look)
          const n1 = tileFbm(u, v, 2, 3, 1);
          const n2 = tileFbm(u, v, 24, 3, 2);
          // A few fissures: narrow iso-lines of a coarse noise field, enabled
          // only over a small part of the surface
          const crackN = tileFbm(u, v, 3, 3, 3);
          const ridge = 1 - Math.abs(crackN * 2 - 1);
          const crackGate = smoothstep(0.58, 0.66, tileFbm(u, v, 2, 2, 9));
          const crack = smoothstep(0.955, 0.99, ridge) * crackGate;
          const rust = smoothstep(0.6, 0.74, tileFbm(u, v, 3, 3, 4));
          const lich = smoothstep(0.71, 0.75, tileFbm(u, v, 4, 4, 6));
          const lich2 = smoothstep(0.78, 0.81, tileFbm(u, v, 9, 3, 8));
          let r = 106 + (n1 - 0.5) * 26 + (n2 - 0.5) * 30 + rust * 14;
          let g = 102 + (n1 - 0.5) * 22 + (n2 - 0.5) * 28 + rust * 4;
          let b = 97 + (n1 - 0.5) * 18 + (n2 - 0.5) * 26 - rust * 6;
          r = lerp(r, 146, lich * 0.5);
          g = lerp(g, 146, lich * 0.5);
          b = lerp(b, 110, lich * 0.5);
          r = lerp(r, 160, lich2 * 0.5);
          g = lerp(g, 122, lich2 * 0.5);
          b = lerp(b, 78, lich2 * 0.5);
          const dark = 1 - crack * 0.45;
          const grain = (rng() - 0.5) * 22;
          const i = (y * w + x) * 4;
          d[i] = clamp(r * dark + grain, 0, 255);
          d[i + 1] = clamp(g * dark + grain, 0, 255);
          d[i + 2] = clamp(b * dark + grain, 0, 255);
          d[i + 3] = 255;
          hgt[y * w + x] =
            n1 * 0.3 +
            n2 * 0.7 -
            crack * 0.8 +
            lich * 0.05 +
            (rng() - 0.5) * 0.1;
        }
      }
      ctx.putImageData(img, 0, 0);
    },
    true,
  );
  return { map, normalMap: normalFromHeight(hgt, s, s, 2.6, true) };
}

/**
 * Shell: cream-colored with growth rings (v) and ribs (u, 7 periods – matching
 * the 14 ribs of the fan shell over 180°) + normal map.
 */
export function shellTextures(): {
  map: THREE.Texture;
  normalMap: THREE.Texture;
} {
  const s = 256;
  const rng = mulberry32(91);
  const hgt = new Float32Array(s * s);
  const map = makeTexture(
    s,
    s,
    (ctx, w, h) => {
      const img = ctx.createImageData(w, h);
      const d = img.data;
      for (let y = 0; y < h; y++) {
        const v = y / h;
        for (let x = 0; x < w; x++) {
          const u = x / w;
          const ridge = 0.5 + 0.5 * Math.sin(u * Math.PI * 2 * 7);
          const bandN = tileFbm(u, v, 3, 2, 11);
          const streak = tileFbm(u, v, 8, 2, 12);
          const band = 0.5 + 0.5 * Math.sin(v * Math.PI * 2 * 9 + bandN * 3);
          const k = band ** 3 * (0.25 + 0.75 * streak) * 0.6;
          const l = 0.9 + 0.13 * ridge;
          const grain = (rng() - 0.5) * 10;
          let r = lerp(241, 196, k) * l + grain;
          let g = lerp(233, 160, k) * l + grain;
          let b = lerp(214, 128, k) * l + grain;
          // occasional pink tinges
          const pink = smoothstep(0.62, 0.7, tileFbm(u, v, 2, 2, 13)) * 0.35;
          r = lerp(r, 230, pink);
          g = lerp(g, 170, pink);
          b = lerp(b, 165, pink);
          const i = (y * w + x) * 4;
          d[i] = clamp(r, 0, 255);
          d[i + 1] = clamp(g, 0, 255);
          d[i + 2] = clamp(b, 0, 255);
          d[i + 3] = 255;
          hgt[y * w + x] = ridge * 0.7 + band * 0.25;
        }
      }
      ctx.putImageData(img, 0, 0);
    },
    true,
    false,
  );
  return { map, normalMap: normalFromHeight(hgt, s, s, 1.8, false) };
}
