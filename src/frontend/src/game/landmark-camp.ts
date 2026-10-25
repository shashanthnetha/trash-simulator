// Abandoned camp deep in the back dunes – a cold stone fire pit with an ash
// bed, charcoal and two half-burned log ends under a blackened cooking tripod,
// a weathered ridge tent with a sagging ridge line and its entrance flap tied
// half open onto a dark interior, a second tent collapsed over its fallen rear
// pole, a driftwood bench dragged to the fire, a tipped enamel kettle and a
// rusted lantern with cracked glass hanging from a stick. Pure set dressing:
// nothing is pickable and nothing ever glows – the camp is long deserted.
//
// At construction time the camp deterministically searches the flattest spot
// within 25 m of its anchor (the analytic terrain cannot be flattened), then
// conforms every element to the ground: the fire ring, pegs and bench follow
// the terrain point by point, each tent sits slightly sunk on its own best-fit
// plane. Registers its own colliders under the tag "camp".
//
// Budget: one merged mesh per material – 8 draw calls. The only animated
// element is the tent canvas, which ripples in the wind via a small vertex
// shader patch (onBeforeCompile) driven from env.wind / env.envTime.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  addBoxCollider,
  addCylinderCollider,
  beginColliderSet,
  clearColliderSet,
} from "./colliders";
import {
  campGlassTexture,
  pbrAshChar,
  pbrCampStone,
  pbrTentCanvas,
} from "./landmark-camp-textures";
import { fbm } from "./noise";
import type { Environment } from "./sky";
import { terrainHeight } from "./terrain";
import {
  TexRng,
  applyPbr,
  hash01,
  pbrRope,
  pbrRustyMetal,
  pbrSand,
  pbrWood,
  sstep,
} from "./textures";
import type { QualityId } from "./types";

// ---------------------------------------------------------------------------
// Site search
// ---------------------------------------------------------------------------

const ANCHOR_X = -40;
const ANCHOR_Z = 185;
const SEARCH_R = 25;
/** Sand texture tiling of the terrain mesh (world.ts) – the drifts match it. */
const SAND_TILE_X = 820 / 70;
const SAND_TILE_Z = 560 / 48;

const UP = new THREE.Vector3(0, 1, 0);
const TV = new THREE.Vector3();
const TQ = new THREE.Quaternion();

export interface CampSite {
  x: number;
  z: number;
  yaw: number;
}

/**
 * Deterministic search for the flattest spot near the anchor: least-squares
 * plane over a 5×5 probe covering the camp footprint, scored by slope plus
 * residual roughness with a slight pull towards the anchor.
 */
function findSite(): CampSite {
  let bestX = ANCHOR_X;
  let bestZ = ANCHOR_Z;
  let bestScore = Number.POSITIVE_INFINITY;
  const SPAN = 2.1;
  const h: number[] = [];
  for (let oz = -SEARCH_R; oz <= SEARCH_R; oz += 2.5) {
    for (let ox = -SEARCH_R; ox <= SEARCH_R; ox += 2.5) {
      if (ox * ox + oz * oz > SEARCH_R * SEARCH_R + 1e-6) continue;
      const cx = ANCHOR_X + ox;
      const cz = ANCHOR_Z + oz;
      h.length = 0;
      let sum = 0;
      let sxh = 0;
      let szh = 0;
      for (let j = -2; j <= 2; j++) {
        for (let i = -2; i <= 2; i++) {
          const hh = terrainHeight(cx + i * SPAN, cz + j * SPAN);
          h.push(hh);
          sum += hh;
          sxh += hh * i * SPAN;
          szh += hh * j * SPAN;
        }
      }
      // Σu² = Σv² = 50 · SPAN² over the 5×5 grid
      const sxx = 50 * SPAN * SPAN;
      const ax = sxh / sxx;
      const az = szh / sxx;
      const mean = sum / 25;
      let res = 0;
      let idx = 0;
      for (let j = -2; j <= 2; j++) {
        for (let i = -2; i <= 2; i++) {
          const d = h[idx++] - (mean + ax * i * SPAN + az * j * SPAN);
          res += d * d;
        }
      }
      const score =
        Math.hypot(ax, az) +
        Math.sqrt(res / 25) * 1.6 +
        Math.hypot(ox, oz) * 0.004;
      if (score < bestScore) {
        bestScore = score;
        bestX = cx;
        bestZ = cz;
      }
    }
  }
  // Camp yaw: pitch the tents along the contour of the remaining grade
  const e = 2;
  const gx =
    (terrainHeight(bestX + e, bestZ) - terrainHeight(bestX - e, bestZ)) /
    (2 * e);
  const gz =
    (terrainHeight(bestX, bestZ + e) - terrainHeight(bestX, bestZ - e)) /
    (2 * e);
  const yaw = Math.hypot(gx, gz) < 0.01 ? 2.7 : Math.atan2(-gx, -gz);
  return { x: bestX, z: bestZ, yaw };
}

let cachedSite: CampSite | null = null;

/**
 * The camp's chosen build site. Deterministic and memoised, so other spawners
 * (pines, collectibles) can keep out of the ACTUAL clearing – the site may lie
 * up to SEARCH_R from the anchor, which an anchor-based keep-out would miss.
 */
export function campSite(): CampSite {
  if (!cachedSite) cachedSite = findSite();
  return cachedSite;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

type CampMat =
  | "canvas"
  | "wood"
  | "stone"
  | "char"
  | "rust"
  | "rope"
  | "glass"
  | "sand";

const COLOR_MATS: ReadonlySet<CampMat> = new Set([
  "canvas",
  "wood",
  "stone",
  "char",
  "rust",
]);

/** Collects geometries per material and merges them into one mesh each. */
class CampBag {
  private readonly lists = new Map<CampMat, THREE.BufferGeometry[]>();

  add(
    key: CampMat,
    g: THREE.BufferGeometry,
    color?: readonly [number, number, number],
  ): void {
    let geo = g;
    if (g.index) {
      geo = g.toNonIndexed();
      g.dispose();
    }
    // Normalize the attribute set per material so mergeGeometries succeeds:
    // color only where the material reads it, aFlutter only on the canvas.
    const n = geo.getAttribute("position").count;
    if (COLOR_MATS.has(key)) {
      if (!geo.getAttribute("color")) {
        const c = color ?? [1, 1, 1];
        const arr = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          arr[i * 3] = c[0];
          arr[i * 3 + 1] = c[1];
          arr[i * 3 + 2] = c[2];
        }
        geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
      }
    } else if (geo.getAttribute("color")) {
      geo.deleteAttribute("color");
    }
    if (key === "canvas") {
      if (!geo.getAttribute("aFlutter")) {
        geo.setAttribute(
          "aFlutter",
          new THREE.BufferAttribute(new Float32Array(n), 1),
        );
      }
    } else if (geo.getAttribute("aFlutter")) {
      geo.deleteAttribute("aFlutter");
    }
    let list = this.lists.get(key);
    if (!list) {
      list = [];
      this.lists.set(key, list);
    }
    list.push(geo);
  }

  build(mats: Record<CampMat, THREE.Material>): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [key, list] of this.lists) {
      if (list.length === 0) continue;
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) throw new Error(`Camp: mergeGeometries (${key}) failed`);
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mats[key]);
      mesh.name = `camp-${key}`;
      // Ash bed and charcoal sit flush with the ground, guy lines are
      // hairline-thin, the glass must not darken the lantern and the drifts
      // hug the terrain: none of them cast.
      mesh.castShadow =
        key !== "char" && key !== "glass" && key !== "rope" && key !== "sand";
      mesh.receiveShadow = true;
      out.push(mesh);
    }
    this.lists.clear();
    return out;
  }
}

