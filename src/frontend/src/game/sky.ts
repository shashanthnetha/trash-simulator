// Sky & atmosphere: time of day, weather, lighting (sun/moon), sky dome with
// Rayleigh/Mie scattering, twilight, stars, Milky Way, textured moon, shader
// clouds, rain, lightning/thunder. Every other module (ocean, vegetation,
// birds, jeep, audio) reads its light and weather values from here.
//
// Lightning is a positional event: every strike gets an azimuth and a distance
// (400 m – 6 km), the bolt is drawn at that azimuth, the flash on the ground
// falls off with the distance, and the thunder is handed to the audio layer
// distance/343 s later – with its azimuth, so it can be panned on arrival.
//
// Render order: stars (additive, renderOrder -20) -> dome (-19, alpha = cloud
// density, fades the stars out via OneMinusSrcAlpha) -> scene.
// All colours (zenith/horizon/horizonSea/sunColor/fog/hemi) are LINEAR
// radiances before the ACES tonemapping – exactly as the dome draws them.

import * as THREE from "three";
import { clamp, lerp, smoothstep } from "./noise";
import { Rain } from "./sky-rain";
import {
  SKY_FRAG,
  SKY_VERT,
  type SkyParams,
  evalSky,
  hgPhase,
  sunIntensity,
  transmittance,
} from "./sky-shaders";
import { StarField } from "./sky-stars";
import { cloudNoiseTexture, moonTexture } from "./sky-textures";
import { terrainHeight } from "./terrain";
import type { QualityId, WeatherId } from "./types";
import { WEATHER_NAMES } from "./types";

const RAIN_COUNT: Record<QualityId, number> = {
  ultra: 4200,
  high: 3000,
  medium: 1700,
  low: 900,
};
const SPLASH_COUNT: Record<QualityId, number> = {
  ultra: 260,
  high: 200,
  medium: 120,
  low: 60,
};
const STAR_COUNT: Record<QualityId, number> = {
  ultra: 5200,
  high: 4200,
  medium: 2800,
  low: 1600,
};

// Preetham constants (as in three.js Sky)
const TOTAL_RAYLEIGH = new THREE.Vector3(
  5.804542996261093e-6,
  1.3562911419845635e-5,
  3.0265902468824876e-5,
);
const MIE_CONST = new THREE.Vector3(
  1.8399918514433978e14,
  2.7798023919660528e14,
  4.0790479543861094e14,
);
// totalMie(T) = 0.434 * (0.2 * T * 10e-18) * MIE_CONST  ->  MIE_SCALE * T * MIE_CONST
const MIE_SCALE = 8.68e-19;
const SKY_GAIN = 0.0105;
const WHITE = new THREE.Color(1, 1, 1);
const MOON_LIGHT = new THREE.Color(0.66, 0.74, 0.93);
const MOON_TINT = new THREE.Color(0.62, 0.7, 0.9);
const FLASH_COL = new THREE.Color(0.8, 0.86, 1.0);
const GROUND_TINT = new THREE.Color(0.52, 0.44, 0.33);
const SLATE_TINT = new THREE.Color(0.85, 0.91, 1.07);
/** Light under a closed deck: neutral-cool (cloud underside), not warm. */
const CLOUD_LIGHT = new THREE.Color(0.76, 0.85, 1.0);
/** Ground colour of the hemisphere light under cloud: cool grey, not sand. */
const GROUND_COOL = new THREE.Color(0.37, 0.38, 0.41);
/** Base values of the night sky light (stars, airglow, scattered light). */
const NIGHT_HEMI = 0.08;
const NIGHT_AMB = 0.024;
/**
 * Illuminance of the full moon on the ground, in units of the sun's intensity
 * (noon sun ≈ 2.5). Realistically that would be ~1/400000; ~5 % is playable.
 */
const MOON_ILLUM = 0.182;
/**
 * Moon elevation below which the intensity is no longer scaled up. The
 * intensity is illuminance / moon elevation – without this lower bound a moon
 * just above the horizon would become arbitrarily bright.
 */
const MOON_MIN = 0.22;
/** Lightning brightener of the sky (shader: col += 0.05 * uFlash * FLASH_SKY). */
const FLASH_SKY = new THREE.Color(0.7, 0.78, 1.0);
/** Speed of sound in m/s (~20 °C) – the flash → thunder delay uses it. */
const SOUND_SPEED = 343;
/** Sample direction for horizonSea: looking -Z, just above the sea horizon. */
const SEA_DIR_Y = 0.01;
const SEA_DIR_Z = -Math.sqrt(1 - SEA_DIR_Y * SEA_DIR_Y);

interface WeatherProfile {
  cloud: number;
  rain: number;
  wind: number;
  weight: number;
}

