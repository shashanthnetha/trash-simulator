// Sea: Gerstner swell + wind chop (vertex), detail normal maps, Fresnel/sky
// reflection, sun/moon glitter, depth color, whitecaps, surf line and the
// run-up on the beach (fragment). The mesh follows the shoreline
// (z = shoreZ(x) + d) and is "draped" over the beach, so that the run-up film
// reaches exactly up to shoreZ + waveReach(t) (consistent with the wet sand in
// world.ts). Reads light/sky from sky.ts every frame.
//
// The grid extends 6 km out (far beyond the camera's far plane): the distant
// range is squashed along the view ray in the vertex shader so that it fits
// inside the far plane without changing its position on screen. The last few
// arcminutes above the waterline blend completely into the dome color – the
// edge of the grid vanishes into the atmosphere instead of ending as a seam.
//
// Color pipeline: everything is composited LINEARLY (HDR) – sky colors, sun,
// foam, fog – and, like the sky dome, ends with the standard chunks
// tonemapping_fragment + colorspace_fragment. That keeps the horizon seamless
// even if the tone mapping later moves into a post pass.

import * as THREE from "three";
import { oceanFoamTexture, oceanNormalTexture } from "./ocean-textures";
import type { Environment } from "./sky";
import { SHORE_GLSL, shoreZ, terrainHeight } from "./terrain";
import type { QualityId } from "./types";

/** Grid spacing in m: sx along the beach, sd across it (surf/run-up zone). */
const GRID: Record<QualityId, { sx: number; sd: number; detail: number }> = {
  ultra: { sx: 0.8, sd: 0.35, detail: 1 },
  high: { sx: 1.0, sd: 0.4, detail: 1 },
  medium: { sx: 1.5, sd: 0.6, detail: 0.85 },
  low: { sx: 2.4, sd: 1.0, detail: 0.7 },
};

const X_DENSE = 430; // dense range along x (world bounds ±378 + margin)
const X_FAR = 6000;
const D_LAND = 10; // the run-up reaches at most reach(≤7) + noise
const D_BREAK = -4; // half density from here on
const D_NEAR = -26; // end of the surf zone (in a storm the breaker line sits at ~-30)
const D_MID = -130;
const D_FAR = -6000; // out to the (flat) horizon
/** Row growth in the middle zone and out toward the horizon, respectively. */
const MID_GROWTH = 1.022;
const FAR_GROWTH = 1.28;
/** Fade-out width at the outermost ring: the displacement is exactly 0 there. */
const EDGE_FLAT = 400;

const TWO_PI = Math.PI * 2;
/** Slope of the sea floor and clamp depth – identical to terrain.ts. */
const SLOPE = 0.075;
const H_MIN = 0.05;
const H_MAX = 7.0;
/**
 * Wave spectrum: dirX, dirZ (deep-water travel direction), base steepness,
 * deep-water wavelength in m, steepness gain per unit of wind.
 * The first `SWELL` entries are swell: they refract, shoal and break; the rest
 * is wind chop in the deep-water regime.
 */
const WAVES: readonly (readonly [number, number, number, number, number])[] = [
  [0.06, 1.0, 0.04, 42, 0.1],
  [-0.15, 1.0, 0.048, 27, 0.098],
  [0.22, 0.97, 0.05, 16, 0.098],
  [-0.35, 0.94, 0.022, 9.5, 0.17],
  [0.55, 0.83, 0.016, 5.6, 0.18],
  [-0.6, 0.8, 0.012, 3.4, 0.17],
];
const SWELL = 3;
const DIRS = WAVES.map(([dx, dz]) => {
  const l = Math.hypot(dx, dz);
  return [dx / l, dz / l] as const;
});
/**
 * Landward of PHASE_STOP the swell phase stops growing: the wave has broken and
 * runs up as a single bore. Without this, the wavelength – heavily shortened in
 * shallow water – would paint several run-up fronts onto the beach at once.
 */
const PHASE_STOP = -0.5;
const PHASE_RAMP = -4.0;

/** Still-water depth over the smooth profile (without terrain noise). */
function stillDepth(d: number): number {
  return Math.min(H_MAX, Math.max(H_MIN, -d * SLOPE));
}

/**
 * Wave number from the dispersion relation ω² = g·k·tanh(k·h), solved with the
 * explicit approximation of Guo (2002); ω comes from the deep-water wave number
 * k0. In shallow water k grows, so the wave gets shorter.
 */
function waveNumber(k0: number, h: number): number {
  const x = Math.sqrt(k0 * h);
  const u = 1 - Math.exp(-x * x * Math.sqrt(x));
  return (x * x) / (h * Math.max(u, 1e-5) ** 0.4);
}

