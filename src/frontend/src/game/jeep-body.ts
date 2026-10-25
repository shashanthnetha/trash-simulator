// Trash Simulator – body of the beach patrol jeep (outer skin, frame,
// attachments, lamps, decals). All parts go into the PartBag and are merged
// into one mesh per material. Local coordinates: x right, y up (wheel center
// = 0, ground = -0.48), z rearwards (front = -z).

import * as THREE from "three";
import {
  type DecalAtlas,
  JD,
  LAMP_CH,
  type PartBag,
  coilSpring,
  convexGlass,
  cylBetween,
  decalQuad,
  extrudeFront,
  extrudeSide,
  place,
  rivet,
  roundedBox,
  roundedRectShape,
  tubePath,
} from "./jeep-build";

const HEAD_COL = [1, 0.96, 0.86, LAMP_CH.head] as const;
const LED_COL = [0.86, 0.93, 1, LAMP_CH.head] as const;
const TAIL_COL = [0.95, 0.06, 0.03, LAMP_CH.tail] as const;
const REV_COL = [0.96, 0.96, 0.9, LAMP_CH.reverse] as const;
const AMBER_COL = [1, 0.55, 0.05, LAMP_CH.fixed] as const;

/** Positions of the headlight lenses (for the glow sprites). */
export const HEADLIGHT_POS: readonly (readonly [number, number, number])[] = [
  [-0.46, 0.63, -1.985],
  [0.46, 0.63, -1.985],
];

export function buildBody(bag: PartBag, atlas: DecalAtlas): void {
  buildFrame(bag);
  buildTub(bag);
  buildHoodAndFront(bag);
  buildFenders(bag);
  buildBumpers(bag);
  buildWindshield(bag);
  buildCage(bag);
  buildRack(bag);
  buildAttachments(bag, atlas);
  buildRearLamps(bag);
  buildDecals(bag, atlas);
}

// ---------------------------------------------------------------------------
// Frame, axles, suspension, exhaust
// ---------------------------------------------------------------------------

function buildFrame(bag: PartBag): void {
  const box = (w: number, h: number, d: number) =>
    new THREE.BoxGeometry(w, h, d);
  // Side rails + cross members
  bag.addMirrored("steel", place(box(0.07, 0.12, 3.75), 0.5, 0.12, -0.05));
  for (const z of [-1.75, -0.95, -0.1, 0.6, 1.55])
    bag.add("steel", place(box(1.02, 0.06, 0.06), 0, 0.11, z));
  for (const z of [JD.axleF, JD.axleR]) {
    // Solid axle with differential, springs, dampers, brakes
    bag.add("steel", cylBetween(-0.66, 0, z, 0.66, 0, z, 0.045, 12));
    const diff = new THREE.SphereGeometry(0.13, 14, 10);
    diff.scale(1, 1, 0.82);
    bag.add("steel", place(diff, 0.16, 0, z));
    bag.addMirrored(
      "steel",
      place(coilSpring(0.07, 0.011, 5, 0.3), 0.62, 0.2, z),
    );
    bag.addMirrored(
      "steel",
      place(new THREE.CylinderGeometry(0.085, 0.085, 0.02, 14), 0.62, 0.05, z),
    );
    bag.addMirrored(
      "steel",
      place(new THREE.CylinderGeometry(0.085, 0.085, 0.02, 14), 0.62, 0.35, z),
    );
    bag.addMirrored(
      "steel",
      cylBetween(0.7, 0.03, z + 0.2, 0.65, 0.22, z + 0.13, 0.03, 10),
    );
    bag.addMirrored(
      "chrome",
      cylBetween(0.65, 0.22, z + 0.13, 0.6, 0.42, z + 0.06, 0.014, 8),
    );
    // Control arms
    bag.addMirrored(
      "steel",
      cylBetween(0.55, 0.05, z + 0.06, 0.5, 0.1, z + 0.6, 0.018, 8),
    );
    // Brake disc, caliper, hub (inside the wheel)
    const disc = new THREE.CylinderGeometry(0.15, 0.15, 0.02, 28);
    disc.rotateZ(Math.PI / 2);
    bag.addMirrored("chrome", place(disc, 0.69, 0, z));
    bag.addMirrored("steel", place(box(0.05, 0.1, 0.07), 0.69, 0.08, z + 0.08));
    bag.addMirrored("steel", cylBetween(0.66, 0, z, 0.74, 0, z, 0.06, 12));
  }
  // Prop shafts, gearbox, transfer case, oil pan, skid plate, fuel tank
  bag.add(
    "steel",
    cylBetween(0.16, 0.02, JD.axleF + 0.1, 0.1, 0.14, -0.45, 0.028, 10),
  );
  bag.add(
    "steel",
    cylBetween(0.16, 0.02, JD.axleR - 0.1, 0.1, 0.14, 0.05, 0.028, 10),
  );
  bag.add("steel", roundedBox(0.34, 0.26, 0.55, 0.04, 0.02, 0.06, 0.2, -0.3));
  bag.add("steel", roundedBox(0.44, 0.22, 0.5, 0.04, 0.02, 0, 0.16, -1.45));
  bag.add("steel", place(box(1.0, 0.02, 0.55), 0, 0.05, -1.65));
  bag.add("steel", roundedBox(0.9, 0.2, 0.42, 0.04, 0.02, 0, 0.17, 0.85));
  // Exhaust: manifold → center silencer → tailpipe with chrome tip
  bag.add(
    "steel",
    tubePath(
      [
        [0.3, 0.12, -1.15],
        [0.42, 0.06, -0.7],
        [0.55, 0.06, 0.4],
        [0.58, 0.08, 0.62],
      ],
      0.028,
      0.1,
      8,
    ),
  );
  const muffler = new THREE.CylinderGeometry(0.085, 0.085, 0.5, 16);
  muffler.rotateX(Math.PI / 2);
  bag.add("steel", place(muffler, 0.58, 0.08, 0.88));
  bag.add(
    "steel",
    tubePath(
      [
        [0.58, 0.08, 1.13],
        [0.6, 0.1, 1.6],
        [0.64, 0.1, 1.78],
        [0.68, 0.11, 1.85],
      ],
      0.028,
      0.08,
      8,
    ),
  );
  // Tailpipe tip: a short chrome pipe whose sooty inner pipe protrudes at the
  // front – that way the pipe reads as an opening and not as a bright stub. It
  // ends only a few centimeters behind the bumper.
  bag.add(
    "chrome",
    cylBetween(0.66, 0.105, 1.79, 0.72, 0.125, 1.95, 0.036, 14),
  );
  bag.add(
    "trim",
    cylBetween(0.67, 0.108, 1.81, 0.724, 0.127, 1.962, 0.029, 12),
  );
  // Side steps
  bag.addMirrored(
    "steel",
    cylBetween(0.95, 0.2, -0.62, 0.95, 0.2, 0.42, 0.024, 10),
  );
  bag.addMirrored("steel", place(box(0.16, 0.03, 0.04), 0.87, 0.2, -0.45));
  bag.addMirrored("steel", place(box(0.16, 0.03, 0.04), 0.87, 0.2, 0.25));
}

