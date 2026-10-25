// Passing lights – far shipping on the night horizon. A seeded timetable
// (one roll per in-game night, mulberry32) sends the occasional vessel
// crossing far out to sea: a flat dark coaster silhouette carrying a handful
// of lamp sprites, taking 8–15 real minutes to pass from one end of the
// horizon to the other. In murky weather (rain, storm, a closed-to-the-water
// cloud deck) the lights stay hidden and a distant foghorn calls every ~90 s
// instead (sound.foghorn, panned by the vessel's bearing). Nothing ever
// approaches the shore – the world stays deserted.
//
// Rendering: the vessel sails at z ≈ −1280..−1560, beyond the camera's far
// plane once the beach is behind you – so, exactly like the ocean's far field
// (ocean.ts), the whole group is squashed along the camera→ship ray:
// same position and size on screen, but a depth that agrees with the sea's
// squashed depth buffer in front of and behind the hull. The hull is one
// merged, one-material mesh (1 draw call); the lamps are five small additive
// sprites with fog:false – the scene fog would otherwise swallow them, the
// silhouette instead fades by hand towards env.horizonSea so it sits in the
// haze like the dome drew it.

import * as THREE from "three";
import { shipLampTexture } from "./ambient-ships-textures";
import { clamp, mulberry32, smoothstep } from "./noise";
import type { Environment } from "./sky";
import { sound } from "./sound";
import type { QualityId } from "./types";

// ---------------------------------------------------------------------------
// Timetable
// ---------------------------------------------------------------------------

/**
 * Base seed of the shipping timetable. Deliberately chosen so that the very
 * first night of a fresh world (night index −1, the one that contains
 * tod = 0) has a vessel mid-crossing around midnight – the sea feels alive
 * from the first evening on. Roughly 55 % of nights see traffic.
 */
const SEED = 39;
/** Night window in unwrapped game hours within a night (sun below horizon). */
const NIGHT_FROM = 18.6;
const NIGHT_TO = 29.3;
/** Real seconds per game hour (a full day passes in 36 minutes – sky.ts). */
const REAL_PER_GH = 90;
/** Half sweep of a crossing along x (m): −X_REACH → +X_REACH or back. */
const X_REACH = 2000;
/** Far-field squash, identical to the ocean vertex shader (ocean.ts). */
const SQUASH_0 = 700;
const SQUASH_SPAN = 780; // SQUASH_MAX 1480 − SQUASH_0
/** Foghorn cadence (s) while a vessel is passing in murk. */
const HORN_BASE = 82;
const HORN_JITTER = 18;

interface Passage {
  /** Start/duration in game hours within the night (18.2 … 29.8). */
  start: number;
  durGh: number;
  /** Real seconds the crossing takes (8–15 min). */
  crossDur: number;
  /** +1 = west→east (+x), −1 = east→west. */
  dir: 1 | -1;
  /** Sea lane, world z (constant per passage). */
  lane: number;
  /** Vessel size factor. */
  kind: number;
  /** 0..1 – jitters the foghorn cadence deterministically. */
  hornSeed: number;
}

/**
 * The timetable of one night, rolled deterministically from the night index.
 * ~55 % of nights have traffic; of those ~a third get a second, later
 * passage (which may finish into the dawn twilight – the lamps fade out with
 * the sky light anyway).
 */
function rollNight(nightIdx: number): Passage[] {
  const rng = mulberry32((SEED ^ Math.imul(nightIdx, 0x9e3779b1)) >>> 0);
  const active = rng() < 0.55;
  const two = rng() < 0.35;
  const n = active ? (two ? 2 : 1) : 0;
  const passes: Passage[] = [];
  for (let i = 0; i < n; i++) {
    const dir: 1 | -1 = rng() < 0.5 ? 1 : -1;
    const crossDur = n === 2 ? 480 + rng() * 140 : 480 + rng() * 420;
    const durGh = crossDur / REAL_PER_GH;
    const lane = -(1280 + rng() * 280);
    const kind = 0.85 + rng() * 0.3;
    const hornSeed = rng();
    let start: number;
    if (n === 1) start = NIGHT_FROM + rng() * (NIGHT_TO - durGh - NIGHT_FROM);
    else if (i === 0) start = NIGHT_FROM + rng() * 2.4;
    else {
      const prev = passes[0];
      start = Math.max(prev.start + prev.durGh + 0.4, 23.6 + rng() * 1.6);
      if (start > 28.4) continue; // would run too far into the day
    }
    passes.push({ start, durGh, crossDur, dir, lane, kind, hornSeed });
  }
  return passes;
}

