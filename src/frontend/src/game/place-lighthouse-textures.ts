// Procedural textures for the Saltreach lighthouse (place-lighthouse.ts):
// the banded painted-masonry face of the tower (u once around, v = height –
// the red/white bands, weathering streaks, salt bloom and hairline render
// cracks are painted into the sheet), the whitewashed interior with its damp
// staining, a dress atlas for the door, breaker box, plaque and keeper's
// clutter, and the verdigris copper of the lantern roof. Deterministic and
// cached like the rest of the PBR library.

import * as THREE from "three";
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
  lerp3,
  makeCanvas,
  noiseField,
  rgb,
  sstep,
} from "./textures-core";

const TAU = Math.PI * 2;

/** Atlas region [u0, v0, u1, v1]. */
export type UvRegion = readonly [number, number, number, number];

/**
 * Fractions of the shaft height (v of the masonry sheet) where the paint
 * bands change. v runs from the buried wall foot to the gallery corbels.
 */
export const BAND_EDGES = [0.22, 0.46, 0.68, 0.9] as const;

// ---------------------------------------------------------------------------
// Banded exterior masonry
// ---------------------------------------------------------------------------

/**
 * Painted masonry of the tower: broad red/white horizontal bands over
 * rendered stone, faint block courses ghosting through the paint, rain
 * streaks bleeding down from the band edges, powdery salt bloom around the
 * foot, chips at the band boundaries showing grey render, and a few hairline
 * cracks. u wraps once around the tower, v spans the shaft height (clamped).
 */
