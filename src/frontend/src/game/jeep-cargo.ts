// Trash Simulator – load on the jeep's cargo bed: pooled instances of
// bottles, cans, boxes, lumps and sticks (category color as a tint) that fill
// the bed according to jeepCount/jeepCapacity, plus a lashing-strap net from
// half full onwards. refresh() only sets instance matrices – no rebuild.

import * as THREE from "three";
import { mulberry32 } from "./noise";
import {
  applyPbr,
  pbrCanLabel,
  pbrCardboard,
  pbrPlastic,
  pbrWood,
} from "./textures";
import { CATEGORIES, TRASH_BY_ID } from "./types";

type Kind = "bottle" | "can" | "box" | "lump" | "stick";
const KINDS: Kind[] = ["bottle", "can", "box", "lump", "stick"];
const MAX = 48;

interface Slot {
  x: number;
  y: number;
  z: number;
  yaw: number;
  tilt: number;
  rx: number;
  scale: number;
}

interface TypeLook {
  kind: Kind;
  /** natural color; is blended with the category color */
  natural?: string;
  sy?: number;
  sx?: number;
}

const LOOK: Record<string, TypeLook> = {
  glass_green: { kind: "bottle", natural: "#2f7a45" },
  glass_brown: { kind: "bottle", natural: "#6b3d1c" },
  plastic_bottle: { kind: "bottle", natural: "#dfe8ee" },
  spray_can: { kind: "can", natural: "#d8d8d8", sy: 1.3 },
  can: { kind: "can" },
  can_crushed: { kind: "can", sy: 0.45, sx: 1.25 },
  cardboard: { kind: "box" },
  canister: { kind: "box", natural: "#d8b93c", sy: 1.4, sx: 0.8 },
  drum: { kind: "box", natural: "#3d5a8a", sy: 1.2 },
  newspaper: { kind: "box", natural: "#e2dccb", sy: 0.25, sx: 1.3 },
  coaster: { kind: "box", natural: "#e9e0c8", sy: 0.12, sx: 0.5 },
  sheet_metal: { kind: "box", natural: "#8a7a66", sy: 0.15, sx: 1.4 },
  flip_flop: { kind: "box", natural: "#e86aa0", sy: 0.15, sx: 0.6 },
  plastic_bag: { kind: "lump", natural: "#e9eef0" },
  crisp_packet: { kind: "lump", natural: "#c8302a", sy: 0.5 },
  paper_ball: { kind: "lump", natural: "#ece9e0" },
  old_bucket: { kind: "lump", natural: "#3a7bc0", sy: 1.3 },
  rubble: { kind: "lump", natural: "#9a948a" },
  cable: { kind: "lump", natural: "#2a2a2c", sy: 0.5 },
  fishing_line: { kind: "lump", natural: "#cfd6d8", sy: 0.4 },
  net: { kind: "lump", natural: "#4f8f7f", sy: 0.6, sx: 1.3 },
  plank: { kind: "stick", natural: "#a08560", sx: 2.2 },
  branch: { kind: "stick" },
  driftwood: { kind: "stick", natural: "#b8b0a0", sx: 1.6 },
  tool: { kind: "stick", natural: "#6c6f73", sx: 0.8 },
};

function bottleGeo(): THREE.BufferGeometry {
  const pts = [
    [0, 0],
    [0.03, 0],
    [0.034, 0.015],
    [0.034, 0.14],
    [0.028, 0.17],
    [0.014, 0.2],
    [0.014, 0.228],
    [0.017, 0.232],
    [0.017, 0.245],
    [0, 0.245],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const g = new THREE.LatheGeometry(pts, 14);
  g.translate(0, -0.12, 0);
  return g;
}

function lumpGeo(seed: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(0.1, 2);
  const rng = mulberry32(seed);
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const bumps: number[] = [];
  for (let k = 0; k < 6; k++)
    bumps.push(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1, 0.6 + rng() * 0.8);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    let d = 1;
    for (let k = 0; k < 6; k++) {
      const dot =
        v.x * bumps[k * 4] + v.y * bumps[k * 4 + 1] + v.z * bumps[k * 4 + 2];
      d += Math.max(0, dot) ** 3 * 0.35 * bumps[k * 4 + 3];
    }
    pos.setXYZ(i, v.x * 0.1 * d, v.y * 0.085 * d, v.z * 0.1 * d);
  }
  g.computeVertexNormals();
  return g;
}

