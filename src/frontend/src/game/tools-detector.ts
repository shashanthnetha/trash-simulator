// Metal detector and trowel – a marketplace upgrade ("detector", with
// "detectorTune" widening the search radius via upgradeValue; the module
// multiplies those tuning values by TUNE_MULT so the edge of range sits at
// ~5.6/7.2/9.6 m). Equipped on foot via the 1/2 keys, the mouse wheel or
// the touch Tool button (store `tool`), it sweeps a seeded buried spawn
// layer along the foreshore and around the built places.
//
// HOW DETECTION WORKS (no hidden conditions): while the detector is the
// equipped tool on foot, update() finds the nearest un-dug spawn within the
// tuned radius every frame – simply WALKING within range is enough. VLF-
// style beeps rise in rate and pitch as the distance closes (~1.2 s apart /
// low at the edge, ~0.12 s / high close in; sound.detectorBlip), inside
// PINPOINT (0.9 m) a solid tone sounds (sound.detectorTone), a scuff ring
// marks the sand and the F action digs the find out with the trowel
// (sound.digScoop). The shared `detectorSignal` state mirrors all of this
// for the viewmodel's LCD bar and blinking signal lamp. Dug spawns persist
// in the save (store `buriedTaken`, setBuriedTaken); deep-buried trash is
// worth bonus points, and a share of the signals are small curios worth
// points outright.
//
// The layer is deterministic per world seed (mulberry32): candidates are
// rejection-sampled along the foreshore band and in loose rings around the
// built places, then filtered against landformKeepOut, the water line, the
// built-surface ground overrides and a minimum spacing. Ids follow the
// accepted order ("b0", "b1", …), so a save's buriedTaken keys stay valid.

import * as THREE from "three";
import { groundHeight } from "./ground";
import { landformKeepOut } from "./landforms";
import { campSite } from "./landmark-camp";
import { mulberry32 } from "./noise";
import type { Environment } from "./sky";
import { sound } from "./sound";
import { useGame } from "./state";
import { STATION_POS } from "./station";
import { shoreZ, terrainHeight } from "./terrain";
import { applyPbr, pbrSand } from "./textures";
import { digHoleTexture, scuffRingTexture } from "./tools-detector-textures";
import { CATEGORIES, type QualityId, TRASH_BY_ID, upgradeValue } from "./types";

/** The dig (or other) interaction currently offered under the crosshair. */
export interface DetectorInteraction {
  /** HUD prompt without the key name (the engine prefixes "F: "). */
  prompt: string;
  run: () => void;
}

/**
 * Live signal state shared with the viewmodel (player-viewmodel.ts drives
 * the pod's LCD bar and the blinking lamp from it). Written once per frame
 * by Detector.update – a plain module singleton, no allocation.
 */
export const detectorSignal = {
  /** True while the detector is the equipped tool on foot. */
  active: false,
  /** 0..1 strength of the nearest live signal (0 = none in range). */
  level: 0,
  /** Jumps to 1 at the instant of each beep and decays – lamp blink. */
  pulse: 0,
  /** True at a pinpoint (solid tone; the dig is offered). */
  locked: false,
};

// ---------------------------------------------------------------------------
// Buried layer data
// ---------------------------------------------------------------------------

interface BuriedSpawn {
  id: string;
  x: number;
  z: number;
  kind: "trash" | "curio";
  /** Trash type id, or an index into CURIOS as a string key. */
  typeId: string;
}

/**
 * Small one-off curios (fictional): dug up whole, they pay points and XP
 * directly instead of taking bucket space. Not part of the rare-collectible
 * display case – adding new display variants would need new catalogue
 * entries and 3D models outside this module's remit.
 */
