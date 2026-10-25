// Trash Simulator – driveable beach jeep: arcade driving physics, chassis with
// independent wheel suspension (4-point terrain sampling), lighting (headlights,
// tail/brake/reversing lights, dashboard lighting), dust, engine sound and the
// model assembly from jeep-build/-body/-interior/-wheels/-cargo.
import * as THREE from "three";
import { type ColliderHit, resolveCircle } from "./colliders";
import { groundHeight } from "./ground";
import { HEADLIGHT_POS, buildBody } from "./jeep-body";
import {
  JD,
  type JeepMaterials,
  PartBag,
  makeJeepMaterials,
} from "./jeep-build";
import { JeepCargo } from "./jeep-cargo";
import { type InteriorRig, buildInterior, needleAngle } from "./jeep-interior";
import {
  type WheelRig,
  buildWheelGeometry,
  makeSpare,
  makeWheel,
} from "./jeep-wheels";
import { sound } from "./sound";
import { useGame } from "./state";
import { makeCanvas, softCircleTexture } from "./textures";
import { upgradeValue } from "./types";
import type { Environment } from "./world";
import { WORLD_BOUNDS, terrainHeight } from "./world";

const WHEEL_RADIUS = JD.wheelR;
const MAX_DUST = 140;
const WHEEL_TRAVEL = 0.13;
/** Half the edge length of the contact shading under one wheel. */
const CONTACT_R = 0.5;
/** Body for the static world colliders: two circles on the axle centres. */
const BODY_R = 1.1;
const BODY_TOP = 2.2;
/** Longest resolve step; longer frames are split so nothing tunnels through. */
const SUBSTEP = 0.4;

interface DustP {
  life: number;
  max: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
}

/**
 * Radial gradient for multiply blending (dark centre, white rim): contact
 * shadows under the wheels so the vehicle sits in the sand instead of looking
 * pasted on top of it.
 */
function contactTexture(): THREE.Texture {
  const [c, ctx] = makeCanvas(64, 64);
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "#2e2a24");
  g.addColorStop(0.22, "#4e463c");
  g.addColorStop(0.55, "#a49a8e");
  g.addColorStop(0.82, "#e2ddd6");
  g.addColorStop(1, "#ffffff");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

/** Write one quad (4 corners, 2 triangles) into the buffer. */
function setQuad(
  arr: Float32Array,
  q: number,
  cx: number,
  cz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  y: (x: number, z: number) => number,
): void {
  const o = q * 12;
  const c: [number, number][] = [
    [cx - ax - bx, cz - az - bz],
    [cx + ax - bx, cz + az - bz],
    [cx + ax + bx, cz + az + bz],
    [cx - ax + bx, cz - az + bz],
  ];
  for (let i = 0; i < 4; i++) {
    arr[o + i * 3] = c[i][0];
    arr[o + i * 3 + 1] = y(c[i][0], c[i][1]);
    arr[o + i * 3 + 2] = c[i][1];
  }
}