export function pbrLighthouseMasonry(size: number): PbrMaps {
  return cachedPbr(cacheKey("lhMasonry", [size]), () => {
    const S = size;
    const k = S / 1024;
    const rng = new TexRng(0x11a57);
    const WHITE: Rgb = rgb("#e9e4d8");
    const RED: Rgb = rgb("#a03a2e");
    const RED_FADE: Rgb = rgb("#b25a48");
    const RENDER: Rgb = rgb("#97918a");
    const SALT: Rgb = rgb("#efece2");
    const GRIME: Rgb = rgb("#5c584f");
    const buf = new TexBuf(S, S, WHITE, 0.66, 0);

    const nVar = noiseField(S, S, 7401, { freq: 5, oct: 4 });
    const nStreak = noiseField(S, S, 7402, { freq: 34, freqY: 3, oct: 3 });
    const nBloom = noiseField(S, S, 7403, { freq: 8, oct: 4, mode: "billow" });
    const nChip = noiseField(S, S, 7404, { freq: 26, oct: 3 });
    const nFade = noiseField(S, S, 7405, { freq: 3, oct: 3 });
    const nGrain = noiseField(S, S, 7406, { freq: 60, oct: 2 });

    // Hairline render cracks: wandering polylines, mostly vertical-ish
    const cracks = buf.layer((ctx) => {
      ctx.strokeStyle = "rgba(58,52,46,0.55)";
      ctx.lineCap = "round";
      for (let c = 0; c < 26; c++) {
        let x = rng.next() * S;
        let y = rng.next() * S * 0.9;
        const len = 5 + rng.int(9);
        ctx.lineWidth = Math.max(0.7, rng.range(0.7, 1.5) * k);
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (let s = 0; s < len; s++) {
          x += rng.gauss() * 14 * k;
          y += rng.range(8, 26) * k;
          ctx.lineTo(x, y);
          if (rng.chance(0.2)) {
            // short side branch
            ctx.moveTo(x, y);
            ctx.lineTo(x + rng.gauss() * 20 * k, y + rng.range(6, 18) * k);
            ctx.moveTo(x, y);
          }
        }
        ctx.stroke();
      }
    });
    const crackA = TexBuf.layerAlpha(cracks, buf.n);

    // Course joints of the masonry ghosting through the paint: ~46 courses
    // with staggered vertical joints, as a faint height field
    const COURSES = 46;
    const joint = new Float32Array(buf.n);
    {
      const ch = S / COURSES;
      for (let y = 0; y < S; y++) {
        const cy = y / ch;
        const row = Math.floor(cy);
        const fy = cy - row;
        const j = Math.max(0, 1 - Math.abs(fy - 0.5) * ch * 0.55);
        const off = (row % 2) * 0.5;
        for (let x = 0; x < S; x++) {
          let v = j * 0.7;
          // vertical joints every ~1/12 of the circumference, staggered
          const cx = (x / S) * 12 + off;
          const fx = Math.abs(cx - Math.round(cx));
          if (fy > 0.12 && fy < 0.88) {
            v = Math.max(v, Math.max(0, 1 - fx * S * 0.055) * 0.55);
          }
          joint[y * S + x] = v;
        }
      }
      blurField(joint, S, S, Math.max(1, Math.round(1.2 * k)), true, false, 1);
    }

    const bandAt = (v: number): number => {
      // 0 = white, 1 = red; bands from the foot upwards W R W R W
      if (v < BAND_EDGES[0]) return 0;
      if (v < BAND_EDGES[1]) return 1;
      if (v < BAND_EDGES[2]) return 0;
      if (v < BAND_EDGES[3]) return 1;
      return 0;
    };
    const edgeDist = (v: number): number => {
      let d = 1;
      for (const e of BAND_EDGES) d = Math.min(d, Math.abs(v - e));
      return d;
    };

    buf.each((i, _u, v) => {
      const red = bandAt(v);
      // Paint fades patchily; red chalks towards a lighter, colder tone
      const fade = sstep(0.35, 0.8, nFade[i]) * 0.55;
      let col = red > 0.5 ? lerp3(RED, RED_FADE, fade) : WHITE;
      const tone =
        0.94 +
        nVar[i] * 0.1 +
        (nGrain[i] - 0.5) * 0.05 +
        (hashPix(i, 3) - 0.5) * 0.045;
      col = [col[0] * tone, col[1] * tone, col[2] * tone];
      let rough = 0.62 + nVar[i] * 0.12;
      let h = (nVar[i] - 0.5) * 0.25 + (nGrain[i] - 0.5) * 0.1;

      // Course joints ghosting through the paint film
      const j = joint[i];
      h -= j * 0.35;
      const jd = 1 - j * 0.16;
      col = [col[0] * jd, col[1] * jd, col[2] * jd];

      // Rain streaks running down, strongest just below the band edges
      const below =
        v < BAND_EDGES[3] + 0.02 ? sstep(0.02, 0.006, edgeDist(v)) : 0;
      const streak =
        sstep(0.58, 0.85, nStreak[i]) * (0.3 + 0.7 * below + 0.25 * nVar[i]);
      col = lerp3(col, GRIME, Math.min(0.42, streak * 0.4));
      rough += streak * 0.14;

      // Chips at the band boundaries: paint gone, grey render showing
      const chip =
        sstep(0.016, 0.004, edgeDist(v)) * sstep(0.62, 0.78, nChip[i]);
      if (chip > 0) {
        col = lerp3(col, RENDER, Math.min(1, chip * 1.4));
        h -= chip * 0.5;
        rough += chip * 0.2;
      }

      // Salt bloom around the foot: powdery pale crust, high roughness
      const bloom =
        sstep(0.2, 0.04, v) * sstep(0.45, 0.75, nBloom[i]) * (0.4 + 0.6 * v);
      col = lerp3(col, SALT, Math.min(0.8, bloom * 1.1));
      rough += bloom * 0.3;
      h += bloom * 0.2;
      // Green algal tide right at the foot
      const algae = sstep(0.045, 0.0, v) * sstep(0.3, 0.7, nBloom[i]);
      col = lerp3(col, rgb("#6c7358"), algae * 0.5);

      // Grime collecting under the gallery
      const grime = sstep(0.94, 1.0, v) * 0.35;
      col = lerp3(col, GRIME, grime);

      // Cracks
      const cr = crackA[i];
      if (cr > 0.02) {
        const cd = 1 - cr * 0.55;
        col = [col[0] * cd, col[1] * cd, col[2] * cd];
        h -= cr * 0.9;
      }

      buf.set(i, col);
      buf.hf[i] = h;
      buf.rough[i] = Math.min(0.96, rough);
    });
    return buf.build({ wrapV: false, normal: 3.2, normalScale: 0.65 });
  });
}

