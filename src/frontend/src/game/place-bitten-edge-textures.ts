// Procedural PBR sets for the Bitten Edge (place-bitten-edge.ts):
//   edgeConcretePbr()  one atlas for the fallen pillbox and the anti-tank
//                      cubes – board-marked 1940s concrete, spalling with
//                      exposed rebar, damp/tide staining and algae low down,
//                      lichen and guano up top, the rusty stove-pipe, the
//                      interior with its chalk tally marks.
//   scarpFacePbr()     the torn dune face – pale wind-blown sand over two dark
//                      peat beds (buried soils) with iron-pan staining under
//                      them, root fibres, slump gullies, dry-sand runnels, a
//                      damp toe with fallen clods and the root-mat turf lip.
//                      u tiles (≈ 8 m), v is clamped foot → lip.
//   lipWadPbr()        alpha atlas for the overhanging root-mat wads: the
//                      fibrous lump, hanging root fibres and dead marram.
//
// Everything is deterministic and cached (textures-core); the atlas regions
// are exported so the geometry can address them.

import {
  type PbrMaps,
  type Rgb,
  TexBuf,
  TexRng,
  cacheKey,
  cachedPbr,
  clamp01,
  hashPix,
  heightToNormal,
  lerp3,
  mix,
  noiseField,
  rgb,
  rustColor,
  sstep,
} from "./textures";

export type Region = readonly [number, number, number, number];

// ---------------------------------------------------------------------------
// Atlas layout (reference 2048×1024; u/v fractions, v upwards)
// ---------------------------------------------------------------------------

function atlasR(x0: number, y0: number, x1: number, y1: number): Region {
  return [x0 / 2048, 1 - y1 / 1024, x1 / 2048, 1 - y0 / 1024];
}

/** Concrete atlas regions. "around" = u runs once around all faces. */
export const ER = {
  /** Pillbox exterior, 6 faces around (u), v = 0..2.7 m. */
  extWall: atlasR(0, 0, 1536, 400),
  /** Pillbox interior, 6 faces around, v = 0..2.4 m. */
  intWall: atlasR(0, 400, 1536, 640),
  roofTop: atlasR(1536, 0, 2048, 384),
  roofUnder: atlasR(1536, 384, 2048, 640),
  /** Anti-tank cubes on the beach, 4 sides around. */
  teethBeach: atlasR(0, 640, 1024, 880),
  /** Anti-tank cubes up in the dunes, 4 sides around. */
  teethDune: atlasR(1024, 640, 2048, 880),
  teethTop: atlasR(0, 880, 256, 1024),
  rust: atlasR(256, 880, 512, 1024),
  floor: atlasR(512, 880, 1024, 1024),
  reveal: atlasR(1024, 880, 1536, 1024),
  plain: atlasR(1536, 880, 2048, 1024),
} as const;

function wadR(x0: number, y0: number, x1: number, y1: number): Region {
  return [x0 / 512, 1 - y1 / 512, x1 / 512, 1 - y0 / 512];
}

/** Root-mat wad atlas regions (512²). */
export const WR = {
  lump: wadR(0, 0, 256, 256),
  fibres: wadR(256, 0, 512, 256),
  tuft: wadR(0, 256, 512, 512),
} as const;

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

const CONC: Rgb = rgb("#8f8d86");
const CONC_INT: Rgb = rgb("#76736d");
const CONC_FLOOR: Rgb = rgb("#7c7972");
const AGG: Rgb = rgb("#6e6862");
const FRESH: Rgb = rgb("#aaa8a0");
const DAMP: Rgb = rgb("#4f4c47");
const ALGAE: Rgb = rgb("#4c5c3a");
const ALGAE_BRIGHT: Rgb = rgb("#6d7f45");
const LICHEN_GREY: Rgb = rgb("#b9bda6");
const LICHEN_YEL: Rgb = rgb("#c9b45c");
const LICHEN_ORANGE: Rgb = rgb("#d08a2e");
const GUANO: Rgb = rgb("#ebe9e1");
const SOOT: Rgb = rgb("#2a2724");
const SAND: Rgb = rgb("#d6bc8e");
const SALT: Rgb = rgb("#e6e3d8");
const BARNACLE: Rgb = rgb("#e2ddd0");

const SAND_PALE: Rgb = rgb("#dcc79f");
const SAND_DAMP: Rgb = rgb("#b39b74");
const SAND_RUNNEL: Rgb = rgb("#ead9b3");
const PEAT_DARK: Rgb = rgb("#33261a");
const PEAT_MID: Rgb = rgb("#5c4832");
const IRON: Rgb = rgb("#9a6532");
const ROOT: Rgb = rgb("#3d2f20");
const MAT: Rgb = rgb("#3a2c1d");
const STRAW: Rgb = rgb("#a89268");
const TOE_DAMP: Rgb = rgb("#8a7359");
const PEBBLE: Rgb = rgb("#8c8478");

// ---------------------------------------------------------------------------
// Region helpers
// ---------------------------------------------------------------------------

interface PxRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function pxRect(r: Region, w: number, h: number): PxRect {
  return {
    x0: Math.round(r[0] * w),
    y0: Math.round((1 - r[3]) * h),
    x1: Math.round(r[2] * w),
    y1: Math.round((1 - r[1]) * h),
  };
}

/** Iterate a region's pixels; ru/rv in 0..1 inside the region, rv upwards. */
function eachPx(
  buf: TexBuf,
  p: PxRect,
  fn: (i: number, ru: number, rv: number) => void,
): void {
  const iw = 1 / (p.x1 - p.x0);
  const ih = 1 / (p.y1 - p.y0);
  for (let y = p.y0; y < p.y1; y++) {
    const rv = 1 - (y - p.y0 + 0.5) * ih;
    const row = y * buf.w;
    for (let x = p.x0; x < p.x1; x++) {
      fn(row + x, (x - p.x0 + 0.5) * iw, rv);
    }
  }
}

