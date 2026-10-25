// Rare collectibles in the world: deterministic, very sparse spawns of the
// catalog variants (collectibles-data.ts) the player does not own yet, a
// crosshair pick like the trash field, and removal on pick-up. The store side
// (ownership, display case) lives in state.ts; engine.ts wires the interaction.
//
// Spawn rules: at most 3 pieces exist at once, a fresh world starts with
// exactly 2, and after a pick-up the next piece appears only after 6–12
// minutes of running play time. Active spawns are persisted in the save
// (store `collectSpawns`), so a reload restores every uncollected piece
// exactly where it lay; new choices (variant, position, pose) come from a
// stream seeded with the world seed plus the number of owned pieces. A
// variant the player owns never spawns again – checked when spawning AND
// again in collect().

import * as THREE from "three";
import { COLLECTIBLES } from "./collectibles-data";
import {
  buildCollectibleGhost,
  buildCollectibleModel,
  disposeCollectibleGhosts,
  disposeCollectibleModel,
} from "./collectibles-models";
import { campSite } from "./landmark-camp";
import { mulberry32 } from "./noise";
import { useGame } from "./state";
import { WORLD_BOUNDS, shoreZ, terrainHeight } from "./terrain";

export interface CollectiblePick {
  /** Active spawn slot – passed back to collect(). */
  slot: number;
  /** Catalog id of the variant (collectibles-data.ts). */
  id: string;
  /** Display name for the HUD prompt. */
  name: string;
  /** Hit point for the grab animation (cloned by the caller). */
  point: THREE.Vector3;
}

const MAX_ACTIVE = 3;
const INITIAL_SPAWNS = 2;
const REFILL_MIN_S = 360; // 6 min
const REFILL_MAX_S = 720; // 12 min
/** Retry delay when no valid placement was found (should not happen). */
const RETRY_S = 30;
const GLINT_RANGE = 25;
const MIN_SEPARATION = 60;
const MARGIN = 20;
const OUTLINE_WIDTH = 0.008;

/** How deep each kind sits in the sand (fraction of its height). */
const SINK: Record<string, number> = {
  fossil: 0.4,
  coin: 0.4,
  bottle: 0.3,
  jewellery: 0.15,
};

/**
 * Landmark keep-out circles: station forecourt, wreck, camp, container. The
 * camp entry uses the clearing the camp actually chose (campSite), which can
 * lie ~25 m from its search anchor.
 */
const EXCLUSIONS: Array<[number, number, number]> = [
  [96, 118, 40],
  [-190, -46, 12],
  [campSite().x, campSite().z, 20],
  [205, 2, 15],
  // Built places: pier abutment, cable house, fallen pillbox (at the scarp
  // foot, place-bitten-edge.ts), lighthouse knoll crown
  [-150, -52, 10],
  [128, 16, 8],
  [162, 23.4, 10],
  [330, 150, 14],
];

/** Driving corridor beach → station (terrain.ts flatZone), z 20..300. */
function inCorridor(x: number, z: number): boolean {
  if (z < 20 || z > 300) return false;
  const cx = 86 + Math.sin((z - 60) * 0.012) * 10;
  return Math.abs(x - cx) < 40;
}

/** Same vertex inflation as the trash outline (trash.ts). */
function hullPatch(
  shader: THREE.WebGLProgramParametersWithUniforms,
  off: { value: number },
): void {
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
}

interface SpawnInst {
  id: string;
  name: string;
  kind: string;
  yaw: number;
  group: THREE.Group;
  model: THREE.Group;
  glint: THREE.Sprite;
  glintMat: THREE.SpriteMaterial;
  proxy: THREE.Mesh;
  hull: THREE.Group | null;
  phase: number;
  /** Height of the visible part – glint anchor. */
  top: number;
}

export class Collectibles {
  protected readonly scene: THREE.Scene;
  protected readonly seed: number;
  protected readonly isOwned: (id: string) => boolean;

  private spawns: Array<SpawnInst | null> = [null, null, null];
  private refillTimer: number;
  private time = 0;
  private glintTex: THREE.Texture;
  private proxyGeo = new THREE.SphereGeometry(1, 10, 8);
  private proxyMat = new THREE.MeshBasicMaterial({ visible: false });
  private hullOff = { value: OUTLINE_WIDTH };
  private hullMat: THREE.MeshBasicMaterial;
  private highlighted = -1;
  private pickPoint = new THREE.Vector3();
  private hits: THREE.Intersection[] = [];
  private tmpBox = new THREE.Box3();

