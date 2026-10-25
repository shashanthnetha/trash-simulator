// Bloom based on UnrealBloomPass (mip chain with growing blur radii, half
// resolution), with three changes:
//   1. The brightness pass clamps the values and filters out Inf/NaN. The sun
//      disc and chrome highlights exceed the HalfFloat maximum (65504) – a
//      single Inf pixel would otherwise spread through the blur chain into a
//      black rectangle covering half the screen.
//   2. The brightness pass averages the four full-resolution pixels below it
//      with the Karis weight 1/(1+luma) ("Karis average", Unreal Engine 4).
//      That way individual, extremely bright sub-pixels – specular aliasing on
//      distant grass, sheet-metal edges, glass – lose nearly all their weight,
//      while area sources (sun, moon, lightning) stay unchanged. This is the
//      robust safeguard against "fireflies": it works no matter which material
//      produced the outlier.
//   3. The result is NOT blended back additively into the (multisampled) scene
//      buffer – that cost one full-screen pass plus a second MSAA resolve per
//      frame. Instead the GradePass adds the bloom texture (half resolution,
//      bilinear) directly.

import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

const HIGHPASS_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec3 defaultColor;
  uniform float defaultOpacity;
  uniform float luminosityThreshold;
  uniform float smoothWidth;
  uniform float clampMax;
  uniform vec2 uTexel;
  varying vec2 vUv;
  const vec3 HP_LUMA = vec3(0.2126, 0.7152, 0.0722);

  // Sort out NaN/Inf/negative without isnan(): every comparison with NaN is
  // false, so the else branch applies. The D3D compiler is allowed to optimize
  // isnan() itself away under fast math (warning X3577) - the safeguard would
  // then be useless and a single NaN pixel would become a blob via the blur.
  vec3 hpTap(vec2 uv) {
    vec3 t = texture2D(tDiffuse, uv).rgb;
    return vec3(
      t.r >= 0.0 ? min(t.r, clampMax) : 0.0,
      t.g >= 0.0 ? min(t.g, clampMax) : 0.0,
      t.b >= 0.0 ? min(t.b, clampMax) : 0.0
    );
  }

  void main() {
    // The target has half resolution: vUv sits exactly on the corner between
    // four full-resolution pixels, and ±0.5 texel hits their centers.
    vec2 o = uTexel * 0.5;
    vec3 c0 = hpTap(vUv + vec2(-o.x, -o.y));
    vec3 c1 = hpTap(vUv + vec2( o.x, -o.y));
    vec3 c2 = hpTap(vUv + vec2(-o.x,  o.y));
    vec3 c3 = hpTap(vUv + vec2( o.x,  o.y));
    float w0 = 1.0 / (1.0 + dot(c0, HP_LUMA));
    float w1 = 1.0 / (1.0 + dot(c1, HP_LUMA));
    float w2 = 1.0 / (1.0 + dot(c2, HP_LUMA));
    float w3 = 1.0 / (1.0 + dot(c3, HP_LUMA));
    vec3 c = (c0 * w0 + c1 * w1 + c2 * w2 + c3 * w3) / (w0 + w1 + w2 + w3);
    float v = dot(c, HP_LUMA);
    float alpha = smoothstep(luminosityThreshold, luminosityThreshold + smoothWidth, v);
    gl_FragColor = mix(vec4(defaultColor, defaultOpacity), vec4(c, 1.0), alpha);
  }
`;

const DIR_X = new THREE.Vector2(1, 0);
const DIR_Y = new THREE.Vector2(0, 1);

type Uniforms = Record<string, THREE.IUniform>;

export class BloomPass extends UnrealBloomPass {
  private readonly quad = new FullScreenQuad();
  private readonly oldClear = new THREE.Color();

  /**
   * @param clampMax Upper bound of the input values (linear, HDR) – also limits
   *   the halo of very bright sources.
   * @param knee Width of the soft threshold edge (luminance).
   */
  constructor(
    resolution: THREE.Vector2,
    strength: number,
    radius: number,
    threshold: number,
    knee: number,
    clampMax: number,
  ) {
    super(resolution, strength, radius, threshold);
    const hp = this.highPassUniforms as Uniforms;
    hp.smoothWidth.value = knee;
    hp.clampMax = { value: clampMax };
    hp.uTexel = {
      value: new THREE.Vector2(
        1 / Math.max(1, resolution.x),
        1 / Math.max(1, resolution.y),
      ),
    };
    this.materialHighPassFilter.fragmentShader = HIGHPASS_FRAG;
    this.materialHighPassFilter.needsUpdate = true;
  }

  /**
   * UnrealBloomPass.setSize does not update `resolution` – the texel size of the
   * input buffer (full resolution) has to be kept in sync for the Karis average
   * here.
   */
  setSize(width: number, height: number): void {
    super.setSize(width, height);
    const hp = this.highPassUniforms as Uniforms;
    // super() does not call setSize; the guard only protects against future
    // three.js versions that would (uTexel does not exist yet at that point).
    const t = hp.uTexel?.value as THREE.Vector2 | undefined;
    if (t) t.set(1 / Math.max(1, width), 1 / Math.max(1, height));
  }

  /** Finished bloom (half resolution, strength already applied) – to be added additively. */
  get texture(): THREE.Texture {
    return this.renderTargetsHorizontal[0].texture;
  }

  render(
    renderer: THREE.WebGLRenderer,
    _writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    renderer.getClearColor(this.oldClear);
    const oldAlpha = renderer.getClearAlpha();
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setClearColor(this.clearColor, 0);

    // 1. Extract the bright areas (half resolution)
    const hp = this.highPassUniforms as Uniforms;
    hp.tDiffuse.value = readBuffer.texture;
    hp.luminosityThreshold.value = this.threshold;
    this.quad.material = this.materialHighPassFilter;
    renderer.setRenderTarget(this.renderTargetBright);
    renderer.clear();
    this.quad.render(renderer);

    // 2. Mip chain: blur horizontally + vertically at each level
    let input: THREE.WebGLRenderTarget = this.renderTargetBright;
    for (let i = 0; i < this.nMips; i++) {
      const mat = this.separableBlurMaterials[i];
      this.quad.material = mat;
      mat.uniforms.colorTexture.value = input.texture;
      mat.uniforms.direction.value = DIR_X;
      renderer.setRenderTarget(this.renderTargetsHorizontal[i]);
      renderer.clear();
      this.quad.render(renderer);
      mat.uniforms.colorTexture.value = this.renderTargetsHorizontal[i].texture;
      mat.uniforms.direction.value = DIR_Y;
      renderer.setRenderTarget(this.renderTargetsVertical[i]);
      renderer.clear();
      this.quad.render(renderer);
      input = this.renderTargetsVertical[i];
    }

    // 3. Combine the mips with weights (result in renderTargetsHorizontal[0])
    this.quad.material = this.compositeMaterial;
    this.compositeMaterial.uniforms.bloomStrength.value = this.strength;
    this.compositeMaterial.uniforms.bloomRadius.value = this.radius;
    this.compositeMaterial.uniforms.bloomTintColors.value =
      this.bloomTintColors;
    renderer.setRenderTarget(this.renderTargetsHorizontal[0]);
    renderer.clear();
    this.quad.render(renderer);

    renderer.setClearColor(this.oldClear, oldAlpha);
    renderer.autoClear = oldAutoClear;
  }

  dispose(): void {
    super.dispose();
    this.quad.dispose();
  }
}
