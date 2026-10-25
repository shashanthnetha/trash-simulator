// Tipped-over 20 ft steel ISO shipping container high on East Beach – thrown
// ~35 m past the water line by a storm surge. It lies on its side (rolled just
// past 90°, settled into the sand), doors burst open toward the surf, cargo
// spilled and half sanded-in. Pure set dressing: nothing here is pickable.
//
// Construction: everything is merged into 4 draw calls –
//   1. hull        corrugated walls/roof/doors, frame, castings, lock rods
//   2. wood/carton crates (two broken open), splintered pallet, soggy cartons
//   3. shrink wrap plastic-wrapped bundles (one torn open)
//   4. sand drift  banked against the seaward face + mounds around the cargo
//
// The corrugation is modelled geometrically (trapezoid profile, phase-aligned
// with the painted valley rust via corrProfile()/corrPeriods()). Colliders are
// registered under the tag "container" (hull OBB, both burst doors, the large
// crates and the biggest bundle).

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  addBoxCollider,
  beginColliderSet,
  clearColliderSet,
} from "./colliders";
import {
  CONTAINER_DIMS as CD,
  CGR,
  CR,
  type Region,
  cargoPbr,
  containerHullPbr,
  corrPeriods,
  corrProfile,
  plankRow,
  wrapPbr,
} from "./landmark-container-textures";
import { fbm } from "./noise";
import type { Environment } from "./sky";
import { terrainHeight } from "./terrain";
import { TexRng, applyPbr, sandAlbedo, sandNormal } from "./textures";
import type { QualityId } from "./types";

// Placement (world): high on East Beach, diagonal to the shore.
const AX = 205;
const AZ = 2;
const YAW = 0.6;
/** How deep the hull has settled into the sand. */
const SINK = 0.15;
/** Roll past horizontal – the sky-facing wall leans a touch seaward. */
const LEAN = 0.08;
/** Door leaf swing angles (about the now-horizontal hinge axes). */
const DOOR_A_SWING = 1.62; // bottom-hinged leaf, fallen almost flat onto sand
const DOOR_B_SWING = -0.52; // top-hinged leaf, hanging ajar
const DOOR_PLANE_X = 2.96;
const HINGE_A_Z = -1.02;
const HINGE_B_Z = 1.02;

// Sand texture tiling of the terrain mesh (world.ts) – the drift matches it.
const SAND_TILE_X = 820 / 70;
const SAND_TILE_Z = 560 / 48;

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Remap a geometry's 0..1 UVs into an atlas region. */
function mapUv(geo: THREE.BufferGeometry, r: Region): THREE.BufferGeometry {
  const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(
      i,
      r[0] + uv.getX(i) * (r[2] - r[0]),
      r[1] + uv.getY(i) * (r[3] - r[1]),
    );
  }
  return geo;
}

/** Remap one box face (+x,-x,+y,-y,+z,-z = 0..5) from region `from` to `r`. */
function mapBoxFaceUv(
  geo: THREE.BoxGeometry,
  face: number,
  from: Region,
  r: Region,
): THREE.BoxGeometry {
  const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = face * 4; i < face * 4 + 4; i++) {
    const u = (uv.getX(i) - from[0]) / (from[2] - from[0]);
    const v = (uv.getY(i) - from[1]) / (from[3] - from[1]);
    uv.setXY(i, r[0] + u * (r[2] - r[0]), r[1] + v * (r[3] - r[1]));
  }
  return geo;
}
/** Solid-wrap sub-region the bundles are first mapped to (see wrapPbr). */
const CRWRAP: Region = [0, 0.03, 1, 0.68];

function box(
  w: number,
  h: number,
  d: number,
  r: Region,
  x = 0,
  y = 0,
  z = 0,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  mapUv(g, r);
  g.translate(x, y, z);
  return g;
}

function gaussBlob(
  x: number,
  y: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
): number {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return Math.exp(-(dx * dx + dy * dy));
}

interface SheetOpts {
  /** Flat crest margin (doors: the pressed frame around the panel). */
  margin?: number;
  /** Extra outward offset (negative = inward dent), same units as depth. */
  dent?: (x: number, y: number) => number;
}

/**
 * Corrugated sheet in the XY plane, x = along (length `len`), y = up
 * (height `h`), profile extruded towards +z (0 = valley plane, `depth` =
 * crest). Columns are duplicated at the profile knots so the trapezoid reads
 * with crisp creases. UVs span the given atlas region.
 */
