// Shared types and material/pose helpers for the trash models.

import * as THREE from "three";
import {
  type PbrMaps,
  applyPbr,
  pbrPlastic,
  pbrRustyMetal,
  pbrScuffedMetal,
} from "./textures";
import type { Part } from "./trash-geo";

/** Real size × 1.4 – objects are deliberately larger than real (recognizability). */
export const K = 1.4;

export interface PoseSpec {
  /** Relative frequency. */
  w: number;
  /** Pre-rotation in object space (before yaw/tilt/terrain alignment). */
  quat: (rng: () => number) => THREE.Quaternion;
}

export interface ModelSpec {
  parts: Part[];
  materials: THREE.Material[];
  /** Poses; index 0 = display pose (upright/natural) for the showcase. */
  poses: PoseSpec[];
  /** Maximum random sinking into the sand (m). */
  sink: number;
  /** Yaw angle in the showcase (front side facing the camera at yaw 0). */
  showYaw?: number;
  /** Hull mode: "back" for closed transparent bodies. */
  hull?: "front" | "back";
  /** false for flat objects without a visible shadow (saves the shadow pass). */
  castShadow?: boolean;
}

// ---------------------------------------------------------------------------
// Shared neutral texture sets (tinting via material.color saves sets – each
// set costs ~130–160 ms to generate at startup)
// ---------------------------------------------------------------------------

export function plasticMaps(): PbrMaps {
  return pbrPlastic("#e8e8e4", { wear: 0.4 });
}
export function plasticStripedMaps(): PbrMaps {
  return pbrPlastic("#e8e8e4", { wear: 0.5, print: "stripes" });
}
export function metalMaps(): PbrMaps {
  return pbrScuffedMetal("#c4c4c4");
}
export function rustMaps(): PbrMaps {
  return pbrRustyMetal("#6b5040", 0.95, { edges: false });
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

export interface MatOpts {
  color?: THREE.ColorRepresentation;
  repeat?: [number, number];
  side?: THREE.Side;
  /** Multiplier on the roughness map. */
  roughness?: number;
  metalness?: number;
  transparent?: boolean;
  opacity?: number;
  emissive?: THREE.ColorRepresentation;
}

export function std(
  maps: PbrMaps,
  o: MatOpts = {},
): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: o.color ?? 0xffffff,
    roughness: 1,
    metalness: 0,
  });
  applyPbr(m, maps, o.repeat);
  track(m, maps);
  finish(m, o);
  return m;
}

export interface PhysOpts extends MatOpts {
  clearcoat?: number;
  clearcoatRoughness?: number;
  ior?: number;
}

export function phys(
  maps: PbrMaps,
  o: PhysOpts = {},
): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    color: o.color ?? 0xffffff,
    roughness: 1,
    metalness: 0,
  });
  applyPbr(m, maps, o.repeat);
  track(m, maps);
  finish(m, o);
  m.clearcoat = o.clearcoat ?? 0;
  m.clearcoatRoughness = o.clearcoatRoughness ?? 0.1;
  if (o.ior !== undefined) m.ior = o.ior;
  m.transmission = 0;
  return m;
}