/** Working surface sample: albedo, height, roughness. */
interface Surf {
  c: Rgb;
  h: number;
  r: number;
}

function commit(buf: TexBuf, i: number, s: Surf): void {
  buf.set(i, s.c);
  buf.hf[i] = s.h;
  buf.rough[i] = clamp01(s.r);
}

/** In-place colour mix / scale – the pixel loops must not allocate. */
function mixC(c: Rgb, to: Rgb, t: number): void {
  c[0] += (to[0] - c[0]) * t;
  c[1] += (to[1] - c[1]) * t;
  c[2] += (to[2] - c[2]) * t;
}

function mulC(c: Rgb, k: number): void {
  c[0] *= k;
  c[1] *= k;
  c[2] *= k;
}

function setC(c: Rgb, from: Rgb): void {
  c[0] = from[0];
  c[1] = from[1];
  c[2] = from[2];
}

/** 2×2 box-filtered copy of a field (for half-resolution normal maps). */
function halfField(f: Float32Array, w: number, h: number): Float32Array {
  const hw = w >> 1;
  const hh = h >> 1;
  const out = new Float32Array(hw * hh);
  for (let y = 0; y < hh; y++) {
    const r0 = 2 * y * w;
    const r1 = r0 + w;
    for (let x = 0; x < hw; x++) {
      const x0 = 2 * x;
      out[y * hw + x] =
        (f[r0 + x0] + f[r0 + x0 + 1] + f[r1 + x0] + f[r1 + x0 + 1]) * 0.25;
    }
  }
  return out;
}

function frac(v: number): number {
  return v - Math.floor(v);
}

// ---------------------------------------------------------------------------
// Concrete atlas
// ---------------------------------------------------------------------------

/**
 * Chalk tally marks, initials and the guano splashes of the concrete atlas,
 * drawn as one vector layer (coordinates at 1024-ref, scaled by `sc`).
 */
function drawConcreteMarks(
  ctx: CanvasRenderingContext2D,
  sc: number,
  rng: TexRng,
): void {
  const S = (v: number) => v * sc;
  // Interior wall region (0,400)-(1536,640): faces of 256 px each. Tally
  // groups on faces 0 and 2 (u 0..256 and 512..768), at chest height.
  ctx.strokeStyle = "rgba(236,232,220,0.85)";
  ctx.lineCap = "round";
  const tally = (x: number, y: number, groups: number) => {
    for (let g = 0; g < groups; g++) {
      const gx = x + g * 34 * sc;
      for (let k = 0; k < 4; k++) {
        ctx.lineWidth = S(2.2 + rng.next());
        ctx.beginPath();
        const px = gx + k * 6.5 * sc + rng.gauss() * sc;
        ctx.moveTo(px, y + rng.gauss() * 1.5 * sc);
        ctx.lineTo(px + rng.gauss() * 1.5 * sc, y + S(22) + rng.gauss() * sc);
        ctx.stroke();
      }
      ctx.lineWidth = S(2.4);
      ctx.beginPath();
      ctx.moveTo(gx - S(3), y + S(18));
      ctx.lineTo(gx + S(24), y + S(3));
      ctx.stroke();
    }
  };
  // Face 0 (u 0..256) and face 2 (512..768): tallies; face 3 (768..1024):
  // names; face 5 (1280..1536): more tallies. Face 1 is the doorway, face 4
  // carries the soot bloom of the stove pipe.
  tally(S(40), S(505), 5);
  tally(S(40), S(540), 3);
  tally(S(290), S(500), 4);
  tally(S(290), S(536), 5);
  tally(S(290), S(572), 2);
  tally(S(1310), S(510), 5);
  tally(S(1310), S(546), 4);
  ctx.fillStyle = "rgba(236,232,220,0.8)";
  ctx.font = `italic ${Math.round(S(17))}px Georgia, "Times New Roman", serif`;
  ctx.textAlign = "left";
  ctx.fillText("J. HALLAM  '41", S(800), S(520));
  ctx.fillText("STAND-TO 0430", S(800), S(548));
  ctx.font = `${Math.round(S(13))}px Georgia, "Times New Roman", serif`;
  ctx.fillText("HW 06.10  18.42", S(290), S(605));
  ctx.fillText("R.T.  E.M.  A.F.", S(800), S(576));
  // Guano splashes on the roof top region (1536,0)-(2048,384)
  ctx.fillStyle = "rgba(240,238,230,0.9)";
  for (let k = 0; k < 26; k++) {
    const x = S(1560 + rng.next() * 460);
    const y = S(20 + rng.next() * 340);
    const r = S(3 + rng.next() * 9);
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * (0.5 + rng.next() * 0.6), rng.next() * 3, 0, 6.3);
    ctx.fill();
    // Trail of drips beside the splash
    for (let d = 0; d < 3; d++) {
      ctx.beginPath();
      ctx.arc(
        x + rng.gauss() * r * 2.2,
        y + rng.gauss() * r * 2.2,
        S(1.2),
        0,
        6.3,
      );
      ctx.fill();
    }
  }
  // Guano runs over the top edge of the exterior wall (0,0)-(1536,400)
  ctx.strokeStyle = "rgba(240,238,230,0.85)";
  for (let k = 0; k < 18; k++) {
    const x = S(rng.next() * 1536);
    ctx.lineWidth = S(2 + rng.next() * 4);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.quadraticCurveTo(
      x + rng.gauss() * S(6),
      S(20 + rng.next() * 30),
      x + rng.gauss() * S(8),
      S(30 + rng.next() * 60),
    );
    ctx.stroke();
  }
}

