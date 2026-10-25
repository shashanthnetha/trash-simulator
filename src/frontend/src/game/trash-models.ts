// Trash models part A: bottles, cans, beer mats, paper, cardboard, bags.
// Every builder returns parts (geometry + material index), materials and
// poses; dimensions are real size × K. Built so the resting face is at y = 0.

import * as THREE from "three";
import {
  pbrBottleLabel,
  pbrBrushedMetal,
  pbrCanLabel,
  pbrCardboard,
  pbrChipsBag,
  pbrGlass,
  pbrNewspaper,
  pbrPaperCrumpled,
  pbrPlasticBag,
} from "./textures";
import {
  type Part,
  boxFaceUv,
  densify,
  disc,
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
  anyRot,
  blob,
  flat,
  metalMaps,
  phys,
  plasticMaps,
  std,
  tippedX,
  tippedZ,
  upright,
} from "./trash-materials";
import { pbrCoaster } from "./trash-textures";
import type { TrashTypeDef } from "./types";

type Prof = Array<[number, number]>;

function scaleProf(p: Prof, k: number): Prof {
  return p.map(([r, y]) => [r * k, y * k]);
}

const LATHE_YAW = -1.7; // front of the label (u ≈ 0.27) faces +z

// ---------------------------------------------------------------------------
// Glass bottles
// ---------------------------------------------------------------------------

function glassBottle(kind: "glass_green" | "glass_brown"): ModelSpec {
  const green = kind === "glass_green";
  const seg = 20;
  const body: Prof = [
    [0, 0.005],
    [0.02, 0.0015],
    [0.03, 0],
    [0.0335, 0.004],
    [0.034, 0.012],
    [0.034, 0.155],
    [0.0325, 0.175],
    [0.027, 0.192],
    [0.02, 0.207],
    [0.0155, 0.22],
    [0.0135, 0.232],
    [0.0135, 0.256],
    [0.0148, 0.259],
    [0.0148, 0.268],
    [0.0135, 0.27],
  ];
  if (!green) body.push([0.0095, 0.27], [0.0095, 0.25], [0.008, 0.245]);
  const glass = lathe(scaleProf(body, K), seg, { vByHeight: true });
  const parts: Part[] = [{ geo: glass, mat: 0 }];
  // Paper label (standing off slightly)
  const rl = 0.034 * K + 0.0007;
  const label = new THREE.CylinderGeometry(rl, rl, 0.09 * K, seg, 1, true);
  label.translate(0, 0.075 * K, 0);
  parts.push({ geo: label, mat: 1 });
  const materials: THREE.Material[] = [
    phys(pbrGlass(), {
      color: green ? "#2f8a45" : "#8a5220",
      repeat: [2, 1.5],
      transparent: true,
      opacity: 0.58,
      clearcoat: 0.6,
      clearcoatRoughness: 0.15,
      ior: 1.5,
    }),
    std(pbrBottleLabel(kind), { side: THREE.DoubleSide }),
  ];
  if (green) {
    // Crown cap
    const cap: Prof = [
      [0.0152, 0.255],
      [0.0172, 0.257],
      [0.0168, 0.263],
      [0.0158, 0.269],
      [0.014, 0.2715],
      [0, 0.2715],
    ];
    parts.push({ geo: lathe(scaleProf(cap, K), seg), mat: 2 });
    materials.push(std(metalMaps(), { color: "#d8aa48" }));
  }
  return {
    parts,
    materials,
    poses: [upright(0.3), tippedX(0.7)],
    sink: 0.008,
    showYaw: LATHE_YAW,
    hull: "back",
  };
}

// ---------------------------------------------------------------------------
// PET bottle
// ---------------------------------------------------------------------------