const WEATHER_PROFILES: Record<WeatherId, WeatherProfile> = {
  sunny: { cloud: 0.08, rain: 0, wind: 0.18, weight: 30 },
  partly_cloudy: { cloud: 0.38, rain: 0, wind: 0.3, weight: 26 },
  overcast: { cloud: 0.88, rain: 0, wind: 0.42, weight: 18 },
  rain: { cloud: 0.96, rain: 0.7, wind: 0.55, weight: 16 },
  storm: { cloud: 1, rain: 1, wind: 1, weight: 10 },
};

function pickWeather(rng: () => number): WeatherId {
  const ids = Object.keys(WEATHER_PROFILES) as WeatherId[];
  const total = ids.reduce((a, id) => a + WEATHER_PROFILES[id].weight, 0);
  let r = rng() * total;
  for (const id of ids) {
    r -= WEATHER_PROFILES[id].weight;
    if (r <= 0) return id;
  }
  return "sunny";
}

/**
 * Distance of a strike inside the storm cell (m). 12 % are near strikes below
 * 800 m (the ones that make you jump), the bulk sits in the 1–3 km core, the
 * rest out to 6 km at the edge of the cell.
 */
function rollStrikeDistance(): number {
  const r = Math.random();
  if (r < 0.12) return 400 + Math.random() * 400;
  if (r < 0.7) return 1000 + Math.random() * 2000;
  return 3000 + Math.random() * 3000;
}

/**
 * Azimuth of a strike (rad; the strike lies towards (sin az, ·, cos az)).
 * Full circle, but triangular-weighted around -Z: the cell sits over the sea,
 * so most bolts are in front of a player looking at the water, and the ones
 * behind still arrive correctly panned.
 */
function rollStrikeAzimuth(): number {
  return Math.PI + (Math.random() + Math.random() - 1) * 3;
}

export class Environment {
  timeOfDay: number;
  weather: WeatherId;
  cloud = 0;
  rain = 0;
  wind = 0.2;
  /** Direction TOWARDS the sun (unit vector; y < 0 = below the horizon). */
  readonly sunDir = new THREE.Vector3(0, 1, 0);
  /** Direction TOWARDS the moon (unit vector; crosses the sea side at night). */
  readonly moonDir = new THREE.Vector3(0, 1, 0);
  isDay = true;
  /** 0..1 daylight fraction (0 = deep night, 1 = full day). */
  dayI = 1;
  /** 0..1 effective moonlight (at night, attenuated by clouds). */
  moonI = 0;
  /**
   * Actual strength of the night light in units of the sun's intensity
   * (`sun.intensity`, full moon ≈ 0.18 against a noon sun of ≈ 2.5). Use this
   * value, not `moonI`, if you want to darken the scene at night.
   */
  moonLight = 0;
  /**
   * 0..1 sky light on the ground: 1 = full day, ~0.42 at sunset, then falling
   * exponentially through the twilight towards 0. Monotone in the sun's height.
   */
  skyLight = 1;
  /** 0..1 visibility of the stars (fades in/out with the twilight). */
  starI = 0;
  /** Moon phase 0..1 (0 = new moon, 0.5 = full moon); default: waxing gibbous. */
  moonPhase = 0.38;
  /**
   * 0..1 decaying lightning flash ON THE GROUND. Falls off steeply with the
   * distance of the strike: a 400 m strike lights the whole beach, a 5 km one
   * hardly reaches it (use `skyFlash` for the sky/clouds instead).
   */
  lightningFlash = 0;
  /**
   * 0..1 decaying lightning flash IN THE SKY (dome, clouds, sea horizon) –
   * falls off much more slowly than `lightningFlash`, so a distant cell still
   * lights up the whole cloud deck.
   */
  skyFlash = 0;
  /** Azimuth (rad) of the last strike: it lies towards (sin az, ·, cos az). */
  lastStrikeAz = Math.PI;
  /** Distance (m) of the last strike. */
  lastStrikeDist = 0;
  envTime = 0;
  /** Dev harness: freeze the time of day and the weather. */
  freezeTime = false;
  /** Linear sky colours (before tonemapping), as the dome shows them. */
  readonly zenith = new THREE.Color(0.1, 0.25, 0.6);
  readonly horizon = new THREE.Color(0.6, 0.7, 0.8);
  /**
   * Dome colour (linear) just above the sea horizon looking towards -Z
   * (elevation ≈ 0.01) – exactly as SKY_FRAG draws it: atmosphere, twilight
   * glow/Belt of Venus, rain gloom, cloud contribution (almost faded out there)
   * and lightning. Unlike `horizon` (an average across the sun) it contains the
   * sunset glow over the sea; the ocean reflection and the fog (fog.color) thus
   * match the dome seamlessly.
   */
  readonly horizonSea = new THREE.Color(0.6, 0.7, 0.8);
  /** Colour of the key light (sun, moon at night), linear, normalised. */
  readonly sunColor = new THREE.Color(1, 0.97, 0.92);
  /** Average cloud colour (linear) – for modules that depict clouds. */
  readonly cloudAmbient = new THREE.Color(0.5, 0.55, 0.6);

  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly ambient: THREE.AmbientLight;
  readonly fog: THREE.FogExp2;

