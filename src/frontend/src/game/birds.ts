// Gulls in the sky – a single InstancedMesh (one draw call) with a procedural
// gull model. The wing beat runs in the vertex shader (arm and hand wing as two
// joints), the flight behaviour on the CPU: gliding with flapping phases, turns
// with bank angle, thermal circling above the dunes, coastal patrol, a dive at
// the water with a pull-out, resting on the beach, loose groups
// (leader/follower), wind drift. At night and in rain/storm there are fewer of
// them, flying lower and more restlessly.

import * as THREE from "three";
import { clamp, smoothstep } from "./noise";
import type { Environment } from "./sky";
import { sound } from "./sound";
import { WORLD_BOUNDS, shoreZ, terrainHeight } from "./terrain";
import type { QualityId } from "./types";

const COUNT: Record<QualityId, number> = {
  ultra: 14,
  high: 10,
  medium: 7,
  low: 4,
};

// Model dimensions (meters at scale 1). Body axis along Z, beak at -Z.
const WING_Y = 0.045; // wing plane above the body axis
const WRIST_X = 0.28; // wrist = length of the arm wing
const HALF_SPAN = 0.7; // half the wingspan
const WING_T = 0.02; // thickness of the wing plate (top/bottom separate)

const G = 9.81;
const TWO_PI = Math.PI * 2;
const MAX_DIST = 350; // birds further away are re-placed on the opposite side
const ALT_MIN = 12;
const ALT_MAX = 70;
const CALL_RANGE = 150;

const M_CRUISE = 0;
const M_THERMAL = 1;
const M_DIVE = 2;
const M_REST = 3;
const M_FOLLOW = 4;
const MODE_NAMES = ["cruise", "thermal", "dive", "rest", "follow"];

type V3 = [number, number, number];

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const C_WHITE = new THREE.Color(0xf3f3f0);
const C_MANTLE = new THREE.Color(0x9ba3aa);
const C_TIP = new THREE.Color(0x1a1c20);
const C_UNDER = new THREE.Color(0xe4e6e8);
const C_UNDER_TIP = new THREE.Color(0x40444a);
const C_BEAK = new THREE.Color(0xf0bd2e);
const C_BEAK_TIP = new THREE.Color(0xd9541e);
const C_EYE = new THREE.Color(0x0b0b0d);

// Wing plan form (x = span from the shoulder; z: leading edge -, trailing edge +)
const PLAN_X = [0, 0.28, 0.45, 0.58, 0.66, HALF_SPAN];
const PLAN_LE = [-0.12, -0.105, -0.085, -0.05, 0.0, 0.06];
const PLAN_TE = [0.13, 0.085, 0.06, 0.05, 0.06, 0.065];
const INNER_X = [0, 0.09, 0.18, WRIST_X];
const OUTER_X = [WRIST_X, 0.36, 0.44, 0.52, 0.59, 0.65, HALF_SPAN];
const CHORD_N = 3;

function interp(xs: number[], ys: number[], x: number): number {
  for (let i = 0; i < xs.length - 1; i++) {
    if (x <= xs[i + 1]) {
      const t = (x - xs[i]) / (xs[i + 1] - xs[i]);
      return ys[i] + (ys[i + 1] - ys[i]) * clamp(t, 0, 1);
    }
  }
  return ys[ys.length - 1];
}

class GeoBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private col: number[] = [];
  private part: number[] = [];
  private tmp = new THREE.Color();

  vertex(p: V3, n: V3, c: THREE.Color, part: number): void {
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    this.col.push(c.r, c.g, c.b);
    this.part.push(part);
  }

  /** Quad a-b-c-d; the winding order is adjusted to match the normal n. */
  quad(
    a: V3,
    b: V3,
    c: V3,
    d: V3,
    n: V3,
    ca: THREE.Color,
    cb: THREE.Color,
    cc: THREE.Color,
    cd: THREE.Color,
    part: number,
  ): void {
    const e1x = b[0] - a[0];
    const e1y = b[1] - a[1];
    const e1z = b[2] - a[2];
    const e2x = c[0] - a[0];
    const e2y = c[1] - a[1];
    const e2z = c[2] - a[2];
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    const flip = cx * n[0] + cy * n[1] + cz * n[2] < 0;
    if (flip) {
      this.vertex(a, n, ca, part);
      this.vertex(c, n, cc, part);
      this.vertex(b, n, cb, part);
      this.vertex(a, n, ca, part);
      this.vertex(d, n, cd, part);
      this.vertex(c, n, cc, part);
    } else {
      this.vertex(a, n, ca, part);
      this.vertex(b, n, cb, part);
      this.vertex(c, n, cc, part);
      this.vertex(a, n, ca, part);
      this.vertex(c, n, cc, part);
      this.vertex(d, n, cd, part);
    }
  }

  /** Grid surface from positions/colors [row][column] with a fixed normal. */
  grid(P: V3[][], C: THREE.Color[][], n: V3, part: number): void {
    for (let i = 0; i < P.length - 1; i++) {
      for (let j = 0; j < P[i].length - 1; j++) {
        this.quad(
          P[i][j],
          P[i + 1][j],
          P[i + 1][j + 1],
          P[i][j + 1],
          n,
          C[i][j],
          C[i + 1][j],
          C[i + 1][j + 1],
          C[i][j + 1],
          part,
        );
      }
    }
  }

  /** Take over an arbitrary (indexed) BufferGeometry with a color function. */
  addGeometry(
    g: THREE.BufferGeometry,
    part: number,
    colorOf: (p: V3, n: V3, out: THREE.Color) => void,
  ): void {
    const pa = g.getAttribute("position");
    const na = g.getAttribute("normal");
    const idx = g.getIndex();
    const count = idx ? idx.count : pa.count;
    const p: V3 = [0, 0, 0];
    const n: V3 = [0, 1, 0];
    for (let k = 0; k < count; k++) {
      const i = idx ? idx.getX(k) : k;
      p[0] = pa.getX(i);
      p[1] = pa.getY(i);
      p[2] = pa.getZ(i);
      n[0] = na.getX(i);
      n[1] = na.getY(i);
      n[2] = na.getZ(i);
      colorOf(p, n, this.tmp);
      this.vertex(p, n, this.tmp, part);
    }
  }

  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    geo.setAttribute("aPart", new THREE.Float32BufferAttribute(this.part, 1));
    return geo;
  }
}

