// Jeep audio.
//
// EngineLayer: two detuned sawtooths + sub octave + an octave square that only
// comes in under load, exhaust pulse via two AM oscillators (firing order and
// its second order), a load-dependent lowpass, four gears with a shaped torque
// dip, rev inertia with separate rise/fall constants, an idle lope, an overrun
// burble with occasional exhaust pops, and tire/body noise on sand that splits
// into boom (slow) and hiss (fast).
//
// HornLayer: dual-tone car horn (400 + 505 Hz saw/square hybrid) through a
// resonant body; the oscillators run permanently, only the envelope is keyed,
// so rapid taps retrigger without clicks.

import type { AudioKit } from "./sound-core";
import {
  clamp,
  clamp01,
  filter,
  gain,
  loopSource,
  oneShot,
  rnd,
  setF,
  setT,
  smoothTo,
} from "./sound-core";

/** Upshift points in rpm01 (speed relative to the top speed). */
const GEAR_UP = [0.3, 0.58, 0.82];
/** Engine revs (0..1) at the bottom end of each gear. */
const RPM_LO = [0.12, 0.42, 0.48, 0.52];

export class EngineLayer {
  private readonly kit: AudioKit;
  private readonly osc1: OscillatorNode;
  private readonly osc2: OscillatorNode;
  private readonly sub: OscillatorNode;
  private readonly subG: GainNode;
  private readonly harm: OscillatorNode;
  private readonly harmG: GainNode;
  private readonly amLfo: OscillatorNode;
  private readonly amDepth: GainNode;
  private readonly amLfo2: OscillatorNode;
  private readonly amDepth2: GainNode;
  private readonly lopeDepth: GainNode;
  private readonly lopePitch: GainNode;
  private readonly lp: BiquadFilterNode;
  private readonly engineG: GainNode;
  private readonly burbleBp: BiquadFilterNode;
  private readonly burbleG: GainNode;
  private readonly tireBp: BiquadFilterNode;
  private readonly tireG: GainNode;
  private readonly boomG: GainNode;
  private readonly hissG: GainNode;

  private gear = 0;
  private rpm = 0;
  private drive = 0;
  private over = 0;
  private idle = 0;
  private prevRpm01 = 0;
  private wasRunning = false;
  private startTimer = 0;
  private shiftTimer = 0;
  private shiftLen = 0.26;
  private popTimer = 0;
  private pushTimer = 0;
  private gainNow = 0;
  private freqNow = 0;
  private tireNow = 0;

  constructor(kit: AudioKit) {
    this.kit = kit;
    const ctx = kit.ctx;
    this.osc1 = ctx.createOscillator();
    this.osc1.type = "sawtooth";
    this.osc1.frequency.value = 50;
    this.osc2 = ctx.createOscillator();
    this.osc2.type = "sawtooth";
    this.osc2.frequency.value = 50.6;
    this.osc2.detune.value = 9;
    this.sub = ctx.createOscillator();
    this.sub.type = "sine";
    this.sub.frequency.value = 25;
    this.subG = gain(ctx, 0.55);
    // Octave square: only audible while pulling – the "working" harmonics
    this.harm = ctx.createOscillator();
    this.harm.type = "square";
    this.harm.frequency.value = 100;
    this.harmG = gain(ctx, 0);
    const mix = gain(ctx, 0.5);
    this.osc1.connect(mix);
    this.osc2.connect(mix);
    this.sub.connect(this.subG);
    this.subG.connect(mix);
    this.harm.connect(this.harmG);
    this.harmG.connect(mix);

    // Exhaust pulse: a sawtooth LFO at the firing rate modulates the amplitude,
    // a second one an octave up sharpens the pulse under load.
    const am = gain(ctx, 1);
    this.amLfo = ctx.createOscillator();
    this.amLfo.type = "sawtooth";
    this.amLfo.frequency.value = 25;
    this.amDepth = gain(ctx, 0);
    this.amLfo.connect(this.amDepth);
    this.amDepth.connect(am.gain);
    this.amLfo2 = ctx.createOscillator();
    this.amLfo2.type = "sawtooth";
    this.amLfo2.frequency.value = 50;
    this.amDepth2 = gain(ctx, 0);
    this.amLfo2.connect(this.amDepth2);
    this.amDepth2.connect(am.gain);
    mix.connect(am);

    this.lp = filter(ctx, "lowpass", 300, 1.2);
    this.engineG = gain(ctx, 0);
    am.connect(this.lp);
    this.lp.connect(this.engineG);
    this.engineG.connect(kit.sfxBus);

    // Idle lope: ~1.1 Hz breathing on level and pitch while standing still
    const lope = ctx.createOscillator();
    lope.type = "sine";
    lope.frequency.value = 1.12;
    this.lopeDepth = gain(ctx, 0);
    lope.connect(this.lopeDepth);
    this.lopeDepth.connect(this.engineG.gain);
    this.lopePitch = gain(ctx, 0);
    lope.connect(this.lopePitch);
    this.lopePitch.connect(this.osc1.frequency);
    lope.start();

    // Overrun burble: dark, irregular exhaust rumble off throttle
    this.burbleBp = filter(ctx, "bandpass", 220, 2.6);
    this.burbleG = gain(ctx, 0);
    loopSource(kit, kit.brown, 1.3).connect(this.burbleBp);
    this.burbleBp.connect(this.burbleG);
    this.burbleG.connect(kit.sfxBus);

    this.osc1.start();
    this.osc2.start();
    this.sub.start();
    this.harm.start();
    this.amLfo.start();
    this.amLfo2.start();

    // Tires on sand: mid rustle + low body boom + high sand hiss
    this.tireG = gain(ctx, 0);
    const sand = loopSource(kit, kit.pink, 2.9);
    this.tireBp = filter(ctx, "bandpass", 400, 0.7);
    sand.connect(this.tireBp);
    this.tireBp.connect(this.tireG);
    const hissHp = filter(ctx, "highpass", 2600, 0.7);
    this.hissG = gain(ctx, 0);
    sand.connect(hissHp);
    hissHp.connect(this.hissG);
    this.hissG.connect(this.tireG);
    const boomLp = filter(ctx, "lowpass", 110, 0.8);
    this.boomG = gain(ctx, 0.55);
    loopSource(kit, kit.brown, 3.7).connect(boomLp);
    boomLp.connect(this.boomG);
    this.boomG.connect(this.tireG);
    this.tireG.connect(kit.sfxBus);
  }

