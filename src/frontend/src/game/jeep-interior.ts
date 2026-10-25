// Trash Simulator – interior of the jeep: dashboard with instruments,
// steering wheel (turns with the steering), seats, pedals, levers, door trim,
// rear-view mirror, air freshener. Static parts go into the shared PartBag,
// moving parts get their own meshes using the same materials.

import * as THREE from "three";
import {
  type DecalAtlas,
  type JeepMat,
  LAMP_CH,
  PartBag,
  convexGlass,
  cylBetween,
  decalQuad,
  place,
  roundedBox,
  tubePath,
} from "./jeep-build";

export interface InteriorRig {
  /** Steering wheel group (tilt); `swSpin` rotates about the steering axis. */
  sw: THREE.Group;
  swSpin: THREE.Group;
  /** Speedometer needle (rotation.z). */
  needle: THREE.Group;
  /** Air freshener suspension (swings). */
  fresh: THREE.Group;
  meshes: THREE.Mesh[];
}

const DASH_GLOW = [0.75, 1, 0.85, LAMP_CH.dash] as const;
const NEEDLE_COL = [0.95, 0.12, 0.06, LAMP_CH.fixed] as const;

/** Instrument cluster: the housing is tilted up by `tilt`, dial face at z = +0.061. */
const BIN = { x: -0.42, y: 1.0, z: -0.64, tilt: -0.26 } as const;
const SPEEDO = { x: -0.09, y: 0.0, r: 0.06 } as const;

