// Starry sky: a single Points object with a few thousand stars (brightness,
// size, color and twinkling per star), denser along the Milky Way. Rotates
// slowly about the celestial pole; drawn BEFORE the sky dome, and the dome
// covers the stars via the cloud alpha (see sky.ts).

import * as THREE from "three";
import { mulberry32 } from "./noise";

export const STAR_RADIUS = 1380;

/** Celestial pole: direction +Z (dunes), 48° up – the sun travels over the sea side. */
export const POLE_AXIS = new THREE.Vector3(
  0,
  Math.sin(0.84),
  Math.cos(0.84),
).normalize();

/** Normal of the galactic plane in star space (for the Milky Way band + clustering). */
export const GALAXY_NORMAL = new THREE.Vector3(0.55, 0.62, -0.56).normalize();

const STAR_VERT = `
  attribute float aSize;
  attribute float aIntensity;
  attribute vec3 aColor;
  attribute vec2 aTwinkle;
  uniform float uTime;
  uniform float uStarI;
  uniform float uPixelRatio;
  varying vec3 vColor;
  varying float vSize;
  void main() {
    vec3 wdir = normalize(mat3(modelMatrix) * position);
    float up = wdir.y;
    float horizon = smoothstep(-0.01, 0.12, up);
    // Extinction + reddening near the horizon (air mass)
    float airmass = 1.0 / max(up, 0.06);
    float ext = exp(-(airmass - 1.0) * 0.14);
    // Twinkling: stronger near the horizon, two frequencies
    float twAmp = mix(0.10, 0.6, 1.0 - clamp(up, 0.0, 1.0));
    float s1 = sin(uTime * aTwinkle.y + aTwinkle.x);
    float s2 = sin(uTime * aTwinkle.y * 0.41 + aTwinkle.x * 2.3);
    float tw = 1.0 - twAmp * (0.5 + 0.5 * s1) * (0.55 + 0.45 * s2);
    float b = aIntensity * uStarI * horizon * ext * tw;
    vec3 col = aColor;
    col.r *= 1.0 + (1.0 - ext) * 0.6;
    col.b *= 1.0 - (1.0 - ext) * 0.4;
    vColor = col * b;
    vSize = aSize;
    gl_PointSize = max(aSize * uPixelRatio * (0.9 + 0.2 * tw), 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const STAR_FRAG = `
  varying vec3 vColor;
  varying float vSize;
  void main() {
    vec2 q = gl_PointCoord - 0.5;
    float d = length(q) * 2.0;
    float core = pow(max(1.0 - d, 0.0), 1.6);
    // Bright stars get a small halo
    float halo = exp(-d * d * 5.0) * 0.14 * smoothstep(2.4, 3.6, vSize);
    gl_FragColor = vec4(vColor * (core + halo), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class StarField {
  readonly points: THREE.Points;
  readonly uniforms: Record<string, THREE.IUniform>;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;

  constructor(count: number, seed = 4242) {
    const rng = mulberry32(seed);
    const pos = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const inten = new Float32Array(count);
    const color = new Float32Array(count * 3);
    const twk = new Float32Array(count * 2);

    // Orthonormal basis of the galactic plane
    const gN = GALAXY_NORMAL;
    const e1 = new THREE.Vector3(1, 0, 0).cross(gN).normalize();
    const e2 = new THREE.Vector3().crossVectors(gN, e1).normalize();
    const v = new THREE.Vector3();

    for (let i = 0; i < count; i++) {
      const inGalaxy = i % 5 < 2; // 40 % of the stars sit in the Milky Way band
      if (inGalaxy) {
        // Gaussian distribution around the galactic plane, denser toward the center (phi≈0)
        const phi = (rng() - 0.5) * Math.PI * 2 * (0.4 + rng() * 0.6);
        const g = (rng() + rng() + rng() - 1.5) * 0.18;
        const lat = g * (1 + Math.abs(phi) * 0.25);
        v.copy(e1)
          .multiplyScalar(Math.cos(phi) * Math.cos(lat))
          .addScaledVector(e2, Math.sin(phi) * Math.cos(lat))
          .addScaledVector(gN, Math.sin(lat));
      } else {
        const y = rng() * 2 - 1;
        const t = rng() * Math.PI * 2;
        const r = Math.sqrt(1 - y * y);
        v.set(r * Math.cos(t), y, r * Math.sin(t));
      }
      v.normalize().multiplyScalar(STAR_RADIUS);
      pos[i * 3] = v.x;
      pos[i * 3 + 1] = v.y;
      pos[i * 3 + 2] = v.z;

      // Brightness distribution: many faint stars, few bright ones
      const m = rng();
      let s = 1.3 + 3.0 * m ** 7;
      let b = 0.16 + 1.6 * m ** 5;
      if (m > 0.993) {
        s = 4.2 + rng() * 1.6;
        b = 2.4 + rng() * 1.4;
      }
      if (inGalaxy) {
        s *= 0.85;
        b *= 0.8;
      }
      size[i] = s;
      inten[i] = b;

      // Spectral color: mostly white, some cool (blue-white) or warm (orange)
      const c = rng();
      let cr = 0.95;
      let cg = 0.96;
      let cb = 1.0;
      if (c < 0.1) {
        cr = 1.0;
        cg = 0.78;
        cb = 0.58;
      } else if (c < 0.16) {
        cr = 1.0;
        cg = 0.62;
        cb = 0.45;
      } else if (c < 0.42) {
        cr = 0.76;
        cg = 0.85;
        cb = 1.0;
      } else if (c < 0.6) {
        cr = 1.0;
        cg = 0.94;
        cb = 0.86;
      }
      const jitter = 0.94 + rng() * 0.12;
      color[i * 3] = cr * jitter;
      color[i * 3 + 1] = cg * jitter;
      color[i * 3 + 2] = cb * jitter;

      twk[i * 2] = rng() * Math.PI * 2;
      twk[i * 2 + 1] = 2 + rng() * 7;
    }

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    this.geo.setAttribute("aIntensity", new THREE.BufferAttribute(inten, 1));
    this.geo.setAttribute("aColor", new THREE.BufferAttribute(color, 3));
    this.geo.setAttribute("aTwinkle", new THREE.BufferAttribute(twk, 2));

    this.uniforms = {
      uTime: { value: 0 },
      uStarI: { value: 0 },
      uPixelRatio: {
        value: Math.min(
          typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
          2,
        ),
      },
    };
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      blending: THREE.AdditiveBlending,
      transparent: false,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = -20;
  }

  /** Set the rotation angle about the celestial pole (rad) + the camera position. */
  update(time: number, angle: number, starI: number, camPos: THREE.Vector3) {
    this.uniforms.uTime.value = time;
    this.uniforms.uStarI.value = starI;
    this.points.quaternion.setFromAxisAngle(POLE_AXIS, angle);
    this.points.position.copy(camPos);
    this.points.visible = starI > 0.002;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