function corrSheet(
  len: number,
  h: number,
  depth: number,
  rows: number,
  low: boolean,
  region: Region,
  opts: SheetOpts = {},
): THREE.BufferGeometry {
  const T = low ? [0, 0.5, 1] : [0, 0.18, 0.42, 0.58, 0.82, 1];
  const periods = corrPeriods(len);
  const pl = len / periods;
  const segs = T.length - 1;
  const margin = opts.margin ?? 0;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const profZ = (x: number, y: number, p01: number): number => {
    let z = p01;
    if (margin > 0) {
      const e = Math.min(x + len / 2, len / 2 - x, y + h / 2, h / 2 - y);
      const f = Math.min(1, Math.max(0, (e - margin) / 0.05));
      z = 1 - (1 - p01) * f;
    }
    let out = z * depth;
    if (opts.dent) out += opts.dent(x, y);
    return out;
  };
  const emitColumn = (x: number, p01: number): number => {
    const first = pos.length / 3;
    for (let r = 0; r <= rows; r++) {
      const y = -h / 2 + (r / rows) * h;
      pos.push(x, y, profZ(x, y, p01));
      const u = (x + len / 2) / len;
      const v = (y + h / 2) / h;
      uv.push(
        region[0] + u * (region[2] - region[0]),
        region[1] + v * (region[3] - region[1]),
      );
    }
    return first;
  };
  for (let p = 0; p < periods; p++) {
    for (let k = 0; k < segs; k++) {
      const xA = -len / 2 + (p + T[k]) * pl;
      const xB = -len / 2 + (p + T[k + 1]) * pl;
      const a = emitColumn(xA, corrProfile(p + T[k] + 1e-4));
      const b = emitColumn(xB, corrProfile(p + T[k + 1] - 1e-4));
      for (let r = 0; r < rows; r++) {
        idx.push(a + r, b + r, b + r + 1, a + r, b + r + 1, a + r + 1);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------------------
// Hull
// ---------------------------------------------------------------------------

interface HullDetail {
  low: boolean;
  rows: number;
  doorRows: number;
  radial: number;
}

function buildDoorLeaf(
  det: HullDetail,
  leafA: boolean,
): THREE.BufferGeometry[] {
  const list: THREE.BufferGeometry[] = [];
  const w = CD.doorW;
  const hz = leafA ? HINGE_A_Z : HINGE_B_Z;
  // z offset of the sheet start (sheet local x runs towards -Z)
  const z0 = leafA ? -0.02 : 1.0;
  const zc = leafA ? -0.51 : 0.51; // leaf centre
  const region = leafA ? CR.doorA : CR.doorB;
  const sheet = corrSheet(w, CD.doorH, 0.03, det.doorRows, det.low, region, {
    margin: 0.09,
  });
  sheet.rotateY(Math.PI / 2);
  sheet.translate(DOOR_PLANE_X, 0.045, z0);
  list.push(sheet);
  // Inner back panel (painted like the frame so an open leaf reads as a door)
  const back = new THREE.PlaneGeometry(w, CD.doorH);
  mapUv(back, CR.rail);
  back.rotateY(-Math.PI / 2);
  back.translate(DOOR_PLANE_X - 0.006, 0.045, zc);
  list.push(back);
  // Edge strips (door thickness)
  const et = 0.05;
  for (const ze of [zc - w / 2, zc + w / 2]) {
    list.push(
      box(et, CD.doorH, 0.028, CR.rail, DOOR_PLANE_X + 0.012, 0.045, ze),
    );
  }
  for (const ye of [0.045 - CD.doorH / 2, 0.045 + CD.doorH / 2]) {
    list.push(box(et, 0.028, w, CR.rail, DOOR_PLANE_X + 0.012, ye, zc));
  }
  // Lock rods with brackets and cam handles
  const rodZ = leafA ? [-0.28, -0.74] : [0.28, 0.74];
  for (let k = 0; k < rodZ.length; k++) {
    const rz = rodZ[k];
    const rod = new THREE.CylinderGeometry(0.019, 0.019, 2.22, det.radial);
    mapUv(rod, CR.rod);
    rod.translate(DOOR_PLANE_X + 0.055, 0.045, rz);
    list.push(rod);
    for (const by of [-0.82, 0.05, 0.86]) {
      list.push(box(0.05, 0.07, 0.06, CR.rail, DOOR_PLANE_X + 0.04, by, rz));
    }
    // Cam handle – on the fallen leaf they dangle at odd angles
    const handle = box(0.05, 0.34, 0.035, CR.rod, 0, -0.17, 0);
    handle.rotateX(leafA ? 2.2 + k * 0.5 : 0.6 + k * 0.3);
    handle.translate(DOOR_PLANE_X + 0.075, -0.42, rz);
    list.push(handle);
    const hub = new THREE.CylinderGeometry(0.03, 0.03, 0.05, det.radial);
    mapUv(hub, CR.rod);
    hub.rotateZ(Math.PI / 2);
    hub.rotateY(Math.PI / 2);
    hub.translate(DOOR_PLANE_X + 0.055, -0.42, rz);
    list.push(hub);
  }
  // Hinge blocks along the hinge edge
  for (const hy of [-0.78, 0.02, 0.82]) {
    list.push(box(0.07, 0.12, 0.1, CR.rail, DOOR_PLANE_X - 0.01, hy, hz));
  }
  // Bake the burst-open pose about the hinge line (now horizontal)
  const swing = leafA ? DOOR_A_SWING : DOOR_B_SWING;
  const sag = leafA ? 0.12 : -0.045;
  for (const g of list) {
    g.translate(-DOOR_PLANE_X, 0, -hz);
    g.rotateZ(sag);
    if (!leafA) g.rotateX(0.06); // buckled leaf, bowed outward
    g.rotateY(swing);
    g.translate(DOOR_PLANE_X, 0, hz);
  }
  return list;
}

function buildHull(det: HullDetail): THREE.BufferGeometry {
  const list: THREE.BufferGeometry[] = [];
  const L2 = CD.len / 2; // 3.03
  const H2 = CD.height / 2; // 1.295
  const W2 = CD.width / 2; // 1.22
  const wallY = 0.045;

  // Storm damage: broad ripples + a few hard hits (only with enough rows)
  const wallDent =
    det.rows > 1
      ? (x: number, y: number): number =>
          (fbm(x * 0.7 + 3.1, y * 0.9, 2) - 0.5) * 0.03 -
          gaussBlob(x, y, 1.7, 0.42, 0.5, 0.4) * 0.06 -
          gaussBlob(x, y, -0.85, -0.55, 0.85, 0.5) * 0.08
      : undefined;
  const roofDent =
    det.rows > 1
      ? (x: number, y: number): number =>
          (fbm(x * 0.6 + 9.7, y * 0.8, 2) - 0.5) * 0.03 -
          gaussBlob(x, y, 0.9, -0.2, 1.1, 0.6) * 0.11
      : undefined;

  // Corrugated long walls (crest flush at |z| = 1.215)
  const wallA = corrSheet(
    CD.wallLen,
    CD.wallH,
    CD.corrDepth,
    det.rows,
    det.low,
    CR.wall,
    { dent: wallDent },
  );
  wallA.translate(0, wallY, W2 - 0.005 - CD.corrDepth);
  list.push(wallA);
  const wallB = corrSheet(
    CD.wallLen,
    CD.wallH,
    CD.corrDepth,
    det.rows,
    det.low,
    CR.wall,
    { dent: wallDent },
  );
  wallB.rotateY(Math.PI);
  wallB.translate(0, wallY, -(W2 - 0.005 - CD.corrDepth));
  list.push(wallB);

  // Roof (crest flush at y = 1.295)
  const roof = corrSheet(
    CD.wallLen,
    2.24,
    CD.corrDepth,
    det.rows,
    det.low,
    CR.roof,
    { dent: roofDent },
  );
  roof.rotateX(-Math.PI / 2);
  roof.translate(0, H2 - CD.corrDepth, 0);
  list.push(roof);

  // Blank end wall at -X
  const end = corrSheet(
    CD.endW,
    CD.wallH,
    CD.corrDepth,
    det.rows,
    det.low,
    CR.end,
  );
  end.rotateY(-Math.PI / 2);
  end.translate(-(L2 - 0.04 - CD.corrDepth), wallY, 0);
  list.push(end);

  // Frame: corner posts, rails, door header/sill
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      list.push(
        box(0.2, CD.height, 0.2, CR.rail, sx * (L2 - 0.1), 0, sz * (W2 - 0.1)),
      );
    }
    // top + bottom side rails
    list.push(box(5.7, 0.14, 0.14, CR.rail, 0, H2 - 0.07, sx * (W2 - 0.07)));
    list.push(
      box(5.7, 0.26, 0.15, CR.rail, 0, -(H2 - 0.13), sx * (W2 - 0.075)),
    );
    // end rails top/bottom
    list.push(box(0.14, 0.14, 2.26, CR.rail, sx * (L2 - 0.07), H2 - 0.07, 0));
  }
  list.push(box(0.14, 0.26, 2.26, CR.rail, -(L2 - 0.07), -(H2 - 0.13), 0));
  // Door header + sill
  list.push(box(0.16, 0.16, 2.26, CR.rail, DOOR_PLANE_X, H2 - 0.14, 0));
  list.push(box(0.16, 0.22, 2.26, CR.rail, DOOR_PLANE_X, -(H2 - 0.16), 0));

  // 8 corner castings with the oval holes (protrude slightly)
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        list.push(
          box(0.29, 0.25, 0.25, CR.casting, sx * 2.905, sy * 1.19, sz * 1.11),
        );
      }
    }
  }

  // Underside: floor slab, cross members, fork pockets
  list.push(box(5.98, 0.05, 2.42, CR.floor, 0, -1.185, 0));
  for (let k = -3; k <= 3; k++) {
    list.push(box(0.06, 0.12, 2.4, CR.floor, k * 0.84, -1.23, 0));
  }
  for (const sx of [-1, 1]) {
    list.push(box(0.36, 0.15, 2.47, CR.dark, sx * 1.03, -1.2, 0));
  }

  // Interior shell (visible through the burst doors)
  const intFloor = new THREE.PlaneGeometry(5.75, 2.26);
  mapUv(intFloor, CR.interiorFloor);
  intFloor.rotateX(-Math.PI / 2);
  intFloor.translate(0, -1.15, 0);
  list.push(intFloor);
  const intCeil = new THREE.PlaneGeometry(5.75, 2.26);
  mapUv(intCeil, CR.interiorWall);
  intCeil.rotateX(Math.PI / 2);
  intCeil.translate(0, 1.24, 0);
  list.push(intCeil);
  for (const sz of [-1, 1]) {
    const iw = new THREE.PlaneGeometry(5.75, 2.32);
    mapUv(iw, CR.interiorWall);
    if (sz > 0) iw.rotateY(Math.PI);
    iw.translate(0, 0.05, sz * 1.16);
    list.push(iw);
  }
  const intEnd = new THREE.PlaneGeometry(2.3, 2.32);
  mapUv(intEnd, CR.interiorWall);
  intEnd.rotateY(Math.PI / 2);
  intEnd.translate(-2.92, 0.05, 0);
  list.push(intEnd);

  // Burst doors
  list.push(...buildDoorLeaf(det, true));
  list.push(...buildDoorLeaf(det, false));

  const merged = mergeGeometries(list, false);
  for (const g of list) g.dispose();
  if (!merged) throw new Error("ShippingContainer: hull merge failed");
  merged.computeBoundingSphere();
  return merged;
}

