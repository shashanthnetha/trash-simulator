// Trash: 25 detailed, procedurally built object types (trash-models*.ts) as
// InstancedMeshes with material groups, raycast picking, outline highlight,
// terrain alignment, poses (upright/lying) and restocking by the tide.
//
// Visibility/LOD: the instances live as master matrices in JS memory. Every
// frame they are tested against the camera frustum and the distance and are
// distributed over two InstancedMeshes per type – near: full geometry with all
// material groups and shadows, far: decimated LOD (trash-geo.decimate) with a
// single material and without shadows. Beyond the view distance everything is
// dropped. This is clocked by an invisible isLOD object: three calls its
// update(camera) while building the render list – before the shadow pass and
// culling, so without touching the engine loop and without a draw call.

import * as THREE from "three";
import { groundHeight } from "./ground";
import { tipPocketPoint } from "./landforms";
import { mulberry32 } from "./noise";
import { useGame } from "./state";
import { assemble, decimate, weldNormals } from "./trash-geo";
import {
  type ModelSpec,
  type PoseSpec,
  disposeTrashTextures,
} from "./trash-materials";
import { buildModelA } from "./trash-models";
import { buildModelB } from "./trash-models2";
import { SECTORS, TRASH_TYPES } from "./types";
import type { QualityId, TrashTypeDef } from "./types";
import { shoreZ, terrainHeight } from "./world";

export interface BuiltType {
  def: TrashTypeDef;
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  /** Rest height of the origin above the ground in the display pose (pose 0). */
  rest: number;
  poses: PoseSpec[];
  sink: number;
  showYaw: number;
  hullMode: "front" | "back";
  castShadow: boolean;
  triangles: number;
  /** Coarse far variant (same dimensions, one material). */
  lod: THREE.BufferGeometry;
  lodMaterial: THREE.Material;
  lodTriangles: number;
  /** Bounding radius of one instance in metres (for the frustum test). */
  radius: number;
}

/** Distances and LOD coarseness per quality tier. */
interface TrashTier {
  /** Full geometry up to here (m). */
  near: number;
  /** Beyond this nothing is drawn at all (m). */
  cull: number;
  /** Cells per axis for the decimation (smaller = coarser). */
  cells: number;
}

const TIERS: Record<QualityId, TrashTier> = {
  ultra: { near: 34, cull: 260, cells: 6 },
  high: { near: 28, cull: 190, cells: 5 },
  medium: { near: 20, cull: 130, cells: 4 },
  low: { near: 14, cull: 90, cells: 3 },
};

/** Margin on the instance radius in the frustum test (shadows off screen). */
const CULL_MARGIN = 3;

function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function fallbackSpec(): ModelSpec {
  return {
    parts: [{ geo: new THREE.BoxGeometry(0.15, 0.15, 0.15), mat: 0 }],
    materials: [new THREE.MeshStandardMaterial({ color: 0x999999 })],
    poses: [{ w: 1, quat: () => new THREE.Quaternion() }],
    sink: 0.01,
  };
}

/** Material group with the largest area – it carries the far LOD. */
function dominantMaterial(geo: THREE.BufferGeometry, count: number): number {
  if (count <= 1) return 0;
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const a = pos.array as ArrayLike<number>;
  const area = new Float64Array(count);
  const groups =
    geo.groups.length > 0
      ? geo.groups
      : [{ start: 0, count: pos.count, materialIndex: 0 }];
  for (const g of groups) {
    const mi = g.materialIndex ?? 0;
    const end = g.start + g.count;
    let s = 0;
    for (let i = g.start; i + 2 < end; i += 3) {
      const o = i * 3;
      const ux = a[o + 3] - a[o];
      const uy = a[o + 4] - a[o + 1];
      const uz = a[o + 5] - a[o + 2];
      const vx = a[o + 6] - a[o];
      const vy = a[o + 7] - a[o + 1];
      const vz = a[o + 8] - a[o + 2];
      const cx = uy * vz - uz * vy;
      const cy = uz * vx - ux * vz;
      const cz = ux * vy - uy * vx;
      s += Math.sqrt(cx * cx + cy * cy + cz * cz);
    }
    area[mi] += s;
  }
  let best = 0;
  for (let i = 1; i < count; i++) if (area[i] > area[best]) best = i;
  return best;
}

