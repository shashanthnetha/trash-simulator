// Ground birds in the dune belt: small foraging flocks that walk, run and
// peck, and flush (fly off low and land further away) when the player or the
// jeep comes too close. Complements birds.ts, which owns the gulls in the sky.
//
// Two species, both rendered as one InstancedMesh each (2 draw calls total):
// ringed plover (sandy-brown back, white belly, black breast band + face mask,
// orange legs) and meadow pipit (streaked brown, pale belly). The plumage is a
// procedural canvas atlas; the animation (folded→flapping wings, pecking head,
// twinkling legs, crouch) runs in the vertex shader, driven by two instanced
// vec4 attributes per bird.
//
// The signature ground behaviour is the plover run-stop-peck: a quick scurry,
// an abrupt stop, a few pecks with the head down, look up, repeat – all
// members desynchronised while the flock drifts slowly as a loose group.

import * as THREE from "three";
import { clamp, smoothstep } from "./noise";
import type { Environment } from "./sky";
import { sound } from "./sound";
import { WORLD_BOUNDS, shoreZ, terrainHeight } from "./terrain";
import { makeCanvas, texFromCanvas } from "./textures-core";
import type { QualityId } from "./types";

const TWO_PI = Math.PI * 2;

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const FLOCK_COUNT: Record<QualityId, number> = {
  ultra: 5,
  high: 4,
  medium: 3,
  low: 3,
};
const FLOCK_MIN: Record<QualityId, number> = {
  ultra: 4,
  high: 4,
  medium: 3,
  low: 3,
};
const FLOCK_MAX: Record<QualityId, number> = {
  ultra: 6,
  high: 6,
  medium: 5,
  low: 4,
};

/** Habitat band: inland distance d = z - shoreZ(x) (foredune/dune belt). */
const HABITAT_MIN = 60;
const HABITAT_MAX = 170;
/** Beyond this camera distance a foraging flock freezes (no per-bird work). */
const DORMANT_DIST = 150;
/** A fast vehicle flushes from further away than a walker. */
const FLUSH_JEEP_DIST = 20;
/** playerPos moving faster than this (m/s) counts as the jeep at speed. */
const JEEP_SPEED = 4;
/** Flush flight distance (m) to the new foraging spot. */
const FLIGHT_MIN = 40;
const FLIGHT_MAX = 80;
/** Idle peeps only within this camera distance. */
const PEEP_DIST = 60;
/** Reference range for pan/distance of the flush/peep sounds. */
const SOUND_RANGE = 90;

// ---------------------------------------------------------------------------
// Geometry: parametric small-wader/pipit body with texture-atlas UVs
// ---------------------------------------------------------------------------

interface BirdShape {
  /** Lathe profile [radius, t]; t runs from the tail (negative) to the bill tip. */
  profile: [number, number][];
  /** Above this t the neck/head rises off the body axis with slope liftK. */
  liftT: number;
  liftK: number;
  /** Vertices with t beyond this belong to the head part (peck rotation). */
  headT: number;
  neck: [number, number, number];
  wingRoot: number;
  wingTip: number;
  wingY: number;
  chordRoot: number;
  chordTip: number;
  sweep: number;
  tailZ0: number;
  tailZ1: number;
  tailW0: number;
  tailW1: number;
  hipX: number;
  hipZ: number;
  legTop: number;
  legBot: number;
  /** Body-origin height above the ground when standing. */
  standH: number;
}

/** Ringed plover: plump body, round head, short tail (~19 cm with the bill). */
const PLOVER: BirdShape = {
  profile: [
    [0.0, -0.072],
    [0.013, -0.063],
    [0.024, -0.045],
    [0.031, -0.022],
    [0.034, 0.004],
    [0.032, 0.024],
    [0.026, 0.038],
    [0.022, 0.046],
    [0.0225, 0.054],
    [0.0255, 0.064],
    [0.0245, 0.075],
    [0.018, 0.084],
    [0.009, 0.091],
    [0.004, 0.0945],
    [0.0022, 0.101],
    [0.0, 0.1045],
  ],
  liftT: 0.036,
  liftK: 0.42,
  headT: 0.048,
  neck: [0, 0.01, -0.046],
  wingRoot: 0.01,
  wingTip: 0.11,
  wingY: 0.014,
  chordRoot: 0.048,
  chordTip: 0.016,
  sweep: 0.02,
  tailZ0: 0.056,
  tailZ1: 0.086,
  tailW0: 0.012,
  tailW1: 0.017,
  hipX: 0.011,
  hipZ: 0.006,
  legTop: -0.024,
  legBot: -0.062,
  standH: 0.062,
};

/** Meadow pipit: slimmer, longer tail, finer bill (~17 cm). */
const PIPIT: BirdShape = {
  profile: [
    [0.0, -0.078],
    [0.011, -0.068],
    [0.02, -0.048],
    [0.026, -0.024],
    [0.029, 0.002],
    [0.027, 0.022],
    [0.022, 0.036],
    [0.019, 0.044],
    [0.0195, 0.052],
    [0.022, 0.062],
    [0.021, 0.073],
    [0.015, 0.082],
    [0.008, 0.089],
    [0.0035, 0.093],
    [0.0018, 0.104],
    [0.0, 0.108],
  ],
  liftT: 0.034,
  liftK: 0.4,
  headT: 0.046,
  neck: [0, 0.009, -0.044],
  wingRoot: 0.009,
  wingTip: 0.104,
  wingY: 0.012,
  chordRoot: 0.042,
  chordTip: 0.014,
  sweep: 0.02,
  tailZ0: 0.06,
  tailZ1: 0.108,
  tailW0: 0.01,
  tailW1: 0.015,
  hipX: 0.01,
  hipZ: 0.008,
  legTop: -0.02,
  legBot: -0.058,
  standH: 0.058,
};

// Texture-atlas layout (u,v in [0,1], v upwards as CanvasTexture flips y):
// x < 0.55: the around-body strip (u = angle around the body, belly at the
// wrap seam, back in the middle; v = along the body, tail → bill).
const TEX = 256;
const BODY_U1 = 0.55;
const WING_U0 = 0.58;
const WING_U1 = 0.99;
const WING_V0 = 0.55;
const WING_V1 = 0.99;
const TAIL_U0 = 0.58;
const TAIL_U1 = 0.82;
const TAIL_V0 = 0.28;
const TAIL_V1 = 0.5;
const LEG_U = 0.9;
const LEG_V = 0.1;

const SEG = 12;

type V3 = [number, number, number];

class GB {
  private pos: number[] = [];
  private nrm: number[] = [];
  private uv: number[] = [];
  private part: number[] = [];
  private piv: number[] = [];

