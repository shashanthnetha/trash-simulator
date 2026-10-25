// Color grading pass (last pass of the chain). Adds the bloom, then does
// exactly what OutputPass does – tone mapping as configured in the renderer
// (ACES) and sRGB output – and afterwards grades in display space: a gentle
// S-curve, saturation, split toning (warm highlights / cool shadows, driven by
// time of day and weather), a soft vignette and very fine animated film grain
// (which doubles as dithering against banding in the sky gradient). All in ONE
// full-screen pass: compared to OutputPass + ShaderPass this saves a pass plus
// an MSAA resolve.

import * as THREE from "three";
import {
  FullScreenQuad,
  Pass,
} from "three/examples/jsm/postprocessing/Pass.js";
import { clamp, smoothstep } from "./noise";
import type { Environment } from "./sky";

const VERT = /* glsl */ `
  precision highp float;
  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  in vec3 position;
  in vec2 uv;
  out vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform sampler2D tBloom;
  uniform float uBloomAmount;
  uniform float uAspect;
  uniform float uTime;
  uniform float uContrast;
  uniform float uSaturation;
  uniform float uVignette;
  uniform float uGrain;
  uniform vec3 uShadowTint;
  uniform vec3 uHighTint;
  #include <tonemapping_pars_fragment>
  #include <colorspace_pars_fragment>
  in vec2 vUv;
  out vec4 fragColor;
  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

  float hash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
  }

  void main() {
    vec3 s = texture(tDiffuse, vUv).rgb;
    // Inf (sun disc above the HalfFloat maximum) -> white, NaN/negative ->
    // black. Without isnan(): every comparison with NaN is false, so the else
    // branch applies. The D3D compiler is allowed to remove isnan() itself
    // under fast math (warning X3577) - the safeguard would then be useless.
    vec3 c = vec3(
      s.r >= 0.0 ? min(s.r, 65000.0) : 0.0,
      s.g >= 0.0 ? min(s.g, 65000.0) : 0.0,
      s.b >= 0.0 ? min(s.b, 65000.0) : 0.0
    );
    #ifdef BLOOM
      c += texture(tBloom, vUv).rgb * uBloomAmount;
    #endif

    // ---- Tone mapping + output color space (like OutputPass) ----
    #ifdef ACES_FILMIC_TONE_MAPPING
      c = ACESFilmicToneMapping(c);
    #elif defined(AGX_TONE_MAPPING)
      c = AgXToneMapping(c);
    #elif defined(NEUTRAL_TONE_MAPPING)
      c = NeutralToneMapping(c);
    #elif defined(REINHARD_TONE_MAPPING)
      c = ReinhardToneMapping(c);
    #elif defined(CINEON_TONE_MAPPING)
      c = CineonToneMapping(c);
    #elif defined(LINEAR_TONE_MAPPING)
      c = LinearToneMapping(c);
    #endif
    #ifdef SRGB_TRANSFER
      c = sRGBTransferOETF(vec4(c, 1.0)).rgb;
    #endif

    // ---- Grading in display space ----
    // Gentle S-curve (keeps 0 and 1 fixed, no clipping)
    c = mix(c, c * c * (3.0 - 2.0 * c), uContrast);
    float lum = dot(c, LUMA);
    c = mix(vec3(lum), c, uSaturation);
    // Split toning: cool shadows, warm highlights (multiplicative, a few percent)
    c *= mix(uShadowTint, uHighTint, smoothstep(0.1, 0.85, lum));
    // Vignette (soft, starting only from the middle of the frame)
    float d = length((vUv - 0.5) * vec2(uAspect, 1.0));
    c *= 1.0 - uVignette * smoothstep(0.4, 1.1, d);
    // Grain + dithering (slightly stronger in dark areas, as with film)
    float g = hash13(vec3(gl_FragCoord.xy, mod(uTime, 37.0) * 61.7)) - 0.5;
    c += g * (uGrain * (1.0 - 0.6 * lum) + 0.0025);
    fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
  }
`;

const WARM = new THREE.Color(1.045, 1.005, 0.94);
const COOL = new THREE.Color(0.94, 0.97, 1.06);
const RAIN_HI = new THREE.Color(0.985, 0.995, 1.02);
const WHITE = new THREE.Color(1, 1, 1);

export class GradePass extends Pass {
  readonly uniforms: Record<string, THREE.IUniform>;
  readonly material: THREE.RawShaderMaterial;
  /** Grain amplitude (fraction of the value range, 0 = off). */
  grain: number;
  /** Dev: grading off (only bloom + tone mapping + sRGB, like OutputPass). */
  grading = true;
  private readonly bloomOn: boolean;
  private readonly fsQuad: FullScreenQuad;
  private outputColorSpace: string | null = null;
  private toneMapping: THREE.ToneMapping | null = null;
  private readonly tmpC = new THREE.Color();

