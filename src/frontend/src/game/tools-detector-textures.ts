// Metal detector – canvas-painted decals and dress-up textures for
// tools-detector.ts (world decals) and player-viewmodel.ts (the SANDLARK 40
// viewmodel: pod face plate, live LCD painter, coil top, grip foam). Fully
// procedural; the ground decals follow the quality tier like the other
// *-textures.ts files, the viewmodel maps are small fixed sizes (they cover
// a few centimetres of screen). Everything static goes through the shared
// texture cache, so repeated tool swaps never repaint; only the LCD painter
// is called again – and only when the displayed value actually changes.

import type * as THREE from "three";
import { mulberry32 } from "./noise";
import {
  cacheKey,
  cachedTex,
  makeCanvas,
  texFromCanvas,
} from "./textures-core";
import type { QualityId } from "./types";

/** Decal canvas size per quality tier (small ground decals). */
const DECAL_SIZE: Record<QualityId, number> = {
  ultra: 256,
  high: 192,
  medium: 128,
  low: 96,
};

/**
 * Subtle scuff ring shown at a pinpointed signal: a broken circle of short
 * dragged strokes, as if the coil's edge marked the sand. Transparent decal.
 */
export function scuffRingTexture(q: QualityId): THREE.Texture {
  const s = DECAL_SIZE[q];
  return cachedTex(cacheKey("detScuffRing", [s]), () => {
    const [c, ctx] = makeCanvas(s, s);
    ctx.clearRect(0, 0, s, s);
    const rng = mulberry32(0x5c0ff);
    const cx = s / 2;
    const r0 = s * 0.34;
    ctx.lineCap = "round";
    // Two passes: a darker damp-sand groove with a lighter kicked-up edge.
    for (const [tone, width, rr] of [
      ["87,70,50", s * 0.028, r0],
      ["224,205,168", s * 0.016, r0 + s * 0.02],
    ] as const) {
      let a = rng() * Math.PI * 2;
      while (a < Math.PI * 2 * (1 + rng() * 0.1)) {
        const seg = 0.18 + rng() * 0.5;
        const rj = rr + (rng() - 0.5) * s * 0.03;
        ctx.strokeStyle = `rgba(${tone},${0.35 + rng() * 0.35})`;
        ctx.lineWidth = width * (0.7 + rng() * 0.6);
        ctx.beginPath();
        ctx.arc(cx, cx, rj, a, a + seg);
        ctx.stroke();
        a += seg + 0.08 + rng() * 0.25;
      }
    }
    // A few stray grains around the ring
    for (let i = 0; i < s / 3; i++) {
      const a = rng() * Math.PI * 2;
      const rr = r0 * (0.85 + rng() * 0.35);
      ctx.fillStyle = `rgba(${rng() < 0.5 ? "87,70,50" : "224,205,168"},${
        0.25 + rng() * 0.3
      })`;
      const g = s * (0.004 + rng() * 0.008);
      ctx.fillRect(cx + Math.cos(a) * rr, cx + Math.sin(a) * rr, g, g);
    }
    return texFromCanvas(c, true, false, false);
  });
}

/**
 * Dug hole: a dark, damp scoop with a rough spoil rim – laid flat on the
 * sand as a fading decal (the small spoil mound is real geometry).
 */
