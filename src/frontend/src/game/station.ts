// Trash Simulator – recycling station: drop-off, storage and passive processing
// into tradable materials (glass cullet, PET flakes, metal scrap, …).
// The model (concrete yard, corrugated-iron hall, sorting plant, containers,
// floodlight) is built in station-build/-parts/-plant and merged into one mesh
// per material; only game logic and animation run here.

import * as THREE from "three";
import { clearColliderSet } from "./colliders";
import type { Environment } from "./sky";
import { sound } from "./sound";
import { useGame } from "./state";
import {
  SD,
  StationBag,
  type StationMaterials,
  makeStationMaterials,
} from "./station-build";
import { buildApron, buildHall, buildYard } from "./station-parts";
import { buildContainers, buildMasts, buildPlant } from "./station-plant";
import {
  type CategoryId,
  STATION_CAPACITY,
  TRASH_BY_ID,
  upgradeValue,
} from "./types";
import { terrainHeight } from "./world";

export const STATION_POS = { x: 96, z: 118 };

export class Station {
  readonly group = new THREE.Group();
  readonly position = new THREE.Vector3();

  private mats: StationMaterials;
  private meshes: THREE.Mesh[] = [];
  private drum: THREE.Mesh;
  private belt: THREE.Mesh;
  private gaugeBar: THREE.Mesh;
  private pools: THREE.Mesh;
  private flood: THREE.SpotLight;
  private floodTarget = new THREE.Object3D();
  private hallLight: THREE.PointLight;

  private processTimer = 0;
  private soundTimer = 0;
  private beltRun = 0;
  private night = 0;
  private lampSmooth = 0;

  constructor(scene: THREE.Scene) {
    const x = STATION_POS.x;
    const z = STATION_POS.z;
    const y = terrainHeight(x, z);
    this.position.set(x, y, z);
    this.group.position.copy(this.position);
    this.group.rotation.y = -0.4;

    this.mats = makeStationMaterials();
    const bag = new StationBag();
    buildApron(bag, this.mats.atlas);
    buildHall(bag, this.mats.atlas);
    buildYard(bag, this.mats.atlas);
    buildContainers(bag, this.mats.atlas);
    const plant = buildPlant(bag, this.mats.atlas);
    const pools = buildMasts(bag);

    for (const mesh of bag.build(this.mats.mats).values()) {
      this.group.add(mesh);
      this.meshes.push(mesh);
    }

    // Moving parts
    this.drum = new THREE.Mesh(plant.drum, this.mats.mats.steel);
    this.drum.position.copy(plant.drumAt);
    this.drum.castShadow = true;
    this.drum.receiveShadow = true;
    this.group.add(this.drum);

    this.belt = new THREE.Mesh(plant.belt, this.mats.belt);
    this.belt.receiveShadow = true;
    this.group.add(this.belt);

    this.gaugeBar = new THREE.Mesh(plant.gaugeBar, this.mats.gauge);
    this.gaugeBar.position.copy(plant.gaugeAt);
    this.group.add(this.gaugeBar);

    this.pools = new THREE.Mesh(pools, this.mats.pool);
    this.pools.renderOrder = 2;
    this.group.add(this.pools);

    // One yard floodlight is enough for the night mood (no shadow – too costly)
    this.flood = new THREE.SpotLight(0xffe6bd, 0, 46, 0.72, 0.55, 1.2);
    this.flood.position.set(6, 9.5, 4);
    this.floodTarget.position.set(0, 0, -1);
    this.group.add(this.flood);
    this.group.add(this.floodTarget);
    this.flood.target = this.floodTarget;

    // Hall light: keeps the gate opening readable instead of pitch black
    this.hallLight = new THREE.PointLight(0xffe4b8, 20, 16, 1.5);
    this.hallLight.position.set(SD.doorCx, 3.3, -1.9);
    this.group.add(this.hallLight);

    scene.add(this.group);
  }

  canInteract(pos: THREE.Vector3): boolean {
    return pos.distanceTo(this.position) < 11;
  }

