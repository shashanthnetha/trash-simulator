// Procedural textures for the companions: the dog's skin layer (short fur,
// hair strokes along v), the strand field for the shell fur, the drone's
// moulded shell, its motor windings and the rotor blur disc.

import * as THREE from "three";
import {
  type PbrMaps,
  TexBuf,
  TexRng,
  cacheKey,
  cachedPbr,
  cachedTex,
  hashPix,
  makeCanvas,
  noiseField,
  rgb,
  sstep,
  texFromCanvas,
} from "./textures";

/**
 * Short fur, tileable. The hairs run along **v** (cylinder UV: v = body axis),
 * u goes around the body. The base tone is a neutral light – the coat markings
 * come from vertex colors. 512², map + normal + roughness. This is the *skin*
 * underneath the shell fur, so it is deliberately a shade darker than the
 * strands: what shows through between the hairs is undercoat.
 */
export function pbrFur(): PbrMaps {
  return cachedPbr(cacheKey("fur", []), () => {
    const S = 512;
    const base = rgb("#cfc6b6");
    const buf = new TexBuf(S, S, base, 0.86, 0);
    // Fine hair strokes: high frequency across, very low along
    const hair = noiseField(S, S, 711, { freq: 150, freqY: 5, oct: 2 });
    const hair2 = noiseField(S, S, 712, { freq: 70, freqY: 3, oct: 2 });
    const clump = noiseField(S, S, 713, { freq: 9, oct: 4 });
    const swirl = noiseField(S, S, 714, { freq: 4, oct: 3 });
    const dirt = noiseField(S, S, 715, { freq: 6, oct: 4 });
    const SAND = rgb("#b8a684");
    buf.each((i) => {
      const h = hair[i] * 0.7 + hair2[i] * 0.3;
      const cl = 0.5 + (clump[i] - 0.5) * 0.9;
      const k =
        0.84 + h * 0.34 + (cl - 0.5) * 0.12 + (hashPix(i, 9) - 0.5) * 0.06;
      buf.r[i] = base[0] * k;
      buf.g[i] = base[1] * k;
      buf.b[i] = base[2] * k;
      // A little sand dust in the recesses
      const du = sstep(0.6, 0.9, dirt[i]) * (1 - h) * 0.35;
      buf.mixTo(i, SAND, du);
      // Height: hair stroke + tuft + cowlick
      buf.hf[i] = (h - 0.5) * 0.55 + (cl - 0.5) * 0.5 + (swirl[i] - 0.5) * 0.25;
      buf.rough[i] = 0.9 - h * 0.12 + du * 0.06;
    });
    return buf.build({ normal: 2.6, normalScale: 0.85 });
  });
}

// ---------------------------------------------------------------------------
// Shell fur
// ---------------------------------------------------------------------------

/**
 * Strand cells per tile edge – with FUR_TILE_M this sets the hair spacing.
 * Deliberately few, large cells (16 px per strand): the shells are sampled at
 * a grazing angle over half of the body, and a strand only a few texels wide
 * is averaged away by the mip chain into flat grey felt.
 */
const FUR_CELLS = 32;
/** Edge length of one texture tile in metres (→ ≈ 4 mm hair spacing). */
export const FUR_TILE_M = 0.125;

/**
 * Strand field for the shell fur. Every texel belongs to the nearest of a
 * jittered grid of hair roots; the value falls off conically towards the edge
 * of the strand, so a shell at height `s` keeps exactly the cross-section of
 * the hairs that are still longer than `s` – the coat therefore thins out
 * towards the tips instead of ending in hard shingles.
 *
 * `R` = strand height 0..1, `G` = per-strand random (colour scatter),
 * `B` = clump density (soft undercoat). Data texture, **no** sRGB.
 * Sampled triplanar in object space, so the strand size is independent of the
 * UV layout of the body part.
 */
