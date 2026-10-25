// Procedural PBR sets for the vehicle, tools, metal and the station.
// The UV layouts are documented in a doc comment above each function.

import {
  type PbrMaps,
  type Rgb,
  TexBuf,
  TexRng,
  blurField,
  cacheKey,
  cachedPbr,
  clamp01,
  drawScratches,
  hash01,
  hashPix,
  lerp3,
  mix,
  noiseField,
  rgb,
  sampleF,
  sstep,
  stampBlob,
} from "./textures-core";

const PRIMER: Rgb = rgb("#8f8e88");
const BARE: Rgb = rgb("#b7babd");
const SAND: Rgb = rgb("#cdb994");
const RUST_DARK: Rgb = rgb("#4a2a15");
const RUST_MID: Rgb = rgb("#b4581e");
const RUST_LIGHT: Rgb = rgb("#c98a3e");

/** Rust color from two noise values (hue field, fine structure). */
export function rustColor(nc: number, nf: number): Rgb {
  const c = lerp3(
    lerp3(RUST_DARK, RUST_MID, sstep(0.25, 0.55, nc)),
    RUST_LIGHT,
    sstep(0.6, 0.85, nc),
  );
  const k = 0.9 + nf * 0.2;
  return [c[0] * k, c[1] * k, c[2] * k];
}

/**
 * Metallic car paint. UV: planar/box mapping per body part, u tileable,
 * **v = 0 bottom → v = 1 top** (dirt collects at the bottom, v is clamped).
 * 1024², map + normal + roughness + metalness. Chips reveal primer/bare metal.
 * Recommendation: MeshPhysicalMaterial with clearcoat 1, clearcoatRoughness 0.1.
 */
export function pbrCarPaint(
  colorHex: string | number,
  opts: { dirt?: number; scratches?: number } = {},
): PbrMaps {
  const dirt = clamp01(opts.dirt ?? 0.5);
  const scr = clamp01(opts.scratches ?? 0.5);
  return cachedPbr(cacheKey("carPaint", [colorHex, dirt, scr]), () => {
    const S = 1024;
    const rng = new TexRng(0xca71);
    const base = rgb(colorHex);
    const buf = new TexBuf(S, S, base, 0.32, 0.35);
    const nVar = noiseField(S, S, 101, { freq: 3, oct: 4 });
    const nDirt = noiseField(S, S, 102, { freq: 6, oct: 5, gain: 0.55 });
    const nFine = noiseField(S, S, 103, { freq: 48, oct: 3 });
    const scratchA = TexBuf.layerAlpha(
      buf.layer((ctx) =>
        drawScratches(ctx, rng, S, S, Math.round(25 + 90 * scr), 170, 1.1, 0.7),
      ),
      buf.n,
    );
    const chip = new Float32Array(buf.n);
    const nChips = 3 + Math.round(rng.next() * 7 * (0.3 + scr));
    for (let k = 0; k < nChips; k++) {
      // well spread over the lower two thirds (hash instead of RNG sequence)
      stampBlob(
        chip,
        S,
        S,
        hash01(k, 1, 0xca71) * S,
        S * (0.3 + hash01(k, 2, 0xca71) * 0.7),
        rng.range(6, 20),
        rng.range(5, 14),
        1,
        false,
      );
    }
    const rust = rgb("#7a4a22");
    buf.each((i, _u, v) => {
      const tv = 1 + (nVar[i] - 0.5) * 0.06;
      const fl = hashPix(i, 7);
      const spark = fl > 0.965 ? (fl - 0.965) / 0.035 : 0;
      let r = base[0] * tv + spark * 0.16;
      let g = base[1] * tv + spark * 0.16;
      let b = base[2] * tv + spark * 0.16;
      let hgt = (nFine[i] - 0.5) * 0.06 + (hashPix(i, 9) - 0.5) * 0.012;
      let ro = 0.3 + (nFine[i] - 0.5) * 0.06 + spark * 0.12;
      let me = 0.35 + spark * 0.5;
      const sc = scratchA[i];
      if (sc > 0.01) {
        r += (0.9 - r) * 0.15 * sc;
        g += (0.9 - g) * 0.15 * sc;
        b += (0.9 - b) * 0.15 * sc;
        hgt -= sc * 0.45;
        ro += sc * 0.25;
        me += sc * 0.15;
      }
      const dm = Math.min(
        0.85,
        dirt * (1 - sstep(0.05, 0.6, v)) * (0.35 + 0.65 * nDirt[i]) +
          dirt * 0.18 * nDirt[i] * nDirt[i],
      );
      if (dm > 0) {
        r += (SAND[0] - r) * dm;
        g += (SAND[1] - g) * dm;
        b += (SAND[2] - b) * dm;
        ro = mix(ro, 0.82, dm);
        me = mix(me, 0.03, dm);
        hgt += dm * 0.02 * (hashPix(i, 11) - 0.5);
      }
      const cm = sstep(0.42, 0.7, chip[i] + (nFine[i] - 0.5) * 0.4);
      if (cm > 0) {
        const bare = nVar[i] > 0.5;
        const cc = bare ? BARE : PRIMER;
        r = mix(r, cc[0], cm);
        g = mix(g, cc[1], cm);
        b = mix(b, cc[2], cm);
        hgt -= cm * 0.5;
        ro = mix(ro, bare ? 0.42 : 0.72, cm);
        me = mix(me, bare ? 1 : 0.02, cm);
        const edge = cm * (1 - cm) * 4 * 0.45;
        r = mix(r, rust[0], edge);
        g = mix(g, rust[1], edge);
        b = mix(b, rust[2], edge);
      }
      buf.r[i] = r;
      buf.g[i] = g;
      buf.b[i] = b;
      buf.hf[i] = hgt;
      buf.rough[i] = ro;
      buf.metal[i] = me;
    });
    return buf.build({
      wrapV: false,
      normal: 7,
      normalScale: 0.6,
      metal: true,
    });
  });
}

