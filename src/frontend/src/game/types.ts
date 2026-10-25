// Core types, categories and balancing data of the game.

export type CategoryId =
  | "GLASS"
  | "PLASTIC"
  | "METAL"
  | "PAPER"
  | "WOOD"
  | "STONE"
  | "CHEMICALS"
  | "GENERAL";

export interface CategoryDef {
  id: CategoryId;
  name: string;
  color: string;
  value: number; // recycling points per item when dropped off
}

export const CATEGORIES: Record<CategoryId, CategoryDef> = {
  GLASS: { id: "GLASS", name: "Glass", color: "#4fd48b", value: 2 },
  PLASTIC: { id: "PLASTIC", name: "Plastic", color: "#ffd23f", value: 1 },
  METAL: { id: "METAL", name: "Metal", color: "#9ecbff", value: 3 },
  PAPER: { id: "PAPER", name: "Paper", color: "#e8e3d5", value: 1 },
  WOOD: { id: "WOOD", name: "Wood", color: "#c98a4b", value: 1 },
  STONE: { id: "STONE", name: "Stone", color: "#b9b3ab", value: 1 },
  CHEMICALS: { id: "CHEMICALS", name: "Chemicals", color: "#ff6b6b", value: 5 },
  GENERAL: { id: "GENERAL", name: "General waste", color: "#c9a6e0", value: 1 },
};

export interface TrashTypeDef {
  id: string;
  name: string;
  category: CategoryId;
  weight: number; // kg
  spawnWeight: number; // relative frequency
  nearWater?: boolean; // prefers spots near the water line
}

// > 20 clearly distinguishable trash types (geometry builders in trash.ts).
export const TRASH_TYPES: TrashTypeDef[] = [
  {
    id: "glass_green",
    name: "Glass bottle (green)",
    category: "GLASS",
    weight: 0.4,
    spawnWeight: 6,
  },
  {
    id: "glass_brown",
    name: "Glass bottle (brown)",
    category: "GLASS",
    weight: 0.4,
    spawnWeight: 5,
  },
  {
    id: "plastic_bottle",
    name: "Plastic bottle",
    category: "PLASTIC",
    weight: 0.05,
    spawnWeight: 10,
  },
  {
    id: "can",
    name: "Drink can",
    category: "METAL",
    weight: 0.03,
    spawnWeight: 8,
  },
  {
    id: "can_crushed",
    name: "Crushed can",
    category: "METAL",
    weight: 0.03,
    spawnWeight: 6,
  },
  {
    id: "coaster",
    name: "Beer mat",
    category: "PAPER",
    weight: 0.01,
    spawnWeight: 4,
  },
  {
    id: "newspaper",
    name: "Newspaper",
    category: "PAPER",
    weight: 0.2,
    spawnWeight: 5,
  },
  {
    id: "paper_ball",
    name: "Paper ball",
    category: "PAPER",
    weight: 0.02,
    spawnWeight: 6,
  },
  {
    id: "cardboard",
    name: "Cardboard box",
    category: "PAPER",
    weight: 0.3,
    spawnWeight: 4,
  },
  {
    id: "plastic_bag",
    name: "Plastic bag",
    category: "PLASTIC",
    weight: 0.02,
    spawnWeight: 7,
  },
  {
    id: "crisp_packet",
    name: "Crisp packet",
    category: "PLASTIC",
    weight: 0.03,
    spawnWeight: 5,
  },
  {
    id: "plank",
    name: "Wooden plank",
    category: "WOOD",
    weight: 1.4,
    spawnWeight: 4,
  },
  {
    id: "branch",
    name: "Branch",
    category: "WOOD",
    weight: 0.8,
    spawnWeight: 5,
  },
  {
    id: "driftwood",
    name: "Driftwood",
    category: "WOOD",
    weight: 2.2,
    spawnWeight: 3,
    nearWater: true,
  },
  {
    id: "rubble",
    name: "Rubble",
    category: "STONE",
    weight: 2.8,
    spawnWeight: 3,
  },
  {
    id: "sheet_metal",
    name: "Rusty sheet metal",
    category: "METAL",
    weight: 1.6,
    spawnWeight: 3,
  },
  {
    id: "cable",
    name: "Coiled cable",
    category: "METAL",
    weight: 0.35,
    spawnWeight: 4,
  },
  {
    id: "fishing_line",
    name: "Fishing line",
    category: "PLASTIC",
    weight: 0.12,
    spawnWeight: 4,
    nearWater: true,
  },
  {
    id: "net",
    name: "Net fragment",
    category: "PLASTIC",
    weight: 1.1,
    spawnWeight: 3,
    nearWater: true,
  },
  {
    id: "canister",
    name: "Jerrycan",
    category: "CHEMICALS",
    weight: 1.2,
    spawnWeight: 3,
  },
  {
    id: "drum",
    name: "Chemical drum",
    category: "CHEMICALS",
    weight: 1.4,
    spawnWeight: 2,
  },
  {
    id: "spray_can",
    name: "Spray can",
    category: "CHEMICALS",
    weight: 0.25,
    spawnWeight: 3,
  },
  {
    id: "tool",
    name: "Broken tool",
    category: "METAL",
    weight: 0.9,
    spawnWeight: 2,
  },
  {
    id: "flip_flop",
    name: "Single flip-flop",
    category: "GENERAL",
    weight: 0.1,
    spawnWeight: 4,
  },
  {
    id: "old_bucket",
    name: "Old bucket",
    category: "PLASTIC",
    weight: 0.25,
    spawnWeight: 2,
  },
];

