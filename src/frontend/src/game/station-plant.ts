// Trash Simulator – recycling station, part 2: sorting plant (steel frame,
// steep conveyor with belt, hopper, trommel screen, gearbox/motor, hydraulics,
// walkway, control cabinet, beacon light, fill-level gauge), the four
// recyclables containers and the floodlight masts.

import * as THREE from "three";
import {
  addBoxCollider,
  addCylinderCollider,
  beginColliderSet,
} from "./colliders";
import {
  type AddOpts,
  type DecalRegion,
  LAMP_CH,
  SD,
  type StMat,
  type StationAtlas,
  type StationBag,
  applyMatUv,
  box,
  boxFromTo,
  cylBetween,
  decalQuad,
  mergeAll,
  place,
  rivet,
  roundedBox,
  taperBox,
  tint,
  tubePath,
} from "./station-build";
import { COLLIDER_FLOOR, stationColliderFrame } from "./station-parts";

/** Moving parts of the plant (separate meshes, outside the collected meshes). */
export interface PlantParts {
  /** Rotary screen drum, centred on its own x axis – the mesh rotates rotation.x. */
  drum: THREE.BufferGeometry;
  drumAt: THREE.Vector3;
  /** Belt surface (the texture scrolls in u). */
  belt: THREE.BufferGeometry;
  /** Fill-level bar, bottom edge at y = 0 – the mesh scales scale.y. */
  gaugeBar: THREE.BufferGeometry;
  gaugeAt: THREE.Vector3;
  /** Pools of light from the floodlights (additive, faded in at night). */
  pools: THREE.BufferGeometry;
  /** Mounting point of the yard spotlight and its target point. */
  spotAt: THREE.Vector3;
  spotTarget: THREE.Vector3;
}

const UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// Sorting plant
// ---------------------------------------------------------------------------

/**
 * Stick warning hatching onto a part as a band. Only as much of the atlas tile
 * is used as keeps the diagonals undistorted; `vertical` stands the band
 * upright (frame uprights).
 */
function stripe(
  bag: StationBag,
  atlas: StationAtlas,
  len: number,
  wide: number,
  x: number,
  y: number,
  z: number,
  ry = 0,
  vertical = false,
): void {
  const [u0, v0, u1, v1] = atlas.chevron;
  const f = Math.min(1, len / wide / (1024 / 72));
  const r: DecalRegion = [u0, v0, u0 + (u1 - u0) * f, v1];
  const rz = vertical ? Math.PI / 2 : 0;
  bag.add("decal", place(decalQuad(r, len, wide), x, y, z, 0, ry, rz), {
    keepUv: true,
  });
}

