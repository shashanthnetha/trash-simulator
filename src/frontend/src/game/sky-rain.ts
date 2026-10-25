// Rain: a mesh of thin quads aligned along the fall direction (including the
// wind slant). The drops are moved entirely in the vertex shader (anchored in
// world space, wrapped around the camera) – no CPU update per frame. Plus
// splashes on the ground as a second, small Points object.

import * as THREE from "three";
import { mulberry32 } from "./noise";

const RAIN_VERT = `
  attribute vec2 aCorner;
  attribute float aRand;
  uniform float uTime;
  uniform vec3 uCam;
  uniform vec3 uBox;
  uniform vec3 uWind;
  uniform float uSpeed;
  uniform float uLen;
  varying vec2 vUv;
  varying float vFade;
  void main() {
    vec3 vel = vec3(uWind.x, -uSpeed * (0.75 + 0.5 * aRand), uWind.z);
    vec3 size = uBox * 2.0;
    // World-anchored path, wrapped into the box around the camera
    vec3 p = position * size + vel * uTime;
    p = mod(p - uCam + uBox, size) - uBox + uCam;
    vec3 sdir = normalize(vel);
    vec3 toCam = uCam - p;
    float dist = length(toCam);
    vec3 side = normalize(cross(sdir, toCam / max(dist, 0.001)));
    float len = uLen * (0.6 + 0.8 * aRand);
    float wid = max(0.009, dist * 0.0017);
    vec3 wp = p + side * (aCorner.x * wid) + sdir * (aCorner.y * len);
    vUv = aCorner;
    vFade = smoothstep(0.35, 1.4, dist) * (1.0 - smoothstep(uBox.x * 0.8, uBox.x * 1.25, dist));
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`;

