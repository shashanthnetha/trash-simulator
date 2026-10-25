// Procedural, tileable textures for the sea (ocean.ts): a detail normal map for
// ripples/glitter and a foam mask (R = lace/bubbles, G = soft patches, B = fine
// speckle). No assets, all Canvas 2D.

import * as THREE from "three";
import { mulberry32 } from "./noise";

function hashLattice(x: number, y: number, seed: number): number {
  let h =
    Math.imul(x, 374761393) +
    Math.imul(y, 668265263) +
    Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Tileable value noise: `cx`/`cy` grid cells per tile edge. */
function periodicNoise(
  u: number,
  v: number,
  cx: number,
  cy: number,
  seed: number,
): number {
  const x = u * cx;
  const y = v * cy;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const x0 = ((xi % cx) + cx) % cx;
  const y0 = ((yi % cy) + cy) % cy;
  const x1 = (x0 + 1) % cx;
  const y1 = (y0 + 1) % cy;
  const a = hashLattice(x0, y0, seed);
  const b = hashLattice(x1, y0, seed);
  const c = hashLattice(x0, y1, seed);
  const d = hashLattice(x1, y1, seed);
  const s = xf * xf * (3 - 2 * xf);
  const t = yf * yf * (3 - 2 * yf);
  return a + (b - a) * s + (c - a) * t + (a - b - c + d) * s * t;
}

function periodicFbm(
  u: number,
  v: number,
  cx: number,
  cy: number,
  octaves: number,
  seed: number,
  gain = 0.5,
): number {
  let amp = 0.5;
  let fx = cx;
  let fy = cy;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * periodicNoise(u, v, fx, fy, seed + i * 17);
    norm += amp;
    fx *= 2;
    fy *= 2;
    amp *= gain;
  }
  return sum / norm;
}

function dataTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/**
 * Detail normal map of the water surface: anisotropic noise (crests across the
 * travel direction, i.e. along u) plus fine capillary ripples. RG = xy slope.
 */
export function oceanNormalTexture(size = 256): THREE.CanvasTexture {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const coarse = periodicFbm(u, v, 5, 9, 4, 11);
      const fine = periodicFbm(u, v, 22, 34, 2, 47);
      const ripple =
        Math.sin((v * 34 + periodicNoise(u, v, 4, 4, 3) * 2.2) * Math.PI * 2) *
          0.5 +
        0.5;
      h[y * size + x] = coarse * 0.7 + fine * 0.22 + ripple * 0.08;
    }
  }
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  if (ctx) {
    const img = ctx.createImageData(size, size);
    const d = img.data;
    const strength = size * 0.075;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const l = h[y * size + ((x - 1 + size) % size)];
        const r = h[y * size + ((x + 1) % size)];
        const up = h[((y - 1 + size) % size) * size + x];
        const dn = h[((y + 1) % size) * size + x];
        const nx = (l - r) * strength;
        const ny = (up - dn) * strength;
        const len = Math.sqrt(nx * nx + ny * ny + 1);
        const i = (y * size + x) * 4;
        d[i] = ((nx / len) * 0.5 + 0.5) * 255;
        d[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
        d[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  return dataTexture(c);
}

/**
 * Foam mask: R = lace pattern with bubble rings, G = soft patches (for
 * whitecaps and the shoreline), B = fine speckle.
 */
export function oceanFoamTexture(size = 512): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  if (!ctx) return dataTexture(c);
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      // Lace: contrast-boosted value noise with cell-like edges
      const n = periodicFbm(u, v, 12, 12, 4, 5, 0.55);
      const cell = periodicNoise(u, v, 28, 28, 9);
      const edge = 1 - Math.abs(cell - 0.5) * 2;
      let lace = (n - 0.42) * 4.5 + edge * edge * 0.55 - 0.35;
      lace = Math.max(0, Math.min(1, lace));
      const patch = periodicFbm(u, v, 3, 3, 3, 21);
      const speck = periodicFbm(u, v, 48, 48, 2, 33);
      const i = (y * size + x) * 4;
      d[i] = lace * 255;
      d[i + 1] = Math.max(0, Math.min(1, (patch - 0.32) * 2.6)) * 255;
      d[i + 2] = Math.max(0, Math.min(1, (speck - 0.3) * 2.2)) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // Bubble rings into the R channel only (additive), with tile wrap-around
  ctx.globalCompositeOperation = "lighter";
  const rng = mulberry32(0x0cea);
  for (let k = 0; k < 900; k++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = 1.5 + rng() * rng() * 7;
    const a = 0.35 + rng() * 0.5;
    ctx.strokeStyle = `rgba(255,0,0,${a.toFixed(2)})`;
    ctx.lineWidth = 0.8 + rng() * 1.2;
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        const cx = x + ox;
        const cy = y + oy;
        if (
          cx < -r - 2 ||
          cx > size + r + 2 ||
          cy < -r - 2 ||
          cy > size + r + 2
        )
          continue;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
  ctx.globalCompositeOperation = "source-over";
  return dataTexture(c);
}