/**
 * Off-road tyre. UV: **u runs around the circumference** (tileable), **v
 * across the tyre** from the sidewall (0) over the tread (v 0.2–0.8) to the
 * other sidewall (1). Fits a LatheGeometry (u = phi, v = profile) or a torus
 * with swapped UVs. 1024×512, map + normal + roughness.
 */
export function pbrTire(): PbrMaps {
  return cachedPbr(cacheKey("tire", []), () => {
    const W = 1024;
    const H = 512;
    const buf = new TexBuf(W, H, rgb("#232527"), 0.9, 0);
    const nFine = noiseField(W, H, 201, { freq: 64, freqY: 32, oct: 3 });
    const nDust = noiseField(W, H, 202, { freq: 20, freqY: 10, oct: 4 });
    const nWear = noiseField(W, H, 203, { freq: 4, freqY: 2, oct: 3 });
    const letters = buf.layer((ctx) => {
      ctx.fillStyle = "#fff";
      ctx.font = "bold 30px Arial, Helvetica, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const txt = "DUNE RUNNER  ·  M+T 235/75 R15  ·  TUBELESS  ·";
      for (const yv of [0.09, 0.91]) {
        const y = (1 - yv) * H;
        for (const xo of [0.25, 0.75]) ctx.fillText(txt, xo * W, y, W * 0.46);
      }
    });
    const letterA = blurField(
      TexBuf.layerAlpha(letters, buf.n),
      W,
      H,
      1,
      true,
      false,
      1,
    );
    const N = 26; // lugs around the circumference
    const LUG = rgb("#2e3033");
    const GROOVE = rgb("#1b1c1e");
    const SIDE = rgb("#26282a");
    buf.each((i, u, v) => {
      let hgt: number;
      let ro: number;
      let r: number;
      let g: number;
      let b: number;
      let dust: number;
      const fine = (nFine[i] - 0.5) * 0.06;
      if (v > 0.2 && v < 0.8) {
        const row = v < 0.5 ? 0 : 1;
        const lv = row === 0 ? (v - 0.2) / 0.3 : (v - 0.5) / 0.3;
        const uu = u * N + (row === 1 ? 0.5 : 0);
        const lu = uu - Math.floor(uu) - 0.5;
        const luS = lu + (lv - 0.5) * 0.18;
        const mU = sstep(0.31, 0.23, Math.abs(luS));
        const mV = sstep(0.08, 0.11, lv) * sstep(0.94, 0.91, lv);
        let lug = mU * mV;
        const sipe = 1 - sstep(0.02, 0.05, Math.abs(lv - 0.5));
        lug *= 1 - sipe * 0.35;
        const cg = 1 - sstep(0.03, 0.045, Math.abs(v - 0.5));
        lug *= 1 - cg;
        const wear = lug * sstep(0.45, 0.8, nWear[i]);
        hgt = 0.15 + lug * 0.85 - wear * 0.08 + fine;
        const k = 1 + wear * 0.18;
        r = mix(GROOVE[0], LUG[0], lug) * k;
        g = mix(GROOVE[1], LUG[1], lug) * k;
        b = mix(GROOVE[2], LUG[2], lug) * k;
        ro = mix(0.92, 0.8, lug) - wear * 0.06;
        dust = (1 - lug) * sstep(0.55, 0.85, nDust[i]) * 0.3;
      } else {
        const sv = v < 0.5 ? v / 0.2 : (1 - v) / 0.2;
        hgt = 0.3 + sv * 0.1 + fine * 0.6;
        const d1 = (sv - 0.55) / 0.02;
        const d2 = (sv - 0.32) / 0.012;
        const ring1 = Math.exp(-(d1 * d1));
        const ring2 = Math.exp(-(d2 * d2));
        hgt += ring1 * 0.08 + ring2 * 0.05 + letterA[i] * 0.09;
        const k = 1 + letterA[i] * 0.12 + ring1 * 0.05;
        r = SIDE[0] * k;
        g = SIDE[1] * k;
        b = SIDE[2] * k;
        dust = sstep(0.7, 0.92, nDust[i]) * (1 - sv * 0.5) * 0.12;
        ro = 0.88;
      }
      buf.r[i] = r + (SAND[0] - r) * dust;
      buf.g[i] = g + (SAND[1] - g) * dust;
      buf.b[i] = b + (SAND[2] - b) * dust;
      buf.hf[i] = hgt;
      buf.rough[i] = ro + dust * 0.05;
    });
    return buf.build({ wrapV: false, normal: 4, normalScale: 1 });
  });
}