// ---------------------------------------------------------------------------
// Geometry: coaster silhouette (one merged mesh, one dark material)
// ---------------------------------------------------------------------------

/** Push a quad (two tris) over four existing vertex indices. */
function quad(idx: number[], a: number, b: number, c: number, d: number): void {
  idx.push(a, b, c, a, c, d);
}

/** Axis-aligned box; the top can be shifted in x (raked funnel). */
function pushBox(
  pos: number[],
  idx: number[],
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  topShiftX = 0,
): void {
  const o = pos.length / 3;
  pos.push(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1);
  const tx0 = x0 + topShiftX;
  const tx1 = x1 + topShiftX;
  pos.push(tx0, y1, z0, tx1, y1, z0, tx1, y1, z1, tx0, y1, z1);
  quad(idx, o, o + 1, o + 5, o + 4); // z0 face
  quad(idx, o + 3, o + 2, o + 6, o + 7); // z1 face
  quad(idx, o, o + 3, o + 7, o + 4); // x0 face
  quad(idx, o + 1, o + 2, o + 6, o + 5); // x1 face
  quad(idx, o + 4, o + 5, o + 6, o + 7); // top
}

/**
 * A ~95 m coaster: lofted hull with sheer and a raked bow, hatch coamings on
 * the foredeck, an aft accommodation block with bridge deck, a raked funnel
 * and two masts. Local +x = bow. Rendered double-sided (pure silhouette).
 */
function buildHull(): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  // Stations: x, deck height, half beam. Keel at −1.4 (just below the water).
  const st: readonly (readonly [number, number, number])[] = [
    [-47.5, 5.8, 5.2],
    [-34, 5.0, 6.8],
    [-10, 4.6, 7.0],
    [18, 4.8, 7.0],
    [36, 5.6, 6.2],
    [46.5, 7.2, 1.0],
  ];
  const keel = -1.4;
  for (const [x, deck, hb] of st) {
    pos.push(x, keel, -hb, x, keel, hb, x, deck, hb, x, deck, -hb);
  }
  for (let s = 0; s < st.length - 1; s++) {
    const o = s * 4;
    quad(idx, o + 1, o + 5, o + 6, o + 2); // starboard (+z)
    quad(idx, o, o + 4, o + 7, o + 3); // port (−z)
    quad(idx, o + 3, o + 7, o + 6, o + 2); // deck
  }
  quad(idx, 0, 1, 2, 3); // transom
  const last = (st.length - 1) * 4;
  quad(idx, last, last + 1, last + 2, last + 3); // stem cap
  // Aft accommodation block, bridge deck, raked funnel, masts, hatches
  pushBox(pos, idx, -45, 5.8, -5.6, -30, 12.8, 5.6);
  pushBox(pos, idx, -43.5, 12.8, -4.8, -33, 15.0, 4.8);
  pushBox(pos, idx, -41, 15.0, -2.2, -37, 18.0, 2.2, -1.2);
  pushBox(pos, idx, -35.4, 15.0, -0.3, -34.9, 17.9, 0.3); // aft mast
  pushBox(pos, idx, 27.7, 5.0, -0.3, 28.3, 11.4, 0.3); // fore mast
  pushBox(pos, idx, -24, 4.7, -5.0, -14, 6.3, 5.0); // hatch coamings
  pushBox(pos, idx, -6, 4.6, -5.0, 10, 6.2, 5.0);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(pos), 3),
  );
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

