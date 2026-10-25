// Trash models part B: wood, rubble, sheet metal, cable, fishing line, net,
// jerry can, drum, spray can, tool, flip-flop, bucket.

import * as THREE from "three";
import {
  pbrBrushedMetal,
  pbrBucket,
  pbrCanLabel,
  pbrCanister,
  pbrConcrete,
  pbrNet,
  pbrRope,
  pbrRubber,
  pbrRustyMetal,
  pbrWood,
  remapBoxUvAround,
} from "./textures";
import {
  type Part,
  boxFaceUv,
  catmull,
  densify,
  displace,
  fbm3,
  lathe,
  noise3,
  remapUv,
  ridged3,
  smoothstep,
  tube,
  weldNormals,
  xform,
} from "./trash-geo";
import {
  K,
  type ModelSpec,
  blob,
  flat,
  metalMaps,
  plasticMaps,
  plasticStripedMaps,
  rustMaps,
  std,
  tippedX,
  tippedZ,
  upright,
} from "./trash-materials";
import { pbrHazardBand } from "./trash-textures";
import type { TrashTypeDef } from "./types";

type Prof = Array<[number, number]>;
const LATHE_YAW = -1.7;

function cylAlong(
  from: THREE.Vector3,
  to: THREE.Vector3,
  r0: number,
  r1: number,
  seg: number,
): THREE.BufferGeometry {
  const dir = to.clone().sub(from);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(r1, r0, len, seg);
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    dir.normalize(),
  );
  g.applyQuaternion(q);
  g.translate((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
  return g;
}

// ---------------------------------------------------------------------------
// Wooden plank
// ---------------------------------------------------------------------------

function plank(): ModelSpec {
  const L = 0.64 * K;
  const T = 0.028 * K;
  const Wd = 0.12 * K;
  const bow = (p: THREE.Vector3) =>
    new THREE.Vector3(0, 0.014 * (1 - (p.x / (L * 0.5)) ** 2), 0);
  const main = new THREE.BoxGeometry(L * 0.78, T, Wd, 10, 1, 3);
  boxFaceUv(main, 4, [0, 0.47, 0.78, 0.53]);
  boxFaceUv(main, 5, [0, 0.47, 0.78, 0.53]);
  boxFaceUv(main, 0, [0.95, 0.4, 1, 0.6]);
  boxFaceUv(main, 1, [0.95, 0.4, 1, 0.6]);
  boxFaceUv(main, 2, [0, 0, 0.78, 1]);
  boxFaceUv(main, 3, [0, 0, 0.78, 1]);
  main.translate(-L * 0.11, T / 2, 0);
  const parts: Part[] = [{ geo: main, mat: 0 }];
  const x0 = L * 0.28;
  const slivers: Array<[number, number, number, number, number, number]> = [
    // len, width, zOff, yaw, roll, uv v0
    [L * 0.24, Wd * 0.48, Wd * 0.26, 0.07, 0, 0.5],
    [L * 0.18, Wd * 0.42, -Wd * 0.28, -0.11, 0.18, 0],
  ];
  for (const [len, w, z, yaw, roll, v0] of slivers) {
    const s = new THREE.BoxGeometry(len, T * 0.96, w, 3, 1, 1);
    boxFaceUv(s, 2, [0.78, v0, 0.78 + len / L, v0 + 0.5]);
    boxFaceUv(s, 3, [0.78, v0, 0.78 + len / L, v0 + 0.5]);
    boxFaceUv(s, 4, [0.78, 0.47, 1, 0.53]);
    boxFaceUv(s, 5, [0.78, 0.47, 1, 0.53]);
    boxFaceUv(s, 0, [0.95, 0.4, 1, 0.6]);
    boxFaceUv(s, 1, [0.95, 0.4, 1, 0.6]);
    xform(s, [x0 + len / 2 - 0.01, T / 2, z], [roll, yaw, 0]);
    parts.push({ geo: s, mat: 0 });
  }
  for (const part of parts) {
    displace(part.geo, bow);
    part.geo.computeVertexNormals();
  }
  // two rusty nails
  for (const [nx, nz, tilt] of [
    [-L * 0.3, Wd * 0.2, 0.15],
    [L * 0.05, -Wd * 0.15, 0.6],
  ] as const) {
    const top = new THREE.Vector3(nx + Math.sin(tilt) * 0.03, T + 0.03, nz);
    const shaft = cylAlong(
      new THREE.Vector3(nx, T * 0.5, nz),
      top,
      0.0025,
      0.002,
      6,
    );
    const head = new THREE.CylinderGeometry(0.005, 0.005, 0.0015, 8);
    head.translate(top.x, top.y, top.z);
    parts.push({ geo: shaft, mat: 1 }, { geo: head, mat: 1 });
  }
  return {
    parts,
    materials: [std(pbrWood("plank")), std(rustMaps())],
    poses: [flat(1)],
    sink: 0.008,
  };
}

// ---------------------------------------------------------------------------
// Branch
// ---------------------------------------------------------------------------

function branch(rng: () => number): ModelSpec {
  const L = 0.6 * K;
  const main = catmull([
    [-L / 2, 0.012, 0],
    [-L * 0.25, 0.02, 0.025],
    [0, 0.016, -0.012],
    [L * 0.25, 0.026, 0.018],
    [L / 2, 0.045, 0.035],
  ]);
  const r0 = 0.017 * K;
  const parts: Part[] = [
    {
      geo: tube(main, {
        radius: (t, ang) =>
          r0 *
          (1 - 0.55 * t) *
          (1 + 0.18 * (noise3(t * 9, ang * 0.9, 0.3) - 0.5)),
        segs: 22,
        radial: 8,
        uvMode: "around",
        tileLen: 0.3,
        caps: true,
      }),
      mat: 0,
    },
  ];
  const twigs: Array<[number, number, number, number]> = [
    // t on main, length, side, up
    [0.3, 0.22, 1, 0.8],
    [0.62, 0.26, -1, 0.5],
    [0.84, 0.1, 1, 1.1],
  ];
  for (const [t, len, side, up] of twigs) {
    const p0 = main.getPointAt(t);
    const dir = main.getTangentAt(t);
    const out = new THREE.Vector3(-dir.z * side, up, dir.x * side).normalize();
    const j = (rng() - 0.5) * 0.3;
    const c = catmull([
      [p0.x, p0.y, p0.z],
      [
        p0.x + out.x * len * 0.45 + dir.x * len * 0.3,
        p0.y + out.y * len * 0.45,
        p0.z + out.z * len * 0.45 + j,
      ],
      [
        p0.x + out.x * len * 0.8 + dir.x * len * 0.5,
        p0.y + out.y * len * 0.75,
        p0.z + out.z * len * 0.9 - j,
      ],
    ]);
    parts.push({
      geo: tube(c, {
        radius: (tt) => r0 * 0.42 * (1 - 0.7 * tt),
        segs: 8,
        radial: 6,
        uvMode: "around",
        tileLen: 0.15,
        caps: true,
      }),
      mat: 0,
    });
  }
  return {
    parts,
    materials: [std(pbrWood("branch"))],
    poses: [flat(1)],
    sink: 0.006,
  };
}

// ---------------------------------------------------------------------------
// Driftwood
// ---------------------------------------------------------------------------

function driftwood(): ModelSpec {
  const L = 0.6 * K;
  const R = 0.06 * K;
  const c = catmull([
    [-L / 2, R, 0],
    [-L * 0.18, R * 1.1, 0.03],
    [L * 0.18, R * 1.05, -0.02],
    [L / 2, R * 0.8, 0.01],
  ]);
  const geo = tube(c, {
    radius: (t, ang) => {
      const taper = smoothstep(0, 0.1, t) ** 0.5 * smoothstep(1, 0.9, t) ** 0.5;
      const base = R * (1 - 0.3 * t) * taper;
      const k1 =
        0.35 *
        Math.exp(-(((t - 0.3) / 0.07) ** 2)) *
        blob(ang - 1.2, 0, 0.55, 1);
      const k2 =
        0.28 *
        Math.exp(-(((t - 0.66) / 0.06) ** 2)) *
        blob(ang - 4.2, 0, 0.5, 1);
      const n =
        0.12 * (fbm3(t * 6, Math.cos(ang) * 1.5, Math.sin(ang) * 1.5) - 0.5);
      return base * (1 + n + k1 + k2);
    },
    segs: 26,
    radial: 12,
    uvMode: "along",
    tileLen: 0.6,
    caps: true,
  });
  const p0 = c.getPointAt(0.5);
  const stub = catmull([
    [p0.x, p0.y, p0.z],
    [p0.x + 0.04, p0.y + 0.07, p0.z - 0.05],
    [p0.x + 0.06, p0.y + 0.12, p0.z - 0.09],
  ]);
  const stubGeo = tube(stub, {
    radius: (t) => R * 0.42 * (1 - 0.4 * t),
    segs: 8,
    radial: 7,
    uvMode: "along",
    tileLen: 0.3,
    caps: true,
  });
  return {
    parts: [
      { geo, mat: 0 },
      { geo: stubGeo, mat: 0 },
    ],
    materials: [std(pbrWood("driftwood"))],
    poses: [flat(1)],
    sink: 0.012,
  };
}

// ---------------------------------------------------------------------------
// Building rubble with rebar
// ---------------------------------------------------------------------------

function rubble(): ModelSpec {
  const R = 0.12 * K;
  const chunk = new THREE.IcosahedronGeometry(R, 2);
  displace(chunk, (p) => {
    const n =
      0.3 * (fbm3(p.x * 7, p.y * 7, p.z * 7) - 0.5) +
      0.1 * (noise3(p.x * 20, p.y * 20, p.z * 20) - 0.5);
    return R * n;
  });
  chunk.scale(1, 0.62, 1);
  chunk.translate(0, R * 0.62, 0);
  chunk.computeVertexNormals();
  const small = new THREE.IcosahedronGeometry(R * 0.4, 1);
  displace(
    small,
    (p) => R * 0.4 * 0.3 * (fbm3(p.x * 15, p.y * 15, p.z * 15) - 0.5),
  );
  small.scale(1, 0.7, 1);
  small.translate(R * 1.25, R * 0.25, R * 0.6);
  small.computeVertexNormals();
  const rebar = catmull([
    [0.02, R * 0.5, 0],
    [R * 1.1, R * 0.8, 0.04],
    [R * 2.1, R * 1.05, 0.07],
    [R * 2.6, R * 0.55, 0.1],
  ]);
  const bar = tube(rebar, {
    radius: (t) => 0.009 * (1 + 0.14 * (0.5 + 0.5 * Math.sin(t * 95))),
    segs: 22,
    radial: 6,
    uvMode: "along",
    tileLen: 0.15,
    caps: true,
  });
  return {
    parts: [
      { geo: chunk, mat: 0 },
      { geo: small, mat: 0 },
      { geo: bar, mat: 1 },
    ],
    materials: [
      std(pbrConcrete(), { repeat: [2, 1] }),
      std(rustMaps(), { repeat: [3, 1] }),
    ],
    poses: [flat(1)],
    sink: 0.02,
  };
}

// ---------------------------------------------------------------------------
// Rusty sheet metal
// ---------------------------------------------------------------------------

function sheetMetal(rng: () => number): ModelSpec {
  const W = 0.45 * K;
  const D = 0.3 * K;
  const g = new THREE.PlaneGeometry(W, D, 20, 14);
  g.rotateX(-Math.PI / 2);
  const s1 = rng() * 7;
  displace(g, (p) => {
    const u = p.x / W + 0.5;
    const v = p.z / D + 0.5;
    const corr = 0.011 * (1 - Math.cos((2 * Math.PI * p.x) / 0.09));
    const c = smoothstep(0.55, 1, u) * smoothstep(0.5, 1, v);
    const c2 = c * c;
    const twist =
      0.025 * (u - 0.5) * (v - 0.5) +
      0.006 * (fbm3(p.x * 8, s1, p.z * 8) - 0.5);
    // frayed edges (two sides)
    let dx = 0;
    let dz = 0;
    if (u < 0.001) dx = noise3(p.z * 60, s1, 0) * 0.03;
    if (v > 0.999) dz = -noise3(p.x * 60, s1, 1) * 0.03;
    return new THREE.Vector3(
      -0.09 * c2 + dx,
      corr + 0.2 * c2 + twist,
      -0.07 * c2 + dz,
    );
  });
  g.computeVertexNormals();
  return {
    parts: [{ geo: g, mat: 0 }],
    materials: [
      std(pbrRustyMetal("#8e969b", 0.62), { side: THREE.DoubleSide }),
    ],
    poses: [flat(1, 0.4)],
    sink: 0.004,
  };
}

// ---------------------------------------------------------------------------
// Coil of cable
// ---------------------------------------------------------------------------

function cableCoil(): ModelSpec {
  const pts: Array<[number, number, number]> = [];
  const R0 = 0.1 * K;
  pts.push([R0 + 0.16, 0.009, -0.09]);
  pts.push([R0 + 0.06, 0.009, -0.04]);
  const turns = 2.6;
  const N = Math.round(turns * 18);
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const a = t * turns * Math.PI * 2;
    const R = R0 + 0.014 * Math.sin(a * 0.7 + 1) + 0.012 * (t - 0.5);
    pts.push([
      R * Math.cos(a),
      0.009 + t * 0.024 + 0.004 * Math.sin(a * 3),
      R * Math.sin(a),
    ]);
  }
  const last = pts[pts.length - 1];
  pts.push([last[0] * 1.3, 0.012, last[2] * 1.3 + 0.05]);
  pts.push([last[0] * 1.5 + 0.06, 0.009, last[2] * 1.6 + 0.12]);
  const c = catmull(pts, false, 0.5);
  const cable = tube(c, {
    radius: () => 0.0085,
    segs: 84,
    radial: 6,
    uvMode: "along",
    tileLen: 0.12,
  });
  const parts: Part[] = [{ geo: cable, mat: 0 }];
  for (const t of [0, 1]) {
    const p = c.getPointAt(t);
    const d = c.getTangentAt(t).multiplyScalar(t === 0 ? -1 : 1);
    const end = p.clone().addScaledVector(d, 0.03);
    parts.push({ geo: cylAlong(p, end, 0.0045, 0.0045, 6), mat: 1 });
  }
  return {
    parts,
    materials: [
      std(plasticMaps(), { color: "#202024", roughness: 1.3 }),
      std(metalMaps(), { color: "#c47a3a" }),
    ],
    poses: [flat(1)],
    sink: 0.004,
  };
}