/**
 * Tyre sidewall for CylinderGeometry caps: planar, circle around (0.5, 0.5),
 * radius 0.5 = outer edge of the tyre. Rings, lettering around the
 * circumference, dark inside (r < 0.45, where the rim sits).
 * 512², map + normal + roughness.
 */
export function pbrTireSidewall(): PbrMaps {
  return cachedPbr(cacheKey("tireSidewall", []), () => {
    const S = 512;
    const buf = new TexBuf(S, S, rgb("#26282a"), 0.88, 0);
    const nFine = noiseField(S, S, 211, { freq: 40, oct: 3 });
    const nDust = noiseField(S, S, 212, { freq: 5, oct: 4 });
    const letters = buf.layer((ctx) => {
      ctx.fillStyle = "#fff";
      ctx.font = "bold 22px Arial, Helvetica, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const txt =
        "DUNE RUNNER · M+T 235/75 R15 · DUNE RUNNER · M+T 235/75 R15 · ";
      const R = S * 0.39;
      const step = (Math.PI * 2) / txt.length;
      for (let k = 0; k < txt.length; k++) {
        ctx.save();
        ctx.translate(S / 2, S / 2);
        ctx.rotate(k * step);
        ctx.fillText(txt[k], 0, -R);
        ctx.restore();
      }
    });
    const letterA = blurField(
      TexBuf.layerAlpha(letters, buf.n),
      S,
      S,
      1,
      false,
      false,
      1,
    );
    const SIDE = rgb("#26282a");
    buf.each((i, u, v) => {
      const dx = u - 0.5;
      const dy = v - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2;
      let hgt = 0.35 + (nFine[i] - 0.5) * 0.04;
      const d1 = (r - 0.62) / 0.012;
      const d2 = (r - 0.9) / 0.015;
      hgt += Math.exp(-(d1 * d1)) * 0.07 + Math.exp(-(d2 * d2)) * 0.05;
      hgt += letterA[i] * 0.09;
      const inner = 1 - sstep(0.44, 0.47, r);
      hgt -= inner * 0.3;
      const k = 1 + letterA[i] * 0.12 - inner * 0.35;
      const dust = sstep(0.7, 0.92, nDust[i]) * 0.12;
      buf.r[i] = mix(SIDE[0] * k, SAND[0], dust);
      buf.g[i] = mix(SIDE[1] * k, SAND[1], dust);
      buf.b[i] = mix(SIDE[2] * k, SAND[2], dust);
      buf.hf[i] = hgt;
      buf.rough[i] = 0.88 + dust * 0.1;
    });
    return buf.build({ wrapU: false, wrapV: false, normal: 4, normalScale: 1 });
  });
}

/**
 * Steel rim. UV: planar, circle around (0.5, 0.5), radius 0.5 = rim edge
 * (CircleGeometry / cylinder cap). 5 spoke windows, 5 wheel bolts, hub,
 * scrapes down to bare metal. 512², map + normal + roughness + metalness.
 */