// ---------------------------------------------------------------------------
// Cargo
// ---------------------------------------------------------------------------

type GeoList = THREE.BufferGeometry[];

/** Apply yaw + settle tilt + position to a locally built item. */
function placeItem(
  list: GeoList,
  parts: GeoList,
  x: number,
  z: number,
  yaw: number,
  sink: number,
  tiltX = 0,
  tiltZ = 0,
): void {
  const y = terrainHeight(x, z) - sink;
  for (const g of parts) {
    if (tiltX) g.rotateX(tiltX);
    if (tiltZ) g.rotateZ(tiltZ);
    g.rotateY(yaw);
    g.translate(x, y, z);
    list.push(g);
  }
}

/** Slatted wooden crate, base at y = 0. `broken` opens one side + the lid. */
function crateParts(
  rng: TexRng,
  w: number,
  h: number,
  d: number,
  broken: boolean,
): GeoList {
  const parts: GeoList = [];
  const post = 0.05;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(
        box(
          post,
          h,
          post,
          plankRow(rng.int(8)),
          sx * (w / 2 - post / 2),
          h / 2,
          sz * (d / 2 - post / 2),
        ),
      );
    }
  }
  const slatY = [0.18, 0.5, 0.82];
  for (const sz of [-1, 1]) {
    for (let k = 0; k < slatY.length; k++) {
      // The broken crate is missing two slats on its +z side
      if (broken && sz > 0 && k > 0) continue;
      parts.push(
        box(
          w,
          h * 0.24,
          0.028,
          plankRow(rng.int(8)),
          0,
          slatY[k] * h,
          sz * (d / 2 - 0.014),
        ),
      );
    }
  }
  for (const sx of [-1, 1]) {
    for (const y of slatY) {
      parts.push(
        box(
          0.028,
          h * 0.24,
          d - 0.1,
          plankRow(rng.int(8)),
          sx * (w / 2 - 0.014),
          y * h,
          0,
        ),
      );
    }
  }
  parts.push(box(w - 0.06, 0.03, d - 0.06, plankRow(rng.int(8)), 0, 0.05, 0));
  if (broken) {
    // One ripped slat hangs, the lid leans against the side
    const hang = box(
      w * 0.55,
      h * 0.24,
      0.028,
      plankRow(rng.int(8)),
      w * 0.05,
      -h * 0.12,
      0,
    );
    hang.rotateZ(-0.5);
    hang.translate(w * 0.18, h * 0.42, d / 2 + 0.05);
    parts.push(hang);
    const lid = box(w + 0.05, 0.035, d + 0.05, CGR.lid, 0, 0, 0);
    lid.rotateX(1.25);
    lid.translate(0, (d + 0.1) / 2, d / 2 + 0.32);
    parts.push(lid);
  } else {
    parts.push(box(w + 0.05, 0.035, d + 0.05, CGR.lid, 0, h + 0.017, 0));
  }
  return parts;
}

