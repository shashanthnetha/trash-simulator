// Trash Simulator – first-person player: movement, camera, grab sequence.
// The viewmodel (bucket, grabber, hands) lives in player-viewmodel.ts.
import * as THREE from "three";
import { resolveCircle } from "./colliders";
import { groundHeight } from "./ground";
import { PlayerViewmodel } from "./player-viewmodel";
import { sound } from "./sound";
import { useGame } from "./state";
import { upgradeValue } from "./types";
import type { World } from "./world";
import { WORLD_BOUNDS, shoreZ, terrainHeight } from "./world";

const EYE_HEIGHT = 1.68;
/** Body circle for the static world colliders. */
const BODY_RADIUS = 0.35;
const BODY_HEIGHT = 1.7;
const WALK_SPEED = 5.4;
const SPRINT_MULT = 1.62;
const GRAVITY = -16;
const JUMP_VELOCITY = 5.6;

interface GrabJob {
  t: number;
  duration: number;
  target: THREE.Vector3;
  ghost: THREE.Mesh | null;
  makeGhost: () => THREE.Mesh;
  onGrabMoment: () => boolean;
  onDone: () => void;
  grabbed: boolean;
  aborted: boolean;
}

export class Player {
  readonly camera: THREE.PerspectiveCamera;
  readonly position = new THREE.Vector3(6, 0, 52);
  yaw = Math.PI * 0.08;
  pitch = -0.04;

  // Set by input.ts
  move = { f: 0, r: 0, sprint: false };
  private jumpQueued = false;

  private vy = 0;
  private grounded = true;
  active = true; // false while sitting in the jeep
  distanceMoved = 0;

  // Viewmodel
  private readonly vm: PlayerViewmodel;

  // Animation
  private bobPhase = 0;
  private bobAmp = 0;
  private stepSide = 1;
  private lastStepPhase = 0;
  private grab: GrabJob | null = null;
  private baseFov: number;

  private scene: THREE.Scene;
  private world: World;
  private tmpV = new THREE.Vector3();
  private tmpV2 = new THREE.Vector3();

  constructor(scene: THREE.Scene, world: World, fov: number, aspect: number) {
    this.scene = scene;
    this.world = world;
    this.baseFov = fov;
    this.camera = new THREE.PerspectiveCamera(fov, aspect, 0.08, 1600);
    this.camera.rotation.order = "YXZ";
    scene.add(this.camera);
    this.vm = new PlayerViewmodel(this.camera);
    this.snapToGround();
  }

  /** Sync the visible fill level of the bucket from the store. */
  refreshBucketFill(): void {
    const st = useGame.getState();
    this.vm.refreshFill(st.bucket, st.bucketCapacity());
  }

  addLook(dx: number, dy: number): void {
    this.yaw -= dx;
    this.pitch -= dy;
    const lim = Math.PI / 2 - 0.02;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
  }

  queueJump(): void {
    if (this.active && this.grounded) this.jumpQueued = true;
  }