// ---------------------------------------------------------------------------
// Tub (floor, side walls with door cutout and wheel arch, rear, doors)
// ---------------------------------------------------------------------------

const ARCH_R = 0.58;

function tubSideShape(): THREE.Shape {
  const s = new THREE.Shape();
  const z0 = JD.cowlZ;
  const r = ARCH_R;
  const zc = JD.axleR;
  const yb = JD.floorY;
  const dz = Math.sqrt(r * r - yb * yb);
  const a0 = Math.atan2(yb, dz);
  s.moveTo(z0, yb);
  s.lineTo(z0, JD.tubTop);
  s.lineTo(JD.doorZ0, JD.tubTop);
  s.lineTo(JD.doorZ0, JD.sillY);
  s.lineTo(JD.doorZ1, JD.sillY);
  s.lineTo(JD.doorZ1, JD.tubTop);
  s.lineTo(JD.rearZ, JD.tubTop);
  s.lineTo(JD.rearZ, yb);
  s.lineTo(zc + dz, yb);
  s.absarc(zc, 0, r, a0, Math.PI - a0, false);
  s.lineTo(z0, yb);
  s.closePath();
  return s;
}

function buildTub(bag: PartBag): void {
  const box = (w: number, h: number, d: number) =>
    new THREE.BoxGeometry(w, h, d);
  // Floor
  bag.add("paint", place(box(1.64, 0.04, 2.63), 0, JD.floorY, 0.435));
  // Side walls
  bag.add("paint", extrudeSide(tubSideShape(), JD.tubHalfW, 0.05, 0.008));
  bag.add("paint", extrudeSide(tubSideShape(), -JD.tubHalfW, 0.05, 0.008));
  // Firewall/cowl, scuttle
  bag.add("paint", roundedBox(1.66, 0.69, 0.1, 0.02, 0.01, 0, 0.625, -0.9));
  bag.add("paint", roundedBox(1.66, 0.04, 0.16, 0.01, 0.006, 0, 0.96, -0.78));
  // Engine bay filler (dark, only visible through the gaps)
  bag.add("trim", place(box(1.23, 0.55, 1.0), 0, 0.55, -1.42));
  // Bed front wall, wheel housings, lashing eyes
  bag.add("paint", place(box(1.6, 0.6, 0.05), 0, 0.62, JD.bedZ0));
  bag.addMirrored(
    "paint",
    roundedBox(0.28, 0.28, 0.9, 0.06, 0.02, 0.66, 0.46, JD.axleR),
  );
  for (const z of [0.75, 1.55]) {
    const loop = new THREE.TorusGeometry(0.022, 0.005, 6, 14);
    loop.rotateY(Math.PI / 2);
    bag.addMirrored("steel", place(loop, 0.775, 0.42, z));
  }
  // Rear: fixed lower section + tailgate with a swage line
  bag.add("paint", roundedBox(1.68, 0.22, 0.05, 0.01, 0.006, 0, 0.41, 1.755));
  bag.add(
    "paint",
    roundedBox(1.57, 0.385, 0.05, 0.012, 0.006, 0, 0.7225, 1.755),
  );
  bag.add("paint", roundedBox(1.3, 0.06, 0.014, 0.01, 0.005, 0, 0.72, 1.786));
  bag.addMirrored(
    "steel",
    cylBetween(0.5, 0.535, 1.79, 0.6, 0.535, 1.79, 0.014, 8),
  );
  bag.add("chrome", roundedBox(0.09, 0.03, 0.02, 0.008, 0.004, 0, 0.88, 1.79));
  // Half doors with hinges, recessed grip, handle and door bar
  for (const s of [1, -1]) {
    bag.add(
      "paint",
      roundedBox(0.045, 0.355, 1.085, 0.012, 0.006, s * 0.8225, 0.7375, -0.12),
    );
    for (const y of [0.63, 0.86])
      bag.add(
        "steel",
        cylBetween(
          s * 0.85,
          y - 0.03,
          -0.676,
          s * 0.85,
          y + 0.03,
          -0.676,
          0.014,
          8,
        ),
      );
    bag.add("trim", place(box(0.13, 0.05, 0.008), s * 0.847, 0.82, 0.28));
    bag.add(
      "chrome",
      roundedBox(0.11, 0.028, 0.02, 0.01, 0.005, s * 0.855, 0.82, 0.28),
    );
    bag.add(
      "steel",
      tubePath(
        [
          [s * 0.83, 0.915, -0.66],
          [s * 0.83, 1.13, -0.63],
          [s * 0.83, 1.13, 0.4],
          [s * 0.83, 0.915, 0.42],
        ],
        0.02,
        0.06,
        8,
      ),
    );
  }
  // Mud flaps (behind the tires)
  bag.addMirrored("trim", place(box(0.34, 0.34, 0.012), 0.82, 0.13, 1.745));
  bag.addMirrored("trim", place(box(0.3, 0.3, 0.012), 0.815, 0.16, -0.76));
}