export function furShellTexture(): THREE.Texture {
  return cachedTex(cacheKey("furShell", []), () => {
    const S = 512;
    const N = FUR_CELLS;
    const cell = S / N;
    const rng = new TexRng(0x7f0c);
    const cxs = new Float32Array(N * N);
    const cys = new Float32Array(N * N);
    const lens = new Float32Array(N * N);
    const ids = new Float32Array(N * N);
    const clump = noiseField(N, N, 731, { freq: 4, oct: 3 });
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        cxs[k] = (i + 0.12 + rng.next() * 0.76) * cell;
        cys[k] = (j + 0.12 + rng.next() * 0.76) * cell;
        // Not every hair reaches the same length – that is what gives the coat
        // depth instead of one uniform lawn.
        const cl = 0.42 + clump[k] * 0.72;
        lens[k] = Math.min(1, cl * (0.62 + rng.next() * 0.6));
        ids[k] = rng.next();
      }
    }
    const [c, ctx] = makeCanvas(S, S);
    const img = ctx.createImageData(S, S);
    const d = img.data;
    // Strand radius: slightly larger than one cell so the cones overlap and no
    // bare skin shows through between them on the inner shells.
    const rad = cell * 0.95;
    for (let y = 0; y < S; y++) {
      const cj = Math.floor(y / cell);
      for (let x = 0; x < S; x++) {
        const ci = Math.floor(x / cell);
        let best = 0;
        let bestId = 0;
        for (let dj = -1; dj <= 1; dj++) {
          const jj = (cj + dj + N) % N;
          for (let di = -1; di <= 1; di++) {
            const ii = (ci + di + N) % N;
            const k = jj * N + ii;
            // Wrapped distance (the tile has to be seamless)
            let dx = cxs[k] - x;
            let dy = cys[k] - y;
            if (ci + di < 0) dx -= S;
            else if (ci + di >= N) dx += S;
            if (cj + dj < 0) dy -= S;
            else if (cj + dj >= N) dy += S;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist >= rad) continue;
            const h = lens[k] * (1 - dist / rad);
            if (h > best) {
              best = h;
              bestId = ids[k];
            }
          }
        }
        const i = y * S + x;
        const j4 = i * 4;
        d[j4] = (Math.min(1, best) * 255 + 0.5) | 0;
        d[j4 + 1] = (bestId * 255 + 0.5) | 0;
        d[j4 + 2] = (clump[(cj % N) * N + (ci % N)] * 255 + 0.5) | 0;
        d[j4 + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return texFromCanvas(c, false, true, true);
  });
}

// ---------------------------------------------------------------------------
// Drone
// ---------------------------------------------------------------------------

/**
 * Moulded ABS shell of the drone: fine plastic grain, flow lines from the
 * injection mould, a tileable grid of panel grooves (2 × 2 per tile) with
 * screw dimples at the crossings and a few cooling slots. Tileable, so it
 * works on every UV layout of the airframe. 512², map + normal + roughness.
 */
export function pbrDroneShell(colorHex = "#dfe3e6"): PbrMaps {
  return cachedPbr(cacheKey("droneShell", [colorHex]), () => {
    const S = 512;
    const base = rgb(colorHex);
    const buf = new TexBuf(S, S, base, 0.44, 0);
    const grain = noiseField(S, S, 741, { freq: 160, oct: 2 });
    const flow = noiseField(S, S, 742, { freq: 3, freqY: 26, oct: 3 });
    const soil = noiseField(S, S, 743, { freq: 5, oct: 4 });
    const DIRT = rgb("#9a9384");
    // Vector layer: panel grooves, screws, cooling slots, a brand stripe
    const lines = buf.layer((ctx) => {
      ctx.clearRect(0, 0, S, S);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 3.4;
      for (const p of [0.25, 0.75]) {
        ctx.beginPath();
        ctx.moveTo(p * S, 0);
        ctx.lineTo(p * S, S);
        ctx.moveTo(0, p * S);
        ctx.lineTo(S, p * S);
        ctx.stroke();
      }
      ctx.fillStyle = "#fff";
      for (const px of [0.25, 0.75])
        for (const py of [0.25, 0.75]) {
          ctx.beginPath();
          ctx.arc(px * S, py * S, 5.5, 0, Math.PI * 2);
          ctx.fill();
        }
      // Cooling slots in two of the four fields
      for (let k = 0; k < 5; k++) {
        ctx.beginPath();
        ctx.roundRect(S * 0.34 + k * 12, S * 0.06, 6, S * 0.12, 3);
        ctx.fill();
        ctx.beginPath();
        ctx.roundRect(S * 0.84, S * 0.36 + k * 12, S * 0.12, 6, 3);
        ctx.fill();
      }
    });
    const lineA = TexBuf.layerAlpha(lines, S * S);
    const label = buf.layer((ctx) => {
      ctx.clearRect(0, 0, S, S);
      ctx.fillStyle = "#5c6470";
      ctx.font = "bold 22px Arial, Helvetica, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText("SHORELINE  AV-4", S * 0.3, S * 0.62);
      ctx.fillRect(S * 0.3, S * 0.68, S * 0.34, 4);
    });
    buf.each((i) => {
      const g = grain[i];
      const fl = flow[i];
      const k = 0.95 + (g - 0.5) * 0.07 + (fl - 0.5) * 0.05;
      buf.r[i] = base[0] * k;
      buf.g[i] = base[1] * k;
      buf.b[i] = base[2] * k;
      const du = sstep(0.62, 0.95, soil[i]) * 0.3;
      buf.mixTo(i, DIRT, du);
      const ln = lineA[i];
      buf.mixTo(i, [0.16, 0.18, 0.2], ln * 0.85);
      buf.hf[i] = (g - 0.5) * 0.1 + (fl - 0.5) * 0.15 - ln * 2.6;
      buf.rough[i] = 0.4 + (g - 0.5) * 0.08 + du * 0.3 + ln * 0.35;
    });
    buf.blendLayer(label, 0.9);
    return buf.build({ normal: 4.2, normalScale: 1 });
  });
}