export function digHoleTexture(q: QualityId): THREE.Texture {
  const s = DECAL_SIZE[q];
  return cachedTex(cacheKey("detDigHole", [s]), () => {
    const [c, ctx] = makeCanvas(s, s);
    ctx.clearRect(0, 0, s, s);
    const rng = mulberry32(0xd16d16);
    const cx = s / 2;
    // Damp halo where the digging churned the sand
    let g = ctx.createRadialGradient(cx, cx, 0, cx, cx, s * 0.46);
    g.addColorStop(0, "rgba(120,98,70,0.55)");
    g.addColorStop(0.75, "rgba(120,98,70,0.28)");
    g.addColorStop(1, "rgba(120,98,70,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    // The hole itself: dark wet centre, slightly lumpy outline
    ctx.save();
    ctx.translate(cx, cx);
    ctx.beginPath();
    const rH = s * 0.21;
    const lump = mulberry32(0xd161);
    const wob: number[] = [];
    for (let i = 0; i < 24; i++) wob.push(0.82 + 0.28 * lump());
    for (let i = 0; i <= 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const rr = rH * wob[i % 24];
      if (i === 0) ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
      else ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath();
    g = ctx.createRadialGradient(0, 0, 0, 0, 0, rH);
    g.addColorStop(0, "rgba(38,28,18,0.95)");
    g.addColorStop(0.7, "rgba(58,44,28,0.9)");
    g.addColorStop(1, "rgba(84,66,44,0.75)");
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
    // Thrown crumbs of spoil
    for (let i = 0; i < s / 2; i++) {
      const a = rng() * Math.PI * 2;
      const rr = s * (0.24 + rng() * 0.2);
      ctx.fillStyle = `rgba(${rng() < 0.6 ? "96,76,50" : "150,126,92"},${
        0.3 + rng() * 0.4
      })`;
      const gr = s * (0.006 + rng() * 0.012);
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * rr, cx + Math.sin(a) * rr, gr, 0, 7);
      ctx.fill();
    }
    return texFromCanvas(c, true, false, false);
  });
}

// ---------------------------------------------------------------------------
// Viewmodel detector (SANDLARK 40)
// ---------------------------------------------------------------------------

/**
 * Physical footprint of the pod's face plate in rig metres – the art below
 * pre-compensates for this aspect so text and circles are not squashed when
 * the square canvas is mapped onto the long plate.
 */
export const DET_FACE_W = 0.066;
export const DET_FACE_D = 0.124;

/**
 * Face plate of the control pod (a PlaneGeometry facing +y; canvas TOP =
 * pod front, canvas BOTTOM = towards the player). Worn dark plastic with
 * corner screws, two control dials' tick scales (the knobs themselves are
 * geometry), a speaker slot row, the fictional SANDLARK 40 brand decal and
 * the recessed LCD window (covered by the live display mesh) with the
 * signal-lamp mount beside it.
 */
export function detectorFaceTexture(): THREE.Texture {
  return cachedTex(cacheKey("detFace2", []), () => {
    const S = 256;
    const [c, ctx] = makeCanvas(S, S);
    // Base plastic
    ctx.fillStyle = "#24262a";
    ctx.fillRect(0, 0, S, S);
    const rng = mulberry32(0xface5);
    for (let i = 0; i < 1600; i++) {
      ctx.fillStyle = `rgba(255,255,255,${rng() * 0.028})`;
      ctx.fillRect(rng() * S, rng() * S, 1, 1);
    }
    // Fine horizontal brush drag (moulding direction along the pod)
    for (let i = 0; i < 90; i++) {
      const y = rng() * S;
      ctx.strokeStyle = `rgba(${rng() < 0.5 ? "0,0,0" : "255,255,255"},${
        0.02 + rng() * 0.03
      })`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(rng() * S * 0.3, y);
      ctx.lineTo(S - rng() * S * 0.3, y);
      ctx.stroke();
    }

    // Everything else is drawn undistorted in a logical 136×256 space that
    // matches the plate's physical aspect (DET_FACE_W : DET_FACE_D).
    const LW = Math.round((DET_FACE_W / DET_FACE_D) * S); // 136
    ctx.save();
    ctx.scale(S / LW, 1);

    // Edge shading + wear: darker rim, pale scuffs on the corners
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 5;
    ctx.strokeRect(2.5, 2.5, LW - 5, S - 5);
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(6, 6, LW - 12, S - 12);
    for (let i = 0; i < 26; i++) {
      const edge = rng();
      const x = edge < 0.5 ? 3 + rng() * 10 : LW - 3 - rng() * 10;
      const y = rng() * S;
      ctx.strokeStyle = `rgba(190,195,200,${0.05 + rng() * 0.1})`;
      ctx.lineWidth = 0.8 + rng() * 1.4;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (rng() - 0.5) * 8, y + 4 + rng() * 14);
      ctx.stroke();
    }

    // Corner screws (phillips heads)
    for (const [sx, sy] of [
      [11, 13],
      [LW - 11, 13],
      [11, S - 13],
      [LW - 11, S - 13],
    ]) {
      const g = ctx.createRadialGradient(sx - 1, sy - 1, 0.5, sx, sy, 5.5);
      g.addColorStop(0, "#8d939a");
      g.addColorStop(0.7, "#4d5258");
      g.addColorStop(1, "#17181a");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(sx, sy, 5.2, 0, 7);
      ctx.fill();
      ctx.strokeStyle = "#101113";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(sx - 3.2, sy);
      ctx.lineTo(sx + 3.2, sy);
      ctx.moveTo(sx, sy - 3.2);
      ctx.lineTo(sx, sy + 3.2);
      ctx.stroke();
    }

    // Brand decal band (front of the pod): slightly raised pale plate
    ctx.fillStyle = "#1b1d20";
    ctx.beginPath();
    ctx.roundRect(16, 22, LW - 32, 40, 4);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.fillStyle = "#e3e7ea";
    ctx.font = "italic bold 17px Arial, sans-serif";
    ctx.fillText("SANDLARK", LW / 2 - 8, 41);
    ctx.fillStyle = "#e8c15a";
    ctx.font = "italic bold 15px Arial, sans-serif";
    ctx.fillText("40", LW / 2 + 46, 41);
    // Accent swoosh under the brand
    ctx.strokeStyle = "#e8c15a";
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(24, 48);
    ctx.quadraticCurveTo(LW / 2, 54, LW - 26, 46);
    ctx.stroke();
    ctx.fillStyle = "#7d838a";
    ctx.font = "7px Arial, sans-serif";
    ctx.fillText("VLF  ·  GROUND SWEEP  ·  SALT MODE", LW / 2, 58);

    // Control dials: tick scales + labels (the knurled knobs are geometry)
    for (const [kx, label] of [
      [34, "DISC"],
      [102, "SENS"],
    ] as const) {
      const ky = 95;
      ctx.strokeStyle = "#8b9095";
      ctx.lineWidth = 1.6;
      for (let i = 0; i <= 10; i++) {
        const a = Math.PI * (0.75 + (i / 10) * 1.5);
        ctx.beginPath();
        ctx.moveTo(kx + Math.cos(a) * 17, ky + Math.sin(a) * 17);
        ctx.lineTo(kx + Math.cos(a) * 21, ky + Math.sin(a) * 21);
        ctx.stroke();
      }
      // Shadow ring where the knob sits
      const g = ctx.createRadialGradient(kx, ky, 6, kx, ky, 15);
      g.addColorStop(0, "rgba(0,0,0,0.55)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(kx, ky, 15, 0, 7);
      ctx.fill();
      ctx.fillStyle = "#9aa0a6";
      ctx.font = "bold 8px Arial, sans-serif";
      ctx.fillText(label, kx, 127);
    }

    // Speaker slot row between dials and the LCD
    ctx.fillStyle = "#0e0f10";
    for (let i = 0; i < 6; i++) {
      ctx.beginPath();
      ctx.roundRect(26 + i * 15, 138, 9, 3.4, 1.6);
      ctx.fill();
    }

    // LCD recess (the live display mesh sits in this window)
    ctx.fillStyle = "#0a0b0c";
    ctx.beginPath();
    ctx.roundRect(6, 156, 108, 76, 5);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(4.5, 154.5, 111, 79, 6);
    ctx.stroke();

    // Signal-lamp mount beside the LCD: dark ring, "SIG" microlabel
    ctx.fillStyle = "#101214";
    ctx.beginPath();
    ctx.arc(122, 226, 8.5, 0, 7);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.1)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(122, 226, 8.5, 0, 7);
    ctx.stroke();
    ctx.fillStyle = "#7d838a";
    ctx.font = "bold 7px Arial, sans-serif";
    ctx.fillText("SIG", 122, 212);

    // Serial sticker, slightly askew (worn)
    ctx.save();
    ctx.translate(122, 176);
    ctx.rotate(-0.06);
    ctx.fillStyle = "rgba(214,210,196,0.85)";
    ctx.fillRect(-8, -14, 16, 28);
    ctx.fillStyle = "#3a3b36";
    ctx.font = "5px Arial, sans-serif";
    ctx.save();
    ctx.rotate(Math.PI / 2);
    ctx.fillText("SN 40-77812", 0, 2);
    ctx.restore();
    ctx.restore();

    ctx.restore();
    return texFromCanvas(c, true, false, false);
  });
}