export function buildPlant(
  bag: StationBag,
  atlas: StationAtlas,
): Omit<PlantParts, "pools" | "spotAt" | "spotTarget"> {
  const CX = SD.plantCx;
  const CZ = SD.plantCz;
  const TOP = SD.apronTop;
  const FT = SD.frameTop;
  const yellow = tint("paint", "#d8a521");
  const machine = tint("paint", "#3c6e8f");
  beginColliderSet("station-plant", stationColliderFrame());

  // --- Foundation and frame
  bag.add(
    "concrete",
    boxFromTo(CX - 3.3, TOP, CZ - 2.7, CX + 3.3, TOP + 0.22, CZ + 2.7),
  );
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const px = CX + sx * 2.75;
      const pz = CZ + sz * 2.15;
      bag.add("steel", box(0.48, 0.06, 0.48, px, TOP + 0.25, pz));
      for (const kx of [-1, 1])
        for (const kz of [-1, 1])
          bag.add(
            "chrome",
            rivet(px + kx * 0.16, TOP + 0.28, pz + kz * 0.16, 0, 1, 0, 0.045),
          );
      bag.add(
        "steel",
        box(0.22, FT - TOP, 0.22, px, (TOP + FT) / 2 + 0.14, pz),
      );
      stripe(
        bag,
        atlas,
        0.62,
        0.2,
        px,
        TOP + 0.68,
        pz + sz * 0.115,
        sz > 0 ? 0 : Math.PI,
        true,
      );
    }
  // Rails and cross bracing
  for (const y of [FT, FT - 1.5]) {
    for (const sz of [-1, 1])
      bag.add("steel", box(5.72, 0.2, 0.14, CX, y, CZ + sz * 2.15));
    for (const sx of [-1, 1])
      bag.add("steel", box(0.14, 0.2, 4.52, CX + sx * 2.75, y, CZ));
  }
  for (const sx of [-1, 1]) {
    bag.add(
      "steel",
      cylBetween(
        CX + sx * 2.75,
        TOP + 0.3,
        CZ - 2.15,
        CX + sx * 2.75,
        FT - 1.6,
        CZ + 2.15,
        0.045,
        6,
      ),
    );
    bag.add(
      "steel",
      cylBetween(
        CX + sx * 2.75,
        FT - 1.6,
        CZ - 2.15,
        CX + sx * 2.75,
        TOP + 0.3,
        CZ + 2.15,
        0.045,
        6,
      ),
    );
    // The braced side faces of the frame block; the open front/rear ends only
    // close further in, at the screen drum.
    addBoxCollider(CX + sx * 2.75, CZ, 0.16, 2.31, 0, COLLIDER_FLOOR, FT);
  }

  // --- Hopper (octagonal) with rim bead, ribs and rivets. Like the walkway,
  // the beacon and the upper rails it sits far above head height and inside the
  // frame footprint, so it needs no collider of its own.
  const hy0 = SD.hopperY0;
  const hy1 = SD.hopperY1;
  const hop = new THREE.CylinderGeometry(1.92, 0.58, hy1 - hy0, 8, 1, true);
  bag.add("chrome", hop.translate(CX, (hy0 + hy1) / 2, CZ));
  const rim = new THREE.CylinderGeometry(2.0, 1.92, 0.16, 8);
  bag.add("steel", rim.translate(CX, hy1 + 0.05, CZ));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    bag.add(
      "steel",
      cylBetween(
        CX + ca * 1.78,
        hy1 - 0.05,
        CZ + sa * 1.78,
        CX + ca * 0.56,
        hy0 + 0.1,
        CZ + sa * 0.56,
        0.035,
        5,
      ),
    );
    for (let k = 0; k < 3; k++) {
      const t = 0.2 + k * 0.3;
      const rr = 1.85 - t * 1.3;
      bag.add(
        "chrome",
        rivet(
          CX + ca * rr,
          hy1 - t * (hy1 - hy0),
          CZ + sa * rr,
          ca,
          0.4,
          sa,
          0.045,
        ),
      );
    }
  }
  stripe(bag, atlas, 1.4, 0.2, CX, hy1 + 0.05, CZ + 1.94);
  // Dark interior (blocks the view from above) and coarse grating over it
  const inner = new THREE.CircleGeometry(1.86, 8);
  inner.rotateX(-Math.PI / 2);
  bag.add("dark", inner.translate(CX, hy1 - 0.1, CZ));
  for (let i = 0; i < 5; i++) {
    const gx0 = CX - 1.4 + i * 0.7;
    bag.add("steel", box(0.07, 0.11, 3.4, gx0, hy1 + 0.14, CZ));
  }
  bag.add("steel", box(3.6, 0.11, 0.09, CX, hy1 + 0.14, CZ));
  // Outlet chute down to the drum
  bag.add(
    "chrome",
    new THREE.CylinderGeometry(0.5, 0.5, 0.62, 10).translate(
      CX,
      hy0 - 0.28,
      CZ,
    ),
  );
  bag.add(
    "steel",
    new THREE.CylinderGeometry(0.56, 0.56, 0.1, 10).translate(
      CX,
      hy0 - 0.55,
      CZ,
    ),
  );

  // --- Rotary screen drum (its own mesh, axis x)
  const dR = SD.drumR;
  const dL = SD.drumL;
  const drumParts: THREE.BufferGeometry[] = [];
  const shell = new THREE.CylinderGeometry(dR, dR, dL, 18, 1, true);
  shell.rotateZ(Math.PI / 2);
  drumParts.push(shell);
  for (const s of [-1, 1]) {
    const cap = new THREE.CylinderGeometry(dR, dR * 0.86, 0.18, 18);
    cap.rotateZ(Math.PI / 2);
    drumParts.push(cap.translate(s * (dL / 2 + 0.08), 0, 0));
  }
  for (const bx of [-1.45, 0, 1.45]) {
    const band = new THREE.CylinderGeometry(dR + 0.07, dR + 0.07, 0.24, 18);
    band.rotateZ(Math.PI / 2);
    drumParts.push(band.translate(bx, 0, 0));
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      drumParts.push(
        rivet(
          bx + 0.09,
          Math.cos(a) * (dR + 0.075),
          Math.sin(a) * (dR + 0.075),
          0,
          Math.cos(a),
          Math.sin(a),
          0.045,
        ),
      );
    }
  }
  // Longitudinal ribs acting as lifters
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const g = box(dL - 0.3, 0.1, 0.16);
    g.translate(0, dR + 0.02, 0);
    g.rotateX(a);
    drumParts.push(g);
  }
  const drum = applyMatUv("steel", mergeAll(drumParts));

  // Drum bearings, support rollers and drive chain
  for (const bx of [-1.45, 1.45])
    for (const sz of [-1, 1]) {
      const roller = new THREE.CylinderGeometry(0.19, 0.19, 0.26, 10);
      roller.rotateZ(Math.PI / 2);
      bag.add(
        "chrome",
        roller.translate(CX + bx, SD.drumY - dR - 0.12, CZ + sz * 0.72),
      );
      bag.add(
        "steel",
        box(0.3, 0.5, 0.22, CX + bx, SD.drumY - dR - 0.42, CZ + sz * 0.72),
      );
    }
  bag.add("steel", box(5.6, 0.16, 0.16, CX, SD.drumY - dR - 0.62, CZ - 0.72));
  bag.add("steel", box(5.6, 0.16, 0.16, CX, SD.drumY - dR - 0.62, CZ + 0.72));
  // Drum plus its support beams: the solid core of the plant
  addBoxCollider(
    CX,
    CZ,
    dL / 2 + 0.1,
    dR + 0.1,
    0,
    COLLIDER_FLOOR,
    SD.drumY + dR + 0.2,
  );

  // --- Gearbox, motor, chain case (right-hand side)
  const mx = CX + dL / 2 + 0.55;
  bag.add(
    "paint",
    roundedBox(0.72, 0.86, 0.78, 0.06, 0.03, mx, SD.drumY + 0.05, CZ),
    { color: machine },
  );
  bag.add("paint", box(0.16, 1.05, 0.9, mx + 0.42, SD.drumY, CZ), {
    color: machine,
  });
  const motor = new THREE.CylinderGeometry(0.27, 0.27, 0.74, 14);
  motor.rotateZ(Math.PI / 2);
  bag.add("paint", motor.translate(mx + 0.86, SD.drumY, CZ), {
    color: machine,
  });
  for (let i = 0; i < 7; i++) {
    const fin = new THREE.CylinderGeometry(0.3, 0.3, 0.03, 14);
    fin.rotateZ(Math.PI / 2);
    bag.add("paint", fin.translate(mx + 0.58 + i * 0.09, SD.drumY, CZ), {
      color: machine,
    });
  }
  const cowl = new THREE.CylinderGeometry(0.24, 0.3, 0.22, 14);
  cowl.rotateZ(Math.PI / 2);
  bag.add("steel", cowl.translate(mx + 1.32, SD.drumY, CZ));
  bag.add("steel", box(0.22, 0.2, 0.26, mx + 0.86, SD.drumY + 0.34, CZ));
  // Chain guard between gearbox and drum
  bag.add("paint", box(0.9, 1.0, 0.1, CX + dL / 2 - 0.1, SD.drumY, CZ + 0.48), {
    color: yellow,
  });
  stripe(bag, atlas, 0.9, 0.14, CX + dL / 2 - 0.1, SD.drumY - 0.42, CZ + 0.54);
  bag.add(
    "decal",
    place(decalQuad(atlas.plate, 0.42, 0.19), mx, SD.drumY + 0.05, CZ + 0.4),
    { keepUv: true },
  );
  // Gearbox/motor overhang next to the frame – blocks at head height only
  addBoxCollider(
    mx + 0.37,
    CZ + 0.1,
    1.03,
    0.55,
    0,
    SD.drumY - 0.45,
    SD.drumY + 0.5,
  );

  // Hydraulic lines from the power pack to the gearbox
  bag.add(
    "steel",
    roundedBox(0.9, 0.62, 0.6, 0.05, 0.03, CX + 2.5, TOP + 0.53, CZ + 1.5),
  );
  addBoxCollider(CX + 2.5, CZ + 1.5, 0.5, 0.35, 0, COLLIDER_FLOOR, TOP + 0.9);
  for (const [dz, r] of [
    [0.12, 0.035],
    [-0.12, 0.03],
  ] as const)
    bag.add(
      "chrome",
      tubePath(
        [
          [CX + 2.5, TOP + 0.8, CZ + 1.5 + dz],
          [CX + 2.9, TOP + 1.6, CZ + 1.2 + dz],
          [mx - 0.5, SD.drumY - 0.1, CZ + 0.6 + dz],
          [mx - 0.35, SD.drumY + 0.05, CZ + 0.35 + dz],
        ],
        r,
        0.3,
        6,
      ),
    );

  // --- Discharge chute and bunker
  bag.add(
    "chrome",
    place(
      box(1.0, 1.3, 0.9),
      CX - dL / 2 - 0.55,
      SD.drumY - 0.5,
      CZ + 0.5,
      0.3,
      0,
      0.35,
    ),
  );
  bag.add(
    "rust",
    taperBox(1.9, 1.6, 1.25, 0.72, CX - 3.1, TOP + 0.65, CZ + 1.5),
  );
  bag.add("steel", box(2.0, 0.1, 1.7, CX - 3.1, TOP + 1.3, CZ + 1.5));
  addBoxCollider(CX - 3.1, CZ + 1.5, 1.02, 0.87, 0, COLLIDER_FLOOR, TOP + 1.4);

  // --- Walkway with railing and ladder
  const wy = FT + 0.14;
  for (let i = 0; i < 14; i++)
    bag.add("steel", box(0.09, 0.05, 1.0, CX - 2.6 + i * 0.42, wy, CZ + 1.6));
  bag.add("steel", box(5.9, 0.08, 0.08, CX, wy - 0.06, CZ + 1.12));
  bag.add("steel", box(5.9, 0.08, 0.08, CX, wy - 0.06, CZ + 2.08));
  for (let i = 0; i < 5; i++) {
    const px = CX - 2.6 + i * 1.3;
    bag.add("paint", box(0.07, 1.05, 0.07, px, wy + 0.53, CZ + 2.06), {
      color: yellow,
    });
  }
  for (const ry of [1.02, 0.55]) {
    bag.add("paint", box(5.9, 0.06, 0.06, CX, wy + ry, CZ + 2.06), {
      color: yellow,
    });
  }
  bag.add("steel", box(5.9, 0.13, 0.05, CX, wy + 0.07, CZ + 2.08));
  // Ladder with a back guard
  const lx = CX - 2.75;
  for (const s of [-1, 1])
    bag.add(
      "steel",
      cylBetween(
        lx + s * 0.24,
        TOP,
        CZ + 1.9,
        lx + s * 0.24,
        wy + 0.9,
        CZ + 2.05,
        0.04,
        6,
      ),
    );
  for (let i = 0; i < 9; i++) {
    const t = i / 9;
    const ry2 = TOP + 0.3 + i * 0.38;
    const rz = CZ + 1.9 + t * 0.15;
    const rung = new THREE.CylinderGeometry(0.026, 0.026, 0.48, 6);
    rung.rotateZ(Math.PI / 2);
    bag.add("chrome", rung.translate(lx, ry2, rz));
  }
  for (let i = 0; i < 4; i++) {
    const hoop = new THREE.TorusGeometry(0.36, 0.022, 5, 10, Math.PI);
    hoop.rotateY(Math.PI / 2);
    bag.add("steel", hoop.translate(lx, TOP + 1.6 + i * 0.55, CZ + 2.0));
  }
  // Caged ladder (no climbing mechanic – it is a blocker, and the walkway
  // above it is out of reach anyway)
  addBoxCollider(lx, CZ + 1.98, 0.41, 0.44, 0, COLLIDER_FLOOR, wy + 0.9);

  // --- Control cabinet, warning light, fill-level gauge
  const cx = CX - 2.3;
  const cz = CZ + 2.3;
  bag.add("steel", roundedBox(1.04, 1.36, 0.34, 0.04, 0.02, cx, TOP + 1.5, cz));
  bag.add("steel", box(1.16, 0.07, 0.44, cx, TOP + 2.22, cz + 0.02));
  bag.add("steel", box(1.1, 0.14, 0.3, cx, TOP + 0.86, cz));
  bag.add(
    "decal",
    place(decalQuad(atlas.panel, 0.9, 0.39), cx, TOP + 1.62, cz + 0.175),
    { keepUv: true },
  );
  bag.add("chrome", box(0.05, 0.3, 0.05, cx + 0.44, TOP + 1.3, cz + 0.2));
  bag.add("lamp", box(0.06, 0.06, 0.04, cx - 0.36, TOP + 1.22, cz + 0.19), {
    color: [0.2, 1, 0.45, LAMP_CH.panel],
  });
  bag.add("lamp", box(0.06, 0.06, 0.04, cx - 0.24, TOP + 1.22, cz + 0.19), {
    color: [1, 0.6, 0.1, LAMP_CH.panel],
  });
  addBoxCollider(cx, cz, 0.63, 0.27, 0, COLLIDER_FLOOR, TOP + 2.3);

  // Beacon light on a bracket above the frame
  const by = FT + 0.35;
  bag.add("steel", box(0.1, 0.75, 0.1, CX + 1.2, by, CZ + 2.1));
  bag.add("steel", box(0.34, 0.08, 0.34, CX + 1.2, by + 0.4, CZ + 2.1));
  bag.add(
    "steel",
    new THREE.CylinderGeometry(0.15, 0.17, 0.12, 12).translate(
      CX + 1.2,
      by + 0.5,
      CZ + 2.1,
    ),
  );
  const dome = new THREE.SphereGeometry(
    0.15,
    12,
    8,
    0,
    Math.PI * 2,
    0,
    Math.PI / 2,
  );
  dome.scale(1, 1.15, 1);
  bag.add("lamp", dome.translate(CX + 1.2, by + 0.56, CZ + 2.1), {
    color: [1, 0.52, 0.06, LAMP_CH.beacon],
  });
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    bag.add(
      "chrome",
      box(
        0.02,
        0.24,
        0.02,
        CX + 1.2 + Math.cos(a) * 0.15,
        by + 0.62,
        CZ + 2.1 + Math.sin(a) * 0.15,
      ),
    );
  }
  bag.add(
    "chrome",
    new THREE.CylinderGeometry(0.17, 0.14, 0.04, 12).translate(
      CX + 1.2,
      by + 0.76,
      CZ + 2.1,
    ),
  );

  // Fill-level gauge: cabinet, scale, moving bar inside the slot
  const gx = CX + 2.1;
  const gz = CZ + 2.28;
  bag.add("steel", roundedBox(0.66, 1.5, 0.26, 0.03, 0.02, gx, TOP + 1.55, gz));
  bag.add("dark", box(0.2, 0.94, 0.07, gx - 0.15, TOP + 1.5, gz + 0.12));
  bag.add(
    "decal",
    place(decalQuad(atlas.gauge, 0.24, 0.36), gx + 0.14, TOP + 1.5, gz + 0.152),
    {
      keepUv: true,
    },
  );
  bag.add("steel", box(0.74, 0.1, 0.34, gx, TOP + 2.34, gz));
  bag.add("steel", box(0.7, 0.12, 0.3, gx, TOP + 0.82, gz));
  addBoxCollider(gx, gz, 0.42, 0.22, 0, COLLIDER_FLOOR, TOP + 2.45);
  const gaugeBar = applyMatUv("steel", box(0.15, 1.0, 0.05, 0, 0.5, 0));

  return {
    drum,
    drumAt: new THREE.Vector3(CX, SD.drumY, CZ),
    belt: buildConveyor(bag, atlas),
    gaugeBar,
    gaugeAt: new THREE.Vector3(gx - 0.15, TOP + 1.05, gz + 0.135),
  };
}

