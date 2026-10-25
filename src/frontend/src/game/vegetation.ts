// Vegetation and beach details: dune grass (marram grass – instanced blade
// clumps, wind in the vertex shader), low ground cover, rocks (triplanar
// textured, wet in the shore zone), shells and pebbles. Everything instanced.
// Geometry: vegetation-geometry.ts, textures: vegetation-textures.ts,
// GLSL: vegetation-shaders.ts.

import * as THREE from "three";
import { landformVegetation } from "./landforms";
import { clamp, fbm, mulberry32, smoothstep } from "./noise";
import type { Environment } from "./sky";
import { SHORE_GLSL, shoreZ, terrainHeight } from "./terrain";
import type { QualityId } from "./types";
import {
  type RockVariant,
  buildBroadClump,
  buildClamShell,
  buildFanShell,
  buildGrassClump,
  buildGroundCover,
  buildPebble,
  buildRock,
  buildSpiralShell,
} from "./vegetation-geometry";
import { Pines } from "./vegetation-pines";
import {
  GRASS_FRAG_COLOR,
  GRASS_FRAG_LIGHT,
  GRASS_FRAG_PARS,
  GRASS_FRAG_ROUGH,
  GRASS_FRAG_SAFE,
  GRASS_VERT_NORMAL,
  GRASS_VERT_PARS,
  GRASS_VERT_VARYINGS,
  GRASS_VERT_WIND,
  ROCK_FRAG_LIGHT,
  ROCK_FRAG_MAP,
  ROCK_FRAG_NORMAL,
  ROCK_FRAG_PARS,
  ROCK_FRAG_ROUGH,
  ROCK_VERT_BODY,
  ROCK_VERT_PARS,
} from "./vegetation-shaders";
import {
  broadLeafTexture,
  grassBladeStripes,
  rockTextures,
  shellTextures,
} from "./vegetation-textures";

interface TierCfg {
  /** Total clumps (both grass species together). */
  clumps: number;
  /** Share of the broad-leaved species in the total budget. */
  broadShare: number;
  blades: number;
  fillers: number;
  broadLeaves: number;
  broadFillers: number;
  cover: number;
  rockDetail: number;
  shells: number;
  pebbles: number;
  grassShadow: boolean;
}

// Triangles per clump: blades/leaves × 10 (3 segments with a fold + the tip) +
// fillers × 2. Since the clumps now stand in tussocks (several per site), the
// same visual coverage needs more clumps – paid for by one blade less each.
// Marram grass 4+3 = 46, broad leaf 3+1 = 32 (medium/low 4+2 = 44 and
// 3+1 = 32 respectively).
// Ultra: 8435×46 + 3615×32 = 504k, high: 334k, medium: 139k, low: 69k –
// each within the previous budget of the single species (504k/336k/141k/70k).
const TIERS: Record<QualityId, TierCfg> = {
  ultra: {
    clumps: 12050,
    broadShare: 0.3,
    blades: 4,
    fillers: 3,
    broadLeaves: 3,
    broadFillers: 1,
    cover: 2200,
    rockDetail: 3,
    shells: 400,
    pebbles: 260,
    grassShadow: true,
  },
  high: {
    clumps: 8000,
    broadShare: 0.3,
    blades: 4,
    fillers: 3,
    broadLeaves: 3,
    broadFillers: 1,
    cover: 1500,
    rockDetail: 3,
    shells: 300,
    pebbles: 200,
    grassShadow: false,
  },
  medium: {
    clumps: 3450,
    broadShare: 0.3,
    blades: 4,
    fillers: 2,
    broadLeaves: 3,
    broadFillers: 1,
    cover: 800,
    rockDetail: 2,
    shells: 180,
    pebbles: 120,
    grassShadow: false,
  },
  low: {
    clumps: 1720,
    broadShare: 0.3,
    blades: 4,
    fillers: 2,
    broadLeaves: 3,
    broadFillers: 1,
    cover: 400,
    rockDetail: 2,
    shells: 100,
    pebbles: 60,
    grassShadow: false,
  },
};