  vert(p: V3, n: V3, u: number, v: number, part: number, pivot: V3): void {
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    this.uv.push(u, v);
    this.part.push(part);
    this.piv.push(pivot[0], pivot[1], pivot[2]);
  }

  /** Quad from four (pos, normal, uv) corners; DoubleSide, winding is free. */
  quad(corners: [V3, V3, number, number][], part: number, pivot: V3): void {
    const [a, b, c, d] = corners;
    for (const [p, n, u, v] of [a, b, c, a, c, d])
      this.vert(p, n, u, v, part, pivot);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute("aPart", new THREE.Float32BufferAttribute(this.part, 1));
    g.setAttribute("aPivot", new THREE.Float32BufferAttribute(this.piv, 3));
    return g;
  }
}

function buildBirdGeometry(s: BirdShape): THREE.BufferGeometry {
  const gb = new GB();
  const P = s.profile;
  const t0 = P[0][1];
  const t1 = P[P.length - 1][1];
  const lift = (t: number): number =>
    t > s.liftT ? (t - s.liftT) * s.liftK : 0;

  // Body of revolution with the raised head; the angle runs bottom → top →
  // bottom so the texture wrap seam sits on the (plain) belly.
  const ringVert = (i: number, j: number): [V3, V3, number, number] => {
    const [r, t] = P[i];
    const a = (j / SEG) * TWO_PI - Math.PI;
    const sa = Math.sin(a);
    const ca = Math.cos(a);
    const iPrev = Math.max(0, i - 1);
    const iNext = Math.min(P.length - 1, i + 1);
    const dt = P[iNext][1] - P[iPrev][1] || 1;
    const dr = (P[iNext][0] - P[iPrev][0]) / dt;
    const dl = t > s.liftT ? s.liftK : 0;
    const nz = ca * dl + dr;
    const nl = Math.hypot(sa, ca, nz) || 1;
    const p: V3 = [r * sa, lift(t) + r * ca, -t];
    const n: V3 = [sa / nl, ca / nl, nz / nl];
    const u = (j / SEG) * BODY_U1;
    const v = (t - t0) / (t1 - t0);
    return [p, n, u, v];
  };
  for (let i = 0; i < P.length - 1; i++) {
    const head = P[i][1] >= s.headT || P[i + 1][1] >= s.headT;
    const part = head ? 1 : 0;
    const pivot: V3 = head ? s.neck : [0, 0, 0];
    for (let j = 0; j < SEG; j++) {
      gb.quad(
        [
          ringVert(i, j),
          ringVert(i, j + 1),
          ringVert(i + 1, j + 1),
          ringVert(i + 1, j),
        ],
        part,
        pivot,
      );
    }
  }

  // Wings: flat swept plates, built spread; the shader folds them.
  const span = s.wingTip - s.wingRoot;
  const stations = [0, 0.35, 0.7, 1];
  for (const side of [1, -1]) {
    const pivot: V3 = [side * s.wingRoot, s.wingY, 0];
    const wv = (f: number, cv: number): [V3, V3, number, number] => {
      const x = s.wingRoot + span * f;
      const chord = s.chordRoot + (s.chordTip - s.chordRoot) * f;
      const zc = s.sweep * f * f + 0.003;
      const z = zc - chord * 0.55 + chord * cv;
      const u = WING_U0 + (WING_U1 - WING_U0) * f;
      const v = WING_V0 + (WING_V1 - WING_V0) * cv;
      return [[side * x, s.wingY, z], [0, 1, 0], u, v];
    };
    for (let k = 0; k < stations.length - 1; k++) {
      gb.quad(
        [
          wv(stations[k], 0),
          wv(stations[k + 1], 0),
          wv(stations[k + 1], 1),
          wv(stations[k], 1),
        ],
        side * 2,
        pivot,
      );
    }
  }

  // Tail: a short flat fan behind the body, drooping slightly.
  const tv = (f: number, w: number): [V3, V3, number, number] => {
    const z = s.tailZ0 + (s.tailZ1 - s.tailZ0) * f;
    const hw = s.tailW0 + (s.tailW1 - s.tailW0) * f;
    const y = 0.006 - 0.008 * f;
    const u = TAIL_U0 + (TAIL_U1 - TAIL_U0) * (0.5 + w * 0.5);
    const v = TAIL_V0 + (TAIL_V1 - TAIL_V0) * f;
    return [[hw * w, y, z], [0, 1, 0.12], u, v];
  };
  for (const [f0, f1] of [
    [0, 0.5],
    [0.5, 1],
  ]) {
    gb.quad([tv(f0, -1), tv(f0, 1), tv(f1, 1), tv(f1, -1)], 0, [0, 0, 0]);
  }

  // Legs: two thin crossed strips per side (read from the side AND the front).
  const legUV: [number, number] = [LEG_U, LEG_V];
  for (const side of [1, -1]) {
    const x = side * s.hipX;
    const pivot: V3 = [x, s.legTop + 0.004, s.hipZ];
    const part = side * 3;
    const w = 0.0022;
    gb.quad(
      [
        [[x, s.legTop, s.hipZ - w], [side, 0, 0], legUV[0], legUV[1]],
        [[x, s.legTop, s.hipZ + w], [side, 0, 0], legUV[0], legUV[1]],
        [[x, s.legBot, s.hipZ + w * 0.7], [side, 0, 0], legUV[0], legUV[1]],
        [[x, s.legBot, s.hipZ - w * 0.7], [side, 0, 0], legUV[0], legUV[1]],
      ],
      part,
      pivot,
    );
    const w2 = 0.0016;
    gb.quad(
      [
        [[x - w2, s.legTop, s.hipZ], [0, 0, -1], legUV[0], legUV[1]],
        [[x + w2, s.legTop, s.hipZ], [0, 0, -1], legUV[0], legUV[1]],
        [[x + w2, s.legBot, s.hipZ], [0, 0, -1], legUV[0], legUV[1]],
        [[x - w2, s.legBot, s.hipZ], [0, 0, -1], legUV[0], legUV[1]],
      ],
      part,
      pivot,
    );
  }

  return gb.build();
}

// ---------------------------------------------------------------------------
// Plumage: procedural canvas atlas per species
// ---------------------------------------------------------------------------

