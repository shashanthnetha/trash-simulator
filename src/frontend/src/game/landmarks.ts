// Landmark set dressing: the stranded fishing boat, the abandoned dune camp
// and the tipped shipping container. A thin composer so engine.ts holds one
// handle; each landmark owns its own module, textures and colliders.

import * as THREE from "three";
import { BoatWreck } from "./landmark-boat";
import { AbandonedCamp } from "./landmark-camp";
import { ShippingContainer } from "./landmark-container";
import type { Environment } from "./sky";
import type { QualityId } from "./types";

export class Landmarks {
  private readonly group = new THREE.Group();
  private scene: THREE.Scene;
  readonly boat: BoatWreck;
  readonly camp: AbandonedCamp;
  readonly container: ShippingContainer;

  constructor(scene: THREE.Scene, quality: QualityId) {
    this.scene = scene;
    scene.add(this.group);
    this.boat = new BoatWreck(this.group, quality);
    this.camp = new AbandonedCamp(this.group, quality);
    this.container = new ShippingContainer(this.group, quality);
  }

  update(dt: number, env: Environment, camPos: THREE.Vector3): void {
    this.boat.update(dt, env, camPos);
    this.camp.update(dt, env, camPos);
    this.container.update(dt, env, camPos);
  }

  dispose(): void {
    this.boat.dispose();
    this.camp.dispose();
    this.container.dispose();
    this.scene.remove(this.group);
  }
}
