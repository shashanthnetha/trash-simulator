// Trash Simulator – model of the delivery drone: moulded two-part shell with
// panel lines, folding-style arms with motor bells (winding slots), battery
// pack with strap, GPS puck, antennas, three-axis camera gimbal, landing
// skids, gripper, position lights and the green night beacon.
//
// DRAW CALLS: everything that does not move on its own is baked into TWO
// meshes – the light shell (airframe, antennas, hub nuts, accents) and the dark
// frame (belly, arms, skids, gripper). They can share a material despite four
// different surface finishes because colour, roughness and metalness come per
// VERTEX (`color` + `aRM`), so one texture set covers polished metal, matte
// plastic and the orange accents. Separate meshes remain only for what animates
// independently: the gimbal, the motor bells, the two lamps (one mesh, two
// intensity uniforms), the four propellers (one mesh, each blade spun about its
// own motor axis in the vertex shader) and the blur disc.
// Total: 8 draw calls plus 2 in the shadow pass – it used to be 20.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  pbrDroneShell,
  pbrMotorBell,
  rotorBlurTexture,
} from "./companions-textures";
import { applyPbr, pbrPlastic, softCircleTexture } from "./textures";

export interface DroneModel {
  root: THREE.Group;
  /**
   * Propellers (spin around y). These are transform carriers only – they are
   * NOT in the scene graph; all four blades live in one mesh and read their
   * angle out of `rotation.y` right before the draw. Setting `rotation.y`
   * works exactly as before.
   */
  rotors: THREE.Mesh[];
  /** Blades fade out as soon as the blur disc takes over. */
  bladeMat: THREE.MeshStandardMaterial;
  /** Blur discs – opacity follows the rotor speed. */
  blur: THREE.Mesh;
  blurMat: THREE.MeshBasicMaterial;
  /** Camera head, stabilised against the tilt. */
  gimbal: THREE.Group;
  /**
   * Position lights: `emissiveIntensity` is read out of this material every
   * frame and handed to the shared lamp shader as a uniform.
   */
  ledMat: THREE.MeshStandardMaterial;
  /** Green night beacon: emissive lens plus glow sprite (same mechanism). */
  navMat: THREE.MeshStandardMaterial;
  navGlow: THREE.Sprite;
  navGlowMat: THREE.SpriteMaterial;
  /** Anchor point of the carried cargo. */
  hook: THREE.Object3D;
  dispose(): void;
}

const ARM = 0.4;
/** Distance of the motor axis from the centre. */
const MX = ARM * 0.72;
const TAU = Math.PI * 2;
const RED = new THREE.Color("#ff5a4a");
const GREEN = new THREE.Color("#5cff8e");
const NAV_LENS = new THREE.Color("#1c3324");
const NAV_GLOW = new THREE.Color("#46ff82");

/** Base colours of the two albedo textures – the vertex tints divide by them. */
const SHELL_BASE = new THREE.Color("#dfe3e6");
const DARK_BASE = new THREE.Color("#31353c");

const CORNERS: Array<[number, number]> = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

/**
 * Vertex tint that turns the base colour of a texture into `hex`. Only ever
 * used to DARKEN (both bases are the lightest colour on their mesh), so the
 * grain of the texture is scaled down, never amplified.
 */
function tint(base: THREE.Color, hex: string): THREE.Color {
  const c = new THREE.Color(hex);
  return c.setRGB(c.r / base.r, c.g / base.g, c.b / base.b);
}

/** Surface finish per vertex: [tint, roughness multiplier, metalness]. */
type Finish = [THREE.Color, number, number];

