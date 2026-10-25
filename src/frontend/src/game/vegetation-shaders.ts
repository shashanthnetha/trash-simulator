// GLSL building blocks for vegetation.ts (inserted into the standard three.js
// shaders via onBeforeCompile).
//
// Grass: wind in the vertex shader – a large-scale gust field (noise over world
// position and time, travelling with uWindDir), flutter per instance/blade,
// amplitude from uWind. The bending grows quadratically with the height along
// the blade while the base stays on the ground; normals are rotated along with
// it. Fragment: color gradient base→tip, dryness tint, backlight translucency.
//
// Important for the distance: under multisampling the GPU interpolates the
// varyings at the pixel center, which for sub-pixel-thin blades lies outside
// the triangle – vT (= uv.y) can then end up far outside 0..1. Unclamped, that
// produced NaN via pow(vT, 0.7) and outliers via the backlight factor, which
// the bloom blew up into white dots. All varying derivations are therefore
// clamped, and vFar damps specular/backlight with distance.

/** Uniforms, attributes and noise – for both the standard and the depth material. */
export const GRASS_VERT_PARS = /* glsl */ `
uniform float uTime;
uniform float uWind;
uniform vec2 uWindDir;
uniform float uStiff;
attribute vec4 aInst;
attribute vec4 aBlade;
float vgHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vgNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = vgHash(i);
  float b = vgHash(i + vec2(1.0, 0.0));
  float c = vgHash(i + vec2(0.0, 1.0));
  float d = vgHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
`;

/** Varyings for the visible material only. */
export const GRASS_VERT_VARYINGS = /* glsl */ `
varying float vT;
varying vec3 vTint;
varying float vDry;
varying float vFar;
`;

/** After <begin_vertex>: wind bending of the position (also in the depth material). */
export const GRASS_VERT_WIND = /* glsl */ `
float gHs = aInst.y;
float gH = max(aBlade.y * gHs, 0.05);
float gT = uv.y;
float gPhase = aInst.x;
float gSeed = aBlade.x;
transformed.y *= gHs;
#ifdef USE_INSTANCING
mat3 gRot = mat3(instanceMatrix);
vec3 gBase = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
#else
mat3 gRot = mat3(1.0);
vec3 gBase = modelMatrix[3].xyz;
#endif
float gW = uWind;
vec2 gP = gBase.xz * 0.05 - uWindDir * uTime * (1.5 + 3.5 * gW);
float gGust = vgNoise(gP) * 0.65 + vgNoise(gP * 3.1 + 7.3) * 0.35;
gGust = smoothstep(0.15, 0.85, gGust);
float gSlow = 0.03 + gW * gW * 0.95 * (0.3 + 0.7 * gGust);
float gFl = sin(uTime * (1.8 + 3.5 * gW) + gPhase * 6.2832 + gSeed * 4.0) * (0.02 + 0.12 * gW);
float gFl2 = sin(uTime * (5.0 + 6.0 * gW) + gSeed * 12.0 + gPhase * 3.0) * 0.06 * gW * gW;
// uStiff: 1 = flexible blade (marram grass), < 1 = stiff, broad leaf
float gB = (gSlow + gFl + gFl2) * gH * uStiff;
vec2 gPerp = vec2(-uWindDir.y, uWindDir.x);
vec2 gDirW = normalize(uWindDir + gPerp * (sin(uTime * 1.1 + gPhase * 7.0 + gSeed * 2.0) * 0.35 + (gSeed - 0.5) * 0.5));
vec3 gDir = normalize(transpose(gRot) * vec3(gDirW.x, 0.0, gDirW.y));
float gProf = gT * gT * 0.85 + gT * 0.15;
float gD = min(gB * gProf, 1.2 * transformed.y);
transformed.xz += gDir.xz * gD;
transformed.y -= gD * gD / (2.0 * max(transformed.y, 0.05));
// Widen distant blades so that they do not drop below one pixel in width
float gDist = distance(cameraPosition, gBase);
float gWiden = smoothstep(10.0, 140.0, gDist) * 3.0;
transformed.xz += aBlade.zw * (uv.x * 2.0 - 1.0) * gWiden * 0.028 * (1.0 - 0.6 * gT);
`;