/**
 * The concrete atlas of the place. `size` = atlas height (1024 on ultra/high,
 * 512 on medium/low); width is 2×. map + normal + roughness.
 */
export function edgeConcretePbr(size: number): PbrMaps {
  return cachedPbr(cacheKey("edgeConcrete", [size]), () => {
    const H = size;
    const W = size * 2;
    const sc = H / 1024;
    const rng = new TexRng(0xb17e);
    const buf = new TexBuf(W, H, CONC, 0.86, 0);

    const nVar = noiseField(W, H, 801, { freq: 8, oct: 4 });
    const nFine = noiseField(W, H, 802, { freq: 120, oct: 2 });
    // Bugholes are 1–2 cm (the atlas texel is ~1 cm on the walls), sparse
    const nAgg = noiseField(W, H, 803, { freq: 640, oct: 1 });
    const nBoardH = noiseField(W, H, 804, { freq: 3, freqY: 160, oct: 3 });
    const nBoardV = noiseField(W, H, 805, { freq: 300, freqY: 2, oct: 3 });
    // The fine wood grain reuses the board fields (and the vertical drip
    // field) through a fixed index shift instead of two more full-size fields
    const n = W * H;
    const GRAIN_SHIFT = W * 53 + 131;
    const nSpall = noiseField(W, H, 806, { freq: 7, oct: 3 });
    const nDrip = noiseField(W, H, 807, { freq: 100, freqY: 5, oct: 3 });
    const nLichen = noiseField(W, H, 808, { freq: 36, oct: 3 });
    const nBlob = noiseField(W, H, 809, { freq: 5, oct: 3 });
    const nHue = noiseField(W, H, 810, { freq: 14, oct: 3 });
    const nCrack = noiseField(W, H, 811, {
      freq: 5,
      oct: 4,
      mode: "ridged",
      gain: 0.5,
    });
    const marks = buf.layer((ctx) => drawConcreteMarks(ctx, sc, rng));
    // Colours derived once, not per pixel
    const CONC_DUNE = lerp3(CONC, FRESH, 0.25);
    const CONC_TOP = lerp3(CONC, FRESH, 0.3);
    const CONC_REVEAL = lerp3(CONC, FRESH, 0.2);
    const DRIP_RUST = rustColor(0.5, 0.5);
    const UNDER_RUST = rustColor(0.4, 0.5);
    const orangeLichen = (t: number): Rgb =>
      lerp3(LICHEN_YEL, LICHEN_ORANGE, t);
    const LICH_EXT = orangeLichen(0.2);
    const LICH_ROOF = orangeLichen(0.5);
    const LICH_DUNE = orangeLichen(0.8);
    const LICH_TOP = orangeLichen(0.6);
    const LICH_PLAIN = orangeLichen(0.3);
    const tmp: Rgb = [0, 0, 0];

    /** Plain cast concrete: tone variation, aggregate speckle, pores. */
    const concrete = (i: number, tone: Rgb): Surf => {
      let k = 1 + (nVar[i] - 0.5) * 0.18 + (nFine[i] - 0.5) * 0.08;
      const hp = hashPix(i, 5);
      if (hp > 0.988) k += 0.16;
      else if (hp < 0.01) k -= 0.22;
      const pore = sstep(0.88, 0.94, nAgg[i]);
      k *= 1 - pore * 0.3;
      return {
        c: [tone[0] * k, tone[1] * k, tone[2] * k],
        h: (nVar[i] - 0.5) * 0.1 + (nFine[i] - 0.5) * 0.06 - pore * 0.2,
        r: 0.86 + (nFine[i] - 0.5) * 0.06,
      };
    };

    /** Shuttering-board marks: rows of boards (horizontal or vertical). */
    const boards = (
      s: Surf,
      i: number,
      along: number,
      across: number,
      rows: number,
      vertical: boolean,
    ): void => {
      const rf = across * rows;
      const row = Math.floor(rf);
      const inRow = rf - row;
      const tone = (hashPix(row * 7919 + 13, 21) - 0.5) * 0.08;
      const j2 = (i + GRAIN_SHIFT) % n;
      const grain =
        ((vertical ? nBoardV[i] : nBoardH[i]) - 0.5) * 0.07 +
        ((vertical ? nDrip[j2] : nBoardH[j2]) - 0.5) * 0.06;
      const seam = 1 - sstep(0.02, 0.05, Math.min(inRow, 1 - inRow));
      mulC(s.c, 1 + tone + grain - seam * 0.16);
      s.h += grain * 0.7 - seam * 0.2 + tone * 0.6;
      // Butt joints between boards along the row
      const bj = frac(along * (vertical ? 3 : 4.5) + hashPix(row, 31));
      const joint = 1 - sstep(0.006, 0.014, Math.min(bj, 1 - bj));
      mulC(s.c, 1 - joint * 0.12);
      s.h -= joint * 0.12;
    };

    /** Spalling: recessed patches of exposed aggregate with rusting rebar. */
    const spall = (
      s: Surf,
      i: number,
      ru: number,
      rv: number,
      amount: number,
      barsV: readonly number[],
      barsU: number,
    ): void => {
      const n = nSpall[i] + (nFine[i] - 0.5) * 0.12;
      const lo = 0.86 - amount * 0.16;
      const inside = sstep(lo, lo + 0.05, n);
      const rim = sstep(lo - 0.04, lo, n) * (1 - inside);
      if (inside <= 0 && rim <= 0) return;
      const agg = 1 + (nAgg[i] - 0.5) * 0.5;
      setC(tmp, AGG);
      mulC(tmp, agg);
      mixC(s.c, tmp, inside);
      mixC(s.c, FRESH, rim * 0.7);
      s.h -= inside * 0.55;
      s.h += rim * 0.06;
      s.r = mix(s.r, 0.93, inside);
      if (inside > 0.55) {
        let bar = 0;
        for (const bv of barsV)
          bar = Math.max(bar, 1 - sstep(0.006, 0.011, Math.abs(rv - bv)));
        const bu = frac(ru * barsU);
        bar = Math.max(bar, 1 - sstep(0.012, 0.02, Math.min(bu, 1 - bu)) * 1);
        if (bar > 0) {
          const rc = rustColor(nHue[i], nFine[i]);
          mixC(s.c, rc, bar * 0.9);
          s.h += bar * 0.3;
          s.r = mix(s.r, 0.8, bar);
          // Rust bleeding down from the bar
          const bleed = sstep(0.5, 0.85, nDrip[i]) * 0.5;
          mixC(s.c, rc, bleed * bar);
        }
      }
    };

    /** Dark run-off streaks from the top edge. */
    const drips = (s: Surf, i: number, rv: number, amount: number): void => {
      const d = sstep(0.68, 0.9, nDrip[i]) * sstep(0.4, 1, rv) ** 1.5 * amount;
      const rusty = sstep(0.62, 0.8, nHue[i]);
      setC(tmp, DAMP);
      mixC(tmp, DRIP_RUST, rusty);
      mulC(tmp, 0.9 + nFine[i] * 0.2);
      mixC(s.c, tmp, d * 0.45);
      s.r = mix(s.r, 0.7, d * 0.4);
    };

    /** Lichen colonies on the sunward / upper parts. */
    /** `orange`: the orange-lichen colour for this surface, null = none. */
    const lichen = (
      s: Surf,
      i: number,
      weight: number,
      orange: Rgb | null,
    ): void => {
      const l = sstep(0.79, 0.86, nLichen[i]) * weight;
      if (l <= 0) return;
      const col =
        nHue[i] > 0.7 && orange
          ? orange
          : nHue[i] > 0.45
            ? LICHEN_YEL
            : LICHEN_GREY;
      mixC(s.c, col, l * 0.85);
      s.h += l * 0.06;
      s.r = mix(s.r, 0.97, l);
    };

    const guanoLayer = (s: Surf, i: number, strength: number): void => {
      const j = i * 4;
      const a = (marks[j + 3] / 255) * strength;
      if (a > 0.01) {
        tmp[0] = marks[j] / 255;
        tmp[1] = marks[j + 1] / 255;
        tmp[2] = marks[j + 2] / 255;
        mixC(s.c, tmp, a);
        s.h += a * 0.04;
        s.r = mix(s.r, 0.6, a * 0.5);
      }
    };

    /** Damp/tide zone from the bottom: dark, algae, barnacles, sand dusting. */
    const tide = (
      s: Surf,
      i: number,
      rv: number,
      top: number,
      algae: number,
      sandDust: number,
    ): void => {
      const dampT =
        1 - sstep(top * 0.35, top + 0.06 + (nBlob[i] - 0.5) * 0.08, rv);
      mixC(s.c, DAMP, dampT * 0.45);
      s.r = mix(s.r, 0.6, dampT * 0.5);
      if (algae > 0) {
        const a =
          (1 - sstep(top * 0.45, top * 0.75 + (nBlob[i] - 0.5) * 0.1, rv)) *
          sstep(0.35, 0.7, nLichen[i]) *
          algae;
        mixC(s.c, nHue[i] > 0.5 ? ALGAE_BRIGHT : ALGAE, a * 0.8);
        s.r = mix(s.r, 0.5, a * 0.5);
        const barn = hashPix(i, 77) > 0.994 && rv < top * 0.7 ? 1 : 0;
        if (barn) {
          mixC(s.c, BARNACLE, 0.85);
          s.h += 0.25;
        }
      }
      if (sandDust > 0) {
        const d =
          (1 - sstep(0.0, top * 0.5, rv)) *
          sstep(0.3, 0.7, nBlob[i]) *
          sandDust;
        mixC(s.c, SAND, d * 0.8);
        s.r = mix(s.r, 0.95, d);
      }
    };

    const EXT_BARS = [0.26, 0.5, 0.74];
    const INT_BARS = [0.3, 0.68];
    const CUBE_BARS = [0.35, 0.65];

    // --- Pillbox exterior: 6 faces around; faces 3..5 (u ≥ 0.5) look seaward
    eachPx(buf, pxRect(ER.extWall, W, H), (i, ru, rv) => {
      const s = concrete(i, CONC);
      const faceU = frac(ru * 6);
      boards(s, i, ru * 6, rv, 13, false);
      const seaward = ru >= 0.5 ? 1 : 0;
      // Corner chips where the faces meet
      const corner = 1 - sstep(0.01, 0.03, Math.min(faceU, 1 - faceU));
      mixC(s.c, FRESH, corner * sstep(0.5, 0.8, nBlob[i]) * 0.5);
      s.h -= corner * 0.15;
      spall(s, i, ru, rv, 0.55 + seaward * 0.35, EXT_BARS, 24);
      drips(s, i, rv, 0.9);
      lichen(s, i, sstep(0.45, 0.85, rv), LICH_EXT);
      const salt = sstep(0.74, 0.9, nBlob[i]) * 0.2;
      mixC(s.c, SALT, salt);
      tide(s, i, rv, 0.3, seaward * 0.9, 1 - seaward * 0.6);
      guanoLayer(s, i, 1);
      commit(buf, i, s);
    });

    // --- Pillbox interior: darker, damp, sooted around the stove, chalk marks
    eachPx(buf, pxRect(ER.intWall, W, H), (i, ru, rv) => {
      const s = concrete(i, CONC_INT);
      boards(s, i, ru * 6, rv, 12, false);
      spall(s, i, ru, rv, 0.35, INT_BARS, 18);
      // Soot bloom around the stove pipe (face 4 = seaward-left interior)
      const sx = (ru - 0.7) / 0.09;
      const sy = (rv - 0.6) / 0.45;
      const soot = Math.exp(-(sx * sx + sy * sy)) * (0.6 + 0.4 * nBlob[i]);
      mixC(s.c, SOOT, soot * 0.85);
      s.r = mix(s.r, 0.95, soot);
      // Condensation damp at the top and the floor line
      const dampTop = sstep(0.8, 1, rv) * sstep(0.5, 0.8, nBlob[i]);
      mixC(s.c, DAMP, dampTop * 0.35);
      tide(s, i, rv, 0.22, 0, 0.9);
      drips(s, i, rv, 0.5);
      guanoLayer(s, i, 1);
      commit(buf, i, s);
    });

    // --- Roof top: lichen carpet, guano, cracks, a puddle stain
    eachPx(buf, pxRect(ER.roofTop, W, H), (i, ru, rv) => {
      const s = concrete(i, CONC);
      const crack = sstep(0.94, 0.98, nCrack[i]);
      mulC(s.c, 1 - crack * 0.5);
      s.h -= crack * 0.5;
      const px = (ru - 0.42) / 0.28;
      const py = (rv - 0.55) / 0.22;
      const puddle = sstep(
        1.1,
        0.7,
        Math.sqrt(px * px + py * py) + (nBlob[i] - 0.5) * 0.4,
      );
      mixC(s.c, DAMP, puddle * 0.5);
      s.r = mix(s.r, 0.55, puddle);
      lichen(s, i, 1.4, LICH_ROOF);
      const salt = sstep(0.7, 0.88, nBlob[i]) * 0.25;
      mixC(s.c, SALT, salt);
      guanoLayer(s, i, 1);
      commit(buf, i, s);
    });

    // --- Roof underside: dark, damp blooms, drip cones, soot patch
    eachPx(buf, pxRect(ER.roofUnder, W, H), (i, ru, rv) => {
      const s = concrete(i, DAMP);
      boards(s, i, ru * 4, rv, 8, false);
      const bloom = sstep(0.55, 0.85, nBlob[i]);
      mixC(s.c, SALT, bloom * 0.3);
      // Soot above the stove pipe (local (-0.8, -1.5) → planar uv (0.35, 0.22))
      const soot = Math.exp(
        -(((ru - 0.35) / 0.14) ** 2 + ((rv - 0.22) / 0.2) ** 2),
      );
      mixC(s.c, SOOT, soot * 0.8);
      const drip = sstep(0.8, 0.94, nLichen[i]);
      mixC(s.c, UNDER_RUST, drip * 0.5 * (0.9 + nFine[i] * 0.2));
      s.r = mix(s.r, 0.6, bloom * 0.5);
      commit(buf, i, s);
    });

    // --- Anti-tank cubes: 4 sides around, vertical shutter boards, chipped
    //     edges. Beach set: tide-stained, algae, barnacles. Dune set: lichen.
    const teeth = (i: number, ru: number, rv: number, beach: boolean): void => {
      const s = concrete(i, beach ? CONC : CONC_DUNE);
      const faceU = frac(ru * 4);
      boards(s, i, rv, faceU, 6, true);
      const edge = Math.max(
        1 - sstep(0.0, 0.07, rv),
        sstep(0.93, 1, rv),
        1 - sstep(0.0, 0.05, Math.min(faceU, 1 - faceU)),
      );
      const chip = edge * sstep(0.45, 0.75, nBlob[i] + (nFine[i] - 0.5) * 0.3);
      mixC(s.c, AGG, chip * 0.6);
      s.h -= chip * 0.35;
      s.r = mix(s.r, 0.92, chip);
      spall(s, i, ru, rv, beach ? 0.4 : 0.55, CUBE_BARS, 12);
      if (beach) {
        tide(s, i, rv, 0.42, 1, 0.8);
        const salt = sstep(0.55, 0.9, rv) * sstep(0.7, 0.88, nBlob[i]) * 0.25;
        mixC(s.c, SALT, salt);
        lichen(s, i, sstep(0.7, 0.95, rv) * 0.5, null);
      } else {
        lichen(s, i, 0.5 + sstep(0.4, 0.9, rv) * 0.8, LICH_DUNE);
        tide(s, i, rv, 0.16, 0, 0.9);
        drips(s, i, rv, 0.6);
      }
      commit(buf, i, s);
    };
    eachPx(buf, pxRect(ER.teethBeach, W, H), (i, ru, rv) =>
      teeth(i, ru, rv, true),
    );
    eachPx(buf, pxRect(ER.teethDune, W, H), (i, ru, rv) =>
      teeth(i, ru, rv, false),
    );

    // --- Cube tops: pale, lichen, guano, a shallow puddle
    eachPx(buf, pxRect(ER.teethTop, W, H), (i, ru, rv) => {
      const s = concrete(i, CONC_TOP);
      lichen(s, i, 1.3, LICH_TOP);
      const px = (ru - 0.5) / 0.3;
      const py = (rv - 0.5) / 0.3;
      const puddle = sstep(
        1.1,
        0.7,
        Math.sqrt(px * px + py * py) + (nBlob[i] - 0.5) * 0.5,
      );
      mixC(s.c, DAMP, puddle * 0.4);
      s.r = mix(s.r, 0.6, puddle);
      const g = sstep(0.86, 0.92, nDrip[i] + (nLichen[i] - 0.5) * 0.2);
      mixC(s.c, GUANO, g * 0.9);
      s.h += g * 0.05;
      commit(buf, i, s);
    });

    // --- Rusty steel (rebar stubs, stove pipe)
    eachPx(buf, pxRect(ER.rust, W, H), (i) => {
      const rc = rustColor(nHue[i], nFine[i]);
      const pit = sstep(0.75, 0.9, nAgg[i]);
      const flake = sstep(0.6, 0.85, nBlob[i]);
      const c = lerp3(rc, rustColor(nHue[i] * 0.5, nFine[i]), flake * 0.6);
      commit(buf, i, {
        c: [
          c[0] * (1 - pit * 0.4),
          c[1] * (1 - pit * 0.4),
          c[2] * (1 - pit * 0.4),
        ],
        h: (nFine[i] - 0.5) * 0.12 - pit * 0.3 + flake * 0.08,
        r: 0.9 - pit * 0.1,
      });
    });

    // --- Interior floor: damp, sand-dusted, drip blotches
    eachPx(buf, pxRect(ER.floor, W, H), (i) => {
      const s = concrete(i, CONC_FLOOR);
      const damp = sstep(0.5, 0.8, nBlob[i]) * 0.5;
      mixC(s.c, DAMP, damp);
      s.r = mix(s.r, 0.6, damp);
      const dust = sstep(0.55, 0.85, nLichen[i]) * 0.6;
      mixC(s.c, SAND, dust);
      s.h += dust * 0.04;
      const blot = sstep(0.9, 0.96, nSpall[i]);
      mixC(s.c, SOOT, blot * 0.5);
      commit(buf, i, s);
    });

    // --- Embrasure / door reveals: fresher concrete, lightly board-marked
    eachPx(buf, pxRect(ER.reveal, W, H), (i, ru, rv) => {
      const s = concrete(i, CONC_REVEAL);
      boards(s, i, ru * 2, rv, 4, false);
      drips(s, i, rv, 0.4);
      commit(buf, i, s);
    });

    // --- Plain tile (wall tops, slab edges)
    eachPx(buf, pxRect(ER.plain, W, H), (i) => {
      const s = concrete(i, CONC);
      lichen(s, i, 0.5, LICH_PLAIN);
      commit(buf, i, s);
    });

    for (let i = 0; i < buf.n; i++)
      buf.mul(i, 1 + (hashPix(i, 17) - 0.5) * 0.05);
    // Albedo + roughness at full size, the normal map at half resolution
    // (the height detail that survives a 2×2 box filter is what the mip
    // chain shows at any sane distance anyway)
    const maps = buf.build({ normal: 0 });
    maps.normalMap = heightToNormal(
      halfField(buf.hf, W, H),
      [W >> 1, H >> 1],
      3.4 * 0.75,
      true,
    );
    maps.normalScale = 0.85;
    return maps;
  });
}