// ---------------------------------------------------------------------------
// Fishing line
// ---------------------------------------------------------------------------

function fishingLine(rng: () => number): ModelSpec {
  const pts: Array<[number, number, number]> = [];
  for (let i = 0; i < 13; i++) {
    pts.push([
      (rng() - 0.5) * 0.34,
      0.006 + rng() * 0.05,
      (rng() - 0.5) * 0.28,
    ]);
  }
  const c = catmull(pts, true, 0.4);
  const line = tube(c, {
    radius: () => 0.0045,
    segs: 96,
    radial: 5,
    uvMode: "along",
    tileLen: 0.1,
    closed: true,
  });
  const float = lathe(
    [
      [0, 0],
      [0.012, 0.002],
      [0.019, 0.012],
      [0.02, 0.03],
      [0.015, 0.05],
      [0.006, 0.062],
      [0.004, 0.075],
      [0, 0.076],
    ],
    14,
    { vByHeight: true },
  );
  xform(float, [0.15, 0.02, -0.07], [0, 0, Math.PI / 2 + 0.2]);
  return {
    parts: [
      { geo: line, mat: 0 },
      { geo: float, mat: 1 },
    ],
    materials: [
      std(plasticMaps(), { color: "#f2f4ec", roughness: 0.8 }),
      std(plasticStripedMaps(), { color: "#f07a2a" }),
    ],
    poses: [flat(1)],
    sink: 0.003,
    castShadow: false,
  };
}