/** Splintered euro-ish pallet, top face at y ≈ 0.13. */
function palletParts(rng: TexRng): GeoList {
  const parts: GeoList = [];
  for (const zx of [-0.44, 0, 0.44]) {
    parts.push(box(1.18, 0.09, 0.09, CGR.pallet, 0, 0.085, zx));
    parts.push(box(1.18, 0.02, 0.095, CGR.pallet, 0, 0.03, zx));
  }
  const topZ = [-0.46, -0.23, 0, 0.23, 0.46];
  for (let k = 0; k < topZ.length; k++) {
    if (k === 1) {
      // Snapped slat: two halves kicked up
      const a = box(0.52, 0.02, 0.1, CGR.pallet, -0.26, 0, 0);
      a.rotateZ(0.42);
      a.translate(-0.28, 0.2, topZ[k]);
      parts.push(a);
      const b = box(0.5, 0.02, 0.1, CGR.pallet, 0.25, 0, 0);
      b.rotateZ(-0.28);
      b.translate(0.3, 0.17, topZ[k]);
      parts.push(b);
      continue;
    }
    parts.push(box(1.2, 0.02, 0.1, plankRow(rng.int(8)), 0, 0.14, topZ[k]));
  }
  return parts;
}

/** Water-swollen carton, base at y = 0. */
function cartonParts(rng: TexRng, w: number, h: number, d: number): GeoList {
  const region = rng.chance(0.5) ? CGR.carton : CGR.cartonWet;
  const g = new THREE.BoxGeometry(w, h, d) as THREE.BoxGeometry;
  mapUv(g, region);
  g.translate(0, h / 2, 0);
  return [g];
}