export function pbrRim(opts: { colorHex?: string | number } = {}): PbrMaps {
  const hex = opts.colorHex ?? "#4e5255";
  return cachedPbr(cacheKey("rim", [hex]), () => {
    const S = 512;
    const rng = new TexRng(0x21f);
    const base = rgb(hex);
    const buf = new TexBuf(S, S, base, 0.48, 0.85);
    const nFine = noiseField(S, S, 221, { freq: 48, oct: 3 });
    const nVar = noiseField(S, S, 222, { freq: 4, oct: 4 });
    const nDirt = noiseField(S, S, 223, { freq: 10, oct: 4 });
    const scratchA = TexBuf.layerAlpha(
      buf.layer((ctx) => drawScratches(ctx, rng, S, S, 90, 60, 1.1, 0.8)),
      buf.n,
    );
    const DIRT = rgb("#4a4238");
    const BOLT = rgb("#9ea3a6");
    const TWO_PI = Math.PI * 2;
    buf.each((i, u, v) => {
      const dx = u - 0.5;
      const dy = v - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2;
      const ang = Math.atan2(dy, dx);
      const a5 = ((((ang / TWO_PI) * 5) % 1) + 1) % 1;
      const sd = Math.min(a5, 1 - a5); // 0 = centre of the spoke
      let hgt = 0.5;
      let ro = 0.48 + (nVar[i] - 0.5) * 0.16 + (nFine[i] - 0.5) * 0.06;
      let me = 0.85;
      // Rim flange + lip
      const flange = sstep(0.85, 0.87, r);
      hgt = mix(hgt, 0.58, flange);
      hgt += sstep(0.95, 0.97, r) * 0.14;
      // Drop centre
      const bead = sstep(0.76, 0.78, r) * (1 - sstep(0.84, 0.86, r));
      hgt = mix(hgt, 0.3, bead);
      // Spoke windows
      const win =
        sstep(0.34, 0.37, r) * (1 - sstep(0.7, 0.73, r)) * sstep(0.2, 0.24, sd);
      hgt = mix(hgt, 0.05, win);
      // Hub + cap
      const hub = 1 - sstep(0.19, 0.21, r);
      hgt = mix(hgt, 0.62, hub);
      hgt += (1 - sstep(0.08, 0.1, r)) * 0.14;
      // Wheel bolts on the spoke axis (r = 0.27): nearest one via the angle
      const ba = (Math.round((ang / TWO_PI) * 5) / 5) * TWO_PI;
      const bx = Math.cos(ba) * 0.135 - dx;
      const by = Math.sin(ba) * 0.135 - dy;
      const bolt = 1 - sstep(0.018, 0.024, Math.sqrt(bx * bx + by * by));
      hgt = mix(hgt, 0.88, bolt);
      const boltRing = bolt * (1 - bolt) * 4;
      // Color
      const tv =
        (1 + (nVar[i] - 0.5) * 0.08 + (nFine[i] - 0.5) * 0.03) *
        (1 - boltRing * 0.3);
      let cr = mix(base[0] * tv, BOLT[0], bolt);
      let cg = mix(base[1] * tv, BOLT[1], bolt);
      let cb = mix(base[2] * tv, BOLT[2], bolt);
      const dirt = (win * 0.35 + bead * 0.3) * sstep(0.35, 0.8, nDirt[i]);
      cr += (DIRT[0] - cr) * dirt;
      cg += (DIRT[1] - cg) * dirt;
      cb += (DIRT[2] - cb) * dirt;
      ro = mix(ro, 0.85, dirt);
      me = mix(me, 0.2, dirt);
      ro = mix(ro, 0.4, bolt);
      me = mix(me, 1, bolt);
      const sc = scratchA[i] * (1 - win) * 0.8;
      cr += (BARE[0] - cr) * sc;
      cg += (BARE[1] - cg) * sc;
      cb += (BARE[2] - cb) * sc;
      ro = mix(ro, 0.35, sc);
      me = mix(me, 1, sc);
      hgt -= sc * 0.08;
      hgt += (nFine[i] - 0.5) * 0.02;
      const out = sstep(0.99, 1.0, r);
      buf.r[i] = cr + (0.1 - cr) * out;
      buf.g[i] = cg + (0.1 - cg) * out;
      buf.b[i] = cb + (0.1 - cb) * out;
      buf.hf[i] = hgt;
      buf.rough[i] = ro;
      buf.metal[i] = me;
    });
    return buf.build({
      wrapU: false,
      wrapV: false,
      normal: 5,
      normalScale: 1,
      metal: true,
    });
  });
}

