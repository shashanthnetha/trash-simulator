// Companions: the dog's bark (formant synthesis, positional, weather-damped)
// and the drone's continuous multirotor loop (four detuned blade-pass tones
// with slow beating, a band-passed buzz and a soft rotor wash).
//
// Both are placed in the world: StereoPanner from `pan`, gain + lowpass from
// `dist01`. Wind and storm add a second layer of attenuation, so a bark or a
// drone at mid distance disappears under the surf during bad weather.

import type { AudioKit } from "./sound-core";
import {
  clamp,
  clamp01,
  filter,
  gain,
  loopSource,
  oneShot,
  panParam,
  panner,
  rnd,
  setF,
  setT,
  smoothTo,
} from "./sound-core";

/** Weather state the positional companion sounds are damped with. */
export interface CompanionEnv {
  /** 0..1 wind strength. */
  wind01: number;
  /** 0..1 storm intensity. */
  storm01: number;
}

// ---------------------------------------------------------------------------
// Dog bark

/**
 * One bark syllable into the collector node `out`.
 * Voiced source: sawtooth at f0 (180–320 Hz) plus an octave, run through three
 * formant bandpasses (~700 Hz body, ~1.6 kHz bite, ~2.8 kHz edge); a chest sine
 * an octave down; a 25 ms noise transient for the plosive onset.
 */
function barkSyllable(
  kit: AudioKit,
  out: AudioNode,
  t: number,
  f0: number,
  dur: number,
  peak: number,
): void {
  const ctx = kit.ctx;
  // Pitch contour: short rise into the attack (116 % after 12 % of the length),
  // then the quick drop to 70 % that makes a bark read as a bark.
  const n = 16;
  const c1 = new Float32Array(n);
  const c2 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    const m =
      x < 0.12
        ? 1 + 0.16 * (x / 0.12)
        : 1.16 - 0.46 * ((x - 0.12) / 0.88) ** 0.7;
    c1[i] = f0 * m;
    c2[i] = f0 * m * 2.004;
  }
  const o1 = ctx.createOscillator();
  o1.type = "sawtooth";
  o1.frequency.setValueCurveAtTime(c1, t, dur);
  const o2 = ctx.createOscillator();
  o2.type = "sawtooth";
  o2.detune.value = rnd(-12, 12);
  o2.frequency.setValueCurveAtTime(c2, t, dur);
  const o2g = gain(ctx, 0.4);
  const body = gain(ctx, 1);
  o1.connect(body);
  o2.connect(o2g);
  o2g.connect(body);

  // Vocal roughness: 30–48 Hz amplitude modulation on the source (±15 %)
  const rough = gain(ctx, 0.85);
  const rlfo = ctx.createOscillator();
  rlfo.type = "sine";
  rlfo.frequency.value = rnd(30, 48);
  const rlfoG = gain(ctx, 0.15);
  rlfo.connect(rlfoG);
  rlfoG.connect(rough.gain);
  body.connect(rough);

  const env = gain(ctx, 0.0001);
  const formant = (hz: number, q: number, level: number): void => {
    const f = filter(ctx, "bandpass", hz, q);
    const fg = gain(ctx, level);
    rough.connect(f);
    f.connect(fg);
    fg.connect(env);
  };
  formant(rnd(620, 830), 3.2, 1);
  formant(rnd(1350, 1900), 4.5, 0.6);
  formant(rnd(2400, 3200), 3, 0.16);

  // Chest: an octave below f0, sagging with the pitch drop
  const chest = ctx.createOscillator();
  chest.type = "sine";
  chest.frequency.setValueAtTime(f0 * 0.5, t);
  chest.frequency.exponentialRampToValueAtTime(f0 * 0.36, t + dur);
  const chestG = gain(ctx, 0.22);
  chest.connect(chestG);
  chestG.connect(env);

  // Noisy onset transient (the plosive "b"), 3 kHz → 900 Hz in 30 ms
  const nz = oneShot(kit, kit.white, t, 0.03, 1);
  const nbp = filter(ctx, "bandpass", 3000, 1.1);
  nbp.frequency.setValueAtTime(3000, t);
  nbp.frequency.exponentialRampToValueAtTime(900, t + 0.03);
  const ng = gain(ctx, 0);
  ng.gain.setValueAtTime(peak * 0.55, t);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
  nz.connect(nbp);
  nbp.connect(ng);
  ng.connect(out);

  // Envelope: 6 ms attack, fast decay to 45 %, then the tail
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(peak, t + 0.006);
  env.gain.exponentialRampToValueAtTime(peak * 0.45, t + 0.04);
  env.gain.setTargetAtTime(0.0001, t + 0.05, dur * 0.3);
  env.gain.setTargetAtTime(0.0001, t + dur, 0.01);
  env.connect(out);

  const stop = t + dur + 0.06;
  o1.start(t);
  o1.stop(stop);
  o2.start(t);
  o2.stop(stop);
  chest.start(t);
  chest.stop(stop);
  rlfo.start(t);
  rlfo.stop(stop);
}

