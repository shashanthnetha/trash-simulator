// Procedural textures for the abandoned dune camp: weathered tent canvas
// (plain weave, panel seams, water stains, sun bleach towards the ridge),
// fire-ring stone (grain, veins, pits – the soot is applied per vertex),
// a cold ash/charcoal bed and the cracked, sooty lantern glass.
// All sets are deterministic and cached like the rest of the PBR library.

import type * as THREE from "three";
import {
  type PbrMaps,
  type Rgb,
  TexBuf,
  cacheKey,
  cachedPbr,
  cachedTex,
  hash01,
  hashPix,
  lerp3,
  makeCanvas,
  noiseField,
  rgb,
  sstep,
  texFromCanvas,
} from "./textures-core";

/**
 * Weathered tent canvas. v runs from the hem (0, grimy) to the ridge
 * (1, sun-bleached); u tiles along the wall. 1024×512, map + normal +
 * roughness, wrapV clamped so hem and ridge stay where they belong.
 */
export function pbrTentCanvas(): PbrMaps {
  return cachedPbr(cacheKey("tentCanvas", []), () => {
    const W = 1024;
    const H = 512;
    const BASE: Rgb = rgb("#6f6a4a");
    const BLEACH: Rgb = rgb("#aaa28b");
    const GRIME: Rgb = rgb("#453f2e");
    const STAIN: Rgb = rgb("#5a5340");
    const buf = new TexBuf(W, H, BASE, 0.9, 0);
    const nSlub = noiseField(W, H, 811, { freq: 80, freqY: 40, oct: 2 });
    const nLow = noiseField(W, H, 812, { freq: 3, oct: 3 });
    const nStain = noiseField(W, H, 813, { freq: 4, oct: 4 });
    const NU = 240;
    const NV = 120;
    const TWO_PI = Math.PI * 2;
    buf.each((i, u, v) => {
      // Plain weave with per-thread tone scatter and slubs
      const cu = Math.floor(u * NU);
      const cv = Math.floor(v * NV);
      const weave =
        Math.sin(u * NU * TWO_PI) * 0.5 + Math.sin(v * NV * TWO_PI) * 0.5;
      let k =
        1 +
        weave * 0.05 +
        (hash01(cu, 0, 31) - 0.5) * 0.05 +
        (hash01(0, cv, 47) - 0.5) * 0.04 +
        (nSlub[i] - 0.5) * 0.1 +
        (hashPix(i, 5) - 0.5) * 0.06;
      // Vertical panel seams every eighth of the tile (double-stitched)
      const su = u * 8 - Math.floor(u * 8 + 0.5);
      const seam = 1 - sstep(0.006, 0.018, Math.abs(su));
      k -= seam * 0.1;
      buf.set(i, [BASE[0] * k, BASE[1] * k, BASE[2] * k]);
      // Sun bleach towards the ridge, uneven via the low-frequency noise
      const bleach = Math.min(
        1,
        (0.15 + 0.85 * v ** 1.3) * (0.7 + 0.6 * nLow[i]),
      );
      buf.mixTo(i, BLEACH, bleach * 0.55);
      // Old water stains with darker tide rims in the lower half
      const s = nStain[i];
      const zone = 1 - sstep(0.2, 0.7, v);
      const fill = sstep(0.6, 0.66, s) * (1 - sstep(0.72, 0.78, s));
      const rim =
        sstep(0.585, 0.615, s) * (1 - sstep(0.615, 0.65, s)) +
        sstep(0.75, 0.78, s) * (1 - sstep(0.78, 0.81, s));
      buf.mixTo(i, STAIN, fill * zone * 0.22);
      buf.mixTo(i, GRIME, rim * zone * 0.32);
      // Mildew specks low down
      if (v < 0.45 && hashPix(i, 9) > 0.9967) buf.mul(i, 0.55);
      // Grimy hem, faint shadow line under the ridge seam
      const hem = 1 - sstep(0, 0.06, v);
      buf.mixTo(i, GRIME, hem * 0.42);
      if (v > 0.986) buf.mul(i, 0.9);
      buf.hf[i] = weave * 0.35 + (nSlub[i] - 0.5) * 0.5 + seam * 0.5;
      buf.rough[i] = 0.9 - bleach * 0.05 + fill * zone * 0.05 + hem * 0.04;
    });
    return buf.build({ normal: 2.2, normalScale: 0.55, wrapV: false });
  });
}

/**
 * Fire-ring stone: grey field stone with warm/cool patches, mineral grain,
 * faint quartz veins and small pits. The smoke blackening is NOT baked in –
 * the camp applies it per vertex facing the fire. 512², map + normal + rough.
 */