export class JeepCargo {
  readonly group = new THREE.Group();
  private meshes: Record<Kind, THREE.InstancedMesh>;
  private net: THREE.Mesh;
  private slots: Slot[] = [];
  private own: (THREE.BufferGeometry | THREE.Material)[] = [];
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpE = new THREE.Euler();
  private tmpP = new THREE.Vector3();
  private tmpS = new THREE.Vector3();
  private tmpC = new THREE.Color();
  private tmpC2 = new THREE.Color();
  private lastKey = "";

  constructor(ropeMat: THREE.Material) {
    const rng = mulberry32(0x4a3e);
    // Slots: four layers, wide at the bottom, narrow at the top (heap shape)
    const layers: [number, number, number, number, number][] = [
      // n, y, halfX, z0, z1
      [16, 0.36, 0.5, 0.68, 1.62],
      [14, 0.5, 0.5, 0.68, 1.62],
      [10, 0.63, 0.42, 0.75, 1.55],
      [8, 0.75, 0.3, 0.82, 1.48],
    ];
    for (const [n, y, hx, z0, z1] of layers) {
      for (let k = 0; k < n; k++) {
        this.slots.push({
          x: (rng() * 2 - 1) * hx,
          y: y + rng() * 0.04,
          z: z0 + rng() * (z1 - z0),
          yaw: rng() * Math.PI * 2,
          tilt: (rng() - 0.5) * 0.5,
          rx: rng() * Math.PI * 2,
          scale: 0.85 + rng() * 0.35,
        });
      }
    }
    // Materials per kind
    const bottle = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.14,
      metalness: 0,
      clearcoat: 0.7,
      clearcoatRoughness: 0.08,
    });
    const can = new THREE.MeshStandardMaterial({ color: 0xffffff });
    applyPbr(can, pbrCanLabel("cola"));
    const cardboard = new THREE.MeshStandardMaterial({ color: 0xffffff });
    applyPbr(cardboard, pbrCardboard());
    const plastic = new THREE.MeshStandardMaterial({ color: 0xffffff });
    applyPbr(plastic, pbrPlastic("#d6d4cc", { wear: 0.7 }));
    const wood = new THREE.MeshStandardMaterial({ color: 0xffffff });
    applyPbr(wood, pbrWood("branch"));
    const geos: Record<Kind, THREE.BufferGeometry> = {
      bottle: bottleGeo(),
      can: new THREE.CylinderGeometry(0.033, 0.033, 0.115, 14),
      box: new THREE.BoxGeometry(0.22, 0.14, 0.16),
      lump: lumpGeo(77),
      stick: new THREE.CylinderGeometry(0.018, 0.024, 0.42, 7),
    };
    const matOf: Record<Kind, THREE.Material> = {
      bottle,
      can,
      box: cardboard,
      lump: plastic,
      stick: wood,
    };
    this.own.push(bottle, can, cardboard, plastic, wood);
    this.meshes = {} as Record<Kind, THREE.InstancedMesh>;
    for (const k of KINDS) {
      const m = new THREE.InstancedMesh(geos[k], matOf[k], MAX);
      m.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(MAX * 3),
        3,
      );
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.visible = false;
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      this.meshes[k] = m;
      this.own.push(geos[k]);
      this.group.add(m);
    }
    this.net = this.buildNet(ropeMat);
    this.net.visible = false;
    this.group.add(this.net);
  }

  /** Lashing straps over the load (tubes along arcs, rope texture along u). */
  private buildNet(ropeMat: THREE.Material): THREE.Mesh {
    const parts: THREE.BufferGeometry[] = [];
    const strap = (pts: [number, number, number][]) => {
      const curve = new THREE.CatmullRomCurve3(
        pts.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
        false,
        "catmullrom",
        0.4,
      );
      const g = new THREE.TubeGeometry(curve, 28, 0.011, 6, false);
      const len = curve.getLength();
      const uv = g.getAttribute("uv") as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setX(i, (uv.getX(i) * len) / 0.08);
      parts.push(g.toNonIndexed());
      g.dispose();
    };
    for (const z of [0.85, 1.15, 1.45]) {
      strap([
        [-0.8, 0.9, z],
        [-0.45, 1.06, z],
        [0, 1.13, z],
        [0.45, 1.06, z],
        [0.8, 0.9, z],
      ]);
    }
    for (const x of [-0.3, 0.3]) {
      strap([
        [x, 0.92, 0.58],
        [x, 1.08, 0.85],
        [x, 1.12, 1.15],
        [x, 1.08, 1.45],
        [x, 0.92, 1.72],
      ]);
    }
    // Knots at the crossings
    for (const z of [0.85, 1.15, 1.45]) {
      for (const x of [-0.3, 0.3]) {
        const k = new THREE.SphereGeometry(0.02, 8, 6);
        k.translate(x, 1.09 + (z === 1.15 ? 0.03 : 0), z);
        parts.push(k.toNonIndexed());
        k.dispose();
      }
    }
    const merged = mergeParts(parts);
    const mesh = new THREE.Mesh(merged, ropeMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.own.push(merged);
    return mesh;
  }

  /** Redistribute the load (only when the contents change). */
  refresh(load: Record<string, number>, capacity: number): void {
    let total = 0;
    const entries: string[] = [];
    for (const typeId of Object.keys(load)) {
      const n = load[typeId];
      total += n;
      for (let i = 0; i < n; i++) entries.push(typeId);
    }
    const key = `${total}|${capacity}|${entries.length > 0 ? entries[0] : ""}|${Object.keys(load).join(",")}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const cap = Math.max(1, capacity);
    const fill = Math.min(1, total / cap);
    const show =
      total === 0 ? 0 : Math.min(MAX, Math.max(1, Math.ceil(fill * MAX)));
    const counts: Record<Kind, number> = {
      bottle: 0,
      can: 0,
      box: 0,
      lump: 0,
      stick: 0,
    };
    for (let i = 0; i < show; i++) {
      const typeId =
        entries[Math.floor((i / show) * entries.length)] ?? entries[0];
      const def = TRASH_BY_ID[typeId];
      const look = LOOK[typeId] ?? { kind: "lump" as Kind };
      const catColor = def ? CATEGORIES[def.category].color : "#9a9a9a";
      const slot = this.slots[i];
      const mesh = this.meshes[look.kind];
      const idx = counts[look.kind]++;
      // Attitude: bottles/cans/sticks lie down, boxes stand slightly askew
      if (look.kind === "box")
        this.tmpE.set(slot.tilt * 0.4, slot.yaw, slot.tilt * 0.3, "YXZ");
      else if (look.kind === "lump") this.tmpE.set(slot.rx, slot.yaw, 0, "YXZ");
      else this.tmpE.set(Math.PI / 2 + slot.tilt * 0.3, slot.yaw, 0, "YXZ");
      this.tmpQ.setFromEuler(this.tmpE);
      const s = slot.scale;
      this.tmpS.set(s * (look.sx ?? 1), s * (look.sy ?? 1), s);
      this.tmpP.set(slot.x, slot.y, slot.z);
      this.tmpM.compose(this.tmpP, this.tmpQ, this.tmpS);
      mesh.setMatrixAt(idx, this.tmpM);
      // Tint: category color, blended with the natural color
      this.tmpC.set(catColor);
      if (look.natural) {
        this.tmpC2.set(look.natural);
        this.tmpC.lerp(this.tmpC2, 0.55);
      } else if (look.kind === "can" || look.kind === "box") {
        this.tmpC2.set(0xffffff);
        this.tmpC.lerp(this.tmpC2, 0.7);
      }
      mesh.setColorAt(idx, this.tmpC);
    }
    for (const k of KINDS) {
      const m = this.meshes[k];
      m.count = counts[k];
      m.visible = counts[k] > 0;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    this.net.visible = fill > 0.45;
    this.net.scale.y = 0.55 + 0.45 * fill;
    this.net.position.y = (1 - this.net.scale.y) * 0.34;
  }

  dispose(): void {
    this.group.parent?.remove(this.group);
    for (const o of this.own) o.dispose();
  }
}

function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let n = 0;
  for (const p of parts) n += p.getAttribute("position").count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  let o = 0;
  for (const p of parts) {
    const c = p.getAttribute("position").count;
    pos.set(p.getAttribute("position").array as Float32Array, o * 3);
    nor.set(p.getAttribute("normal").array as Float32Array, o * 3);
    uv.set(p.getAttribute("uv").array as Float32Array, o * 2);
    o += c;
    p.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.computeBoundingSphere();
  return g;
}
