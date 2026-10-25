// Sea: distant surf rumble, surf hiss, water running up and running back
// (both follow the visible wave reach) plus individual wave events that
// "break" at the low point of the backwash.
// Stereo via uncorrelated noise channels + L/R-offset event sources.

import type { AudioKit } from "./sound-core";
import {
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

export interface OceanInput {
  /** Distance from the camera to the water line in meters. */
  shoreDistance: number;
  /** Current wave reach (m) from terrain.waveReach(). */
  waveReach: number;
  /** 0..1 storm (smoothed). */
  storm01: number;
  wind01: number;
  /** View direction (rad); undefined = no panning. */
  yaw?: number;
}

export class OceanLayer {
  private readonly kit: AudioKit;
  private readonly out: GainNode;
  private readonly panP: AudioParam | null;
  private readonly rumbleLp: BiquadFilterNode;
  private readonly rumbleG: GainNode;
  private readonly hissBp: BiquadFilterNode;
  private readonly hissG: GainNode;
  private readonly runHp: BiquadFilterNode;
  private readonly runG: GainNode;
  private readonly backBp: BiquadFilterNode;
  private readonly backG: GainNode;

  // Wave rhythm
  private prevReach = Number.NaN;
  private vel = 0;
  private armed = false;
  private eventDelay = -1;
  private pendingIntensity = 0;
  // Swell (slow random walk)
  private swell = 1;
  private swellTarget = 1;
  private swellTimer = 0;
  // Most recently computed distance factors (used by the events)
  private a = 0;
  private near = 0;
  private lastStorm = 0;
  private gains = { rumble: 0, hiss: 0, run: 0, back: 0 };
  events = 0;

  constructor(kit: AudioKit) {
    this.kit = kit;
    const ctx = kit.ctx;
    this.out = gain(ctx, 1);
    const pan = panner(ctx, 0);
    this.panP = panParam(pan);
    this.out.connect(pan);
    pan.connect(kit.outdoor);

    // (a) Distant rumble: stereo brown noise, lowpass, slow swell LFO
    this.rumbleLp = filter(ctx, "lowpass", 300, 0.7);
    this.rumbleG = gain(ctx, 0);
    loopSource(kit, kit.brown, 0.3).connect(this.rumbleLp);
    this.rumbleLp.connect(this.rumbleG);
    this.rumbleG.connect(this.out);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.05;
    const lfoG = gain(ctx, 0.035);
    lfo.connect(lfoG);
    lfoG.connect(this.rumbleG.gain);
    lfo.start();

    // (b) Surf hiss (mids/highs): pink noise, bandpass
    this.hissBp = filter(ctx, "bandpass", 1000, 0.6);
    this.hissG = gain(ctx, 0);
    loopSource(kit, kit.pink, 1.1).connect(this.hissBp);
    this.hissBp.connect(this.hissG);
    this.hissG.connect(this.out);

    // (c) Water running up: bright noise, follows the run-up speed
    this.runHp = filter(ctx, "highpass", 1500, 0.5);
    this.runG = gain(ctx, 0);
    loopSource(kit, kit.pink, 2.4).connect(this.runHp);
    this.runHp.connect(this.runG);
    this.runG.connect(this.out);

    // (d) Backwash: "gurgling" – brown noise with a wobbling bandpass + fine hiss
    this.backBp = filter(ctx, "bandpass", 380, 1.8);
    this.backG = gain(ctx, 0);
    loopSource(kit, kit.brown, 2.1).connect(this.backBp);
    this.backBp.connect(this.backG);
    const fizz = filter(ctx, "bandpass", 2600, 1.2);
    const fizzG = gain(ctx, 0.35);
    loopSource(kit, kit.pink, 3.3).connect(fizz);
    fizz.connect(fizzG);
    fizzG.connect(this.backG);
    this.backG.connect(this.out);
    const wob = ctx.createOscillator();
    wob.frequency.value = 0.9;
    const wobG = gain(ctx, 110);
    wob.connect(wobG);
    wobG.connect(this.backBp.frequency);
    wob.start();
  }

  /** Call every frame; parameters are only pushed when `push` is set (~20 Hz). */
  update(dt: number, inp: OceanInput, push: boolean): void {
    const d = Math.max(0, inp.shoreDistance);
    // Loudness curve: 0 m → 1, 60 m → 0.55, 200 m → 0.19, 400 m → 0.08
    const a = 1 / (1 + (d / 70) ** 1.4);
    // Proximity: brightness/detail only right at the water
    const near = 1 / (1 + (d / 25) ** 2);
    this.a = a;
    this.near = near;
    this.lastStorm = inp.storm01;

    // Wave rhythm: speed of the water edge (m/s), smoothed
    const r = inp.waveReach;
    if (Number.isNaN(this.prevReach)) this.prevReach = r;
    const rawVel = dt > 0 ? (r - this.prevReach) / dt : 0;
    this.prevReach = r;
    this.vel = smoothTo(this.vel, rawVel, dt, 0.2);
    if (this.vel < -0.05) this.armed = true;
    else if (this.armed && this.vel > 0.03 && this.eventDelay < 0) {
      // Low point: the next wave breaks (slightly delayed, random strength)
      this.armed = false;
      this.eventDelay = rnd(0, 0.35);
      const depth = clamp01((4.2 - r) / 2.8);
      this.pendingIntensity =
        (0.45 + depth * 0.3 + Math.random() * 0.3) * (1 + inp.storm01 * 0.6);
    }
    if (this.eventDelay >= 0) {
      this.eventDelay -= dt;
      if (this.eventDelay < 0) {
        this.eventDelay = -1;
        this.breakWave(this.pendingIntensity);
      }
    }

    // Swell: slow random walk
    this.swellTimer -= dt;
    if (this.swellTimer <= 0) {
      this.swellTimer = rnd(5, 11);
      this.swellTarget = rnd(0.75, 1.25);
    }
    this.swell = smoothTo(this.swell, this.swellTarget, dt, 3);

    if (!push) return;
    const ctx = this.kit.ctx;
    const up = clamp01(this.vel / 0.9);
    const down = clamp01(-this.vel / 0.9);
    const storm = inp.storm01;
    const big = 1 + storm * 0.7 + inp.wind01 * 0.2;
    const facing =
      inp.yaw === undefined ? 1 : 0.75 + 0.25 * Math.max(0, Math.cos(inp.yaw));

    // Levels calibrated with the analyser (master 0.8 / ambience 0.8): water line
    // ≈ -21 dBFS RMS, 60 m ≈ -26, 250 m ≈ -34; storm ≈ +4 dB (limiter catches peaks)
    const rumble = 1.1 * a ** 0.85 * this.swell * (1 + storm * 0.4);
    const hiss = 0.6 * a ** 1.7 * (0.5 + 0.5 * up) * this.swell * big * facing;
    const run = 0.8 * a ** 1.8 * up * big * facing;
    const back = 0.55 * a ** 1.6 * down * (0.6 + 0.4 * near) * big;
    this.gains = { rumble, hiss, run, back };

    setT(ctx, this.rumbleG.gain, rumble, 0.25);
    setF(ctx, this.rumbleLp.frequency, 140 + 420 * a ** 0.7 + storm * 120, 0.4);
    setT(ctx, this.hissG.gain, hiss, 0.15);
    setF(ctx, this.hissBp.frequency, 700 + 900 * near, 0.4);
    setT(ctx, this.runG.gain, run, 0.12);
    setF(ctx, this.runHp.frequency, 900 + 1600 * up * near, 0.2);
    setT(ctx, this.backG.gain, back, 0.15);
    setF(ctx, this.backBp.frequency, 330 + 120 * near, 0.4);
    if (this.panP && inp.yaw !== undefined)
      setT(ctx, this.panP, Math.sin(inp.yaw) * 0.55, 0.2);
  }

  /**
   * A wave breaks: two L/R-offset noise sources with a bright onset that decay
   * into the run-up via a bandpass sweep, plus a dull body.
   */
  breakWave(intensity: number): void {
    const kit = this.kit;
    const ctx = kit.ctx;
    const a = this.a;
    if (a < 0.04) return;
    const near = this.near;
    const amp = a ** 1.4 * intensity;
    const dur = rnd(3.2, 5.2);
    if (!kit.voices.acquire(dur)) return;
    const t = ctx.currentTime;
    this.events++;
    const side = Math.random() < 0.5 ? -1 : 1;
    for (let i = 0; i < 2; i++) {
      const ts = t + (i === 0 ? 0 : rnd(0.012, 0.03));
      const src = oneShot(kit, kit.white, ts, dur, rnd(0.85, 1.15));
      const bp = filter(ctx, "bandpass", 2000, 0.8);
      const f0 = (1800 + 1400 * near) * rnd(0.85, 1.15);
      const f1 = (380 + 220 * near) * rnd(0.85, 1.15);
      bp.frequency.setValueAtTime(f0, ts);
      bp.frequency.exponentialRampToValueAtTime(f1, ts + dur);
      const g = gain(ctx, 0);
      const peak = 1.4 * amp * rnd(0.85, 1.1) * (1 + this.lastStorm * 0.3);
      const atk = rnd(0.35, 0.7);
      g.gain.setValueAtTime(0.0001, ts);
      g.gain.exponentialRampToValueAtTime(peak, ts + atk);
      g.gain.exponentialRampToValueAtTime(peak * 0.3, ts + atk + 1.2);
      g.gain.exponentialRampToValueAtTime(0.0001, ts + dur);
      const p = panner(ctx, side * (i === 0 ? 1 : -1) * rnd(0.15, 0.45));
      src.connect(bp);
      bp.connect(g);
      g.connect(p);
      p.connect(this.out);
    }
    // Body of the breaking wave: dull thump
    const body = oneShot(kit, kit.brown, t, 0.9, rnd(0.8, 1));
    const lp = filter(ctx, "lowpass", 90 + 110 * near, 0.9);
    const bg = gain(ctx, 0);
    bg.gain.setValueAtTime(0.0001, t);
    bg.gain.exponentialRampToValueAtTime(Math.max(0.001, 0.9 * amp), t + 0.25);
    bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    body.connect(lp);
    lp.connect(bg);
    bg.connect(this.out);
  }

  debug(): Record<string, number> {
    return {
      a: this.a,
      near: this.near,
      vel: this.vel,
      swell: this.swell,
      events: this.events,
      ...this.gains,
    };
  }
}