/** Physical LCD footprint (rig metres) – matches the painter's aspect. */
export const DET_LCD_W = 0.048;
export const DET_LCD_D = 0.034;
/** Canvas size of the live LCD (same aspect as DET_LCD_W : DET_LCD_D). */
export const DET_LCD_PX_W = 160;
export const DET_LCD_PX_H = 112;

/**
 * Paint the live LCD: a backlit signal readout with a large numeric value
 * (0–100), a 20-segment bar that fills with signal strength and a PINPOINT
 * tag at a lock. Called by the viewmodel ONLY when the displayed integer or
 * the lock state changes – never per frame while idle.
 */
export function paintDetectorDisplay(
  ctx: CanvasRenderingContext2D,
  value: number,
  locked: boolean,
): void {
  const w = DET_LCD_PX_W;
  const h = DET_LCD_PX_H;
  const v = Math.max(0, Math.min(100, Math.round(value)));
  // Backlit glass
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, locked ? "#18220f" : "#121a0c");
  bg.addColorStop(1, locked ? "#1d2a12" : "#16200e");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  // Faint scanlines
  ctx.fillStyle = "rgba(255,255,255,0.016)";
  for (let y = 2; y < h; y += 4) ctx.fillRect(0, y, w, 1);
  // Captions
  ctx.textAlign = "left";
  ctx.fillStyle = "#7d9a5e";
  ctx.font = "bold 13px Arial, sans-serif";
  ctx.fillText("SIGNAL", 8, 18);
  ctx.textAlign = "right";
  ctx.fillStyle = "#5d7548";
  ctx.font = "bold 10px Arial, sans-serif";
  ctx.fillText("SL·40", w - 8, 17);
  // Ghost digits (unlit LCD segments) + the live value
  ctx.font = "bold 46px Consolas, 'Courier New', monospace";
  ctx.fillStyle = "rgba(140,170,90,0.05)";
  ctx.fillText("888", w - 10, 62);
  ctx.fillStyle = locked ? "#e8ffb0" : "#cdf09a";
  ctx.shadowColor = "rgba(154,223,90,0.8)";
  ctx.shadowBlur = locked ? 10 : 6;
  ctx.fillText(String(v), w - 10, 62);
  ctx.shadowBlur = 0;
  // Status line
  ctx.textAlign = "left";
  if (locked) {
    ctx.fillStyle = "#ffdf88";
    ctx.font = "bold 12px Arial, sans-serif";
    ctx.fillText("◆ PINPOINT", 8, 60);
  } else {
    ctx.fillStyle = "#66804f";
    ctx.font = "10px Arial, sans-serif";
    ctx.fillText(v > 0 ? "TARGET" : "SEARCH", 8, 59);
  }
  // 20-segment bar
  const bx = 8;
  const by = 76;
  const bw = w - 16;
  const bh = 26;
  ctx.strokeStyle = "rgba(140,170,100,0.35)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(bx - 2.5, by - 2.5, bw + 5, bh + 5);
  const lit = locked ? 20 : Math.round(v / 5);
  const segW = bw / 20;
  for (let i = 0; i < 20; i++) {
    ctx.fillStyle =
      i < lit
        ? i < 12
          ? "#a8e06a"
          : i < 16
            ? "#e0c85a"
            : "#ef8f4a"
        : "rgba(150,175,110,0.10)";
    ctx.fillRect(bx + i * segW + 1, by, segW - 2, bh);
  }
  if (locked) {
    ctx.fillStyle = "rgba(190,240,130,0.06)";
    ctx.fillRect(0, 0, w, h);
  }
}