function petBottle(): ModelSpec {
  const seg = 18;
  const body: Prof = densify(
    scaleProf(
      [
        [0, 0.006],
        [0.018, 0.003],
        [0.028, 0],
        [0.0315, 0.004],
        [0.0325, 0.012],
        [0.0325, 0.06],
        [0.0295, 0.066],
        [0.0295, 0.078],
        [0.0325, 0.084],
        [0.0325, 0.108],
        [0.0295, 0.114],
        [0.0295, 0.126],
        [0.0325, 0.132],
        [0.0325, 0.16],
        [0.029, 0.175],
        [0.022, 0.187],
        [0.016, 0.194],
        [0.0125, 0.199],
        [0.0125, 0.207],
        [0.0145, 0.208],
        [0.0145, 0.211],
        [0.0125, 0.212],
        [0.0125, 0.218],
      ],
      K,
    ),
    0.03,
  );
  const dent = (p: THREE.Vector3): number => {
    const ang = Math.atan2(p.x, p.z);
    const y = p.y / K;
    if (y < 0.03 || y > 0.17) return 0;
    const b = blob(ang - 2.4, y - 0.1, 0.7, 0.05);
    const wr = ridged3(ang * 1.5, y * 40, 0.5) - 0.5;
    return -K * (0.011 * b + 0.004 * b * wr);
  };
  const glass = lathe(body, seg, { vByHeight: true });
  displace(glass, dent);
  weldNormals(glass);
  const rl = 0.0325 * K + 0.0006;
  const label = new THREE.CylinderGeometry(rl, rl, 0.105 * K, seg, 1, true);
  label.translate(0, 0.0975 * K, 0);
  displace(label, dent);
  const cap = lathe(
    scaleProf(
      [
        [0.0135, 0.214],
        [0.0155, 0.215],
        [0.0155, 0.232],
        [0.0145, 0.234],
        [0, 0.234],
      ],
      K,
    ),
    seg,
  );
  return {
    parts: [
      { geo: glass, mat: 0 },
      { geo: label, mat: 1 },
      { geo: cap, mat: 2 },
    ],
    materials: [
      phys(pbrGlass(), {
        color: "#cfe9f2",
        repeat: [2, 1.5],
        transparent: true,
        opacity: 0.6,
        roughness: 2.2,
        clearcoat: 0.4,
        clearcoatRoughness: 0.25,
      }),
      std(pbrBottleLabel("plastic_bottle")),
      std(plasticMaps(), { color: "#2277dd" }),
    ],
    poses: [upright(0.25), tippedX(0.75)],
    sink: 0.005,
    showYaw: LATHE_YAW,
    hull: "back",
  };
}

// ---------------------------------------------------------------------------
// Drinks can (intact / crushed)
// ---------------------------------------------------------------------------

function canParts(seg: number, crushed: boolean): Part[] {
  const bodyP: Prof = [
    [0, 0.007],
    [0.018, 0.004],
    [0.03, 0.001],
    [0.036, 0.003],
    [0.0395, 0.007],
    [0.041, 0.012],
    [0.0425, 0.02],
    [0.043, 0.03],
    [0.043, 0.13],
    [0.041, 0.138],
    [0.037, 0.147],
    [0.0355, 0.152],
  ];
  const lidP: Prof = [
    [0.0355, 0.152],
    [0.0375, 0.155],
    [0.0375, 0.159],
    [0.0355, 0.161],
    [0.033, 0.158],
    [0.031, 0.153],
    [0, 0.152],
  ];
  const bp = crushed
    ? densify(scaleProf(bodyP, K), 0.012)
    : scaleProf(bodyP, K);
  // Label v: 0.06 ↔ bottom edge, 0.93 ↔ start of the neck
  const body = lathe(bp, seg, { vRange: [0.0 * K, 0.163 * K] });
  const lid = lathe(scaleProf(lidP, K), seg);
  const tab = new THREE.TorusGeometry(0.008 * K, 0.0022 * K, 6, 12);
  tab.rotateX(Math.PI / 2);
  tab.scale(1, 0.45, 1);
  tab.translate(0.008 * K, 0.155 * K, 0);
  const rivet = new THREE.CylinderGeometry(0.003 * K, 0.003 * K, 0.0025 * K, 8);
  rivet.translate(0, 0.1535 * K, 0);
  return [
    { geo: body, mat: 0 },
    { geo: lid, mat: 1 },
    { geo: tab, mat: 1 },
    { geo: rivet, mat: 1 },
  ];
}

function can(): ModelSpec {
  return {
    parts: canParts(22, false),
    materials: [
      std(pbrCanLabel("cola")),
      std(pbrBrushedMetal("#c9ccce"), { repeat: [2, 1] }),
    ],
    poses: [upright(0.35), tippedX(0.65)],
    sink: 0.005,
    showYaw: LATHE_YAW,
  };
}

