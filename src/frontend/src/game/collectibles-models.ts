// 3D builders for the rare collectibles: one detailed model per catalog
// variant, shared by the world spawner (collectibles.ts) and the display-case
// inspect viewer (MenuCollection.tsx). Fully procedural like everything else –
// Canvas 2D textures (collectibles-textures.ts), generated geometry, no asset
// files. Each build creates fresh geometries/materials/textures so that
// disposeCollectibleModel() can free everything without touching a second
// live instance of the same variant (world + inspect viewer can coexist).
//
// Conventions: origin at the resting point on the ground, +y up, sizes in
// metres (0.05–0.35 m). Parts are merged per material (trash-geo assemble),
// so a model costs 1–5 draw calls; transparent shells (glass, crystal,
// amber) get explicit renderOrder so the rolled-up letters stay visible
// through the bottle walls.

import * as THREE from "three";
import { COLLECTIBLE_BY_ID } from "./collectibles-data";
import {
  GOLD,
  SILVER,
  amberMaps,
  cashCoinMaps,
  coinMapsFor,
  corkMaps,
  dialMaps,
  fernShaleMaps,
  glassMaps,
  matFromMaps,
  nacreMaps,
  paperMaps,
  stoneMaps,
  urchinMaps,
  wornMetalMaps,
} from "./collectibles-textures";
import type { Rgb } from "./textures-core";
import { makeCanvas, texFromCanvas } from "./textures-core";
import {
  assemble,
  catmull,
  displace,
  lathe,
  tube,
  weldNormals,
  xform,
} from "./trash-geo";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Deterministic per-variant seed so a variant always looks identical. */
function seedFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++)
    h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  return h >>> 0;
}

/** Wrap the content in a root group and lift it so min y = 0 (resting pose). */
function settle(root: THREE.Group): THREE.Group {
  const box = new THREE.Box3().setFromObject(root);
  if (Number.isFinite(box.min.y)) {
    for (const c of root.children) c.position.y -= box.min.y;
  }
  return root;
}

function mesh(
  geo: THREE.BufferGeometry,
  mat: THREE.Material | THREE.Material[],
  castShadow = true,
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = castShadow;
  return m;
}

// ---------------------------------------------------------------------------
// Fossils
// ---------------------------------------------------------------------------

function buildAmmonite(seed: number): THREE.Group {
  // Logarithmic spiral (3.4 turns) in the ground plane; the tube radius grows
  // linearly with arc length (property of the log spiral), so successive
  // whorls just touch. Ribs ride across the whorl like on the real shell.
  const b = 0.0748; // growth: ×1.6 per turn
  const turns = 3.4;
  const th1 = turns * Math.PI * 2;
  const rOut = 0.052;
  const r0 = rOut * Math.exp(-b * th1);
  const pts: Array<[number, number, number]> = [];
  const steps = 180;
  for (let i = 0; i <= steps; i++) {
    const th = (i / steps) * th1;
    const r = r0 * Math.exp(b * th);
    pts.push([r * Math.cos(th), 0, -r * Math.sin(th)]);
  }
  const curve = catmull(pts, false, 0.5);
  const L = curve.getLength();
  const kGrow = b / Math.sqrt(1 + b * b); // shell radius per arc length
  const ribCount = Math.round(L / 0.009);
  const geo = tube(curve, {
    segs: 300,
    radial: 22,
    uvMode: "along",
    caps: true,
    radius: (t, ang) => {
      const shellR = r0 + kGrow * t * L;
      const rib = 0.5 + 0.5 * Math.sin(t * ribCount * Math.PI * 2);
      const s = Math.sin(ang);
      const squash = 1 - 0.45 * s * s; // flattened whorl cross-section
      return Math.max(0.0008, shellR * 0.26 * squash * (1 + rib * rib * 0.06));
    },
  });
  const maps = stoneMaps(seed, {
    base: [0.45, 0.37, 0.27],
    band: [0.27, 0.21, 0.15],
    bandFreq: ribCount,
    striae: 0,
    rough: 0.5,
    fleck: 0.25,
  });
  const g = new THREE.Group();
  g.add(mesh(geo, matFromMaps(maps)));
  return settle(g);
}

function buildTrilobite(seed: number): THREE.Group {
  // Slate slab with the animal in half relief on top.
  const slabH = 0.028;
  const slab = displace(
    new THREE.CylinderGeometry(0.075, 0.082, slabH, 26, 1),
    (p) => {
      const a = Math.atan2(p.z, p.x);
      const rk =
        1 +
        0.16 * Math.sin(a * 3 + seed) +
        0.1 * Math.sin(a * 7 - seed * 2) +
        0.05 * Math.sin(a * 13);
      return new THREE.Vector3(p.x * (rk - 1) * 1.12, 0, p.z * (rk - 1));
    },
  );
  slab.translate(0, slabH / 2, 0);
  const parts = [{ geo: slab, mat: 0 }];
  // Body: cephalon, ten arched thorax segments, axial ridge, pygidium
  const yTop = slabH;
  const ceph = new THREE.SphereGeometry(1, 20, 12);
  parts.push({
    geo: xform(ceph, [0, yTop, -0.03], undefined, [0.027, 0.0085, 0.02]),
    mat: 1,
  });
  for (let k = 0; k < 10; k++) {
    const t = k / 9;
    const w = 0.05 * (1 - t * 0.45);
    const seg = new THREE.CylinderGeometry(0.0038, 0.0038, w, 10);
    parts.push({
      geo: xform(
        seg,
        [0, yTop + 0.0022, -0.012 + k * 0.0062],
        [0, 0, Math.PI / 2],
        [1, 1, 0.62],
      ),
      mat: 1,
    });
  }
  const axis = new THREE.CapsuleGeometry(0.0055, 0.062, 4, 10);
  parts.push({
    geo: xform(
      axis,
      [0, yTop + 0.003, 0.002],
      [Math.PI / 2, 0, 0],
      [1, 1, 0.75],
    ),
    mat: 1,
  });
  const pyg = new THREE.SphereGeometry(1, 16, 10);
  parts.push({
    geo: xform(pyg, [0, yTop, 0.052], undefined, [0.017, 0.006, 0.014]),
    mat: 1,
  });
  const geo = assemble(parts, 2);
  const slabMat = matFromMaps(
    stoneMaps(seed, { base: [0.3, 0.32, 0.35], rough: 0.85 }),
  );
  const bodyMat = matFromMaps(
    stoneMaps(seed ^ 9, { base: [0.16, 0.17, 0.19], striae: 90, rough: 0.55 }),
  );
  const g = new THREE.Group();
  g.add(mesh(geo, [slabMat, bodyMat]));
  return settle(g);
}

