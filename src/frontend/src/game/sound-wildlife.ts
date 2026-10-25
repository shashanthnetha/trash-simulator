// Wildlife: gull calls (formant-filtered sawtooths with a pitch contour and
// breath noise, 1–3 syllables, positioned and distance-damped), sandpiper
// peeps by day, the wing-flutter flush of startled dune birds, crickets in the
// dunes on clear nights plus a sparse fallback scheduler (the birds themselves
// call with their real positions).

import type { AudioKit } from "./sound-core";
import {
  clamp,
  clamp01,
  filter,
  gain,
  oneShot,
  panner,
  rnd,
} from "./sound-core";

/** One gull syllable starting at time t into the collector node `out`. */
function gullSyllable(
  kit: AudioKit,
  out: AudioNode,
  t: number,
  dur: number,
  f: number,
  peak: number,
  laugh: boolean,
): void {
  const ctx = kit.ctx;
  // Pitch contour: "kee-ow" (quickly up, then falling) or a short arc
  const n = 12;
  const c1 = new Float32Array(n);
  const c2 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    let m: number;
    if (laugh) m = 1 + 0.12 * Math.sin(x * Math.PI);
    else if (x < 0.25) m = 1 + 0.18 * (x / 0.25);
    else m = 1.18 - 0.5 * ((x - 0.25) / 0.75) ** 0.8;
    c1[i] = f * m;
    c2[i] = f * m * 2.003;
  }
  const o1 = ctx.createOscillator();
  o1.type = "sawtooth";
  o1.frequency.setValueCurveAtTime(c1, t, dur);
  const o2 = ctx.createOscillator();
  o2.type = "sawtooth";
  o2.detune.value = rnd(-14, 14);
  o2.frequency.setValueCurveAtTime(c2, t, dur);
  const o2g = gain(ctx, 0.35);
  const body = gain(ctx, 1);
  o1.connect(body);
  o2.connect(o2g);
  o2g.connect(body);
  // Formants
  const f1 = filter(ctx, "bandpass", rnd(1700, 2300), 2.5);
  const f2 = filter(ctx, "bandpass", rnd(2900, 3500), 3.5);
  const f2g = gain(ctx, 0.5);
  const env = gain(ctx, 0);
  body.connect(f1);
  f1.connect(env);
  body.connect(f2);
  f2.connect(f2g);
  f2g.connect(env);
  // Breath noise
  const breath = oneShot(kit, kit.white, t, dur, 1);
  const bbp = filter(ctx, "bandpass", 2700, 1.5);
  const bg = gain(ctx, 0.2);
  breath.connect(bbp);
  bbp.connect(bg);
  bg.connect(env);
  // Envelope
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(peak, t + 0.02);
  env.gain.setTargetAtTime(peak * 0.65, t + 0.03, dur * 0.45);
  env.gain.setTargetAtTime(0.0001, t + dur - 0.05, 0.025);
  env.connect(out);
  o1.start(t);
  o1.stop(t + dur + 0.05);
  o2.start(t);
  o2.stop(t + dur + 0.05);
}

/** Gull call; pan -1..1, dist01 0 = near, 1 = far away. */
export function gullCall(kit: AudioKit, pan: number, dist01: number): void {
  const ctx = kit.ctx;
  const near = 1 - clamp01(dist01);
  const laugh = Math.random() < 0.55;
  const count = laugh ? 2 + Math.floor(Math.random() * 2) : 1;
  const total = laugh ? count * 0.45 : 0.6;
  if (!kit.voices.acquire(total)) return;
  const out = gain(ctx, 1);
  const lp = filter(ctx, "lowpass", 900 + 7000 * near ** 1.2, 0.7);
  const p = panner(ctx, clamp(pan, -1, 1));
  out.connect(lp);
  lp.connect(p);
  p.connect(kit.outdoor);
  const f0 = rnd(760, 1150);
  // The formant filters pass little of the sawtooth – near ≈ -22 dBFS, far ≈ -35
  const peak = 0.5 * (0.08 + 0.92 * near ** 1.5);
  let t = ctx.currentTime + 0.01;
  for (let k = 0; k < count; k++) {
    const dur = laugh ? rnd(0.14, 0.24) : rnd(0.3, 0.48);
    const fk = f0 * (1 - k * 0.05) * rnd(0.97, 1.03);
    const pk = peak * (k === 0 ? 1 : rnd(0.7, 0.95));
    gullSyllable(kit, out, t, dur, fk, pk, laugh);
    t += dur + rnd(0.09, 0.2);
  }
}