const RAIN_FRAG = `
  uniform vec3 uColor;
  uniform float uAlpha;
  varying vec2 vUv;
  varying float vFade;
  void main() {
    float across = 1.0 - abs(vUv.x);
    float along = smoothstep(0.0, 0.3, vUv.y) * (1.0 - smoothstep(0.6, 1.0, vUv.y));
    float a = across * across * along * uAlpha * vFade;
    gl_FragColor = vec4(uColor, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const SPLASH_VERT = `
  attribute float aRand;
  uniform float uTime;
  uniform vec3 uCam;
  uniform vec3 uGround;   // (height below the camera, dH/dx, dH/dz)
  uniform float uRadius;
  uniform float uViewH;   // viewport height in pixels
  varying float vLife;
  varying float vSquash;
  void main() {
    // Each splash lives 0.22 s and then jumps to a new spot
    float period = 0.22;
    float t = uTime / period + aRand * 17.0;
    float cycle = floor(t);
    float life = fract(t);
    float a1 = fract(sin(cycle * 12.9898 + aRand * 78.233) * 43758.5453);
    float a2 = fract(sin(cycle * 39.346 + aRand * 11.135) * 24634.6345);
    float r = sqrt(a1) * uRadius;
    float ang = a2 * 6.2831853;
    vec3 p = vec3(uCam.x + cos(ang) * r, 0.0, uCam.z + sin(ang) * r);
    // On the (locally tilted) ground plane
    p.y = uGround.x + uGround.y * (p.x - uCam.x) + uGround.z * (p.z - uCam.z) + 0.01;
    vLife = life;
    vec3 toCam = uCam - p;
    float dist = max(0.3, length(toCam));
    vSquash = max(0.12, abs(toCam.y) / dist);
    // 1.2 .. 5 cm diameter, meters -> pixels
    float sizeM = 0.012 + 0.04 * life;
    vec4 mv = viewMatrix * vec4(p, 1.0);
    gl_PointSize = max(1.5, sizeM * projectionMatrix[1][1] * uViewH * 0.5 / max(0.3, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const SPLASH_FRAG = `
  uniform vec3 uColor;
  uniform float uAlpha;
  varying float vLife;
  varying float vSquash;
  void main() {
    vec2 q = (gl_PointCoord - 0.5) * 2.0;
    q.y /= vSquash;   // the ring lies on the ground -> squashed into an ellipse by perspective
    float d = length(q);
    float ring = smoothstep(0.45, 0.78, d) * (1.0 - smoothstep(0.82, 1.0, d));
    float a = ring * (1.0 - vLife) * uAlpha;
    gl_FragColor = vec4(uColor, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class Rain {
  readonly mesh: THREE.Mesh;
  readonly splashes: THREE.Points;
  private uniforms: Record<string, THREE.IUniform>;
  private splashUniforms: Record<string, THREE.IUniform>;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private splashGeo: THREE.BufferGeometry;
  private splashMat: THREE.ShaderMaterial;
  private dpr: number;

  constructor(count: number, splashCount: number) {
    const rng = mulberry32(9001);
    const pos = new Float32Array(count * 4 * 3);
    const corner = new Float32Array(count * 4 * 2);
    const rand = new Float32Array(count * 4);
    const idx = new Uint32Array(count * 6);
    for (let i = 0; i < count; i++) {
      const sx = rng();
      const sy = rng();
      const sz = rng();
      const r = rng();
      for (let k = 0; k < 4; k++) {
        const v = i * 4 + k;
        pos[v * 3] = sx;
        pos[v * 3 + 1] = sy;
        pos[v * 3 + 2] = sz;
        corner[v * 2] = k === 0 || k === 3 ? -1 : 1;
        corner[v * 2 + 1] = k < 2 ? 0 : 1;
        rand[v] = r;
      }
      const b = i * 4;
      idx.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.geo.setAttribute("aCorner", new THREE.BufferAttribute(corner, 2));
    this.geo.setAttribute("aRand", new THREE.BufferAttribute(rand, 1));
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));

    const dpr = Math.min(
      typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
      2,
    );
    this.uniforms = {
      uTime: { value: 0 },
      uCam: { value: new THREE.Vector3() },
      uBox: { value: new THREE.Vector3(15, 9, 15) },
      uWind: { value: new THREE.Vector3() },
      uSpeed: { value: 16 },
      uLen: { value: 0.45 },
      uColor: { value: new THREE.Color(0.5, 0.55, 0.6) },
      uAlpha: { value: 0 },
    };
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.visible = false;

    // Splashes
    const sp = new Float32Array(splashCount * 3);
    const sr = new Float32Array(splashCount);
    for (let i = 0; i < splashCount; i++) sr[i] = rng();
    this.splashGeo = new THREE.BufferGeometry();
    this.splashGeo.setAttribute("position", new THREE.BufferAttribute(sp, 3));
    this.splashGeo.setAttribute("aRand", new THREE.BufferAttribute(sr, 1));
    this.splashUniforms = {
      uTime: { value: 0 },
      uCam: { value: this.uniforms.uCam.value },
      uGround: { value: new THREE.Vector3() },
      uRadius: { value: 5 },
      uViewH: { value: 900 * dpr },
      uColor: { value: new THREE.Color() },
      uAlpha: { value: 0 },
    };
    this.dpr = dpr;
    this.splashMat = new THREE.ShaderMaterial({
      uniforms: this.splashUniforms,
      vertexShader: SPLASH_VERT,
      fragmentShader: SPLASH_FRAG,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.splashes = new THREE.Points(this.splashGeo, this.splashMat);
    this.splashes.frustumCulled = false;
    this.splashes.renderOrder = 6;
    this.splashes.visible = false;
  }

  /**
   * @param time     seconds (wrapped periodically internally)
   * @param rain     0..1 rain intensity
   * @param wind     0..1 wind
   * @param color    streak color (linear)
   * @param ground   (ground height below the camera, dH/dx, dH/dz) for the splashes
   */
  update(
    time: number,
    camPos: THREE.Vector3,
    rain: number,
    wind: number,
    color: THREE.Color,
    ground: THREE.Vector3,
  ): void {
    const on = rain > 0.02;
    this.mesh.visible = on;
    this.splashes.visible = on;
    if (!on) return;
    // Wrap periodically so that float precision in the shader is sufficient
    const t = time % 600;
    this.uniforms.uTime.value = t;
    (this.uniforms.uCam.value as THREE.Vector3).copy(camPos);
    (this.uniforms.uWind.value as THREE.Vector3).set(wind * 7.5, 0, wind * 2.5);
    this.uniforms.uSpeed.value = 13 + wind * 7;
    this.uniforms.uLen.value = 0.35 + wind * 0.35;
    this.uniforms.uAlpha.value = 0.22 + rain * 0.3;
    (this.uniforms.uColor.value as THREE.Color).copy(color);
    this.splashUniforms.uTime.value = t;
    (this.splashUniforms.uGround.value as THREE.Vector3).copy(ground);
    this.splashUniforms.uViewH.value =
      (typeof window !== "undefined" ? window.innerHeight : 900) * this.dpr;
    (this.splashUniforms.uColor.value as THREE.Color)
      .copy(color)
      .multiplyScalar(1.4)
      .addScalar(0.08);
    this.splashUniforms.uAlpha.value = 0.3 + rain * 0.4;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    this.splashGeo.dispose();
    this.splashMat.dispose();
  }
}
