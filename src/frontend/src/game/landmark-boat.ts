// Stranded wooden fishing boat at the water line of Old Pier – an open
// clinker-built (lapstrake) hull, heeled over on its port side in the wet
// sand, weathered two-tone paint peeling to driftwood, the name "Sea Lark"
// hand-painted on both bow quarters. Pure set dressing: a torn net over the
// port gunwale, a rope coil, two oars, a cracked buoy and a wind-blown sand
// drift banked against the leeward (inland) side. Registers its own colliders
// (tag "boat").
//
// Construction: the hull is a parametric surface (stations t = stern→bow,
// girth s = keel→sheer). Every strake is swept individually as a thin solid
// with a real lap offset, so the clinker steps are geometry, not texture.
// Everything merges into four draw calls: painted hull, bare timber,
// dressing atlas, sand drift.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  addBoxCollider,
  beginColliderSet,
  clearColliderSet,
} from "./colliders";
import {
  DRESS_UV,
  boatDressingPbr,
  boatHullPbr,
  boatWoodPbr,
  hullRowV,
} from "./landmark-boat-textures";
import { clamp, lerp, smoothstep } from "./noise";
import type { Environment } from "./sky";
import { SHORE_GLSL, terrainHeight } from "./terrain";
import { sandAlbedo, sandNormal } from "./textures";
import { applyPbr, hash01 } from "./textures-core";
import type { QualityId } from "./types";

// ---------------------------------------------------------------------------
// Placement (fixed anchor, fine-tuned on screenshots)
// ---------------------------------------------------------------------------

const AX = -190;
const AZ = -46;
/** Bow points inland, roughly shore-parallel + 0.5 rad. */
const YAW = -0.27;
/** Heel to port (the seaward side) ≈ 23°. */
const HEEL = -0.41;
/** Bow slightly up the beach slope. */
const PITCH = 0.055;
/** How deep the keel sits in the sand. */
const SINK = 0.22;

// ---------------------------------------------------------------------------
// Hull dimensions (local frame: +x bow, +y up, +z starboard, y=0 keel top)
// ---------------------------------------------------------------------------

const X_STERN = -3.28;
const RAKE_STERN = -0.48; // transom leans aft with height
const X_BOW = 3.3;
const RAKE_BOW = 0.6; // stem rakes forward with height
const BEAM_HALF = 1.18;
const TH = 0.02; // plank thickness
const LAP = 0.046; // clinker land (visible step)
/** Girth fractions of the 8 strake seams + sheer (garboard first). */
const SG = [0, 0.14, 0.27, 0.4, 0.52, 0.64, 0.755, 0.875, 1];
const STRAKES = SG.length - 1;

function keelY(t: number): number {
  return (
    0.05 +
    0.44 * smoothstep(0.6, 1, t) ** 1.7 +
    0.17 * smoothstep(0.3, 0, t) ** 1.6
  );
}

function sheerY(t: number): number {
  return (
    0.78 +
    0.3 * smoothstep(0.55, 1, t) ** 1.6 +
    0.1 * smoothstep(0.35, 0, t) ** 1.4
  );
}

function beamAt(t: number): number {
  return BEAM_HALF * Math.sin(Math.PI * (0.16 + 0.835 * t)) ** 0.72;
}

/** Section fullness: round bilge amidships, V-er towards the stem. */
function secExp(t: number): number {
  return 0.82 + 0.5 * smoothstep(0.55, 1, t) + 0.22 * smoothstep(0.3, 0, t);
}

/** Hull surface point at station t (0 stern … 1 bow), girth s, side ±1. */
function surfPoint(
  t: number,
  s: number,
  side: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const yk = keelY(t);
  const ys = sheerY(t);
  const y = yk + (ys - yk) * s ** 1.15;
  const hw = beamAt(t) * Math.sin((s * Math.PI) / 2) ** secExp(t);
  const x = (1 - t) * (X_STERN + RAKE_STERN * y) + t * (X_BOW + RAKE_BOW * y);
  return out.set(x, y, side * hw);
}

const N_A = new THREE.Vector3();
const N_B = new THREE.Vector3();
const N_C = new THREE.Vector3();
const N_D = new THREE.Vector3();

/** Outward surface normal via finite differences. */
function surfNormal(
  t: number,
  s: number,
  side: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const et = 0.012;
  const es = 0.012;
  const t0 = clamp(t - et, 0.001, 0.999);
  const t1 = clamp(t + et, 0.001, 0.999);
  const s0 = clamp(s - es, 0.004, 0.998);
  const s1 = clamp(s + es, 0.004, 0.998);
  surfPoint(t1, s, side, N_A).sub(surfPoint(t0, s, side, N_B));
  surfPoint(t, s1, side, N_C).sub(surfPoint(t, s0, side, N_D));
  out.crossVectors(N_A, N_C);
  if (out.lengthSq() < 1e-12) out.set(0, -0.3, side);
  out.normalize();
  // Orient outward (down at the garboard, sideways at the sheer)
  if (out.y * -0.25 + out.z * side < 0) out.negate();
  return out;
}

/** x of the centre line at station t for a given height y. */
function centerX(t: number, y: number): number {
  return (1 - t) * (X_STERN + RAKE_STERN * y) + t * (X_BOW + RAKE_BOW * y);
}

/** Keel depth below the rabbet (deeper towards the stern – a beach skeg). */
function keelDepth(t: number): number {
  return 0.16 + 0.2 * smoothstep(0.35, 0, t);
}

/** Half width of the hull at station t for a given height y (bisection). */
function hullHalfAt(t: number, y: number): number {
  const yk = keelY(t);
  const ys = sheerY(t);
  if (y <= yk) return 0;
  if (y >= ys) return beamAt(t);
  const rel = (y - yk) / (ys - yk);
  const s = rel ** (1 / 1.15);
  return beamAt(t) * Math.sin((s * Math.PI) / 2) ** secExp(t);
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

type BagKey = "hull" | "wood" | "dress";
type Tint = [number, number, number];

/** Collects non-indexed geometries per material and merges them. */
class GeoBag {
  readonly lists: Record<BagKey, THREE.BufferGeometry[]> = {
    hull: [],
    wood: [],
    dress: [],
  };

  add(key: BagKey, g: THREE.BufferGeometry, tint: Tint = [1, 1, 1]): void {
    let geo = g;
    if (g.index) {
      geo = g.toNonIndexed();
      g.dispose();
    }
    const n = geo.getAttribute("position").count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = tint[0];
      col[i * 3 + 1] = tint[1];
      col[i * 3 + 2] = tint[2];
    }
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    this.lists[key].push(geo);
  }

  merge(key: BagKey): THREE.BufferGeometry | null {
    const list = this.lists[key];
    if (list.length === 0) return null;
    const merged = mergeGeometries(list, false);
    for (const g of list) g.dispose();
    list.length = 0;
    if (!merged) throw new Error(`BoatWreck: mergeGeometries (${key}) failed`);
    merged.computeBoundingSphere();
    return merged;
  }
}

/**
 * Quad strip between two rails with smooth per-column normals, oriented
 * towards `ref[j]`; the winding follows the normals (front faces outward).
 */
