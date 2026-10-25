// World: terrain mesh (beach + dunes, wet sand along the wave line and in the
// rain) and footprints; keeps the sea (ocean.ts) and the vegetation
// (vegetation.ts) as separate modules. The terrain maths lives in terrain.ts,
// sky/weather in sky.ts.
//
// The terrain is a non-uniform grid: as dense as before inside the play zone,
// growing geometrically outwards up to 1500 m. That way the edge of the land
// dissolves into the haze instead of ending at a hard border. It is paid for
// by a coarse grid in deep water (net +6 % triangles on "ultra", +22 % on
// "low", still a single draw call).

import * as THREE from "three";
import { lerp, smoothstep } from "./noise";
import { Ocean } from "./ocean";
import type { Environment } from "./sky";
import { SHORE_GLSL, shoreZ, terrainHeight } from "./terrain";
import { footprintTexture, sandAlbedo, sandNormal } from "./textures";
import type { QualityId } from "./types";
import { Vegetation } from "./vegetation";
import { CoastalFlowers } from "./vegetation-flowers";

// Backwards-compatible re-exports: jeep/player/trash/companions/station still
// import the terrain functions and the Environment type from here.
export { Environment } from "./sky";
export {
  WORLD_BOUNDS,
  sectorAt,
  shoreZ,
  terrainHeight,
  waveReach,
} from "./terrain";

/** Dense play zone of the terrain (as before) in m. */
const NEAR_X = 410;
const NEAR_Z0 = -140;
const NEAR_Z1 = 420;
/** Seaward of this the floor is ≥ 2 m deep and flat – a coarse grid is fine. */
const DEEP_Z = -90;
/** Range of the distant backdrop; the fog is practically opaque out there. */
const FAR_EDGE = 1500;
/** Tile size of the sand texture in m (u/v are computed directly in metres). */
const TILE_X = (NEAR_X * 2) / 70;
const TILE_Z = (NEAR_Z1 - NEAR_Z0) / 48;
/** Where the sea floor runs out – beyond it land starts at the water line. */
const SEA_EDGE = 410;
/** From this grid spacing on the height is filtered (aliasing at distance). */
const FILTER_SPACING = 9;

/** Geometrically growing sample points from `a` (exclusive) to `b`. */
function graded(a: number, b: number, first: number, growth: number): number[] {
  const out: number[] = [];
  const dir = b > a ? 1 : -1;
  let v = a;
  let step = first;
  while (out.length < 64) {
    v += dir * step;
    if ((b - v) * dir <= step * 0.5) break;
    out.push(v);
    step *= growth;
  }
  out.push(b);
  return out;
}

/** Low-pass over the local grid spacing: the coarse far zone stays calm. */
function filteredHeight(x: number, z: number, r: number): number {
  const q = r * 0.35;
  return (
    terrainHeight(x, z) * 0.4 +
    (terrainHeight(x - q, z) +
      terrainHeight(x + q, z) +
      terrainHeight(x, z - q) +
      terrainHeight(x, z + q)) *
      0.15
  );
}

export class World {
  readonly group = new THREE.Group();
  private scene: THREE.Scene;
  private terrainUniforms = {
    uTime: { value: 0 },
    uWet: { value: 0 },
    uCloud: { value: 0 },
  };
  private ocean: Ocean;
  private vegetation: Vegetation;
  private flowers: CoastalFlowers;
  private terrain!: THREE.Mesh;
  private footprintGeo!: THREE.BufferGeometry;
  private footprintPool: THREE.Mesh[] = [];
  private footprintAges: number[] = [];
  private footprintIdx = 0;
  /** Smoothed rain wetness of the sand (wets fast, dries slowly). */
  private wet = 0;
  private wetInit = false;

  constructor(scene: THREE.Scene, quality: QualityId) {
    this.scene = scene;
    scene.add(this.group);
    this.buildTerrain(quality);
    this.ocean = new Ocean(this.group, quality);
    this.vegetation = new Vegetation(this.group, quality);
    this.flowers = new CoastalFlowers(this.group, quality);
    this.buildFootprints();
  }