function sstepJs(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Lift of the film above the sand (the terrain mesh is interpolated coarsely). */
const LIFT = 0.07;
/** Half the grid spacing of the terrain mesh (world.ts), for the ceiling estimate. */
const TERRAIN_Q = 1.7;

/**
 * Upper bound of the sand height beneath an ocean vertex. The terrain mesh
 * interpolates linearly between its sample points and, in hollows, lies ABOVE
 * the analytic height – the 7 cm film would poke through there. Hence we take
 * the maximum of the point value and the neighbor averages here.
 */
function terrainCeil(x: number, z: number): number {
  const h = terrainHeight(x, z);
  const a =
    (terrainHeight(x - TERRAIN_Q, z) + terrainHeight(x + TERRAIN_Q, z)) * 0.5;
  const b =
    (terrainHeight(x, z - TERRAIN_Q) + terrainHeight(x, z + TERRAIN_Q)) * 0.5;
  return Math.max(h, a, b);
}

function buildGeometry(quality: QualityId): THREE.BufferGeometry {
  const { sx, sd } = GRID[quality];
  // Columns (x): dense inside, growing geometrically outside
  const inner: number[] = [];
  const nIn = Math.round((X_DENSE * 2) / sx);
  for (let i = 0; i <= nIn; i++) inner.push(-X_DENSE + (i * X_DENSE * 2) / nIn);
  const outer: number[] = [];
  let x = X_DENSE;
  let step = sx * 2;
  while (x < X_FAR) {
    x = Math.min(X_FAR, x + step);
    outer.push(x);
    step *= 1.3;
  }
  const xs = [...outer.map((v) => -v).reverse(), ...inner, ...outer];
  // Rows (d = distance to the shoreline, positive on land), from land out to sea
  const ds: number[] = [];
  let d = D_LAND;
  while (d > D_BREAK + 1e-6) {
    ds.push(d);
    d -= sd;
  }
  while (d > D_NEAR + 1e-6) {
    ds.push(d);
    d -= sd * 2;
  }
  // Middle zone: growing slowly so that the 9.5 m chop is still sampled out to
  // ~120 m (that is where most of the visible sea state happens)
  step = sd * 3;
  while (d > D_MID + 1e-6) {
    ds.push(d);
    d -= step;
    step *= MID_GROWTH;
  }
  // Far zone: a few very coarse rings out to the horizon
  while (d > D_FAR + EDGE_FLAT) {
    ds.push(d);
    d -= step;
    step *= FAR_GROWTH;
  }
  ds.push(D_FAR + EDGE_FLAT);
  ds.push(D_FAR);

  const cols = xs.length;
  const rows = ds.length;
  // Local grid spacing (x, d) per column/row: waves that the grid can no longer
  // sample are faded out in the vertex shader (no aliasing).
  const spX = new Float32Array(cols);
  for (let i = 0; i < cols; i++) {
    const l = i > 0 ? xs[i] - xs[i - 1] : 0;
    const r = i < cols - 1 ? xs[i + 1] - xs[i] : 0;
    spX[i] = Math.max(l, r);
  }
  const spD = new Float32Array(rows);
  for (let j = 0; j < rows; j++) {
    const l = j > 0 ? ds[j - 1] - ds[j] : 0;
    const r = j < rows - 1 ? ds[j] - ds[j + 1] : 0;
    spD[j] = Math.max(l, r);
  }
  // Refraction phase of the swell across the beach: Φ(d) = ∫ k_z dd'. Under
  // refraction k_x is conserved (Snell's law), so in shallow water every wave
  // inevitably turns toward the shoreline and gets shorter. Because the depth
  // depends only on d, Φ is constant per row and can be integrated here once –
  // the surf then costs nothing in the shader.
  const phiRow = new Float32Array(rows * SWELL);
  const acc = [0, 0, 0];
  for (let j = 0; j < rows; j++) {
    if (j > 0) {
      const dm = (ds[j - 1] + ds[j]) * 0.5;
      const dd = ds[j] - ds[j - 1]; // negative: d decreases seaward
      const hm = stillDepth(dm);
      const ramp = sstepJs(PHASE_STOP, PHASE_RAMP, dm);
      for (let i = 0; i < SWELL; i++) {
        const k0 = TWO_PI / WAVES[i][3];
        const k = waveNumber(k0, hm);
        const kx = k0 * DIRS[i][0];
        const kz = Math.sqrt(Math.max(k * k - kx * kx, 1e-6));
        acc[i] += kz * dd * ramp;
      }
    }
    for (let i = 0; i < SWELL; i++) phiRow[j * SWELL + i] = acc[i];
  }

  const pos = new Float32Array(cols * rows * 3);
  const ty = new Float32Array(cols * rows);
  const sp = new Float32Array(cols * rows * 2);
  const phi = new Float32Array(cols * rows * 3);
  for (let j = 0; j < rows; j++) {
    // Ceiling estimate only where the sea floor is not yet clamped to −7 m
    // (further out it yields the same value anyway)
    const ceil = ds[j] > -95;
    for (let i = 0; i < cols; i++) {
      const vx = xs[i];
      const vz = shoreZ(vx) + ds[j];
      const k = j * cols + i;
      pos[k * 3] = vx;
      pos[k * 3 + 1] = 0;
      pos[k * 3 + 2] = vz;
      ty[k] = ceil ? terrainCeil(vx, vz) : terrainHeight(vx, vz);
      sp[k * 2] = spX[i];
      sp[k * 2 + 1] = spD[j];
      phi[k * 3] = phiRow[j * SWELL];
      phi[k * 3 + 1] = phiRow[j * SWELL + 1];
      phi[k * 3 + 2] = phiRow[j * SWELL + 2];
    }
  }
  const idx = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let n = 0;
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i;
      const b = a + cols;
      const c = a + 1;
      const e = b + 1;
      // Winding chosen so that the normal points toward +Y (front face seen from above)
      idx[n++] = a;
      idx[n++] = c;
      idx[n++] = b;
      idx[n++] = c;
      idx[n++] = e;
      idx[n++] = b;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aTerrainY", new THREE.BufferAttribute(ty, 1));
  geo.setAttribute("aSpacing", new THREE.BufferAttribute(sp, 2));
  geo.setAttribute("aPhi", new THREE.BufferAttribute(phi, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  return geo;
}

/** Wave table as GLSL – one source for both the CPU phase and the shader. */
const WAVE_GLSL = `
  // (dirX, dirZ, base steepness, deep-water wavelength)
  const vec4 W[6] = vec4[6](
    ${WAVES.map(
      (w, i) =>
        `vec4(${DIRS[i][0].toFixed(5)}, ${DIRS[i][1].toFixed(5)}, ${w[2].toFixed(4)}, ${w[3].toFixed(2)})`,
    ).join(",\n    ")});
  // Increase of steepness with wind
  const float WS[6] = float[6](${WAVES.map((w) => w[4].toFixed(4)).join(", ")});
`;

const VERTEX = `
  attribute float aTerrainY; attribute vec2 aSpacing; attribute vec3 aPhi;
  uniform float uTime; uniform float uWind;
  varying vec3 vWorldPos; varying vec3 vNormal;
  varying float vDepth; varying float vDrape; varying float vJ; varying float vCrest;
  varying float vDShore; varying vec2 vSC0; varying float vViewZ; varying float vBreak;
  ${SHORE_GLSL}
  const float LIFT = ${LIFT.toFixed(3)};
  const float D_FAR = ${D_FAR.toFixed(1)};
  const float EDGE_FLAT = ${EDGE_FLAT.toFixed(1)};
  const float SLOPE = ${SLOPE.toFixed(4)};
  const float H_MIN = ${H_MIN.toFixed(3)};
  const float H_MAX = ${H_MAX.toFixed(2)};
  const float PHASE_STOP = ${PHASE_STOP.toFixed(2)};
  /** Upper bound of the total steepness – above it the surface folds over itself. */
  const float S_MAX = 1.0;
  // Squashing of the far field into the camera's far plane (1600 m)
  const float SQUASH_0 = 700.0;
  const float SQUASH_MAX = 1480.0;
  float sstep(float a, float b, float x) {
    float t = clamp((x - a) / (b - a), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
  }
  ${WAVE_GLSL}
  // How well a wave can be sampled on the local grid (Nyquist with headroom)
  float sampleOk(vec2 dir, float len) {
    float sp = abs(dir.x) * aSpacing.x + abs(dir.y) * aSpacing.y;
    return 1.0 - smoothstep(len * 0.22, len * 0.4, sp);
  }
  /** Dispersion relation ω² = g·k·tanh(k·h), solved for k (Guo 2002). */
  float waveK(float k0, float h) {
    float x = sqrt(k0 * h);
    float u = 1.0 - exp(-x * x * sqrt(x));
    return (x * x) / (h * pow(max(u, 1e-5), 0.4));
  }
  /** tanh and 2kh/sinh(2kh) without overflow for large kh. */
  float tanhSafe(float x) { float e = exp(-2.0 * x); return (1.0 - e) / (1.0 + e); }
  float sinhRatio(float x) { float e = exp(-2.0 * x); return 4.0 * x * e / max(1.0 - e * e, 1e-6); }

  void main() {
    vec3 p = position;
    float d = p.z - shoreZf(p.x);
    vDShore = d;
    // Still-water depth (smooth profile). For the dispersion, d is frozen
    // landward of PHASE_STOP – the wave broke long before that point.
    float hStill = clamp(-d * SLOPE, H_MIN, H_MAX);
    float hDisp = clamp(-min(d, PHASE_STOP) * SLOPE, H_MIN, H_MAX);
    // Fade out only the outermost far field (a wave is narrower than a pixel
    // there); the outermost ring stays exactly flat for a straight silhouette
    float distFade = 1.0 - smoothstep(700.0, 1500.0, distance(cameraPosition.xz, p.xz));
    distFade *= smoothstep(D_FAR, D_FAR + EDGE_FLAT, d);

    // ---- Pass 1: local wave number, shoaling, breaker criterion
    float amp[6]; vec2 dirL[6]; float kL[6]; float phL[6];
    float aTot = 0.0; float sTot = 0.0; float brkRaw = 0.0;
    for (int i = 0; i < 6; i++) {
      float k0 = 6.28318 / W[i].w;
      float k = k0;
      vec2 dir = W[i].xy;
      float f;
      if (i < ${SWELL}) {
        // Refraction: k_x is conserved, the wave turns toward the shore
        k = waveK(k0, hDisp);
        float kx = k0 * W[i].x;
        float kz = sqrt(max(k * k - kx * kx, 1e-4));
        k = sqrt(kx * kx + kz * kz);
        dir = vec2(kx, kz) / k;
        f = kx * p.x + aPhi[i];
      } else {
        f = k0 * dot(dir, p.xz);
      }
      f -= sqrt(9.81 * k0) * uTime;
      float len = 6.28318 / k;
      float kh = k * hStill;
      float th = tanhSafe(kh);
      float n = 0.5 * (1.0 + sinhRatio(kh));
      // Shoaling per linear wave theory (energy flux is conserved): the wave
      // grows toward shallow water, after a dip at kh≈1.2
      float ks = min(sqrt(0.5 / max(n * th, 1e-3)), 2.2);
      float a = (W[i].z + WS[i] * uWind) / k0 * ks * sampleOk(dir, len) * distFade;
      // Miche: H ≤ 0.14·L·tanh(kh) – in shallow water this becomes H ≤ 0.88·h,
      // in deep water the classic steepness limit. Used only as a breaker
      // indicator; the amplitude is limited by steepness and depth budget.
      if (i < ${SWELL}) brkRaw = max(brkRaw, a / max(0.075 * len * th, 1e-3));
      amp[i] = a; kL[i] = k; dirL[i] = dir; phL[i] = f;
      aTot += a;
      sTot += a * k;
    }
    // Breaking swell steepens at the front: more horizontal Gerstner offset
    // sharpens the crest and widens the trough (sawtooth instead of sine).
    float qGain = 1.0 + 0.8 * smoothstep(0.7, 1.4, brkRaw);
    sTot += (amp[0] * kL[0] + amp[1] * kL[1] + amp[2] * kL[2]) * (qGain - 1.0);
    float sNorm = min(1.0, S_MAX / max(sTot, 1e-3));
    // Depth budget: the sum of the amplitudes stays below the still-water depth.
    // Without it the wave trough punches through the sea floor and exposes a
    // hard sand edge. Applied proportionally so that the spectrum keeps its
    // shape – limiting each component separately would level all of them out
    // and turn the swell in the surf into chop. The modulation along x stands
    // for sandbars: it keeps the breaker line from being dead straight.
    float bar = sin(p.x * 0.055 + 1.7) * 0.55 + sin(p.x * 0.021 + 4.1) * 0.45;
    float budget = hStill * (0.88 + 0.12 * bar) + 0.22 * sstep(-0.6, -5.0, d);
    sNorm = min(sNorm, budget / max(aTot, 1e-3));
    vBreak = smoothstep(0.55, 1.15, brkRaw * sNorm);

    // ---- Pass 2: Gerstner sum
    vec3 off = vec3(0.0);
    vec3 nSum = vec3(0.0);
    float jxx = 0.0; float jzz = 0.0; float jxz = 0.0;
    float crest = 0.0; float aSum = 0.0;
    for (int i = 0; i < 6; i++) {
      float a = amp[i] * sNorm;
      float s = a * kL[i];
      vec2 dir = dirL[i];
      float q = (i < ${SWELL}) ? qGain : 1.0;
      float sf = sin(phL[i]); float cf = cos(phL[i]);
      off += vec3(dir.x * a * cf * q, a * sf, dir.y * a * cf * q);
      nSum += vec3(dir.x * s * cf, s * sf, dir.y * s * cf);
      jxx += q * dir.x * dir.x * s * sf;
      jzz += q * dir.y * dir.y * s * sf;
      jxz += q * dir.x * dir.y * s * sf;
      if (i == 0) vSC0 = vec2(sf, cf);
      if (i < ${SWELL}) { crest += a * sf; aSum += a; }
    }
    vec3 dp = p + off;
    // Drape over the beach: never let the surface go below the sand, but do it
    // softly – a hard max() creates a visible crease running across the beach
    float floorY = aTerrainY + LIFT;
    float e = dp.y - floorY;
    float eS = 0.5 * (e + sqrt(e * e + 0.008));
    dp.y = floorY + eS;
    float lay = 1.0 - sstep(0.0, 0.40, e);
    // Run-up film only landward of the still-water line; seaward it stays a
    // water body (otherwise a wave trough gets drawn as dry sand)
    float beachM = sstep(-3.0, 0.3, d);
    vDrape = lay * beachM;
    vDepth = max(eS + LIFT, hStill * (1.0 - beachM));
    vec3 nrm = vec3(-nSum.x, max(1.0 - nSum.y, 0.08), -nSum.z);
    vNormal = normalize(mix(nrm, vec3(0.0, 1.0, 0.0), lay));
    vJ = (1.0 - jxx) * (1.0 - jzz) - jxz * jxz;
    vCrest = crest / max(0.03, aSum);
    vec4 wp = modelMatrix * vec4(dp, 1.0);
    vWorldPos = wp.xyz;
    vViewZ = -(viewMatrix * wp).z;
    // Squash the far field along the view ray: same position on screen, but
    // inside the far plane. Monotonic, so that depths stay sorted.
    vec3 rel = wp.xyz - cameraPosition;
    float dh = length(rel);
    if (dh > SQUASH_0) {
      float span = SQUASH_MAX - SQUASH_0;
      rel *= (SQUASH_0 + span * (1.0 - exp(-(dh - SQUASH_0) / span))) / dh;
    }
    vec4 mvPosition = viewMatrix * vec4(cameraPosition + rel, 1.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FRAGMENT = `
  uniform float uTime; uniform float uWind; uniform float uRain; uniform float uCloud;
  uniform float uDayI; uniform float uMoonI; uniform float uStarI; uniform float uFlash;
  uniform float uDetail; uniform float uFogDensity;
  uniform vec3 uSunDir; uniform vec3 uSunColor; uniform vec3 uMoonDir;
  uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uFogColor;
  uniform sampler2D uNormalMap; uniform sampler2D uFoamMap;
  varying vec3 vWorldPos; varying vec3 vNormal;
  varying float vDepth; varying float vDrape; varying float vJ; varying float vCrest;
  varying float vDShore; varying vec2 vSC0; varying float vViewZ; varying float vBreak;
  ${SHORE_GLSL}
  const float PI = 3.14159265;
  float sstep(float a, float b, float x) {
    float t = clamp((x - a) / (b - a), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
  }
  float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float hash11(float p) { return fract(sin(p * 78.233 + 0.7) * 43758.5453); }
  /** Smooth 1D value noise in [-1,1] – for the tongues of the run-up front. */
  float vn1(float x) {
    float i = floor(x);
    float f = x - i;
    f = f * f * (3.0 - 2.0 * f);
    return mix(hash11(i), hash11(i + 1.0), f) * 2.0 - 1.0;
  }
  float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
  float schlick(float cosT) { return 0.02 + 0.98 * pow(1.0 - cosT, 5.0); }
  // GGX lobe with Smith visibility (stays bounded at grazing angles)
  float specLobe(vec3 N, vec3 V, vec3 Ld, float NdV, float a) {
    vec3 H = normalize(Ld + V);
    float NdH = max(dot(N, H), 0.0);
    float NdL = max(dot(N, Ld), 0.0);
    float HdV = max(dot(H, V), 0.0);
    float a2 = a * a;
    float q = NdH * NdH * (a2 - 1.0) + 1.0;
    float D = a2 / (PI * q * q);
    float nv = max(NdV, 0.02);
    float vis = 0.5 / (NdL * sqrt(nv * nv * (1.0 - a2) + a2) + nv * sqrt(NdL * NdL * (1.0 - a2) + a2) + 1e-4);
    return D * schlick(HdV) * vis * NdL;
  }
  // Sky color in direction R (same gradient as the dome; the cloud cover is
  // already baked into the colors). With a low sun the sun color warms up the
  // horizon – the dome's sunset belt is not part of the average env.horizon.
  vec3 skyColor(vec3 R) {
    float up = clamp(R.y, 0.0, 1.0);
    float low = (1.0 - smoothstep(0.0, 0.3, uSunDir.y)) * smoothstep(-0.06, 0.04, uSunDir.y) * (1.0 - uCloud);
    vec3 hor = uHorizon + uSunColor * (low * 0.3 * uDayI);
    return mix(hor, uZenith, pow(up, 0.6));
  }
  // Rain: expanding rings, one cell per fragment
  vec2 rainRipple(vec2 p, float t) {
    vec2 cell = floor(p);
    float h = hash21(cell);
    vec2 ctr = vec2(hash21(cell + 1.3), hash21(cell + 7.1)) - 0.5;
    vec2 dv = fract(p) - 0.5 - ctr * 0.5;
    float r = length(dv);
    float ph = fract(t * (1.1 + h * 0.8) + h * 9.0);
    float w = sin(r * 34.0 - ph * 14.0) * exp(-r * 5.0) * (1.0 - ph) * sstep(0.0, 0.12, ph);
    return dv / max(r, 1e-3) * w;
  }

  void main() {
    vec3 toCam = cameraPosition - vWorldPos;
    float dist = length(toCam);
    vec3 V = toCam / dist;
    float d = vDShore;
    float t = uTime;
    vec2 wxz = vWorldPos.xz;
    float wet = 1.0 - vDrape;
    float sunUp = smoothstep(-0.03, 0.08, uSunDir.y);
    float sunI = uDayI * (1.0 - uCloud * 0.72) * sunUp;
    vec3 sunL = uSunColor * sunI;
    vec3 skyAmb = mix(uHorizon, uZenith, 0.5) * (1.0 + uFlash * 4.0);
    vec3 moonL = vec3(0.62, 0.72, 0.95) * uMoonI * smoothstep(0.0, 0.15, uMoonDir.y);
    // Rough sea seen from afar: facets tilt toward the viewer – the reflection
    // becomes less grazing (bluer sky) and Fresnel stays bounded. This is a
    // statistical stand-in for waves the grid can no longer resolve – hence
    // fade it in only far out, otherwise it eats exactly the Fresnel contrast
    // between the front and back of a wave, which is what makes the sea state
    // visible at grazing angles in the first place.
    float far = smoothstep(90.0, 480.0, dist) * wet;
    float farS = smoothstep(120.0, 600.0, dist);

    // ---- Detail normals: 3 layers + rain rings, faded out with distance
    float detail = uDetail / (1.0 + dist * 0.02);
    vec2 n1 = texture2D(uNormalMap, wxz * 0.05 + vec2(0.012, 0.028) * t).xy * 2.0 - 1.0;
    vec2 n2 = texture2D(uNormalMap, wxz * 0.21 + vec2(-0.045, 0.06) * t).xy * 2.0 - 1.0;
    vec2 nd = n1 * (0.10 + uWind * 0.18) + n2 * (0.16 + uWind * 0.28);
    // Finest layer only near the camera (beyond that its weight is 0)
    if (dist < 60.0) {
      vec2 n3 = texture2D(uNormalMap, wxz * 0.83 + vec2(0.08, -0.11) * t).xy * 2.0 - 1.0;
      nd += n3 * 0.22 * sstep(60.0, 6.0, dist);
    }
    nd *= detail;
    if (uRain > 0.01) {
      nd += rainRipple(wxz * 1.6, t) * uRain * sstep(70.0, 5.0, dist) * 0.5;
    }
    float ndScale = 1.0 - vDrape * 0.6;
    vec3 N = normalize(vec3(vNormal.x + nd.x * ndScale, vNormal.y, vNormal.z + nd.y * ndScale));
    // Fresnel/mirror direction with a smoothed normal (no shimmering at flat angles)
    vec3 Nf = normalize(mix(N, vNormal, 0.5 + 0.5 * smoothstep(15.0, 120.0, dist)));
    float NdV = max(dot(N, V), 0.0);
    float NdVf = max(dot(Nf, V), 0.0);
    float fres = schlick(max(NdVf, far * (0.2 + uWind * 0.1)));
    vec3 R = reflect(-V, Nf);
    R.y = max(R.y, 0.0) + far * (0.05 + uWind * 0.08);
    vec3 skyR = skyColor(R) * (1.0 + uFlash * 3.0);
    // Star glitter at night (same hash lattice as the sky dome)
    if (uStarI > 0.005) {
      vec2 sp = R.xz / max(0.12, R.y + 0.25) * 60.0;
      float star = step(0.9975, hash21(floor(sp))) * uStarI * smoothstep(0.05, 0.35, R.y);
      skyR += vec3(star) * 0.3;
    }

    // ---- Water body: per-channel absorption (coastal water: red goes first)
    // along the incoming (sun) and outgoing (view) path; scattered light grows
    // with the path length. The sand under the water only shows through in
    // green/blue (an estimate, since alpha is scalar).
    float sinI2 = 1.0 - NdVf * NdVf;
    float cosT = sqrt(max(0.0, 1.0 - sinI2 / 1.77));
    float path2 = vDepth / max(cosT, 0.2) + vDepth;
    vec3 Tc = exp(-path2 * vec3(0.45, 0.16, 0.14));
    float depthT = 1.0 - exp(-vDepth * 0.25);
    vec3 scatter = mix(vec3(0.03, 0.2, 0.2), vec3(0.004, 0.045, 0.14), depthT);
    scatter = mix(scatter, vec3(0.03, 0.062, 0.06), uCloud * 0.7);
    // Underwater irradiance falls with the sun's elevation (a low sun reflects)
    vec3 light = sunL * (0.15 + 0.85 * smoothstep(0.0, 0.5, uSunDir.y)) + skyAmb * 0.7 + moonL * 0.12;
    vec3 body = scatter * light * (1.0 - exp(-path2 * 0.3));
    vec3 sandEst = vec3(0.40, 0.37, 0.30) * (sunL * max(uSunDir.y, 0.0) + skyAmb * 1.2 + moonL * 0.3);
    body += sandEst * (Tc - Tc.r);
    float a = 1.0 - (1.0 - fres) * Tc.r;
    vec3 rad = (1.0 - fres) * body + fres * skyR;

    // ---- Sun/moon specular: narrow lobe (glitter) + wide lobe (glitter path);
    // wider in the distance so that the coarse grid does not throw sparks
    float rough = 0.06 + uWind * 0.1 + (1.0 - detail) * 0.1 + vDrape * 0.03 + farS * 0.12;
    vec3 spec = vec3(0.0);
    if (sunI > 0.002) {
      float specSun = specLobe(N, V, uSunDir, NdV, rough) * 0.75
                    + specLobe(N, V, uSunDir, NdV, rough * 2.2 + 0.12) * 0.25;
      spec += sunL * specSun;
    }
    if (uMoonI > 0.002) {
      float specMoon = specLobe(N, V, uMoonDir, NdV, rough + 0.02) * 0.75
                     + specLobe(N, V, uMoonDir, NdV, rough * 2.2 + 0.14) * 0.25;
      spec += moonL * specMoon * 1.2;
    }
    spec *= 1.0 - vDrape * 0.35;
    rad += spec;
    a = min(1.0, a + lum(spec) * 0.6);

    // ---- Scattered light in wave crests with a low backlighting sun (turquoise)
    float sunLow = (1.0 - smoothstep(0.0, 0.45, uSunDir.y)) * sunUp;
    if (sunLow * uDayI > 0.002) {
      float back = pow(max(dot(V, -uSunDir), 0.0), 3.0);
      float sss = back * sunLow * smoothstep(0.3, 0.95, vCrest) * (1.0 - fres) * smoothstep(0.2, 1.5, vDepth);
      rad += vec3(0.08, 0.5, 0.42) * uSunColor * uDayI * sss * 0.8 * (1.0 - Tc.g);
    }

    // ---- Foam. The two base layers are only needed by the surf zone or – from
    // moderate wind on – by the whitecaps on the open sea.
    float windCap = smoothstep(0.28, 0.82, uWind);
    // In a storm the breaker line sits at ~4 m water depth, i.e. ~30-40 m out;
    // in a calm the waves only break just before the beach.
    bool surf = d > -48.0;
    bool wash = d > -22.0;
    vec3 fmA = vec3(0.0);
    vec3 fmB = vec3(0.0);
    if (surf || windCap > 0.002) {
      fmA = texture2D(uFoamMap, wxz * 0.11 + vec2(0.01, 0.03) * t).rgb;
      fmB = texture2D(uFoamMap, wxz * 0.37 + vec2(-0.03, 0.05) * t).rgb;
    }
    // Whitecaps: scattered patches, stretched along the crests (x), where the
    // surface folds (Jacobian); dense in a storm
    float cap = 0.0;
    if (windCap > 0.002) {
      float patchN = texture2D(uFoamMap, vec2(wxz.x * 0.016 + t * 0.005, wxz.y * 0.07 - t * 0.02)).g;
      float capPatch = smoothstep(mix(0.72, 0.1, windCap), mix(1.0, 0.7, windCap), patchN);
      // Breaking criterion: folding (Jacobian) or – with strong wind – a high swell crest
      float jac = sstep(0.55 + windCap * 0.4, 0.1, vJ);
      float crestBrk = smoothstep(0.5, 0.9, vCrest) * 0.8;
      float capRaw = max(jac, crestBrk) * capPatch * (0.5 + 0.5 * fmB.r) * (0.6 + 0.4 * fmA.g);
      cap = windCap * wet * smoothstep(0.12, 0.45, capRaw);
      // Storm: streaks of spray blown by the wind (stretched along the travel
      // direction). The frequency along x stays moderate, otherwise it flickers
      // on the steep breaker flanks (where the surface is nearly edge-on).
      float streakT = texture2D(uFoamMap, vec2(wxz.x * 0.28, wxz.y * 0.05 + t * 0.2)).g;
      cap += windCap * windCap * smoothstep(0.55, 0.9, streakT) * (0.5 + 0.5 * fmB.b)
           * wet * 0.4 * sstep(0.9, 0.35, vJ) * (1.0 - smoothstep(80.0, 260.0, dist));
    }

    float foam = cap;
    float frontMask = 1.0;
    // ---- Surf and run-up zone (computed only near the shoreline)
    if (surf) {
      float ph = atan(vSC0.x, vSC0.y);
      float sinceCrest = mod(1.5708 - ph, 6.28318) / 6.28318;
      float trail = exp(-sinceCrest * 7.0);
      // Shore noise along x on five scales (80 m … 40 cm), unclamped. The fine
      // layers drift slowly so that the tongues change from wave to wave; the
      // coarse ones stay put (sandbars, bays).
      float xw = vWorldPos.x;
      float fine = 1.0 - smoothstep(25.0, 70.0, dist);
      float nA = vn1(xw * 0.0125 + 3.1);
      float nB = vn1(xw * 0.055 + t * 0.017 + 11.7);
      float nC = vn1(xw * 0.23 + t * 0.05 + 5.3);
      float nD = vn1(xw * 0.78 + t * 0.13 + 19.1);
      float nE = vn1(xw * 2.3 + t * 0.27 + 7.7);
      // Surf line: where the Miche criterion kicks in (vBreak from the vertex
      // shader), on the crests of the swell plus a trail behind them. The line
      // therefore moves outward by itself as the waves grow: in a calm they
      // break close to the beach, in a storm 30-40 m out.
      float zone = vBreak * sstep(-0.8, -3.2, d);
      float crestF = smoothstep(0.25, 0.72, vCrest);
      float brkVar = smoothstep(-0.5, 0.55, nA * 0.55 + nB * 0.5 + uWind * 0.9 - 0.3);
      float brk = zone * brkVar * max(crestF, trail * 0.55) * (0.5 + 0.5 * fmA.g)
                * (0.75 + 0.25 * fmB.r) * (0.6 + uWind * 0.6);
      foam += brk;
      // ---- Run-up zone: pulse of the main swell (delayed, offset along x) out
      // to waveReach(t). Every tongue runs a different distance (lobeGain), and
      // the front is additionally frayed on the meter-to-decimeter scale.
      if (wash) {
        float reach = waveReachF(t);
        float s = fract((1.5708 - (ph + 1.2 + nA * 1.7 + nB * 0.85)) / 6.28318);
        float runup = smoothstep(0.0, 0.3, s) * (1.0 - smoothstep(0.32, 1.0, s));
        float lobeGain = 1.0 + nB * 0.30 + nC * 0.26 + nD * 0.12;
        float lace1 = nC * 0.55 + (nD * 0.34 + nE * 0.15) * fine;
        float front = reach - 2.6 + 2.6 * runup * lobeGain
                    + nA * 0.55 + nB * 0.75 + lace1 * (0.4 + 0.6 * runup);
        frontMask = 1.0 - smoothstep(front - 0.28, front + 0.10, d);
        rad *= frontMask; a *= frontMask;
        // Film: thin and nearly clear – the reflection (Fresnel) and the wet
        // sand set the color, with only slight turbidity from sand/bubbles
        float sheet = vDrape * frontMask;
        float film = sheet * 0.04 * (0.5 + 0.5 * runup);
        rad += skyAmb * 0.8 * film; a += film;
        // Lace at the front (narrow, bright), moving along with it; a few streaks behind it
        vec3 fmW = texture2D(uFoamMap, vec2(wxz.x * 0.45, (d - front) * 0.6 + t * 0.05)).rgb;
        float lace = smoothstep(0.3, 0.75, fmW.r * 0.75 + fmW.b * 0.35);
        float edge = sstep(0.6, 0.0, front - d) * frontMask;
        float washFoam = sheet * edge * (0.5 + 0.5 * lace) * (0.55 + 0.45 * runup);
        washFoam += sheet * sstep(3.5, 0.4, front - d) * smoothstep(0.6, 0.9, fmW.r * 0.8 + fmW.g * 0.3) * 0.4;
        // Bore zone in front of the film: bubbles behind the breaker, further out in a storm
        washFoam += wet * smoothstep(-4.0 - 8.0 * vBreak, -0.5, d) * frontMask * lace
                  * (0.06 + 0.3 * trail) * (1.0 + vBreak);
        // Residue on the wet sand: thin lace right behind the front + a line at the maximum
        float exposed = (1.0 - frontMask) * vDrape;
        float resid = exposed * sstep(1.6, 0.0, d - front) * 0.3 * smoothstep(0.5, 0.8, fmB.r * 0.8 + fmA.b * 0.4);
        float lineD = d - (reach + 0.3 + nB * 0.6 + nC * 0.45 + nD * 0.2 * fine);
        float line = exposed * sstep(0.35, 0.0, abs(lineD)) * 0.35 * smoothstep(0.35, 0.7, fmB.r);
        foam += washFoam + resid + line;
      }
    }
    foam = clamp(foam, 0.0, 1.0);
    vec3 foamCol = vec3(0.9, 0.93, 0.95) * (sunL * max(uSunDir.y, 0.0) * 0.85 + skyAmb * 0.8 + moonL * 0.35);
    foamCol *= 1.0 - uCloud * 0.2;
    rad = mix(rad, foamCol, foam);
    a = mix(a, 1.0, foam);

    // ---- Seen from below (camera under a crest): murky green. Only close by,
    // or when the fragment lies above the camera – otherwise distant, extremely
    // thin triangles at the horizon flip to "back face" through raster precision.
    if (!gl_FrontFacing && (vWorldPos.y > cameraPosition.y + 0.02 || dist < 150.0)) {
      rad = vec3(0.02, 0.09, 0.09) * (skyAmb + sunL * 0.5 + moonL) * 0.9;
      a = 0.9;
    }
    if (a < 0.004) discard;
    vec3 col = rad / a;
    // ---- Haze/fog (the scene's FogExp2 + a slight horizon veil), linear. Over
    // the open sea (no terrain behind it) the surface becomes transparent along
    // with the fog: the dome, already drawn, then supplies exactly its own
    // horizon color for that view direction (env.fog.color is only an average
    // and misses sunset red/sun glare at the horizon) – no seam. In front of
    // the coastal strip we blend toward the fog color as standard materials do.
    float fogF = 1.0 - exp(-uFogDensity * uFogDensity * vViewZ * vViewZ);
    float hazeF = 1.0 - exp(-dist * 0.0005);
    float fogTot = 1.0 - (1.0 - fogF) * (1.0 - hazeF);
    float openSea = max(1.0 - smoothstep(-200.0, -130.0, vWorldPos.z),
                        smoothstep(400.0, 460.0, abs(vWorldPos.x)));
    col = mix(col, uFogColor, fogTot * (1.0 - openSea));
    a *= 1.0 - openSea * fogTot;
    // ---- Horizon: water seen at a grazing angle is a nearly perfect mirror and
    // disappears into the aerial perspective. The last ~1.5° above the waterline
    // therefore blend completely into the dome color – the edge of the grid lies
    // far beyond that and is no longer visible.
    float drop = cameraPosition.y - vWorldPos.y;
    float elev = max(drop, 0.0) / max(dist, 1.0);
    float hz = (1.0 - smoothstep(0.0035, 0.028, elev))
             * smoothstep(0.1, 0.6, drop) * smoothstep(40.0, 120.0, dist);
    col = mix(col, uHorizon, hz);
    a *= 1.0 - hz;
    gl_FragColor = vec4(col, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class Ocean {
  readonly mesh: THREE.Mesh;
  private uniforms: Record<string, THREE.IUniform>;
  private parent: THREE.Object3D;
  private normalMap: THREE.Texture;
  private foamMap: THREE.Texture;

  constructor(parent: THREE.Object3D, quality: QualityId) {
    this.parent = parent;
    this.normalMap = oceanNormalTexture(quality === "low" ? 128 : 256);
    this.foamMap = oceanFoamTexture(quality === "low" ? 256 : 512);
    this.uniforms = {
      uTime: { value: 0 },
      uWind: { value: 0.2 },
      uRain: { value: 0 },
      uCloud: { value: 0 },
      uDayI: { value: 1 },
      uMoonI: { value: 0 },
      uStarI: { value: 0 },
      uFlash: { value: 0 },
      uDetail: { value: GRID[quality].detail },
      uFogDensity: { value: 0.0012 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 0.97, 0.92) },
      uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
      uZenith: { value: new THREE.Color(0.09, 0.18, 0.36) },
      uHorizon: { value: new THREE.Color(0.5, 0.65, 0.7) },
      uFogColor: { value: new THREE.Color(0.5, 0.65, 0.7) },
      uNormalMap: { value: this.normalMap },
      uFoamMap: { value: this.foamMap },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: true,
      side: THREE.DoubleSide,
      // Fog is blended in the shader itself, linearly (before the tone mapping)
      fog: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.Mesh(buildGeometry(quality), mat);
    this.mesh.renderOrder = 2;
    this.mesh.frustumCulled = false;
    this.mesh.name = "ocean";
    parent.add(this.mesh);
  }

  update(_dt: number, env: Environment, _camPos: THREE.Vector3): void {
    const u = this.uniforms;
    u.uTime.value = env.envTime;
    (u.uSunDir.value as THREE.Vector3).copy(env.sunDir);
    (u.uSunColor.value as THREE.Color).copy(env.sunColor);
    (u.uMoonDir.value as THREE.Vector3).copy(env.moonDir);
    (u.uZenith.value as THREE.Color).copy(env.zenith);
    (u.uHorizon.value as THREE.Color).copy(env.horizonSea);
    (u.uFogColor.value as THREE.Color).copy(env.fog.color);
    u.uFogDensity.value = env.fog.density;
    u.uDayI.value = env.dayI;
    u.uMoonI.value = env.moonI;
    u.uStarI.value = env.starI;
    u.uWind.value = env.wind;
    u.uRain.value = env.rain;
    u.uCloud.value = env.cloud;
    // The water mirrors the SKY: a 5 km strike lights the horizon in the
    // reflection even though the ground flash has already fallen off.
    u.uFlash.value = env.skyFlash;
    // The renderer sets cameraPosition itself; the grid is anchored to the
    // shoreline and reaches the horizon – no need to move it along.
  }

  dispose(): void {
    this.parent.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.normalMap.dispose();
    this.foamMap.dispose();
  }
}