function buildSharkTooth(seed: number): THREE.Group {
  // Crown: curved triangular blade; root: broad bilobate band at the base.
  const crownShape = new THREE.Shape();
  crownShape.moveTo(-0.041, 0);
  crownShape.quadraticCurveTo(-0.012, 0.045, -0.0015, 0.104);
  crownShape.quadraticCurveTo(0, 0.108, 0.0015, 0.104);
  crownShape.quadraticCurveTo(0.014, 0.045, 0.041, 0);
  crownShape.quadraticCurveTo(0, -0.008, -0.041, 0);
  const crown = new THREE.ExtrudeGeometry(crownShape, {
    depth: 0.007,
    bevelEnabled: true,
    bevelThickness: 0.0035,
    bevelSize: 0.004,
    bevelSegments: 4,
    curveSegments: 24,
  });
  crown.translate(0, 0, -0.0035);
  // taper the blade towards the tip and give it a slight backwards sweep
  displace(crown, (p) => {
    const t = Math.max(0, Math.min(1, p.y / 0.105));
    return new THREE.Vector3(
      t * t * 0.008,
      0,
      -p.z * t * 0.6 + Math.sin(seed) * 0.0005,
    );
  });
  crown.computeVertexNormals();
  const rootShape = new THREE.Shape();
  rootShape.moveTo(-0.049, 0.012);
  rootShape.quadraticCurveTo(-0.03, -0.021, -0.006, -0.014);
  rootShape.quadraticCurveTo(0, -0.011, 0.006, -0.014);
  rootShape.quadraticCurveTo(0.03, -0.021, 0.049, 0.012);
  rootShape.quadraticCurveTo(0, 0.028, -0.049, 0.012);
  const root = new THREE.ExtrudeGeometry(rootShape, {
    depth: 0.012,
    bevelEnabled: true,
    bevelThickness: 0.003,
    bevelSize: 0.003,
    bevelSegments: 3,
    curveSegments: 18,
  });
  root.translate(0, 0, -0.006);
  const geo = assemble(
    [
      { geo: crown, mat: 0 },
      { geo: root, mat: 1 },
    ],
    2,
  );
  const enamel = new THREE.MeshStandardMaterial({
    color: 0x33343a,
    roughness: 0.24,
    metalness: 0.05,
  });
  const bone = matFromMaps(
    stoneMaps(seed, { base: [0.56, 0.48, 0.37], rough: 0.95, fleck: 0.3 }),
  );
  const g = new THREE.Group();
  const m = mesh(geo, [enamel, bone]);
  m.rotation.x = -0.22; // leans back on its root
  g.add(m);
  return settle(g);
}

function buildUrchin(seed: number): THREE.Group {
  const geo = new THREE.SphereGeometry(0.037, 48, 32);
  geo.scale(1, 0.68, 1.06);
  displace(geo, (p) => {
    if (p.y < -0.0155) p.y = -0.0155; // flint hearts sit on a flat base
    const lump =
      Math.sin(p.x * 240 + seed) * Math.sin(p.z * 260 - seed) * 0.0006;
    return new THREE.Vector3(0, lump, 0);
  });
  geo.computeVertexNormals();
  const g = new THREE.Group();
  g.add(mesh(geo, matFromMaps(urchinMaps(seed))));
  return settle(g);
}

function buildFernShale(seed: number): THREE.Group {
  const h = 0.022;
  const slab = displace(
    new THREE.CylinderGeometry(0.095, 0.1, h, 30, 1),
    (p) => {
      const a = Math.atan2(p.z, p.x);
      const rk =
        0.18 * Math.sin(a * 2 + seed) +
        0.12 * Math.sin(a * 5 - seed) +
        0.05 * Math.sin(a * 11 + 2);
      return new THREE.Vector3(p.x * rk, 0, p.z * (rk + 0.22)); // oblong plate
    },
  );
  slab.translate(0, h / 2, 0);
  // planar UV over the slab so the painted frond lands on the top face
  slab.computeBoundingBox();
  const bb = slab.boundingBox;
  if (bb) {
    const uv = slab.getAttribute("uv") as THREE.BufferAttribute;
    const pos = slab.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(
        i,
        (pos.getX(i) - bb.min.x) / (bb.max.x - bb.min.x),
        (pos.getZ(i) - bb.min.z) / (bb.max.z - bb.min.z),
      );
    }
    uv.needsUpdate = true;
  }
  const g = new THREE.Group();
  g.add(mesh(slab, matFromMaps(fernShaleMaps(seed))));
  return settle(g);
}