// ---------------------------------------------------------------------------
// Steep conveyor
// ---------------------------------------------------------------------------

const TAIL = new THREE.Vector3(0.6, 0.72, 4.4);
const HEAD = new THREE.Vector3(7.4, 5.0, -2.2);

/** Called at the end of buildPlant, so it adds to the "station-plant" set. */
function buildConveyor(
  bag: StationBag,
  atlas: StationAtlas,
): THREE.BufferGeometry {
  const ex = HEAD.clone().sub(TAIL);
  const L = ex.length();
  ex.normalize();
  const ez = ex.clone().cross(UP).normalize();
  const ey = ez.clone().cross(ex);
  const mat = new THREE.Matrix4().makeBasis(ex, ey, ez).setPosition(TAIL);
  const yellow = tint("paint", "#d8a521");
  const add = (key: StMat, g: THREE.BufferGeometry, opts: AddOpts = {}) =>
    bag.add(key, g.applyMatrix4(mat), opts);

  // Frame, cross members, skirts
  for (const s of [-1, 1]) {
    add("steel", box(L, 0.26, 0.09, L / 2, 0, s * 0.58));
    add("steel", box(L * 0.72, 0.24, 0.03, L * 0.42, 0.28, s * 0.5));
  }
  const cross = Math.floor(L / 0.95);
  for (let i = 1; i < cross; i++)
    add("steel", box(0.07, 0.07, 1.2, i * 0.95, -0.11, 0));
  // Idlers and pulleys
  for (let i = 0; i < Math.floor(L / 0.8); i++) {
    const r = new THREE.CylinderGeometry(0.075, 0.075, 1.02, 8);
    r.rotateX(Math.PI / 2);
    add("chrome", r.translate(0.45 + i * 0.8, 0.04, 0));
  }
  for (const px of [0.24, L - 0.24]) {
    const p = new THREE.CylinderGeometry(0.2, 0.2, 1.1, 14);
    p.rotateX(Math.PI / 2);
    add("chrome", p.translate(px, -0.06, 0));
    for (const s of [-1, 1])
      add("steel", box(0.3, 0.34, 0.1, px, -0.06, s * 0.63));
  }
  // Railing along the operator side
  for (let i = 0; i <= Math.floor(L / 2.2); i++)
    add("paint", box(0.06, 0.95, 0.06, 0.6 + i * 2.2, 0.6, 0.68), {
      color: yellow,
    });
  for (const ry of [1.0, 0.55])
    add("paint", box(L - 0.9, 0.05, 0.05, L / 2, ry, 0.68), { color: yellow });
  // Head cover and drive
  add("steel", box(1.0, 0.62, 1.3, L - 0.3, 0.34, 0));
  add("paint", roundedBox(0.5, 0.5, 0.44, 0.05, 0.02, L - 0.5, -0.1, 0.85), {
    color: tint("paint", "#3c6e8f"),
  });
  add("steel", box(0.22, 0.22, 0.3, L - 0.5, -0.1, 1.12));
  // Discharge chute into the hopper
  add("chrome", box(0.9, 0.7, 1.1, L + 0.32, -0.16, 0));

  // Belt surface: its own geometry with u along the belt
  const beltLen = L - 0.5;
  const belt = new THREE.PlaneGeometry(beltLen, 1.0);
  belt.rotateX(-Math.PI / 2);
  belt.translate(L / 2, 0.145, 0);
  const uv = belt.getAttribute("uv") as THREE.BufferAttribute;
  const reps = beltLen / 1.15;
  for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * reps);
  uv.needsUpdate = true;
  belt.applyMatrix4(mat);
  // Cleats – without them nothing would travel up a 25° incline
  const cleats = Math.floor(beltLen / 0.62);
  for (let i = 0; i < cleats; i++)
    add("rubber", box(0.05, 0.1, 0.94, 0.5 + i * 0.62, 0.2, 0));
  // Return run (static, dark)
  add("rubber", box(beltLen, 0.04, 1.0, L / 2, -0.2, 0));

  // Supports down to the yard
  for (const t of [0.34, 0.7]) {
    const p = new THREE.Vector3()
      .copy(ex)
      .multiplyScalar(t * L)
      .add(TAIL);
    for (const s of [-1, 1]) {
      const fx = p.x + ez.x * s * 0.58;
      const fz = p.z + ez.z * s * 0.58;
      bag.add(
        "steel",
        box(
          0.16,
          p.y - SD.apronTop - 0.2,
          0.16,
          fx,
          (p.y - 0.2 + SD.apronTop) / 2,
          fz,
        ),
      );
      bag.add("steel", box(0.44, 0.06, 0.44, fx, SD.apronTop + 0.03, fz));
    }
    bag.add(
      "steel",
      cylBetween(
        p.x - ez.x * 0.58,
        SD.apronTop + 0.15,
        p.z - ez.z * 0.58,
        p.x + ez.x * 0.58,
        p.y - 0.4,
        p.z + ez.z * 0.58,
        0.04,
        6,
      ),
    );
    stripe(
      bag,
      atlas,
      0.58,
      0.19,
      p.x + ez.x * 0.58,
      SD.apronTop + 0.64,
      p.z + ez.z * 0.58 + 0.09,
      0,
      true,
    );
    // The rear pair of legs stands free on the yard (the front pair is inside
    // the collider of the low conveyor end below)
    if (t > 0.5)
      for (const s of [-1, 1])
        addCylinderCollider(
          p.x + ez.x * s * 0.58,
          p.z + ez.z * s * 0.58,
          0.14,
          COLLIDER_FLOOR,
          p.y - 0.2,
        );
  }

  // Collider for the low end of the belt: from the tail up to where the frame
  // clears head height (~2.5 m). Further up you walk underneath it.
  const cut = 0.45;
  const hLen = Math.hypot(HEAD.x - TAIL.x, HEAD.z - TAIL.z);
  addBoxCollider(
    TAIL.x + (HEAD.x - TAIL.x) * cut * 0.5,
    TAIL.z + (HEAD.z - TAIL.z) * cut * 0.5,
    (hLen * cut) / 2,
    0.73,
    Math.atan2(TAIL.z - HEAD.z, HEAD.x - TAIL.x),
    COLLIDER_FLOOR,
    TAIL.y + (HEAD.y - TAIL.y) * cut + 1.1,
  );
  return belt;
}