const WHITE = new THREE.Color(1, 1, 1);
/** Plain plastic / painted shell – texture unchanged. */
const F_BASE: Finish = [WHITE, 1, 0];
/** Small bare-metal parts: antennas, shafts, hub nuts, gimbal yoke. */
const F_METAL: Finish = [tint(SHELL_BASE, "#9aa2a9"), 0.8, 0.92];
/** Orange accents: battery strap, warning rings, gripper jaw tips. */
const F_ACCENT: Finish = [tint(SHELL_BASE, "#d4761f"), 1.7, 0.02];
/** Anodised gimbal ring – dark like the housing but polished. */
const F_RING: Finish = [WHITE, 0.35, 0.9];
/** Camera lens: almost black and very glossy. */
const F_GLASS: Finish = [tint(DARK_BASE, "#0d1116"), 0.16, 0.35];

function roundedBox(
  w: number,
  h: number,
  d: number,
  r: number,
): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const hw = w / 2 - r;
  const hd = d / 2 - r;
  shape.moveTo(-hw, -d / 2);
  shape.lineTo(hw, -d / 2);
  shape.absarc(hw, -hd, r, -Math.PI / 2, 0, false);
  shape.lineTo(w / 2, hd);
  shape.absarc(hw, hd, r, 0, Math.PI / 2, false);
  shape.lineTo(-hw, d / 2);
  shape.absarc(-hw, hd, r, Math.PI / 2, Math.PI, false);
  shape.lineTo(-w / 2, -hd);
  shape.absarc(-hw, -hd, r, Math.PI, Math.PI * 1.5, false);
  shape.closePath();
  const b = Math.min(0.02, h / 3);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: h - 2 * b,
    bevelEnabled: true,
    bevelThickness: b,
    bevelSize: b,
    bevelSegments: 2,
    curveSegments: 4,
    steps: 1,
  });
  g.rotateX(-Math.PI / 2);
  g.translate(0, -h / 2 + b, 0);
  return g;
}

function tube(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  r: number,
  seg = 7,
): THREE.BufferGeometry {
  const d = new THREE.Vector3(bx - ax, by - ay, bz - az);
  const len = d.length() || 1e-4;
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1, false);
  g.applyQuaternion(
    new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      d.normalize(),
    ),
  );
  g.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  return g;
}

/**
 * Flat, tapering arm from (ax, az) to (bx, bz) at height y – a folding arm is
 * a flat profile, not a round tube.
 */
function armBeam(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  y: number,
  w0: number,
  w1: number,
  h: number,
): THREE.BufferGeometry {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz) || 1e-4;
  const g = new THREE.BoxGeometry(len, h, 1);
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getX(i) / len + 0.5;
    pos.setZ(i, pos.getZ(i) * (w0 + (w1 - w0) * t));
    pos.setY(i, pos.getY(i) * (1 - t * 0.22));
  }
  g.computeVertexNormals();
  g.rotateY(Math.atan2(-dz, dx));
  g.translate((ax + bx) / 2, y, (az + bz) / 2);
  return g;
}

/**
 * Merge after dropping the index: ExtrudeGeometry is non-indexed while
 * Box/Sphere/Cylinder are indexed – mergeGeometries fails on a mix of both.
 */
function merge(
  list: THREE.BufferGeometry[],
  what: string,
): THREE.BufferGeometry {
  const flat = list.map((g) => (g.index ? g.toNonIndexed() : g));
  const out = mergeGeometries(flat, false);
  for (let i = 0; i < flat.length; i++) {
    if (flat[i] !== list[i]) list[i].dispose();
    flat[i].dispose();
  }
  if (!out) throw new Error(`Drone: ${what} missing`);
  return out;
}

/**
 * Stamp a surface finish onto a part before it is merged. Every geometry that
 * goes into a vertex-coloured mesh MUST carry both attributes – a missing one
 * would leave the shader reading zeros (a mirror-finish part).
 */
function fin(g: THREE.BufferGeometry, f: Finish): THREE.BufferGeometry {
  const n = g.getAttribute("position").count;
  const col = new Float32Array(n * 3);
  const rm = new Float32Array(n * 2);
  const [c, rough, metal] = f;
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
    rm[i * 2] = rough;
    rm[i * 2 + 1] = metal;
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setAttribute("aRM", new THREE.BufferAttribute(rm, 2));
  return g;
}

