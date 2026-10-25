// Shared WebAudio building blocks for the sound-*.ts modules: context + buses,
// noise buffers (seamlessly loopable), parameter smoothing without zipper
// noise, a voice limit for one-shot effects and small random helpers.

export interface AudioKit {
  readonly ctx: AudioContext;
  /** Outdoor ambience (damped inside the jeep): → ambFilter → ambBus → master. */
  readonly outdoor: GainNode;
  /** Ambience bus (the "Ambience" slider), undamped – e.g. rain on the jeep roof. */
  readonly ambBus: GainNode;
  /** Effects bus (the "Effekte" slider). */
  readonly sfxBus: GainNode;
  /** Mono white noise, 2 s, RMS 0.2. */
  readonly white: AudioBuffer;
  /** Stereo pink noise (channels uncorrelated), 4 s, RMS 0.2. */
  readonly pink: AudioBuffer;
  /** Stereo brown noise (channels uncorrelated), 5 s, RMS 0.2. */
  readonly brown: AudioBuffer;
  readonly voices: VoicePool;
}

export type NoiseKind = "white" | "pink" | "brown";

export function rnd(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Exponential smoothing with time constant tc (seconds), framerate-independent. */
export function smoothTo(
  cur: number,
  target: number,
  dt: number,
  tc: number,
): number {
  const k = 1 - Math.exp(-dt / Math.max(1e-4, tc));
  return cur + (target - cur) * k;
}

// ---------------------------------------------------------------------------
// Parameter automation

/** Ease a gain/value parameter to `v` (setTargetAtTime, no zipper noise). */
export function setT(
  ctx: AudioContext,
  p: AudioParam,
  v: number,
  tc: number,
): void {
  if (!Number.isFinite(v)) return;
  p.setTargetAtTime(v, ctx.currentTime, Math.max(0.005, tc));
}

/** Set a frequency parameter smoothly, clamped to a sensible range. */
export function setF(
  ctx: AudioContext,
  p: AudioParam,
  hz: number,
  tc: number,
): void {
  if (!Number.isFinite(hz)) return;
  const max = ctx.sampleRate * 0.45;
  p.setTargetAtTime(clamp(hz, 10, max), ctx.currentTime, Math.max(0.005, tc));
}

// ---------------------------------------------------------------------------
// Node shorthands

export function gain(ctx: AudioContext, v: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = v;
  return g;
}

export function filter(
  ctx: AudioContext,
  type: BiquadFilterType,
  freq: number,
  q = 1,
): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = clamp(freq, 10, ctx.sampleRate * 0.45);
  f.Q.value = q;
  return f;
}

/** Stereo panner (-1 left .. 1 right); falls back to a gain if unavailable. */
export function panner(ctx: AudioContext, pan: number): AudioNode {
  if (typeof ctx.createStereoPanner === "function") {
    const p = ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    return p;
  }
  return gain(ctx, 1);
}

export function panParam(node: AudioNode): AudioParam | null {
  const p = (node as StereoPannerNode).pan;
  return p instanceof AudioParam ? p : null;
}

/** Endlessly looping noise source (already started), offset to avoid correlation. */
export function loopSource(
  kit: AudioKit,
  buf: AudioBuffer,
  offsetSeconds = 0,
): AudioBufferSourceNode {
  const src = kit.ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.start(0, offsetSeconds % buf.duration);
  return src;
}

/**
 * One-shot noise source for `dur` seconds starting at `t` (random start point
 * in the buffer, loops across the seamless splice if needed).
 */
export function oneShot(
  kit: AudioKit,
  buf: AudioBuffer,
  t: number,
  dur: number,
  rate = 1,
): AudioBufferSourceNode {
  const src = kit.ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.playbackRate.value = rate;
  src.start(t, Math.random() * buf.duration * 0.95);
  src.stop(t + dur + 0.05);
  return src;
}

// ---------------------------------------------------------------------------
// Noise buffers

function fillNoise(kind: NoiseKind, d: Float32Array): void {
  if (kind === "white") {
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return;
  }
  if (kind === "brown") {
    // Leaky integrator: ~1/f² above ~150 Hz, no DC drift
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last;
    }
    return;
  }
  // Pink noise (Paul Kellet, ~1/f)
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
}

/** Generate one channel: crossfade the loop seam smooth, normalize to RMS 0.2. */
function genChannel(
  kind: NoiseKind,
  n: number,
  seam: number,
): Float32Array<ArrayBuffer> {
  const tmp = new Float32Array(n + seam);
  fillNoise(kind, tmp);
  const out = new Float32Array(n);
  for (let i = seam; i < n; i++) out[i] = tmp[i];
  // Fade the start in from the continuation past the end → continuous at the loop point
  for (let i = 0; i < seam; i++) {
    const w = i / seam;
    const s = w * w * (3 - 2 * w);
    out[i] = tmp[n + i] * (1 - s) + tmp[i] * s;
  }
  let sq = 0;
  for (let i = 0; i < n; i++) sq += out[i] * out[i];
  const rms = Math.sqrt(sq / n) || 1;
  let k = 0.2 / rms;
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]) * k);
  if (peak > 0.98) k *= 0.98 / peak;
  for (let i = 0; i < n; i++) out[i] *= k;
  return out;
}

export function makeNoiseBuffer(
  ctx: AudioContext,
  seconds: number,
  channels: number,
  kind: NoiseKind,
): AudioBuffer {
  const rate = ctx.sampleRate;
  const n = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(channels, n, rate);
  const seam = Math.floor(rate * 0.08);
  for (let ch = 0; ch < channels; ch++) {
    buf.copyToChannel(genChannel(kind, n, seam), ch);
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Voice limit for one-shot effects (prevents piles of nodes, even while the
// context is suspended: currentTime does not advance then, so nothing "expires").

export class VoicePool {
  private readonly ctx: AudioContext;
  private readonly max: number;
  private ends: number[] = [];

  constructor(ctx: AudioContext, max: number) {
    this.ctx = ctx;
    this.max = max;
  }

  /** true if one more voice is allowed for `dur` seconds. */
  acquire(dur: number): boolean {
    const now = this.ctx.currentTime;
    const alive: number[] = [];
    for (const e of this.ends) if (e > now) alive.push(e);
    this.ends = alive;
    if (alive.length >= this.max) return false;
    alive.push(now + dur);
    return true;
  }

  get active(): number {
    const now = this.ctx.currentTime;
    let n = 0;
    for (const e of this.ends) if (e > now) n++;
    return n;
  }
}