function wingTopColor(x: number, v: number, out: THREE.Color): void {
  out.copy(C_MANTLE);
  // bright trailing edge of the secondaries
  const te = smoothstep(0.8, 0.96, v) * (1 - smoothstep(0.42, 0.56, x));
  out.lerp(C_WHITE, te * 0.85);
  // black primary tips
  out.lerp(C_TIP, smoothstep(0.55, 0.67, x));
}

function wingBottomColor(x: number, _v: number, out: THREE.Color): void {
  out.copy(C_UNDER);
  out.lerp(C_UNDER_TIP, smoothstep(0.58, 0.69, x));
}

function addWing(gb: GeoBuilder, side: number): void {
  const segs: { xs: number[]; part: number }[] = [
    { xs: INNER_X, part: 1 },
    { xs: OUTER_X, part: 2 },
  ];
  for (const seg of segs) {
    for (const top of [true, false]) {
      const y = WING_Y + (top ? WING_T * 0.5 : -WING_T * 0.5);
      const P: V3[][] = [];
      const C: THREE.Color[][] = [];
      for (const x of seg.xs) {
        const le = interp(PLAN_X, PLAN_LE, x);
        const te = interp(PLAN_X, PLAN_TE, x);
        const row: V3[] = [];
        const crow: THREE.Color[] = [];
        for (let j = 0; j <= CHORD_N; j++) {
          const v = j / CHORD_N;
          row.push([side * x, y, le + (te - le) * v]);
          const c = new THREE.Color();
          if (top) wingTopColor(x, v, c);
          else wingBottomColor(x, v, c);
          crow.push(c);
        }
        P.push(row);
        C.push(crow);
      }
      gb.grid(P, C, [0, top ? 1 : -1, 0], side * seg.part);
    }
  }
}

function addTail(gb: GeoBuilder): void {
  const zs = [0.24, 0.33, 0.42];
  const hw = [0.035, 0.07, 0.1];
  const tilt = 0.12;
  const len = Math.hypot(1, tilt);
  for (const top of [true, false]) {
    const P: V3[][] = [];
    const C: THREE.Color[][] = [];
    for (let i = 0; i < zs.length; i++) {
      const y = 0.015 - (zs[i] - zs[0]) * tilt + (top ? 0.006 : -0.006);
      const row: V3[] = [];
      const crow: THREE.Color[] = [];
      for (let j = 0; j <= 2; j++) {
        const x = -hw[i] + hw[i] * j;
        row.push([x, y, zs[i]]);
        crow.push(top ? C_WHITE : C_UNDER);
      }
      P.push(row);
      C.push(crow);
    }
    gb.grid(P, C, [0, (top ? 1 : -1) / len, (top ? tilt : -tilt) / len], 0);
  }
}

function bodyColor(p: V3, n: V3, out: THREE.Color): void {
  const t = -p[2];
  if (t > 0.352) {
    out.copy(C_BEAK).lerp(C_BEAK_TIP, smoothstep(0.4, 0.44, t));
    return;
  }
  // grey mantle on the back, white elsewhere
  const mantle =
    smoothstep(0.1, 0.5, n[1]) *
    smoothstep(-0.27, -0.19, t) *
    (1 - smoothstep(0.1, 0.2, t));
  out.copy(C_WHITE).lerp(C_MANTLE, mantle);
}

function buildGullGeometry(): THREE.BufferGeometry {
  const gb = new GeoBuilder();

  // Body + head + beak as a lathe object (profile: [radius, length])
  const profile: [number, number][] = [
    [0.0, -0.3],
    [0.03, -0.27],
    [0.058, -0.2],
    [0.082, -0.1],
    [0.095, 0.0],
    [0.09, 0.1],
    [0.068, 0.18],
    [0.052, 0.23],
    [0.06, 0.27],
    [0.056, 0.31],
    [0.036, 0.345],
    [0.022, 0.36],
    [0.008, 0.43],
    [0.0, 0.445],
  ];
  const lathe = new THREE.LatheGeometry(
    profile.map(([r, t]) => new THREE.Vector2(r, t)),
    14,
  );
  lathe.rotateX(-Math.PI / 2); // profile axis +Y -> -Z (beak in front)
  // Lift the head and neck slightly above the body axis
  const lp = lathe.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < lp.count; i++) {
    const t = -lp.getZ(i);
    if (t > 0.2) lp.setY(i, lp.getY(i) + (t - 0.2) * 0.28);
  }
  gb.addGeometry(lathe, 0, bodyColor);
  lathe.dispose();

  // Eyes
  for (const side of [1, -1]) {
    const eye = new THREE.SphereGeometry(0.013, 6, 5);
    eye.translate(side * 0.05, 0.036, -0.3);
    gb.addGeometry(eye, 0, (_p, _n, out) => out.copy(C_EYE));
    eye.dispose();
  }

  addWing(gb, 1);
  addWing(gb, -1);
  addTail(gb);
  return gb.build();
}

// ---------------------------------------------------------------------------
// Shader extension: wing beat with two joints per wing
// ---------------------------------------------------------------------------

const VERT_HEAD = /* glsl */ `
attribute float aPart;
attribute vec4 aFlap;
const float B_WING_Y = ${WING_Y.toFixed(3)};
const float B_WRIST_X = ${WRIST_X.toFixed(3)};
mat3 bRotZ(float a) {
  float c = cos(a); float s = sin(a);
  return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0);
}
mat3 bRotY(float a) {
  float c = cos(a); float s = sin(a);
  return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
}
`;

const VERT_NORMAL = /* glsl */ `
#include <beginnormal_vertex>
float bSide = sign(aPart);
float bSeg = abs(aPart);
mat3 bR1 = mat3(1.0);
mat3 bR2 = mat3(1.0);
if (bSeg > 0.5) {
  float bAmp = aFlap.y;
  float bTuck = aFlap.z;
  float s1 = sin(aFlap.x);
  float s2 = sin(aFlap.x - 0.75);
  // Glide pose: arm wing raised slightly, hand wing lowered (the gull "M")
  float th1 = mix(0.22, 0.12 + 0.62 * s1, bAmp);
  float th2 = mix(-0.55 - aFlap.w * 0.2, -0.22 + 0.58 * s2, bAmp);
  // Tucking (dive/rest): swing back, lower the arm, raise the hand
  th1 = mix(th1, -0.3, bTuck);
  th2 = mix(th2, 0.12, bTuck);
  bR1 = bRotZ(bSide * th1) * bRotY(-bSide * bTuck * 1.2);
  bR2 = bRotZ(bSide * th2) * bRotY(-bSide * bTuck * 0.75);
  if (bSeg > 1.5) objectNormal = bR2 * objectNormal;
  objectNormal = bR1 * objectNormal;
}
`;

