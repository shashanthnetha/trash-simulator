// Geometry builders for vegetation.ts: grass clumps (blades with a lengthwise
// fold and a tip), ground-cover rosettes, rocks (displaced icosahedra in three
// shapes), shells (fan, clam, spiral) and pebbles.

import * as THREE from "three";
import {
  mergeGeometries,
  mergeVertices,
} from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { fbm, lerp } from "./noise";

// ---------------------------------------------------------------------------
// Grass
// ---------------------------------------------------------------------------

/** Vertical segments per blade (rows 0..ROWS-1 with 3 vertices, then the tip). */
const BLADE_ROWS = 3;

/**
 * One blade: a tapering strip with a fold (the middle vertex is offset
 * forward), at rest leaning slightly toward +Z (before the rotation).
 * Attribute aBlade = (blade seed, height, width direction x, z) for the shader.
 */
function buildBlade(
  bx: number,
  bz: number,
  height: number,
  halfW: number,
  lean: number,
  yaw: number,
  seed: number,
): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const info: number[] = [];
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const push = (
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    u: number,
    v: number,
  ) => {
    pos.push(bx + x * cy + z * sy, y, bz - x * sy + z * cy);
    const len = Math.hypot(nx, ny, nz) || 1;
    const px = nx / len;
    const py = ny / len;
    const pz = nz / len;
    nrm.push(px * cy + pz * sy, py, -px * sy + pz * cy);
    uv.push(u, v);
    // Width direction (local +X after the rotation) for the widening in the distance
    info.push(seed, height, cy, -sy);
  };
  for (let r = 0; r < BLADE_ROWS; r++) {
    const t = r / BLADE_ROWS;
    const hw = halfW * (1 - 0.6 * t);
    const fold = halfW * 0.6 * (1 - 0.5 * t);
    const z = lean * t * t;
    const y = t * height - (lean * lean * t * t * t) / (2 * height);
    const slope = (2 * lean * t) / height;
    push(-hw, y, z, -0.85, -slope * 0.7, 0.7, 0, t);
    push(0, y, z + fold, 0, -slope, 1, 0.5, t);
    push(hw, y, z, 0.85, -slope * 0.7, 0.7, 1, t);
  }
  const tipSlope = (2 * lean) / height;
  push(0, height - (lean * lean) / (2 * height), lean, 0, -tipSlope, 1, 0.5, 1);

  const idx: number[] = [];
  for (let r = 0; r < BLADE_ROWS - 1; r++) {
    const a = r * 3;
    const b = a + 3;
    idx.push(a, a + 1, b + 1, a, b + 1, b);
    idx.push(a + 1, a + 2, b + 2, a + 1, b + 2, b + 1);
  }
  const top = (BLADE_ROWS - 1) * 3;
  const tip = BLADE_ROWS * 3;
  idx.push(top, top + 1, tip, top + 1, top + 2, tip);

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("aBlade", new THREE.Float32BufferAttribute(info, 4));
  g.setIndex(idx);
  return g;
}

/**
 * Short, broad filler blade (old growth at the foot of the tussock): a single
 * tapering quad (2 triangles), tilted strongly outward.
 */