/**
 * Brushed metal, tileable, brush direction along u. 512²,
 * map + normal (fine) + roughness + metalness.
 */
export function pbrBrushedMetal(tintHex: string | number = "#b8bcc0"): PbrMaps {
  return cachedPbr(cacheKey("brushed", [tintHex]), () => {
    const S = 512;
    const tint = rgb(tintHex);
    const buf = new TexBuf(S, S, tint, 0.38, 0.97);
    const nStreak = noiseField(S, S, 301, {
      freq: 2,
      freqY: 256,
      oct: 3,
      gain: 0.6,
    });
    const nVar = noiseField(S, S, 302, { freq: 3, oct: 4 });
    const nSm = noiseField(S, S, 303, { freq: 4, oct: 3 });
    buf.each((i) => {
      const st = nStreak[i];
      const k = 0.9 + st * 0.2 + (nVar[i] - 0.5) * 0.06;
      buf.r[i] = tint[0] * k;
      buf.g[i] = tint[1] * k;
      buf.b[i] = tint[2] * k;
      buf.hf[i] = st * 0.03;
      const smudge = sstep(0.55, 0.85, nSm[i]);
      buf.rough[i] = 0.34 + (st - 0.5) * 0.14 + smudge * 0.14;
      buf.metal[i] = 1 - smudge * 0.1;
    });
    return buf.build({ normal: 6, normalScale: 0.5, metal: true });
  });
}

/**
 * Painted/anodised metal with scrapes, pitting and grime (bumpers, tools,
 * litter picker). Tileable, 512², map + normal + roughness + metalness.
 */
export function pbrScuffedMetal(tintHex: string | number): PbrMaps {
  return cachedPbr(cacheKey("scuffed", [tintHex]), () => {
    const S = 512;
    const rng = new TexRng(0x5c0f);
    const tint = rgb(tintHex);
    const buf = new TexBuf(S, S, tint, 0.5, 0.8);
    const nVar = noiseField(S, S, 311, { freq: 3, oct: 4 });
    const nPit = noiseField(S, S, 312, { freq: 40, oct: 2 });
    const nScuff = noiseField(S, S, 313, { freq: 5, oct: 4 });
    const nGrime = noiseField(S, S, 314, { freq: 8, oct: 4 });
    const nFine = noiseField(S, S, 315, { freq: 64, oct: 2 });
    const scratchA = TexBuf.layerAlpha(
      buf.layer((ctx) => drawScratches(ctx, rng, S, S, 70, 120, 1.0, 0.6)),
      buf.n,
    );
    const GRIME = rgb("#3a342c");
    buf.each((i) => {
      const tv = 1 + (nVar[i] - 0.5) * 0.08;
      let col: Rgb = [tint[0] * tv, tint[1] * tv, tint[2] * tv];
      let hgt = (nFine[i] - 0.5) * 0.04;
      let ro = 0.5 + (nFine[i] - 0.5) * 0.08;
      let me = 0.8;
      const scuff = sstep(0.6, 0.8, nScuff[i]);
      col = lerp3(
        col,
        [col[0] * 1.15 + 0.05, col[1] * 1.15 + 0.05, col[2] * 1.15 + 0.05],
        scuff * 0.5,
      );
      ro += scuff * 0.2;
      const grime = sstep(0.55, 0.85, nGrime[i]);
      col = lerp3(col, GRIME, grime * 0.35);
      ro += grime * 0.25;
      me -= grime * 0.3;
      const pit = sstep(0.78, 0.86, nPit[i]);
      col = [
        col[0] * (1 - pit * 0.5),
        col[1] * (1 - pit * 0.5),
        col[2] * (1 - pit * 0.5),
      ];
      hgt -= pit * 0.3;
      ro += pit * 0.3;
      const sc = scratchA[i];
      col = lerp3(col, BARE, sc * 0.6);
      ro = mix(ro, 0.35, sc);
      me = mix(me, 1, sc);
      hgt -= sc * 0.15;
      buf.set(i, col);
      buf.hf[i] = hgt;
      buf.rough[i] = ro;
      buf.metal[i] = me;
    });
    return buf.build({ normal: 5, normalScale: 0.8, metal: true });
  });
}

/**
 * Rusty sheet metal. Rust blooms out of the pitting and – with `edges`
 * (default true) – inwards from the UV borders (not tileable then; ideal for a
 * single panel/drum). `rustAmount` 0..1.
 * 512², map + normal + roughness + metalness.
 */