function buildType(def: TrashTypeDef, cells: number): BuiltType {
  const rng = mulberry32(hashId(def.id));
  const spec = buildModelA(def, rng) ?? buildModelB(def, rng) ?? fallbackSpec();
  const geometry = assemble(spec.parts, spec.materials.length);
  // Origin into the centre of the bounding box (ghosts spin around the centre)
  geometry.computeBoundingBox();
  const c = new THREE.Vector3();
  geometry.boundingBox?.getCenter(c);
  geometry.translate(-c.x, -c.y, -c.z);
  // Careful: computeBoundingBox() writes into the SAME Box3 – only read after
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const bb = geometry.boundingBox;
  const rest = bb ? -bb.min.y : 0.05;
  for (const m of spec.materials) m.needsUpdate = true;
  const lod = decimate(geometry, cells);
  return {
    def,
    geometry,
    material: spec.materials.length === 1 ? spec.materials[0] : spec.materials,
    rest,
    poses: spec.poses,
    sink: spec.sink,
    showYaw: spec.showYaw ?? 0,
    hullMode: spec.hull ?? "front",
    castShadow: spec.castShadow !== false,
    triangles: geometry.getAttribute("position").count / 3,
    lod,
    lodMaterial:
      spec.materials[dominantMaterial(geometry, spec.materials.length)],
    lodTriangles: lod.getAttribute("position").count / 3,
    radius: geometry.boundingSphere?.radius ?? 0.4,
  };
}

/** Rest height for a pose: support function of the geometry along −up. */
function restFor(
  geo: THREE.BufferGeometry,
  q: THREE.Quaternion,
  tmp: THREE.Vector3,
  tmpQ: THREE.Quaternion,
): number {
  tmp.set(0, 1, 0).applyQuaternion(tmpQ.copy(q).invert());
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const a = pos.array as Float32Array;
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < a.length; i += 3) {
    const d = a[i] * tmp.x + a[i + 1] * tmp.y + a[i + 2] * tmp.z;
    if (d < min) min = d;
  }
  return -min;
}

// ---------------------------------------------------------------------------

interface InstanceRecord {
  x: number;
  z: number;
  sector: string;
}

export interface PickResult {
  typeIdx: number;
  instanceId: number;
  distance: number;
  /** Hit point – only valid until the next raycastPick() (shared buffer). */
  point: THREE.Vector3;
  def: TrashTypeDef;
}

const SECTOR_DIRT = [1.25, 0.9, 1.45, 0.85, 1.15, 0.7];
const DENSITY = 1.55; // scales the total amount (~950 objects)
const OUTLINE_WIDTH = 0.012; // outline width in metres (world units)

// Search grid for findNearest (covers WORLD_BOUNDS)
const CELL = 20;
const GX0 = -400;
const GZ0 = -140;
const GNX = 40;
const GNZ = 28;

const HULL_VERTEX_PATCH = (
  shader: THREE.WebGLProgramParametersWithUniforms,
  off: { value: number },
) => {
  shader.uniforms.uOff = off;
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nuniform float uOff;")
    .replace(
      "#include <begin_vertex>",
      [
        "vec3 radial = normalize(vec3(position.x, 0.0, position.z) + vec3(1e-5, 0.0, 1e-5));",
        "vec3 transformed = position + normalize(normal) * uOff + radial * uOff * 0.7;",
      ].join("\n"),
    );
};

/**
 * Invisible clock: three calls update(camera) for isLOD objects inside
 * projectObject – before the shadow pass and frustum culling. Costs neither a
 * draw call nor a triangle.
 */