export function pbrCampStone(): PbrMaps {
  return cachedPbr(cacheKey("campStone", []), () => {
    const S = 512;
    const BASE: Rgb = rgb("#8b877e");
    const WARM: Rgb = rgb("#968a70");
    const COOL: Rgb = rgb("#7c818b");
    const VEIN: Rgb = rgb("#b3aea3");
    const buf = new TexBuf(S, S, BASE, 0.84, 0);
    const nLow = noiseField(S, S, 821, { freq: 3, oct: 3 });
    const nMid = noiseField(S, S, 822, { freq: 9, oct: 4 });
    const nVein = noiseField(S, S, 823, { freq: 6, oct: 4, mode: "ridged" });
    const nPit = noiseField(S, S, 824, { freq: 30, oct: 2, mode: "billow" });
    buf.each((i) => {
      const t = nLow[i];
      let col = lerp3(
        BASE,
        t > 0.5 ? WARM : COOL,
        Math.min(1, Math.abs(t - 0.5) * 1.6),
      );
      const k = 0.9 + nMid[i] * 0.2 + (hashPix(i, 3) - 0.5) * 0.12;
      col = [col[0] * k, col[1] * k, col[2] * k];
      const vein = sstep(0.8, 0.92, nVein[i]);
      col = lerp3(col, VEIN, vein * 0.5);
      const pit = sstep(0.72, 0.88, nPit[i]);
      buf.set(i, [
        col[0] * (1 - pit * 0.25),
        col[1] * (1 - pit * 0.25),
        col[2] * (1 - pit * 0.22),
      ]);
      buf.hf[i] =
        nMid[i] * 0.5 + vein * 0.25 - pit * 0.6 + (hashPix(i, 7) - 0.5) * 0.15;
      buf.rough[i] = 0.84 + pit * 0.1 - vein * 0.08 + (nMid[i] - 0.5) * 0.06;
    });
    return buf.build({ normal: 3, normalScale: 0.8 });
  });
}

/**
 * Cold fire bed: mid-grey base with charcoal cracks, pale powder-ash patches
 * and a few vitrified glossy facets. Used for the ash disc, the charcoal
 * chunks, the charred log ends and the dark tent interior – the vertex color
 * decides which of them a surface reads as. 512², map + normal + rough.
 */
export function pbrAshChar(): PbrMaps {
  return cachedPbr(cacheKey("ashChar", []), () => {
    const S = 512;
    const BASE: Rgb = rgb("#65635f");
    const ASH: Rgb = rgb("#b4b1aa");
    const CHAR: Rgb = rgb("#1d1c1b");
    const buf = new TexBuf(S, S, BASE, 0.94, 0);
    const nCrack = noiseField(S, S, 831, { freq: 12, oct: 4, mode: "ridged" });
    const nAsh = noiseField(S, S, 832, { freq: 5, oct: 3, mode: "billow" });
    const nFine = noiseField(S, S, 833, { freq: 60, oct: 2 });
    buf.each((i) => {
      const crack = sstep(0.7, 0.9, nCrack[i]);
      const ash = sstep(0.45, 0.75, nAsh[i]);
      buf.mixTo(i, ASH, ash * 0.75);
      buf.mixTo(i, CHAR, crack * 0.8);
      buf.mul(i, 0.92 + nFine[i] * 0.16 + (hashPix(i, 11) - 0.5) * 0.08);
      const facet = (1 - crack) * (1 - ash) * sstep(0.78, 0.9, nFine[i]);
      buf.hf[i] = -crack * 0.6 + ash * 0.25 + (nFine[i] - 0.5) * 0.2;
      buf.rough[i] = 0.95 - facet * 0.4 + ash * 0.03 - crack * 0.05;
    });
    return buf.build({ normal: 2.5, normalScale: 0.7 });
  });
}

/**
 * Lantern glass: smoky pane with soot creeping up from the burner and a
 * crack star. Color + alpha; the material renders it transparent, nothing
 * about it ever glows. u wraps around the globe, v is clamped.
 */
export function campGlassTexture(): THREE.Texture {
  return cachedTex(cacheKey("campGlass", []), () => {
    const S = 128;
    const [c, ctx] = makeCanvas(S, S);
    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = "rgba(196,208,214,0.30)";
    ctx.fillRect(0, 0, S, S);
    // Soot from below (v = 0 is the bottom of the pane after flipY)
    const g = ctx.createLinearGradient(0, S, 0, S * 0.3);
    g.addColorStop(0, "rgba(26,24,22,0.7)");
    g.addColorStop(1, "rgba(26,24,22,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    // Vertical soot streaks
    ctx.strokeStyle = "rgba(30,28,26,0.35)";
    ctx.lineWidth = 3;
    for (const sx of [12, 30, 55, 78, 99, 118]) {
      ctx.beginPath();
      ctx.moveTo(sx, S);
      ctx.quadraticCurveTo(sx + 4, S * 0.75, sx - 2, S * 0.45);
      ctx.stroke();
    }
    // Crack star with jagged branches
    const ix = S * 0.62;
    const iy = S * 0.36;
    ctx.strokeStyle = "rgba(238,246,248,0.8)";
    ctx.lineWidth = 1.2;
    const RAYS: Array<[number, number, number]> = [
      [0.3, 34, 8],
      [1.5, 26, -6],
      [2.4, 30, 10],
      [3.6, 22, -8],
      [4.5, 30, 6],
      [5.5, 20, -5],
    ];
    for (const [ang, len, bend] of RAYS) {
      const mx = ix + Math.cos(ang) * len * 0.5 + Math.sin(ang) * bend * 0.4;
      const my = iy + Math.sin(ang) * len * 0.5 - Math.cos(ang) * bend * 0.4;
      ctx.beginPath();
      ctx.moveTo(ix, iy);
      ctx.lineTo(mx, my);
      ctx.lineTo(ix + Math.cos(ang) * len, iy + Math.sin(ang) * len);
      ctx.stroke();
    }
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.arc(ix, iy, 3.5, 0, Math.PI * 2);
    ctx.stroke();
    return texFromCanvas(c, true, true, false);
  });
}