// ---------------------------------------------------------------------------
// Hood with power dome, front block, radiator grille, headlights
// ---------------------------------------------------------------------------

/** Soft bulge (cosine bell) as a height field on the top of the hood. */
function bulgeGrid(
  cx: number,
  cy: number,
  cz: number,
  hx: number,
  hz: number,
  amp: number,
): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(hx * 2, hz * 2, 22, 30);
  g.rotateX(-Math.PI / 2);
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const bump = (t: number) =>
    Math.abs(t) >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * t);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    pos.setY(i, 0.0006 + amp * bump(x / hx) * bump(z / hz));
  }
  g.computeVertexNormals();
  g.translate(cx, cy, cz);
  return g;
}

function buildHoodAndFront(bag: PartBag): void {
  const box = (w: number, h: number, d: number) =>
    new THREE.BoxGeometry(w, h, d);
  const zc = (JD.frontZ + -0.905) / 2;
  bag.add(
    "paint",
    roundedBox(1.24, 0.18, 1.045, 0.06, 0.025, 0, 0.91, zc, 4, 8),
  );
  bag.add("paint", bulgeGrid(0, JD.hoodTop, -1.42, 0.3, 0.42, 0.035));
  // Hood hinges (rear), hood catches (at the sides)
  bag.addMirrored("steel", place(box(0.06, 0.014, 0.05), 0.45, 1.004, -0.915));
  bag.addMirrored("trim", place(box(0.012, 0.05, 0.04), 0.626, 0.88, -1.55));
  bag.addMirrored("steel", place(box(0.03, 0.02, 0.05), 0.655, 0.83, -1.55));
  // Front block
  bag.add("paint", roundedBox(1.24, 0.47, 0.65, 0.03, 0.012, 0, 0.585, -1.625));
  // Grille: dark panel, six slots between seven painted bars
  bag.add("trim", place(box(0.62, 0.27, 0.026), 0, 0.65, -1.962));
  for (let i = 0; i < 7; i++)
    bag.add(
      "paint",
      place(box(0.028, 0.29, 0.036), -0.27 + i * 0.09, 0.65, -1.967),
    );
  // Headlights: chrome ring, reflector, lens
  for (const s of [-1, 1]) {
    const ring = new THREE.TorusGeometry(0.105, 0.016, 10, 30);
    bag.add("chrome", place(ring, s * 0.46, 0.63, -1.975));
    const refl = new THREE.CylinderGeometry(0.1, 0.055, 0.06, 24, 1, true);
    refl.rotateX(Math.PI / 2);
    bag.add("chrome", place(refl, s * 0.46, 0.63, -1.95));
    const lens = new THREE.CircleGeometry(0.096, 30);
    lens.rotateY(Math.PI);
    bag.add("lamp", place(lens, s * 0.46, 0.63, -1.985), { color: HEAD_COL });
    // Turn signal on the front of the fender
    bag.add("chrome", place(box(0.115, 0.075, 0.012), s * 0.81, 0.7, -1.968));
    bag.add("lamp", place(box(0.1, 0.06, 0.02), s * 0.81, 0.7, -1.975), {
      color: AMBER_COL,
    });
  }
}

