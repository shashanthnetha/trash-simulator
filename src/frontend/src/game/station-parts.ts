// Trash Simulator – recycling station, part 1: concrete apron with ramp,
// drainage channel and floor markings, the corrugated-sheet hall with roller
// door, windows, roof, gutter, chimney and fascia band, plus the yard
// inventory (pallets, drums, cones).

import * as THREE from "three";
import {
  type ColliderFrame,
  addBoxCollider,
  addCylinderCollider,
  beginColliderSet,
} from "./colliders";
import {
  LAMP_CH,
  SD,
  type StationAtlas,
  type StationBag,
  box,
  boxFromTo,
  cylBetween,
  decalQuad,
  place,
  rivet,
  roundedBox,
  slopeTop,
  taperBox,
  tint,
  tubePath,
} from "./station-build";
import { terrainHeight } from "./terrain";

const FLAT = -Math.PI / 2;

/**
 * World placement of the station group. Mirrors STATION_POS and
 * group.rotation.y in station.ts – importing them here would close the cycle
 * station.ts -> station-parts.ts, so the two constants are kept in sync by hand.
 */
const STATION_AT = { x: 96, z: 118, yaw: -0.4 } as const;

/** Frame for all station colliders: station-local coordinates -> world. */
export function stationColliderFrame(): ColliderFrame {
  return {
    x: STATION_AT.x,
    y: terrainHeight(STATION_AT.x, STATION_AT.z),
    z: STATION_AT.z,
    yaw: STATION_AT.yaw,
  };
}

/**
 * Lower edge of every blocker standing on the yard. Reaches well below the
 * apron so a blocker still catches a body that walks in from the sand outside –
 * underneath everything here is solid concrete anyway.
 */
export const COLLIDER_FLOOR = -2.5;

/** Lower roof edge of the hall at position z (mono-pitch roof falling to the rear). */
export function hallRoofY(z: number): number {
  return 5.62 + (z + 3.1) * 0.0825;
}

// ---------------------------------------------------------------------------
// Walkable surface of the yard
// ---------------------------------------------------------------------------

/** Width of the blend band outside the slab (m): a short ramp, not a step. */
const APRON_BAND = 1.2;
/**
 * Access ramp in front of the slab: its top face starts flush with the slab
 * edge and drops away with the tilt of the ramp box (0.14 rad) over 3.76 m.
 */
const RAMP_LEN = 3.76;
const RAMP_SLOPE = Math.tan(0.14);
/** Weighbridge deck: centre, half extents, height above the concrete, bevel. */
const WB_X = -6.6;
const WB_Z = 5.9;
const WB_HX = 3.6;
const WB_HZ = 1.8;
const WB_TOP = 0.11;
const WB_BAND = 0.45;

/** Broad phase: outside this radius around the station nothing stands on concrete. */
const APRON_REACH = Math.hypot(
  SD.apronX + APRON_BAND,
  SD.apronZ + RAMP_LEN + APRON_BAND,
);
const YAW_COS = Math.cos(STATION_AT.yaw);
const YAW_SIN = Math.sin(STATION_AT.yaw);
/** World y of the slab top – terrainHeight() is pure, so this never changes. */
const APRON_TOP_Y = terrainHeight(STATION_AT.x, STATION_AT.z) + SD.apronTop;

/**
 * Height of the station's concrete surface at a world position, null where
 * there is none. The apron is one flat slab poured over the undulating terrain
 * (up to ~1 m of fill at the rear of the yard), so player and jeep have to
 * follow this instead of terrainHeight() – otherwise they sink into the pour.
 *
 * Outside the slab the value blends linearly into the terrain across
 * APRON_BAND, which turns the edge into a short ramp instead of a step, and it
 * never returns less than the terrain: the ground is only ever raised.
 * Allocation-free – runs once per frame for the player and four times for the jeep.
 */