// ---------------------------------------------------------------------------
// Lamps
// ---------------------------------------------------------------------------

interface LampDef {
  x: number;
  y: number;
  z: number;
  /** Sprite size in metres (angular: a few pixels at 1.4 km). */
  size: number;
  op: number;
  r: number;
  g: number;
  b: number;
  /** Side lamp gets its colour from the heading at spawn time. */
  side?: boolean;
  /** Twinkle phase offset. */
  ph: number;
}

const LAMPS: readonly LampDef[] = [
  // Masthead white, fore (lower) and aft (higher) – warm incandescent white
  { x: 28, y: 11.6, z: 0, size: 11, op: 1, r: 1, g: 0.93, b: 0.78, ph: 0 },
  {
    x: -35.15,
    y: 18.4,
    z: 0,
    size: 11,
    op: 1,
    r: 1,
    g: 0.93,
    b: 0.78,
    ph: 2.1,
  },
  // Sidelight on the shoreward bridge wing (green or red by heading)
  {
    x: -31.5,
    y: 13.1,
    z: 5.9,
    size: 8.5,
    op: 0.85,
    r: 0.2,
    g: 1,
    b: 0.35,
    side: true,
    ph: 4.4,
  },
  // Faint warm accommodation glow (two "windows")
  {
    x: -37.5,
    y: 9.6,
    z: 5.8,
    size: 10.0,
    op: 0.2,
    r: 1,
    g: 0.7,
    b: 0.4,
    ph: 1.2,
  },
  {
    x: -32.5,
    y: 10.8,
    z: 5.8,
    size: 8.0,
    op: 0.16,
    r: 1,
    g: 0.74,
    b: 0.45,
    ph: 3.3,
  },
];

// ---------------------------------------------------------------------------

export class HorizonTraffic {
  protected readonly scene: THREE.Scene;
  protected readonly quality: QualityId;

  private readonly group = new THREE.Group();
  private readonly hull: THREE.Mesh;
  private readonly hullMat: THREE.MeshBasicMaterial;
  private readonly lampTex: THREE.Texture;
  private readonly sprites: THREE.Sprite[] = [];
  private readonly sprMats: THREE.SpriteMaterial[] = [];

  /** Unwrapped world clock in game hours (env.timeOfDay with wrap counting). */
  private worldH = 0;
  private prevTod: number | null = null;
  private nightIdx = Number.NaN;
  private passes: Passage[] = [];
  private doneMask = 0;
  /**
   * The passage currently mid-crossing. Held as the object itself (not an
   * index) so a crossing that overruns 6:00 am survives the night re-roll:
   * the timetable flips underneath it, the vessel sails on regardless.
   */
  private active: Passage | null = null;
  /** Index of `active` in `passes` for doneMask bookkeeping; −1 once the
   *  night has rolled over and the slot no longer refers to this passage. */
  private activeIdx = -1;
  /** Real seconds into the active crossing. */
  private elapsed = 0;
  private hornT = 0;
  private hornGate = false;
  private hornCount = 0;

  private cam: THREE.PerspectiveCamera | null = null;
  private readonly tmpRight = new THREE.Vector3();
  private readonly hullCol = new THREE.Color();

  constructor(scene: THREE.Scene, quality: QualityId) {
    this.scene = scene;
    this.quality = quality;
    this.lampTex = shipLampTexture(quality);
    this.hullMat = new THREE.MeshBasicMaterial({
      color: 0x0c0f14,
      fog: false,
      side: THREE.DoubleSide,
    });
    this.hull = new THREE.Mesh(buildHull(), this.hullMat);
    this.group.add(this.hull);
    for (const def of LAMPS) {
      const mat = new THREE.SpriteMaterial({
        map: this.lampTex,
        color: new THREE.Color(def.r, def.g, def.b),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        opacity: 0,
        fog: false,
      });
      const spr = new THREE.Sprite(mat);
      spr.position.set(def.x, def.y, def.z);
      spr.scale.setScalar(def.size);
      spr.renderOrder = 3; // after the ocean (renderOrder 2)
      this.sprites.push(spr);
      this.sprMats.push(mat);
      this.group.add(spr);
    }
    this.group.name = "horizon-traffic";
    this.group.visible = false;
    if (import.meta.env.DEV) this.group.userData.traffic = this;
    scene.add(this.group);
  }

