// Fully procedural sound design (WebAudio, no asset files).
// This file is the mixing desk + public API; the layers live in:
//   sound-core      context, buses, noise buffers, parameter helpers, voice limit
//   sound-ocean     surf: rumble, hiss, run-up/backwash, wave events
//   sound-weather   wind (3 bands + gusts), rain (outdoors / jeep roof), thunder
//   sound-vehicle   jeep engine (gears, load, exhaust pulse), tires, horn
//   sound-wildlife  gulls, sandpipers, crickets, fallback scheduler
//   sound-companions dog bark, drone rotor loop (both positional)
//
// Signal flow: outdoor → ambFilter (jeep damping, wet air) → ambBus ───┐
//              rain on the jeep roof ──────────────────────→ ambBus ───┤
//              sfxBus (effects, engine) ───────────────────────────────┤
//              master → limiter → makeup compensation → destination ◄──┘
// Every continuous source exists exactly once (ensure()) and is only modulated
// afterwards; parameter changes go through setTargetAtTime (no zipper noise).
// Before ensure() (= the first user input) every method is a no-op.

import { type CompanionEnv, DroneLayer, dogBarkSfx } from "./sound-companions";
import type { AudioKit, NoiseKind } from "./sound-core";
import {
  VoicePool,
  clamp01,
  filter,
  gain,
  makeNoiseBuffer,
  oneShot,
  panner,
  rnd,
  setF,
  setT,
  smoothTo,
} from "./sound-core";
import { type OceanInput, OceanLayer } from "./sound-ocean";
import { EngineLayer, HornLayer } from "./sound-vehicle";
import {
  RainLayer,
  type ThunderParams,
  type ThunderStats,
  type WindInput,
  WindLayer,
  thunderSfx,
} from "./sound-weather";
import {
  type WildlifeInput,
  WildlifeScheduler,
  flushBurst,
  gullCall,
  sandpiperPeeps,
} from "./sound-wildlife";
import type { CategoryId } from "./types";

/** Additional environment information per frame (supplied by engine.ts). */
export interface AmbienceExtra {
  /** 0..1 cloud cover */
  cloud: number;
  /** 0..24 time of day in hours */
  timeOfDay: number;
  inJeep: boolean;
  /** 0..1 jeep speed relative to the top speed */
  jeepSpeed01: number;
  /** Camera height above the terrain in meters */
  camHeight: number;
  /** Current wave reach (m) – rhythm of the surf */
  waveReach: number;
  /** 0..1 decaying lightning intensity */
  lightning: number;
  /** Optional: view direction (rad) – the sea is then placed in the stereo image. */
  yaw?: number;
  /** Optional: absolute camera height (m) – dunes/high spots are more wind-exposed. */
  altitude?: number;
}

/** Master-bus factor while the game is paused. */
const PAUSE_DUCK = 0.12;

const DEFAULT_EXTRA: AmbienceExtra = {
  cloud: 0,
  timeOfDay: 12,
  inJeep: false,
  jeepSpeed01: 0,
  camHeight: 1.7,
  waveReach: 4.2,
  lightning: 0,
};

/**
 * Per spec the DynamicsCompressor applies automatic makeup gain
 * (= (1/gain at 0 dBFS)^0.6). We cancel that out so that levels below the
 * threshold stay unchanged and the compressor acts as a pure limiter.
 */
function compressorMakeup(thresholdDb: number, ratio: number): number {
  const outDb = thresholdDb + (0 - thresholdDb) / ratio;
  const fullRangeGain = 10 ** (outDb / 20);
  return (1 / fullRangeGain) ** 0.6;
}

interface ToneOpts {
  freq: number;
  dur: number;
  gain: number;
  type?: OscillatorType;
  freqEnd?: number;
  /** Start offset in seconds (sequences without setTimeout). */
  at?: number;
  pan?: number;
  attack?: number;
  /** Optional bandpass (formant/body). */
  bp?: number;
  bpQ?: number;
}

interface BurstOpts {
  dur: number;
  gain: number;
  freq: number;
  type: BiquadFilterType;
  q?: number;
  rate?: number;
  at?: number;
  /** The filter frequency glides exponentially to this value over dur. */
  sweepTo?: number;
  attack?: number;
  pan?: number;
  buf?: NoiseKind;
}

export class SoundManager {
  private kit: AudioKit | null = null;
  private master: GainNode | null = null;
  private ambBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private ambFilter: BiquadFilterNode | null = null;
  private outdoor: GainNode | null = null;
  private analyser: AnalyserNode | null = null;