/** Geometry with `n` quads (UV 0..1 per quad); positions are set per frame. */
function quadStrip(n: number): [THREE.BufferGeometry, Float32Array] {
  const pos = new Float32Array(n * 12);
  const uv = new Float32Array(n * 8);
  const idx: number[] = [];
  for (let q = 0; q < n; q++) {
    uv.set([0, 0, 1, 0, 1, 1, 0, 1], q * 8);
    idx.push(q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  return [g, pos];
}

export class Jeep {
  readonly group = new THREE.Group();
  heading = -0.6;
  speed = 0;
  occupied = false;
  input = { f: 0, r: 0, brake: false };

  private mats: JeepMaterials;
  private wheels: WheelRig[] = [];
  private wheelY = [0, 0, 0, 0];
  private interior: InteriorRig;
  private cargo: JeepCargo;
  private steerVis = 0;
  private pitch = 0;
  private roll = 0;
  private bounce = 0;
  private dynPitch = 0;
  private dynRoll = 0;
  private accelVis = 0;
  private latVis = 0;
  private time = 0;
  private lampHead = 0;
  private lampTail = 0;
  private lampRev = 0;
  private lampDash = 0;
  private envK = -1;
  private headL: THREE.SpotLight;
  private headR: THREE.SpotLight;
  private dashLamp: THREE.PointLight;
  private glow: THREE.Sprite[] = [];
  private glowMat: THREE.SpriteMaterial;

  // Ground decals (world space): contact shadows under the wheels, headlight pool
  private contactMesh: THREE.Mesh;
  private contactPos: Float32Array;
  private contactMat: THREE.MeshBasicMaterial;
  private contactTex: THREE.Texture;
  private beamMesh: THREE.Mesh;
  private beamPos: Float32Array;
  private beamMat: THREE.MeshBasicMaterial;

  /** Result of resolveColliders (reused – no per-frame allocation). */
  private colHit: ColliderHit = { x: 0, z: 0 };

  private dust: DustP[] = [];
  private dustGeo = new THREE.BufferGeometry();
  private dustPos: Float32Array;
  private dustPoints: THREE.Points;
  private dustMat: THREE.PointsMaterial;

  constructor(scene: THREE.Scene, x: number, z: number) {
    this.group.position.set(x, groundHeight(x, z) + WHEEL_RADIUS, z);
    this.mats = makeJeepMaterials();

    // Body + static interior: one mesh per material
    const bag = new PartBag();
    buildBody(bag, this.mats.atlas);
    this.interior = buildInterior(bag, this.mats.atlas, this.mats.mats);
    for (const m of bag.build(this.mats.mats).values()) this.group.add(m);
    this.group.add(this.interior.sw, this.interior.needle, this.interior.fresh);

    // Wheels + spare wheel
    const wg = buildWheelGeometry();
    for (const [wx, wz] of [
      [-JD.trackX, JD.axleF],
      [JD.trackX, JD.axleF],
      [-JD.trackX, JD.axleR],
      [JD.trackX, JD.axleR],
    ] as const) {
      const w = makeWheel(wg, this.mats.tire, this.mats.rim, wx, wz);
      this.wheels.push(w);
      this.group.add(w.holder);
    }
    this.group.add(
      makeSpare(wg, this.mats.tire, this.mats.rim, 0.3, 0.78, 2.1),
    );

    // Cargo
    this.cargo = new JeepCargo(this.mats.rope);
    this.group.add(this.cargo.group);

    // Headlights (spots) + glow sprites + dashboard lighting
    this.headL = this.makeSpot(HEADLIGHT_POS[0][0]);
    this.headR = this.makeSpot(HEADLIGHT_POS[1][0]);
    this.dashLamp = new THREE.PointLight(0xb6e8c6, 0, 1.25, 2.2);
    this.dashLamp.position.set(-0.32, 0.91, -0.56);
    this.group.add(this.dashLamp);
    this.glowMat = new THREE.SpriteMaterial({
      map: softCircleTexture("255,238,190", 1),
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      opacity: 0,
    });
    for (const p of HEADLIGHT_POS) {
      const s = new THREE.Sprite(this.glowMat);
      s.position.set(p[0], p[1], p[2] - 0.03);
      s.scale.set(0.6, 0.6, 1);
      s.visible = false;
      this.group.add(s);
      this.glow.push(s);
    }
    scene.add(this.group);

    // Dust
    this.dustPos = new Float32Array(MAX_DUST * 3);
    this.dustGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(this.dustPos, 3),
    );
    this.dustMat = new THREE.PointsMaterial({
      size: 1.5,
      map: softCircleTexture("214,196,158", 0.55),
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.dustPoints = new THREE.Points(this.dustGeo, this.dustMat);
    this.dustPoints.frustumCulled = false;
    scene.add(this.dustPoints);

    // Contact shading under the four wheels (multiplied onto the sand)
    this.contactTex = contactTexture();
    const [cg, cp] = quadStrip(4);
    this.contactPos = cp;
    this.contactMat = new THREE.MeshBasicMaterial({
      map: this.contactTex,
      blending: THREE.MultiplyBlending,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    this.contactMesh = new THREE.Mesh(cg, this.contactMat);
    this.contactMesh.frustumCulled = false;
    this.contactMesh.renderOrder = 2;
    scene.add(this.contactMesh);

    // Soft light pool of the headlights (additive, replaces the hard ellipse)
    const [bg, bp] = quadStrip(1);
    this.beamPos = bp;
    this.beamMat = new THREE.MeshBasicMaterial({
      map: softCircleTexture("255,232,176", 1),
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    this.beamMesh = new THREE.Mesh(bg, this.beamMat);
    this.beamMesh.frustumCulled = false;
    this.beamMesh.renderOrder = 3;
    this.beamMesh.visible = false;
    scene.add(this.beamMesh);
  }

  private makeSpot(x: number): THREE.SpotLight {
    // wide and soft: the hard ellipse of the old setting stood out
    const s = new THREE.SpotLight(0xffe9b0, 0, 42, 0.62, 0.92, 1.5);
    s.position.set(x, 0.66, -1.9);
    s.target.position.set(x * 1.7, -0.62, -10);
    this.group.add(s, s.target);
    return s;
  }

  maxSpeed(): number {
    return upgradeValue(
      "jeepEngine",
      useGame.getState().upgrades.jeepEngine ?? 0,
    );
  }

  canEnter(pos: THREE.Vector3): boolean {
    return pos.distanceTo(this.group.position) < 3.6;
  }

  /**
   * World position of the driver's eyes (for the camera while driving). Lower
   * and further forward than the seat centre – otherwise you are enthroned
   * above the dashboard as if in a bus.
   */
  driverEye(out: THREE.Vector3): THREE.Vector3 {
    out.set(-0.42, 1.35 + this.bounce * 0.4, 0.0);
    return this.group.localToWorld(out);
  }

  refreshCargo(): void {
    const st = useGame.getState();
    this.cargo.refresh(st.jeepLoad, st.jeepCapacity());
  }

  update(dt: number, env: Environment): void {
    const st = useGame.getState();
    const susp = upgradeValue("jeepSusp", st.upgrades.jeepSusp ?? 0);
    const prevSpeed = this.speed;
    const prevHeading = this.heading;
    this.time += dt;

    if (this.occupied) {
      const max = this.maxSpeed();
      const accel = 8.5;
      const brake = 16;
      const gas = this.input.f;
      if (gas > 0.02) this.speed += accel * gas * dt;
      else if (gas < -0.02)
        this.speed +=
          (this.speed > 0.4 ? -brake : accel * 0.6 * gas * 2.4) * dt;
      if (this.input.brake) this.speed -= Math.sign(this.speed) * brake * dt;
      // Rolling resistance
      this.speed *= 1 - dt * 0.35;
      const h = terrainHeight(this.group.position.x, this.group.position.z);
      if (h < 0.35) this.speed *= 1 - dt * 2.2; // water slows you down hard
      this.speed = Math.max(-max * 0.4, Math.min(max, this.speed));
      if (Math.abs(this.speed) < 0.03 && Math.abs(gas) < 0.02) this.speed = 0;

      // Steering
      const steer = this.input.r;
      const steerEff = 1.7 * Math.min(1, Math.abs(this.speed) / 5.5);
      this.heading -= steer * steerEff * dt * Math.sign(this.speed || 1);
      this.steerVis += (steer * 0.45 - this.steerVis) * Math.min(1, dt * 10);
    } else {
      this.speed *= 1 - dt * 2;
      this.steerVis *= 1 - dt * 4;
    }

    // Movement
    const fx = -Math.sin(this.heading);
    const fz = -Math.cos(this.heading);
    let nx = this.group.position.x + fx * this.speed * dt;
    let nz = this.group.position.z + fz * this.speed * dt;
    nx = Math.max(WORLD_BOUNDS.minX + 2, Math.min(WORLD_BOUNDS.maxX - 2, nx));
    nz = Math.max(WORLD_BOUNDS.minZ + 2, Math.min(WORLD_BOUNDS.maxZ - 2, nz));
    const solved = this.resolveColliders(nx, nz, fx, fz);
    nx = solved.x;
    nz = solved.z;
    if (terrainHeight(nx, nz) < -0.6) {
      this.speed *= 0.5; // too deep: bounce off
    } else {
      if (this.occupied)
        st.addDistance(
          0,
          Math.hypot(nx - this.group.position.x, nz - this.group.position.z),
        );
      this.group.position.x = nx;
      this.group.position.z = nz;
    }

    // Ground under the four wheels → pitch/roll/height target + spring travel
    const rx = Math.cos(this.heading);
    const rz = -Math.sin(this.heading);
    const px = this.group.position.x;
    const pz = this.group.position.z;
    const sample = (lx: number, lz: number) =>
      groundHeight(px + rx * lx - fx * lz, pz + rz * lx - fz * lz);
    const hFL = sample(-JD.trackX, JD.axleF);
    const hFR = sample(JD.trackX, JD.axleF);
    const hBL = sample(-JD.trackX, JD.axleR);
    const hBR = sample(JD.trackX, JD.axleR);
    const hC = (hFL + hFR + hBL + hBR) / 4;
    const targetPitch = Math.atan2(
      (hFL + hFR - hBL - hBR) / 2,
      JD.axleR - JD.axleF,
    );
    const targetRoll = Math.atan2((hFR + hBR - hFL - hBL) / 2, JD.trackX * 2);
    const smooth = 6 + susp * 5;
    this.pitch += (targetPitch - this.pitch) * Math.min(1, dt * smooth);
    this.roll += (targetRoll - this.roll) * Math.min(1, dt * smooth);
    const roughness =
      Math.abs(targetPitch - this.pitch) + Math.abs(targetRoll - this.roll);
    this.bounce +=
      (roughness * (1.6 - susp * 0.9) * Math.min(1, Math.abs(this.speed) / 6) -
        this.bounce) *
      Math.min(1, dt * 5);

    // Dynamics: pitching under acceleration/braking, roll in corners
    const accel = dt > 0 ? (this.speed - prevSpeed) / dt : 0;
    const yawRate = dt > 0 ? (this.heading - prevHeading) / dt : 0;
    const lat = this.speed * yawRate;
    this.accelVis += (accel - this.accelVis) * Math.min(1, dt * 6);
    this.latVis += (lat - this.latVis) * Math.min(1, dt * 6);
    const k = 1 - susp * 0.25;
    this.dynPitch = THREE.MathUtils.clamp(
      this.accelVis * 0.006 * k,
      -0.05,
      0.05,
    );
    this.dynRoll = THREE.MathUtils.clamp(-this.latVis * 0.01 * k, -0.06, 0.06);

    const targetY = hC + WHEEL_RADIUS + 0.06;
    this.group.position.y +=
      (targetY - this.group.position.y) * Math.min(1, dt * (7 + susp * 4));
    const pitch = this.pitch + this.dynPitch;
    const roll = this.roll + this.dynRoll;
    this.group.rotation.set(pitch, this.heading, roll, "YXZ");

    // Wheels: independent suspension, rotation, steering
    const sp = Math.sin(pitch);
    const cp = Math.cos(pitch);
    const sr = Math.sin(roll);
    const spin = (this.speed * dt) / WHEEL_RADIUS;
    const heights = [hFL, hFR, hBL, hBR];
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const worldY = this.group.position.y + w.x * sr * cp - w.z * sp;
      // sunk in by 2.5 cm: the tyre should sit in the sand, not on top of it
      const target = THREE.MathUtils.clamp(
        heights[i] + WHEEL_RADIUS - 0.025 - worldY,
        -WHEEL_TRAVEL,
        WHEEL_TRAVEL,
      );
      this.wheelY[i] += (target - this.wheelY[i]) * Math.min(1, dt * 14);
      w.holder.position.y = this.wheelY[i];
      w.spin.rotation.x -= spin;
      if (w.front) w.holder.rotation.y = -this.steerVis;
    }
    // Steering wheel, speedometer needle, air freshener
    this.interior.swSpin.rotation.z = -this.steerVis * 2.6;
    this.interior.needle.children[0].rotation.z = needleAngle(this.speed);
    const fresh = this.interior.fresh;
    const sway =
      Math.abs(this.speed) > 0.5 ? Math.sin(this.time * 2.3) * 0.04 : 0;
    fresh.rotation.x =
      THREE.MathUtils.clamp(-this.accelVis * 0.06, -0.5, 0.5) + sway;
    fresh.rotation.z =
      THREE.MathUtils.clamp(this.latVis * 0.05, -0.5, 0.5) + sway * 0.6;

    // Lights: headlights at night, brake light, reversing light, dashboard
    const lightsOn = this.occupied && !env.isDay;
    const braking =
      this.occupied &&
      (this.input.brake || (this.input.f < -0.02 && this.speed > 0.3));
    const reversing = this.occupied && this.speed < -0.25;
    const ease = Math.min(1, dt * 6);
    const fast = Math.min(1, dt * 14);
    this.lampHead += ((lightsOn ? 1 : 0) - this.lampHead) * ease;
    this.lampTail +=
      ((braking ? 2.8 : lightsOn ? 0.55 : 0) - this.lampTail) * fast;
    this.lampRev += ((reversing ? 2.2 : 0) - this.lampRev) * fast;
    this.lampDash += ((lightsOn ? 1 : 0) - this.lampDash) * ease;
    this.mats.lampI.value.set(
      this.lampHead * 4.5,
      this.lampTail,
      this.lampRev,
      this.lampDash * 1.6,
    );
    this.mats.dial.emissiveIntensity = this.lampDash * 2.3;
    this.headL.intensity = this.lampHead * 32;
    this.headR.intensity = this.headL.intensity;
    this.dashLamp.intensity = this.lampDash * 0.55;
    const glowOn = this.lampHead > 0.03;
    this.glowMat.opacity = this.lampHead * 0.85;
    for (const g of this.glow) g.visible = glowOn;
    // Dim the reflections with the daylight
    const envK = 0.1 + 0.9 * env.dayI + env.moonI * 0.05;
    if (Math.abs(envK - this.envK) > 0.01) {
      this.envK = envK;
      this.mats.setEnvIntensity(envK);
    }
    // Mirror glass follows the sky colour (near black at night, not glowing)
    this.mats.mirror.color
      .copy(env.horizonSea)
      .multiplyScalar(0.42)
      .addScalar(0.01);
    this.updateGroundDecals(fx, fz, rx, rz);

    // Engine sound
    sound.updateEngine(
      this.occupied,
      Math.min(1, Math.abs(this.speed) / Math.max(1, this.maxSpeed())),
    );

    // Dust
    this.updateDust(dt, hC);
    st.setJeepState(this.occupied, Math.abs(this.speed));
  }

  /**
   * Push the vehicle out of the static world colliders. The body is two circles
   * on the axle centres; each correction moves the whole chassis. Long frames
   * are split into substeps so a fast run cannot tunnel through a wall, and the
   * speed component into the obstacle is removed – head-on the jeep stops, at a
   * shallow angle it slides along.
   */
  private resolveColliders(
    toX: number,
    toZ: number,
    fx: number,
    fz: number,
  ): ColliderHit {
    const fromX = this.group.position.x;
    const fromZ = this.group.position.z;
    const dx = toX - fromX;
    const dz = toZ - fromZ;
    const steps = Math.min(4, 1 + Math.floor(Math.hypot(dx, dz) / SUBSTEP));
    const y0 = this.group.position.y - WHEEL_RADIUS;
    const y1 = y0 + BODY_TOP;
    const ax = JD.axleR;
    let cx = fromX;
    let cz = fromZ;
    for (let s = 1; s <= steps; s++) {
      cx = fromX + (dx * s) / steps;
      cz = fromZ + (dz * s) / steps;
      for (const sign of [1, -1]) {
        const px = cx + fx * ax * sign;
        const pz = cz + fz * ax * sign;
        const hit = resolveCircle(px, pz, BODY_R, y0, y1);
        cx += hit.x - px;
        cz += hit.z - pz;
      }
    }
    const corrX = cx - toX;
    const corrZ = cz - toZ;
    const corr = Math.hypot(corrX, corrZ);
    if (corr > 1e-4) {
      // Cosine between driving direction and push-out direction
      const d = (fx * corrX + fz * corrZ) / corr;
      if (d < 0) this.speed *= Math.max(0, 1 - d * d);
    }
    this.colHit.x = cx;
    this.colHit.z = cz;
    return this.colHit;
  }

  /**
   * Update the ground decals in world space: four contact shadows under the
   * wheels (always) and the soft headlight pool ahead (only when lit).
   */
  private updateGroundDecals(
    fx: number,
    fz: number,
    rx: number,
    rz: number,
  ): void {
    const px = this.group.position.x;
    const pz = this.group.position.z;
    const gy = (x: number, z: number) => groundHeight(x, z) + 0.03;
    const wheels = [
      [-JD.trackX, JD.axleF],
      [JD.trackX, JD.axleF],
      [-JD.trackX, JD.axleR],
      [JD.trackX, JD.axleR],
    ] as const;
    for (let i = 0; i < 4; i++) {
      const [lx, lz] = wheels[i];
      const wx = px + rx * lx - fx * lz;
      const wz = pz + rz * lx - fz * lz;
      setQuad(this.contactPos, i, wx, wz, CONTACT_R, 0, 0, CONTACT_R, gy);
    }
    this.contactMesh.geometry.attributes.position.needsUpdate = true;
    this.contactMesh.geometry.computeBoundingSphere();

    const on = this.lampHead > 0.02;
    this.beamMesh.visible = on;
    if (!on) return;
    this.beamMat.opacity = this.lampHead * 0.5;
    const cx = px + fx * 9;
    const cz = pz + fz * 9;
    // Semi-axes: lateral (to the right) 5 m, longitudinal (forward) 11 m
    setQuad(
      this.beamPos,
      0,
      cx,
      cz,
      rx * 5,
      rz * 5,
      fx * 11,
      fz * 11,
      (x, z) => groundHeight(x, z) + 0.06,
    );
    this.beamMesh.geometry.attributes.position.needsUpdate = true;
    this.beamMesh.geometry.computeBoundingSphere();
  }

  private updateDust(dt: number, groundH: number): void {
    if (
      Math.abs(this.speed) > 3.2 &&
      groundH > 0 &&
      this.dust.length < MAX_DUST &&
      Math.random() < dt * 26
    ) {
      const bx =
        this.group.position.x +
        Math.sin(this.heading) * 1.4 +
        (Math.random() - 0.5) * 1.4;
      const bz =
        this.group.position.z +
        Math.cos(this.heading) * 1.4 +
        (Math.random() - 0.5) * 1.4;
      this.dust.push({
        life: 0,
        max: 0.8 + Math.random() * 0.6,
        pos: new THREE.Vector3(bx, groundH + 0.2, bz),
        vel: new THREE.Vector3(
          (Math.random() - 0.5) * 0.7,
          0.9 + Math.random() * 0.8,
          (Math.random() - 0.5) * 0.7,
        ),
      });
    }
    for (let i = this.dust.length - 1; i >= 0; i--) {
      const d = this.dust[i];
      d.life += dt;
      if (d.life > d.max) {
        this.dust.splice(i, 1);
        continue;
      }
      d.pos.addScaledVector(d.vel, dt);
    }
    for (let i = 0; i < MAX_DUST; i++) {
      const d = this.dust[i];
      if (d) {
        this.dustPos[i * 3] = d.pos.x;
        this.dustPos[i * 3 + 1] = d.pos.y;
        this.dustPos[i * 3 + 2] = d.pos.z;
      } else {
        this.dustPos[i * 3 + 1] = -100;
      }
    }
    this.dustGeo.attributes.position.needsUpdate = true;
    this.dustGeo.setDrawRange(0, Math.max(this.dust.length, 1));
  }

  dispose(): void {
    this.group.parent?.remove(this.group);
    this.dustPoints.parent?.remove(this.dustPoints);
    this.contactMesh.parent?.remove(this.contactMesh);
    this.beamMesh.parent?.remove(this.beamMesh);
    this.contactMesh.geometry.dispose();
    this.beamMesh.geometry.dispose();
    this.contactMat.dispose();
    this.beamMat.dispose();
    this.contactTex.dispose();
    const seen = new Set<THREE.BufferGeometry>();
    this.group.traverse((o) => {
      const g = (o as THREE.Mesh).geometry;
      if (g && !seen.has(g)) {
        seen.add(g);
        g.dispose();
      }
    });
    this.cargo.dispose();
    this.mats.dispose();
    this.glowMat.dispose();
    this.dustGeo.dispose();
    this.dustMat.dispose();
  }
}