export function pbrRustyMetal(
  baseHex: string | number,
  rustAmount: number,
  opts: { edges?: boolean } = {},
): PbrMaps {
  const rust = clamp01(rustAmount);
  const edges = opts.edges !== false;
  return cachedPbr(cacheKey("rusty", [baseHex, rust, edges]), () => {
    const S = 512;
    const base = rgb(baseHex);
    const buf = new TexBuf(S, S, base, 0.45, 0.9);
    const nR = noiseField(S, S, 321, { freq: 4, oct: 5, gain: 0.55 });
    const nW = noiseField(S, S, 322, { freq: 3, oct: 3 });
    const nP = noiseField(S, S, 323, { freq: 48, oct: 2 });
    const nC = noiseField(S, S, 324, { freq: 12, oct: 4 });
    const nF = noiseField(S, S, 325, { freq: 80, oct: 2 });
    const nS = noiseField(S, S, 326, { freq: 24, freqY: 2, oct: 3 });
    const nVar = noiseField(S, S, 327, { freq: 3, oct: 4 });
    const th = 0.95 - rust * 0.85;
    buf.each((i, u, v, x, y) => {
      const wx = (nW[i] - 0.5) * 0.15;
      const rw = sampleF(nR, S, S, x / S + wx, y / S - wx * 0.7);
      let m = sstep(th - 0.18, th + 0.12, rw);
      if (edges) {
        const e = Math.min(u, 1 - u, v, 1 - v);
        const et = 1 - sstep(0, 0.16, e);
        m = Math.max(m, et * sstep(0.25, 0.6, rw) * Math.min(1, rust * 1.4));
      }
      const pit = sstep(0.8, 0.88, nP[i]);
      m = Math.min(
        1,
        m + sstep(0.62, 0.8, nP[i]) * 0.8 * Math.min(1, rust * 2 + 0.2),
      );
      const rc = rustColor(nC[i], nF[i]);
      const tv = 1 + (nVar[i] - 0.5) * 0.08;
      let col: Rgb = lerp3([base[0] * tv, base[1] * tv, base[2] * tv], rc, m);
      let hgt = m * nF[i] * 0.18 - pit * 0.4 + (nF[i] - 0.5) * 0.02;
      let ro = mix(0.45, 0.92, m) + pit * 0.1;
      let me = mix(0.9, 0.05, m);
      // Rust streaks run downwards (−v)
      const streak =
        sstep(0.62, 0.82, nS[i]) * (1 - m) * rust * 0.6 * sstep(1, 0.3, v);
      col = lerp3(col, RUST_MID, streak * 0.5);
      ro += streak * 0.25;
      me -= streak * 0.4;
      buf.set(i, col);
      buf.hf[i] = hgt;
      buf.rough[i] = ro;
      buf.metal[i] = me;
    });
    return buf.build({
      wrapU: !edges,
      wrapV: !edges,
      normal: 4,
      normalScale: 0.9,
      metal: true,
    });
  });
}

/**
 * Seat cover (jeep). Tileable; two seams per tile at v = 0.25 / 0.75 with
 * quilting stitches along u. `vinyl` = imitation-leather grain instead of a
 * woven fabric. 512², map + normal + roughness.
 */
