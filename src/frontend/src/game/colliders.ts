// Trash Simulator – static world colliders. Walls, machines and yard clutter
// are registered as boxes with a yaw (OBB) or as vertical cylinders, each with
// a height band [y0, y1]. Moving bodies (player, jeep) push their body circle
// out of them; the ground stays the terrain, so only blockers live here.
//
// Deliberately without a Three.js import (like terrain.ts) – plain numbers, no
// import cycles, no per-frame allocations. Colliders are grouped by a tag so a
// rebuild of the object that owns them replaces exactly its own set.

/** Placement of a local coordinate system in the world (an Object3D frame). */
export interface ColliderFrame {
  x: number;
  y: number;
  z: number;
  /** Rotation about Y, like Object3D.rotation.y. */
  yaw: number;
}

/** Result of resolveCircle – reused, so read it before the next call. */
export interface ColliderHit {
  x: number;
  z: number;
}

interface Collider {
  tag: string;
  /** 0 = box (OBB), 1 = vertical cylinder. */
  kind: number;
  x: number;
  z: number;
  /** Box: half extents. Cylinder: radius in hx. */
  hx: number;
  hz: number;
  /** cos/sin of the world yaw (box only). */
  cos: number;
  sin: number;
  y0: number;
  y1: number;
  /** Bounding radius in XZ for the near phase. */
  br: number;
}

const IDENTITY: ColliderFrame = { x: 0, y: 0, z: 0, yaw: 0 };
/** Relaxation passes: corners and touching colliders need more than one. */
const PASSES = 3;

const colliders: Collider[] = [];
let frame: ColliderFrame = IDENTITY;
let group = "";

// Broad phase: one bounding circle over everything. Away from it a query costs
// a single distance check.
let boundX = 0;
let boundZ = 0;
let boundR = -1;

function updateBounds(): void {
  if (colliders.length === 0) {
    boundR = -1;
    return;
  }
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const c of colliders) {
    if (c.x - c.br < minX) minX = c.x - c.br;
    if (c.x + c.br > maxX) maxX = c.x + c.br;
    if (c.z - c.br < minZ) minZ = c.z - c.br;
    if (c.z + c.br > maxZ) maxZ = c.z + c.br;
  }
  boundX = (minX + maxX) / 2;
  boundZ = (minZ + maxZ) / 2;
  let r = 0;
  for (const c of colliders) {
    const d = Math.hypot(c.x - boundX, c.z - boundZ) + c.br;
    if (d > r) r = d;
  }
  boundR = r;
}

/**
 * Start a collider group: drops everything previously registered under `tag`
 * and makes all following add* calls belong to it. `setFrame` places the local
 * coordinates of those calls in the world (omit it for world coordinates).
 * Order-independent, so every builder can open its own group.
 */
export function beginColliderSet(tag: string, setFrame?: ColliderFrame): void {
  for (let i = colliders.length - 1; i >= 0; i--) {
    if (colliders[i].tag === tag) colliders.splice(i, 1);
  }
  group = tag;
  frame = setFrame ?? IDENTITY;
  updateBounds();
}

/** Box with a single Y rotation, centre (cx, cz) in the current frame. */
export function addBoxCollider(
  cx: number,
  cz: number,
  halfX: number,
  halfZ: number,
  yaw: number,
  y0: number,
  y1: number,
): void {
  const fc = Math.cos(frame.yaw);
  const fs = Math.sin(frame.yaw);
  const wYaw = yaw + frame.yaw;
  colliders.push({
    tag: group,
    kind: 0,
    x: frame.x + cx * fc + cz * fs,
    z: frame.z - cx * fs + cz * fc,
    hx: halfX,
    hz: halfZ,
    cos: Math.cos(wYaw),
    sin: Math.sin(wYaw),
    y0: frame.y + y0,
    y1: frame.y + y1,
    br: Math.hypot(halfX, halfZ),
  });
  updateBounds();
}

/** Vertical cylinder, centre (cx, cz) in the current frame. */
export function addCylinderCollider(
  cx: number,
  cz: number,
  r: number,
  y0: number,
  y1: number,
): void {
  const fc = Math.cos(frame.yaw);
  const fs = Math.sin(frame.yaw);
  colliders.push({
    tag: group,
    kind: 1,
    x: frame.x + cx * fc + cz * fs,
    z: frame.z - cx * fs + cz * fc,
    hx: r,
    hz: r,
    cos: 1,
    sin: 0,
    y0: frame.y + y0,
    y1: frame.y + y1,
    br: r,
  });
  updateBounds();
}