// ---------------------------------------------------------------------------
// Fenders (flat, with wheel arch), flares with rivets
// ---------------------------------------------------------------------------

function fenderShape(): THREE.Shape {
  const s = new THREE.Shape();
  const r = ARCH_R;
  const zc = JD.axleF;
  const yb = 0.5;
  const dz = Math.sqrt(r * r - yb * yb);
  const a0 = Math.atan2(yb, dz);
  s.moveTo(-1.97, yb);
  s.lineTo(-1.97, JD.fenderTop);
  s.lineTo(-0.892, JD.fenderTop);
  s.lineTo(-0.892, yb);
  s.lineTo(zc + dz, yb);
  s.absarc(zc, 0, r, a0, Math.PI - a0, false);
  s.lineTo(-1.97, yb);
  s.closePath();
  return s;
}

function flareShape(zc: number, a0: number, a1: number): THREE.Shape {
  const s = new THREE.Shape();
  const ro = ARCH_R + 0.075;
  const ri = ARCH_R + 0.005;
  s.moveTo(zc + Math.cos(a0) * ro, Math.sin(a0) * ro);
  s.absarc(zc, 0, ro, a0, a1, false);
  s.lineTo(zc + Math.cos(a1) * ri, Math.sin(a1) * ri);
  s.absarc(zc, 0, ri, a1, a0, true);
  s.closePath();
  return s;
}

function buildFenders(bag: PartBag): void {
  bag.add("paint", extrudeSide(fenderShape(), 1.0, 0.385, 0.012));
  bag.add("paint", extrudeSide(fenderShape(), -1.0, 0.385, 0.012));
  // Flares at the front (on the fender) and rear (on the tub)
  const front = flareShape(JD.axleF, 0.95, Math.PI - 0.95);
  const rear = flareShape(JD.axleR, 0.45, Math.PI - 0.45);
  bag.add("trim", extrudeSide(front, 1.05, 0.05, 0.008));
  bag.add("trim", extrudeSide(front, -1.05, 0.05, 0.008));
  bag.add("trim", extrudeSide(rear, 0.89, 0.05, 0.008));
  bag.add("trim", extrudeSide(rear, -0.89, 0.05, 0.008));
  for (const [zc, x, a0, a1] of [
    [JD.axleF, 1.05, 1.05, Math.PI - 1.05],
    [JD.axleR, 0.89, 0.6, Math.PI - 0.6],
  ] as const) {
    for (let k = 0; k < 7; k++) {
      const a = a0 + ((a1 - a0) * k) / 6;
      const z = zc + Math.cos(a) * (ARCH_R + 0.04);
      const y = Math.sin(a) * (ARCH_R + 0.04);
      bag.add("chrome", rivet(x, y, z, 1, 0, 0));
      bag.add("chrome", rivet(-x, y, z, -1, 0, 0));
    }
  }
}

// ---------------------------------------------------------------------------
// Bumpers, winch, bull bar, tow hooks, trailer hitch
// ---------------------------------------------------------------------------