  update(
    running: boolean,
    rpm01In: number,
    dtIn: number,
    speed01: number,
  ): void {
    const dt = clamp(dtIn, 0.001, 0.1);
    const rpm01 = clamp01(rpm01In);
    const speed = clamp01(speed01);
    if (running && !this.wasRunning) {
      this.starter();
      this.startTimer = 0.45;
    }
    this.wasRunning = running;
    this.startTimer = Math.max(0, this.startTimer - dt);
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);

    // Gear steps with hysteresis
    if (this.gear < 3 && rpm01 > GEAR_UP[this.gear]) {
      this.gear++;
      this.shiftLen = 0.26;
      this.shiftTimer = this.shiftLen;
    } else if (this.gear > 0 && rpm01 < GEAR_UP[this.gear - 1] - 0.07) {
      this.gear--;
      this.shiftLen = 0.16;
      this.shiftTimer = this.shiftLen;
    }
    const lo = this.gear === 0 ? 0 : GEAR_UP[this.gear - 1];
    const hi = this.gear === 3 ? 1 : GEAR_UP[this.gear];
    const local = clamp01((rpm01 - lo) / (hi - lo));
    const rpmT = running
      ? RPM_LO[this.gear] + (1 - RPM_LO[this.gear]) * local
      : 0;
    // Inertia: revs climb quickly under load, fall slowly when coasting; only
    // during a shift do they drop fast (clutch out). The pitch never steps.
    const tc = !running
      ? 0.5
      : rpmT > this.rpm
        ? 0.1 + 0.05 * (1 - this.drive)
        : this.shiftTimer > 0
          ? 0.09
          : 0.3;
    this.rpm = smoothTo(this.rpm, rpmT, dt, tc);

    // Load states: drive = pulling, over = off throttle, idle = standing still
    const dr = (rpm01 - this.prevRpm01) / dt;
    this.prevRpm01 = rpm01;
    this.drive = smoothTo(this.drive, clamp01(dr * 3), dt, 0.25);
    this.over = smoothTo(
      this.over,
      rpm01 > 0.08 ? clamp01((-dr - 0.05) * 2.2) : 0,
      dt,
      0.18,
    );
    this.idle = running ? clamp01(1 - rpm01 / 0.06) : 0;

    // Occasional exhaust pop while the engine is being driven backwards
    if (running && this.over > 0.45 && this.rpm > 0.3) {
      this.popTimer -= dt;
      if (this.popTimer <= 0) {
        this.popTimer = rnd(0.07, 0.26);
        this.pop();
      }
    }