/** Standard material only: rotate the normal along, fill the varyings. */
export const GRASS_VERT_NORMAL = /* glsl */ `
float gAng = clamp(gB * (1.7 * gT + 0.15) / gH, -1.4, 1.4);
float gSa = sin(gAng);
float gCa = cos(gAng);
vec3 gN = objectNormal;
float gNu = gN.y;
float gNd = dot(gN, gDir);
gN += gNu * (vec3(0.0, gCa - 1.0, 0.0) + gDir * gSa) + gNd * (gDir * (gCa - 1.0) - vec3(0.0, gSa, 0.0));
vNormal = normalize(normalMatrix * (gRot * gN));
vT = gT;
// Distance factor: damps specular and backlight as soon as a blade is only a
// few pixels wide (its per-pixel normal is essentially noise by then).
vFar = smoothstep(30.0, 110.0, gDist);
vDry = aInst.z;
// Color variation per tussock (gCv: 0 = blue-green/glaucous, 1 = fresh
// yellow-green) plus brightness scatter per blade. Considerably wider than
// before – without it the whole area looks like a single plant.
float gCv = aInst.w;
vTint = mix(vec3(0.86, 0.98, 1.06), vec3(1.14, 1.02, 0.86), gCv) * (0.84 + 0.32 * gSeed);
`;

export const GRASS_FRAG_PARS = /* glsl */ `
uniform vec3 uSunDir;
uniform float uBacklight;
uniform vec3 uBaseA;
uniform vec3 uBaseB;
uniform vec3 uTipA;
uniform vec3 uTipB;
varying float vT;
varying vec3 vTint;
varying float vDry;
varying float vFar;
`;

/**
 * After <color_fragment>: gradient from the base (dark olive/brown) → the tip
 * (bleached). gTc is the clamped blade parameter – pow() with a negative base
 * yields NaN, and that is exactly what happens without a clamp under MSAA
 * extrapolation.
 */
export const GRASS_FRAG_COLOR = /* glsl */ `
float gTc = clamp(vT, 0.0, 1.0);
float gFar = clamp(vFar, 0.0, 1.0);
diffuseColor.rgb *= mix(mix(uBaseA, uBaseB, vDry), mix(uTipA, uTipB, vDry), pow(gTc, 0.7)) * vTint;
`;

/**
 * After <roughnessmap_fragment>: go matte in the distance. A sub-pixel-wide
 * blade has a random normal per pixel – without this floor the specular part
 * sparkles (specular aliasing).
 */
export const GRASS_FRAG_ROUGH = /* glsl */ `
roughnessFactor = mix(roughnessFactor, 1.0, gFar);
`;

/**
 * After <lights_fragment_end>: backlight translucency + soft scattering.
 * The backlight is the brightest contribution of the grass and fades out
 * COMPLETELY with distance (1 - gFar): far away one pixel covers many blades,
 * so the backlight term used to accumulate there and handed the bloom that
 * bright band on the horizon. The specular part is faded out the same way.
 */
export const GRASS_FRAG_LIGHT = /* glsl */ `
#if ( NUM_DIR_LIGHTS > 0 )
{
  vec3 gSunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
  float gToSun = saturate(dot(-geometryViewDir, gSunV));
  float gBl = pow(gToSun, 5.0) * uBacklight * (1.0 - gFar);
  float gThin = 0.55 + 0.45 * saturate(dot(-geometryNormal, gSunV));
  reflectedLight.directDiffuse += diffuseColor.rgb * directLight.color * gBl * gThin * (0.25 + 0.75 * gTc) * 1.2;
  reflectedLight.indirectDiffuse += diffuseColor.rgb * directLight.color * 0.08 * (0.3 + 0.7 * gTc);
  reflectedLight.directSpecular *= 1.0 - 0.85 * gFar;
}
#endif
`;

/**
 * After <opaque_fragment>: safety net. Nothing negative, nothing NaN/Inf and no
 * absurdly bright value may leave the shader – the bloom would otherwise turn
 * it back into white dots. The cap moves with distance from 12 (close by, the
 * backlight is allowed to glow) to 1.0 (far away, below the bloom threshold of
 * 1.1) – distant blades therefore cannot bloom at all any more. The fog is only
 * blended in afterwards, so the horizon keeps its normal brightness.
 */
export const GRASS_FRAG_SAFE = /* glsl */ `
float gCap = mix(12.0, 1.0, gFar);
gl_FragColor.r = gl_FragColor.r >= 0.0 ? min(gl_FragColor.r, gCap) : 0.0;
gl_FragColor.g = gl_FragColor.g >= 0.0 ? min(gl_FragColor.g, gCap) : 0.0;
gl_FragColor.b = gl_FragColor.b >= 0.0 ? min(gl_FragColor.b, gCap) : 0.0;
`;

