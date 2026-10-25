// Trash Simulator – first-person viewmodel: bucket on its bail (pendulum with
// inertia), grabber (morph animation: jaws/trigger + telescope), gloves and
// sleeves, bucket contents as pooled InstancedMeshes.
//
// Structure (everything is parented to the camera):
//   root (shoulder pivot: bob, pitch coupling)
//     ├─ rightRig (position/rotation = grabber space): grabber, glove, sleeve
//     └─ leftRig (position = center of the bail's grip): glove, sleeve,
//          bucketSwing (hangs plumb, swings): bucket, bail, fillGroup
import * as THREE from "three";
import { groundHeight } from "./ground";
import { mulberry32 } from "./noise";
import {
  BUCKET,
  BUCKET_DENT_MAX,
  BUCKET_INNER_FLOOR,
  FILL_KINDS,
  type FillKind,
  GRABBER,
  SLEEVE_LEN,
  addMorphs,
  bailGeometry,
  bucketGeometry,
  bucketInnerRadius,
  fillKindGeometry,
  gloveGeometry,
  grabberGeometry,
  sleeveGeometry,
} from "./player-geometry";
import { useGame } from "./state";
import {
  applyPbr,
  pbrBrushedMetal,
  pbrBucket,
  pbrCanLabel,
  pbrCardboard,
  pbrGlass,
  pbrPaperCrumpled,
  pbrPlastic,
  pbrSeatFabric,
  pbrWood,
} from "./textures";
import { detectorSignal } from "./tools-detector";
import {
  DET_FACE_D,
  DET_FACE_W,
  DET_LCD_D,
  DET_LCD_PX_H,
  DET_LCD_PX_W,
  DET_LCD_W,
  coilTopTexture,
  detectorFaceTexture,
  gripFoamTexture,
  paintDetectorDisplay,
} from "./tools-detector-textures";
import { assemble } from "./trash-geo";
import { CATEGORIES, type CategoryId, TRASH_TYPES } from "./types";

export interface ViewInput {
  dt: number;
  bobX: number;
  bobY: number;
  bobPhase: number;
  bobAmp: number;
  sprint: boolean;
  pitch: number;
  yaw: number;
  grounded: boolean;
  active: boolean;
}

const MAX_SLOTS = 28;
const SLOTS_PER_LAYER = 7;
/** Baked shading of the bucket contents per layer (darkest at the bottom). */
const LAYER_AO = [0.32, 0.52, 0.72, 0.94];
/** Base size per fill-object kind (so everything fits into a 10 l bucket). */
const KIND_SCALE: Record<FillKind, number> = {
  can: 0.85,
  bottle: 0.64,
  box: 0.8,
  crumple: 1.15,
  plank: 0.8,
};

/** Shoulder pivot (camera space) for the bob roll and the pitch coupling. */
const SHOULDER = new THREE.Vector3(0, -0.5, 0.08);
const RIGHT_REST = new THREE.Vector3(0.28, -0.26, -0.46);
const RIGHT_ROT = new THREE.Vector3(0.04, 0.1, 0.32);
const RIGHT_EXTEND = new THREE.Vector3(-0.07, 0.05, -0.3);
const LEFT_REST = new THREE.Vector3(-0.37, -0.16, -0.55);
const BUCKET_YAW = 0.28;
const PEND_L = 0.32; // effective pendulum length
const PEND_G = 9.81;
const PEND_DAMP = 1.5;

// --- Metal detector (SANDLARK 40) ------------------------------------------
/** Control pod position/tilt in rig space (top tips back towards the eye). */
const DET_POD_POS = new THREE.Vector3(0, 0.012, 0);
const DET_POD_TILT = 0.42;
/** S-bend elbow where the lower rod is clamped – the shaft pivots here. */
const DET_PIVOT = new THREE.Vector3(0, -0.005, -0.075);
/** Rest length of the shaft, pivot → coil bolt (the rod telescopes ±). */
const DET_SHAFT_LEN = 1.45;
const DET_STRETCH_MIN = 0.78;
const DET_STRETCH_MAX = 1.18;
/** Clearance demanded at each of the coil's low-rim sample points. */
const DET_RIM_CLEAR = 0.02;
/**
 * Low points of the coil in coil-local space (centre + an ellipse just
 * outside the shell at its lowest y), flat-packed [x,y,z,...]. The pose
 * guard lifts the shaft until every one of them clears the real ground –
 * vertex-exact, so the rim cannot bury itself on cross-slope stances the
 * way a centre-only check allowed (half a coil width times the slope).
 */
const DET_COIL_RIM: readonly number[] = (() => {
  const pts = [0, -0.044, 0];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    pts.push(Math.cos(a) * 0.172, -0.044, Math.sin(a) * 0.224);
  }
  return pts;
})();
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

// --- Bucket contents: everything has to stay inside the shell -------------
/** Height of the fill origin above the bucket bottom (bucket space). */
const FILL_BASE_Y = 0.018;
/** The contents rock about their own middle, not about the bucket bottom. */
const FILL_PIVOT_Y = 0.1;
/** Jiggle of the contents against the swing: tilt = -swing * gain. */
const JIGGLE_GAIN = 0.1;
/** Hard bound of that tilt per axis (swX/swZ are clamped to ±0.5, plus idle). */
const JIGGLE_TILT = 0.052;
/** How much of the bucket's bounce the contents lag behind by. */
const BOUNCE_LAG = 0.15;
/**
 * Room the clamp reserves for the jiggle. A tilt of `t` about both axes moves
 * a point sideways by ≤ √2·t·d (d = distance above/below FILL_PIVOT_Y) and
 * vertically by ≤ √2·t·r (r = its radius):
 *   radial   √2 · 0.052 · 0.148 m = 10.9 mm  (wall ends 0.148 m above the pivot)
 *   vertical √2 · 0.052 · 0.09 m + 0.15 · 0.022 m = 9.9 mm  (radius near the
 *            bottom is at most 0.09 m after the clamp)
 */
const FILL_RADIAL_RESERVE = 0.011;
const FILL_VERTICAL_RESERVE = 0.012;
/** Extra safety gap between an object and the wall/bottom. */
const FILL_MARGIN = 0.002;
/** Smallest usable radius (bottom of the bucket) – used for the emergency fit. */
const FILL_R_WORST =
  bucketInnerRadius(BUCKET_INNER_FLOOR) -
  BUCKET_DENT_MAX -
  FILL_RADIAL_RESERVE -
  FILL_MARGIN;

interface FillDef {
  kind: number; // index into FILL_KINDS
  color: string;
  scale: [number, number, number];
}

const fd = (
  kind: FillKind,
  color: string,
  scale: [number, number, number] = [1, 1, 1],
): FillDef => ({ kind: FILL_KINDS.indexOf(kind), color, scale });

/** Trash type → mini object in the bucket (shape, color, proportions). */
const FILL_BY_TYPE: Record<string, FillDef> = {
  glass_green: fd("bottle", "#3f9a55"),
  glass_brown: fd("bottle", "#7a4a1d"),
  plastic_bottle: fd("bottle", "#cfe9f2"),
  can: fd("can", "#ffffff"),
  can_crushed: fd("can", "#f0f0f0", [1, 0.45, 1.15]),
  spray_can: fd("can", "#ffe6e6", [1.3, 0.8, 0.8]),
  coaster: fd("box", "#e8dcc0", [0.85, 0.08, 0.85]),
  newspaper: fd("box", "#dedad0", [1.3, 0.25, 1.5]),
  paper_ball: fd("crumple", "#ffffff"),
  cardboard: fd("box", "#ffffff"),
  plastic_bag: fd("crumple", "#dfe9ee", [1.3, 0.8, 1.3]),
  crisp_packet: fd("crumple", "#c8402a", [1.2, 0.7, 1.4]),
  plank: fd("plank", "#ffffff"),
  branch: fd("plank", "#6b4b2e", [0.9, 1.6, 0.55]),
  driftwood: fd("plank", "#a8a297", [1.1, 1.8, 1.3]),
  rubble: fd("crumple", "#9c968e", [1.1, 0.9, 1]),
  sheet_metal: fd("plank", "#8a6a55", [0.9, 0.35, 1.9]),
  cable: fd("crumple", "#2c2c30", [1.2, 0.6, 1.2]),
  fishing_line: fd("crumple", "#cfc7ae", [1, 0.5, 1]),
  net: fd("crumple", "#4f8f7f", [1.4, 0.6, 1.3]),
  canister: fd("bottle", "#d8b93c", [0.8, 1.5, 1.3]),
  drum: fd("bottle", "#3a6fb0", [0.6, 1.7, 1.7]),
  tool: fd("plank", "#4a4d52", [0.8, 0.7, 0.5]),
  flip_flop: fd("plank", "#e86aa0", [0.75, 0.6, 1.3]),
  old_bucket: fd("bottle", "#c9c3bb", [0.6, 1.7, 1.7]),
};