export const TRASH_BY_ID: Record<string, TrashTypeDef> = Object.fromEntries(
  TRASH_TYPES.map((t) => [t.id, t]),
);

/** All category ids in a fixed order (iteration, round-robin, UI lists). */
export const CATEGORY_IDS: readonly CategoryId[] = [
  "GLASS",
  "PLASTIC",
  "METAL",
  "PAPER",
  "WOOD",
  "STONE",
  "CHEMICALS",
  "GENERAL",
];

// ---------------------------------------------------------------------------
// Recycling materials
// ---------------------------------------------------------------------------
// The station does not just make trash disappear: it sorts by material and
// bales/shreds it into a tradable commodity. Every category yields exactly one
// commodity; `itemsPerUnit` pieces of trash become one unit of it (e.g. 10
// plastic bottles → 1 kg PET flakes). The ids and the rates are shared with the
// backend marketplace – do not change them without changing the backend too.

export type MaterialId =
  | "glass_cullet"
  | "pet_flake"
  | "metal_scrap"
  | "paper_pulp"
  | "wood_chips"
  | "aggregate"
  | "chem_recovered"
  | "rdf_pellets";

export interface MaterialDef {
  id: MaterialId;
  name: string;
  unit: string; // "kg" / "L"
  category: CategoryId; // the trash category it is recovered from
  itemsPerUnit: number; // pieces of trash per unit
  /**
   * What the station's wholesale desk pays, in whole cents per unit. It sits
   * 12 % below the exchange's oracle reference price (`marketPrices()` on the
   * backend returns both), because the desk has unlimited liquidity and no
   * price impact – the exchange beats it on any sane trade size.
   *
   * The oracle prices are the REAL 2025/26 secondary-commodity prices scaled
   * by ONE factor, 2.52, pinned so PET flake keeps its historic $3.50/unit.
   * Everything else therefore keeps its real relative value. The backend table
   * in `src/backend/lib/Validate.mo` is the single source of truth and carries
   * the same numbers plus the full source citations.
   *
   *   id              real $/unit  source (short)          oracle ¢  wholesale ¢
   *   glass_cullet    0.079 /kg    businessanalytiq cullet   19.908       17
   *   pet_flake       1.39  /kg    ChemAnalyst US r-PET     350.280      308
   *   metal_scrap     0.42  /kg    ScrapMonster shredded    105.840       93
   *   paper_pulp      0.085 /kg    SMP OCC index             21.420       18
   *   wood_chips      0.037 /kg    Ryegate VT biomass         9.324        8
   *   aggregate       0.020 /kg    USGS MCS 2026 stone        5.040        4
   *   chem_recovered  0.67  /L     virgin solvent -40 %     168.840      148
   *   rdf_pellets     0.05  /kg    RDF into cement kilns     12.600       11
   *
   * Note that RDF has a NEGATIVE value in the real UK/EU market (the producer
   * pays a gate fee); the positive high-spec SRF price is used instead.
   * All of this is fictional in-game money with no real-world value.
   */
  basePriceCents: number;
}