function canCrushed(): ModelSpec {
  const parts = canParts(20, true);
  const H = 0.163 * K;
  const crush = (p: THREE.Vector3): THREE.Vector3 => {
    const h = Math.max(0, Math.min(1, p.y / H));
    const ang = Math.atan2(p.x, p.z);
    const bul =
      1 +
      0.24 * Math.sin(h * Math.PI) +
      0.2 * (ridged3(Math.cos(ang) * 2.2, h * 3.5, Math.sin(ang) * 2.2) - 0.5) +
      0.08 * (noise3(Math.cos(ang) * 5, h * 8, Math.sin(ang) * 5) - 0.5);
    const shear = 0.03 * K * h;
    const ny = p.y * 0.33 + 0.004 * K * Math.sin(ang * 3 + h * 4);
    return new THREE.Vector3(
      p.x * bul + shear - p.x,
      ny - p.y,
      p.z * bul - p.z,
    );
  };
  for (const part of parts) {
    displace(part.geo, crush);
    weldNormals(part.geo);
  }
  return {
    parts,
    materials: [
      std(pbrCanLabel("beer", { crushed: true })),
      std(pbrBrushedMetal("#c9ccce"), { repeat: [2, 1] }),
    ],
    poses: [flat(1, 0.45)],
    sink: 0.004,
    showYaw: LATHE_YAW,
  };
}

// ---------------------------------------------------------------------------
// Beer mat
// ---------------------------------------------------------------------------

function coaster(): ModelSpec {
  const R = 0.0535 * K;
  const g = disc(R, 0.004, 28, 4);
  displace(g, (p) => {
    const cx = Math.max(0, p.x / R - 0.15);
    const bend = 0.018 * cx * cx + 0.003 * Math.sin((p.z / R) * 2.2);
    return new THREE.Vector3(0, bend, 0);
  });
  weldNormals(g);
  return {
    parts: [{ geo: g, mat: 0 }],
    materials: [std(pbrCoaster())],
    poses: [flat(1, 0.5)],
    sink: 0.001,
    castShadow: false,
  };
}

// ---------------------------------------------------------------------------
// Newspaper
// ---------------------------------------------------------------------------

function newspaper(rng: () => number): ModelSpec {
  const parts: Part[] = [];
  const W = 0.3 * K;
  const D = 0.22 * K;
  const t = 0.0045;
  const edge: [number, number, number, number] = [0.005, 0.35, 0.035, 0.65];
  for (let i = 3; i >= 0; i--) {
    const top = i === 0;
    const w = W - i * 0.014;
    const d = D - i * 0.01;
    const box = top
      ? new THREE.BoxGeometry(w, t, d, 8, 1, 6)
      : new THREE.BoxGeometry(w, t, d, 4, 1, 3);
    for (const f of [0, 1, 4, 5]) boxFaceUv(box, f, edge);
    box.translate(0, t / 2 + (3 - i) * (t + 0.0004), 0);
    if (top) {
      displace(box, (p) => {
        const c = smoothstep(0.06, 0.2, p.x) * smoothstep(0.0, 0.12, p.z);
        const c2 = c * c;
        return new THREE.Vector3(-0.035 * c2, 0.075 * c2, -0.025 * c2);
      });
      box.computeVertexNormals();
    }
    xform(
      box,
      [(rng() - 0.5) * 0.02, 0, (rng() - 0.5) * 0.016],
      [0, (rng() - 0.5) * 0.12, 0],
    );
    parts.push({ geo: box, mat: 0 });
  }
  return {
    parts,
    materials: [std(pbrNewspaper())],
    poses: [flat(1, 0.3)],
    sink: 0.003,
    castShadow: false,
    showYaw: Math.PI,
  };
}

// ---------------------------------------------------------------------------
// Crumpled paper ball
// ---------------------------------------------------------------------------

