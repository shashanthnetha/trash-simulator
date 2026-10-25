// Post-processing: building the render chain per quality tier.
//
//   ultra      : scene -> HalfFloat target with 4x MSAA -> UnrealBloom (half
//                resolution, high HDR threshold: only the sun, glitter, moon,
//                lightning, headlights) -> GradePass (ACES + sRGB + color
//                correction) to the screen
//   high       : as above with 2x MSAA
//   medium     : 2x MSAA, without bloom
//   low    : no chain – the engine renders directly (renderer.render)
//
// The scene shaders (sky, sea, rain, stars) end with the standard chunks
// tonemapping_fragment/colorspace_fragment; when rendering into a target those
// are empty, so everything lands in the buffer linearly (HDR) and is tone mapped
// only in the GradePass – no double tone mapping. If the HDR/multisample buffer
// is unavailable (old GPU without EXT_color_buffer_float), create() returns null
// and the engine renders directly; this is noted in the console once.

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { BloomPass } from "./postfx-bloom";
import { GradePass } from "./postfx-grade";
import type { Environment } from "./sky";
import type { QualityId } from "./types";

export interface PostFxTier {
  /** MSAA samples of the HDR target (clamped to capabilities.maxSamples). */
  samples: number;
  bloom: boolean;
  /** Grain amplitude (fraction of the value range). */
  grain: number;
}

// "high" runs 2x MSAA rather than 4x: the multisampled HalfFloat buffer is the
// biggest single fixed cost of the frame (measured 4.2-4.9 ms in every scene,
// of which the bloom is only 0.3-1.2 ms), and the water line is fill bound
// (86 % of the ocean's cost is fragment work). 4x stays the ultra feature.
const TIERS: Record<QualityId, PostFxTier | null> = {
  ultra: { samples: 4, bloom: true, grain: 0.02 },
  high: { samples: 2, bloom: true, grain: 0.02 },
  medium: { samples: 2, bloom: false, grain: 0.015 },
  low: null,
};

/** Bloom parameters in linear HDR (before the tone mapping). */
export const BLOOM = {
  threshold: 1.1,
  /** Soft edge of the threshold (luminance range over which the bloom fades in). */
  knee: 0.9,
  strength: 0.32,
  radius: 0.4,
  /**
   * Upper bound of the input values. Deliberately low: tiny highlights
   * (sub-pixel glitter on cans/glass, caught by MSAA) would otherwise bloom
   * into white blobs; the sun and the moon consist of many pixels and keep
   * their halo.
   */
  clampMax: 3,
};

export class PostFX {
  /** Dev: false = bypass the chain, the engine renders directly. */
  enabled = true;
  readonly tier: PostFxTier;
  readonly composer: EffectComposer;
  readonly renderPass: RenderPass;
  readonly bloom: BloomPass | null;
  readonly grade: GradePass;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.Camera;
  private readonly target: THREE.WebGLRenderTarget;
  private pixelRatio = 1;
  private width = 1;
  private height = 1;
  private readonly tmpV = new THREE.Vector2();

  /**
   * Builds the chain for the quality tier. null = no chain (low, or the
   * HDR/multisample target is unavailable).
   */
  static create(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    quality: QualityId,
  ): PostFX | null {
    const tier = TIERS[quality];
    if (!tier) return null;
    const caps = renderer.capabilities;
    if (
      !caps.isWebGL2 ||
      (!renderer.extensions.has("EXT_color_buffer_float") &&
        !renderer.extensions.has("EXT_color_buffer_half_float"))
    ) {
      console.warn(
        "PostFX: no HalfFloat render target available – rendering without post-processing.",
      );
      return null;
    }
    let fx: PostFX | null = null;
    try {
      fx = new PostFX(renderer, scene, camera, tier);
      if (!fx.framebufferOk()) {
        fx.dispose();
        console.warn(
          "PostFX: HDR/multisample framebuffer incomplete – rendering without post-processing.",
        );
        return null;
      }
      return fx;
    } catch (e) {
      fx?.dispose();
      console.warn("PostFX: setup failed – rendering directly.", e);
      return null;
    }
  }

  private constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    tier: PostFxTier,
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.tier = tier;
    const size = renderer.getDrawingBufferSize(this.tmpV);
    const w = Math.max(1, size.x);
    const h = Math.max(1, size.y);
    this.target = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      samples: Math.min(tier.samples, renderer.capabilities.maxSamples),
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.target.texture.name = "PostFX.hdr";

    this.composer = new EffectComposer(renderer, this.target);
    // Manage the sizes ourselves in device pixels (integral, like the canvas buffer)
    this.composer.setPixelRatio(1);
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    if (tier.bloom) {
      this.bloom = new BloomPass(
        new THREE.Vector2(w, h),
        BLOOM.strength,
        BLOOM.radius,
        BLOOM.threshold,
        BLOOM.knee,
        BLOOM.clampMax,
      );
      this.composer.addPass(this.bloom);
    } else {
      this.bloom = null;
    }

