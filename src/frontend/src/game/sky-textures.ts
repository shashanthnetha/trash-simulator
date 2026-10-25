// Procedural sky textures (no asset import): tileable cloud noise (RGBA = four
// noise types in one fetch) and the moon disc with maria, craters and ray
// systems. Everything deterministic (mulberry32).

import * as THREE from "three";
import { mulberry32 } from "./noise";

// ---------------------------------------------------------------------------
// Periodic value/Worley noise (tileable)
// ---------------------------------------------------------------------------

function hashP(x: number, y: number, period: number, seed: number): number {
  const xi = ((x % period) + period) % period;
  const yi = ((y % period) + period) % period;
  let h =
    Math.imul(xi, 374761393) +
    Math.imul(yi, 668265263) +
    Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function pnoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = smooth(x - xi);
  const v = smooth(y - yi);
  const a = hashP(xi, yi, period, seed);
  const b = hashP(xi + 1, yi, period, seed);
  const c = hashP(xi, yi + 1, period, seed);
  const d = hashP(xi + 1, yi + 1, period, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** FBM over cells [0, cells); tileable. */
function pfbm(
  x: number,
  y: number,
  cells: number,
  octaves: number,
  seed: number,
): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * pnoise(x * freq, y * freq, cells * freq, seed + i * 7);
    norm += amp;
    freq *= 2;
    amp *= 0.5;
  }
  return sum / norm;
}

/** Billow FBM (1 - |2n - 1|): puffy, cumulus-like shapes. */
function pbillow(
  x: number,
  y: number,
  cells: number,
  octaves: number,
  seed: number,
): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = pnoise(x * freq, y * freq, cells * freq, seed + i * 11);
    sum += amp * (1 - Math.abs(2 * n - 1));
    norm += amp;
    freq *= 2;
    amp *= 0.55;
  }
  return sum / norm;
}