/**
 * Top of the search coil: an elliptical double-D shell – two moulded D
 * windings meeting on a centre spine, a bolt boss, shallow radial ribs and
 * a scuffed, sand-worn rim. The geometry stretches this circular art into
 * the ellipse, so everything here is drawn round.
 */
export function coilTopTexture(): THREE.Texture {
  return cachedTex(cacheKey("detCoilTop2", []), () => {
    const S = 256;
    const [c, ctx] = makeCanvas(S, S);
    ctx.fillStyle = "#2c3034";
    ctx.fillRect(0, 0, S, S);
    const cx = S / 2;
    const rng = mulberry32(0xc011);

    // Shallow radial mould ribs
    ctx.strokeStyle = "rgba(0,0,0,0.22)";
    ctx.lineWidth = 5;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.39;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * S * 0.13, cx + Math.sin(a) * S * 0.13);
      ctx.lineTo(cx + Math.cos(a) * S * 0.44, cx + Math.sin(a) * S * 0.44);
      ctx.stroke();
    }

    // The two D windings: moulded channels (dark groove + light edge).
    // Flat sides meet at the vertical centre line; arcs bow outwards.
    const dR = S * 0.31;
    for (const side of [-1, 1]) {
      for (const [tone, width, off] of [
        ["rgba(0,0,0,0.45)", 7, 0],
        ["rgba(255,255,255,0.10)", 2.5, 3],
      ] as const) {
        ctx.strokeStyle = tone;
        ctx.lineWidth = width;
        ctx.beginPath();
        // Flat edge just off centre, then the outer arc
        const fx = cx + side * (S * 0.035 + off * side * 0.3);
        ctx.moveTo(fx, cx - dR);
        ctx.lineTo(fx, cx + dR);
        ctx.arc(fx, cx, dR - off, Math.PI / 2, -Math.PI / 2, side < 0);
        ctx.closePath();
        ctx.stroke();
      }
    }

    // Centre spine bar (raised: light top edge, dark bottom)
    ctx.fillStyle = "#33383d";
    ctx.fillRect(cx - S * 0.055, cx - S * 0.4, S * 0.11, S * 0.8);
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = 2;
    ctx.strokeRect(cx - S * 0.055, cx - S * 0.4, S * 0.11, S * 0.8);

    // Bolt boss with a hex hint
    let g = ctx.createRadialGradient(cx - 3, cx - 3, 2, cx, cx, S * 0.085);
    g.addColorStop(0, "#4b5157");
    g.addColorStop(0.7, "#33373c");
    g.addColorStop(1, "#22252a");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cx, S * 0.085, 0, 7);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let i = 0; i <= 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.26;
      const x = cx + Math.cos(a) * S * 0.052;
      const y = cx + Math.sin(a) * S * 0.052;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();

    // Brand print on the front lobe
    ctx.fillStyle = "rgba(200,205,210,0.5)";
    ctx.font = "bold 13px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("SANDLARK", cx, cx - S * 0.335);
    ctx.font = "9px Arial, sans-serif";
    ctx.fillStyle = "rgba(200,205,210,0.35)";
    ctx.fillText("DD-30 SALT", cx, cx + S * 0.36);

    // Scuffed rim: pale abrasion strokes hugging the outer edge
    ctx.lineCap = "round";
    for (let i = 0; i < 60; i++) {
      const a = rng() * Math.PI * 2;
      const rr = S * (0.435 + rng() * 0.05);
      const seg = 0.06 + rng() * 0.22;
      ctx.strokeStyle = `rgba(${
        rng() < 0.65 ? "182,178,168" : "120,112,98"
      },${0.08 + rng() * 0.2})`;
      ctx.lineWidth = 1 + rng() * 2.6;
      ctx.beginPath();
      ctx.arc(cx, cx, rr, a, a + seg);
      ctx.stroke();
    }
    // Grime + speckle
    for (let i = 0; i < 700; i++) {
      ctx.fillStyle = `rgba(${rng() < 0.5 ? "255,255,255" : "0,0,0"},${
        rng() * 0.05
      })`;
      ctx.fillRect(rng() * S, rng() * S, 1, 1);
    }
    // A few sandy drag scratches
    for (let i = 0; i < 9; i++) {
      const a = rng() * Math.PI * 2;
      const r0 = S * (0.1 + rng() * 0.3);
      ctx.strokeStyle = `rgba(196,186,166,${0.06 + rng() * 0.1})`;
      ctx.lineWidth = 0.8 + rng();
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cx + Math.sin(a) * r0);
      ctx.lineTo(
        cx + Math.cos(a) * r0 + (rng() - 0.5) * 60,
        cx + Math.sin(a) * r0 + (rng() - 0.5) * 60,
      );
      ctx.stroke();
    }
    return texFromCanvas(c, true, false, false);
  });
}