class LodTicker extends THREE.Object3D {
  readonly isLOD = true;
  readonly autoUpdate = true;
  constructor(private readonly fn: (cam: THREE.Camera) => void) {
    super();
    this.frustumCulled = false;
    this.matrixAutoUpdate = false;
  }
  update(camera: THREE.Camera): void {
    this.fn(camera);
  }
}

export class TrashField {
  readonly group = new THREE.Group();
  readonly types: BuiltType[] = [];
  /** Full geometry, near range – the target for raycasts. */
  private nearMeshes: THREE.InstancedMesh[] = [];
  /** Decimated LOD, far range. */
  private farMeshes: THREE.InstancedMesh[] = [];
  /** Master matrices per type (16 floats per instance). */
  private master: Float32Array[] = [];
  private counts: number[] = [];
  /** Near slot → master index (for picking). */
  private nearMap: Int32Array[] = [];
  private records: InstanceRecord[][] = [];
  private hulls: (THREE.BufferGeometry | undefined)[] = [];
  private hullMesh: THREE.Mesh | null = null;
  private hullFront: THREE.MeshBasicMaterial;
  private hullBack: THREE.MeshBasicMaterial;
  private hullOff = { value: OUTLINE_WIDTH };
  private highlighted: { ti: number; id: number } | null = null;
  private lineup: THREE.Mesh[] = [];
  private ticker: LodTicker;
  private readonly quality: QualityId;
  /** Copy of the tier defaults (dev mode may change them). */
  private readonly tier: TrashTier;
  private tmpMat = new THREE.Matrix4();
  private tmpV = new THREE.Vector3();
  private tmpV2 = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  private tmpQ2 = new THREE.Quaternion();
  private tmpQ3 = new THREE.Quaternion();
  private tmpEuler = new THREE.Euler();
  private tmpScale = new THREE.Vector3();
  private tmpPos = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  private frustum = new THREE.Frustum();
  private projM = new THREE.Matrix4();
  private sphere = new THREE.Sphere();
  private pickPoint = new THREE.Vector3();
  private hits: THREE.Intersection[] = [];
  /** Camera state of the last LOD update (multiple passes per frame). */
  private camState = new Float64Array(6).fill(Number.NaN);
  private dirty = true;
  private cells: number[][] = [];
  private gridDirty = true;