/** Flat emissive colour + lamp channel (0 = position light, 1 = beacon). */
function lamp(
  g: THREE.BufferGeometry,
  body: THREE.Color,
  emit: THREE.Color,
  channel: number,
): THREE.BufferGeometry {
  const n = g.getAttribute("position").count;
  const col = new Float32Array(n * 3);
  const em = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    col[i * 3] = body.r;
    col[i * 3 + 1] = body.g;
    col[i * 3 + 2] = body.b;
    em[i * 4] = emit.r;
    em[i * 4 + 1] = emit.g;
    em[i * 4 + 2] = emit.b;
    em[i * 4 + 3] = channel;
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setAttribute("aEmit", new THREE.BufferAttribute(em, 4));
  return g;
}

/**
 * Per-vertex roughness and metalness on a standard material. This is what lets
 * polished metal, matte plastic and the orange accents share ONE material – and
 * therefore one draw call – instead of a mesh per surface finish.
 */
function vertexFinish(m: THREE.MeshStandardMaterial, key: string): void {
  m.vertexColors = true;
  m.customProgramCacheKey = () => key;
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nattribute vec2 aRM;\nvarying vec2 vRM;",
      )
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvRM = aRM;",
      );
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vRM;")
      .replace(
        "#include <roughnessmap_fragment>",
        "#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor * vRM.x, 0.035, 1.0);",
      )
      .replace(
        "#include <metalnessmap_fragment>",
        "#include <metalnessmap_fragment>\nmetalnessFactor = vRM.y;",
      );
  };
  m.needsUpdate = true;
}

/** Propeller blade with a realistic planform: narrow root, wide mid, twist. */
function blade(sign: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(0.21, 0.005, 0.04, 8, 1, 1);
  g.translate(sign * 0.12, 0, 0);
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const t = Math.min(1, Math.max(0, Math.abs(x) / 0.225));
    // Chord: thin at the root, widest at 45 %, tapering to the tip
    const chord = 0.35 + 1.05 * Math.sin(Math.PI * Math.min(1, t * 0.92));
    pos.setZ(i, pos.getZ(i) * chord);
    pos.setY(i, pos.getY(i) * (1.4 - t * 0.7));
    // Twist: steep pitch at the root, shallow at the tip
    const a = 0.4 * (1 - t * 0.62) * sign;
    const y = pos.getY(i);
    const z = pos.getZ(i);
    pos.setY(i, y * Math.cos(a) - z * Math.sin(a));
    pos.setZ(i, y * Math.sin(a) + z * Math.cos(a));
  }
  g.computeVertexNormals();
  return g;
}