// ---------------------------------------------------------------------------
// Recyclables containers
// ---------------------------------------------------------------------------

const BIN_COLORS = ["#2f9e44", "#e8b81c", "#77838d", "#1e6fbf"];

export function buildContainers(bag: StationBag, atlas: StationAtlas): void {
  const TOP = SD.apronTop;
  const W = SD.binW;
  const D = SD.binD;
  const H = 1.62;
  const wheelR = 0.15;
  const y0 = TOP + wheelR * 2 + 0.05;
  beginColliderSet("station-bins", stationColliderFrame());

  for (let i = 0; i < 4; i++) {
    const bx = SD.binX0 + i * SD.binDx;
    const bz = SD.binZ + (i % 2) * 0.12;
    const col = tint("plastic", BIN_COLORS[i]);
    const dark = tint("plastic", "#26292d");
    const yaw = (i - 1.5) * 0.05;
    const T = (g: THREE.BufferGeometry) => place(g, bx, 0, bz, 0, yaw);
    // Body incl. edge bead, comb lip and sign
    addBoxCollider(
      bx,
      bz,
      W / 2 + 0.05,
      D / 2 + 0.09,
      yaw,
      COLLIDER_FLOOR,
      y0 + H + 0.14,
    );

    // Body (tapered downwards) with an edge bead and swages
    bag.add("plastic", T(taperBox(W, D, H, 0.82, 0, y0 + H / 2, 0)), {
      color: col,
    });
    bag.add("plastic", T(box(W + 0.06, 0.1, D + 0.06, 0, y0 + H - 0.02, 0)), {
      color: col,
    });
    for (let k = 0; k < 3; k++)
      bag.add(
        "plastic",
        T(box(W * 0.92, 0.05, D * 0.93, 0, y0 + 0.4 + k * 0.36, 0)),
        { color: col },
      );
    // Lid: two halves, hinged at the outer edge, one of them standing open
    for (const s of [-1, 1]) {
      const open = s < 0 && i % 2 === 0 ? 0.55 : 0.035;
      const half = W / 2 - 0.04;
      const lid = box(half, 0.075, D + 0.06, (-s * half) / 2, 0, 0);
      const grip = new THREE.CylinderGeometry(0.035, 0.035, D * 0.5, 8);
      grip.rotateX(Math.PI / 2);
      grip.translate(-s * (half - 0.12), 0.07, 0);
      for (const g of [lid, grip]) {
        place(g, s * (W / 2 - 0.02), y0 + H + 0.07, 0, 0, 0, -s * open);
        bag.add("plastic", T(g), { color: dark });
      }
    }
    for (const s of [-1, 1])
      for (const hz of [-D * 0.32, D * 0.32]) {
        const h = new THREE.CylinderGeometry(0.05, 0.05, 0.22, 8);
        h.rotateX(Math.PI / 2);
        bag.add("steel", T(h.translate(s * (W / 2 - 0.02), y0 + H + 0.07, hz)));
      }
    // Comb lip for the lifter and the grab rail at the front
    bag.add(
      "steel",
      T(box(W * 0.8, 0.1, 0.12, 0, y0 + H - 0.34, D / 2 + 0.06)),
    );
    for (const s of [-1, 1])
      bag.add(
        "steel",
        T(box(0.1, 0.34, 0.14, s * W * 0.32, y0 + H - 0.5, D / 2 + 0.06)),
      );
    // Wheels with forks
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        const wx = sx * (W * 0.36);
        const wz = sz * (D * 0.3);
        bag.add("steel", T(box(0.14, 0.1, 0.14, wx, y0 - 0.02, wz)));
        bag.add("steel", T(box(0.04, 0.16, 0.2, wx - 0.07, y0 - 0.12, wz)));
        bag.add("steel", T(box(0.04, 0.16, 0.2, wx + 0.07, y0 - 0.12, wz)));
        const w = new THREE.CylinderGeometry(wheelR, wheelR, 0.08, 10);
        w.rotateZ(Math.PI / 2);
        bag.add("rubber", T(w.translate(wx, TOP + wheelR, wz)));
      }
    // Drain plug and sign
    bag.add(
      "dark",
      T(
        new THREE.CylinderGeometry(0.06, 0.06, 0.06, 8)
          .rotateX(Math.PI / 2)
          .translate(0, y0 + 0.2, D / 2 + 0.02),
      ),
    );
    bag.add("steel", T(box(1.72, 0.86, 0.05, 0, y0 + H * 0.6, D / 2 + 0.02)));
    bag.add(
      "decal",
      T(
        place(
          decalQuad(atlas.bins[i], 1.6, 0.77),
          0,
          y0 + H * 0.6,
          D / 2 + 0.055,
        ),
      ),
      {
        keepUv: true,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Floodlight masts
// ---------------------------------------------------------------------------

const MASTS: Array<[number, number, number]> = [
  [-12.9, 8.8, -0.5],
  [12.9, 8.8, 0.5],
  [12.9, -8.9, 2.2],
];

export function buildMasts(bag: StationBag): THREE.BufferGeometry {
  const TOP = SD.apronTop;
  const H = 7.2;
  const pools: THREE.BufferGeometry[] = [];
  beginColliderSet("station-masts", stationColliderFrame());
  for (const [mx, mz, aim] of MASTS) {
    bag.add("concrete", box(0.9, 0.3, 0.9, mx, TOP + 0.14, mz));
    // Concrete base (low and wide) plus the mast itself
    addCylinderCollider(mx, mz, 0.5, COLLIDER_FLOOR, TOP + 0.35);
    addCylinderCollider(mx, mz, 0.22, COLLIDER_FLOOR, TOP + 0.3 + H);
    bag.add("steel", box(0.58, 0.06, 0.58, mx, TOP + 0.31, mz));
    for (const sx of [-1, 1])
      for (const sz of [-1, 1])
        bag.add(
          "chrome",
          rivet(mx + sx * 0.2, TOP + 0.34, mz + sz * 0.2, 0, 1, 0, 0.05),
        );
    bag.add(
      "steel",
      new THREE.CylinderGeometry(0.09, 0.15, H, 10).translate(
        mx,
        TOP + 0.3 + H / 2,
        mz,
      ),
    );
    bag.add(
      "steel",
      roundedBox(0.24, 0.4, 0.2, 0.03, 0.02, mx + 0.16, TOP + 1.5, mz),
    );
    // Cross arm and two floodlights
    const ty = TOP + 0.3 + H;
    bag.add("steel", box(1.5, 0.1, 0.1, mx, ty, mz));
    for (const s of [-1, 1]) {
      const fx = mx + s * 0.55;
      bag.add("steel", box(0.09, 0.24, 0.09, fx, ty - 0.14, mz));
      const head = roundedBox(0.62, 0.34, 0.42, 0.05, 0.03, 0, 0, 0);
      bag.add("paint", place(head, fx, ty - 0.36, mz, 0.5, aim), {
        color: tint("paint", "#3a4046"),
      });
      const hood = box(0.7, 0.06, 0.3, 0, 0.18, 0.1);
      bag.add("paint", place(hood, fx, ty - 0.36, mz, 0.5, aim), {
        color: tint("paint", "#2c3136"),
      });
      const lens = box(0.5, 0.04, 0.3, 0, -0.16, 0.02);
      bag.add("lamp", place(lens, fx, ty - 0.36, mz, 0.5, aim), {
        color: [1, 0.94, 0.75, LAMP_CH.flood],
      });
    }
    const pool = new THREE.PlaneGeometry(11, 11);
    pool.rotateX(-Math.PI / 2);
    pools.push(
      pool.translate(
        mx - Math.sin(aim) * 3.4,
        TOP + 0.02,
        mz - Math.cos(aim) * 3.4,
      ),
    );
  }
  return mergeAll(pools);
}
