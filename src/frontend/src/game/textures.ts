// Procedural textures (canvas) so the game runs without external assets.
// Entry point of the PBR library: sand, the old single textures (now
// deterministic + cached) and re-exports of the texture sets from
// textures-core.ts (API, helpers), textures-vehicle.ts, textures-trash.ts.
//
// Quick guide for modellers:
//   const maps = pbrCarPaint("#2f6e43", { dirt: 0.6 });
//   applyPbr(material, maps);            // or applyPbr(material, maps, [2, 1])
// Every set is cached (same arguments → same texture objects); anyone who
// needs a different `repeat` gets clones via applyPbr().

import * as THREE from "three";
import { fbm } from "./noise";
import {
  type PbrMaps,
  type Rgb,
  TexBuf,
  TexRng,
  blurField,
  cacheKey,
  cachedPbr,
  cachedTex,
  hashPix,
  noiseField,
  rgb,
  sstep,
} from "./textures-core";

export * from "./textures-core";
export * from "./textures-trash";
export * from "./textures-vehicle";

// ---------------------------------------------------------------------------
// Sand
// ---------------------------------------------------------------------------

/**
 * Beach sand. Tile ≈ 11.7 m (world.ts: repeat 70×48 over 820×560 m). Contains
 * only mid/high frequencies (no visible tile grid): fine grain, subtle
 * anisotropic wind ripples (wavelength ≈ 19 cm), shell fragments and pebbles,
 * damp darker speckles in the roughness. 1024², map + normal + roughness
 * (normalScale 0.7). sandAlbedo()/sandNormal()/sandRoughness() return the
 * individual maps of the same set.
 */
