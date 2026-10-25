// Procedural PBR textures for the stranded fishing boat (landmark-boat.ts).
//
// boatHullPbr()     1024² – 16 horizontal bands, one per clinker strake
//                   (rows 0..7 port garboard→sheer, rows 8..15 starboard).
//                   Two-tone paint (oxblood below the rubbing strake, chalky
//                   white sheer strake) peeling to grey driftwood, tar seams
//                   along the plank edges, rivet lines with rust bleed and the
//                   hand-painted name "Sea Lark" on both bow quarters.
// boatWoodPbr()     512² tileable bare driftwood for keel, frames, thwarts,
//                   bottom boards, oars and gunwale caps (tinted per part
//                   through vertex colors).
// boatDressingPbr() 512² atlas: net weave with alpha (top left), rope strands
//                   (top right), cracked buoy plastic (bottom left) and rusted
//                   iron (bottom right).

import {
  type PbrMaps,
  type Rgb,
  TexBuf,
  TexRng,
  cacheKey,
  cachedPbr,
  hash01,
  hashPix,
  lerp3,
  mix,
  noiseField,
  rgb,
  sstep,
} from "./textures-core";

/** Number of strake bands in the hull texture (8 per side). */
export const HULL_ROWS = 16;

/** v coordinate inside strake band `row` (f = 0 bottom edge … 1 top edge). */
export function hullRowV(row: number, f: number): number {
  return (row + f) / HULL_ROWS;
}

// ---------------------------------------------------------------------------
// Hull strakes
// ---------------------------------------------------------------------------

const OXBLOOD: Rgb = rgb("#7c2f24");
const OXBLOOD_FADE: Rgb = rgb("#a96a54");
const PRIMER: Rgb = rgb("#977c6d");
const CHALK: Rgb = rgb("#d9d5c6");
const CHALK_FADE: Rgb = rgb("#c2c4b8");
const UNDERCOAT: Rgb = rgb("#7e98a1");
const WOOD_DARK: Rgb = rgb("#6b6355");
const WOOD_LIGHT: Rgb = rgb("#a89f8a");
const TAR: Rgb = rgb("#262019");