  private ocean: OceanLayer | null = null;
  private wind: WindLayer | null = null;
  private rain: RainLayer | null = null;
  private engine: EngineLayer | null = null;
  private wildlife: WildlifeScheduler | null = null;
  // Created lazily on first use – neither exists in a run without companions.
  private drone: DroneLayer | null = null;
  private horn: HornLayer | null = null;

  private started = false;
  private storm01 = 0;
  private wind01 = 0;
  private pushTimer = 0;
  private lastDt = 1 / 60;
  private jeepSpeed01 = 0;
  private lastGull = -10;
  private lastBark = -10;
  private droneCalled = false;
  private droneIdle = 0;
  /**
   * Last view direction reported by updateAmbience. Positional one-shots that
   * are triggered long after their cause (thunder: distance/343 s after the
   * flash) read it AT TRIGGER TIME, so the sound comes from where the event
   * was, not from where the camera pointed when it started.
   */
  private lastYaw = 0;
  private thunderCount = 0;
  private lastThunderAz = 0;
  private thunderStats: ThunderStats | null = null;

  // Reused input objects (no allocation per frame)
  private readonly oceanIn: OceanInput = {
    shoreDistance: 100,
    waveReach: 4.2,
    storm01: 0,
    wind01: 0,
  };
  private readonly windIn: WindInput = {
    wind01: 0,
    storm01: 0,
    rain01: 0,
    camHeight: 1.7,
    inJeep: false,
    jeepSpeed01: 0,
  };
  private readonly wildIn: WildlifeInput = {
    isDay: true,
    timeOfDay: 12,
    rain01: 0,
    storm01: 0,
    cloud: 0,
    shoreDistance: 100,
    inJeep: false,
  };
  private readonly compEnv: CompanionEnv = { wind01: 0, storm01: 0 };
  private readonly thunderIn: ThunderParams = {
    distance: 2000,
    pan: 0,
    front: 1,
    wind01: 0,
    storm01: 0,
  };

  // Level meter (only active once debugState() has been queried at least once)
  private meterOn = false;
  private meterBuf = new Float32Array(0);
  private meterRms = 0;
  private meterPeak = 0;
  private meterMax = 0;

  volMaster = 0.8;
  volAmb = 0.8;
  volSfx = 0.9;

  ensure(): void {
    if (this.started) return;
    const Ctor = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!Ctor) return;
    this.started = true;
    let ctx: AudioContext;
    try {
      ctx = new Ctor();
    } catch {
      return;
    }

    // Master: buses → master → limiter → makeup compensation → output
    const master = gain(ctx, this.volMaster);
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 3;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    const post = gain(ctx, 1 / compressorMakeup(-3, 12));
    master.connect(limiter);
    limiter.connect(post);
    post.connect(ctx.destination);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    post.connect(analyser);

    const ambBus = gain(ctx, this.volAmb);
    ambBus.connect(master);
    const sfxBus = gain(ctx, this.volSfx);
    sfxBus.connect(master);
    const ambFilter = filter(ctx, "lowpass", 18000, 0.5);
    ambFilter.connect(ambBus);
    const outdoor = gain(ctx, 1);
    outdoor.connect(ambFilter);

    const kit: AudioKit = {
      ctx,
      outdoor,
      ambBus,
      sfxBus,
      white: makeNoiseBuffer(ctx, 2, 1, "white"),
      pink: makeNoiseBuffer(ctx, 4, 2, "pink"),
      brown: makeNoiseBuffer(ctx, 5, 2, "brown"),
      voices: new VoicePool(ctx, 40),
    };
    this.kit = kit;
    this.master = master;
    this.ambBus = ambBus;
    this.sfxBus = sfxBus;
    this.ambFilter = ambFilter;
    this.outdoor = outdoor;
    this.analyser = analyser;

