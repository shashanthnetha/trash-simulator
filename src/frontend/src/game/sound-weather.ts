// Weather: wind (three bands, gust random walk, howling in a storm), rain
// (patter outdoors with an intensity-dependent spectrum + droplet transients,
// drumming on the jeep roof) and thunder (positional: N-wave crack, tear and a
// multi-group rumble tail whose length and darkness follow the distance).

import type { AudioKit } from "./sound-core";
import {
  clamp,
  clamp01,
  filter,
  gain,
  loopSource,
  oneShot,
  panner,
  rnd,
  setF,
  setT,
  smoothTo,
} from "./sound-core";

export interface WindInput {
  wind01: number;
  storm01: number;
  rain01: number;
  /** Camera height above the terrain (m). */
  camHeight: number;
  /** Absolute camera height (m), optional – dunes/high spots are wind-exposed. */
  altitude?: number;
  inJeep: boolean;
  jeepSpeed01: number;
}

interface Band {
  bp: BiquadFilterNode;
  g: GainNode;
}

export class WindLayer {
  private readonly kit: AudioKit;
  private readonly low: Band;
  private readonly mid: Band;
  private readonly high: Band;
  private readonly whistleLfoG: GainNode;
  private gust = 0.4;
  private gustTarget = 0.4;
  private gustTimer = 0;
  private flutter = 0;
  private flutterTarget = 0;
  private flutterTimer = 0;
  level = 0;
  private gains = { low: 0, mid: 0, high: 0 };

  constructor(kit: AudioKit) {
    this.kit = kit;
    const ctx = kit.ctx;
    const out = gain(ctx, 1);
    out.connect(kit.outdoor);
    const src = loopSource(kit, kit.pink, 0.7);
    const band = (freq: number, q: number): Band => {
      const bp = filter(ctx, "bandpass", freq, q);
      const g = gain(ctx, 0);
      src.connect(bp);
      bp.connect(g);
      g.connect(out);
      return { bp, g };
    };
    this.low = band(140, 0.8);
    this.mid = band(420, 0.9);
    this.high = band(1800, 6);
    // Slow vibrato on the whistling resonance (howling)
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.33;
    this.whistleLfoG = gain(ctx, 60);
    lfo.connect(this.whistleLfoG);
    this.whistleLfoG.connect(this.high.bp.frequency);
    lfo.start();
  }

  update(dt: number, inp: WindInput, push: boolean): void {
    // Gusts: random walk, faster and more often strong in a storm
    this.gustTimer -= dt;
    if (this.gustTimer <= 0) {
      this.gustTimer = rnd(1.5, 5) * (1 - inp.storm01 * 0.5);
      this.gustTarget = Math.random() ** (1.6 - inp.storm01);
    }
    this.gust = smoothTo(this.gust, this.gustTarget, dt, 1.2);
    // Flutter: fast small fluctuations
    this.flutterTimer -= dt;
    if (this.flutterTimer <= 0) {
      this.flutterTimer = rnd(0.2, 0.6);
      this.flutterTarget = rnd(-1, 1);
    }
    this.flutter = smoothTo(this.flutter, this.flutterTarget, dt, 0.18);
    if (!push) return;

    const ctx = this.kit.ctx;
    const exposure =
      clamp01((inp.camHeight - 2) / 4) * 0.5 +
      (inp.altitude !== undefined ? clamp01((inp.altitude - 6) / 9) * 0.6 : 0);
    let w =
      inp.wind01 * (0.6 + 0.8 * this.gust) +
      exposure * 0.25 +
      inp.storm01 * 0.15;
    if (inp.inJeep) w += inp.jeepSpeed01 * 0.5;
    w = Math.max(0.14, Math.min(1.35, w));
    this.level = w;
    const howl = inp.storm01 * 0.7 + inp.rain01 * 0.3;
    // The bandpasses keep only ~15–20 % of the noise energy – hence the high gains
    // (measured: storm ≈ -25 dBFS RMS, sunny breeze ≈ -43 dBFS)
    const low = 0.6 * w ** 0.9;
    const mid = 0.55 * w ** 1.2 * (1 + this.flutter * 0.12);
    const high = 0.25 * Math.max(0, w - 0.45) ** 1.5 * (1 + howl * 1.2);
    this.gains = { low, mid, high };
    setT(ctx, this.low.g.gain, low, 0.35);
    setF(ctx, this.low.bp.frequency, 100 + 100 * w, 0.5);
    setT(ctx, this.mid.g.gain, mid, 0.25);
    setF(ctx, this.mid.bp.frequency, 240 + 460 * w + this.flutter * 90, 0.3);
    setT(ctx, this.high.g.gain, high, 0.3);
    setF(ctx, this.high.bp.frequency, 1300 + 900 * w, 0.4);
    setT(ctx, this.high.bp.Q, 5 + 7 * howl, 0.5);
    setT(ctx, this.whistleLfoG.gain, 60 + 260 * howl, 0.5);
  }