  setFov(fov: number): void {
    this.baseFov = fov;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  get isGrabbing(): boolean {
    return this.grab !== null;
  }

  grabRange(): number {
    return upgradeValue(
      "grabRange",
      useGame.getState().upgrades.grabRange ?? 0,
    );
  }

  startGrab(
    target: THREE.Vector3,
    makeGhost: () => THREE.Mesh,
    onGrabMoment: () => boolean,
    onDone: () => void,
  ): boolean {
    if (this.grab || !this.active) return false;
    const duration =
      upgradeValue("grabSpeed", useGame.getState().upgrades.grabSpeed ?? 0) +
      0.32;
    this.grab = {
      t: 0,
      duration,
      target: target.clone(),
      ghost: null,
      makeGhost,
      onGrabMoment,
      onDone,
      grabbed: false,
      aborted: false,
    };
    return true;
  }

  private snapToGround(): void {
    this.position.y =
      groundHeight(this.position.x, this.position.z) + EYE_HEIGHT;
  }

  teleport(x: number, z: number, yaw?: number): void {
    this.position.set(x, 0, z);
    this.snapToGround();
    this.vy = 0;
    if (yaw !== undefined) this.yaw = yaw;
    this.vm.resetMotion();
  }

  update(dt: number): void {
    if (this.active) this.updateMovement(dt);
    this.updateCameraTransform(dt);
    this.updateGrab(dt);
  }

  private updateMovement(dt: number): void {
    const speedBase = WALK_SPEED * (this.move.sprint ? SPRINT_MULT : 1);
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    // Forward = -Z in camera direction
    const dirX = -sin * this.move.f + cos * this.move.r;
    const dirZ = -cos * this.move.f - sin * this.move.r;
    let len = Math.hypot(dirX, dirZ);
    if (len < 0.001) len = 1;

    const feet = this.position.y - EYE_HEIGHT;
    const groundH = groundHeight(this.position.x, this.position.z, feet);
    const inWater = groundH < 0.15;
    const nearWater = this.position.z < shoreZ(this.position.x) + 7;
    const speed = speedBase * (inWater ? 0.5 : nearWater ? 0.88 : 1);

    const stepX = (dirX / len) * speed * dt;
    const stepZ = (dirZ / len) * speed * dt;
    let nx = Math.max(
      WORLD_BOUNDS.minX,
      Math.min(WORLD_BOUNDS.maxX, this.position.x + stepX),
    );
    let nz = Math.max(
      WORLD_BOUNDS.minZ,
      Math.min(WORLD_BOUNDS.maxZ, this.position.z + stepZ),
    );

    // Static world colliders (station): push the body circle out of walls and
    // machines. Only the component into the obstacle is removed, so you slide
    // along a wall instead of sticking to it.
    const feetY = this.position.y - EYE_HEIGHT;
    const solved = resolveCircle(
      nx,
      nz,
      BODY_RADIUS,
      feetY,
      feetY + BODY_HEIGHT,
    );
    nx = solved.x;
    nz = solved.z;

    // Don't wade too deep into the sea. Built surfaces count (the pier deck
    // stands over 2 m of water), so a gap in the planks is a wall, not a
    // plunge – there is no climbing back out of the sea.
    const nH = groundHeight(nx, nz, feet);
    if (nH > -1.1) {
      this.distanceMoved += Math.hypot(
        nx - this.position.x,
        nz - this.position.z,
      );
      this.position.x = nx;
      this.position.z = nz;
    }

    // Vertical
    if (this.jumpQueued) {
      this.vy = JUMP_VELOCITY;
      this.grounded = false;
      this.jumpQueued = false;
    }
    this.vy += GRAVITY * dt;
    this.position.y += this.vy * dt;
    const floor =
      groundHeight(
        this.position.x,
        this.position.z,
        this.position.y - EYE_HEIGHT,
      ) + EYE_HEIGHT;
    if (this.position.y <= floor) {
      this.position.y = floor;
      this.vy = 0;
      this.grounded = true;
    }

    // Head bob + footsteps
    const moving =
      (Math.abs(this.move.f) > 0.05 || Math.abs(this.move.r) > 0.05) &&
      this.grounded;
    const targetAmp = moving ? (this.move.sprint ? 0.052 : 0.036) : 0;
    this.bobAmp += (targetAmp - this.bobAmp) * Math.min(1, dt * 8);
    if (moving) {
      this.bobPhase += dt * (this.move.sprint ? 11.4 : 8.2);
      const cycle = Math.floor(this.bobPhase / Math.PI);
      if (cycle > this.lastStepPhase) {
        this.lastStepPhase = cycle;
        this.stepSide *= -1;
        const wet = inWater || this.position.z < shoreZ(this.position.x) + 4;
        sound.footstep(wet, inWater);
        // Footprint offset sideways from the view direction
        const px = this.position.x + cos * 0.16 * this.stepSide + sin * 0.3;
        const pz = this.position.z - sin * 0.16 * this.stepSide + cos * 0.3;
        this.world.stampFootprint(px, pz, this.yaw, this.stepSide);
      }
    }
  }

  private updateCameraTransform(dt: number): void {
    this.camera.position.copy(this.position);
    const bobY = Math.sin(this.bobPhase * 2) * this.bobAmp;
    const bobX = Math.cos(this.bobPhase) * this.bobAmp * 0.6;
    this.camera.position.y += bobY;
    this.camera.rotation.set(this.pitch, this.yaw, 0);

    // Sprint FOV
    const wantFov = this.baseFov + (this.move.sprint && this.active ? 4 : 0);
    if (Math.abs(this.camera.fov - wantFov) > 0.05) {
      this.camera.fov += (wantFov - this.camera.fov) * Math.min(1, dt * 6);
      this.camera.updateProjectionMatrix();
    }

    // Viewmodel: sway, pitch coupling, swinging bucket
    this.vm.update({
      dt,
      bobX,
      bobY,
      bobPhase: this.bobPhase,
      bobAmp: this.bobAmp,
      sprint: this.move.sprint && this.active,
      pitch: this.pitch,
      yaw: this.yaw,
      grounded: this.grounded,
      active: this.active,
    });
  }

  private updateGrab(dt: number): void {
    const g = this.grab;
    if (!g) {
      // Idle pose: jaws slightly open, breathing
      this.vm.grabPose(
        0.12 + Math.sin(performance.now() * 0.0012) * 0.03,
        0,
        null,
        0,
        0,
      );
      return;
    }
    g.t += dt;
    const p = Math.min(1, g.t / g.duration);

    if (p < 0.4) {
      // Extend arm, telescope out, open the jaws, turn towards the target
      const k = p / 0.4;
      this.vm.grabPose(0.55 + k * 0.45, k, g.target, k, 0);
    } else if (p < 0.6) {
      // Pull the trigger, close the jaws
      const k = (p - 0.4) / 0.2;
      this.vm.grabPose(1 - k, 1, g.target, 1, 0);
      if (!g.grabbed && p >= 0.5) {
        g.grabbed = true;
        const ok = g.onGrabMoment();
        if (!ok) {
          g.aborted = true;
        } else {
          g.ghost = g.makeGhost();
          g.ghost.position.copy(g.target);
          this.scene.add(g.ghost);
        }
      }
    } else {
      // Retract + swing over the bucket, ghost flies in, jaws let go
      const k = (p - 0.6) / 0.4;
      const open = k < 0.75 ? 0.08 : 0.08 + ((k - 0.75) / 0.25) * 0.5;
      this.vm.grabPose(open, 1 - k, g.target, 1 - k, k);
      if (g.ghost) {
        this.vm.dropPoint.getWorldPosition(this.tmpV);
        this.tmpV2.copy(g.target).lerp(this.tmpV, k);
        this.tmpV2.y += Math.sin(k * Math.PI) * 0.6;
        g.ghost.position.copy(this.tmpV2);
        const s = 1 - k * 0.55;
        g.ghost.scale.setScalar(s);
        g.ghost.rotation.y += dt * 6;
      }
    }

    if (p >= 1) {
      if (g.ghost) this.scene.remove(g.ghost);
      this.vm.grabPose(0.12, 0, null, 0, 0);
      this.grab = null;
      if (!g.aborted) g.onDone();
    }
  }

  dispose(): void {
    this.vm.dispose();
    this.scene.remove(this.camera);
  }
}