// ---------------------------------------------------------------------------
// Scrap of net
// ---------------------------------------------------------------------------

function netFragment(rng: () => number): ModelSpec {
  const W = 0.5 * K;
  const D = 0.4 * K;
  const g = new THREE.PlaneGeometry(W, D, 12, 10);
  g.rotateX(-Math.PI / 2);
  const s1 = rng() * 5;
  displace(g, (p) => {
    const u = p.x / W + 0.5;
    const v = p.z / D + 0.5;
    const e = smoothstep(0, 0.15, Math.min(u, 1 - u, v, 1 - v));
    const h =
      0.01 +
      0.03 * fbm3(p.x * 4 + s1, 0, p.z * 4) +
      0.03 * ridged3(p.x * 6, s1, p.z * 6) * e;
    let dx = 0;
    let dz = 0;
    if (u < 0.001) dx = noise3(p.z * 40, s1, 2) * 0.08;
    if (v < 0.001) dz = noise3(p.x * 40, s1, 3) * 0.08;
    return new THREE.Vector3(dx, h, dz);
  });
  g.computeVertexNormals();
  // Edge rope along the +z edge (follows the deformed edge)
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const edge: Array<[number, number, number]> = [];
  for (let i = 0; i < pos.count; i++) {
    if (pos.getZ(i) > D * 0.5 - 0.02 && i % 2 === 0)
      edge.push([pos.getX(i), pos.getY(i) + 0.004, pos.getZ(i)]);
  }
  edge.sort((a, b) => a[0] - b[0]);
  edge.push(
    [W * 0.5 + 0.12, 0.012, D * 0.5 + 0.05],
    [W * 0.5 + 0.22, 0.01, D * 0.5 + 0.02],
  );
  const rope = tube(catmull(edge, false, 0.5), {
    radius: () => 0.007,
    segs: 26,
    radial: 6,
    uvMode: "along",
    tileLen: 0.2,
  });
  const ball = new THREE.SphereGeometry(0.06, 12, 8);
  ball.translate(W * 0.5 + 0.24, 0.06, D * 0.5 - 0.01);
  return {
    parts: [
      { geo: g, mat: 0 },
      { geo: rope, mat: 1 },
      { geo: ball, mat: 2 },
    ],
    materials: [
      std(pbrNet("#4f8f7f"), { repeat: [2.8, 2.24] }),
      std(pbrRope()),
      std(plasticMaps(), { color: "#f07a2a" }),
    ],
    poses: [flat(1)],
    sink: 0.002,
    castShadow: false,
  };
}