  debug(): Record<string, number> {
    return { level: this.level, gust: this.gust, ...this.gains };
  }
}

// ---------------------------------------------------------------------------

export class RainLayer {
  private readonly kit: AudioKit;
  private readonly hp: BiquadFilterNode;
  private readonly outG: GainNode;
  private readonly sizzleG: GainNode;
  private readonly roofG: GainNode;
  private dropTimer = 0;
  private thudTimer = 0;
  private gains = { outdoor: 0, roof: 0 };

  constructor(kit: AudioKit) {
    this.kit = kit;
    const ctx = kit.ctx;
    // Outdoors: pink noise, the highpass moves down as the intensity rises
    this.hp = filter(ctx, "highpass", 2400, 0.6);
    this.outG = gain(ctx, 0);
    loopSource(kit, kit.pink, 1.9).connect(this.hp);
    this.hp.connect(this.outG);
    this.outG.connect(kit.outdoor);
    // Sizzle in heavy rain
    const sizzle = filter(ctx, "bandpass", 5200, 1);
    this.sizzleG = gain(ctx, 0);
    loopSource(kit, kit.white, 0.6).connect(sizzle);
    sizzle.connect(this.sizzleG);
    this.sizzleG.connect(this.outG);
    // Jeep roof: dull drumming (not damped – you are sitting right under it)
    const roof = filter(ctx, "bandpass", 230, 1.3);
    this.roofG = gain(ctx, 0);
    loopSource(kit, kit.brown, 1.4).connect(roof);
    roof.connect(this.roofG);
    this.roofG.connect(kit.ambBus);
  }

  update(dt: number, rain01: number, inJeep: boolean, push: boolean): void {
    const r = clamp01(rain01);
    // Droplet transients (outdoors) or roof hits (inside the jeep)
    if (r > 0.03) {
      if (!inJeep) {
        this.dropTimer -= dt;
        while (this.dropTimer <= 0) {
          this.dropTimer += 1 / (2 + 9 * r);
          this.droplet(r);
        }
      } else {
        this.thudTimer -= dt;
        while (this.thudTimer <= 0) {
          this.thudTimer += 1 / (3 + 12 * r);
          this.roofThud(r);
        }
      }
    }
    if (!push) return;
    const ctx = this.kit.ctx;
    const outdoor = 0.5 * r ** 1.4 * (inJeep ? 0.35 : 1);
    const roof = inJeep ? 0.6 * r ** 1.2 : 0;
    this.gains = { outdoor, roof };
    setT(ctx, this.outG.gain, outdoor, 0.4);
    setF(ctx, this.hp.frequency, 2600 - 1900 * r, 0.6);
    setT(ctx, this.sizzleG.gain, 0.45 * r * r, 0.4);
    setT(ctx, this.roofG.gain, roof, 0.3);
  }

  /** Single droplet: short, bright bandpass tick, randomly positioned. */
  private droplet(r: number): void {
    const kit = this.kit;
    if (!kit.voices.acquire(0.06)) return;
    const ctx = kit.ctx;
    const t = ctx.currentTime;
    const dur = rnd(0.012, 0.035);
    const src = oneShot(kit, kit.white, t, dur, 1);
    const bp = filter(ctx, "bandpass", rnd(2500, 7500), 3);
    const g = gain(ctx, 0);
    const peak = rnd(0.02, 0.06) * (0.6 + 0.4 * (1 - r));
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const p = panner(ctx, rnd(-0.8, 0.8));
    src.connect(bp);
    bp.connect(g);
    g.connect(p);
    p.connect(kit.outdoor);
  }