function buildAmber(seed: number): THREE.Group {
  const lump = new THREE.IcosahedronGeometry(0.036, 4);
  displace(lump, (p, n) => {
    const k =
      Math.sin(p.x * 34 + seed) * Math.sin(p.y * 41 - seed) * 0.5 +
      Math.sin(p.z * 27 + p.x * 22) * 0.5;
    return n.clone().multiplyScalar(k * 0.0022);
  });
  lump.scale(1, 0.82, 0.92);
  // PolyhedronGeometry is non-indexed – computeVertexNormals would facet it
  weldNormals(lump);
  const amber = amberMaps(seed);
  const amberMat = new THREE.MeshPhysicalMaterial({
    map: amber.map,
    roughnessMap: amber.roughnessMap ?? null,
    transparent: true,
    roughness: 1,
    metalness: 0,
    clearcoat: 0.7,
    clearcoatRoughness: 0.25,
    emissive: new THREE.Color(0x421c02),
    emissiveIntensity: 0.2,
    depthWrite: false,
  });
  const shell = mesh(lump, amberMat, false);
  shell.renderOrder = 4;
  // the midge, forever mid-flight
  const flyParts = [
    {
      geo: xform(
        new THREE.SphereGeometry(0.0022, 8, 6),
        [0.004, 0.0055, 0.002],
        undefined,
        [1, 0.8, 1.6],
      ),
      mat: 0,
    },
    {
      geo: xform(
        new THREE.SphereGeometry(0.0013, 8, 6),
        [0.004, 0.0062, -0.0012],
      ),
      mat: 0,
    },
  ];
  const fly = mesh(
    assemble(flyParts, 1),
    new THREE.MeshStandardMaterial({ color: 0x241407, roughness: 0.6 }),
    false,
  );
  const wingGeo = assemble(
    [
      {
        geo: xform(
          new THREE.PlaneGeometry(0.005, 0.0024),
          [0.0068, 0.0062, 0.003],
          [-1.2, 0.5, 0],
        ),
        mat: 0,
      },
      {
        geo: xform(
          new THREE.PlaneGeometry(0.005, 0.0024),
          [0.0012, 0.0062, 0.003],
          [-1.2, -0.5, 0],
        ),
        mat: 0,
      },
    ],
    1,
  );
  const wings = mesh(
    wingGeo,
    new THREE.MeshStandardMaterial({
      color: 0xb0a894,
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide,
      roughness: 0.7,
    }),
    false,
  );
  wings.renderOrder = 3;
  const g = new THREE.Group();
  g.add(fly, wings, shell);
  return settle(g);
}

// ---------------------------------------------------------------------------
// Coins
// ---------------------------------------------------------------------------

/**
 * Milled or hammered disc whose caps map onto the two face circles of the
 * coin sheet (collectibles-textures.ts coinMaps) and whose side maps onto the
 * edge strip. Hammered coins get an irregular outline and a slight cup warp.
 */
function buildRoundCoin(id: string, seed: number): THREE.Group {
  const spec = COLLECTIBLE_BY_ID[id];
  const milled = id === "coin_doubloon" || id === "coin_sovereign";
  const r = id === "coin_real" ? 0.031 : id === "coin_penny" ? 0.024 : 0.027;
  const h = 0.0042;
  const geo = new THREE.CylinderGeometry(r, r, h, 64, 1, false);
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const nor = geo.getAttribute("normal") as THREE.BufferAttribute;
  const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i);
    const py = pos.getY(i);
    const pz = pos.getZ(i);
    const ny = nor.getY(i);
    if (ny > 0.7) {
      uv.setXY(i, 0.25 + (px / r) * 0.1953, 0.53125 - (pz / r) * 0.3906);
    } else if (ny < -0.7) {
      uv.setXY(i, 0.75 - (px / r) * 0.1953, 0.53125 - (pz / r) * 0.3906);
    } else {
      const a = Math.atan2(pz, px) / (Math.PI * 2) + 0.5;
      uv.setXY(i, a, 0.9775 + (py / h) * 0.035);
    }
    if (!milled) {
      // hammered: irregular outline + gentle cupping
      const a = Math.atan2(pz, px);
      const wob =
        1 +
        0.04 * Math.sin(a * 3 + seed) +
        0.028 * Math.sin(a * 7 - seed * 1.7) +
        0.012 * Math.sin(a * 13 + 1);
      const rd = Math.hypot(px, pz) / r;
      pos.setX(i, px * wob);
      pos.setZ(i, pz * wob);
      pos.setY(i, py + rd * rd * 0.0005 * Math.sin(a + seed));
    }
  }
  pos.needsUpdate = true;
  uv.needsUpdate = true;
  const mat = matFromMaps(coinMapsFor(id, seed), { envMapIntensity: 0.8 });
  const g = new THREE.Group();
  const m = mesh(geo, mat);
  m.name = spec?.id ?? id;
  g.add(m);
  return settle(g);
}

function buildCashCoin(seed: number): THREE.Group {
  const R = 0.0275;
  const hole = 0.0078;
  const shape = new THREE.Shape();
  shape.absarc(0, 0, R, 0, Math.PI * 2, false);
  const sq = new THREE.Path();
  sq.moveTo(-hole, -hole);
  sq.lineTo(-hole, hole);
  sq.lineTo(hole, hole);
  sq.lineTo(hole, -hole);
  sq.closePath();
  shape.holes.push(sq);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.0028,
    bevelEnabled: true,
    bevelThickness: 0.0006,
    bevelSize: 0.0006,
    bevelSegments: 2,
    curveSegments: 48,
  });
  // planar UV over the face so both sides carry the cast relief sheet
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  if (bb) {
    const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(
        i,
        (pos.getX(i) - bb.min.x) / (bb.max.x - bb.min.x),
        (pos.getY(i) - bb.min.y) / (bb.max.y - bb.min.y),
      );
    }
    uv.needsUpdate = true;
  }
  geo.rotateX(-Math.PI / 2);
  const g = new THREE.Group();
  g.add(mesh(geo, matFromMaps(cashCoinMaps(seed))));
  return settle(g);
}

// ---------------------------------------------------------------------------
// Bottles
// ---------------------------------------------------------------------------

interface BottleSpec {
  /** Outer glass profile, bottom → lip. */
  profile: Array<[number, number]>;
  tint: Rgb;
  opacity: number;
  crust?: number;
  /** Cork: centre height and radius. */
  cork?: { y: number; r: number; h: number };
  /** Wax seal poured over cork and lip. */
  wax?: { y: number; r: number; color: number };
  /** Rope collar wound around the neck. */
  rope?: { y: number; r: number };
  /** Sticky-tape band over the closure. */
  tape?: { y: number; r: number; h: number };
  /** Rolled letter inside: centre height, roll length. */
  paper: { y: number; len: number; tilt: number };
  sand?: boolean;
  limpets?: boolean;
  /** Radius of the body at sand/limpet height (for placement). */
  bodyR: number;
}