function quadStrip(
  a: THREE.Vector3[],
  b: THREE.Vector3[],
  uvA: number[][],
  uvB: number[][],
  ref: THREE.Vector3[],
): THREE.BufferGeometry {
  const M = a.length - 1;
  const colN: THREE.Vector3[] = [];
  const tang = new THREE.Vector3();
  const across = new THREE.Vector3();
  for (let j = 0; j <= M; j++) {
    const j0 = Math.max(0, j - 1);
    const j1 = Math.min(M, j + 1);
    tang.copy(a[j1]).add(b[j1]).sub(a[j0]).sub(b[j0]);
    across.copy(b[j]).sub(a[j]);
    const n = new THREE.Vector3().crossVectors(across, tang);
    if (n.lengthSq() < 1e-12) n.copy(ref[j]);
    n.normalize();
    if (n.dot(ref[j]) < 0) n.negate();
    colN.push(n);
  }
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const put = (p: THREE.Vector3, n: THREE.Vector3, t: number[]) => {
    pos.push(p.x, p.y, p.z);
    nor.push(n.x, n.y, n.z);
    uv.push(t[0], t[1]);
  };
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const gn = new THREE.Vector3();
  for (let j = 0; j < M; j++) {
    e1.copy(a[j + 1]).sub(a[j]);
    e2.copy(b[j + 1]).sub(a[j]);
    gn.crossVectors(e1, e2);
    const keep = gn.dot(colN[j]) >= 0;
    if (keep) {
      put(a[j], colN[j], uvA[j]);
      put(a[j + 1], colN[j + 1], uvA[j + 1]);
      put(b[j + 1], colN[j + 1], uvB[j + 1]);
      put(a[j], colN[j], uvA[j]);
      put(b[j + 1], colN[j + 1], uvB[j + 1]);
      put(b[j], colN[j], uvB[j]);
    } else {
      put(a[j], colN[j], uvA[j]);
      put(b[j + 1], colN[j + 1], uvB[j + 1]);
      put(a[j + 1], colN[j + 1], uvA[j + 1]);
      put(a[j], colN[j], uvA[j]);
      put(b[j], colN[j], uvB[j]);
      put(b[j + 1], colN[j + 1], uvB[j + 1]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(pos), 3),
  );
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(nor), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uv), 2));
  return g;
}

/** Single quad p0..p3 (counter-clockwise seen from `ref`). */
function quadFace(
  p0: THREE.Vector3,
  p1: THREE.Vector3,
  p2: THREE.Vector3,
  p3: THREE.Vector3,
  ref: THREE.Vector3,
  uv: number[][],
): THREE.BufferGeometry {
  return quadStrip(
    [p0, p1],
    [p3, p2],
    [uv[0], uv[1]],
    [uv[3], uv[2]],
    [ref, ref],
  );
}

/** Remap a primitive's UVs: optional u/v swap, then scale + offset. */
function remapUv(
  g: THREE.BufferGeometry,
  swap: boolean,
  su: number,
  sv: number,
  ou: number,
  ov: number,
): THREE.BufferGeometry {
  const attr = g.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < attr.count; i++) {
    const u = attr.getX(i);
    const v = attr.getY(i);
    if (swap) attr.setXY(i, ou + v * su, ov + u * sv);
    else attr.setXY(i, ou + u * su, ov + v * sv);
  }
  attr.needsUpdate = true;
  return g;
}

/** Map a primitive's 0..1 UVs into an atlas rectangle. */
function uvInto(
  g: THREE.BufferGeometry,
  r: readonly [number, number, number, number],
): THREE.BufferGeometry {
  return remapUv(g, false, r[2] - r[0], r[3] - r[1], r[0], r[1]);
}

const V = () => new THREE.Vector3();

// ---------------------------------------------------------------------------
// The landmark
// ---------------------------------------------------------------------------

export class BoatWreck {
  private readonly parent: THREE.Group;
  private readonly quality: QualityId;
  private readonly root = new THREE.Group();
  private readonly materials: THREE.Material[] = [];
  private readonly wetU = {
    uWetY: { value: 0 },
    uWetFade: { value: 0.45 },
  };
  /** Terrain-shader uniforms of the drift/bilge sand (matches world.ts). */
  private readonly sandU = {
    uTime: { value: 0 },
    uWet: { value: 0 },
    uCloud: { value: 0 },
  };
  private sandWet = 0;
  private sandWetInit = false;