/**
 * Dog bark, 1–2 syllables with randomised pitch, length and formants so two
 * consecutive barks never sound the same. pan −1..1, dist01 0 = right next to
 * you, 1 ≈ 60 m. Routed through `outdoor` (so the jeep damps it like any other
 * world sound). Returns the level/brightness it decided on (diagnostics).
 */
export function dogBarkSfx(
  kit: AudioKit,
  pan: number,
  dist01: number,
  env: CompanionEnv,
): Record<string, number> {
  const ctx = kit.ctx;
  const near = 1 - clamp01(dist01);
  const storm = clamp01(env.storm01);
  const wind = clamp01(env.wind01);
  // Wind and surf mask the bark: distance bites harder (steeper exponent) and
  // the highs go first – in a storm a bark from 30 m is only just there.
  const reach = near ** (1.5 + 1.3 * storm + 0.35 * wind);
  const wx = Math.max(0.12, 1 - 0.58 * storm - 0.2 * wind);
  // The formant filters only pass a part of the sawtooth: an envelope peak of
  // 1.0 measures ≈ 0.24 (−12 dBFS) at the master, roughly twice the peak of
  // calm surf – a bark right next to you is meant to make you jump.
  const peak = (0.02 + 0.98 * reach) * wx;
  const lpHz = (560 + 7400 * near ** 1.15) * (1 - 0.45 * storm - 0.12 * wind);
  const count = Math.random() < 0.55 ? 2 : 1;
  const stats = { peak, lpHz: Math.round(lpHz), syllables: count, played: 0 };
  if (!kit.voices.acquire(count * 0.32)) return stats;
  stats.played = 1;

  const out = gain(ctx, 1);
  const lp = filter(ctx, "lowpass", lpHz, 0.7);
  const p = panner(ctx, clamp(pan, -1, 1));
  out.connect(lp);
  lp.connect(p);
  p.connect(kit.outdoor);

  const f0 = rnd(185, 315);
  let t = ctx.currentTime + 0.01;
  for (let k = 0; k < count; k++) {
    const dur = rnd(0.085, 0.16);
    const fk = f0 * (k === 0 ? 1 : rnd(0.84, 1.02));
    const pk = peak * (k === 0 ? 1 : rnd(0.55, 0.9));
    barkSyllable(kit, out, t, fk, dur, pk);
    t += dur + rnd(0.07, 0.15);
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Drone

/** Blade-pass frequency ratio per rotor – four motors, never quite in tune. */
const ROTOR_RATIO = [1, 1.021, 0.983, 1.036];
/** Detune drift rate per rotor (Hz) – produces the slow inter-rotor beating. */
const ROTOR_BEAT = [0.13, 0.19, 0.27, 0.35];

/**
 * Continuous multirotor loop. All nodes exist exactly once (created with the
 * layer on the first active call); afterwards only parameters are modulated.
 * Silent (gain exactly 0) once it has been inactive for 0.4 s.
 */
export class DroneLayer {
  private readonly kit: AudioKit;
  private readonly rotors: OscillatorNode[] = [];
  private readonly rotorG: GainNode;
  private readonly buzz: OscillatorNode;
  private readonly buzzBp: BiquadFilterNode;
  private readonly buzzG: GainNode;
  private readonly washG: GainNode;
  private readonly lp: BiquadFilterNode;
  private readonly out: GainNode;
  private readonly panP: AudioParam | null;

  private on = false;
  private pushT = 0;
  private offT = 0;
  private flutter = 0;
  private flutterTarget = 0;
  private flutterTimer = 0;
  private level = 0;
  private blade = 95;

  constructor(kit: AudioKit) {
    this.kit = kit;
    const ctx = kit.ctx;
    this.out = gain(ctx, 0);
    this.lp = filter(ctx, "lowpass", 4000, 0.7);
    const p = panner(ctx, 0);
    this.panP = panParam(p);
    this.lp.connect(this.out);
    this.out.connect(p);
    p.connect(kit.outdoor);

    // Blade-pass tone: fundamental + 2nd/3rd/4th harmonic in one periodic wave
    const real = new Float32Array([0, 0, 0, 0, 0]);
    const imag = new Float32Array([0, 1, 0.55, 0.3, 0.12]);
    const wave = ctx.createPeriodicWave(real, imag);
    this.rotorG = gain(ctx, 0);
    this.rotorG.connect(this.lp);
    for (let i = 0; i < 4; i++) {
      const o = ctx.createOscillator();
      o.setPeriodicWave(wave);
      o.frequency.value = 95 * ROTOR_RATIO[i];
      // Each motor wanders a few cents on its own → slow beating, not a chord
      const lfo = ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = ROTOR_BEAT[i];
      const lfoG = gain(ctx, 7 + i * 2);
      lfo.connect(lfoG);
      lfoG.connect(o.detune);
      lfo.start();
      const g = gain(ctx, 0.24);
      o.connect(g);
      g.connect(this.rotorG);
      o.start();
      this.rotors.push(o);
    }

    // Buzz: blade harmonics + noise edge, band-passed at 1–2 kHz
    this.buzz = ctx.createOscillator();
    this.buzz.type = "sawtooth";
    this.buzz.frequency.value = 190;
    this.buzzBp = filter(ctx, "bandpass", 1400, 2.2);
    this.buzzG = gain(ctx, 0);
    this.buzz.connect(this.buzzBp);
    const nbp = filter(ctx, "bandpass", 1700, 1.3);
    const ng = gain(ctx, 0.5);
    loopSource(kit, kit.white, 1.1).connect(nbp);
    nbp.connect(ng);
    ng.connect(this.buzzBp);
    this.buzzBp.connect(this.buzzG);
    this.buzzG.connect(this.lp);
    this.buzz.start();

    // Rotor wash: soft broadband air noise
    const wbp = filter(ctx, "bandpass", 800, 0.5);
    this.washG = gain(ctx, 0);
    loopSource(kit, kit.pink, 2.3).connect(wbp);
    wbp.connect(this.washG);
    this.washG.connect(this.lp);
  }

  /** Called every frame by the companions module. */
  update(
    dt: number,
    active: boolean,
    pan: number,
    dist01: number,
    throttle01: number,
    env: CompanionEnv,
  ): void {
    const on = active && dist01 < 1;
    // Flutter: irregular level/pitch wobble, mostly noticeable in a storm
    this.flutterTimer -= dt;
    if (this.flutterTimer <= 0) {
      this.flutterTimer = rnd(0.1, 0.35);
      this.flutterTarget = rnd(-1, 1);
    }
    this.flutter = smoothTo(this.flutter, this.flutterTarget, dt, 0.11);
    this.offT = on ? 0 : this.offT + dt;
    const change = on !== this.on;
    this.on = on;
    this.pushT -= dt;
    if (!change && this.pushT > 0) return;
    this.pushT = 0.05;

    const ctx = this.kit.ctx;
    const near = 1 - clamp01(dist01);
    const th = clamp01(throttle01);
    const storm = clamp01(env.storm01);
    const flut = this.flutter * (0.2 + 0.8 * storm);
    const blade = (95 + 45 * th) * (1 + flut * 0.045);
    this.blade = blade;
    for (let i = 0; i < 4; i++)
      setF(ctx, this.rotors[i].frequency, blade * ROTOR_RATIO[i], 0.09);
    setF(ctx, this.buzz.frequency, blade * 2, 0.09);
    setF(ctx, this.buzzBp.frequency, 1050 + 850 * th, 0.15);
    setT(ctx, this.rotorG.gain, on ? 0.3 + 0.16 * th : 0, 0.12);
    setT(ctx, this.buzzG.gain, on ? 0.1 + 0.2 * th : 0, 0.12);
    setT(ctx, this.washG.gain, on ? 0.12 + 0.16 * th : 0, 0.15);
    setF(
      ctx,
      this.lp.frequency,
      (450 + 6500 * near ** 1.1) * (1 - 0.3 * storm),
      0.2,
    );
    const level = on
      ? (0.1 + 0.1 * th) * near ** 1.5 * (1 - 0.4 * storm) * (1 + flut * 0.3)
      : 0;
    this.level = level;
    setT(ctx, this.out.gain, level, on ? 0.12 : 0.04);
    if (this.panP) setT(ctx, this.panP, clamp(pan, -1, 1), 0.08);
    // After the release: exactly zero, so nothing keeps trickling through
    if (!on && this.offT > 0.4) {
      const now = ctx.currentTime;
      this.out.gain.cancelScheduledValues(now);
      this.out.gain.setValueAtTime(0, now);
    }
  }

  debug(): Record<string, number> {
    return {
      on: this.on ? 1 : 0,
      level: this.level,
      outGain: this.out.gain.value,
      bladeHz: Math.round(this.blade),
      lpHz: Math.round(this.lp.frequency.value),
      rotorG: this.rotorG.gain.value,
      buzzG: this.buzzG.gain.value,
      washG: this.washG.gain.value,
      // 4 rotors + 4 drift LFOs + buzz oscillator
      oscillators: this.rotors.length + this.rotors.length + 1,
      // white (buzz edge) + pink (wash)
      loops: 2,
    };
  }
}