const BOTTLE_SPECS: Record<string, BottleSpec> = {
  bottle_castaway: {
    profile: [
      [0.004, 0.0015],
      [0.03, 0.001],
      [0.042, 0.004],
      [0.0448, 0.012],
      [0.045, 0.07],
      [0.0445, 0.125],
      [0.04, 0.152],
      [0.028, 0.178],
      [0.017, 0.2],
      [0.0135, 0.218],
      [0.0125, 0.262],
      [0.0125, 0.272],
      [0.0148, 0.275],
      [0.0148, 0.288],
      [0.012, 0.29],
      [0.0095, 0.288],
    ],
    tint: [0.14, 0.28, 0.18],
    opacity: 0.52,
    crust: 0.85,
    cork: { y: 0.283, r: 0.0095, h: 0.032 },
    paper: { y: 0.05, len: 0.1, tilt: 1.35 },
    sand: true,
    limpets: true,
    bodyR: 0.045,
  },
  bottle_wish: {
    profile: [
      [0.003, 0.001],
      [0.022, 0.001],
      [0.0295, 0.006],
      [0.0305, 0.03],
      [0.028, 0.052],
      [0.0305, 0.068],
      [0.028, 0.088],
      [0.019, 0.108],
      [0.0125, 0.122],
      [0.0105, 0.132],
      [0.0105, 0.158],
      [0.0128, 0.161],
      [0.0128, 0.172],
      [0.0102, 0.174],
      [0.008, 0.172],
    ],
    tint: [0.72, 0.78, 0.75],
    opacity: 0.26,
    cork: { y: 0.168, r: 0.008, h: 0.026 },
    paper: { y: 0.04, len: 0.07, tilt: 1.2 },
    bodyR: 0.0305,
  },
  bottle_capsule: {
    profile: [
      [0.0035, 0.001],
      [0.026, 0.001],
      [0.0345, 0.005],
      [0.035, 0.05],
      [0.035, 0.13],
      [0.0325, 0.152],
      [0.022, 0.175],
      [0.014, 0.192],
      [0.0115, 0.2],
      [0.0115, 0.228],
      [0.0135, 0.231],
      [0.0135, 0.24],
      [0.011, 0.242],
      [0.009, 0.24],
    ],
    tint: [0.62, 0.74, 0.64],
    opacity: 0.3,
    cork: { y: 0.235, r: 0.009, h: 0.028 },
    tape: { y: 0.238, r: 0.0145, h: 0.02 },
    paper: { y: 0.045, len: 0.09, tilt: 1.3 },
    sand: true,
    bodyR: 0.035,
  },
  bottle_apology: {
    profile: [
      [0.0035, 0.001],
      [0.024, 0.001],
      [0.0325, 0.005],
      [0.033, 0.04],
      [0.033, 0.118],
      [0.029, 0.138],
      [0.017, 0.155],
      [0.0125, 0.164],
      [0.0115, 0.172],
      [0.0115, 0.182],
      [0.014, 0.185],
      [0.014, 0.194],
      [0.0112, 0.196],
      [0.009, 0.194],
    ],
    tint: [0.34, 0.18, 0.07],
    opacity: 0.58,
    cork: { y: 0.19, r: 0.009, h: 0.026 },
    wax: { y: 0.198, r: 0.016, color: 0xd8cfb4 },
    paper: { y: 0.04, len: 0.08, tilt: 1.25 },
    bodyR: 0.033,
  },
  bottle_forecast: {
    profile: [
      [0.004, 0.001],
      [0.03, 0.001],
      [0.0405, 0.006],
      [0.0425, 0.03],
      [0.0405, 0.062],
      [0.032, 0.088],
      [0.019, 0.108],
      [0.0135, 0.12],
      [0.0125, 0.13],
      [0.0125, 0.15],
      [0.015, 0.153],
      [0.015, 0.163],
      [0.0118, 0.165],
      [0.0095, 0.163],
    ],
    tint: [0.5, 0.7, 0.62],
    opacity: 0.36,
    crust: 0.25,
    cork: { y: 0.158, r: 0.0095, h: 0.028 },
    rope: { y: 0.124, r: 0.0135 },
    paper: { y: 0.035, len: 0.07, tilt: 1.15 },
    sand: true,
    bodyR: 0.0425,
  },
  bottle_coordinates: {
    profile: [
      [0.003, 0.001],
      [0.021, 0.001],
      [0.0285, 0.005],
      [0.0295, 0.04],
      [0.0295, 0.11],
      [0.026, 0.132],
      [0.016, 0.155],
      [0.0115, 0.168],
      [0.0105, 0.178],
      [0.0105, 0.198],
      [0.013, 0.201],
      [0.013, 0.21],
      [0.0105, 0.212],
      [0.0085, 0.21],
    ],
    tint: [0.1, 0.17, 0.5],
    opacity: 0.5,
    cork: { y: 0.206, r: 0.008, h: 0.026 },
    wax: { y: 0.214, r: 0.015, color: 0x8c1f1a },
    paper: { y: 0.04, len: 0.085, tilt: 1.3 },
    bodyR: 0.0295,
  },
};