  /** Droplet on the metal roof: low sine thump + short dull noise component. */
  private roofThud(r: number): void {
    const kit = this.kit;
    if (!kit.voices.acquire(0.1)) return;
    const ctx = kit.ctx;
    const t = ctx.currentTime;
    const dur = rnd(0.05, 0.09);
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(rnd(90, 170), t);
    osc.frequency.exponentialRampToValueAtTime(60, t + dur);
    const g = gain(ctx, 0);
    const peak = rnd(0.08, 0.18) * (0.7 + 0.3 * r);
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const p = panner(ctx, rnd(-0.5, 0.5));
    osc.connect(g);
    g.connect(p);
    p.connect(kit.ambBus);
    osc.start(t);
    osc.stop(t + dur + 0.02);
    const n = oneShot(kit, kit.brown, t, 0.04, 1);
    const lp = filter(ctx, "lowpass", 350, 0.8);
    const ng = gain(ctx, 0);
    ng.gain.setValueAtTime(peak * 0.9, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    n.connect(lp);
    lp.connect(ng);
    ng.connect(p);
  }

  debug(): Record<string, number> {
    return { ...this.gains };
  }
}

// ---------------------------------------------------------------------------
// Thunder
//
// One strike = one arrival event. The caller (sky.ts via sound.ts) has already
// waited distance/343 s and computed the stereo position from the strike's
// azimuth against the listener's CURRENT view direction, so everything left to
// do here is to make the sound of a lightning channel `distance` meters away:
//
//   (a) crack  – a cluster of N-waves (the shock fronts of the channel), swept
//                down in frequency, plus an echo crack 60–180 ms later
//   (b) tear   – mid noise through a bandpass falling from ~3 kHz to ~300 Hz
//   (c) rumble – 1–3 groups (different sections of the channel arrive one after
//                the other) of decorrelated brown-noise bursts, each with its
//                own lowpass, resonant peak, pan and slowly rolling envelope
//   (d) sub    – a sine rolling with the rumble plus, for near strikes, a
//                short 62 → 26 Hz thump you feel rather than hear
//
// Distance shapes all of it: the crack fades out beyond ~2.6 km, the top end is
// eaten by air absorption (lowpass ~5 kHz at 400 m, ~150 Hz at 6 km), the tail
// grows from ~3.5 s to ~12 s and the stereo image narrows towards a point.

/** One thunder arrival. */
export interface ThunderParams {
  /** Distance of the strike in meters (≈ 300 … 7000). */
  distance: number;
  /** Stereo position −1 = left .. 1 = right (azimuth vs. listener yaw). */
  pan: number;
  /** −1 = behind the listener .. 1 = straight ahead (slight high shadowing). */
  front?: number;
  /** 0..1 wind strength – a little extra muffling (as for the dog bark). */
  wind01?: number;
  /** 0..1 storm intensity – a little extra muffling. */
  storm01?: number;
}

/** What one arrival scheduled – diagnostics for the dev harness. */
export interface ThunderStats {
  distance: number;
  pan: number;
  /** 0 = right overhead .. 1 = at the far edge of the cell. */
  dist01: number;
  /** Length of the whole event in seconds (onset .. end of the last roll). */
  tail: number;
  /** Air-absorption lowpass of the rumble (Hz). */
  lpHz: number;
  /** Distance gain before the bus. */
  amp: number;
  /** 0..1 share of the crack (0 beyond ≈ 2.6 km). */
  crack: number;
  /** 0..1 stereo width. */
  width: number;
  groups: number;
  bursts: number;
  played: number;
}

/**
 * Shock-front cluster for the crack. A lightning channel radiates an N-wave –
 * an instant pressure jump, a linear fall through zero, an instant return.
 * A single one is just a click; what you hear as the crack is dozens of them
 * from the tortuous channel and its branches arriving within a few ms of each
 * other. Built as a short buffer per strike (a few thousand samples).
 */
function shockBuffer(
  ctx: AudioContext,
  dur: number,
  shocks: number,
  riseSec: number,
): AudioBuffer {
  const rate = ctx.sampleRate;
  const n = Math.max(128, Math.floor(rate * dur));
  const buf = ctx.createBuffer(1, n, rate);
  const d = buf.getChannelData(0);
  for (let k = 0; k < shocks; k++) {
    // Fronts cluster at the very beginning; the late ones are branches
    const at = Math.floor(n * Math.random() ** 2.2);
    const w = Math.max(3, Math.floor(riseSec * rate * rnd(0.5, 2.6)));
    const a = (k === 0 ? 1 : rnd(0.25, 0.9)) * (1 - at / n) ** 0.7;
    const s = Math.random() < 0.5 ? -a : a;
    for (let i = 0; i < w && at + i < n; i++) {
      d[at + i] += s * (1 - (2 * i) / w);
    }
  }
  let pk = 0;
  for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(d[i]));
  const g = pk > 0 ? 0.95 / pk : 0;
  for (let i = 0; i < n; i++) d[i] *= g;
  return buf;
}