  constructor(
    scene: THREE.Scene,
    seed: number,
    isOwned: (id: string) => boolean,
  ) {
    this.scene = scene;
    this.seed = seed >>> 0;
    this.isOwned = isOwned;
    this.glintTex = makeGlintTexture();
    this.hullMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    this.hullMat.onBeforeCompile = (s) => hullPatch(s, this.hullOff);
    // Restore the uncollected pieces the save left lying in the world
    // (migrateSave already dropped owned/unknown/malformed entries). Only a
    // genuinely fresh profile gets the initial pair – a player who owns
    // pieces but restored none is either waiting for a refill or migrating
    // from a build without spawn persistence; the refill timer covers both.
    const saved = useGame.getState().collectSpawns;
    for (const id of Object.keys(saved)) {
      if (this.activeCount() >= MAX_ACTIVE) break;
      const def = COLLECTIBLES.find((c) => c.id === id);
      if (!def || this.isOwned(id) || this.isActive(id)) continue;
      const [x, z, yaw] = saved[id];
      this.place(def.id, def.name, def.kind, x, z, yaw);
    }
    if (this.activeCount() === 0 && this.countOwned() === 0) {
      this.spawnUpTo(INITIAL_SPAWNS);
    }
    this.syncStore();
    this.refillTimer = this.drawRefillDelay();
  }

  /** Mirror the live spawns into the store so the save can restore them. */
  private syncStore(): void {
    const rec: Record<string, [number, number, number]> = {};
    for (const s of this.spawns) {
      if (s) rec[s.id] = [s.group.position.x, s.group.position.z, s.yaw];
    }
    useGame.getState().setCollectSpawns(rec);
  }

  // ------------------------------------------------------------ spawning --

  private countOwned(): number {
    let n = 0;
    for (const c of COLLECTIBLES) if (this.isOwned(c.id)) n++;
    return n;
  }

  private activeCount(): number {
    let n = 0;
    for (const s of this.spawns) if (s) n++;
    return n;
  }

  private isActive(id: string): boolean {
    return this.spawns.some((s) => s?.id === id);
  }

  /** Everything below derives from seed + owned count → reload-stable. */
  private streamRng(): () => number {
    return mulberry32(
      ((this.seed ^ 0x5bd1e99) + this.countOwned() * 7919) >>> 0,
    );
  }

  private drawRefillDelay(): number {
    const r = mulberry32((this.seed * 13 + this.countOwned() * 101) >>> 0)();
    return REFILL_MIN_S + r * (REFILL_MAX_S - REFILL_MIN_S);
  }