/** Sandpiper: 2–4 quick, high peeps with a small downward chirp. */
export function sandpiperPeeps(
  kit: AudioKit,
  pan: number,
  dist01: number,
): void {
  const ctx = kit.ctx;
  const near = 1 - clamp01(dist01);
  const count = 2 + Math.floor(Math.random() * 3);
  if (!kit.voices.acquire(count * 0.14)) return;
  const out = gain(ctx, 1);
  const lp = filter(ctx, "lowpass", 2500 + 6000 * near, 0.7);
  const p = panner(ctx, clamp(pan, -1, 1));
  out.connect(lp);
  lp.connect(p);
  p.connect(kit.outdoor);
  const peak = 0.01 + 0.18 * near ** 1.5;
  let t = ctx.currentTime + 0.01;
  for (let k = 0; k < count; k++) {
    const f = rnd(3300, 4100);
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(f, t);
    osc.frequency.exponentialRampToValueAtTime(f * 0.92, t + 0.05);
    const g = gain(ctx, 0);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    osc.connect(g);
    g.connect(out);
    osc.start(t);
    osc.stop(t + 0.06);
    t += rnd(0.075, 0.1);
  }
}

/** Cricket: high sine with ~30 Hz amplitude modulation, very quiet. */
export function cricketChirp(kit: AudioKit, pan: number): void {
  const ctx = kit.ctx;
  const dur = rnd(0.35, 0.9);
  if (!kit.voices.acquire(dur)) return;
  const t = ctx.currentTime + 0.01;
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = rnd(4100, 4700);
  const am = gain(ctx, 0.5);
  const lfo = ctx.createOscillator();
  lfo.type = "sine";
  lfo.frequency.value = rnd(24, 34);
  const lfoG = gain(ctx, 0.5);
  lfo.connect(lfoG);
  lfoG.connect(am.gain);
  const env = gain(ctx, 0);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(0.05, t + 0.04);
  env.gain.setValueAtTime(0.05, t + dur - 0.05);
  env.gain.linearRampToValueAtTime(0, t + dur);
  const p = panner(ctx, clamp(pan, -1, 1));
  osc.connect(am);
  am.connect(env);
  env.connect(p);
  p.connect(kit.outdoor);
  osc.start(t);
  osc.stop(t + dur + 0.02);
  lfo.start(t);
  lfo.stop(t + dur + 0.02);
}

/**
 * One wing-flutter layer = one bird bursting up: bandpassed noise whose
 * amplitude is modulated at the wing-beat rate (fast at lift-off, settling as
 * the bird accelerates away), with the spectrum darkening over the burst.
 */
function flutterLayer(
  kit: AudioKit,
  out: AudioNode,
  t: number,
  dur: number,
  rate: number,
  peak: number,
  bright: number,
): void {
  const ctx = kit.ctx;
  const src = oneShot(kit, kit.white, t, dur, 1);
  const bp = filter(ctx, "bandpass", 1500, 1.1);
  bp.frequency.setValueAtTime(1400 + 900 * bright, t);
  bp.frequency.exponentialRampToValueAtTime(850 + 350 * bright, t + dur);
  // Amplitude modulation = the wing beats themselves (~8–14 Hz)
  const am = gain(ctx, 0.45);
  const lfo = ctx.createOscillator();
  lfo.type = "sine";
  lfo.frequency.setValueAtTime(rate * 1.3, t);
  lfo.frequency.linearRampToValueAtTime(rate, t + dur * 0.5);
  const lfoG = gain(ctx, 0.55);
  lfo.connect(lfoG);
  lfoG.connect(am.gain);
  const env = gain(ctx, 0);
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(peak, t + 0.025);
  env.gain.setTargetAtTime(peak * 0.55, t + 0.05, dur * 0.35);
  env.gain.setTargetAtTime(0.0001, t + dur - 0.08, 0.04);
  src.connect(bp);
  bp.connect(am);
  am.connect(env);
  env.connect(out);
  lfo.start(t);
  lfo.stop(t + dur + 0.05);
}

/** One sharp little alarm note with an upward slur ("eet"). */
function alarmNote(
  kit: AudioKit,
  out: AudioNode,
  t: number,
  f0: number,
  f1: number,
  dur: number,
  peak: number,
): void {
  const ctx = kit.ctx;
  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = gain(ctx, 0);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g);
  g.connect(out);
  osc.start(t);
  osc.stop(t + dur + 0.03);
}