export const MATERIALS: Record<MaterialId, MaterialDef> = {
  glass_cullet: {
    id: "glass_cullet",
    name: "Glass cullet",
    unit: "kg",
    category: "GLASS",
    itemsPerUnit: 8,
    basePriceCents: 17,
  },
  pet_flake: {
    id: "pet_flake",
    name: "PET flakes",
    unit: "kg",
    category: "PLASTIC",
    itemsPerUnit: 10,
    basePriceCents: 308,
  },
  metal_scrap: {
    id: "metal_scrap",
    name: "Metal scrap",
    unit: "kg",
    category: "METAL",
    itemsPerUnit: 6,
    basePriceCents: 93,
  },
  paper_pulp: {
    id: "paper_pulp",
    name: "Paper pulp",
    unit: "kg",
    category: "PAPER",
    itemsPerUnit: 12,
    basePriceCents: 18,
  },
  wood_chips: {
    id: "wood_chips",
    name: "Wood chips",
    unit: "kg",
    category: "WOOD",
    itemsPerUnit: 5,
    basePriceCents: 8,
  },
  aggregate: {
    id: "aggregate",
    name: "Crushed aggregate",
    unit: "kg",
    category: "STONE",
    itemsPerUnit: 4,
    basePriceCents: 4,
  },
  chem_recovered: {
    id: "chem_recovered",
    name: "Recovered chemicals",
    unit: "L",
    category: "CHEMICALS",
    itemsPerUnit: 3,
    basePriceCents: 148,
  },
  // Mixed waste that cannot be sorted becomes refuse-derived fuel.
  rdf_pellets: {
    id: "rdf_pellets",
    name: "RDF pellets",
    unit: "kg",
    category: "GENERAL",
    itemsPerUnit: 10,
    basePriceCents: 11,
  },
};

/** All material ids in a fixed order (iteration, UI lists). */
export const MATERIAL_IDS: readonly MaterialId[] = [
  "glass_cullet",
  "pet_flake",
  "metal_scrap",
  "paper_pulp",
  "wood_chips",
  "aggregate",
  "chem_recovered",
  "rdf_pellets",
];

/** Which commodity a category is recycled into. */
export const MATERIAL_BY_CATEGORY: Record<CategoryId, MaterialId> = {
  GLASS: "glass_cullet",
  PLASTIC: "pet_flake",
  METAL: "metal_scrap",
  PAPER: "paper_pulp",
  WOOD: "wood_chips",
  STONE: "aggregate",
  CHEMICALS: "chem_recovered",
  GENERAL: "rdf_pellets",
};

/** Is this an id of an existing material? */
export function isMaterialId(id: string): id is MaterialId {
  return Object.hasOwn(MATERIALS, id);
}

/** Cents → dollar string, e.g. 350 → "$3.50". */
export function formatCents(cents: number): string {
  const c = Number.isFinite(cents) ? Math.round(cents) : 0;
  const sign = c < 0 ? "-" : "";
  const abs = Math.abs(c);
  // Thousands separator so "$10,000.00" matches the wording used in the UI
  const whole = Math.floor(abs / 100).toLocaleString("en-GB");
  return `${sign}$${whole}.${String(abs % 100).padStart(2, "0")}`;
}

/** A material record with every id at 0. */
export function emptyMaterials(): Record<MaterialId, number> {
  const out = {} as Record<MaterialId, number>;
  for (const id of MATERIAL_IDS) out[id] = 0;
  return out;
}

/** A category record with every id at 0. */
export function emptyCategoryCounts(): Record<CategoryId, number> {
  const out = {} as Record<CategoryId, number>;
  for (const id of CATEGORY_IDS) out[id] = 0;
  return out;
}

// ---------------------------------------------------------------------------
// World / sectors
// ---------------------------------------------------------------------------

export interface SectorDef {
  id: string;
  name: string;
  x0: number;
  x1: number;
}

export const SECTORS: SectorDef[] = [
  { id: "s0", name: "West Bay", x0: -360, x1: -240 },
  { id: "s1", name: "Old Pier", x0: -240, x1: -120 },
  { id: "s2", name: "Central Beach", x0: -120, x1: 0 },
  { id: "s3", name: "Dune Edge", x0: 0, x1: 120 },
  { id: "s4", name: "East Beach", x0: 120, x1: 240 },
  { id: "s5", name: "Rocky Cape", x0: 240, x1: 360 },
];