// ---------------------------------------------------------------------------
// Jerry can
// ---------------------------------------------------------------------------

function canister(): ModelSpec {
  const W = 0.19 * K;
  const H = 0.24 * K;
  const D = 0.13 * K;
  const body = new THREE.BoxGeometry(W, H, D, 2, 6, 2);
  remapBoxUvAround(body);
  body.translate(0, H / 2, 0);
  displace(body, (p) => {
    const s = Math.max(0, (p.y - (H - 0.07)) / 0.07);
    const k = s * s;
    return new THREE.Vector3(-p.x * 0.3 * k, 0, -p.z * 0.35 * k);
  });
  body.computeVertexNormals();
  const neck = new THREE.CylinderGeometry(0.024, 0.026, 0.03, 14);
  neck.translate(0.075, H + 0.012, 0);
  const cap = lathe(
    [
      [0.024, H + 0.009],
      [0.03, H + 0.011],
      [0.03, H + 0.036],
      [0.027, H + 0.039],
      [0, H + 0.039],
    ],
    14,
  );
  const handle = tube(
    catmull([
      [-0.065, H - 0.03, 0],
      [-0.06, H + 0.05, 0],
      [-0.035, H + 0.068, 0],
      [0.005, H + 0.068, 0],
      [0.03, H + 0.05, 0],
      [0.032, H - 0.02, 0],
    ]),
    {
      radius: () => 0.012,
      segs: 16,
      radial: 6,
      uvMode: "around",
      tileLen: 0.2,
    },
  );
  return {
    parts: [
      { geo: body, mat: 0 },
      { geo: neck, mat: 1 },
      { geo: handle, mat: 1 },
      { geo: cap, mat: 2 },
    ],
    materials: [
      std(pbrCanister()),
      std(plasticMaps(), { color: "#e0be40" }),
      std(plasticMaps(), { color: "#26262a" }),
    ],
    poses: [upright(0.55), tippedX(0.3), tippedZ(0.15, 0.4)],
    sink: 0.008,
  };
}