function paintBird(species: number, s: BirdShape): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(TEX, TEX);
  const X = (u: number) => u * TEX;
  const Y = (v: number) => (1 - v) * TEX;
  const vt = (t: number) =>
    (t - s.profile[0][1]) /
    (s.profile[s.profile.length - 1][1] - s.profile[0][1]);
  /** Band around the whole body between v0..v1, out to |angle| thMax from the top. */
  const ring = (v0: number, v1: number, thMax: number, col: string) => {
    ctx.fillStyle = col;
    const du = thMax / TWO_PI;
    ctx.fillRect(
      X((0.5 - du) * BODY_U1),
      Y(v1),
      2 * du * BODY_U1 * TEX,
      (v1 - v0) * TEX,
    );
  };
  /** Two mirrored side bands (|angle| in th0..th1 from the top). */
  const sides = (
    v0: number,
    v1: number,
    th0: number,
    th1: number,
    col: string,
  ) => {
    ctx.fillStyle = col;
    const u0 = th0 / TWO_PI;
    const u1 = th1 / TWO_PI;
    const w = (u1 - u0) * BODY_U1 * TEX;
    const h = (v1 - v0) * TEX;
    ctx.fillRect(X((0.5 + u0) * BODY_U1), Y(v1), w, h);
    ctx.fillRect(X((0.5 - u1) * BODY_U1), Y(v1), w, h);
  };
  const wingRect = (
    s0: number,
    s1: number,
    c0: number,
    c1: number,
    col: string,
  ) => {
    ctx.fillStyle = col;
    const x0 = WING_U0 + (WING_U1 - WING_U0) * s0;
    const x1 = WING_U0 + (WING_U1 - WING_U0) * s1;
    const vLo = WING_V0 + (WING_V1 - WING_V0) * c0;
    const vHi = WING_V0 + (WING_V1 - WING_V0) * c1;
    ctx.fillRect(X(x0), Y(vHi), (x1 - x0) * TEX, (vHi - vLo) * TEX);
  };
  const tailRect = (
    u0: number,
    u1: number,
    f0: number,
    f1: number,
    col: string,
  ) => {
    ctx.fillStyle = col;
    const x0 = TAIL_U0 + (TAIL_U1 - TAIL_U0) * u0;
    const x1 = TAIL_U0 + (TAIL_U1 - TAIL_U0) * u1;
    const vLo = TAIL_V0 + (TAIL_V1 - TAIL_V0) * f0;
    const vHi = TAIL_V0 + (TAIL_V1 - TAIL_V0) * f1;
    ctx.fillRect(X(x0), Y(vHi), (x1 - x0) * TEX, (vHi - vLo) * TEX);
  };

  if (species === 0) {
    // Ringed plover
    const BROWN = "#8b7156";
    const BLACK = "#17181b";
    const WHITE = "#f2efe8";
    ctx.fillStyle = WHITE;
    ctx.fillRect(0, 0, TEX, TEX);
    ring(vt(-0.07), vt(0.036), 1.55, BROWN); // upperparts
    ring(vt(0.028), vt(0.044), Math.PI, BLACK); // breast band (full ring)
    ring(vt(0.044), vt(0.055), Math.PI, WHITE); // white collar
    ring(vt(0.055), vt(0.083), 1.3, BROWN); // crown
    sides(vt(0.058), vt(0.094), 0.95, 1.9, BLACK); // eye mask / ear coverts
    ring(vt(0.082), vt(0.089), 1.15, BLACK); // frontal bar
    ring(vt(0.089), vt(0.0945), 1.15, WHITE); // white forehead
    ring(vt(0.0945), vt(0.1), Math.PI, "#e2801f"); // bill base orange
    ring(vt(0.1), 1.0, Math.PI, "#191a1c"); // bill tip
    // Wing: brown coverts, dark primaries with black tips, white wingbar
    wingRect(0, 1, 0, 1, BROWN);
    wingRect(0.55, 1, 0.1, 1, "#4a4136");
    wingRect(0.8, 1, 0.5, 1, "#23211e");
    wingRect(0.12, 0.85, 0.42, 0.56, WHITE);
    // Tail: white sides, brown centre, dark subterminal band
    tailRect(0, 1, 0, 1, WHITE);
    tailRect(0.3, 0.7, 0, 1, "#6e5c49");
    tailRect(0.15, 0.85, 0.72, 0.95, "#2a2723");
    // Legs: orange
    ctx.fillStyle = "#e2891f";
    ctx.fillRect(X(LEG_U) - 14, Y(LEG_V) - 14, 28, 28);
  } else {
    // Meadow pipit
    const BROWN = "#7c6c4e";
    const STREAK = "#42392a";
    ctx.fillStyle = "#ede4c8";
    ctx.fillRect(0, 0, TEX, TEX);
    ring(vt(-0.074), vt(0.04), 1.55, BROWN); // upperparts
    ring(vt(0.052), vt(0.086), 1.25, BROWN); // crown
    sides(vt(0.056), vt(0.088), 1.05, 1.28, "#eae1c2"); // supercilium
    ctx.fillStyle = STREAK;
    for (let i = 0; i < 20; i++) {
      // mantle streaks
      const th = (Math.random() * 2 - 1) * 1.35;
      const u = (0.5 + th / TWO_PI) * BODY_U1;
      const v = vt(-0.062) + Math.random() * (vt(0.036) - vt(-0.062));
      ctx.fillRect(X(u), Y(v), 1.6 + Math.random(), 6 + Math.random() * 9);
    }
    for (let i = 0; i < 8; i++) {
      // crown streaks
      const th = (Math.random() * 2 - 1) * 1.05;
      const u = (0.5 + th / TWO_PI) * BODY_U1;
      const v = vt(0.056) + Math.random() * (vt(0.084) - vt(0.056));
      ctx.fillRect(X(u), Y(v), 1.4, 3 + Math.random() * 3);
    }
    ctx.fillStyle = "#4d4430";
    for (let i = 0; i < 14; i++) {
      // breast/flank streaks
      const th = (1.9 + Math.random()) * (Math.random() < 0.5 ? 1 : -1);
      const u = (0.5 + th / TWO_PI) * BODY_U1;
      const v = vt(-0.008) + Math.random() * (vt(0.034) - vt(-0.008));
      ctx.fillRect(X(u), Y(v), 1.5, 3.5 + Math.random() * 3.5);
    }
    // Eyes: dark dot on each side of the head
    ctx.fillStyle = "#17181a";
    for (const sgn of [1, -1]) {
      const u = (0.5 + (sgn * 1.42) / TWO_PI) * BODY_U1;
      ctx.beginPath();
      ctx.arc(X(u), Y(vt(0.067)), 2.6, 0, TWO_PI);
      ctx.fill();
    }
    ring(vt(0.091), 1.0, Math.PI, "#4d463b"); // fine dark bill
    // Wing: brown with darker primaries and two pale wingbars
    wingRect(0, 1, 0, 1, "#6f6046");
    wingRect(0.6, 1, 0.25, 1, "#4b4232");
    wingRect(0.08, 0.82, 0.36, 0.44, "#e3d9ba");
    wingRect(0.08, 0.85, 0.58, 0.66, "#e3d9ba");
    // Tail: dark with white outer edges
    tailRect(0, 1, 0, 1, "#4a4335");
    tailRect(0, 0.12, 0, 1, "#efe9d8");
    tailRect(0.88, 1, 0, 1, "#efe9d8");
    // Legs: pale pinkish
    ctx.fillStyle = "#d8a481";
    ctx.fillRect(X(LEG_U) - 14, Y(LEG_V) - 14, 28, 28);
  }
  return texFromCanvas(c, true, false, false);
}