    this.pushTimer -= dt;
    if (this.pushTimer > 0) return;
    this.pushTimer = 0.05;
    const ctx = this.kit.ctx;
    const shiftK = this.shiftLen > 0 ? this.shiftTimer / this.shiftLen : 0;
    const freq = 34 + this.rpm * 128 + this.gear * 4;
    this.freqNow = freq;
    setF(ctx, this.osc1.frequency, freq, 0.05);
    setF(ctx, this.osc2.frequency, freq * 1.012, 0.05);
    setF(ctx, this.sub.frequency, freq * 0.5, 0.05);
    setF(ctx, this.harm.frequency, freq * 2, 0.05);
    setF(ctx, this.amLfo.frequency, freq * 0.5, 0.05);
    setF(ctx, this.amLfo2.frequency, freq, 0.05);
    setT(ctx, this.subG.gain, 0.62 - this.rpm * 0.22, 0.12);
    setT(
      ctx,
      this.harmG.gain,
      this.drive * 0.15 + Math.max(0, this.rpm - 0.5) * 0.12,
      0.12,
    );
    // Exhaust: deep pulses at low revs, sharper while pulling, looser on overrun
    const amBase = 0.5 * (1 - this.rpm) ** 1.6 + 0.06 + this.over * 0.18;
    setT(ctx, this.amDepth.gain, amBase * (1 - 0.5 * shiftK), 0.1);
    setT(
      ctx,
      this.amDepth2.gain,
      (this.drive * 0.22 + this.rpm * 0.06) * (1 - shiftK),
      0.1,
    );
    // Load filter: brighter and more resonant while pulling, dark on overrun
    setF(
      ctx,
      this.lp.frequency,
      230 +
        this.rpm * 1500 +
        this.drive * 620 -
        this.over * 240 -
        this.idle * 60,
      0.08,
    );
    setT(ctx, this.lp.Q, 1.2 + this.drive * 2.4, 0.1);
    setT(ctx, this.lopeDepth.gain, this.idle * 0.018, 0.2);
    setT(ctx, this.lopePitch.gain, this.idle * 1.6, 0.2);

    let g = running
      ? 0.105 + this.rpm * 0.155 + this.drive * 0.05 - this.over * 0.04
      : 0;
    if (this.startTimer > 0) g = 0;
    // Torque dip: sharp cut on the shift, then smoothly back in
    else g *= 1 - 0.5 * Math.sqrt(shiftK);
    this.gainNow = g;
    setT(ctx, this.engineG.gain, g, running ? 0.06 : 0.25);

    const burble = running
      ? this.over * (0.05 + 0.05 * this.rpm) * rnd(0.35, 1.35)
      : 0;
    setT(ctx, this.burbleG.gain, burble, 0.04);
    setF(ctx, this.burbleBp.frequency, 180 + this.rpm * 260, 0.15);

    // Tires: the boom carries at walking pace, the hiss takes over with speed
    const tire = running ? 0.17 * speed ** 1.25 : 0;
    this.tireNow = tire;
    setT(ctx, this.tireG.gain, tire, 0.2);
    setF(ctx, this.tireBp.frequency, 300 + 900 * speed, 0.3);
    setT(ctx, this.boomG.gain, 0.55 * (1 - speed * 0.45), 0.3);
    setT(ctx, this.hissG.gain, 0.3 * speed ** 1.8, 0.3);
  }

  /** Starter: three noise pulses + a short whine, then the engine catches. */
  private starter(): void {
    const kit = this.kit;
    if (!kit.voices.acquire(0.5)) return;
    const ctx = kit.ctx;
    const t = ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      const ts = t + i * 0.12;
      const src = oneShot(kit, kit.white, ts, 0.08, 1);
      const bp = filter(ctx, "bandpass", 650, 2);
      const g = gain(ctx, 0);
      g.gain.setValueAtTime(0.14, ts);
      g.gain.exponentialRampToValueAtTime(0.0001, ts + 0.08);
      src.connect(bp);
      bp.connect(g);
      g.connect(kit.sfxBus);
    }
    const whine = ctx.createOscillator();
    whine.type = "triangle";
    whine.frequency.setValueAtTime(160, t);
    whine.frequency.exponentialRampToValueAtTime(260, t + 0.36);
    const wg = gain(ctx, 0);
    wg.gain.setValueAtTime(0.05, t);
    wg.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    whine.connect(wg);
    wg.connect(kit.sfxBus);
    whine.start(t);
    whine.stop(t + 0.42);
  }

  /** Overrun pop: short, dull crack out of the exhaust. */
  private pop(): void {
    const kit = this.kit;
    if (!kit.voices.acquire(0.09)) return;
    const ctx = kit.ctx;
    const t = ctx.currentTime;
    const dur = rnd(0.03, 0.07);
    const src = oneShot(kit, kit.brown, t, dur, rnd(0.8, 1.3));
    const bp = filter(ctx, "bandpass", rnd(160, 420), 1.6);
    const g = gain(ctx, 0);
    g.gain.setValueAtTime(rnd(0.05, 0.13), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(kit.sfxBus);
  }

  debug(): Record<string, number> {
    return {
      gear: this.gear,
      rpm: this.rpm,
      load: this.drive,
      over: this.over,
      idle: this.idle,
      gain: this.gainNow,
      freqHz: Math.round(this.freqNow),
      lpHz: Math.round(this.lp.frequency.value),
      tire: this.tireNow,
    };
  }
}