  private targetProfile: WeatherProfile;
  private weatherTimer = 0;
  private lightningTimer = 8;
  private boltTimer = 0;
  /** Decay phase of the current flash (1 → 0); scaled per strike, see strike(). */
  private flashPhase = 0;
  private flashGround = 1;
  private flashSkyAmt = 1;
  private boltAmp = 1;
  /** Remaining return strokes of the current flash (flicker) and their timer. */
  private restrikeLeft = 0;
  private restrikeTimer = 0;
  /**
   * Thunder callback of a strike that has just been HEARD: world azimuth (rad,
   * direction (sin az, ·, cos az)) and distance in meters. Fired
   * distance/343 s after the flash.
   */
  private onThunder: (azimuth: number, distanceM: number) => void;
  /**
   * Thunder still travelling towards the listener. Several strikes can be in
   * flight at once (a 6 km one takes 17.5 s); each timer carries its own
   * azimuth and distance in its closure. Cleared in dispose().
   */
  private thunderTimers: ReturnType<typeof setTimeout>[] = [];
  private scene: THREE.Scene;

  private sky: THREE.Mesh;
  private skyMat: THREE.ShaderMaterial;
  private u: Record<string, THREE.IUniform>;
  private noiseTex: THREE.Texture;
  private moonTex: THREE.Texture;
  private stars: StarField;
  private rainFx: Rain;

  // Reused temporaries (no allocations per frame)
  private readonly betaR = new THREE.Vector3();
  private readonly betaM = new THREE.Vector3();
  private readonly nightZen = new THREE.Color();
  private readonly nightHor = new THREE.Color();
  private readonly zenithClear = new THREE.Color();
  private readonly horizonClear = new THREE.Color();
  private readonly sunHue = new THREE.Color();
  private readonly sunTint = new THREE.Color(1, 1, 1);
  private readonly tmpC = new THREE.Color();
  private readonly tmpC2 = new THREE.Color();
  private readonly ground = new THREE.Vector3();
  private readonly starMat4 = new THREE.Matrix4();
  private readonly params: SkyParams;

  constructor(
    scene: THREE.Scene,
    rng: () => number,
    onThunder: (azimuth: number, distanceM: number) => void,
    quality: QualityId = "ultra",
  ) {
    this.scene = scene;
    this.onThunder = onThunder;
    this.timeOfDay = rng() * 24;
    this.weather = pickWeather(rng);
    this.targetProfile = WEATHER_PROFILES[this.weather];
    this.cloud = this.targetProfile.cloud;
    this.rain = this.targetProfile.rain;
    this.wind = this.targetProfile.wind;

    // ---- Lights ----
    this.sun = new THREE.DirectionalLight(0xffffff, 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    // Box ±70 m around the camera (the engine moves/snaps it per frame, see
    // postfx-shadow.ts). Small depth bias + normal bias instead of a large
    // depth bias: no acne on the sand, no detaching of the contact shadows.
    this.sun.shadow.camera.left = -70;
    this.sun.shadow.camera.right = 70;
    this.sun.shadow.camera.top = 70;
    this.sun.shadow.camera.bottom = -70;
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 700;
    this.sun.shadow.bias = -0.00003;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.radius = 2;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xbfd8ee, 0xcbb287, 0.7);
    scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.12);
    scene.add(this.ambient);

    this.fog = new THREE.FogExp2(0xbfd3e0, 0.0018);
    scene.fog = this.fog;

    // ---- Textures ----
    this.noiseTex = cloudNoiseTexture(256);
    this.moonTex = moonTexture(256);