    this.ocean = new OceanLayer(kit);
    this.wind = new WindLayer(kit);
    this.rain = new RainLayer(kit);
    this.engine = new EngineLayer(kit);
    this.wildlife = new WildlifeScheduler(kit);
  }

  resume(): void {
    this.ensure();
    const ctx = this.kit?.ctx;
    if (ctx && ctx.state === "suspended") {
      void ctx.resume().catch(() => undefined);
    }
  }

  setVolumes(master: number, amb: number, sfx: number): void {
    this.volMaster = master;
    this.volAmb = amb;
    this.volSfx = sfx;
    const ctx = this.kit?.ctx;
    if (!ctx) return;
    if (this.master)
      setT(
        ctx,
        this.master.gain,
        master * (this.paused ? PAUSE_DUCK : 1),
        0.03,
      );
    if (this.ambBus) setT(ctx, this.ambBus.gain, amb, 0.03);
    if (this.sfxBus) setT(ctx, this.sfxBus.gain, sfx, 0.03);
  }

  /**
   * Duck the whole mix while the game is paused (menu/pause panel). The
   * continuous layers keep their state – engine/drone are silenced separately
   * by the engine at the pause edge – but nothing plays at full level behind
   * the pause panel.
   */
  setPaused(p: boolean): void {
    if (this.paused === p) return;
    this.paused = p;
    const ctx = this.kit?.ctx;
    if (ctx && this.master)
      setT(ctx, this.master.gain, this.volMaster * (p ? PAUSE_DUCK : 1), 0.25);
  }
  private paused = false;

  /** Continuous environment parameters, callable every frame. */
  updateAmbience(
    dt: number,
    shoreDistance: number,
    windStrength: number,
    rainStrength: number,
    isDay: boolean,
    stormy: boolean,
    extra?: AmbienceExtra,
  ): void {
    this.lastDt = dt;
    const kit = this.kit;
    if (
      !kit ||
      !this.ocean ||
      !this.wind ||
      !this.rain ||
      !this.wildlife ||
      !this.ambFilter ||
      !this.outdoor
    )
      return;
    const ex = extra ?? DEFAULT_EXTRA;
    if (ex.yaw !== undefined) this.lastYaw = ex.yaw;
    this.jeepSpeed01 = clamp01(ex.jeepSpeed01);
    this.storm01 = smoothTo(this.storm01, stormy ? 1 : 0, dt, 2);
    this.pushTimer -= dt;
    const push = this.pushTimer <= 0;
    if (push) this.pushTimer = 0.05;
    const wind01 = clamp01(windStrength);
    const rain01 = clamp01(rainStrength);
    this.wind01 = wind01;
    this.compEnv.wind01 = wind01;
    this.compEnv.storm01 = this.storm01;

    // Watchdog: if the companions module stops calling droneSound (drone gone,
    // upgrade sold), the loop must not stay stuck at its last level.
    if (this.drone) {
      if (this.droneCalled) {
        this.droneCalled = false;
        this.droneIdle = 0;
      } else {
        this.droneIdle += dt;
        if (this.droneIdle > 0.25)
          this.drone.update(dt, false, 0, 1, 0, this.compEnv);
      }
    }

    const o = this.oceanIn;
    o.shoreDistance = shoreDistance;
    o.waveReach = ex.waveReach;
    o.storm01 = this.storm01;
    o.wind01 = wind01;
    o.yaw = ex.yaw;
    this.ocean.update(dt, o, push);

    const w = this.windIn;
    w.wind01 = wind01;
    w.storm01 = this.storm01;
    w.rain01 = rain01;
    w.camHeight = ex.camHeight;
    w.altitude = ex.altitude;
    w.inJeep = ex.inJeep;
    w.jeepSpeed01 = this.jeepSpeed01;
    this.wind.update(dt, w, push);

    this.rain.update(dt, rain01, ex.inJeep, push);

    const wl = this.wildIn;
    wl.isDay = isDay;
    wl.timeOfDay = ex.timeOfDay;
    wl.rain01 = rain01;
    wl.storm01 = this.storm01;
    wl.cloud = ex.cloud;
    wl.shoreDistance = shoreDistance;
    wl.inJeep = ex.inJeep;
    this.wildlife.update(dt, wl);

    if (push) {
      const ctx = kit.ctx;
      // In the jeep: outside world dull and quieter; in rain "wet air" (fewer highs)
      setF(
        ctx,
        this.ambFilter.frequency,
        ex.inJeep ? 650 : 18000 - rain01 * 9000,
        0.3,
      );
      setT(ctx, this.outdoor.gain, ex.inJeep ? 0.5 : 1, 0.3);
      if (this.meterOn) this.readMeter();
    }
  }

  updateEngine(running: boolean, rpm01: number): void {
    this.engine?.update(running, rpm01, this.lastDt, this.jeepSpeed01);
  }

  // ---------------------------------------------------------------------
  // One-shot effects (nodes per event, limited by VoicePool)

  private tone(o: ToneOpts): void {
    const kit = this.kit;
    if (!kit) return;
    const at = o.at ?? 0;
    if (!kit.voices.acquire(at + o.dur)) return;
    const ctx = kit.ctx;
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    osc.type = o.type ?? "sine";
    osc.frequency.setValueAtTime(Math.max(20, o.freq), t);
    if (o.freqEnd)
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(20, o.freqEnd),
        t + o.dur,
      );
    const g = gain(ctx, 0);
    const atk = o.attack ?? 0;
    if (atk > 0) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(o.gain, t + Math.min(atk, o.dur * 0.5));
    } else {
      g.gain.setValueAtTime(o.gain, t);
    }
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    let head: AudioNode = osc;
    if (o.bp) {
      const f = filter(ctx, "bandpass", o.bp, o.bpQ ?? 1.5);
      head.connect(f);
      head = f;
    }
    head.connect(g);
    if (o.pan) {
      const p = panner(ctx, o.pan);
      g.connect(p);
      p.connect(kit.sfxBus);
    } else {
      g.connect(kit.sfxBus);
    }
    osc.start(t);
    osc.stop(t + o.dur + 0.02);
  }

  private burst(o: BurstOpts): void {
    const kit = this.kit;
    if (!kit) return;
    const at = o.at ?? 0;
    if (!kit.voices.acquire(at + o.dur)) return;
    const ctx = kit.ctx;
    const t = ctx.currentTime + at;
    const buf =
      o.buf === "pink" ? kit.pink : o.buf === "brown" ? kit.brown : kit.white;
    const src = oneShot(kit, buf, t, o.dur, o.rate ?? rnd(0.85, 1.15));
    const f = filter(ctx, o.type, o.freq, o.q ?? 1);
    if (o.sweepTo) {
      f.frequency.setValueAtTime(o.freq, t);
      f.frequency.exponentialRampToValueAtTime(o.sweepTo, t + o.dur);
    }
    const g = gain(ctx, 0);
    const atk = o.attack ?? 0;
    if (atk > 0) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(o.gain, t + Math.min(atk, o.dur * 0.5));
    } else {
      g.gain.setValueAtTime(o.gain, t);
    }
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    src.connect(f);
    f.connect(g);
    if (o.pan) {
      const p = panner(ctx, o.pan);
      g.connect(p);
      p.connect(kit.sfxBus);
    } else {
      g.connect(kit.sfxBus);
    }
  }

  private blip(
    freq: number,
    dur: number,
    type: OscillatorType,
    gainV: number,
    freqEnd?: number,
    at = 0,
  ): void {
    this.tone({ freq, dur, type, gain: gainV, freqEnd, at });
  }

  /**
   * Footstep: dry sand = soft step + crunch, wet sand = squelch (falling
   * bandpass), water = splash + dull "plunk".
   */
  footstep(wet: boolean, water = false): void {
    const v = rnd(0.8, 1.15);
    if (water) {
      this.burst({
        dur: 0.26,
        gain: 0.16 * v,
        freq: 1400,
        sweepTo: 600,
        type: "highpass",
        q: 0.7,
        rate: rnd(0.9, 1.2),
        attack: 0.02,
      });
      this.burst({
        dur: 0.12,
        gain: 0.08 * v,
        freq: 3200,
        type: "bandpass",
        q: 1.2,
        at: 0.03,
      });
      this.tone({
        freq: 130 * v,
        dur: 0.11,
        type: "sine",
        gain: 0.12,
        freqEnd: 55,
      });
    } else if (wet) {
      this.burst({
        dur: 0.17,
        gain: 0.15 * v,
        freq: 1500,
        sweepTo: 380,
        type: "bandpass",
        q: 1.1,
        rate: rnd(0.8, 1.1),
        attack: 0.008,
      });
      this.burst({
        dur: 0.07,
        gain: 0.05,
        freq: 260,
        type: "lowpass",
        buf: "brown",
      });
    } else {
      this.burst({
        dur: 0.075,
        gain: 0.11 * v,
        freq: 240,
        type: "lowpass",
        buf: "brown",
        attack: 0.004,
      });
      this.burst({
        dur: 0.11,
        gain: 0.07 * v,
        freq: rnd(1300, 2400),
        type: "bandpass",
        q: 0.9,
        rate: rnd(0.85, 1.25),
        attack: 0.006,
      });
    }
  }

  pickupSound(category: CategoryId): void {
    this.pickupAt(category, 0);
  }

  private pickupAt(category: CategoryId, at: number): void {
    switch (category) {
      case "GLASS":
        this.tone({ freq: 1750 + rnd(0, 300), dur: 0.22, gain: 0.14, at });
        this.tone({
          freq: 2600 + rnd(0, 400),
          dur: 0.14,
          gain: 0.07,
          at: at + 0.01,
        });
        this.burst({
          dur: 0.04,
          gain: 0.06,
          freq: 4200,
          type: "bandpass",
          q: 2,
          at,
        });
        break;
      case "METAL":
        this.tone({
          freq: 280 + rnd(0, 90),
          dur: 0.22,
          type: "square",
          gain: 0.09,
          freqEnd: 180,
          bp: 900,
          bpQ: 2,
          at,
        });
        this.tone({
          freq: 1900 + rnd(0, 500),
          dur: 0.12,
          type: "triangle",
          gain: 0.05,
          at,
        });
        this.burst({ dur: 0.08, gain: 0.08, freq: 2400, type: "bandpass", at });
        break;
      case "PLASTIC":
        // Crackling: three short bursts
        this.burst({
          dur: 0.05,
          gain: 0.11,
          freq: 1800,
          type: "bandpass",
          q: 1.5,
          at,
        });
        this.burst({
          dur: 0.045,
          gain: 0.09,
          freq: 2600,
          type: "bandpass",
          q: 1.5,
          at: at + 0.05,
        });
        this.burst({
          dur: 0.06,
          gain: 0.07,
          freq: 2100,
          type: "bandpass",
          q: 1.5,
          at: at + 0.11,
        });
        break;
      case "PAPER":
        this.burst({
          dur: 0.18,
          gain: 0.09,
          freq: 3200,
          type: "highpass",
          attack: 0.03,
          rate: rnd(0.8, 1.2),
          at,
        });
        break;
      case "WOOD":
        this.tone({ freq: 150, dur: 0.12, gain: 0.16, freqEnd: 90, at });
        this.burst({ dur: 0.06, gain: 0.05, freq: 500, type: "lowpass", at });
        break;
      case "STONE":
        this.tone({ freq: 95, dur: 0.14, gain: 0.2, freqEnd: 55, at });
        this.burst({
          dur: 0.05,
          gain: 0.05,
          freq: 900,
          type: "bandpass",
          q: 1.2,
          buf: "brown",
          at,
        });
        break;
      case "CHEMICALS":
        // Hollow canister
        this.tone({
          freq: 220,
          dur: 0.18,
          type: "square",
          gain: 0.08,
          freqEnd: 150,
          bp: 420,
          bpQ: 3,
          at,
        });
        this.tone({ freq: 440, dur: 0.1, type: "triangle", gain: 0.05, at });
        break;
      default:
        this.burst({ dur: 0.09, gain: 0.1, freq: 1200, type: "bandpass", at });
    }
  }

  bucketDrop(category: CategoryId): void {
    this.tone({
      freq: category === "GLASS" ? 900 : 320,
      dur: 0.09,
      type: "triangle",
      gain: 0.08,
      freqEnd: 200,
    });
    this.pickupSound(category);
  }

  dumpCascade(categories: CategoryId[]): void {
    categories.slice(0, 7).forEach((c, i) => this.pickupAt(c, i * 0.07));
    this.burst({
      dur: 0.4,
      gain: 0.1,
      freq: 700,
      type: "lowpass",
      buf: "brown",
    });
  }

  stationProcessSound(): void {
    // Motor hum + rattling of the drum + clattering
    this.tone({
      freq: 62,
      dur: 1.4,
      type: "sawtooth",
      gain: 0.05,
      freqEnd: 50,
      bp: 180,
      bpQ: 1.5,
    });
    this.burst({
      dur: 0.9,
      gain: 0.05,
      freq: 900,
      type: "bandpass",
      attack: 0.1,
      buf: "pink",
    });
    this.burst({
      dur: 0.08,
      gain: 0.06,
      freq: 2400,
      type: "bandpass",
      q: 2,
      at: 0.35,
    });
    this.burst({
      dur: 0.06,
      gain: 0.05,
      freq: 1800,
      type: "bandpass",
      q: 2,
      at: 0.62,
    });
  }

  bucketFull(): void {
    this.blip(220, 0.15, "square", 0.1);
    this.blip(160, 0.2, "square", 0.1);
  }

  levelUp(): void {
    [440, 554, 659, 880].forEach((f, i) => {
      this.blip(f, 0.22, "triangle", 0.12, undefined, i * 0.09);
    });
  }

  /** A distant ship's foghorn: two low reeds swelling out of the murk. */
  foghorn(gain01 = 1, pan = 0): void {
    const g = 0.11 * gain01;
    this.tone({
      freq: 64,
      dur: 2.8,
      type: "sawtooth",
      gain: g,
      attack: 0.5,
      pan,
      bp: 120,
      bpQ: 1.2,
    });
    this.tone({
      freq: 96.5,
      dur: 2.6,
      type: "sawtooth",
      gain: g * 0.6,
      attack: 0.6,
      pan,
      bp: 190,
      bpQ: 1.6,
      at: 0.08,
    });
    this.burst({
      dur: 2.4,
      gain: g * 0.3,
      freq: 260,
      type: "lowpass",
      q: 0.7,
      attack: 0.7,
      pan,
    });
  }

  /** Quick belt thock when swapping the hand tool. */
  toolSwap(): void {
    this.tone({
      freq: 470,
      dur: 0.05,
      type: "square",
      gain: 0.055,
      bp: 1400,
      bpQ: 2,
    });
    this.tone({ freq: 290, dur: 0.07, gain: 0.07, freqEnd: 210, at: 0.045 });
  }

  /**
   * One VLF beep burst; tools-detector.ts sets the repeat rate (slow at the
   * edge of range, urgent close in). s = signal 0..1 lifts the pitch from
   * ~650 Hz to ~1.1 kHz. Deliberately louder than the old blip so it reads
   * over surf and wind.
   */
  detectorBlip(s: number): void {
    const f = 650 + 460 * s;
    this.tone({
      freq: f,
      dur: 0.085,
      type: "square",
      gain: 0.11 + 0.06 * s,
      bp: f * 1.8,
      bpQ: 1.6,
    });
    // Thin second partial gives it the boxy little-speaker character.
    this.tone({
      freq: f * 2.01,
      dur: 0.05,
      type: "sine",
      gain: 0.04 + 0.03 * s,
      at: 0.004,
    });
  }

  /** Two-note confirmation chirp when the coil first locks a pinpoint. */
  detectorLock(): void {
    this.tone({
      freq: 940,
      dur: 0.07,
      type: "square",
      gain: 0.09,
      bp: 1900,
      bpQ: 2,
    });
    this.tone({
      freq: 1180,
      dur: 0.16,
      type: "square",
      gain: 0.1,
      bp: 2300,
      bpQ: 2,
      at: 0.075,
    });
  }

  /**
   * Continuous solid pinpoint tone – a single held oscillator, created
   * lazily and afterwards only modulated (no per-frame nodes). Call with
   * on=true every frame while the coil sits over the find; any frame
   * without a call lets the watchdog in setHorn() fade it out, so the tone
   * cannot survive a pause or an unequip.
   */
  detectorTone(on: boolean, s = 1): void {
    const kit = this.kit;
    if (!kit) return;
    if (!this.detToneOsc) {
      if (!on) return;
      const ctx = kit.ctx;
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.value = 1150;
      const f = filter(ctx, "bandpass", 2100, 1.4);
      const g = gain(ctx, 0);
      osc.connect(f);
      f.connect(g);
      g.connect(kit.sfxBus);
      osc.start();
      this.detToneOsc = osc;
      this.detToneGain = g;
    }
    const ctx = kit.ctx;
    this.detToneOn = on;
    if (on) this.detTonePing = ctx.currentTime;
    if (this.detToneGain) {
      setT(ctx, this.detToneGain.gain, on ? 0.085 : 0, on ? 0.015 : 0.045);
    }
    if (on) {
      setF(ctx, this.detToneOsc.frequency, 1090 + 90 * clamp01(s), 0.04);
    }
  }
  private detToneOsc: OscillatorNode | null = null;
  private detToneGain: GainNode | null = null;
  private detToneOn = false;
  private detTonePing = 0;

  /** Trowel scooping wet sand. */
  digScoop(): void {
    this.burst({
      dur: 0.26,
      gain: 0.11,
      freq: 850,
      type: "lowpass",
      q: 0.8,
      rate: 0.85,
    });
    this.burst({
      dur: 0.18,
      gain: 0.06,
      freq: 2400,
      type: "bandpass",
      q: 1.5,
      at: 0.1,
    });
  }

  /** Small keys jingling on a ring – picking up the lighthouse key. */
  keyJingle(): void {
    [3150, 2680, 3480, 2950].forEach((f, i) => {
      this.tone({
        freq: f * (0.98 + Math.random() * 0.04),
        dur: 0.09,
        type: "triangle",
        gain: 0.05,
        at: i * 0.05 + Math.random() * 0.02,
      });
    });
    this.burst({ dur: 0.12, gain: 0.04, freq: 5200, type: "bandpass", q: 2 });
  }

  /** A heavy old lock turning: mechanism scrape, then the bolt clunks over. */
  unlockClunk(): void {
    this.burst({
      dur: 0.16,
      gain: 0.07,
      freq: 1900,
      type: "bandpass",
      q: 1.2,
      rate: 0.8,
    });
    this.tone({
      freq: 210,
      dur: 0.1,
      type: "square",
      gain: 0.1,
      freqEnd: 150,
      bp: 500,
      bpQ: 2,
      at: 0.16,
    });
    this.tone({ freq: 95, dur: 0.16, gain: 0.16, freqEnd: 60, at: 0.18 });
  }

  /** Old breaker lever thrown: heavy clack, plus a hum blip when going live. */
  switchThunk(on: boolean): void {
    this.tone({ freq: 300, dur: 0.05, type: "square", gain: 0.09, bp: 900 });
    this.tone({ freq: 120, dur: 0.09, gain: 0.14, freqEnd: 70, at: 0.03 });
    if (on) {
      this.tone({
        freq: 100,
        dur: 0.5,
        type: "sawtooth",
        gain: 0.03,
        bp: 210,
        bpQ: 4,
        at: 0.1,
      });
    }
  }

  /** Sparkling chime for a rare collectible going into the display case. */
  collectibleFound(): void {
    [1046.5, 1318.5, 1568, 2093].forEach((f, i) => {
      this.tone({ freq: f, dur: 0.5, type: "sine", gain: 0.09, at: i * 0.085 });
      this.tone({
        freq: f * 2.01,
        dur: 0.28,
        type: "sine",
        gain: 0.03,
        at: i * 0.085,
      });
    });
    this.burst({
      dur: 0.55,
      gain: 0.035,
      freq: 6400,
      type: "bandpass",
      q: 2,
      attack: 0.06,
    });
  }

  /**
   * Ground-bird flush: wing flutter + alarm call when a dune bird takes off.
   * pan −1..1, dist01 0 = close / 1 = far. Rate limiting is the caller's job.
   */
  birdFlush(pan = 0, dist01 = 0.5): void {
    const kit = this.kit;
    if (!kit) return;
    flushBurst(kit, pan, clamp01(dist01));
  }

  /** Positional sandpiper peeps from an actual bird (not the fallback timer). */
  birdPeep(pan = 0, dist01 = 0.5): void {
    const kit = this.kit;
    if (!kit) return;
    sandpiperPeeps(kit, pan, clamp01(dist01));
  }

  uiClick(): void {
    this.blip(900, 0.05, "square", 0.05);
  }

  /**
   * Thunder arrival of a strike at world azimuth `azimuth` (rad – the strike
   * lies in the direction (sin az, ·, cos az)) and `distanceM` meters away.
   * Called by sky.ts distance/343 s AFTER the flash; the stereo position is
   * computed here, at arrival time, against the listener's current view
   * direction. Camera forward is (−sin yaw, 0, −cos yaw) and right is
   * (cos yaw, 0, −sin yaw), so the lateral component is sin(az − yaw) and the
   * front/back component −cos(az − yaw).
   */
  thunderStrike(azimuth: number, distanceM: number): void {
    const kit = this.kit;
    if (!kit) return;
    const rel = azimuth - this.lastYaw;
    const p = this.thunderIn;
    p.distance = Math.max(60, distanceM);
    p.pan = Math.sin(rel);
    p.front = -Math.cos(rel);
    p.wind01 = this.wind01;
    p.storm01 = this.storm01;
    this.lastThunderAz = azimuth;
    this.thunderCount++;
    this.thunderStats = thunderSfx(kit, p);
  }

  /**
   * Legacy API: thunder without a world position. dist01 0 = right overhead
   * (crack), 1 = distant (rumble only) – mapped onto a synthetic strike at a
   * random azimuth over the sea, 300 m … 6 km away.
   */
  thunder(dist01?: number): void {
    const d = clamp01(dist01 ?? rnd(0.15, 0.9));
    this.thunderStrike(Math.PI + rnd(-1.4, 1.4), 300 + d * 5700);
  }

  /** Gull call; pan -1..1 (left..right), dist01 0 = near, 1 = far away. */
  gull(pan = 0, dist01 = 0.5): void {
    const kit = this.kit;
    if (!kit) return;
    const t = kit.ctx.currentTime;
    if (t - this.lastGull < 0.3) return;
    this.lastGull = t;
    gullCall(kit, pan, dist01);
  }

  /**
   * Dog bark. pan −1..1 (left..right relative to the camera), dist01 0 = close,
   * 1 = far (≈ 60 m). Weather attenuation (harder to hear in wind/storm) is
   * applied inside the sound layer from the stored storm/wind state.
   * Rate limiting is the caller's job; a hard floor of 2 s applies regardless.
   */
  dogBark(pan = 0, dist01 = 0.5): void {
    const kit = this.kit;
    if (!kit) return;
    const t = kit.ctx.currentTime;
    if (t - this.lastBark < 2) return;
    this.lastBark = t;
    this.compEnv.wind01 = this.wind01;
    this.compEnv.storm01 = this.storm01;
    this.barkStats = dogBarkSfx(kit, pan, clamp01(dist01), this.compEnv);
  }
  private barkStats: Record<string, number> | null = null;

  droneHum(on: boolean): void {
    // short beep on start/stop; a continuous hum would be annoying at a distance
    this.blip(on ? 1200 : 700, 0.12, "triangle", 0.06);
  }

  /**
   * Continuous positional multirotor sound, driven every frame by the
   * companions module. pan −1..1, dist01 0 = close / 1 = inaudible,
   * throttle01 = current rotor load (climb/descent/speed). The rotor loop is
   * built on the first active call and silenced (gain 0) when inactive.
   */
  droneSound(active: boolean, pan = 0, dist01 = 0.5, throttle01 = 0.5): void {
    const kit = this.kit;
    if (!kit) return;
    if (!this.drone) {
      if (!active) return;
      this.drone = new DroneLayer(kit);
    }
    this.droneCalled = true;
    this.droneIdle = 0;
    this.compEnv.wind01 = this.wind01;
    this.compEnv.storm01 = this.storm01;
    this.drone.update(
      this.lastDt,
      active,
      pan,
      clamp01(dist01),
      clamp01(throttle01),
      this.compEnv,
    );
  }

  /** Jeep horn; called every frame with the held state of the horn key. */
  setHorn(on: boolean): void {
    const kit = this.kit;
    if (!kit) return;
    // Watchdog for the detector's held pinpoint tone: setHorn is the one
    // sound call the engine makes every frame even while paused, so a tone
    // whose owner stopped pinging (pause, unequip edge) fades out here.
    if (
      this.detToneOn &&
      this.detToneGain &&
      kit.ctx.currentTime - this.detTonePing > 0.35
    ) {
      this.detToneOn = false;
      setT(kit.ctx, this.detToneGain.gain, 0, 0.045);
    }
    if (!this.horn) {
      if (!on) return;
      this.horn = new HornLayer(kit);
    }
    this.horn.set(on);
  }

  carDoor(): void {
    this.tone({ freq: 120, dur: 0.12, gain: 0.18, freqEnd: 55 });
    this.burst({
      dur: 0.07,
      gain: 0.1,
      freq: 700,
      type: "lowpass",
      buf: "brown",
    });
    this.burst({
      dur: 0.02,
      gain: 0.07,
      freq: 3200,
      type: "bandpass",
      q: 3,
      at: 0.04,
    });
  }

  washUp(): void {
    this.ocean?.breakWave(1.4);
    this.burst({
      dur: 0.8,
      gain: 0.1,
      freq: 500,
      type: "lowpass",
      buf: "brown",
      attack: 0.15,
    });
  }

  // ---------------------------------------------------------------------
  // Diagnostics (dev harness)

  private readMeter(): void {
    const an = this.analyser;
    if (!an) return;
    if (this.meterBuf.length !== an.fftSize)
      this.meterBuf = new Float32Array(an.fftSize);
    const buf = this.meterBuf;
    an.getFloatTimeDomainData(buf);
    let sq = 0;
    let pk = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i];
      sq += v * v;
      const a = Math.abs(v);
      if (a > pk) pk = a;
    }
    const rms = Math.sqrt(sq / buf.length);
    this.meterRms = this.meterRms * 0.8 + rms * 0.2;
    this.meterPeak = Math.max(pk, this.meterPeak * 0.97);
    this.meterMax = Math.max(this.meterMax, pk);
  }

  /** Current state (context, levels, layer gains) – for checks only. */
  debugState(resetPeak = false): Record<string, unknown> {
    const kit = this.kit;
    if (!kit) return { started: this.started, ctx: null };
    this.meterOn = true;
    this.readMeter();
    const peakMax = this.meterMax;
    if (resetPeak) this.meterMax = 0;
    const ctx = kit.ctx;
    const db = (v: number) => Math.round(20 * Math.log10(Math.max(1e-6, v)));
    return {
      state: ctx.state,
      time: Math.round(ctx.currentTime * 100) / 100,
      sampleRate: ctx.sampleRate,
      master: this.master?.gain.value,
      amb: this.ambBus?.gain.value,
      sfx: this.sfxBus?.gain.value,
      ambFilterHz: Math.round(this.ambFilter?.frequency.value ?? 0),
      outdoor: this.outdoor?.gain.value,
      storm01: this.storm01,
      wind01: this.wind01,
      yaw: this.lastYaw,
      voices: kit.voices.active,
      meter: {
        rms: this.meterRms,
        rmsDb: db(this.meterRms),
        peak: this.meterPeak,
        peakMax,
        peakMaxDb: db(peakMax),
      },
      ocean: this.ocean?.debug(),
      wind: this.wind?.debug(),
      rain: this.rain?.debug(),
      engine: this.engine?.debug(),
      drone: this.drone ? this.drone.debug() : null,
      horn: this.horn ? this.horn.debug() : null,
      bark: {
        // Seconds since the last bark that actually played (2 s hard floor)
        sinceLast: Math.round((ctx.currentTime - this.lastBark) * 100) / 100,
        ...this.barkStats,
      },
      thunder: {
        count: this.thunderCount,
        azimuth: Math.round(this.lastThunderAz * 1000) / 1000,
        ...this.thunderStats,
      },
    };
  }
}

export const sound = new SoundManager();
