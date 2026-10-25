// The built places with a story: chapel knoll, old pier, old tip, cable
// house, bitten edge, bothy, lane's end and the wardens' boardwalk. A thin
// composer so engine.ts holds one handle; each place owns its module,
// textures, colliders and ground overrides. The landforms they stand on live
// in landforms.ts and are part of the terrain itself.
//
// The places are the most expensive part of the boot (each paints its own
// procedural texture sets), so they are built one per `step()` call – the
// engine yields to the browser between steps, which keeps the loading screen
// alive and lets it show progress. A build that is abandoned (the canvas
// unmounts mid-boot) leaves the fields already filled; dispose() handles any
// partial state.

import * as THREE from "three";
import { BittenEdge } from "./place-bitten-edge";
import { WardensBoardwalk } from "./place-boardwalk";
import { KeldBothy } from "./place-bothy";
import { CableHouse } from "./place-cable-house";
import { ChantryKnoll } from "./place-chantry";
import { LanesEnd } from "./place-lanes-end";
import { Lighthouse } from "./place-lighthouse";
import { OldPier } from "./place-pier";
import { OldTip } from "./place-tip";
import type { Environment } from "./sky";
import type { QualityId } from "./types";

/** Called before every place is built with a label for the loading screen. */
export type BuildStep = (label: string) => Promise<void>;

export class Places {
  private readonly group = new THREE.Group();
  private scene: THREE.Scene;
  chantry: ChantryKnoll | null = null;
  pier: OldPier | null = null;
  tip: OldTip | null = null;
  cableHouse: CableHouse | null = null;
  bittenEdge: BittenEdge | null = null;
  bothy: KeldBothy | null = null;
  lanesEnd: LanesEnd | null = null;
  boardwalk: WardensBoardwalk | null = null;
  lighthouse: Lighthouse | null = null;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    scene.add(this.group);
  }

  /** Builds the eight places in sequence, yielding through `step`. */
  async build(quality: QualityId, step: BuildStep): Promise<void> {
    const g = this.group;
    await step("the old pier");
    this.pier = new OldPier(g, quality);
    await step("the bitten edge");
    this.bittenEdge = new BittenEdge(g, quality);
    await step("the cable house");
    this.cableHouse = new CableHouse(g, quality);
    await step("the old tip");
    this.tip = new OldTip(g, quality);
    await step("the boardwalk");
    this.boardwalk = new WardensBoardwalk(g, quality);
    await step("lane's end");
    this.lanesEnd = new LanesEnd(g, quality);
    await step("the chapel knoll");
    this.chantry = new ChantryKnoll(g, quality);
    await step("the bothy");
    this.bothy = new KeldBothy(g, quality);
    // After the bothy: the keeper's key hangs inside it (bothySite frame)
    await step("the lighthouse");
    this.lighthouse = new Lighthouse(g, quality);
  }

  update(dt: number, env: Environment, camPos: THREE.Vector3): void {
    this.chantry?.update(dt, env, camPos);
    this.pier?.update(dt, env, camPos);
    this.tip?.update(dt, env, camPos);
    this.cableHouse?.update(dt, env, camPos);
    this.bittenEdge?.update(dt, env, camPos);
    this.bothy?.update(dt, env, camPos);
    this.lanesEnd?.update(dt, env, camPos);
    this.boardwalk?.update(dt, env, camPos);
    this.lighthouse?.update(dt, env, camPos);
  }

  dispose(): void {
    this.chantry?.dispose();
    this.pier?.dispose();
    this.tip?.dispose();
    this.cableHouse?.dispose();
    this.bittenEdge?.dispose();
    this.bothy?.dispose();
    this.lanesEnd?.dispose();
    this.boardwalk?.dispose();
    this.lighthouse?.dispose();
    this.scene.remove(this.group);
  }
}