function buildFillerBlade(
  bx: number,
  bz: number,
  height: number,
  halfW: number,
  lean: number,
  yaw: number,
  seed: number,
): THREE.BufferGeometry {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const slope = (2 * lean) / height;
  const nl = Math.hypot(slope, 1);
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const info: number[] = [];
  const push = (x: number, y: number, z: number, u: number, v: number) => {
    pos.push(bx + x * cy + z * sy, y, bz - x * sy + z * cy);
    const ny = -slope / nl;
    const nz = 1 / nl;
    nrm.push(nz * sy, ny, nz * cy);
    uv.push(u, v);
    info.push(seed, height, cy, -sy);
  };
  push(-halfW, 0, 0, 0, 0);
  push(halfW, 0, 0, 1, 0);
  push(-halfW * 0.25, height - (lean * lean) / (2 * height), lean, 0, 1);
  push(halfW * 0.25, height - (lean * lean) / (2 * height), lean, 1, 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("aBlade", new THREE.Float32BufferAttribute(info, 4));
  g.setIndex([0, 1, 3, 0, 3, 2]);
  return g;
}

/**
 * One clump of `bladeCount` blades (heights 0.55–1.0 m, leaning outward) plus
 * `fillerCount` short filler blades at the foot.
 */
export function buildGrassClump(
  bladeCount: number,
  fillerCount: number,
  rng: () => number,
): THREE.BufferGeometry {
  const blades: THREE.BufferGeometry[] = [];
  for (let f = 0; f < fillerCount; f++) {
    const ang = (f / fillerCount) * Math.PI * 2 + rng() * 1.5;
    const rad = 0.04 + rng() * 0.05;
    const height = 0.25 + rng() * 0.2;
    blades.push(
      buildFillerBlade(
        Math.cos(ang) * rad,
        Math.sin(ang) * rad,
        height,
        0.03 + rng() * 0.015,
        (0.3 + rng() * 0.25) * height,
        Math.PI / 2 - ang + (rng() - 0.5) * 0.8,
        rng(),
      ),
    );
  }
  for (let b = 0; b < bladeCount; b++) {
    const ang = rng() * Math.PI * 2;
    const rad = 0.01 + rng() * 0.05;
    const tall = b === 0 || rng() < 0.3;
    const height = tall ? 0.8 + rng() * 0.2 : 0.55 + rng() * 0.3;
    const halfW = 0.024 + rng() * 0.014;
    const lean = (0.08 + rng() * 0.24) * height;
    // Local +Z (the lean direction) points away from the clump center, ±60° scatter
    const yaw = Math.PI / 2 - ang + (rng() - 0.5) * 2.1;
    blades.push(
      buildBlade(
        Math.cos(ang) * rad,
        Math.sin(ang) * rad,
        height,
        halfW,
        lean,
        yaw,
        rng(),
      ),
    );
  }
  return mergeClump(blades);
}

/**
 * Second species: broad-leaved, low sand couch grass – few, distinctly broader
 * and shorter leaves that arch strongly outward (lean ≈ leaf height, so the tip
 * ends up at half height). Clearly distinguishable from the upright marram
 * grass, at fewer triangles per clump.
 */
export function buildBroadClump(
  leafCount: number,
  fillerCount: number,
  rng: () => number,
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let f = 0; f < fillerCount; f++) {
    const ang = (f / fillerCount) * Math.PI * 2 + rng() * 2.4;
    const rad = 0.03 + rng() * 0.04;
    const height = 0.13 + rng() * 0.1;
    parts.push(
      buildFillerBlade(
        Math.cos(ang) * rad,
        Math.sin(ang) * rad,
        height,
        0.05 + rng() * 0.025,
        (0.6 + rng() * 0.4) * height,
        Math.PI / 2 - ang + (rng() - 0.5) * 0.7,
        rng(),
      ),
    );
  }
  for (let b = 0; b < leafCount; b++) {
    const ang = (b / leafCount) * Math.PI * 2 + (rng() - 0.5) * 1.1;
    const rad = 0.02 + rng() * 0.04;
    const height = 0.26 + rng() * 0.2;
    const halfW = 0.055 + rng() * 0.03;
    const lean = (0.55 + rng() * 0.5) * height;
    const yaw = Math.PI / 2 - ang + (rng() - 0.5) * 0.9;
    parts.push(
      buildBlade(
        Math.cos(ang) * rad,
        Math.sin(ang) * rad,
        height,
        halfW,
        lean,
        yaw,
        rng(),
      ),
    );
  }
  return mergeClump(parts);
}

