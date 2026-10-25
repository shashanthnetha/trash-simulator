// Procedural PBR sets for the tipped shipping container landmark: the hull
// livery atlas (corrugation-phase-aligned rust, fictional "MERIDIAN LINE"
// wordmark, container number stencils, CSC plate hint), the spilled-cargo
// atlas (crate planks, cartons, pallet wood) and the shrink-wrap set.
//
// The container lies ON ITS SIDE, so the weathering tells a two-direction
// story: rust streaks from its former upright life run along each face's old
// "down" (-v of the upright panel), while fresh streaks since it tipped run
// along the NEW world-down of that face (sideways across doors and end wall,
// down the former roof). The sky-facing wall collects sand in its corrugation
// valleys instead.
//
// Shared with landmark-container.ts: CONTAINER_DIMS, corrPeriods() and
// corrProfile() keep the painted valley rust in phase with the modelled
// corrugation geometry.

import {
  type PbrMaps,
  type Rgb,
  TexBuf,
  TexRng,
  cacheKey,
  cachedPbr,
  clamp01,
  drawScratches,
  hashPix,
  lerp3,
  mix,
  noiseField,
  rgb,
  rustColor,
  sstep,
} from "./textures";

// ---------------------------------------------------------------------------
// Shared dimensions & corrugation profile
// ---------------------------------------------------------------------------

/** True 20 ft ISO proportions; wall/door sizes derived from the frame. */
export const CONTAINER_DIMS = {
  len: 6.06,
  width: 2.44,
  height: 2.59,
  /** Corner post cross-section. */
  post: 0.2,
  /** Corrugated wall span between the corner posts. */
  wallLen: 5.58,
  /** Wall height between bottom and top rail (local y -1.045 .. 1.135). */
  wallH: 2.18,
  wallY0: -1.045,
  corrPeriod: 0.209,
  corrDepth: 0.042,
  doorW: 0.98,
  doorH: 2.14,
  endW: 2.04,
} as const;

export function corrPeriods(len: number): number {
  return Math.max(1, Math.round(len / CONTAINER_DIMS.corrPeriod));
}

/**
 * Trapezoidal corrugation profile: 1 = crest (outer face), 0 = valley.
 * Crest flat around t = 0/1, valley flat around t = 0.5, straight slopes.
 */
export function corrProfile(t: number): number {
  const s = t - Math.floor(t);
  if (s < 0.18) return 1;
  if (s < 0.42) return 1 - (s - 0.18) / 0.24;
  if (s < 0.58) return 0;
  if (s < 0.82) return (s - 0.58) / 0.24;
  return 1;
}

// ---------------------------------------------------------------------------
// Atlas regions (reference layout 2048x1024; u/v fractions, v upwards)
// ---------------------------------------------------------------------------

export type Region = readonly [number, number, number, number];

function hullR(x0: number, y0: number, x1: number, y1: number): Region {
  return [x0 / 2048, 1 - y1 / 1024, x1 / 2048, 1 - y0 / 1024];
}

/** Hull atlas regions. doorA = viewer-right leaf (hinge at local z=-1.02). */
export const CR = {
  wall: hullR(0, 0, 1280, 400),
  roof: hullR(0, 400, 1280, 717),
  floor: hullR(0, 717, 1280, 1024),
  doors: hullR(1280, 0, 2048, 471),
  doorB: hullR(1280, 0, 1664, 471),
  doorA: hullR(1664, 0, 2048, 471),
  end: hullR(1280, 471, 2048, 819),
  interiorWall: hullR(1280, 819, 1792, 948),
  interiorFloor: hullR(1280, 948, 1792, 1024),
  casting: hullR(1792, 819, 1920, 921),
  rail: hullR(1792, 921, 1920, 1024),
  rod: hullR(1920, 819, 2048, 921),
  dark: hullR(1920, 921, 2048, 1024),
} as const;

function cargoR(x0: number, y0: number, x1: number, y1: number): Region {
  return [x0 / 1024, 1 - y1 / 1024, x1 / 1024, 1 - y0 / 1024];
}

export const PLANK_ROWS = 8;

/** Cargo atlas regions. Planks: 8 horizontal rows, use plankRow(i). */
export const CGR = {
  planks: cargoR(0, 0, 1024, 336),
  lid: cargoR(0, 336, 560, 672),
  endGrain: cargoR(560, 336, 716, 672),
  pallet: cargoR(716, 336, 1024, 672),
  carton: cargoR(0, 672, 512, 1024),
  cartonWet: cargoR(512, 672, 1024, 1024),
} as const;