interface SheetVertex {
  x: number;
  y: number;
  z: number;
  u: number;
  v: number;
  r: number;
  g: number;
  b: number;
  fl: number;
}

/**
 * Subdivided sheet (nx × ny quads); `fn` fills position, uv, vertex color and
 * flutter weight per grid point. Used for tent walls, flaps, the collapsed
 * cloth, the ash bed and the sand drifts.
 */
function makeSheet(
  nx: number,
  ny: number,
  fn: (ti: number, tj: number, out: SheetVertex) => void,
): THREE.BufferGeometry {
  const cols = nx + 1;
  const rows = ny + 1;
  const n = cols * rows;
  const pos = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const col = new Float32Array(n * 3);
  const flut = new Float32Array(n);
  const o: SheetVertex = {
    x: 0,
    y: 0,
    z: 0,
    u: 0,
    v: 0,
    r: 1,
    g: 1,
    b: 1,
    fl: 0,
  };
  let p = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      o.r = 1;
      o.g = 1;
      o.b = 1;
      o.fl = 0;
      fn(i / nx, j / ny, o);
      pos[p * 3] = o.x;
      pos[p * 3 + 1] = o.y;
      pos[p * 3 + 2] = o.z;
      uv[p * 2] = o.u;
      uv[p * 2 + 1] = o.v;
      col[p * 3] = o.r;
      col[p * 3 + 1] = o.g;
      col[p * 3 + 2] = o.b;
      flut[p] = o.fl;
      p++;
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setAttribute("aFlutter", new THREE.BufferAttribute(flut, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** Cylinder between two points, u along the axis (wood grain direction). */
function cylBetween(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  r0: number,
  seg: number,
  r1 = r0,
): THREE.BufferGeometry {
  const len = Math.hypot(bx - ax, by - ay, bz - az) || 1e-4;
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, false);
  const uvA = g.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < uvA.count; i++) {
    const u0 = uvA.getX(i);
    const v0 = uvA.getY(i);
    uvA.setXY(i, v0 * Math.max(0.4, len * 0.6), u0 * 0.35);
  }
  TV.set(bx - ax, by - ay, bz - az).normalize();
  TQ.setFromUnitVectors(UP, TV);
  g.applyQuaternion(TQ);
  g.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  return g;
}

/** Radial hash jitter about the origin (irregular stones and charcoal). */
function jitter(geo: THREE.BufferGeometry, amp: number, seed: number): void {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const k =
      1 +
      (hash01(
        Math.round(x * 140) + 31 * Math.round(y * 140),
        Math.round(z * 140),
        seed,
      ) -
        0.5) *
        2 *
        amp;
    pos.setXYZ(i, x * k, y * k, z * k);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

/** Flat color attribute (per-geometry, before the bag fills a default). */
function setFlatColor(
  geo: THREE.BufferGeometry,
  r: number,
  g: number,
  b: number,
): void {
  const n = geo.getAttribute("position").count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = r;
    arr[i * 3 + 1] = g;
    arr[i * 3 + 2] = b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------------------------------------------------------------------------
// The camp
// ---------------------------------------------------------------------------

/** Layout in camp-local metres around the fire pit at the origin. */
const MAIN_POS = { x: -3.05, z: 0.55 };
const COLL_POS = { x: 2.4, z: -1.55 };
const COLL_YAW = 2.75;
const BENCH_POS = { x: -0.35, z: -1.8 };
const BENCH_YAW = 0.55;

/** Main ridge tent dimensions. */
const TENT_L = 2.2;
const TENT_HW = 0.72;
const TENT_H = 1.32;
const TENT_SAG = 0.1;

function ridgeY(x: number): number {
  return TENT_H - TENT_SAG * Math.sin(Math.PI * (x / TENT_L + 0.5));
}

interface TentPlane {
  m: THREE.Matrix4;
  meanY: number;
}

export class AbandonedCamp {
  protected readonly parent: THREE.Group;
  protected readonly quality: QualityId;

  private readonly group = new THREE.Group();
  private readonly mats: Record<CampMat, THREE.Material>;
  private readonly meshes: THREE.Mesh[] = [];
  private readonly uTime: THREE.IUniform<number> = { value: 0 };
  private readonly uWind: THREE.IUniform<number> = { value: 0.2 };
  private readonly site: CampSite;
  private readonly baseY: number;
  private readonly det: number;
  /** Drift material – darkened with env.rain like the wet terrain shader. */
  private sandMat: THREE.MeshStandardMaterial | null = null;

  constructor(parent: THREE.Group, quality: QualityId) {
    this.parent = parent;
    this.quality = quality;
    this.det =
      quality === "ultra"
        ? 1
        : quality === "high"
          ? 0.9
          : quality === "medium"
            ? 0.65
            : 0.45;
    this.site = campSite();
    this.baseY = terrainHeight(this.site.x, this.site.z);
    this.group.position.set(this.site.x, this.baseY, this.site.z);
    this.group.rotation.y = this.site.yaw;
    parent.add(this.group);
    this.mats = this.makeMaterials();
    this.build();
  }

  update(dt: number, env: Environment, _camPos: THREE.Vector3): void {
    this.uTime.value = env.envTime;
    const target =
      env.weather === "storm" ? Math.min(1, env.wind * 1.1 + 0.05) : env.wind;
    this.uWind.value += (target - this.uWind.value) * Math.min(1, dt * 1.5);
    // The terrain darkens when wet (uWet in world.ts) – follow with the drifts
    if (this.sandMat) this.sandMat.color.setScalar(1 - env.rain * 0.42);
  }

  dispose(): void {
    clearColliderSet("camp");
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      this.group.remove(mesh);
    }
    this.meshes.length = 0;
    for (const m of Object.values(this.mats)) m.dispose();
    this.parent.remove(this.group);
    // Textures stay in the shared cache (same convention as station/trash).
  }

  // -------------------------------------------------------------------------
  // Frame helpers
  // -------------------------------------------------------------------------

  private seg(n: number, min = 3): number {
    return Math.max(min, Math.round(n * this.det));
  }

  /** Terrain height under a camp-local point, relative to the group origin. */
  private groundLocal(lx: number, lz: number): number {
    const c = Math.cos(this.site.yaw);
    const s = Math.sin(this.site.yaw);
    return (
      terrainHeight(
        this.site.x + lx * c + lz * s,
        this.site.z - lx * s + lz * c,
      ) - this.baseY
    );
  }

  /** Camp-local → world (x, z) – for the drift UVs and the windward test. */
  private worldXZ(lx: number, lz: number): [number, number] {
    const c = Math.cos(this.site.yaw);
    const s = Math.sin(this.site.yaw);
    return [this.site.x + lx * c + lz * s, this.site.z - lx * s + lz * c];
  }

  /**
   * Best-fit ground plane under a tent footprint: 3×3 probe in the tent frame,
   * least squares in both axes. The matrix places tent-local geometry slightly
   * sunk onto that plane (tilt first, then yaw, then translation).
   */
  private tentPlane(
    cx: number,
    cz: number,
    yawT: number,
    hx: number,
    hz: number,
    sink: number,
  ): TentPlane {
    const c = Math.cos(yawT);
    const s = Math.sin(yawT);
    let sum = 0;
    let suh = 0;
    let svh = 0;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const u = i * hx;
        const v = j * hz;
        const h = this.groundLocal(cx + u * c + v * s, cz - u * s + v * c);
        sum += h;
        suh += h * u;
        svh += h * v;
      }
    }
    const au = suh / (6 * hx * hx);
    const av = svh / (6 * hz * hz);
    const meanY = sum / 9;
    const n = new THREE.Vector3(-au, 1, -av).normalize();
    const qTilt = new THREE.Quaternion().setFromUnitVectors(UP, n);
    const qYaw = new THREE.Quaternion().setFromAxisAngle(UP, yawT);
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(cx, meanY - sink, cz),
      qYaw.multiply(qTilt),
      new THREE.Vector3(1, 1, 1),
    );
    return { m, meanY };
  }

  /** World z of a tent-local point (smaller z = towards the sea = windward). */
  private worldZOf(m: THREE.Matrix4, x: number, y: number, z: number): number {
    TV.set(x, y, z).applyMatrix4(m);
    return this.worldXZ(TV.x, TV.z)[1];
  }

  // -------------------------------------------------------------------------
  // Materials
  // -------------------------------------------------------------------------

  private makeMaterials(): Record<CampMat, THREE.Material> {
    const canvas = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
    });
    applyPbr(canvas, pbrTentCanvas());
    const uTime = this.uTime;
    const uWind = this.uWind;
    canvas.customProgramCacheKey = () => "camp-canvas";
    canvas.onBeforeCompile = (shader) => {
      shader.uniforms.uCampTime = uTime;
      shader.uniforms.uCampWind = uWind;
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          [
            "#include <common>",
            "uniform float uCampTime;",
            "uniform float uCampWind;",
            "attribute float aFlutter;",
          ].join("\n"),
        )
        .replace(
          "#include <beginnormal_vertex>",
          [
            "#include <beginnormal_vertex>",
            "float campWave = 0.0;",
            "{",
            "  float cw = clamp(uCampWind, 0.0, 1.0);",
            // barely-there in calm, clearly alive in storm, never balloon-like
            "  float amp = aFlutter * (0.07 + 0.93 * cw * cw) * 0.036;",
            "  float ph = uCampTime * (2.1 + 6.5 * cw);",
            "  float gust = 0.35 + 0.65 * (0.5 + 0.5 * sin(ph * 0.31 + position.x * 0.7 + position.z * 0.5));",
            "  amp *= gust;",
            "  float p1 = ph + position.x * 5.3 + position.y * 3.2 + position.z * 4.6;",
            "  float p2 = ph * 1.83 + position.x * 9.4 + position.z * 7.1 + 1.7;",
            "  campWave = (sin(p1) * 0.72 + sin(p2) * 0.28) * amp;",
            "  float slope = (cos(p1) * 3.8 + cos(p2) * 2.6) * amp;",
            "  objectNormal = normalize(objectNormal + vec3(slope * 0.4, slope * 0.2, slope * 0.35));",
            "}",
          ].join("\n"),
        )
        .replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\ntransformed += objectNormal * campWave;",
        );
    };

    const wood = new THREE.MeshStandardMaterial({ vertexColors: true });
    applyPbr(wood, pbrWood("driftwood"));

    const stone = new THREE.MeshStandardMaterial({ vertexColors: true });
    applyPbr(stone, pbrCampStone());

    const char = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
    });
    applyPbr(char, pbrAshChar());

    const rust = new THREE.MeshStandardMaterial({ vertexColors: true });
    applyPbr(rust, pbrRustyMetal("#6d7076", 0.55, { edges: false }));
    // No env map out here – keep the metal response low so it stays legible
    rust.metalness = 0.3;

    const rope = new THREE.MeshStandardMaterial();
    applyPbr(rope, pbrRope("#c7bda4"), [1.5, 1]);

    const glass = new THREE.MeshStandardMaterial({
      map: campGlassTexture(),
      transparent: true,
      roughness: 0.22,
      metalness: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    const sand = new THREE.MeshStandardMaterial();
    applyPbr(sand, pbrSand());
    this.sandMat = sand;

    return { canvas, wood, stone, char, rust, rope, glass, sand };
  }

  // -------------------------------------------------------------------------
  // Build
  // -------------------------------------------------------------------------

  private build(): void {
    const bag = new CampBag();
    beginColliderSet("camp", {
      x: this.site.x,
      y: this.baseY,
      z: this.site.z,
      yaw: this.site.yaw,
    });

    // Main tent faces the fire pit with its entrance (+x in tent frame)
    const mainYaw = Math.atan2(MAIN_POS.z, -MAIN_POS.x);
    const main = this.tentPlane(
      MAIN_POS.x,
      MAIN_POS.z,
      mainYaw,
      1.15,
      0.75,
      0.075,
    );
    const coll = this.tentPlane(
      COLL_POS.x,
      COLL_POS.z,
      COLL_YAW,
      0.9,
      0.62,
      0.05,
    );

    this.buildFirePit(bag);
    this.buildMainTent(bag, main.m);
    this.buildCollapsedTent(bag, coll.m);
    this.buildBench(bag);
    this.buildKettle(bag);
    this.buildLantern(bag);

    for (const mesh of bag.build(this.mats)) {
      this.meshes.push(mesh);
      this.group.add(mesh);
    }

    // Colliders (camp frame): both tents, the bench, a low fire-ring cylinder
    addBoxCollider(
      MAIN_POS.x,
      MAIN_POS.z,
      1.32,
      0.92,
      mainYaw,
      main.meanY - 0.8,
      main.meanY + 1.4,
    );
    addBoxCollider(
      COLL_POS.x,
      COLL_POS.z,
      1.02,
      0.8,
      COLL_YAW,
      coll.meanY - 0.8,
      coll.meanY + 0.75,
    );
    const benchY = this.groundLocal(BENCH_POS.x, BENCH_POS.z);
    addBoxCollider(
      BENCH_POS.x,
      BENCH_POS.z,
      0.95,
      0.24,
      BENCH_YAW,
      benchY - 0.5,
      benchY + 0.45,
    );
    const pitY = this.groundLocal(0, 0);
    addCylinderCollider(0, 0, 0.8, pitY - 0.6, pitY + 0.4);
  }

  // -------------------------------------------------------------------------
  // Fire pit
  // -------------------------------------------------------------------------

  private buildFirePit(bag: CampBag): void {
    const rng = new TexRng(0xca3b);
    const count =
      this.quality === "ultra" || this.quality === "high"
        ? 13
        : this.quality === "medium"
          ? 11
          : 10;
    const detail = this.det >= 0.9 ? 2 : this.det >= 0.65 ? 1 : 0;

    // Ring of smoke-blackened stones, each conformed to the ground
    for (let k = 0; k < count; k++) {
      const ang = (k / count) * Math.PI * 2 + (rng.next() - 0.5) * 0.24;
      const rad = 0.56 + (rng.next() - 0.5) * 0.1;
      const lx = Math.cos(ang) * rad;
      const lz = Math.sin(ang) * rad;
      const size = 0.15 + rng.next() * 0.08;
      const tone = 0.86 + rng.next() * 0.26;
      const geo = new THREE.IcosahedronGeometry(size, detail);
      geo.scale(
        1 + rng.next() * 0.35,
        0.62 + rng.next() * 0.25,
        0.8 + rng.next() * 0.3,
      );
      jitter(geo, 0.16, 100 + k);
      geo.rotateY(rng.next() * Math.PI * 2);
      geo.rotateX((rng.next() - 0.5) * 0.5);
      geo.rotateZ((rng.next() - 0.5) * 0.4);
      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      if (!bb) continue;
      const g = this.groundLocal(lx, lz);
      const h = bb.max.y - bb.min.y;
      geo.translate(lx, g - bb.min.y - h * 0.32, lz);
      // Soot: darkest on the faces towards the fire, fading up and outwards
      const pos = geo.getAttribute("position") as THREE.BufferAttribute;
      const col = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const rr = Math.hypot(pos.getX(i), pos.getZ(i));
        const up = clamp01((pos.getY(i) - g) / Math.max(0.05, h));
        let soot = clamp01(1.25 - rr / 0.55) * (0.55 + 0.45 * up);
        soot = clamp01(soot ** 1.15) * 0.88;
        col[i * 3] = tone * (1 - soot) + 0.15 * soot;
        col[i * 3 + 1] = tone * (1 - soot) + 0.14 * soot;
        col[i * 3 + 2] = tone * (1 - soot) + 0.145 * soot;
      }
      geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
      bag.add("stone", geo);
    }

    // Ash bed: shallow mound of cold ash, conformed and dished
    const na = this.seg(9, 5);
    const rim = 0.44;
    const ash = makeSheet(na, na, (ti, tj, o) => {
      let ax = (ti * 2 - 1) * rim * 1.02;
      let az = (tj * 2 - 1) * rim * 1.02;
      const rr = Math.hypot(ax, az);
      if (rr > rim) {
        ax *= rim / rr;
        az *= rim / rr;
      }
      const rn = Math.min(1, rr / rim);
      const g = this.groundLocal(ax, az);
      o.x = ax;
      o.y =
        g +
        0.012 +
        (1 - rn * rn) * 0.032 +
        (fbm(ax * 6 + 4, az * 6, 2) - 0.5) * 0.02 * (1 - rn);
      o.z = az;
      o.u = ti * 1.4;
      o.v = tj * 1.4;
      const light = Math.max(
        0.55,
        1.5 - rn * 0.75 + (fbm(ax * 3 + 8, az * 3, 2) - 0.5) * 0.5,
      );
      o.r = light;
      o.g = light;
      o.b = light * 1.02;
    });
    bag.add("char", ash);

    // Charcoal chunks
    const nCh =
      this.quality === "ultra" || this.quality === "high"
        ? 9
        : this.quality === "medium"
          ? 6
          : 5;
    for (let k = 0; k < nCh; k++) {
      const ang = rng.next() * Math.PI * 2;
      const rr = rng.next() * 0.27;
      const lx = Math.cos(ang) * rr;
      const lz = Math.sin(ang) * rr;
      const size = 0.03 + rng.next() * 0.028;
      const geo = new THREE.DodecahedronGeometry(size, 0);
      geo.scale(
        1 + rng.next() * 0.5,
        0.6 + rng.next() * 0.3,
        0.8 + rng.next() * 0.3,
      );
      jitter(geo, 0.12, 200 + k);
      geo.rotateY(rng.next() * Math.PI * 2);
      geo.rotateZ((rng.next() - 0.5) * 0.8);
      const dark = 0.12 + rng.next() * 0.07;
      geo.translate(lx, this.groundLocal(lx, lz) + 0.03 + size * 0.35, lz);
      setFlatColor(geo, dark, dark * 0.97, dark * 1.05);
      bag.add("char", geo);
    }

    // Two half-burned log ends poking out of the ash: the charred half starts
    // well outside the ring so the burn is readable from every side
    for (const a of [1.05, 2.55]) {
      const ox = Math.cos(a) * 0.78;
      const oz = Math.sin(a) * 0.78;
      const mx = Math.cos(a) * 0.46;
      const mz = Math.sin(a) * 0.46;
      const ix = Math.cos(a) * 0.08;
      const iz = Math.sin(a) * 0.08;
      const go = this.groundLocal(ox, oz);
      const gm = this.groundLocal(mx, mz);
      const outer = cylBetween(
        ox,
        go + 0.042,
        oz,
        mx,
        gm + 0.06,
        mz,
        0.048,
        this.seg(9, 6),
      );
      setFlatColor(outer, 0.72, 0.68, 0.62);
      bag.add("wood", outer);
      const inner = cylBetween(
        mx,
        gm + 0.06,
        mz,
        ix,
        gm + 0.08,
        iz,
        0.042,
        this.seg(8, 5),
        0.026,
      );
      setFlatColor(inner, 0.17, 0.16, 0.16);
      bag.add("char", inner);
    }

    // Blackened cooking tripod – cold, nothing hangs over the ash any more
    const apex = { x: 0.03, y: 1.0, z: -0.02 };
    for (const a of [0.5, 2.6, 4.7]) {
      const bx = Math.cos(a) * 0.66;
      const bz = Math.sin(a) * 0.66;
      const gb = this.groundLocal(bx, bz);
      const tx = apex.x + (apex.x - bx) * 0.07;
      const tz = apex.z + (apex.z - bz) * 0.07;
      const ty = apex.y + (apex.y - gb) * 0.07;
      const leg = cylBetween(
        bx,
        gb - 0.03,
        bz,
        tx,
        ty,
        tz,
        0.021,
        this.seg(7, 5),
        0.015,
      );
      // Heavily sooted lower two thirds, fading out towards the lashing
      const pos = leg.getAttribute("position") as THREE.BufferAttribute;
      const col = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const bl = clamp01(1 - (pos.getY(i) - gb) / 0.9) * 0.95;
        const t = 0.62 * (1 - bl) + 0.12 * bl;
        col[i * 3] = t;
        col[i * 3 + 1] = t * 0.98;
        col[i * 3 + 2] = t * 0.98;
      }
      leg.setAttribute("color", new THREE.BufferAttribute(col, 3));
      bag.add("wood", leg);
    }
    // Lashing at the apex and a short, empty hook wire
    const lash = new THREE.CylinderGeometry(0.045, 0.05, 0.1, this.seg(8, 6));
    lash.rotateZ(0.12);
    lash.translate(apex.x, apex.y + 0.01, apex.z);
    bag.add("rope", lash);
    // Sooty hanging wire and hook: matte char, no metal sparkle over the pit
    const wire = cylBetween(
      apex.x,
      apex.y - 0.02,
      apex.z,
      apex.x + 0.01,
      apex.y - 0.3,
      apex.z + 0.01,
      0.005,
      5,
    );
    setFlatColor(wire, 0.22, 0.21, 0.2);
    bag.add("char", wire);
    const hook = new THREE.TorusGeometry(0.02, 0.0045, 5, 8, Math.PI * 1.3);
    hook.rotateY(0.6);
    hook.translate(apex.x + 0.01, apex.y - 0.315, apex.z + 0.01);
    setFlatColor(hook, 0.22, 0.21, 0.2);
    bag.add("char", hook);
  }

  // -------------------------------------------------------------------------
  // Main ridge tent
  // -------------------------------------------------------------------------

  private buildMainTent(bag: CampBag, m: THREE.Matrix4): void {
    const windwardS =
      this.worldZOf(m, 0, 0, -TENT_HW) < this.worldZOf(m, 0, 0, TENT_HW)
        ? -1
        : 1;
    const openS = -windwardS;
    const nx = this.seg(26, 10);
    const ny = this.seg(13, 5);

    // Side walls with cloth sag, hem flare and wrinkle noise
    for (const s of [-1, 1]) {
      const wall = makeSheet(nx, ny, (ti, tj, o) => {
        const x = -TENT_L / 2 + TENT_L * ti;
        const ry = ridgeY(x);
        const f = tj;
        const nl = Math.hypot(TENT_HW, ry);
        const nY = TENT_HW / nl;
        const nZ = (s * ry) / nl;
        const belly =
          0.05 * Math.sin(Math.PI * f) * (0.35 + 0.65 * Math.sin(Math.PI * ti));
        const wr =
          (fbm(ti * 5 + s * 3 + 5, f * 2.5, 3) - 0.5) * 0.05 +
          (fbm(ti * 14 + s * 7 + 9, f * 7 + 2, 2) - 0.5) * 0.02;
        let d = belly + wr;
        if (f < 0.1) d -= (1 - f / 0.1) * 0.02; // hem kicks out
        o.x = x;
        o.y = f * ry - nY * d;
        o.z = s * TENT_HW * (1 - f) ** 0.94 - nZ * d;
        o.u = (x + TENT_L / 2) * 0.9;
        o.v = f;
        const k =
          (s === windwardS ? 1.06 : 1) *
          (1 + (fbm(ti * 3 + s, f * 3, 2) - 0.5) * 0.12);
        o.r = k;
        o.g = k;
        o.b = k * 0.99;
        o.fl = Math.min(
          1.25,
          Math.sin(Math.PI * f) ** 0.9 *
            (0.25 + 0.75 * Math.sin(Math.PI * ti) ** 0.8) *
            1.05 +
            (1 - f) ** 2 * 0.35 * Math.sin(Math.PI * ti),
        );
      });
      wall.applyMatrix4(m);
      bag.add("canvas", wall);
    }

    // Back gable
    const gn = this.seg(10, 4);
    const back = makeSheet(gn, ny, (ti, tj, o) => {
      const f = tj;
      const ry = ridgeY(-TENT_L / 2);
      const w = ti * 2 - 1;
      const z = w * TENT_HW * (1 - f);
      const d =
        0.035 *
          Math.sin(Math.PI * f) *
          (0.4 + 0.6 * Math.cos((w * Math.PI) / 2)) +
        (fbm(ti * 4 + 11, f * 3, 2) - 0.5) * 0.03;
      o.x = -TENT_L / 2 - d;
      o.y = f * ry;
      o.z = z;
      o.u = (z + TENT_HW) * 0.9;
      o.v = f;
      o.fl = Math.sin(Math.PI * f) ** 1.1 * Math.sin(Math.PI * ti) * 0.55;
    });
    back.applyMatrix4(m);
    bag.add("canvas", back);

    // Entrance: one flap hangs closed but ajar, the other is tied half open
    const ryF = ridgeY(TENT_L / 2);
    const fn = this.seg(9, 4);
    const closedS = -openS;
    const closed = makeSheet(fn, fn, (ti, tj, o) => {
      const i = ti;
      const j = tj;
      const gz = closedS * TENT_HW * (1 - i);
      o.x =
        TENT_L / 2 -
        0.03 * Math.sin(Math.PI * j) * Math.sin(Math.PI * i) +
        (fbm(i * 6 + 3, j * 4, 2) - 0.5) * 0.03 +
        0.1 * i ** 2 * (1 - j) ** 2; // bottom corner hangs slightly ajar
      o.y = j * ryF;
      o.z = gz * (1 - j);
      o.u = Math.abs(gz) * 0.9;
      o.v = j;
      o.fl = Math.min(1.3, i ** 1.3 * (1 - j) ** 0.6 * 1.2 + 0.1);
    });
    closed.applyMatrix4(m);
    bag.add("canvas", closed);

    const hinge = new THREE.Vector3(TENT_L / 2, 0, openS * TENT_HW);
    const apexV = new THREE.Vector3(TENT_L / 2, ryF, 0);
    const axis = apexV.clone().sub(hinge).normalize();
    const rot = new THREE.Vector3();
    const open = makeSheet(fn, fn, (ti, tj, o) => {
      const i = ti;
      const j = tj;
      const gz = openS * TENT_HW * (1 - i);
      rot.set(TENT_L / 2, j * ryF, gz * (1 - j)).sub(hinge);
      const ang = -openS * (0.95 + 0.6 * i ** 1.2);
      rot.applyAxisAngle(axis, ang).add(hinge);
      rot.x += (fbm(i * 5 + 21, j * 4, 2) - 0.5) * 0.04;
      rot.y -= 0.14 * i ** 1.5 * (1 - j);
      if (rot.y < 0.02) rot.y = 0.02;
      o.x = rot.x;
      o.y = rot.y;
      o.z = rot.z;
      o.u = Math.abs(gz) * 0.9 + 1.1;
      o.v = j;
      const k = 1.03; // the tied-back flap catches more sun
      o.r = k;
      o.g = k;
      o.b = k * 0.99;
      o.fl = Math.min(1.3, (0.5 + 0.8 * i) * (0.3 + 0.7 * (1 - j)));
    });
    open.applyMatrix4(m);
    bag.add("canvas", open);

    // Dark interior behind the entrance
    const inner = new THREE.BufferGeometry();
    const iz = TENT_HW * 0.92;
    inner.setAttribute(
      "position",
      new THREE.BufferAttribute(
        new Float32Array([
          TENT_L / 2 - 0.08,
          0.02,
          iz,
          TENT_L / 2 - 0.08,
          0.02,
          -iz,
          TENT_L / 2 - 0.08,
          ryF * 0.94,
          0,
        ]),
        3,
      ),
    );
    inner.setAttribute(
      "uv",
      new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0.5, 1]), 2),
    );
    inner.computeVertexNormals();
    setFlatColor(inner, 0.1, 0.1, 0.11);
    inner.applyMatrix4(m);
    bag.add("char", inner);

    // Patched corner on the windward wall (a newer, less bleached square)
    const patch = makeSheet(3, 3, (ti, tj, o) => {
      const x = -0.65 + ti * 0.36;
      const f = 0.03 + tj * 0.17;
      const ry = ridgeY(x);
      const nl = Math.hypot(TENT_HW, ry);
      const lift = 0.012 + (ti > 0.8 && tj > 0.8 ? 0.02 : 0);
      o.x = x;
      o.y = f * ry + (TENT_HW / nl) * lift;
      o.z =
        windwardS * TENT_HW * (1 - f) ** 0.94 + ((windwardS * ry) / nl) * lift;
      o.u = 0.12 + ti * 0.24;
      o.v = 0.08 + tj * 0.2;
      o.r = 0.86;
      o.g = 0.88;
      o.b = 0.64;
      o.fl = 0.12 + (tj > 0.8 ? 0.25 : 0);
    });
    patch.applyMatrix4(m);
    bag.add("canvas", patch);

    // Poles: crossed pairs at both gables and short ridge-pole stubs
    const woodCol: [number, number, number] = [0.85, 0.82, 0.75];
    const poles: Array<[number, number, number, number, number, number]> = [
      [TENT_L / 2 + 0.06, -0.05, 0.78, TENT_L / 2 + 0.02, TENT_H + 0.1, -0.04],
      [TENT_L / 2 + 0.06, -0.05, -0.78, TENT_L / 2 + 0.02, TENT_H + 0.1, 0.04],
      [
        -TENT_L / 2 - 0.06,
        -0.05,
        0.78,
        -TENT_L / 2 - 0.02,
        TENT_H + 0.06,
        -0.03,
      ],
      [
        -TENT_L / 2 - 0.06,
        -0.05,
        -0.78,
        -TENT_L / 2 - 0.02,
        TENT_H + 0.06,
        0.03,
      ],
    ];
    for (const [ax, ay, az, bx, by, bz] of poles) {
      const p = cylBetween(
        ax,
        ay,
        az,
        bx,
        by,
        bz,
        0.022,
        this.seg(7, 5),
        0.018,
      );
      setFlatColor(p, woodCol[0], woodCol[1], woodCol[2]);
      p.applyMatrix4(m);
      bag.add("wood", p);
    }
    for (const [ax, bx, y] of [
      [-TENT_L / 2 - 0.22, -TENT_L / 2 + 0.08, TENT_H + 0.04],
      [TENT_L / 2 - 0.08, TENT_L / 2 + 0.2, TENT_H + 0.055],
    ]) {
      const p = cylBetween(ax, y, 0, bx, y, 0, 0.019, this.seg(7, 5));
      setFlatColor(p, woodCol[0], woodCol[1], woodCol[2]);
      p.applyMatrix4(m);
      bag.add("wood", p);
    }

    // Guy lines to wooden pegs (+ one snapped line lying limp in the sand)
    this.rope(bag, m, TENT_L / 2 + 0.04, TENT_H + 0.06, 0, 2.02, 0.08, 0.3);
    this.rope(bag, m, -TENT_L / 2 - 0.04, TENT_H + 0.03, 0, -1.9, 0.08, -0.25);
    this.peg(bag, m, 2.02, 0.3, 0.35);
    this.peg(bag, m, -1.9, -0.25, -0.35);
    for (const [px, pz] of [
      [0.95, TENT_HW + 0.05],
      [-0.95, TENT_HW + 0.05],
      [0, TENT_HW + 0.07],
      [0.95, -TENT_HW - 0.05],
      [-0.95, -TENT_HW - 0.05],
      [0, -TENT_HW - 0.07],
    ]) {
      this.peg(bag, m, px, pz, pz > 0 ? 0.3 : -0.3);
    }
    const limpPts = [
      new THREE.Vector3(1.06, 0.06, openS * 0.8),
      new THREE.Vector3(1.32, 0.035, openS * 1.0),
      new THREE.Vector3(1.52, 0.05, openS * 1.06),
      new THREE.Vector3(1.64, 0.04, openS * 0.9),
    ];
    const limp = new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3(limpPts),
      this.seg(14, 8),
      0.007,
      5,
      false,
    );
    limp.applyMatrix4(m);
    bag.add("rope", limp);
    this.peg(bag, m, 1.7, openS * 0.88, openS * 0.3);

    // Sand drift against the windward wall
    this.buildDrift(
      bag,
      m,
      1.9,
      0.9,
      0.3,
      windwardS * (TENT_HW - 0.04),
      windwardS,
    );
  }

  /** Taut guy line from a tent point down to a peg (tent frame). */
  private rope(
    bag: CampBag,
    m: THREE.Matrix4,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
  ): void {
    const g = cylBetween(ax, ay, az, bx, by, bz, 0.0065, 5);
    g.applyMatrix4(m);
    bag.add("rope", g);
  }

  /** Weathered wooden peg, tilted, conformed to the real ground. */
  private peg(
    bag: CampBag,
    m: THREE.Matrix4,
    px: number,
    pz: number,
    tilt: number,
  ): void {
    TV.set(px, 0, pz).applyMatrix4(m);
    const g = this.groundLocal(TV.x, TV.z);
    const geo = new THREE.CylinderGeometry(0.009, 0.016, 0.2, this.seg(6, 5));
    geo.rotateX(tilt * 0.8);
    geo.rotateZ(tilt * 0.4);
    geo.translate(TV.x, g + 0.035, TV.z);
    setFlatColor(geo, 0.72, 0.68, 0.6);
    bag.add("wood", geo);
  }

  // -------------------------------------------------------------------------
  // Collapsed tent
  // -------------------------------------------------------------------------

  private buildCollapsedTent(bag: CampBag, m: THREE.Matrix4): void {
    const L = 1.7;
    const HW = 0.58;
    const HF = 0.72;
    const nx = this.seg(22, 10);
    const ny = this.seg(14, 6);
    const sheet = makeSheet(nx, ny, (ti, tj, o) => {
      const t = ti; // 0 = collapsed rear, 1 = front (pole still standing)
      const w = tj * 2 - 1;
      const x = -L / 2 + L * t;
      const h = 0.05 + (HF - 0.05) * t ** 2.2;
      const spread = HW + (1 - h / HF) * 0.16;
      const z = w * spread;
      let y = h * (1 - Math.abs(w) ** 1.35);
      const flat = (1 - t) ** 1.3;
      // small crumple folds where the cloth lies on the ground
      y += (fbm(t * 8 + 9, w * 5 + 3, 3) - 0.5) * 0.11 * flat;
      // ridge of the fallen rear pole under the cloth
      const pd = z - (0.1 + (1 - t) * 0.14);
      y += Math.exp((-pd * pd) / 0.006) * 0.05 * flat;
      // hems stay pinned to the sand even where the folds pile up
      y *= 1 - sstep(0.72, 1, Math.abs(w)) * 0.9;
      if (y < 0.018) y = 0.018;
      o.x = x;
      o.y = y;
      o.z = z;
      o.u = t * 1.6;
      o.v = Math.max(0.04, (1 - Math.abs(w)) * 0.85);
      // far more bleached than the main tent, grimy where it touches sand
      const grime = 0.8 + 0.2 * clamp01(y / 0.15);
      o.r = 1.14 * grime;
      o.g = 1.11 * grime;
      o.b = 1.05 * grime;
      const cl = clamp01((y - 0.03) / 0.45);
      o.fl = cl * (0.35 + 0.65 * t) * (0.55 + 0.45 * Math.abs(w)) * 0.9;
    });
    sheet.applyMatrix4(m);
    bag.add("canvas", sheet);

    // Slumped front gable: closes most of the mouth so the tent reads as a
    // fallen shelter, with a slack dark opening left towards one side
    const gf = this.seg(8, 4);
    const gable = makeSheet(gf, gf, (ti, tj, o) => {
      const i = ti; // across the mouth, 0 = z-, 1 = towards z+
      const j = tj; // 0 = hem, 1 = apex
      const zc = (i * 2 - 1) * HW * 0.94 * (1 - j);
      const sagY =
        (HF - 0.06) * j * (0.72 + 0.28 * Math.sin(Math.PI * i)) +
        (fbm(i * 5 + 31, j * 4, 2) - 0.5) * 0.06 * (1 - j);
      o.x = L / 2 - 0.04 - 0.16 * (1 - j) * (0.4 + 0.6 * i);
      o.y = Math.max(0.018, sagY);
      o.z = zc;
      o.u = 3.2 + i * 0.8;
      o.v = Math.max(0.04, j);
      const grime = 0.82 + 0.18 * clamp01(sagY / 0.2);
      o.r = 1.1 * grime;
      o.g = 1.07 * grime;
      o.b = 1.02 * grime;
      o.fl = Math.sin(Math.PI * i) * j * 0.7;
    });
    gable.applyMatrix4(m);
    bag.add("canvas", gable);

    // Front pole pair still standing but visibly askew, rear pole fallen
    const woodCol: [number, number, number] = [0.8, 0.77, 0.7];
    for (const s of [-1, 1]) {
      const lean = s < 0 ? -0.09 : 0.03;
      const p = cylBetween(
        L / 2 + 0.04,
        -0.05,
        s * 0.56,
        L / 2 - 0.07 + lean,
        HF + 0.04 - Math.abs(lean) * 0.4,
        s * 0.04,
        0.019,
        this.seg(7, 5),
        0.015,
      );
      setFlatColor(p, woodCol[0], woodCol[1], woodCol[2]);
      p.applyMatrix4(m);
      bag.add("wood", p);
    }
    TV.set(-1.15, 0, 0.42).applyMatrix4(m);
    const gEnd = this.groundLocal(TV.x, TV.z);
    const fallen = cylBetween(
      -L / 2 + 0.06,
      0.045,
      0.26,
      -1.15,
      Math.max(0.02, gEnd - (TV.y - 0.02)),
      0.42,
      0.018,
      this.seg(7, 5),
    );
    setFlatColor(fallen, woodCol[0], woodCol[1], woodCol[2]);
    fallen.applyMatrix4(m);
    bag.add("wood", fallen);

    // One guy line still taut, a frayed stub swinging at the apex
    this.rope(bag, m, L / 2 - 0.07, HF + 0.02, 0, 1.6, 0.08, -0.3);
    this.peg(bag, m, 1.6, -0.3, -0.3);
    this.rope(bag, m, L / 2 - 0.06, HF, 0.03, L / 2 + 0.02, HF - 0.3, 0.08);
    this.peg(bag, m, -L / 2 - 0.12, -0.62, -0.3);
    this.peg(bag, m, -L / 2 - 0.1, 0.66, 0.3);

    // Smaller drift crawling over the flattened end
    this.buildDrift(bag, m, 1.3, 0.7, 0.2, -(HW + 0.06), -1);
  }

  /**
   * Wind-blown sand drift against a tent wall (tent frame): a low mound that
   * hugs the terrain, sunk at the edges so it never floats. Textured with the
   * sand set of the terrain (`sandAlbedo()` etc.) at the same world tiling.
   */
  private buildDrift(
    bag: CampBag,
    m: THREE.Matrix4,
    len: number,
    dep: number,
    hgt: number,
    zEdge: number,
    out: number,
  ): void {
    const nx = this.seg(12, 7);
    const nb = this.seg(6, 4);
    const drift = makeSheet(nx, nb, (ti, tj, o) => {
      const a = (ti * 2 - 1) * (len / 2);
      const b = -0.08 + tj * (dep + 0.08);
      TV.set(a, 0, zEdge + out * b).applyMatrix4(m);
      const bf = clamp01(b / dep);
      const af = a / (len / 2);
      const h =
        hgt *
        Math.max(0, 1 - af * af) ** 1.3 *
        (1 - bf) ** 1.7 *
        (0.85 + 0.3 * fbm(a * 2 + 3, b * 2, 2));
      const lx = TV.x;
      const lz = TV.z;
      o.x = lx;
      o.y = this.groundLocal(lx, lz) + h - 0.035;
      o.z = lz;
      const [wx, wz] = this.worldXZ(lx, lz);
      o.u = (wx + 410) / SAND_TILE_X;
      o.v = (420 - wz) / SAND_TILE_Z;
    });
    bag.add("sand", drift);
  }

  // -------------------------------------------------------------------------
  // Bench, kettle, lantern
  // -------------------------------------------------------------------------

  private buildBench(bag: CampBag): void {
    const len = 1.5;
    const dirX = Math.cos(BENCH_YAW);
    const dirZ = -Math.sin(BENCH_YAW);
    const e1x = BENCH_POS.x - dirX * (len / 2);
    const e1z = BENCH_POS.z - dirZ * (len / 2);
    const e2x = BENCH_POS.x + dirX * (len / 2);
    const e2z = BENCH_POS.z + dirZ * (len / 2);
    const y1 = this.groundLocal(e1x, e1z) + 0.078;
    const y2 = this.groundLocal(e2x, e2z) + 0.078;
    const geo = new THREE.CylinderGeometry(
      0.108,
      0.155,
      len,
      this.seg(12, 8),
      6,
    );
    // Driftwood lumps and an uneven surface
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const th = Math.atan2(z, x);
      const k = 1 + (fbm(th * 1.4 + 3, y * 1.8, 3) - 0.5) * 0.4;
      pos.setXYZ(i, x * k, y, z * k);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    const uvA = geo.getAttribute("uv") as THREE.BufferAttribute;
    for (let i = 0; i < uvA.count; i++) {
      const u0 = uvA.getX(i);
      const v0 = uvA.getY(i);
      uvA.setXY(i, v0 * 1.4, u0 * 0.6);
    }
    TV.set(e2x - e1x, y2 - y1, e2z - e1z).normalize();
    TQ.setFromUnitVectors(UP, TV);
    geo.applyQuaternion(TQ);
    geo.translate((e1x + e2x) / 2, (y1 + y2) / 2, (e1z + e2z) / 2);
    setFlatColor(geo, 0.98, 0.96, 0.9);
    bag.add("wood", geo);
    // Two broken branch stubs
    for (const [t, ang, ln] of [
      [0.28, 0.9, 0.16],
      [0.72, -2.2, 0.13],
    ]) {
      const cx = e1x + (e2x - e1x) * t;
      const cz = e1z + (e2z - e1z) * t;
      const cy = y1 + (y2 - y1) * t + 0.1;
      const stub = cylBetween(
        cx,
        cy,
        cz,
        cx + Math.cos(ang) * ln,
        cy + 0.1,
        cz + Math.sin(ang) * ln,
        0.024,
        this.seg(6, 5),
        0.012,
      );
      setFlatColor(stub, 0.9, 0.88, 0.82);
      bag.add("wood", stub);
    }
  }

  private buildKettle(bag: CampBag): void {
    const px = 0.68;
    const pz = 0.44;
    const g = this.groundLocal(px, pz);
    const seg = this.seg(20, 10);
    const profile: Array<[number, number]> = [
      [0.002, 0],
      [0.092, 0.002],
      [0.112, 0.03],
      [0.118, 0.085],
      [0.102, 0.14],
      [0.072, 0.172],
      [0.068, 0.185],
      [0.076, 0.195],
      [0.03, 0.198],
      [0.002, 0.198],
    ];
    const pts = profile.map(([r, y]) => new THREE.Vector2(r, y));
    const parts: THREE.BufferGeometry[] = [new THREE.LatheGeometry(pts, seg)];
    parts.push(
      cylBetween(0.09, 0.08, 0, 0.168, 0.16, 0.02, 0.02, this.seg(7, 5), 0.011),
    );
    const handle = new THREE.TorusGeometry(
      0.085,
      0.008,
      5,
      this.seg(12, 8),
      Math.PI * 1.05,
    );
    handle.rotateZ(-0.05);
    handle.translate(0, 0.19, 0);
    parts.push(handle);
    const knob = new THREE.SphereGeometry(0.016, 8, 6);
    knob.translate(0, 0.212, 0);
    parts.push(knob);
    // Tipped onto its side by the stones
    const q = new THREE.Quaternion()
      .setFromAxisAngle(UP, 2.2)
      .multiply(
        new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 0, 1),
          1.42,
        ),
      );
    const mk = new THREE.Matrix4().compose(
      new THREE.Vector3(px, g + 0.112, pz),
      q,
      new THREE.Vector3(1, 1, 1),
    );
    for (const p of parts) {
      p.applyMatrix4(mk);
      setFlatColor(p, 0.17, 0.18, 0.2);
      bag.add("rust", p);
    }
  }

  private buildLantern(bag: CampBag): void {
    const bx = -1.82;
    const bz = 1.42;
    const gb = this.groundLocal(bx, bz);
    const tipX = -1.42;
    const tipZ = 1.7;
    const tipY = gb + 0.84;
    // Clearly leaning stick planted in the sand; the lantern hangs free of it
    const stick = cylBetween(
      bx,
      gb - 0.1,
      bz,
      tipX,
      tipY,
      tipZ,
      0.034,
      this.seg(8, 6),
      0.019,
    );
    setFlatColor(stick, 0.78, 0.75, 0.68);
    bag.add("wood", stick);
    const fork = cylBetween(
      tipX - 0.07,
      tipY - 0.24,
      tipZ - 0.04,
      tipX + 0.05,
      tipY - 0.06,
      tipZ + 0.1,
      0.013,
      5,
      0.007,
    );
    setFlatColor(fork, 0.76, 0.73, 0.66);
    bag.add("wood", fork);

    // Hurricane lantern hanging plumb from the tip – glass cracked, never lit
    const cx = tipX + 0.03;
    const cz = tipZ + 0.02;
    const bodyCol: [number, number, number] = [0.48, 0.44, 0.4];
    const bail = new THREE.TorusGeometry(
      0.045,
      0.004,
      5,
      this.seg(10, 8),
      Math.PI * 1.2,
    );
    bail.rotateZ(-0.15);
    bail.translate(cx, tipY - 0.045, cz);
    setFlatColor(bail, bodyCol[0], bodyCol[1], bodyCol[2]);
    bag.add("rust", bail);
    const crownY = tipY - 0.115;
    const crown = new THREE.CylinderGeometry(
      0.014,
      0.05,
      0.045,
      this.seg(9, 7),
    );
    crown.translate(cx, crownY, cz);
    setFlatColor(crown, bodyCol[0], bodyCol[1], bodyCol[2]);
    bag.add("rust", crown);
    for (const s of [-1, 1]) {
      const w = cylBetween(
        cx,
        tipY - 0.06,
        cz,
        cx + s * 0.032,
        crownY + 0.015,
        cz - s * 0.01,
        0.004,
        4,
      );
      setFlatColor(w, bodyCol[0], bodyCol[1], bodyCol[2]);
      bag.add("rust", w);
    }
    const glassBase = crownY - 0.11;
    const gProfile: Array<[number, number]> = [
      [0.028, 0],
      [0.043, 0.03],
      [0.045, 0.05],
      [0.038, 0.075],
      [0.03, 0.088],
    ];
    const glass = new THREE.LatheGeometry(
      gProfile.map(([r, y]) => new THREE.Vector2(r, y)),
      this.seg(12, 8),
    );
    glass.translate(cx, glassBase, cz);
    bag.add("glass", glass);
    if (this.det >= 0.6) {
      for (const ry of [0.35, 0.35 + Math.PI / 2]) {
        const guard = new THREE.TorusGeometry(
          0.05,
          0.0032,
          4,
          this.seg(10, 8),
          Math.PI,
        );
        guard.rotateZ(Math.PI);
        guard.rotateY(ry);
        guard.scale(1, 1.1, 1);
        guard.translate(cx, glassBase + 0.048, cz);
        setFlatColor(guard, 0.32, 0.3, 0.29);
        bag.add("rust", guard);
      }
    }
    const collar = new THREE.CylinderGeometry(
      0.032,
      0.034,
      0.014,
      this.seg(9, 7),
    );
    collar.translate(cx, glassBase - 0.006, cz);
    setFlatColor(collar, bodyCol[0], bodyCol[1], bodyCol[2]);
    bag.add("rust", collar);
    const tank = new THREE.LatheGeometry(
      [
        new THREE.Vector2(0.002, 0),
        new THREE.Vector2(0.05, 0.004),
        new THREE.Vector2(0.056, 0.03),
        new THREE.Vector2(0.052, 0.055),
        new THREE.Vector2(0.03, 0.062),
        new THREE.Vector2(0.024, 0.075),
        new THREE.Vector2(0.002, 0.075),
      ],
      this.seg(14, 9),
    );
    tank.translate(cx, glassBase - 0.082, cz);
    setFlatColor(tank, bodyCol[0], bodyCol[1], bodyCol[2]);
    bag.add("rust", tank);
  }
}
