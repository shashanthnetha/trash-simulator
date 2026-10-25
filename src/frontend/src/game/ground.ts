// Ground the moving bodies stand on. The terrain is the default; built
// surfaces override it where they exist: the station's concrete apron (a
// slab poured over undulating sand) and any deck a place module registers –
// the pier planks, for example. Player, jeep and dog all query this, so a
// registered surface is walkable for everything at once.
//
// Overrides return null where they have no surface. Registration is keyed by
// tag so a rebuild replaces exactly its own entry; the world teardown clears
// everything.

import { apronHeight } from "./station-parts";
import { terrainHeight } from "./terrain";

/**
 * Height of a walkable surface at (x, z), or null where the override has
 * none. `refY` is the querying body's current FOOT height – surfaces that
 * overlap themselves in plan (the lighthouse's spiral stair wraps several
 * turns over the same footprint) use it to answer with the turn nearest the
 * body; single-level surfaces may ignore it. It is undefined for queries
 * with no body context (spawn placement, teleports) – multi-level overrides
 * must return null then, so things fall back to the terrain.
 */
export type GroundFn = (x: number, z: number, refY?: number) => number | null;

const overrides: Array<{ tag: string; fn: GroundFn }> = [];

export function registerGround(tag: string, fn: GroundFn): void {
  unregisterGround(tag);
  overrides.push({ tag, fn });
}

export function unregisterGround(tag: string): void {
  for (let i = overrides.length - 1; i >= 0; i--) {
    if (overrides[i].tag === tag) overrides.splice(i, 1);
  }
}

export function clearGroundOverrides(): void {
  overrides.length = 0;
}

/** Height of whatever a body stands on at (x, z). Allocation-free. */
export function groundHeight(x: number, z: number, refY?: number): number {
  const apron = apronHeight(x, z);
  if (apron !== null) return apron;
  for (let i = 0; i < overrides.length; i++) {
    const y = overrides[i].fn(x, z, refY);
    if (y !== null) return y;
  }
  return terrainHeight(x, z);
}