  constructor(
    scene: THREE.Scene,
    seed: number,
    savedRemaining: Record<string, number> | null,
    quality?: QualityId,
  ) {
    scene.add(this.group);
    this.quality = quality ?? useGame.getState().settings.quality;
    this.tier = { ...TIERS[this.quality] };
    // The clock as first child: its update runs before three projects the
    // trash meshes – counters and buffers are up to date by then.
    this.ticker = new LodTicker((cam) => this.refresh(cam));
    this.group.add(this.ticker);

    const rng = mulberry32(seed);
    for (const def of TRASH_TYPES)
      this.types.push(buildType(def, this.tier.cells));

    // Outline materials: "front" (opaque, DoubleSide, drawn before the trash
    // meshes – the instance covers the inside) and "back" (transparent closed
    // bodies: back faces only, drawn after the glass).
    this.hullFront = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    this.hullFront.onBeforeCompile = (s) => HULL_VERTEX_PATCH(s, this.hullOff);
    this.hullBack = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.BackSide,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    this.hullBack.onBeforeCompile = (s) => HULL_VERTEX_PATCH(s, this.hullOff);

    // Determine target counts per sector|type (deterministic from the seed)
    const targets: number[][] = [];
    for (let ti = 0; ti < this.types.length; ti++) {
      targets.push([]);
      for (let si = 0; si < SECTORS.length; si++) {
        const base = this.types[ti].def.spawnWeight * SECTOR_DIRT[si] * DENSITY;
        const n = Math.max(0, Math.round(base * (0.7 + rng() * 0.6)));
        targets[ti].push(n);
      }
    }

    for (let ti = 0; ti < this.types.length; ti++) {
      const t = this.types[ti];
      const total = targets[ti].reduce((a, b) => a + b, 0);
      const capacity = total + 160;
      this.master.push(new Float32Array(capacity * 16));
      this.nearMap.push(new Int32Array(capacity));
      this.counts.push(0);
      this.records.push([]);
      const near = new THREE.InstancedMesh(t.geometry, t.material, capacity);
      const far = new THREE.InstancedMesh(t.lod, t.lodMaterial, capacity);
      for (const m of [near, far]) {
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        m.frustumCulled = false; // own visibility test per instance
        m.receiveShadow = true;
        m.count = 0;
        m.renderOrder = 2; // after the outline (renderOrder 1)
        m.userData.typeIdx = ti;
        this.group.add(m);
      }
      near.castShadow = t.castShadow;
      far.castShadow = false; // distant shadows are only a few texels wide
      this.nearMeshes.push(near);
      this.farMeshes.push(far);
      for (let si = 0; si < SECTORS.length; si++) {
        let want = targets[ti][si];
        const key = `${SECTORS[si].id}|${t.def.id}`;
        if (savedRemaining && savedRemaining[key] != null) {
          want = Math.min(want, savedRemaining[key]);
        }
        for (let k = 0; k < want; k++) this.spawnOne(ti, si, rng);
      }
    }
    // Initial state: everything in the near mesh, so that the first frame and
    // a pick before the first render are correct. refresh() fixes it at once.
    for (let ti = 0; ti < this.types.length; ti++) {
      const n = this.counts[ti];
      const near = this.nearMeshes[ti];
      (near.instanceMatrix.array as Float32Array).set(
        this.master[ti].subarray(0, n * 16),
      );
      for (let i = 0; i < n; i++) this.nearMap[ti][i] = i;
      near.count = n;
      near.instanceMatrix.needsUpdate = true;
    }
  }

  /** Terrain normal via finite differences. */
  private terrainNormal(
    x: number,
    z: number,
    out: THREE.Vector3,
  ): THREE.Vector3 {
    const e = 0.35;
    const dx = terrainHeight(x - e, z) - terrainHeight(x + e, z);
    const dz = terrainHeight(x, z - e) - terrainHeight(x, z + e);
    return out.set(dx, 2 * e, dz).normalize();
  }

  /** Build the instance matrix for type `ti` at (x, z): pose, yaw, tilt, terrain alignment. */
  private placeMatrix(
    ti: number,
    x: number,
    z: number,
    rng: () => number,
    out: THREE.Matrix4,
  ): void {
    const t = this.types[ti];
    // Choose a pose
    let sum = 0;
    for (const p of t.poses) sum += p.w;
    let r = rng() * sum;
    let pose = t.poses[0];
    for (const p of t.poses) {
      r -= p.w;
      if (r <= 0) {
        pose = p;
        break;
      }
    }
    const qPose = pose.quat(rng);
    const rest = restFor(t.geometry, qPose, this.tmpV2, this.tmpQ3);
    const s = 0.85 + rng() * 0.4;
    const yaw = rng() * Math.PI * 2;
    const tilt = 0.05;
    const qYaw = this.tmpQ.setFromEuler(
      this.tmpEuler.set((rng() - 0.5) * tilt, yaw, (rng() - 0.5) * tilt),
    );
    const n = this.terrainNormal(x, z, this.tmpV);
    const qAlign = this.tmpQ2.setFromUnitVectors(this.up, n);
    const q = qAlign.multiply(qYaw).multiply(qPose);
    // Built surfaces count (station apron, the tip's refuse skin, pier deck):
    // an item placed at the analytic terrain would vanish inside them.
    const h = groundHeight(x, z);
    const lift = rest * s - t.sink * rng();
    const pos = this.tmpPos.set(x, h, z).addScaledVector(n, lift);
    out.compose(pos, q, this.tmpScale.set(s, s, s));
  }