const VERT_POS = /* glsl */ `
#include <begin_vertex>
if (bSeg > 0.5) {
  vec3 bSh = vec3(0.0, B_WING_Y, 0.0);
  if (bSeg > 1.5) {
    vec3 bWr = vec3(bSide * B_WRIST_X, B_WING_Y, 0.0);
    transformed = bWr + bR2 * (transformed - bWr);
  }
  transformed = bSh + bR1 * (transformed - bSh);
}
`;

// ---------------------------------------------------------------------------
// Bird state
// ---------------------------------------------------------------------------

class Bird {
  active = false;
  x = 0;
  y = 30;
  z = 0;
  /** Heading (yaw); 0 = toward -Z, positive = turning left. */
  h = 0;
  /** Flight path angle (positive = climbing). */
  p = 0;
  /** Bank angle (positive = right wing down). */
  roll = 0;
  /** Turn rate (rad/s). */
  omega = 0;
  v = 11;
  vBase = 11;
  scale = 1;
  seed = 0;
  droop = 0;
  // Wing beat
  flapping = false;
  phase = 0;
  amp = 0;
  flapsLeft = 0;
  glideT = 0;
  rate = 3;
  tuck = 0;
  // Behaviour
  mode = M_CRUISE;
  sub = 0;
  modeT = 0;
  tx = 0;
  tz = 0;
  alt = 30;
  altT = 0;
  altTop = 60;
  dir = 1;
  cw = 1;
  r = 20;
  restY = 0;
  restH = 0;
  leader: Bird | null = null;
  offB = 4;
  offR = 2;
  offY = 0;
  callT = 10;
  // Relation to the camera (per frame)
  camDist = 0;
  camDot = 0;
  camPan = 0;
}

interface Control {
  hDes: number;
  altDes: number;
  vDes: number;
  pForced: boolean;
  pForce: number;
  flapUrge: number;
  tuck: number;
  altMin: number;
  soaring: boolean;
}

function wrapAngle(a: number): number {
  return a - TWO_PI * Math.round(a / TWO_PI);
}

/** Heading to fly from (fx,fz) to (tx,tz) (forward = (-sin h, -cos h)). */
function headingTo(fx: number, fz: number, tx: number, tz: number): number {
  return Math.atan2(-(tx - fx), -(tz - fz));
}

function mixAngle(a: number, b: number, w: number): number {
  return a + wrapAngle(b - a) * w;
}

// ---------------------------------------------------------------------------
// Flock
// ---------------------------------------------------------------------------

export class Birds {
  readonly group = new THREE.Group();
  readonly mesh: THREE.InstancedMesh;
  private scene: THREE.Scene;
  private birds: Bird[] = [];
  private n: number;
  private geo: THREE.BufferGeometry;
  private mat: THREE.MeshStandardMaterial;
  private flapAttr: THREE.InstancedBufferAttribute;
  private time = 0;
  private started = false;
  private adjustT = 0;
  private callCooldown = 0;
  private cam = new THREE.Vector3();
  private camFwd = new THREE.Vector3(0, 0, -1);
  private camRight = new THREE.Vector3(1, 0, 0);
  private ctl: Control = {
    hDes: 0,
    altDes: 30,
    vDes: 11,
    pForced: false,
    pForce: 0,
    flapUrge: 0,
    tuck: 0,
    altMin: ALT_MIN,
    soaring: false,
  };

  constructor(scene: THREE.Scene, quality: QualityId) {
    this.scene = scene;
    this.n = COUNT[quality];

    this.geo = buildGullGeometry();
    this.flapAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(this.n * 4),
      4,
    );
    this.flapAttr.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("aFlap", this.flapAttr);