function buildBottle(id: string, seed: number): THREE.Group {
  const spec = BOTTLE_SPECS[id] ?? BOTTLE_SPECS.bottle_castaway;
  const g = new THREE.Group();

  // ---- opaque contents and fittings, merged per material -----------------
  const parts: Array<{ geo: THREE.BufferGeometry; mat: number }> = [];
  // rolled letter: two nested open cylinders + top disc + twine
  const P = spec.paper;
  const roll = new THREE.CylinderGeometry(0.008, 0.008, P.len, 16, 1, true);
  const rollIn = new THREE.CylinderGeometry(
    0.0054,
    0.0054,
    P.len * 0.96,
    12,
    1,
    true,
  );
  const rollTop = new THREE.CircleGeometry(0.008, 16);
  rollTop.rotateX(-Math.PI / 2);
  rollTop.translate(0, P.len / 2, 0);
  const rot: [number, number, number] = [P.tilt, seed % 3, 0];
  parts.push({ geo: xform(roll, [0, P.y, 0], rot), mat: 0 });
  parts.push({ geo: xform(rollIn, [0, P.y, 0], rot), mat: 0 });
  parts.push({ geo: xform(rollTop, [0, P.y, 0], rot), mat: 0 });
  const twine = new THREE.TorusGeometry(0.0086, 0.0009, 6, 18);
  parts.push({
    geo: xform(twine, [0, P.y, 0], [P.tilt + Math.PI / 2, seed % 3, 0]),
    mat: 3,
  });
  if (spec.cork) {
    const c = spec.cork;
    const cork = lathe(
      [
        [c.r * 0.94, -c.h / 2],
        [c.r, -c.h * 0.3],
        [c.r * 1.06, c.h * 0.28],
        [c.r * 1.04, c.h * 0.44],
        [c.r * 0.7, c.h / 2],
        [0.0008, c.h / 2],
      ],
      18,
      { vByHeight: true },
    );
    parts.push({ geo: xform(cork, [0, c.y, 0]), mat: 1 });
  }
  if (spec.sand) {
    const sand = new THREE.SphereGeometry(spec.bodyR * 0.72, 18, 10);
    parts.push({
      geo: xform(sand, [0, 0.004, 0], undefined, [1, 0.22, 1]),
      mat: 2,
    });
  }
  if (spec.limpets) {
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + seed;
      const y = 0.03 + ((k * 37 + seed) % 10) * 0.009;
      const cone = new THREE.ConeGeometry(0.0058, 0.005, 10);
      parts.push({
        geo: xform(
          cone,
          [Math.cos(a) * spec.bodyR, y, Math.sin(a) * spec.bodyR],
          [0, -a, -Math.PI / 2],
        ),
        mat: 2,
      });
    }
  }
  if (spec.rope) {
    for (let k = 0; k < 3; k++) {
      const ring = new THREE.TorusGeometry(spec.rope.r, 0.0035, 8, 22);
      parts.push({
        geo: xform(ring, [0, spec.rope.y + k * 0.0058, 0], [Math.PI / 2, 0, 0]),
        mat: 3,
      });
    }
  }
  if (spec.tape) {
    const band = new THREE.CylinderGeometry(
      spec.tape.r,
      spec.tape.r,
      spec.tape.h,
      20,
      1,
      true,
    );
    parts.push({ geo: xform(band, [0, spec.tape.y, 0]), mat: 4 });
  }
  const paperMat = matFromMaps(paperMaps(seed), { side: THREE.DoubleSide });
  const corkMat = matFromMaps(corkMaps(seed));
  const shellMat = new THREE.MeshStandardMaterial({
    color: 0xcfc4a8,
    roughness: 0.9,
  });
  const ropeMat = new THREE.MeshStandardMaterial({
    color: 0x6b5636,
    roughness: 1,
  });
  const tapeMat = new THREE.MeshStandardMaterial({
    color: 0x9a9788,
    roughness: 0.45,
    side: THREE.DoubleSide,
  });
  g.add(
    mesh(assemble(parts, 5), [paperMat, corkMat, shellMat, ropeMat, tapeMat]),
  );

  if (spec.wax) {
    const w = spec.wax;
    const wax = lathe(
      [
        [w.r * 0.55, -0.012],
        [w.r * 0.9, -0.007],
        [w.r, -0.002],
        [w.r * 0.92, 0.003],
        [w.r * 0.55, 0.006],
        [0.0008, 0.007],
      ],
      20,
      { vByHeight: true },
    );
    displace(wax, (p) => {
      const a = Math.atan2(p.z, p.x);
      const drip = Math.max(0, Math.sin(a * 5 + seed)) ** 3;
      return new THREE.Vector3(0, p.y < -0.004 ? -drip * 0.012 : 0, 0);
    });
    wax.computeVertexNormals();
    const waxMesh = mesh(
      wax,
      new THREE.MeshStandardMaterial({ color: w.color, roughness: 0.42 }),
    );
    waxMesh.position.y = w.y;
    g.add(waxMesh);
  }

  // ---- glass shell: back faces then front faces, letter shows through ----
  const glass = lathe(spec.profile, 44, { vByHeight: true });
  const maps = glassMaps({
    tint: spec.tint,
    opacity: spec.opacity,
    crust: spec.crust ?? 0,
    seed,
  });
  const back = matFromMaps(maps, {
    side: THREE.BackSide,
    depthWrite: false,
    transparent: true,
  });
  const front = matFromMaps(maps, {
    side: THREE.FrontSide,
    depthWrite: false,
    transparent: true,
    envMapIntensity: 1.4,
  });
  const backMesh = mesh(glass, back, false);
  backMesh.renderOrder = 5;
  const frontMesh = mesh(glass, front, false);
  frontMesh.renderOrder = 6;
  g.add(backMesh, frontMesh);
  return settle(g);
}

// ---------------------------------------------------------------------------
// Jewellery
// ---------------------------------------------------------------------------

function buildWeddingBand(seed: number): THREE.Group {
  const geo = new THREE.TorusGeometry(0.021, 0.0036, 18, 56);
  geo.scale(1, 1, 0.8); // D-shaped band profile
  geo.rotateX(-Math.PI / 2); // lying flat in the sand
  const maps = wornMetalMaps({
    ...GOLD,
    amount: 0.12,
    rough: 0.2,
    scratches: 70,
    seed,
    engrave: (ctx, w, h) => {
      ctx.font = `italic ${Math.round(h * 0.2)}px 'Times New Roman', serif`;
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (let k = 0; k < 3; k++)
        ctx.fillText("A · E · 1911", w * (0.17 + k * 0.33), h * 0.5);
    },
  });
  const g = new THREE.Group();
  g.add(mesh(geo, matFromMaps(maps)));
  return settle(g);
}