/**
 * Motor bell: dark anodised aluminium with the copper windings shining through
 * the ventilation slots. **u runs around the can**, v along its axis – for a
 * CylinderGeometry side. 256², map + normal + roughness + metalness.
 */
export function pbrMotorBell(): PbrMaps {
  return cachedPbr(cacheKey("motorBell", []), () => {
    const W = 256;
    const H = 128;
    const buf = new TexBuf(W, H, rgb("#3a3f45"), 0.42, 0.85);
    const grain = noiseField(W, H, 751, { freq: 90, freqY: 8, oct: 2 });
    const COPPER = rgb("#b0642a");
    buf.each((i, u, v) => {
      const g = grain[i];
      // 12 slots around the circumference, only in the middle third of the can
      const slot = Math.abs(((u * 12) % 1) - 0.5) < 0.22 ? 1 : 0;
      const band = sstep(0.2, 0.3, v) * (1 - sstep(0.68, 0.78, v));
      const win = slot * band;
      buf.mul(i, 0.94 + (g - 0.5) * 0.18);
      buf.mixTo(i, COPPER, win * (0.55 + g * 0.4));
      buf.hf[i] = (g - 0.5) * 0.12 - win * 1.1;
      buf.rough[i] = 0.4 + (g - 0.5) * 0.1 + win * 0.28;
      buf.metal[i] = 0.85 - win * 0.15;
      // Turned ring grooves at the top and bottom edge
      const ring =
        sstep(0.03, 0.0, Math.abs(v - 0.12)) +
        sstep(0.03, 0.0, Math.abs(v - 0.88));
      buf.hf[i] -= ring * 0.5;
      buf.mul(i, 1 - ring * 0.15);
    });
    return buf.build({
      normal: 2.4,
      normalScale: 0.8,
      metal: true,
      wrapV: false,
    });
  });
}

/**
 * Rotor blur disc: radial alpha gradient with a few streaks, for a quad blended
 * additively/transparently above the propeller. 256², only `map` (alpha in
 * channel A) – use it as a MeshBasicMaterial with transparent.
 */
export function rotorBlurTexture(): THREE.Texture {
  return cachedTex(cacheKey("rotorBlur", []), () => {
    const S = 256;
    const [c, ctx] = makeCanvas(S, S);
    ctx.clearRect(0, 0, S, S);
    const R = S / 2;
    // Base disc: denser towards the outside (the blade tips sweep more area)
    const g = ctx.createRadialGradient(R, R, R * 0.1, R, R, R);
    g.addColorStop(0, "rgba(210,214,220,0.05)");
    g.addColorStop(0.55, "rgba(198,204,212,0.16)");
    g.addColorStop(0.9, "rgba(224,229,236,0.3)");
    g.addColorStop(0.98, "rgba(236,240,246,0.12)");
    g.addColorStop(1, "rgba(236,240,246,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(R, R, R, 0, Math.PI * 2);
    ctx.fill();
    // Streaks: individual lighter sectors hinting at the blade shadow
    ctx.globalCompositeOperation = "lighter";
    for (let k = 0; k < 22; k++) {
      const a0 = (k / 22) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(R, R);
      ctx.arc(R, R, R * 0.99, a0, a0 + 0.07);
      ctx.closePath();
      ctx.fillStyle = `rgba(255,255,255,${0.02 + (k % 3) * 0.012})`;
      ctx.fill();
    }
    // Hub ring
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = "rgba(150,156,164,0.45)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(R, R, R * 0.16, 0, Math.PI * 2);
    ctx.stroke();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  });
}
