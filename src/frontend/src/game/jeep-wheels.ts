// Trash Simulator – wheels of the jeep: off-road tire as a lathe (pbrTire: u
// around the circumference, v across sidewall–tread–sidewall), drop-center
// steel rim as a lathe with a planar pbrRim projection. The geometries are
// shared by all five wheels; +x is the outer side (right-hand wheel).

import * as THREE from "three";
import { JD } from "./jeep-build";

export interface WheelGeometry {
  tire: THREE.BufferGeometry;
  rim: THREE.BufferGeometry;
}

/** Sidewall points per profile half (the tread lies in between). */
const SIDE_N = 6;

/** Tire profile: 6 sidewall points, 19 tread, 6 sidewall (v 0.2–0.8 = tread). */
function tireProfile(): THREE.Vector2[] {
  const R = JD.wheelR;
  const hw = JD.wheelW / 2;
  const pts: THREE.Vector2[] = [];
  // Sidewall (fractions of radius/half width): bead → belly → shoulder
  const sideA: [number, number][] = [
    [0.535, -0.81],
    [0.583, -0.93],
    [0.714, -1.01],
    [0.833, -1.03],
    [0.917, -0.955],
    [0.964, -0.84],
  ];
  for (const [r, y] of sideA) pts.push(new THREE.Vector2(r * R, y * hw));
  const tw = hw * 0.7;
  for (let k = 0; k <= 18; k++) {
    const y = -tw + (2 * tw * k) / 18;
    const t = y / tw;
    pts.push(new THREE.Vector2(R - 0.005 * t * t, y));
  }
  for (let i = sideA.length - 1; i >= 0; i--)
    pts.push(new THREE.Vector2(sideA[i][0] * R, -sideA[i][1] * hw));
  return pts;
}

/** Rim profile (r, axial): inner disc → drop center → flange → spoke face → hub. */
function rimProfile(): THREE.Vector2[] {
  const R = JD.rimR;
  const raw: [number, number][] = [
    [0, -0.035],
    [0.05, -0.035],
    [0.19, -0.035],
    [0.19, -0.09],
    [R, -0.09],
    [R, 0.066],
    [R - 0.01, 0.066],
    [R - 0.03, 0.058],
    [R - 0.05, 0.048],
    [0.075, 0.048],
    [0.052, 0.062],
    [0.045, 0.035],
    [0, 0.035],
  ];
  return raw.map(([r, y]) => new THREE.Vector2(r, y));
}

export function buildWheelGeometry(): WheelGeometry {
  const prof = tireProfile();
  const tire = new THREE.LatheGeometry(prof, 40);
  // Map v exactly onto the pbrTire layout: sidewall 0–0.2, tread 0.2–0.8,
  // sidewall 0.8–1. The lathe's arc-length based UVs would otherwise push the
  // lugs onto the sidewall and the tread pattern would become invisible.
  const N = prof.length;
  // SHOULDER points of the sidewall count as tread: as on an M/T tire the lugs
  // run over the shoulder and stay visible from the side.
  const SHOULDER = 2;
  const a = SIDE_N - 1 - SHOULDER;
  const b = N - SIDE_N + SHOULDER;
  const vmap = new Float32Array(N);
  for (let j = 0; j < N; j++) {
    if (j <= a) vmap[j] = (j / a) * 0.2;
    else if (j < b) vmap[j] = 0.2 + ((j - a) / (b - a)) * 0.6;
    else vmap[j] = 0.8 + ((j - b) / (N - 1 - b)) * 0.2;
  }
  const tuv = tire.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < tuv.count; i++) tuv.setY(i, vmap[i % N]);
  tuv.needsUpdate = true;
  tire.rotateZ(-Math.PI / 2); // lathe +y → +x (outer side)

  const rim = new THREE.LatheGeometry(rimProfile(), 32);
  // planar rim UV: radius 0.5 = rim edge (both sides)
  const pos = rim.getAttribute("position") as THREE.BufferAttribute;
  const uv = rim.getAttribute("uv") as THREE.BufferAttribute;
  const k = 1 / (2 * JD.rimR);
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, 0.5 + pos.getX(i) * k, 0.5 + pos.getZ(i) * k);
  }
  uv.needsUpdate = true;
  rim.rotateZ(-Math.PI / 2);
  return { tire, rim };
}

export interface WheelRig {
  /** Suspension: position (track/axle), steering (y), travel (position.y). */
  holder: THREE.Group;
  /** Rotates about the wheel axis (x). */
  spin: THREE.Group;
  x: number;
  z: number;
  front: boolean;
}

/** A complete wheel (tire + rim) at position (x, z). */
export function makeWheel(
  geo: WheelGeometry,
  tireMat: THREE.Material,
  rimMat: THREE.Material,
  x: number,
  z: number,
): WheelRig {
  const holder = new THREE.Group();
  holder.position.set(x, 0, z);
  const spin = new THREE.Group();
  if (x < 0) spin.rotation.y = Math.PI;
  const tire = new THREE.Mesh(geo.tire, tireMat);
  tire.castShadow = true;
  tire.receiveShadow = true;
  const rim = new THREE.Mesh(geo.rim, rimMat);
  // The rim sits inside the tire (rimR 0.235 < wheelR 0.46, axially inside the
  // sidewalls) and its shadow lands under the vehicle, inside the body's own.
  // Skipping it in the shadow pass saves one draw call per wheel.
  rim.castShadow = false;
  rim.receiveShadow = true;
  spin.add(tire, rim);
  holder.add(spin);
  return { holder, spin, x, z, front: z < 0 };
}

/** Spare wheel (axis along z, outer side facing rearwards). */
export function makeSpare(
  geo: WheelGeometry,
  tireMat: THREE.Material,
  rimMat: THREE.Material,
  x: number,
  y: number,
  z: number,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = -Math.PI / 2; // +x → +z
  const tire = new THREE.Mesh(geo.tire, tireMat);
  const rim = new THREE.Mesh(geo.rim, rimMat);
  for (const m of [tire, rim]) m.receiveShadow = true;
  tire.castShadow = true;
  // As above: the rim is enclosed by the tire, so it needs no shadow pass.
  rim.castShadow = false;
  g.add(tire, rim);
  return g;
}