// ---------------------------------------------------------------------------
// Chemical drum
// ---------------------------------------------------------------------------

function drum(): ModelSpec {
  const R = 0.19;
  const prof: Prof = densify(
    [
      [0, 0],
      [0.15, 0],
      [0.175, 0.004],
      [0.185, 0.012],
      [R, 0.03],
      [R, 0.12],
      [R + 0.01, 0.128],
      [R + 0.01, 0.142],
      [R, 0.15],
      [R, 0.29],
      [R + 0.01, 0.298],
      [R + 0.01, 0.312],
      [R, 0.32],
      [R, 0.425],
      [R + 0.008, 0.432],
      [R + 0.008, 0.446],
      [R - 0.002, 0.452],
      [R - 0.018, 0.452],
      [R - 0.022, 0.446],
      [0.1, 0.443],
      [0, 0.442],
    ],
    0.045,
  );
  const dent = (p: THREE.Vector3): THREE.Vector3 => {
    const r = Math.hypot(p.x, p.z);
    if (r < 0.05 || p.y < 0.035 || p.y > 0.42) return new THREE.Vector3();
    const ang = Math.atan2(p.x, p.z);
    const d =
      0.022 * blob(ang - 0.8, p.y - 0.2, 0.5, 0.08) +
      0.014 * blob(ang - 3.9, p.y - 0.33, 0.4, 0.06);
    return new THREE.Vector3((-p.x / r) * d, 0, (-p.z / r) * d);
  };
  const body = lathe(prof, 16, { vByHeight: true });
  displace(body, dent);
  weldNormals(body);
  const band = new THREE.CylinderGeometry(
    R + 0.0006,
    R + 0.0006,
    0.07,
    16,
    1,
    true,
  );
  band.translate(0, 0.235, 0);
  displace(band, dent);
  const bung = new THREE.CylinderGeometry(0.028, 0.028, 0.012, 12);
  bung.translate(0.1, 0.448, 0);
  return {
    parts: [
      { geo: body, mat: 0 },
      { geo: bung, mat: 0 },
      { geo: band, mat: 1 },
    ],
    materials: [
      std(pbrRustyMetal("#2c66a8", 0.36, { edges: false }), { repeat: [2, 1] }),
      std(pbrHazardBand()),
    ],
    poses: [upright(0.55), tippedX(0.45)],
    sink: 0.01,
    showYaw: LATHE_YAW,
  };
}