function buildSignet(seed: number): THREE.Group {
  // Band thickening towards the shoulders, oval table with an onyx inlay.
  const R = 0.0115;
  const pts: Array<[number, number, number]> = [];
  for (let i = 0; i < 24; i++) {
    const a = Math.PI / 2 + (i / 24) * Math.PI * 2;
    pts.push([Math.cos(a) * R, R + Math.sin(a) * R, 0]);
  }
  const band = tube(catmull(pts, true, 0.5), {
    segs: 72,
    radial: 14,
    closed: true,
    radius: (t) => {
      const k = 0.5 + 0.5 * Math.cos(t * Math.PI * 2); // 1 at the top
      return 0.0024 + 0.0032 * k * k;
    },
  });
  const plate = new THREE.CylinderGeometry(0.0105, 0.0088, 0.0042, 24);
  const goldParts = [
    { geo: band, mat: 0 },
    {
      geo: xform(plate, [0, 2 * R + 0.0032, 0], undefined, [1, 1, 0.8]),
      mat: 0,
    },
  ];
  const onyx = new THREE.CylinderGeometry(0.0086, 0.0086, 0.0012, 24);
  const g = new THREE.Group();
  g.add(
    mesh(
      assemble(goldParts, 1),
      matFromMaps(
        wornMetalMaps({
          ...GOLD,
          amount: 0.22,
          rough: 0.24,
          scratches: 60,
          seed,
        }),
      ),
    ),
  );
  const onyxMesh = mesh(
    onyx,
    new THREE.MeshPhysicalMaterial({
      color: 0x101014,
      roughness: 0.12,
      clearcoat: 0.8,
      clearcoatRoughness: 0.1,
    }),
  );
  onyxMesh.position.set(0, 2 * R + 0.0056, 0);
  onyxMesh.scale.set(1, 1, 0.8);
  g.add(onyxMesh);
  return settle(g);
}

function buildPearls(seed: number): THREE.Group {
  // A graduated string pooled on the sand in a lazy loop.
  const loop = catmull(
    [
      [-0.05, 0, 0],
      [-0.032, 0, 0.028],
      [0.004, 0, 0.038],
      [0.038, 0, 0.026],
      [0.05, 0, -0.004],
      [0.034, 0, -0.028],
      [0.002, 0, -0.036],
      [-0.03, 0, -0.026],
    ],
    true,
    0.55,
  );
  const n = 48;
  const pearlParts: Array<{ geo: THREE.BufferGeometry; mat: number }> = [];
  const p = new THREE.Vector3();
  for (let k = 0; k < n; k++) {
    const t = k / n;
    loop.getPointAt(t, p);
    // graduated: largest opposite the clasp (t = 0.5)
    const r = 0.0027 + 0.0022 * Math.sin(Math.PI * t) ** 1.5;
    const s = new THREE.SphereGeometry(r, 14, 10);
    const jx = Math.sin(k * 7.3 + seed) * 0.0005;
    pearlParts.push({
      geo: xform(s, [p.x + jx, r * 0.95, p.z + Math.cos(k * 5.1) * 0.0005]),
      mat: 0,
    });
  }
  const g = new THREE.Group();
  const nacre = nacreMaps(seed);
  const pearlMat = new THREE.MeshPhysicalMaterial({
    map: nacre.map,
    roughnessMap: nacre.roughnessMap ?? null,
    roughness: 1,
    metalness: 0,
    clearcoat: 0.35,
    clearcoatRoughness: 0.3,
    iridescence: 0.35,
    iridescenceIOR: 1.3,
    sheen: 0.4,
    sheenColor: new THREE.Color(0xffe8f0),
    envMapIntensity: 0.5,
  });
  g.add(mesh(assemble(pearlParts, 1), pearlMat));
  // gold clasp at t = 0
  loop.getPointAt(0, p);
  const clasp = mesh(
    new THREE.CapsuleGeometry(0.0018, 0.004, 4, 10),
    matFromMaps(wornMetalMaps({ ...GOLD, amount: 0.2, rough: 0.25, seed })),
  );
  clasp.position.set(p.x, 0.002, p.z);
  clasp.rotation.set(Math.PI / 2, 0, 0.6);
  g.add(clasp);
  return settle(g);
}

function buildBracelet(seed: number): THREE.Group {
  // Curb chain pooled in an open S, links alternately flat and tilted.
  const path = catmull(
    [
      [-0.055, 0, -0.02],
      [-0.035, 0, 0.012],
      [-0.005, 0, 0.02],
      [0.02, 0, 0.004],
      [0.038, 0, -0.016],
      [0.055, 0, -0.008],
      [0.05, 0, 0.018],
    ],
    false,
    0.6,
  );
  const n = 14;
  const parts: Array<{ geo: THREE.BufferGeometry; mat: number }> = [];
  const p = new THREE.Vector3();
  const tan = new THREE.Vector3();
  for (let k = 0; k < n; k++) {
    const t = k / (n - 1);
    path.getPointAt(t, p);
    path.getTangentAt(t, tan);
    const yaw = Math.atan2(tan.x, tan.z);
    const link = new THREE.TorusGeometry(0.0062, 0.0017, 8, 16);
    link.scale(1, 1.35, 1);
    const tilt = k % 2 === 0 ? Math.PI / 2 : Math.PI / 2 - 0.9;
    parts.push({
      geo: xform(link, [p.x, 0.0022, p.z], [tilt, yaw, 0]),
      mat: 0,
    });
  }
  // simple spring-ring clasp at the far end
  path.getPointAt(1, p);
  parts.push({
    geo: xform(
      new THREE.TorusGeometry(0.0045, 0.0014, 8, 14),
      [p.x, 0.002, p.z + 0.006],
      [Math.PI / 2, 0, 0],
    ),
    mat: 0,
  });
  const g = new THREE.Group();
  g.add(
    mesh(
      assemble(parts, 1),
      matFromMaps(
        wornMetalMaps({
          ...SILVER,
          amount: 0.6,
          rough: 0.3,
          scratches: 80,
          seed,
        }),
      ),
    ),
  );
  return settle(g);
}