/** One plank row of the crate-slat strip (v-slice of CGR.planks). */
export function plankRow(i: number): Region {
  const [u0, v0, u1, v1] = CGR.planks;
  const k = ((i % PLANK_ROWS) + PLANK_ROWS) % PLANK_ROWS;
  const dv = (v1 - v0) / PLANK_ROWS;
  return [u0, v0 + k * dv, u1, v0 + (k + 1) * dv];
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const TEAL: Rgb = rgb("#2e6f68");
const TEAL_DOOR: Rgb = rgb("#25635e");
const PALE: Rgb = rgb("#84aca2");
const BARE: Rgb = rgb("#b7babd");
const SAND_TINT: Rgb = rgb("#d6bc8e");
const SALT: Rgb = rgb("#e9e6da");
const GRIME: Rgb = rgb("#3c362e");

// ---------------------------------------------------------------------------
// Region iteration helper
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

// ---------------------------------------------------------------------------
// Stencil helpers
// ---------------------------------------------------------------------------

/** Blocky stencil lettering with manual letter spacing; returns end x. */
function stencilText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  color: string,
  spacing = 0.1,
): number {
  ctx.fillStyle = color;
  ctx.font = `900 ${Math.round(size)}px Arial, Helvetica, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  let cx = x;
  for (const ch of text) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + size * spacing;
  }
  return cx;
}

/** Ring-and-waves line logo of the fictional MERIDIAN LINE. */
function meridianMark(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  color: string,
  lineW: number,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineW;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  for (let k = -1; k <= 1; k++) {
    const y = cy + k * r * 0.38;
    const half = Math.sqrt(Math.max(0.05, 1 - (y - cy) ** 2 / (r * r))) * r;
    ctx.beginPath();
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      const px = cx - half * 0.82 + t * half * 1.64;
      const py = y + Math.sin(t * Math.PI * 2 + k) * r * 0.09;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// Hull atlas
// ---------------------------------------------------------------------------

/**
 * The container hull livery atlas. `size` = atlas height (1024 on ultra/high,
 * 512 on medium/low); width is 2x. map + normal + roughness + metalness.
 */
export function containerHullPbr(size: number): PbrMaps {
  return cachedPbr(cacheKey("containerHull", [size]), () => {
    const H = size;
    const W = size * 2;
    const rng = new TexRng(0xc047);
    const sc = H / 1024;
    const buf = new TexBuf(W, H, TEAL, 0.55, 0.75);

    // Shared noise fields
    const nVar = noiseField(W, H, 701, { freq: 6, oct: 4 });
    const nFine = noiseField(W, H, 702, { freq: 100, oct: 2 });
    const nRust = noiseField(W, H, 703, { freq: 9, oct: 5, gain: 0.55 });
    const nHue = noiseField(W, H, 704, { freq: 14, oct: 4 });
    const nChip = noiseField(W, H, 705, { freq: 70, oct: 2 });
    const nWear = noiseField(W, H, 706, { freq: 5, oct: 3 });
    const nStkV = noiseField(W, H, 707, { freq: 110, freqY: 8, oct: 3 });
    const nStkU = noiseField(W, H, 708, { freq: 8, freqY: 55, oct: 3 });
    const nSalt = noiseField(W, H, 709, { freq: 16, oct: 3 });
    const nBlob = noiseField(W, H, 710, { freq: 4, oct: 3 });
    const nSand = noiseField(W, H, 711, { freq: 40, oct: 2 });

    // Vector layer: wordmarks, numbers, plates (drawn once at atlas size)
    const layer = buf.layer((ctx) => {
      drawHullStencils(ctx, sc);
      drawScratches(ctx, rng, W, H, 90, 140 * sc, 1.1, 0.28);
    });

    const wallP = corrPeriods(CONTAINER_DIMS.wallLen);
    const doorP = corrPeriods(CONTAINER_DIMS.doorW);
    const endP = corrPeriods(CONTAINER_DIMS.endW);

    /**
     * Weathered livery paint shared by wall/roof/doors/end.
     * oldDown: streak fade along the panel's upright "down".
     * newDir: fresh streaks since the tip-over: 0 none, 1 toward +u,
     * -1 toward -u, 2 toward +v (former roof face).
     */
    const paintedPanel = (
      i: number,
      ru: number,
      rv: number,
      o: {
        base: Rgb;
        periods: number;
        pu: number; // corrugation phase coordinate (0..1 across periods)
        seams?: number;
        wearMul: number; // 0 fresh .. 1 hammered
        newDir: number;
        sandTop?: boolean; // sky-facing: sand pools in valleys
        sandEdge?: number; // 0 none, else sand tint toward rv=this end (0|1)
      },
    ): void => {
      const valley = 1 - corrProfile(o.pu * o.periods);
      // Base + sun fade; valleys get painted-in ambient occlusion
      const tv =
        (1 + (nVar[i] - 0.5) * 0.1 + (nFine[i] - 0.5) * 0.05) *
        (1 - valley * 0.16);
      let col: Rgb = [o.base[0] * tv, o.base[1] * tv, o.base[2] * tv];
      const fade =
        sstep(0.48, 0.85, nWear[i]) * 0.5 + sstep(0.62, 0.95, rv) * 0.18;
      col = lerp3(col, PALE, clamp01(fade * (0.4 + o.wearMul * 0.5)));
      let hgt = (nFine[i] - 0.5) * 0.05 - valley * 0.22;
      let ro = 0.52 + fade * 0.12 + (nFine[i] - 0.5) * 0.08;
      let me = 0.72;
      // Panel weld seams
      if (o.seams) {
        const sd = Math.abs(((ru * o.seams) % 1) - 0.5);
        const seam = 1 - sstep(0.46, 0.492, sd);
        hgt += seam * 0.12;
        col = lerp3(col, GRIME, seam * 0.22);
      }
      // Stencil layer, worn through where the paint is tired
      const j = i * 4;
      const la = (layer[j + 3] / 255) * (1 - sstep(0.55, 0.9, nWear[i]) * 0.75);
      if (la > 0.01) {
        col = lerp3(
          col,
          [layer[j] / 255, layer[j + 1] / 255, layer[j + 2] / 255],
          la,
        );
        hgt += la * 0.05;
        ro = mix(ro, 0.45, la * 0.5);
      }
      // Rust: corrugation valleys (patchy, not every valley), blooms, both
      // streak generations
      let m =
        valley *
          sstep(0.48, 0.86, nRust[i]) *
          (0.35 + o.wearMul * 0.45) *
          (0.55 + 0.45 * nBlob[i]) +
        sstep(0.78, 0.94, nBlob[i]) * (0.45 + o.wearMul * 0.45);
      m += (1 - sstep(0, 0.08, rv)) * sstep(0.3, 0.6, nRust[i]) * 0.7;
      m += sstep(0.94, 1, rv) * sstep(0.35, 0.65, nRust[i]) * 0.45;
      const oldStk =
        sstep(0.66, 0.88, nStkV[i]) * (1 - rv) * sstep(0.42, 0.7, nRust[i]);
      let newStk = 0;
      if (o.newDir === 1) newStk = sstep(0.64, 0.86, nStkU[i]) * ru;
      else if (o.newDir === -1) newStk = sstep(0.64, 0.86, nStkU[i]) * (1 - ru);
      else if (o.newDir === 2)
        newStk = sstep(0.68, 0.9, nStkV[i]) * (1 - rv) * 0.8;
      m = clamp01(m);
      const rc = rustColor(nHue[i], nFine[i]);
      col = lerp3(col, rc, m * 0.9);
      col = lerp3(
        col,
        rustColor(nHue[i] * 0.6, nFine[i]),
        clamp01(oldStk) * 0.35,
      );
      col = lerp3(col, rc, clamp01(newStk) * 0.42);
      const rustAll = clamp01(m + oldStk * 0.35 + newStk * 0.42);
      hgt += m * nFine[i] * 0.16;
      ro = mix(ro, 0.92, rustAll);
      me = mix(me, 0.06, rustAll);
      // Chips down to bare metal (rust-ringed)
      const chipN = nChip[i] + valley * 0.03 + o.wearMul * 0.03;
      const chip = sstep(0.875, 0.93, chipN);
      const ring = sstep(0.83, 0.87, chipN) * (1 - chip);
      col = lerp3(col, rc, ring * 0.7);
      col = lerp3(col, BARE, chip);
      hgt -= chip * 0.2;
      ro = mix(ro, 0.38, chip);
      me = mix(me, 0.95, chip);
      // Salt bloom
      const salt = sstep(0.7, 0.88, nSalt[i]) * (0.25 + o.wearMul * 0.25);
      col = lerp3(col, SALT, salt);
      ro += salt * 0.15;
      // Sand: pooled in valleys of the sky-facing wall / drifted at one edge
      let sand = 0;
      if (o.sandTop) sand = valley * sstep(0.5, 0.78, nSand[i]) * 0.6;
      if (o.sandEdge !== undefined) {
        const d = o.sandEdge === 0 ? 1 - rv : rv;
        sand = Math.max(
          sand,
          sstep(0.55, 0.95, d) * sstep(0.35, 0.7, nSand[i]),
        );
      }
      if (sand > 0) {
        col = lerp3(col, SAND_TINT, sand);
        ro = mix(ro, 0.95, sand);
        me = mix(me, 0.05, sand);
        hgt += sand * 0.04;
      }
      buf.set(i, col);
      buf.hf[i] = hgt;
      buf.rough[i] = clamp01(ro);
      buf.metal[i] = clamp01(me);
    };

    // --- Long wall (sky-facing wall reuses this region; buried wall unseen)
    eachPx(buf, pxRect(CR.wall, W, H), (i, ru, rv) =>
      paintedPanel(i, ru, rv, {
        base: TEAL,
        periods: wallP,
        pu: ru,
        seams: 5,
        wearMul: 0.55,
        newDir: 0,
        sandTop: true,
      }),
    );

    // --- Former roof: now the seaward vertical face. Hammered, fresh streaks
    // run toward +v (its world-down after the tip), sand drift banks at +v.
    eachPx(buf, pxRect(CR.roof, W, H), (i, ru, rv) =>
      paintedPanel(i, ru, rv, {
        base: TEAL,
        periods: wallP,
        pu: ru,
        seams: 5,
        wearMul: 1,
        newDir: 2,
        sandEdge: 1,
      }),
    );

    // --- Doors (both leaves; leaf B was once repainted a fresher teal)
    eachPx(buf, pxRect(CR.doors, W, H), (i, ru, rv) => {
      const leafA = ru >= 0.5;
      const lu = (ru * 2) % 1;
      paintedPanel(i, ru, rv, {
        base: leafA ? TEAL : TEAL_DOOR,
        periods: doorP,
        pu: lu,
        wearMul: leafA ? 0.8 : 0.45,
        // World-down on the door face is +u (viewer-right after the tip)
        newDir: 1,
        sandEdge: undefined,
      });
      // Dark leaf gap and hinge-edge grime
      const gap = 1 - sstep(0.004, 0.012, Math.abs(ru - 0.5));
      if (gap > 0) {
        buf.mixTo(i, GRIME, gap * 0.85);
        buf.hf[i] -= gap * 0.3;
      }
    });

    // --- Blank end wall (world-down is -u here)
    eachPx(buf, pxRect(CR.end, W, H), (i, ru, rv) =>
      paintedPanel(i, ru, rv, {
        base: TEAL,
        periods: endP,
        pu: ru,
        wearMul: 0.7,
        newDir: -1,
      }),
    );

    // --- Underside (former floor): dusty chassis steel with wear strips
    const FLOOR_BASE: Rgb = rgb("#6b675e");
    const WEAR_STRIP: Rgb = rgb("#8a867a");
    eachPx(buf, pxRect(CR.floor, W, H), (i, _ru, rv) => {
      const tv = 1 + (nVar[i] - 0.5) * 0.14 + (nFine[i] - 0.5) * 0.08;
      let col: Rgb = [
        FLOOR_BASE[0] * tv,
        FLOOR_BASE[1] * tv,
        FLOOR_BASE[2] * tv,
      ];
      for (const s of [0.28, 0.72]) {
        const w = 1 - sstep(0.03, 0.09, Math.abs(rv - s));
        col = lerp3(col, WEAR_STRIP, w * 0.6);
      }
      const m = clamp01(
        sstep(0.6, 0.88, nRust[i]) * 0.7 + sstep(0.84, 0.96, nBlob[i]) * 0.8,
      );
      col = lerp3(col, rustColor(nHue[i], nFine[i]), m * 0.8);
      // Sand dusting thrown up by the surf
      const dust = sstep(0.55, 0.85, nSand[i]) * 0.3;
      col = lerp3(col, SAND_TINT, dust);
      const oil = sstep(0.84, 0.95, nSalt[i]);
      col = lerp3(col, rgb("#33302a"), oil * 0.5);
      buf.set(i, col);
      buf.hf[i] = (nFine[i] - 0.5) * 0.08 + m * nFine[i] * 0.1;
      buf.rough[i] = 0.85 + m * 0.08 - oil * 0.2;
      buf.metal[i] = 0.35 - m * 0.25;
    });

    // --- Interior wall/ceiling: dark, rusty, vignetted toward the corners
    const INT_BASE: Rgb = rgb("#57504a");
    eachPx(buf, pxRect(CR.interiorWall, W, H), (i, ru, rv) => {
      const tv = 1 + (nVar[i] - 0.5) * 0.12;
      let col: Rgb = [INT_BASE[0] * tv, INT_BASE[1] * tv, INT_BASE[2] * tv];
      const m = clamp01(sstep(0.55, 0.82, nRust[i]) * 0.7);
      col = lerp3(col, rustColor(nHue[i], nFine[i]), m);
      const vig =
        sstep(0.75, 1, Math.abs(ru - 0.5) * 2) * 0.35 +
        sstep(0.75, 1, Math.abs(rv - 0.5) * 2) * 0.3;
      col = [col[0] * (1 - vig), col[1] * (1 - vig), col[2] * (1 - vig)];
      buf.set(i, col);
      buf.hf[i] = (nFine[i] - 0.5) * 0.06;
      buf.rough[i] = 0.82 + m * 0.1;
      buf.metal[i] = 0.25 - m * 0.2;
    });

    // --- Interior plywood floor with water staining
    const PLY: Rgb = rgb("#87664a");
    eachPx(buf, pxRect(CR.interiorFloor, W, H), (i, ru, rv) => {
      const grain = 1 + (nStkU[i] - 0.5) * 0.16 + (nFine[i] - 0.5) * 0.08;
      let col: Rgb = [PLY[0] * grain, PLY[1] * grain, PLY[2] * grain];
      const gapLine = (ru * 6) % 1 < 0.025 ? 1 : 0;
      col = lerp3(col, GRIME, gapLine * 0.5);
      const wet = sstep(0.55, 0.85, nBlob[i]) * 0.55;
      col = [
        col[0] * (1 - wet * 0.5),
        col[1] * (1 - wet * 0.5),
        col[2] * (1 - wet * 0.45),
      ];
      buf.set(i, col);
      buf.hf[i] = (nFine[i] - 0.5) * 0.06 - gapLine * 0.15;
      buf.rough[i] = 0.9 - wet * 0.2;
      buf.metal[i] = 0;
      void rv;
    });

    // --- Corner casting: forged block with the oval hole
    const CAST: Rgb = rgb("#5d6167");
    eachPx(buf, pxRect(CR.casting, W, H), (i, ru, rv) => {
      const tv = 1 + (nVar[i] - 0.5) * 0.1 + (nFine[i] - 0.5) * 0.08;
      let col: Rgb = [CAST[0] * tv, CAST[1] * tv, CAST[2] * tv];
      const dx = (ru - 0.5) / 0.3;
      const dy = (rv - 0.5) / 0.2;
      const d = Math.sqrt(dx * dx + dy * dy);
      const hole = 1 - sstep(0.88, 1, d);
      const rim = sstep(0.85, 0.98, d) * (1 - sstep(1, 1.14, d));
      const m = clamp01(sstep(0.5, 0.8, nRust[i]) * 0.75);
      col = lerp3(col, rustColor(nHue[i], nFine[i]), m * (1 - hole));
      col = lerp3(col, rgb("#141518"), hole);
      col = lerp3(col, BARE, rim * 0.5);
      buf.set(i, col);
      buf.hf[i] = -hole * 0.6 + rim * 0.1 + (nFine[i] - 0.5) * 0.05;
      buf.rough[i] = mix(0.6 + m * 0.25, 0.9, hole);
      buf.metal[i] = mix(0.85 - m * 0.6, 0.15, hole);
    });

    // --- Frame rail paint: livery color, chipped hard along the edges
    eachPx(buf, pxRect(CR.rail, W, H), (i, ru, rv) => {
      const tv = 1 + (nVar[i] - 0.5) * 0.1;
      let col: Rgb = [
        TEAL[0] * tv * 0.92,
        TEAL[1] * tv * 0.92,
        TEAL[2] * tv * 0.92,
      ];
      const edge = Math.max(1 - sstep(0, 0.16, rv), sstep(0.84, 1, rv));
      const m = clamp01(
        sstep(0.45, 0.75, nRust[i]) * (0.35 + edge * 0.6) +
          sstep(0.8, 0.94, nChip[i]) * 0.9,
      );
      col = lerp3(col, rustColor(nHue[i], nFine[i]), m);
      const chip = sstep(0.9, 0.96, nChip[i]);
      col = lerp3(col, BARE, chip);
      buf.set(i, col);
      buf.hf[i] = (nFine[i] - 0.5) * 0.08 - chip * 0.15;
      buf.rough[i] = 0.55 + m * 0.35 - chip * 0.15;
      buf.metal[i] = 0.7 - m * 0.6 + chip * 0.3;
      void ru;
    });

    // --- Galvanised lock rod steel
    const ZINC: Rgb = rgb("#a2aaae");
    eachPx(buf, pxRect(CR.rod, W, H), (i, ru, rv) => {
      const tv = 1 + (nStkV[i] - 0.5) * 0.1 + (nFine[i] - 0.5) * 0.05;
      let col: Rgb = [ZINC[0] * tv, ZINC[1] * tv, ZINC[2] * tv];
      const m = clamp01(sstep(0.72, 0.9, nRust[i]) * 0.8);
      col = lerp3(col, rustColor(nHue[i], nFine[i]), m);
      buf.set(i, col);
      buf.hf[i] = (nFine[i] - 0.5) * 0.04;
      buf.rough[i] = 0.35 + m * 0.5;
      buf.metal[i] = 0.9 - m * 0.7;
      void ru;
      void rv;
    });

    // --- Dark tile: gaskets, fork-pocket openings
    const DARK: Rgb = rgb("#1b1c1e");
    eachPx(buf, pxRect(CR.dark, W, H), (i) => {
      const tv = 1 + (nFine[i] - 0.5) * 0.12;
      buf.set(i, [DARK[0] * tv, DARK[1] * tv, DARK[2] * tv]);
      buf.hf[i] = (nFine[i] - 0.5) * 0.03;
      buf.rough[i] = 0.92;
      buf.metal[i] = 0.05;
    });

    // Pixel grain everywhere
    for (let i = 0; i < buf.n; i++) {
      const g = 1 + (hashPix(i, 11) - 0.5) * 0.05;
      buf.mul(i, g);
    }

    return buf.build({ normal: 3.5, normalScale: 0.85, metal: true });
  });
}

/** All painted graphics of the hull atlas (coordinates at 1024-ref, x sc). */
function drawHullStencils(ctx: CanvasRenderingContext2D, sc: number): void {
  const S = (v: number) => v * sc;
  const WHITE = "#dde4de";
  const DIM = "rgba(221,228,222,0.85)";

  // --- Long wall (0,0)-(1280,400): wordmark, logo, number
  meridianMark(ctx, S(120), S(196), S(86), WHITE, S(10));
  stencilText(ctx, "MERIDIAN LINE", S(240), S(242), S(118), WHITE, 0.06);
  stencilText(ctx, "GLOBAL CARGO · FLEET 12", S(244), S(300), S(30), DIM, 0.1);
  ctx.textAlign = "left";
  stencilText(ctx, "MDLU 204187 3", S(918), S(58), S(30), WHITE, 0.08);
  stencilText(ctx, "22G1", S(1176), S(104), S(26), WHITE, 0.08);

  // --- Former roof (0,400)-(1280,717): roof number, long and worn
  stencilText(
    ctx,
    "MDLU 204187 3",
    S(210),
    S(590),
    S(78),
    "rgba(221,228,222,0.75)",
    0.3,
  );

  // --- Doors (1280,0)-(2048,471)
  // Leaf B (left, 1280..1664): brand, CSC plate, hazard hint
  meridianMark(ctx, S(1332), S(64), S(30), WHITE, S(5));
  stencilText(ctx, "MERIDIAN", S(1374), S(58), S(28), WHITE, 0.08);
  stencilText(ctx, "LINE", S(1374), S(90), S(28), WHITE, 0.08);
  // CSC safety approval plate
  ctx.fillStyle = "#9a9c98";
  ctx.beginPath();
  ctx.roundRect(S(1316), S(250), S(210), S(130), S(8));
  ctx.fill();
  ctx.strokeStyle = "#5a5c58";
  ctx.lineWidth = S(3);
  ctx.strokeRect(S(1326), S(260), S(190), S(110));
  ctx.fillStyle = "#3c3e3a";
  ctx.font = `bold ${Math.round(S(17))}px Arial, Helvetica, sans-serif`;
  ctx.textAlign = "left";
  ctx.fillText("CSC SAFETY APPROVAL", S(1334), S(282));
  ctx.font = `${Math.round(S(12))}px Arial, Helvetica, sans-serif`;
  ctx.fillText("HAV/CS/2168-4", S(1334), S(302));
  ctx.fillText("MAX GROSS 24 000 KG", S(1334), S(320));
  ctx.fillText("DATE MFD 20XX-05", S(1334), S(338));
  ctx.fillText("TIMBER TREATED", S(1334), S(356));
  // Faded hazard diamond
  ctx.save();
  ctx.globalAlpha = 0.65;
  ctx.translate(S(1600), S(320));
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = "#c96f28";
  ctx.fillRect(S(-34), S(-34), S(68), S(68));
  ctx.strokeStyle = "#f0e8dc";
  ctx.lineWidth = S(4);
  ctx.strokeRect(S(-26), S(-26), S(52), S(52));
  ctx.restore();
  // Leaf A (right, 1664..2048): the number block + size/type code
  stencilText(ctx, "MDLU", S(1704), S(84), S(56), WHITE, 0.1);
  stencilText(ctx, "204187 3", S(1704), S(152), S(56), WHITE, 0.1);
  stencilText(ctx, "22G1", S(1704), S(226), S(44), WHITE, 0.1);
  ctx.fillStyle = DIM;
  ctx.font = `bold ${Math.round(S(19))}px Arial, Helvetica, sans-serif`;
  const table = [
    ["MAX GROSS", "24 000 KG"],
    ["TARE", "2 180 KG"],
    ["NET", "21 820 KG"],
    ["CUB", "33.2 M³"],
  ];
  for (let r = 0; r < table.length; r++) {
    ctx.textAlign = "left";
    ctx.fillText(table[r][0], S(1704), S(318 + r * 28));
    ctx.textAlign = "right";
    ctx.fillText(table[r][1], S(1998), S(318 + r * 28));
  }
  ctx.textAlign = "left";

  // --- End wall (1280,471)-(2048,819): ghost logo + number
  ctx.save();
  ctx.globalAlpha = 0.4;
  meridianMark(ctx, S(1664), S(618), S(96), WHITE, S(9));
  ctx.restore();
  stencilText(ctx, "MDLU 204187 3", S(1420), S(780), S(34), DIM, 0.1);
}

// ---------------------------------------------------------------------------
// Cargo atlas (crates, pallet, cartons)
// ---------------------------------------------------------------------------

/** Spilled-cargo atlas: weathered crate planks, lid panel, cartons, pallet. */
export function cargoPbr(size: number): PbrMaps {
  return cachedPbr(cacheKey("containerCargo", [size]), () => {
    const S = size;
    const rng = new TexRng(0xca60);
    const sc = S / 1024;
    const buf = new TexBuf(S, S, rgb("#9a8568"), 0.85, 0);
    const nGrain = noiseField(S, S, 721, { freq: 3, freqY: 40, oct: 3 });
    const nGrainU = noiseField(S, S, 722, { freq: 40, freqY: 3, oct: 3 });
    const nVar = noiseField(S, S, 723, { freq: 6, oct: 4 });
    const nFine = noiseField(S, S, 724, { freq: 90, oct: 2 });
    const nStain = noiseField(S, S, 725, { freq: 5, oct: 3 });
    const nKnot = noiseField(S, S, 726, { freq: 20, oct: 2 });

    const layer = buf.layer((ctx) => {
      const P = (v: number) => v * sc;
      // Lid panel stencils (0,336)-(560,672)
      ctx.fillStyle = "rgba(30,28,24,0.88)";
      ctx.font = `900 ${Math.round(P(52))}px Arial, Helvetica, sans-serif`;
      ctx.textAlign = "left";
      ctx.fillText("MARINE SPARES", P(36), P(440));
      ctx.font = `900 ${Math.round(P(38))}px Arial, Helvetica, sans-serif`;
      ctx.fillText("HDL-7734", P(36), P(496));
      ctx.font = `bold ${Math.round(P(26))}px Arial, Helvetica, sans-serif`;
      ctx.fillText("HANDLE WITH CARE", P(36), P(548));
      // "This way up" arrows
      for (const ax of [430, 490]) {
        ctx.beginPath();
        ctx.moveTo(P(ax), P(590));
        ctx.lineTo(P(ax), P(630));
        ctx.moveTo(P(ax - 14), P(604));
        ctx.lineTo(P(ax), P(588));
        ctx.lineTo(P(ax + 14), P(604));
        ctx.strokeStyle = "rgba(30,28,24,0.88)";
        ctx.lineWidth = P(7);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(P(400), P(640));
      ctx.lineTo(P(520), P(640));
      ctx.stroke();
      // Carton print (both variants)
      for (const ox of [0, 512]) {
        ctx.fillStyle = "rgba(46,54,60,0.85)";
        ctx.font = `900 ${Math.round(P(40))}px Arial, Helvetica, sans-serif`;
        ctx.fillText("PORT HAVEN", P(ox + 40), P(760));
        ctx.fillText("CANNERY", P(ox + 40), P(806));
        ctx.font = `bold ${Math.round(P(22))}px Arial, Helvetica, sans-serif`;
        ctx.fillText("24 × 400 G · KEEP DRY", P(ox + 40), P(846));
        ctx.strokeStyle = "rgba(46,54,60,0.8)";
        ctx.lineWidth = P(4);
        ctx.strokeRect(P(ox + 356), P(724), P(96), P(96));
        ctx.beginPath();
        ctx.moveTo(P(ox + 372), P(804));
        ctx.lineTo(P(ox + 404), P(744));
        ctx.lineTo(P(ox + 436), P(804));
        ctx.stroke();
      }
      drawScratches(ctx, rng, S, S, 50, 90 * sc, 1, 0.2);
    });

    const WOOD_TONES: Rgb[] = [
      rgb("#9a8568"),
      rgb("#8b7355"),
      rgb("#a8977c"),
      rgb("#7e6a50"),
    ];
    const GREY_WOOD: Rgb = rgb("#8d8578");
    const KRAFT: Rgb = rgb("#a5876a");
    const KRAFT_WET: Rgb = rgb("#79624c");
    const TAPE: Rgb = rgb("#b8a27e");

    const wood = (
      i: number,
      ru: number,
      rv: number,
      tone: Rgb,
      grey: number,
      grain: Float32Array,
    ): void => {
      let col = lerp3(tone, GREY_WOOD, grey);
      const g = 1 + (grain[i] - 0.5) * 0.3 + (nFine[i] - 0.5) * 0.1;
      col = [col[0] * g, col[1] * g, col[2] * g];
      const knot = sstep(0.86, 0.94, nKnot[i]);
      col = lerp3(col, rgb("#4a3a28"), knot * 0.7);
      const damp = sstep(0.6, 0.9, nStain[i]) * 0.35;
      col = [
        col[0] * (1 - damp),
        col[1] * (1 - damp * 0.95),
        col[2] * (1 - damp * 0.85),
      ];
      const j = i * 4;
      const la = layer[j + 3] / 255;
      if (la > 0.01)
        col = lerp3(
          col,
          [layer[j] / 255, layer[j + 1] / 255, layer[j + 2] / 255],
          la * 0.9,
        );
      buf.set(i, col);
      buf.hf[i] = (grain[i] - 0.5) * 0.2 + (nFine[i] - 0.5) * 0.07 - knot * 0.1;
      buf.rough[i] = 0.85 + damp * 0.08 - la * 0.1;
      void ru;
      void rv;
    };

    // Planks: 8 rows, alternating tone, gaps between rows, nail heads
    eachPx(buf, pxRect(CGR.planks, S, S), (i, ru, rv) => {
      const row = Math.min(PLANK_ROWS - 1, Math.floor((1 - rv) * PLANK_ROWS));
      const tone = WOOD_TONES[row % WOOD_TONES.length];
      const grey = 0.3 + 0.4 * ((row * 0.37) % 1);
      wood(i, ru, rv, tone, grey, nGrainU);
      const rvIn = (1 - rv) * PLANK_ROWS - row;
      const edge = Math.max(1 - sstep(0, 0.09, rvIn), sstep(0.91, 1, rvIn));
      buf.hf[i] -= edge * 0.3;
      buf.mul(i, 1 - edge * 0.3);
      for (const nu of [0.05, 0.95]) {
        const d = Math.hypot((ru - nu) * 40, (rvIn - 0.5) * 3.4);
        const nail = 1 - sstep(0.5, 0.9, d);
        if (nail > 0) {
          buf.mixTo(i, rgb("#4e4a46"), nail * 0.85);
          buf.hf[i] += nail * 0.12;
          buf.metal[i] = Math.max(buf.metal[i], nail * 0.6);
        }
      }
    });

    // Lid panel: vertical grain + stencils (in the layer)
    eachPx(buf, pxRect(CGR.lid, S, S), (i, ru, rv) => {
      wood(i, ru, rv, WOOD_TONES[0], 0.42, nGrain);
      const line = (ru * 5) % 1 < 0.03 ? 1 : 0;
      buf.hf[i] -= line * 0.2;
      buf.mul(i, 1 - line * 0.25);
    });

    // End grain
    eachPx(buf, pxRect(CGR.endGrain, S, S), (i, ru, rv) => {
      const d = Math.hypot(ru - 0.5, rv - 0.5);
      const ringField = Math.sin(d * 46 + nVar[i] * 3) * 0.5 + 0.5;
      let col = lerp3(rgb("#a08a6a"), rgb("#6e5a42"), ringField * 0.7);
      col = [col[0] * (1 + (nFine[i] - 0.5) * 0.12), col[1], col[2]];
      buf.set(i, col);
      buf.hf[i] = (ringField - 0.5) * 0.12;
      buf.rough[i] = 0.88;
    });

    // Pallet wood: greyer, rougher
    eachPx(buf, pxRect(CGR.pallet, S, S), (i, ru, rv) => {
      wood(i, ru, rv, WOOD_TONES[3], 0.62, nGrainU);
      buf.rough[i] = Math.min(0.97, buf.rough[i] + 0.06);
    });

    // Cartons: kraft + tape band + water swell (wet variant darker)
    const carton = (i: number, ru: number, rv: number, wet: boolean): void => {
      const base = wet ? KRAFT_WET : KRAFT;
      const tv = 1 + (nVar[i] - 0.5) * 0.12 + (nFine[i] - 0.5) * 0.06;
      let col: Rgb = [base[0] * tv, base[1] * tv, base[2] * tv];
      // Water damage creeps from the bottom of each face
      const soak =
        sstep(0.45, 0.05, rv) * (wet ? 0.75 : 0.4) * (0.6 + nStain[i] * 0.6);
      col = [
        col[0] * (1 - soak * 0.45),
        col[1] * (1 - soak * 0.42),
        col[2] * (1 - soak * 0.35),
      ];
      // Tape band across the middle
      const tape = 1 - sstep(0.05, 0.085, Math.abs(ru - 0.5));
      col = lerp3(col, TAPE, tape * 0.85);
      const j = i * 4;
      const la = (layer[j + 3] / 255) * (1 - soak * 0.5);
      if (la > 0.01)
        col = lerp3(
          col,
          [layer[j] / 255, layer[j + 1] / 255, layer[j + 2] / 255],
          la,
        );
      buf.set(i, col);
      // Swollen wrinkles
      buf.hf[i] =
        (nGrainU[i] - 0.5) * 0.16 * (0.5 + soak) +
        (nFine[i] - 0.5) * 0.05 +
        tape * 0.05;
      buf.rough[i] = 0.88 - tape * 0.25 + soak * 0.06;
      buf.metal[i] = 0;
    };
    eachPx(buf, pxRect(CGR.carton, S, S), (i, ru, rv) =>
      carton(i, ru, rv, false),
    );
    eachPx(buf, pxRect(CGR.cartonWet, S, S), (i, ru, rv) =>
      carton(i, ru, rv, true),
    );

    for (let i = 0; i < buf.n; i++)
      buf.mul(i, 1 + (hashPix(i, 13) - 0.5) * 0.06);

    return buf.build({ normal: 4, normalScale: 0.8 });
  });
}

// ---------------------------------------------------------------------------
// Shrink wrap
// ---------------------------------------------------------------------------

/**
 * Semi-gloss shrink wrap over stacked boxes. v 0..~0.72 is the solid wrap
 * (bundle faces map here), v 0.72..0.95 a ragged torn fringe (alpha), above
 * that fully transparent. Two darker strap bands per face at u 0.32/0.68.
 * 512^2, map + normal + roughness, alphaTest.
 */
export function wrapPbr(): PbrMaps {
  return cachedPbr(cacheKey("containerWrap", []), () => {
    const S = 512;
    const rng = new TexRng(0x3a9);
    const base = rgb("#bcc7cc");
    const buf = new TexBuf(S, S, base, 0.3, 0);
    const nBox = noiseField(S, S, 731, { freq: 3, oct: 2 });
    const nFold = noiseField(S, S, 732, {
      freq: 8,
      freqY: 60,
      oct: 3,
      mode: "ridged",
    });
    const nFine = noiseField(S, S, 733, { freq: 70, oct: 2 });
    const nTear = noiseField(S, S, 734, { freq: 12, oct: 3 });
    const creases = TexBuf.layerAlpha(
      buf.layer((ctx) => {
        drawScratches(ctx, rng, S, S, 46, 220, 2.2, 0.5, 1.1);
        drawScratches(ctx, rng, S, S, 30, 160, 1.6, 0.4, 2.2);
      }),
      buf.n,
    );
    const CARTON_GHOST: Rgb = rgb("#8d8272");
    buf.each((i, u, v) => {
      // Ghost of the carton stack under the film
      const gx = Math.abs(((u * 3) % 1) - 0.5);
      const gy = Math.abs(((v * 4.2) % 1) - 0.5);
      const seams = Math.max(sstep(0.4, 0.5, gx), sstep(0.4, 0.5, gy));
      let col = lerp3(
        base,
        CARTON_GHOST,
        0.32 + seams * 0.3 + (nBox[i] - 0.5) * 0.18,
      );
      // Straps
      for (const su of [0.32, 0.68]) {
        const st = 1 - sstep(0.02, 0.035, Math.abs(u - su));
        col = lerp3(col, rgb("#46564c"), st * 0.7);
      }
      // Film folds: bright ridged streaks
      const fold = sstep(0.62, 0.9, nFold[i]) + creases[i] * 0.8;
      col = lerp3(col, rgb("#eef2f4"), clamp01(fold) * 0.4);
      buf.set(i, col);
      buf.hf[i] = fold * 0.22 + (nFine[i] - 0.5) * 0.04;
      buf.rough[i] = 0.26 - fold * 0.1 + (nFine[i] - 0.5) * 0.1 + seams * 0.08;
      // Torn fringe
      if (v > 0.72) {
        const rag = 0.72 + 0.2 * nTear[i];
        buf.a[i] = v < rag ? 1 : 0;
      }
    });
    return buf.build({
      normal: 5,
      normalScale: 0.7,
      alpha: true,
      alphaTest: 0.5,
      doubleSide: true,
    });
  });
}