function paperBall(): ModelSpec {
  const R = 0.04 * K;
  const g = new THREE.SphereGeometry(R, 22, 14);
  displace(g, (p) => {
    const f =
      0.7 +
      0.42 * ridged3(p.x * 32, p.y * 32, p.z * 32, 3) +
      0.15 * (fbm3(p.x * 9, p.y * 9, p.z * 9) - 0.5);
    return R * (f - 1);
  });
  g.scale(1, 0.85, 1);
  weldNormals(g);
  return {
    parts: [{ geo: g, mat: 0 }],
    materials: [std(pbrPaperCrumpled(), { repeat: [2, 1] })],
    poses: [anyRot(1)],
    sink: 0.006,
  };
}

// ---------------------------------------------------------------------------
// Packing carton
// ---------------------------------------------------------------------------

function flapGeo(
  w: number,
  L: number,
  t: number,
  a0: number,
  bend: number,
  rect: [number, number, number, number],
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, t, L, 4, 1, 4);
  for (let f = 0; f < 6; f++) boxFaceUv(g, f, rect);
  g.translate(0, 0, L / 2);
  displace(g, (p) => {
    const s = p.z / L;
    const a = a0 + bend * s * s;
    const y = p.y * Math.cos(a) - p.z * Math.sin(a);
    const z = p.y * Math.sin(a) + p.z * Math.cos(a);
    return new THREE.Vector3(0, y - p.y, z - p.z);
  });
  g.computeVertexNormals();
  return g;
}

function cardboardBox(rng: () => number): ModelSpec {
  const W = 0.35 * K;
  const H = 0.25 * K;
  const D = 0.25 * K;
  const t = 0.005;
  const plain: [number, number, number, number] = [0.5, 0.64, 0.95, 0.82];
  const parts: Part[] = [];
  const wallZ = (z: number) => {
    const b = new THREE.BoxGeometry(W, H, t, 4, 3, 1);
    for (const f of [0, 1, 2, 3]) boxFaceUv(b, f, plain);
    b.translate(0, H / 2, z);
    return b;
  };
  const wallX = (x: number) => {
    const b = new THREE.BoxGeometry(t, H, D - 2 * t, 1, 3, 4);
    for (const f of [2, 3, 4, 5]) boxFaceUv(b, f, plain);
    b.translate(x, H / 2, 0);
    return b;
  };
  parts.push({ geo: wallZ(D / 2 - t / 2), mat: 0 });
  parts.push({ geo: wallZ(-D / 2 + t / 2), mat: 0 });
  parts.push({ geo: wallX(W / 2 - t / 2), mat: 0 });
  parts.push({ geo: wallX(-W / 2 + t / 2), mat: 0 });
  const bottom = new THREE.BoxGeometry(W - 2 * t, t, D - 2 * t, 1, 1, 1);
  for (let f = 0; f < 6; f++) boxFaceUv(bottom, f, plain);
  bottom.translate(0, t / 2, 0);
  parts.push({ geo: bottom, mat: 0 });
  // Flaps: local +z = inwards; opening angle −(π/2 + δ)
  const flaps: Array<[number, number, number, number, number]> = [
    // hinge x, hinge z, yaw, width, length
    [0, D / 2, Math.PI, W - 0.004, D / 2 - 0.006],
    [0, -D / 2, 0, W - 0.004, D / 2 - 0.006],
    [W / 2, 0, -Math.PI / 2, D - 0.004, W / 2 - 0.01],
    [-W / 2, 0, Math.PI / 2, D - 0.004, W / 2 - 0.01],
  ];
  const opens = [0.45, 0.05, -0.35, 0.3];
  const bends = [0.25, 0.3, 0.15, 0.4];
  for (let i = 0; i < 4; i++) {
    const [hx, hz, yaw, w, L] = flaps[i];
    const g = flapGeo(
      w,
      L,
      t,
      -(Math.PI / 2 + opens[i] + (rng() - 0.5) * 0.15),
      bends[i],
      plain,
    );
    xform(g, [hx, H, hz], [0, yaw, 0]);
    parts.push({ geo: g, mat: 0 });
  }
  return {
    parts,
    materials: [std(pbrCardboard())],
    poses: [upright(0.65), tippedZ(0.35, 0.3)],
    sink: 0.01,
  };
}

// ---------------------------------------------------------------------------
// Plastic bag
// ---------------------------------------------------------------------------