  /** Add an instance to the master list. */
  private addInstance(
    ti: number,
    x: number,
    z: number,
    sector: string,
    rng: () => number,
  ): boolean {
    const m = this.master[ti];
    const c = this.counts[ti];
    if (c >= m.length / 16) return false;
    this.placeMatrix(ti, x, z, rng, this.tmpMat);
    m.set(this.tmpMat.elements, c * 16);
    this.records[ti].push({ x, z, sector });
    this.counts[ti] = c + 1;
    this.dirty = true;
    this.gridDirty = true;
    return true;
  }

  private spawnOne(ti: number, si: number, rng: () => number): boolean {
    const t = this.types[ti];
    const sector = SECTORS[si];
    // East Beach: a share of the metal, chemicals and general waste bleeds out
    // of the old tip's eroded flank instead of lying on the beach – the
    // landfill is where it all came from. Same counts per sector|type, so
    // saved `remaining` keys stay valid.
    if (
      sector.id === "s4" &&
      (t.def.category === "METAL" ||
        t.def.category === "CHEMICALS" ||
        t.def.category === "GENERAL") &&
      rng() < 0.3
    ) {
      const [px, pz] = tipPocketPoint(rng);
      return this.addInstance(ti, px, pz, sector.id, rng);
    }
    const x = sector.x0 + 4 + rng() * (sector.x1 - sector.x0 - 8);
    let d: number;
    if (t.def.nearWater) {
      d = -3 + rng() * 20;
    } else {
      d = 1 + rng() ** 1.6 * 74;
    }
    const z = shoreZ(x) + d;
    return this.addInstance(ti, x, z, sector.id, rng);
  }

  // ------------------------------------------------------------------ LOD --