    this.mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.82,
      metalness: 0,
    });
    this.mat.onBeforeCompile = (shader) => {
      shader.vertexShader = `${VERT_HEAD}\n${shader.vertexShader}`
        .replace("#include <beginnormal_vertex>", VERT_NORMAL)
        .replace("#include <begin_vertex>", VERT_POS);
    };

    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, this.n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    const arr = this.mesh.instanceMatrix.array as Float32Array;
    arr.fill(0);
    for (let i = 0; i < this.n; i++) arr[i * 16 + 15] = 1;
    this.group.add(this.mesh);
    scene.add(this.group);

    // Create the birds and loose groups (leader + 0..2 followers)
    let i = 0;
    while (i < this.n) {
      const sizes = [1, 2, 2, 3, 2, 4];
      const size = Math.min(
        sizes[Math.floor(Math.random() * sizes.length)],
        this.n - i,
      );
      const leader = this.makeBird();
      this.birds.push(leader);
      for (let k = 1; k < size; k++) {
        const f = this.makeBird();
        f.leader = leader;
        f.mode = M_FOLLOW;
        this.birds.push(f);
      }
      i += size;
    }
  }

  private makeBird(): Bird {
    const b = new Bird();
    b.seed = Math.random() * 100;
    b.scale = 1.0 + Math.random() * 0.35;
    b.vBase = 9.5 + Math.random() * 3;
    b.droop = Math.random();
    b.offB = 3 + Math.random() * 5;
    b.offR = (Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * 4);
    b.offY = (Math.random() - 0.5) * 3;
    b.callT = 4 + Math.random() * 20;
    b.dir = Math.random() < 0.5 ? -1 : 1;
    return b;
  }

  // ---------------- Update ----------------

  update(dt: number, env: Environment, camera: THREE.PerspectiveCamera): void {
    if (dt <= 0) return;
    this.time += dt;
    this.cam.copy(camera.position);
    camera.getWorldDirection(this.camFwd);
    this.camRight.setFromMatrixColumn(camera.matrixWorld, 0);
    this.camRight.y = 0;
    if (this.camRight.lengthSq() < 1e-6) this.camRight.set(1, 0, 0);
    else this.camRight.normalize();
    this.callCooldown -= dt;

    const stormy = env.weather === "storm";
    const erratic = clamp(env.rain * 0.8 + (stormy ? 0.5 : 0), 0, 1.3);
    const windDrift = env.wind * 5;

    if (!this.started) {
      this.started = true;
      this.initialSpawn(env);
    }
    for (const b of this.birds) if (b.active) this.measure(b);
    this.adjustPopulation(dt, env);

    const mat = this.mesh.instanceMatrix.array as Float32Array;
    const fl = this.flapAttr.array as Float32Array;
    for (let i = 0; i < this.n; i++) {
      const b = this.birds[i];
      if (!b.active) {
        mat.fill(0, i * 16, i * 16 + 16);
        mat[i * 16 + 15] = 1;
        continue;
      }
      if (b.camDist > MAX_DIST) this.respawn(b, env);
      this.stepCall(b, dt, env, stormy);
      if (b.mode === M_REST) this.stepRest(b, dt, env);
      else this.stepFlight(b, dt, env, erratic, windDrift);
      this.writeInstance(i, b, mat, fl);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.flapAttr.needsUpdate = true;
  }

  private measure(b: Bird): void {
    const dx = b.x - this.cam.x;
    const dy = b.y - this.cam.y;
    const dz = b.z - this.cam.z;
    b.camDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const inv = 1 / Math.max(0.001, b.camDist);
    b.camDot =
      (dx * this.camFwd.x + dy * this.camFwd.y + dz * this.camFwd.z) * inv;
    b.camPan = (dx * this.camRight.x + dz * this.camRight.z) * inv;
  }

  private writeInstance(
    i: number,
    b: Bird,
    mat: Float32Array,
    fl: Float32Array,
  ): void {
    const p = b.mode === M_REST && b.sub === 2 ? 0 : b.p + 0.06 + b.amp * 0.04;
    const ch = Math.cos(b.h);
    const sh = Math.sin(b.h);
    const cp = Math.cos(p);
    const sp = Math.sin(p);
    const cr = Math.cos(b.roll);
    const sr = Math.sin(b.roll);
    // Forward F, horizontal right R0, up U0 = R0 x F
    const fx = -sh * cp;
    const fy = sp;
    const fz = -ch * cp;
    const r0x = ch;
    const r0z = -sh;
    const u0x = sh * sp;
    const u0y = cp;
    const u0z = ch * sp;
    // Bank about F: R = R0 cos r - U0 sin r, U = R0 sin r + U0 cos r
    const s = b.scale;
    const o = i * 16;
    mat[o] = (r0x * cr - u0x * sr) * s;
    mat[o + 1] = -u0y * sr * s;
    mat[o + 2] = (r0z * cr - u0z * sr) * s;
    mat[o + 3] = 0;
    mat[o + 4] = (r0x * sr + u0x * cr) * s;
    mat[o + 5] = u0y * cr * s;
    mat[o + 6] = (r0z * sr + u0z * cr) * s;
    mat[o + 7] = 0;
    mat[o + 8] = -fx * s;
    mat[o + 9] = -fy * s;
    mat[o + 10] = -fz * s;
    mat[o + 11] = 0;
    mat[o + 12] = b.x;
    mat[o + 13] = b.y;
    mat[o + 14] = b.z;
    mat[o + 15] = 1;
    const f = i * 4;
    fl[f] = b.phase;
    fl[f + 1] = b.amp;
    fl[f + 2] = b.tuck;
    fl[f + 3] = b.droop;
  }

  // ---------------- Population ----------------

  private targetCount(env: Environment): number {
    let f = smoothstep(0.03, 0.45, env.dayI);
    f *= 1 - env.rain * 0.5;
    if (env.weather === "storm") f *= 0.6;
    let t = Math.round(this.n * f);
    // At night at most one single gull
    const nightMin = this.n >= 7 ? 1 : 0;
    if (t < nightMin) t = nightMin;
    return clamp(t, 0, this.n);
  }

  private adjustPopulation(dt: number, env: Environment): void {
    this.adjustT -= dt;
    if (this.adjustT > 0) return;
    this.adjustT = 1.2 + Math.random();
    const target = this.targetCount(env);
    let active = 0;
    for (const b of this.birds) if (b.active) active++;
    if (active < target) {
      const b = this.birds.find((x) => !x.active);
      if (b) {
        b.active = true;
        this.respawn(b, env);
      }
    } else if (active > target) {
      // only remove birds that are out of sight or far away
      let best: Bird | null = null;
      let bestScore = 0;
      for (const b of this.birds) {
        if (!b.active) continue;
        const s =
          (b.camDist > 220 ? 2 : 0) +
          (b.camDot < 0.25 ? 1 : 0) +
          b.camDist / 1000;
        if (s > bestScore) {
          bestScore = s;
          best = b;
        }
      }
      if (best && bestScore >= 1) best.active = false;
    }
  }

  private validSpot(x: number, z: number): boolean {
    return (
      x > WORLD_BOUNDS.minX + 30 &&
      x < WORLD_BOUNDS.maxX - 30 &&
      z < WORLD_BOUNDS.maxZ - 50 &&
      z > shoreZ(x) - 200
    );
  }

  private rainy(env: Environment): boolean {
    return env.rain > 0.25 || env.weather === "storm";
  }

  private randomAlt(env: Environment): number {
    const max = this.rainy(env) ? 26 : 45;
    return ALT_MIN + Math.random() * (max - ALT_MIN);
  }

  private leaderOf(b: Bird): Bird | null {
    const L = b.leader;
    if (!L || !L.active || L.mode === M_REST) return null;
    return L;
  }

  private initialSpawn(env: Environment): void {
    const target = this.targetCount(env);
    let groups = 0;
    for (const b of this.birds) if (!b.leader) groups++;
    let gi = 0;
    for (let i = 0; i < this.n; i++) {
      const b = this.birds[i];
      b.active = i < target;
      if (!b.active) continue;
      const L = this.leaderOf(b);
      if (L) {
        this.placeNearLeader(b, L);
        continue;
      }
      // Leaders stratified in a ring around the camera (first frame: visible is fine)
      let placed = false;
      for (let k = 0; k < 12 && !placed; k++) {
        const a = ((gi + Math.random() * 0.9) / Math.max(1, groups)) * TWO_PI;
        const d = 50 + Math.random() * 140;
        const x = this.cam.x + Math.cos(a) * d;
        const z = this.cam.z + Math.sin(a) * d;
        if (!this.validSpot(x, z)) {
          gi++;
          continue;
        }
        this.placeAt(b, x, z, env);
        placed = true;
      }
      if (!placed) this.respawn(b, env);
      gi++;
    }
  }

  private placeAt(b: Bird, x: number, z: number, env: Environment): void {
    b.x = x;
    b.z = z;
    b.y = Math.max(
      this.randomAlt(env) + Math.random() * 10,
      Math.max(terrainHeight(x, z), 0) + 8,
    );
    b.h = headingTo(
      x,
      z,
      this.cam.x + (Math.random() - 0.5) * 160,
      this.cam.z + (Math.random() - 0.5) * 160,
    );
    b.v = b.vBase;
    b.p = 0;
    b.roll = 0;
    b.omega = 0;
    b.flapping = false;
    b.amp = 0;
    b.tuck = 0;
    b.glideT = Math.random() * 3;
    b.callT = 4 + Math.random() * 20;
    if (b.leader) {
      b.mode = M_FOLLOW;
      b.sub = 0;
    } else if (!this.rainy(env) && Math.random() < 0.35) {
      this.startThermal(b);
    } else {
      this.startCruise(b);
    }
    this.measure(b);
  }

  private placeNearLeader(b: Bird, L: Bird): void {
    const fx = -Math.sin(L.h);
    const fz = -Math.cos(L.h);
    const rx = Math.cos(L.h);
    const rz = -Math.sin(L.h);
    b.x = L.x - fx * b.offB + rx * b.offR;
    b.z = L.z - fz * b.offB + rz * b.offR;
    b.y = Math.max(L.y + b.offY, Math.max(terrainHeight(b.x, b.z), 0) + 4);
    b.h = L.h;
    b.v = L.v;
    b.p = L.p;
    b.roll = L.roll;
    b.omega = L.omega;
    b.flapping = false;
    b.amp = 0;
    b.tuck = 0;
    b.glideT = Math.random() * 3;
    b.mode = M_FOLLOW;
    b.sub = 0;
    b.callT = 4 + Math.random() * 20;
    this.measure(b);
  }

  /** Re-place a bird: followers near their leader, otherwise on the opposite side out of sight. */
  private respawn(b: Bird, env: Environment): void {
    const L = this.leaderOf(b);
    if (L && (L.camDot < 0.3 || L.camDist > 200)) {
      this.placeNearLeader(b, L);
      return;
    }
    let bx = 0;
    let bz = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let k = 0; k < 10; k++) {
      const a = Math.random() * TWO_PI;
      const d = 220 + Math.random() * 80;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const x = this.cam.x + ca * d;
      const z = this.cam.z + sa * d;
      if (!this.validSpot(x, z)) continue;
      const dot = ca * this.camFwd.x + sa * this.camFwd.z;
      const score = -dot + Math.random() * 0.3;
      if (score > bestScore) {
        bestScore = score;
        bx = x;
        bz = z;
      }
    }
    if (bestScore === Number.NEGATIVE_INFINITY) {
      bx = clamp(this.cam.x, -300, 300);
      bz = clamp(this.cam.z + 250, shoreZ(bx) - 100, 320);
    }
    this.placeAt(b, bx, bz, env);
  }

  // ---------------- Calls ----------------

  private stepCall(
    b: Bird,
    dt: number,
    env: Environment,
    stormy: boolean,
  ): void {
    b.callT -= dt;
    if (b.callT > 0) return;
    b.callT = 8 + Math.random() * 22;
    if (
      b.camDist > CALL_RANGE ||
      this.callCooldown > 0 ||
      env.dayI < 0.12 ||
      env.rain > 0.7 ||
      stormy
    )
      return;
    this.callCooldown = 2 + Math.random() * 1.5;
    sound.gull(clamp(b.camPan, -1, 1), clamp(b.camDist / CALL_RANGE, 0, 1));
  }

  // ---------------- Behaviour ----------------

  private startCruise(b: Bird): void {
    b.mode = M_CRUISE;
    b.sub = 0;
    b.modeT = 20 + Math.random() * 30;
    b.altT = 0;
    b.alt = clamp(b.y, ALT_MIN, ALT_MAX);
    this.newWaypoint(b);
  }

  private newWaypoint(b: Bird): void {
    if (b.x > 290) b.dir = -1;
    else if (b.x < -290) b.dir = 1;
    else if (Math.abs(b.x - this.cam.x) > 150 && Math.random() < 0.7)
      b.dir = this.cam.x > b.x ? 1 : -1;
    else if (Math.random() < 0.15) b.dir = -b.dir;
    const tx = b.x + b.dir * (70 + Math.random() * 110);
    b.tx = clamp(tx, -330, 330);
    b.tz = shoreZ(b.tx) + (-60 + Math.random() * 150);
  }

  private startThermal(b: Bird): void {
    b.mode = M_THERMAL;
    b.sub = 0;
    const cx = clamp(b.x + (Math.random() - 0.5) * 140, -330, 330);
    b.tx = cx;
    b.tz = clamp(shoreZ(cx) + 90 + Math.random() * 140, -100, 320);
    b.r = 14 + Math.random() * 16;
    b.cw = Math.random() < 0.5 ? -1 : 1;
    b.altTop = clamp(
      Math.max(b.y + 10, 48 + Math.random() * 20),
      ALT_MIN,
      ALT_MAX - 2,
    );
    b.alt = clamp(b.y, ALT_MIN, ALT_MAX);
    b.modeT = 30 + Math.random() * 40;
  }

  private startDive(b: Bird): void {
    b.mode = M_DIVE;
    b.sub = 0;
    const tx = b.x - Math.sin(b.h) * 50 + (Math.random() - 0.5) * 40;
    b.tx = clamp(tx, -330, 330);
    b.tz = shoreZ(b.tx) - (15 + Math.random() * 55);
    b.modeT = 14;
  }

  private startRest(b: Bird): boolean {
    for (let k = 0; k < 6; k++) {
      const x = this.cam.x + (Math.random() - 0.5) * 220;
      const z = shoreZ(x) + 12 + Math.random() * 35;
      const dcx = x - this.cam.x;
      const dcz = z - this.cam.z;
      const dc = Math.hypot(dcx, dcz);
      if (dc < 30 || dc > 130) continue;
      if (Math.hypot(x - b.x, z - b.z) > 220) continue;
      if (!this.validSpot(x, z)) continue;
      const h0 = terrainHeight(x, z);
      if (Math.abs(terrainHeight(x + 2, z) - terrainHeight(x - 2, z)) > 0.6)
        continue;
      b.mode = M_REST;
      b.sub = 0;
      b.tx = x;
      b.tz = z;
      b.restY = h0 + 0.22;
      b.modeT = 60;
      return true;
    }
    return false;
  }

  private chooseMode(b: Bird, env: Environment): void {
    const r = Math.random();
    const rainy = this.rainy(env);
    const nearShore = Math.abs(b.z - shoreZ(b.x)) < 90;
    if (!rainy && r < 0.35) this.startThermal(b);
    else if (r < 0.55 && nearShore && b.y > 16) this.startDive(b);
    else if (!rainy && r < 0.66 && b.camDist < 200 && this.startRest(b)) {
      // resting was chosen
    } else this.startCruise(b);
  }

  private stepFlight(
    b: Bird,
    dt: number,
    env: Environment,
    erratic: number,
    windDrift: number,
  ): void {
    const ground = terrainHeight(b.x, b.z);
    const floor = Math.max(ground, 0) + 3;
    // Look ahead: climb over the dunes in time
    const ax = b.x - Math.sin(b.h) * 22;
    const az = b.z - Math.cos(b.h) * 22;
    const floorAhead = Math.max(terrainHeight(ax, az), 0) + 3;

    const c = this.ctl;
    c.hDes = b.h;
    c.altDes = b.alt;
    c.vDes = b.vBase;
    c.pForced = false;
    c.pForce = 0;
    c.flapUrge = 0;
    c.tuck = 0;
    c.altMin = ALT_MIN;
    c.soaring = false;

    switch (b.mode) {
      case M_CRUISE:
        this.bhCruise(b, dt, env, c);
        break;
      case M_THERMAL:
        this.bhThermal(b, dt, env, c, windDrift);
        break;
      case M_DIVE:
        this.bhDive(b, dt, c, erratic, floor);
        break;
      default:
        this.bhFollow(b, dt, env, c, floor);
        break;
    }
    this.separation(b, c);
    this.bounds(b, c);
    this.flyControl(b, dt, c, floor, floorAhead, erratic, windDrift);
  }

  private bhCruise(b: Bird, dt: number, env: Environment, c: Control): void {
    b.modeT -= dt;
    const ddx = b.tx - b.x;
    const ddz = b.tz - b.z;
    if (ddx * ddx + ddz * ddz < 900) this.newWaypoint(b);
    c.hDes = headingTo(b.x, b.z, b.tx, b.tz);
    b.altT -= dt;
    if (b.altT <= 0) {
      b.altT = 6 + Math.random() * 10;
      b.alt = this.randomAlt(env);
    }
    c.altDes = b.alt;
    c.vDes = b.vBase;
    if (b.modeT <= 0) this.chooseMode(b, env);
  }

  private bhThermal(
    b: Bird,
    dt: number,
    env: Environment,
    c: Control,
    windDrift: number,
  ): void {
    b.tx += windDrift * 0.5 * dt; // the thermal bubble drifts with the wind
    const ang = Math.atan2(b.z - b.tz, b.x - b.tx);
    const a2 = ang + b.cw * 0.6;
    c.hDes = headingTo(
      b.x,
      b.z,
      b.tx + Math.cos(a2) * b.r,
      b.tz + Math.sin(a2) * b.r,
    );
    b.alt = Math.min(b.altTop, b.alt + 0.8 * dt);
    c.altDes = b.alt;
    c.vDes = b.vBase - 1.2;
    c.soaring = true;
    b.modeT -= dt;
    if (b.modeT <= 0 || b.y >= b.altTop - 1) {
      if (Math.random() < 0.35 && Math.abs(b.z - shoreZ(b.x)) < 200)
        this.startDive(b);
      else this.startCruise(b);
    }
    if (this.rainy(env) && Math.random() < dt * 0.2) this.startCruise(b);
  }

  private bhDive(
    b: Bird,
    dt: number,
    c: Control,
    erratic: number,
    floor: number,
  ): void {
    b.modeT -= dt;
    c.altMin = 0;
    if (b.sub === 0) {
      // Head for the target and dive steeply
      c.hDes = headingTo(b.x, b.z, b.tx, b.tz);
      c.altDes = 3;
      c.vDes = 15;
      c.tuck = 0.55;
      if (b.y > floor + 6) {
        c.pForced = true;
        c.pForce = -0.5 - erratic * 0.1;
      }
      const d = Math.hypot(b.tx - b.x, b.tz - b.z);
      const overWater = b.z < shoreZ(b.x) + 4;
      if ((b.y < 5.5 && overWater) || d < 8 || b.modeT <= 0) {
        b.sub = 1;
        b.modeT = 1 + Math.random() * 1.6;
      }
    } else if (b.sub === 1) {
      // glide along just above the water
      c.hDes = b.h + Math.sin(this.time * 0.9 + b.seed) * 0.3;
      c.altDes = 3;
      c.pForced = true;
      c.pForce = 0;
      c.vDes = 12;
      c.tuck = 0.15;
      if (b.modeT <= 0) {
        b.sub = 2;
        b.alt = 22 + Math.random() * 16;
        b.flapping = true;
        b.flapsLeft = 6 + Math.random() * 3;
        if (b.amp < 0.05) b.phase = Math.PI * 0.5;
      }
    } else {
      // Pull up with a strong wing beat
      c.hDes = b.h;
      c.altDes = b.alt;
      c.vDes = b.vBase;
      c.flapUrge = b.y < b.alt - 6 ? 1 : 0;
      if (b.y > b.alt - 3) this.startCruise(b);
    }
  }

  private bhFollow(
    b: Bird,
    dt: number,
    env: Environment,
    c: Control,
    floor: number,
  ): void {
    const L = this.leaderOf(b);
    if (!L) {
      // The leader is resting/missing: patrol independently for the time being
      if (b.sub !== 1) {
        b.sub = 1;
        b.modeT = 1e9;
        b.altT = 0;
        this.newWaypoint(b);
      }
      this.bhCruise(b, dt, env, c);
      return;
    }
    b.sub = 0;
    const fx = -Math.sin(L.h);
    const fz = -Math.cos(L.h);
    const rx = Math.cos(L.h);
    const rz = -Math.sin(L.h);
    const tx = L.x - fx * b.offB + rx * b.offR;
    const tz = L.z - fz * b.offB + rz * b.offR;
    const dx = tx - b.x;
    const dz = tz - b.z;
    const d = Math.hypot(dx, dz);
    const hTo = headingTo(b.x, b.z, tx, tz);
    if (d > 160 && (b.camDot < 0.2 || b.camDist > 220)) {
      // far behind and out of sight: re-insert it right next to the leader
      this.placeNearLeader(b, L);
      return;
    }
    if (d > 45) {
      c.hDes = hTo;
      c.vDes = 13.5;
    } else {
      c.hDes = mixAngle(L.h, hTo, clamp(d / 12, 0, 1));
      const along = dx * fx + dz * fz;
      c.vDes = L.v + clamp(along * 0.4, -2.5, 2.5);
    }
    c.altDes = L.y + b.offY;
    if (L.mode === M_DIVE) {
      c.altMin = floor;
      c.altDes += 3;
      c.tuck = L.tuck * 0.7;
      c.vDes = Math.max(c.vDes, L.v - 1);
    } else if (L.mode === M_THERMAL) {
      c.soaring = true;
    }
    if (L.flapping && !b.flapping && Math.random() < dt * 1.5) c.flapUrge = 1;
  }

  private separation(b: Bird, c: Control): void {
    for (const o of this.birds) {
      if (o === b || !o.active || o.mode === M_REST) continue;
      const dx = o.x - b.x;
      const dy = o.y - b.y;
      const dz = o.z - b.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 25) continue;
      const w = 1 - Math.sqrt(d2) / 5;
      const rel = wrapAngle(headingTo(b.x, b.z, o.x, o.z) - b.h);
      if (Math.abs(rel) < 1.6) c.hDes -= Math.sign(rel || 1) * w * 0.9;
      c.altDes -= Math.sign(dy || 1) * w * 4;
    }
  }

  private bounds(b: Bird, c: Control): void {
    const sz = shoreZ(b.x);
    if (b.z < sz - 200 || b.x < -330 || b.x > 330 || b.z > 320) {
      c.hDes = headingTo(
        b.x,
        b.z,
        clamp(b.x, -250, 250),
        clamp(b.z, sz + 30, 260),
      );
    }
  }

  private flyControl(
    b: Bird,
    dt: number,
    c: Control,
    floor: number,
    floorAhead: number,
    erratic: number,
    windDrift: number,
  ): void {
    const altMin = Math.max(c.altMin, floor, floorAhead);
    const altDes = clamp(c.altDes, altMin, ALT_MAX);

    // Heading: slight wandering, restless in rain/storm
    const wander =
      (Math.sin(this.time * 0.31 + b.seed) * 0.35 +
        Math.sin(this.time * 1.1 + b.seed * 1.7) * 0.15) *
      (0.4 + erratic * 1.5) *
      (c.soaring ? 0.3 : 1);
    const dh = wrapAngle(c.hDes + wander - b.h);
    const wMax = 0.8 + erratic * 0.5;
    const wDes = clamp(dh * 1.5, -wMax, wMax);
    b.omega += (wDes - b.omega) * Math.min(1, dt * 3);
    b.h = wrapAngle(b.h + b.omega * dt);

    // Bank angle from the turn rate (coordinated turn) plus gusts
    const bankDes =
      -Math.atan((b.v * b.omega) / G) +
      erratic * Math.sin(this.time * 3.3 + b.seed) * 0.15;
    b.roll += (clamp(bankDes, -1.05, 1.05) - b.roll) * Math.min(1, dt * 3.5);

    // Flight path angle from the altitude error; slow = do not climb
    let pDes = c.pForced
      ? c.pForce
      : clamp(Math.atan2(altDes - b.y, 26), -0.5, 0.33);
    if (b.v < 8.5 && pDes > 0.06) pDes = 0.06;
    b.p += (pDes - b.p) * Math.min(1, dt * 2);

    // Speed: target value; climbing brakes, descending accelerates, flapping pushes
    const thrust = b.flapping ? 0.9 : 0;
    b.v += ((c.vDes - b.v) * 0.45 - G * Math.sin(b.p) * 0.35 + thrust) * dt;
    b.v = clamp(b.v, 6, 20);

    const cp = Math.cos(b.p);
    b.x += (-Math.sin(b.h) * cp * b.v + windDrift) * dt;
    b.z += -Math.cos(b.h) * cp * b.v * dt;
    b.y += Math.sin(b.p) * b.v * dt;
    if (b.y < floor) {
      b.y = floor;
      if (b.p < 0.05) b.p = 0.05;
    } else if (b.y > ALT_MAX + 4) {
      b.y = ALT_MAX + 4;
      if (b.p > 0) b.p = 0;
    }

    this.stepFlap(b, dt, c, erratic, altDes - b.y, c.vDes - b.v);
  }

  private stepFlap(
    b: Bird,
    dt: number,
    c: Control,
    erratic: number,
    altErr: number,
    vErr: number,
  ): void {
    const wantClimb = !c.soaring && (altErr > 5 || b.p > 0.15);
    const slow = vErr > 1.8;
    if (b.flapping) {
      b.phase += dt * b.rate * TWO_PI;
      if (b.phase > TWO_PI * 64) b.phase -= TWO_PI * 64;
      b.flapsLeft -= dt * b.rate;
      if (b.flapsLeft <= 0) {
        const keep = c.flapUrge >= 1 || (wantClimb && b.flapsLeft > -2);
        // switch to the glide pose only at the end of the downstroke
        if (!keep && Math.sin(b.phase) < 0.35 && Math.cos(b.phase) < 0) {
          b.flapping = false;
          let g =
            (b.mode === M_THERMAL || c.soaring
              ? 6 + Math.random() * 12
              : 3.5 + Math.random() * 7) *
            (1 - erratic * 0.55);
          if (slow) g *= 0.5;
          b.glideT = g;
        }
      }
    } else {
      b.glideT -= dt * (1 + (wantClimb ? 1.5 : 0) + (slow ? 2 : 0));
      if (b.glideT <= 0 || c.flapUrge >= 1) {
        b.flapping = true;
        b.flapsLeft =
          3 +
          Math.floor(Math.random() * 4) +
          (wantClimb ? 2 : 0) +
          (erratic > 0.4 ? 2 : 0);
        b.rate = 2.6 + Math.random() * 0.8 + erratic * 0.5;
        if (b.amp < 0.05) b.phase = Math.PI * 0.5;
      }
    }
    b.amp += ((b.flapping ? 1 : 0) - b.amp) * Math.min(1, dt * 6);
    b.tuck += (c.tuck - b.tuck) * Math.min(1, dt * 3);
  }

  // ---------------- Resting on the beach ----------------

  private stepRest(b: Bird, dt: number, env: Environment): void {
    if (b.sub === 0) {
      // Approach at a shallow glide angle
      const ground = terrainHeight(b.x, b.z);
      const floor = Math.max(ground, 0) + 3;
      const d = Math.hypot(b.tx - b.x, b.tz - b.z);
      const c = this.ctl;
      c.hDes = headingTo(b.x, b.z, b.tx, b.tz);
      c.altDes = b.restY + 3.2 + Math.min(d, 150) * 0.15;
      c.vDes = 8.5;
      c.pForced = false;
      c.flapUrge = 0;
      c.tuck = 0;
      c.altMin = 0;
      c.soaring = false;
      this.flyControl(b, dt, c, floor, floor, 0, env.wind * 5);
      b.modeT -= dt;
      if (d < 7 && b.y < b.restY + 4.5) {
        b.sub = 1;
        b.flapping = true;
        b.flapsLeft = 99;
        if (b.amp < 0.05) b.phase = Math.PI * 0.5;
      } else if (b.modeT <= 0 || d > 220) {
        this.startCruise(b);
      }
    } else if (b.sub === 1) {
      // Flare: brake, beat the wings, sink
      b.v = Math.max(0, b.v - 7 * dt);
      b.p += (0.4 - b.p) * Math.min(1, dt * 4);
      b.roll += (0 - b.roll) * Math.min(1, dt * 4);
      b.omega = 0;
      b.y = Math.max(b.restY, b.y - 2.2 * dt);
      b.x += -Math.sin(b.h) * b.v * dt;
      b.z += -Math.cos(b.h) * b.v * dt;
      b.phase += dt * 3.4 * TWO_PI;
      b.amp += (1 - b.amp) * Math.min(1, dt * 6);
      b.tuck += (0 - b.tuck) * Math.min(1, dt * 3);
      if (b.v < 0.8 && b.y <= b.restY + 0.05) {
        b.sub = 2;
        b.v = 0;
        b.flapping = false;
        b.modeT = 15 + Math.random() * 30;
        b.restH = Math.PI * 0.5 + (Math.random() - 0.5) * 0.6; // into the wind
      }
    } else if (b.sub === 2) {
      // Resting: wings tucked in, turned into the wind
      b.y = b.restY;
      b.p += (0 - b.p) * Math.min(1, dt * 3);
      b.roll += (0 - b.roll) * Math.min(1, dt * 3);
      b.tuck += (1 - b.tuck) * Math.min(1, dt * 2.5);
      b.amp += (0 - b.amp) * Math.min(1, dt * 6);
      b.h = mixAngle(b.h, b.restH, Math.min(1, dt * 1.2));
      b.modeT -= dt;
      const flushed = b.camDist < 14 || this.rainy(env);
      if (b.modeT <= 0 || flushed) {
        b.sub = 3;
        b.flapping = true;
        b.flapsLeft = 99;
        b.phase = Math.PI * 0.5;
        b.alt = 20 + Math.random() * 15;
      }
    } else {
      // Take-off: beat hard, accelerate, climb
      b.tuck += (0 - b.tuck) * Math.min(1, dt * 5);
      b.amp += (1 - b.amp) * Math.min(1, dt * 8);
      b.phase += dt * 3.6 * TWO_PI;
      b.v = Math.min(9.5, b.v + 6 * dt);
      b.p += (0.32 - b.p) * Math.min(1, dt * 3);
      b.x += -Math.sin(b.h) * Math.cos(b.p) * b.v * dt;
      b.z += -Math.cos(b.h) * Math.cos(b.p) * b.v * dt;
      b.y += (Math.sin(b.p) * b.v + 0.6) * dt;
      if (b.y > b.restY + 5) {
        b.flapsLeft = 4;
        this.startCruise(b);
      }
    }
  }

  // ---------------- Dev / cleanup ----------------

  /** Dev harness only: positions, altitudes and states of all active birds. */
  debugInfo() {
    const r1 = (v: number) => Math.round(v * 10) / 10;
    const birds: Record<string, number | string | boolean>[] = [];
    for (let i = 0; i < this.n; i++) {
      const b = this.birds[i];
      if (!b.active) continue;
      const ground = terrainHeight(b.x, b.z);
      birds.push({
        i,
        x: r1(b.x),
        y: r1(b.y),
        z: r1(b.z),
        ground: r1(ground),
        agl: r1(b.y - Math.max(ground, 0)),
        mode: MODE_NAMES[b.mode],
        sub: b.sub,
        v: r1(b.v),
        roll: Math.round((b.roll * 180) / Math.PI),
        pitch: Math.round((b.p * 180) / Math.PI),
        flap: b.flapping,
        amp: Math.round(b.amp * 100) / 100,
        tuck: Math.round(b.tuck * 100) / 100,
        leader: b.leader ? this.birds.indexOf(b.leader) : -1,
        dist: r1(b.camDist),
        inView: b.camDot > 0.5,
      });
    }
    return { count: this.n, active: birds.length, time: r1(this.time), birds };
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.group.remove(this.mesh);
    this.mesh.dispose();
    this.geo.dispose();
    this.mat.dispose();
  }
}
