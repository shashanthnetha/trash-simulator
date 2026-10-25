// Lamp glow for the horizon traffic (ambient-ships.ts): one tiny radial
// sprite, painted once. A hard bright core over a soft halo – scaled down to
// a few pixels it reads as a distant navigation light, not a bloom blob.

import * as THREE from "three";
import { makeCanvas } from "./textures-core";
import type { QualityId } from "./types";

/** Radial lamp glow, white – the sprite material tints it per lamp. */
export function shipLampTexture(quality: QualityId): THREE.CanvasTexture {
  const size = quality === "ultra" || quality === "high" ? 64 : 32;
  const [c, ctx] = makeCanvas(size, size);
  ctx.clearRect(0, 0, size, size);
  const half = size / 2;
  // Halo: gentle exponential falloff (radial gradient stops approximate it)
  const halo = ctx.createRadialGradient(half, half, 0, half, half, half);
  halo.addColorStop(0, "rgba(255,255,255,1)");
  halo.addColorStop(0.18, "rgba(255,255,255,0.82)");
  halo.addColorStop(0.38, "rgba(255,255,255,0.34)");
  halo.addColorStop(0.64, "rgba(255,255,255,0.08)");
  halo.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, size, size);
  // Core: small, saturated centre so the lamp keeps a point when tiny
  const core = ctx.createRadialGradient(half, half, 0, half, half, size * 0.16);
  core.addColorStop(0, "rgba(255,255,255,1)");
  core.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