  /** Timetable of a night (dev/testing – deterministic, no state touched). */
  static timetable(nightIdx: number): Passage[] {
    return rollNight(nightIdx);
  }

  update(dt: number, env: Environment, camPos: THREE.Vector3): void {
    // ---- Unwrapped clock and per-night timetable ----
    const tod = env.timeOfDay;
    if (this.prevTod === null) {
      this.worldH = tod;
    } else {
      let d = tod - this.prevTod;
      if (d < -12) d += 24;
      else if (d > 12) d -= 24;
      this.worldH += d;
    }
    this.prevTod = tod;
    const nightIdx = Math.floor((this.worldH - 6) / 24);
    if (nightIdx !== this.nightIdx) {
      this.nightIdx = nightIdx;
      this.passes = rollNight(nightIdx);
      this.doneMask = 0;
      // A late second passage can still be mid-crossing at 6:00 am. `active`
      // keeps that vessel on its old lane/heading until it leaves the sweep;
      // only the index into the (now replaced) timetable is void.
      this.activeIdx = -1;
    }
    const nh = this.worldH - 24 * nightIdx;

    // ---- Activation: does the timetable put a vessel out right now? ----
    if (this.active === null) {
      for (let i = 0; i < this.passes.length; i++) {
        const q = this.passes[i];
        if (
          (this.doneMask & (1 << i)) === 0 &&
          nh >= q.start &&
          nh < q.start + q.durGh
        ) {
          this.active = q;
          this.activeIdx = i;
          this.elapsed = clamp((nh - q.start) / q.durGh, 0, 1) * q.crossDur;
          this.hornCount = 0;
          this.hornGate = false;
          this.spawn(q);
          break;
        }
      }
      if (this.active === null) {
        this.group.visible = false;
        return;
      }
    }

    // ---- Crossing (real time – smooth regardless of a frozen clock) ----
    const p = this.active;
    this.elapsed += dt;
    if (this.elapsed >= p.crossDur) {
      if (this.activeIdx >= 0) this.doneMask |= 1 << this.activeIdx;
      this.active = null;
      this.activeIdx = -1;
      this.group.visible = false;
      return;
    }
    const prog = this.elapsed / p.crossDur;
    const xw = p.dir * (prog * 2 * X_REACH - X_REACH);
    const zw = p.lane;

    // ---- Murk / visibility: lights on clear or plain-overcast nights,
    // hidden (and replaced by the horn) in rain, storm or a deck that sits
    // on the water. Crossfaded so lamps and horn never both run at full.
    const murk = Math.max(
      smoothstep(0.32, 0.5, env.rain),
      smoothstep(0.93, 0.99, env.cloud),
    );
    const dusk = 1 - smoothstep(0.03, 0.26, env.skyLight);
    const lampVis = dusk * (1 - murk);
    const sil = 0.34 * (1 - murk) * (1 - smoothstep(0.12, 0.45, env.skyLight));

    // ---- Transform: squash the vessel along the view ray exactly like the
    // ocean's far field, so depth agrees with the water in front and behind.
    const dx = xw - camPos.x;
    const dz = zw - camPos.z;
    const dist = Math.hypot(dx, dz);
    let f = 1;
    if (dist > SQUASH_0) {
      const s =
        SQUASH_0 +
        SQUASH_SPAN * (1 - Math.exp(-(dist - SQUASH_0) / SQUASH_SPAN));
      f = s / dist;
    }
    this.group.position.set(
      camPos.x + dx * f,
      camPos.y * (1 - f),
      camPos.z + dz * f,
    );
    this.group.scale.setScalar(f * p.kind);

    // ---- Silhouette: a touch darker than the dome at the sea horizon ----
    this.hullCol.copy(env.horizonSea).multiplyScalar(1 - sil);
    this.hullMat.color.copy(this.hullCol);

    // ---- Lamps: tiny, slightly scintillating points ----
    const t = env.envTime;
    for (let i = 0; i < LAMPS.length; i++) {
      const def = LAMPS[i];
      const tw =
        0.8 +
        0.2 * Math.sin(t * 2.1 + def.ph) * Math.sin(t * 3.7 + def.ph * 1.7);
      this.sprMats[i].opacity = def.op * lampVis * tw;
    }
    this.group.visible = lampVis > 0.004 || sil > 0.01;

    // ---- Foghorn in murk: every ~90 s, panned by the vessel's bearing ----
    const gate = murk > 0.55 && dusk > 0.05;
    if (gate && !this.hornGate) this.hornT = 6 + p.hornSeed * 9;
    this.hornGate = gate;
    if (gate) {
      this.hornT -= dt;
      if (this.hornT <= 0) {
        this.hornCount++;
        const jit =
          Math.abs(Math.sin(p.hornSeed * 913.7 + this.hornCount * 71.3)) % 1;
        this.hornT = HORN_BASE + jit * HORN_JITTER;
        const gain =
          clamp((0.7 * 1500) / dist, 0.4, 0.7) * smoothstep(0.55, 0.85, murk);
        sound.foghorn(gain, this.panTowards(dx, dz, dist));
      }
    }
  }