export type WeatherId =
  | "sunny"
  | "partly_cloudy"
  | "overcast"
  | "rain"
  | "storm";

export const WEATHER_NAMES: Record<WeatherId, string> = {
  sunny: "Sunny",
  partly_cloudy: "Partly cloudy",
  overcast: "Overcast",
  rain: "Rain",
  storm: "Storm",
};

/** All weather ids, in the order the dev harness documents them. */
export const WEATHER_IDS: readonly WeatherId[] = [
  "sunny",
  "partly_cloudy",
  "overcast",
  "rain",
  "storm",
];

// ---------------------------------------------------------------------------
// Progress / upgrades
// ---------------------------------------------------------------------------

export const XP_PER_PICKUP = 10;
export const XP_PER_DISPOSE = 10;
export const MAX_LEVEL = 250;
export const STATION_CAPACITY = 2000;

export function xpForLevel(level: number): number {
  // XP needed to get from `level` to `level + 1`.
  return 100 + (level - 1) * 18;
}

export function levelFromXp(xp: number): {
  level: number;
  into: number;
  needed: number;
} {
  let level = 1;
  let rest = xp;
  while (level < MAX_LEVEL) {
    const need = xpForLevel(level);
    if (rest < need) return { level, into: rest, needed: need };
    rest -= need;
    level++;
  }
  return { level: MAX_LEVEL, into: 0, needed: 0 };
}

/** Hand tool the player can equip on foot (1/2 keys, mouse wheel). */
export type ToolId = "picker" | "detector";

// ---------------------------------------------------------------------------
// TEST MODE (temporary). To remove the feature later, delete: this block, the
// SaveData `test` field below, the `test`/`toggleTestMode` members in
// state.ts, and the "Testing" section in PauseSettings.tsx.
// ---------------------------------------------------------------------------

/** Snapshot of real progress held while test mode is switched on. */
export interface TestModeData {
  snapshot: {
    xp: number;
    recyclePoints: number;
    upgrades: Record<string, number>;
    lighthouse: { hasKey: boolean; unlocked: boolean; lampOn: boolean };
    tool: ToolId;
  };
}

export interface UpgradeDef {
  id: string;
  name: string;
  desc: string;
  // Value per stage; stage 0 = base.
  values: number[];
  costs: number[]; // points per stage (length = values.length - 1)
  levelReq: number[]; // minimum level per stage
  unit?: string;
}

export const UPGRADES: UpgradeDef[] = [
  {
    id: "bucketCap",
    name: "Bucket capacity",
    desc: "Carry more pieces of trash per round in your bucket.",
    values: [10, 20, 30, 50, 75, 100, 150],
    costs: [50, 150, 400, 900, 1800, 3500],
    levelReq: [2, 5, 9, 14, 20, 28],
    unit: "pcs",
  },
  {
    id: "grabRange",
    name: "Grabber reach",
    desc: "A longer grabber – pick up trash from further away.",
    values: [2.8, 3.4, 4.0, 4.8, 5.8],
    costs: [40, 120, 300, 700],
    levelReq: [2, 6, 11, 17],
    unit: "m",
  },
  {
    id: "grabSpeed",
    name: "Grab speed",
    desc: "A faster pick-up animation.",
    values: [0.45, 0.38, 0.32, 0.26, 0.2],
    costs: [40, 120, 300, 700],
    levelReq: [3, 7, 12, 18],
    unit: "s",
  },
  {
    id: "magnet",
    name: "Magnetic grabber",
    desc: "Bonus points for metal (+1 per stage when you drop it off).",
    values: [0, 1, 2],
    costs: [200, 600],
    levelReq: [8, 16],
    unit: "pts",
  },
  {
    id: "detector",
    name: "Metal detector",
    desc: "A hip-slung detector and trowel – find what the beach has swallowed.",
    values: [0, 1],
    costs: [800],
    levelReq: [10],
  },
  {
    id: "detectorTune",
    name: "Detector tuning",
    desc: "A wider search coil picks up deeper, fainter signals.",
    values: [3.5, 4.5, 6],
    costs: [400, 1000],
    levelReq: [12, 18],
    unit: "m",
  },
  {
    id: "jeepCap",
    name: "Jeep container",
    desc: "A bigger trash container on the flatbed.",
    values: [100, 200, 350, 600, 1000],
    costs: [100, 300, 800, 2000],
    levelReq: [4, 8, 14, 22],
    unit: "pcs",
  },
  {
    id: "jeepEngine",
    name: "Jeep engine",
    desc: "Higher top speed and quicker acceleration.",
    values: [12, 14, 16.5, 19.5],
    costs: [80, 240, 700],
    levelReq: [4, 9, 15],
    unit: "m/s",
  },
  {
    id: "jeepSusp",
    name: "Jeep suspension",
    desc: "Better off-road handling and a smoother ride.",
    values: [0, 1, 2],
    costs: [60, 180],
    levelReq: [5, 10],
  },
  {
    id: "dog",
    name: "Trash-collecting dog",
    desc: "A loyal companion that fetches trash on its own.",
    values: [0, 1],
    costs: [500],
    levelReq: [8],
  },
  {
    id: "dogSpeed",
    name: "Dog training",
    desc: "The dog finds trash faster.",
    values: [9, 7, 5],
    costs: [300, 900],
    levelReq: [10, 15],
    unit: "s",
  },
  {
    id: "drone",
    name: "Trash-collecting drone",
    desc: "An autonomous drone that flies trash straight to the jeep.",
    values: [0, 1],
    costs: [1200],
    levelReq: [15],
  },
  {
    id: "droneSpeed",
    name: "Drone software",
    desc: "Faster scans and flight routes.",
    values: [8, 6, 4.5],
    costs: [600, 1500],
    levelReq: [18, 24],
    unit: "s",
  },
  {
    id: "stationRate",
    name: "Station throughput",
    desc: "The recycling station processes trash faster.",
    values: [1, 2, 4],
    costs: [200, 600],
    levelReq: [6, 12],
    unit: "pcs/s",
  },
];