/** Shrink-wrapped bundle, base at y = 0. `torn` exposes the carton stack. */
function bundleParts(
  rng: TexRng,
  w: number,
  h: number,
  d: number,
  torn: boolean,
  wrap: GeoList,
  wood: GeoList,
): void {
  if (!torn) {
    const g = new THREE.BoxGeometry(w, h, d) as THREE.BoxGeometry;
    mapUv(g, CRWRAP);
    // Top face: plain film
    mapBoxFaceUv(g, 2, CRWRAP, [0.2, 0.36, 0.8, 0.6]);
    g.translate(0, h / 2, 0);
    wrap.push(g);
    return;
  }
  // Torn: wrap covers ~70 % height, fringe flutters at its top edge,
  // the top face is discarded via the transparent zone of the texture.
  const wh = h * 0.72;
  const tornR: Region = [0, 0.03, 1, 0.96];
  const g = new THREE.BoxGeometry(w, wh, d) as THREE.BoxGeometry;
  mapUv(g, tornR);
  mapBoxFaceUv(g, 2, tornR, [0.4, 0.985, 0.6, 0.995]);
  g.translate(0, wh / 2, 0);
  wrap.push(g);
  // Cartons sticking out of the top + one tumbled beside
  const c1 = cartonParts(rng, w * 0.55, h * 0.4, d * 0.6)[0];
  c1.translate(-w * 0.12, wh - 0.06, 0.05);
  wood.push(c1);
  const c2 = cartonParts(rng, w * 0.4, h * 0.36, d * 0.5)[0];
  c2.rotateY(0.7);
  c2.rotateZ(0.18);
  c2.translate(w * 0.22, wh - 0.1, -d * 0.14);
  wood.push(c2);
}

// ---------------------------------------------------------------------------
// Sand drift
// ---------------------------------------------------------------------------

interface Mound {
  x: number;
  z: number;
  r: number;
  h: number;
}

function sandUv(uv: number[], x: number, z: number): void {
  uv.push((x + 410) / SAND_TILE_X, (420 - z) / SAND_TILE_Z);
}

/**
 * Drift banked against the seaward face plus small mounds that swallow the
 * bases of the spilled cargo. World coordinates; edges feather onto the
 * terrain (heights sampled per vertex).
 */