  /**
   * Grid: uniform inside the play zone, growing geometrically outside. The sea
   * floor still ends further out at |x| ≈ 410 as before (beyond that the
   * distant sea turns transparent – the floor must not show through there);
   * the rows before it are pulled together onto the shoreline.
   */
  private terrainGeometry(quality: QualityId): THREE.BufferGeometry {
    const seg =
      quality === "ultra"
        ? 300
        : quality === "high"
          ? 240
          : quality === "medium"
            ? 170
            : 120;
    const segZ = Math.floor(seg * 0.7);
    const stepX = (NEAR_X * 2) / seg;
    const stepZ = (NEAR_Z1 - NEAR_Z0) / segZ;
    const xs: number[] = [];
    for (let i = 0; i <= seg; i++) xs.push(-NEAR_X + i * stepX);
    const outX = graded(NEAR_X, FAR_EDGE, stepX * 1.6, 1.55);
    xs.push(...outX);
    xs.unshift(...outX.map((v) => -v).reverse());
    const zs: number[] = [];
    // Resolve deep water coarsely (several metres below the surface, never
    // touched by the wash film) – this pays for the distant backdrop
    zs.push(...graded(DEEP_Z, NEAR_Z0, stepZ * 1.6, 1.5).reverse());
    const nZ = Math.max(1, Math.round((NEAR_Z1 - DEEP_Z) / stepZ));
    for (let j = 0; j <= nZ; j++)
      zs.push(DEEP_Z + (j * (NEAR_Z1 - DEEP_Z)) / nZ);
    zs.push(...graded(NEAR_Z1, FAR_EDGE, stepZ * 1.6, 1.55));

    const cols = xs.length;
    const rows = zs.length;
    // Local grid spacing per column/row (for the low-pass in the distance)
    const spX = new Float32Array(cols);
    for (let i = 0; i < cols; i++) {
      spX[i] = Math.max(
        i > 0 ? xs[i] - xs[i - 1] : 0,
        i < cols - 1 ? xs[i + 1] - xs[i] : 0,
      );
    }
    const spZ = new Float32Array(rows);
    for (let j = 0; j < rows; j++) {
      spZ[j] = Math.max(
        j > 0 ? zs[j] - zs[j - 1] : 0,
        j < rows - 1 ? zs[j + 1] - zs[j] : 0,
      );
    }
    const pos = new Float32Array(cols * rows * 3);
    const uv = new Float32Array(cols * rows * 2);
    for (let i = 0; i < cols; i++) {
      const x = xs[i];
      const zMin = lerp(
        NEAR_Z0,
        shoreZ(x) + 8,
        smoothstep(SEA_EDGE, 470, Math.abs(x)),
      );
      for (let j = 0; j < rows; j++) {
        const z = Math.max(zs[j], zMin);
        const sp = Math.max(spX[i], spZ[j]);
        const k = (j * cols + i) * 3;
        pos[k] = x;
        pos[k + 1] =
          sp > FILTER_SPACING ? filteredHeight(x, z, sp) : terrainHeight(x, z);
        pos[k + 2] = z;
        const u = (j * cols + i) * 2;
        uv[u] = (x + NEAR_X) / TILE_X;
        uv[u + 1] = (NEAR_Z1 - z) / TILE_Z;
      }
    }
    const idx = new Uint32Array((cols - 1) * (rows - 1) * 6);
    let n = 0;
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const a = j * cols + i;
        const b = a + cols;
        idx[n++] = a;
        idx[n++] = b;
        idx[n++] = a + 1;
        idx[n++] = a + 1;
        idx[n++] = b;
        idx[n++] = b + 1;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }

  private buildTerrain(quality: QualityId): void {
    const geo = this.terrainGeometry(quality);
    const mat = new THREE.MeshStandardMaterial({
      map: sandAlbedo(),
      normalMap: sandNormal(),
      normalScale: new THREE.Vector2(0.7, 0.7),
      roughness: 0.95,
      metalness: 0,
    });
    // Tiling is baked into the UVs (the grid is no longer uniform)
    mat.map?.repeat.set(1, 1);
    mat.normalMap?.repeat.set(1, 1);
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.terrainUniforms.uTime;
      shader.uniforms.uWet = this.terrainUniforms.uWet;
      shader.uniforms.uCloud = this.terrainUniforms.uCloud;
      shader.vertexShader =
        `varying vec3 vWorldPos;\n${shader.vertexShader}`.replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\n vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;",
        );
      shader.fragmentShader =
        `varying vec3 vWorldPos;\nuniform float uTime;\nuniform float uWet;\nuniform float uCloud;\n${SHORE_GLSL}
         float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
         float wNoise(vec2 p) {
           vec2 i = floor(p); vec2 f = p - i;
           f = f * f * (3.0 - 2.0 * f);
           float a = wHash(i), b = wHash(i + vec2(1.0, 0.0));
           float c = wHash(i + vec2(0.0, 1.0)), d = wHash(i + vec2(1.0, 1.0));
           return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
         }
         float wetSand;
         ${shader.fragmentShader}`
          .replace(
            "#include <color_fragment>",
            `#include <color_fragment>
           float dShore = vWorldPos.z - shoreZf(vWorldPos.x);
           float reach = waveReachF(uTime);
           wetSand = 1.0 - smoothstep(reach, reach + 6.0, dShore);
           wetSand = max(wetSand, 1.0 - smoothstep(-0.5, 0.4, dShore));
           // Rain: the whole beach soaks up water, hollows stay darker
           float pud = wNoise(vWorldPos.xz * 0.085) * 0.65
                     + wNoise(vWorldPos.xz * 0.31) * 0.35;
           float rainWet = uWet * (0.5 + 0.5 * smoothstep(0.32, 0.68, pud));
           wetSand = max(wetSand, rainWet * 0.85);
           diffuseColor.rgb *= mix(1.0, 0.6, wetSand);
           // Under a closed cloud deck the warm sunlight is missing: the sand
           // then reads as grey-beige. The light is already neutral (sky.ts),
           // the remaining warmth sits in the albedo itself - desaturate and
           // cool it slightly here, or the beach looks sunny under grey skies.
           float grey = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
           diffuseColor.rgb = mix(
             diffuseColor.rgb,
             vec3(grey) * vec3(0.97, 0.99, 1.05),
             uCloud * 0.42);
          `,
          )
          .replace(
            "#include <roughnessmap_fragment>",
            `#include <roughnessmap_fragment>
           roughnessFactor = mix(roughnessFactor, 0.3, wetSand);
          `,
          )
          .replace(
            "#include <normal_fragment_maps>",
            `#include <normal_fragment_maps>
           // Wet sand is smooth: dial the ripple normals back, otherwise the
           // tiling of the normal map reflects back visibly
           normal = normalize(mix(normal, nonPerturbedNormal, wetSand * 0.6));
          `,
          );
    };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = "terrain";
    this.terrain = mesh;
    this.group.add(mesh);
  }

  private buildFootprints(): void {
    const tex = footprintTexture();
    const geo = new THREE.PlaneGeometry(0.24, 0.4);
    geo.rotateX(-Math.PI / 2);
    this.footprintGeo = geo;
    for (let i = 0; i < 90; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 1;
      mesh.visible = false;
      this.group.add(mesh);
      this.footprintPool.push(mesh);
      this.footprintAges.push(999);
    }
  }

  stampFootprint(x: number, z: number, yaw: number, side: number): void {
    const i = this.footprintIdx;
    this.footprintIdx = (this.footprintIdx + 1) % this.footprintPool.length;
    const mesh = this.footprintPool[i];
    const off = new THREE.Vector3(
      Math.cos(yaw) * 0.14 * side,
      0,
      -Math.sin(yaw) * 0.14 * side,
    );
    mesh.position.set(
      x + off.x,
      terrainHeight(x + off.x, z + off.z) + 0.015,
      z + off.z,
    );
    mesh.rotation.y = yaw;
    mesh.visible = true;
    this.footprintAges[i] = 0;
  }

  update(dt: number, env: Environment, camPos: THREE.Vector3): void {
    this.terrainUniforms.uTime.value = env.envTime;
    // The sand gets wet within seconds but only dries over minutes
    if (this.wetInit) {
      const rate = env.rain > this.wet ? 0.5 : 0.02;
      this.wet += (env.rain - this.wet) * Math.min(1, dt * rate);
    } else {
      this.wet = env.rain;
      this.wetInit = true;
    }
    this.terrainUniforms.uWet.value = this.wet;
    this.terrainUniforms.uCloud.value = env.cloud;
    this.ocean.update(dt, env, camPos);
    this.vegetation.update(dt, env, camPos);
    this.flowers.update(dt, env, camPos);
    for (let i = 0; i < this.footprintPool.length; i++) {
      if (!this.footprintPool[i].visible) continue;
      this.footprintAges[i] += dt;
      const a = 1 - this.footprintAges[i] / 18;
      const mat = this.footprintPool[i].material as THREE.MeshBasicMaterial;
      if (a <= 0) {
        this.footprintPool[i].visible = false;
      } else {
        mat.opacity = Math.min(0.8, a);
      }
    }
  }

  dispose(): void {
    this.ocean.dispose();
    this.vegetation.dispose();
    this.flowers.dispose();
    this.terrain.geometry.dispose();
    (this.terrain.material as THREE.Material).dispose();
    for (const m of this.footprintPool) {
      (m.material as THREE.Material).dispose();
    }
    this.footprintPool.length = 0;
    this.footprintAges.length = 0;
    this.footprintGeo.dispose();
    // Sand and footprint textures live in the global cache of textures.ts and
    // are reused by a new world – do not release them here.
    this.group.clear();
    this.scene.remove(this.group);
  }
}