/**
 * Rumble envelope: several overlapping "rolls" (thunder rolls because sections
 * of the channel at different distances arrive one after another) plus a slow
 * random amplitude wobble. `rise` stretches the attacks (a distant roll swells
 * instead of hitting), `shape` the overall decay. 0..1, starts and ends at 0.
 */
function rollCurve(
  n: number,
  rolls: number,
  rise: number,
  shape: number,
): Float32Array {
  const c = new Float32Array(n);
  for (let k = 0; k < rolls; k++) {
    const pos = k === 0 ? rnd(0.01, 0.1) : rnd(0.12, 0.86);
    const amp = k === 0 ? 1 : rnd(0.3, 0.85);
    const up = rnd(0.015, 0.06) * rise;
    const down = rnd(0.1, 0.34);
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1) - pos;
      c[i] += amp * (x < 0 ? Math.exp(x / up) : Math.exp(-x / down));
    }
  }
  const w1 = rnd(1.5, 3.5);
  const w2 = rnd(4, 9);
  const p1 = rnd(0, Math.PI * 2);
  const p2 = rnd(0, Math.PI * 2);
  let max = 0;
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    const wob =
      1 +
      0.3 * Math.sin(x * w1 * Math.PI * 2 + p1) +
      0.15 * Math.sin(x * w2 * Math.PI * 2 + p2);
    c[i] = Math.max(0, c[i] * wob);
    if (c[i] > max) max = c[i];
  }
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    c[i] = (c[i] / (max || 1)) * (1 - x) ** shape;
  }
  c[0] = 0;
  c[n - 1] = 0;
  return c;
}

/** Gain node that downmixes its (stereo) input to mono – for true equal-power panning. */
function monoGain(ctx: AudioContext): GainNode {
  const g = gain(ctx, 1);
  g.channelCount = 1;
  g.channelCountMode = "explicit";
  g.channelInterpretation = "speakers";
  return g;
}

/** Master trim of the whole thunder event (calibrated against the limiter). */
const THUNDER_GAIN = 1.05;