function buildBumpers(bag: PartBag): void {
  const box = (w: number, h: number, d: number) =>
    new THREE.BoxGeometry(w, h, d);
  bag.add("steel", roundedBox(2.0, 0.14, 0.12, 0.03, 0.012, 0, 0.3, -2.01));
  bag.add("steel", roundedBox(1.96, 0.14, 0.12, 0.03, 0.012, 0, 0.3, 1.86));
  // Winch: side plates, cover, drum with rope, fairlead, hook
  bag.addMirrored("steel", place(box(0.03, 0.15, 0.18), 0.225, 0.445, -2.0));
  bag.add("steel", place(box(0.48, 0.02, 0.18), 0, 0.515, -2.0));
  const drum = new THREE.CylinderGeometry(0.05, 0.05, 0.4, 14);
  drum.rotateZ(Math.PI / 2);
  bag.add("chrome", place(drum, 0, 0.445, -2.02));
  const cable = new THREE.CylinderGeometry(0.068, 0.068, 0.3, 14);
  cable.rotateZ(Math.PI / 2);
  bag.add("trim", place(cable, 0, 0.445, -2.02));
  bag.add("steel", place(box(0.4, 0.13, 0.014), 0, 0.445, -2.1));
  bag.addMirrored(
    "chrome",
    cylBetween(0.15, 0.39, -2.11, 0.15, 0.5, -2.11, 0.016, 10),
  );
  bag.add("steel", place(box(0.26, 0.012, 0.012), 0, 0.445, -2.11));
  const hook = new THREE.TorusGeometry(0.03, 0.008, 8, 16, Math.PI * 1.4);
  bag.add("chrome", place(hook, 0.05, 0.36, -2.12, 0, 0, -0.6));
  bag.add(
    "chrome",
    roundedBox(0.03, 0.06, 0.02, 0.006, 0.004, 0.0, 0.41, -2.115),
  );
  // Tow eyes front/rear
  for (const z of [-2.075, 1.925]) {
    const ring = new THREE.TorusGeometry(0.04, 0.009, 8, 20);
    bag.addMirrored("chrome", place(ring, 0.55, 0.3, z));
  }
  // Bull bar with fog lights
  bag.add(
    "steel",
    tubePath(
      [
        [-0.5, 0.37, -2.05],
        [-0.5, 0.95, -2.12],
        [0.5, 0.95, -2.12],
        [0.5, 0.37, -2.05],
      ],
      0.024,
      0.12,
      10,
    ),
  );
  bag.add("steel", cylBetween(-0.5, 0.5, -2.12, 0.5, 0.5, -2.12, 0.02, 10));
  for (const s of [-1, 1]) {
    const ring = new THREE.TorusGeometry(0.052, 0.01, 8, 22);
    bag.add("chrome", place(ring, s * 0.3, 0.57, -2.15));
    const body = new THREE.CylinderGeometry(0.05, 0.04, 0.06, 18);
    body.rotateX(Math.PI / 2);
    bag.add("trim", place(body, s * 0.3, 0.57, -2.12));
    const lens = new THREE.CircleGeometry(0.045, 22);
    lens.rotateY(Math.PI);
    bag.add("lamp", place(lens, s * 0.3, 0.57, -2.156), { color: HEAD_COL });
    bag.add(
      "steel",
      cylBetween(s * 0.3, 0.5, -2.12, s * 0.3, 0.55, -2.13, 0.01, 8),
    );
  }
  // Trailer hitch
  bag.add("steel", place(box(0.06, 0.06, 0.16), 0, 0.35, 1.98));
  bag.add(
    "chrome",
    place(new THREE.SphereGeometry(0.028, 12, 10), 0, 0.41, 2.02),
  );
  bag.add("chrome", cylBetween(0, 0.36, 2.02, 0, 0.39, 2.02, 0.014, 8));
}

// ---------------------------------------------------------------------------
// Windshield: frame, glass, wipers, sun visors, hinges, grab handles
// ---------------------------------------------------------------------------

function buildWindshield(bag: PartBag): void {
  const tilt = Math.atan2(JD.wsBaseZ - JD.wsTopZ, JD.wsTopY - JD.wsBaseY);
  const cy = (JD.wsBaseY + JD.wsTopY) / 2;
  const cz = (JD.wsBaseZ + JD.wsTopZ) / 2;
  const h = Math.hypot(JD.wsTopY - JD.wsBaseY, JD.wsBaseZ - JD.wsTopZ);
  const outer = roundedRectShape(1.64, h, 0.05);
  const holeShape = roundedRectShape(1.54, h - 0.1, 0.03);
  const hole = new THREE.Path(holeShape.getPoints(8));
  outer.holes.push(hole);
  const frame = extrudeFront(outer, -0.02, 0.04, 0.006);
  bag.add("paint", place(frame, 0, cy, cz, tilt));
  const glass = new THREE.PlaneGeometry(1.53, h - 0.11);
  bag.add("glass", place(glass, 0, cy, cz, tilt));
  // Wipers (arm + blade) at the bottom of the glass
  for (const [px, ang] of [
    [-0.36, -0.55],
    [0.22, -0.55],
  ] as const) {
    const arm = new THREE.BoxGeometry(0.012, 0.3, 0.01);
    arm.translate(0, 0.15, 0);
    const blade = new THREE.BoxGeometry(0.022, 0.32, 0.008);
    blade.translate(0, 0.19, -0.004);
    const a = place(arm, px, -h / 2 + 0.06, 0.028, 0, 0, ang);
    const b = place(blade, px, -h / 2 + 0.06, 0.028, 0, 0, ang);
    bag.add("trim", place(a, 0, cy, cz, tilt));
    bag.add("trim", place(b, 0, cy, cz, tilt));
    const piv = new THREE.CylinderGeometry(0.012, 0.012, 0.03, 10);
    piv.rotateX(Math.PI / 2);
    bag.add(
      "steel",
      place(place(piv, px, -h / 2 + 0.06, 0.025), 0, cy, cz, tilt),
    );
  }
  // Sun visors, inside at the top
  for (const s of [-1, 1]) {
    const v = roundedBox(0.42, 0.012, 0.15, 0.02, 0.004, 0, 0, 0, 2);
    bag.add(
      "trim",
      place(place(v, s * 0.4, h / 2 - 0.1, 0.09, 0.7), 0, cy, cz, tilt),
    );
    bag.add(
      "steel",
      place(
        place(
          cylBetween(
            s * 0.58,
            h / 2 - 0.05,
            0.03,
            s * 0.58,
            h / 2 - 0.05,
            0.09,
            0.006,
            6,
          ),
          0,
          0,
          0,
        ),
        0,
        cy,
        cz,
        tilt,
      ),
    );
  }
  // Fold-down hinges at the bottom, grab handle on the passenger A-pillar
  bag.addMirrored(
    "steel",
    cylBetween(0.72, 0.985, -0.72, 0.82, 0.985, -0.72, 0.02, 10),
  );
  bag.add(
    "steel",
    tubePath(
      [
        [0.84, 1.05, -0.68],
        [0.9, 1.08, -0.66],
        [0.9, 1.5, -0.53],
        [0.84, 1.53, -0.51],
      ],
      0.012,
      0.03,
      8,
    ),
  );
}