export function pbrSeatFabric(
  colorHex: string | number,
  opts: { vinyl?: boolean } = {},
): PbrMaps {
  const vinyl = opts.vinyl === true;
  return cachedPbr(cacheKey("seat", [colorHex, vinyl]), () => {
    const S = 512;
    const base = rgb(colorHex);
    const buf = new TexBuf(S, S, base, vinyl ? 0.5 : 0.9, 0);
    const nVar = noiseField(S, S, 331, { freq: 3, oct: 4 });
    const nDirt = noiseField(S, S, 332, { freq: 6, oct: 4 });
    const nGrain = noiseField(S, S, 333, { freq: 60, oct: 2, mode: "billow" });
    const nFine = noiseField(S, S, 334, { freq: 90, oct: 2 });
    const THREAD = rgb("#d8cfb8");
    const BLEACH: Rgb = [0.86, 0.84, 0.78];
    const TWO_PI = Math.PI * 2;
    buf.each((i, u, v, x) => {
      let hgt: number;
      let k = 1;
      if (vinyl) {
        hgt = nGrain[i] * 0.1 + (nFine[i] - 0.5) * 0.03;
        k += (nGrain[i] - 0.5) * 0.06;
      } else {
        const weave = Math.sin(u * TWO_PI * 180) * Math.sin(v * TWO_PI * 180);
        hgt = weave * 0.05 + (nFine[i] - 0.5) * 0.06;
        k += weave * 0.05 + (nFine[i] - 0.5) * 0.08;
      }
      let col: Rgb = [base[0] * k, base[1] * k, base[2] * k];
      const fade = sstep(0.45, 0.85, nVar[i]) * 0.12;
      col = lerp3(col, BLEACH, fade);
      const dirt = sstep(0.55, 0.85, nDirt[i]) * 0.15;
      col = [
        col[0] * (1 - dirt * 0.5),
        col[1] * (1 - dirt * 0.55),
        col[2] * (1 - dirt * 0.6),
      ];
      let ro = (vinyl ? 0.5 : 0.9) + dirt * 0.1 - fade * 0.05;
      // Seams
      for (const sv of [0.25, 0.75]) {
        const d = Math.abs(v - sv) * S;
        const groove = Math.exp(-((d / 3) ** 2));
        hgt -= groove * 0.15;
        const stitch = (x % 14 < 8 ? 1 : 0) * Math.exp(-((d / 1.6) ** 2));
        hgt += stitch * 0.14;
        col = lerp3(col, THREAD, stitch);
        ro = mix(ro, 0.7, stitch);
      }
      buf.set(i, col);
      buf.hf[i] = hgt;
      buf.rough[i] = ro;
    });
    return buf.build({ normal: 5, normalScale: 0.7 });
  });
}

/**
 * Dashboard: dark grained hard plastic with dust in the recesses.
 * Tileable, 512², map + normal + roughness.
 */
export function pbrDashboard(colorHex: string | number = "#2b2d30"): PbrMaps {
  return cachedPbr(cacheKey("dashboard", [colorHex]), () => {
    const S = 512;
    const rng = new TexRng(0xda5);
    const base = rgb(colorHex);
    const buf = new TexBuf(S, S, base, 0.62, 0);
    const nGrain = noiseField(S, S, 341, { freq: 90, oct: 2, mode: "billow" });
    const nDust = noiseField(S, S, 342, { freq: 5, oct: 4 });
    const nVar = noiseField(S, S, 343, { freq: 3, oct: 3 });
    const scratchA = TexBuf.layerAlpha(
      buf.layer((ctx) => drawScratches(ctx, rng, S, S, 40, 80, 0.9, 0.5)),
      buf.n,
    );
    const DUST = rgb("#6e6c66");
    buf.each((i) => {
      const gr = nGrain[i];
      const k =
        1 +
        (gr - 0.5) * 0.1 +
        (nVar[i] - 0.5) * 0.06 +
        (hashPix(i, 3) - 0.5) * 0.04;
      let col: Rgb = [base[0] * k, base[1] * k, base[2] * k];
      const dust = (1 - gr) * sstep(0.5, 0.85, nDust[i]) * 0.35;
      col = lerp3(col, DUST, dust);
      const sc = scratchA[i];
      col = lerp3(col, [0.5, 0.5, 0.5], sc * 0.4);
      buf.set(i, col);
      buf.hf[i] = gr * 0.1 - sc * 0.06;
      buf.rough[i] = 0.62 + (gr - 0.5) * 0.1 + dust * 0.25 + sc * 0.15;
    });
    return buf.build({ normal: 5, normalScale: 0.6 });
  });
}

/**
 * Concrete (floor slab, ramp). Tileable, 512², map + normal + roughness.
 */