export function pbrSand(): PbrMaps {
  return cachedPbr(cacheKey("sand", []), () => {
    const S = 1024;
    const rng = new TexRng(0x5a4d);
    const base: Rgb = rgb("#d6bc8e");
    const buf = new TexBuf(S, S, base, 0.92, 0);
    const nMid = noiseField(S, S, 601, { freq: 8, oct: 4 });
    const nHi = noiseField(S, S, 602, { freq: 48, oct: 3 });
    const nWarp = noiseField(S, S, 603, { freq: 4, oct: 3 });
    const nMask = noiseField(S, S, 604, { freq: 6, oct: 3 });
    const nSp = noiseField(S, S, 605, { freq: 200, oct: 1 });
    // Shell fragments and pebbles (with wrap copies at the edges)
    const items = buf.layer((ctx) => {
      const SHELL = ["#ebe3d4", "#e6d2c4", "#dccbb4", "#f0e9dc"];
      const STONE = ["#8f877c", "#7d6a55", "#5c5148", "#a99f92", "#b5a48c"];
      for (let k = 0; k < 240; k++) {
        const x = rng.next() * S;
        const y = rng.next() * S;
        const shell = rng.chance(0.4);
        const r = shell ? rng.range(2.5, 6) : rng.range(1.5, 4.5);
        const col = shell ? rng.pick(SHELL) : rng.pick(STONE);
        const rot = rng.next() * Math.PI;
        const ar = rng.range(0.55, 1);
        for (const [ox, oy] of [
          [0, 0],
          [S, 0],
          [-S, 0],
          [0, S],
          [0, -S],
        ]) {
          const px = x + ox;
          const py = y + oy;
          if (px < -10 || px > S + 10 || py < -10 || py > S + 10) continue;
          ctx.fillStyle = col;
          ctx.beginPath();
          if (shell) {
            ctx.ellipse(px, py, r, r * ar, rot, 0, Math.PI);
            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = "rgba(120,100,90,0.5)";
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            ctx.moveTo(px, py);
            ctx.lineTo(
              px + Math.cos(rot + 0.5) * r,
              py + Math.sin(rot + 0.5) * r,
            );
            ctx.stroke();
          } else {
            ctx.ellipse(px, py, r, r * ar, rot, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    });
    const itemA = TexBuf.layerAlpha(items, buf.n);
    const itemH = blurField(Float32Array.from(itemA), S, S, 1, true, true, 1);
    const TWO_PI = Math.PI * 2;
    buf.each((i, u, v) => {
      let k =
        1 +
        (nMid[i] - 0.5) * 0.07 +
        (nHi[i] - 0.5) * 0.06 +
        (hashPix(i, 1) - 0.5) * 0.1;
      const spark = hashPix(i, 2) > 0.996 ? 0.12 : 0;
      k += spark;
      // Wind ripples: 170 cycles in u, 40 in v (seamless, wavelength ≈ 6.7 cm),
      // flat, in patches with gaps, direction drifting via noise
      const A = sstep(0.45, 0.8, nMask[i]) * (0.6 + 0.4 * nHi[i]);
      const dw = (nWarp[i] - 0.5) * 0.04;
      const phase = ((u + dw) * 170 + (v - dw * 0.6) * 40) * TWO_PI;
      const rp = Math.sin(phase) + 0.3 * Math.sin(2 * phase - 1);
      k += rp * A * 0.005;
      const moist = sstep(0.78, 0.86, nSp[i]);
      k -= moist * 0.07;
      const warm = (nMid[i] - 0.5) * 0.03;
      buf.r[i] = base[0] * (k + warm);
      buf.g[i] = base[1] * k;
      buf.b[i] = base[2] * (k - warm);
      const ia = itemA[i];
      if (ia > 0.02) {
        const j = i * 4;
        buf.mixTo(
          i,
          [items[j] / 255, items[j + 1] / 255, items[j + 2] / 255],
          ia,
        );
      }
      buf.hf[i] =
        rp * A * 0.035 +
        (nHi[i] - 0.5) * 0.16 +
        (nMid[i] - 0.5) * 0.06 +
        (hashPix(i, 3) - 0.5) * 0.16 +
        itemH[i] * 0.7;
      buf.rough[i] =
        0.92 - (nHi[i] - 0.5) * 0.06 - moist * 0.2 - ia * 0.3 - spark * 0.3;
    });
    return buf.build({ normal: 3, normalScale: 0.7 });
  });
}

export function sandAlbedo(): THREE.Texture {
  return pbrSand().map;
}

/** Normal map of the sand set (ripples, grain, pebbles). */
export function sandNormal(): THREE.Texture {
  return requireMap(pbrSand().normalMap, "sandNormal");
}

/** Roughness: dry sand ≈ 0.92, damp speckles/pebbles lower. */
export function sandRoughness(): THREE.Texture {
  return requireMap(pbrSand().roughnessMap, "sandRoughness");
}

function requireMap(t: THREE.Texture | undefined, name: string): THREE.Texture {
  if (!t) throw new Error(`${name}: map missing`);
  return t;
}

// ---------------------------------------------------------------------------
// Single textures (existing API) – deterministic and cached
// ---------------------------------------------------------------------------

function canvasTexture(
  size: number,
  draw: (ctx: CanvasRenderingContext2D, size: number) => void,
  repeat = 1,
): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  if (ctx) draw(ctx, size);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 8;
  return tex;
}

export function woodTexture(base = "#8a6238"): THREE.Texture {
  return cachedTex(cacheKey("woodTexture", [base]), () => {
    const rng = new TexRng(0x77);
    const tex = canvasTexture(256, (ctx, s) => {
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, s, s);
      for (let y = 0; y < s; y += 2) {
        const n = fbm(0.7, y * 0.08, 3);
        ctx.fillStyle = `rgba(40,24,10,${0.08 + n * 0.16})`;
        ctx.fillRect(
          0,
          y + Math.sin(y * 0.09) * 3,
          s,
          1 + (y % 5 === 0 ? 1 : 0),
        );
      }
      for (let k = 0; k < 5; k++) {
        const x = rng.next() * s;
        const y = rng.next() * s;
        ctx.strokeStyle = "rgba(30,18,8,0.5)";
        ctx.beginPath();
        ctx.ellipse(
          x,
          y,
          4 + rng.next() * 5,
          2 + rng.next() * 3,
          0,
          0,
          Math.PI * 2,
        );
        ctx.stroke();
      }
    });
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  });
}

export function rustTexture(): THREE.Texture {
  return cachedTex(cacheKey("rustTexture", []), () => {
    const tex = canvasTexture(256, (ctx, s) => {
      ctx.fillStyle = "#7d8790";
      ctx.fillRect(0, 0, s, s);
      const img = ctx.getImageData(0, 0, s, s);
      const d = img.data;
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const n = fbm(x * 0.06, y * 0.06, 4);
          if (n > 0.56) {
            const i = (y * s + x) * 4;
            const rustAmt = (n - 0.56) * 3;
            d[i] = 140 + rustAmt * 60;
            d[i + 1] = 74 + rustAmt * 20;
            d[i + 2] = 38;
          }
        }
      }
      ctx.putImageData(img, 0, 0);
    });
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  });
}