// ---------------------------------------------------------------------------
// Roll cage with clamps, padding, brake light
// ---------------------------------------------------------------------------

function buildCage(bag: PartBag): void {
  const box = (w: number, h: number, d: number) =>
    new THREE.BoxGeometry(w, h, d);
  const R = 0.035;
  const top = JD.cageTopY;
  const hz = JD.hoopZ;
  bag.add(
    "steel",
    tubePath(
      [
        [-0.78, 0.9, hz],
        [-0.78, top, hz],
        [0.78, top, hz],
        [0.78, 0.9, hz],
      ],
      R,
      0.14,
      12,
    ),
  );
  for (const s of [-1, 1]) {
    bag.add(
      "steel",
      tubePath(
        [
          [s * 0.78, top, hz],
          [s * 0.78, top, -0.45],
          [s * 0.78, 1.66, -0.545],
        ],
        R,
        0.1,
        12,
      ),
    );
    bag.add("steel", place(box(0.08, 0.04, 0.08), s * 0.78, 1.64, -0.54));
    bag.add(
      "steel",
      cylBetween(s * 0.78, top, hz, s * 0.815, 0.93, 1.6, 0.03, 10),
    );
    bag.add("steel", place(box(0.12, 0.04, 0.12), s * 0.78, 0.93, hz));
    bag.add("steel", place(box(0.1, 0.04, 0.1), s * 0.815, 0.935, 1.6));
    // Connectors (clamps) with bolts
    const clampY = new THREE.CylinderGeometry(0.048, 0.048, 0.06, 12);
    bag.add("steel", place(clampY, s * 0.78, 1.5, hz));
    const clampZ = new THREE.CylinderGeometry(0.048, 0.048, 0.06, 12);
    clampZ.rotateX(Math.PI / 2);
    bag.add("steel", place(clampZ, s * 0.78, top, 0.0));
    bag.add("chrome", rivet(s * 0.828, 1.5, hz, s, 0, 0, 0.007));
    bag.add("chrome", rivet(s * 0.828, top, 0.0, s, 0, 0, 0.007));
  }
  bag.add("steel", cylBetween(-0.78, top, -0.45, 0.78, top, -0.45, R, 12));
  bag.add("steel", cylBetween(-0.78, 1.35, hz, 0.78, 1.35, hz, 0.03, 10));
  bag.add("steel", cylBetween(-0.797, 1.4, 1.014, 0.797, 1.4, 1.014, 0.03, 10));
  // Padding
  const padF = new THREE.CylinderGeometry(0.05, 0.05, 0.6, 12);
  padF.rotateZ(Math.PI / 2);
  bag.add("trim", place(padF, 0, top, -0.45));
  const padH = new THREE.CylinderGeometry(0.05, 0.05, 0.7, 12);
  padH.rotateZ(Math.PI / 2);
  bag.add("trim", place(padH, 0, top, hz));
  // third brake light on the rear hoop
  bag.add("trim", place(box(0.24, 0.045, 0.03), 0, 1.4, 1.035));
  bag.add("lamp", place(box(0.2, 0.025, 0.012), 0, 1.4, 1.052), {
    color: TAIL_COL,
  });
}