function plasticBag(rng: () => number): ModelSpec {
  const W = 0.36 * K;
  const D = 0.44 * K;
  const g = new THREE.PlaneGeometry(W, D, 12, 14);
  g.rotateX(-Math.PI / 2);
  const s1 = rng() * 10;
  displace(g, (p) => {
    const u = p.x / W + 0.5;
    const v = p.z / D + 0.5;
    const e = Math.min(u, 1 - u, v, 1 - v);
    const edge = smoothstep(0, 0.2, e);
    const h =
      0.075 * edge * (0.55 + 0.7 * fbm3(p.x * 5 + s1, 0, p.z * 5)) +
      0.04 * (ridged3(p.x * 8, s1, p.z * 8) - 0.35) * Math.sqrt(edge);
    const wob = (noise3(p.x * 20, s1, p.z * 20) - 0.5) * 0.02;
    return new THREE.Vector3(wob, Math.max(0, h), -wob);
  });
  g.computeVertexNormals();
  const parts: Part[] = [{ geo: g, mat: 0 }];
  // two flat carrying handles at the end
  for (const sx of [-1, 1]) {
    const c = new THREE.CatmullRomCurve3([
      new THREE.Vector3(sx * 0.1, 0.008, D * 0.45),
      new THREE.Vector3(sx * 0.13, 0.01, D * 0.58),
      new THREE.Vector3(sx * 0.05, 0.007, D * 0.62),
      new THREE.Vector3(sx * 0.02, 0.006, D * 0.5),
    ]);
    parts.push({
      geo: tube(c, {
        radius: (_t, ang) => 0.012 * (1 - 0.55 * Math.abs(Math.sin(ang))),
        segs: 14,
        radial: 5,
        uvMode: "along",
        tileLen: 0.3,
      }),
      mat: 0,
    });
  }
  return {
    parts,
    materials: [std(pbrPlasticBag(), { repeat: [1.4, 1.6] })],
    poses: [flat(1)],
    sink: 0.002,
    castShadow: false,
  };
}

// ---------------------------------------------------------------------------
// Crisp packet
// ---------------------------------------------------------------------------

function chipsBag(rng: () => number): ModelSpec {
  const W = 0.2 * K;
  const L = 0.3 * K;
  const s1 = rng() * 10;
  const mk = (front: boolean) => {
    const g = new THREE.PlaneGeometry(W, L, 10, 14);
    g.rotateX(front ? -Math.PI / 2 : Math.PI / 2);
    displace(g, (p) => {
      const u = p.x / W + 0.5;
      const v = p.z / L + 0.5;
      const su = Math.max(0, Math.sin(Math.PI * u)) ** 0.7;
      const sv = smoothstep(0, 0.14, Math.min(v, 1 - v)) ** 0.8;
      const base = front ? 0.09 : 0.02;
      let h =
        base *
        su *
        sv *
        (0.9 + 0.3 * fbm3(p.x * 6 + s1, front ? 1 : 3, p.z * 6));
      h += 0.006 * (ridged3(p.x * 12, s1, p.z * 12) - 0.5) * su * sv;
      return new THREE.Vector3(0, front ? h : -h, 0);
    });
    g.computeVertexNormals();
    return g;
  };
  const front = mk(true);
  const back = mk(false);
  remapUv(back, (u, v) => [1 - u, v]);
  return {
    parts: [
      { geo: front, mat: 0 },
      { geo: back, mat: 0 },
    ],
    materials: [std(pbrChipsBag("#d93a2b", "#f2c33d"))],
    poses: [flat(1, 0.35)],
    sink: 0.004,
    showYaw: Math.PI,
  };
}

// ---------------------------------------------------------------------------

export function buildModelA(
  def: TrashTypeDef,
  rng: () => number,
): ModelSpec | null {
  switch (def.id) {
    case "glass_green":
    case "glass_brown":
      return glassBottle(def.id);
    case "plastic_bottle":
      return petBottle();
    case "can":
      return can();
    case "can_crushed":
      return canCrushed();
    case "coaster":
      return coaster();
    case "newspaper":
      return newspaper(rng);
    case "paper_ball":
      return paperBall();
    case "cardboard":
      return cardboardBox(rng);
    case "plastic_bag":
      return plasticBag(rng);
    case "crisp_packet":
      return chipsBag(rng);
    default:
      return null;
  }
}
