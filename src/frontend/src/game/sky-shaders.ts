// Sky dome shader (atmosphere, sun, moon, Milky Way, clouds, lightning) plus a
// JS mirror of the atmosphere formula, so that Environment hands the same
// zenith/horizon colors (linear) to the ocean, the fog and the hemisphere light.
//
// Atmosphere: Rayleigh + Mie after Preetham (a variant of the three.js sky
// example), extended with twilight glow, Belt of Venus, night sky and moon
// scattering. Clouds: 2D projection onto a curved layer, three fetches of a
// tileable RGBA noise texture (no per-pixel noise).

import type * as THREE from "three";

export const SKY_VERT = `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const SKY_FRAG = `
  varying vec3 vDir;
  uniform vec3 uSunDir;
  uniform vec3 uMoonDir;
  uniform vec3 uBetaR;
  uniform vec3 uBetaM;
  uniform float uSunE;
  uniform vec3 uSunTint;
  uniform float uMieG;
  uniform float uGloom;
  uniform float uSkyGain;
  uniform float uDayI;
  uniform float uNight;
  uniform vec3 uNightZen;
  uniform vec3 uNightHor;
  uniform float uTwAmb;
  uniform float uTwGlow;
  uniform float uTwBelt;
  uniform float uTwDepth;
  uniform float uMoonE;
  uniform float uMoonI;
  uniform vec3 uMoonTint;
  uniform vec3 uMoonLight;
  uniform float uMoonBright;
  uniform sampler2D uMoonTex;
  uniform sampler2D uNoise;
  uniform vec2 uCloudOff;
  uniform float uCloud;
  uniform float uRain;
  uniform float uTime;
  uniform vec3 uLightDir;
  uniform vec3 uLightCol;
  uniform vec3 uCloudAmb;
  uniform float uStarI;
  uniform mat3 uStarRot;
  uniform float uFlash;
  uniform float uBolt;
  uniform vec3 uBoltDir;
  uniform float uBoltAz;
  uniform float uBoltSeed;
  // Angular scale of the bolt: 1 = near strike (tall, wide, high up),
  // ~0.3 = 6 km away (a short narrow streak just over the horizon).
  uniform float uBoltW;

  const float PI = 3.141592653589793;
  const float R_ZENITH = 8.4e3;
  const float M_ZENITH = 1.25e3;
  const float SUN_COS = 0.99991433;   // cos(0.75°): sun disc 1.5°
  const float MOON_SIN = 0.02094;     // sin(1.2°): moon disc 2.4° (slightly larger than real)
  // Galactic plane in star space (identical to sky-stars.ts: GALAXY_NORMAL, e1, e2)
  const vec3 G_NORMAL = vec3(0.5499, 0.6198, -0.5599);
  const vec3 G_E1 = vec3(0.0, 0.6703, 0.7420);
  const vec3 G_E2 = vec3(0.8352, -0.4080, 0.3686);

  float rayleighPhase(float c) { return (3.0 / (16.0 * PI)) * (1.0 + c * c); }
  float hgPhase(float c, float g) {
    float g2 = g * g;
    return (1.0 / (4.0 * PI)) * ((1.0 - g2) / pow(1.0 - 2.0 * g * c + g2, 1.5));
  }

  void main() {
    vec3 dir = normalize(vDir);
    float h = max(dir.y, 0.0);
    float hh = exp(-h * 3.5);   // proximity to the horizon

    // ---- Rayleigh / Mie ----
    float zenithAngle = acos(h);
    float inv = 1.0 / (h + 0.15 * pow(93.885 - degrees(zenithAngle), -1.253));
    vec3 Fex = exp(-(uBetaR * (R_ZENITH * inv) + uBetaM * (M_ZENITH * inv)));
    float cosTheta = dot(dir, uSunDir);
    vec3 betaTheta = uBetaR * rayleighPhase(cosTheta * 0.5 + 0.5) + uBetaM * hgPhase(cosTheta, uMieG);
    // In-scattering, tinted with the transmittance of the sunlight (low sun = warm)
    vec3 Lin = uSunE * uSunTint * betaTheta / (uBetaR + uBetaM) * (1.0 - Fex);
    // Low sun: long paths turn red-orange (normalized extinction), more strongly
    // toward the sun; the zenith and directions away from it stay blue/pale
    vec2 az = normalize(vec2(dir.x, dir.z) + vec2(0.00001));
    vec2 sunAz = normalize(uSunDir.xz + vec2(0.00001));
    float align = dot(az, sunAz);
    vec3 fexN = pow(Fex / max(max(Fex.r, Fex.g), max(Fex.b, 0.0001)), vec3(0.75));
    float lowSun = 1.0 - smoothstep(0.0, 0.3, uSunDir.y);
    Lin *= mix(vec3(1.0), fexN, lowSun * (0.5 + 0.5 * max(align, 0.0)));
    vec3 col = Lin * uSkyGain + vec3(0.0, 0.0003, 0.00075) * uDayI;

    // Sun disc (1.5°) + corona
    float sunK = uSunE * 0.001;
    vec3 sunTrans = sqrt(Fex);
    float aa = fwidth(cosTheta) * 1.5 + 0.00001;
    float sundisk = smoothstep(SUN_COS - aa, SUN_COS + aa, cosTheta);
    // Corona: low in the sky a wide haze halo (long path through the aerosols),
    // high in the sky only a narrow rim – otherwise the midday sun becomes a big
    // white blob instead of a small bright disc.
    float sunHigh = smoothstep(0.02, 0.4, uSunDir.y);
    float coronaP = mix(220.0, 1400.0, sunHigh);
    float coronaA = mix(2.2, 0.3, sunHigh);
    // Under rain/thunderstorm the disc disappears behind the cover (rain: pale patch)
    float discVis = (1.0 - uGloom) * (1.0 - uGloom);
    col += sunTrans * sunK * (sundisk * 40.0 + pow(max(cosTheta, 0.0), coronaP) * coronaA) * discVis;

    // ---- Twilight ----
    // Remaining sky blue (the upper atmosphere is still lit), pulled back near
    // the horizon on the sun side so that the glow stays orange
    col += vec3(0.05, 0.09, 0.2) * uTwAmb * (0.5 + 0.5 * hh) * (1.0 - 0.6 * max(align, 0.0) * hh);
    // Glow on the horizon near the sun: orange -> red -> violet
    vec3 gc = mix(vec3(1.0, 0.5, 0.15), vec3(0.85, 0.24, 0.26), smoothstep(0.0, 0.45, uTwDepth));
    gc = mix(gc, vec3(0.32, 0.17, 0.42), smoothstep(0.45, 1.0, uTwDepth));
    float gs = pow(max(align, 0.0), 2.0 + 3.0 * uTwDepth);
    float gv = exp(-h * (5.0 + 12.0 * uTwDepth));
    col += gc * gs * gv * uTwGlow;
    // Belt of Venus + Earth's shadow opposite the sun
    float anti = pow(max(-align, 0.0), 1.5) * uTwBelt;
    float belt = exp(-pow((dir.y - 0.075) / 0.06, 2.0));
    float eshadow = exp(-pow(h / 0.04, 2.0));
    col += vec3(0.45, 0.22, 0.32) * belt * anti * 0.45;
    col = mix(col, col * vec3(0.55, 0.62, 0.8), eshadow * anti * 0.5);

    // ---- Night ----
    vec3 night = mix(uNightZen, uNightHor, hh);
    col += night * uNight;
    // Moon scattering: cool halo + wide Mie veil
    float cosM = dot(dir, uMoonDir);
    float moonGlow = hgPhase(cosM, 0.72) * 0.38 + pow(max(cosM, 0.0), 260.0) * 1.6;
    col += uMoonTint * uMoonE * moonGlow * (1.0 - Fex * 0.6);

    // ---- Moon disc ----
    if (uMoonI > 0.001 && cosM > 0.9993) {
      vec3 mr = normalize(cross(vec3(0.0, 1.0, 0.0), uMoonDir));
      vec3 mu = cross(uMoonDir, mr);
      vec2 q = vec2(dot(dir, mr), dot(dir, mu)) / MOON_SIN;
      float r = length(q);
      float maa = fwidth(r) + 0.01;
      float disc = 1.0 - smoothstep(1.0 - maa, 1.0 + maa, r);
      if (disc > 0.0) {
        vec3 n = vec3(q, sqrt(max(0.0, 1.0 - dot(q, q))));
        float lit = smoothstep(-0.06, 0.32, dot(n, uMoonLight));
        vec3 alb = texture2D(uMoonTex, q * 0.5 + 0.5).rgb;
        vec3 moonCol = alb * (lit * uMoonBright + 0.02) * vec3(1.0, 0.985, 0.95);
        col = mix(col, moonCol, disc * uMoonI);
      }
    }

    // ---- Milky Way (in the rotating star space) ----
    if (uStarI > 0.001) {
      vec3 sd = uStarRot * dir;
      float gl = dot(sd, G_NORMAL);
      float band = exp(-gl * gl * 26.0);
      float lon = atan(dot(sd, G_E2), dot(sd, G_E1));
      vec2 gn = texture2D(uNoise, vec2(lon * 0.6, gl * 2.5) + 0.37).rg;
      float dust = 1.0 - 0.55 * smoothstep(0.42, 0.7, gn.g) * exp(-gl * gl * 90.0);
      float core = 1.0 + 1.3 * exp(-lon * lon * 1.2);
      vec3 mwCol = mix(vec3(0.5, 0.58, 0.8), vec3(0.75, 0.66, 0.6), exp(-lon * lon * 1.2) * 0.6);
      col += mwCol * 0.05 * band * (0.3 + 0.7 * gn.r) * dust * core * uStarI * smoothstep(0.0, 0.12, dir.y);
    }

    // Rain/storm: clear sky damped and desaturated (gaps look grey)
    col = mix(col, vec3(dot(col, vec3(0.3, 0.5, 0.2))), uGloom * 0.6) * (1.0 - uGloom * 0.85);
    vec3 clear = col;
    // Thunderstorm (not mere rain): ragged, low-hanging cover
    float stormy = smoothstep(0.45, 0.9, uGloom);

    // ---- Clouds ----
    // In a storm the layer hangs lower (faster drift, more ragged)
    float curve = 1.0 / (h + mix(0.11, 0.075, uGloom));
    vec2 cp = dir.xz * curve;
    vec2 uvA = cp * 0.055 + uCloudOff;
    vec2 uvB = cp * 0.24 + uCloudOff * 1.7 + vec2(uTime * 0.0015, uTime * 0.0009);
    vec4 nA = texture2D(uNoise, uvA);
    vec4 nB = texture2D(uNoise, uvB);
    float shape = nA.r * 0.55 + nA.b * 0.22 + nB.g * 0.13 + nB.a * 0.10;
    // Rain: more fine structure; thunderstorm: coarse shreds on top
    shape += (nB.g - 0.5) * 0.24 * stormy + (nB.a - 0.5) * (0.2 * uRain + 0.15 * uGloom);
    // Coverage -> threshold; at full coverage there are no gaps left
    float thr = mix(0.72, 0.16, uCloud);
    float soft = mix(0.16, 0.08, uCloud);
    float dens = smoothstep(thr, thr + soft, shape);
    float thick = clamp((shape - thr) / max(0.85 - thr, 0.2), 0.0, 1.0);
    // Fade out toward the horizon; in a thunderstorm the cover reaches lower (narrower bright band)
    float horizonFade = smoothstep(0.0, mix(0.09, 0.045, uGloom), dir.y);
    dens *= horizonFade;

    #ifdef CLOUD_LIGHT
      // Density toward the light source: thin = silver lining, thick = shadow
      vec2 lo = normalize(uLightDir.xz + vec2(0.0001)) * (0.3 / (max(uLightDir.y, 0.0) + 0.35)) * 0.055;
      vec4 nL = texture2D(uNoise, uvA + lo);
      float shapeL = nL.r * 0.55 + nL.b * 0.22 + nB.g * 0.13 + nB.a * 0.10;
      float dL = shapeL - shape;
      float shade = 1.0 - smoothstep(-0.14, 0.16, dL);
    #else
      float shade = 0.6;
    #endif
    float cosL = dot(dir, uLightDir);
    float fwd = hgPhase(cosL, 0.55) * 4.0 * PI;
    // The undersides of thick clouds receive hardly any direct light
    vec3 amb = uCloudAmb * mix(1.05, 0.32 - 0.14 * uGloom, thick);
    float lit = (0.12 + 0.88 * shade) * mix(1.0, 0.07, thick);
    lit += fwd * 0.1 * (1.0 - thick * 0.9);
    vec3 cloudCol = amb + uLightCol * lit;
    // Aerial perspective: distant clouds sink into the haze
    float haze = 1.0 - exp(-curve * 0.065);
    cloudCol = mix(cloudCol, clear, haze);
    dens *= 1.0 - haze * 0.35;
    // Lightning lights the clouds from within
    float hot = pow(max(dot(dir, uBoltDir), 0.0), 10.0);
    cloudCol += vec3(0.75, 0.82, 1.0) * uFlash * (0.25 + 0.55 * dens + hot * 2.0);
    col = mix(col, cloudCol, dens);
    col += vec3(0.7, 0.78, 1.0) * uFlash * 0.05;

    // ---- Lightning (bolt shape) ----
    if (uBolt > 0.001) {
      float bz = atan(dir.x, dir.z) - uBoltAz;
      bz = atan(sin(bz), cos(bz));
      float w = max(uBoltW, 0.05);
      // A distant channel is shorter and hangs lower over the horizon
      float s = (0.36 * w - dir.y) / (0.34 * w);
      if (s > 0.0 && s < 1.0 && abs(bz) < 0.3 * w) {
        float x = (sin(s * 21.0 + uBoltSeed) * 0.022 + sin(s * 57.0 + uBoltSeed * 1.7) * 0.011 + sin(s * 131.0 + uBoltSeed * 2.9) * 0.005) * w;
        x *= 0.6 + s;
        float d = abs(bz - x);
        // The core stays a hairline at any distance (it is a pixel wide
        // already); the glow around it shrinks with the channel.
        float core = exp(-d * d * 90000.0);
        float glow = exp(-d * d * 1400.0 / (w * w)) * 0.3 * w;
        // Side branch
        float sb = s - 0.35;
        float xb = x + (sb * (0.12 + 0.05 * sin(uBoltSeed)) + sin(sb * 80.0 + uBoltSeed) * 0.008) * w;
        float db = abs(bz - xb);
        float branch = exp(-db * db * 120000.0) * step(0.0, sb) * step(sb, 0.3);
        float bolt = (core * 40.0 + glow * 3.0 + branch * 22.0) * smoothstep(1.0, 0.8, s) * uBolt;
        col += vec3(0.8, 0.86, 1.0) * bolt;
      }
    }

    gl_FragColor = vec4(col, dens);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ---------------------------------------------------------------------------
// JS mirror of the atmosphere (without clouds/discs) for zenith/horizon colors
// ---------------------------------------------------------------------------

export interface SkyParams {
  sunDir: THREE.Vector3;
  moonDir: THREE.Vector3;
  betaR: THREE.Vector3;
  betaM: THREE.Vector3;
  sunE: number;
  sunTint: THREE.Color;
  mieG: number;
  skyGain: number;
  dayI: number;
  night: number;
  nightZen: THREE.Color;
  nightHor: THREE.Color;
  twAmb: number;
  twGlow: number;
  twBelt: number;
  twDepth: number;
  moonE: number;
  moonTint: THREE.Color;
}

const R_ZENITH = 8.4e3;
const M_ZENITH = 1.25e3;
// Scratch buffers for evalSky (no allocations per call)
const BR = new Float64Array(3);
const BM = new Float64Array(3);
const ST = new Float64Array(3);
const FEX = new Float64Array(3);
const RES = new Float64Array(3);

/** Henyey-Greenstein phase function (identical to hgPhase in the shader). */
export function hgPhase(c: number, g: number): number {
  const g2 = g * g;
  return ((1 / (4 * Math.PI)) * (1 - g2)) / (1 - 2 * g * c + g2) ** 1.5;
}

function mixN(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function sstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Sky radiance (linear) in direction dir – identical to the shader. */
export function evalSky(
  dx: number,
  dy: number,
  dz: number,
  p: SkyParams,
  out: THREE.Color,
): void {
  const h = Math.max(dy, 0);
  const hh = Math.exp(-h * 3.5);
  const zenithAngle = Math.acos(h);
  const inv =
    1 / (h + 0.15 * (93.885 - (zenithAngle * 180) / Math.PI) ** -1.253);
  const sR = R_ZENITH * inv;
  const sM = M_ZENITH * inv;
  const s = p.sunDir;
  const cosTheta = dx * s.x + dy * s.y + dz * s.z;
  const c = cosTheta * 0.5 + 0.5;
  const rPh = (3 / (16 * Math.PI)) * (1 + c * c);
  const mPh = hgPhase(cosTheta, p.mieG);
  const br = BR;
  const bm = BM;
  const st = ST;
  const fexA = FEX;
  br[0] = p.betaR.x;
  br[1] = p.betaR.y;
  br[2] = p.betaR.z;
  bm[0] = p.betaM.x;
  bm[1] = p.betaM.y;
  bm[2] = p.betaM.z;
  st[0] = p.sunTint.r;
  st[1] = p.sunTint.g;
  st[2] = p.sunTint.b;
  for (let i = 0; i < 3; i++) fexA[i] = Math.exp(-(br[i] * sR + bm[i] * sM));
  const fexMax = Math.max(fexA[0], fexA[1], fexA[2], 0.0001);
  const azLen = Math.hypot(dx, dz) + 1e-5;
  const sLen = Math.hypot(s.x, s.z) + 1e-5;
  const align = (dx * s.x + dz * s.z) / (azLen * sLen);
  const lowSun = (1 - sstep(0, 0.3, s.y)) * (0.5 + 0.5 * Math.max(align, 0));
  const res = RES;
  for (let i = 0; i < 3; i++) {
    const fex = fexA[i];
    const base =
      (p.sunE * st[i] * (br[i] * rPh + bm[i] * mPh)) / (br[i] + bm[i]);
    res[i] =
      base * (1 - fex) * mixN(1, (fex / fexMax) ** 0.75, lowSun) * p.skyGain;
    // Moon scattering (only the wide part; the halo is local)
    const m = p.moonDir;
    const cosM = dx * m.x + dy * m.y + dz * m.z;
    const glow = hgPhase(cosM, 0.72) * 0.38;
    const tint = i === 0 ? p.moonTint.r : i === 1 ? p.moonTint.g : p.moonTint.b;
    res[i] += tint * p.moonE * glow * (1 - fex * 0.6);
  }
  res[1] += 0.0003 * p.dayI;
  res[2] += 0.00075 * p.dayI;

  // Twilight
  const twA = p.twAmb * (0.5 + 0.5 * hh) * (1 - 0.6 * Math.max(align, 0) * hh);
  res[0] += 0.05 * twA;
  res[1] += 0.09 * twA;
  res[2] += 0.2 * twA;
  const t1 = sstep(0, 0.45, p.twDepth);
  const t2 = sstep(0.45, 1, p.twDepth);
  let gr = mixN(1.0, 0.85, t1);
  let gg = mixN(0.5, 0.24, t1);
  let gb = mixN(0.15, 0.26, t1);
  gr = mixN(gr, 0.32, t2);
  gg = mixN(gg, 0.17, t2);
  gb = mixN(gb, 0.42, t2);
  const gs = Math.max(align, 0) ** (2 + 3 * p.twDepth);
  const gv = Math.exp(-h * (5 + 12 * p.twDepth));
  const gw = gs * gv * p.twGlow;
  res[0] += gr * gw;
  res[1] += gg * gw;
  res[2] += gb * gw;
  const anti = Math.max(-align, 0) ** 1.5 * p.twBelt;
  const belt = Math.exp(-(((dy - 0.075) / 0.06) ** 2));
  const eshadow = Math.exp(-((h / 0.04) ** 2));
  res[0] += 0.45 * belt * anti * 0.45;
  res[1] += 0.22 * belt * anti * 0.45;
  res[2] += 0.32 * belt * anti * 0.45;
  const es = eshadow * anti * 0.5;
  res[0] = mixN(res[0], res[0] * 0.55, es);
  res[1] = mixN(res[1], res[1] * 0.62, es);
  res[2] = mixN(res[2], res[2] * 0.8, es);

  // Night
  res[0] += mixN(p.nightZen.r, p.nightHor.r, hh) * p.night;
  res[1] += mixN(p.nightZen.g, p.nightHor.g, hh) * p.night;
  res[2] += mixN(p.nightZen.b, p.nightHor.b, hh) * p.night;

  out.setRGB(res[0], res[1], res[2]);
}

/** Preetham sun intensity (our own, softer curve instead of the hard cut-off). */
export function sunIntensity(sunY: number): number {
  return 1000 * sstep(-0.12, 0.35, sunY) ** 1.2;
}

/** Transmittance of the atmosphere in direction dir (for the sun's light color). */
export function transmittance(
  dy: number,
  betaR: THREE.Vector3,
  betaM: THREE.Vector3,
  out: THREE.Color,
): void {
  const h = Math.max(dy, 0);
  const zenithAngle = Math.acos(h);
  const inv =
    1 / (h + 0.15 * (93.885 - (zenithAngle * 180) / Math.PI) ** -1.253);
  const sR = R_ZENITH * inv;
  const sM = M_ZENITH * inv;
  out.setRGB(
    Math.exp(-(betaR.x * sR + betaM.x * sM)),
    Math.exp(-(betaR.y * sR + betaM.y * sM)),
    Math.exp(-(betaR.z * sR + betaM.z * sM)),
  );
}