// ---------------------------------------------------------------------------
// Whitewashed interior
// ---------------------------------------------------------------------------

/**
 * Interior of the tower: old limewash over rough masonry, grey-green damp
 * maps crawling up from the floor and bleeding down from the windows, flaked
 * patches showing the plaster brown, faint course shadows. u wraps once
 * around the drum, v spans the interior height.
 */
export function pbrLighthouseInterior(size: number): PbrMaps {
  return cachedPbr(cacheKey("lhInterior", [size]), () => {
    const S = size;
    const k = S / 1024;
    const rng = new TexRng(0x11a58);
    const LIME: Rgb = rgb("#e3ded1");
    const PLASTER: Rgb = rgb("#b3a288");
    const DAMP: Rgb = rgb("#77816f");
    const buf = new TexBuf(S, S, LIME, 0.85, 0);
    const nVar = noiseField(S, S, 7411, { freq: 4, oct: 4 });
    const nFlake = noiseField(S, S, 7412, { freq: 14, oct: 4, mode: "billow" });
    const nDamp = noiseField(S, S, 7413, { freq: 6, oct: 4 });
    const nStreak = noiseField(S, S, 7414, { freq: 40, freqY: 4, oct: 3 });
    const nGrain = noiseField(S, S, 7415, { freq: 70, oct: 2 });

    // A few long limewash runs / brush sags
    const runs = buf.layer((ctx) => {
      ctx.strokeStyle = "rgba(255,252,244,0.35)";
      ctx.lineCap = "round";
      for (let c = 0; c < 30; c++) {
        const x = rng.next() * S;
        const y = rng.next() * S;
        ctx.lineWidth = rng.range(2, 6) * k;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + rng.gauss() * 6 * k, y + rng.range(20, 90) * k);
        ctx.stroke();
      }
    });
    const runA = TexBuf.layerAlpha(runs, buf.n);

    buf.each((i, _u, v) => {
      const tone =
        0.93 + nVar[i] * 0.1 + (nGrain[i] - 0.5) * 0.07 + runA[i] * 0.06;
      let col: Rgb = [LIME[0] * tone, LIME[1] * tone, LIME[2] * tone];
      let rough = 0.85 + (nVar[i] - 0.5) * 0.08;
      let h = (nVar[i] - 0.5) * 0.3 + (nGrain[i] - 0.5) * 0.12;

      // Flaked limewash showing plaster
      const flake = sstep(0.72, 0.84, nFlake[i]);
      if (flake > 0) {
        col = lerp3(col, PLASTER, Math.min(1, flake * 1.5));
        h -= flake * 0.6;
        rough += flake * 0.08;
      }
      // Damp: rising from the foot, and streaks running down the drum
      const rise = sstep(0.16, 0.0, v);
      const streakD = sstep(0.6, 0.85, nStreak[i]) * sstep(0.35, 0.7, nDamp[i]);
      const damp = Math.min(
        0.75,
        rise * (0.35 + 0.5 * nDamp[i]) + streakD * 0.5,
      );
      col = lerp3(col, DAMP, damp);
      rough -= damp * 0.18;

      buf.set(i, col);
      buf.hf[i] = h;
      buf.rough[i] = rough;
    });
    return buf.build({ wrapV: false, normal: 2.6, normalScale: 0.6 });
  });
}

// ---------------------------------------------------------------------------
// Dress atlas: door, breaker box, plaque, label, keeper's clutter
// ---------------------------------------------------------------------------

export const LH_DRESS_UV: Record<
  | "door"
  | "planks"
  | "breaker"
  | "brass"
  | "label"
  | "oilcan"
  | "rope"
  | "book"
  | "steel",
  UvRegion
> = {
  door: [0.0, 0.0, 0.42, 1.0],
  planks: [0.44, 0.005, 0.72, 0.3],
  breaker: [0.44, 0.32, 0.72, 0.75],
  brass: [0.44, 0.77, 0.72, 0.995],
  label: [0.74, 0.86, 0.995, 0.995],
  oilcan: [0.74, 0.56, 0.995, 0.84],
  rope: [0.74, 0.28, 0.995, 0.54],
  book: [0.74, 0.005, 0.995, 0.26],
  steel: [0.445, 0.325, 0.455, 0.745],
};