// ---------------------------------------------------------------------------
// Roof rack with LED light bar
// ---------------------------------------------------------------------------

function buildRack(bag: PartBag): void {
  const box = (w: number, h: number, d: number) =>
    new THREE.BoxGeometry(w, h, d);
  bag.addMirrored(
    "steel",
    cylBetween(0.75, 1.93, -0.5, 0.75, 1.93, 0.5, 0.02, 10),
  );
  bag.add("steel", cylBetween(-0.75, 1.93, 0.5, 0.75, 1.93, 0.5, 0.02, 10));
  for (const z of [-0.4, -0.1, 0.2, 0.5])
    bag.add("steel", place(box(1.5, 0.025, 0.04), 0, 1.93, z));
  for (const z of [-0.45, 0.44])
    bag.addMirrored("steel", place(box(0.05, 0.08, 0.05), 0.75, 1.895, z));
  bag.add("trim", roundedBox(1.0, 0.07, 0.07, 0.02, 0.01, 0, 1.95, -0.52));
  bag.addMirrored("steel", place(box(0.03, 0.07, 0.05), 0.5, 1.92, -0.5));
  for (let i = 0; i < 4; i++) {
    const lens = new THREE.CircleGeometry(0.026, 16);
    lens.rotateY(Math.PI);
    bag.add("lamp", place(lens, -0.36 + i * 0.24, 1.95, -0.556), {
      color: LED_COL,
    });
    const ring = new THREE.TorusGeometry(0.028, 0.004, 6, 16);
    bag.add("chrome", place(ring, -0.36 + i * 0.24, 1.95, -0.556));
  }
}

// ---------------------------------------------------------------------------
// Attachments: snorkel, mirrors, antenna, spare wheel carrier, jerry can, plates
// ---------------------------------------------------------------------------

function buildAttachments(bag: PartBag, atlas: DecalAtlas): void {
  const box = (w: number, h: number, d: number) =>
    new THREE.BoxGeometry(w, h, d);
  // Snorkel on the right A-pillar
  bag.add(
    "trim",
    tubePath(
      [
        [0.66, 0.9, -1.0],
        [0.86, 0.96, -0.92],
        [0.88, 1.6, -0.66],
        [0.88, 1.78, -0.62],
      ],
      0.04,
      0.12,
      12,
    ),
  );
  bag.add("trim", roundedBox(0.11, 0.1, 0.18, 0.03, 0.015, 0.88, 1.84, -0.68));
  bag.add("steel", place(box(0.1, 0.06, 0.012), 0.88, 1.84, -0.776));
  bag.add(
    "steel",
    cylBetween(0.8696, 1.236, -0.8056, 0.8704, 1.264, -0.7944, 0.048, 12),
  );
  bag.add("steel", place(box(0.02, 0.06, 0.02), 0.845, 1.25, -0.8));
  // Exterior mirrors
  for (const s of [-1, 1]) {
    bag.add(
      "steel",
      tubePath(
        [
          [s * 0.83, 1.28, -0.645],
          [s * 1.0, 1.31, -0.68],
          [s * 1.06, 1.31, -0.68],
        ],
        0.012,
        0.03,
        8,
      ),
    );
    bag.add(
      "trim",
      roundedBox(0.2, 0.15, 0.05, 0.03, 0.01, s * 1.07, 1.33, -0.66),
    );
    // Mirror glass tilted slightly downwards: that way it catches the darker
    // ground part of the surroundings instead of the bright sky
    bag.add(
      "mirror",
      place(
        convexGlass(0.17, 0.12, 0.014),
        s * 1.07,
        1.33,
        -0.633,
        0.16,
        -s * 0.12,
      ),
    );
  }
  // Antenna at the left rear
  bag.add(
    "trim",
    place(
      new THREE.CylinderGeometry(0.02, 0.024, 0.04, 10),
      -0.815,
      0.945,
      1.65,
    ),
  );
  bag.add(
    "steel",
    place(coilSpring(0.012, 0.003, 6, 0.06), -0.815, 0.995, 1.65),
  );
  bag.add(
    "trim",
    cylBetween(-0.815, 1.02, 1.65, -0.8, 2.15, 1.62, 0.004, 5, 0.002),
  );
  // Spare wheel carrier (swing arm) on the right of the tailgate
  bag.add("steel", cylBetween(0.8, 0.37, 1.94, 0.8, 1.05, 1.94, 0.022, 10));
  bag.add("steel", cylBetween(0.8, 0.78, 1.94, 0.3, 0.78, 1.94, 0.022, 10));
  bag.add("steel", cylBetween(0.8, 1.05, 1.94, 0.36, 0.84, 1.94, 0.018, 8));
  for (const y of [0.45, 0.95])
    bag.add(
      "steel",
      cylBetween(0.8, y - 0.03, 1.94, 0.8, y + 0.03, 1.94, 0.035, 12),
    );
  bag.add("steel", place(box(0.16, 0.16, 0.03), 0.3, 0.78, 1.96));
  bag.add("steel", cylBetween(0.3, 0.78, 1.78, 0.3, 0.78, 2.12, 0.06, 14));
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    bag.add(
      "chrome",
      cylBetween(
        0.3 + Math.cos(a) * 0.055,
        0.78 + Math.sin(a) * 0.055,
        2.13,
        0.3 + Math.cos(a) * 0.055,
        0.78 + Math.sin(a) * 0.055,
        2.15,
        0.009,
        6,
      ),
    );
  }
  // Water jerry can on the left with its bracket
  bag.add("trim", roundedBox(0.34, 0.46, 0.17, 0.03, 0.02, -0.52, 0.72, 1.87));
  for (const x of [-0.58, -0.52, -0.46]) {
    const h = new THREE.CylinderGeometry(0.012, 0.012, 0.13, 8);
    h.rotateX(Math.PI / 2);
    bag.add("trim", place(h, x, 0.965, 1.87));
  }
  bag.add(
    "trim",
    place(new THREE.CylinderGeometry(0.03, 0.03, 0.03, 12), -0.4, 0.96, 1.87),
  );
  bag.add("steel", place(box(0.38, 0.03, 0.2), -0.52, 0.48, 1.87));
  bag.add("steel", place(box(0.36, 0.03, 0.008), -0.52, 0.73, 1.96));
  bag.add("steel", place(box(0.1, 0.42, 0.02), -0.52, 0.72, 1.79));
  bag.add(
    "decal",
    place(decalQuad(atlas.water, 0.24, 0.08), -0.52, 0.72, 1.957),
  );
  // License plates front/rear with frames
  bag.add("trim", place(box(0.36, 0.1, 0.006), -0.15, 0.415, 1.779));
  bag.add(
    "decal",
    place(decalQuad(atlas.plate, 0.34, 0.08), -0.15, 0.415, 1.783),
  );
  bag.add("trim", place(box(0.36, 0.1, 0.006), 0.42, 0.3, -2.069));
  bag.add(
    "decal",
    place(decalQuad(atlas.plate, 0.34, 0.08), 0.42, 0.3, -2.073, 0, Math.PI),
  );
  // Warning sticker at the rear
  bag.add(
    "decal",
    place(decalQuad(atlas.sticker, 0.26, 0.07), 0.35, 0.415, 1.782),
  );
}