  /** Spawn until `target` pieces are active (or no variant/spot is left). */
  private spawnUpTo(target: number): void {
    const rng = this.streamRng();
    // deterministic candidate order
    const order = [...COLLECTIBLES];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const def of order) {
      if (this.activeCount() >= target) break;
      if (this.isOwned(def.id) || this.isActive(def.id)) continue;
      for (let attempt = 0; attempt < 50; attempt++) {
        const pos = this.samplePos(def.kind, rng);
        if (!pos) continue;
        this.place(
          def.id,
          def.name,
          def.kind,
          pos.x,
          pos.z,
          rng() * Math.PI * 2,
        );
        break;
      }
    }
  }

  /** One placement attempt inside the kind's beach band; null if invalid. */
  private samplePos(
    kind: string,
    rng: () => number,
  ): { x: number; z: number } | null {
    let x: number;
    let d: number;
    if (kind === "fossil") {
      if (rng() < 0.6) {
        x = -358 + rng() * 716; // wet-sand band anywhere along the coast
        d = 2 + rng() * 8;
      } else {
        x = 240 + rng() * 118; // rocky east end
        d = 2 + rng() * 38;
      }
    } else if (kind === "coin") {
      x = -358 + rng() * 716; // dune field
      d = 80 + rng() * 180;
    } else if (kind === "bottle") {
      x = -358 + rng() * 716; // the wave line
      d = 3 + rng() * 5;
    } else {
      x = -358 + rng() * 716; // dry beach
      d = 15 + rng() * 35;
    }
    const z = shoreZ(x) + d;
    if (
      x < WORLD_BOUNDS.minX + MARGIN ||
      x > WORLD_BOUNDS.maxX - MARGIN ||
      z < WORLD_BOUNDS.minZ + MARGIN ||
      z > WORLD_BOUNDS.maxZ - MARGIN
    )
      return null;
    if (inCorridor(x, z)) return null;
    for (const [ex, ez, er] of EXCLUSIONS) {
      if (Math.hypot(x - ex, z - ez) < er) return null;
    }
    for (const s of this.spawns) {
      if (
        s &&
        Math.hypot(x - s.group.position.x, z - s.group.position.z) <
          MIN_SEPARATION
      )
        return null;
    }
    return { x, z };
  }

  private place(
    id: string,
    name: string,
    kind: string,
    x: number,
    z: number,
    yaw: number,
  ): number {
    const slot = this.spawns.indexOf(null);
    if (slot < 0) return -1;
    const model = buildCollectibleModel(id);
    model.rotation.y = yaw;
    if (kind === "bottle") {
      // bottles lie on their side in the wave wash
      model.rotation.z = Math.PI / 2 - 0.12;
      model.rotation.x = 0.1;
    } else {
      model.rotation.x = (Math.sin(yaw * 3) * 8) / 100;
      model.rotation.z = (Math.cos(yaw * 5) * 8) / 100;
    }
    // opaque parts must render after the outline hull (renderOrder 1)
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.renderOrder === 0) m.renderOrder = 2;
    });
    const group = new THREE.Group();
    group.add(model);
    group.updateMatrixWorld(true);
    this.tmpBox.setFromObject(model);
    const height = Math.max(0.02, this.tmpBox.max.y - this.tmpBox.min.y);
    const sink = (SINK[kind] ?? 0.3) * height;
    group.position.set(x, terrainHeight(x, z) - this.tmpBox.min.y - sink, z);

    const glintMat = new THREE.SpriteMaterial({
      map: this.glintTex,
      color: 0xffe9b0,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const glint = new THREE.Sprite(glintMat);
    const top = this.tmpBox.max.y - sink;
    glint.position.set(0, top + 0.14, 0);
    glint.scale.setScalar(0.16);
    glint.renderOrder = 8;
    group.add(glint);

    const proxy = new THREE.Mesh(this.proxyGeo, this.proxyMat);
    const radius = Math.max(
      0.16,
      Math.max(
        this.tmpBox.max.x - this.tmpBox.min.x,
        this.tmpBox.max.z - this.tmpBox.min.z,
      ) * 0.7,
    );
    proxy.scale.setScalar(radius);
    proxy.position.y = Math.max(0.04, top * 0.5);
    proxy.visible = false;
    proxy.userData.slot = slot;
    group.add(proxy);

    this.scene.add(group);
    this.spawns[slot] = {
      id,
      name,
      kind,
      yaw,
      group,
      model,
      glint,
      glintMat,
      proxy,
      hull: null,
      phase: (x * 7 + z * 3) % 6.28,
      top,
    };
    return slot;
  }

  // ------------------------------------------------------------ game loop --

  /** Spawn timers / sparkle animation; runs only while the game is running. */
  update(dt: number, playerPos: THREE.Vector3): void {
    this.time += dt;
    // refill: one piece every 6–12 minutes up to the cap, owned pieces excluded
    if (this.activeCount() < MAX_ACTIVE) {
      const remaining = COLLECTIBLES.some(
        (c) => !this.isOwned(c.id) && !this.isActive(c.id),
      );
      if (remaining) {
        this.refillTimer -= dt;
        if (this.refillTimer <= 0) {
          const before = this.activeCount();
          this.spawnUpTo(before + 1);
          if (this.activeCount() > before) {
            this.syncStore();
            this.refillTimer = this.drawRefillDelay();
          } else {
            this.refillTimer = RETRY_S;
          }
        }
      }
    }
    // the glint: a soft pulse with an occasional sharper flash, close range only
    for (const s of this.spawns) {
      if (!s) continue;
      const dist = playerPos.distanceTo(s.group.position);
      if (dist > GLINT_RANGE + 4) {
        s.glint.visible = false;
        continue;
      }
      s.glint.visible = true;
      const fade = 1 - Math.min(1, Math.max(0, (dist - 6) / (GLINT_RANGE - 6)));
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 2.1 + s.phase);
      const flash = Math.max(0, Math.sin(this.time * 0.7 + s.phase * 2)) ** 8;
      s.glintMat.opacity = fade * (0.1 + pulse * 0.16 + flash * 0.3);
      s.glint.scale.setScalar(0.13 + pulse * 0.05 + flash * 0.06);
    }
  }

  // ---------------------------------------------------------- interaction --

  /** Crosshair pick within `maxDist`; null when nothing is hit. */
  raycastPick(
    raycaster: THREE.Raycaster,
    maxDist: number,
  ): CollectiblePick | null {
    const proxies: THREE.Object3D[] = [];
    for (const s of this.spawns) if (s) proxies.push(s.proxy);
    if (proxies.length === 0) return null;
    const prevFar = raycaster.far;
    raycaster.far = maxDist + 0.5;
    this.hits.length = 0;
    raycaster.intersectObjects(proxies, false, this.hits);
    raycaster.far = prevFar;
    for (const h of this.hits) {
      if (h.distance > maxDist) break;
      const slot = h.object.userData.slot as number;
      const s = this.spawns[slot];
      if (!s) continue;
      return {
        slot,
        id: s.id,
        name: s.name,
        point: this.pickPoint.copy(h.point),
      };
    }
    return null;
  }

  /** Highlight the picked item (like the trash outline); null clears it. */
  setHighlight(pick: CollectiblePick | null): void {
    if (this.highlighted >= 0 && this.highlighted !== pick?.slot) {
      const prev = this.spawns[this.highlighted];
      if (prev?.hull) prev.hull.visible = false;
      this.highlighted = -1;
    }
    if (!pick) return;
    const s = this.spawns[pick.slot];
    if (!s) return;
    if (!s.hull) {
      // shared-geometry clone of the model, drawn inflated before the model
      const hull = s.model.clone();
      hull.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.material = this.hullMat;
        m.castShadow = false;
        m.renderOrder = 1;
      });
      s.group.add(hull);
      s.hull = hull;
    }
    s.hull.visible = true;
    this.highlighted = pick.slot;
  }

  /** Simple mesh for the grab animation. */
  makeGhost(id: string): THREE.Mesh {
    return buildCollectibleGhost(id);
  }

  /** Remove the item in `slot` from the world; false if it is already gone. */
  collect(slot: number): boolean {
    const s = this.spawns[slot];
    if (!s) return false;
    const wasOwned = this.isOwned(s.id); // double-delivery guard
    this.removeSpawn(slot);
    this.syncStore();
    this.refillTimer = this.drawRefillDelay();
    return !wasOwned;
  }

  private removeSpawn(slot: number): void {
    const s = this.spawns[slot];
    if (!s) return;
    if (this.highlighted === slot) this.highlighted = -1;
    this.scene.remove(s.group);
    disposeCollectibleModel(s.model);
    s.glintMat.dispose();
    this.spawns[slot] = null;
  }

  dispose(): void {
    for (let i = 0; i < this.spawns.length; i++) this.removeSpawn(i);
    this.glintTex.dispose();
    this.proxyGeo.dispose();
    this.proxyMat.dispose();
    this.hullMat.dispose();
    disposeCollectibleGhosts();
  }

  // ------------------------------------------------- dev harness only ----

  /** Dev harness only: force-spawn a variant at x/z (ignores all rules). */
  debugSpawn(id: string, x: number, z: number): number {
    const def = COLLECTIBLES.find((c) => c.id === id);
    if (!def) return -1;
    if (this.spawns.every((s) => s !== null)) this.removeSpawn(0);
    const slot = this.place(def.id, def.name, def.kind, x, z, 0.7);
    this.syncStore();
    return slot;
  }

  /** Dev harness only: active spawns as id/position/time-to-next-spawn. */
  debugList(): Array<{ slot: number; id: string; x: number; z: number }> {
    const out: Array<{ slot: number; id: string; x: number; z: number }> = [];
    for (let i = 0; i < this.spawns.length; i++) {
      const s = this.spawns[i];
      if (s)
        out.push({
          slot: i,
          id: s.id,
          x: Math.round(s.group.position.x),
          z: Math.round(s.group.position.z),
        });
    }
    return out;
  }

  /** Dev harness only: clear the world and restart the refill timer. */
  debugClear(): void {
    for (let i = 0; i < this.spawns.length; i++) this.removeSpawn(i);
    this.syncStore();
    this.refillTimer = this.drawRefillDelay();
  }
}

/** Additive four-point star with a soft core for the glint sprite. */
function makeGlintTexture(): THREE.Texture {
  const S = 64;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const ctx = c.getContext("2d");
  if (ctx) {
    const grad = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grad.addColorStop(0, "rgba(255,255,255,0.9)");
    grad.addColorStop(0.25, "rgba(255,240,200,0.35)");
    grad.addColorStop(1, "rgba(255,240,200,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, S, S);
    ctx.strokeStyle = "rgba(255,255,255,0.8)";
    ctx.lineCap = "round";
    for (const [dx, dy] of [
      [1, 0],
      [0, 1],
    ]) {
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(S / 2 - dx * S * 0.42, S / 2 - dy * S * 0.42);
      ctx.lineTo(S / 2 + dx * S * 0.42, S / 2 + dy * S * 0.42);
      ctx.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