/** px rect of a region on a size-S canvas (y measured downwards). */
function rectPx(region: UvRegion, S: number): [number, number, number, number] {
  const [u0, v0, u1, v1] = region;
  return [u0 * S, (1 - v1) * S, (u1 - u0) * S, (v1 - v0) * S];
}

/**
 * Dress atlas of the lighthouse: the studded door with its weathered
 * blue-green paint, scrubbed shelf planks, the grey breaker cabinet, the
 * engraved brass plaque, the enamel MAIN LIGHT label, a paraffin can wrap,
 * rope and the log book cover. map + normal + roughness + metalness.
 */
export function lighthouseDressPbr(size: number): PbrMaps {
  return cachedPbr(cacheKey("lhDress", [size]), () => {
    const S = size;
    const kk = S / 1024;
    const buf = new TexBuf(S, S, rgb("#5c5850"), 0.7, 0);
    const nVar = noiseField(S, S, 7421, { freq: 8, oct: 4 });
    const nWear = noiseField(S, S, 7422, { freq: 16, oct: 4, mode: "billow" });
    const nGrain = noiseField(S, S, 7423, { freq: 8, freqY: 90, oct: 3 });

    // ---- vector layer: all the flat artwork ----
    const art = buf.layer((ctx) => {
      // Door: five planks of weathered teal, strap hinges, stud rows
      {
        const [x, y, w, h] = rectPx(LH_DRESS_UV.door, S);
        ctx.fillStyle = "#3f6f63";
        ctx.fillRect(x, y, w, h);
        const pw = w / 5;
        for (let p = 0; p < 5; p++) {
          const px = x + p * pw;
          ctx.fillStyle =
            p % 2 === 0 ? "rgba(0,0,0,0.1)" : "rgba(255,255,255,0.05)";
          ctx.fillRect(px, y, pw, h);
          ctx.fillStyle = "rgba(14,20,18,0.8)";
          ctx.fillRect(px, y, 2.4 * kk, h);
        }
        ctx.fillStyle = "rgba(14,20,18,0.8)";
        ctx.fillRect(x + w - 2.4 * kk, y, 2.4 * kk, h);
        // Strap hinges: two dark iron bands tapering from the hinge side
        for (const fy of [0.22, 0.74]) {
          const hy = y + h * fy;
          ctx.fillStyle = "#2b2d2e";
          ctx.beginPath();
          ctx.moveTo(x, hy - 13 * kk);
          ctx.lineTo(x + w * 0.72, hy - 5 * kk);
          ctx.lineTo(x + w * 0.78, hy);
          ctx.lineTo(x + w * 0.72, hy + 5 * kk);
          ctx.lineTo(x, hy + 13 * kk);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = "#3a3d3e";
          for (let b = 0; b < 4; b++) {
            ctx.beginPath();
            ctx.arc(x + w * (0.12 + b * 0.18), hy, 3.4 * kk, 0, TAU);
            ctx.fill();
          }
        }
        // Stud rows
        ctx.fillStyle = "#33403c";
        for (const fy of [0.06, 0.5, 0.94]) {
          for (let b = 0; b < 5; b++) {
            ctx.beginPath();
            ctx.arc(x + (b + 0.5) * pw, y + h * fy, 3.6 * kk, 0, TAU);
            ctx.fill();
          }
        }
        // Escutcheon + ring handle shadow, right-hand side
        ctx.fillStyle = "#26292a";
        ctx.beginPath();
        ctx.ellipse(x + w * 0.86, y + h * 0.47, 7 * kk, 10 * kk, 0, 0, TAU);
        ctx.fill();
      }
      // Scrubbed planks
      {
        const [x, y, w, h] = rectPx(LH_DRESS_UV.planks, S);
        ctx.fillStyle = "#9a8d76";
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = "rgba(60,48,34,0.5)";
        for (let p = 1; p < 4; p++)
          ctx.fillRect(x, y + (h / 4) * p, w, 1.6 * kk);
      }
      // Breaker cabinet: hammered grey door, seam, rivets, chevron strip
      {
        const [x, y, w, h] = rectPx(LH_DRESS_UV.breaker, S);
        ctx.fillStyle = "#7e868c";
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = "rgba(30,33,35,0.85)";
        ctx.lineWidth = 2 * kk;
        ctx.strokeRect(x + w * 0.08, y + h * 0.06, w * 0.84, h * 0.82);
        ctx.fillStyle = "#41474b";
        for (const [fx, fy] of [
          [0.05, 0.04],
          [0.95, 0.04],
          [0.05, 0.92],
          [0.95, 0.92],
          [0.05, 0.48],
          [0.95, 0.48],
        ]) {
          ctx.beginPath();
          ctx.arc(x + w * fx, y + h * fy, 3 * kk, 0, TAU);
          ctx.fill();
        }
        // black/yellow chevron strip along the foot
        const sy = y + h * 0.9;
        for (let c = 0; c < 10; c++) {
          ctx.fillStyle = c % 2 === 0 ? "#c9a52c" : "#26262a";
          ctx.beginPath();
          ctx.moveTo(x + (c / 10) * w, sy + h * 0.1);
          ctx.lineTo(x + ((c + 0.6) / 10) * w, sy);
          ctx.lineTo(x + ((c + 1.6) / 10) * w, sy);
          ctx.lineTo(x + ((c + 1) / 10) * w, sy + h * 0.1);
          ctx.closePath();
          ctx.fill();
        }
      }
      // Brass plaque: border, engraved lettering
      {
        const [x, y, w, h] = rectPx(LH_DRESS_UV.brass, S);
        const g = ctx.createLinearGradient(x, y, x + w, y + h);
        g.addColorStop(0, "#9d7d33");
        g.addColorStop(0.5, "#c3a052");
        g.addColorStop(1, "#8f7029");
        ctx.fillStyle = g;
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = "#5f4a1c";
        ctx.lineWidth = 3 * kk;
        ctx.strokeRect(x + w * 0.05, y + h * 0.09, w * 0.9, h * 0.82);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        // engraved: dark cut with a light kick below
        ctx.font = `600 ${Math.round(h * 0.24)}px Georgia, serif`;
        ctx.fillStyle = "rgba(244,228,180,0.55)";
        ctx.fillText("SALTREACH LIGHT", x + w / 2, y + h * 0.36 + 2 * kk);
        ctx.fillStyle = "#4a3812";
        ctx.fillText("SALTREACH LIGHT", x + w / 2, y + h * 0.36);
        ctx.font = `600 ${Math.round(h * 0.17)}px Georgia, serif`;
        ctx.fillStyle = "rgba(244,228,180,0.55)";
        ctx.fillText("EST. 1893", x + w / 2, y + h * 0.66 + 2 * kk);
        ctx.fillStyle = "#4a3812";
        ctx.fillText("EST. 1893", x + w / 2, y + h * 0.66);
        ctx.fillStyle = "#5f4a1c";
        for (const [fx, fy] of [
          [0.03, 0.06],
          [0.97, 0.06],
          [0.03, 0.94],
          [0.97, 0.94],
        ]) {
          ctx.beginPath();
          ctx.arc(x + w * fx, y + h * fy, 3.2 * kk, 0, TAU);
          ctx.fill();
        }
      }
      // Enamel label MAIN LIGHT
      {
        const [x, y, w, h] = rectPx(LH_DRESS_UV.label, S);
        ctx.fillStyle = "#ecebe2";
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = "#28418f";
        ctx.lineWidth = 4 * kk;
        ctx.strokeRect(x + 3 * kk, y + 3 * kk, w - 6 * kk, h - 6 * kk);
        ctx.fillStyle = "#28418f";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = `700 ${Math.round(h * 0.3)}px Arial, sans-serif`;
        ctx.fillText("MAIN LIGHT", x + w / 2, y + h * 0.52);
        // chipped corner
        ctx.fillStyle = "#454340";
        ctx.beginPath();
        ctx.moveTo(x + w, y);
        ctx.lineTo(x + w - 10 * kk, y);
        ctx.lineTo(x + w, y + 12 * kk);
        ctx.closePath();
        ctx.fill();
      }
      // Paraffin can wrap: galvanised with a paper band
      {
        const [x, y, w, h] = rectPx(LH_DRESS_UV.oilcan, S);
        ctx.fillStyle = "#8d9598";
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = "#d8cfb4";
        ctx.fillRect(x, y + h * 0.3, w, h * 0.4);
        ctx.fillStyle = "#7d2f24";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = `700 ${Math.round(h * 0.17)}px Arial, sans-serif`;
        ctx.fillText("PARAFFIN", x + w / 2, y + h * 0.5);
        ctx.strokeStyle = "rgba(60,60,60,0.5)";
        ctx.lineWidth = 1.6 * kk;
        for (let b = 1; b < 4; b++) {
          ctx.beginPath();
          ctx.moveTo(x, y + (h / 4) * b);
          ctx.lineTo(x + w, y + (h / 4) * b);
          ctx.stroke();
        }
      }
      // Rope: diagonal laid strands
      {
        const [x, y, w, h] = rectPx(LH_DRESS_UV.rope, S);
        ctx.fillStyle = "#b7a684";
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = "rgba(88,72,48,0.75)";
        ctx.lineWidth = 3.2 * kk;
        for (let s = -6; s < 26; s++) {
          ctx.beginPath();
          ctx.moveTo(x + (s / 20) * w, y);
          ctx.lineTo(x + (s / 20) * w + w * 0.32, y + h);
          ctx.stroke();
        }
      }
      // Log book: dark green cloth, pale label
      {
        const [x, y, w, h] = rectPx(LH_DRESS_UV.book, S);
        ctx.fillStyle = "#31473a";
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = "#22332a";
        ctx.fillRect(x, y, w * 0.12, h);
        ctx.fillStyle = "#ddd6c2";
        ctx.fillRect(x + w * 0.3, y + h * 0.22, w * 0.44, h * 0.3);
        ctx.fillStyle = "#3a3a38";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = `600 ${Math.round(h * 0.14)}px Georgia, serif`;
        ctx.fillText("LIGHT LOG", x + w * 0.52, y + h * 0.37);
      }
    });
    buf.blendLayer(art, 1);

    // ---- per-pixel material response by region ----
    const door = LH_DRESS_UV.door;
    const breaker = LH_DRESS_UV.breaker;
    const brass = LH_DRESS_UV.brass;
    const label = LH_DRESS_UV.label;
    const oil = LH_DRESS_UV.oilcan;
    const planks = LH_DRESS_UV.planks;
    const rope = LH_DRESS_UV.rope;
    const hit = (r: UvRegion, u: number, v: number): boolean =>
      u >= r[0] && u <= r[2] && v >= r[1] && v <= r[3];

    buf.each((i, u, v) => {
      let rough = 0.72 + (nVar[i] - 0.5) * 0.1;
      let metal = 0;
      let h = (nVar[i] - 0.5) * 0.1;
      if (hit(door, u, v)) {
        // Weathered paint: worn through to grey wood on the blooms
        const wear = sstep(0.6, 0.82, nWear[i]);
        if (wear > 0) {
          buf.mixTo(i, rgb("#8b8577"), Math.min(1, wear * 1.3));
          rough = 0.8;
        } else {
          rough = 0.62;
        }
        h += (nGrain[i] - 0.5) * 0.5 + wear * -0.2;
        buf.mul(i, 0.92 + nGrain[i] * 0.16);
      } else if (hit(breaker, u, v)) {
        metal = 0.35;
        rough = 0.48 + nWear[i] * 0.2;
        h += (nWear[i] - 0.5) * 0.16;
        const chip = sstep(0.88, 0.95, nWear[i]);
        if (chip > 0) {
          buf.mixTo(i, rgb("#494f53"), chip);
          metal = 0.7;
        }
      } else if (hit(brass, u, v)) {
        metal = 0.92;
        rough = 0.32 + sstep(0.55, 0.85, nWear[i]) * 0.3;
        buf.mul(i, 0.94 + nVar[i] * 0.12);
      } else if (hit(label, u, v)) {
        metal = 0;
        rough = 0.22;
      } else if (hit(oil, u, v)) {
        metal = 0.7;
        rough = 0.45 + nWear[i] * 0.2;
        buf.mul(i, 0.92 + nVar[i] * 0.14);
      } else if (hit(planks, u, v)) {
        rough = 0.85;
        h += (nGrain[i] - 0.5) * 0.5;
        buf.mul(i, 0.92 + nGrain[i] * 0.14);
      } else if (hit(rope, u, v)) {
        rough = 0.9;
        h += (nVar[i] - 0.5) * 0.4;
      } else {
        rough = 0.8;
      }
      buf.hf[i] = h;
      buf.rough[i] = rough;
      buf.metal[i] = metal;
    });
    return buf.build({
      wrapU: false,
      wrapV: false,
      normal: 3,
      normalScale: 0.7,
      metal: true,
    });
  });
}