function buildBrooch(seed: number): THREE.Group {
  // Full-rigged ship in gilt, lying face up; a garnet amidships.
  const gold: Array<{ geo: THREE.BufferGeometry; mat: number }> = [];
  const hullShape = new THREE.Shape();
  hullShape.moveTo(-0.026, 0.004);
  hullShape.quadraticCurveTo(-0.02, -0.007, 0, -0.0085);
  hullShape.quadraticCurveTo(0.02, -0.007, 0.028, 0.005);
  hullShape.quadraticCurveTo(0.012, 0.001, 0, 0.001);
  hullShape.quadraticCurveTo(-0.014, 0.001, -0.026, 0.004);
  const hull = new THREE.ExtrudeGeometry(hullShape, {
    depth: 0.003,
    bevelEnabled: true,
    bevelThickness: 0.0008,
    bevelSize: 0.0008,
    bevelSegments: 2,
    curveSegments: 16,
  });
  gold.push({ geo: hull, mat: 0 });
  // waves under the keel
  const waveShape = new THREE.Shape();
  waveShape.moveTo(-0.03, -0.009);
  for (let k = 0; k < 6; k++) {
    const x0 = -0.03 + k * 0.01;
    waveShape.quadraticCurveTo(x0 + 0.005, -0.014, x0 + 0.01, -0.009);
  }
  waveShape.lineTo(0.03, -0.012);
  waveShape.lineTo(-0.03, -0.012);
  const waves = new THREE.ExtrudeGeometry(waveShape, {
    depth: 0.0022,
    bevelEnabled: false,
    curveSegments: 10,
  });
  gold.push({ geo: waves, mat: 0 });
  const mastX = [-0.013, 0.001, 0.015];
  const mastH = [0.02, 0.026, 0.018];
  for (let m = 0; m < 3; m++) {
    const mast = new THREE.CylinderGeometry(0.0008, 0.001, mastH[m], 6);
    gold.push({
      geo: xform(mast, [mastX[m], 0.004 + mastH[m] / 2, 0.0015]),
      mat: 0,
    });
    // two billowed square sails per mast
    for (let s = 0; s < 2; s++) {
      const w = 0.011 - s * 0.003 - m * 0.0006;
      const sail = new THREE.PlaneGeometry(w, 0.0075, 6, 4);
      displace(
        sail,
        (pt) =>
          new THREE.Vector3(0, 0, Math.cos((pt.x / w) * Math.PI) * 0.0022),
      );
      sail.computeVertexNormals();
      gold.push({
        geo: xform(
          sail,
          [mastX[m], 0.011 + s * 0.0085 + (m === 1 ? 0.002 : 0), 0.0015],
          [0, 0, s === 0 ? 0.04 : -0.05],
        ),
        mat: 1,
      });
    }
  }
  // pin bar across the back
  const pin = new THREE.CylinderGeometry(0.0007, 0.0007, 0.04, 6);
  gold.push({
    geo: xform(pin, [0, -0.002, -0.0012], [0, 0, Math.PI / 2]),
    mat: 0,
  });
  const geo = assemble(gold, 2);
  geo.rotateX(-Math.PI / 2); // face up
  const g = new THREE.Group();
  const gilt = matFromMaps(
    wornMetalMaps({ ...GOLD, amount: 0.3, rough: 0.24, scratches: 50, seed }),
  );
  const sailMat = matFromMaps(
    wornMetalMaps({
      ...GOLD,
      base: [0.9, 0.75, 0.42],
      amount: 0.18,
      rough: 0.3,
      seed: seed ^ 5,
    }),
    { side: THREE.DoubleSide },
  );
  g.add(mesh(geo, [gilt, sailMat]));
  const garnet = mesh(
    new THREE.SphereGeometry(0.0032, 14, 10),
    new THREE.MeshPhysicalMaterial({
      color: 0x5a0a12,
      roughness: 0.08,
      clearcoat: 1,
      clearcoatRoughness: 0.06,
    }),
  );
  garnet.position.set(0.001, 0.0042, 0.0018);
  g.add(garnet);
  return settle(g);
}