export function pbrConcrete(): PbrMaps {
  return cachedPbr(cacheKey("concrete", []), () => {
    const S = 512;
    const base = rgb("#9c9a94");
    const buf = new TexBuf(S, S, base, 0.9, 0);
    const nM = noiseField(S, S, 351, { freq: 6, oct: 5 });
    const nP = noiseField(S, S, 352, { freq: 60, oct: 2 });
    const nS = noiseField(S, S, 353, { freq: 3, oct: 3 });
    const nCr = noiseField(S, S, 354, {
      freq: 4,
      oct: 4,
      mode: "ridged",
      gain: 0.5,
    });
    const nF = noiseField(S, S, 355, { freq: 100, oct: 2 });
    buf.each((i) => {
      let k = 1 + (nM[i] - 0.5) * 0.16 + (nF[i] - 0.5) * 0.06;
      const hp = hashPix(i, 5);
      if (hp > 0.985) k += 0.18;
      else if (hp < 0.012) k -= 0.2;
      let col: Rgb = [base[0] * k, base[1] * k, base[2] * k];
      let hgt = (nM[i] - 0.5) * 0.12 + (nF[i] - 0.5) * 0.05;
      let ro = 0.9 + (nF[i] - 0.5) * 0.06;
      const pore = sstep(0.8, 0.88, nP[i]);
      col = [
        col[0] * (1 - pore * 0.45),
        col[1] * (1 - pore * 0.45),
        col[2] * (1 - pore * 0.45),
      ];
      hgt -= pore * 0.3;
      const stain = sstep(0.55, 0.8, nS[i]);
      col = [
        col[0] * (1 - stain * 0.18),
        col[1] * (1 - stain * 0.19),
        col[2] * (1 - stain * 0.2),
      ];
      ro -= stain * 0.12;
      const crack = sstep(0.93, 0.98, nCr[i]);
      col = [
        col[0] * (1 - crack * 0.5),
        col[1] * (1 - crack * 0.5),
        col[2] * (1 - crack * 0.5),
      ];
      hgt -= crack * 0.5;
      buf.set(i, col);
      buf.hf[i] = hgt;
      buf.rough[i] = ro;
    });
    return buf.build({ normal: 4, normalScale: 0.8 });
  });
}

/**
 * Galvanised corrugated sheet (roof/wall). Tileable; 8 waves along u, screws
 * in one row at v = 0.8 with rust streaks running down. 512²,
 * map + normal + roughness + metalness.
 */
export function pbrCorrugatedSheet(): PbrMaps {
  return cachedPbr(cacheKey("corrugated", []), () => {
    const S = 512;
    const base = rgb("#8e969b");
    const buf = new TexBuf(S, S, base, 0.4, 0.9);
    const nC = noiseField(S, S, 361, { freq: 12, oct: 4 });
    const nF = noiseField(S, S, 362, { freq: 80, oct: 2 });
    const nS = noiseField(S, S, 363, { freq: 32, freqY: 3, oct: 3 });
    const nR = noiseField(S, S, 364, { freq: 5, oct: 4 });
    const nCell = noiseField(S, S, 365, { freq: 20, oct: 1 });
    const WAVES = 8;
    const TWO_PI = Math.PI * 2;
    buf.each((i, u, v) => {
      const wave = 0.5 + 0.5 * Math.sin(u * TWO_PI * WAVES);
      let hgt = wave + (nF[i] - 0.5) * 0.03;
      // Spangle: cell-like tinting
      const cell = hashPix(Math.floor(nCell[i] * 40) + 17, 8);
      const k = 1 + (cell - 0.5) * 0.1 + (nF[i] - 0.5) * 0.04;
      let col: Rgb = [base[0] * k, base[1] * k, base[2] * k];
      let ro = 0.4 + (cell - 0.5) * 0.1;
      let me = 0.9;
      // Screw on every second wave crest
      const cellU = u * WAVES;
      const crestIdx = Math.round(cellU - 0.25);
      let bolt = 0;
      let streak = 0;
      if (crestIdx % 2 === 0) {
        const bu = (crestIdx + 0.25) / WAVES;
        const ddx = (u - bu) * S;
        const ddy = (v - 0.8) * S;
        bolt = 1 - sstep(4, 6, Math.sqrt(ddx * ddx + ddy * ddy));
        const below = v < 0.8 ? sstep(0.8, 0.45, v) : 0;
        streak =
          below *
          (1 - sstep(0.012, 0.03, Math.abs(u - bu))) *
          sstep(0.5, 0.8, nS[i]);
      }
      hgt += bolt * 0.35;
      col = lerp3(col, rgb("#6e7478"), bolt);
      // Rust: streaks, patches, lower edge
      let rust = Math.max(streak, sstep(0.72, 0.88, nR[i]) * 0.7);
      rust = Math.max(
        rust,
        (1 - sstep(0.02, 0.14, v)) * sstep(0.35, 0.6, nR[i]),
      );
      rust = Math.min(1, rust);
      const rc = rustColor(nC[i], nF[i]);
      col = lerp3(col, rc, rust);
      ro = mix(ro, 0.9, rust);
      me = mix(me, 0.1, rust);
      hgt += rust * nF[i] * 0.06;
      buf.set(i, col);
      buf.hf[i] = hgt;
      buf.rough[i] = ro;
      buf.metal[i] = me;
    });
    return buf.build({ normal: 4, normalScale: 1, metal: true });
  });
}