// ---------------------------------------------------------------------------
// Spray can
// ---------------------------------------------------------------------------

function sprayCan(): ModelSpec {
  const R = 0.0325 * K;
  const seg = 18;
  const bottom = lathe(
    [
      [0, 0.008],
      [0.02, 0.004],
      [0.033, 0.001],
      [0.04, 0.003],
      [0.044, 0.008],
      [R, 0.016],
    ],
    seg,
  );
  const body = lathe(
    [
      [R, 0.016],
      [R, 0.19],
    ],
    seg,
    { vRange: [0.004, 0.204] },
  );
  const top = lathe(
    [
      [R, 0.19],
      [0.044, 0.198],
      [0.038, 0.208],
      [0.028, 0.216],
      [0.016, 0.221],
      [0.016, 0.226],
      [0.012, 0.226],
      [0, 0.226],
    ],
    seg,
  );
  const nozzle = new THREE.CylinderGeometry(0.006, 0.0065, 0.018, 10);
  nozzle.translate(0, 0.235, 0);
  const spout = new THREE.BoxGeometry(0.005, 0.006, 0.012);
  spout.translate(0, 0.241, 0.01);
  return {
    parts: [
      { geo: body, mat: 0 },
      { geo: bottom, mat: 1 },
      { geo: top, mat: 1 },
      { geo: nozzle, mat: 1 },
      { geo: spout, mat: 1 },
    ],
    materials: [
      std(pbrCanLabel("energy", { dents: 2 })),
      std(pbrBrushedMetal("#c9ccce"), { repeat: [2, 1] }),
    ],
    poses: [upright(0.3), tippedX(0.7)],
    sink: 0.005,
    showYaw: LATHE_YAW,
  };
}