const FILL_BY_CATEGORY: Record<CategoryId, FillKind> = {
  GLASS: "bottle",
  PLASTIC: "crumple",
  METAL: "can",
  PAPER: "crumple",
  WOOD: "plank",
  STONE: "crumple",
  CHEMICALS: "bottle",
  GENERAL: "crumple",
};

interface Slot {
  /** Angle around the bucket axis (x = cos·r, z = sin·r). */
  angle: number;
  /** Desired radius – the clamp only ever pulls it inwards. */
  radius: number;
  /** Desired height in fill space – the clamp only ever lifts it. */
  y: number;
  quat: THREE.Quaternion;
  layer: number;
}

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

/**
 * Position of the grip cylinder in hand space: 7.5 cm above the wrist, far
 * enough in front of the palm plane (z = −0.0155) that it just touches it.
 * gloveGeometry wraps the fingers around it analytically.
 */
function handGrip(r: number): { y: number; z: number; r: number } {
  return { y: 0.075, z: -0.0175 - r, r };
}

/**
 * Hand matrix: grip axis (knuckle line, x_h), palm normal (points out of the
 * palm towards the grip) and grip center → basis + wrist position.
 * Hand space: +y towards the fingers, palm faces −z (see gloveGeometry).
 */
function handMatrix(
  gripCenter: THREE.Vector3,
  gripAxis: THREE.Vector3,
  palmNormal: THREE.Vector3,
  grip: { y: number; z: number },
): THREE.Matrix4 {
  const zh = palmNormal.clone().normalize().negate();
  const xh = gripAxis.clone();
  xh.addScaledVector(zh, -xh.dot(zh)).normalize();
  const yh = new THREE.Vector3().crossVectors(zh, xh);
  const wrist = gripCenter
    .clone()
    .addScaledVector(zh, -grip.z)
    .addScaledVector(yh, -grip.y);
  const m = new THREE.Matrix4().makeBasis(xh, yh, zh);
  m.setPosition(wrist);
  return m;
}

/** Convert a world direction into the hand space of the hand matrix (for the gauntlet). */
function handSpaceDir(hm: THREE.Matrix4, v: THREE.Vector3): THREE.Vector3 {
  const b = new THREE.Vector3();
  return new THREE.Vector3(
    v.dot(b.setFromMatrixColumn(hm, 0)),
    v.dot(b.setFromMatrixColumn(hm, 1)),
    v.dot(b.setFromMatrixColumn(hm, 2)),
  ).normalize();
}

/** Sleeve group at the wrist, its local −y axis points towards the elbow. */
function sleeveGroup(
  mesh: THREE.Mesh,
  wrist: THREE.Vector3,
  toElbow: THREE.Vector3,
): THREE.Group {
  const g = new THREE.Group();
  g.position.copy(wrist);
  g.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, -1, 0),
    toElbow.clone().normalize(),
  );
  g.add(mesh);
  return g;
}

export class PlayerViewmodel {
  readonly root = new THREE.Group();
  /** Target point inside the bucket (world position via getWorldPosition) for the ghost flight. */
  readonly dropPoint = new THREE.Object3D();

  private readonly camera: THREE.PerspectiveCamera;
  private readonly rightRig = new THREE.Group();
  private readonly leftRig = new THREE.Group();
  private readonly bucketSwing = new THREE.Group();
  private readonly fillGroup = new THREE.Group();
  private grabber!: THREE.Mesh;
  private rightGlove!: THREE.Mesh;
  private rightSleeve!: THREE.Group;
  private readonly materials: THREE.Material[] = [];
  private readonly meshes: THREE.Mesh[] = [];

  // Metal detector (marketplace upgrade): built lazily on first equip and
  // kept for the session – tool swaps only toggle visibility, so repeated
  // swapping allocates nothing and cannot leak. The shaft and coil are
  // posed per frame against the real ground height (updateDetectorPose),
  // so the coil can never clip into a slope.
  private detectorRoot: THREE.Group | null = null;
  private detShaft: THREE.Group | null = null;
  private detShaftMesh: THREE.Mesh | null = null;
  private detCoil: THREE.Group | null = null;
  private ledMat: THREE.MeshStandardMaterial | null = null;
  private glowMat: THREE.MeshBasicMaterial | null = null;
  private dispCtx: CanvasRenderingContext2D | null = null;
  private dispTex: THREE.CanvasTexture | null = null;
  private dispValue = 0;
  private dispShown = -1;
  private dispLocked = false;
  // Per-frame view inputs stashed for the detector pose (grabPose runs last)
  private inpDt = 1 / 60;
  private inpPitch = 0;
  private inpYaw = 0;
  private inpBobPhase = 0;
  private inpBobAmp = 0;
  private readonly dsPivot = new THREE.Vector3();
  private readonly dsTarget = new THREE.Vector3();
  private readonly dsDir = new THREE.Vector3();
  private readonly dsX = new THREE.Vector3();
  private readonly dsY = new THREE.Vector3();
  private readonly dsZ = new THREE.Vector3();
  private readonly dsN = new THREE.Vector3();
  private readonly dsM = new THREE.Matrix4();
  private readonly dsQ = new THREE.Quaternion();
  private readonly dsQ2 = new THREE.Quaternion();
  private readonly dsQ3 = new THREE.Quaternion();
  private readonly dsQ4 = new THREE.Quaternion();
  private readonly dsE = new THREE.Vector3();
  private readonly dsESm = new THREE.Vector3();
  private readonly dsS = new THREE.Vector3();
  private detPoseValid = false;

  // Fill
  private readonly kinds: THREE.InstancedMesh[] = [];
  private readonly kindCount = new Int32Array(FILL_KINDS.length);
  /** Result of measureShape() – lowest point / widest reach of an object. */
  private fitYMin = 0;
  private fitTMax = 0;
  private readonly slots: Slot[] = [];
  private readonly fillDefs = new Map<string, FillDef>();
  private readonly fillFallback: FillDef = fd("crumple", "#9a9a9a");

  // Rest pose of the right arm (computed per frame, the grab pose builds on it)
  private readonly rRest = new THREE.Vector3();
  private readonly rRestRot = new THREE.Vector3();
  private rootRx = 0;
  private rootRz = 0;
  private time = 0;

  // Pendulum
  private swX = 0;
  private swZ = 0;
  private swVX = 0;
  private swVZ = 0;
  private bounce = 0;
  private bounceV = 0;
  private hasPrev = false;
  private hasPrevVel = false;
  private wasGrounded = true;
  private readonly pivot = new THREE.Vector3();
  private readonly prevPivot = new THREE.Vector3();
  private readonly vel = new THREE.Vector3();
  private readonly prevVel = new THREE.Vector3();
  private readonly dv = new THREE.Vector3();