// ---------------------------------------------------------------------------
// Horn

/** The two horn fundamentals (Hz) – a real dual-tone horn beats at ~105 Hz. */
const HORN_A = 400;
const HORN_B = 505;
/** Envelope peak; the network below adds roughly 0.8× on top of it. */
const HORN_PEAK = 0.5;

export class HornLayer {
  private readonly kit: AudioKit;
  private readonly oscA: OscillatorNode;
  private readonly oscB: OscillatorNode;
  private readonly env: GainNode;
  private on = false;

  constructor(kit: AudioKit) {
    this.kit = kit;
    const ctx = kit.ctx;
    // Saw/square hybrid: odd harmonics dominate, even ones are present at half
    // level – the brash, nasal timbre of a diaphragm horn.
    const n = 16;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    for (let k = 1; k < n; k++) imag[k] = (k % 2 === 1 ? 1 : 0.5) / k;
    const wave = ctx.createPeriodicWave(real, imag);
    const mix = gain(ctx, 1);
    const mk = (f: number, level: number): OscillatorNode => {
      const o = ctx.createOscillator();
      o.setPeriodicWave(wave);
      o.frequency.value = f;
      const g = gain(ctx, level);
      o.connect(g);
      g.connect(mix);
      o.start();
      return o;
    };
    this.oscA = mk(HORN_A, 0.5);
    this.oscB = mk(HORN_B, 0.45);

    // Body: no mud below 220 Hz, a broad 1 kHz resonance and a 2.4 kHz bite
    const hp = filter(ctx, "highpass", 220, 0.7);
    mix.connect(hp);
    this.env = gain(ctx, 0);
    const dry = gain(ctx, 0.4);
    hp.connect(dry);
    dry.connect(this.env);
    const bp = filter(ctx, "bandpass", 1000, 1.1);
    const bpG = gain(ctx, 1);
    hp.connect(bp);
    bp.connect(bpG);
    bpG.connect(this.env);
    const bite = filter(ctx, "bandpass", 2400, 2);
    const biteG = gain(ctx, 0.35);
    hp.connect(bite);
    bite.connect(biteG);
    biteG.connect(this.env);
    this.env.connect(kit.sfxBus);
  }

  /** Called every frame with the held state; only edges do anything. */
  set(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    const ctx = this.kit.ctx;
    const t = ctx.currentTime;
    const g = this.env.gain;
    // Continue from the value currently reached – rapid taps never click
    if (typeof g.cancelAndHoldAtTime === "function") g.cancelAndHoldAtTime(t);
    else {
      const cur = g.value;
      g.cancelScheduledValues(t);
      g.setValueAtTime(cur, t);
    }
    if (on) {
      g.linearRampToValueAtTime(HORN_PEAK, t + 0.015);
      // Tiny pitch settle: the diaphragm needs a moment to find its note
      this.settle(this.oscA, HORN_A, t);
      this.settle(this.oscB, HORN_B, t);
    } else {
      g.linearRampToValueAtTime(0, t + 0.12);
    }
  }

  private settle(o: OscillatorNode, f: number, t: number): void {
    o.frequency.cancelScheduledValues(t);
    o.frequency.setValueAtTime(f * 1.055, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.055);
  }

  debug(): Record<string, number> {
    return {
      on: this.on ? 1 : 0,
      gain: this.env.gain.value,
      aHz: Math.round(this.oscA.frequency.value),
      bHz: Math.round(this.oscB.frequency.value),
    };
  }
}