    // ---- Sky dome ----
    this.u = {
      uSunDir: { value: this.sunDir },
      uMoonDir: { value: this.moonDir },
      uBetaR: { value: this.betaR },
      uBetaM: { value: this.betaM },
      uSunE: { value: 1000 },
      uSunTint: { value: this.sunTint },
      uMieG: { value: 0.8 },
      uGloom: { value: 0 },
      uSkyGain: { value: SKY_GAIN },
      uDayI: { value: 1 },
      uNight: { value: 0 },
      uNightZen: { value: this.nightZen },
      uNightHor: { value: this.nightHor },
      uTwAmb: { value: 0 },
      uTwGlow: { value: 0 },
      uTwBelt: { value: 0 },
      uTwDepth: { value: 0 },
      uMoonE: { value: 0 },
      uMoonI: { value: 0 },
      uMoonTint: { value: MOON_TINT },
      uMoonLight: { value: new THREE.Vector3(0, 0, 1) },
      uMoonBright: { value: 1.6 },
      uMoonTex: { value: this.moonTex },
      uNoise: { value: this.noiseTex },
      uCloudOff: { value: new THREE.Vector2(rng() * 10, rng() * 10) },
      uCloud: { value: 0 },
      uRain: { value: 0 },
      uTime: { value: 0 },
      uLightDir: { value: new THREE.Vector3(0, 1, 0) },
      uLightCol: { value: new THREE.Color(1, 1, 1) },
      uCloudAmb: { value: this.cloudAmbient },
      uStarI: { value: 0 },
      uStarRot: { value: new THREE.Matrix3() },
      uFlash: { value: 0 },
      uBolt: { value: 0 },
      uBoltDir: { value: new THREE.Vector3(0, 1, 0) },
      uBoltAz: { value: Math.PI },
      uBoltSeed: { value: 0 },
      uBoltW: { value: 1 },
    };
    this.params = {
      sunDir: this.sunDir,
      moonDir: this.moonDir,
      betaR: this.betaR,
      betaM: this.betaM,
      sunE: 1000,
      sunTint: this.sunTint,
      mieG: 0.8,
      skyGain: SKY_GAIN,
      dayI: 1,
      night: 0,
      nightZen: this.nightZen,
      nightHor: this.nightHor,
      twAmb: 0,
      twGlow: 0,
      twBelt: 0,
      twDepth: 0,
      moonE: 0,
      moonTint: MOON_TINT,
    };
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      defines: quality === "low" ? {} : { CLOUD_LIGHT: "" },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      // The dome blends over the stars drawn earlier with the cloud density
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.ZeroFactor,
    });
    const segs = quality === "low" ? 28 : 40;
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(1400, segs, Math.round(segs * 0.55)),
      this.skyMat,
    );
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -19;
    scene.add(this.sky);

    // ---- Stars ----
    this.stars = new StarField(STAR_COUNT[quality]);
    scene.add(this.stars.points);

    // ---- Rain ----
    this.rainFx = new Rain(RAIN_COUNT[quality], SPLASH_COUNT[quality]);
    scene.add(this.rainFx.mesh);
    scene.add(this.rainFx.splashes);
  }

  weatherName(): string {
    return WEATHER_NAMES[this.weather];
  }

  /** Desaturate and dim a colour under rain/storm as the shader does (in place). */
  private gloomDim(c: THREE.Color, gloom: number): void {
    const l = c.r * 0.3 + c.g * 0.5 + c.b * 0.2;
    this.tmpC.setRGB(l, l, l);
    c.lerp(this.tmpC, gloom * 0.6).multiplyScalar(1 - gloom * 0.85);
  }

  /** Set the weather directly (immediate = no transition), e.g. for the dev harness. */
  setWeather(id: WeatherId, immediate = true): void {
    this.weather = id;
    this.targetProfile = WEATHER_PROFILES[id];
    this.weatherTimer = 180 + Math.random() * 240;
    if (immediate) {
      this.cloud = this.targetProfile.cloud;
      this.rain = this.targetProfile.rain;
      this.wind = this.targetProfile.wind;
    }
  }

  update(dt: number, camPos: THREE.Vector3): void {
    this.envTime += dt;
    if (!this.freezeTime) {
      // A full day in 36 minutes
      this.timeOfDay = (this.timeOfDay + dt * (24 / (36 * 60))) % 24;
      this.weatherTimer -= dt;
      if (this.weatherTimer <= 0) {
        this.weatherTimer = 180 + Math.random() * 240;
        this.weather = pickWeather(Math.random);
        this.targetProfile = WEATHER_PROFILES[this.weather];
      }
    }
    const t = this.timeOfDay;
    const u = this.u;

    // ---- Sun / moon ----
    const elev = Math.sin(((t - 6) / 24) * Math.PI * 2);
    const azim = Math.PI * ((t - 6) / 12);
    this.sunDir
      .set(Math.cos(azim), elev, -0.42 - 0.2 * Math.sin(azim))
      .normalize();
    this.isDay = elev > -0.06;
    // Moon: same arc, offset by 12 h, a little flatter – over the sea
    const tm = (t + 12) % 24;
    const elevM = Math.sin(((tm - 6) / 24) * Math.PI * 2) * 0.82;
    const azimM = Math.PI * ((tm - 6) / 12);
    this.moonDir
      .set(Math.cos(azimM) * 1.05, elevM, -0.5 - 0.18 * Math.sin(azimM))
      .normalize();

    // ---- Weather transitions ----
    const k = Math.min(1, dt * 0.12);
    this.cloud = lerp(this.cloud, this.targetProfile.cloud, k);
    this.rain = lerp(this.rain, this.targetProfile.rain, k);
    this.wind = lerp(this.wind, this.targetProfile.wind, k);
    const cloud = this.cloud;
    const rain = this.rain;
    const sunY = this.sunDir.y;
    const dayI = smoothstep(-0.04, 0.16, sunY);
    this.dayI = dayI;
    // Ground flash (lights/scene) and sky flash (dome/clouds/sea horizon) are
    // two different curves over the strike distance – see strike().
    const flash = this.lightningFlash;
    const flashSky = this.skyFlash;

    // ---- Atmosphere parameters ----
    const turb = 2.2 + cloud * 4.5 + rain * 5;
    const rayleigh = 1.25 + cloud * 0.6;
    const mie = 0.004 + cloud * 0.014 + rain * 0.02;
    this.betaR.copy(TOTAL_RAYLEIGH).multiplyScalar(rayleigh);
    this.betaM.copy(MIE_CONST).multiplyScalar(MIE_SCALE * turb * mie);
    const sunE = sunIntensity(sunY);
    const mieG = 0.8 - cloud * 0.12;
    const cloudMute = 1 - cloud * 0.75;
    // Gloom: rain darkens, a storm markedly so (slate grey)
    const storm = smoothstep(0.72, 1.0, rain);
    const gloom = clamp(rain * 0.55 + storm * 0.35, 0, 0.9);
    // Sunlight transmittance: hue of the light and tint of the in-scattering
    transmittance(sunY, this.betaR, this.betaM, this.tmpC);
    const mx = Math.max(this.tmpC.r, this.tmpC.g, this.tmpC.b, 1e-4);
    this.sunHue
      .setRGB(this.tmpC.r / mx, this.tmpC.g / mx, this.tmpC.b / mx)
      .lerp(WHITE, 0.25);
    this.sunTint.setRGB(
      1 - 0.85 * (1 - Math.sqrt(this.tmpC.r)),
      1 - 0.85 * (1 - Math.sqrt(this.tmpC.g)),
      1 - 0.85 * (1 - Math.sqrt(this.tmpC.b)),
    );
    const twAmb =
      smoothstep(-0.32, -0.02, sunY) * (1 - smoothstep(0.0, 0.28, sunY));
    const twGlow =
      smoothstep(-0.27, -0.04, sunY) *
      (1 - smoothstep(0.0, 0.2, sunY)) *
      cloudMute;
    const twBelt =
      smoothstep(-0.13, -0.05, sunY) *
      (1 - smoothstep(-0.02, 0.05, sunY)) *
      cloudMute;
    const twDepth = clamp(-sunY / 0.25, 0, 1);
    const night = 1 - smoothstep(-0.3, -0.02, sunY);
    const rainDark = 1 - rain * 0.45;
    this.nightZen.setRGB(0.012, 0.018, 0.042).multiplyScalar(rainDark);
    this.nightHor.setRGB(0.024, 0.032, 0.058).multiplyScalar(rainDark);

    // Stars & moon
    const starI =
      (1 - smoothstep(-0.2, -0.05, sunY)) * (1 - smoothstep(0.8, 1, cloud));
    const moonUp = smoothstep(-0.03, 0.08, this.moonDir.y);
    const moonVis = moonUp * (1 - smoothstep(-0.1, 0.03, sunY));
    this.starI = starI * (1 - moonVis * 0.2);
    this.moonI = moonVis * (1 - cloud * 0.85) * (1 - rain * 0.3);
    const moonE = 0.07 * moonVis;

    // ---- Uniforms / mirrored parameters ----
    const p = this.params;
    p.sunE = sunE;
    p.mieG = mieG;
    p.dayI = dayI;
    p.night = night;
    p.twAmb = twAmb;
    p.twGlow = twGlow;
    p.twBelt = twBelt;
    p.twDepth = twDepth;
    p.moonE = moonE;
    u.uSunE.value = sunE;
    u.uMieG.value = mieG;
    u.uDayI.value = dayI;
    u.uNight.value = night;
    u.uTwAmb.value = twAmb;
    u.uTwGlow.value = twGlow;
    u.uTwBelt.value = twBelt;
    u.uTwDepth.value = twDepth;
    u.uMoonE.value = moonE;
    u.uMoonI.value = moonVis;
    u.uGloom.value = gloom;
    u.uStarI.value = this.starI;
    u.uCloud.value = cloud;
    u.uRain.value = rain;
    u.uTime.value = this.envTime;
    const phaseAng = (0.5 - this.moonPhase) * Math.PI * 2;
    (u.uMoonLight.value as THREE.Vector3)
      .set(Math.sin(phaseAng), 0.12, Math.cos(phaseAng))
      .normalize();

    // Star rotation around the celestial pole (one revolution per day)
    const starAngle = (t / 24) * Math.PI * 2 + 1.3;
    this.stars.update(this.envTime, starAngle, this.starI, camPos);
    this.starMat4.makeRotationFromQuaternion(this.stars.points.quaternion);
    (u.uStarRot.value as THREE.Matrix3)
      .setFromMatrix4(this.starMat4)
      .transpose();

    // Cloud drift with the wind
    const drift = (0.0005 + this.wind * 0.0022) * dt;
    const off = u.uCloudOff.value as THREE.Vector2;
    off.x += drift * 0.94;
    off.y += drift * 0.34;

    // ---- Sky colours (JS mirror of the shader) ----
    evalSky(0, 1, 0, p, this.zenithClear);
    const sl = Math.hypot(this.sunDir.x, this.sunDir.z) + 1e-5;
    evalSky(
      -this.sunDir.z / sl,
      0.02,
      this.sunDir.x / sl,
      p,
      this.horizonClear,
    );
    this.tmpC.copy(WHITE).lerp(SLATE_TINT, storm);
    this.cloudAmbient
      .copy(this.zenithClear)
      .lerp(this.horizonClear, 0.55)
      .multiplyScalar((1 - rain * 0.55) * (1 - storm * 0.6))
      .multiply(this.tmpC);
    // Clouds are more neutral than the blue sky: desaturate them halfway
    const cl =
      this.cloudAmbient.r * 0.3 +
      this.cloudAmbient.g * 0.5 +
      this.cloudAmbient.b * 0.2;
    this.tmpC.setRGB(cl, cl, cl);
    this.cloudAmbient.lerp(this.tmpC, 0.55);
    // Clear sky dimmed and desaturated under rain/storm (as in the shader)
    this.gloomDim(this.zenithClear, gloom);
    this.gloomDim(this.horizonClear, gloom);
    const cloudMix = smoothstep(0.2, 0.9, cloud);
    this.tmpC.copy(this.cloudAmbient).multiplyScalar(0.72);
    this.zenith.copy(this.zenithClear).lerp(this.tmpC, cloudMix);
    this.horizon
      .copy(this.horizonClear)
      .lerp(this.cloudAmbient, cloudMix * 0.6);

    // ---- Sunlight ----
    const sunUp = smoothstep(-0.03, 0.06, sunY);
    // Closed cloud deck: hardly any direct light left, and what remains is the
    // light of the cloud underside (neutral) instead of the warm transmittance
    const overcast = smoothstep(0.45, 0.98, cloud);
    // Clouds and rain take away the direct light; in a storm practically no
    // sun is left (no shadows, only scattered light)
    const weatherDim = clamp(
      (1 - cloud * 0.8 - rain * 0.15) *
        (1 - storm * 0.7) *
        (1 - overcast * 0.45),
      0.015,
      1,
    );
    const sunI =
      2.7 * (0.35 + 0.65 * smoothstep(0, 0.45, sunY)) * sunUp * weatherDim;
    // Sky light on the ground as ONE monotonically falling curve over the
    // sun's height: above the horizon it follows the height, below it an
    // exponentially decaying twilight. Previously dayI dropped to 0 at sunset
    // already and the ground light jumped straight to the night floor.
    const twiNorm = Math.exp(-Math.max(0, -sunY) / 0.145);
    const skyLevel =
      sunY >= 0 ? 0.52 + 0.48 * smoothstep(0, 0.16, sunY) : 0.52 * twiNorm;
    this.skyLight = skyLevel;
    const night01 = 1 - dayI;
    // Night level: keeps falling slightly from early night into deep night
    const nightLevel = 0.68 + 0.32 * smoothstep(-0.95, -0.3, sunY);
    // The moonlight fades in exactly as the twilight fades out – so the sum
    // falls monotonically from twilight to midnight. What is controlled is the
    // illuminance on the ground, not the intensity: otherwise midnight (moon
    // high) would be brighter than the early night.
    const moonIllum =
      MOON_ILLUM *
      moonUp *
      (1 - twiNorm) *
      nightLevel *
      (1 - cloud * 0.8) *
      (1 - rain * 0.3);
    const moonLightI = moonIllum / Math.max(this.moonDir.y, MOON_MIN);
    this.moonLight = moonLightI;
    if (this.isDay) {
      this.sun.color.copy(this.sunHue).lerp(CLOUD_LIGHT, overcast * 0.9);
      this.sun.intensity = sunI + flash * 1.5;
      this.sun.position.copy(this.sunDir).multiplyScalar(420).add(camPos);
    } else {
      this.sun.color.copy(MOON_LIGHT);
      this.sun.intensity = moonLightI + flash * 2;
      this.sun.position.copy(this.moonDir).multiplyScalar(420).add(camPos);
    }
    this.sun.target.position.copy(camPos);
    this.sunColor.copy(this.sun.color);

    // Cloud lighting: the sun, and the moon once the sun is below the horizon
    const lightCol = u.uLightCol.value as THREE.Color;
    const lightDir = u.uLightDir.value as THREE.Vector3;
    if (sunUp > 0.01) {
      lightDir.copy(this.sunDir);
      lightCol
        .copy(this.sunHue)
        .multiplyScalar(1.5 * sunUp * (1 - rain * 0.65) * (1 - storm * 0.75));
    } else {
      lightDir.copy(this.moonDir);
      lightCol.copy(MOON_TINT).multiplyScalar(0.12 * moonVis);
    }

    // ---- Hemisphere / ambient / fog ----
    this.hemi.color.copy(this.zenith).lerp(this.horizon, 0.35);
    const hm = Math.max(
      this.hemi.color.r,
      this.hemi.color.g,
      this.hemi.color.b,
      1e-4,
    );
    this.hemi.color.multiplyScalar(1 / hm).lerp(WHITE, 0.2);
    // Under a closed deck cool and desaturated instead of warm white
    this.hemi.color.lerp(CLOUD_LIGHT, overcast * 0.85);
    this.hemi.color.lerp(FLASH_COL, Math.min(1, flash));
    this.hemi.groundColor
      .copy(GROUND_TINT)
      .lerp(GROUND_COOL, overcast * 0.75)
      .multiplyScalar(0.3 + 0.7 * dayI * (1 - cloud * 0.35));
    // Cloud cover scatters more light but does not give back the energy it
    // took from the sun (previously: + cloud * 0.3 – which kept the sand as
    // bright as by day). Rain lowers the diffuse share, a storm markedly so.
    this.hemi.intensity =
      night01 * nightLevel * (NIGHT_HEMI + moonVis * 0.05) +
      skyLevel *
        (0.7 + cloud * 0.12) *
        (1 - overcast * 0.22) *
        (1 - rain * 0.26) *
        (1 - storm * 0.28) +
      flash * 3;
    this.ambient.intensity =
      night01 * nightLevel * NIGHT_AMB +
      skyLevel * 0.145 * (1 - gloom * 0.4) * (1 - storm * 0.35) +
      flash * 2;

    // ---- Horizon over the sea (JS mirror of the dome towards -Z) ----
    // Atmosphere + twilight terms (evalSky), gloom, then the cloud share that
    // is almost faded out there (average cloud: thickness 0.45, half in shadow,
    // with haze towards the clear colour) and the lightning brightener.
    evalSky(0, SEA_DIR_Y, SEA_DIR_Z, p, this.horizonSea);
    this.gloomDim(this.horizonSea, gloom);
    const curve = 1 / (SEA_DIR_Y + lerp(0.11, 0.075, gloom));
    const haze = 1 - Math.exp(-curve * 0.065);
    const seaDens =
      cloudMix *
      smoothstep(0, lerp(0.09, 0.045, gloom), SEA_DIR_Y) *
      (1 - haze * 0.35);
    const cosL = SEA_DIR_Y * lightDir.y + SEA_DIR_Z * lightDir.z;
    const seaLit =
      0.56 * lerp(1, 0.07, 0.45) +
      hgPhase(cosL, 0.55) * 4 * Math.PI * 0.1 * (1 - 0.45 * 0.9);
    this.tmpC.copy(lightCol).multiplyScalar(seaLit);
    this.tmpC2
      .copy(this.cloudAmbient)
      .multiplyScalar(lerp(1.05, 0.32 - 0.14 * gloom, 0.45))
      .add(this.tmpC)
      .lerp(this.horizonSea, haze);
    this.horizonSea.lerp(this.tmpC2, seaDens);
    if (flashSky > 0) {
      this.tmpC.copy(FLASH_SKY).multiplyScalar(flashSky * 0.05);
      this.horizonSea.add(this.tmpC);
    }
    // Fog = dome colour at the sea horizon: terrain fog, the coastal strip of
    // the ocean and the dome meet there seamlessly (in the sunset glow too)
    this.fog.color.copy(this.horizonSea);
    this.fog.density =
      0.0012 + cloud * 0.0012 + rain * 0.0034 + storm * 0.001 + night * 0.0005;

    // ---- The dome follows the camera ----
    this.sky.position.copy(camPos);

    // ---- Rain ----
    this.tmpC.copy(lightCol).multiplyScalar(0.08);
    this.tmpC2
      .copy(this.horizon)
      .multiplyScalar(0.9)
      .add(this.tmpC)
      .addScalar(0.05);
    if (rain > 0.02) {
      // Ground height + slope below the camera for the splashes
      const cx = camPos.x;
      const cz = camPos.z;
      this.ground.set(
        terrainHeight(cx, cz),
        (terrainHeight(cx + 2, cz) - terrainHeight(cx - 2, cz)) / 4,
        (terrainHeight(cx, cz + 2) - terrainHeight(cx, cz - 2)) / 4,
      );
    }
    this.rainFx.update(
      this.envTime,
      camPos,
      rain,
      this.wind,
      this.tmpC2,
      this.ground,
    );

    // ---- Lightning and thunder during a storm ----
    // One decay phase, two brightness curves (ground / sky) per strike.
    this.flashPhase = Math.max(0, this.flashPhase - dt * 6);
    this.lightningFlash = this.flashPhase * this.flashGround;
    this.skyFlash = this.flashPhase * this.flashSkyAmt;
    this.boltTimer = Math.max(0, this.boltTimer - dt);
    u.uFlash.value = this.skyFlash;
    u.uBolt.value =
      this.boltTimer > 0
        ? Math.min(1, this.boltTimer * 9) *
          (0.55 + 0.45 * Math.sin(this.envTime * 95)) *
          this.boltAmp
        : 0;
    // Return strokes: the channel re-ignites a few times, 50–160 ms apart –
    // that flicker is what makes a flash read as lightning and not as a lamp.
    if (this.restrikeLeft > 0) {
      this.restrikeTimer -= dt;
      if (this.restrikeTimer <= 0) {
        this.restrikeLeft--;
        this.restrikeTimer = 0.05 + Math.random() * 0.11;
        this.flashPhase = Math.max(
          this.flashPhase,
          0.55 + Math.random() * 0.45,
        );
        this.boltTimer = 0.16;
        u.uBoltSeed.value = Math.random() * 100;
      }
    }
    if (this.weather === "storm") {
      this.lightningTimer -= dt;
      if (this.lightningTimer <= 0) {
        this.lightningTimer = 7 + Math.random() * 14;
        this.strike(rollStrikeAzimuth(), rollStrikeDistance());
      }
    }
  }

  /**
   * One lightning strike at `azimuth` (rad, towards (sin az, ·, cos az)) and
   * `distanceM` meters away: bolt + flash now, thunder in distance/343 s. The
   * pending thunder carries its own azimuth and distance, so several strikes
   * can be in flight at once and each one is placed and filtered on arrival.
   */
  private strike(azimuth: number, distanceM: number): void {
    const u = this.u;
    const d = clamp(distanceM, 150, 12000);
    // Normalise to (-pi, pi] so the shader's atan() window matches
    const az = Math.atan2(Math.sin(azimuth), Math.cos(azimuth));
    this.lastStrikeAz = az;
    this.lastStrikeDist = d;
    // Ground light falls off steeply (~1/r^1.35): 400 m floods the beach,
    // 3 km is a faint wash, 5 km does not reach the sand at all.
    this.flashGround = clamp((700 / d) ** 1.35, 0.02, 1);
    // The sky keeps much more: even a distant cell lights the cloud deck.
    this.flashSkyAmt = clamp((2200 / d) ** 0.55, 0.25, 1);
    this.flashPhase = 1;
    this.lightningFlash = this.flashGround;
    this.skyFlash = this.flashSkyAmt;
    this.boltTimer = 0.22;
    this.restrikeLeft = Math.random() < 0.5 ? (Math.random() < 0.3 ? 2 : 1) : 0;
    this.restrikeTimer = 0.05 + Math.random() * 0.11;
    // Bolt: further away = shorter, narrower, lower over the horizon, dimmer
    const w = clamp(1.15 - 0.62 * Math.log10(d / 400), 0.3, 1);
    this.boltAmp = clamp((1200 / d) ** 0.5, 0.25, 1.3);
    u.uBoltAz.value = az;
    u.uBoltW.value = w;
    u.uBoltSeed.value = Math.random() * 100;
    (u.uBoltDir.value as THREE.Vector3)
      .set(Math.sin(az), 0.06 + 0.24 * w, Math.cos(az))
      .normalize();
    const id = setTimeout(
      () => {
        const i = this.thunderTimers.indexOf(id);
        if (i >= 0) this.thunderTimers.splice(i, 1);
        this.onThunder(az, d);
      },
      (d / SOUND_SPEED) * 1000,
    );
    this.thunderTimers.push(id);
  }

  /**
   * Dev harness only (stripped from the production build): fire a strike with
   * an exact azimuth and distance and report what it scheduled.
   */
  debugStrike(
    azimuth: number,
    distanceM: number,
  ): {
    azimuth: number;
    distance: number;
    delayMs: number;
    flashGround: number;
    flashSky: number;
    boltW: number;
    pending: number;
  } | null {
    if (!import.meta.env.DEV) return null;
    this.strike(azimuth, distanceM);
    return {
      azimuth: this.lastStrikeAz,
      distance: this.lastStrikeDist,
      delayMs: (this.lastStrikeDist / SOUND_SPEED) * 1000,
      flashGround: this.flashGround,
      flashSky: this.flashSkyAmt,
      boltW: this.u.uBoltW.value as number,
      pending: this.thunderTimers.length,
    };
  }

  dispose(): void {
    // Otherwise thunder still in flight (up to 17.5 s for 6 km) would arrive
    // after teardown, with no scene left to belong to.
    for (const id of this.thunderTimers) clearTimeout(id);
    this.thunderTimers.length = 0;
    const s = this.scene;
    s.remove(this.sun, this.sun.target, this.hemi, this.ambient);
    s.remove(
      this.sky,
      this.stars.points,
      this.rainFx.mesh,
      this.rainFx.splashes,
    );
    if (s.fog === this.fog) s.fog = null;
    this.sky.geometry.dispose();
    this.skyMat.dispose();
    this.noiseTex.dispose();
    this.moonTex.dispose();
    this.stars.dispose();
    this.rainFx.dispose();
  }
}