  constructor(parent: THREE.Group, quality: QualityId) {
    this.parent = parent;
    this.quality = quality;
    this.root.name = "boat-wreck";

    const seg = { ultra: 26, high: 24, medium: 16, low: 12 }[quality];
    const ribCount = { ultra: 10, high: 10, medium: 7, low: 5 }[quality];

    // ---- placement -------------------------------------------------------
    const rot = new THREE.Matrix4().makeRotationFromEuler(
      new THREE.Euler(HEEL, YAW, PITCH, "YXZ"),
    );
    const samples: THREE.Vector3[] = [];
    for (const t of [0.06, 0.25, 0.5, 0.75, 0.94]) {
      samples.push(V().set(centerX(t, keelY(t)), keelY(t) - keelDepth(t), 0));
    }
    samples.push(surfPoint(0.35, 0.3, -1, V()));
    samples.push(surfPoint(0.65, 0.3, -1, V()));
    let minClear = Number.POSITIVE_INFINITY;
    for (const p of samples) {
      p.applyMatrix4(rot);
      const c = p.y - terrainHeight(AX + p.x, AZ + p.z);
      if (c < minClear) minClear = c;
    }
    const y0 = -SINK - minClear;
    const groundY = terrainHeight(AX, AZ);
    // Waves lick the stern-side sand: wet band relative to the seaward ground
    const sternG = terrainHeight(AX - 2.6, AZ - 1.3);
    this.wetU.uWetY.value = Math.min(groundY, sternG) + 0.52;

    const boat = new THREE.Group();
    boat.rotation.order = "YXZ";
    boat.rotation.set(HEEL, YAW, PITCH);
    boat.position.set(AX, y0, AZ);
    this.root.add(boat);

    // ---- geometry --------------------------------------------------------
    const bag = new GeoBag();
    this.buildStrakes(bag, seg);
    this.buildBackbone(bag, seg);
    this.buildTransom(bag);
    this.buildGunwale(bag, seg);
    this.buildInterior(bag, ribCount);
    this.buildDressing(bag, quality);

    // ---- materials -------------------------------------------------------
    const hullMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      metalness: 0,
    });
    applyPbr(hullMat, boatHullPbr());
    const woodMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      metalness: 0,
    });
    applyPbr(woodMat, boatWoodPbr());
    const dressMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      metalness: 0,
    });
    applyPbr(dressMat, boatDressingPbr());
    // The drift/bilge sand mirrors the TERRAIN material exactly (same maps,
    // no roughness map) and gets the terrain's dynamic shader below – a
    // static tint made it read as a bright cut-out box against the wet,
    // cloud-greyed beach around the waterline.
    const sandMat = new THREE.MeshStandardMaterial({
      map: sandAlbedo(),
      normalMap: sandNormal(),
      normalScale: new THREE.Vector2(0.7, 0.7),
      roughness: 0.95,
      metalness: 0,
    });
    this.patchWet(hullMat, 0.4, 0.5);
    this.patchWet(woodMat, 0.38, 0.55);
    this.patchWet(dressMat, 0.3, 0.7);
    this.patchTerrainSand(sandMat);
    this.materials.push(hullMat, woodMat, dressMat, sandMat);

    const mats: Record<BagKey, THREE.Material> = {
      hull: hullMat,
      wood: woodMat,
      dress: dressMat,
    };
    for (const key of ["hull", "wood", "dress"] as BagKey[]) {
      const geo = bag.merge(key);
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, mats[key]);
      mesh.name = `boat-${key}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      boat.add(mesh);
    }

    // ---- sand drift (world space, blends into the terrain) ---------------
    const drift = this.buildDrift(sandMat, quality);
    this.root.add(drift);
    const boatM = rot.clone().setPosition(AX, y0, AZ);
    this.root.add(this.buildBilgeSand(sandMat, boatM));

    parent.add(this.root);

    // ---- colliders (world coordinates) -----------------------------------
    beginColliderSet("boat");
    const ca = Math.cos(YAW);
    const sa = Math.sin(YAW);
    const place = (dx: number, dz: number): [number, number] => [
      AX + dx * ca + dz * sa,
      AZ - dx * sa + dz * ca,
    ];
    const cy0 = groundY - 1.2;
    const cy1 = groundY + 1.7;
    const mid = place(0, -0.1);
    addBoxCollider(mid[0], mid[1], 1.45, 1.3, YAW, cy0, cy1);
    const bow = place(2.45, 0.05);
    addBoxCollider(bow[0], bow[1], 1.15, 0.95, YAW, cy0, cy1);
    const stern = place(-2.45, -0.1);
    addBoxCollider(stern[0], stern[1], 1.05, 1.1, YAW, cy0, cy1);
  }

  // -------------------------------------------------------------------------

  /** The clinker shell: every strake is an individually stepped thin solid. */
  private buildStrakes(bag: GeoBag, seg: number): void {
    for (const side of [-1, 1]) {
      for (let i = 0; i < STRAKES; i++) {
        const row = side === -1 ? i : i + 8;
        const sLo = SG[i];
        const sHi = SG[i + 1];
        const OB: THREE.Vector3[] = [];
        const OT: THREE.Vector3[] = [];
        const IB: THREE.Vector3[] = [];
        const IT: THREE.Vector3[] = [];
        const nMid: THREE.Vector3[] = [];
        const nLoA: THREE.Vector3[] = [];
        const gDir: THREE.Vector3[] = [];
        const uLine: number[] = [];
        for (let j = 0; j <= seg; j++) {
          const t = j / seg;
          const pLo = surfPoint(t, sLo, side, V());
          const pHi = surfPoint(t, sHi, side, V());
          const nLo = surfNormal(t, Math.max(sLo, 0.01), side, V());
          const nHi = surfNormal(t, sHi, side, V());
          OB.push(
            V()
              .copy(pLo)
              .addScaledVector(nLo, TH + LAP),
          );
          OT.push(V().copy(pHi).addScaledVector(nHi, TH));
          IB.push(V().copy(pLo).addScaledVector(nLo, LAP));
          IT.push(pHi);
          nMid.push(V().copy(nLo).add(nHi).normalize());
          nLoA.push(nLo);
          gDir.push(V().copy(pHi).sub(pLo).normalize());
          uLine.push(0.03 + 0.94 * t);
        }
        // Outer painted face
        const uvOB = uLine.map((u) => [u, hullRowV(row, 0.14)]);
        const uvOT = uLine.map((u) => [u, hullRowV(row, 0.9)]);
        bag.add("hull", quadStrip(OB, OT, uvOB, uvOT, nMid));
        // Land underside – samples the tar seam, carries the lap shadow
        const refDown = nLoA.map((n) =>
          V()
            .copy(n)
            .multiplyScalar(0.6)
            .add(new THREE.Vector3(0, -1, 0)),
        );
        const uvIB = uLine.map((u) => [u, hullRowV(row, 0.035)]);
        const uvOB2 = uLine.map((u) => [u, hullRowV(row, 0.08)]);
        bag.add("hull", quadStrip(IB, OB, uvIB, uvOB2, refDown));
        // Inner face (bare timber, visible in the open boat)
        const refIn = nMid.map((n) => V().copy(n).negate());
        const jit = hash01(i, side + 2, 71) * 0.6;
        const uvIT = uLine.map((u) => [u * 4.2 + jit, 0.32]);
        const uvIB2 = uLine.map((u) => [u * 4.2 + jit, 0.02]);
        const paleJ = 0.72 + hash01(i, side + 5, 72) * 0.12;
        bag.add("wood", quadStrip(IT, IB, uvIT, uvIB2, refIn), [
          paleJ,
          paleJ * 0.94,
          paleJ * 0.85,
        ]);
        // Top edge (mostly hidden beneath the next land)
        const uvE1 = uLine.map((u) => [u * 4.2, 0.36]);
        const uvE2 = uLine.map((u) => [u * 4.2, 0.4]);
        bag.add("wood", quadStrip(OT, IT, uvE1, uvE2, gDir), [0.6, 0.55, 0.48]);
        // End caps
        const capUv = [
          [0, 0],
          [0.05, 0],
          [0.05, 0.04],
          [0, 0.04],
        ];
        bag.add(
          "wood",
          quadFace(
            IB[0],
            OB[0],
            OT[0],
            IT[0],
            new THREE.Vector3(-1, 0, 0),
            capUv,
          ),
          [0.5, 0.45, 0.4],
        );
        bag.add(
          "wood",
          quadFace(
            IB[seg],
            IT[seg],
            OT[seg],
            OB[seg],
            new THREE.Vector3(1, 0, 0),
            capUv,
          ),
          [0.5, 0.45, 0.4],
        );
      }
    }
  }

  /** External keel with stern skeg, hog and stem timber. */
  private buildBackbone(bag: GeoBag, seg: number): void {
    const tar: Tint = [0.42, 0.37, 0.31];
    // Keel
    const KTP: THREE.Vector3[] = [];
    const KBP: THREE.Vector3[] = [];
    const KBS: THREE.Vector3[] = [];
    const KTS: THREE.Vector3[] = [];
    const uK: number[] = [];
    for (let j = 0; j <= seg; j++) {
      const t = j / seg;
      const yT = keelY(t) + 0.03;
      const yB = keelY(t) - keelDepth(t);
      const x = centerX(t, keelY(t));
      KTP.push(V().set(x, yT, -0.06));
      KBP.push(V().set(x, yB, -0.06));
      KBS.push(V().set(x, yB, 0.06));
      KTS.push(V().set(x, yT, 0.06));
      uK.push(t * 4);
    }
    const refP = KTP.map(() => new THREE.Vector3(0, 0, -1));
    const refS = KTP.map(() => new THREE.Vector3(0, 0, 1));
    const refD = KTP.map(() => new THREE.Vector3(0, -1, 0));
    bag.add(
      "wood",
      quadStrip(
        KTP,
        KBP,
        uK.map((u) => [u, 0.5]),
        uK.map((u) => [u, 0.62]),
        refP,
      ),
      tar,
    );
    bag.add(
      "wood",
      quadStrip(
        KBP,
        KBS,
        uK.map((u) => [u, 0.62]),
        uK.map((u) => [u, 0.68]),
        refD,
      ),
      tar,
    );
    bag.add(
      "wood",
      quadStrip(
        KBS,
        KTS,
        uK.map((u) => [u, 0.68]),
        uK.map((u) => [u, 0.8]),
        refS,
      ),
      tar,
    );
    const capUv = [
      [0, 0.5],
      [0.06, 0.5],
      [0.06, 0.62],
      [0, 0.62],
    ];
    bag.add(
      "wood",
      quadFace(
        KBP[0],
        KBS[0],
        KTS[0],
        KTP[0],
        new THREE.Vector3(-1, 0, 0),
        capUv,
      ),
      tar,
    );
    // Hog (keelson) covering the garboard seam inside
    const HTP: THREE.Vector3[] = [];
    const HTS: THREE.Vector3[] = [];
    const HBP: THREE.Vector3[] = [];
    const HBS: THREE.Vector3[] = [];
    for (let j = 0; j <= seg; j++) {
      const t = lerp(0.03, 0.97, j / seg);
      const yT = keelY(t) + 0.075;
      const yB = keelY(t) + 0.015;
      const x = centerX(t, keelY(t));
      HTP.push(V().set(x, yT, -0.09));
      HTS.push(V().set(x, yT, 0.09));
      HBP.push(V().set(x, yB, -0.105));
      HBS.push(V().set(x, yB, 0.105));
    }
    const refU = HTP.map(() => new THREE.Vector3(0, 1, 0));
    bag.add(
      "wood",
      quadStrip(
        HTP,
        HTS,
        uK.map((u) => [u, 0.84]),
        uK.map((u) => [u, 0.92]),
        refU,
      ),
      tar,
    );
    bag.add(
      "wood",
      quadStrip(
        HBP,
        HTP,
        uK.map((u) => [u, 0.8]),
        uK.map((u) => [u, 0.84]),
        refP,
      ),
      tar,
    );
    bag.add(
      "wood",
      quadStrip(
        HTS,
        HBS,
        uK.map((u) => [u, 0.92]),
        uK.map((u) => [u, 0.96]),
        refS,
      ),
      tar,
    );
    // Stem
    const SM = 10;
    const hullP: THREE.Vector3[] = [];
    const hullS: THREE.Vector3[] = [];
    const frontP: THREE.Vector3[] = [];
    const frontS: THREE.Vector3[] = [];
    const uS: number[] = [];
    for (let k = 0; k <= SM; k++) {
      const s = k / SM;
      const yk = keelY(1);
      const ys = sheerY(1) + 0.06;
      const y = k === 0 ? yk - 0.14 : yk + (ys - yk) * s ** 1.15;
      const xb = X_BOW + RAKE_BOW * Math.max(y, yk);
      // Stem direction and its forward normal in the x/y plane
      const inv = 1 / Math.hypot(RAKE_BOW, 1);
      const fx = 1 * inv;
      const fy = -RAKE_BOW * inv;
      hullP.push(V().set(xb - 0.03, y, -0.055));
      hullS.push(V().set(xb - 0.03, y, 0.055));
      frontP.push(V().set(xb + fx * 0.13, y + fy * 0.13, -0.042));
      frontS.push(V().set(xb + fx * 0.13, y + fy * 0.13, 0.042));
      uS.push(s * 2.2);
    }
    const refFp = hullP.map(() => new THREE.Vector3(0, 0, -1));
    const refFs = hullP.map(() => new THREE.Vector3(0, 0, 1));
    const refFwd = hullP.map(() => new THREE.Vector3(1, -0.4, 0));
    bag.add(
      "wood",
      quadStrip(
        hullP,
        frontP,
        uS.map((u) => [u, 0.05]),
        uS.map((u) => [u, 0.16]),
        refFp,
      ),
      tar,
    );
    bag.add(
      "wood",
      quadStrip(
        frontP,
        frontS,
        uS.map((u) => [u, 0.16]),
        uS.map((u) => [u, 0.26]),
        refFwd,
      ),
      tar,
    );
    bag.add(
      "wood",
      quadStrip(
        frontS,
        hullS,
        uS.map((u) => [u, 0.26]),
        uS.map((u) => [u, 0.37]),
        refFs,
      ),
      tar,
    );
    bag.add(
      "wood",
      quadFace(
        hullP[SM],
        frontP[SM],
        frontS[SM],
        hullS[SM],
        new THREE.Vector3(0.4, 1, 0),
        capUv,
      ),
      tar,
    );
  }

  /** Raked transom board, painted like the hull (horizontal plank bands). */
  private buildTransom(bag: GeoBag): void {
    const NS = 9;
    const outline: THREE.Vector3[] = [];
    outline.push(
      V().set(X_STERN + RAKE_STERN * (keelY(0) - 0.02), keelY(0) - 0.02, 0),
    );
    for (let k = 1; k <= NS; k++) outline.push(surfPoint(0, k / NS, -1, V()));
    for (let k = NS; k >= 1; k--) outline.push(surfPoint(0, k / NS, 1, V()));
    const fwd = new THREE.Vector3(1, RAKE_STERN * -1, 0).normalize();
    const aft = fwd.clone().negate();
    const yb = keelY(0) - 0.02;
    const yt = sheerY(0);
    const uvOf = (p: THREE.Vector3): [number, number] => [
      0.03 + ((p.z + 0.9) / 1.8) * 0.24,
      (1.4 + 5.2 * clamp((p.y - yb) / (yt - yb), 0, 1)) / 16,
    ];
    const buildFace = (
      offset: number,
      normal: THREE.Vector3,
    ): THREE.BufferGeometry => {
      const c = new THREE.Vector3();
      for (const p of outline) c.add(p);
      c.divideScalar(outline.length).addScaledVector(aft, offset);
      const pos: number[] = [];
      const nor: number[] = [];
      const uv: number[] = [];
      const cUv = uvOf(c);
      for (let k = 0; k < outline.length; k++) {
        const p0 = V().copy(outline[k]).addScaledVector(aft, offset);
        const p1 = V()
          .copy(outline[(k + 1) % outline.length])
          .addScaledVector(aft, offset);
        const flip = normal.dot(fwd) < 0;
        const a = flip ? p1 : p0;
        const b = flip ? p0 : p1;
        const ua = uvOf(flip ? p1 : p0);
        const ub = uvOf(flip ? p0 : p1);
        pos.push(c.x, c.y, c.z, a.x, a.y, a.z, b.x, b.y, b.z);
        for (let m = 0; m < 3; m++) nor.push(normal.x, normal.y, normal.z);
        uv.push(cUv[0], cUv[1], ua[0], ua[1], ub[0], ub[1]);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(pos), 3),
      );
      g.setAttribute(
        "normal",
        new THREE.BufferAttribute(new Float32Array(nor), 3),
      );
      g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uv), 2));
      return g;
    };
    bag.add("hull", buildFace(0, fwd));
    bag.add("hull", buildFace(0.035, aft));
    // Top edge cap
    const tp = surfPoint(0, 1, -1, V());
    const ts = surfPoint(0, 1, 1, V());
    const tpA = V().copy(tp).addScaledVector(aft, 0.035);
    const tsA = V().copy(ts).addScaledVector(aft, 0.035);
    bag.add(
      "wood",
      quadFace(tp, ts, tsA, tpA, new THREE.Vector3(-0.3, 1, 0), [
        [0, 0.44],
        [1.6, 0.44],
        [1.6, 0.48],
        [0, 0.48],
      ]),
      [0.55, 0.5, 0.44],
    );
  }

  /** Gunwale capping + rubbing strake on both sides. */
  private buildGunwale(bag: GeoBag, seg: number): void {
    const pale: Tint = [0.82, 0.78, 0.7];
    const dark: Tint = [0.4, 0.35, 0.3];
    const nH = new THREE.Vector3();
    for (const side of [-1, 1]) {
      const OT: THREE.Vector3[] = [];
      const IT: THREE.Vector3[] = [];
      const OB: THREE.Vector3[] = [];
      const IBv: THREE.Vector3[] = [];
      const nRail: THREE.Vector3[] = [];
      const uR: number[] = [];
      for (let j = 0; j <= seg; j++) {
        const t = lerp(0.015, 0.995, j / seg);
        const c = surfPoint(t, 1, side, V());
        surfNormal(t, 0.99, side, nH);
        nH.y = 0;
        if (nH.lengthSq() < 1e-6) nH.set(0, 0, side);
        nH.normalize();
        OT.push(
          V()
            .copy(c)
            .addScaledVector(nH, 0.05)
            .add(new THREE.Vector3(0, 0.05, 0)),
        );
        IT.push(
          V()
            .copy(c)
            .addScaledVector(nH, -0.075)
            .add(new THREE.Vector3(0, 0.05, 0)),
        );
        OB.push(
          V()
            .copy(c)
            .addScaledVector(nH, 0.05)
            .add(new THREE.Vector3(0, -0.012, 0)),
        );
        IBv.push(
          V()
            .copy(c)
            .addScaledVector(nH, -0.075)
            .add(new THREE.Vector3(0, -0.02, 0)),
        );
        nRail.push(nH.clone());
        uR.push(t * 5);
      }
      const refUp = nRail.map(() => new THREE.Vector3(0, 1, 0));
      const refIn = nRail.map((n) => n.clone().negate());
      bag.add(
        "wood",
        quadStrip(
          OT,
          IT,
          uR.map((u) => [u, 0.05]),
          uR.map((u) => [u, 0.14]),
          refUp,
        ),
        pale,
      );
      bag.add(
        "wood",
        quadStrip(
          OB,
          OT,
          uR.map((u) => [u, 0.0]),
          uR.map((u) => [u, 0.05]),
          nRail,
        ),
        pale,
      );
      bag.add(
        "wood",
        quadStrip(
          IT,
          IBv,
          uR.map((u) => [u, 0.14]),
          uR.map((u) => [u, 0.2]),
          refIn,
        ),
        pale,
      );
      // Rubbing strake proud of the sheer-strake seam
      const RU: THREE.Vector3[] = [];
      const RM: THREE.Vector3[] = [];
      const RL: THREE.Vector3[] = [];
      const nRub: THREE.Vector3[] = [];
      for (let j = 0; j <= seg; j++) {
        const t = lerp(0.03, 0.99, j / seg);
        const c = surfPoint(t, SG[7], side, V());
        const n = surfNormal(t, SG[7], side, V());
        const base = V()
          .copy(c)
          .addScaledVector(n, TH + LAP + 0.006);
        RU.push(
          V()
            .copy(base)
            .add(new THREE.Vector3(0, 0.03, 0)),
        );
        RM.push(V().copy(base).addScaledVector(n, 0.024));
        RL.push(
          V()
            .copy(base)
            .add(new THREE.Vector3(0, -0.03, 0)),
        );
        nRub.push(n);
      }
      const refRubU = nRub.map((n) =>
        V()
          .copy(n)
          .add(new THREE.Vector3(0, 0.8, 0)),
      );
      const refRubL = nRub.map((n) =>
        V()
          .copy(n)
          .add(new THREE.Vector3(0, -0.8, 0)),
      );
      bag.add(
        "wood",
        quadStrip(
          RU,
          RM,
          uR.map((u) => [u, 0.24]),
          uR.map((u) => [u, 0.28]),
          refRubU,
        ),
        dark,
      );
      bag.add(
        "wood",
        quadStrip(
          RM,
          RL,
          uR.map((u) => [u, 0.28]),
          uR.map((u) => [u, 0.32]),
          refRubL,
        ),
        dark,
      );
    }
  }

  /** Frames (ribs), thwarts and bottom boards. */
  private buildInterior(bag: GeoBag, ribCount: number): void {
    // Steam-bent ribs
    const ribTs = [0.1, 0.18, 0.27, 0.36, 0.45, 0.54, 0.63, 0.72, 0.81, 0.9];
    const step = ribTs.length / ribCount;
    for (let r = 0; r < ribCount; r++) {
      const t = ribTs[Math.min(ribTs.length - 1, Math.round(r * step))];
      for (const side of [-1, 1]) {
        const KS = 10;
        const fore: THREE.Vector3[] = [];
        const aftR: THREE.Vector3[] = [];
        const foreI: THREE.Vector3[] = [];
        const aftI: THREE.Vector3[] = [];
        const nIn: THREE.Vector3[] = [];
        const uRib: number[] = [];
        for (let k = 0; k <= KS; k++) {
          const s = lerp(0.05, 0.965, k / KS);
          const b = surfPoint(t, s, side, V());
          const n = surfNormal(t, s, side, V());
          b.addScaledVector(n, 0.012);
          const xd = new THREE.Vector3(1, 0, 0);
          fore.push(V().copy(b).addScaledVector(xd, 0.023));
          aftR.push(V().copy(b).addScaledVector(xd, -0.023));
          foreI.push(
            V().copy(b).addScaledVector(xd, 0.023).addScaledVector(n, -0.037),
          );
          aftI.push(
            V().copy(b).addScaledVector(xd, -0.023).addScaledVector(n, -0.037),
          );
          nIn.push(V().copy(n).negate());
          uRib.push(k * 0.24 + hash01(r, side + 3, 73) * 2);
        }
        const jr = 0.46 + hash01(r, side + 7, 74) * 0.12;
        const tint: Tint = [jr, jr * 0.86, jr * 0.72];
        const refF = nIn.map(() => new THREE.Vector3(1, 0, 0));
        const refA = nIn.map(() => new THREE.Vector3(-1, 0, 0));
        bag.add(
          "wood",
          quadStrip(
            foreI,
            aftI,
            uRib.map((u) => [u, 0.55]),
            uRib.map((u) => [u, 0.6]),
            nIn,
          ),
          tint,
        );
        bag.add(
          "wood",
          quadStrip(
            fore,
            foreI,
            uRib.map((u) => [u, 0.5]),
            uRib.map((u) => [u, 0.55]),
            refF,
          ),
          tint,
        );
        bag.add(
          "wood",
          quadStrip(
            aftI,
            aftR,
            uRib.map((u) => [u, 0.6]),
            uRib.map((u) => [u, 0.65]),
            refA,
          ),
          tint,
        );
      }
    }
    // Thwarts (two seats)
    for (const t of [0.34, 0.62]) {
      const yT = keelY(t) + 0.42;
      const half = hullHalfAt(t, yT) - 0.04;
      const g = new THREE.BoxGeometry(half * 2, 0.045, 0.3);
      g.rotateY(Math.PI / 2);
      g.translate(centerX(t, yT), yT, 0);
      remapUv(g, false, 2, 0.4, hash01(Math.round(t * 100), 1, 75), 0);
      bag.add("wood", g, [0.75, 0.7, 0.62]);
    }
    // Bottom boards
    const zcs = [-0.34, -0.17, 0, 0.17, 0.34];
    for (let b = 0; b < zcs.length; b++) {
      const zc = zcs[b];
      // Find the t range where the hull is wide enough at board height
      let tA = 0.5;
      let tB = 0.5;
      for (let t = 0.1; t <= 0.9; t += 0.02) {
        const y = keelY(t) + 0.1;
        if (hullHalfAt(t, y) > Math.abs(zc) + 0.12) {
          tA = Math.min(tA, t);
          tB = Math.max(tB, t);
        }
      }
      if (tB - tA < 0.1) continue;
      const BM = 8;
      const L: THREE.Vector3[] = [];
      const R: THREE.Vector3[] = [];
      const LD: THREE.Vector3[] = [];
      const RD: THREE.Vector3[] = [];
      const uB: number[] = [];
      for (let j = 0; j <= BM; j++) {
        const t = lerp(tA + 0.02, tB - 0.02, j / BM);
        const y = keelY(t) + 0.1;
        const x = centerX(t, y);
        L.push(V().set(x, y, zc - 0.065));
        R.push(V().set(x, y, zc + 0.065));
        LD.push(V().set(x, y - 0.03, zc - 0.065));
        RD.push(V().set(x, y - 0.03, zc + 0.065));
        uB.push(t * 3.5 + hash01(b, 2, 76));
      }
      const refUp = L.map(() => new THREE.Vector3(0, 1, 0));
      const refL = L.map(() => new THREE.Vector3(0, 0, -1));
      const refR = L.map(() => new THREE.Vector3(0, 0, 1));
      const tint: Tint = [0.62, 0.58, 0.5];
      bag.add(
        "wood",
        quadStrip(
          L,
          R,
          uB.map((u) => [u, 0.7]),
          uB.map((u) => [u, 0.78]),
          refUp,
        ),
        tint,
      );
      bag.add(
        "wood",
        quadStrip(
          LD,
          L,
          uB.map((u) => [u, 0.66]),
          uB.map((u) => [u, 0.7]),
          refL,
        ),
        tint,
      );
      bag.add(
        "wood",
        quadStrip(
          R,
          RD,
          uB.map((u) => [u, 0.78]),
          uB.map((u) => [u, 0.82]),
          refR,
        ),
        tint,
      );
    }
    // Two oars lying askew across the thwarts
    const oarSpecs: {
      p: [number, number, number];
      e: [number, number, number];
    }[] = [
      { p: [0.15, 0.56, 0.14], e: [0.03, 0.2, 0.035] },
      { p: [-0.55, 0.55, -0.3], e: [-0.02, -0.16, -0.02] },
    ];
    for (const spec of oarSpecs) {
      const shaft = new THREE.CylinderGeometry(0.024, 0.029, 2.3, 7, 1);
      shaft.rotateZ(Math.PI / 2);
      remapUv(shaft, true, 2.5, 0.3, 0, 0.1);
      const blade = new THREE.BoxGeometry(0.8, 0.024, 0.15);
      blade.translate(1.5, 0, 0);
      remapUv(blade, false, 1, 0.3, 0, 0.5);
      const grip = new THREE.CylinderGeometry(0.018, 0.018, 0.26, 6, 1);
      grip.rotateZ(Math.PI / 2);
      grip.translate(-1.25, 0, 0);
      remapUv(grip, true, 0.4, 0.2, 0, 0.7);
      const oar = mergeGeometries(
        [shaft.toNonIndexed(), blade.toNonIndexed(), grip.toNonIndexed()],
        false,
      );
      shaft.dispose();
      blade.dispose();
      grip.dispose();
      if (!oar) continue;
      const m = new THREE.Matrix4()
        .makeRotationFromEuler(new THREE.Euler(spec.e[0], spec.e[1], spec.e[2]))
        .setPosition(spec.p[0], spec.p[1], spec.p[2]);
      oar.applyMatrix4(m);
      bag.add("wood", oar, [0.8, 0.76, 0.67]);
    }
  }

  /** Net, rope coil, buoy and rowlock pins (dressing atlas material). */
  private buildDressing(bag: GeoBag, quality: QualityId): void {
    const lowQ = quality === "medium" || quality === "low";
    // --- torn net draped over the port gunwale ---
    const C = lowQ ? 7 : 10;
    const K = 11;
    const cols: THREE.Vector3[][] = [];
    for (let c = 0; c < C; c++) {
      const fc = c / (C - 1);
      const t = lerp(0.36, 0.68, fc) + (hash01(c, 1, 81) - 0.5) * 0.015;
      const sEnd = 0.58 + hash01(c, 2, 82) * 0.16;
      const rail = surfPoint(t, 1, -1, V()).add(new THREE.Vector3(0, 0.065, 0));
      const inner = surfPoint(t, 0.74, -1, V()).add(
        new THREE.Vector3(0, -0.1, 0.42),
      );
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= 3; k++) {
        const q = k / 3;
        const p = V().lerpVectors(inner, rail, q);
        p.y -= 0.15 * Math.sin(Math.PI * q) * (1 - q * 0.4);
        p.x += (hash01(c * 7 + k, 3, 83) - 0.5) * 0.06;
        pts.push(p);
      }
      for (let k = 1; k <= K - 4; k++) {
        const s = lerp(0.965, sEnd, k / (K - 4));
        const p = surfPoint(t, s, -1, V());
        const n = surfNormal(t, s, -1, V());
        p.addScaledVector(n, 0.09);
        p.x += (hash01(c * 11 + k, 4, 84) - 0.5) * 0.05;
        pts.push(p);
      }
      cols.push(pts);
    }
    const [nu0, nv0, nu1, nv1] = DRESS_UV.net;
    const netRef: THREE.Vector3[] = [];
    for (let k = 0; k < K; k++) netRef.push(new THREE.Vector3(0, 0.55, -0.84));
    for (let c = 0; c < C - 1; c++) {
      const uvA = cols[c].map((_, k) => [
        nu0 + ((nu1 - nu0) * c) / (C - 1),
        nv0 + ((nv1 - nv0) * k) / (K - 1),
      ]);
      const uvB = cols[c + 1].map((_, k) => [
        nu0 + ((nu1 - nu0) * (c + 1)) / (C - 1),
        nv0 + ((nv1 - nv0) * k) / (K - 1),
      ]);
      bag.add("dress", quadStrip(cols[c], cols[c + 1], uvA, uvB, netRef));
    }
    // --- rope coil on the bottom boards near the stern ---
    const coilAt = new THREE.Vector3(-1.95, 0.19, 0.3);
    const loops = lowQ ? 2 : 3;
    for (let k = 0; k < loops; k++) {
      const torus = new THREE.TorusGeometry(
        0.165 - k * 0.02,
        0.024,
        6,
        lowQ ? 16 : 22,
      );
      torus.rotateX(Math.PI / 2);
      torus.rotateY(hash01(k, 5, 85) * 0.8);
      torus.translate(
        coilAt.x + (hash01(k, 6, 86) - 0.5) * 0.03,
        coilAt.y + k * 0.036,
        coilAt.z + (hash01(k, 7, 87) - 0.5) * 0.03,
      );
      uvInto(torus, DRESS_UV.rope);
      bag.add("dress", torus);
    }
    const tail = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-1.79, 0.2, 0.34),
      new THREE.Vector3(-1.52, 0.15, 0.52),
      new THREE.Vector3(-1.28, 0.13, 0.4),
      new THREE.Vector3(-1.1, 0.12, 0.18),
    ]);
    const tailGeo = new THREE.TubeGeometry(tail, lowQ ? 6 : 10, 0.02, 5, false);
    uvInto(tailGeo, DRESS_UV.rope);
    bag.add("dress", tailGeo);
    // --- cracked buoy hanging over the starboard quarter ---
    const g = surfPoint(0.3, 1, 1, V());
    const gn = surfNormal(0.3, 0.97, 1, V());
    gn.y = 0;
    gn.normalize();
    const buoyC = V()
      .copy(g)
      .addScaledVector(gn, 0.14)
      .add(new THREE.Vector3(0, -0.5, 0));
    const buoy = new THREE.SphereGeometry(0.17, lowQ ? 10 : 14, lowQ ? 8 : 10);
    buoy.scale(1, 0.86, 1);
    buoy.translate(buoyC.x, buoyC.y, buoyC.z);
    uvInto(buoy, DRESS_UV.buoy);
    bag.add("dress", buoy);
    const buoyRope = new THREE.CatmullRomCurve3([
      V()
        .copy(g)
        .add(new THREE.Vector3(0, 0.05, 0)),
      V()
        .copy(g)
        .addScaledVector(gn, 0.08)
        .add(new THREE.Vector3(0, -0.2, 0)),
      V()
        .copy(buoyC)
        .add(new THREE.Vector3(0, 0.12, 0)),
    ]);
    const buoyRopeGeo = new THREE.TubeGeometry(buoyRope, 6, 0.013, 5, false);
    uvInto(buoyRopeGeo, DRESS_UV.rope);
    bag.add("dress", buoyRopeGeo);
    // --- rusted rowlock pins on both gunwales ---
    for (const side of [-1, 1]) {
      const t = 0.58;
      const c = surfPoint(t, 1, side, V());
      const u = new THREE.TorusGeometry(0.052, 0.015, 5, 10, Math.PI);
      u.rotateZ(Math.PI);
      u.rotateY(Math.PI / 2);
      u.translate(c.x, c.y + 0.11, c.z - side * 0.02);
      uvInto(u, DRESS_UV.iron);
      bag.add("dress", u);
      const pin = new THREE.CylinderGeometry(0.014, 0.014, 0.1, 6, 1);
      pin.translate(c.x, c.y + 0.04, c.z - side * 0.02);
      uvInto(pin, DRESS_UV.iron);
      bag.add("dress", pin);
    }
  }

  /** Wind-blown sand banked against the hull (world space, terrain-matched). */
  private buildDrift(mat: THREE.Material, quality: QualityId): THREE.Mesh {
    const lowQ = quality === "medium" || quality === "low";
    const NA = lowQ ? 24 : 34;
    const NB = lowQ ? 11 : 16;
    const la0 = -4.8;
    const la1 = 5.0;
    const lb0 = -1.6;
    const lb1 = 2.8;
    const ca = Math.cos(YAW);
    const sa = Math.sin(YAW);
    const pos = new Float32Array((NA + 1) * (NB + 1) * 3);
    const uv = new Float32Array((NA + 1) * (NB + 1) * 2);
    // Sand tile size copied from world.ts (TILE_X/TILE_Z), so the drift's
    // texture lines up with the terrain's in scale AND phase.
    const TILE_X = 820 / 70;
    const TILE_Z = 560 / 48;
    let vi = 0;
    for (let j = 0; j <= NB; j++) {
      const lb = lerp(lb0, lb1, j / NB);
      for (let i = 0; i <= NA; i++) {
        const la = lerp(la0, la1, i / NA);
        // Height: main ridge along the leeward (starboard/inland) side plus
        // lobes hugging the stern and the bow toe.
        const ridgeZ = 0.95 + 0.15 * Math.sin(la * 0.9);
        const dz = lb - ridgeZ;
        const sig = dz < 0 ? 0.42 : 0.8;
        let h =
          0.42 *
          smoothstep(-4.2, -1.0, la) *
          smoothstep(4.4, 1.2, la) *
          Math.exp(-((dz / sig) * (dz / sig)));
        h +=
          0.2 * Math.exp(-(((la + 3.6) / 1.4) ** 2) - ((lb - 0.45) / 1.0) ** 2);
        h +=
          0.28 *
          Math.exp(-(((la - 3.9) / 1.25) ** 2) - ((lb - 0.1) / 0.9) ** 2);
        if (h > 0.02) h += 0.02 * Math.sin(la * 5.2 + lb * 2.1);
        const fade =
          smoothstep(0, 0.8, la - la0) *
          smoothstep(0, 0.8, la1 - la) *
          smoothstep(0, 0.6, lb - lb0) *
          smoothstep(0, 0.6, lb1 - lb);
        const wx = AX + la * ca + lb * sa;
        const wz = AZ - la * sa + lb * ca;
        const wy = terrainHeight(wx, wz) + Math.max(0, h) * fade + 0.01;
        pos[vi * 3] = wx;
        pos[vi * 3 + 1] = wy;
        pos[vi * 3 + 2] = wz;
        uv[vi * 2] = (wx + 410) / TILE_X;
        uv[vi * 2 + 1] = (420 - wz) / TILE_Z;
        vi++;
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < NB; j++) {
      for (let i = 0; i < NA; i++) {
        const a = j * (NA + 1) + i;
        const b = a + NA + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "boat-drift";
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    return mesh;
  }

  /**
   * Sand drifted INTO the open hull: pools flat-ish against the low (port)
   * side, hides where the terrain would cut through the bilge, and lets the
   * bottom boards emerge from it. World space, clamped above the terrain.
   */
  private buildBilgeSand(
    mat: THREE.Material,
    boatM: THREE.Matrix4,
  ): THREE.Mesh {
    const NA = 22;
    const NB = 10;
    const la0 = -2.95;
    const la1 = 2.95;
    const lb0 = -0.95;
    const lb1 = 0.62;
    const TILE_X = 820 / 70;
    const TILE_Z = 560 / 48;
    const flat = new THREE.Vector3(0, 0.17, 0).applyMatrix4(boatM);
    const p = new THREE.Vector3();
    const pos = new Float32Array((NA + 1) * (NB + 1) * 3);
    const uv = new Float32Array((NA + 1) * (NB + 1) * 2);
    let vi = 0;
    for (let j = 0; j <= NB; j++) {
      const lb = lerp(lb0, lb1, j / NB);
      for (let i = 0; i <= NA; i++) {
        const la = lerp(la0, la1, i / NA);
        p.set(la, 0.17, lb).applyMatrix4(boatM);
        const fade =
          smoothstep(0, 0.9, la - la0) *
          smoothstep(0, 0.9, la1 - la) *
          smoothstep(0, 0.35, lb - lb0) *
          smoothstep(0, 0.35, lb1 - lb);
        // Sand slumps towards the low side: only 45 % of the hull's tilt
        let y = lerp(flat.y, p.y, 0.45);
        y += 0.02 * Math.sin(la * 4.1 + lb * 2.3) + 0.015 * Math.sin(la * 9.7);
        y -= (1 - fade) * 0.3; // tuck the rim under the planking
        const wy = Math.max(y, terrainHeight(p.x, p.z) + 0.045);
        pos[vi * 3] = p.x;
        pos[vi * 3 + 1] = wy;
        pos[vi * 3 + 2] = p.z;
        uv[vi * 2] = (p.x + 410) / TILE_X;
        uv[vi * 2 + 1] = (420 - p.z) / TILE_Z;
        vi++;
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < NB; j++) {
      for (let i = 0; i < NA; i++) {
        const a = j * (NA + 1) + i;
        const b = a + NA + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "boat-bilge-sand";
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    return mesh;
  }

  /** Static wet-darkening band: lower ~0.5 m darker + less rough. */
  private patchWet(mat: THREE.Material, dark: number, roughMul: number): void {
    const u = this.wetU;
    mat.customProgramCacheKey = () => `boatwet:${dark}:${roughMul}`;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uWetY = u.uWetY;
      sh.uniforms.uWetFade = u.uWetFade;
      sh.vertexShader =
        `uniform float uWetY;\nuniform float uWetFade;\nvarying float vBoatWet;\n${sh.vertexShader}`.replace(
          "#include <worldpos_vertex>",
          `#include <worldpos_vertex>
          { vec4 bWp = modelMatrix * vec4( transformed, 1.0 );
            vBoatWet = 1.0 - smoothstep( uWetY - uWetFade, uWetY + uWetFade * 0.35, bWp.y ); }`,
        );
      sh.fragmentShader = `varying float vBoatWet;\n${sh.fragmentShader}`
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          diffuseColor.rgb *= 1.0 - ${dark.toFixed(2)} * vBoatWet;`,
        )
        .replace(
          "#include <roughnessmap_fragment>",
          `#include <roughnessmap_fragment>
          roughnessFactor = mix( roughnessFactor, roughnessFactor * ${roughMul.toFixed(2)}, vBoatWet );`,
        );
    };
  }

  /**
   * The drift sand follows the terrain shader's state: wave-reach clock,
   * smoothed rain wetness (wets fast, dries slowly – same rates as world.ts)
   * and the cloud grey-out. Without this the drift pops bright against the
   * beach whenever the sand around it is wet or the sky is grey.
   */
  private patchTerrainSand(mat: THREE.MeshStandardMaterial): void {
    const u = this.sandU;
    mat.customProgramCacheKey = () => "boat-terrain-sand";
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = u.uTime;
      shader.uniforms.uWet = u.uWet;
      shader.uniforms.uCloud = u.uCloud;
      shader.vertexShader =
        `varying vec3 vWorldPos;\n${shader.vertexShader}`.replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\n vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;",
        );
      shader.fragmentShader =
        `varying vec3 vWorldPos;\nuniform float uTime;\nuniform float uWet;\nuniform float uCloud;\n${SHORE_GLSL}
         float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
         float wNoise(vec2 p) {
           vec2 i = floor(p); vec2 f = p - i;
           f = f * f * (3.0 - 2.0 * f);
           float a = wHash(i), b = wHash(i + vec2(1.0, 0.0));
           float c = wHash(i + vec2(0.0, 1.0)), d = wHash(i + vec2(1.0, 1.0));
           return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
         }
         float wetSand;
         ${shader.fragmentShader}`
          .replace(
            "#include <color_fragment>",
            `#include <color_fragment>
           float dShore = vWorldPos.z - shoreZf(vWorldPos.x);
           float reach = waveReachF(uTime);
           wetSand = 1.0 - smoothstep(reach, reach + 6.0, dShore);
           wetSand = max(wetSand, 1.0 - smoothstep(-0.5, 0.4, dShore));
           float pud = wNoise(vWorldPos.xz * 0.085) * 0.65
                     + wNoise(vWorldPos.xz * 0.31) * 0.35;
           float rainWet = uWet * (0.5 + 0.5 * smoothstep(0.32, 0.68, pud));
           wetSand = max(wetSand, rainWet * 0.85);
           diffuseColor.rgb *= mix(1.0, 0.6, wetSand);
           float grey = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
           diffuseColor.rgb = mix(
             diffuseColor.rgb,
             vec3(grey) * vec3(0.97, 0.99, 1.05),
             uCloud * 0.42);
          `,
          )
          .replace(
            "#include <roughnessmap_fragment>",
            `#include <roughnessmap_fragment>
           roughnessFactor = mix(roughnessFactor, 0.3, wetSand);
          `,
          )
          .replace(
            "#include <normal_fragment_maps>",
            `#include <normal_fragment_maps>
           normal = normalize(mix(normal, nonPerturbedNormal, wetSand * 0.6));
          `,
          );
    };
  }

  update(dt: number, env: Environment, _camPos: THREE.Vector3): void {
    // Nothing on the wreck itself is animated – but its sand keeps step with
    // the beach around it (wave clock, rain wetness, cloud grey-out).
    this.sandU.uTime.value = env.envTime;
    if (this.sandWetInit) {
      const rate = env.rain > this.sandWet ? 0.5 : 0.02;
      this.sandWet += (env.rain - this.sandWet) * Math.min(1, dt * rate);
    } else {
      this.sandWet = env.rain;
      this.sandWetInit = true;
    }
    this.sandU.uWet.value = this.sandWet;
    this.sandU.uCloud.value = env.cloud;
  }

  dispose(): void {
    clearColliderSet("boat");
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    for (const m of this.materials) m.dispose();
    this.parent.remove(this.root);
  }
}