export const UPGRADE_BY_ID: Record<string, UpgradeDef> = Object.fromEntries(
  UPGRADES.map((u) => [u.id, u]),
);

export function upgradeValue(id: string, stage: number): number {
  const def = UPGRADE_BY_ID[id];
  if (!def) return 0;
  const s = Math.min(stage, def.values.length - 1);
  return def.values[s];
}

// ---------------------------------------------------------------------------
// Missions
// ---------------------------------------------------------------------------

export interface MissionDef {
  id: string;
  name: string;
  desc: string;
  target: number;
  metric:
    | "collected"
    | "disposed"
    | "collectedGlass"
    | "collectedChemicals"
    | "collectedMetal"
    | "level"
    | "jeepLoads"
    | "dogItems"
    | "sectorClean";
  rewardXp: number;
  rewardPoints: number;
}

export const MISSIONS: MissionDef[] = [
  {
    id: "m1",
    name: "First steps",
    desc: "Collect 25 pieces of trash.",
    target: 25,
    metric: "collected",
    rewardXp: 100,
    rewardPoints: 30,
  },
  {
    id: "m2",
    name: "Into the bin",
    desc: "Drop off 25 pieces of trash at the station.",
    target: 25,
    metric: "disposed",
    rewardXp: 120,
    rewardPoints: 40,
  },
  {
    id: "m3",
    name: "Glass harvest",
    desc: "Collect 20 glass items.",
    target: 20,
    metric: "collectedGlass",
    rewardXp: 150,
    rewardPoints: 60,
  },
  {
    id: "m4",
    name: "Logistics",
    desc: "Empty your bucket into the jeep 5 times.",
    target: 5,
    metric: "jeepLoads",
    rewardXp: 120,
    rewardPoints: 50,
  },
  {
    id: "m5",
    name: "Elbow grease",
    desc: "Collect 150 pieces of trash in total.",
    target: 150,
    metric: "collected",
    rewardXp: 300,
    rewardPoints: 120,
  },
  {
    id: "m6",
    name: "Hazardous goods",
    desc: "Collect 12 chemical items.",
    target: 12,
    metric: "collectedChemicals",
    rewardXp: 250,
    rewardPoints: 150,
  },
  {
    id: "m7",
    name: "Scrap collector",
    desc: "Collect 30 metal items.",
    target: 30,
    metric: "collectedMetal",
    rewardXp: 220,
    rewardPoints: 110,
  },
  {
    id: "m8",
    name: "Recycling pro",
    desc: "Drop off 400 pieces of trash in total.",
    target: 400,
    metric: "disposed",
    rewardXp: 600,
    rewardPoints: 260,
  },
  {
    id: "m9",
    name: "Climbing the ranks",
    desc: "Reach level 10.",
    target: 10,
    metric: "level",
    rewardXp: 0,
    rewardPoints: 200,
  },
  {
    id: "m10",
    name: "Best friend",
    desc: "Have the dog fetch you 20 pieces of trash.",
    target: 20,
    metric: "dogItems",
    rewardXp: 250,
    rewardPoints: 140,
  },
  {
    id: "m11",
    name: "Spotless sector",
    desc: "Clean one beach sector to 100 %.",
    target: 1,
    metric: "sectorClean",
    rewardXp: 800,
    rewardPoints: 400,
  },
  {
    id: "m12",
    name: "The big clean-up",
    desc: "Drop off 1500 pieces of trash in total.",
    target: 1500,
    metric: "disposed",
    rewardXp: 1500,
    rewardPoints: 800,
  },
];