// ---------------------------------------------------------------------------
// Broken hammer
// ---------------------------------------------------------------------------

function hammer(rng: () => number): ModelSpec {
  const parts: Part[] = [];
  const head = new THREE.BoxGeometry(0.05, 0.05, 0.16);
  head.translate(0.16, 0.026, 0);
  parts.push({ geo: head, mat: 0 });
  const face = new THREE.CylinderGeometry(0.024, 0.026, 0.03, 12);
  face.rotateX(Math.PI / 2);
  face.translate(0.16, 0.026, 0.095);
  parts.push({ geo: face, mat: 0 });
  for (const s of [-1, 1]) {
    const claw = new THREE.BoxGeometry(0.014, 0.032, 0.07);
    xform(claw, [0.16 + s * 0.012, 0.03, -0.11], [0.45, 0, 0]);
    parts.push({ geo: claw, mat: 0 });
  }
  const handle = new THREE.CylinderGeometry(0.02, 0.017, 0.29, 12);
  displace(handle, (p) => {
    if (p.y < -0.14) return new THREE.Vector3(0, rng() * 0.04, 0);
    return new THREE.Vector3();
  });
  remapUv(handle, (u, v) => [v * 0.6, u]);
  handle.computeVertexNormals();
  handle.rotateZ(-Math.PI / 2);
  handle.translate(0.0, 0.02, 0);
  parts.push({ geo: handle, mat: 1 });
  return {
    parts,
    materials: [std(rustMaps()), std(pbrWood("plank"))],
    poses: [flat(1, 0.5)],
    sink: 0.006,
  };
}

// ---------------------------------------------------------------------------
// Flip-flop
// ---------------------------------------------------------------------------

function flipFlop(): ModelSpec {
  const L = 0.27 * K;
  const s = L / 0.38;
  const outline: Array<[number, number]> = [
    [0, 0],
    [0.045, 0.01],
    [0.058, 0.06],
    [0.055, 0.14],
    [0.06, 0.22],
    [0.072, 0.3],
    [0.068, 0.35],
    [0.045, 0.375],
    [0.01, 0.38],
    [-0.03, 0.378],
    [-0.06, 0.36],
    [-0.07, 0.3],
    [-0.06, 0.22],
    [-0.052, 0.14],
    [-0.056, 0.06],
    [-0.045, 0.01],
  ];
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.splineThru(
    outline.slice(1).map(([x, y]) => new THREE.Vector2(x * s, y * s)),
  );
  shape.closePath();
  const sole = new THREE.ExtrudeGeometry(shape, {
    depth: 0.016,
    bevelEnabled: true,
    bevelThickness: 0.004,
    bevelSize: 0.004,
    bevelSegments: 2,
    curveSegments: 3,
  });
  const halfW = 0.075 * s;
  remapUv(sole, (_u, _v, p) => [p.x / (2 * halfW) + 0.5, p.y / L]);
  sole.rotateX(-Math.PI / 2);
  sole.translate(0, 0.004, 0);
  const parts: Part[] = [{ geo: sole, mat: 0 }];
  const post = new THREE.Vector3(-0.012 * s, 0, -0.25 * s * 1.0);
  const postGeo = new THREE.CylinderGeometry(0.006, 0.006, 0.036, 8);
  postGeo.translate(post.x, 0.036, post.z);
  const knob = new THREE.SphereGeometry(0.01, 8, 6);
  knob.translate(post.x, 0.054, post.z);
  parts.push({ geo: postGeo, mat: 1 }, { geo: knob, mat: 1 });
  for (const side of [-1, 1]) {
    const ax = side * 0.06 * s;
    const az = -0.12 * s;
    const c = catmull([
      [post.x, 0.05, post.z],
      [(post.x + ax) * 0.5, 0.058, (post.z + az) * 0.5],
      [ax, 0.02, az],
    ]);
    parts.push({
      geo: tube(c, {
        radius: (_t, ang) => 0.0075 * (1 - 0.45 * Math.abs(Math.cos(ang))),
        segs: 10,
        radial: 6,
        uvMode: "along",
        tileLen: 0.2,
      }),
      mat: 1,
    });
  }
  return {
    parts,
    materials: [
      std(pbrRubber("#e86aa0")),
      std(plasticMaps(), { color: "#f6f4ee" }),
    ],
    poses: [flat(1)],
    sink: 0.004,
  };
}

