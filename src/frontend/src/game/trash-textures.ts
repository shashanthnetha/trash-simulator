// Small extra texture sets only for the trash models (beer-mat print,
// hazard stripe band). Uses the core library from textures-core.ts.

import {
  type PbrMaps,
  type Rgb,
  TexBuf,
  TexRng,
  cacheKey,
  cachedPbr,
  drawScratches,
  noiseField,
  rgb,
  sstep,
  stampBlob,
} from "./textures";

/**
 * Beer mat: round print (ring, emblem, lettering) on board, planar
 * (u = x, v = z across the disc), worn edge, beer stain.
 * 512², map + normal + roughness.
 */
export function pbrCoaster(): PbrMaps {
  return cachedPbr(cacheKey("coaster", []), () => {
    const S = 512;
    const rng = new TexRng(0xb1e7);
    const base: Rgb = rgb("#e9dfc4");
    const buf = new TexBuf(S, S, base, 0.9, 0);
    buf.blendLayer(
      buf.layer((ctx) => {
        const c = S / 2;
        ctx.lineWidth = 26;
        ctx.strokeStyle = "#a8382c";
        ctx.beginPath();
        ctx.arc(c, c, S * 0.41, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(c, c, S * 0.35, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = "#a8382c";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = "bold 64px Georgia, 'Times New Roman', serif";
        ctx.fillText("DUNE BREW", c, c - 10, S * 0.6);
        ctx.font = "bold 24px Arial, Helvetica, sans-serif";
        ctx.fillStyle = "#3d2413";
        ctx.fillText("PILSNER · EST. 1911", c, c + 46);
        // Emblem: wave + gull
        ctx.strokeStyle = "#1d6fa8";
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(c - 70, c - 70);
        ctx.bezierCurveTo(c - 40, c - 100, c - 10, c - 50, c + 20, c - 78);
        ctx.bezierCurveTo(c + 40, c - 95, c + 60, c - 70, c + 70, c - 72);
        ctx.stroke();
        ctx.fillStyle = "#3d2413";
        ctx.font = "16px Arial, Helvetica, sans-serif";
        ctx.fillText("BREWERY ON THE BAY", c, c + 118);
      }),
      0.9,
    );
    const nF = noiseField(S, S, 601, { freq: 6, freqY: 180, oct: 3 });
    const nS = noiseField(S, S, 602, { freq: 4, oct: 4 });
    const nW = noiseField(S, S, 603, { freq: 5, oct: 3 });
    const stain = new Float32Array(buf.n);
    stampBlob(stain, S, S, S * 0.63, S * 0.36, 70, 60, 1, false);
    const scratchA = TexBuf.layerAlpha(
      buf.layer((ctx) => drawScratches(ctx, rng, S, S, 40, 60, 1, 0.5)),
      buf.n,
    );
    const STAIN: Rgb = rgb("#b98d4a");
    const GREY: Rgb = rgb("#9c9385");
    buf.each((i, u, v) => {
      const d = Math.hypot(u - 0.5, v - 0.5) * 2;
      buf.mul(i, 0.95 + nF[i] * 0.1);
      const edge = sstep(0.8, 1, d) * (0.4 + 0.6 * nW[i]);
      buf.mixTo(i, GREY, edge * 0.5);
      // Beer ring: the rim of the stain is darker
      const st = stain[i];
      const ring = sstep(0.25, 0.45, st) * (1 - sstep(0.55, 0.8, st));
      buf.mixTo(i, STAIN, ring * 0.6 + sstep(0.45, 1, st) * 0.15);
      const sc = scratchA[i];
      buf.mixTo(i, [0.95, 0.93, 0.88], sc * 0.4);
      const fade = sstep(0.55, 0.85, nS[i]) * 0.25;
      buf.mixTo(i, base, fade);
      buf.hf[i] = (nF[i] - 0.5) * 0.06 - ring * 0.05 - sc * 0.08 - edge * 0.1;
      buf.rough[i] = 0.9 + (nF[i] - 0.5) * 0.06 - ring * 0.15;
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
 * Hazard band: yellow/black diagonal stripes with warning text, scratched and
 * grimy. u around the body (tileable), v = band height. 1024×128,
 * map + normal + roughness.
 */
export function pbrHazardBand(): PbrMaps {
  return cachedPbr(cacheKey("hazardBand", []), () => {
    const W = 1024;
    const H = 128;
    const rng = new TexRng(0x4a2d);
    const base: Rgb = rgb("#e6b91c");
    const buf = new TexBuf(W, H, base, 0.5, 0);
    buf.blendLayer(
      buf.layer((ctx) => {
        ctx.fillStyle = "#1b1b1d";
        for (let x = -H; x < W + H; x += 96) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x + 40, 0);
          ctx.lineTo(x + 40 + H, H);
          ctx.lineTo(x + H, H);
          ctx.closePath();
          ctx.fill();
        }
        // Text field at the front
        ctx.fillStyle = "#e6b91c";
        ctx.fillRect(W * 0.16, H * 0.22, W * 0.22, H * 0.56);
        ctx.fillStyle = "#1b1b1d";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = "bold 44px Arial, Helvetica, sans-serif";
        ctx.fillText("DANGER", W * 0.27, H * 0.5, W * 0.2);
        ctx.fillStyle = "#e6b91c";
        ctx.fillRect(W * 0.66, H * 0.22, W * 0.22, H * 0.56);
        ctx.fillStyle = "#1b1b1d";
        ctx.font = "bold 30px Arial, Helvetica, sans-serif";
        ctx.fillText("CORROSIVE · UN 1760", W * 0.77, H * 0.5, W * 0.2);
      }),
    );
    const nG = noiseField(W, H, 611, { freq: 10, freqY: 2, oct: 4 });
    const nF = noiseField(W, H, 612, { freq: 90, freqY: 12, oct: 2 });
    const scratchA = TexBuf.layerAlpha(
      buf.layer((ctx) => drawScratches(ctx, rng, W, H, 90, 70, 1.2, 0.7)),
      buf.n,
    );
    const GRIME: Rgb = rgb("#4a4034");
    buf.each((i, _u, v) => {
      buf.mul(i, 1 + (nF[i] - 0.5) * 0.06);
      const grime =
        sstep(0.55, 0.85, nG[i]) * 0.35 + (1 - sstep(0, 0.15, v)) * 0.2;
      buf.mixTo(i, GRIME, grime);
      const sc = scratchA[i];
      buf.mixTo(i, [0.9, 0.88, 0.8], sc * 0.5);
      buf.hf[i] = (nF[i] - 0.5) * 0.03 - sc * 0.15;
      buf.rough[i] = 0.5 + grime * 0.3 + sc * 0.2;
    });
    return buf.build({ wrapV: false, normal: 4, normalScale: 0.6 });
  });
}