// ---------------------------------------------------------------------------
// Settings / Save
// ---------------------------------------------------------------------------

export type QualityId = "ultra" | "high" | "medium" | "low";

/** All quality tiers, best first. */
export const QUALITY_IDS: readonly QualityId[] = [
  "ultra",
  "high",
  "medium",
  "low",
];

export interface Settings {
  quality: QualityId;
  renderScale: number; // 0.5 - 1.0 (fraction of devicePixelRatio)
  shadows: boolean;
  fov: number;
  sensitivity: number;
  invertY: boolean;
  volMaster: number;
  volAmbience: number;
  volSfx: number;
  washUp: boolean; // the tide washes up new trash
}

export const DEFAULT_SETTINGS: Settings = {
  quality: "ultra",
  renderScale: 1,
  shadows: true,
  fov: 75,
  sensitivity: 1,
  invertY: false,
  volMaster: 0.8,
  volAmbience: 0.8,
  volSfx: 0.9,
  washUp: true,
};

export interface StatsData {
  collected: number;
  disposed: number;
  recycled: number;
  byCategoryCollected: Record<string, number>;
  jeepLoads: number;
  dogItems: number;
  droneItems: number;
  distanceWalked: number;
  distanceDriven: number;
  playSeconds: number;
}

export function emptyStats(): StatsData {
  return {
    collected: 0,
    disposed: 0,
    recycled: 0,
    byCategoryCollected: {},
    jeepLoads: 0,
    dogItems: 0,
    droneItems: 0,
    distanceWalked: 0,
    distanceDriven: 0,
    playSeconds: 0,
  };
}

export interface SaveData {
  version: number;
  seed: number;
  playerName: string;
  xp: number;
  recyclePoints: number;
  upgrades: Record<string, number>;
  stats: StatsData;
  missionsDone: string[];
  // Remaining trash items per "sector|type" - the world is generated
  // deterministically from the seed and then reduced to these counts.
  remaining: Record<string, number>;
  /** Total number of items in the station – the sum of `stationQueue`. */
  stationStored: number;
  /** Items waiting to be processed, per category. Missing in old saves. */
  stationQueue: Record<string, number>;
  /** Units of each material owned. Missing in old saves. */
  materials: Record<string, number>;
  /** Leftover items per category below one full unit. Missing in old saves. */
  recycleProgress: Record<string, number>;
  /**
   * Rare finds in the display case: collectible variant id → found at
   * (epoch ms). Missing in old saves.
   */
  collection: Record<string, number>;
  /**
   * Uncollected rare finds lying in the world: variant id → [x, z, yaw], so a
   * reload restores them exactly where they were. Missing in old saves.
   */
  collectSpawns: Record<string, [number, number, number]>;
  /**
   * Lighthouse quest: the keeper's key found, the door unlocked, the lamp
   * switched on. Missing in old saves (all false).
   */
  lighthouse: { hasKey: boolean; unlocked: boolean; lampOn: boolean };
  /** Equipped hand tool; missing in old saves ("picker"). */
  tool: ToolId;
  /** TEST MODE (temporary): non-null while test mode is on. */
  test?: TestModeData | null;
  /**
   * Buried finds already dug up: spawn id → env day it was taken (drives
   * hole fade and any respawn logic). Missing in old saves.
   */
  buriedTaken: Record<string, number>;
  jeepLoad: Record<string, number>;
  bucket: Record<string, number>;
  settings: Settings;
}

export const SAVE_VERSION = 1;