// ---------------------------------------------------------------------------
// Rocks: triplanar albedo/normal map in world coordinates, wet at the shore.
// ---------------------------------------------------------------------------

export const ROCK_VERT_PARS = /* glsl */ `
varying vec3 vRWPos;
varying vec3 vRWNormal;
`;

export const ROCK_VERT_BODY = /* glsl */ `
{
  vec4 rwp = vec4(transformed, 1.0);
  vec3 rn = objectNormal;
  #ifdef USE_INSTANCING
  rwp = instanceMatrix * rwp;
  rn = mat3(instanceMatrix) * rn;
  #endif
  rwp = modelMatrix * rwp;
  vRWPos = rwp.xyz;
  vRWNormal = normalize(mat3(modelMatrix) * rn);
}
`;

export const ROCK_FRAG_PARS = /* glsl */ `
uniform float uTime;
uniform vec3 uSkyCol;
varying vec3 vRWPos;
varying vec3 vRWNormal;
`;

/** Replaces <map_fragment>. Declares tp/bw/wetR for the chunks that follow. */
export const ROCK_FRAG_MAP = /* glsl */ `
vec3 bw = pow(abs(normalize(vRWNormal)), vec3(4.0));
bw /= (bw.x + bw.y + bw.z);
vec3 tp = vRWPos * 0.62;
vec4 sampledDiffuseColor = texture2D(map, tp.zy) * bw.x + texture2D(map, tp.xz) * bw.y + texture2D(map, tp.xy) * bw.z;
diffuseColor *= sampledDiffuseColor;
float dShoreR = vRWPos.z - shoreZf(vRWPos.x);
float reachR = waveReachF(uTime);
float wetR = 1.0 - smoothstep(reachR + 1.0, reachR + 7.0, dShoreR);
wetR = max(wetR, 1.0 - smoothstep(-0.5, 0.6, dShoreR));
wetR *= 1.0 - smoothstep(0.7, 1.7, vRWPos.y);
// Wet stone darkens, but must not turn black: together with the mirror
// roughness below, 0.48 produced coal-black lumps with a chrome spot.
diffuseColor.rgb *= mix(1.0, 0.68, wetR);
`;

/**
 * Wet = smoother, but not a mirror. 0.22 turned the single directional light
 * into a tiny, blown-out specular lobe (there is no environment map that would
 * supply the rest of the surroundings).
 */
export const ROCK_FRAG_ROUGH = /* glsl */ `
roughnessFactor = mix(roughnessFactor, 0.38, wetR);
`;

/**
 * After <lights_fragment_end>: what a wet stone lacks without an environment
 * map is the sky reflection – without it only the sun lobe on a darkened base
 * remains. `uSkyCol` is env.horizonSea (the linear dome color just above the
 * sea horizon), applied with Fresnel weighting: flanks seen at a flat angle
 * gleam wet, the top face stays matte and dark. In addition the direct specular
 * lobe is capped when wet so that it does not blow out.
 */
export const ROCK_FRAG_LIGHT = /* glsl */ `
{
  float rNv = saturate(dot(normal, geometryViewDir));
  float rF = pow(1.0 - rNv, 5.0);
  // Energy moves from the sun lobe into the broad sky reflection
  reflectedLight.directSpecular *= mix(1.0, 0.4, wetR);
  reflectedLight.directSpecular = min(reflectedLight.directSpecular, vec3(mix(64.0, 3.0, wetR)));
  reflectedLight.indirectSpecular += uSkyCol * (wetR * (0.05 + 0.5 * rF));
}
`;

/** Replaces <normal_fragment_maps>: UDN blend of three projections. */
export const ROCK_FRAG_NORMAL = /* glsl */ `
{
  vec3 tnx = texture2D(normalMap, tp.zy).xyz * 2.0 - 1.0;
  vec3 tny = texture2D(normalMap, tp.xz).xyz * 2.0 - 1.0;
  vec3 tnz = texture2D(normalMap, tp.xy).xyz * 2.0 - 1.0;
  vec3 nW = normalize(vRWNormal);
  vec3 pert = vec3(0.0, tnx.y, tnx.x) * bw.x + vec3(tny.x, 0.0, tny.y) * bw.y + vec3(tnz.x, tnz.y, 0.0) * bw.z;
  nW = normalize(nW + pert * normalScale.x * (1.0 - wetR * 0.4));
  normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
}
`;