/** Worley F1 distance (cell coordinates), tileable. */
function pworley(x: number, y: number, cells: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let best = 9;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i;
      const cy = yi + j;
      const px = cx + hashP(cx, cy, cells, seed);
      const py = cy + hashP(cx, cy, cells, seed + 13);
      const d = (px - x) * (px - x) + (py - y) * (py - y);
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

/**
 * Tileable cloud noise, 4 channels:
 *  R: FBM (6 octaves, base shapes)   G: billow (cumulus puffs)
 *  B: inverted Worley (cells)        A: fine FBM (detail)
 */
export function cloudNoiseTexture(size = 256): THREE.DataTexture {
  const n = size * size;
  const ch = [
    new Float32Array(n),
    new Float32Array(n),
    new Float32Array(n),
    new Float32Array(n),
  ];
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const i = y * size + x;
      ch[0][i] = pfbm(u * 4, v * 4, 4, 6, 1);
      ch[1][i] = pbillow(u * 6, v * 6, 6, 4, 20);
      const w1 = 1 - Math.min(1, pworley(u * 6, v * 6, 6, 40) * 1.1);
      const w2 = 1 - Math.min(1, pworley(u * 12, v * 12, 12, 41) * 1.1);
      ch[2][i] = w1 * 0.65 + w2 * 0.35;
      ch[3][i] = pfbm(u * 16, v * 16, 16, 4, 60);
    }
  }
  // Normalize the channels to the full value range
  const data = new Uint8Array(n * 4);
  for (let c = 0; c < 4; c++) {
    let lo = 1;
    let hi = 0;
    const arr = ch[c];
    for (let i = 0; i < n; i++) {
      if (arr[i] < lo) lo = arr[i];
      if (arr[i] > hi) hi = arr[i];
    }
    const inv = 255 / Math.max(1e-5, hi - lo);
    for (let i = 0; i < n; i++) {
      data[i * 4 + c] = Math.round((arr[i] - lo) * inv);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Moon disc
// ---------------------------------------------------------------------------

interface Mare {
  x: number;
  y: number;
  rx: number;
  ry: number;
  rot: number;
  dark: number;
}

// Position in disc coordinates (-1..1), roughly following the real moon
// (Imbrium, Serenitatis, Tranquillitatis, Crisium, Fecunditatis,
// Procellarum, Nubium, Humorum, Vaporum, Frigoris).
const MARIA: Mare[] = [
  { x: -0.3, y: -0.38, rx: 0.2, ry: 0.17, rot: 0.2, dark: 0.55 },
  { x: -0.06, y: -0.4, rx: 0.11, ry: 0.09, rot: 0.1, dark: 0.5 },
  { x: 0.2, y: -0.2, rx: 0.14, ry: 0.11, rot: 0.4, dark: 0.55 },
  { x: 0.58, y: -0.3, rx: 0.08, ry: 0.07, rot: 0.0, dark: 0.55 },
  { x: 0.45, y: 0.02, rx: 0.1, ry: 0.13, rot: 0.5, dark: 0.45 },
  { x: -0.6, y: -0.05, rx: 0.15, ry: 0.32, rot: 0.15, dark: 0.45 },
  { x: -0.22, y: 0.24, rx: 0.14, ry: 0.1, rot: -0.3, dark: 0.45 },
  { x: -0.45, y: 0.36, rx: 0.09, ry: 0.07, rot: 0.4, dark: 0.45 },
  { x: 0.04, y: 0.02, rx: 0.08, ry: 0.06, rot: 0.2, dark: 0.35 },
  { x: -0.15, y: -0.62, rx: 0.3, ry: 0.045, rot: 0.05, dark: 0.35 },
];

function drawForeshortened(
  ctx: CanvasRenderingContext2D,
  R: number,
  x: number,
  y: number,
  draw: () => void,
): void {
  // Perspective foreshortening radially toward the limb (spherical surface)
  const r = Math.min(0.999, Math.sqrt(x * x + y * y));
  const squash = Math.sqrt(1 - r * r);
  ctx.save();
  ctx.translate(R + x * R, R + y * R);
  ctx.rotate(Math.atan2(y, x));
  ctx.scale(squash, 1);
  draw();
  ctx.restore();
}

export function moonTexture(size = 256): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  if (!ctx) return tex;
  const rng = mulberry32(7331);
  const R = size / 2;

  ctx.fillStyle = "#c2bfb5";
  ctx.fillRect(0, 0, size, size);

  // The highlands are slightly brighter in the south (bottom)
  const hl = ctx.createLinearGradient(0, 0, 0, size);
  hl.addColorStop(0, "rgba(255,255,255,0)");
  hl.addColorStop(1, "rgba(255,255,250,0.14)");
  ctx.fillStyle = hl;
  ctx.fillRect(0, 0, size, size);

  // Maria: irregular dark basalt plains
  for (const m of MARIA) {
    drawForeshortened(ctx, R, m.x, m.y, () => {
      ctx.rotate(m.rot - Math.atan2(m.y, m.x));
      for (let pass = 0; pass < 2; pass++) {
        const shrink = pass === 0 ? 1 : 0.72;
        ctx.beginPath();
        const steps = 40;
        for (let i = 0; i <= steps; i++) {
          const a = (i / steps) * Math.PI * 2;
          const wob =
            1 +
            0.16 * Math.sin(a * 3 + m.x * 9) +
            0.1 * Math.sin(a * 5 + m.y * 7) +
            0.06 * Math.sin(a * 9 + 1.3);
          const px = Math.cos(a) * m.rx * R * wob * shrink;
          const py = Math.sin(a) * m.ry * R * wob * shrink;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        const k = pass === 0 ? m.dark * 0.55 : m.dark * 0.35;
        ctx.fillStyle = `rgba(70,72,78,${k.toFixed(3)})`;
        ctx.fill();
      }
    });
  }

  // Craters: bright rim, dark floor, slight shading
  const craters = 170;
  for (let i = 0; i < craters; i++) {
    const a = rng() * Math.PI * 2;
    const rr = Math.sqrt(rng()) * 0.96;
    const x = Math.cos(a) * rr;
    const y = Math.sin(a) * rr;
    // The southern highlands are richer in craters
    if (y < 0.1 && rng() < 0.45) continue;
    const rad = (0.006 + rng() * rng() * 0.05) * R;
    drawForeshortened(ctx, R, x, y, () => {
      ctx.rotate(-Math.atan2(y, x));
      ctx.beginPath();
      ctx.arc(0, 0, rad, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(95,95,100,0.35)";
      ctx.fill();
      ctx.lineWidth = Math.max(0.6, rad * 0.22);
      ctx.strokeStyle = "rgba(235,232,225,0.55)";
      ctx.stroke();
      // Inner shadow
      ctx.beginPath();
      ctx.arc(rad * 0.25, rad * 0.2, rad * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(60,60,66,0.22)";
      ctx.fill();
    });
  }

  // Ray systems (Tycho at the bottom, Copernicus center-left)
  const rays = (cx: number, cy: number, n: number, len: number, w: number) => {
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2;
      const l = (0.4 + rng() * 0.6) * len * R;
      ctx.beginPath();
      ctx.moveTo(R + cx * R, R + cy * R);
      ctx.lineTo(R + cx * R + Math.cos(a) * l, R + cy * R + Math.sin(a) * l);
      ctx.lineWidth = w * (0.5 + rng());
      ctx.strokeStyle = `rgba(245,243,238,${(0.05 + rng() * 0.1).toFixed(3)})`;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(R + cx * R, R + cy * R, R * 0.035, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(250,248,242,0.8)";
    ctx.fill();
  };
  rays(-0.08, 0.66, 26, 0.75, 1.4);
  rays(-0.34, -0.06, 14, 0.3, 1.0);

  // Grain / albedo variation
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const n = (pfbm((x / size) * 8, (y / size) * 8, 8, 4, 99) - 0.5) * 34;
      const g = (rng() - 0.5) * 10;
      d[i] = Math.min(255, Math.max(0, d[i] + n + g));
      d[i + 1] = Math.min(255, Math.max(0, d[i + 1] + n + g));
      d[i + 2] = Math.min(255, Math.max(0, d[i + 2] + n * 0.9 + g));
    }
  }
  ctx.putImageData(img, 0, 0);
  tex.needsUpdate = true;
  return tex;
}