/**
 * Tileable EVA-foam texture for the grip sleeve and the arm-cuff pad:
 * dense dark pores with a hint of wear sheen.
 */
export function gripFoamTexture(): THREE.Texture {
  return cachedTex(cacheKey("detGripFoam", []), () => {
    const S = 64;
    const [c, ctx] = makeCanvas(S, S);
    ctx.fillStyle = "#1c1d1f";
    ctx.fillRect(0, 0, S, S);
    const rng = mulberry32(0xf0a3);
    for (let i = 0; i < 340; i++) {
      ctx.fillStyle = `rgba(0,0,0,${0.15 + rng() * 0.25})`;
      const r = 0.5 + rng() * 1.1;
      ctx.beginPath();
      ctx.arc(rng() * S, rng() * S, r, 0, 7);
      ctx.fill();
    }
    for (let i = 0; i < 90; i++) {
      ctx.fillStyle = `rgba(255,255,255,${0.02 + rng() * 0.05})`;
      ctx.fillRect(rng() * S, rng() * S, 1, 1);
    }
    // Soft worn sheen band (fingers polish the foam)
    const g = ctx.createLinearGradient(0, 0, S, 0);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.5, "rgba(255,255,255,0.045)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    return texFromCanvas(c, true, true, true);
  });
}