/** Thunder arrival – see the block comment above. Returns what it scheduled. */
export function thunderSfx(kit: AudioKit, p: ThunderParams): ThunderStats {
  const ctx = kit.ctx;
  const d = clamp(p.distance, 120, 12000);
  const storm = clamp01(p.storm01 ?? 0);
  const wind = clamp01(p.wind01 ?? 0);
  const front01 = 0.5 + 0.5 * clamp(p.front ?? 1, -1, 1);
  const dist01 = clamp01((d - 250) / 5750);
  // The crack survives to ≈ 2.6 km, the tear a little further
  const crack = clamp01((2600 - d) / 2300) ** 0.85;
  const tearAmt = clamp01((3400 - d) / 3100) ** 0.9;
  // Near = a wide event all around you, far = a point on the horizon
  const width = 0.22 + 0.78 * clamp01((3600 - d) / 3300);
  // Air absorption eats the top end; the storm and a head shadow add a little
  const lpHz =
    (150 + 8000 * Math.exp(-d / 850)) *
    (1 - 0.22 * storm - 0.08 * wind) *
    (0.86 + 0.14 * front01);
  // Spreading, softened (1/r would make 6 km inaudible – it is not)
  const amp = (900 / d) ** 0.38 * (1 - 0.16 * storm - 0.07 * wind);
  // Tail: ≈ 3.4 s at 400 m, 5.5 s at 1.5 km, 8.4 s at 3 km, ≈ 12 s at 6 km
  const tail = clamp((2.6 + d / 520) * rnd(0.95, 1.06), 2.4, 13);
  // Beyond ≈ 2.4 km the channel arrives as several separate rumble groups
  const groups = d > 2400 ? (Math.random() < 0.62 ? 3 : 2) : d > 1200 ? 2 : 1;
  const stats: ThunderStats = {
    distance: Math.round(d),
    pan: Math.round(p.pan * 1000) / 1000,
    dist01: Math.round(dist01 * 1000) / 1000,
    tail: 0,
    lpHz: Math.round(lpHz),
    amp: Math.round(amp * 1000) / 1000,
    crack: Math.round(crack * 1000) / 1000,
    width: Math.round(width * 1000) / 1000,
    groups,
    bursts: 0,
    played: 0,
  };
  if (!kit.voices.acquire(tail + 1)) return stats;
  stats.played = 1;

  const t = ctx.currentTime + 0.02;
  let endAt = t;
  const out = gain(ctx, amp * THUNDER_GAIN);
  out.connect(kit.sfxBus);
  // Placement: the further away, the more the image collapses to the centre
  const panMain = clamp(p.pan * (0.4 + 0.6 * width), -1, 1);
  const spread = 0.62 * width;
  const place = (bias: number): AudioNode =>
    panner(ctx, clamp(panMain + bias * spread, -1, 1));

  // ---- (a) Crack: N-wave cluster + echo crack -----------------------------
  if (crack > 0.005) {
    const boom = (at: number, level: number, bright: number, bias: number) => {
      const dur = rnd(0.11, 0.2);
      const src = ctx.createBufferSource();
      src.buffer = shockBuffer(
        ctx,
        dur,
        18 + Math.floor(Math.random() * 22),
        0.00035,
      );
      const hp = filter(ctx, "highpass", 180 + 260 * bright, 0.7);
      const lp = filter(ctx, "lowpass", 12000, 0.7);
      const f0 = Math.min(13000, lpHz * (2.4 + 1.6 * bright));
      lp.frequency.setValueAtTime(f0, at);
      lp.frequency.exponentialRampToValueAtTime(
        Math.max(160, f0 * 0.16),
        at + dur,
      );
      const g = gain(ctx, 0);
      g.gain.setValueAtTime(level, at);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      const pn = place(bias);
      src.connect(hp);
      hp.connect(lp);
      lp.connect(g);
      g.connect(pn);
      pn.connect(out);
      src.start(at);
      src.stop(at + dur + 0.02);
      endAt = Math.max(endAt, at + dur);
    };
    boom(t, 1.35 * crack, 1, rnd(-0.25, 0.25));
    // Echo crack: the same channel heard again off the cloud base / the dunes
    const echoAt = t + rnd(0.06, 0.18);
    boom(echoAt, rnd(0.35, 0.62) * crack, 0.45, rnd(-1, 1));
  }

  // ---- (b) Tear: band-swept mid noise, with a ripping flutter -------------
  if (tearAmt > 0.01) {
    const at = t + rnd(0.02, 0.07);
    const dur = rnd(0.4, 0.85);
    const src = oneShot(kit, kit.white, at, dur, rnd(0.8, 1.2));
    const mono = monoGain(ctx);
    const bp = filter(ctx, "bandpass", 3200, 1.3);
    const f0 = Math.min(4200, Math.max(600, lpHz * 0.8));
    bp.frequency.setValueAtTime(f0, at);
    bp.frequency.exponentialRampToValueAtTime(
      Math.max(160, f0 * 0.12),
      at + dur,
    );
    const g = gain(ctx, 0);
    const n = 24;
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1);
      c[i] = 0.75 * tearAmt * (1 - x) ** 1.4 * rnd(0.45, 1);
    }
    c[0] = 0.0001;
    c[n - 1] = 0.0001;
    g.gain.setValueCurveAtTime(c, at, dur);
    const pn = place(rnd(-0.4, 0.4));
    src.connect(mono);
    mono.connect(bp);
    bp.connect(g);
    g.connect(pn);
    pn.connect(out);
    endAt = Math.max(endAt, at + dur);
  }

  // ---- (c) Rumble: decorrelated brown-noise bursts in 1–3 groups ----------
  // Level: the rumble carries a distant strike alone, so it grows relative to
  // the crack with distance instead of shrinking.
  const rumble = 0.72 + 0.7 * dist01;
  const rise = 1 + 5 * dist01;
  for (let gi = 0; gi < groups; gi++) {
    const gStart =
      gi === 0
        ? rnd(0, 0.1)
        : tail * (gi === 1 ? rnd(0.16, 0.36) : rnd(0.46, 0.7));
    const gAmp = gi === 0 ? 1 : gi === 1 ? rnd(0.5, 0.85) : rnd(0.3, 0.6);
    const n = gi === 0 ? 3 : 2;
    for (let k = 0; k < n; k++) {
      // Staggered starts + decorrelated buffer offsets = no comb filtering
      const at = t + gStart + rnd(0, 0.3) + k * rnd(0.04, 0.22);
      const dur = Math.max(0.9, (tail - (at - t)) * rnd(0.62, 1));
      const src = oneShot(kit, kit.brown, at, dur, rnd(0.5, 1.1));
      const mono = monoGain(ctx);
      const f0 = clamp(lpHz * rnd(0.5, 1.5), 40, 6000);
      const lp = filter(ctx, "lowpass", f0, rnd(0.6, 1.1));
      // The roll gets darker as it moves away from you
      lp.frequency.setValueAtTime(f0, at);
      lp.frequency.exponentialRampToValueAtTime(
        Math.max(35, f0 * 0.5),
        at + dur,
      );
      // Resonant body: the "boom" of the low channel modes
      const pk = filter(ctx, "peaking", rnd(52, 190), rnd(1.2, 3.4));
      pk.gain.value = rnd(4, 11);
      const g = gain(ctx, 0);
      const curve = rollCurve(
        96,
        2 + Math.floor(Math.random() * 3),
        rise,
        0.45 + 0.35 * dist01,
      );
      const peak = rumble * gAmp * rnd(0.6, 1) * (k === 0 ? 1 : 0.85);
      for (let i = 0; i < curve.length; i++) curve[i] *= peak;
      g.gain.setValueCurveAtTime(curve, at, dur);
      // L/R decorrelation: bursts alternate sides, the spread shrinks with distance
      const pn = place(k === 0 ? rnd(-0.3, 0.3) : k === 1 ? -1 : 1);
      src.connect(mono);
      mono.connect(lp);
      lp.connect(pk);
      pk.connect(g);
      g.connect(pn);
      pn.connect(out);
      endAt = Math.max(endAt, at + dur);
      stats.bursts++;
    }
  }

  // ---- (d) Sub ------------------------------------------------------------
  // Below ~80 Hz there is no useful stereo cue, so the sub stays centred.
  const subDur = Math.max(1.5, tail * 0.85);
  const sub = ctx.createOscillator();
  sub.type = "sine";
  sub.frequency.setValueAtTime(rnd(38, 52), t);
  sub.frequency.exponentialRampToValueAtTime(rnd(20, 26), t + subDur);
  const sg = gain(ctx, 0);
  const subCurve = rollCurve(64, 2, rise, 0.5);
  const subPeak = 0.3 + 0.15 * (1 - dist01);
  for (let i = 0; i < subCurve.length; i++) subCurve[i] *= subPeak;
  sg.gain.setValueCurveAtTime(subCurve, t, subDur);
  sub.connect(sg);
  sg.connect(out);
  sub.start(t);
  sub.stop(t + subDur + 0.05);
  endAt = Math.max(endAt, t + subDur);

  // Near strike: the thump in the chest, right with the crack
  if (crack > 0.05) {
    const th = ctx.createOscillator();
    th.type = "sine";
    th.frequency.setValueAtTime(rnd(58, 72), t);
    th.frequency.exponentialRampToValueAtTime(26, t + 0.9);
    const tg = gain(ctx, 0.0001);
    tg.gain.setValueAtTime(0.0001, t);
    tg.gain.exponentialRampToValueAtTime(0.5 * crack, t + 0.03);
    tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    th.connect(tg);
    tg.connect(out);
    th.start(t);
    th.stop(t + 0.95);
  }

  stats.tail = Math.round((endAt - t) * 100) / 100;
  return stats;
}