const CURIOS: ReadonlyArray<{
  id: string;
  name: string;
  pts: number;
  xp: number;
}> = [
  { id: "curio_button", name: "Old brass button", pts: 18, xp: 24 },
  { id: "curio_thimble", name: "Silver thimble", pts: 26, xp: 30 },
  { id: "curio_shilling", name: "Worn shilling", pts: 32, xp: 36 },
  { id: "curio_buckle", name: "Verdigris belt buckle", pts: 22, xp: 28 },
  { id: "curio_key", name: "Rusted mortice key", pts: 20, xp: 26 },
  { id: "curio_marble", name: "Sea-glass marble", pts: 16, xp: 22 },
  { id: "curio_spoon", name: "Pewter spoon", pts: 24, xp: 28 },
];
const CURIO_BY_ID = Object.fromEntries(CURIOS.map((c) => [c.id, c]));

/** Buried trash mix – metal-biased, the sort of thing a detector rings on. */
const BURIED_TRASH: ReadonlyArray<readonly [string, number]> = [
  ["can", 5],
  ["can_crushed", 4],
  ["sheet_metal", 4],
  ["cable", 4],
  ["tool", 3],
  ["spray_can", 2],
  ["canister", 1.5],
  ["glass_green", 1.5],
  ["glass_brown", 1.5],
  ["old_bucket", 1],
  ["flip_flop", 1],
  ["drum", 0.5],
];

/** Loose rings around the built places the layer also seeds into. */
const PLACE_RINGS: ReadonlyArray<
  readonly [x: number, z: number, rMin: number, rMax: number, tries: number]
> = [
  [-285, 330, 52, 72, 7], // chapel knoll (keep-out r 50)
  [235, 350, 44, 62, 6], // old tip (keep-out r 42)
  [-153, 363, 20, 32, 4], // the bothy (clearing r 18)
  [330, 150, 46, 62, 4], // lighthouse knoll (keep-out r 44)
  [128, 16, 7, 22, 4], // cable house
  [-150, -40, 10, 28, 4], // pier root on the beach
  [-190, -51, 8, 20, 4], // stranded boat
  [205, 2, 7, 20, 4], // washed-up container
  [162, 23, 7, 18, 4], // pillbox on East Beach
  [-27.5, 165, 16, 28, 4], // wardens' camp (real site via campSite())
];

/** Extra spacing so neighbouring signals cannot blur into one sweep. */
const MIN_SPACING = 5;
/**
 * Module-side widening of the "detectorTune" upgrade values (3.5/4.5/6 m in
 * types.ts): the effective edge of range is ~5.6/7.2/9.6 m, so a sweeping
 * walk along the foreshore rings every few strides instead of never.
 */
const TUNE_MULT = 1.6;
/** Beep cadence: seconds between beeps at the edge of range / at pinpoint. */
const BEEP_SLOW = 1.2;
const BEEP_FAST = 0.12;
/** Pinpoint radius: inside this the solid tone sounds and the dig is offered. */
const PINPOINT = 0.9;
/** Length of the dig moment in seconds. */
const DIG_TIME = 0.8;
/** Deep-find bonus: category drop-off value times this, plus flat XP. */
const DEEP_BONUS_MULT = 4;
const DEEP_BONUS_XP = 15;
/** In-game day length in real seconds (matches sky.ts: a day in 36 min). */
const DAY_SECONDS = 36 * 60;
/** How many dug holes stay visible at once (oldest is reused). */
const MAX_HOLES = 10;

function validSpot(x: number, z: number): boolean {
  if (x < -365 || x > 365 || z < -100 || z > 372) return false;
  // Never below the low-tide line (waveReach minimum ≈ 1.4 m up the beach).
  const d = z - shoreZ(x);
  if (d < 2.5) return false;
  if (landformKeepOut(x, z)) return false;
  // Built surfaces (station apron, pier deck, boardwalk, tip skin …) override
  // the analytic terrain – nothing may be buried under a floor.
  const th = terrainHeight(x, z);
  if (Math.abs(groundHeight(x, z) - th) > 0.03) return false;
  // The recycling station's yard (the apron test above only covers concrete).
  if (Math.hypot(x - STATION_POS.x, z - STATION_POS.z) < 26) return false;
  // The camp's ACTUAL clearing (may sit well off its anchor).
  const camp = campSite();
  if (Math.hypot(x - camp.x, z - camp.z) < 14) return false;
  return true;
}