  /**
   * Distribute the instances over the near/far mesh. Called by the clock once
   * per frame; the engine may call update(camera) instead.
   */
  private refresh(cam: THREE.Camera): void {
    const e = cam.matrixWorld.elements;
    const c = this.camState;
    if (
      !this.dirty &&
      c[0] === e[12] &&
      c[1] === e[13] &&
      c[2] === e[14] &&
      c[3] === e[8] &&
      c[4] === e[9] &&
      c[5] === e[10]
    )
      return;
    c[0] = e[12];
    c[1] = e[13];
    c[2] = e[14];
    c[3] = e[8];
    c[4] = e[9];
    c[5] = e[10];
    this.dirty = false;
    const px = e[12];
    const py = e[13];
    const pz = e[14];
    this.projM.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projM);
    const near2 = this.tier.near * this.tier.near;
    const cull2 = this.tier.cull * this.tier.cull;
    for (let ti = 0; ti < this.types.length; ti++) {
      const m = this.master[ti];
      const cnt = this.counts[ti];
      const nearMesh = this.nearMeshes[ti];
      const farMesh = this.farMeshes[ti];
      const nb = nearMesh.instanceMatrix.array as Float32Array;
      const fb = farMesh.instanceMatrix.array as Float32Array;
      const map = this.nearMap[ti];
      this.sphere.radius = this.types[ti].radius * 1.25 + CULL_MARGIN;
      let nn = 0;
      let fn = 0;
      for (let i = 0; i < cnt; i++) {
        const o = i * 16;
        const dx = m[o + 12] - px;
        const dy = m[o + 13] - py;
        const dz = m[o + 14] - pz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > cull2) continue;
        this.sphere.center.set(m[o + 12], m[o + 13], m[o + 14]);
        if (!this.frustum.intersectsSphere(this.sphere)) continue;
        if (d2 < near2) {
          const k = nn * 16;
          for (let j = 0; j < 16; j++) nb[k + j] = m[o + j];
          map[nn] = i;
          nn++;
        } else {
          const k = fn * 16;
          for (let j = 0; j < 16; j++) fb[k + j] = m[o + j];
          fn++;
        }
      }
      nearMesh.count = nn;
      nearMesh.visible = nn > 0;
      farMesh.count = fn;
      farMesh.visible = fn > 0;
      if (nn > 0) {
        nearMesh.instanceMatrix.clearUpdateRanges();
        nearMesh.instanceMatrix.addUpdateRange(0, nn * 16);
        nearMesh.instanceMatrix.needsUpdate = true;
      }
      if (fn > 0) {
        farMesh.instanceMatrix.clearUpdateRanges();
        farMesh.instanceMatrix.addUpdateRange(0, fn * 16);
        farMesh.instanceMatrix.needsUpdate = true;
      }
    }
  }

  /**
   * Optional: update the LOD explicitly (otherwise the clock does it while the
   * render list is built).
   */
  update(camera: THREE.Camera): void {
    this.refresh(camera);
  }

  // --------------------------------------------------------------- Access --

  initialCountsByKey(): Record<string, number> {
    const out: Record<string, number> = {};
    for (let ti = 0; ti < this.types.length; ti++) {
      for (const r of this.records[ti]) {
        const key = `${r.sector}|${this.types[ti].def.id}`;
        out[key] = (out[key] ?? 0) + 1;
      }
    }
    return out;
  }

  raycastPick(raycaster: THREE.Raycaster, maxDist: number): PickResult | null {
    const prevFar = raycaster.far;
    raycaster.far = maxDist + 0.5;
    this.hits.length = 0;
    raycaster.intersectObjects(this.nearMeshes, false, this.hits);
    raycaster.far = prevFar;
    for (const h of this.hits) {
      if (h.distance > maxDist) break;
      if (h.instanceId == null) continue;
      const ti = (h.object as THREE.InstancedMesh).userData.typeIdx as number;
      const id = this.nearMap[ti][h.instanceId];
      if (id >= this.counts[ti]) continue;
      return {
        typeIdx: ti,
        instanceId: id,
        distance: h.distance,
        point: this.pickPoint.copy(h.point),
        def: this.types[ti].def,
      };
    }
    return null;
  }

  /** Smoothed outline geometry per type (normals welded by equal positions). */
  private hullGeometry(ti: number): THREE.BufferGeometry {
    let g = this.hulls[ti];
    if (!g) {
      g = this.types[ti].geometry.clone();
      g.clearGroups();
      weldNormals(g);
      this.hulls[ti] = g;
    }
    return g;
  }

  setHighlight(pick: PickResult | null): void {
    if (!pick) {
      if (this.hullMesh) this.hullMesh.visible = false;
      this.highlighted = null;
      return;
    }
    if (!this.hullMesh) {
      this.hullMesh = new THREE.Mesh(
        this.hullGeometry(pick.typeIdx),
        this.hullFront,
      );
      this.hullMesh.frustumCulled = false;
      this.group.add(this.hullMesh);
    }
    const hm = this.hullMesh;
    const t = this.types[pick.typeIdx];
    if (!this.highlighted || this.highlighted.ti !== pick.typeIdx) {
      hm.geometry = this.hullGeometry(pick.typeIdx);
      hm.material = t.hullMode === "back" ? this.hullBack : this.hullFront;
      hm.renderOrder = t.hullMode === "back" ? 3 : 1;
    }
    this.tmpMat.fromArray(this.master[pick.typeIdx], pick.instanceId * 16);
    this.tmpMat.decompose(hm.position, hm.quaternion, hm.scale);
    // constant world width regardless of the instance scale
    this.hullOff.value = OUTLINE_WIDTH / Math.max(0.2, hm.scale.x);
    hm.visible = true;
    this.highlighted = { ti: pick.typeIdx, id: pick.instanceId };
  }

  getInstanceWorld(ti: number, instanceId: number): THREE.Vector3 {
    const m = this.master[ti];
    const o = instanceId * 16;
    return new THREE.Vector3(m[o + 12], m[o + 13], m[o + 14]);
  }

  /** Remove an instance (swap with the last) and return its type/sector. */
  remove(
    ti: number,
    instanceId: number,
  ): { typeId: string; key: string; pos: THREE.Vector3 } | null {
    const recs = this.records[ti];
    const last = this.counts[ti] - 1;
    if (instanceId < 0 || instanceId > last) return null;
    const pos = this.getInstanceWorld(ti, instanceId);
    const rec = recs[instanceId];
    if (instanceId !== last) {
      const m = this.master[ti];
      m.copyWithin(instanceId * 16, last * 16, last * 16 + 16);
      recs[instanceId] = recs[last];
    }
    recs.pop();
    this.counts[ti] = last;
    // Fix up the near mapping right away so a pick in the same frame is correct
    // (refresh() rewrites the matrices themselves before the next draw).
    const map = this.nearMap[ti];
    const near = this.nearMeshes[ti];
    let nc = near.count;
    for (let k = 0; k < nc; k++) {
      if (map[k] === instanceId) {
        nc--;
        map[k] = map[nc];
        k--;
      } else if (map[k] === last) {
        map[k] = instanceId;
      }
    }
    near.count = nc;
    this.dirty = true;
    this.gridDirty = true;
    this.setHighlight(null);
    return {
      typeId: this.types[ti].def.id,
      key: `${rec.sector}|${this.types[ti].def.id}`,
      pos,
    };
  }

  /** Rebuild the search grid (after a pick-up or a wash-up). */
  private buildGrid(): void {
    if (this.cells.length === 0) {
      for (let i = 0; i < GNX * GNZ; i++) this.cells.push([]);
    } else {
      for (const c of this.cells) c.length = 0;
    }
    for (let ti = 0; ti < this.records.length; ti++) {
      const recs = this.records[ti];
      for (let i = 0; i < recs.length; i++) {
        const ix = Math.max(
          0,
          Math.min(GNX - 1, Math.floor((recs[i].x - GX0) / CELL)),
        );
        const iz = Math.max(
          0,
          Math.min(GNZ - 1, Math.floor((recs[i].z - GZ0) / CELL)),
        );
        this.cells[iz * GNX + ix].push(ti * 4096 + i);
      }
    }
    this.gridDirty = false;
  }

  /**
   * For the dog/drone: the nearest active instance to a point. Searches ring by
   * ring in the 20 m grid and stops as soon as no closer hit is possible.
   */
  findNearest(
    from: THREE.Vector3,
    maxDist: number,
  ): { typeIdx: number; instanceId: number; pos: THREE.Vector3 } | null {
    if (this.gridDirty) this.buildGrid();
    const cx = Math.max(
      0,
      Math.min(GNX - 1, Math.floor((from.x - GX0) / CELL)),
    );
    const cz = Math.max(
      0,
      Math.min(GNZ - 1, Math.floor((from.z - GZ0) / CELL)),
    );
    let bestD = maxDist * maxDist;
    let bTi = -1;
    let bI = -1;
    const maxR = Math.ceil(maxDist / CELL) + 1;
    for (let r = 0; r <= maxR; r++) {
      for (let iz = cz - r; iz <= cz + r; iz++) {
        if (iz < 0 || iz >= GNZ) continue;
        const edgeRow = iz === cz - r || iz === cz + r;
        for (let ix = cx - r; ix <= cx + r; ix++) {
          if (ix < 0 || ix >= GNX) continue;
          if (!edgeRow && ix !== cx - r && ix !== cx + r) continue;
          const list = this.cells[iz * GNX + ix];
          for (let k = 0; k < list.length; k++) {
            const packed = list[k];
            const ti = packed >> 12;
            const i = packed & 4095;
            const rec = this.records[ti][i];
            const dx = rec.x - from.x;
            const dz = rec.z - from.z;
            const d2 = dx * dx + dz * dz;
            if (d2 < bestD) {
              bestD = d2;
              bTi = ti;
              bI = i;
            }
          }
        }
      }
      if (bTi >= 0 && bestD <= (r * CELL) ** 2) break;
    }
    if (bTi < 0) return null;
    return {
      typeIdx: bTi,
      instanceId: bI,
      pos: this.getInstanceWorld(bTi, bI),
    };
  }

  totalRemaining(): number {
    let n = 0;
    for (const c of this.counts) n += c;
    return n;
  }

  /** The tide washes new objects ashore. Returns the keys of the new objects. */
  washUp(n: number): string[] {
    const keys: string[] = [];
    const rng = mulberry32(Math.floor(Math.random() * 1e9));
    for (let k = 0; k < n; k++) {
      const ti = Math.floor(rng() * this.types.length);
      const si = Math.floor(rng() * SECTORS.length);
      const t = this.types[ti];
      const sector = SECTORS[si];
      const x = sector.x0 + 4 + rng() * (sector.x1 - sector.x0 - 8);
      const z = shoreZ(x) + (-2 + rng() * 10);
      if (!this.addInstance(ti, x, z, sector.id, rng)) continue;
      keys.push(`${sector.id}|${t.def.id}`);
    }
    return keys;
  }

  makeGhost(ti: number): THREE.Mesh {
    const t = this.types[ti];
    const m = new THREE.Mesh(t.geometry, t.material);
    m.castShadow = false;
    return m;
  }

  /**
   * Dev only: places one non-instanced display piece per type in a row along
   * +x (spacing 0.9 m, on the terrain). Does not touch any instances.
   */
  debugLineup(x: number, z: number): void {
    for (const m of this.lineup) this.group.remove(m);
    this.lineup = [];
    for (let ti = 0; ti < this.types.length; ti++) {
      const t = this.types[ti];
      const px = x + ti * 0.9;
      const m = new THREE.Mesh(t.geometry, t.material);
      m.position.set(px, terrainHeight(px, z) + t.rest + 0.002, z);
      m.rotation.y = t.showYaw;
      m.castShadow = t.castShadow;
      m.receiveShadow = true;
      m.renderOrder = 2;
      this.group.add(m);
      this.lineup.push(m);
    }
  }

  /** Dev only: force the far LOD instead of full geometry (comparison shots). */
  debugLodOnly(on: boolean): void {
    this.tier.near = on ? 0 : TIERS[this.quality].near;
    this.dirty = true;
  }

  /** Dev only: metrics of the LOD system. */
  debugLodStats(): {
    quality: QualityId;
    near: number;
    cull: number;
    instances: number;
    drawnNear: number;
    drawnFar: number;
    fullTris: number;
    lodTris: number;
  } {
    let dn = 0;
    let df = 0;
    let fullTris = 0;
    let lodTris = 0;
    for (let ti = 0; ti < this.types.length; ti++) {
      dn += this.nearMeshes[ti].count;
      df += this.farMeshes[ti].count;
      fullTris += this.nearMeshes[ti].count * this.types[ti].triangles;
      lodTris += this.farMeshes[ti].count * this.types[ti].lodTriangles;
    }
    return {
      quality: this.quality,
      near: this.tier.near,
      cull: this.tier.cull,
      instances: this.totalRemaining(),
      drawnNear: dn,
      drawnFar: df,
      fullTris,
      lodTris,
    };
  }

  dispose(): void {
    for (const m of this.lineup) this.group.remove(m);
    this.lineup = [];
    if (this.hullMesh) this.group.remove(this.hullMesh);
    this.group.remove(this.ticker);
    for (const mesh of [...this.nearMeshes, ...this.farMeshes]) {
      this.group.remove(mesh);
      mesh.dispose();
    }
    for (const t of this.types) {
      t.geometry.dispose();
      t.lod.dispose();
      for (const m of Array.isArray(t.material) ? t.material : [t.material])
        m.dispose();
    }
    for (const h of this.hulls) h?.dispose();
    this.hullFront.dispose();
    this.hullBack.dispose();
    disposeTrashTextures();
    this.group.parent?.remove(this.group);
  }
}