export function apronHeight(x: number, z: number): number | null {
  const wx = x - STATION_AT.x;
  const wz = z - STATION_AT.z;
  if (wx * wx + wz * wz > APRON_REACH * APRON_REACH) return null;
  // World -> station-local (inverse of stationColliderFrame())
  const lx = wx * YAW_COS - wz * YAW_SIN;
  const lz = wx * YAW_SIN + wz * YAW_COS;
  // Nearest point of the concrete footprint (slab + access ramp)
  const zMax = SD.apronZ + RAMP_LEN;
  const qx = lx < -SD.apronX ? -SD.apronX : lx > SD.apronX ? SD.apronX : lx;
  const qz = lz < -SD.apronZ ? -SD.apronZ : lz > zMax ? zMax : lz;
  const ox = lx - qx;
  const oz = lz - qz;
  const out = Math.sqrt(ox * ox + oz * oz);
  if (out >= APRON_BAND) return null;

  let y = APRON_TOP_Y;
  // Access ramp: the slab top runs out into the sand towards the road
  if (qz > SD.apronZ) y -= (qz - SD.apronZ) * RAMP_SLOPE;
  // Weighbridge deck stands 11 cm proud – bevelled so it can be driven onto
  const bx = Math.abs(lx - WB_X) - WB_HX;
  const bz = Math.abs(lz - WB_Z) - WB_HZ;
  if (bx < WB_BAND && bz < WB_BAND) {
    const ex = bx > 0 ? bx : 0;
    const ez = bz > 0 ? bz : 0;
    const d = Math.sqrt(ex * ex + ez * ez);
    if (d < WB_BAND) y += WB_TOP * (1 - d / WB_BAND);
  }
  // At the edge and on the ramp the terrain can be the higher surface
  if (out > 0 || qz > SD.apronZ) {
    const th = terrainHeight(x, z);
    if (out > 0) y += (th - y) * (out / APRON_BAND);
    if (y < th) return th;
  }
  return y;
}

// ---------------------------------------------------------------------------
// Concrete apron
// ---------------------------------------------------------------------------

export function buildApron(bag: StationBag, atlas: StationAtlas): void {
  const AX = SD.apronX;
  const AZ = SD.apronZ;
  const TOP = SD.apronTop;
  beginColliderSet("station-apron", stationColliderFrame());

  // One pour – no overlapping slabs
  bag.add("concrete", boxFromTo(-AX, SD.apronBase, -AZ, AX, TOP, AZ));
  // Access ramp: its top edge sits flush with the edge of the slab
  bag.add("concrete", place(box(AX * 2, 0.5, 3.8), 0, -0.173, 12.05, 0.14));
  // Kerb at the back and the sides (open at the front for the driveway)
  bag.add("concrete", box(AX * 2, 0.18, 0.42, 0, TOP + 0.09, -AZ + 0.21));
  for (const sx of [-1, 1]) {
    bag.add(
      "concrete",
      box(0.42, 0.18, AZ * 0.92, sx * (AX - 0.21), TOP + 0.09, -AZ * 0.5),
    );
    // Buffer bollards at the driveway
    for (let k = 0; k < 2; k++) {
      const px = sx * (AX - 0.7);
      const pz = AZ - 1.1 - k * 3.2;
      bag.add("steel", box(0.34, 0.05, 0.34, px, TOP + 0.02, pz));
      bag.add(
        "paint",
        new THREE.CylinderGeometry(0.11, 0.13, 1.05, 10).translate(
          px,
          TOP + 0.55,
          pz,
        ),
        { color: tint("paint", "#e0a51f") },
      );
      bag.add("paint", box(0.28, 0.16, 0.28, px, TOP + 0.78, pz), {
        color: tint("paint", "#1d1f22"),
      });
      addCylinderCollider(px, pz, 0.19, COLLIDER_FLOOR, TOP + 0.86);
    }
  }

  // Drainage channel running across in front of the hall, with a grating
  const chZ = 3.2;
  bag.add(
    "dark",
    boxFromTo(-11.5, TOP - 0.34, chZ - 0.22, 11.5, TOP, chZ + 0.22),
  );
  for (let i = 0; i < 44; i++) {
    const gx = -11.2 + i * 0.52;
    bag.add("steel", box(0.09, 0.05, 0.46, gx, TOP - 0.03, chZ));
  }
  bag.add("steel", box(23, 0.06, 0.06, 0, TOP - 0.03, chZ - 0.2));
  bag.add("steel", box(23, 0.06, 0.06, 0, TOP - 0.03, chZ + 0.2));

  // Weighbridge: steel deck set into the concrete, frame, display column
  const wx = -6.6;
  const wz = 5.9;
  bag.add("steel", box(7.2, 0.16, 3.6, wx, TOP + 0.03, wz));
  for (let i = 0; i < 6; i++)
    bag.add("steel", box(7.0, 0.05, 0.06, wx, TOP + 0.12, wz - 1.5 + i * 0.6));
  bag.add("dark", box(7.5, 0.2, 3.9, wx, TOP - 0.06, wz));
  const dx = wx + 4.4;
  bag.add("steel", box(0.4, 0.08, 0.4, dx, TOP + 0.04, wz));
  bag.add("chrome", cylBetween(dx, TOP, wz, dx, TOP + 1.5, wz, 0.07, 8));
  bag.add("steel", roundedBox(0.68, 0.5, 0.3, 0.05, 0.02, dx, TOP + 1.82, wz));
  bag.add("steel", box(0.78, 0.06, 0.4, dx, TOP + 2.09, wz + 0.03));
  addDecal(bag, atlas.display, 0.6, 0.26, dx, TOP + 1.82, wz + 0.16, 0, 0);
  // The deck itself is flush with the concrete (drive-on) – only the display
  // column blocks.
  addCylinderCollider(dx, wz, 0.2, COLLIDER_FLOOR, TOP + 2.15);

  // Floor markings
  const dy = TOP + 0.014;
  // Lane arrow pointing to the hall
  addDecal(bag, atlas.arrow, 3.2, 0.85, -7.4, dy, 8.4, FLAT);
  // Hatching in front of the weighbridge and in front of the plant
  for (let i = 0; i < 10; i++)
    addDecal(bag, atlas.hatch, 1.6, 0.5, -11.2 + i * 1.6, dy, 3.95, FLAT);
  for (let i = 0; i < 7; i++)
    addDecal(bag, atlas.hatch, 1.6, 0.5, 2.2 + i * 1.6, dy, -0.4, FLAT);
  // Bay lines for the containers
  for (let i = 0; i < 4; i++) {
    const bx = SD.binX0 + i * SD.binDx;
    for (const s of [-1, 1])
      addDecal(
        bag,
        atlas.bayLine,
        2.2,
        0.14,
        bx + s * 1.35,
        dy,
        SD.binZ,
        FLAT,
        0,
        Math.PI / 2,
      );
    addDecal(bag, atlas.bayLine, 2.6, 0.14, bx, dy, SD.binZ + 1.1, FLAT);
  }
  // Expansion joints in the concrete
  for (let i = 0; i < 5; i++) {
    const jx = -AX + 2.3 + i * 5.4;
    for (let k = 0; k < 4; k++)
      addDecal(
        bag,
        atlas.joint,
        5.2,
        0.09,
        jx,
        dy,
        -AZ + 2.5 + k * 5.1,
        FLAT,
        0,
        Math.PI / 2,
      );
  }
}