/** Cracked-crystal sheet: mostly clear with bright fracture lines. */
function crystalTexture(seed: number): THREE.Texture {
  const [c, ctx] = makeCanvas(256, 256);
  ctx.fillStyle = "rgba(255,255,255,0.13)";
  ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = 1.4;
  const ix = 96 + (seed % 40);
  const iy = 120 + (seed % 23);
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + (seed % 7) * 0.4;
    ctx.beginPath();
    ctx.moveTo(ix, iy);
    let x = ix;
    let y = iy;
    for (let s = 0; s < 4; s++) {
      x += Math.cos(a + Math.sin(s * 3 + k) * 0.5) * 34;
      y += Math.sin(a + Math.cos(s * 2 + k) * 0.5) * 34;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  return texFromCanvas(c, true, false, false);
}

function buildPocketWatch(seed: number): THREE.Group {
  const g = new THREE.Group();
  // case: rounded silver drum, lying face up
  const caseGeo = lathe(
    [
      [0.001, 0.0008],
      [0.019, 0.0008],
      [0.027, 0.002],
      [0.0305, 0.005],
      [0.031, 0.008],
      [0.0305, 0.011],
      [0.0295, 0.0132],
      [0.0268, 0.0138],
      [0.0262, 0.0126],
    ],
    52,
    { vByHeight: true },
  );
  const silver = matFromMaps(
    wornMetalMaps({
      ...SILVER,
      amount: 0.85,
      rough: 0.42,
      scratches: 110,
      seed,
    }),
    { envMapIntensity: 0.7 },
  );
  const caseParts: Array<{ geo: THREE.BufferGeometry; mat: number }> = [
    { geo: caseGeo, mat: 0 },
  ];
  // crown and bow at XII (-z once the dial is laid flat)
  const crown = new THREE.CylinderGeometry(0.0042, 0.0042, 0.0062, 12);
  caseParts.push({
    geo: xform(crown, [0, 0.0072, -0.0335], [Math.PI / 2, 0, 0]),
    mat: 0,
  });
  const bow = new THREE.TorusGeometry(0.0052, 0.0012, 8, 20);
  caseParts.push({
    geo: xform(bow, [0, 0.0072, -0.0425], [0, Math.PI / 2, 0]),
    mat: 0,
  });
  g.add(mesh(assemble(caseParts, 1), silver));
  // dial
  const dial = new THREE.CircleGeometry(0.026, 48);
  dial.rotateX(-Math.PI / 2);
  const dialMesh = mesh(dial, matFromMaps(dialMaps(seed)), false);
  dialMesh.position.y = 0.0128;
  g.add(dialMesh);
  // domed, cracked crystal
  const dome = new THREE.SphereGeometry(0.062, 32, 10, 0, Math.PI * 2, 0, 0.47);
  dome.scale(0.47, 0.16, 0.47);
  const crystal = mesh(
    dome,
    new THREE.MeshPhysicalMaterial({
      map: crystalTexture(seed),
      transparent: true,
      roughness: 0.06,
      metalness: 0,
      clearcoat: 0.5,
      depthWrite: false,
    }),
    false,
  );
  crystal.position.y = 0.0035;
  crystal.renderOrder = 5;
  g.add(crystal);
  return settle(g);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const BUILDERS: Record<string, (seed: number) => THREE.Group> = {
  fossil_ammonite: buildAmmonite,
  fossil_trilobite: buildTrilobite,
  fossil_shark_tooth: buildSharkTooth,
  fossil_urchin: buildUrchin,
  fossil_fern: buildFernShale,
  fossil_amber: buildAmber,
  coin_real: (s) => buildRoundCoin("coin_real", s),
  coin_denarius: (s) => buildRoundCoin("coin_denarius", s),
  coin_doubloon: (s) => buildRoundCoin("coin_doubloon", s),
  coin_penny: (s) => buildRoundCoin("coin_penny", s),
  coin_sovereign: (s) => buildRoundCoin("coin_sovereign", s),
  coin_cash: buildCashCoin,
  bottle_castaway: (s) => buildBottle("bottle_castaway", s),
  bottle_wish: (s) => buildBottle("bottle_wish", s),
  bottle_capsule: (s) => buildBottle("bottle_capsule", s),
  bottle_apology: (s) => buildBottle("bottle_apology", s),
  bottle_forecast: (s) => buildBottle("bottle_forecast", s),
  bottle_coordinates: (s) => buildBottle("bottle_coordinates", s),
  jewel_ring: buildWeddingBand,
  jewel_signet: buildSignet,
  jewel_pearls: buildPearls,
  jewel_bracelet: buildBracelet,
  jewel_brooch: buildBrooch,
  jewel_watch: buildPocketWatch,
};

/**
 * The detailed model for a catalog variant, origin at its resting point on the
 * ground, +y up. The caller positions and disposes it (disposeCollectibleModel).
 */
export function buildCollectibleModel(id: string): THREE.Group {
  const builder = BUILDERS[id];
  const g = builder
    ? builder(seedFor(id))
    : settle(
        (() => {
          const f = new THREE.Group();
          f.add(
            mesh(
              new THREE.BoxGeometry(0.1, 0.06, 0.1),
              new THREE.MeshStandardMaterial({
                color: 0xd8b24a,
                roughness: 0.4,
              }),
            ),
          );
          return f;
        })(),
      );
  g.name = id;
  return g;
}

// Ghost resources are cached per variant: player.ts removes the ghost mesh
// from the scene after the grab but never disposes it, so the cache keeps
// repeated grabs from leaking. Freed via disposeCollectibleGhosts().
const ghostCache = new Map<
  string,
  { geo: THREE.BufferGeometry; mat: THREE.Material }
>();

/** One simple mesh for the grab animation (flies into the hand, then gone). */
export function buildCollectibleGhost(id: string): THREE.Mesh {
  let entry = ghostCache.get(id);
  if (!entry) {
    const kind = COLLECTIBLE_BY_ID[id]?.kind ?? "fossil";
    if (kind === "coin") {
      const gold = id === "coin_doubloon" || id === "coin_sovereign";
      entry = {
        geo: new THREE.CylinderGeometry(0.028, 0.028, 0.005, 22),
        mat: new THREE.MeshStandardMaterial({
          color: gold ? 0xd8a833 : id === "coin_cash" ? 0x6a7a5a : 0xb9bcc0,
          roughness: 0.35,
          metalness: 0.9,
        }),
      };
    } else if (kind === "bottle") {
      entry = {
        geo: new THREE.CylinderGeometry(0.02, 0.03, 0.16, 12),
        mat: new THREE.MeshStandardMaterial({
          color: 0x3a5c42,
          roughness: 0.15,
          transparent: true,
          opacity: 0.65,
        }),
      };
    } else if (kind === "jewellery") {
      entry = {
        geo: new THREE.TorusGeometry(0.018, 0.005, 10, 22),
        mat: new THREE.MeshStandardMaterial({
          color: 0xd8a833,
          roughness: 0.3,
          metalness: 0.9,
        }),
      };
    } else {
      entry = {
        geo: new THREE.IcosahedronGeometry(0.045, 1),
        mat: new THREE.MeshStandardMaterial({
          color: 0x8a7d6a,
          roughness: 0.85,
        }),
      };
    }
    ghostCache.set(id, entry);
  }
  const m = new THREE.Mesh(entry.geo, entry.mat);
  m.name = `${id}-ghost`;
  return m;
}

/** Frees the cached ghost resources (Collectibles.dispose()). */
export function disposeCollectibleGhosts(): void {
  for (const { geo, mat } of ghostCache.values()) {
    geo.dispose();
    mat.dispose();
  }
  ghostCache.clear();
}

/** Frees the geometries/materials/textures a build* call created. */
export function disposeCollectibleModel(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (!mat) return;
    for (const one of Array.isArray(mat) ? mat : [mat]) {
      for (const v of Object.values(one)) {
        if (v instanceof THREE.Texture) v.dispose();
      }
      one.dispose();
    }
  });
}
