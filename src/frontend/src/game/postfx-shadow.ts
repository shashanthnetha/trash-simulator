// Fit the sun's shadow box tightly around the camera. The sun (sky.ts) sits
// 420 m along the light direction above the camera and points at it, so the
// ortho box of the shadow camera lies in the light plane around the camera
// position. Here it is, every frame,
//   - set to ±half per quality tier (a small box = fine texels),
//   - shifted along the view direction (more range in front of the camera than
//     behind it),
//   - snapped to the texel grid of the shadow map, so that the shadow edges do
//     not shimmer while walking (a world-fixed grid).
// Cascades are deliberately out of scope.

import * as THREE from "three";
import type { QualityId } from "./types";

/** Half the edge length of the shadow box in m (light plane). */
const HALF: Record<QualityId, number> = {
  ultra: 70,
  high: 70,
  medium: 62,
  low: 55,
};

/** Fraction of half by which the box moves along the view direction. */
const FORWARD = 0.45;
const UP = new THREE.Vector3(0, 1, 0);

export class ShadowFit {
  /** Half the edge length in m (dev: changeable). */
  half: number;
  /** Shift along the view direction as a fraction of half (dev: changeable). */
  forward = FORWARD;
  private readonly x = new THREE.Vector3();
  private readonly y = new THREE.Vector3();
  private readonly z = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();

  constructor(quality: QualityId) {
    this.half = HALF[quality];
  }

  apply(sun: THREE.DirectionalLight, camera: THREE.Camera): void {
    const target = sun.target.position;
    // Axes of the shadow camera as in Matrix4.lookAt(position, target, up)
    this.z.subVectors(sun.position, target);
    if (this.z.lengthSq() < 1e-6) return;
    this.z.normalize();
    this.x.crossVectors(UP, this.z);
    if (this.x.lengthSq() < 1e-8) this.x.set(1, 0, 0);
    else this.x.normalize();
    this.y.crossVectors(this.z, this.x);

    this.fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const half = this.half;
    const texel = (2 * half) / Math.max(1, sun.shadow.mapSize.x);
    // desired box center relative to the target (camera), in the light plane
    const cx = this.fwd.dot(this.x) * half * this.forward;
    const cy = this.fwd.dot(this.y) * half * this.forward;
    // snap the box edges to world-fixed multiples of a texel
    const tx = target.dot(this.x);
    const ty = target.dot(this.y);
    const sx = Math.round((tx + cx) / texel) * texel - tx;
    const sy = Math.round((ty + cy) / texel) * texel - ty;

    const cam = sun.shadow.camera;
    cam.left = sx - half;
    cam.right = sx + half;
    cam.bottom = sy - half;
    cam.top = sy + half;
    cam.updateProjectionMatrix();
  }
}