// ---------------------------------------------------------------------------
// Verdigris copper (lantern roof)
// ---------------------------------------------------------------------------

/**
 * Weathered copper of the lantern dome: verdigris green with darker standing
 * seams (16 around, u-aligned), streaks, and worn brown copper at the eaves.
 * Tileable in u, clamped in v.
 */
export function pbrLighthousePatina(size: number): PbrMaps {
  return cachedPbr(cacheKey("lhPatina", [size]), () => {
    const S = size;
    const GREEN: Rgb = rgb("#4e8371");
    const GREEN2: Rgb = rgb("#699a82");
    const COPPER: Rgb = rgb("#5f4632");
    const buf = new TexBuf(S, S, GREEN, 0.6, 0.25);
    const nVar = noiseField(S, S, 7431, { freq: 6, oct: 4 });
    const nStreak = noiseField(S, S, 7432, { freq: 24, freqY: 4, oct: 3 });
    const nWorn = noiseField(S, S, 7433, { freq: 10, oct: 4, mode: "billow" });
    const SEAMS = 16;
    buf.each((i, u, v) => {
      let col = lerp3(GREEN, GREEN2, sstep(0.35, 0.75, nVar[i]));
      let h = (nVar[i] - 0.5) * 0.2;
      let rough = 0.58 + (nVar[i] - 0.5) * 0.12;
      let metal = 0.25;
      // Standing seams
      const fs = Math.abs(u * SEAMS - Math.round(u * SEAMS)) / SEAMS;
      const seam = Math.max(0, 1 - fs * S * 0.5);
      h += seam * 0.8;
      col = lerp3(col, COPPER, seam * 0.35);
      // Streaks
      const st = sstep(0.6, 0.85, nStreak[i]);
      col = lerp3(col, rgb("#3e6b5c"), st * 0.4);
      // Worn copper at the lower edge (v near 0 = eaves)
      const worn = sstep(0.25, 0.02, v) * sstep(0.5, 0.8, nWorn[i]);
      col = lerp3(col, COPPER, worn * 0.8);
      metal += worn * 0.5;
      rough -= worn * 0.15;
      buf.set(i, col);
      buf.hf[i] = h;
      buf.rough[i] = rough;
      buf.metal[i] = metal;
    });
    return buf.build({
      wrapV: false,
      normal: 3,
      normalScale: 0.6,
      metal: true,
    });
  });
}

// ---------------------------------------------------------------------------
// Glare billboard
// ---------------------------------------------------------------------------

/** Warm radial glare with a horizontal flare line, for the lamp billboard. */
export function lighthouseGlareTexture(): THREE.Texture {
  return cachedTex(cacheKey("lhGlare", []), () => {
    const S = 128;
    const [c, ctx] = makeCanvas(S, S);
    ctx.clearRect(0, 0, S, S);
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, "rgba(255,246,224,1)");
    g.addColorStop(0.18, "rgba(255,228,176,0.85)");
    g.addColorStop(0.45, "rgba(255,204,138,0.3)");
    g.addColorStop(1, "rgba(255,190,120,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    // horizontal flare line
    const f = ctx.createLinearGradient(0, 0, S, 0);
    f.addColorStop(0, "rgba(255,220,170,0)");
    f.addColorStop(0.5, "rgba(255,236,200,0.55)");
    f.addColorStop(1, "rgba(255,220,170,0)");
    ctx.fillStyle = f;
    ctx.fillRect(0, S * 0.47, S, S * 0.06);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  });
}