// ---------------------------------------------------------------------------
// Shader extension: per-instance pose (wings, head, legs, crouch)
// ---------------------------------------------------------------------------

// aBird1 = (wingSpread 0..1, flapPhase, runPhase, runAmp)
// aBird2 = (headPitch +down, crouch 0..1, legTuck -reach..+tucked, unused)
const VERT_HEAD = /* glsl */ `
attribute float aPart;
attribute vec3 aPivot;
attribute vec4 aBird1;
attribute vec4 aBird2;
mat3 dbRotX(float a) {
  float c = cos(a); float s = sin(a);
  return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c);
}
mat3 dbRotY(float a) {
  float c = cos(a); float s = sin(a);
  return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
}
mat3 dbRotZ(float a) {
  float c = cos(a); float s = sin(a);
  return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0);
}
`;

const VERT_NORMAL = /* glsl */ `
#include <beginnormal_vertex>
float dbSide = aPart < 0.0 ? -1.0 : 1.0;
float dbSeg = abs(aPart);
mat3 dbR = mat3(1.0);
if (dbSeg > 2.5) {
  // Legs: alternating run swing, tucked backwards in flight
  float dbSw = sin(aBird1.z + (dbSide < 0.0 ? 3.14159 : 0.0)) * 0.85 * aBird1.w;
  dbR = dbRotX(dbSw - 1.25 * aBird2.z);
} else if (dbSeg > 1.5) {
  // Wings: folded along the flank -> spread and flapping
  float dbTh = mix(-0.92, sin(aBird1.y) * 1.05 + 0.12, aBird1.x);
  float dbSweep = (1.0 - aBird1.x) * 1.05;
  dbR = dbRotZ(dbSide * dbTh) * dbRotY(-dbSide * dbSweep);
} else if (dbSeg > 0.5) {
  // Head: peck rotation about the neck
  dbR = dbRotX(-aBird2.x);
}
objectNormal = dbR * objectNormal;
`;

const VERT_POS = /* glsl */ `
#include <begin_vertex>
if (dbSeg > 0.5) transformed = aPivot + dbR * (transformed - aPivot);
if (dbSeg > 2.5) {
  // Crouch: the legs shorten ...
  transformed.y = aPivot.y + (transformed.y - aPivot.y) * (1.0 - 0.45 * max(aBird2.y, 0.0));
} else {
  // ... while everything above them settles down
  transformed.y -= aBird2.y * 0.016;
}
`;

function makeMaterial(tex: THREE.Texture): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    map: tex,
    roughness: 0.92,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = `${VERT_HEAD}\n${shader.vertexShader}`
      .replace("#include <beginnormal_vertex>", VERT_NORMAL)
      .replace("#include <begin_vertex>", VERT_POS);
  };
  return m;
}

// ---------------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------------

const S_FORAGE = 0;
const S_FLUSHWAIT = 1;
const S_FLY = 2;
const S_LAND = 3;

const F_RUN = 0;
const F_STOP = 1;
const F_PECK = 2;
const F_LOOK = 3;

const STATE_NAMES = ["forage", "flushwait", "fly", "land"];