// ---------------------------------------------------------------------------
// Scarp face (stratigraphy)
// ---------------------------------------------------------------------------

/**
 * The torn dune face. `size` = texture height (512 on ultra/high, 256 on
 * medium/low); width 2×. u tiles along the face (one tile ≈ 8 m), v runs
 * foot (0) → lip (1) and is clamped. map + normal + roughness.
 */
export function scarpFacePbr(size: number): PbrMaps {
  return cachedPbr(cacheKey("scarpFace", [size]), () => {
    const H = size;
    const W = size * 2;
    const buf = new TexBuf(W, H, SAND_PALE, 0.9, 0);
    const nBed = noiseField(W, H, 821, { freq: 2, freqY: 120, oct: 3 });
    const nWave = noiseField(W, H, 822, { freq: 3, oct: 3 });
    const nFine = noiseField(W, H, 823, { freq: 90, oct: 2 });
    const nGully = noiseField(W, H, 824, { freq: 14, freqY: 1, oct: 3 });
    const nRunnel = noiseField(W, H, 825, { freq: 44, freqY: 2, oct: 2 });
    const nClod = noiseField(W, H, 826, { freq: 26, oct: 2 });
    const nRoot = noiseField(W, H, 827, {
      freq: 70,
      freqY: 5,
      oct: 2,
      mode: "ridged",
    });
    const nWarp = noiseField(W, H, 828, { freq: 5, oct: 3 });
    const nPeat = noiseField(W, H, 829, { freq: 24, freqY: 70, oct: 3 });
    const nDamp = noiseField(W, H, 830, { freq: 4, oct: 3 });
    // Along-face field: where each bed breaks (≈ once per 8 m tile) and how
    // its thickness swells and thins – one field read at three shifts
    const nBreak = noiseField(W, H, 831, { freq: 2, freqY: 1, oct: 2 });
    const n = W * H;
    const BREAK_SHIFT = (W * 0.5) | 0;
    const THICK_SHIFT = (W * 0.29) | 0;
    const c: Rgb = [0, 0, 0];
    const tmp: Rgb = [0, 0, 0];

    buf.each((i, _u, v) => {
      const wander = (nWave[i] - 0.5) * 0.07 + (nWarp[i] - 0.5) * 0.02;
      const vw = v + wander;
      // Base: pale wind-blown sand with damp patches and fine bedding laminae
      setC(c, SAND_PALE);
      mixC(c, SAND_DAMP, sstep(0.58, 0.85, nDamp[i]) * 0.55);
      const tone = 1 + (nFine[i] - 0.5) * 0.1 + (hashPix(i, 3) - 0.5) * 0.06;
      mulC(c, tone);
      const lam = sstep(0.55, 0.78, nBed[i]);
      c[0] *= 1 - lam * 0.07;
      c[1] *= 1 - lam * 0.075;
      c[2] *= 1 - lam * 0.08;
      let h =
        (nFine[i] - 0.5) * 0.12 + (hashPix(i, 4) - 0.5) * 0.1 - lam * 0.06;
      let r = 0.9 - (nFine[i] - 0.5) * 0.05;

      // Slump gullies (damp, recessed) and dry-sand runnels (pale, proud)
      const g = sstep(0.6, 0.8, nGully[i] + (nWarp[i] - 0.5) * 0.18);
      mixC(c, SAND_DAMP, g * 0.6);
      h -= g * 0.35;
      r = mix(r, 0.76, g);
      const run = sstep(0.86, 0.95, nRunnel[i]) * (1 - g) * sstep(0.08, 0.3, v);
      mixC(c, SAND_RUNNEL, run * 0.8);
      h += run * 0.05;

      // Peat beds: the lower one thin, lensing and pinching out altogether in
      // places; the upper one thicker and continuous but of uneven thickness
      const pinch = sstep(0.3, 0.5, nDamp[i]);
      const thickN = nBreak[(i + THICK_SHIFT) % n];
      const thick1 = 0.5 + thickN;
      const thick2 = 0.55 + (1 - thickN) * 0.9;
      const pres1 = 1 - sstep(0.64, 0.74, nBreak[i]);
      const pres2 = 1 - sstep(0.68, 0.78, nBreak[(i + BREAK_SHIFT) % n]);
      const bands: ReadonlyArray<readonly [number, number]> = [
        [0.36, (0.016 + 0.034 * nWave[i]) * pinch * thick1 * pres1],
        [0.66, (0.03 + 0.045 * nWarp[i]) * thick2 * pres2],
      ];
      // Iron pan under each peat bed (leached iron, a soft diffuse zone)
      for (const [bc, bh] of bands) {
        if (bh <= 0.008) continue;
        const bottom = bc - bh;
        const ip =
          sstep(bottom - 0.075, bottom - 0.005, vw) *
          (1 - sstep(bottom - 0.005, bottom + 0.01, vw));
        const streak = 0.6 + 0.4 * sstep(0.35, 0.7, nRunnel[i]);
        mixC(c, IRON, ip * streak * 0.35);
        r = mix(r, 0.85, ip * 0.3);
      }
      // Root fibres through the upper sand (and a few lower down)
      const rootZone = sstep(0.68, 0.76, v) * (1 - sstep(0.92, 0.97, v)) + 0.15;
      const rt = sstep(0.84, 0.92, nRoot[i]) * rootZone;
      mixC(c, ROOT, rt * 0.45);
      h += rt * 0.06;

      // Peat beds: dark, fibrous, standing proud with ragged edges
      for (const [bc, bh] of bands) {
        if (bh <= 0.004) continue;
        const edge = 0.012 + (nPeat[i] - 0.5) * 0.02;
        const inBand =
          sstep(bc - bh - edge, bc - bh + edge, vw) *
          (1 - sstep(bc + bh - edge, bc + bh + edge, vw));
        if (inBand <= 0) continue;
        const fib = sstep(0.4, 0.75, nPeat[i]);
        setC(tmp, PEAT_DARK);
        mixC(tmp, PEAT_MID, fib * 0.8 + (nFine[i] - 0.5) * 0.2);
        mixC(c, tmp, inBand * 0.92);
        h = mix(h, 0.11 + (nPeat[i] - 0.5) * 0.1 - g * 0.1, inBand);
        r = mix(r, 0.95, inBand);
      }

      // Turf / root-mat lip at the top, ragged underside, straw and sand in it
      const matEdge =
        0.935 + (nWarp[i] - 0.5) * 0.05 + (nPeat[i] - 0.5) * 0.015;
      const mat = sstep(matEdge - 0.008, matEdge + 0.008, v);
      if (mat > 0) {
        const straw = sstep(0.62, 0.8, nPeat[i]);
        setC(tmp, MAT);
        mixC(tmp, STRAW, straw * 0.7);
        mixC(tmp, SAND_PALE, sstep(0.75, 0.9, nClod[i]) * 0.5);
        mixC(c, tmp, mat);
        h = mix(h, 0.32 + (nPeat[i] - 0.5) * 0.2, mat);
        r = mix(r, 0.95, mat);
      }

      // Damp toe with fallen peat clods and pebbles
      const toe = 1 - sstep(0.03, 0.13, v);
      mixC(c, TOE_DAMP, toe * 0.5 * (0.6 + 0.4 * nDamp[i]));
      r = mix(r, 0.72, toe * 0.5);
      const clod = sstep(0.9, 0.94, nClod[i]) * (1 - sstep(0.04, 0.14, v));
      if (clod > 0) {
        setC(tmp, PEAT_MID);
        mixC(tmp, TOE_DAMP, 0.45 + nFine[i] * 0.3);
        mixC(c, tmp, clod * 0.7);
        h += clod * 0.14;
      }
      if (hashPix(i, 9) > 0.9985 && v < 0.35) {
        mixC(c, PEBBLE, 0.85);
        h += 0.2;
        r = 0.7;
      }
      buf.set(i, c);
      buf.hf[i] = h;
      buf.rough[i] = clamp01(r);
    });
    return buf.build({ normal: 3.2, normalScale: 0.9, wrapV: false });
  });
}