  /** Drop-off from bucket + jeep. Returns items handed in and points earned. */
  deposit(): { count: number; points: number } {
    const st = useGame.getState();
    const before = { ...st.bucket };
    const beforeJeep = { ...st.jeepLoad };
    const res = st.depositAtStation();
    if (res.count > 0) {
      const cats = new Set<CategoryId>();
      const after = useGame.getState();
      const addCat = (typeId: string) => {
        const def = TRASH_BY_ID[typeId];
        if (def) cats.add(def.category);
      };
      for (const k of Object.keys(before))
        if ((after.bucket[k] ?? 0) < before[k]) addCat(k);
      for (const k of Object.keys(beforeJeep))
        if ((after.jeepLoad[k] ?? 0) < beforeJeep[k]) addCat(k);
      sound.dumpCascade([...cats]);
    }
    return res;
  }

  update(dt: number, env?: Environment): void {
    const st = useGame.getState();
    const stored = st.stationStored;

    // Passive processing: the plant works through `stationRate` items per
    // second. Sorting by material and the yield are done by the store
    // (`stationProcess`), here only the machines run.
    let running = false;
    if (stored > 0) {
      running = true;
      this.processTimer += dt;
      const rate = upgradeValue("stationRate", st.upgrades.stationRate ?? 0);
      if (this.processTimer >= 1) {
        this.processTimer -= 1;
        st.stationProcess(Math.min(stored, Math.round(rate)));
      }
      this.drum.rotation.x += dt * 1.35;
      this.soundTimer -= dt;
      if (this.soundTimer <= 0) {
        this.soundTimer = 5 + Math.random() * 6;
        sound.stationProcessSound();
      }
    }

    // The belt spins up and down (texture scrolls)
    const wantRun = running ? 1 : 0;
    this.beltRun += (wantRun - this.beltRun) * Math.min(1, dt * 1.6);
    if (this.beltRun > 0.002) {
      const off = -dt * this.beltRun * 0.55;
      const m = this.mats.belt;
      for (const t of [m.map, m.normalMap, m.roughnessMap]) {
        if (t) t.offset.x = (t.offset.x + off) % 1;
      }
    }

    // Day/night: floodlight, hall light, flashing beacon
    this.night = 1 - dayFactor(env, st.env.timeOfDay);
    const blink = running && Math.sin(performance.now() * 0.0065) > 0 ? 1 : 0;
    const target = this.night;
    this.lampSmooth += (target - this.lampSmooth) * Math.min(1, dt * 2.2);
    const l = this.mats.lampI.value;
    l.x = 0.25 + this.lampSmooth * 2.6;
    l.y = blink ? 2.4 : 0.05;
    l.z = 0.12 + this.lampSmooth * 1.5;
    l.w = 0.3 + this.lampSmooth * 0.5;
    this.flood.intensity = this.lampSmooth * 210;
    this.hallLight.intensity = 11 + this.lampSmooth * 22;
    this.mats.setEnvIntensity(0.14 + (1 - this.lampSmooth) * 0.86);
    const pm = this.mats.pool;
    pm.opacity = this.lampSmooth * 0.5;
    this.pools.visible = pm.opacity > 0.01;

    // Fill-level bar in the slot of the gauge
    const f = Math.min(1, stored / Math.max(1, STATION_CAPACITY));
    this.gaugeBar.scale.y = Math.max(0.03, f * 0.86);
    this.mats.gauge.color.setHSL(0.33 - f * 0.33, 0.72, 0.46);
    this.mats.gauge.emissive.setHSL(
      0.33 - f * 0.33,
      0.8,
      0.1 + this.night * 0.16,
    );
  }

  dispose(): void {
    // The yard registered static world colliders on build – drop exactly the
    // station's own groups so a disposed station leaves no invisible walls
    // behind without wiping colliders other modules may register.
    for (const tag of [
      "station-apron",
      "station-hall",
      "station-yard",
      "station-bins",
      "station-plant",
      "station-masts",
    ])
      clearColliderSet(tag);
    this.group.parent?.remove(this.group);
    for (const m of this.meshes) m.geometry.dispose();
    this.drum.geometry.dispose();
    this.belt.geometry.dispose();
    this.gaugeBar.geometry.dispose();
    this.pools.geometry.dispose();
    this.mats.dispose();
  }
}

/** Daylight fraction 0..1 – from the environment, otherwise from the clock. */
function dayFactor(env: Environment | undefined, tod: number): number {
  if (env) return Math.min(1, env.dayI + env.moonI * 0.12);
  const up = smooth(5.6, 7.2, tod);
  const down = 1 - smooth(17.2, 18.9, tod);
  return Math.min(up, down);
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Footprint of the yard (for collision/placement queries of other modules). */
export const STATION_APRON = { halfX: SD.apronX, halfZ: SD.apronZ, yaw: -0.4 };