function rnd(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

function wrapAngle(a: number): number {
  return a - TWO_PI * Math.round(a / TWO_PI);
}

/** Heading from (fx,fz) to (tx,tz); forward = (-sin h, -cos h). */
function headingTo(fx: number, fz: number, tx: number, tz: number): number {
  return Math.atan2(-(tx - fx), -(tz - fz));
}

function approach(cur: number, to: number, rate: number, dt: number): number {
  return cur + (to - cur) * Math.min(1, rate * dt);
}

/** Distance of the segment (x0,z0)-(x1,z1) to the point (px,pz). */
function segPointDist(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  px: number,
  pz: number,
): number {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len2 = dx * dx + dz * dz;
  const t =
    len2 > 1e-6 ? clamp(((px - x0) * dx + (pz - z0) * dz) / len2, 0, 1) : 0;
  return Math.hypot(x0 + dx * t - px, z0 + dz * t - pz);
}

/**
 * The low flight arc from the flock to a candidate landing spot must not
 * cross the recycling station – the birds fly at chest height. A path is
 * rejected when it dips under 45 m from the station AND closer than its own
 * endpoints get (both are validGround-legal down to 40 m, so a flock sitting
 * in that annulus may still skim past – it just must never cut inward).
 * Boat, camp and containers lie outside the habitat band, never crossed.
 */
function flightPathClear(
  fx: number,
  fz: number,
  tx: number,
  tz: number,
): boolean {
  const seg = segPointDist(fx, fz, tx, tz, 96, 118);
  const ends = Math.min(
    Math.hypot(fx - 96, fz - 118),
    Math.hypot(tx - 96, tz - 118),
  );
  return seg >= Math.min(45, ends - 0.5);
}

/** A spot ground birds accept: dune belt, outside corridor and forecourt. */
function validGround(x: number, z: number): boolean {
  if (x < WORLD_BOUNDS.minX + 20 || x > WORLD_BOUNDS.maxX - 20) return false;
  const d = z - shoreZ(x);
  if (d < HABITAT_MIN || d > HABITAT_MAX) return false;
  // Driving corridor beach -> station (meandering wind gap, kept clear)
  if (z > 20 && z < 300) {
    const cx = 86 + Math.sin((z - 60) * 0.012) * 10;
    if (Math.abs(x - cx) < 40) return false;
  }
  // Station forecourt
  if (Math.hypot(x - 96, z - 118) < 40) return false;
  return true;
}

class GroundBird {
  x = 0;
  y = 0;
  z = 0;
  yaw = 0;
  pitch = 0;
  roll = 0;
  v = 0;
  scale = 1;
  state = S_FORAGE;
  sub = F_LOOK;
  t = 0.5;
  tx = 0;
  tz = 0;
  /** Landing point of the current flight. */
  lx = 0;
  lz = 0;
  flightDist = 1;
  flightT = 0;
  arcH = 3;
  runSpeed = 1.8;
  vMax = 10;
  flapRate = 9;
  pecksLeft = 0;
  peckT = 0;
  head = 0;
  crouch = 0;
  spread = 0;
  flapPhase = 0;
  runPhase = 0;
  runAmp = 0;
  legTuck = 0;
  stagger = 0;
}

class Flock {
  readonly species: number;
  readonly slot0: number;
  readonly size: number;
  readonly birds: GroundBird[] = [];
  enabled = false;
  ax = 0;
  az = 0;
  flushDist = 12;
  peepT = rnd(20, 60);
  driftA = 0;
  driftT = 0;
  camDist = 1e9;
  /** Pending second flush sound (staggered), <= 0 = none. */
  sndT2 = 0;

  constructor(species: number, slot0: number, size: number) {
    this.species = species;
    this.slot0 = slot0;
    this.size = size;
    this.flushDist = rnd(10, 14);
    for (let i = 0; i < size; i++) {
      const b = new GroundBird();
      b.scale = rnd(0.92, 1.08);
      this.birds.push(b);
    }
  }

  flying(): boolean {
    for (const b of this.birds) if (b.state !== S_FORAGE) return true;
    return false;
  }
}

// ---------------------------------------------------------------------------

export class DuneBirds {
  protected readonly scene: THREE.Scene;
  protected readonly quality: QualityId;

  private readonly meshes: THREE.InstancedMesh[] = [];
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.MeshStandardMaterial[] = [];
  private readonly texes: THREE.CanvasTexture[] = [];
  private readonly attr1: THREE.InstancedBufferAttribute[] = [];
  private readonly attr2: THREE.InstancedBufferAttribute[] = [];
  private readonly flocks: Flock[] = [];

  private time = 0;
  private started = false;
  private hidden = false;
  private popT = 0;
  private lastFlushSnd = -10;
  private playerSpeed = 0;
  private prevPlayer = new THREE.Vector3();
  private havePrev = false;
  private tmpB = new THREE.Vector3();
  private camRight = new THREE.Vector3();
  private sndPan = 0;
  private sndDist = 1;

  constructor(scene: THREE.Scene, quality: QualityId) {
    this.scene = scene;
    this.quality = quality;

    const nFlocks = FLOCK_COUNT[quality];
    const maxSize = FLOCK_MAX[quality];
    const perSpecies = [0, 0];
    for (let i = 0; i < nFlocks; i++) perSpecies[i % 2]++;

    for (let sp = 0; sp < 2; sp++) {
      const shape = sp === 0 ? PLOVER : PIPIT;
      const cap = Math.max(1, perSpecies[sp] * maxSize);
      const geo = buildBirdGeometry(shape);
      const a1 = new THREE.InstancedBufferAttribute(
        new Float32Array(cap * 4),
        4,
      );
      const a2 = new THREE.InstancedBufferAttribute(
        new Float32Array(cap * 4),
        4,
      );
      a1.setUsage(THREE.DynamicDrawUsage);
      a2.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute("aBird1", a1);
      geo.setAttribute("aBird2", a2);
      const tex = paintBird(sp, shape);
      const mat = makeMaterial(tex);
      const mesh = new THREE.InstancedMesh(geo, mat, cap);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      const arr = mesh.instanceMatrix.array as Float32Array;
      arr.fill(0);
      for (let i = 0; i < cap; i++) arr[i * 16 + 15] = 1;
      scene.add(mesh);
      this.meshes.push(mesh);
      this.geos.push(geo);
      this.mats.push(mat);
      this.texes.push(tex);
      this.attr1.push(a1);
      this.attr2.push(a2);
    }

    const nextSlot = [0, 0];
    for (let i = 0; i < nFlocks; i++) {
      const sp = i % 2;
      const size = Math.round(rnd(FLOCK_MIN[quality], FLOCK_MAX[quality]));
      this.flocks.push(new Flock(sp, nextSlot[sp], size));
      nextSlot[sp] += maxSize;
    }
  }

  // --------------------------- Audio helpers ---------------------------

  /** Pan (−1..1 along the camera's right) + normalised distance of a point. */
  private listen(
    x: number,
    y: number,
    z: number,
    range: number,
    camera: THREE.PerspectiveCamera,
  ): number {
    this.tmpB.set(x, y, z).sub(camera.position);
    const d = this.tmpB.length();
    if (d > 1e-3) {
      this.camRight.setFromMatrixColumn(camera.matrixWorld, 0);
      this.sndPan = clamp(this.tmpB.dot(this.camRight) / d, -1, 1);
    } else {
      this.sndPan = 0;
    }
    this.sndDist = clamp(d / range, 0, 1);
    return d;
  }

  // --------------------------- Placement ---------------------------

  private findSpot(
    cx: number,
    cz: number,
    px: number,
    pz: number,
    dMin: number,
    dMax: number,
  ): [number, number] | null {
    for (let k = 0; k < 30; k++) {
      const a = Math.random() * TWO_PI;
      const d = dMin + Math.random() * (dMax - dMin);
      const x = cx + Math.cos(a) * d;
      const z = cz + Math.sin(a) * d;
      if (!validGround(x, z)) continue;
      if (Math.hypot(x - px, z - pz) < 30) continue;
      return [x, z];
    }
    return null;
  }

  private placeFlock(f: Flock, x: number, z: number): void {
    f.ax = x;
    f.az = z;
    for (const b of f.birds) {
      const a = Math.random() * TWO_PI;
      const r = 1 + Math.random() * 3;
      b.x = x + Math.cos(a) * r;
      b.z = z + Math.sin(a) * r;
      b.y = terrainHeight(b.x, b.z) + this.standH(f) * b.scale;
      b.yaw = Math.random() * TWO_PI;
      b.state = S_FORAGE;
      b.sub = F_LOOK;
      b.t = rnd(0.1, 1.2);
      b.v = 0;
      b.pitch = 0;
      b.roll = 0;
      b.spread = 0;
      b.runAmp = 0;
      b.head = 0;
      b.crouch = 0;
      b.legTuck = 0;
    }
  }

  private standH(f: Flock): number {
    return f.species === 0 ? PLOVER.standH : PIPIT.standH;
  }

  private enableFlock(f: Flock, x: number, z: number): void {
    f.enabled = true;
    this.placeFlock(f, x, z);
  }

  private disableFlock(f: Flock): void {
    f.enabled = false;
    f.camDist = 1e9;
    const arr = this.meshes[f.species].instanceMatrix.array as Float32Array;
    for (let i = 0; i < f.size; i++) {
      const o = (f.slot0 + i) * 16;
      arr.fill(0, o, o + 16);
      arr[o + 15] = 1;
    }
    this.meshes[f.species].instanceMatrix.needsUpdate = true;
  }

  // --------------------------- Population ---------------------------

  private adjustPopulation(
    env: Environment,
    camX: number,
    camZ: number,
    px: number,
    pz: number,
  ): void {
    const target = this.hidden
      ? 0
      : Math.max(
          1,
          Math.round(this.flocks.length * smoothstep(0.05, 0.4, env.dayI)),
        );
    let active = 0;
    for (const f of this.flocks) if (f.enabled) active++;
    if (active < target) {
      const f = this.flocks.find((fl) => !fl.enabled);
      if (f) {
        const spot = this.findSpot(camX, camZ, px, pz, 60, 150);
        if (spot) this.enableFlock(f, spot[0], spot[1]);
      }
    } else if (active > target) {
      // only remove flocks that are far away (no pop-out in view)
      let best: Flock | null = null;
      let bestD = 120;
      for (const f of this.flocks) {
        // Never despawn a flock in the air – its anchor is already the far
        // landing point while the birds may still be on screen.
        if (f.enabled && !f.flying() && f.camDist > bestD) {
          bestD = f.camDist;
          best = f;
        }
      }
      if (best) this.disableFlock(best);
    }
  }

  // --------------------------- Flush ---------------------------

  private flushFlock(
    f: Flock,
    playerPos: THREE.Vector3,
    env: Environment,
    camera: THREE.PerspectiveCamera,
  ): void {
    // New foraging spot: away from the threat, drifting a bit downwind
    const away = Math.atan2(f.az - playerPos.z, f.ax - playerPos.x);
    let tx = f.ax;
    let tz = f.az;
    let found = false;
    for (let k = 0; k < 24 && !found; k++) {
      const a = away + rnd(-0.9, 0.9);
      const d = rnd(FLIGHT_MIN, FLIGHT_MAX);
      const x = f.ax + Math.cos(a) * d + env.wind * rnd(0, 18);
      const z = f.az + Math.sin(a) * d;
      if (!validGround(x, z)) continue;
      if (!flightPathClear(f.ax, f.az, x, z)) continue;
      tx = x;
      tz = z;
      found = true;
    }
    if (!found) {
      for (let k = 0; k < 12 && !found; k++) {
        const a = (k / 12) * TWO_PI;
        const x = f.ax + Math.cos(a) * 60;
        const z = f.az + Math.sin(a) * 60;
        if (!validGround(x, z)) continue;
        if (!flightPathClear(f.ax, f.az, x, z)) continue;
        if (Math.hypot(x - playerPos.x, z - playerPos.z) < 30) continue;
        tx = x;
        tz = z;
        found = true;
      }
    }
    f.ax = tx;
    f.az = tz;
    for (const b of f.birds) {
      b.state = S_FLUSHWAIT;
      b.stagger = rnd(0.02, 0.5);
      const a = Math.random() * TWO_PI;
      const r = Math.random() * 3.5;
      b.lx = tx + Math.cos(a) * r;
      b.lz = tz + Math.sin(a) * r;
      b.arcH = rnd(2.5, 5);
      b.vMax = rnd(9, 12);
      b.flapRate = rnd(8.5, 11);
      b.flightT = 0;
    }
    // ONE flush sound for the whole flock (occasionally a second, staggered)
    const gy = terrainHeight(f.ax, f.az);
    this.listen(f.ax, gy + 1, f.az, SOUND_RANGE, camera);
    if (this.time - this.lastFlushSnd > 0.6) {
      sound.birdFlush(this.sndPan, this.sndDist);
      this.lastFlushSnd = this.time;
      if (f.size >= 5 && Math.random() < 0.6) f.sndT2 = rnd(0.15, 0.3);
    }
  }

  // --------------------------- Bird step ---------------------------

  private newForageTarget(b: GroundBird, f: Flock): void {
    for (let k = 0; k < 6; k++) {
      const a = Math.random() * TWO_PI;
      const r = 1 + Math.random() * 6;
      const x = f.ax + Math.cos(a) * r;
      const z = f.az + Math.sin(a) * r;
      if (!validGround(x, z)) continue;
      const d = Math.hypot(x - b.x, z - b.z);
      if (d < 0.8 || d > 7) continue;
      b.tx = x;
      b.tz = z;
      b.runSpeed = rnd(1.4, 2.4);
      b.sub = F_RUN;
      b.t = rnd(0.5, 1.5);
      return;
    }
    // Fallback: trot back towards the anchor
    b.tx = f.ax;
    b.tz = f.az;
    b.runSpeed = rnd(1.4, 2);
    b.sub = F_RUN;
    b.t = rnd(0.5, 1.2);
  }

  private stepForage(b: GroundBird, f: Flock, dt: number): void {
    const ground = terrainHeight(b.x, b.z);
    b.t -= dt;
    let headTgt = 0;
    let crouchTgt = 0;
    if (b.sub === F_RUN) {
      const dx = b.tx - b.x;
      const dz = b.tz - b.z;
      const d = Math.hypot(dx, dz);
      const des = headingTo(b.x, b.z, b.tx, b.tz);
      const dh = wrapAngle(des - b.yaw);
      b.yaw = wrapAngle(b.yaw + clamp(dh, -8 * dt, 8 * dt));
      b.v = approach(b.v, b.runSpeed, 10, dt);
      b.runAmp = approach(b.runAmp, 1, 10, dt);
      b.runPhase += dt * TWO_PI * (7 + b.v * 3);
      b.x += -Math.sin(b.yaw) * b.v * dt;
      b.z += -Math.cos(b.yaw) * b.v * dt;
      headTgt = 0.12; // head level, slightly forward while running
      if (d < 0.18 || b.t <= 0) {
        b.sub = F_STOP;
        b.t = rnd(0.08, 0.22);
      }
    } else if (b.sub === F_STOP) {
      // The abrupt plover stop
      b.v = Math.max(0, b.v - 26 * dt);
      b.runAmp = approach(b.runAmp, 0, 14, dt);
      b.x += -Math.sin(b.yaw) * b.v * dt;
      b.z += -Math.cos(b.yaw) * b.v * dt;
      if (b.t <= 0) {
        if (Math.random() < 0.72) {
          b.sub = F_PECK;
          b.pecksLeft = 1 + Math.floor(Math.random() * 3);
          b.peckT = 0;
        } else {
          b.sub = F_LOOK;
          b.t = rnd(0.3, 1.2);
        }
      }
    } else if (b.sub === F_PECK) {
      b.v = 0;
      b.runAmp = approach(b.runAmp, 0, 14, dt);
      const cycle = 0.42;
      b.peckT += dt;
      const ph = b.peckT / cycle;
      headTgt = ph < 0.5 ? 1.25 : 0.1;
      crouchTgt = ph < 0.5 ? 0.55 : 0.1;
      if (b.peckT >= cycle) {
        b.peckT = 0;
        b.pecksLeft--;
        if (b.pecksLeft <= 0) {
          b.sub = F_LOOK;
          b.t = rnd(0.4, 1.4);
        }
      }
    } else {
      // F_LOOK: upright, alert, then pick the next scurry
      b.v = 0;
      b.runAmp = approach(b.runAmp, 0, 10, dt);
      headTgt = -0.12;
      if (b.t <= 0) this.newForageTarget(b, f);
    }
    b.head = approach(b.head, headTgt, 14, dt);
    b.crouch = approach(b.crouch, crouchTgt, 10, dt);
    b.spread = approach(b.spread, 0, 8, dt);
    b.legTuck = approach(b.legTuck, 0, 8, dt);
    // Body tips forward with the pecking head; light bob while running
    b.pitch = approach(b.pitch, -Math.max(b.head, 0) * 0.4, 10, dt);
    b.roll = approach(b.roll, 0, 6, dt);
    const bob = Math.sin(b.runPhase) * 0.004 * b.runAmp;
    b.y =
      ground +
      this.standH(f) * b.scale * (1 - 0.28 * b.crouch) +
      bob -
      Math.max(b.head, 0) * 0.012;
  }

  private stepFlight(b: GroundBird, f: Flock, dt: number): void {
    if (b.state === S_FLUSHWAIT) {
      b.stagger -= dt;
      b.crouch = approach(b.crouch, 1, 9, dt);
      b.head = approach(b.head, -0.2, 10, dt);
      b.v = Math.max(0, b.v - 20 * dt);
      b.runAmp = approach(b.runAmp, 0, 12, dt);
      if (b.stagger <= 0) {
        b.state = S_FLY;
        b.crouch = 0;
        b.v = 2.5;
        b.flapPhase = Math.random() * TWO_PI;
        b.flightDist = Math.max(4, Math.hypot(b.lx - b.x, b.lz - b.z));
      }
      return;
    }
    const ground = terrainHeight(b.x, b.z);
    b.spread = approach(b.spread, 1, 9, dt);
    b.flapPhase += dt * TWO_PI * b.flapRate;
    if (b.flapPhase > TWO_PI * 64) b.flapPhase -= TWO_PI * 64;
    b.runAmp = approach(b.runAmp, 0, 8, dt);
    b.head = approach(b.head, 0, 8, dt);

    if (b.state === S_FLY) {
      b.flightT += dt;
      const dx = b.lx - b.x;
      const dz = b.lz - b.z;
      const dRem = Math.hypot(dx, dz);
      const des = headingTo(b.x, b.z, b.lx, b.lz);
      const dh = wrapAngle(des - b.yaw);
      const step = clamp(dh, -3.5 * dt, 3.5 * dt);
      b.yaw = wrapAngle(b.yaw + step);
      b.roll = approach(b.roll, clamp(-dh * 0.9, -0.55, 0.55), 5, dt);
      b.v = approach(b.v, b.vMax, 2.2, dt);
      b.legTuck = approach(b.legTuck, 1, 4, dt);
      const prog = clamp(1 - dRem / b.flightDist, 0, 1);
      const gAhead = terrainHeight(
        b.x - Math.sin(b.yaw) * 8,
        b.z - Math.cos(b.yaw) * 8,
      );
      const agl = Math.max(
        0.6,
        b.arcH * Math.sin(Math.PI * Math.min(prog, 0.95)),
      );
      const yDes = Math.max(ground, gAhead) + agl;
      b.y = approach(b.y, yDes, 2.8, dt);
      b.y = Math.max(b.y, ground + 0.25);
      b.pitch = approach(b.pitch, clamp((yDes - b.y) * 0.5, -0.55, 0.7), 4, dt);
      b.x += -Math.sin(b.yaw) * b.v * dt;
      b.z += -Math.cos(b.yaw) * b.v * dt;
      if (dRem < 3 || b.flightT > 15) {
        b.state = S_LAND;
        b.sub = 0;
      }
      return;
    }
    // S_LAND
    if (b.sub === 0) {
      // Flare: nose up, rapid braking flaps, legs reaching
      b.v = approach(b.v, 2, 6, dt);
      b.pitch = approach(b.pitch, 0.6, 6, dt);
      b.roll = approach(b.roll, 0, 6, dt);
      b.legTuck = approach(b.legTuck, -0.35, 8, dt);
      b.flapPhase += dt * TWO_PI * 4; // extra-fast beats on top of flapRate
      const yDes = ground + this.standH(f) * b.scale;
      b.y = approach(b.y, yDes, 4.5, dt);
      b.x += -Math.sin(b.yaw) * b.v * dt;
      b.z += -Math.cos(b.yaw) * b.v * dt;
      if (b.y - yDes < 0.02) {
        b.sub = 1;
        b.runAmp = 1;
      }
    } else {
      // Run-out: touch down running, fold the wings, decelerate
      b.v = Math.max(0, b.v - 5 * dt);
      b.pitch = approach(b.pitch, 0, 8, dt);
      b.legTuck = approach(b.legTuck, 0, 10, dt);
      b.spread = approach(b.spread, 0, 6, dt);
      b.runAmp = approach(b.runAmp, 1, 10, dt);
      b.runPhase += dt * TWO_PI * (7 + b.v * 3);
      b.x += -Math.sin(b.yaw) * b.v * dt;
      b.z += -Math.cos(b.yaw) * b.v * dt;
      b.y = ground + this.standH(f) * b.scale;
      if (b.v < 0.25) {
        b.state = S_FORAGE;
        b.sub = F_LOOK;
        b.t = rnd(0.3, 0.9);
      }
    }
  }

  // --------------------------- Instance write ---------------------------

  private writeBird(f: Flock, i: number): void {
    const b = f.birds[i];
    const slot = f.slot0 + i;
    const mat = this.meshes[f.species].instanceMatrix.array as Float32Array;
    const a1 = this.attr1[f.species].array as Float32Array;
    const a2 = this.attr2[f.species].array as Float32Array;
    const ch = Math.cos(b.yaw);
    const sh = Math.sin(b.yaw);
    const cp = Math.cos(b.pitch);
    const sp = Math.sin(b.pitch);
    const cr = Math.cos(b.roll);
    const sr = Math.sin(b.roll);
    const fx = -sh * cp;
    const fy = sp;
    const fz = -ch * cp;
    const r0x = ch;
    const r0z = -sh;
    const u0x = sh * sp;
    const u0y = cp;
    const u0z = ch * sp;
    const s = b.scale;
    const o = slot * 16;
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
    const a = slot * 4;
    a1[a] = b.spread;
    a1[a + 1] = b.flapPhase;
    a1[a + 2] = b.runPhase;
    a1[a + 3] = b.runAmp;
    a2[a] = b.head;
    a2[a + 1] = b.crouch;
    a2[a + 2] = b.legTuck;
    a2[a + 3] = 0;
  }

  // --------------------------- Update ---------------------------

  /** Runs only while the game is running; playerPos = player or jeep. */
  update(
    dt: number,
    playerPos: THREE.Vector3,
    env: Environment,
    camera: THREE.PerspectiveCamera,
  ): void {
    if (dt <= 0) return;
    const step = Math.min(dt, 0.05);
    this.time += step;

    // Speed of the focus point: a fast mover is the jeep
    if (this.havePrev) {
      const inst = this.tmpB.copy(playerPos).sub(this.prevPlayer).length() / dt;
      this.playerSpeed = approach(
        this.playerSpeed,
        Math.min(inst, 40),
        4,
        step,
      );
    }
    this.prevPlayer.copy(playerPos);
    this.havePrev = true;

    const camX = camera.position.x;
    const camZ = camera.position.z;

    // In a storm or heavy rain the flocks disappear into the grass (hidden).
    // Nearby ones must not vanish mid-screen: they flush and fly out first,
    // and are despawned once landed or far enough away; only far/off-screen
    // flocks despawn instantly.
    const hide = env.weather === "storm" || env.rain > 0.6;
    if (hide !== this.hidden) {
      this.hidden = hide;
      if (hide) {
        for (const f of this.flocks) {
          if (!f.enabled) continue;
          f.camDist = Math.hypot(f.ax - camX, f.az - camZ);
          if (f.camDist > 120) this.disableFlock(f);
          else if (!f.flying()) this.flushFlock(f, playerPos, env, camera);
        }
      }
    }

    if (!this.started) {
      this.started = true;
      this.popT = 0;
    }
    this.popT -= step;
    if (this.popT <= 0) {
      this.popT = 1.5 + Math.random();
      this.adjustPopulation(env, camX, camZ, playerPos.x, playerPos.z);
    }

    let touched0 = false;
    let touched1 = false;
    for (const f of this.flocks) {
      if (!f.enabled) continue;
      f.camDist = Math.hypot(f.ax - camX, f.az - camZ);
      const flying = f.flying();

      // Hidden (storm): a flushed-out flock despawns once it has landed or
      // once every bird is far from the camera (never mid-screen).
      if (this.hidden) {
        let nearCam = 1e9;
        for (const b of f.birds) {
          const d = Math.hypot(b.x - camX, b.z - camZ);
          if (d < nearCam) nearCam = d;
        }
        if (!flying || nearCam > DORMANT_DIST) {
          this.disableFlock(f);
          continue;
        }
      }

      // Delayed second flush sound of a big flock
      if (f.sndT2 > 0) {
        f.sndT2 -= step;
        if (f.sndT2 <= 0) {
          const gy = terrainHeight(f.ax, f.az);
          this.listen(f.ax, gy + 1, f.az, SOUND_RANGE, camera);
          sound.birdFlush(this.sndPan, this.sndDist);
        }
      }

      if (!flying && f.camDist > DORMANT_DIST) continue; // dormant: frozen

      // Threat check: walker close, or the jeep at speed a bit further out
      if (!flying) {
        let nearest = 1e9;
        for (const b of f.birds) {
          const d = Math.hypot(b.x - playerPos.x, b.z - playerPos.z);
          if (d < nearest) nearest = d;
        }
        const thr =
          this.playerSpeed > JEEP_SPEED ? FLUSH_JEEP_DIST : f.flushDist;
        if (nearest < thr) this.flushFlock(f, playerPos, env, camera);
      }

      // Slow flock drift while foraging
      if (!flying) {
        f.driftT -= step;
        if (f.driftT <= 0) {
          f.driftT = rnd(4, 9);
          f.driftA = Math.random() * TWO_PI;
        }
        const nx = f.ax + Math.cos(f.driftA) * 0.15 * step;
        const nz = f.az + Math.sin(f.driftA) * 0.15 * step;
        if (validGround(nx, nz)) {
          f.ax = nx;
          f.az = nz;
        } else {
          f.driftT = 0;
        }
      }

      // Occasional idle peep from a random member (day, calm, near)
      f.peepT -= step;
      if (f.peepT <= 0) {
        f.peepT = rnd(20, 60);
        if (
          !flying &&
          env.dayI > 0.25 &&
          env.rain < 0.35 &&
          f.camDist < PEEP_DIST
        ) {
          const b = f.birds[Math.floor(Math.random() * f.size)];
          this.listen(b.x, b.y, b.z, SOUND_RANGE, camera);
          sound.birdPeep(this.sndPan, this.sndDist);
        }
      }

      for (let i = 0; i < f.size; i++) {
        const b = f.birds[i];
        if (b.state === S_FORAGE) this.stepForage(b, f, step);
        else this.stepFlight(b, f, step);
        this.writeBird(f, i);
      }
      if (f.species === 0) touched0 = true;
      else touched1 = true;
    }

    if (touched0) {
      this.meshes[0].instanceMatrix.needsUpdate = true;
      this.attr1[0].needsUpdate = true;
      this.attr2[0].needsUpdate = true;
    }
    if (touched1) {
      this.meshes[1].instanceMatrix.needsUpdate = true;
      this.attr1[1].needsUpdate = true;
      this.attr2[1].needsUpdate = true;
    }
  }

  // --------------------------- Dev / cleanup ---------------------------

  /**
   * Dev harness only: teleport the first flock of `species` (0 = plover,
   * 1 = pipit) to (x, z) and let it forage there – for screenshots.
   */
  debugFlock(x: number, z: number, species = 0) {
    const f =
      this.flocks.find((fl) => fl.species === species) ?? this.flocks[0];
    f.enabled = true;
    this.placeFlock(f, x, z);
    return {
      species: f.species === 0 ? "plover" : "pipit",
      size: f.size,
      x,
      z,
      valid: validGround(x, z),
    };
  }

  /** Dev harness only: flock states for verification. */
  debugInfo() {
    const r1 = (v: number) => Math.round(v * 10) / 10;
    return {
      hidden: this.hidden,
      playerSpeed: r1(this.playerSpeed),
      flocks: this.flocks.map((f) => ({
        species: f.species === 0 ? "plover" : "pipit",
        size: f.size,
        enabled: f.enabled,
        ax: r1(f.ax),
        az: r1(f.az),
        camDist: r1(f.camDist),
        states: f.birds.map((b) => `${STATE_NAMES[b.state]}:${b.sub}`),
        birds: f.birds.map((b) => ({
          x: r1(b.x),
          y: r1(b.y),
          z: r1(b.z),
          v: r1(b.v),
        })),
      })),
    };
  }

  dispose(): void {
    for (const m of this.meshes) {
      this.scene.remove(m);
      m.dispose();
    }
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const t of this.texes) t.dispose();
  }
}