/**
 * Place a decal quad from the atlas. The normal starts out as +z; `rz` rotates
 * the image within its plane (applied first), `rx`/`ry` orient the plane –
 * floor markings get rx = FLAT and are rotated via rz.
 */
function addDecal(
  bag: StationBag,
  region: readonly [number, number, number, number],
  w: number,
  h: number,
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
): void {
  bag.add("decal", place(decalQuad(region, w, h), x, y, z, rx, ry, rz), {
    keepUv: true,
  });
}

// ---------------------------------------------------------------------------
// Hall
// ---------------------------------------------------------------------------

/** Collider for one wall panel, given by its footprint corners and its top. */
function wallCollider(
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  top: number,
): void {
  addBoxCollider(
    (x0 + x1) / 2,
    (z0 + z1) / 2,
    Math.abs(x1 - x0) / 2,
    Math.abs(z1 - z0) / 2,
    0,
    COLLIDER_FLOOR,
    top,
  );
}

export function buildHall(bag: StationBag, atlas: StationAtlas): void {
  const X0 = SD.hallX0;
  const X1 = SD.hallX1;
  const Z0 = SD.hallZ0;
  const Z1 = SD.hallZ1;
  const BASE = 0.9;
  const dW = SD.doorW / 2;
  const dxc = SD.doorCx;
  const dTop = BASE + SD.doorH;
  const T = 0.16;

  // Concrete plinth
  bag.add(
    "concrete",
    boxFromTo(
      X0 - 0.16,
      SD.apronTop - 0.1,
      Z0 - 0.16,
      X1 + 0.16,
      BASE,
      Z1 + 0.16,
    ),
  );

  beginColliderSet("station-hall", stationColliderFrame());

  // Front wall with the door opening
  bag.add("wall", boxFromTo(X0, BASE, Z1 - T, dxc - dW, hallRoofY(Z1), Z1));
  bag.add("wall", boxFromTo(dxc + dW, BASE, Z1 - T, X1, hallRoofY(Z1), Z1));
  bag.add(
    "wall",
    boxFromTo(dxc - dW, dTop, Z1 - T, dxc + dW, hallRoofY(Z1), Z1),
  );
  // ... as two collider segments, so the door opening stays walkable (the
  // lowered curtain hangs above head height).
  wallCollider(X0, dxc - dW, Z1 - T, Z1, hallRoofY(Z1));
  wallCollider(dxc + dW, X1, Z1 - T, Z1, hallRoofY(Z1));
  // Rear wall and side walls (the sides follow the roof pitch)
  bag.add("wall", boxFromTo(X0, BASE, Z0, X1, hallRoofY(Z0), Z0 + T));
  wallCollider(X0, X1, Z0, Z0 + T, hallRoofY(Z0));
  for (const [sx, x] of [
    [-1, X0],
    [1, X1],
  ] as const) {
    const w = boxFromTo(x, BASE, Z0, x - sx * T, hallRoofY(Z1), Z1);
    slopeTop(w, hallRoofY(Z1) - 1e-3, (_x, z) => hallRoofY(z));
    bag.add("wall", w);
    wallCollider(x, x - sx * T, Z0, Z1, hallRoofY(Z1));
  }

  // Corner posts, base flashing and parapet flashing
  for (const [x, z] of [
    [X0, Z0],
    [X1, Z0],
    [X0, Z1],
    [X1, Z1],
  ] as const) {
    const c = box(0.26, hallRoofY(z) - BASE, 0.26, x, 0, z);
    c.translate(0, BASE + (hallRoofY(z) - BASE) / 2, 0);
    bag.add("steel", c);
  }
  bag.add(
    "steel",
    boxFromTo(
      X0 - 0.05,
      BASE - 0.06,
      Z1 - 0.05,
      X1 + 0.05,
      BASE + 0.16,
      Z1 + 0.05,
    ),
  );
  bag.add(
    "steel",
    boxFromTo(
      X0 - 0.05,
      BASE - 0.06,
      Z0 - 0.05,
      X1 + 0.05,
      BASE + 0.16,
      Z0 + 0.05,
    ),
  );

  // Mono-pitch roof with overhang and eaves flashing
  const roof = box(X1 - X0 + 0.7, 0.17, Z1 - Z0 + 0.8, (X0 + X1) / 2, 0, 0);
  place(roof, 0, 5.7, -3.1, -0.0823);
  bag.add("wall", roof);
  bag.add(
    "steel",
    place(
      box(X1 - X0 + 0.72, 0.13, 0.14, (X0 + X1) / 2, 0, 0),
      0,
      hallRoofY(Z1 + 0.4) - 0.02,
      Z1 + 0.44,
      -0.0823,
    ),
  );

  // Gutter (U-profile) and downpipe at the back
  const gz = Z0 - 0.42;
  const gy = hallRoofY(gz) - 0.2;
  const gL = X1 - X0 + 0.6;
  const gcx = (X0 + X1) / 2;
  bag.add("chrome", box(gL, 0.04, 0.24, gcx, gy - 0.1, gz));
  bag.add("chrome", box(gL, 0.2, 0.04, gcx, gy, gz - 0.1));
  bag.add("chrome", box(gL, 0.2, 0.04, gcx, gy, gz + 0.1));
  for (let i = 0; i < 7; i++)
    bag.add("steel", box(0.05, 0.06, 0.34, X0 + 0.4 + i * 1.9, gy - 0.08, gz));
  bag.add(
    "chrome",
    tubePath(
      [
        [X0 + 0.6, gy - 0.1, gz],
        [X0 + 0.6, gy - 0.7, gz],
        [X0 + 0.6, gy - 0.9, gz + 0.28],
        [X0 + 0.6, SD.apronTop + 0.15, gz + 0.28],
      ],
      0.075,
      0.16,
      7,
    ),
  );

  // Roller door: guide rails, roll box, half-lowered curtain
  for (const s of [-1, 1]) {
    const rx = dxc + s * (dW + 0.16);
    bag.add(
      "steel",
      box(0.22, SD.doorH + 0.5, 0.3, rx, BASE + SD.doorH / 2 + 0.2, Z1 - 0.12),
    );
    bag.add(
      "steel",
      box(
        0.1,
        SD.doorH + 0.5,
        0.12,
        rx - s * 0.12,
        BASE + SD.doorH / 2 + 0.2,
        Z1 - 0.12,
      ),
    );
  }
  bag.add("steel", box(SD.doorW + 0.7, 0.66, 0.62, dxc, dTop + 0.36, Z1 - 0.1));
  for (const s of [-1, 1]) {
    const cap = new THREE.CylinderGeometry(0.3, 0.3, 0.1, 12);
    cap.rotateZ(Math.PI / 2);
    bag.add(
      "chrome",
      cap.translate(dxc + s * (dW + 0.4), dTop + 0.36, Z1 - 0.1),
    );
  }
  const curtain = tint("paint", "#79828a");
  for (let i = 0; i < 10; i++) {
    const sy = dTop - 0.075 - i * 0.15;
    if (sy < dTop - 1.55) break;
    bag.add(
      "paint",
      box(SD.doorW - 0.06, 0.145, 0.07 + (i % 2) * 0.02, dxc, sy, Z1 - 0.14),
      {
        color: curtain,
      },
    );
  }
  bag.add(
    "paint",
    box(SD.doorW - 0.02, 0.14, 0.11, dxc, dTop - 1.62, Z1 - 0.14),
    {
      color: tint("paint", "#7d858c"),
    },
  );

  // Interior: floor, walls, ceiling light, bales and shelving
  const iz0 = Z0 + T + 0.02;
  const iz1 = Z1 - T - 0.02;
  bag.add(
    "concrete",
    boxFromTo(X0 + T, BASE - 0.1, iz0, X1 - T, BASE + 0.02, iz1),
  );
  bag.add("concrete", boxFromTo(X0 + T, BASE, iz0, X0 + T + 0.06, 5.2, iz1));
  bag.add("concrete", boxFromTo(X1 - T - 0.06, BASE, iz0, X1 - T, 5.2, iz1));
  bag.add("concrete", boxFromTo(X0 + T, BASE, iz0, X1 - T, 5.2, iz0 + 0.06));
  bag.add("dark", boxFromTo(X0 + T, 5.12, iz0, X1 - T, 5.24, iz1));
  // Visible roof trusses above the door
  for (let i = 0; i < 4; i++) {
    const tz = iz0 + 0.9 + i * 2.1;
    bag.add("steel", box(X1 - X0 - 2 * T, 0.22, 0.1, (X0 + X1) / 2, 4.9, tz));
    bag.add("steel", box(X1 - X0 - 2 * T, 0.06, 0.06, (X0 + X1) / 2, 4.3, tz));
  }
  for (const lx of [dxc - 1.6, dxc + 1.6]) {
    bag.add("steel", box(2.2, 0.12, 0.24, lx, 5.02, -1.2));
    bag.add("lamp", box(2.0, 0.06, 0.18, lx, 4.94, -1.2), {
      color: [1, 0.97, 0.86, LAMP_CH.interior],
    });
  }
  const bale = tint("plastic", "#6e7a83");
  for (let i = 0; i < 7; i++) {
    const bx = dxc - 1.9 + (i % 3) * 1.35;
    const by = BASE + 0.55 + Math.floor(i / 3) * 1.06;
    bag.add("plastic", box(1.25, 1.0, 1.15, bx, by, -3.4), { color: bale });
    for (let k = 0; k < 3; k++)
      bag.add("dark", box(1.28, 0.05, 0.05, bx, by - 0.3 + k * 0.3, -2.83));
  }
  addBoxCollider(
    dxc - 0.55,
    -3.4,
    1.98,
    0.63,
    0,
    COLLIDER_FLOOR,
    BASE + 0.55 + 2 * 1.06 + 0.5,
  );
  for (let i = 0; i < 3; i++)
    bag.add("steel", box(3.0, 0.1, 0.9, X1 - 1.9, BASE + 0.7 + i * 1.1, -5.6));
  for (const px of [X1 - 3.3, X1 - 0.5])
    bag.add("steel", box(0.12, 3.2, 0.12, px, BASE + 1.6, -5.6));
  addBoxCollider(X1 - 1.9, -5.6, 1.56, 0.5, 0, COLLIDER_FLOOR, BASE + 3.2);

  // Side door and windows
  const pdx = X1 - 1.7;
  bag.add("steel", box(1.24, 2.32, 0.1, pdx, BASE + 1.16, Z1 + 0.02));
  bag.add("paint", box(1.06, 2.14, 0.09, pdx, BASE + 1.07, Z1 + 0.05), {
    color: tint("paint", "#4a6b78"),
  });
  bag.add("chrome", box(0.06, 0.06, 0.22, pdx + 0.4, BASE + 1.05, Z1 + 0.14));
  bag.add("chrome", box(0.3, 0.05, 0.05, pdx + 0.4, BASE + 1.05, Z1 + 0.2));
  for (const [wx, wy, wz, ry] of [
    [X1 - 1.7, 4.3, Z1 + 0.02, 0],
    [X0 + 1.6, 4.3, Z1 + 0.02, 0],
    [X0 - 0.02, 4.15, -2.2, -Math.PI / 2],
    [X0 - 0.02, 4.15, -5.0, -Math.PI / 2],
  ] as const) {
    bag.add("steel", place(box(1.5, 1.16, 0.12), wx, wy, wz, 0, ry));
    bag.add(
      "glass",
      place(box(1.32, 0.98, 0.04, 0, 0, 0.03), wx, wy, wz, 0, ry),
    );
    bag.add("steel", place(box(0.06, 1.0, 0.1, 0, 0, 0.02), wx, wy, wz, 0, ry));
    bag.add(
      "lamp",
      place(box(1.3, 0.96, 0.02, 0, 0, -0.05), wx, wy, wz, 0, ry),
      {
        color: [1, 0.9, 0.66, LAMP_CH.interior],
      },
    );
  }

  // Fascia band with the lettering
  const fy = hallRoofY(Z1) - 0.35;
  bag.add(
    "paint",
    boxFromTo(X0 - 0.2, fy - 0.6, Z1 + 0.02, X1 + 0.2, fy + 0.6, Z1 + 0.32),
    {
      color: tint("paint", "#f0efe9"),
    },
  );
  bag.add(
    "steel",
    boxFromTo(X0 - 0.24, fy + 0.6, Z1, X1 + 0.24, fy + 0.72, Z1 + 0.36),
  );
  bag.add(
    "steel",
    boxFromTo(X0 - 0.24, fy - 0.72, Z1, X1 + 0.24, fy - 0.6, Z1 + 0.36),
  );
  for (let i = 0; i < 5; i++) {
    const bx = X0 + 0.8 + i * 2.6;
    bag.add("steel", box(0.1, 1.3, 0.34, bx, fy, Z1 + 0.17));
  }
  addDecal(bag, atlas.logo, 5.6, 1.4, dxc - 0.9, fy, Z1 + 0.34, 0, 0);
  addDecal(bag, atlas.annahme, 2.4, 0.63, X1 - 1.5, fy, Z1 + 0.34, 0, 0);
  // LED strip that lights up the sign at night
  for (let i = 0; i < 4; i++) {
    const lx = X0 + 1.5 + i * 3.2;
    bag.add("steel", box(2.6, 0.1, 0.24, lx, fy - 0.66, Z1 + 0.42));
    bag.add("lamp", box(2.4, 0.05, 0.16, lx, fy - 0.7, Z1 + 0.42), {
      color: [1, 0.95, 0.8, LAMP_CH.flood],
    });
  }
  // Warning board and hazard sign next to the door
  addDecal(bag, atlas.warn, 1.15, 0.49, dxc + dW + 0.9, 2.7, Z1 + 0.03, 0, 0);
  addDecal(bag, atlas.hazard, 0.55, 0.5, dxc + dW + 0.9, 3.45, Z1 + 0.03, 0, 0);
  bag.add("steel", box(1.3, 1.5, 0.06, dxc + dW + 0.9, 3.05, Z1 - 0.01));

  // Hose reel on the facade
  const hx = X0 + 1.6;
  bag.add("steel", box(0.5, 0.1, 0.4, hx, 2.5, Z1 + 0.22));
  bag.add("steel", box(0.1, 0.9, 0.4, hx - 0.28, 2.05, Z1 + 0.22));
  bag.add("steel", box(0.1, 0.9, 0.4, hx + 0.28, 2.05, Z1 + 0.22));
  const reel = new THREE.CylinderGeometry(0.34, 0.34, 0.42, 14, 1, true);
  reel.rotateZ(Math.PI / 2);
  bag.add("rubber", reel.translate(hx, 1.95, Z1 + 0.22));
  for (const s of [-1, 1]) {
    const disc = new THREE.CylinderGeometry(0.4, 0.4, 0.05, 14);
    disc.rotateZ(Math.PI / 2);
    bag.add("paint", disc.translate(hx + s * 0.24, 1.95, Z1 + 0.22), {
      color: tint("paint", "#b8322c"),
    });
  }
  bag.add(
    "rubber",
    tubePath(
      [
        [hx + 0.3, 1.62, Z1 + 0.22],
        [hx + 0.6, 1.2, Z1 + 0.5],
        [hx + 0.35, 0.55, Z1 + 0.9],
        [hx - 0.4, SD.apronTop + 0.06, Z1 + 1.4],
      ],
      0.045,
      0.3,
      6,
    ),
  );

  // Chimney with base flange, bands, guy wires and rain cap. It stands on the
  // roof inside the hall footprint – the wall colliders already cover it.
  const cx = X0 + 1.9;
  const cz = -5.4;
  const cy0 = hallRoofY(cz);
  bag.add("steel", box(1.0, 0.14, 1.0, cx, cy0 + 0.05, cz));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    bag.add(
      "steel",
      rivet(
        cx + Math.cos(a) * 0.38,
        cy0 + 0.13,
        cz + Math.sin(a) * 0.38,
        0,
        1,
        0,
        0.06,
      ),
    );
  }
  bag.add(
    "steel",
    new THREE.CylinderGeometry(0.36, 0.44, 2.6, 12).translate(
      cx,
      cy0 + 1.4,
      cz,
    ),
  );
  bag.add(
    "rust",
    new THREE.CylinderGeometry(0.33, 0.36, 1.9, 12).translate(
      cx,
      cy0 + 3.6,
      cz,
    ),
  );
  for (const by of [1.6, 3.1]) {
    const band = new THREE.CylinderGeometry(0.4, 0.4, 0.14, 12);
    bag.add("chrome", band.translate(cx, cy0 + by, cz));
  }
  bag.add(
    "rust",
    new THREE.CylinderGeometry(0.5, 0.34, 0.24, 12).translate(
      cx,
      cy0 + 4.62,
      cz,
    ),
  );
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    bag.add(
      "chrome",
      box(
        0.05,
        0.28,
        0.05,
        cx + Math.cos(a) * 0.34,
        cy0 + 4.86,
        cz + Math.sin(a) * 0.34,
      ),
    );
    bag.add(
      "chrome",
      cylBetween(
        cx,
        cy0 + 3.1,
        cz,
        cx + Math.cos(a) * 1.5,
        cy0 + 0.15,
        cz + Math.sin(a) * 1.5,
        0.025,
        5,
      ),
    );
  }
  bag.add(
    "rust",
    new THREE.CylinderGeometry(0.56, 0.56, 0.09, 12).translate(
      cx,
      cy0 + 5.04,
      cz,
    ),
  );

  // Wall-mounted floodlights
  for (const wx of [X0 + 3.2, X1 - 3.2]) {
    bag.add("steel", box(0.14, 0.14, 0.5, wx, 5.0, Z1 + 0.28));
    bag.add(
      "paint",
      roundedBox(0.5, 0.3, 0.28, 0.05, 0.03, wx, 4.94, Z1 + 0.55),
      {
        color: tint("paint", "#3a4045"),
      },
    );
    bag.add(
      "lamp",
      place(box(0.42, 0.03, 0.22, 0, 0, 0), wx, 4.79, Z1 + 0.55, 0.35),
      {
        color: [1, 0.93, 0.72, LAMP_CH.flood],
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Yard inventory
// ---------------------------------------------------------------------------

/** Euro pallet (ready to merge, top edge at y = 0.144). */
function pallet(
  x: number,
  y: number,
  z: number,
  ry: number,
): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry) => out.push(place(g, x, y, z, 0, ry));
  for (let i = 0; i < 3; i++)
    add(box(1.2, 0.022, 0.1, 0, 0.011, -0.4 + i * 0.4));
  for (let i = 0; i < 3; i++)
    for (let k = 0; k < 3; k++)
      add(box(0.1, 0.078, 0.1, -0.55 + k * 0.55, 0.061, -0.4 + i * 0.4));
  for (let i = 0; i < 5; i++)
    add(box(1.2, 0.022, 0.14, 0, 0.111, -0.4 + i * 0.2));
  return out;
}

export function buildYard(bag: StationBag, atlas: StationAtlas): void {
  const TOP = SD.apronTop;
  beginColliderSet("station-yard", stationColliderFrame());

  // Pallet stacks (`ch` = height of the stack including the crates on top)
  for (const [px, pz, pr, n, ch] of [
    [-12.3, 5.0, 0.2, 5, 1.9],
    [-12.3, 7.3, -0.1, 3, 0.45],
    [1.1, 7.4, 0.9, 4, 1.75],
  ] as const) {
    for (let i = 0; i < n; i++)
      for (const g of pallet(px, TOP + i * 0.148, pz, pr)) bag.add("wood", g);
    addBoxCollider(px, pz, 0.62, 0.47, pr, COLLIDER_FLOOR, TOP + ch);
  }
  // Wooden crates on the topmost stack
  for (const [kx, kz, kr] of [
    [-12.2, 5.0, 0.25],
    [1.2, 7.35, 0.85],
  ] as const) {
    const kyBase = kx < 0 ? TOP + 1.01 : TOP + 0.86;
    for (let i = 0; i < 2; i++) {
      const ky = kyBase + i * 0.56;
      bag.add(
        "wood",
        place(box(0.9, 0.54, 0.7, 0, 0, 0), kx, ky, kz, 0, kr + i * 0.15),
      );
      for (const s of [-1, 1])
        bag.add(
          "wood",
          place(
            box(0.94, 0.06, 0.08, 0, 0, s * 0.26),
            kx,
            ky + 0.2,
            kz,
            0,
            kr + i * 0.15,
          ),
        );
    }
  }

  // Drums (three upright, one lying down)
  const drum = (
    x: number,
    y: number,
    z: number,
    lying: boolean,
    ry: number,
  ) => {
    const body = new THREE.CylinderGeometry(0.29, 0.29, 0.88, 14);
    const h1 = new THREE.CylinderGeometry(0.31, 0.31, 0.08, 14).translate(
      0,
      0.2,
      0,
    );
    const h2 = new THREE.CylinderGeometry(0.31, 0.31, 0.08, 14).translate(
      0,
      -0.2,
      0,
    );
    const rim = new THREE.CylinderGeometry(0.3, 0.3, 0.06, 14).translate(
      0,
      0.44,
      0,
    );
    for (const g of [body, h1, h2, rim]) {
      if (lying) g.rotateX(Math.PI / 2);
      bag.add("rust", place(g, x, y, z, 0, ry));
    }
    if (!lying) bag.add("chrome", rivet(x + 0.14, y + 0.47, z, 0, 1, 0, 0.05));
    if (lying) addBoxCollider(x, z, 0.33, 0.48, ry, COLLIDER_FLOOR, y + 0.33);
    else addCylinderCollider(x, z, 0.33, COLLIDER_FLOOR, y + 0.47);
  };
  drum(11.9, TOP + 0.46, 1.6, false, 0.3);
  drum(12.4, TOP + 0.46, 2.3, false, 1.1);
  drum(11.6, TOP + 0.29, 2.6, true, 0.6);

  // Traffic cones, tyres, broom: knee-high clutter, deliberately without
  // colliders – you walk over them instead of bumping into thin air.
  for (const [cx, cz] of [
    [-2.2, 8.4],
    [-0.9, 8.7],
    [4.6, 3.0],
    [13.0, 4.4],
  ] as const) {
    bag.add("paint", box(0.36, 0.05, 0.36, cx, TOP + 0.025, cz), {
      color: tint("paint", "#d2571c"),
    });
    bag.add(
      "paint",
      new THREE.ConeGeometry(0.15, 0.62, 10).translate(cx, TOP + 0.35, cz),
      {
        color: tint("paint", "#d2571c"),
      },
    );
    bag.add(
      "paint",
      new THREE.CylinderGeometry(0.105, 0.125, 0.13, 10).translate(
        cx,
        TOP + 0.33,
        cz,
      ),
      {
        color: tint("paint", "#eae6dc"),
      },
    );
  }

  // Stack of tyres
  for (let i = 0; i < 3; i++)
    bag.add(
      "rubber",
      new THREE.TorusGeometry(0.32, 0.13, 6, 14)
        .rotateX(Math.PI / 2)
        .translate(-12.6, TOP + 0.14 + i * 0.24, -4.2),
    );

  // Small wheelie bin with a lid
  const wb = 12.3;
  const wbz = -6.6;
  bag.add("plastic", taperBox(0.7, 0.62, 1.0, 0.82, wb, TOP + 0.65, wbz), {
    color: tint("plastic", "#39424a"),
  });
  bag.add("plastic", box(0.74, 0.07, 0.66, wb, TOP + 1.18, wbz), {
    color: tint("plastic", "#232a30"),
  });
  for (const s of [-1, 1]) {
    const w = new THREE.CylinderGeometry(0.11, 0.11, 0.07, 8);
    w.rotateZ(Math.PI / 2);
    bag.add("rubber", w.translate(wb + s * 0.3, TOP + 0.11, wbz - 0.2));
  }
  addBoxCollider(wb, wbz, 0.4, 0.36, 0, COLLIDER_FLOOR, TOP + 1.22);

  // Broom leaning against the hall wall
  bag.add(
    "wood",
    place(
      new THREE.CylinderGeometry(0.023, 0.028, 1.5, 6),
      -0.95,
      TOP + 0.72,
      1.65,
      0.14,
      0,
      0.1,
    ),
  );
  bag.add(
    "dark",
    place(box(0.42, 0.1, 0.12, 0, 0, 0), -1.06, TOP + 0.05, 1.86, 0, 0.1),
  );

  // Sign at the weighbridge approach (two posts with base plates)
  const sx = -12.4;
  const sz = 9.3;
  for (const s of [-1, 1]) {
    bag.add("steel", box(0.42, 0.05, 0.42, sx + s * 0.85, TOP + 0.025, sz));
    bag.add("steel", box(0.12, 2.5, 0.12, sx + s * 0.85, TOP + 1.25, sz));
    for (const k of [-1, 1])
      bag.add(
        "steel",
        rivet(sx + s * 0.85 + k * 0.14, TOP + 0.05, sz, 0, 1, 0, 0.04),
      );
    bag.add(
      "steel",
      cylBetween(
        sx + s * 0.85,
        TOP + 1.9,
        sz,
        sx + s * 0.85,
        TOP + 2.3,
        sz + 0.35,
        0.03,
        6,
      ),
    );
    addCylinderCollider(sx + s * 0.85, sz, 0.15, COLLIDER_FLOOR, TOP + 2.5);
  }
  bag.add("steel", box(2.5, 1.1, 0.08, sx, TOP + 2.16, sz));
  addDecal(bag, atlas.waage, 2.2, 0.8, sx, TOP + 2.16, sz + 0.05, 0, 0);
  bag.add("paint", box(2.6, 0.09, 0.13, sx, TOP + 2.75, sz), {
    color: tint("paint", "#0d5c6b"),
  });
}