  /** Place hull and lamps for a passage (heading, sidelight colour). */
  private spawn(p: Passage): void {
    this.hull.rotation.y = p.dir === 1 ? 0 : Math.PI;
    for (let i = 0; i < LAMPS.length; i++) {
      const def = LAMPS[i];
      this.sprites[i].position.set(def.x * p.dir, def.y, def.z);
      if (def.side) {
        // Camera side is +z: heading +x shows starboard (green), −x port (red)
        if (p.dir === 1) this.sprMats[i].color.setRGB(0.2, 1, 0.35);
        else this.sprMats[i].color.setRGB(1, 0.16, 0.1);
      }
      this.sprMats[i].opacity = 0;
    }
  }

  /** Stereo pan of a world offset relative to the camera's view direction. */
  private panTowards(dx: number, dz: number, dist: number): number {
    if (!this.cam) {
      for (const child of this.scene.children) {
        if ((child as THREE.PerspectiveCamera).isPerspectiveCamera) {
          this.cam = child as THREE.PerspectiveCamera;
          break;
        }
      }
    }
    if (!this.cam || dist < 1e-3) return 0;
    this.tmpRight.setFromMatrixColumn(this.cam.matrixWorld, 0);
    return clamp((dx * this.tmpRight.x + dz * this.tmpRight.z) / dist, -1, 1);
  }

  /** Dev harness only (stripped from the production build): current state. */
  debugInfo(): Record<string, unknown> | null {
    if (!import.meta.env.DEV) return null;
    const p = this.active;
    return {
      worldH: this.worldH,
      nightIdx: this.nightIdx,
      passes: this.passes.map((q) => ({
        start: q.start,
        durGh: q.durGh,
        crossDur: q.crossDur,
        dir: q.dir,
        lane: q.lane,
      })),
      doneMask: this.doneMask,
      active: this.activeIdx,
      crossing: this.active !== null,
      elapsed: this.elapsed,
      progress: p ? this.elapsed / p.crossDur : 0,
      visible: this.group.visible,
      pos: p
        ? [
            p.dir * ((this.elapsed / p.crossDur) * 2 * X_REACH - X_REACH),
            p.lane,
          ]
        : null,
      hornGate: this.hornGate,
      hornIn: this.hornT,
      hornCount: this.hornCount,
    };
  }

  /** Dev harness only: let the next foghorn fire in `inSeconds`. */
  debugHorn(inSeconds = 0): void {
    if (!import.meta.env.DEV) return;
    this.hornT = inSeconds;
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.hull.geometry.dispose();
    this.hullMat.dispose();
    for (const m of this.sprMats) m.dispose();
    this.lampTex.dispose();
  }
}
