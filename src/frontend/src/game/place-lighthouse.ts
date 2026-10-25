// The Saltreach lighthouse â€“ a red/white banded tapered tower on its own
// knoll behind Rocky Cape (landforms.ts LIGHTHOUSE), climbable inside up a
// cast-iron spiral stair to a glazed lamp room with a rotating first-order
// lens. The heavy door faces south towards the arriving footpath and is
// locked; the keeper's key hangs on a nail inside the Keld Bothy across the
// map (bothySite() frame). A breaker box beside the door switches the main
// light: the lens spins up, two opposed volumetric beams sweep the coast, a
// rotating spotlight rakes the dunes at night and a billboard glare flashes
// whenever a beam crosses the camera bearing. Quest state lives in the store
// (`lighthouse` / `setLighthouse`), persisted in the save and re-applied on
// construction.
//
// Walkability: one ground override ("lighthouse") serves the apron, the
// ground floor, the helical stair ramp (refY picks the turn nearest the
// body; multi-level answers are suppressed when refY is undefined) and the
// lamp-room floor with its stair hatch. Colliders: tapered wall rings with a
// door gap (the locked leaf is one extra box under "lighthouse-door",
// dropped on unlocking), an invisible well-guard cylinder at the inner
// handrail so nobody falls down the open well, and the furniture.
//
// Budget: ~15 draw calls close up (roughly 9 beyond the 80 m interior cull),
// â‰ˆ 60 k triangles at ultra.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  type ColliderFrame,
  addBoxCollider,
  addCylinderCollider,
  beginColliderSet,
  clearColliderSet,
} from "./colliders";
import { registerGround, unregisterGround } from "./ground";
import { LIGHTHOUSE } from "./landforms";
import { bothySite } from "./place-bothy";
import {
  LH_DRESS_UV,
  type UvRegion,
  lighthouseDressPbr,
  lighthouseGlareTexture,
  pbrLighthouseInterior,
  pbrLighthouseMasonry,
  pbrLighthousePatina,
} from "./place-lighthouse-textures";
import type { Environment } from "./sky";
import { sound } from "./sound";
import { useGame } from "./state";
import { terrainHeight } from "./terrain";
import { applyPbr, pbrConcrete, pbrRustyMetal } from "./textures";
import type { QualityId } from "./types";

// ---------------------------------------------------------------------------
// Dimensions (local: origin at the tower axis, y = 0 at the ground floor)
// ---------------------------------------------------------------------------

const CX = LIGHTHOUSE.x;
const CZ = LIGHTHOUSE.z;
const TAU = Math.PI * 2;

/** Angular cells of the wall sheet (the door spans exactly two). */
const COLS = 44;
const STEP_A = TAU / COLS;

const SHAFT_H = 19.8;
const WALL_BOT = -1.2;
const R_BASE = 4.0;
const R_TOP = 2.65;
const T_BASE = 0.55;
const T_TOP = 0.42;
const DOOR_H = 2.31;
/** Interior lamp-room floor = gallery deck top. */
const LAMP_FLOOR = 20.05;
const MUR_TOP = 20.95;
const GLAZE_TOP = 23.35;
/** Optical centre of the lens (beams, glare, spotlight). */
const LAMP_Y = 22.05;

const APRON_R = 6.2;
const APRON_BLEND = 1.3;

/** Open well: invisible guard cylinder at the inner handrail line. */
const WELL_R = 1.1;
const STAIR_IN = 1.18;
const TURNS = 4.25;
const A_MAX = TURNS * TAU;
const SLOPE = LAMP_FLOOR / A_MAX;
/** Angle (rad, 0 = south/door, clockwise from above) where the stair starts. */
const STAIR_A0 = 0.95;
/** Angle where the stair meets the lamp-room floor. */
const TOP_ANG = (STAIR_A0 + A_MAX) % TAU;
/**
 * The hatch opening trails this far behind the stair's arrival angle. Sized
 * so the plate only starts where a climber's head (1.85 m over the ramp) is
 * already below it: at the low edge the ramp sits 2.5 * SLOPE â‰ˆ 1.88 m under
 * the floor, so the guard rail there never clips the emerging body.
 */
const HATCH_ARC = 2.5;

/** Breaker box beside the door, inside. */
const BRK_A = 0.55;
const BRK_R = 3.28;
const BRK_Y = 1.45;

/** Wall openings: door (two cells) and two windows on the stair line. */
interface Opening {
  c0: number;
  c1: number;
  y0: number;
  y1: number;
  pane: boolean;
}
const OPENINGS: readonly Opening[] = [
  { c0: 0, c1: 1, y0: 0, y1: DOOR_H, pane: false },
  { c0: 33, c1: 33, y0: 8.0, y1: 9.2, pane: true },
  { c0: 5, c1: 5, y0: 14.5, y1: 15.7, pane: true },
];

const ROT_SPEED = TAU / 10; // one revolution in 10 s

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Outer radius of the shaft (slight entasis). */
function outerR(y: number): number {
  const t = clamp01(y / SHAFT_H);
  return R_TOP + (R_BASE - R_TOP) * (1 - t) ** 1.18;
}

function innerR(y: number): number {
  const t = clamp01(y / SHAFT_H);
  return outerR(y) - (T_BASE + (T_TOP - T_BASE) * t);
}

/** Polar angle used everywhere: 0 = south (the door), in [0, TAU). */
function angOf(dx: number, dz: number): number {
  const a = Math.atan2(dx, -dz);
  return a < 0 ? a + TAU : a;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

type LhMat =
  | "masonry"
  | "inner"
  | "iron"
  | "ironIn"
  | "dress"
  | "dressIn"
  | "copper"
  | "glass"
  | "concrete";
type Tint = readonly [number, number, number];

const COLOR_MATS: ReadonlySet<LhMat> = new Set([
  "masonry",
  "inner",
  "iron",
  "ironIn",
  "dress",
  "dressIn",
  "copper",
]);
const WHITE: Tint = [1, 1, 1];
const UP = new THREE.Vector3(0, 1, 0);
const TV = new THREE.Vector3();
const TQ = new THREE.Quaternion();

/** Collects geometries per material key and merges them into one mesh each. */
class Bag {
  private readonly lists = new Map<LhMat, THREE.BufferGeometry[]>();

  add(key: LhMat, g: THREE.BufferGeometry, tint: Tint = WHITE): void {
    const geo = nonIndexed(g);
    const n = geo.getAttribute("position").count;
    if (COLOR_MATS.has(key)) {
      if (!geo.getAttribute("color")) {
        const arr = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          arr[i * 3] = tint[0];
          arr[i * 3 + 1] = tint[1];
          arr[i * 3 + 2] = tint[2];
        }
        geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
      }
    } else if (geo.getAttribute("color")) {
      geo.deleteAttribute("color");
    }
    let list = this.lists.get(key);
    if (!list) {
      list = [];
      this.lists.set(key, list);
    }
    list.push(geo);
  }

  build(mats: Record<LhMat, THREE.Material>): Map<LhMat, THREE.Mesh> {
    const out = new Map<LhMat, THREE.Mesh>();
    for (const [key, list] of this.lists) {
      if (list.length === 0) continue;
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) throw new Error(`Lighthouse: mergeGeometries (${key})`);
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mats[key]);
      mesh.name = `lighthouse-${key}`;
      mesh.castShadow = key !== "glass";
      mesh.receiveShadow = true;
      out.set(key, mesh);
    }
    this.lists.clear();
    return out;
  }
}

function nonIndexed(g: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!g.index) return g;
  const out = g.toNonIndexed();
  g.dispose();
  return out;
}

/** x, y, z, nx, ny, nz, u, v */
type Vtx = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** Accumulates explicit quads/tris into one BufferGeometry. */
class Sink {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly uvs: number[] = [];

  tri(a: Vtx, b: Vtx, c: Vtx): void {
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.nor.push(a[3], a[4], a[5], b[3], b[4], b[5], c[3], c[4], c[5]);
    this.uvs.push(a[6], a[7], b[6], b[7], c[6], c[7]);
  }

  quad(a: Vtx, b: Vtx, c: Vtx, d: Vtx): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(this.pos), 3),
    );
    g.setAttribute(
      "normal",
      new THREE.BufferAttribute(new Float32Array(this.nor), 3),
    );
    g.setAttribute(
      "uv",
      new THREE.BufferAttribute(new Float32Array(this.uvs), 2),
    );
    return g;
  }
}

function box(
  w: number,
  h: number,
  d: number,
  x = 0,
  y = 0,
  z = 0,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/** Remap 0..1 UVs into an atlas region (clamped). */
function regionUv(
  g: THREE.BufferGeometry,
  region: UvRegion,
): THREE.BufferGeometry {
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  const [u0, v0, u1, v1] = region;
  for (let i = 0; i < uv.count; i++) {
    const u = Math.min(1, Math.max(0, uv.getX(i)));
    const v = Math.min(1, Math.max(0, uv.getY(i)));
    uv.setXY(i, u0 + u * (u1 - u0), v0 + v * (v1 - v0));
  }
  uv.needsUpdate = true;
  return g;
}

/** Cylinder between two points (u around, v along â€“ fine for dark ironwork). */
function cylBetween(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  r: number,
  seg: number,
): THREE.BufferGeometry {
  const len = Math.hypot(bx - ax, by - ay, bz - az) || 1e-4;
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1, false);
  TV.set(bx - ax, by - ay, bz - az).normalize();
  TQ.setFromUnitVectors(UP, TV);
  g.applyQuaternion(TQ);
  g.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  return g;
}

/** Keep a lathe/cylinder's u, remap v onto the masonry sheet's height axis. */
function remapV(
  g: THREE.BufferGeometry,
  yBot: number,
  ySpan: number,
): THREE.BufferGeometry {
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setY(i, clamp01((pos.getY(i) - yBot) / ySpan));
  }
  uv.needsUpdate = true;
  return g;
}