export function buildInterior(
  bag: PartBag,
  atlas: DecalAtlas,
  mats: Record<JeepMat, THREE.Material>,
): InteriorRig {
  const box = (w: number, h: number, d: number) =>
    new THREE.BoxGeometry(w, h, d);
  const meshes: THREE.Mesh[] = [];

  // ---- Dashboard ----
  bag.add("trim", roundedBox(1.62, 0.28, 0.34, 0.04, 0.02, 0, 0.82, -0.71));
  const pad = new THREE.CylinderGeometry(0.035, 0.035, 1.6, 12);
  pad.rotateZ(Math.PI / 2);
  bag.add("trim", place(pad, 0, 0.95, -0.555));
  // Instrument binnacle (tilted)
  const binn = roundedBox(0.42, 0.14, 0.12, 0.04, 0.015, 0, 0, 0);
  bag.add("trim", place(binn, BIN.x, BIN.y, BIN.z, BIN.tilt));
  const inBin = (g: THREE.BufferGeometry, lx: number, ly: number, lz: number) =>
    place(place(g, lx, ly, lz), BIN.x, BIN.y, BIN.z, BIN.tilt);
  bag.add(
    "dial",
    inBin(
      decalQuad(atlas.speedo, SPEEDO.r * 2, SPEEDO.r * 2),
      SPEEDO.x,
      SPEEDO.y,
      0.061,
    ),
  );
  bag.add("dial", inBin(decalQuad(atlas.fuel, 0.05, 0.05), 0.1, 0.028, 0.061));
  bag.add("dial", inBin(decalQuad(atlas.temp, 0.05, 0.05), 0.1, -0.03, 0.061));
  bag.add(
    "chrome",
    inBin(
      new THREE.TorusGeometry(0.064, 0.004, 6, 32),
      SPEEDO.x,
      SPEEDO.y,
      0.06,
    ),
  );
  bag.add(
    "chrome",
    inBin(new THREE.TorusGeometry(0.027, 0.003, 6, 20), 0.1, 0.028, 0.06),
  );
  bag.add(
    "chrome",
    inBin(new THREE.TorusGeometry(0.027, 0.003, 6, 20), 0.1, -0.03, 0.06),
  );
  // Instrument lighting (rings behind the bezels, greenish at night)
  bag.add(
    "lamp",
    inBin(
      new THREE.RingGeometry(0.058, 0.0605, 32),
      SPEEDO.x,
      SPEEDO.y,
      0.0605,
    ),
    { color: DASH_GLOW },
  );
  bag.add(
    "lamp",
    inBin(new THREE.RingGeometry(0.024, 0.0265, 20), 0.1, 0.028, 0.0605),
    { color: DASH_GLOW },
  );
  bag.add(
    "lamp",
    inBin(new THREE.RingGeometry(0.024, 0.0265, 20), 0.1, -0.03, 0.0605),
    { color: DASH_GLOW },
  );
  // Center console: radio, rotary knobs, toggle switches, vents, sticker
  bag.add("dial", place(decalQuad(atlas.radio, 0.2, 0.065), 0, 0.83, -0.535));
  for (const x of [-0.13, 0.13]) {
    const k = new THREE.CylinderGeometry(0.012, 0.012, 0.016, 12);
    k.rotateX(Math.PI / 2);
    bag.add("trim", place(k, x, 0.75, -0.532));
  }
  for (let i = 0; i < 4; i++) {
    bag.add(
      "chrome",
      cylBetween(
        -0.06 + i * 0.04,
        0.75,
        -0.54,
        -0.06 + i * 0.04,
        0.762,
        -0.522,
        0.004,
        6,
      ),
    );
    bag.add(
      "lamp",
      place(box(0.008, 0.008, 0.004), -0.06 + i * 0.04, 0.735, -0.538),
      {
        color: DASH_GLOW,
      },
    );
  }
  for (const x of [-0.25, 0.25]) {
    bag.add("trim", place(box(0.1, 0.045, 0.012), x, 0.9, -0.545));
    for (let k = 0; k < 4; k++)
      bag.add(
        "steel",
        place(box(0.09, 0.003, 0.01), x, 0.884 + k * 0.011, -0.54),
      );
  }
  bag.add(
    "decal",
    place(decalQuad(atlas.sticker, 0.24, 0.065), 0.45, 0.82, -0.535),
  );
  // Passenger grab handle
  bag.add(
    "steel",
    tubePath(
      [
        [0.3, 0.9, -0.56],
        [0.3, 0.955, -0.5],
        [0.55, 0.955, -0.5],
        [0.55, 0.9, -0.56],
      ],
      0.012,
      0.03,
      8,
    ),
  );
  // Steering column, shroud, stalks
  bag.add("trim", cylBetween(-0.42, 0.84, -0.68, -0.42, 1.0, -0.46, 0.03, 12));
  bag.add(
    "trim",
    cylBetween(-0.42, 0.93, -0.58, -0.42, 0.99, -0.475, 0.046, 12),
  );
  bag.add("trim", cylBetween(-0.42, 0.98, -0.5, -0.54, 0.98, -0.53, 0.007, 6));
  bag.add("trim", cylBetween(-0.42, 0.98, -0.5, -0.3, 0.98, -0.53, 0.007, 6));

  // ---- Steering wheel (its own mesh) ----
  const swBag = new PartBag();
  swBag.add("trim", new THREE.TorusGeometry(0.19, 0.022, 9, 36));
  for (const a of [0, Math.PI, -Math.PI / 2]) {
    const spoke = box(0.15, 0.026, 0.012);
    spoke.translate(0.105, 0, 0);
    spoke.rotateZ(a);
    swBag.add("trim", spoke);
  }
  swBag.add(
    "trim",
    new THREE.CylinderGeometry(0.05, 0.05, 0.035, 20).rotateX(Math.PI / 2),
  );
  // Horn button: dark, just a narrow chrome ring (previously glaring white)
  swBag.add(
    "trim",
    place(
      new THREE.CylinderGeometry(0.029, 0.029, 0.008, 20).rotateX(Math.PI / 2),
      0,
      0,
      0.02,
    ),
  );
  swBag.add(
    "chrome",
    place(new THREE.TorusGeometry(0.03, 0.0025, 6, 24), 0, 0, 0.021),
  );
  const swSpin = new THREE.Group();
  for (const m of swBag.build(mats).values()) {
    swSpin.add(m);
    meshes.push(m);
  }
  const sw = new THREE.Group();
  sw.position.set(-0.42, 1.02, -0.42);
  sw.rotation.x = -0.44;
  sw.add(swSpin);

  // ---- Speedometer needle (its own mesh) ----
  const needleBag = new PartBag();
  const nd = box(0.007, 0.052, 0.002);
  nd.translate(0, 0.024, 0);
  needleBag.add("lamp", nd, { color: NEEDLE_COL });
  const needle = new THREE.Group();
  for (const m of needleBag.build(mats).values()) {
    needle.add(m);
    meshes.push(m);
  }
  const needleMount = new THREE.Group();
  needleMount.position.set(BIN.x, BIN.y, BIN.z);
  needleMount.rotation.x = BIN.tilt;
  needle.position.set(SPEEDO.x, SPEEDO.y, 0.064);
  needleMount.add(needle);
  const needleHub = new THREE.CylinderGeometry(0.006, 0.006, 0.004, 10).rotateX(
    Math.PI / 2,
  );
  bag.add("chrome", inBin(needleHub, SPEEDO.x, SPEEDO.y, 0.064));

  // ---- Pedals, floor mats, center tunnel, levers ----
  for (const x of [-0.54, -0.44, -0.32]) {
    const p = box(0.06, 0.09, 0.008);
    bag.add("steel", place(p, x, 0.44, -0.74, -0.9));
    bag.add("steel", cylBetween(x, 0.47, -0.76, x, 0.52, -0.84, 0.006, 6));
  }
  bag.addMirrored("trim", place(box(0.62, 0.012, 0.8), 0.42, 0.326, -0.42));
  bag.add("trim", roundedBox(0.32, 0.17, 1.25, 0.05, 0.02, 0, 0.385, -0.3));
  bag.add("steel", cylBetween(0, 0.46, -0.18, 0, 0.76, -0.26, 0.011, 8));
  bag.add(
    "trim",
    place(new THREE.SphereGeometry(0.026, 12, 10), 0, 0.775, -0.265),
  );
  bag.add(
    "trim",
    place(new THREE.CylinderGeometry(0.02, 0.05, 0.06, 10), 0, 0.49, -0.18),
  );
  bag.add("steel", cylBetween(0.09, 0.46, -0.02, 0.09, 0.66, -0.06, 0.009, 8));
  bag.add(
    "trim",
    place(new THREE.SphereGeometry(0.02, 10, 8), 0.09, 0.67, -0.062),
  );
  bag.add("steel", cylBetween(0.13, 0.48, 0.12, 0.13, 0.62, -0.1, 0.012, 8));
  bag.add("trim", cylBetween(0.13, 0.58, -0.04, 0.13, 0.625, -0.11, 0.018, 8));

  // ---- Seats ----
  for (const x of [-0.42, 0.42]) {
    bag.add(
      "seat",
      roundedBox(0.5, 0.13, 0.5, 0.05, 0.03, x, 0.615, 0.05, 3, 6),
    );
    for (const s of [-1, 1]) {
      const b = new THREE.CylinderGeometry(0.045, 0.045, 0.46, 12);
      b.rotateX(Math.PI / 2);
      bag.add("seat", place(b, x + s * 0.225, 0.69, 0.05));
      bag.add(
        "seat",
        cylBetween(
          x + s * 0.215,
          0.7,
          0.32,
          x + s * 0.215,
          1.22,
          0.43,
          0.04,
          12,
        ),
      );
      bag.add(
        "steel",
        cylBetween(
          x + s * 0.06,
          1.25,
          0.42,
          x + s * 0.06,
          1.31,
          0.44,
          0.006,
          6,
        ),
      );
      bag.add(
        "steel",
        cylBetween(
          x + s * 0.2,
          0.32,
          -0.15,
          x + s * 0.2,
          0.55,
          -0.15,
          0.012,
          8,
        ),
      );
      bag.add(
        "steel",
        cylBetween(x + s * 0.2, 0.32, 0.25, x + s * 0.2, 0.55, 0.25, 0.012, 8),
      );
      bag.add("steel", place(box(0.03, 0.02, 0.5), x + s * 0.2, 0.33, 0.05));
    }
    const back = roundedBox(0.5, 0.62, 0.11, 0.05, 0.03, 0, 0.31, 0, 3, 6);
    bag.add("seat", place(back, x, 0.66, 0.3, 0.2));
    bag.add("seat", roundedBox(0.26, 0.13, 0.09, 0.04, 0.025, x, 1.355, 0.46));
    // Seat belt buckle
    bag.add("chrome", place(box(0.03, 0.06, 0.02), x + 0.27, 0.68, 0.18, 0.3));
  }

  // ---- Door trim ----
  for (const s of [-1, 1]) {
    bag.add("trim", place(box(0.015, 0.3, 1.0), s * 0.797, 0.735, -0.12));
    bag.add(
      "trim",
      roundedBox(0.07, 0.04, 0.32, 0.015, 0.01, s * 0.775, 0.86, -0.05),
    );
    bag.add("trim", place(box(0.02, 0.12, 0.5), s * 0.79, 0.64, -0.2));
    // Door release: dark base plate with a slim chrome lever (previously a
    // textureless white chrome block in the footwell)
    bag.add(
      "trim",
      roundedBox(0.018, 0.045, 0.075, 0.012, 0.006, s * 0.786, 0.8, -0.45),
    );
    bag.add(
      "steel",
      cylBetween(
        s * 0.775,
        0.802,
        -0.474,
        s * 0.775,
        0.795,
        -0.428,
        0.007,
        8,
        0.005,
      ),
    );
  }

  // ---- Rear-view mirror + air freshener ----
  bag.add("trim", cylBetween(0, 1.6, -0.545, 0, 1.52, -0.49, 0.008, 8));
  const mirBody = roundedBox(0.22, 0.065, 0.02, 0.02, 0.006, 0, 0, 0, 2);
  bag.add("trim", place(mirBody, 0, 1.49, -0.485, -0.1, 0.25));
  bag.add(
    "mirror",
    place(convexGlass(0.2, 0.05, 0.005), 0, 1.49, -0.485 + 0.0105, -0.1, 0.25),
  );
  const freshBag = new PartBag();
  const str = decalQuad(atlas.dark, 0.003, 0.12);
  str.translate(0, -0.06, 0);
  freshBag.add("decal", str);
  const tree = decalQuad(atlas.tree, 0.07, 0.075);
  tree.translate(0, -0.157, 0);
  freshBag.add("decal", tree);
  const fresh = new THREE.Group();
  fresh.position.set(0.0, 1.475, -0.47);
  for (const m of freshBag.build(mats).values()) {
    m.castShadow = false;
    fresh.add(m);
    meshes.push(m);
  }

  // Driver's eye (-0.42, 1.45, 0.05): all parts are > 0.3 m away (near plane 0.08).
  return { sw, swSpin, needle: needleMount, fresh, meshes };
}

/** Needle angle for a given speed (scale 0–80 km/h, −135° … +135°). */
export function needleAngle(speedMs: number): number {
  const t = Math.min(1, (Math.abs(speedMs) * 3.6) / 80);
  return ((135 - 270 * t) * Math.PI) / 180;
}