    this.grade = new GradePass(tier.grain, this.bloom?.texture ?? null);
    this.composer.addPass(this.grade);

    const logical = renderer.getSize(this.tmpV);
    this.pixelRatio = renderer.getPixelRatio();
    this.setSize(logical.x, logical.y);
  }

  /**
   * Checks once whether the HDR/multisample target is a complete framebuffer.
   * What is checked is the readBuffer – the only buffer the chain renders into
   * (no pass swaps; renderTarget1 stays unused).
   */
  private framebufferOk(): boolean {
    const gl = this.renderer.getContext();
    gl.getError(); // discard stale errors
    this.renderer.setRenderTarget(this.composer.readBuffer);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    const err = gl.getError();
    this.renderer.setRenderTarget(null);
    return status === gl.FRAMEBUFFER_COMPLETE && err === gl.NO_ERROR;
  }

  /** Pixel ratio including renderScale (like renderer.setPixelRatio). */
  setPixelRatio(pr: number): void {
    this.pixelRatio = pr;
    this.setSize(this.width, this.height);
  }

  /** Logical canvas size (CSS pixels); buffer = size × pixel ratio. */
  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    const w = Math.max(1, Math.floor(width * this.pixelRatio));
    const h = Math.max(1, Math.floor(height * this.pixelRatio));
    this.composer.setSize(w, h);
  }

  render(env: Environment): void {
    this.grade.update(env);
    // Dev: bloom.enabled = false -> the pass is skipped, do not add the texture
    this.grade.uniforms.uBloomAmount.value = this.bloom?.enabled ? 1 : 0;
    this.composer.render();
  }

  /**
   * Dev: HDR statistics of the current scene (linear, before the tone mapping)
   * for tuning the bloom threshold. Renders small into a float target and reads
   * the result back.
   */
  probe(scale = 0.5): {
    p50: number;
    p90: number;
    p99: number;
    max: number;
    above1: number;
    above2: number;
    aboveThreshold: number;
    nan: number;
    inf: number;
    /** Pixels above the HalfFloat maximum (they become Inf in the real buffer). */
    over65k: number;
    /** Image coordinates (0..1, origin top left) of the first NaN/Inf/>65k pixels. */
    bad: [number, number][];
  } {
    const size = this.renderer.getDrawingBufferSize(this.tmpV);
    const w = Math.max(1, Math.round(size.x * scale));
    const h = Math.max(1, Math.round(size.y * scale));
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.FloatType,
      depthBuffer: true,
    });
    const buf = new Float32Array(w * h * 4);
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(rt);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    this.renderer.setRenderTarget(prev);
    rt.dispose();
    const lum = new Float32Array(w * h);
    let above1 = 0;
    let above2 = 0;
    let aboveT = 0;
    let max = 0;
    let nan = 0;
    let inf = 0;
    let over65k = 0;
    const bad: [number, number][] = [];
    for (let i = 0; i < w * h; i++) {
      const r = buf[i * 4];
      const g = buf[i * 4 + 1];
      const b = buf[i * 4 + 2];
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const isNan = Number.isNaN(l);
      const isInf = !isNan && !Number.isFinite(l);
      const isOver = !isNan && !isInf && Math.max(r, g, b) > 65504;
      if (isNan || isInf || isOver) {
        if (isNan) nan++;
        else if (isInf) inf++;
        else over65k++;
        if (bad.length < 8)
          bad.push([
            Math.round(((i % w) / w) * 1000) / 1000,
            // readPixels returns the rows from bottom to top
            Math.round((1 - Math.floor(i / w) / h) * 1000) / 1000,
          ]);
        if (isNan || isInf) {
          lum[i] = 0;
          continue;
        }
      }
      lum[i] = l;
      if (l > 1) above1++;
      if (l > 2) above2++;
      if (l > BLOOM.threshold) aboveT++;
      if (l > max) max = l;
    }
    lum.sort();
    const n = w * h;
    return {
      p50: lum[Math.floor(n * 0.5)],
      p90: lum[Math.floor(n * 0.9)],
      p99: lum[Math.floor(n * 0.99)],
      max,
      above1: above1 / n,
      above2: above2 / n,
      aboveThreshold: aboveT / n,
      nan,
      inf,
      over65k,
      bad,
    };
  }

  dispose(): void {
    this.renderPass.dispose();
    this.bloom?.dispose();
    this.grade.dispose();
    // composer.dispose() frees renderTarget1 (= this.target) and the clone
    this.composer.dispose();
  }
}
