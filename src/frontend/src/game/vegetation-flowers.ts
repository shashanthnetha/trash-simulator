// Coastal flowers – removed on request: the thrift cushions and sea holly
// rosettes that briefly grew here were taken out again. The empty shell
// stays so world.ts keeps its wiring and a future ground-cover species has
// a ready seat; it costs nothing at runtime.

import type * as THREE from "three";
import type { Environment } from "./sky";
import type { QualityId } from "./types";

export class CoastalFlowers {
  protected readonly parent: THREE.Group;
  protected readonly quality: QualityId;

  constructor(parent: THREE.Group, quality: QualityId) {
    this.parent = parent;
    this.quality = quality;
  }

  update(_dt: number, _env: Environment, _camPos: THREE.Vector3): void {}

  dispose(): void {}
}