function finish(m: THREE.MeshStandardMaterial, o: MatOpts): void {
  if (o.roughness !== undefined) m.roughness = o.roughness;
  if (o.metalness !== undefined) m.metalness = o.metalness;
  if (o.side !== undefined) m.side = o.side;
  if (o.transparent) {
    m.transparent = true;
    m.opacity = o.opacity ?? 1;
  }
  if (o.emissive !== undefined) m.emissive = new THREE.Color(o.emissive);
  if (m.alphaTest > 0) alphaCoverage(m);
  m.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Alpha cutout: keep the coverage constant over distance
// ---------------------------------------------------------------------------

/**
 * Net, paper labels & co. are alpha cutouts. When they shrink, the mip chain
 * averages the alpha away; a fixed threshold then flips the thin webs pixel by
 * pixel – that is the moiré/shimmering. Hence:
 *   - lower the threshold with the mip level (texels per pixel from the
 *     derivatives) so the coverage is preserved instead of breaking away,
 *   - alphaToCoverage: MSAA smooths the edge (three then replaces the hard
 *     `discard` with a smoothstep over fwidth itself).
 */
function alphaCoverage(m: THREE.MeshStandardMaterial): void {
  const img = m.map?.image as { width?: number; height?: number } | undefined;
  const size = new THREE.Vector2(img?.width ?? 512, img?.height ?? 512);
  m.alphaToCoverage = true;
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer);
    shader.uniforms.uTexSize = { value: size };
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec2 uTexSize;")
      .replace(
        "#include <alphatest_fragment>",
        [
          "#if defined( USE_ALPHATEST ) && defined( USE_MAP )",
          "  vec2 dTex = max(abs(dFdx(vMapUv)), abs(dFdy(vMapUv))) * uTexSize;",
          "  float mipA = log2(max(max(dTex.x, dTex.y), 1.0));",
          "  float aRef = alphaTest / (1.0 + mipA * 0.9);",
          "  #ifdef ALPHA_TO_COVERAGE",
          "    diffuseColor.a *= smoothstep(0.0, fwidth(diffuseColor.a), diffuseColor.a - aRef);",
          "    if (diffuseColor.a == 0.0) discard;",
          "  #else",
          "    if (diffuseColor.a < aRef) discard;",
          "  #endif",
          "#else",
          "  #include <alphatest_fragment>",
          "#endif",
        ].join("\n"),
      );
  };
}

// ---------------------------------------------------------------------------
// Textures we own
// ---------------------------------------------------------------------------

// applyPbr clones the (globally cached, shared) textures as soon as a
// `repeat` is set. The clones belong to us – they are collected here and
// released in TrashField.dispose(). The cached originals stay alive: they are
// shared with other modules and reused on the next build.
const owned = new Set<THREE.Texture>();

function track(m: THREE.MeshStandardMaterial, maps: PbrMaps): void {
  if (m.map && m.map !== maps.map) owned.add(m.map);
  if (m.normalMap && m.normalMap !== maps.normalMap) owned.add(m.normalMap);
  if (m.roughnessMap && m.roughnessMap !== maps.roughnessMap)
    owned.add(m.roughnessMap);
  if (m.metalnessMap && m.metalnessMap !== maps.metalnessMap)
    owned.add(m.metalnessMap);
}

/** Release all texture clones we created ourselves (from TrashField.dispose()). */
export function disposeTrashTextures(): void {
  for (const t of owned) t.dispose();
  owned.clear();
}

// ---------------------------------------------------------------------------
// Poses
// ---------------------------------------------------------------------------

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

export function qx(a: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromAxisAngle(X, a);
}
export function qy(a: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromAxisAngle(Y, a);
}
export function qz(a: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromAxisAngle(Z, a);
}

/** Upright (identity). */
export function upright(w: number): PoseSpec {
  return { w, quat: () => new THREE.Quaternion() };
}

/** Lying down: rolled about its own axis, then tipped about X. */
export function tippedX(w: number): PoseSpec {
  return {
    w,
    quat: (rng) =>
      qx(rng() < 0.5 ? Math.PI / 2 : -Math.PI / 2).multiply(
        qy(rng() * Math.PI * 2),
      ),
  };
}

/** Lying on its side: rolled, then tipped about Z. `rollMax` limits the roll. */
export function tippedZ(w: number, rollMax = Math.PI): PoseSpec {
  return {
    w,
    quat: (rng) => qz(Math.PI / 2).multiply(qy((rng() * 2 - 1) * rollMax)),
  };
}

/** Lying flat (as built), optionally flipped over with a given probability. */
export function flat(w: number, flipChance = 0): PoseSpec {
  return {
    w,
    quat: (rng) => (rng() < flipChance ? qx(Math.PI) : new THREE.Quaternion()),
  };
}

/** Rolled arbitrarily about the X axis (the long axis). */
export function rolledX(w: number): PoseSpec {
  return { w, quat: (rng) => qx(rng() * Math.PI * 2) };
}

/** Arbitrary rotation (spheres, crumpled balls). */
export function anyRot(w: number): PoseSpec {
  return {
    w,
    quat: (rng) =>
      new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          rng() * Math.PI * 2,
          rng() * Math.PI * 2,
          rng() * Math.PI * 2,
        ),
      ),
  };
}

/** Gaussian bell for dents: angular/height distance. */
export function blob(da: number, dy: number, sa: number, sy: number): number {
  let a = da;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return Math.exp(-((a / sa) ** 2) - (dy / sy) ** 2);
}