// ---------------------------------------------------------------------------
// Root-mat wads (alpha atlas)
// ---------------------------------------------------------------------------

/**
 * 512² alpha atlas for the lip wads: fibrous root-mat lump (opaque), hanging
 * root fibres and dead marram blades (alpha-tested). map + normal + roughness.
 */
export function lipWadPbr(): PbrMaps {
  return cachedPbr(cacheKey("lipWad", []), () => {
    const S = 512;
    const rng = new TexRng(0x9a7d);
    const buf = new TexBuf(S, S, MAT, 0.92, 0);
    const nFine = noiseField(S, S, 841, { freq: 60, oct: 2 });
    const nFib = noiseField(S, S, 842, {
      freq: 30,
      freqY: 6,
      oct: 3,
      mode: "ridged",
    });
    const nBlob = noiseField(S, S, 843, { freq: 6, oct: 3 });

    const layer = buf.layer((ctx) => {
      // Hanging root fibres (256,0)-(512,256): wavy strands from the top
      ctx.lineCap = "round";
      for (let k = 0; k < 48; k++) {
        const x = 262 + rng.next() * 244;
        const len = 40 + rng.next() * 170;
        const tone = rng.pick([
          "#5a4630",
          "#6e5840",
          "#7d6a4c",
          "#4a3a28",
          "#8c7455",
          "#a08a62",
        ]);
        ctx.strokeStyle = tone;
        ctx.lineWidth = 0.9 + rng.next() * 1.8;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        const sway = rng.gauss() * 26;
        ctx.bezierCurveTo(
          x + sway,
          len * 0.35,
          x - sway * 0.6,
          len * 0.7,
          x + rng.gauss() * 18,
          len,
        );
        ctx.stroke();
        // Sand grains stuck to the root
        ctx.fillStyle = "#cdb994";
        for (let d = 0; d < 3; d++) {
          ctx.beginPath();
          ctx.arc(
            x + rng.gauss() * 8,
            rng.next() * len,
            1 + rng.next() * 1.5,
            0,
            6.3,
          );
          ctx.fill();
        }
      }
      // Dead marram blades (0,256)-(512,512): a fan from the bottom centre
      const cx = 256;
      const cy = 508;
      // Fewer, longer, darker blades, the whole tuft leaning to one side
      for (let k = 0; k < 72; k++) {
        const ang = -Math.PI / 2 + rng.gauss() * 0.5 + 0.22;
        const len = 140 + rng.next() * 120;
        const bend = rng.gauss() * 70;
        const tone = rng.pick([
          "#8f8462",
          "#7a7052",
          "#a39672",
          "#6e6448",
          "#b0a27b",
          "#5f5740",
        ]);
        ctx.strokeStyle = tone;
        const w0 = 2.0 + rng.next() * 2.5;
        const x0 = cx + rng.gauss() * 40;
        const ex = x0 + Math.cos(ang) * len + bend;
        const ey = cy + Math.sin(ang) * len + Math.abs(bend) * 0.4;
        const mx = x0 + Math.cos(ang) * len * 0.5 + bend * 0.25;
        const my = cy + Math.sin(ang) * len * 0.55;
        // Blade drawn as two strokes: thick base, thin tip
        ctx.lineWidth = w0;
        ctx.beginPath();
        ctx.moveTo(x0, cy);
        ctx.quadraticCurveTo(mx, my, (mx + ex) / 2, (my + ey) / 2);
        ctx.stroke();
        ctx.lineWidth = w0 * 0.45;
        ctx.beginPath();
        ctx.moveTo((mx + ex) / 2, (my + ey) / 2);
        ctx.quadraticCurveTo(ex - bend * 0.2, (my + ey) / 2 + 10, ex, ey);
        ctx.stroke();
        // Some blades snapped: a darker kink line
        if (rng.chance(0.25)) {
          ctx.strokeStyle = "#6e6650";
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(mx - 3, my);
          ctx.lineTo(mx + 3, my + 2);
          ctx.stroke();
        }
      }
      // Base tangle of straw at the bottom of the fan
      ctx.fillStyle = "#6a5a3c";
      ctx.beginPath();
      ctx.ellipse(cx, 500, 60, 14, 0, 0, 6.3);
      ctx.fill();
    });

    buf.each((i, u, v) => {
      const j = i * 4;
      if (u < 0.5 && v > 0.5) {
        // Lump: fibrous root mat with sand grains, opaque
        const fib = sstep(0.55, 0.85, nFib[i]);
        let c = lerp3(
          lerp3(MAT, STRAW, 0.3),
          lerp3(ROOT, STRAW, 0.6),
          fib * 0.7,
        );
        c = lerp3(c, SAND_PALE, sstep(0.7, 0.88, nBlob[i]) * 0.6);
        const tone = 1 + (nFine[i] - 0.5) * 0.2;
        buf.set(i, [c[0] * tone, c[1] * tone, c[2] * tone]);
        buf.hf[i] = fib * 0.3 + (nFine[i] - 0.5) * 0.15;
        buf.rough[i] = 0.93;
        buf.a[i] = 1;
        return;
      }
      // Alpha regions: take the drawn layer
      const a = layer[j + 3] / 255;
      buf.a[i] = a;
      if (a > 0.02) {
        const tone = 1 + (nFine[i] - 0.5) * 0.12;
        buf.set(i, [
          (layer[j] / 255) * tone,
          (layer[j + 1] / 255) * tone,
          (layer[j + 2] / 255) * tone,
        ]);
        buf.hf[i] = a * 0.2;
        buf.rough[i] = 0.9;
      } else {
        buf.set(i, MAT);
        buf.hf[i] = 0;
        buf.rough[i] = 0.9;
      }
    });
    return buf.build({
      normal: 2.5,
      normalScale: 0.7,
      alpha: true,
      alphaTest: 0.5,
      doubleSide: true,
    });
  });
}