  /** @param bloom finished bloom texture (additive), null = no bloom. */
  constructor(grain: number, bloom: THREE.Texture | null) {
    super();
    // Renders to the screen – the composer must not swap the buffers (otherwise
    // the scene alternates between the two MSAA targets every frame).
    this.needsSwap = false;
    this.grain = grain;
    this.bloomOn = bloom !== null;
    this.uniforms = {
      tDiffuse: { value: null },
      tBloom: { value: bloom },
      uBloomAmount: { value: 1 },
      toneMappingExposure: { value: 1 },
      uAspect: { value: 16 / 9 },
      uTime: { value: 0 },
      uContrast: { value: 0.26 },
      uSaturation: { value: 1.08 },
      uVignette: { value: 0.18 },
      uGrain: { value: grain },
      uShadowTint: { value: new THREE.Color(1, 1, 1) },
      uHighTint: { value: new THREE.Color(1, 1, 1) },
    };
    this.material = new THREE.RawShaderMaterial({
      name: "GradePass",
      glslVersion: THREE.GLSL3,
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }

  setSize(width: number, height: number): void {
    this.uniforms.uAspect.value = width / Math.max(1, height);
  }

  /** Derive the look per frame from time of day and weather (deliberately subtle). */
  update(env: Environment): void {
    const u = this.uniforms;
    u.uTime.value = env.envTime;
    if (!this.grading) {
      u.uContrast.value = 0;
      u.uSaturation.value = 1;
      u.uVignette.value = 0;
      u.uGrain.value = 0;
      (u.uShadowTint.value as THREE.Color).copy(WHITE);
      (u.uHighTint.value as THREE.Color).copy(WHITE);
      return;
    }
    const sunY = env.sunDir.y;
    const day = env.dayI;
    const night = 1 - day;
    // Sun low above the horizon: golden hour
    const golden =
      smoothstep(-0.03, 0.04, sunY) * (1 - smoothstep(0.06, 0.32, sunY));
    const wet = clamp(env.rain, 0, 1);
    const overcast = smoothstep(0.5, 1, env.cloud);
    const flash = clamp(env.lightningFlash, 0, 1);

    u.uSaturation.value =
      1.08 + golden * 0.06 - night * 0.18 - wet * 0.12 - overcast * 0.04;
    u.uContrast.value = 0.26 + night * 0.06 + wet * 0.04;
    u.uVignette.value = Math.max(
      0,
      0.18 + night * 0.08 + wet * 0.05 - flash * 0.2,
    );
    u.uGrain.value = this.grain * (1 + night * 0.4);

    // Highlights: slightly warm by day, more so at golden hour; rain cool-neutral
    const hiWarm = clamp((0.35 * day + 0.65 * golden) * (1 - wet), 0, 1);
    const hi = u.uHighTint.value as THREE.Color;
    hi.copy(WHITE).lerp(WARM, hiWarm);
    this.tmpC.copy(WHITE).lerp(RAIN_HI, wet);
    hi.multiply(this.tmpC);
    // Shadows: always slightly cool, more so at night and in the rain
    const shCool = clamp(0.4 + 0.5 * night + 0.3 * wet, 0, 1);
    (u.uShadowTint.value as THREE.Color).copy(WHITE).lerp(COOL, shCool);
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    const u = this.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    u.toneMappingExposure.value = renderer.toneMappingExposure;

    // Derive the defines from the renderer settings, like OutputPass does
    if (
      this.outputColorSpace !== renderer.outputColorSpace ||
      this.toneMapping !== renderer.toneMapping
    ) {
      this.outputColorSpace = renderer.outputColorSpace;
      this.toneMapping = renderer.toneMapping;
      const d: Record<string, string> = {};
      if (this.bloomOn) d.BLOOM = "";
      if (
        THREE.ColorManagement.getTransfer(this.outputColorSpace) ===
        THREE.SRGBTransfer
      )
        d.SRGB_TRANSFER = "";
      const tm = this.toneMapping;
      if (tm === THREE.LinearToneMapping) d.LINEAR_TONE_MAPPING = "";
      else if (tm === THREE.ReinhardToneMapping) d.REINHARD_TONE_MAPPING = "";
      else if (tm === THREE.CineonToneMapping) d.CINEON_TONE_MAPPING = "";
      else if (tm === THREE.ACESFilmicToneMapping)
        d.ACES_FILMIC_TONE_MAPPING = "";
      else if (tm === THREE.AgXToneMapping) d.AGX_TONE_MAPPING = "";
      else if (tm === THREE.NeutralToneMapping) d.NEUTRAL_TONE_MAPPING = "";
      this.material.defines = d;
      this.material.needsUpdate = true;
    }

    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear)
        renderer.clear(
          renderer.autoClearColor,
          renderer.autoClearDepth,
          renderer.autoClearStencil,
        );
    }
    this.fsQuad.render(renderer);
  }

  dispose(): void {
    this.material.dispose();
    this.fsQuad.dispose();
  }
}