/** Drop every collider (world teardown). */
export function clearColliders(): void {
  colliders.length = 0;
  updateBounds();
}

/**
 * Drop only the colliders registered under `tag` – teardown for a single
 * module without wiping groups that other modules may have registered.
 */
export function clearColliderSet(tag: string): void {
  for (let i = colliders.length - 1; i >= 0; i--) {
    if (colliders[i].tag === tag) colliders.splice(i, 1);
  }
  updateBounds();
}

/** Number of registered colliders (dev harness / diagnostics). */
export function colliderCount(): number {
  return colliders.length;
}

/** Colliders per group, split by kind (dev harness / diagnostics). */
export function colliderStats(): Record<
  string,
  { boxes: number; cylinders: number }
> {
  const out: Record<string, { boxes: number; cylinders: number }> = {};
  for (const c of colliders) {
    const e = out[c.tag] ?? { boxes: 0, cylinders: 0 };
    if (c.kind === 1) e.cylinders++;
    else e.boxes++;
    out[c.tag] = e;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

const SHARED: ColliderHit = { x: 0, z: 0 };

/** Push `out` out of one box; returns true if it was moved. */
function pushBox(c: Collider, radius: number, out: ColliderHit): boolean {
  const dx = out.x - c.x;
  const dz = out.z - c.z;
  const reach = c.br + radius;
  if (dx * dx + dz * dz > reach * reach) return false;
  // World -> box space
  const lx = dx * c.cos - dz * c.sin;
  const lz = dx * c.sin + dz * c.cos;
  const qx = lx < -c.hx ? -c.hx : lx > c.hx ? c.hx : lx;
  const qz = lz < -c.hz ? -c.hz : lz > c.hz ? c.hz : lz;
  const ex = lx - qx;
  const ez = lz - qz;
  let nx = lx;
  let nz = lz;
  if (ex !== 0 || ez !== 0) {
    // Outside: push out along the shortest way to the surface (slides at edges)
    const d2 = ex * ex + ez * ez;
    if (d2 >= radius * radius) return false;
    const k = radius / Math.sqrt(d2);
    nx = qx + ex * k;
    nz = qz + ez * k;
  } else {
    // Centre inside the box: out through the nearest face
    const px = c.hx - Math.abs(lx);
    const pz = c.hz - Math.abs(lz);
    if (px <= pz) nx = (lx < 0 ? -1 : 1) * (c.hx + radius);
    else nz = (lz < 0 ? -1 : 1) * (c.hz + radius);
  }
  out.x = c.x + nx * c.cos + nz * c.sin;
  out.z = c.z - nx * c.sin + nz * c.cos;
  return true;
}

/** Push `out` out of one cylinder; returns true if it was moved. */
function pushCylinder(c: Collider, radius: number, out: ColliderHit): boolean {
  const dx = out.x - c.x;
  const dz = out.z - c.z;
  const reach = c.hx + radius;
  const d2 = dx * dx + dz * dz;
  if (d2 >= reach * reach) return false;
  const d = Math.sqrt(d2);
  if (d < 1e-6) {
    out.x = c.x + reach;
    return true;
  }
  const k = reach / d;
  out.x = c.x + dx * k;
  out.z = c.z + dz * k;
  return true;
}

/**
 * Push a moving circle out of all colliders whose height band overlaps
 * [bodyY0, bodyY1]. Returns the corrected position – tangential motion is kept,
 * so a body slides along a wall instead of stopping dead or being teleported.
 * `out` is reused when no target is passed.
 */
export function resolveCircle(
  x: number,
  z: number,
  radius: number,
  bodyY0: number,
  bodyY1: number,
  out: ColliderHit = SHARED,
): ColliderHit {
  out.x = x;
  out.z = z;
  if (boundR < 0) return out;
  // Broad phase: one distance check away from the collider cluster
  const bx = x - boundX;
  const bz = z - boundZ;
  const reach = boundR + radius;
  if (bx * bx + bz * bz > reach * reach) return out;

  for (let pass = 0; pass < PASSES; pass++) {
    let moved = false;
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      if (c.y1 <= bodyY0 || c.y0 >= bodyY1) continue;
      const hit =
        c.kind === 1 ? pushCylinder(c, radius, out) : pushBox(c, radius, out);
      if (hit) moved = true;
    }
    if (!moved) break;
  }
  return out;
}