// ---------------------------------------------------------------------------
// Tail light housings at the rear corners
// ---------------------------------------------------------------------------

function buildRearLamps(bag: PartBag): void {
  const box = (w: number, h: number, d: number) =>
    new THREE.BoxGeometry(w, h, d);
  for (const s of [-1, 1]) {
    bag.add(
      "trim",
      roundedBox(0.1, 0.26, 0.07, 0.015, 0.008, s * 0.79, 0.78, 1.795),
    );
    bag.add("lamp", place(box(0.07, 0.06, 0.012), s * 0.79, 0.86, 1.833), {
      color: AMBER_COL,
    });
    bag.add("lamp", place(box(0.07, 0.08, 0.012), s * 0.79, 0.78, 1.833), {
      color: TAIL_COL,
    });
    bag.add("lamp", place(box(0.07, 0.05, 0.012), s * 0.79, 0.705, 1.833), {
      color: REV_COL,
    });
  }
}

// ---------------------------------------------------------------------------
// Decals: belt line, emblems, numbers
// ---------------------------------------------------------------------------

function buildDecals(bag: PartBag, atlas: DecalAtlas): void {
  const Y = 0.72;
  for (const s of [-1, 1]) {
    const ry = s > 0 ? Math.PI / 2 : -Math.PI / 2;
    // Accent stripes (fender, cowl, A-pillar, door, rear side)
    for (const [x, z, len] of [
      [1.002, -1.43, 1.05],
      [0.832, -0.9, 0.06],
      [0.842, -0.775, 0.215],
      [0.847, -0.12, 1.08],
      [0.842, 1.09, 1.32],
    ] as const) {
      bag.add(
        "decal",
        place(decalQuad(atlas.stripe, len, 0.05), s * x, Y, z, 0, ry),
      );
    }
    bag.add(
      "decal",
      place(decalQuad(atlas.emblem, 0.24, 0.24), s * 0.848, 0.74, -0.15, 0, ry),
    );
    // Racing number flat on the fender: both sides oriented the same way
    // (u towards +x, v forwards) – otherwise the left "42" reads mirrored.
    bag.add(
      "decal",
      place(
        decalQuad(atlas.number, 0.3, 0.23),
        s * 0.81,
        JD.fenderTop + 0.0135,
        -1.5,
        -Math.PI / 2,
      ),
    );
  }
}