/** Hand-painted boat name, per letter with jitter, then weathered. */
function paintName(
  ctx: CanvasRenderingContext2D,
  rng: TexRng,
  cx: number,
  cy: number,
  mirror: boolean,
): void {
  ctx.save();
  if (mirror) {
    // Mirror horizontally so the text reads correctly on the mirrored side
    ctx.translate(1024, 0);
    ctx.scale(-1, 1);
  }
  const text = "Sea Lark";
  ctx.font = "italic 600 34px Georgia, 'Times New Roman', serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const widths: number[] = [];
  let total = 0;
  for (const ch of text) {
    const w = ctx.measureText(ch).width;
    widths.push(w);
    total += w;
  }
  let x = cx - total / 2;
  for (let i = 0; i < text.length; i++) {
    const w = widths[i];
    const t = (x + w / 2 - (cx - total / 2)) / total;
    const dy = -3.5 * Math.sin(Math.PI * t) + rng.range(-1.2, 1.2);
    ctx.save();
    ctx.translate(x + w / 2, cy + dy);
    ctx.rotate(rng.range(-0.045, 0.045));
    // Shadowed double coat, like a sign writer's brush
    ctx.fillStyle = "rgba(24,32,42,0.55)";
    ctx.fillText(text[i], 1.2, 1.4);
    ctx.fillStyle = "rgba(45,70,96,0.92)";
    ctx.fillText(text[i], 0, 0);
    ctx.restore();
    x += w;
  }
  // Weather the paint away in specks
  ctx.globalCompositeOperation = "destination-out";
  for (let k = 0; k < 90; k++) {
    const px = cx - total / 2 + rng.next() * total;
    const py = cy + rng.range(-16, 16);
    ctx.fillStyle = `rgba(0,0,0,${rng.range(0.25, 0.8)})`;
    ctx.beginPath();
    ctx.ellipse(
      px,
      py,
      rng.range(0.6, 2.6),
      rng.range(0.5, 1.6),
      rng.next() * Math.PI,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Hull plank texture: one 64 px band per strake, u = stern→bow. Paint chips
 * follow noise + edge wear; the lowest strakes are the most abraded (beach),
 * seams carry tar, rivet lines bleed rust downwards across the seams.
 */
export function boatHullPbr(): PbrMaps {
  return cachedPbr(cacheKey("boatHull", []), () => {
    const S = 1024;
    const ROW = S / HULL_ROWS;
    const rng = new TexRng(0xb0a7);
    const buf = new TexBuf(S, S, WOOD_LIGHT, 0.85, 0);
    const grainA = noiseField(S, S, 9101, { freq: 6, freqY: 240, oct: 3 });
    const grainB = noiseField(S, S, 9102, { freq: 30, freqY: 420, oct: 2 });
    const peelN = noiseField(S, S, 9103, { freq: 9, oct: 4 });
    const chipN = noiseField(S, S, 9104, { freq: 60, oct: 2 });
    const dirtN = noiseField(S, S, 9105, { freq: 5, oct: 3 });

    // Per-row jitter (paint tone, wear bias)
    const rowTone: number[] = [];
    const rowWear: number[] = [];
    for (let r = 0; r < HULL_ROWS; r++) {
      rowTone.push(0.88 + hash01(r, 3, 51) * 0.24);
      rowWear.push(hash01(r, 7, 52) * 0.16);
    }

    buf.each((i, u, v) => {
      const r = Math.min(HULL_ROWS - 1, Math.floor(v * HULL_ROWS));
      const idx = r % 8; // strake index: 0 garboard … 7 sheer
      const vr = v * HULL_ROWS - r; // 0 bottom edge … 1 top edge
      const gA = grainA[i];
      const gB = grainB[i];
      const grain =
        0.82 + gA * 0.3 + (gB - 0.5) * 0.28 + (hashPix(i, 5) - 0.5) * 0.08;

      // Bare weathered wood beneath everything
      const wood = lerp3(
        WOOD_DARK,
        WOOD_LIGHT,
        Math.min(1, gA * 0.75 + gB * 0.45),
      );

      // Wear: heavier near the stern (small u), near plank edges and on the
      // lower strakes that grind in the sand.
      const edge = Math.max(sstep(0.2, 0.04, vr), sstep(0.82, 0.97, vr));
      const wear =
        rowWear[r] +
        0.26 * (1 - sstep(0.06, 0.42, u)) +
        0.2 * (1 - idx / 7) +
        0.2 * edge +
        0.16 * sstep(0.6, 0.95, chipN[i]);
      const cover = peelN[i] - wear * 0.5;

      const sheer = idx === 7;
      let col: Rgb;
      let rough: number;
      let paintH = 0;
      if (sheer) {
        if (cover > 0.4) {
          col = lerp3(CHALK, CHALK_FADE, dirtN[i] * 0.8);
          rough = 0.88;
          paintH = 0.55;
        } else if (cover > 0.27) {
          col = lerp3(UNDERCOAT, CHALK_FADE, 0.25 + dirtN[i] * 0.3);
          rough = 0.8;
          paintH = 0.3;
        } else {
          col = wood;
          rough = 0.86;
        }
      } else {
        if (cover > 0.37) {
          const fade =
            0.2 + 0.5 * (1 - dirtN[i]) * (1 - sstep(0.1, 0.5, u) * 0.4);
          col = lerp3(OXBLOOD, OXBLOOD_FADE, Math.min(1, fade));
          rough = 0.74 + dirtN[i] * 0.08;
          paintH = 0.55;
        } else if (cover > 0.29) {
          col = lerp3(PRIMER, wood, 0.35);
          rough = 0.8;
          paintH = 0.25;
        } else {
          col = wood;
          rough = 0.87;
        }
      }

      let k = grain * rowTone[r];
      let hf = (gA - 0.5) * 0.5 + (gB - 0.5) * 0.35 + paintH;

      // Tar in the plank seams (the lap shadow line lives here too)
      const tar = Math.max(sstep(0.085, 0.02, vr), sstep(0.955, 0.995, vr));
      if (tar > 0) {
        col = lerp3(col, TAR, tar * 0.9);
        rough = mix(rough, 0.62, tar);
        hf -= tar * 0.9;
        k = mix(k, 1, tar * 0.5);
      }

      // Big soft grime gradient, sinking to the lower strakes
      k *= 1 - 0.16 * dirtN[i] * (1 - idx / 9);
      // Ambient occlusion under the overhanging land of the plank above
      k *= 1 - 0.38 * sstep(0.78, 0.97, vr);

      buf.set(i, [col[0] * k, col[1] * k, col[2] * k]);
      buf.hf[i] = hf;
      buf.rough[i] = rough - (gB - 0.5) * 0.05;
    });

    // Vector layer: name, rivet lines, rust bleed, tar drips
    const layer = buf.layer((ctx) => {
      // Names first so rivets are never erased by the distressing pass.
      // Starboard sheer strake = row 15 (canvas band y 0..64), reads normally;
      // port sheer strake = row 7 (band y 512..576), mirrored.
      paintName(ctx, rng, 900, 31, false);
      paintName(ctx, rng, 1024 - 900, 543, true);

      for (const side of [0, 1]) {
        ctx.save();
        ctx.beginPath();
        // port rows 0..7 live in canvas y 512..1024, starboard in 0..512
        ctx.rect(0, side === 0 ? 512 : 0, S, 512);
        ctx.clip();
        const r0 = side === 0 ? 0 : 8;
        for (let r = r0; r < r0 + 8; r++) {
          const bandTop = (HULL_ROWS - 1 - r) * ROW;
          const edgeY = bandTop + ROW - 9;
          // Rivet line through the lap, one nail every ~0.45 m
          for (let kk = 0; kk < 16; kk++) {
            const x = kk * ROW + ROW / 2 + rng.range(-6, 6);
            ctx.fillStyle = "rgba(46,42,36,0.95)";
            ctx.beginPath();
            ctx.arc(x, edgeY, 1.9, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "rgba(120,116,110,0.5)";
            ctx.beginPath();
            ctx.arc(x - 0.5, edgeY - 0.5, 0.7, 0, Math.PI * 2);
            ctx.fill();
            if (rng.chance(0.55)) {
              // Rust bleeding down (canvas +y = down the hull)
              const len = rng.range(8, 40);
              ctx.strokeStyle = `rgba(146,80,38,${rng.range(0.2, 0.45)})`;
              ctx.lineWidth = rng.range(1.8, 3.6);
              ctx.lineCap = "round";
              ctx.beginPath();
              ctx.moveTo(x, edgeY + 2);
              ctx.quadraticCurveTo(
                x + rng.range(-3, 3),
                edgeY + len * 0.6,
                x + rng.range(-4, 4),
                edgeY + len,
              );
              ctx.stroke();
            }
          }
          // Occasional tar runs from the seam above
          for (let d = 0; d < 3; d++) {
            if (!rng.chance(0.7)) continue;
            const x = rng.next() * S;
            const len = rng.range(7, 22);
            ctx.strokeStyle = `rgba(30,25,19,${rng.range(0.35, 0.6)})`;
            ctx.lineWidth = rng.range(1.6, 3);
            ctx.beginPath();
            ctx.moveTo(x, bandTop + 4);
            ctx.lineTo(x + rng.range(-2, 2), bandTop + 4 + len);
            ctx.stroke();
          }
        }
        ctx.restore();
      }
    });
    buf.blendLayer(layer, 1);

    return buf.build({ normal: 2.4, normalScale: 0.8 });
  });
}

// ---------------------------------------------------------------------------
// Bare driftwood tile
// ---------------------------------------------------------------------------

/** Tileable silvery driftwood for the boat's structural timbers. */
export function boatWoodPbr(): PbrMaps {
  return cachedPbr(cacheKey("boatWood", []), () => {
    const S = 512;
    const rng = new TexRng(0xd21f);
    const buf = new TexBuf(S, S, WOOD_LIGHT, 0.85, 0);
    const grainA = noiseField(S, S, 9301, { freq: 3, freqY: 90, oct: 4 });
    const grainB = noiseField(S, S, 9302, { freq: 16, freqY: 220, oct: 2 });
    const toneN = noiseField(S, S, 9303, { freq: 2, freqY: 5, oct: 2 });
    const silver: Rgb = rgb("#9aa09e");
    buf.each((i) => {
      const gA = grainA[i];
      const gB = grainB[i];
      let col = lerp3(WOOD_DARK, WOOD_LIGHT, Math.min(1, gA * 0.8 + gB * 0.4));
      // Sun-silvered patches
      col = lerp3(col, silver, sstep(0.55, 0.9, toneN[i]) * 0.45);
      const k =
        0.86 + gA * 0.2 + (gB - 0.5) * 0.24 + (hashPix(i, 9) - 0.5) * 0.08;
      buf.set(i, [col[0] * k, col[1] * k, col[2] * k]);
      buf.hf[i] = (gA - 0.5) * 0.7 + (gB - 0.5) * 0.4;
      buf.rough[i] = 0.85 - (gB - 0.5) * 0.08 + (toneN[i] - 0.5) * 0.05;
    });
    const layer = buf.layer((ctx) => {
      // Weathering checks: short dark cracks along the grain
      ctx.lineCap = "round";
      for (let k = 0; k < 110; k++) {
        const x = rng.next() * S;
        const y = rng.next() * S;
        const len = rng.range(8, 42);
        ctx.strokeStyle = `rgba(38,32,26,${rng.range(0.2, 0.5)})`;
        ctx.lineWidth = rng.range(0.7, 1.6);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + len, y + rng.range(-3, 3));
        ctx.stroke();
      }
      // A few knots
      for (let k = 0; k < 6; k++) {
        const x = rng.next() * S;
        const y = rng.next() * S;
        ctx.strokeStyle = "rgba(40,30,20,0.55)";
        ctx.lineWidth = 1.4;
        for (let ring = 0; ring < 3; ring++) {
          ctx.beginPath();
          ctx.ellipse(
            x,
            y,
            3 + ring * 2.6,
            1.6 + ring * 1.4,
            rng.range(-0.2, 0.2),
            0,
            Math.PI * 2,
          );
          ctx.stroke();
        }
      }
    });
    buf.blendLayer(layer, 1);
    return buf.build({ normal: 2.2, normalScale: 0.7 });
  });
}

// ---------------------------------------------------------------------------
// Dressing atlas (net / rope / buoy / rusted iron)
// ---------------------------------------------------------------------------

/** UV rectangles of the dressing atlas quadrants (u0, v0, u1, v1). */
export const DRESS_UV = {
  net: [0.02, 0.53, 0.48, 0.98] as const,
  rope: [0.53, 0.53, 0.97, 0.97] as const,
  buoy: [0.03, 0.03, 0.47, 0.47] as const,
  iron: [0.53, 0.03, 0.97, 0.47] as const,
};

/**
 * 512² atlas: torn net weave (alpha-tested), laid rope, cracked plastic float
 * and rusted iron fittings. One material, one draw call for all dressing.
 */
export function boatDressingPbr(): PbrMaps {
  return cachedPbr(cacheKey("boatDressing", []), () => {
    const S = 512;
    const H = S / 2;
    const rng = new TexRng(0x5ea1);
    const buf = new TexBuf(S, S, rgb("#808078"), 0.85, 0);
    const n1 = noiseField(S, S, 9401, { freq: 6, oct: 4 });
    const n2 = noiseField(S, S, 9402, { freq: 42, oct: 2 });

    // --- Net weave drawn as a vector layer (top-left canvas quadrant) ---
    const netLayer = buf.layer((ctx) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, H, H);
      ctx.clip();
      ctx.lineCap = "round";
      const step = 15;
      for (let x = 4; x <= H - 2; x += step) {
        ctx.strokeStyle = rng.chance(0.5) ? "#938d72" : "#a49d82";
        ctx.lineWidth = rng.range(3.4, 4.4);
        ctx.beginPath();
        ctx.moveTo(x + rng.range(-2, 2), 0);
        for (let y = 0; y <= H; y += 32)
          ctx.lineTo(
            x + Math.sin(y * 0.05 + x) * 2.5 + rng.range(-1.5, 1.5),
            y,
          );
        ctx.stroke();
      }
      for (let y = 4; y <= H - 2; y += step) {
        ctx.strokeStyle = rng.chance(0.5) ? "#8b8569" : "#999277";
        ctx.lineWidth = rng.range(3.4, 4.4);
        ctx.beginPath();
        ctx.moveTo(0, y + rng.range(-2, 2));
        for (let x = 0; x <= H; x += 32)
          ctx.lineTo(
            x,
            y + Math.sin(x * 0.045 + y) * 2.5 + rng.range(-1.5, 1.5),
          );
        ctx.stroke();
      }
      // Knots at the crossings
      ctx.fillStyle = "#6e684f";
      for (let x = 4; x <= H; x += step)
        for (let y = 4; y <= H; y += step)
          if (rng.chance(0.8)) {
            ctx.beginPath();
            ctx.arc(
              x + rng.range(-2, 2),
              y + rng.range(-2, 2),
              3.1,
              0,
              Math.PI * 2,
            );
            ctx.fill();
          }
      // Torn holes
      ctx.globalCompositeOperation = "destination-out";
      for (let k = 0; k < 9; k++) {
        ctx.beginPath();
        ctx.ellipse(
          rng.next() * H,
          rng.next() * H,
          rng.range(9, 26),
          rng.range(7, 18),
          rng.next() * Math.PI,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      ctx.restore();
    });

    const ropeDark = rgb("#6b5940");
    const ropeLight = rgb("#b7a37c");
    const buoyCol = rgb("#c65f36");
    const buoyBleach = rgb("#d9a488");
    const buoyBand = rgb("#ddd6c2");
    const rustA = rgb("#4d3a2b");
    const rustB = rgb("#8a4f28");
    const rustC = rgb("#a5602e");

    buf.each((i, _u, _v, x, y) => {
      if (x < H && y < H) {
        // Net (alpha from the layer)
        const j = i * 4;
        const a = netLayer[j + 3] / 255;
        buf.a[i] = a;
        if (a > 0.02) {
          const k = 0.85 + (n2[i] - 0.5) * 0.3;
          buf.set(i, [
            (netLayer[j] / 255) * k,
            (netLayer[j + 1] / 255) * k,
            (netLayer[j + 2] / 255) * k,
          ]);
        }
        buf.rough[i] = 0.9;
        buf.hf[i] = a * 0.5;
      } else if (x >= H && y < H) {
        // Rope: laid strands as diagonal ridges
        const phase = ((x * 0.94 + y * 0.34) / 7.5) * Math.PI * 2;
        const strand = Math.sin(phase);
        const wearK = 0.8 + (n1[i] - 0.5) * 0.5;
        const col = lerp3(
          ropeDark,
          ropeLight,
          0.35 + strand * 0.32 + (n2[i] - 0.5) * 0.2,
        );
        buf.set(i, [col[0] * wearK, col[1] * wearK, col[2] * wearK]);
        buf.rough[i] = 0.93 - strand * 0.03;
        buf.hf[i] = strand * 0.5 + (n2[i] - 0.5) * 0.2;
      } else if (x < H && y >= H) {
        // Buoy: bleached plastic, worn white band, grime in the scuffs
        const by = (y - H) / H; // 0 top of the buoy … 1 bottom
        let col = lerp3(buoyCol, buoyBleach, sstep(0.55, 0.1, by) * 0.7);
        const band = sstep(0.47, 0.52, by) * sstep(0.68, 0.63, by);
        col = lerp3(col, buoyBand, band * 0.9);
        const grime =
          sstep(0.45, 0.8, n1[i]) * 0.35 + sstep(0.7, 0.95, n2[i]) * 0.25;
        col = lerp3(col, rgb("#5c5248"), grime * 0.6);
        buf.set(i, col);
        buf.rough[i] = 0.5 + grime * 0.3 + band * 0.1;
        buf.hf[i] = (n1[i] - 0.5) * 0.25;
      } else {
        // Rusted iron
        const t = n1[i];
        let col = lerp3(rustA, rustB, t);
        col = lerp3(col, rustC, sstep(0.65, 0.95, n2[i]) * 0.8);
        const pit = hashPix(i, 11) > 0.93 ? 0.4 : 0;
        buf.set(i, [
          col[0] * (1 - pit),
          col[1] * (1 - pit),
          col[2] * (1 - pit),
        ]);
        buf.rough[i] = 0.88 + pit * 0.08;
        buf.hf[i] = (t - 0.5) * 0.4 - pit;
      }
    });

    // Crack + scuffs on the buoy quadrant
    const marks = buf.layer((ctx) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, H, H, H);
      ctx.clip();
      ctx.strokeStyle = "rgba(30,22,16,0.85)";
      ctx.lineWidth = 2.2;
      ctx.lineJoin = "round";
      ctx.beginPath();
      let cx = 40;
      let cy = H + 190;
      ctx.moveTo(cx, cy);
      for (let k = 0; k < 7; k++) {
        cx += rng.range(18, 34);
        cy += rng.range(-16, 10);
        ctx.lineTo(cx, cy);
      }
      ctx.stroke();
      ctx.strokeStyle = "rgba(30,22,16,0.5)";
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(cx - 60, cy - 4);
      ctx.lineTo(cx - 30, cy + 14);
      ctx.stroke();
      // Pale scuffs
      for (let k = 0; k < 40; k++) {
        ctx.strokeStyle = `rgba(235,228,214,${rng.range(0.06, 0.2)})`;
        ctx.lineWidth = rng.range(0.8, 2.2);
        const sx = rng.next() * H;
        const sy = H + rng.next() * H;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + rng.range(-24, 24), sy + rng.range(-10, 10));
        ctx.stroke();
      }
      ctx.restore();
    });
    buf.blendLayer(marks, 1);

    return buf.build({
      normal: 1.8,
      normalScale: 0.6,
      alpha: true,
      alphaTest: 0.28,
      doubleSide: true,
    });
  });
}