/** Deterministic buried layer for a world seed (~150–180 accepted spawns). */
function generateSpawns(seed: number): BuriedSpawn[] {
  const rng = mulberry32((seed ^ 0xb0d1e5) >>> 0);
  const out: BuriedSpawn[] = [];
  const totalW = BURIED_TRASH.reduce((a, [, w]) => a + w, 0);

  const accept = (x: number, z: number): void => {
    if (!validSpot(x, z)) return;
    for (const s of out) {
      if (Math.hypot(s.x - x, s.z - z) < MIN_SPACING) return;
    }
    let kind: BuriedSpawn["kind"] = "trash";
    let typeId: string;
    if (rng() < 0.22) {
      kind = "curio";
      typeId = CURIOS[Math.floor(rng() * CURIOS.length)].id;
    } else {
      let r = rng() * totalW;
      typeId = BURIED_TRASH[0][0];
      for (const [id, w] of BURIED_TRASH) {
        r -= w;
        if (r <= 0) {
          typeId = id;
          break;
        }
      }
    }
    out.push({ id: `b${out.length}`, x, z, kind, typeId });
  };

  // Foreshore band along the whole coast (the bulk of the layer).
  for (let i = 0; i < 175; i++) {
    const x = -350 + rng() * 700;
    const d = 3 + rng() ** 1.4 * 22;
    accept(x, shoreZ(x) + d);
  }
  // Loose scatter around the built places.
  for (const [px, pz, rMin, rMax, tries] of PLACE_RINGS) {
    for (let i = 0; i < tries; i++) {
      const a = rng() * Math.PI * 2;
      const r = rMin + rng() * (rMax - rMin);
      accept(px + Math.cos(a) * r, pz + Math.sin(a) * r);
    }
  }
  return out;
}

/**
 * Dev harness: the deterministic layer for a seed – identical to what a
 * Detector built for that seed sweeps (generateSpawns is pure).
 */
export function buriedLayerDev(seed: number): ReadonlyArray<{
  id: string;
  x: number;
  z: number;
  kind: "trash" | "curio";
  typeId: string;
}> {
  return generateSpawns(seed);
}

// ---------------------------------------------------------------------------

interface HoleSlot {
  group: THREE.Group;
  decalMat: THREE.MeshStandardMaterial;
  mound: THREE.Mesh;
  /** dayClock when dug; the slot fades out over the following day. */
  born: number;
  active: boolean;
}

export class Detector {
  protected readonly scene: THREE.Scene;
  protected readonly quality: QualityId;

  private readonly spawns: BuriedSpawn[];
  /** Continuous session clock in in-game days (36 real minutes = 1 day). */
  private dayClock = 0;

  private equipped = false;
  private introShown = false;
  private blipT = 0;
  /** Spawn id the lock tone last fired for (reset when the coil moves off). */
  private lockedId: string | null = null;
  private pinpoint: BuriedSpawn | null = null;
  private digT = 0;
  private digSpawn: BuriedSpawn | null = null;
  private digScooped = false;
  private time = 0;

  // Ground marker at the pinpointed spot
  private readonly marker: THREE.Mesh;
  private readonly markerMat: THREE.MeshStandardMaterial;

  // Dug holes (pooled)
  private readonly holes: HoleSlot[] = [];
  private readonly holeDecalGeo: THREE.BufferGeometry;
  private readonly moundGeo: THREE.BufferGeometry;
  private readonly moundMat: THREE.MeshStandardMaterial;

  // Cached interaction (no per-frame allocation)
  private readonly act: DetectorInteraction;
  /** Player position of the last interaction pass – spawnHole throws the
   *  spoil on the far side of the hole from where the digger stood. */
  private lastPx = 0;
  private lastPz = 0;