  private readonly tmpV = new THREE.Vector3();
  private readonly tmpS = new THREE.Vector3();
  private readonly tmpF = new THREE.Vector3();
  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpC = new THREE.Color();
  private readonly qA = new THREE.Quaternion();
  private readonly qB = new THREE.Quaternion();
  private readonly eul = new THREE.Euler();

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
    this.root.name = "viewmodel";
    this.rightRig.rotation.order = "YXZ";
    this.buildBucket();
    this.buildArms();
    this.buildGrabber();
    this.buildFill();
    this.root.add(this.rightRig, this.leftRig);
    this.root.traverse((o) => {
      o.frustumCulled = false;
      o.castShadow = false;
      o.receiveShadow = false;
    });
    camera.add(this.root);
    this.grabPose(0.12, 0, null, 0, 0);
  }

  // ---------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------

  private std(
    opts: THREE.MeshStandardMaterialParameters = {},
  ): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial(opts);
    this.materials.push(m);
    return m;
  }

  private mesh(
    geo: THREE.BufferGeometry,
    mat: THREE.Material | THREE.Material[],
  ): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    this.meshes.push(m);
    return m;
  }

  private buildBucket(): void {
    const bucketMat = this.std({ vertexColors: true });
    applyPbr(bucketMat, pbrBucket("#e8762c"));
    const bailMat = this.std();
    applyPbr(bailMat, pbrBrushedMetal("#9da2a7"), [6, 1]);
    bailMat.metalness = 0.55;
    this.bucketSwing.add(
      this.mesh(bucketGeometry(), bucketMat),
      this.mesh(bailGeometry(), bailMat),
      this.fillGroup,
      this.dropPoint,
    );
    this.dropPoint.position.set(0, -0.1, 0);
    this.fillGroup.position.set(0, -BUCKET.pivotH + FILL_BASE_Y, 0);
    this.leftRig.add(this.bucketSwing);
  }

  private buildArms(): void {
    // Worn leather glove (no high-vis yellow), matte and slightly sandy
    const gloveMat = this.std();
    applyPbr(gloveMat, pbrPlastic("#8a7057", { wear: 0.85 }), [2, 2]);
    gloveMat.roughness = 1.25;
    gloveMat.normalScale.set(1.4, 1.4);
    // Sleeve: seat fabric, but sampled in the seam-free v window (0.29..0.71)
    // so the texture's stitched-seam bands do not end up on the arm
    const sleeveMat = this.std();
    applyPbr(sleeveMat, pbrSeatFabric("#2f5a46"), [3, 0.42]);
    for (const t of [
      sleeveMat.map,
      sleeveMat.normalMap,
      sleeveMat.roughnessMap,
    ]) {
      if (t) t.offset.set(0, 0.29);
    }

    // Right hand on the pistol grip (palm faces left towards the grip)
    const gripR = handGrip(GRABBER.gripR);
    const hmR = handMatrix(
      GRABBER.gripCenter,
      GRABBER.gripAxis,
      new THREE.Vector3(-1, 0, 0),
      gripR,
    );
    const elbowR = new THREE.Vector3(0.1, -0.34, 0.94).normalize();
    const optsR = { knuckles: true, cuffDir: handSpaceDir(hmR, elbowR) };
    const gR = gloveGeometry(
      false,
      { grip: gripR, curl: 1, index: [1.15, 1.0, 0.75], thumb: 0.8 },
      optsR,
    );
    const gROpen = gloveGeometry(
      false,
      { grip: gripR, curl: 0.88, index: [0.9, 0.68, 0.48], thumb: 0.55 },
      optsR,
    );
    gR.applyMatrix4(hmR);
    gROpen.applyMatrix4(hmR);
    addMorphs(gR, [gROpen]);
    this.rightGlove = this.mesh(gR, gloveMat);
    const wristR = new THREE.Vector3().setFromMatrixPosition(hmR);
    this.rightSleeve = sleeveGroup(
      this.mesh(sleeveGeometry(0x5e11), sleeveMat),
      wristR,
      elbowR,
    );
    this.rightRig.add(this.rightGlove, this.rightSleeve);

    // Left hand: fist OVER the bail's grip (overhand grip). Back of the hand
    // on top, palm down onto the grip, the fingers reach around the far side
    // and the fingertips roll back underneath towards the wrist.
    // The bucket hangs from the grip rotated by BUCKET_YAW – the hand is
    // rotated by the same angle about the grip center, otherwise the grip
    // cylinder sits askew in the fist.
    const gripL = handGrip(BUCKET.gripR);
    const hmL = handMatrix(
      new THREE.Vector3(0, 0, 0),
      // Knuckle line along the grip; +x of the mirrored hand is the
      // thumb/index side, so it points to the right.
      new THREE.Vector3(1, 0, 0),
      // Palm almost straight down (just a touch backwards): that way the row
      // of knuckles rolls towards the camera and the wrapped fingers stay in
      // view instead of hiding behind the back of the hand. The wrist then
      // sits 3 cm above the grip and the forearm only bends slightly down and
      // back.
      new THREE.Vector3(0, -0.9986, -0.052),
      gripL,
    ).premultiply(new THREE.Matrix4().makeRotationY(BUCKET_YAW));
    // Noticeably steeper than the hand axis (the wrist bends) – otherwise the
    // forearm points at the camera and hides the fist
    const elbowL = new THREE.Vector3(-0.12, -0.55, 0.83).normalize();
    const gL = gloveGeometry(
      true,
      {
        grip: gripL,
        // The full wrap (≈230°) puts the fingertips underneath the grip –
        // exactly right for an overhand grip, the fist is closed.
        curl: 1,
        // The thumb lies lengthwise over the camera side of the grip sleeve
        thumb: 0.95,
      },
      {
        knuckles: true,
        thumbAcross: true,
        cuffDir: handSpaceDir(hmL, elbowL),
      },
    );
    gL.applyMatrix4(hmL);
    const wristL = new THREE.Vector3().setFromMatrixPosition(hmL);
    this.leftRig.add(
      this.mesh(gL, gloveMat),
      sleeveGroup(this.mesh(sleeveGeometry(0x1e77), sleeveMat), wristL, elbowL),
    );
  }

  private buildGrabber(): void {
    const metalMat = this.std();
    applyPbr(metalMat, pbrBrushedMetal("#c3c7cb"), [1, 3]);
    // Brush direction along the tube axis (v) instead of around the circumference (u)
    for (const t of [
      metalMat.map,
      metalMat.normalMap,
      metalMat.roughnessMap,
      metalMat.metalnessMap,
    ]) {
      if (!t) continue;
      t.center.set(0.5, 0.5);
      t.rotation = Math.PI / 2;
    }
    metalMat.metalness = 0.6;
    const darkMat = this.std();
    applyPbr(darkMat, pbrPlastic("#25272b", { wear: 0.3 }), [3, 3]);

    const base = grabberGeometry(0, 0);
    addMorphs(base, [grabberGeometry(1, 0), grabberGeometry(0, 1)]);
    this.grabber = this.mesh(base, [metalMat, darkMat]);
    this.rightRig.add(this.grabber);
  }

  /**
   * Hand-held metal detector (the fictional SANDLARK 40), in the same rig
   * space as the grabber – the right fist keeps gripping at
   * GRABBER.gripCenter. Layout of a modern hobby VLF machine:
   *
   *   arm cuff (foam-padded) ── S-bend stem ── foam grip + control pod
   *                                              └─ shaft pivot (elbow)
   *                                                   └─ detShaft: cam-lock,
   *                                                      telescoping rod,
   *                                                      spiral cable
   *                                                        └─ detCoil:
   *                                                           yoke + bolt,
   *                                                           double-D coil
   *
   * The pod carries a live LCD (canvas texture, repainted only when the
   * shown value changes) and the blinking signal lamp. detShaft/detCoil are
   * posed every frame in updateDetectorPose(): the shaft aims at a ground
   * target in front of the player, the rod telescopes to reach it, the coil
   * tilts to lie flat on the local slope and a vertex-exact rim guard lifts
   * the pose clear of the sand – so nothing clips into a dune face, at any
   * camera pitch or stance.
   */
  private buildDetector(): void {
    if (this.detectorRoot) return;
    const root = new THREE.Group();

    // Cylinder from a to b, radius r – merged parts helper.
    const tube = (
      a: THREE.Vector3,
      b: THREE.Vector3,
      r: number,
      seg = 10,
    ): THREE.BufferGeometry => {
      const dir = new THREE.Vector3().subVectors(b, a);
      const len = dir.length();
      const g = new THREE.CylinderGeometry(r, r, len, seg);
      const q = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        dir.normalize(),
      );
      g.applyQuaternion(q);
      const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
      g.translate(mid.x, mid.y, mid.z);
      return g;
    };

    // Materials --------------------------------------------------------------
    const aluMat = this.std();
    applyPbr(aluMat, pbrBrushedMetal("#c9ced2"), [1, 3]);
    for (const t of [
      aluMat.map,
      aluMat.normalMap,
      aluMat.roughnessMap,
      aluMat.metalnessMap,
    ]) {
      if (!t) continue;
      t.center.set(0.5, 0.5);
      t.rotation = Math.PI / 2; // brush along the tube axis
    }
    aluMat.metalness = 0.62;
    const stemMat = this.std();
    applyPbr(stemMat, pbrPlastic("#232629", { wear: 0.5 }), [2, 2]);
    const podMat = this.std();
    applyPbr(podMat, pbrPlastic("#2a2d31", { wear: 0.45 }), [2, 2]);
    const faceMat = this.std({ map: detectorFaceTexture(), roughness: 0.5 });
    const foamMat = this.std({ map: gripFoamTexture(), roughness: 1 });
    const coilMat = this.std();
    applyPbr(coilMat, pbrPlastic("#2e3237", { wear: 0.7 }), [2, 2]);
    const coilFaceMat = this.std({ map: coilTopTexture(), roughness: 0.85 });

    // Pod-local → rig transform (baked into the merged static parts).
    const podM = new THREE.Matrix4()
      .makeRotationX(DET_POD_TILT)
      .setPosition(DET_POD_POS);
    const inPod = (g: THREE.BufferGeometry): THREE.BufferGeometry =>
      g.applyMatrix4(podM);

    // Control pod: housing + face plate (+ two knurled knobs on the plate).
    const housing = inPod(new THREE.BoxGeometry(0.072, 0.046, 0.132));
    const facePlate = new THREE.PlaneGeometry(DET_FACE_W, DET_FACE_D);
    facePlate.rotateX(-Math.PI / 2);
    facePlate.translate(0, 0.0235, 0);
    inPod(facePlate);
    const knobs: THREE.BufferGeometry[] = [];
    for (const kx of [-0.0165, 0.0165]) {
      const k = new THREE.CylinderGeometry(0.0075, 0.008, 0.008, 12);
      k.translate(kx, 0.027, -0.016);
      knobs.push(inPod(k));
    }

    // Foam pistol grip around the fist line (an alu core pokes out at the
    // ends, with a squashed pommel ball at the bottom).
    const gripUp = GRABBER.gripAxis.clone().normalize().negate();
    const gc = GRABBER.gripCenter;
    const gripCore = new THREE.CylinderGeometry(0.0155, 0.0155, 0.12, 10);
    const gripQ = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      gripUp,
    );
    gripCore.applyQuaternion(gripQ);
    gripCore.translate(gc.x, gc.y, gc.z);
    const gripFoam = new THREE.CylinderGeometry(0.019, 0.019, 0.088, 12);
    gripFoam.applyQuaternion(gripQ);
    gripFoam.translate(gc.x, gc.y, gc.z);
    const pommel = new THREE.SphereGeometry(0.019, 10, 8);
    pommel.scale(1, 0.7, 1);
    pommel.applyQuaternion(gripQ);
    const pomAt = gc.clone().addScaledVector(gripUp, -0.06);
    pommel.translate(pomAt.x, pomAt.y, pomAt.z);

    // S-bend stem: from the arm cuff, down over the grip, under the pod and
    // out to the shaft pivot. Elbow balls smooth the kinks.
    const sPts = [
      new THREE.Vector3(0.012, 0.088, 0.3),
      new THREE.Vector3(0.004, 0.05, 0.205),
      new THREE.Vector3(0, 0.008, 0.115),
      new THREE.Vector3(0, -0.014, 0.03),
      new THREE.Vector3(0, -0.014, -0.03),
      DET_PIVOT.clone(),
    ];
    const stemParts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < sPts.length - 1; i++) {
      stemParts.push(tube(sPts[i], sPts[i + 1], 0.0085));
      if (i > 0) {
        const ball = new THREE.SphereGeometry(0.0088, 8, 6);
        ball.translate(sPts[i].x, sPts[i].y, sPts[i].z);
        stemParts.push(ball);
      }
    }

    // Arm cuff under the forearm: open shell + foam pad lining.
    const cuffAt = new THREE.Vector3(0.012, 0.095, 0.3);
    const cuffQ = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0.1, -0.3, 0.94).normalize(),
    );
    const cuff = new THREE.CylinderGeometry(
      0.05,
      0.05,
      0.1,
      14,
      1,
      true,
      Math.PI * 0.55,
      Math.PI * 0.9,
    );
    cuff.applyQuaternion(cuffQ);
    cuff.translate(cuffAt.x, cuffAt.y, cuffAt.z);
    const cuffPad = new THREE.CylinderGeometry(
      0.046,
      0.046,
      0.094,
      14,
      1,
      true,
      Math.PI * 0.58,
      Math.PI * 0.84,
    );
    cuffPad.applyQuaternion(cuffQ);
    cuffPad.translate(cuffAt.x, cuffAt.y, cuffAt.z);

    // Cable stub from the pod's underside towards the pivot (the spiral on
    // the rod picks it up a few millimetres further on).
    const cableStub = tube(
      new THREE.Vector3(0, -0.016, 0.02),
      new THREE.Vector3(0.004, -0.011, -0.058),
      0.0034,
      6,
    );

    const staticGeo = assemble(
      [
        ...stemParts.map((g) => ({ geo: g, mat: 0 })),
        { geo: cuff, mat: 0 },
        { geo: cableStub, mat: 0 },
        { geo: housing, mat: 1 },
        ...knobs.map((g) => ({ geo: g, mat: 1 })),
        { geo: facePlate, mat: 2 },
        { geo: gripFoam, mat: 3 },
        { geo: cuffPad, mat: 3 },
        { geo: pommel, mat: 0 },
        { geo: gripCore, mat: 4 },
      ],
      5,
    );
    root.add(this.mesh(staticGeo, [stemMat, podMat, faceMat, foamMat, aluMat]));

    // Live LCD + signal lamp sit on the tilted face plate.
    const podGroup = new THREE.Group();
    podGroup.position.copy(DET_POD_POS);
    podGroup.rotation.x = DET_POD_TILT;
    const dispCanvas = document.createElement("canvas");
    dispCanvas.width = DET_LCD_PX_W;
    dispCanvas.height = DET_LCD_PX_H;
    const ctx2d = dispCanvas.getContext("2d");
    if (ctx2d) {
      paintDetectorDisplay(ctx2d, 0, false);
      this.dispCtx = ctx2d;
    }
    const dispTex = new THREE.CanvasTexture(dispCanvas);
    dispTex.colorSpace = THREE.SRGBColorSpace;
    dispTex.anisotropy = 4;
    this.dispTex = dispTex;
    // Matte LCD: high roughness kills the sun glare that would otherwise
    // wash the readout out to white at unlucky angles.
    const dispMat = this.std({
      map: dispTex,
      emissive: 0xffffff,
      emissiveMap: dispTex,
      emissiveIntensity: 0.6,
      roughness: 0.85,
    });
    const dispGeo = new THREE.PlaneGeometry(DET_LCD_W, DET_LCD_D);
    dispGeo.rotateX(-Math.PI / 2);
    const dispMesh = this.mesh(dispGeo, dispMat);
    dispMesh.position.set(-0.004, 0.0245, 0.033);
    podGroup.add(dispMesh);
    // Signal lamp: small emissive dome + additive glow disc (bloom-friendly)
    const ledMat = this.std({
      color: 0x2a0c0c,
      emissive: 0xff2d1a,
      emissiveIntensity: 0,
      roughness: 0.35,
    });
    this.ledMat = ledMat;
    const ledMesh = this.mesh(new THREE.SphereGeometry(0.0045, 10, 8), ledMat);
    ledMesh.position.set(0.0262, 0.0245, 0.0475);
    podGroup.add(ledMesh);
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0xff5a3c,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.materials.push(glowMat);
    this.glowMat = glowMat;
    const glowGeo = new THREE.CircleGeometry(0.0095, 12);
    glowGeo.rotateX(-Math.PI / 2);
    const glowMesh = this.mesh(glowGeo, glowMat);
    glowMesh.position.set(0.0262, 0.0262, 0.0475);
    podGroup.add(glowMesh);
    root.add(podGroup);

    // Shaft: everything below the pivot, aimed per frame. Rod + spiral cable
    // stretch with scale.y (a telescoping rod); collars sit near the pivot.
    const shaft = new THREE.Group();
    shaft.position.copy(DET_PIVOT);
    const jointBall = new THREE.SphereGeometry(0.0145, 10, 8);
    jointBall.translate(0, -0.002, 0);
    const camLock = new THREE.CylinderGeometry(0.0135, 0.0135, 0.05, 12);
    camLock.translate(0, -0.03, 0);
    const upperRod = new THREE.CylinderGeometry(0.0105, 0.0105, 0.57, 12);
    upperRod.translate(0, -0.335, 0);
    const clamp = new THREE.CylinderGeometry(0.0138, 0.0138, 0.034, 10);
    clamp.translate(0, -0.615, 0);
    const clampLever = new THREE.BoxGeometry(0.006, 0.014, 0.018);
    clampLever.translate(0.013, -0.615, 0);
    const lowerRod = new THREE.CylinderGeometry(0.0088, 0.0088, 0.85, 10);
    lowerRod.translate(0, -1.025, 0);
    // Spiral cable: a helix hugging the rod for most of its length.
    const helixPts: THREE.Vector3[] = [];
    const turns = 6.5;
    for (let i = 0; i <= 80; i++) {
      const t = i / 80;
      const a = t * turns * Math.PI * 2;
      helixPts.push(
        new THREE.Vector3(
          Math.cos(a) * 0.0158,
          -0.07 - t * 1.3,
          Math.sin(a) * 0.0158,
        ),
      );
    }
    const cableGeo = new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3(helixPts),
      110,
      0.0034,
      5,
      false,
    );
    const shaftGeo = assemble(
      [
        { geo: upperRod, mat: 0 },
        { geo: lowerRod, mat: 0 },
        { geo: jointBall, mat: 1 },
        { geo: camLock, mat: 1 },
        { geo: clamp, mat: 1 },
        { geo: clampLever, mat: 1 },
        { geo: cableGeo, mat: 1 },
      ],
      2,
    );
    const shaftMesh = this.mesh(shaftGeo, [aluMat, stemMat]);
    shaft.add(shaftMesh);
    this.detShaftMesh = shaftMesh;

    // Coil assembly, hinged at the yoke bolt (= the group origin): the rod
    // tip meets the bolt exactly, and the coil pitches about the bolt axis.
    const yokeEarL = new THREE.BoxGeometry(0.0075, 0.042, 0.028);
    yokeEarL.translate(-0.0155, -0.008, 0);
    const yokeEarR = new THREE.BoxGeometry(0.0075, 0.042, 0.028);
    yokeEarR.translate(0.0155, -0.008, 0);
    const bolt = new THREE.CylinderGeometry(0.0052, 0.0052, 0.056, 10);
    bolt.rotateZ(Math.PI / 2);
    const washerL = new THREE.CylinderGeometry(0.0105, 0.0105, 0.003, 12);
    washerL.rotateZ(Math.PI / 2);
    washerL.translate(-0.0205, 0, 0);
    const washerR = new THREE.CylinderGeometry(0.0105, 0.0105, 0.003, 12);
    washerR.rotateZ(Math.PI / 2);
    washerR.translate(0.0205, 0, 0);
    const shell = new THREE.TorusGeometry(0.15, 0.019, 10, 28);
    shell.rotateX(Math.PI / 2);
    shell.scale(1, 0.62, 1.3);
    shell.translate(0, -0.03, 0);
    const topDisc = new THREE.CircleGeometry(0.144, 28);
    topDisc.rotateX(-Math.PI / 2);
    topDisc.scale(1, 1, 1.3);
    topDisc.translate(0, -0.0225, 0);
    const bottomDisc = new THREE.CircleGeometry(0.15, 28);
    bottomDisc.rotateX(Math.PI / 2);
    bottomDisc.scale(1, 1, 1.3);
    bottomDisc.translate(0, -0.0385, 0);
    const coilGeo = assemble(
      [
        { geo: shell, mat: 0 },
        { geo: bottomDisc, mat: 0 },
        { geo: yokeEarL, mat: 0 },
        { geo: yokeEarR, mat: 0 },
        { geo: topDisc, mat: 1 },
        { geo: bolt, mat: 2 },
        { geo: washerL, mat: 2 },
        { geo: washerR, mat: 2 },
      ],
      3,
    );
    const coil = new THREE.Group();
    coil.add(this.mesh(coilGeo, [coilMat, coilFaceMat, aluMat]));
    coil.position.set(0, -DET_SHAFT_LEN, 0);
    shaft.add(coil);
    root.add(shaft);

    root.visible = false;
    root.traverse((o) => {
      o.frustumCulled = false;
      o.castShadow = false;
      o.receiveShadow = false;
    });
    this.rightRig.add(root);
    this.detectorRoot = root;
    this.detShaft = shaft;
    this.detCoil = coil;
  }

  private buildFill(): void {
    const mats: THREE.MeshStandardMaterial[] = [];
    const can = this.std();
    applyPbr(can, pbrCanLabel("cola"));
    can.metalness = 0.5;
    mats.push(can);
    const bottle = this.std();
    applyPbr(bottle, pbrGlass());
    mats.push(bottle);
    const box = this.std();
    applyPbr(box, pbrCardboard());
    mats.push(box);
    const paper = this.std();
    applyPbr(paper, pbrPaperCrumpled());
    mats.push(paper);
    const plank = this.std();
    applyPbr(plank, pbrWood("plank"));
    mats.push(plank);

    const white = new THREE.Color(1, 1, 1);
    for (let k = 0; k < FILL_KINDS.length; k++) {
      const im = new THREE.InstancedMesh(
        fillKindGeometry(FILL_KINDS[k]),
        mats[k],
        MAX_SLOTS,
      );
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.setColorAt(0, white); // create instanceColor once
      im.count = 0;
      this.kinds.push(im);
      this.meshes.push(im);
      this.fillGroup.add(im);
    }
    // Slot layout: seven objects per layer, long objects lie tangentially.
    // These are only WISHES – fitSlot() pulls each object inwards/upwards
    // until its bounding box fits inside the inner wall.
    const rng = mulberry32(0x51f7);
    for (let i = 0; i < MAX_SLOTS; i++) {
      const layer = Math.floor(i / SLOTS_PER_LAYER);
      const k = i % SLOTS_PER_LAYER;
      const a =
        (k / SLOTS_PER_LAYER) * Math.PI * 2 + layer * 1.1 + (rng() - 0.5) * 0.6;
      const radius = 0.035 + rng() * 0.075;
      const y = 0.02 + layer * 0.058 + rng() * 0.012;
      // Long axis (local x) perpendicular to the radial direction: yaw = -a ± jitter
      const quat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          (rng() - 0.5) * 0.5,
          -a + Math.PI / 2 + (rng() - 0.5) * 0.7,
          (rng() - 0.5) * 0.35,
        ),
      );
      this.slots.push({ angle: a, radius, y, quat, layer });
    }
    for (const t of TRASH_TYPES) {
      const def =
        FILL_BY_TYPE[t.id] ??
        fd(FILL_BY_CATEGORY[t.category], CATEGORIES[t.category].color);
      this.fillDefs.set(t.id, def);
    }
  }

  // ---------------------------------------------------------------------
  // Runtime
  // ---------------------------------------------------------------------

  /** Discard the pendulum/velocity history (teleport, entering/leaving the jeep). */
  resetMotion(): void {
    this.hasPrev = false;
    this.hasPrevVel = false;
    this.swVX = 0;
    this.swVZ = 0;
    this.bounceV = 0;
  }

  update(inp: ViewInput): void {
    this.root.visible = inp.active;
    if (!inp.active) {
      this.resetMotion();
      return;
    }
    const dt = inp.dt;
    this.time += dt;
    const t = this.time;

    // Root: shoulder pivot, bob sway, pitch coupling (the arms hang off the body)
    const rx = clamp(-inp.pitch * 0.4, -0.12, 0.32);
    const rz = inp.bobX * 0.35;
    this.rootRx = rx;
    this.rootRz = rz;
    this.root.position.set(
      SHOULDER.x + inp.bobX * 0.5,
      SHOULDER.y + inp.bobY * 0.45,
      SHOULDER.z,
    );
    this.root.rotation.set(rx, 0, rz);

    // Equipped hand tool: the detector replaces the litter picker in the
    // right hand (built once on first equip; swaps only toggle visibility –
    // exactly one of grabber/detector is ever visible). The detector's
    // shaft/coil pose runs at the END of grabPose, once the rig transform
    // for this frame is final; stash the inputs it needs.
    const detector = useGame.getState().tool === "detector";
    if (detector && !this.detectorRoot) this.buildDetector();
    if (this.detectorRoot) {
      this.detectorRoot.visible = detector;
      this.grabber.visible = !detector;
      if (!detector) this.detPoseValid = false;
    }
    this.inpDt = dt;
    this.inpPitch = inp.pitch;
    this.inpYaw = inp.yaw;
    this.inpBobPhase = inp.bobPhase;
    this.inpBobAmp = inp.bobAmp;

    // Breathing + sprint pumping
    const breathe = Math.sin(t * 1.25);
    const pump = inp.bobAmp * (inp.sprint ? 1.1 : 0.45);
    const ph = Math.sin(inp.bobPhase);
    this.rRest.copy(RIGHT_REST).sub(SHOULDER);
    this.rRest.y += breathe * 0.004;
    this.rRest.z += ph * pump * 0.7;
    this.rRestRot.set(
      RIGHT_ROT.x + breathe * 0.012 + Math.cos(inp.bobPhase) * pump * 0.5,
      RIGHT_ROT.y,
      RIGHT_ROT.z,
    );
    this.leftRig.position.copy(LEFT_REST).sub(SHOULDER);
    this.leftRig.position.y += Math.sin(t * 1.25 + 1.7) * 0.003;
    this.leftRig.position.z += ph * pump * 0.3;

    // Pendulum: impulse from the change in velocity of the grip point (world)
    this.camera.updateMatrixWorld();
    this.leftRig.getWorldPosition(this.pivot);
    if (dt > 0) {
      if (this.hasPrev) {
        this.vel.subVectors(this.pivot, this.prevPivot).divideScalar(dt);
        if (this.hasPrevVel) {
          this.dv.subVectors(this.vel, this.prevVel);
          if (this.dv.lengthSq() < 400) {
            const s = Math.sin(inp.yaw);
            const c = Math.cos(inp.yaw);
            const dvx = clamp(this.dv.x * c - this.dv.z * s, -3, 3);
            const dvz = clamp(this.dv.x * s + this.dv.z * c, -3, 3);
            const dvy = clamp(this.dv.y, -4, 4);
            this.swVZ -= (dvx / PEND_L) * 0.8;
            this.swVX += (dvz / PEND_L) * 0.8;
            this.bounceV -= dvy * 0.3;
          }
        }
        this.prevVel.copy(this.vel);
        this.hasPrevVel = true;
      }
      this.prevPivot.copy(this.pivot);
      this.hasPrev = true;
    }
    if (inp.grounded && !this.wasGrounded) {
      // Landing: the bucket kicks forwards and dips briefly
      this.swVX += 0.6;
      this.bounceV -= 0.3;
    }
    this.wasGrounded = inp.grounded;
    const k = PEND_G / PEND_L;
    this.swVX += (-k * Math.sin(this.swX) - PEND_DAMP * this.swVX) * dt;
    this.swVZ += (-k * Math.sin(this.swZ) - PEND_DAMP * this.swVZ) * dt;
    this.swX = clamp(this.swX + this.swVX * dt, -0.5, 0.5);
    this.swZ = clamp(this.swZ + this.swVZ * dt, -0.5, 0.5);
    this.bounceV += (-70 * this.bounce - 8 * this.bounceV) * dt;
    // Tightly clamped: otherwise the bail's grip slips out of the fist
    this.bounce = clamp(this.bounce + this.bounceV * dt, -0.022, 0.022);

    const sx = this.swX + Math.sin(t * 0.9) * 0.01;
    const sz = this.swZ + Math.sin(t * 0.7 + 1) * 0.008;
    // The bucket hangs plumb: cancel out camera pitch, root tilt and roll
    this.qA.setFromEuler(this.eul.set(-(inp.pitch + rx), 0, -rz, "ZXY"));
    this.qB.setFromEuler(this.eul.set(sx, BUCKET_YAW, sz, "XZY"));
    this.bucketSwing.quaternion.multiplyQuaternions(this.qA, this.qB);
    this.bucketSwing.position.y = this.bounce;
    // The contents jostle slightly against the swing – bounded (JIGGLE_TILT)
    // and about their own middle, so they can never leave the shell. The
    // clamp in fitSlot() reserves exactly this much room.
    this.fillGroup.rotation.set(
      clamp(-sx * JIGGLE_GAIN, -JIGGLE_TILT, JIGGLE_TILT),
      0,
      clamp(-sz * JIGGLE_GAIN, -JIGGLE_TILT, JIGGLE_TILT),
    );
    // Rotate about (0, FILL_PIVOT_Y, 0) instead of about the bucket bottom
    this.tmpV.set(0, FILL_PIVOT_Y, 0).applyEuler(this.fillGroup.rotation);
    this.fillGroup.position.set(
      -this.tmpV.x,
      -BUCKET.pivotH +
        FILL_BASE_Y +
        FILL_PIVOT_Y -
        this.tmpV.y +
        this.bounce * BOUNCE_LAG,
      -this.tmpV.z,
    );
  }

  /**
   * Grab pose for this frame (after update()): `open` 0..1 jaws (0 = closed,
   * trigger pulled), `reach` 0..1 arm extension + telescope, `target` (world)
   * with `aimWeight`, `sweep` 0..1 arc over the bucket while pulling back.
   */
  grabPose(
    open: number,
    reach: number,
    target: THREE.Vector3 | null,
    aimWeight: number,
    sweep: number,
  ): void {
    const gi = this.grabber.morphTargetInfluences;
    const e = reach * reach * (3 - 2 * reach);
    if (gi) {
      gi[0] = open;
      gi[1] = e;
    }
    const hi = this.rightGlove.morphTargetInfluences;
    if (hi) hi[0] = open;

    const rig = this.rightRig;
    rig.position.copy(this.rRest).addScaledVector(RIGHT_EXTEND, e);
    // The sleeve stretches along so the elbow stays back
    this.rightSleeve.scale.y =
      1 + (e * RIGHT_EXTEND.length() * 0.9) / SLEEVE_LEN;
    let ax = 0;
    let ay = 0;
    if (target && aimWeight > 0) {
      this.tmpV.copy(target);
      this.root.worldToLocal(this.tmpV);
      this.tmpV.sub(rig.position);
      const len = this.tmpV.length();
      if (len > 1e-3) {
        this.tmpV.divideScalar(len);
        ay = Math.atan2(-this.tmpV.x, -this.tmpV.z) - RIGHT_ROT.y;
        ax = Math.asin(clamp(this.tmpV.y, -1, 1)) - RIGHT_ROT.x;
      }
      ax *= aimWeight * 0.85;
      ay *= aimWeight * 0.85;
    }
    const sw = Math.sin(sweep * Math.PI);
    rig.rotation.set(
      this.rRestRot.x + ax - sw * 0.22,
      this.rRestRot.y + ay + sw * 0.5,
      this.rRestRot.z - sw * 0.3,
    );
    rig.position.x -= sw * 0.1;
    rig.position.y += sw * 0.04;

    // The rig transform is final for this frame – pose the detector now.
    if (this.root.visible && this.detectorRoot?.visible) {
      this.updateDetectorPose();
    }
  }

  /**
   * Per-frame detector pose. The shaft aims from its pivot (at the hand) at
   * a ground target in front of the player: sweeping side to side with the
   * walk cycle, pulled in and raised as the camera pitches down (a real
   * detectorist lifts the coil when they stop and look at it), and always
   * resting just above groundHeight – so the coil follows dune slopes
   * instead of clipping through them. The rod telescopes (scale.y) to
   * bridge the remaining distance, the coil tilts about its yoke bolt AND
   * sideways to lie flat on the local slope, and a rim-sample clearance
   * guard lifts the whole pose until every low point of the coil clears
   * the real ground. Also drives the LCD + lamp.
   */
  private updateDetectorPose(): void {
    const shaft = this.detShaft;
    const coil = this.detCoil;
    const shaftMesh = this.detShaftMesh;
    if (!shaft || !coil || !shaftMesh) return;
    const rig = this.rightRig;
    rig.updateWorldMatrix(true, false);
    this.dsPivot.copy(DET_PIVOT).applyMatrix4(rig.matrixWorld);

    // Ground target in front of the player ---------------------------------
    const yaw = this.inpYaw;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const down01 = clamp(-this.inpPitch / 1.55, 0, 1);
    let dist = 1.45 - down01 * 0.85;
    const walk = clamp(this.inpBobAmp / 0.036, 0, 1.3);
    // Raw sweep amplitude – the target loop below shrinks it with the pose
    // pull-in, so the coil never swings across the bucket at steep look-down
    // angles or on tight uphill stances.
    const sweep =
      Math.sin(this.inpBobPhase * 0.5) * 0.5 * walk +
      Math.sin(this.time * 0.55) * 0.16 * (1 - walk * 0.55);
    dist += Math.cos(this.inpBobPhase * 0.5) * 0.05 * walk;
    const hover =
      0.055 +
      (0.5 + 0.5 * Math.sin(this.inpBobPhase)) * 0.03 * walk +
      Math.sin(this.time * 1.25) * 0.008;
    const camP = this.camera.position;
    // Horizontal aim: forward, swung towards the low side only when even the
    // closest ground ahead climbs to the hand (an extreme uphill scarp).
    let ax = fx;
    let az = fz;
    let sideways = false;
    // Targets must stay clearly ahead of the pivot – otherwise the pull-in
    // below sweeps the rod back across the body (and the bucket) on steep
    // ground.
    const pivF =
      (this.dsPivot.x - camP.x) * fx + (this.dsPivot.z - camP.z) * fz;
    const distFloor = Math.max(0.55, pivF + 0.4);
    let tx = 0;
    let tz = 0;
    let ty = 0;
    for (let i = 0; i < 8; i++) {
      const sw = sweep * (0.35 + 0.65 * clamp(dist / 1.45, 0, 1));
      tx = camP.x + ax * dist + rx * sw;
      tz = camP.z + az * dist + rz * sw;
      ty = groundHeight(tx, tz) + hover;
      const dy = ty - this.dsPivot.y;
      if (dy > -0.42) {
        // Uphill: the ground ahead rises to the hand – pull the target in.
        if (dist > distFloor + 1e-3) {
          dist = Math.max(distFloor, dist * 0.6);
          continue;
        }
        if (!sideways) {
          // Still at hand height at the closest range: sweep the low side
          // of the bank instead (what a detectorist does on a steep scarp).
          // Prefer the RIGHT side whenever it is usable – the bucket hangs
          // from the left hand, and a full left swing would carry the rod
          // across its silhouette. Forced left, swing gentler for the same
          // reason.
          sideways = true;
          const gl = groundHeight(camP.x - rx * 1.1, camP.z - rz * 1.1);
          const gr = groundHeight(camP.x + rx * 1.1, camP.z + rz * 1.1);
          const left = gr > this.dsPivot.y - 0.45 && gl < gr;
          const bx = left ? fx * 0.9 - rx * 0.75 : fx * 0.45 + rx;
          const bz = left ? fz * 0.9 - rz * 0.75 : fz * 0.45 + rz;
          const bl = Math.hypot(bx, bz);
          ax = bx / bl;
          az = bz / bl;
          dist = Math.max(distFloor, 0.95);
          continue;
        }
        break; // the clearance guard below still has the last word
      }
      // Downhill: ground falls away beyond the rod's reach – pull in so the
      // coil follows the face down instead of dangling over the drop.
      const dd = Math.hypot(tx - this.dsPivot.x, tz - this.dsPivot.z);
      if (
        Math.hypot(dd, dy) > DET_SHAFT_LEN * DET_STRETCH_MAX * 1.12 &&
        dist > distFloor + 1e-3
      ) {
        dist = Math.max(distFloor, dist * 0.72);
        continue;
      }
      break;
    }
    this.dsTarget.set(tx, ty, tz);
    this.dsDir.subVectors(this.dsTarget, this.dsPivot);
    const len = this.dsDir.length();
    if (len < 1e-4) {
      this.dsDir.set(0, -1, 0);
    } else {
      this.dsDir.divideScalar(len);
    }
    let L = clamp(
      len,
      DET_SHAFT_LEN * DET_STRETCH_MIN,
      DET_SHAFT_LEN * DET_STRETCH_MAX,
    );
    this.dsE.copy(this.dsPivot).addScaledVector(this.dsDir, L);
    // Low-pass the endpoint so pull-ins and the side swing glide instead of
    // popping frame to frame (the clearance guard below runs on the smoothed
    // pose, so smoothing can never re-bury the coil). Snap on equip/teleport.
    if (!this.detPoseValid || this.dsESm.distanceToSquared(this.dsE) > 2.25) {
      this.dsESm.copy(this.dsE);
      this.detPoseValid = true;
    } else {
      this.dsESm.lerp(this.dsE, Math.min(1, this.inpDt * 9));
    }
    this.dsE.copy(this.dsESm);

    // Clearance guard: pose the shaft and coil, audit the coil's low-rim
    // sample points against the real ground, and lift the endpoint straight
    // up by the worst deficit (repeated – lifting re-aims the shaft a
    // little). Lifting keeps x/z fixed, so the loop cannot oscillate on
    // scarps where a small horizontal shift moves the ground by 0.2 m+.
    const eyeMax = this.dsPivot.y - 0.16; // the rod never aims skyward
    for (let pass = 0; pass < 4; pass++) {
      this.dsDir.subVectors(this.dsE, this.dsPivot);
      const l2 = this.dsDir.length();
      if (l2 < 1e-4) {
        this.dsDir.set(0, -1, 0);
        L = DET_SHAFT_LEN * 0.3;
      } else {
        this.dsDir.divideScalar(l2);
        L = clamp(l2, DET_SHAFT_LEN * 0.3, DET_SHAFT_LEN * DET_STRETCH_MAX);
      }
      this.dsE.copy(this.dsPivot).addScaledVector(this.dsDir, L);

      // Shaft basis: local −y down the rod, local +z (cable side) back
      // towards the player (eyeMax keeps the rod off horizontal, so the
      // basis cannot degenerate).
      this.dsY.copy(this.dsDir).negate();
      this.dsZ.set(-this.dsDir.x, 0, -this.dsDir.z);
      if (this.dsZ.lengthSq() < 1e-6) {
        this.dsZ.set(Math.sin(yaw), 0, Math.cos(yaw));
      }
      this.dsZ.addScaledVector(this.dsY, -this.dsZ.dot(this.dsY)).normalize();
      this.dsX.crossVectors(this.dsY, this.dsZ);
      this.dsM.makeBasis(this.dsX, this.dsY, this.dsZ);
      this.dsQ.setFromRotationMatrix(this.dsM); // world rotation of the shaft

      // Coil: align its plane to the local slope in BOTH axes (pitch about
      // the yoke bolt plus sideways roll – without the roll the rim buries
      // itself by half a coil width on any cross-slope stance), capped so
      // the coil can never flip over.
      const e = 0.45;
      const gx =
        groundHeight(this.dsE.x - e, this.dsE.z) -
        groundHeight(this.dsE.x + e, this.dsE.z);
      const gz =
        groundHeight(this.dsE.x, this.dsE.z - e) -
        groundHeight(this.dsE.x, this.dsE.z + e);
      this.dsN.set(gx, 2 * e, gz).normalize();
      this.dsQ3.copy(this.dsQ).invert();
      this.dsN.applyQuaternion(this.dsQ3); // slope normal in shaft space
      this.dsQ2.setFromUnitVectors(Y_AXIS, this.dsN);
      this.dsQ4.identity().rotateTowards(this.dsQ2, 1.25);
      this.dsQ4.multiply(
        this.dsQ2.setFromAxisAngle(X_AXIS, Math.sin(this.time * 1.4) * 0.012),
      );
      coil.quaternion.copy(this.dsQ4);

      // Vertex-exact audit of the coil's low rim against the ground.
      let deficit = 0;
      for (let i = 0; i < DET_COIL_RIM.length; i += 3) {
        this.dsS
          .set(DET_COIL_RIM[i], DET_COIL_RIM[i + 1], DET_COIL_RIM[i + 2])
          .applyQuaternion(this.dsQ4)
          .applyQuaternion(this.dsQ)
          .add(this.dsE);
        const d =
          groundHeight(this.dsS.x, this.dsS.z) + DET_RIM_CLEAR - this.dsS.y;
        if (d > deficit) deficit = d;
      }
      if (deficit <= 0.001 || pass === 3) break;
      this.dsE.y += deficit + 0.004;
      if (this.dsE.y > eyeMax) {
        // Can't lift any further without aiming the rod skyward – pull the
        // coil in towards the player (downhill of the face) and try again.
        this.dsE.y = eyeMax;
        this.dsE.x = this.dsPivot.x + (this.dsE.x - this.dsPivot.x) * 0.66;
        this.dsE.z = this.dsPivot.z + (this.dsE.z - this.dsPivot.z) * 0.66;
      }
    }

    rig.getWorldQuaternion(this.dsQ2).invert();
    shaft.quaternion.multiplyQuaternions(this.dsQ2, this.dsQ);
    shaftMesh.scale.y = L / DET_SHAFT_LEN;
    coil.position.y = -L;

    // LCD + signal lamp ----------------------------------------------------
    const sig = detectorSignal;
    const level = sig.active ? (sig.locked ? 1 : sig.level) : 0;
    this.dispValue +=
      (level * 100 - this.dispValue) * Math.min(1, this.inpDt * 12);
    if (Math.abs(this.dispValue - level * 100) < 0.5) {
      this.dispValue = level * 100;
    }
    const shown = Math.round(this.dispValue);
    if (
      this.dispCtx &&
      this.dispTex &&
      (shown !== this.dispShown || sig.locked !== this.dispLocked)
    ) {
      this.dispShown = shown;
      this.dispLocked = sig.locked;
      paintDetectorDisplay(this.dispCtx, shown, sig.locked);
      this.dispTex.needsUpdate = true;
    }
    const lamp = sig.locked ? 1 : sig.pulse;
    if (this.ledMat) this.ledMat.emissiveIntensity = lamp * 3.2;
    if (this.glowMat) this.glowMat.opacity = lamp * 0.55;
  }

  /**
   * Lowest point (`fitYMin`) and widest distance from the object's own axis
   * (`fitTMax`) of the scaled and rotated object, over ALL of its vertices.
   * Working on the real vertices instead of the bounding box keeps round
   * objects from being pushed unnecessarily far away from the wall.
   */
  private measureShape(
    kind: number,
    q: THREE.Quaternion,
    scale: THREE.Vector3,
  ): void {
    const pos = this.kinds[kind].geometry.getAttribute("position");
    const v = this.tmpF;
    let yMin = Number.POSITIVE_INFINITY;
    let tMax = 0;
    for (let i = 0; i < pos.count; i++) {
      v.set(
        pos.getX(i) * scale.x,
        pos.getY(i) * scale.y,
        pos.getZ(i) * scale.z,
      ).applyQuaternion(q);
      if (v.y < yMin) yMin = v.y;
      const t = v.x * v.x + v.z * v.z;
      if (t > tMax) tMax = t;
    }
    this.fitYMin = yMin;
    this.fitTMax = Math.sqrt(tMax);
  }

  /**
   * Fit an object into the bucket: every one of its vertices has to stay above
   * the bottom dish and inside the inner wall – including the room reserved
   * for the jiggle and the dents. The slot is only a wish; the object is
   * lifted and pulled inwards until it fits (it is never pushed outwards, so
   * the layout keeps its look). Writes the position into `out`.
   */
  private fitSlot(
    slot: Slot,
    kind: number,
    scale: THREE.Vector3,
    out: THREE.Vector3,
  ): void {
    this.measureShape(kind, slot.quat, scale);
    // Emergency case: an object wider than the bucket at any radius. Scaling
    // it to the narrowest usable radius guarantees a solution below.
    if (this.fitTMax > FILL_R_WORST) {
      scale.multiplyScalar(FILL_R_WORST / this.fitTMax);
      this.measureShape(kind, slot.quat, scale);
    }
    // Height: lift until the lowest point clears the bottom dish
    const floor =
      BUCKET_INNER_FLOOR - FILL_BASE_Y + FILL_MARGIN + FILL_VERTICAL_RESERVE;
    const y = Math.max(slot.y, floor - this.fitYMin);
    // Radius: for a center at r·(cos a, sin a) a vertex v sits at the squared
    // radius (r + p)² + (t² − p²) with p = v·(cos a, sin a). Solve each vertex
    // for r and take the tightest limit.
    const pos = this.kinds[kind].geometry.getAttribute("position");
    const v = this.tmpF;
    const ca = Math.cos(slot.angle);
    const sa = Math.sin(slot.angle);
    let r = slot.radius;
    for (let i = 0; i < pos.count; i++) {
      v.set(
        pos.getX(i) * scale.x,
        pos.getY(i) * scale.y,
        pos.getZ(i) * scale.z,
      ).applyQuaternion(slot.quat);
      const p = v.x * ca + v.z * sa;
      const t2 = v.x * v.x + v.z * v.z;
      const rMax =
        bucketInnerRadius(y + v.y + FILL_BASE_Y) -
        BUCKET_DENT_MAX -
        FILL_RADIAL_RESERVE -
        FILL_MARGIN;
      const disc = rMax * rMax - t2 + p * p;
      const lim = (disc > 0 ? Math.sqrt(disc) : 0) - p;
      if (lim < r) r = lim;
    }
    if (r < 0) r = 0;
    out.set(ca * r, y, sa * r);
  }

  /** Build the bucket contents from the inventory (pooled, no new objects). */
  refreshFill(bucket: Record<string, number>, capacity: number): void {
    let total = 0;
    for (const key in bucket) total += bucket[key];
    const show =
      total <= 0
        ? 0
        : Math.min(
            MAX_SLOTS,
            Math.ceil((total / Math.max(1, capacity)) * MAX_SLOTS),
          );
    this.kindCount.fill(0);
    for (let i = 0; i < show; i++) {
      // Representative entry for this slot: the golden ratio spreads the kinds
      // evenly over all layers (instead of sorted by kind from bottom to top)
      const e = Math.floor(((i * 0.6180339887) % 1) * total);
      let acc = 0;
      let typeId = "";
      for (const key in bucket) {
        acc += bucket[key];
        if (acc > e) {
          typeId = key;
          break;
        }
      }
      const def = this.fillDefs.get(typeId) ?? this.fillFallback;
      const im = this.kinds[def.kind];
      const n = this.kindCount[def.kind]++;
      const slot = this.slots[i];
      this.tmpS
        .set(def.scale[0], def.scale[1], def.scale[2])
        .multiplyScalar(KIND_SCALE[FILL_KINDS[def.kind]]);
      this.fitSlot(slot, def.kind, this.tmpS, this.tmpV);
      this.tmpM.compose(this.tmpV, slot.quat, this.tmpS);
      im.setMatrixAt(n, this.tmpM);
      this.tmpC.set(def.color).multiplyScalar(LAYER_AO[slot.layer]);
      im.setColorAt(n, this.tmpC);
    }
    for (let k = 0; k < this.kinds.length; k++) {
      const im = this.kinds[k];
      im.count = this.kindCount[k];
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    this.camera.remove(this.root);
    this.dispTex?.dispose();
    for (const m of this.meshes) {
      m.removeFromParent();
      m.geometry.dispose();
    }
    for (const m of this.materials) m.dispose();
    this.meshes.length = 0;
    this.materials.length = 0;
    this.kinds.length = 0;
  }
}