/** Areas free of growth/rocks: recycling station, jeep parking spot, spawn. */
const KEEP_CLEAR = [
  { x: 96, z: 118, r: 12 },
  { x: 76, z: 106, r: 7 },
  { x: 6, z: 52, r: 4 },
];

function keepClear(x: number, z: number): boolean {
  for (const k of KEEP_CLEAR) {
    const dx = x - k.x;
    const dz = z - k.z;
    if (dx * dx + dz * dz < k.r * k.r) return true;
  }
  return false;
}

/** Dune relief above the smooth beach profile (0 = beach, up to ~6.5 on the crests). */
function duneRelief(x: number, z: number, h: number): number {
  const d = z - shoreZ(x);
  return h - 7.5 * (1 - Math.exp(-d * 0.011));
}

interface RockDef {
  v: RockVariant;
  x: number;
  z: number;
  s: number;
}

/** A placed clump (both species share the same distribution). */
interface GrassSpot {
  x: number;
  y: number;
  z: number;
  ry: number;
  tiltX: number;
  tiltZ: number;
  s: number;
  /** Height factor (aInst.y). */
  hs: number;
  dry: number;
  cv: number;
  broad: boolean;
}

export class Vegetation {
  readonly group = new THREE.Group();
  private parent: THREE.Object3D;
  private textures: THREE.Texture[] = [];
  /** Shared by both grass species: wind and light. */
  private grassU = {
    uTime: { value: 0 },
    uWind: { value: 0.2 },
    uWindDir: { value: new THREE.Vector2(1, 0) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uBacklight: { value: 0.8 },
  };
  // Blade colors (sRGB → linear): base olive/brown, tip a pale silver-green or
  // straw-yellow when dry. uStiff = flexibility in the wind.
  private grassColA = {
    uStiff: { value: 1 },
    uBaseA: { value: new THREE.Color(0x4a5628) },
    uBaseB: { value: new THREE.Color(0x7a6234) },
    uTipA: { value: new THREE.Color(0xafbb88) },
    uTipB: { value: new THREE.Color(0xddc47c) },
  };
  // Broad leaf: richer, darker and barely bleached – stiff leaves.
  private grassColB = {
    uStiff: { value: 0.42 },
    uBaseA: { value: new THREE.Color(0x2c401e) },
    uBaseB: { value: new THREE.Color(0x55532b) },
    uTipA: { value: new THREE.Color(0x6d8a44) },
    uTipB: { value: new THREE.Color(0x9d9455) },
  };
  private rockU = {
    uTime: { value: 0 },
    uSkyCol: { value: new THREE.Color(0.6, 0.7, 0.8) },
  };
  private pines: Pines;
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpE = new THREE.Euler();
  private tmpP = new THREE.Vector3();
  private tmpS = new THREE.Vector3();

  constructor(parent: THREE.Object3D, quality: QualityId) {
    this.parent = parent;
    parent.add(this.group);
    const cfg = TIERS[quality];
    this.buildGrass(cfg);
    this.buildGroundCover(cfg);
    const clusters = this.buildRocks(cfg);
    this.buildPebbles(cfg, clusters);
    this.buildShells(cfg);
    this.pines = new Pines(this.group, quality);
  }

  private setInstance(
    mesh: THREE.InstancedMesh,
    i: number,
    x: number,
    y: number,
    z: number,
    rx: number,
    ry: number,
    rz: number,
    s: number,
  ): void {
    this.tmpE.set(rx, ry, rz);
    this.tmpQ.setFromEuler(this.tmpE);
    this.tmpP.set(x, y, z);
    this.tmpS.set(s, s, s);
    this.tmpM.compose(this.tmpP, this.tmpQ, this.tmpS);
    mesh.setMatrixAt(i, this.tmpM);
  }

  private finish(mesh: THREE.InstancedMesh, count: number): void {
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
  }

  // ---------------------------------------------------------------------
  // Dune grass: two species, distributed in tussocks
  // ---------------------------------------------------------------------

  /** Material of one grass species; wind uniforms shared, color uniforms per species. */
  private grassMaterial(
    tex: THREE.Texture,
    cols: Record<string, THREE.IUniform>,
  ): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      alphaTest: 0.4,
      side: THREE.DoubleSide,
      roughness: 0.82,
      metalness: 0,
      color: 0xffffff,
    });
    const u = this.grassU;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u, cols);
      shader.vertexShader =
        `${GRASS_VERT_PARS}${GRASS_VERT_VARYINGS}${shader.vertexShader}`.replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>\n${GRASS_VERT_WIND}${GRASS_VERT_NORMAL}`,
        );
      shader.fragmentShader = `${GRASS_FRAG_PARS}${shader.fragmentShader}`
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>\n${GRASS_FRAG_COLOR}`,
        )
        .replace(
          "#include <roughnessmap_fragment>",
          `#include <roughnessmap_fragment>\n${GRASS_FRAG_ROUGH}`,
        )
        .replace(
          "#include <lights_fragment_end>",
          `#include <lights_fragment_end>\n${GRASS_FRAG_LIGHT}`,
        )
        .replace(
          "#include <opaque_fragment>",
          `#include <opaque_fragment>\n${GRASS_FRAG_SAFE}`,
        );
    };
    return mat;
  }

  /** Depth material with the same wind deformation (only when the grass casts shadows). */
  private grassDepthMaterial(
    tex: THREE.Texture,
    cols: Record<string, THREE.IUniform>,
  ): THREE.MeshDepthMaterial {
    const depth = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      map: tex,
      alphaTest: 0.4,
      side: THREE.DoubleSide,
    });
    const u = this.grassU;
    depth.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u, cols);
      shader.vertexShader = `${GRASS_VERT_PARS}${shader.vertexShader}`.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>\n${GRASS_VERT_WIND}`,
      );
    };
    return depth;
  }

  /**
   * Distribution of both species. Instead of evenly spread single clumps, a
   * whole TUSSOCK is placed at every accepted point (1..n clumps around it) –
   * that yields dense nests and real gaps instead of a raster field. Height,
   * size and hue are shared per tussock, with scatter per clump; the species is
   * decided by its own noise field (broad leaf in the hollows, marram grass on
   * the crests). Toward the world edge the density thins out so that the grass
   * area does not end along a line.
   */
  private grassSpots(cfg: TierCfg, nBroad: number): GrassSpot[] {
    const rng = mulberry32(0x5eed42);
    const total = cfg.clumps;
    const spots: GrassSpot[] = [];
    let broadLeft = nBroad;
    let tallLeft = total - nBroad;
    let guard = 0;
    while (spots.length < total && guard < total * 40) {
      guard++;
      const cx = (rng() - 0.5) * 756;
      const cz = 40 + rng() * 338;
      const d = cz - shoreZ(cx);
      if (d < 44) continue;
      const ch = terrainHeight(cx, cz);
      if (ch < 2.4) continue;
      const rel = duneRelief(cx, cz, ch);
      const crown = smoothstep(0.1, 1.6, rel);
      let p: number;
      if (d < 62) {
        // scattered tussocks on high spots of the beach fringe
        p = fbm(cx * 0.09, cz * 0.09, 3) > 0.6 ? 0.03 : 0;
      } else {
        // Every hilltop carries growth (noise thins it out), noise patches hold
        // dense tussock fields, the valleys only scattered tussocks; thinner on
        // steep slopes. The thresholds are tuned to the now considerably higher
        // dunes: fbm practically never exceeds 0.55, so with the old patch
        // threshold (0.5..0.6) dense fields did not occur at all any more; and
        // marram grass grows precisely on the dune flanks – only the steepest
        // scarps stay bare.
        const mask = fbm(cx * 0.02 + 9, cz * 0.02, 3);
        const patch = smoothstep(0.42, 0.55, mask);
        const thin = 0.3 + 0.7 * smoothstep(0.28, 0.5, mask);
        const gx = terrainHeight(cx + 1.5, cz) - terrainHeight(cx - 1.5, cz);
        const gz = terrainHeight(cx, cz + 1.5) - terrainHeight(cx, cz - 1.5);
        const slope = Math.hypot(gx, gz) / 3;
        p =
          (crown * crown * 0.5 * thin + patch * (0.1 + 0.9 * crown) + 0.01) *
          (1 - 0.5 * smoothstep(0.45, 1, slope));
      }
      const rich = clamp(p * 2.2, 0, 1);
      // Thin out toward the world edge (z up to 380, x up to ±378)
      p *=
        (1 - smoothstep(318, 376, cz)) *
        (1 - 0.85 * smoothstep(316, 376, Math.abs(cx)));
      // Built places: bare ruin floors, scarp faces, lane floor and paths;
      // lusher on the grassed-over tip
      p *= landformVegetation(cx, cz, d);
      if (rng() > p || keepClear(cx, cz)) continue;

      // Species per tussock: the broad leaf prefers sheltered hollows
      const bMask = fbm(cx * 0.045 + 130, cz * 0.045 + 61, 2);
      const bP = clamp(
        (0.12 + 0.88 * smoothstep(0.44, 0.6, bMask)) * (1 - 0.55 * crown),
        0,
        1,
      );
      let broad = rng() < bP;
      if (broad && broadLeft <= 0) broad = false;
      else if (!broad && tallLeft <= 0) broad = true;

      // Tussock size and shared properties: ~1.7 clumps on average, up to 5 in
      // lush spots – enough for dense nests without thinning out the area.
      const n = 1 + Math.floor(rng() ** 2 * (1 + 4 * rich));
      const spread = (0.35 + rng() * 0.7) * (1 + 2.2 * rich);
      const clumpS = broad
        ? 0.8 + rng() ** 1.2 * 0.85
        : 0.72 + rng() ** 1.3 * 0.8;
      const clumpH = broad ? 0.7 + rng() * 0.6 : 0.6 + rng() ** 1.2 * 0.9;
      const clumpCv = broad ? rng() * 0.55 : 0.2 + rng() * 0.8;
      const dryN = fbm(cx * 0.03 + 50, cz * 0.03 + 11, 2);
      const clumpDry = clamp(
        (dryN - 0.38) * 2.4 + (rng() - 0.5) * 0.4 + (1 - crown) * 0.3,
        0,
        1,
      );

      for (let k = 0; k < n && spots.length < total; k++) {
        const a = rng() * Math.PI * 2;
        const r = spread * rng() ** 0.6;
        const x = cx + Math.cos(a) * r;
        const z = cz + Math.sin(a) * r;
        if (keepClear(x, z)) continue;
        const h = terrainHeight(x, z);
        if (h < 2.2) continue;
        spots.push({
          x,
          y: h - 0.03,
          z,
          ry: rng() * Math.PI * 2,
          tiltX: (rng() - 0.5) * 0.18,
          tiltZ: (rng() - 0.5) * 0.18,
          s: clumpS * (0.85 + rng() * 0.3),
          hs: clumpH * (0.82 + rng() * 0.36),
          dry: clamp(clumpDry + (rng() - 0.5) * 0.22, 0, 1),
          cv: clamp(clumpCv + (rng() - 0.5) * 0.24, 0, 1),
          broad,
        });
        if (broad) broadLeft--;
        else tallLeft--;
      }
    }
    return spots;
  }

  private buildGrass(cfg: TierCfg): void {
    const nBroad = Math.round(cfg.clumps * cfg.broadShare);
    const spots = this.grassSpots(cfg, nBroad);
    const rng = mulberry32(0x9a55ed);

    const texA = grassBladeStripes();
    const texB = broadLeafTexture();
    this.textures.push(texA, texB);
    const species = [
      {
        name: "grass",
        geo: buildGrassClump(cfg.blades, cfg.fillers, mulberry32(7)),
        mat: this.grassMaterial(texA, this.grassColA),
        tex: texA,
        cols: this.grassColA as Record<string, THREE.IUniform>,
        broad: false,
      },
      {
        name: "grassBroad",
        geo: buildBroadClump(cfg.broadLeaves, cfg.broadFillers, mulberry32(19)),
        mat: this.grassMaterial(texB, this.grassColB),
        tex: texB,
        cols: this.grassColB as Record<string, THREE.IUniform>,
        broad: true,
      },
    ];

    for (const sp of species) {
      const list = spots.filter((s) => s.broad === sp.broad);
      const n = Math.max(1, list.length);
      const inst = new Float32Array(n * 4);
      const mesh = new THREE.InstancedMesh(sp.geo, sp.mat, n);
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        this.setInstance(mesh, i, s.x, s.y, s.z, s.tiltX, s.ry, s.tiltZ, s.s);
        const o = i * 4;
        inst[o] = rng(); // phase
        inst[o + 1] = s.hs; // height factor
        inst[o + 2] = s.dry;
        inst[o + 3] = s.cv; // color variation
      }
      sp.geo.setAttribute("aInst", new THREE.InstancedBufferAttribute(inst, 4));
      mesh.receiveShadow = true;
      mesh.castShadow = cfg.grassShadow;
      if (cfg.grassShadow) {
        mesh.customDepthMaterial = this.grassDepthMaterial(sp.tex, sp.cols);
      }
      mesh.name = sp.name;
      this.finish(mesh, list.length);
    }
  }

  // ---------------------------------------------------------------------
  // Low ground cover (the fringe in front of the dunes)
  // ---------------------------------------------------------------------
  private buildGroundCover(cfg: TierCfg): void {
    const rng = mulberry32(0xc0ffee);
    const geo = buildGroundCover(mulberry32(3));
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      roughness: 0.85,
      metalness: 0,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, cfg.cover);
    const col = new THREE.Color();
    let placed = 0;
    let guard = 0;
    while (placed < cfg.cover && guard < cfg.cover * 40) {
      guard++;
      const x = (rng() - 0.5) * 756;
      const z = 20 + rng() * 300;
      const d = z - shoreZ(x);
      if (d < 46 || keepClear(x, z)) continue;
      const h = terrainHeight(x, z);
      const rel = duneRelief(x, z, h);
      const mask = fbm(x * 0.035 + 77, z * 0.035 + 5, 3);
      // Densest in the fringe in front of the dunes, rarer on the crests
      const band = smoothstep(46, 60, d) * (1 - smoothstep(110, 200, d));
      const p =
        (0.05 + 0.75 * band) *
        smoothstep(0.45, 0.62, mask) *
        (1 - 0.7 * smoothstep(1.5, 3, rel)) *
        landformVegetation(x, z, d);
      if (rng() > p) continue;
      const s = 0.7 + rng() * 0.8;
      this.setInstance(
        mesh,
        placed,
        x,
        h - 0.005,
        z,
        (rng() - 0.5) * 0.2,
        rng() * Math.PI * 2,
        (rng() - 0.5) * 0.2,
        s,
      );
      // slight variation, occasionally reddish-violet (sea rocket)
      const purple = rng() < 0.15 ? 0.25 : 0;
      col.setRGB(
        0.8 + rng() * 0.35 + purple,
        0.8 + rng() * 0.35 - purple * 0.6,
        0.8 + rng() * 0.35 + purple * 0.3,
      );
      mesh.setColorAt(placed, col);
      placed++;
    }
    mesh.receiveShadow = true;
    mesh.name = "groundcover";
    this.finish(mesh, placed);
  }

  // ---------------------------------------------------------------------
  // Rocks (three shape variants, one material)
  // ---------------------------------------------------------------------
  private buildRocks(cfg: TierCfg): { x: number; z: number }[] {
    const rng = mulberry32(0x0c0ffee);
    const { map, normalMap } = rockTextures();
    this.textures.push(map, normalMap);
    const mat = new THREE.MeshStandardMaterial({
      map,
      normalMap,
      normalScale: new THREE.Vector2(0.9, 0.9),
      roughness: 0.93,
      metalness: 0,
    });
    const ru = this.rockU;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, ru);
      shader.vertexShader = `${ROCK_VERT_PARS}${shader.vertexShader}`.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>\n${ROCK_VERT_BODY}`,
      );
      shader.fragmentShader =
        `${ROCK_FRAG_PARS}${SHORE_GLSL}${shader.fragmentShader}`
          .replace("#include <map_fragment>", ROCK_FRAG_MAP)
          .replace(
            "#include <roughnessmap_fragment>",
            `#include <roughnessmap_fragment>\n${ROCK_FRAG_ROUGH}`,
          )
          .replace("#include <normal_fragment_maps>", ROCK_FRAG_NORMAL)
          .replace(
            "#include <lights_fragment_end>",
            `#include <lights_fragment_end>\n${ROCK_FRAG_LIGHT}`,
          );
    };

    const pick = (): RockVariant => {
      const r = rng();
      return r < 0.34 ? 0 : r < 0.67 ? 1 : 2;
    };
    const defs: RockDef[] = [];
    // Scattered single rocks, concentrated near the shore zone
    for (let i = 0; i < 44; i++) {
      const x = (rng() - 0.5) * 740;
      const z = shoreZ(x) - 6 + rng() ** 1.6 * 130;
      if (keepClear(x, z)) continue;
      defs.push({ v: pick(), x, z, s: 0.5 + rng() ** 2 * 2.6 });
    }
    // Rocky headland (x 240..360): rock groups at the shore, partly in the water
    const clusters: { x: number; z: number }[] = [];
    for (let c = 0; c < 6; c++) {
      const cx = 250 + rng() * 105;
      const cz = shoreZ(cx) - 10 + rng() * 34;
      clusters.push({ x: cx, z: cz });
      const n = 5 + Math.floor(rng() * 5);
      for (let i = 0; i < n; i++) {
        const a = rng() * Math.PI * 2;
        const r = rng() ** 0.7 * (3 + rng() * 5);
        defs.push({
          v: rng() < 0.5 ? 2 : pick(),
          x: cx + Math.cos(a) * r,
          z: cz + Math.sin(a) * r,
          s: 0.8 + rng() ** 1.5 * 3,
        });
      }
      defs.push({ v: 1, x: cx, z: cz, s: 3 + rng() * 2.2 });
    }

    const variants: RockVariant[] = [0, 1, 2];
    for (const v of variants) {
      const list = defs.filter((d) => d.v === v);
      if (list.length === 0) continue;
      const geo = buildRock(v, cfg.rockDetail, v * 3 + 1);
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      const sink = v === 2 ? 0.14 : 0.36;
      const tilt = v === 2 ? 0.2 : 0.35;
      for (let i = 0; i < list.length; i++) {
        const d = list[i];
        const h = terrainHeight(d.x, d.z);
        this.setInstance(
          mesh,
          i,
          d.x,
          h - d.s * sink,
          d.z,
          (rng() - 0.5) * tilt,
          rng() * Math.PI * 2,
          (rng() - 0.5) * tilt,
          d.s,
        );
      }
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `rocks${v}`;
      this.finish(mesh, list.length);
    }
    return clusters;
  }

  // ---------------------------------------------------------------------
  // Pebbles: the wrack line and around the rock groups
  // ---------------------------------------------------------------------
  private buildPebbles(
    cfg: TierCfg,
    clusters: { x: number; z: number }[],
  ): void {
    const rng = mulberry32(0x9ebb1e);
    const geo = buildPebble(2.5);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.75,
      metalness: 0,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, cfg.pebbles);
    const col = new THREE.Color();
    for (let i = 0; i < cfg.pebbles; i++) {
      let x: number;
      let z: number;
      if (rng() < 0.4 && clusters.length > 0) {
        const c = clusters[Math.floor(rng() * clusters.length)];
        const a = rng() * Math.PI * 2;
        const r = 1 + rng() ** 0.6 * 9;
        x = c.x + Math.cos(a) * r;
        z = c.z + Math.sin(a) * r;
      } else {
        x = (rng() - 0.5) * 740;
        z = shoreZ(x) + 3.5 + rng() * 5;
      }
      const h = terrainHeight(x, z);
      const s = 0.03 + rng() ** 1.5 * 0.07;
      this.setInstance(
        mesh,
        i,
        x,
        h - s * 0.2,
        z,
        rng() * 0.5,
        rng() * Math.PI * 2,
        rng() * 0.5,
        s,
      );
      const g = 0.35 + rng() * 0.4;
      col.setRGB(
        g * (0.9 + rng() * 0.2),
        g * (0.88 + rng() * 0.12),
        g * (0.8 + rng() * 0.15),
        THREE.SRGBColorSpace,
      );
      mesh.setColorAt(i, col);
    }
    mesh.receiveShadow = true;
    mesh.name = "pebbles";
    this.finish(mesh, cfg.pebbles);
  }

  // ---------------------------------------------------------------------
  // Shells: fan, clam, spiral – dense along the wrack line, scattered elsewhere
  // ---------------------------------------------------------------------
  private buildShells(cfg: TierCfg): void {
    const rng = mulberry32(0x5ea5e11);
    const { map, normalMap } = shellTextures();
    this.textures.push(map, normalMap);
    const mat = new THREE.MeshStandardMaterial({
      map,
      normalMap,
      normalScale: new THREE.Vector2(0.6, 0.6),
      color: 0xd6cfc2, // the texture is bright – otherwise blown out in sunlight
      // ≥ 0.6: below that the tiny shells sparkle in the distance (specular
      // aliasing), which the bloom blows up into white dots.
      roughness: 0.62,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    const kinds = [
      { geo: buildFanShell(), share: 0.5, name: "shellsFan" },
      { geo: buildClamShell(), share: 0.3, name: "shellsClam" },
      { geo: buildSpiralShell(), share: 0.2, name: "shellsSpiral" },
    ];
    for (const k of kinds) {
      const n = Math.round(cfg.shells * k.share);
      const mesh = new THREE.InstancedMesh(k.geo, mat, n);
      for (let i = 0; i < n; i++) {
        const wrack = rng() < 0.7;
        const x = (rng() - 0.5) * 740;
        const z = wrack
          ? shoreZ(x) + 4.5 + rng() * 3.5
          : shoreZ(x) + 8 + rng() ** 2 * 50;
        const h = terrainHeight(x, z);
        const s = 0.045 + rng() * 0.06;
        this.setInstance(
          mesh,
          i,
          x,
          h + 0.004,
          z,
          (rng() - 0.5) * 0.3,
          rng() * Math.PI * 2,
          (rng() - 0.5) * 0.3,
          s,
        );
      }
      mesh.receiveShadow = true;
      mesh.name = k.name;
      this.finish(mesh, n);
    }
  }

  update(dt: number, env: Environment, camPos: THREE.Vector3): void {
    this.pines.update(dt, env, camPos);
    const g = this.grassU;
    g.uTime.value = env.envTime;
    g.uWind.value = clamp(env.wind, 0, 1);
    // The wind blows toward +x like the clouds, with a slowly meandering direction
    const a = 0.28 * Math.sin(env.envTime * 0.045);
    g.uWindDir.value.set(Math.cos(a), Math.sin(a));
    g.uSunDir.value.copy(env.isDay ? env.sunDir : env.moonDir);
    g.uBacklight.value = env.isDay
      ? 0.9 * env.dayI * (1 - env.cloud * 0.85)
      : 0.06 * env.moonI;
    this.rockU.uTime.value = env.envTime;
    // Sky reflection on wet rocks: the dome color above the sea horizon
    this.rockU.uSkyCol.value.copy(env.horizonSea);
  }

  dispose(): void {
    this.pines.dispose();
    this.parent.remove(this.group);
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as
        | THREE.Material
        | THREE.Material[]
        | undefined;
      if (mat) for (const mm of Array.isArray(mat) ? mat : [mat]) mm.dispose();
      if (mesh.customDepthMaterial) mesh.customDepthMaterial.dispose();
      const im = o as THREE.InstancedMesh;
      if (im.isInstancedMesh) im.dispose();
    });
    for (const t of this.textures) t.dispose();
    this.textures.length = 0;
  }
}