function lathe(
  profile: ReadonlyArray<readonly [number, number]>,
  seg: number,
  phiStart = 0,
  phiLength = TAU,
): THREE.BufferGeometry {
  return new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(r, y)),
    seg,
    phiStart,
    phiLength,
  );
}

/** Flat ring (torus) lying in the XZ plane at height y. */
function ring(
  r: number,
  tube: number,
  y: number,
  seg: number,
  tubeSeg = 6,
): THREE.BufferGeometry {
  const g = new THREE.TorusGeometry(r, tube, tubeSeg, seg);
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}

// ---------------------------------------------------------------------------
// The lighthouse
// ---------------------------------------------------------------------------

export interface LighthouseInteraction {
  /** Prompt shown on the HUD, without the key name (engine prefixes "F: "). */
  prompt: string;
  /** Runs when the player presses the action key. */
  run: () => void;
}

const BEAM_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalMatrix * normal;
  vV = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

const BEAM_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uI;
uniform float uTime;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main() {
  float t = vUv.y;
  // Fade along the beam, held back right at the lens so it does not clip hard
  float axial = pow(max(0.0, 1.0 - t), 1.7) * (0.35 + 0.65 * smoothstep(0.0, 0.05, t));
  vec3 N = normalize(vN);
  vec3 V = normalize(vV);
  // Soft radial edge: the shell dims towards its silhouette
  float core = pow(abs(dot(N, V)), 1.35);
  // Subtle in-beam shimmer drifting outwards
  float n = 0.9 + 0.1 * sin(t * 46.0 - uTime * 1.9 + 2.3 * sin(vUv.x * 6.2832 + t * 9.0));
  float b = uI * axial * core * n;
  gl_FragColor = vec4(uColor * b, 1.0);
}
`;

export class Lighthouse {
  protected readonly parent: THREE.Group;
  protected readonly quality: QualityId;

  private readonly group = new THREE.Group();
  private readonly interior = new THREE.Group();
  private readonly keyGroup = new THREE.Group();
  private readonly mats: Record<LhMat, THREE.Material>;
  private readonly meshes: THREE.Mesh[] = [];
  private readonly det: number;
  private readonly floorYw: number;
  private readonly apronYw: number;
  private readonly frame: ColliderFrame;

  // Dynamic pieces
  private doorPivot: THREE.Group | null = null;
  private lever: THREE.Mesh | null = null;
  private indMat: THREE.MeshBasicMaterial | null = null;
  private coreMat: THREE.MeshBasicMaterial | null = null;
  private lensGroup: THREE.Group | null = null;
  private beams: THREE.Mesh | null = null;
  private beamMat: THREE.ShaderMaterial | null = null;
  private glare: THREE.Sprite | null = null;
  private glareMat: THREE.SpriteMaterial | null = null;
  private spot: THREE.SpotLight | null = null;
  private spotTarget: THREE.Object3D | null = null;
  private lampLight: THREE.PointLight | null = null;
  private glassMat: THREE.MeshPhysicalMaterial;
  private lensGlassMat: THREE.MeshPhysicalMaterial;
  private keyMat: THREE.MeshStandardMaterial | null = null;

  // Quest / animation state (mirrors the store; syncState reconciles)
  private hasKey = false;
  private unlocked = false;
  private lampOn = false;
  private doorT = 0; // 0 closed .. 1 open
  private warm = 0; // lamp warm-up 0..1
  private spin = 0; // rotation spin-up 0..1
  private beamAngle = 0;
  private leverT = 0;

  // Interactions (preallocated â€“ interaction() runs every frame)
  private readonly actKey: LighthouseInteraction;
  private readonly actTry: LighthouseInteraction;
  private readonly actUnlock: LighthouseInteraction;
  private readonly actLamp: LighthouseInteraction;
  private readonly keyWorld = new THREE.Vector3();
  private readonly doorWorld = new THREE.Vector3();
  private readonly brkWorld = new THREE.Vector3();
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpFwd = new THREE.Vector3();

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
            : 0.5;

    // Site: the knoll crown is flat; the apron sits just above the highest
    // terrain sample under it, the interior floor a step above the apron.
    let hi = Number.NEGATIVE_INFINITY;
    for (let j = -4; j <= 4; j++) {
      for (let i = -4; i <= 4; i++) {
        const h = terrainHeight(CX + i * 1.5, CZ + j * 1.5);
        if (h > hi) hi = h;
      }
    }
    this.apronYw = hi + 0.06;
    this.floorYw = this.apronYw + 0.08;
    this.frame = { x: CX, y: this.floorYw, z: CZ, yaw: 0 };
    this.group.position.set(CX, this.floorYw, CZ);
    parent.add(this.group);
    this.group.add(this.interior);
    parent.add(this.keyGroup);

    this.glassMat = new THREE.MeshPhysicalMaterial({
      color: 0xd9e9e0,
      transparent: true,
      opacity: 0.22,
      roughness: 0.06,
      metalness: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      emissive: 0xffb36b,
      emissiveIntensity: 0,
    });
    this.lensGlassMat = new THREE.MeshPhysicalMaterial({
      color: 0xc8ddd3,
      transparent: true,
      opacity: 0.42,
      roughness: 0.05,
      metalness: 0.15,
      side: THREE.DoubleSide,
      depthWrite: false,
      emissive: 0xffa95e,
      emissiveIntensity: 0,
    });
    this.mats = this.makeMaterials();

    // Interactions
    this.actKey = {
      prompt: "Take the keeper's key",
      run: () => this.takeKey(),
    };
    this.actTry = { prompt: "Try the door", run: () => this.tryDoor() };
    this.actUnlock = {
      prompt: "Unlock the lighthouse door",
      run: () => this.unlockDoor(),
    };
    this.actLamp = {
      prompt: "Switch the main light on",
      run: () => this.toggleLamp(),
    };

    this.build();
    this.registerGround();
    this.registerColliders();

    // Apply restored quest state (save game)
    const ls = useGame.getState().lighthouse;
    if (ls.hasKey) this.keyGroup.visible = false;
    this.hasKey = ls.hasKey;
    if (ls.unlocked) {
      this.unlocked = true;
      this.doorT = 1;
      this.applyDoor();
    } else {
      this.registerDoorBlocker();
    }
    if (ls.lampOn) {
      this.lampOn = true;
      this.warm = 1;
      this.spin = 1;
      this.leverT = 1;
      if (this.lever) this.lever.rotation.x = 0.6 - 1.2;
    }
    this.actLamp.prompt = this.lampOn
      ? "Switch the main light off"
      : "Switch the main light on";
    this.applyIndicator();
  }

  // -------------------------------------------------------------------------
  // Materials
  // -------------------------------------------------------------------------

  private makeMaterials(): Record<LhMat, THREE.Material> {
    const size =
      this.quality === "ultra" ? 1024 : this.quality === "high" ? 768 : 512;

    const masonry = new THREE.MeshStandardMaterial({ vertexColors: true });
    applyPbr(masonry, pbrLighthouseMasonry(size));

    const inner = new THREE.MeshStandardMaterial({ vertexColors: true });
    applyPbr(inner, pbrLighthouseInterior(size));

    // Painted cast iron (dark sage, kept by the board) with light pitting â€“
    // heavy rust reads as a wreck, not a working light
    const iron = new THREE.MeshStandardMaterial({ vertexColors: true });
    applyPbr(iron, pbrRustyMetal("#5d6b64", 0.06, { edges: false }));
    iron.metalness = 0.25;

    const dress = new THREE.MeshStandardMaterial({ vertexColors: true });
    applyPbr(dress, lighthouseDressPbr(size));

    // Double-sided: the dome and cornice are open shells whose backs face
    // the lamp room and the gallery, so their insides must render too
    const copper = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
    });
    applyPbr(copper, pbrLighthousePatina(Math.max(256, size / 2)));

    const concrete = new THREE.MeshStandardMaterial();
    applyPbr(concrete, pbrConcrete());

    return {
      masonry,
      inner,
      iron,
      ironIn: iron,
      dress,
      dressIn: dress,
      copper,
      glass: this.glassMat,
      concrete,
    };
  }

  // -------------------------------------------------------------------------
  // Ground override
  // -------------------------------------------------------------------------

  private registerGround(): void {
    const floorYw = this.floorYw;
    const apronYw = this.apronYw;
    const RMAX = APRON_R + APRON_BLEND;
    const LAMP_R = innerR(SHAFT_H) + 0.1;
    registerGround("lighthouse", (x, z, refY) => {
      const dx = x - CX;
      const dz = z - CZ;
      const r2 = dx * dx + dz * dz;
      if (r2 > RMAX * RMAX) return null;
      const r = Math.sqrt(r2);
      // Ground level: interior floor / apron / blend down to the terrain
      let g: number;
      if (r < innerR(0)) g = floorYw;
      else if (r <= APRON_R) {
        // Threshold slab through the doorway: flush with the interior floor,
        // one 8 cm step up from the apron at the slab's outer edge
        g = dz < -3.2 && dz > -4.4 && Math.abs(dx) < 0.92 ? floorYw : apronYw;
      } else {
        const t = (r - APRON_R) / APRON_BLEND;
        const s = t * t * (3 - 2 * t);
        g = apronYw + (terrainHeight(x, z) - apronYw) * s;
      }
      // Spawn/teleport queries get the single-level ground only
      if (refY === undefined) return g;
      let best = g;
      const aq = angOf(dx, dz);
      // Lamp-room floor (minus the stair hatch)
      if (r <= LAMP_R) {
        let d = TOP_ANG - aq;
        d -= Math.floor(d / TAU) * TAU;
        const inHatch = r >= WELL_R - 0.05 && d <= HATCH_ARC;
        const yw = floorYw + LAMP_FLOOR;
        if (!inHatch && yw <= refY + 0.6 && yw > best) best = yw;
      }
      // Helical stair ramp: the turn nearest (but not above) the body's feet
      if (r >= STAIR_IN - 0.03) {
        let a0 = aq - STAIR_A0;
        a0 -= Math.floor(a0 / TAU) * TAU;
        for (let k = 0; k < 6; k++) {
          const a = a0 + k * TAU;
          if (a > A_MAX + 0.35) break;
          const y = Math.min(SLOPE * a, LAMP_FLOOR);
          if (r > innerR(y) + 0.3) continue;
          const yw = floorYw + y;
          if (yw <= refY + 0.6 && yw > best) best = yw;
        }
      }
      return best;
    });
  }

  // -------------------------------------------------------------------------
  // Colliders
  // -------------------------------------------------------------------------

  private registerColliders(): void {
    beginColliderSet("lighthouse", this.frame);
    // Tapered wall as stacked rings of tangential boxes (12 per ring). The
    // ring at the door level skips the south segment; jamb boxes narrow the
    // gap to the actual door width.
    const bands: ReadonlyArray<readonly [number, number]> = [
      [-0.3, 3.4],
      [3.4, 6.8],
      [6.8, 10.2],
      [10.2, 13.6],
      [13.6, 17],
      [17, 20.1],
    ];
    for (let b = 0; b < bands.length; b++) {
      const [y0, y1] = bands[b];
      const rI = innerR((y0 + y1) / 2);
      const halfT = 0.45;
      const halfX = rI * Math.tan(Math.PI / 12) + 0.12;
      for (let i = 0; i < 12; i++) {
        if (b === 0 && i === 0) continue; // door gap
        const a = i * (Math.PI / 6);
        const rc = rI + halfT;
        addBoxCollider(
          Math.sin(a) * rc,
          -Math.cos(a) * rc,
          halfX,
          halfT,
          -a,
          y0,
          y1,
        );
      }
    }
    // Door jambs
    for (const s of [-1, 1]) {
      const a = s * 0.205;
      const rc = innerR(1.2) + 0.45;
      addBoxCollider(
        Math.sin(a) * rc,
        -Math.cos(a) * rc,
        0.2,
        0.45,
        -a,
        -0.3,
        2.6,
      );
    }
    // Door-surround base blocks (proud of the wall foot, flanking the slab)
    for (const s of [-1, 1]) {
      addBoxCollider(s * 0.73, -3.85, 0.21, 0.45, 0, -0.5, 0.9);
    }
    // Lamp room: murette + glazing keep the player inside
    for (let i = 0; i < 12; i++) {
      const a = i * (Math.PI / 6);
      const rc = 2.2 + 0.35;
      addBoxCollider(
        Math.sin(a) * rc,
        -Math.cos(a) * rc,
        2.2 * Math.tan(Math.PI / 12) + 0.12,
        0.35,
        -a,
        LAMP_FLOOR,
        GLAZE_TOP,
      );
    }
    // Open-well guard (reads as the inner handrail) â€“ starts above head
    // height of the ground floor so the well mouth stays walkable below
    addCylinderCollider(0, 0, WELL_R, 2.45, LAMP_FLOOR - 0.05);
    // Weight tube on the axis at ground level
    addCylinderCollider(0, 0, 0.22, -0.2, 2.45);
    // Lens pedestal
    addCylinderCollider(0, 0, 0.62, LAMP_FLOOR, LAMP_FLOOR + 1.1);
    // Hatch guard rail along the low edge of the opening. Its band starts
    // just above the plate: the climber crossing this angle is still fully
    // below it (see HATCH_ARC), a walker on the plate is always inside it.
    {
      const a = TOP_ANG - HATCH_ARC;
      const rc = (WELL_R + 2.3) / 2;
      addBoxCollider(
        Math.sin(a) * rc,
        -Math.cos(a) * rc,
        0.62,
        0.07,
        Math.PI / 2 - a,
        LAMP_FLOOR + 0.08,
        LAMP_FLOOR + 1.05,
      );
    }
    // Stored clutter blocks walking under the low turns of the stair. Each
    // box tops out safely below the ramp at its own LEADING edge (a box
    // spans ~Â±0.24 rad of arc), so a body climbing the stair never overlaps
    // its band while a body on the ground floor (feet at 0) always does.
    for (const [a, y1] of [
      [2.0, 0.48],
      [2.5, 0.86],
      [3.0, 1.24],
      [3.5, 1.6],
      [3.95, 1.85],
    ] as const) {
      const rc = 2.3;
      addBoxCollider(Math.sin(a) * rc, -Math.cos(a) * rc, 0.55, 1.0, -a, 0, y1);
    }
    // Keeper's desk
    {
      const a = 5.5;
      const rc = 2.55;
      addBoxCollider(
        Math.sin(a) * rc,
        -Math.cos(a) * rc,
        0.52,
        0.35,
        -a,
        0,
        0.85,
      );
    }
  }

  private registerDoorBlocker(): void {
    beginColliderSet("lighthouse-door", this.frame);
    addBoxCollider(0, -3.66, 0.62, 0.3, 0, -0.3, 2.5);
  }

  // -------------------------------------------------------------------------
  // Build
  // -------------------------------------------------------------------------

  private seg(n: number, min = 6): number {
    return Math.max(min, Math.round(n * this.det));
  }

  private build(): void {
    const bag = new Bag();
    this.buildApron(bag);
    this.buildWall(bag);
    this.buildGallery(bag);
    this.buildLantern(bag);
    this.buildStair(bag);
    this.buildLampRoom(bag);
    this.buildClutter(bag);
    this.buildBreaker(bag);

    const built = bag.build(this.mats);
    const interiorKeys: ReadonlySet<LhMat> = new Set([
      "inner",
      "ironIn",
      "dressIn",
    ]);
    for (const [key, mesh] of built) {
      this.meshes.push(mesh);
      if (key === "glass") mesh.renderOrder = 2;
      (interiorKeys.has(key) ? this.interior : this.group).add(mesh);
    }

    this.buildDoor();
    this.buildLens();
    this.buildBeams();
    this.buildKey();

    // Lights: one rotating spot (no shadows) + one lamp-room point light
    this.spot = new THREE.SpotLight(0xffe2b8, 0, 420, 0.145, 0.5, 1.1);
    this.spot.castShadow = false;
    this.spot.position.set(0, LAMP_Y, 0);
    this.spotTarget = new THREE.Object3D();
    this.spot.target = this.spotTarget;
    this.group.add(this.spot, this.spotTarget);
    // Reaches well down the open stair well, so the climb is never pitch
    // black while the lamp runs
    this.lampLight = new THREE.PointLight(0xffd9a6, 0, 34, 1.4);
    this.lampLight.position.set(0, LAMP_Y - 0.6, 0);
    this.interior.add(this.lampLight);
  }

  /** Concrete apron conforming to the knoll crown + interior floor. */
  private buildApron(bag: Bag): void {
    const sink = new Sink();
    const segs = this.seg(40, 24);
    const apron = this.apronYw - this.floorYw;
    const ringDefs: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [2.2, 0],
      [3.62, 0],
      [3.62, apron],
      [5.0, apron],
      [APRON_R, apron],
    ];
    const vy = (r: number, a: number, y: number): Vtx => {
      const x = Math.sin(a) * r;
      const z = -Math.cos(a) * r;
      return [x, y, z, 0, 1, 0, x / 2.6, z / 2.6];
    };
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * TAU;
      const a1 = ((i + 1) / segs) * TAU;
      for (let k = 0; k + 1 < ringDefs.length; k++) {
        const [r0, y0] = ringDefs[k];
        const [r1, y1] = ringDefs[k + 1];
        if (r0 === r1 && y0 === y1) continue;
        sink.quad(
          vy(r0, a0, y0),
          vy(r0, a1, y0),
          vy(r1, a1, y1),
          vy(r1, a0, y1),
        );
      }
      // Skirt down to the terrain
      const skirt = (a: number): Vtx => {
        const r = APRON_R + APRON_BLEND;
        const x = Math.sin(a) * r;
        const z = -Math.cos(a) * r;
        const ty = terrainHeight(CX + x, CZ + z) - this.floorYw - 0.04;
        return [x, ty, z, 0, 1, 0, x / 2.6, z / 2.6];
      };
      sink.quad(
        vy(APRON_R, a0, apron),
        vy(APRON_R, a1, apron),
        skirt(a1),
        skirt(a0),
      );
    }
    bag.add("concrete", sink.build());
    // Door threshold: a dressed stone slab flush with the interior floor,
    // one shallow step up from the apron, spanning the surround's base blocks
    bag.add(
      "masonry",
      regionUv(box(1.9, 0.2, 1.12, 0, -0.1, -3.86), [0.3, 0.01, 0.38, 0.04]),
      [0.78, 0.77, 0.75],
    );
  }

  /**
   * The tower shaft: a parametric sheet over 44 angular cells and variable
   * height rows. Cells at the door and window openings are skipped and lined
   * with reveal quads; the two shells share the analytic taper.
   */
  private buildWall(bag: Bag): void {
    const outerSink = new Sink();
    const innerSink = new Sink();
    const rows = this.wallRows();
    const span = SHAFT_H - WALL_BOT;
    const dR = (y: number, inner: boolean): number => {
      const f = inner ? innerR : outerR;
      return (f(y + 0.05) - f(y - 0.05)) / 0.1;
    };
    const wv = (a: number, y: number, outer: boolean): Vtx => {
      const sinA = Math.sin(a);
      const cosA = Math.cos(a);
      const r = outer ? outerR(y) : innerR(y);
      const d = dR(y, !outer);
      let nx: number;
      let ny: number;
      let nz: number;
      if (outer) {
        nx = sinA;
        ny = -d;
        nz = -cosA;
      } else {
        nx = -sinA;
        ny = d;
        nz = cosA;
      }
      const il = 1 / Math.hypot(nx, ny, nz);
      return [
        sinA * r,
        y,
        -cosA * r,
        nx * il,
        ny * il,
        nz * il,
        a / TAU,
        (y - WALL_BOT) / span,
      ];
    };
    const isOpen = (c: number, y0: number, y1: number): boolean => {
      for (const o of OPENINGS) {
        if (c >= o.c0 && c <= o.c1 && y0 >= o.y0 - 0.01 && y1 <= o.y1 + 0.01)
          return true;
      }
      return false;
    };
    for (let c = 0; c < COLS; c++) {
      const a0 = (c - 1) * STEP_A;
      const a1 = a0 + STEP_A;
      for (let j = 0; j + 1 < rows.length; j++) {
        const y0 = rows[j];
        const y1 = rows[j + 1];
        if (isOpen(c, y0, y1)) continue;
        outerSink.quad(
          wv(a0, y0, true),
          wv(a0, y1, true),
          wv(a1, y1, true),
          wv(a1, y0, true),
        );
        if (y1 > -0.06) {
          innerSink.quad(
            wv(a0, y0, false),
            wv(a1, y0, false),
            wv(a1, y1, false),
            wv(a0, y1, false),
          );
        }
      }
    }
    // Reveals + panes
    for (const o of OPENINGS) {
      const aL = (o.c0 - 1) * STEP_A;
      const aR = o.c1 * STEP_A;
      this.reveal(outerSink, aL, aR, o.y0, o.y1, o.y0 > 0.5);
      if (o.pane) {
        const rm = (innerR((o.y0 + o.y1) / 2) + outerR((o.y0 + o.y1) / 2)) / 2;
        const pane = new Sink();
        const pv = (a: number, y: number): Vtx => {
          const sinA = Math.sin(a);
          const cosA = Math.cos(a);
          return [sinA * rm, y, -cosA * rm, sinA, 0, -cosA, a, y * 0.2];
        };
        pane.quad(pv(aL, o.y0), pv(aL, o.y1), pv(aR, o.y1), pv(aR, o.y0));
        bag.add("glass", pane.build());
      }
    }
    bag.add("masonry", outerSink.build());
    bag.add("inner", innerSink.build());

    // Plinth course: an arc, not a full ring. It stops short of the door bay
    // (tower angle a maps to lathe phi = PI - a, the door is centred on a = 0)
    // and both cut ends are buried inside the surround's base blocks below,
    // so no open backfaces ever show and the break reads as dressed stonework.
    const plinthGap = Math.asin(0.73 / 4.24);
    bag.add(
      "masonry",
      remapV(
        lathe(
          [
            [4.24, WALL_BOT],
            [4.24, 0.5],
            [4.12, 0.72],
            [outerR(0.85), 0.85],
          ],
          this.seg(COLS, 24),
          Math.PI + plinthGap,
          TAU - 2 * plinthGap,
        ),
        WALL_BOT,
        SHAFT_H - WALL_BOT,
      ),
      [0.86, 0.84, 0.82],
    );
    // Entrance surround: projecting stone jambs flanking the doorway. The
    // wider base blocks catch the interrupted plinth course (its arc ends at
    // |x| = 0.73, mid-block); the shafts above carry the existing lintel.
    for (const s of [-1, 1]) {
      bag.add(
        "masonry",
        regionUv(
          box(0.42, 1.36, 0.9, s * 0.73, 0.18, -3.85),
          [0.3, 0.02, 0.38, 0.055],
        ),
        [0.84, 0.82, 0.8],
      );
      bag.add(
        "masonry",
        regionUv(
          box(0.3, 1.45, 0.69, s * 0.7, 1.585, -3.695),
          [0.3, 0.05, 0.36, 0.08],
        ),
        [0.72, 0.71, 0.7],
      );
    }
    // Stone lintel over the door + the brass plaque beside it
    bag.add(
      "masonry",
      regionUv(
        box(1.7, 0.26, 0.75, 0, DOOR_H + 0.13, -3.66),
        [0.3, 0.05, 0.36, 0.08],
      ),
      [0.72, 0.71, 0.7],
    );
    {
      const a = -0.34;
      const r = outerR(1.6) + 0.02;
      const plaque = regionUv(
        new THREE.PlaneGeometry(0.38, 0.28),
        LH_DRESS_UV.brass,
      );
      plaque.rotateY(Math.PI - a);
      plaque.translate(Math.sin(a) * r, 1.6, -Math.cos(a) * r);
      bag.add("dress", plaque);
    }
  }

  private wallRows(): number[] {
    const forced = new Set<number>([WALL_BOT, 0, 0.77, 1.54, DOOR_H, SHAFT_H]);
    for (const o of OPENINGS) {
      if (o.y0 > 0) forced.add(o.y0);
      forced.add(o.y1);
    }
    const bounds = [...forced].sort((a, b) => a - b);
    const rows: number[] = [];
    for (let i = 0; i + 1 < bounds.length; i++) {
      const a = bounds[i];
      const b = bounds[i + 1];
      rows.push(a);
      const n = Math.ceil((b - a) / 0.85);
      for (let k = 1; k < n; k++) rows.push(a + ((b - a) * k) / n);
    }
    rows.push(SHAFT_H);
    return rows;
  }

  /** Jamb/sill/head quads lining a wall opening. */
  private reveal(
    sink: Sink,
    aL: number,
    aR: number,
    y0: number,
    y1: number,
    withSill: boolean,
  ): void {
    const span = SHAFT_H - WALL_BOT;
    const P = (a: number, y: number, outer: boolean): THREE.Vector3 => {
      const r = outer ? outerR(y) : innerR(y);
      return new THREE.Vector3(Math.sin(a) * r, y, -Math.cos(a) * r);
    };
    const mk = (p: THREE.Vector3, nx: number, ny: number, nz: number): Vtx => [
      p.x,
      p.y,
      p.z,
      nx,
      ny,
      nz,
      (Math.atan2(p.x, -p.z) + TAU) / TAU,
      (p.y - WALL_BOT) / span,
    ];
    // Left jamb: faces towards +a
    {
      const t = [Math.cos(aL), 0, Math.sin(aL)] as const;
      sink.quad(
        mk(P(aL, y0, true), t[0], t[1], t[2]),
        mk(P(aL, y1, true), t[0], t[1], t[2]),
        mk(P(aL, y1, false), t[0], t[1], t[2]),
        mk(P(aL, y0, false), t[0], t[1], t[2]),
      );
    }
    // Right jamb: faces towards -a
    {
      const t = [-Math.cos(aR), 0, -Math.sin(aR)] as const;
      sink.quad(
        mk(P(aR, y0, true), t[0], t[1], t[2]),
        mk(P(aR, y0, false), t[0], t[1], t[2]),
        mk(P(aR, y1, false), t[0], t[1], t[2]),
        mk(P(aR, y1, true), t[0], t[1], t[2]),
      );
    }
    // Head (faces down)
    sink.quad(
      mk(P(aL, y1, true), 0, -1, 0),
      mk(P(aR, y1, true), 0, -1, 0),
      mk(P(aR, y1, false), 0, -1, 0),
      mk(P(aL, y1, false), 0, -1, 0),
    );
    if (withSill) {
      sink.quad(
        mk(P(aL, y0, true), 0, 1, 0),
        mk(P(aL, y0, false), 0, 1, 0),
        mk(P(aR, y0, false), 0, 1, 0),
        mk(P(aR, y0, true), 0, 1, 0),
      );
    }
  }

  /** Corbelled gallery with its railing. */
  private buildGallery(bag: Bag): void {
    const segs = this.seg(COLS, 24);
    bag.add(
      "masonry",
      remapV(
        lathe(
          [
            [outerR(18.3), 18.3],
            [2.84, 18.75],
            [2.84, 18.95],
            [3.06, 19.03],
            [3.06, 19.28],
            [3.3, 19.36],
            [3.3, 19.62],
            [3.58, 19.7],
            [3.58, LAMP_FLOOR],
            [2.36, LAMP_FLOOR],
          ],
          segs,
        ),
        WALL_BOT,
        SHAFT_H - WALL_BOT,
      ),
    );
    // Railing: stanchions, two rails, toe ring
    const posts = this.seg(22, 14);
    for (let i = 0; i < posts; i++) {
      const a = (i / posts) * TAU;
      const x = Math.sin(a) * 3.42;
      const z = -Math.cos(a) * 3.42;
      bag.add(
        "iron",
        cylBetween(x, LAMP_FLOOR, z, x, LAMP_FLOOR + 1.06, z, 0.024, 5),
        [0.92, 0.93, 0.96],
      );
    }
    bag.add(
      "iron",
      ring(3.42, 0.032, LAMP_FLOOR + 1.06, segs),
      [0.92, 0.93, 0.96],
    );
    bag.add(
      "iron",
      ring(3.42, 0.026, LAMP_FLOOR + 0.58, segs),
      [0.92, 0.93, 0.96],
    );
    bag.add(
      "iron",
      ring(3.46, 0.02, LAMP_FLOOR + 0.08, segs),
      [0.78, 0.79, 0.82],
    );
  }

  /** Lamp-room murette, glazing, cornice, dome, vent ball and finial. */
  private buildLantern(bag: Bag): void {
    const segs = this.seg(COLS, 24);
    bag.add(
      "masonry",
      remapV(
        lathe(
          [
            [2.36, LAMP_FLOOR],
            [2.36, 20.2],
            [2.3, 20.32],
            [2.3, 20.86],
            [2.2, MUR_TOP],
          ],
          segs,
        ),
        WALL_BOT,
        SHAFT_H - WALL_BOT,
      ),
    );
    // Interior face of the murette
    {
      const sink = new Sink();
      const n = this.seg(24, 16);
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * TAU;
        const a1 = ((i + 1) / n) * TAU;
        const iv = (a: number, y: number): Vtx => [
          Math.sin(a) * 2.18,
          y,
          -Math.cos(a) * 2.18,
          -Math.sin(a),
          0,
          Math.cos(a),
          a / TAU,
          (y - WALL_BOT) / (SHAFT_H - WALL_BOT),
        ];
        // Runs below the plate to the wall top, sealing the corbel band
        sink.quad(
          iv(a0, SHAFT_H - 0.1),
          iv(a1, SHAFT_H - 0.1),
          iv(a1, MUR_TOP),
          iv(a0, MUR_TOP),
        );
      }
      bag.add("inner", sink.build());
    }
    // Glazing bars: 12 verticals, sill/transom/top rings
    const glzH = GLAZE_TOP - MUR_TOP;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      const g = box(0.075, glzH, 0.075, 0, MUR_TOP + glzH / 2, 0);
      g.rotateY(-a);
      g.translate(Math.sin(a) * 2.19, 0, -Math.cos(a) * 2.19);
      bag.add("iron", g, [0.85, 0.86, 0.9]);
    }
    bag.add("iron", ring(2.19, 0.05, MUR_TOP + 0.03, segs), [0.85, 0.86, 0.9]);
    bag.add("iron", ring(2.19, 0.04, 22.2, segs), [0.85, 0.86, 0.9]);
    bag.add(
      "iron",
      ring(2.19, 0.05, GLAZE_TOP - 0.03, segs),
      [0.85, 0.86, 0.9],
    );
    // Glass drum (slight green tint, glows at night when the lamp runs)
    {
      const g = new THREE.CylinderGeometry(
        2.16,
        2.16,
        glzH - 0.04,
        segs,
        1,
        true,
      );
      g.translate(0, (MUR_TOP + GLAZE_TOP) / 2, 0);
      bag.add("glass", g);
    }
    // Cornice + copper dome + vent ball + lightning finial
    bag.add(
      "copper",
      remapV(
        lathe(
          [
            [2.2, GLAZE_TOP],
            [2.5, 23.42],
            [2.56, 23.55],
            [2.5, 23.66],
            [2.44, 23.72],
          ],
          segs,
        ),
        23.35,
        2.6,
      ),
      [0.8, 0.8, 0.8],
    );
    const dome: Array<readonly [number, number]> = [];
    for (let i = 0; i <= 9; i++) {
      const p = (i / 9) * (Math.PI / 2);
      dome.push([2.44 * Math.cos(p), 23.72 + 2.1 * Math.sin(p)]);
    }
    bag.add("copper", remapV(lathe(dome, segs), 23.72, 2.1));
    // Inner dome soffit: a slightly smaller shell with the profile reversed
    // (apex first), so its faces and normals point down into the lamp room -
    // a real painted-iron ceiling instead of a see-through culled dome
    const soffit: Array<readonly [number, number]> = [];
    for (let i = 9; i >= 0; i--) {
      const p = (i / 9) * (Math.PI / 2);
      soffit.push([2.34 * Math.cos(p), 23.42 + 1.9 * Math.sin(p)]);
    }
    bag.add("ironIn", lathe(soffit, segs), [0.66, 0.65, 0.62]);
    bag.add(
      "copper",
      regionUv(
        cylBetween(0, 25.72, 0, 0, 26.42, 0, 0.055, this.seg(8, 6)),
        [0.3, 0.4, 0.5, 0.6],
      ),
      [0.75, 0.72, 0.7],
    );
    const ball = new THREE.SphereGeometry(
      0.27,
      this.seg(16, 10),
      this.seg(12, 8),
    );
    ball.translate(0, 26.6, 0);
    bag.add("copper", regionUv(ball, [0.2, 0.45, 0.6, 0.75]));
    const spike = new THREE.ConeGeometry(0.045, 0.85, this.seg(8, 6));
    spike.translate(0, 27.25, 0);
    bag.add("copper", regionUv(spike, [0.3, 0.4, 0.5, 0.6]), [0.7, 0.68, 0.66]);
  }

  /** Cast-iron spiral stair: treads, brackets, balusters, two handrails. */
  private buildStair(bag: Bag): void {
    const N = Math.round(A_MAX / 0.281);
    const dA = A_MAX / N;
    const IRON: Tint = [0.98, 1.0, 1.02];
    const DARK: Tint = [0.78, 0.79, 0.82];
    for (let s = 0; s < N; s++) {
      const aMid = (s + 0.5) * dA;
      const ang = STAIR_A0 + aMid;
      const y = SLOPE * aMid;
      const rWall = innerR(y) + 0.05;
      const len = rWall - STAIR_IN + 0.08;
      const rc = (STAIR_IN - 0.08 + rWall) / 2;
      const wid = dA * rWall + 0.07;
      const tread = box(wid, 0.05, len);
      tread.rotateY(-ang);
      tread.translate(Math.sin(ang) * rc, y - 0.025, -Math.cos(ang) * rc);
      const tone = 0.92 + (s % 3) * 0.05;
      bag.add("ironIn", tread, [
        IRON[0] * tone,
        IRON[1] * tone,
        IRON[2] * tone,
      ]);
      // Bracket under the outer nose
      const br = box(0.05, 0.16, 0.3);
      br.rotateY(-ang);
      br.translate(
        Math.sin(ang) * (rWall - 0.2),
        y - 0.13,
        -Math.cos(ang) * (rWall - 0.2),
      );
      bag.add("ironIn", br, DARK);
      // Baluster every second tread
      if (s % 2 === 0) {
        const bx = Math.sin(ang) * 1.44;
        const bz = -Math.cos(ang) * 1.44;
        bag.add(
          "ironIn",
          cylBetween(bx, y - 0.02, bz, bx, y + 0.92, bz, 0.018, 5),
          DARK,
        );
      }
    }
    // Handrails: inner helix at the well, outer helix on wall brackets
    const railSeg = Math.max(48, Math.round(N * this.det));
    let px = 0;
    let py = 0;
    let pz = 0;
    let qx = 0;
    let qy = 0;
    let qz = 0;
    for (let s = 0; s <= railSeg; s++) {
      const a = (s / railSeg) * A_MAX;
      const ang = STAIR_A0 + a;
      const y = SLOPE * a;
      const ix = Math.sin(ang) * 1.45;
      const iz = -Math.cos(ang) * 1.45;
      const iy = y + 0.95;
      const rw = innerR(y) - 0.1;
      const ox = Math.sin(ang) * rw;
      const oz = -Math.cos(ang) * rw;
      const oy = y + 0.98;
      if (s > 0) {
        bag.add("ironIn", cylBetween(px, py, pz, ix, iy, iz, 0.035, 6), IRON);
        bag.add("ironIn", cylBetween(qx, qy, qz, ox, oy, oz, 0.03, 5), IRON);
        if (s % 6 === 0) {
          const wx = Math.sin(ang) * (rw + 0.13);
          const wz = -Math.cos(ang) * (rw + 0.13);
          bag.add(
            "ironIn",
            cylBetween(ox, oy - 0.02, oz, wx, oy - 0.06, wz, 0.014, 5),
            DARK,
          );
        }
      }
      px = ix;
      py = iy;
      pz = iz;
      qx = ox;
      qy = oy;
      qz = oz;
    }
    // Newel post at the foot
    const nx = Math.sin(STAIR_A0 - 0.08) * 1.45;
    const nz = -Math.cos(STAIR_A0 - 0.08) * 1.45;
    bag.add(
      "ironIn",
      cylBetween(nx, 0, nz, nx, 0.98, nz, 0.05, this.seg(8, 6)),
      DARK,
    );
    const ballG = new THREE.SphereGeometry(0.07, 8, 6);
    ballG.translate(nx, 1.02, nz);
    bag.add("ironIn", ballG, DARK);
    // Clockwork weight tube down the axis of the well
    bag.add(
      "ironIn",
      cylBetween(0, 0.02, 0, 0, LAMP_FLOOR - 0.08, 0, 0.13, this.seg(12, 8)),
      [0.86, 0.88, 0.92],
    );
    const plinth = new THREE.CylinderGeometry(0.3, 0.34, 0.26, this.seg(14, 9));
    plinth.translate(0, 0.13, 0);
    bag.add("ironIn", plinth, DARK);
    for (const y of [5, 10, 15]) {
      bag.add("ironIn", ring(0.145, 0.02, y, this.seg(12, 8)), DARK);
    }
  }

  /** Lamp-room floor plate with the stair hatch, its rails, the pedestal. */
  private buildLampRoom(bag: Bag): void {
    const sink = new Sink();
    const n = this.seg(COLS, 28);
    const rings = [0, 0.55, 1.05, 1.65, 2.28];
    const inHatch = (a: number): boolean => {
      let d = TOP_ANG - a;
      d -= Math.floor(d / TAU) * TAU;
      return d <= HATCH_ARC;
    };
    const fv = (a: number, r: number, top: boolean): Vtx => [
      Math.sin(a) * r,
      top ? LAMP_FLOOR : LAMP_FLOOR - 0.05,
      -Math.cos(a) * r,
      0,
      top ? 1 : -1,
      0,
      Math.sin(a) * r * 0.4,
      -Math.cos(a) * r * 0.4,
    ];
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * TAU;
      const a1 = ((i + 1) / n) * TAU;
      const aMid = (a0 + a1) / 2;
      for (let k = 0; k + 1 < rings.length; k++) {
        if (rings[k] >= 1.0 && inHatch(aMid)) continue;
        const r0 = rings[k];
        const r1 = rings[k + 1];
        sink.quad(
          fv(a0, r0, true),
          fv(a0, r1, true),
          fv(a1, r1, true),
          fv(a1, r0, true),
        );
        sink.quad(
          fv(a0, r0, false),
          fv(a1, r0, false),
          fv(a1, r1, false),
          fv(a0, r1, false),
        );
      }
    }
    bag.add("ironIn", sink.build(), [0.88, 0.9, 0.94]);
    // Hatch coaming and guard rail (the walk-off edge at TOP_ANG stays open)
    const DARK: Tint = [0.78, 0.79, 0.82];
    for (const edge of [TOP_ANG, TOP_ANG - HATCH_ARC]) {
      const g = box(0.06, 0.12, 1.3);
      g.rotateY(Math.PI / 2 - edge);
      g.translate(
        Math.sin(edge) * 1.68,
        LAMP_FLOOR + 0.04,
        -Math.cos(edge) * 1.68,
      );
      bag.add("ironIn", g, DARK);
    }
    {
      const a = TOP_ANG - HATCH_ARC;
      for (const r of [1.18, 2.15]) {
        const x = Math.sin(a) * r;
        const z = -Math.cos(a) * r;
        bag.add(
          "ironIn",
          cylBetween(x, LAMP_FLOOR, z, x, LAMP_FLOOR + 0.92, z, 0.022, 5),
          DARK,
        );
      }
      const x0 = Math.sin(a) * 1.18;
      const z0 = -Math.cos(a) * 1.18;
      const x1 = Math.sin(a) * 2.15;
      const z1 = -Math.cos(a) * 2.15;
      bag.add(
        "ironIn",
        cylBetween(
          x0,
          LAMP_FLOOR + 0.92,
          z0,
          x1,
          LAMP_FLOOR + 0.92,
          z1,
          0.028,
          5,
        ),
        DARK,
      );
      bag.add(
        "ironIn",
        cylBetween(
          x0,
          LAMP_FLOOR + 0.5,
          z0,
          x1,
          LAMP_FLOOR + 0.5,
          z1,
          0.022,
          5,
        ),
        DARK,
      );
    }
    // Lens pedestal with the clockwork drum
    bag.add(
      "ironIn",
      lathe(
        [
          [0.55, LAMP_FLOOR],
          [0.52, LAMP_FLOOR + 0.06],
          [0.34, LAMP_FLOOR + 0.14],
          [0.3, LAMP_FLOOR + 0.5],
          [0.42, LAMP_FLOOR + 0.6],
          [0.42, LAMP_FLOOR + 0.78],
          [0.3, LAMP_FLOOR + 0.86],
          [0.34, LAMP_FLOOR + 1.02],
          [0.52, LAMP_FLOOR + 1.1],
          [0.55, LAMP_FLOOR + 1.15],
          [0, LAMP_FLOOR + 1.15],
        ],
        this.seg(24, 14),
      ),
      [0.85, 0.86, 0.9],
    );
  }

  /** Keeper's clutter at ground level. */
  private buildClutter(bag: Bag): void {
    const deskA = 5.5;
    const dx = Math.sin(deskA) * 2.55;
    const dz = -Math.cos(deskA) * 2.55;
    const yawD = -deskA;
    const place = (
      g: THREE.BufferGeometry,
      lx: number,
      ly: number,
      lz: number,
      yaw = 0,
    ): THREE.BufferGeometry => {
      g.rotateY(yaw + yawD);
      const c = Math.cos(yawD);
      const s = Math.sin(yawD);
      g.translate(dx + lx * c + lz * s, ly, dz - lx * s + lz * c);
      return g;
    };
    const PLANK = LH_DRESS_UV.planks;
    // Desk: top + four legs
    bag.add(
      "dressIn",
      place(regionUv(box(1.0, 0.05, 0.62), PLANK), 0, 0.76, 0),
    );
    for (const [lx, lz] of [
      [-0.44, -0.25],
      [0.44, -0.25],
      [-0.44, 0.25],
      [0.44, 0.25],
    ]) {
      bag.add(
        "dressIn",
        place(regionUv(box(0.06, 0.74, 0.06), PLANK), lx, 0.37, lz),
        [0.8, 0.78, 0.75],
      );
    }
    // Log book, enamel mug, lantern on the desk
    bag.add(
      "dressIn",
      place(
        regionUv(box(0.34, 0.05, 0.26), LH_DRESS_UV.book),
        -0.2,
        0.81,
        0.05,
        0.25,
      ),
    );
    {
      const mug = regionUv(
        new THREE.CylinderGeometry(0.042, 0.038, 0.09, this.seg(12, 8)),
        LH_DRESS_UV.oilcan,
      );
      bag.add("dressIn", place(mug, 0.28, 0.83, -0.12), [1.15, 1.12, 1.05]);
    }
    {
      const body = new THREE.CylinderGeometry(0.07, 0.08, 0.2, this.seg(10, 7));
      bag.add("ironIn", place(body, 0.18, 0.89, 0.16), [0.45, 0.44, 0.42]);
      const cap = new THREE.ConeGeometry(0.075, 0.07, this.seg(10, 7));
      bag.add("ironIn", place(cap, 0.18, 1.02, 0.16), [0.45, 0.44, 0.42]);
    }
    // Oil cans by the desk
    for (const [lx, lz, s] of [
      [-0.75, 0.1, 1],
      [-0.68, -0.28, 0.85],
    ]) {
      const can = regionUv(
        new THREE.CylinderGeometry(
          0.14 * s,
          0.15 * s,
          0.42 * s,
          this.seg(12, 8),
        ),
        LH_DRESS_UV.oilcan,
      );
      bag.add("dressIn", place(can, lx, 0.21 * s, lz, lx));
      const spout = new THREE.ConeGeometry(0.03, 0.14, 6);
      bag.add(
        "ironIn",
        place(spout, lx + 0.09, 0.45 * s, lz, 0),
        [0.85, 0.86, 0.88],
      );
    }
    // Coiled rope by the door
    {
      const a = -0.62;
      const rx = Math.sin(a) * 2.9;
      const rz = -Math.cos(a) * 2.9;
      for (let k = 0; k < 3; k++) {
        const t = regionUv(
          new THREE.TorusGeometry(0.3 - k * 0.02, 0.055, 6, this.seg(20, 12)),
          LH_DRESS_UV.rope,
        );
        t.rotateX(-Math.PI / 2);
        t.translate(rx, 0.06 + k * 0.09, rz);
        bag.add("dressIn", t);
      }
    }
    // Crates and a barrel under the low turn of the stair
    for (const [a, r, w, h, yaw] of [
      [2.05, 2.35, 0.62, 0.5, 0.2],
      [2.45, 2.5, 0.5, 0.42, 0.9],
    ]) {
      const g = regionUv(box(w, h, w * 0.9), PLANK);
      g.rotateY(yaw);
      g.translate(Math.sin(a) * r, h / 2, -Math.cos(a) * r);
      bag.add("dressIn", g, [0.9, 0.88, 0.84]);
    }
    {
      const barrel = regionUv(
        new THREE.CylinderGeometry(0.26, 0.3, 0.72, this.seg(14, 9)),
        LH_DRESS_UV.oilcan,
      );
      barrel.translate(Math.sin(3.0) * 2.4, 0.36, -Math.cos(3.0) * 2.4);
      bag.add("dressIn", barrel, [0.75, 0.72, 0.68]);
    }
  }

  /** Breaker cabinet, conduit up to the lamp, label, lever, indicator. */
  private buildBreaker(bag: Bag): void {
    const c = Math.cos(BRK_A);
    const s = Math.sin(BRK_A);
    const bx = s * BRK_R;
    const bz = -c * BRK_R;
    const yaw = -BRK_A;
    // Cabinet-local (lx right, lz towards the tower axis) -> tower-local
    const lp = (
      out: THREE.Vector3,
      lx: number,
      ly: number,
      lz: number,
    ): THREE.Vector3 => out.set(bx + lx * c - lz * s, ly, bz + lx * s + lz * c);
    const P = new THREE.Vector3();
    // Cabinet (front faces the tower axis, i.e. local +z after yaw)
    const cab = regionUv(box(0.55, 0.8, 0.2), LH_DRESS_UV.breaker);
    cab.rotateY(yaw);
    cab.translate(bx, BRK_Y, bz);
    bag.add("dressIn", cab);
    // Enamel label under the cabinet
    const label = regionUv(
      new THREE.PlaneGeometry(0.4, 0.12),
      LH_DRESS_UV.label,
    );
    label.rotateY(yaw);
    lp(P, 0, BRK_Y - 0.55, 0.105);
    label.translate(P.x, P.y, P.z);
    bag.add("dressIn", label);
    // Conduit from the cabinet top up the wall to the lamp-room floor
    let py = BRK_Y + 0.4;
    let prX = s * (innerR(py) - 0.06);
    let prZ = -c * (innerR(py) - 0.06);
    for (let y = 3.5; y <= LAMP_FLOOR + 0.5; y += 2.5) {
      const yy = Math.min(y, LAMP_FLOOR - 0.1);
      const rx = s * (innerR(yy) - 0.06);
      const rz = -c * (innerR(yy) - 0.06);
      bag.add(
        "ironIn",
        cylBetween(prX, py, prZ, rx, yy, rz, 0.035, 6),
        [0.98, 1.0, 1.02],
      );
      // saddle clamp
      const clampG = box(0.1, 0.05, 0.05);
      clampG.rotateY(-BRK_A);
      clampG.translate(rx, yy, rz);
      bag.add("ironIn", clampG, [0.78, 0.79, 0.82]);
      prX = rx;
      prZ = rz;
      py = yy;
      if (yy >= LAMP_FLOOR - 0.1) break;
    }
    // Lever (separate mesh â€“ it throws with the switch)
    const leverG = mergeGeometries(
      [
        nonIndexed(box(0.055, 0.055, 0.3, 0, 0, 0.15)),
        nonIndexed(new THREE.SphereGeometry(0.05, 8, 6).translate(0, 0, 0.31)),
      ],
      false,
    );
    if (leverG) {
      const lever = new THREE.Mesh(leverG, this.mats.ironIn);
      lever.castShadow = true;
      // Hinge on the cabinet's right-hand side, throw in the vertical plane
      lp(P, 0.2, BRK_Y - 0.06, 0.13);
      lever.position.copy(P);
      lever.rotation.order = "YXZ";
      lever.rotation.y = yaw;
      lever.rotation.x = 0.6;
      this.lever = lever;
      this.interior.add(lever);
    }
    // Indicator jewel on the cabinet face above the lever
    this.indMat = new THREE.MeshBasicMaterial({ color: 0x8c2020 });
    const ind = new THREE.Mesh(
      new THREE.SphereGeometry(0.032, 8, 6),
      this.indMat,
    );
    lp(P, -0.15, BRK_Y + 0.26, 0.115);
    ind.position.copy(P);
    this.interior.add(ind);
    this.meshes.push(ind);
    // Interaction point: a step into the room from the cabinet face
    lp(P, 0, BRK_Y, 0.35);
    this.brkWorld.set(CX + P.x, this.floorYw + BRK_Y, CZ + P.z);
  }

  /** The heavy studded door on its pivot. */
  private buildDoor(): void {
    const parts: THREE.BufferGeometry[] = [];
    const leaf = regionUv(
      box(1.02, 2.24, 0.07, 0.51, 1.12, 0),
      LH_DRESS_UV.door,
    );
    parts.push(nonIndexed(leaf));
    for (const y of [0.5, 1.85]) {
      parts.push(
        nonIndexed(
          regionUv(box(0.94, 0.16, 0.045, 0.51, y, 0.055), LH_DRESS_UV.planks),
        ),
      );
    }
    // Ring handle on the lock side
    const handle = regionUv(
      new THREE.TorusGeometry(0.06, 0.014, 5, 10),
      LH_DRESS_UV.steel,
    );
    handle.rotateX(0.4);
    handle.translate(0.88, 1.12, -0.06);
    parts.push(nonIndexed(handle));
    this.doorWorld.set(CX, this.floorYw + 1.1, CZ - 3.75);
    const g = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    if (!g) return;
    const n = g.getAttribute("position").count;
    const col = new Float32Array(n * 3).fill(1);
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const mesh = new THREE.Mesh(g, this.mats.dress);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const pivot = new THREE.Group();
    pivot.position.set(-0.51, 0.02, -3.62);
    pivot.add(mesh);
    this.doorPivot = pivot;
    this.group.add(pivot);
  }

  /** Rotating first-order lens with its brass cage and burner. */
  private buildLens(): void {
    const lensGroup = new THREE.Group();
    lensGroup.position.set(0, LAMP_FLOOR + 1.15, 0);
    this.lensGroup = lensGroup;
    this.group.add(lensGroup);
    const seg = this.seg(32, 18);
    // Glass: sawtooth lathe â€“ dioptric belt with prism rings above and below
    const prof: Array<readonly [number, number]> = [
      [0.3, 0.02],
      [0.52, 0.08],
      [0.47, 0.17],
      [0.56, 0.24],
      [0.5, 0.33],
      [0.6, 0.4],
      [0.55, 0.5],
      [0.66, 0.58],
      [0.7, 0.72],
      [0.7, 0.98],
      [0.66, 1.12],
      [0.55, 1.2],
      [0.6, 1.28],
      [0.5, 1.36],
      [0.54, 1.44],
      [0.42, 1.52],
      [0.46, 1.58],
      [0.3, 1.66],
      [0.18, 1.7],
    ];
    const glassG = lathe(prof, seg);
    const glass = new THREE.Mesh(glassG, this.lensGlassMat);
    glass.renderOrder = 1;
    lensGroup.add(glass);
    // Cage: rings + two bow ribs framing the bi-valve panels + burner
    const cage: THREE.BufferGeometry[] = [];
    cage.push(nonIndexed(ring(0.64, 0.04, 0.05, seg)));
    cage.push(nonIndexed(ring(0.72, 0.028, 0.62, seg)));
    cage.push(nonIndexed(ring(0.72, 0.028, 1.08, seg)));
    cage.push(nonIndexed(ring(0.37, 0.035, 1.66, seg)));
    const ribR = [0.58, 0.68, 0.74, 0.68, 0.4];
    const ribY = [0.06, 0.45, 0.85, 1.25, 1.64];
    for (const phi of [0, Math.PI]) {
      for (let i = 0; i + 1 < ribR.length; i++) {
        cage.push(
          nonIndexed(
            cylBetween(
              Math.sin(phi) * ribR[i],
              ribY[i],
              -Math.cos(phi) * ribR[i],
              Math.sin(phi) * ribR[i + 1],
              ribY[i + 1],
              -Math.cos(phi) * ribR[i + 1],
              0.025,
              5,
            ),
          ),
        );
      }
    }
    const burner = new THREE.CylinderGeometry(0.075, 0.09, 0.34, 10);
    burner.translate(0, 0.72, 0);
    cage.push(nonIndexed(burner));
    const cageG = mergeGeometries(cage, false);
    for (const c of cage) c.dispose();
    if (cageG) {
      const nc = cageG.getAttribute("position").count;
      const col = new Float32Array(nc * 3);
      for (let i = 0; i < nc; i++) {
        col[i * 3] = 0.95;
        col[i * 3 + 1] = 0.82;
        col[i * 3 + 2] = 0.55;
      }
      cageG.setAttribute("color", new THREE.BufferAttribute(col, 3));
      const cageMesh = new THREE.Mesh(cageG, this.mats.ironIn);
      cageMesh.castShadow = false;
      lensGroup.add(cageMesh);
    }
    // Bright core at the focal point (interior views)
    this.coreMat = new THREE.MeshBasicMaterial({ color: 0x241d16 });
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.105, 10, 8),
      this.coreMat,
    );
    core.position.set(0, LAMP_Y, 0);
    this.interior.add(core);
    this.meshes.push(core);
  }

  /** Two opposed volumetric beams + the glare billboard. */
  private buildBeams(): void {
    const L = 230;
    const coneA = new THREE.CylinderGeometry(17, 0.5, L, 20, 6, true);
    coneA.translate(0, L / 2, 0);
    coneA.rotateX(Math.PI / 2);
    coneA.rotateX(0.012); // a hair below horizontal
    const coneB = coneA.clone();
    coneB.rotateY(Math.PI);
    const merged = mergeGeometries(
      [nonIndexed(coneA), nonIndexed(coneB)],
      false,
    );
    if (!merged) return;
    this.beamMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(1.0, 0.82, 0.58) },
        uI: { value: 0 },
        uTime: { value: 0 },
      },
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      fog: false,
    });
    const beams = new THREE.Mesh(merged, this.beamMat);
    beams.position.set(0, LAMP_Y, 0);
    beams.renderOrder = 14;
    beams.frustumCulled = false;
    beams.visible = false;
    this.beams = beams;
    this.group.add(beams);

    this.glareMat = new THREE.SpriteMaterial({
      map: lighthouseGlareTexture(),
      color: 0xffe0b0,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    });
    const glare = new THREE.Sprite(this.glareMat);
    glare.position.set(0, LAMP_Y, 0);
    glare.renderOrder = 15;
    glare.visible = false;
    this.glare = glare;
    this.group.add(glare);
  }

  /** The keeper's key on a nail inside the Keld Bothy. */
  private buildKey(): void {
    const site = bothySite();
    this.keyGroup.position.set(site.x, site.floorY, site.z);
    this.keyGroup.rotation.y = site.yaw;
    // Interior face of the bothy's front wall, east of the door
    // (mirrors place-bothy.ts: HW=1.85, T=0.5, door at x 0.65..1.55)
    const lx = 1.98;
    const ly = 1.48;
    const lz = 1.32;
    const parts: THREE.BufferGeometry[] = [];
    // Nail driven into the joint, slightly up
    const nail = new THREE.CylinderGeometry(0.006, 0.004, 0.07, 6);
    nail.rotateX(Math.PI / 2 - 0.18);
    nail.translate(lx, ly + 0.035, lz + 0.02);
    parts.push(nonIndexed(nail));
    // Bow ring hanging on the nail
    const bow = new THREE.TorusGeometry(0.03, 0.008, 6, 12);
    bow.translate(lx, ly + 0.01, lz);
    parts.push(nonIndexed(bow));
    // Shaft + collar + two ward teeth
    const shaft = new THREE.CylinderGeometry(0.007, 0.007, 0.1, 6);
    shaft.translate(lx, ly - 0.07, lz);
    parts.push(nonIndexed(shaft));
    const collar = new THREE.CylinderGeometry(0.011, 0.011, 0.012, 6);
    collar.translate(lx, ly - 0.035, lz);
    parts.push(nonIndexed(collar));
    parts.push(nonIndexed(box(0.02, 0.03, 0.006, lx + 0.012, ly - 0.11, lz)));
    parts.push(
      nonIndexed(box(0.012, 0.018, 0.006, lx + 0.008, ly - 0.085, lz)),
    );
    const g = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    if (!g) return;
    this.keyMat = new THREE.MeshStandardMaterial({
      color: 0xc0983e,
      metalness: 0.85,
      roughness: 0.32,
    });
    const mesh = new THREE.Mesh(g, this.keyMat);
    mesh.castShadow = true;
    this.keyGroup.add(mesh);
    this.meshes.push(mesh);
    // World position for the interaction
    const c = Math.cos(site.yaw);
    const s = Math.sin(site.yaw);
    this.keyWorld.set(
      site.x + lx * c + lz * s,
      site.floorY + ly,
      site.z - lx * s + lz * c,
    );
  }

  // -------------------------------------------------------------------------
  // Quest actions
  // -------------------------------------------------------------------------

  private takeKey(): void {
    const st = useGame.getState();
    if (st.lighthouse.hasKey) return;
    sound.keyJingle();
    st.setLighthouse({ hasKey: true });
    this.keyGroup.visible = false;
    this.hasKey = true;
    st.toast("An old brass key â€” stamped 'SALTREACH LIGHT'.", "good");
    st.float("Keeper's key found", "#eab308");
  }

  private tryDoor(): void {
    const st = useGame.getState();
    sound.switchThunk(false);
    st.toast(
      "Locked fast. The keeper's key must still be about â€” perhaps in the old bothy.",
      "warn",
    );
  }

  private unlockDoor(): void {
    const st = useGame.getState();
    if (st.lighthouse.unlocked) return;
    sound.unlockClunk();
    st.setLighthouse({ unlocked: true });
    this.unlocked = true;
    clearColliderSet("lighthouse-door");
    st.toast("The lock gives. The lighthouse is open.", "good");
  }

  private toggleLamp(): void {
    const st = useGame.getState();
    const on = !st.lighthouse.lampOn;
    sound.switchThunk(on);
    st.setLighthouse({ lampOn: on });
    this.lampOn = on;
    this.actLamp.prompt = on
      ? "Switch the main light off"
      : "Switch the main light on";
    this.applyIndicator();
    st.toast(
      on ? "The lamp motor hums into life." : "The lamp winds down.",
      on ? "good" : "info",
    );
  }

  private applyIndicator(): void {
    this.indMat?.color.set(this.lampOn ? 0x2fbf5a : 0x8c2020);
  }

  private applyDoor(): void {
    if (!this.doorPivot) return;
    const t = this.doorT;
    const e = t * t * (3 - 2 * t);
    this.doorPivot.rotation.y = -1.98 * e;
  }

  /** Reconcile with the store (dev harness / load may drive it directly). */
  private syncState(): void {
    const ls = useGame.getState().lighthouse;
    if (ls.hasKey !== this.hasKey) {
      this.hasKey = ls.hasKey;
      this.keyGroup.visible = !ls.hasKey;
    }
    if (ls.unlocked && !this.unlocked) {
      this.unlocked = true;
      clearColliderSet("lighthouse-door");
    }
    if (ls.lampOn !== this.lampOn) {
      this.lampOn = ls.lampOn;
      this.actLamp.prompt = this.lampOn
        ? "Switch the main light off"
        : "Switch the main light on";
      this.applyIndicator();
    }
  }

  // -------------------------------------------------------------------------
  // Per-frame update
  // -------------------------------------------------------------------------

  update(dt: number, env: Environment, camPos: THREE.Vector3): void {
    this.syncState();

    // Door swing (â‰ˆ1.2 s once unlocked)
    if (this.unlocked && this.doorT < 1) {
      this.doorT = Math.min(1, this.doorT + dt / 1.2);
      this.applyDoor();
    }
    // Lever throw
    const lTarget = this.lampOn ? 1 : 0;
    if (this.leverT !== lTarget) {
      this.leverT +=
        Math.sign(lTarget - this.leverT) *
        Math.min(dt / 0.22, Math.abs(lTarget - this.leverT));
      if (this.lever) this.lever.rotation.x = 0.6 - 1.2 * this.leverT;
    }

    // Lamp warm-up and rotation spin-up / spin-down
    if (this.lampOn) {
      this.warm = Math.min(1, this.warm + dt / 2.2);
      this.spin = Math.min(1, this.spin + dt / 3.6);
    } else {
      this.warm = Math.max(0, this.warm - dt / 2.6);
      this.spin = Math.max(0, this.spin - dt / 5);
    }
    const warm = this.warm;
    const spin = this.spin;
    if (spin > 0) {
      this.beamAngle = (this.beamAngle + ROT_SPEED * spin * spin * dt) % TAU;
      if (this.lensGroup) this.lensGroup.rotation.y = this.beamAngle;
      if (this.beams) this.beams.rotation.y = this.beamAngle;
    }

    // Environment response
    const night = 1 - env.skyLight;
    const nf = night * night;
    const storm = env.rain > 0.72 ? (env.rain - 0.72) / 0.28 : 0;
    const scatterK = env.rain * 0.9 + env.cloud * 0.28 + storm * 0.3;
    const dx = camPos.x - CX;
    const dz = camPos.z - CZ;
    const dist2 = dx * dx + dz * dz;
    const dist = Math.sqrt(dist2);
    // Manual fog attenuation for the additive effects (ShaderMaterial has
    // fog off): matches FogExp2 loosely, floored so the night flash carries
    const fogAtt = Math.max(
      0.3,
      Math.exp(-((dist * env.fog.density) ** 2) * 1.6),
    );

    this.interior.visible = dist2 < 80 * 80;

    if (this.beamMat && this.beams) {
      const on = warm > 0.02;
      this.beams.visible = on;
      if (on) {
        const uI =
          warm *
          (0.045 + 0.955 * nf ** 1.4) *
          (0.55 + scatterK * 0.9) *
          fogAtt *
          1.35;
        this.beamMat.uniforms.uI.value = Math.min(2.2, uI);
        this.beamMat.uniforms.uTime.value = env.envTime;
        const shorten = 1 / (1 + env.rain * 1.15 + env.cloud * 0.3);
        this.beams.scale.z = Math.max(0.42, shorten);
      }
    }

    // Glare billboard: base glow + the flash when a beam crosses the camera
    if (this.glareMat && this.glare) {
      const on = warm > 0.02 && dist > 3;
      this.glare.visible = on;
      if (on) {
        const inv = 1 / Math.max(1e-4, dist);
        const dirX = dx * inv;
        const dirZ = dz * inv;
        const cosd = Math.abs(
          Math.sin(this.beamAngle) * dirX + Math.cos(this.beamAngle) * dirZ,
        );
        const flash = clamp01((cosd - 0.9935) / 0.0065) ** 2;
        const halo = cosd ** 30 * 0.4;
        const base = 0.16 + nf * 0.5;
        const o =
          warm *
          (0.04 + nf * 0.96) *
          (base + (flash + halo) * (0.9 + scatterK * 0.5)) *
          Math.max(0.42, fogAtt);
        this.glareMat.opacity = Math.min(1, o);
        const scale =
          (1.6 + dist * 0.016) * (1 + (flash * 2.2 + halo) * (0.8 + nf));
        this.glare.scale.set(scale, scale * 0.62, 1);
      }
    }

    // Rotating spotlight rakes the terrain at night; off by day
    if (this.spot && this.spotTarget) {
      const spotI = warm * nf * (1 - env.rain * 0.2) * 2400;
      this.spot.visible = spotI > 1;
      if (this.spot.visible) {
        // Point along whichever of the two beams faces the camera side
        const d1 =
          Math.sin(this.beamAngle) * dx + Math.cos(this.beamAngle) * dz;
        const h = d1 >= 0 ? this.beamAngle : this.beamAngle + Math.PI;
        this.spot.intensity = spotI;
        this.spotTarget.position.set(
          Math.sin(h) * 150,
          LAMP_Y - 17,
          Math.cos(h) * 150,
        );
      }
    }
    if (this.lampLight) {
      const li = warm * (9 + nf * 26);
      this.lampLight.visible = li > 0.05 && this.interior.visible;
      this.lampLight.intensity = li;
    }

    // Glazing and lens glow
    this.glassMat.emissiveIntensity = warm * (0.05 + nf * 1.0);
    this.lensGlassMat.emissiveIntensity = warm * (0.3 + nf * 2.2);
    if (this.coreMat) {
      const k = 0.06 + warm * (1.2 + nf * 3.5);
      this.coreMat.color.setRGB(k, k * 0.84, k * 0.6);
    }
  }

  // -------------------------------------------------------------------------
  // Interaction
  // -------------------------------------------------------------------------

  interaction(
    playerPos: THREE.Vector3,
    camera: THREE.PerspectiveCamera,
  ): LighthouseInteraction | null {
    const ls = useGame.getState().lighthouse;
    let best: LighthouseInteraction | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    const consider = (
      target: THREE.Vector3,
      range: number,
      act: LighthouseInteraction,
    ): void => {
      const d = playerPos.distanceTo(target);
      if (d > range || d >= bestD) return;
      // A rough facing gate so prompts don't fire behind the player's back
      this.tmpV.copy(target).sub(playerPos);
      this.tmpV.y = 0;
      if (this.tmpV.lengthSq() > 0.16) {
        this.tmpV.normalize();
        camera.getWorldDirection(this.tmpFwd);
        this.tmpFwd.y = 0;
        this.tmpFwd.normalize();
        if (this.tmpV.dot(this.tmpFwd) < 0.05) return;
      }
      best = act;
      bestD = d;
    };
    if (!ls.hasKey) consider(this.keyWorld, 2.2, this.actKey);
    if (!ls.unlocked) {
      consider(this.doorWorld, 2.8, ls.hasKey ? this.actUnlock : this.actTry);
    } else {
      const dx = playerPos.x - CX;
      const dz = playerPos.z - CZ;
      const inside =
        dx * dx + dz * dz < 3.4 * 3.4 && playerPos.y < this.floorYw + 4;
      if (inside) consider(this.brkWorld, 2.1, this.actLamp);
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  dispose(): void {
    clearColliderSet("lighthouse");
    clearColliderSet("lighthouse-door");
    unregisterGround("lighthouse");
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      mesh.parent?.remove(mesh);
    }
    this.meshes.length = 0;
    if (this.doorPivot) {
      for (const child of this.doorPivot.children) {
        if (child instanceof THREE.Mesh) child.geometry.dispose();
      }
      this.group.remove(this.doorPivot);
    }
    if (this.lever) {
      this.lever.geometry.dispose();
      this.interior.remove(this.lever);
    }
    if (this.lensGroup) {
      for (const child of this.lensGroup.children) {
        if (child instanceof THREE.Mesh) child.geometry.dispose();
      }
      this.group.remove(this.lensGroup);
    }
    if (this.beams) {
      this.beams.geometry.dispose();
      this.group.remove(this.beams);
    }
    this.beamMat?.dispose();
    this.glareMat?.dispose();
    this.indMat?.dispose();
    this.coreMat?.dispose();
    this.keyMat?.dispose();
    this.glassMat.dispose();
    this.lensGlassMat.dispose();
    for (const m of Object.values(this.mats)) m.dispose();
    this.parent.remove(this.group);
    this.parent.remove(this.keyGroup);
    // Painted texture sets stay in the shared cache (station/camp convention)
  }
}