function buildDrift(
  pz: number[],
  seaward: number[],
  mounds: Mound[],
): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const COLS = 26;
  const ROWS = 10;
  const S0 = -4.6;
  const S1 = 3.6;
  const T0 = 0.85;
  const T1 = 4.0;
  for (let j = 0; j <= ROWS; j++) {
    const t = T0 + (j / ROWS) * (T1 - T0);
    for (let i = 0; i <= COLS; i++) {
      const s = S0 + (i / COLS) * (S1 - S0);
      const x = AX + pz[0] * s + seaward[0] * t;
      const z = AZ + pz[1] * s + seaward[1] * t;
      const cap = s > 0 ? S1 : -S0;
      const endW = 1 - smooth01((Math.abs(s) - (cap - 1.6)) / 1.55);
      const amp = 0.78 * endW * (0.7 + 0.3 * fbm(s * 0.55 + 2, t * 0.7, 2));
      const shape = t < 1.32 ? 1 : Math.exp(-(((t - 1.32) / 0.9) ** 2));
      const edge = 1 - smooth01((t - T1 + 0.4) / 0.4);
      const h = amp * shape * edge;
      pos.push(x, terrainHeight(x, z) + h - 0.015, z);
      sandUv(uv, x, z);
    }
  }
  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      const a = j * (COLS + 1) + i;
      const b = a + COLS + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  // Mounds around the cargo (2 rings + centre)
  for (const m of mounds) {
    const base = pos.length / 3;
    pos.push(m.x, terrainHeight(m.x, m.z) + m.h, m.z);
    sandUv(uv, m.x, m.z);
    const SEG = 10;
    for (const [rr, hh] of [
      [0.55, 0.5],
      [1, -0.02],
    ]) {
      for (let k = 0; k < SEG; k++) {
        const a = (k / SEG) * Math.PI * 2;
        const px =
          m.x + Math.cos(a) * m.r * rr * (0.85 + 0.3 * fbm(k * 1.7, m.x, 1));
        const pzz = m.z + Math.sin(a) * m.r * rr;
        pos.push(px, terrainHeight(px, pzz) + m.h * hh, pzz);
        sandUv(uv, px, pzz);
      }
    }
    for (let k = 0; k < SEG; k++) {
      const k1 = (k + 1) % SEG;
      idx.push(base, base + 1 + k1, base + 1 + k);
      idx.push(base + 1 + k, base + 1 + SEG + k1, base + 1 + SEG + k);
      idx.push(base + 1 + k, base + 1 + k1, base + 1 + SEG + k1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

function smooth01(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

// ---------------------------------------------------------------------------
// The landmark
// ---------------------------------------------------------------------------

export class ShippingContainer {
  private readonly parent: THREE.Group;
  private readonly group = new THREE.Group();
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  /** Drift shader uniforms – kept in step with the terrain's wet/cloud look. */
  private readonly sandUniforms = {
    uWet: { value: 0 },
    uCloud: { value: 0 },
  };

  constructor(parent: THREE.Group, quality: QualityId) {
    this.parent = parent;
    this.group.name = "landmark-container";
    parent.add(this.group);

    const hi = quality === "ultra" || quality === "high";
    const det: HullDetail = {
      low: !hi,
      rows: quality === "ultra" ? 4 : quality === "high" ? 3 : 1,
      doorRows: hi ? 6 : 2,
      radial: hi ? 10 : 7,
    };
    const atlas = hi ? 1024 : 512;

    // --- Settle the hull on the sampled terrain ------------------------------
    // Local axes in the world: a = hull +X, p = hull +Z before the roll.
    const a = [Math.cos(YAW), -Math.sin(YAW)];
    const p = [Math.sin(YAW), Math.cos(YAW)];
    const cornerH = (sa: number, sp: number): number =>
      terrainHeight(
        AX + a[0] * 3 * sa + p[0] * 1.29 * sp,
        AZ + a[1] * 3 * sa + p[1] * 1.29 * sp,
      );
    const hFF = cornerH(1, 1);
    const hFB = cornerH(1, -1);
    const hBF = cornerH(-1, 1);
    const hBB = cornerH(-1, -1);
    const hC = (hFF + hFB + hBF + hBB) / 4;
    const tiltZ = Math.atan(((hFF + hFB) / 2 - (hBF + hBB) / 2) / 6);
    const rollAdj =
      -Math.atan(((hFF + hBF) / 2 - (hFB + hBB) / 2) / 2.58) * 0.5;
    const roll = -(Math.PI / 2 + LEAN) + rollAdj;
    const centerY = hC + 1.22 - SINK;

    const q = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(0, 1, 0), YAW)
      .multiply(
        new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 0, 1),
          tiltZ,
        ),
      )
      .multiply(
        new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(1, 0, 0),
          roll,
        ),
      );
    const meshPos = new THREE.Vector3(AX, centerY, AZ);
    const toWorld = (lx: number, ly: number, lz: number): THREE.Vector3 =>
      new THREE.Vector3(lx, ly, lz).applyQuaternion(q).add(meshPos);

    // --- Hull ---------------------------------------------------------------
    const hullMat = new THREE.MeshStandardMaterial();
    applyPbr(hullMat, containerHullPbr(atlas));
    this.materials.push(hullMat);
    const hullGeo = buildHull(det);
    this.geometries.push(hullGeo);
    const hull = new THREE.Mesh(hullGeo, hullMat);
    hull.position.copy(meshPos);
    hull.quaternion.copy(q);
    hull.castShadow = true;
    hull.receiveShadow = true;
    this.group.add(hull);

    // --- Spilled cargo (world coordinates, out of the door end) -------------
    const rng = new TexRng(0x51ab);
    const out = a; // door end direction
    const side = p;
    const at = (o: number, s: number): [number, number] => [
      AX + out[0] * (3.1 + o) + side[0] * s,
      AZ + out[1] * (3.1 + o) + side[1] * s,
    ];
    const wood: GeoList = [];
    const wrap: GeoList = [];
    const mounds: Mound[] = [];

    // Large crates (first one keeps a collider, second burst open)
    const [c1x, c1z] = at(1.6, 0.95);
    placeItem(
      wood,
      crateParts(rng, 0.95, 0.75, 0.75, false),
      c1x,
      c1z,
      YAW + 0.32,
      0.1,
      0.02,
      -0.04,
    );
    mounds.push({ x: c1x, z: c1z, r: 0.95, h: 0.14 });
    const [c2x, c2z] = at(3.4, -0.7);
    placeItem(
      wood,
      crateParts(rng, 0.85, 0.7, 0.7, true),
      c2x,
      c2z,
      YAW + 1.7,
      0.08,
      -0.03,
      0.05,
    );
    mounds.push({ x: c2x, z: c2z, r: 0.85, h: 0.12 });
    const [c3x, c3z] = at(4.9, 1.5);
    placeItem(
      wood,
      crateParts(rng, 0.6, 0.55, 0.55, false),
      c3x,
      c3z,
      YAW + 3.4,
      0.05,
      0,
      0.34,
    );
    mounds.push({ x: c3x, z: c3z, r: 0.6, h: 0.08 });

    // Splintered pallet
    const [plx, plz] = at(2.6, 2.1);
    placeItem(wood, palletParts(rng), plx, plz, YAW + 1.1, 0.09, 0.05, 0.03);
    mounds.push({ x: plx, z: plz, r: 0.85, h: 0.1 });

    // Shrink-wrapped bundles (one torn open)
    const bundle = (
      o: number,
      s: number,
      yw: number,
      w: number,
      h: number,
      d: number,
      torn: boolean,
      sink: number,
      tx = 0,
      tz = 0,
    ): [number, number] => {
      const wr: GeoList = [];
      const wo: GeoList = [];
      bundleParts(rng, w, h, d, torn, wr, wo);
      const [bx, bz] = at(o, s);
      placeItem(wrap, wr, bx, bz, yw, sink, tx, tz);
      placeItem(wood, wo, bx, bz, yw, sink, tx, tz);
      mounds.push({ x: bx, z: bz, r: Math.max(w, d) * 0.9, h: 0.1 });
      return [bx, bz];
    };
    const [b1x, b1z] = bundle(
      2.1,
      -1.9,
      YAW - 0.5,
      0.92,
      0.82,
      0.86,
      false,
      0.1,
      0.03,
      0.05,
    );
    bundle(5.4, -0.6, YAW + 2.2, 0.7, 0.6, 0.68, false, 0.06, -0.06, 0.1);
    bundle(4.1, 0.35, YAW + 5.0, 0.8, 0.72, 0.76, true, 0.07);

    // Tumbled swollen cartons – a couple still in the door mouth
    const cartonSpots: Array<[number, number, number, number]> = [
      [-0.5, 0.25, 0.5, 0.06],
      [-0.1, -0.35, 2.4, 0.05],
      [1.1, -0.9, 1.2, 0.1],
      [2.9, 1.2, 3.7, 0.12],
      [4.4, -1.6, 5.3, 0.09],
      [6.2, 0.8, 0.9, 0.14],
      [7.1, -0.3, 4.6, 0.1],
    ];
    for (const [o, s, yw, sink] of cartonSpots) {
      const w = rng.range(0.38, 0.52);
      const h = rng.range(0.26, 0.36);
      const [cx, cz] = at(o, s);
      placeItem(
        wood,
        cartonParts(rng, w, h, w * rng.range(0.7, 0.95)),
        cx,
        cz,
        yw,
        sink,
        rng.range(-0.12, 0.12),
        rng.range(-0.12, 0.12),
      );
      if (o > 0.5) mounds.push({ x: cx, z: cz, r: w * 1.3, h: 0.07 });
    }

    const woodMat = new THREE.MeshStandardMaterial();
    applyPbr(woodMat, cargoPbr(atlas));
    this.materials.push(woodMat);
    const woodGeo = mergeGeometries(wood, false);
    for (const g of wood) g.dispose();
    if (!woodGeo) throw new Error("ShippingContainer: cargo merge failed");
    woodGeo.computeBoundingSphere();
    this.geometries.push(woodGeo);
    const woodMesh = new THREE.Mesh(woodGeo, woodMat);
    woodMesh.castShadow = true;
    woodMesh.receiveShadow = true;
    this.group.add(woodMesh);

    const wrapMat = new THREE.MeshStandardMaterial();
    applyPbr(wrapMat, wrapPbr());
    this.materials.push(wrapMat);
    const wrapGeo = mergeGeometries(wrap, false);
    for (const g of wrap) g.dispose();
    if (!wrapGeo) throw new Error("ShippingContainer: wrap merge failed");
    wrapGeo.computeBoundingSphere();
    this.geometries.push(wrapGeo);
    const wrapMesh = new THREE.Mesh(wrapGeo, wrapMat);
    wrapMesh.castShadow = true;
    wrapMesh.receiveShadow = true;
    this.group.add(wrapMesh);

    // --- Sand drift against the seaward face (the former roof) --------------
    // A lump under the outer edge of the fallen door leaf props it up a touch
    const leafEdge = toWorld(
      DOOR_PLANE_X + Math.sin(DOOR_A_SWING) * 0.95,
      0.045,
      HINGE_A_Z + Math.cos(DOOR_A_SWING) * 0.95,
    );
    mounds.push({ x: leafEdge.x, z: leafEdge.z, r: 0.7, h: 0.16 });
    const seaward = [-p[0], -p[1]];
    const driftGeo = buildDrift([a[0], a[1]], seaward, mounds);
    this.geometries.push(driftGeo);
    const sandMat = new THREE.MeshStandardMaterial({
      map: sandAlbedo(),
      normalMap: sandNormal(),
      normalScale: new THREE.Vector2(0.7, 0.7),
      roughness: 0.95,
      metalness: 0,
    });
    // Match the terrain's rain-wet darkening and grey-out under a closed
    // cloud deck (world.ts), otherwise the drift pops light in bad weather.
    sandMat.customProgramCacheKey = () => "container-drift";
    sandMat.onBeforeCompile = (shader) => {
      shader.uniforms.uWet = this.sandUniforms.uWet;
      shader.uniforms.uCloud = this.sandUniforms.uCloud;
      shader.vertexShader =
        `varying vec3 vWorldPos;\n${shader.vertexShader}`.replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\n vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;",
        );
      shader.fragmentShader = `varying vec3 vWorldPos;
        uniform float uWet;
        uniform float uCloud;
        float cwHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float cwNoise(vec2 p) {
          vec2 i = floor(p); vec2 f = p - i;
          f = f * f * (3.0 - 2.0 * f);
          float a = cwHash(i), b = cwHash(i + vec2(1.0, 0.0));
          float c = cwHash(i + vec2(0.0, 1.0)), d = cwHash(i + vec2(1.0, 1.0));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }
        ${shader.fragmentShader}`.replace(
        "#include <map_fragment>",
        `#include <map_fragment>
         float pud = cwNoise(vWorldPos.xz * 0.085) * 0.65
                   + cwNoise(vWorldPos.xz * 0.31) * 0.35;
         float rainWet = uWet * (0.5 + 0.5 * smoothstep(0.32, 0.68, pud)) * 0.85;
         diffuseColor.rgb *= mix(1.0, 0.6, rainWet);
         float cGrey = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
         diffuseColor.rgb = mix(
           diffuseColor.rgb,
           vec3(cGrey) * vec3(0.97, 0.99, 1.05),
           uCloud * 0.42);`,
      );
    };
    this.materials.push(sandMat);
    const drift = new THREE.Mesh(driftGeo, sandMat);
    drift.receiveShadow = true;
    this.group.add(drift);

    // --- Colliders (world coordinates, tag "container") ---------------------
    beginColliderSet("container");
    addBoxCollider(AX, AZ, 3.16, 1.47, YAW, hC - 0.8, hC + 2.35);
    // Low box over the deep part of the sand drift (the ground system cannot
    // lift the player onto the bank, so keep them out of its knee-deep core)
    addBoxCollider(
      AX + seaward[0] * 1.9,
      AZ + seaward[1] * 1.9,
      2.9,
      0.6,
      YAW,
      hC - 0.5,
      hC + 0.55,
    );
    // Fallen leaf A (flat on the sand past the door end)
    const swingA = [Math.sin(DOOR_A_SWING), Math.cos(DOOR_A_SWING)];
    const cA = toWorld(
      DOOR_PLANE_X + swingA[0] * 0.49,
      0.045,
      HINGE_A_Z + swingA[1] * 0.49,
    );
    const hingeDir = toWorld(0, 1, 0).sub(toWorld(0, 0, 0));
    const yawDoor = Math.atan2(-hingeDir.z, hingeDir.x);
    const gA = terrainHeight(cA.x, cA.z);
    addBoxCollider(cA.x, cA.z, 1.12, 0.55, yawDoor, gA, gA + 0.35);
    // Hanging leaf B (blocks at chest/head height)
    const swingB = [Math.sin(-DOOR_B_SWING), -Math.cos(-DOOR_B_SWING)];
    const e0 = toWorld(DOOR_PLANE_X, 0, HINGE_B_Z);
    const e1 = toWorld(
      DOOR_PLANE_X + swingB[0] * 0.98,
      0,
      HINGE_B_Z + swingB[1] * 0.98,
    );
    const cB = e0.clone().add(e1).multiplyScalar(0.5);
    addBoxCollider(
      cB.x,
      cB.z,
      1.12,
      Math.max(0.28, Math.hypot(e1.x - e0.x, e1.z - e0.z) / 2 + 0.08),
      yawDoor,
      Math.min(e0.y, e1.y) - 0.2,
      Math.max(e0.y, e1.y) + 0.2,
    );
    // Large crates + the big bundle
    const g1 = terrainHeight(c1x, c1z);
    addBoxCollider(c1x, c1z, 0.52, 0.42, YAW + 0.32, g1, g1 + 0.85);
    const g2 = terrainHeight(c2x, c2z);
    addBoxCollider(c2x, c2z, 0.48, 0.4, YAW + 1.7, g2, g2 + 0.78);
    const gB = terrainHeight(b1x, b1z);
    addBoxCollider(b1x, b1z, 0.5, 0.47, YAW - 0.5, gB, gB + 0.85);
  }

  update(dt: number, env: Environment, _camPos: THREE.Vector3): void {
    // Static set dressing – only the drift's wet/cloud response follows the
    // weather (soaks quickly, dries slowly, like the terrain).
    const w = this.sandUniforms.uWet.value;
    const rate = env.rain > w ? 0.6 : 0.05;
    this.sandUniforms.uWet.value = w + (env.rain - w) * Math.min(1, dt * rate);
    this.sandUniforms.uCloud.value = env.cloud;
  }

  dispose(): void {
    this.parent.remove(this.group);
    for (const g of this.geometries) g.dispose();
    // Textures stay in the shared cache (textures-core); only materials go.
    for (const m of this.materials) m.dispose();
    clearColliderSet("container");
  }
}