export function buildDrone(): DroneModel {
  const shell = new THREE.MeshStandardMaterial({ color: 0xffffff });
  applyPbr(shell, pbrDroneShell(), [2, 2]);
  vertexFinish(shell, "drone-shell");
  const dark = new THREE.MeshStandardMaterial({ color: 0xffffff });
  applyPbr(dark, pbrPlastic("#31353c", { wear: 0.5 }), [3, 3]);
  vertexFinish(dark, "drone-frame");
  const bell = new THREE.MeshStandardMaterial({ color: 0xffffff });
  applyPbr(bell, pbrMotorBell());
  // Position lights and beacon in one mesh: which lamp a vertex belongs to
  // comes from aEmit.a, its brightness from one of two uniforms.
  const uLedI = { value: 0.9 };
  const uNavI = { value: 0 };
  const lights = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.24,
    metalness: 0.08,
  });
  lights.customProgramCacheKey = () => "drone-lights";
  lights.onBeforeCompile = (sh) => {
    sh.uniforms.uLedI = uLedI;
    sh.uniforms.uNavI = uNavI;
    sh.vertexShader = sh.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nattribute vec4 aEmit;\nvarying vec4 vEmit;",
      )
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvEmit = aEmit;",
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform float uLedI;\nuniform float uNavI;\nvarying vec4 vEmit;",
      )
      .replace(
        "vec3 totalEmissiveRadiance = emissive;",
        "vec3 totalEmissiveRadiance = vEmit.rgb * mix(uLedI, uNavI, vEmit.a);",
      );
  };
  // Animation carriers: companions.ts writes emissiveIntensity here, the values
  // are picked up as uniforms right before the lamp mesh is drawn. They are not
  // attached to any mesh, so they never compile a program of their own.
  const led = new THREE.MeshStandardMaterial({
    emissive: 0xffffff,
    emissiveIntensity: 0.9,
  });
  const nav = new THREE.MeshStandardMaterial({
    emissive: 0x46ff82,
    emissiveIntensity: 0,
  });
  const blurTex = rotorBlurTexture();
  const blurMat = new THREE.MeshBasicMaterial({
    map: blurTex,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
    // A transparent DoubleSide material is drawn TWICE by three (back then
    // front faces). On a flat disc that second pass buys nothing and cost the
    // drone a whole draw call.
    forceSinglePass: true,
    fog: true,
  });
  const bladeMat = new THREE.MeshStandardMaterial({
    color: 0x23262b,
    roughness: 0.45,
    metalness: 0.1,
    transparent: true,
    opacity: 1,
  });
  // One angle per motor: the vertices of all four propellers sit in ONE mesh,
  // each carries its motor axis and its index in `aProp`, and turns about that
  // axis here. Four floats per frame instead of four draw calls.
  const uSpin = { value: new THREE.Vector4() };
  bladeMat.customProgramCacheKey = () => "drone-rotor";
  bladeMat.onBeforeCompile = (sh) => {
    sh.uniforms.uSpin = uSpin;
    sh.vertexShader = sh.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nattribute vec4 aProp;\nuniform vec4 uSpin;\nfloat pS;\nfloat pC;",
      )
      .replace(
        "#include <beginnormal_vertex>",
        `#include <beginnormal_vertex>
pS = sin(uSpin[int(aProp.w + 0.5)]);
pC = cos(uSpin[int(aProp.w + 0.5)]);
objectNormal = vec3(pC * normal.x + pS * normal.z, normal.y,
  pC * normal.z - pS * normal.x);`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
transformed = vec3(pC * position.x + pS * position.z, position.y,
  pC * position.z - pS * position.x) + aProp.xyz;`,
      );
  };
  const navGlowMat = new THREE.SpriteMaterial({
    map: softCircleTexture("140,255,170", 1),
    color: 0x7dff9c,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const mats: THREE.Material[] = [
    shell,
    dark,
    bell,
    lights,
    led,
    nav,
    blurMat,
    bladeMat,
    navGlowMat,
  ];
  const geos: THREE.BufferGeometry[] = [];

  const root = new THREE.Group();
  root.rotation.order = "YXZ";
  const put = (
    g: THREE.BufferGeometry,
    m: THREE.Material,
    parent: THREE.Object3D = root,
    shadow = true,
  ): THREE.Mesh => {
    geos.push(g);
    const me = new THREE.Mesh(g, m);
    me.castShadow = shadow;
    parent.add(me);
    return me;
  };

  // --- Light shell: airframe with the panel lines, plus every small part whose
  //     finish can be reached from this texture by darkening it – the bare
  //     metal bits and the orange accents.
  const shellParts: THREE.BufferGeometry[] = [];
  shellParts.push(fin(roundedBox(0.44, 0.088, 0.38, 0.085), F_BASE));
  // GPS puck on the rear deck
  shellParts.push(
    fin(
      new THREE.CylinderGeometry(0.062, 0.066, 0.014, 16).translate(
        0,
        0.05,
        0.105,
      ),
      F_BASE,
    ),
  );
  // Raised centre ridge (cooling duct) so the deck is not one flat slab
  shellParts.push(
    fin(roundedBox(0.16, 0.036, 0.3, 0.05).translate(0, 0.058, -0.02), F_BASE),
  );
  // Antennas with their ball tips
  for (const s of [-1, 1]) {
    shellParts.push(
      fin(
        tube(s * 0.155, 0.03, 0.165, s * 0.183, 0.15, 0.2, 0.006, 5),
        F_METAL,
      ),
    );
    shellParts.push(
      fin(
        new THREE.SphereGeometry(0.009, 6, 5).translate(s * 0.183, 0.15, 0.2),
        F_METAL,
      ),
    );
  }
  // Motor shafts and hub nuts
  for (const [sx, sz] of CORNERS) {
    shellParts.push(
      fin(
        new THREE.CylinderGeometry(0.006, 0.006, 0.03, 6).translate(
          sx * MX,
          0.078,
          sz * MX,
        ),
        F_METAL,
      ),
    );
    shellParts.push(
      fin(
        new THREE.CylinderGeometry(0.011, 0.013, 0.008, 6).translate(
          sx * MX,
          0.096,
          sz * MX,
        ),
        F_METAL,
      ),
    );
  }
  // Gimbal yoke
  const yoke = new THREE.TorusGeometry(0.058, 0.007, 5, 12, Math.PI);
  yoke.rotateY(Math.PI / 2);
  shellParts.push(fin(yoke.translate(0, -0.1, -0.145), F_METAL));
  // Accents: battery strap, arm warning rings, gripper jaw tips
  for (const z of [0.045, 0.135])
    shellParts.push(
      fin(
        new THREE.BoxGeometry(0.208, 0.07, 0.014).translate(0, 0.086, z),
        F_ACCENT,
      ),
    );
  for (const [sx, sz] of CORNERS)
    shellParts.push(
      fin(
        new THREE.CylinderGeometry(0.0245, 0.0245, 0.01, 10).translate(
          sx * 0.132,
          0.008,
          sz * 0.117,
        ),
        F_ACCENT,
      ),
    );
  for (const s of [-1, 1])
    shellParts.push(
      fin(
        new THREE.SphereGeometry(0.012, 6, 5).translate(
          s * 0.018,
          -0.272,
          0.075,
        ),
        F_ACCENT,
      ),
    );
  put(merge(shellParts, "airframe"), shell);

  // --- Dark structure: belly plate, seam band, arms, motor mounts, battery,
  //     skids, gripper, antenna bases
  const darkParts: THREE.BufferGeometry[] = [];
  // Dark sensor canopy over the nose – gives the airframe a readable front
  const nose = new THREE.SphereGeometry(0.125, 16, 8, 0, Math.PI * 2, 0, 1.2);
  nose.scale(1, 0.46, 1.15);
  darkParts.push(nose.translate(0, 0.03, -0.115));
  // Parting line: a slightly larger flat ring between upper and lower shell
  darkParts.push(
    roundedBox(0.452, 0.016, 0.392, 0.088).translate(0, -0.044, 0),
  );
  darkParts.push(
    roundedBox(0.33, 0.06, 0.29, 0.06).translate(0, -0.082, 0.005),
  );
  for (const [sx, sz] of CORNERS) {
    const ax = sx * MX;
    const az = sz * MX;
    darkParts.push(
      armBeam(sx * 0.13, sz * 0.115, ax, az, -0.014, 0.032, 0.02, 0.03),
    );
    // Folding hinge at the arm root
    darkParts.push(
      new THREE.CylinderGeometry(0.026, 0.026, 0.048, 10).translate(
        sx * 0.132,
        -0.014,
        sz * 0.117,
      ),
    );
    // Motor mount plate + stator base
    darkParts.push(
      new THREE.CylinderGeometry(0.05, 0.054, 0.014, 12).translate(
        ax,
        0.004,
        az,
      ),
    );
    darkParts.push(
      new THREE.CylinderGeometry(0.03, 0.03, 0.03, 10).translate(ax, 0.014, az),
    );
    // LED bezel under each motor
    darkParts.push(
      new THREE.CylinderGeometry(0.017, 0.019, 0.012, 8)
        .rotateX(Math.PI / 2)
        .translate(ax * 1.03, -0.02, az * 1.03),
    );
  }
  // Battery pack on the rear deck with a recessed handle
  darkParts.push(roundedBox(0.2, 0.062, 0.15, 0.02).translate(0, 0.086, 0.09));
  // Landing skids: two arches with rubber feet
  for (const s of [-1, 1]) {
    darkParts.push(
      tube(s * 0.15, -0.1, -0.16, s * 0.185, -0.235, -0.13, 0.013, 6),
    );
    darkParts.push(
      tube(s * 0.15, -0.1, 0.16, s * 0.185, -0.235, 0.13, 0.013, 6),
    );
    darkParts.push(
      tube(s * 0.185, -0.242, -0.185, s * 0.185, -0.242, 0.185, 0.016, 8),
    );
  }
  // Gripper: housing and two jaws
  darkParts.push(
    new THREE.CylinderGeometry(0.046, 0.056, 0.06, 12).translate(
      0,
      -0.135,
      0.075,
    ),
  );
  for (const s of [-1, 1]) {
    darkParts.push(
      tube(s * 0.032, -0.16, 0.075, s * 0.052, -0.232, 0.075, 0.012, 6),
    );
    darkParts.push(
      tube(s * 0.052, -0.232, 0.075, s * 0.018, -0.272, 0.075, 0.011, 6),
    );
  }
  // Antenna bases
  for (const s of [-1, 1])
    darkParts.push(
      new THREE.CylinderGeometry(0.012, 0.014, 0.022, 8).translate(
        s * 0.155,
        0.02,
        0.165,
      ),
    );
  for (const g of darkParts) fin(g, F_BASE);
  put(merge(darkParts, "frame"), dark);

  // --- Motor bells (winding slots come from the texture). No shadow: they sit
  //     on top of the arms, inside the airframe's own shadow.
  const bellParts: THREE.BufferGeometry[] = [];
  for (const [sx, sz] of CORNERS) {
    const can = new THREE.CylinderGeometry(0.044, 0.047, 0.05, 14, 1, true);
    bellParts.push(can.translate(sx * MX, 0.038, sz * MX));
    bellParts.push(
      new THREE.CylinderGeometry(0.044, 0.044, 0.006, 14).translate(
        sx * MX,
        0.062,
        sz * MX,
      ),
    );
  }
  put(merge(bellParts, "motor bells"), bell, root, false);

  // --- Camera gimbal (roll yoke → pitch head): housing, ring and lens in one
  //     mesh, the finishes come from the vertex attributes.
  const gimbal = new THREE.Group();
  gimbal.position.set(0, -0.11, -0.145);
  root.add(gimbal);
  const camBody = new THREE.SphereGeometry(0.046, 12, 8);
  camBody.scale(1, 0.95, 1.1);
  const hood = new THREE.CylinderGeometry(0.034, 0.034, 0.016, 12);
  hood.rotateX(Math.PI / 2);
  hood.translate(0, 0, -0.056);
  const ring = new THREE.CylinderGeometry(0.031, 0.031, 0.008, 12);
  ring.rotateX(Math.PI / 2);
  const lens = new THREE.CylinderGeometry(0.024, 0.028, 0.026, 14);
  lens.rotateX(Math.PI / 2);
  put(
    merge(
      [
        fin(camBody, F_BASE),
        fin(hood, F_BASE),
        fin(ring.translate(0, 0, -0.062), F_RING),
        fin(lens.translate(0, 0, -0.052), F_GLASS),
      ],
      "camera",
    ),
    dark,
    gimbal,
    false,
  );

  // --- Lamps: four flush position lenses in the bezels under the motors plus
  //     the green night beacon on the rear belly – one mesh, two channels.
  const lampParts: THREE.BufferGeometry[] = [];
  for (const [sx, sz] of CORNERS) {
    const s = new THREE.SphereGeometry(0.013, 8, 6);
    s.scale(1, 1, 0.7);
    const c = sx < 0 ? RED : GREEN;
    lampParts.push(
      lamp(s.translate(sx * MX * 1.03, -0.02, sz * MX * 1.03), c, c, 0),
    );
  }
  const dome = new THREE.SphereGeometry(0.017, 10, 7, 0, Math.PI * 2, 0, 1.9);
  dome.rotateX(Math.PI);
  lampParts.push(lamp(dome.translate(0, -0.108, 0.15), NAV_LENS, NAV_GLOW, 1));
  const lampMesh = put(merge(lampParts, "lamps"), lights, root, false);
  lampMesh.onBeforeRender = () => {
    uLedI.value = led.emissiveIntensity;
    uNavI.value = nav.emissiveIntensity;
  };
  const navGlow = new THREE.Sprite(navGlowMat);
  navGlow.position.set(0, -0.125, 0.15);
  navGlow.scale.setScalar(0.34);
  root.add(navGlow);

  // --- Propellers: all four in ONE mesh; every blade is spun about its own
  //     motor axis in the VERTEX SHADER from a vec4 of angles. companions.ts
  //     still gets four Meshes and turns them via rotation.y; they never enter
  //     the scene graph, their angle is copied into the uniform before the draw.
  //     An InstancedMesh does the same job in one call, but rewriting its matrix
  //     buffer once per frame measured 4 ms on ANGLE/D3D11 – 256 bytes uploaded
  //     mid-frame are enough to stall the pipeline. A uniform costs nothing.
  const propParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < CORNERS.length; i++) {
    const [sx, sz] = CORNERS[i];
    const g = merge(
      [new THREE.CylinderGeometry(0.014, 0.019, 0.02, 8), blade(-1), blade(1)],
      "propeller",
    );
    const n = g.getAttribute("position").count;
    const arr = new Float32Array(n * 4);
    for (let k = 0; k < n; k++) {
      arr[k * 4] = sx * MX;
      arr[k * 4 + 1] = 0.1;
      arr[k * 4 + 2] = sz * MX;
      arr[k * 4 + 3] = i;
    }
    g.setAttribute("aProp", new THREE.BufferAttribute(arr, 4));
    propParts.push(g);
  }
  const propAll = merge(propParts, "propellers");
  // The vertices are local to their motor axis, so the automatic bounds would
  // be far too small – give the mesh the hull of all four discs.
  propAll.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.1, 0), 0.68);
  // A spinning propeller casts no readable shadow – saves four shadow calls
  const rotorMesh = put(propAll, bladeMat, root, false);
  const rotors: THREE.Mesh[] = [];
  for (const [sx, sz] of CORNERS) {
    const m = new THREE.Mesh(propAll, bladeMat);
    m.position.set(sx * MX, 0.1, sz * MX);
    rotors.push(m);
  }
  rotorMesh.onBeforeRender = () => {
    // Wrapped: the spin angle grows without bound, and a float32 sin() of 10^5
    // radians starts to stutter.
    uSpin.value.set(
      rotors[0].rotation.y % TAU,
      rotors[1].rotation.y % TAU,
      rotors[2].rotation.y % TAU,
      rotors[3].rotation.y % TAU,
    );
  };

  // --- Blur discs (one mesh for all four)
  const blurParts: THREE.BufferGeometry[] = [];
  for (const [sx, sz] of CORNERS) {
    const disc = new THREE.PlaneGeometry(0.47, 0.47);
    disc.rotateX(-Math.PI / 2);
    blurParts.push(disc.translate(sx * MX, 0.104, sz * MX));
  }
  const blurAll = merge(blurParts, "blur discs");
  geos.push(blurAll);
  const blur = new THREE.Mesh(blurAll, blurMat);
  blur.renderOrder = 3;
  root.add(blur);

  const hook = new THREE.Object3D();
  hook.position.set(0, -0.34, 0.075);
  root.add(hook);

  return {
    root,
    rotors,
    bladeMat,
    blur,
    blurMat,
    gimbal,
    ledMat: led,
    navMat: nav,
    navGlow,
    navGlowMat,
    hook,
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
    },
  };
}
