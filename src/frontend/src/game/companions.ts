// Trash Simulator – companions: collecting dog and delivery drone.
// The state machines, the flight dynamics and the audio hooks live here, the
// models, the shell fur and the gait in companions-dog.ts /
// companions-drone.ts.
//
// Dog: idle → seek → grab → return, plus idle variation (sniffing, sitting)
// while it is waiting next to the player. It barks sparingly – a global
// cooldown makes sure two triggers never machine-gun.
// Drone: hover (escorts the player) → seek → descend → toJeep → drop. It flies
// like a real quad: the position controller commands an acceleration, the
// airframe tilts into it, yaw follows the flight path with lag, wind pushes it
// off course and the drone leans against it. At night a single green beacon
// pulses slowly on its belly.

import * as THREE from "three";
import {
  type DogGait,
  type DogModel,
  type DogPose,
  animateDog,
  buildDog,
  newGait,
  newPose,
  setDogFurLod,
} from "./companions-dog";
import { type DroneModel, buildDrone } from "./companions-drone";
import { groundHeight } from "./ground";
import { sound } from "./sound";
import { useGame } from "./state";
import type { TrashField } from "./trash";
import { type QualityId, upgradeValue } from "./types";
import type { Environment } from "./world";
import { terrainHeight } from "./world";

type DogState = "idle" | "seek" | "grab" | "return" | "wait";
type DogIdleAct = "none" | "sniff" | "sit";
type DroneState = "hover" | "seek" | "descend" | "toJeep" | "drop";

/**
 * Never two barks closer together than this (seconds). Measured in review:
 * with 9.5 s and an ungated delivery bark the dog averaged ~3 barks/min while
 * fetching – reads as yapping. Target is ≤ 1 bark/min during work.
 */
const BARK_COOLDOWN = 18;
/** Only this share of the "new target spotted" triggers actually barks. */
const BARK_SPOT_CHANCE = 0.3;
/** Only this share of the deliveries is announced with a bark. */
const BARK_DELIVER_CHANCE = 0.3;
/** Beyond this the dog stays silent altogether. */
const BARK_MAX_DIST = 80;
/** The idle bark only fires when the dog is this close to the camera. */
const BARK_IDLE_DIST = 50;
const DOG_SOUND_RANGE = 80;
const DRONE_SOUND_RANGE = 55;
/** Period of the green night beacon in seconds (≈ 1 flash / 1.2 s). */
const NAV_PERIOD = 1.2;
const GRAVITY = 9.81;
/**
 * Camera distance (m) beyond which the fur shells are dropped entirely. Each
 * furry part is one extra draw call, and past this distance a shell is thinner
 * than a pixel anyway – the lower tiers drop them earlier.
 */
// medium/low must stay ABOVE FUR_FULL: if the two coincide, the "half shells"
// bucket is unreachable and the coat pops full ↔ off in a single frame.
const FUR_CULL: Record<QualityId, number> = {
  ultra: 14,
  high: 14,
  medium: 12,
  low: 12,
};
/** Below this distance the full shell count is used, above it half of it. */
const FUR_FULL = 9;
/**
 * Hysteresis (m) around both fur LOD thresholds: a dog trotting along the
 * boundary would otherwise pop furry↔smooth every few frames. Stepping DOWN
 * uses threshold + margin, stepping UP uses threshold − margin.
 */
const FUR_HYST = 1.5;

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

function sstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Shortest signed angle difference. */
function wrapPi(a: number): number {
  let d = a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Move `cur` towards `to` with a time constant (frame-rate independent). */
function approach(cur: number, to: number, rate: number, dt: number): number {
  return cur + (to - cur) * Math.min(1, rate * dt);
}

export class Companions {
  private scene: THREE.Scene;
  private trash: TrashField;
  private time = 0;

  // Dog
  private dog: DogModel | null = null;
  private gait: DogGait = newGait();
  private pose: DogPose = newPose();
  private dogState: DogState = "idle";
  private dogPos = new THREE.Vector3();
  private dogYaw = 0;
  private dogSpeed = 0;
  private dogCooldown = 2;
  private dogTarget: {
    typeIdx: number;
    instanceId: number;
    pos: THREE.Vector3;
  } | null = null;
  private dogCarry: THREE.Mesh | null = null;
  private dogCarryType = "";
  private dogHappy = 0;
  private dogAlert = 0;
  private waitTimer = 0;
  private dogTime = 0;
  private furLod = -1;
  /** Fur cull distance of the current quality tier (set when the dog spawns). */
  private furCull = FUR_CULL.high;
  // Idle variation
  private idleStill = 0;
  private idleAct: DogIdleAct = "none";
  private idleActT = 0;
  private nextSniff = 9;
  private sniffB = 0;
  private sitB = 0;
  private crouchT = 0;
  private barkImp = 0;
  // Barking
  private barkCd = 3;
  private nextIdleBark = 34;

  // Drone
  private drone: DroneModel | null = null;
  private droneState: DroneState = "hover";
  private dronePos = new THREE.Vector3();
  private droneVel = new THREE.Vector3();
  private droneYaw = 0;
  private dronePitch = 0;
  private droneRoll = 0;
  private droneCooldown = 3;
  private droneTarget: {
    typeIdx: number;
    instanceId: number;
    pos: THREE.Vector3;
  } | null = null;
  private droneCarry: THREE.Mesh | null = null;
  private droneCarryType = "";
  private rotorSpin = 0;
  private throttle = 0;
  private spool = 0;
  private navPhase = 0;
  private droneAudible = false;

  // Reused temporaries – nothing is allocated per frame
  private tmpV = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private ctrlAcc = new THREE.Vector3();
  private wantVel = new THREE.Vector3();
  private turb = new THREE.Vector3();
  private camRight = new THREE.Vector3();
  private moveDelta = new THREE.Vector3();
  private escort = new THREE.Vector3();
  private sndPan = 0;
  private sndDist = 1;

  constructor(scene: THREE.Scene, trash: TrashField) {
    this.scene = scene;
    this.trash = trash;
  }

  // --------------------------- Audio helpers ---------------------------

  /**
   * Pan (−1..1 along the camera's right vector) and normalised distance of a
   * point. Writes to sndPan/sndDist so nothing is allocated per frame.
   */
  private listen(
    pos: THREE.Vector3,
    range: number,
    fallback: THREE.Vector3,
    camera?: THREE.PerspectiveCamera,
  ): number {
    const from = camera ? camera.position : fallback;
    this.tmpB.copy(pos).sub(from);
    const d = this.tmpB.length();
    if (camera && d > 1e-3) {
      this.camRight.setFromMatrixColumn(camera.matrixWorld, 0);
      this.sndPan = clamp(this.tmpB.dot(this.camRight) / d, -1, 1);
    } else {
      this.sndPan = 0;
    }
    this.sndDist = clamp(d / range, 0, 1);
    return d;
  }

  // ----------------------------- Dog -----------------------------

  private spawnDog(at: THREE.Vector3): void {
    const quality = useGame.getState().settings.quality;
    const model = buildDog(quality);
    this.furCull = FUR_CULL[quality];
    this.dogPos.copy(at);
    model.root.position.copy(at);
    this.scene.add(model.root);
    this.dog = model;
    this.furLod = -1;
  }

  private dogSpeedInterval(): number {
    return upgradeValue("dogSpeed", useGame.getState().upgrades.dogSpeed ?? 0);
  }

  /** One bark, subject to the global cooldown and the maximum distance. */
  private bark(dist: number): void {
    if (this.barkCd > 0 || dist > BARK_MAX_DIST) return;
    sound.dogBark(this.sndPan, this.sndDist);
    this.barkCd = BARK_COOLDOWN + Math.random() * 5;
    this.barkImp = 1;
  }

  /** Idle variation: sniff the sand now and then, sit down after a long wait. */
  private updateIdleAct(dt: number, standingStill: boolean): void {
    if (standingStill) {
      this.idleStill += dt;
      if (this.idleAct === "sniff") {
        this.idleActT -= dt;
        if (this.idleActT <= 0) {
          this.idleAct = "none";
          this.nextSniff = this.idleStill + 8 + Math.random() * 12;
        }
      } else if (this.idleAct === "none") {
        if (this.idleStill > 20) this.idleAct = "sit";
        else if (this.idleStill > this.nextSniff) {
          this.idleAct = "sniff";
          this.idleActT = 2 + Math.random();
        }
      }
    } else {
      this.idleStill = 0;
      this.idleAct = "none";
      this.nextSniff = 9 + Math.random() * 8;
    }
    this.sniffB = approach(
      this.sniffB,
      this.idleAct === "sniff" ? 1 : 0,
      2.4,
      dt,
    );
    this.sitB = approach(
      this.sitB,
      this.idleAct === "sit" ? 1 : 0,
      this.idleAct === "sit" ? 1.3 : 3.2,
      dt,
    );
  }

  private updateDog(
    dt: number,
    playerPos: THREE.Vector3,
    env?: Environment,
    camera?: THREE.PerspectiveCamera,
  ): void {
    const st = useGame.getState();
    const owned = (st.upgrades.dog ?? 0) >= 1;
    if (!owned) return;
    if (!this.dog) {
      this.spawnDog(this.tmpV.set(playerPos.x + 2, 0, playerPos.z + 2));
      this.barkCd = 0;
      this.listen(this.dogPos, DOG_SOUND_RANGE, playerPos, camera);
      this.bark(0);
    }
    const dog = this.dog;
    if (!dog) return;

    this.dogTime += dt;
    this.dogCooldown -= dt;
    this.barkCd -= dt;
    this.crouchT = Math.max(0, this.crouchT - dt);
    this.barkImp *= Math.exp(-4.5 * dt);
    const camDist = this.listen(
      this.dogPos,
      DOG_SOUND_RANGE,
      playerPos,
      camera,
    );
    const bucketFree = st.bucketCount < st.bucketCapacity();

    let moveTarget: THREE.Vector3 | null = null;
    let runSpeed = 5.6;
    let alert = 0;
    let lookAt: THREE.Vector3 | null = null;

    switch (this.dogState) {
      case "idle": {
        // Stay with the player
        const d = this.dogPos.distanceTo(playerPos);
        if (d > 4.5) moveTarget = playerPos;
        runSpeed = d > 12 ? 7.5 : 3.4;
        alert = 0.18;
        lookAt = playerPos;
        if (this.dogCooldown <= 0 && bucketFree) {
          const found = this.trash.findNearest(this.dogPos, 42);
          if (found) {
            this.dogTarget = found;
            this.dogState = "seek";
            this.idleAct = "none";
            this.crouchT = 0.42;
            // Not on every find – otherwise the dog yaps once per fetch cycle
            if (Math.random() < BARK_SPOT_CHANCE) this.bark(camDist);
          } else {
            this.dogCooldown = 3;
          }
        }
        break;
      }
      case "seek": {
        if (!this.dogTarget) {
          this.dogState = "idle";
          break;
        }
        moveTarget = this.dogTarget.pos;
        lookAt = this.dogTarget.pos;
        runSpeed = 7.2;
        alert = 0.75;
        if (this.dogPos.distanceTo(this.dogTarget.pos) < 0.9) {
          this.dogState = "grab";
          this.waitTimer = 0.55;
        }
        break;
      }
      case "grab": {
        this.waitTimer -= dt;
        alert = 0;
        if (this.waitTimer <= 0 && this.dogTarget) {
          const res = this.trash.remove(
            this.dogTarget.typeIdx,
            this.dogTarget.instanceId,
          );
          if (res) {
            st.decRemaining(res.key);
            this.dogCarryType = res.typeId;
            this.dogCarry = this.trash.makeGhost(this.dogTarget.typeIdx);
            this.dogCarry.scale.setScalar(0.55);
            this.dogCarry.position.set(0, 0, 0);
            dog.mouth.add(this.dogCarry);
          }
          this.dogTarget = null;
          this.dogState = "return";
        }
        break;
      }
      case "return":
      case "wait": {
        moveTarget = playerPos;
        lookAt = playerPos;
        runSpeed = 6.8;
        alert = 0.4;
        this.dogHappy = Math.min(1, this.dogHappy + dt * 2);
        if (this.dogPos.distanceTo(playerPos) < 2.4) {
          const ok = useGame.getState().pickup(this.dogCarryType, true);
          if (ok) {
            if (this.dogCarry) {
              this.dogCarry.parent?.remove(this.dogCarry);
              this.dogCarry = null;
            }
            this.dogState = "idle";
            this.dogCooldown = this.dogSpeedInterval();
            this.idleStill = 0;
            if (Math.random() < BARK_DELIVER_CHANCE) this.bark(camDist);
          } else {
            this.dogState = "wait";
            moveTarget = null;
          }
        }
        break;
      }
    }

    // Idle variation only in idle/wait, and only while standing still
    const idling = this.dogState === "idle" || this.dogState === "wait";
    this.updateIdleAct(dt, idling && !moveTarget);
    // Stand up before running off
    if (moveTarget && this.sitB > 0.25) {
      this.idleAct = "none";
      moveTarget = null;
    }

    // Sparse idle bark
    if (this.dogTime >= this.nextIdleBark) {
      this.nextIdleBark = this.dogTime + 25 + Math.random() * 45;
      if (idling && camDist < BARK_IDLE_DIST) this.bark(camDist);
    }

    // Movement with terrain snap
    const prevYaw = this.dogYaw;
    const crouch = this.crouchT > 0 ? sstep(0.06, 0.42, this.crouchT) : 0;
    let moving = false;
    if (moveTarget) {
      this.tmpV.copy(moveTarget).sub(this.dogPos);
      this.tmpV.y = 0;
      const d = this.tmpV.length();
      if (d > 0.2) {
        moving = true;
        const wantYaw = Math.atan2(-this.tmpV.x, -this.tmpV.z);
        const dy = wrapPi(wantYaw - this.dogYaw);
        this.dogYaw += dy * Math.min(1, dt * 7);
        // Accelerate smoothly; the anticipation crouch holds it back briefly
        const goal =
          runSpeed * (1 - crouch * 0.85) * Math.min(1, d / 1.2 + 0.3);
        this.dogSpeed += (goal - this.dogSpeed) * Math.min(1, dt * 3.6);
        this.dogPos.addScaledVector(
          this.tmpV.normalize(),
          Math.min(d, this.dogSpeed * dt),
        );
      }
    }
    if (!moving) this.dogSpeed *= Math.exp(-6 * dt);
    // Like the player/jeep, the dog stands on built surfaces (station apron,
    // pier deck) where there are any – otherwise it sinks into the slab.
    this.dogPos.y = Math.max(0, groundHeight(this.dogPos.x, this.dogPos.z));
    dog.root.position.copy(this.dogPos);
    dog.root.rotation.y = this.dogYaw;

    // Head look-at, converted into the body frame
    let lookYaw = 0;
    let lookPitch = 0;
    if (lookAt && this.sniffB < 0.5) {
      this.tmpV.copy(lookAt).sub(this.dogPos);
      const horiz = Math.hypot(this.tmpV.x, this.tmpV.z);
      if (horiz > 0.05) {
        lookYaw = clamp(
          wrapPi(Math.atan2(-this.tmpV.x, -this.tmpV.z) - this.dogYaw),
          -0.85,
          0.85,
        );
        lookPitch = clamp(
          Math.atan2(this.tmpV.y + 0.55 - 0.62, horiz),
          -0.45,
          0.45,
        );
      }
    }

    // Sniffing while picking up: head low, otherwise alert by state
    const grabbing = this.dogState === "grab";
    const wantAlert = grabbing ? 0 : alert;
    this.dogAlert = approach(this.dogAlert, wantAlert, 5, dt);
    if (this.dogState === "idle") this.dogHappy *= Math.exp(-1.2 * dt);

    const p = this.pose;
    p.speed = this.dogSpeed;
    p.moving = moving && this.dogSpeed > 0.15;
    p.alert = this.dogAlert;
    p.happy = this.dogHappy;
    p.turn = dt > 1e-4 ? wrapPi(this.dogYaw - prevYaw) / dt : 0;
    p.lookYaw = lookYaw;
    p.lookPitch = lookPitch;
    p.crouch = crouch;
    p.sit = this.sitB;
    p.sniff = Math.max(this.sniffB, grabbing ? 1 : 0);
    p.bark = this.barkImp;
    p.wind = env ? env.wind : 0.2;
    animateDog(dog, this.gait, dt, p);

    // Fur: wind/sun uniforms and the shell LOD
    const f = dog.fur;
    f.uTime.value = this.time;
    f.uWind.value = env ? clamp(env.wind, 0, 1) : 0.2;
    const wa = 0.28 * Math.sin((env ? env.envTime : this.time) * 0.045);
    f.uWindDir.value.set(Math.cos(wa), Math.sin(wa));
    if (env) f.uSunDir.value.copy(env.isDay ? env.sunDir : env.moonDir);
    // Buckets with hysteresis: entering a LOWER bucket (fewer shells) needs
    // threshold + FUR_HYST, going back UP needs threshold − FUR_HYST.
    const half = Math.max(3, dog.shellMax >> 1);
    let lod: number;
    if (this.furLod === dog.shellMax || this.furLod < 0) {
      lod = camDist > FUR_FULL + FUR_HYST ? half : dog.shellMax;
      if (lod === half && camDist > this.furCull + FUR_HYST) lod = 0;
    } else if (this.furLod === 0) {
      lod = camDist < this.furCull - FUR_HYST ? half : 0;
      if (lod === half && camDist < FUR_FULL - FUR_HYST) lod = dog.shellMax;
    } else {
      lod =
        camDist < FUR_FULL - FUR_HYST
          ? dog.shellMax
          : camDist > this.furCull + FUR_HYST
            ? 0
            : half;
    }
    if (lod !== this.furLod) {
      this.furLod = lod;
      setDogFurLod(dog, lod);
    }
  }

  // ----------------------------- Drone -----------------------------

  private spawnDrone(at: THREE.Vector3): void {
    const model = buildDrone();
    this.dronePos.copy(at);
    this.droneVel.set(0, 0, 0);
    model.root.position.copy(at);
    this.scene.add(model.root);
    this.drone = model;
    this.spool = 0;
    this.throttle = 0;
  }

  private droneSpeedInterval(): number {
    return upgradeValue(
      "droneSpeed",
      useGame.getState().upgrades.droneSpeed ?? 0,
    );
  }

  private updateDrone(
    dt: number,
    playerPos: THREE.Vector3,
    jeepPos: THREE.Vector3,
    env?: Environment,
    camera?: THREE.PerspectiveCamera,
  ): void {
    const st = useGame.getState();
    const owned = (st.upgrades.drone ?? 0) >= 1;
    if (!owned) {
      if (this.droneAudible) {
        this.droneAudible = false;
        sound.droneSound(false, 0, 1, 0);
      }
      return;
    }
    if (!this.drone) {
      // Starts on the jeep and spools up – no drone pops into the air
      this.spawnDrone(
        this.tmpV.set(
          jeepPos.x,
          terrainHeight(jeepPos.x, jeepPos.z) + 1.35,
          jeepPos.z,
        ),
      );
    }
    const drone = this.drone;
    if (!drone) return;

    this.droneCooldown -= dt;
    this.spool = Math.min(1, this.spool + dt * 0.55);
    const jeepFree = st.jeepCount < st.jeepCapacity();

    let target = this.tmpV.set(
      jeepPos.x,
      terrainHeight(jeepPos.x, jeepPos.z) + 7.5,
      jeepPos.z,
    );
    let speed = 7;

    switch (this.droneState) {
      case "hover": {
        // Escorts the player and circles above them – it only flies to the
        // jeep to unload. That keeps it visible and searching where the work
        // happens; the jeep still remains the destination of every delivery.
        const t = this.time * 0.4;
        const far = playerPos.distanceTo(jeepPos) > 9;
        this.escort.copy(far ? playerPos : jeepPos);
        target = this.tmpV.set(
          this.escort.x + Math.cos(t) * (far ? 3.2 : 4),
          terrainHeight(this.escort.x, this.escort.z) +
            (far ? 6.2 : 7) +
            Math.sin(t * 2.3) * 0.55,
          this.escort.z + Math.sin(t) * (far ? 3.2 : 4),
        );
        speed = 6.5;
        if (this.droneCooldown <= 0 && jeepFree && this.spool > 0.85) {
          if (this.droneCarry) {
            // Still holding cargo from a failed drop (jeep was full):
            // deliver it first – seeking now would orphan the carried mesh.
            this.droneState = "toJeep";
          } else {
            const found = this.trash.findNearest(this.dronePos, 70);
            if (found) {
              this.droneTarget = found;
              this.droneState = "seek";
            } else {
              this.droneCooldown = 4;
            }
          }
        }
        break;
      }
      case "seek": {
        if (!this.droneTarget) {
          this.droneState = "hover";
          break;
        }
        target = this.tmpV.copy(this.droneTarget.pos);
        target.y = Math.max(terrainHeight(target.x, target.z), 0) + 6;
        speed = 10.5;
        if (this.dronePos.distanceTo(target) < 1.4) this.droneState = "descend";
        break;
      }
      case "descend": {
        if (!this.droneTarget || this.droneCarry) {
          // No target, or already carrying (a second pickup would orphan the
          // first mesh on the hook) – back to hover.
          this.droneState = "hover";
          break;
        }
        target = this.tmpV.copy(this.droneTarget.pos);
        target.y += 0.55;
        speed = 4;
        if (this.dronePos.distanceTo(target) < 0.9) {
          const res = this.trash.remove(
            this.droneTarget.typeIdx,
            this.droneTarget.instanceId,
          );
          if (res) {
            st.decRemaining(res.key);
            this.droneCarryType = res.typeId;
            this.droneCarry = this.trash.makeGhost(this.droneTarget.typeIdx);
            this.droneCarry.scale.setScalar(0.7);
            this.droneCarry.position.set(0, 0, 0);
            drone.hook.add(this.droneCarry);
          }
          this.droneTarget = null;
          this.droneState = "toJeep";
        }
        break;
      }
      case "toJeep": {
        target = this.tmpV.set(
          jeepPos.x,
          terrainHeight(jeepPos.x, jeepPos.z) + 5.5,
          jeepPos.z,
        );
        speed = 10.5;
        if (this.dronePos.distanceTo(target) < 1.6) this.droneState = "drop";
        break;
      }
      case "drop": {
        target = this.tmpV.set(
          jeepPos.x,
          terrainHeight(jeepPos.x, jeepPos.z) + 3.4,
          jeepPos.z,
        );
        speed = 3.6;
        if (this.dronePos.distanceTo(target) < 1) {
          const ok = useGame.getState().droneDeliver(this.droneCarryType);
          if (ok) {
            this.droneCarry?.parent?.remove(this.droneCarry);
            this.droneCarry = null;
            this.droneCarryType = "";
            this.droneState = "hover";
            this.droneCooldown = this.droneSpeedInterval();
          } else {
            // Jeep full: KEEP the cargo and hold station – deleting it here
            // would destroy the item (it already left the world in "descend").
            // The drop is retried once there is room again.
            this.droneCooldown = 2;
            this.droneState = "hover";
          }
        }
        break;
      }
    }

    // --- Flight dynamics -------------------------------------------------
    // Position controller: desired velocity ∝ error (capped), the rotors
    // supply the acceleration that closes the gap. Slightly under-damped, so
    // the drone overshoots a stop a little and corrects.
    const wind = env ? clamp(env.wind, 0, 1) : 0.2;
    const wa = 0.28 * Math.sin((env ? env.envTime : this.time) * 0.045);
    this.moveDelta.copy(target).sub(this.dronePos);
    const dist = this.moveDelta.length();
    if (dist > 1e-4) {
      this.wantVel
        .copy(this.moveDelta)
        .multiplyScalar(Math.min(speed, dist * 1.5) / dist);
    } else {
      this.wantVel.set(0, 0, 0);
    }
    this.wantVel.multiplyScalar(this.spool);
    this.ctrlAcc.copy(this.wantVel).sub(this.droneVel).multiplyScalar(2.7);
    const aLen = this.ctrlAcc.length();
    if (aLen > 9) this.ctrlAcc.multiplyScalar(9 / aLen);
    // Turbulence: a slow random walk, only really noticeable in a storm
    const gust = wind * wind * 2.2;
    this.turb.x += (Math.random() - 0.5) * gust * dt * 6;
    this.turb.y += (Math.random() - 0.5) * gust * dt * 4;
    this.turb.z += (Math.random() - 0.5) * gust * dt * 6;
    this.turb.multiplyScalar(Math.exp(-1.4 * dt));
    // Wind pushes the airframe; the controller has to lean against it, which
    // is what produces the counter-tilt further down.
    const windAx = Math.cos(wa) * wind * 1.7;
    const windAz = Math.sin(wa) * wind * 1.7;
    this.droneVel.x += (this.ctrlAcc.x + this.turb.x + windAx) * dt;
    this.droneVel.y += (this.ctrlAcc.y + this.turb.y) * dt;
    this.droneVel.z += (this.ctrlAcc.z + this.turb.z + windAz) * dt;
    this.droneVel.multiplyScalar(Math.exp(-0.3 * dt));
    this.dronePos.addScaledVector(this.droneVel, dt);
    // Never sink into the beach
    const floor = Math.max(0, terrainHeight(this.dronePos.x, this.dronePos.z));
    if (this.dronePos.y < floor + 0.42) {
      this.dronePos.y = floor + 0.42;
      if (this.droneVel.y < 0) this.droneVel.y = 0;
    }
    drone.root.position.copy(this.dronePos);

    // Yaw follows the flight path with lag; it holds heading when hovering
    const vh = Math.hypot(this.droneVel.x, this.droneVel.z);
    if (vh > 0.65) {
      const wantYaw = Math.atan2(-this.droneVel.x, -this.droneVel.z);
      const dy = wrapPi(wantYaw - this.droneYaw);
      const step = dy * Math.min(1, dt * 2.1);
      this.droneYaw += clamp(step, -2.2 * dt, 2.2 * dt);
    }

    // Attitude: a quad accelerates by tilting. tan(angle) = a / g.
    const cy = Math.cos(this.droneYaw);
    const sy = Math.sin(this.droneYaw);
    const fwd = this.ctrlAcc.x * -sy + this.ctrlAcc.z * -cy;
    const rgt = this.ctrlAcc.x * cy + this.ctrlAcc.z * -sy;
    const pitchT = clamp(-Math.atan2(fwd, GRAVITY), -0.52, 0.52);
    const rollT = clamp(-Math.atan2(rgt, GRAVITY), -0.52, 0.52);
    this.dronePitch = approach(this.dronePitch, pitchT, 5.5, dt);
    this.droneRoll = approach(this.droneRoll, rollT, 5.5, dt);
    drone.root.rotation.set(this.dronePitch, this.droneYaw, this.droneRoll);
    // The gimbal stays level and looks slightly downwards
    drone.gimbal.rotation.x = -this.dronePitch - 0.3;
    drone.gimbal.rotation.z = -this.droneRoll;

    // --- Rotors ----------------------------------------------------------
    const accH = Math.hypot(this.ctrlAcc.x, this.ctrlAcc.z);
    const thT =
      (0.45 +
        this.droneVel.y * 0.22 +
        accH * 0.045 +
        (this.droneCarry ? 0.07 : 0)) *
      this.spool;
    this.throttle = approach(this.throttle, clamp(thT, 0.04, 1), 4, dt);
    const rev = 3 + this.throttle * 27;
    this.rotorSpin += dt * rev * Math.PI * 2;
    for (let i = 0; i < drone.rotors.length; i++) {
      const dir = i === 0 || i === 3 ? 1 : -1;
      drone.rotors[i].rotation.y = this.rotorSpin * dir * (1 + (i % 2) * 0.02);
    }
    // Real blades at low RPM, the blur disc takes over from cruise upwards
    drone.bladeMat.opacity = 1 - sstep(0.22, 0.5, this.throttle) * 0.88;
    drone.blurMat.opacity = sstep(0.18, 0.55, this.throttle) * 0.5;
    drone.blur.rotation.y = this.rotorSpin * 0.06;

    // --- Lights ----------------------------------------------------------
    const dayI = env ? env.dayI : 1;
    // Green night beacon: a soft pulse, roughly one flash per 1.2 s. Gaussian
    // attack/decay instead of a hard strobe, with a faint steady floor so the
    // lamp does not disappear completely between the flashes.
    this.navPhase = (this.navPhase + dt / NAV_PERIOD) % 1;
    const x = this.navPhase - 0.18;
    const pulse = Math.exp(-(x * x) / 0.0115);
    const night = 1 - sstep(0.1, 0.25, dayI);
    const lamp = night * (0.1 + 0.9 * pulse);
    drone.navMat.emissiveIntensity = lamp * 6;
    drone.navGlowMat.opacity = lamp * 0.6;
    drone.navGlow.scale.setScalar(0.09 + lamp * 0.15);
    // Position lights only read as lenses by day – at night the drone shows
    // the green beacon and nothing else.
    drone.ledMat.emissiveIntensity = 0.95 * sstep(0.1, 0.4, dayI);

    // --- Audio -----------------------------------------------------------
    this.listen(this.dronePos, DRONE_SOUND_RANGE, playerPos, camera);
    this.droneAudible = true;
    sound.droneSound(true, this.sndPan, this.sndDist, this.throttle);
  }

  update(
    dt: number,
    playerPos: THREE.Vector3,
    jeepPos: THREE.Vector3,
    env?: Environment,
    camera?: THREE.PerspectiveCamera,
  ): void {
    this.time += dt;
    this.updateDog(dt, playerPos, env, camera);
    this.updateDrone(dt, playerPos, jeepPos, env, camera);
  }

  dispose(): void {
    if (this.dog) {
      this.scene.remove(this.dog.root);
      this.dog.dispose();
    }
    if (this.drone) {
      this.scene.remove(this.drone.root);
      this.drone.dispose();
    }
    this.dogCarry?.parent?.remove(this.dogCarry);
    this.droneCarry?.parent?.remove(this.droneCarry);
    if (this.droneAudible) sound.droneSound(false, 0, 1, 0);
  }
}