export function paperTexture(): THREE.Texture {
  return cachedTex(cacheKey("paperTexture", []), () => {
    const rng = new TexRng(0x9a);
    const tex = canvasTexture(256, (ctx, s) => {
      ctx.fillStyle = "#efe9da";
      ctx.fillRect(0, 0, s, s);
      ctx.fillStyle = "rgba(60,60,70,0.85)";
      for (let y = 18; y < s - 10; y += 9) {
        const w = s * (0.55 + rng.next() * 0.4);
        ctx.fillRect(14, y, w - 20, 2.4);
      }
      ctx.fillStyle = "rgba(30,30,40,0.95)";
      ctx.fillRect(14, 4, s * 0.6, 9);
    });
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  });
}

export function labelTexture(
  color1: string,
  color2: string,
  text?: string,
): THREE.Texture {
  return cachedTex(
    cacheKey("labelTexture", [color1, color2, text ?? ""]),
    () => {
      const tex = canvasTexture(128, (ctx, s) => {
        ctx.fillStyle = color1;
        ctx.fillRect(0, 0, s, s);
        ctx.fillStyle = color2;
        ctx.fillRect(0, s * 0.34, s, s * 0.32);
        if (text) {
          ctx.fillStyle = "#ffffff";
          ctx.font = "bold 26px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(text, s / 2, s * 0.56);
        }
      });
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    },
  );
}

export function grassBladeTexture(): THREE.Texture {
  return cachedTex(cacheKey("grassBladeTexture", []), () => {
    const rng = new TexRng(0x6a);
    const tex = canvasTexture(64, (ctx, s) => {
      ctx.clearRect(0, 0, s, s);
      for (let b = 0; b < 5; b++) {
        const x0 = 8 + b * 12 + rng.next() * 4;
        const sway = (rng.next() - 0.5) * 14;
        const grd = ctx.createLinearGradient(0, s, 0, 0);
        grd.addColorStop(0, "#5d7a3a");
        grd.addColorStop(1, "#a8b96a");
        ctx.strokeStyle = grd;
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.moveTo(x0, s);
        ctx.quadraticCurveTo(x0 + sway * 0.4, s * 0.5, x0 + sway, 3);
        ctx.stroke();
      }
    });
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  });
}

export function softCircleTexture(
  rgbCss = "255,255,255",
  alphaMax = 0.9,
): THREE.Texture {
  return cachedTex(cacheKey("softCircleTexture", [rgbCss, alphaMax]), () =>
    canvasTexture(64, (ctx, s) => {
      const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      g.addColorStop(0, `rgba(${rgbCss},${alphaMax})`);
      g.addColorStop(1, `rgba(${rgbCss},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    }),
  );
}

export function footprintTexture(): THREE.Texture {
  return cachedTex(cacheKey("footprintTexture", []), () =>
    canvasTexture(64, (ctx, s) => {
      ctx.clearRect(0, 0, s, s);
      ctx.fillStyle = "rgba(90,70,45,0.55)";
      ctx.beginPath();
      ctx.ellipse(s / 2, s * 0.38, s * 0.16, s * 0.26, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(s / 2, s * 0.76, s * 0.13, s * 0.12, 0, 0, Math.PI * 2);
      ctx.fill();
    }),
  );
}

export function cloudTexture(): THREE.Texture {
  return cachedTex(cacheKey("cloudTexture", []), () => {
    const rng = new TexRng(0xc1);
    return canvasTexture(256, (ctx, s) => {
      ctx.clearRect(0, 0, s, s);
      for (let i = 0; i < 26; i++) {
        const x = s * 0.5 + (rng.next() - 0.5) * s * 0.7;
        const y = s * 0.5 + (rng.next() - 0.5) * s * 0.34;
        const r = s * (0.09 + rng.next() * 0.16);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, "rgba(255,255,255,0.20)");
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  });
}