/**
 * Flush of a startled ground-bird flock: 2–3 staggered wing-flutter bursts
 * (amplitude-modulated filtered noise at individual wing-beat rates) plus a
 * sharp two-note alarm call. pan −1..1, dist01 0 = close / 1 = far, damped
 * with distance like `gullCall`.
 */
export function flushBurst(kit: AudioKit, pan: number, dist01: number): void {
  const ctx = kit.ctx;
  const near = 1 - clamp01(dist01);
  if (!kit.voices.acquire(1.0)) return;
  const out = gain(ctx, 1);
  const lp = filter(ctx, "lowpass", 1100 + 7800 * near ** 1.2, 0.7);
  const p = panner(ctx, clamp(pan, -1, 1));
  out.connect(lp);
  lp.connect(p);
  p.connect(kit.outdoor);
  const t0 = ctx.currentTime + 0.01;
  // A whole flock = a few flutter layers taking off within ~a tenth of a second
  const layers = 2 + Math.floor(Math.random() * 2);
  const fPeak = 0.2 * (0.1 + 0.9 * near ** 1.4);
  for (let k = 0; k < layers; k++) {
    flutterLayer(
      kit,
      out,
      t0 + k * rnd(0.05, 0.11),
      rnd(0.4, 0.6),
      rnd(8, 14),
      fPeak * (k === 0 ? 1 : rnd(0.5, 0.8)),
      Math.random(),
    );
  }
  // Alarm call over the flutter: "too-eet", the second note slurring upward
  const aPeak = 0.1 * (0.06 + 0.94 * near ** 1.5);
  const ta = t0 + rnd(0.05, 0.13);
  const fa = rnd(2400, 2900);
  alarmNote(kit, out, ta, fa, fa * 1.16, rnd(0.06, 0.09), aPeak);
  if (Math.random() < 0.75)
    alarmNote(
      kit,
      out,
      ta + rnd(0.09, 0.14),
      fa * 1.12,
      fa * 1.45,
      rnd(0.07, 0.11),
      aPeak * rnd(0.7, 1),
    );
}

// ---------------------------------------------------------------------------

export interface WildlifeInput {
  isDay: boolean;
  timeOfDay: number;
  rain01: number;
  storm01: number;
  cloud: number;
  shoreDistance: number;
  inJeep: boolean;
}

/** Sparse schedule for background animal sounds (day/night, twilight). */
export class WildlifeScheduler {
  private readonly kit: AudioKit;
  private gullT = rnd(8, 20);
  private peepT = rnd(15, 40);
  private cricketT = 2;

  constructor(kit: AudioKit) {
    this.kit = kit;
  }

  update(dt: number, inp: WildlifeInput): void {
    const tod = inp.timeOfDay;
    const dawn = tod > 5.3 && tod < 7.6;
    const dusk = tod > 17.3 && tod < 19.2;
    const calm = inp.storm01 < 0.5 && inp.rain01 < 0.35;

    // Distant gull (fallback – nearby calls come from the birds module)
    this.gullT -= dt;
    if (this.gullT <= 0) {
      this.gullT = inp.isDay
        ? rnd(18, 42) * (dawn ? 0.55 : dusk ? 1.3 : 1)
        : rnd(70, 160);
      if (calm && !inp.inJeep)
        gullCall(
          this.kit,
          rnd(-0.9, 0.9),
          inp.isDay ? rnd(0.7, 0.95) : rnd(0.88, 0.98),
        );
    }
    // Sandpipers near the water line
    this.peepT -= dt;
    if (this.peepT <= 0) {
      this.peepT = rnd(22, 55) * (dawn ? 0.6 : 1);
      if (inp.isDay && calm && inp.shoreDistance < 130 && !inp.inJeep)
        sandpiperPeeps(this.kit, rnd(-1, 1), rnd(0.35, 0.85));
    }
    // Crickets in the dunes on clear nights
    this.cricketT -= dt;
    if (this.cricketT <= 0) {
      this.cricketT = rnd(1.6, 4.5);
      if (
        !inp.isDay &&
        inp.rain01 < 0.15 &&
        inp.cloud < 0.75 &&
        inp.shoreDistance > 45 &&
        !inp.inJeep &&
        Math.random() < 0.7
      )
        cricketChirp(this.kit, rnd(-0.9, 0.9));
    }
  }
}