function mergeClump(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  for (const b of parts) b.dispose();
  if (!merged) throw new Error("Grass clump: mergeGeometries failed");
  merged.computeBoundingSphere();
  return merged;
}

/**
 * Low rosette (sea rocket / sea sandwort style): 6–7 leaves of 3 triangles
 * each, vertex colors dark green → lighter toward the tip.
 */
export function buildGroundCover(rng: () => number): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const leaves = 6 + Math.floor(rng() * 2);
  for (let i = 0; i < leaves; i++) {
    const yaw = (i / leaves) * Math.PI * 2 + (rng() - 0.5) * 0.5;
    const len = 0.12 + rng() * 0.1;
    const w = 0.05 + rng() * 0.03;
    const hm = 0.04 + rng() * 0.03;
    const ht = hm + 0.02 + rng() * 0.04;
    const bright = 0.85 + rng() * 0.3;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const base = pos.length / 3;
    const push = (x: number, y: number, z: number, k: number) => {
      pos.push(x * cy + z * sy, y, -x * sy + z * cy);
      col.push(
        lerp(0.09, 0.3, k) * bright,
        lerp(0.15, 0.42, k) * bright,
        lerp(0.07, 0.18, k) * bright,
      );
    };
    push(-0.012, 0.004, 0.015, 0);
    push(0.012, 0.004, 0.015, 0);
    push(-w / 2, hm, len * 0.55, 0.55);
    push(w / 2, hm, len * 0.55, 0.55);
    push(0, ht, len, 1);
    idx.push(base, base + 3, base + 1);
    idx.push(base, base + 2, base + 3);
    idx.push(base + 2, base + 4, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------------------
// Rocks / pebbles
// ---------------------------------------------------------------------------

/** Pseudo-3D noise from three 2D projections (smooth, isotropic enough). */
function noise3(x: number, y: number, z: number, octaves: number): number {
  return (
    (fbm(x, y, octaves) + fbm(y + 7.1, z, octaves) + fbm(z + 3.3, x, octaves)) /
    3
  );
}

export type RockVariant = 0 | 1 | 2; // 0 round, 1 blocky, 2 flat slab

/** Icosahedron displaced with layered noise; radius ≈ 1. */
export function buildRock(
  variant: RockVariant,
  detail: number,
  seed: number,
): THREE.BufferGeometry {
  const ico = new THREE.IcosahedronGeometry(1, detail);
  ico.deleteAttribute("uv"); // triplanar in the shader → cleanly mergeable
  const geo = mergeVertices(ico);
  ico.dispose();
  const p = geo.getAttribute("position") as THREE.BufferAttribute;
  const off = seed * 13.7;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    let px = x;
    let py = y;
    let pz = z;
    if (variant === 1) {
      // Pull toward a cube → angular block
      const m = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
      px = lerp(x, (x / m) * 0.8, 0.72);
      py = lerp(y, (y / m) * 0.8, 0.72);
      pz = lerp(z, (z / m) * 0.8, 0.72);
    }
    const n1 = noise3(px * 1.6 + off, py * 1.6, pz * 1.6, 3) - 0.5;
    const n2 = noise3(px * 4.5 + off, py * 4.5 + 3, pz * 4.5, 2) - 0.5;
    const n3 = noise3(px * 11 + off, py * 11, pz * 11 + 5, 1) - 0.5;
    const big = variant === 1 ? 0.28 : 0.5;
    const r = 1 + n1 * big + n2 * 0.18 + n3 * 0.08;
    px *= r;
    py *= r;
    pz *= r;
    if (variant === 2) {
      py *= 0.42;
      px *= 1.25;
    } else if (variant === 1) {
      py *= 0.8;
    }
    p.setXYZ(i, px, py, pz);
  }
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** Small, slightly flattened pebble (radius ≈ 1). */
export function buildPebble(seed: number): THREE.BufferGeometry {
  const ico = new THREE.IcosahedronGeometry(1, 1);
  ico.deleteAttribute("uv");
  const geo = mergeVertices(ico);
  ico.dispose();
  const p = geo.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const r = 1 + (noise3(x * 2 + seed, y * 2, z * 2, 2) - 0.5) * 0.36;
    p.setXYZ(i, x * r * 1.2, y * r * 0.55, z * r);
  }
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

// ---------------------------------------------------------------------------
// Shells
// ---------------------------------------------------------------------------

/**
 * Fan shell (scallop): a semicircular fan with 14 radial ribs and a wavy edge,
 * slightly domed; the hinge sits at the origin. Radius 1, lying in the XZ plane
 * (y ≥ 0), UV = (angle/π, radius).
 */
export function buildFanShell(): THREE.BufferGeometry {
  const SEG = 18;
  const RINGS = 5;
  const pos: number[] = [0, 0, 0];
  const uv: number[] = [0.5, 0];
  const idx: number[] = [];
  for (let k = 1; k <= RINGS; k++) {
    const r = k / RINGS;
    for (let j = 0; j <= SEG; j++) {
      const th = (j / SEG) * Math.PI;
      const rr = r * (1 + 0.03 * Math.sin(th * 14));
      const y = 0.4 * r * (1 - r) + 0.03 * r * Math.sin(th * 14);
      pos.push(rr * Math.cos(th), y, -rr * Math.sin(th));
      uv.push(j / SEG, r);
    }
  }
  const ring = (k: number, j: number) => 1 + (k - 1) * (SEG + 1) + j;
  for (let j = 0; j < SEG; j++) idx.push(0, ring(1, j), ring(1, j + 1));
  for (let k = 1; k < RINGS; k++) {
    for (let j = 0; j < SEG; j++) {
      const a = ring(k, j);
      const b = ring(k + 1, j);
      const c = ring(k + 1, j + 1);
      const d = ring(k, j + 1);
      idx.push(a, b, c, a, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** Clam shell: a flat hemispherical shell with concentric ridges. */
export function buildClamShell(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  g.scale(1, 0.34, 0.8);
  const p = g.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const r = Math.hypot(x, z / 0.8);
    p.setY(i, y + 0.02 * Math.sin(r * Math.PI * 7) * y * 3);
  }
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** Spiral curve of a snail shell: apex at the top, aperture at the bottom, growing radius. */
class WhorlCurve extends THREE.Curve<THREE.Vector3> {
  constructor(private readonly turns: number) {
    super();
  }

  getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    const a = t * this.turns * Math.PI * 2;
    const r = 0.06 + 0.5 * t ** 1.4;
    return target.set(Math.cos(a) * r, 1 - t, Math.sin(a) * r);
  }
}

/**
 * Spiral snail shell (whelk): a tube along a spiral whose cross-section grows
 * toward the aperture. Lies on its side, min y = 0.
 */
export function buildSpiralShell(): THREE.BufferGeometry {
  const TUB = 36;
  const RAD = 8;
  const curve = new WhorlCurve(3);
  const g = new THREE.TubeGeometry(curve, TUB, 1, RAD, false);
  const p = g.getAttribute("position") as THREE.BufferAttribute;
  const c = new THREE.Vector3();
  const v = new THREE.Vector3();
  for (let i = 0; i <= TUB; i++) {
    const t = i / TUB;
    curve.getPoint(t, c);
    const rad = 0.03 + 0.34 * t ** 1.3;
    for (let j = 0; j <= RAD; j++) {
      const k = i * (RAD + 1) + j;
      v.set(p.getX(k), p.getY(k), p.getZ(k)).sub(c).multiplyScalar(rad).add(c);
      p.setXYZ(k, v.x, v.y, v.z);
    }
  }
  g.rotateX(Math.PI / 2);
  g.computeBoundingBox();
  const minY = g.boundingBox ? g.boundingBox.min.y : 0;
  g.translate(0, -minY, 0);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}