// ---------------------------------------------------------------------------
// Old bucket
// ---------------------------------------------------------------------------

function oldBucket(): ModelSpec {
  const prof: Prof = densify(
    [
      [0, 0],
      [0.15, 0],
      [0.158, 0.004],
      [0.16, 0.012],
      [0.196, 0.34],
      [0.204, 0.348],
      [0.207, 0.36],
      [0.2, 0.364],
      [0.192, 0.36],
      [0.19, 0.35],
      [0.155, 0.015],
      [0.14, 0.012],
      [0, 0.012],
    ],
    0.05,
  );
  const dent = (p: THREE.Vector3): THREE.Vector3 => {
    const r = Math.hypot(p.x, p.z);
    if (r < 0.1 || p.y < 0.03 || p.y > 0.34) return new THREE.Vector3();
    const ang = Math.atan2(p.x, p.z);
    const d =
      0.026 * blob(ang - 1.2, p.y - 0.2, 0.6, 0.09) +
      0.016 * blob(ang - 4.5, p.y - 0.3, 0.5, 0.06);
    return new THREE.Vector3((-p.x / r) * d, 0, (-p.z / r) * d);
  };
  const body = lathe(prof, 18, { vByHeight: true });
  displace(body, dent);
  weldNormals(body);
  const parts: Part[] = [{ geo: body, mat: 0 }];
  for (const sx of [-1, 1]) {
    const lug = new THREE.BoxGeometry(0.02, 0.03, 0.016);
    lug.translate(sx * 0.203, 0.33, 0);
    parts.push({ geo: lug, mat: 0 });
  }
  const handle = tube(
    catmull([
      [0.2, 0.34, 0],
      [0.215, 0.42, 0],
      [0.17, 0.5, 0.02],
      [0.07, 0.555, 0.03],
      [-0.02, 0.545, 0.05],
      [-0.07, 0.5, 0.06],
    ]),
    {
      radius: () => 0.0045,
      segs: 16,
      radial: 6,
      uvMode: "along",
      tileLen: 0.1,
      caps: true,
    },
  );
  parts.push({ geo: handle, mat: 1 });
  return {
    parts,
    materials: [
      std(pbrBucket("#3f78b0")),
      std(metalMaps(), { color: "#9a9ea2" }),
    ],
    poses: [upright(0.5), tippedZ(0.5, 0.6)],
    sink: 0.008,
    showYaw: LATHE_YAW,
  };
}

// ---------------------------------------------------------------------------

export function buildModelB(
  def: TrashTypeDef,
  rng: () => number,
): ModelSpec | null {
  switch (def.id) {
    case "plank":
      return plank();
    case "branch":
      return branch(rng);
    case "driftwood":
      return driftwood();
    case "rubble":
      return rubble();
    case "sheet_metal":
      return sheetMetal(rng);
    case "cable":
      return cableCoil();
    case "fishing_line":
      return fishingLine(rng);
    case "net":
      return netFragment(rng);
    case "canister":
      return canister();
    case "drum":
      return drum();
    case "spray_can":
      return sprayCan();
    case "tool":
      return hammer(rng);
    case "flip_flop":
      return flipFlop();
    case "old_bucket":
      return oldBucket();
    default:
      return null;
  }
}