  private readonly tmpV = new THREE.Vector3();
  private readonly tmpN = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(scene: THREE.Scene, quality: QualityId) {
    this.scene = scene;
    this.quality = quality;
    this.spawns = generateSpawns(useGame.getState().seed);

    this.markerMat = new THREE.MeshStandardMaterial({
      map: scuffRingTexture(quality),
      transparent: true,
      depthWrite: false,
      roughness: 1,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const markerGeo = new THREE.CircleGeometry(0.52, 24);
    markerGeo.rotateX(-Math.PI / 2); // decal lies flat; the group tilts it
    this.marker = new THREE.Mesh(markerGeo, this.markerMat);
    this.marker.renderOrder = 1;
    this.marker.visible = false;
    this.marker.castShadow = false;
    this.marker.receiveShadow = false;
    scene.add(this.marker);

    this.holeDecalGeo = new THREE.CircleGeometry(0.5, 20);
    this.holeDecalGeo.rotateX(-Math.PI / 2);
    // Small spoil mound beside the hole: a squashed dome of damp sand whose
    // skirt runs on below grade (theta past π/2), so the silhouette always
    // ends IN the sand instead of floating as a capped rim above it.
    this.moundGeo = new THREE.SphereGeometry(1, 14, 8, 0, Math.PI * 2, 0, 2.05);
    this.moundMat = new THREE.MeshStandardMaterial({
      color: "#b3a184",
      roughness: 1,
      metalness: 0,
    });
    applyPbr(this.moundMat, pbrSand(), [0.4, 0.4]);
    this.moundMat.color.set("#b3a184");

    this.act = {
      prompt: "Dig here",
      run: () => this.startDig(),
    };
  }

  update(
    dt: number,
    _env: Environment,
    camera: THREE.PerspectiveCamera,
    equipped: boolean,
  ): void {
    this.dayClock += dt / DAY_SECONDS;
    this.time += dt;
    this.updateHoles();
    // Lamp pulse decays every frame; each beep below re-arms it to 1.
    detectorSignal.pulse = Math.max(0, detectorSignal.pulse - dt * 9);

    const st = useGame.getState();
    if (!equipped) {
      if (this.equipped) {
        // Unequipped mid-search: drop the pinpoint and any running dig.
        this.pinpoint = null;
        this.lockedId = null;
        this.digT = 0;
        this.digSpawn = null;
        this.marker.visible = false;
      }
      this.equipped = false;
      detectorSignal.active = false;
      detectorSignal.level = 0;
      detectorSignal.locked = false;
      detectorSignal.pulse = 0;
      sound.detectorTone(false);
      return;
    }
    if (!this.equipped) {
      this.equipped = true;
      this.blipT = 0.3;
      if (!this.introShown) {
        this.introShown = true;
        st.toast(
          "Sweep the foreshore near the waterline – the beeps quicken and rise over a buried find. A solid tone means: press F to dig.",
          "info",
        );
      }
    }
    detectorSignal.active = true;

    // A running dig: two trowel scoops, then the find pops out. The solid
    // tone pauses (the coil is set aside), the lamp stays lit.
    if (this.digSpawn) {
      detectorSignal.level = 1;
      detectorSignal.locked = true;
      sound.detectorTone(false);
      const half = DIG_TIME * 0.45;
      this.digT -= dt;
      if (!this.digScooped && this.digT <= half) {
        this.digScooped = true;
        sound.digScoop();
      }
      if (this.digT <= 0) this.finishDig();
      return;
    }

    // Sweep: nearest live signal within the (module-widened) tuned radius.
    const radius =
      upgradeValue("detectorTune", st.upgrades.detectorTune ?? 0) * TUNE_MULT;
    camera.getWorldPosition(this.tmpV);
    const px = this.tmpV.x;
    const pz = this.tmpV.z;
    let best: BuriedSpawn | null = null;
    let bestD = radius;
    for (const s of this.spawns) {
      if (st.buriedTaken[s.id] != null) continue;
      const d = Math.hypot(s.x - px, s.z - pz);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }

    if (!best) {
      this.pinpoint = null;
      this.lockedId = null;
      this.marker.visible = false;
      detectorSignal.level = 0;
      detectorSignal.locked = false;
      sound.detectorTone(false);
      return;
    }

    const sig = 1 - bestD / radius;
    detectorSignal.level = sig;

    if (bestD < PINPOINT) {
      // Pinpoint: solid tone (plus a confirmation chirp on first lock).
      if (this.lockedId !== best.id) {
        this.lockedId = best.id;
        sound.detectorLock();
      }
      detectorSignal.locked = true;
      sound.detectorTone(true, sig);
      this.blipT = Math.min(this.blipT, 0.05); // beeps resume promptly after
      this.pinpoint = best;
      // Subtle scuff ring so the dig spot reads on the sand.
      const y = groundHeight(best.x, best.z) + 0.025;
      this.marker.position.set(best.x, y, best.z);
      this.alignToGround(this.marker, best.x, best.z);
      const pulse = 1 + Math.sin(this.time * 4) * 0.05;
      this.marker.scale.setScalar(pulse);
      this.markerMat.opacity = 0.62 + Math.sin(this.time * 4) * 0.14;
      this.marker.visible = true;
    } else {
      // VLF beeps: rate and pitch climb as the coil closes in
      // (~BEEP_SLOW apart at the edge → ~BEEP_FAST near the pinpoint).
      detectorSignal.locked = false;
      sound.detectorTone(false);
      this.blipT -= dt;
      if (this.blipT <= 0) {
        sound.detectorBlip(sig);
        detectorSignal.pulse = 1;
        this.blipT = BEEP_FAST * (BEEP_SLOW / BEEP_FAST) ** (1 - sig);
      }
      this.pinpoint = null;
      this.marker.visible = false;
      // Re-arm the lock chirp once the coil has clearly moved off the spot.
      if (this.lockedId === best.id && bestD > PINPOINT * 1.6) {
        this.lockedId = null;
      }
    }
  }

  /** Called once per frame from the engine's interaction pass. */
  interaction(
    playerPos: THREE.Vector3,
    _camera: THREE.PerspectiveCamera,
  ): DetectorInteraction | null {
    this.lastPx = playerPos.x;
    this.lastPz = playerPos.z;
    const st = useGame.getState();
    if (!this.equipped || st.inJeep || st.tool !== "detector") return null;
    if (this.digSpawn) return null;
    const p = this.pinpoint;
    if (!p) return null;
    if (Math.hypot(p.x - playerPos.x, p.z - playerPos.z) > PINPOINT * 1.5) {
      return null;
    }
    return this.act;
  }

  // ------------------------------------------------------------------ dig --

  private startDig(): void {
    const p = this.pinpoint;
    if (!p || this.digSpawn) return;
    const st = useGame.getState();
    if (p.kind === "trash" && st.bucketCount >= st.bucketCapacity()) {
      st.toast("Your bucket is full – the find stays put for now.", "warn");
      return;
    }
    this.digSpawn = p;
    this.digT = DIG_TIME;
    this.digScooped = false;
    sound.digScoop();
  }

  private finishDig(): void {
    const p = this.digSpawn;
    this.digSpawn = null;
    if (!p) return;
    const st = useGame.getState();
    if (p.kind === "trash") {
      const def = TRASH_BY_ID[p.typeId];
      if (!def || !st.pickup(p.typeId)) {
        st.toast("Your bucket is full – the find stays put for now.", "warn");
        return;
      }
      const bonus = CATEGORIES[def.category].value * DEEP_BONUS_MULT;
      st.addDeepBonus(bonus, DEEP_BONUS_XP);
      st.float(`Deep find: ${def.name} +${bonus} pts`, "#ffd76a");
    } else {
      const c = CURIO_BY_ID[p.typeId] ?? CURIOS[0];
      st.addDeepBonus(c.pts, c.xp);
      st.float(`✦ ${c.name} +${c.pts} pts`, "#ffd76a");
      st.toast(`Deep find: ${c.name} (+${c.pts} pts)`, "good");
    }
    st.setBuriedTaken({ ...st.buriedTaken, [p.id]: this.dayClock });
    this.spawnHole(p.x, p.z);
    this.pinpoint = null;
    this.lockedId = null;
    this.marker.visible = false;
  }

  // ---------------------------------------------------------------- holes --

  /** Tilt a flat decal (or the hole group) to the local ground slope. */
  private alignToGround(obj: THREE.Object3D, x: number, z: number): void {
    const e = 0.45;
    const dx = groundHeight(x - e, z) - groundHeight(x + e, z);
    const dz = groundHeight(x, z - e) - groundHeight(x, z + e);
    this.tmpN.set(dx, 2 * e, dz).normalize();
    obj.quaternion.setFromUnitVectors(this.up, this.tmpN);
  }

  private spawnHole(x: number, z: number): void {
    let slot: HoleSlot | undefined;
    for (const h of this.holes) {
      if (!h.active) {
        slot = h;
        break;
      }
    }
    if (!slot && this.holes.length < MAX_HOLES) {
      const decalMat = new THREE.MeshStandardMaterial({
        map: digHoleTexture(this.quality),
        transparent: true,
        depthWrite: false,
        roughness: 1,
        metalness: 0,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      const decal = new THREE.Mesh(this.holeDecalGeo, decalMat);
      decal.renderOrder = 1;
      decal.castShadow = false;
      decal.receiveShadow = false;
      const mound = new THREE.Mesh(this.moundGeo, this.moundMat);
      mound.castShadow = false;
      mound.receiveShadow = true;
      const group = new THREE.Group();
      group.add(decal, mound);
      this.scene.add(group);
      slot = { group, decalMat, mound, born: 0, active: false };
      this.holes.push(slot);
    }
    if (!slot) {
      // Pool exhausted: reuse the oldest hole.
      slot = this.holes[0];
      for (const h of this.holes) if (h.born < slot.born) slot = h;
    }
    const y = groundHeight(x, z);
    slot.group.position.set(x, y + 0.02, z);
    this.alignToGround(slot.group, x, z);
    // Spoil thrown against the hole's far rim, seen from where the digger
    // stood: sunk below grade so the buried skirt blends the pile into the
    // ground (no floating cap, no rim-shadow gap), stretched off-round and
    // kept clear of the dark hole centre so both read together.
    const away = Math.atan2(x - this.lastPx, z - this.lastPz);
    slot.mound.position.set(
      Math.sin(away + 0.35) * 0.33,
      -0.026,
      Math.cos(away + 0.35) * 0.33,
    );
    slot.mound.rotation.y = away;
    slot.mound.scale.set(0.21, 0.055, 0.17);
    slot.born = this.dayClock;
    slot.active = true;
    slot.group.visible = true;
    slot.decalMat.opacity = 0.95;
  }

  /** Holes fade over the following in-game day; the wind levels the spoil. */
  private updateHoles(): void {
    for (const h of this.holes) {
      if (!h.active) continue;
      const age = this.dayClock - h.born;
      if (age >= 1 || age < 0) {
        h.active = false;
        h.group.visible = false;
        continue;
      }
      const f = 1 - age;
      h.decalMat.opacity = 0.95 * f;
      // The dome flattens towards its (below-grade) centre plane, so the
      // wind visibly levels the spoil back into the beach as it ages.
      h.mound.scale.set(
        0.21 * (0.4 + 0.6 * f),
        0.055 * f,
        0.17 * (0.4 + 0.6 * f),
      );
    }
  }

  dispose(): void {
    detectorSignal.active = false;
    detectorSignal.level = 0;
    detectorSignal.pulse = 0;
    detectorSignal.locked = false;
    sound.detectorTone(false);
    this.scene.remove(this.marker);
    this.marker.geometry.dispose();
    this.markerMat.dispose();
    for (const h of this.holes) {
      this.scene.remove(h.group);
      h.decalMat.dispose();
    }
    this.holes.length = 0;
    this.holeDecalGeo.dispose();
    this.moundGeo.dispose();
    this.moundMat.dispose();
  }
}
