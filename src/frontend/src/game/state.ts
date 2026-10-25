import { create } from "zustand";
import { COLLECTIBLE_BY_ID } from "./collectibles-data";
import { sound } from "./sound";
import {
  CATEGORIES,
  CATEGORY_IDS,
  DEFAULT_SETTINGS,
  MATERIALS,
  MATERIAL_BY_CATEGORY,
  MATERIAL_IDS,
  MAX_LEVEL,
  MISSIONS,
  QUALITY_IDS,
  SAVE_VERSION,
  SECTORS,
  STATION_CAPACITY,
  TRASH_BY_ID,
  UPGRADES,
  UPGRADE_BY_ID,
  XP_PER_DISPOSE,
  XP_PER_PICKUP,
  emptyCategoryCounts,
  emptyMaterials,
  emptyStats,
  isMaterialId,
  levelFromXp,
  upgradeValue,
} from "./types";
import type {
  CategoryId,
  MaterialId,
  QualityId,
  SaveData,
  Settings,
  StatsData,
  TestModeData,
  WeatherId,
} from "./types";

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "good" | "warn";
}

export interface FloatText {
  id: number;
  text: string;
  color: string;
}

export interface EnvInfo {
  timeOfDay: number;
  weather: WeatherId;
  weatherName: string;
  sectorName: string;
}

let nextUiId = 1;

// Rotating start for the sorting round robin: without it a slow plant would
// always empty the first line first. Pure ordering, not part of the save.
let sortCursor = 0;

export interface GameStore {
  // App flow
  screen: "start" | "game";
  paused: boolean;
  menuOpen: boolean;
  /** The tab the in-game menu shows; `Menus.tsx` reads and writes it. */
  menuTab:
    | "upgrades"
    | "missions"
    | "stats"
    | "leaderboard"
    | "inventory"
    | "market"
    | "collection";
  pointerLocked: boolean;
  isTouch: boolean;

  // Profile / progress
  playerName: string;
  seed: number;
  xp: number;
  recyclePoints: number;
  upgrades: Record<string, number>;
  stats: StatsData;
  missionsDone: string[];

  // Inventory & world
  bucket: Record<string, number>;
  bucketCount: number;
  jeepLoad: Record<string, number>;
  jeepCount: number;
  /** Total number of items in the station – always the sum of `stationQueue`. */
  stationStored: number;
  /** Items dropped off and waiting to be processed, per category. */
  stationQueue: Record<CategoryId, number>;
  /** Units of every recovered material the player owns (integers). */
  materials: Record<MaterialId, number>;
  /** Items already processed but not yet enough for a whole unit, per category. */
  recycleProgress: Record<CategoryId, number>;
  /** Rare finds in the display case: collectible variant id → found at (ms). */
  collection: Record<string, number>;
  /** Uncollected rare finds in the world: variant id → [x, z, yaw]. */
  collectSpawns: Record<string, [number, number, number]>;
  /** Lighthouse quest: key found / door unlocked / lamp running. */
  lighthouse: { hasKey: boolean; unlocked: boolean; lampOn: boolean };
  /** Equipped hand tool (1/2 keys, mouse wheel). */
  tool: "picker" | "detector";
  /** Buried finds already dug up: spawn id → env day it was taken. */
  buriedTaken: Record<string, number>;
  /** TEST MODE (temporary): non-null while test mode is on. */
  test: TestModeData | null;
  remaining: Record<string, number>;
  initialCounts: Record<string, number>;
  initialTotal: number;

  // HUD
  prompt: string;
  /**
   * Is the crosshair currently on a pickable piece of trash? Deliberately its
   * own flag instead of a text search in the prompt – otherwise the display
   * would depend on the prompt's translation.
   */
  promptGrab: boolean;
  toasts: Toast[];
  floats: FloatText[];
  env: EnvInfo;
  inJeep: boolean;
  jeepSpeed: number;

  // Cloud
  cloudDirty: boolean;
  cloudStatus: "offline" | "online" | "sync" | "error";
  engineStatus: "idle" | "booting" | "ready" | "error";
  engineError: string;
  /** What the staged world build is working on (loading screen caption). */
  bootStep: string;
  cloudInfo: string;
  lastSavedAt: number;

  // Actions
  setScreen: (s: "start" | "game") => void;
  setPaused: (p: boolean) => void;
  setMenu: (open: boolean, tab?: GameStore["menuTab"]) => void;
  setPointerLocked: (l: boolean) => void;
  setIsTouch: (t: boolean) => void;
  setPrompt: (p: string, grab?: boolean) => void;
  setEnv: (e: Partial<EnvInfo>) => void;
  setJeepState: (inJeep: boolean, speed: number) => void;
  setPlayerName: (n: string) => void;
  updateSettings: (s: Partial<Settings>) => void;
  settings: Settings;

  toast: (text: string, kind?: Toast["kind"]) => void;
  float: (text: string, color?: string) => void;

  bucketCapacity: () => number;
  jeepCapacity: () => number;
  level: () => number;

  registerWorld: (initial: Record<string, number>) => void;
  decRemaining: (key: string) => void;
  incRemaining: (key: string, n: number) => void;

  pickup: (typeId: string, viaDog?: boolean) => boolean;
  transferBucketToJeep: () => number;
  droneDeliver: (typeId: string) => boolean;
  depositAtStation: () => { count: number; points: number };
  stationProcess: (n: number) => void;
  addMaterials: (id: MaterialId, n: number) => void;
  /** Removes `n` units; false (and no change) if there are not enough. */
  takeMaterials: (id: MaterialId, n: number) => boolean;
  /**
   * Books a rare find into the display case. False (and no change) if the
   * variant is unknown or already owned – the spawner excludes owned pieces,
   * so that only guards against double delivery in the same grab.
   */
  foundCollectible: (id: string) => boolean;
  /** Written by the collectibles spawner whenever its world spawns change. */
  setCollectSpawns: (s: Record<string, [number, number, number]>) => void;
  /** Advances the lighthouse quest (place-lighthouse.ts drives it). */
  setLighthouse: (
    patch: Partial<{ hasKey: boolean; unlocked: boolean; lampOn: boolean }>,
  ) => void;
  /** Equips a hand tool (the engine gates ownership and plays the swap). */
  setTool: (t: "picker" | "detector") => void;
  /** Written by the detector module whenever a buried spawn is dug up. */
  setBuriedTaken: (m: Record<string, number>) => void;
  /**
   * TEST MODE (temporary): on = everything unlocked (a snapshot of the real
   * progress is kept); off = the snapshot is restored and everything earned
   * while testing is discarded.
   */
  toggleTestMode: () => void;
  /**
   * Deep-find bonus from the metal detector: books points and XP in one go
   * (with the usual level-up fanfare). Both amounts are clamped to ≥ 0.
   */
  addDeepBonus: (points: number, xp: number) => void;
  buyUpgrade: (id: string) => boolean;
  addPlaySeconds: (s: number) => void;
  addDistance: (walked: number, driven: number) => void;

  serialize: () => SaveData;
  applySave: (d: SaveData) => void;
  /** Flags unsaved changes for the next profile save. */
  markDirty: () => void;
  newGame: (name: string) => void;
  resetAll: () => void;
  setCloud: (status: GameStore["cloudStatus"], info?: string) => void;
  setEngineStatus: (status: GameStore["engineStatus"], error?: string) => void;
  setBootStep: (label: string) => void;
  clearDirty: () => void;
}

function sumCounts(rec: Record<string, number>): number {
  let n = 0;
  for (const k of Object.keys(rec)) n += rec[k];
  return n;
}

// ---------------------------------------------------------------------------
// Legacy save migration
// ---------------------------------------------------------------------------
// Saves written before the German → English identifier rename carry the old
// ids. Those saves are already stamped SAVE_VERSION 1, so the migration keys
// on recognising the legacy keys rather than on the version number.

const LEGACY_TYPE: Readonly<Record<string, string>> = {
  glas_gruen: "glass_green",
  glas_braun: "glass_brown",
  plastikflasche: "plastic_bottle",
  dose: "can",
  dose_platt: "can_crushed",
  bierdeckel: "coaster",
  zeitung: "newspaper",
  papier: "paper_ball",
  karton: "cardboard",
  tuete: "plastic_bag",
  chipstuete: "crisp_packet",
  brett: "plank",
  ast: "branch",
  treibgut: "driftwood",
  schutt: "rubble",
  blech: "sheet_metal",
  kabel: "cable",
  leine: "fishing_line",
  netz: "net",
  kanister: "canister",
  fass: "drum",
  spraydose: "spray_can",
  werkzeug: "tool",
  flipflop: "flip_flop",
  eimer_alt: "old_bucket",
};

const LEGACY_CATEGORY: Readonly<Record<string, CategoryId>> = {
  GLAS: "GLASS",
  PLASTIK: "PLASTIC",
  METALL: "METAL",
  PAPIER: "PAPER",
  HOLZ: "WOOD",
  STEIN: "STONE",
  CHEMIE: "CHEMICALS",
  REST: "GENERAL",
};

const LEGACY_QUALITY: Readonly<Record<string, QualityId>> = {
  hoch: "high",
  mittel: "medium",
  niedrig: "low",
};

/** Trash type id → current id; null = the type no longer exists. */
function migrateTypeId(id: string): string | null {
  if (TRASH_BY_ID[id]) return id;
  const mapped = LEGACY_TYPE[id];
  return mapped && TRASH_BY_ID[mapped] ? mapped : null;
}

/** Category id → current id; null = the category no longer exists. */
function migrateCategoryId(id: string): CategoryId | null {
  if (CATEGORIES[id as CategoryId]) return id as CategoryId;
  return LEGACY_CATEGORY[id] ?? null;
}

function migrateQuality(q: unknown): QualityId {
  if (typeof q !== "string") return DEFAULT_SETTINGS.quality;
  if ((QUALITY_IDS as readonly string[]).includes(q)) return q as QualityId;
  return LEGACY_QUALITY[q] ?? "high";
}

/** Rebuilds a count map under new keys; counts that collide are summed. */
function remapCounts(
  src: Record<string, number> | undefined,
  mapKey: (k: string) => string | null,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(src ?? {})) {
    const key = mapKey(k);
    if (key == null) continue; // refers to content that no longer exists
    const v = (src as Record<string, number>)[k];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    out[key] = (out[key] ?? 0) + v;
  }
  return out;
}

/** Category counts from a save: legacy ids translated, every category present. */
function readCategoryCounts(
  src: Record<string, number> | undefined,
): Record<CategoryId, number> {
  const out = emptyCategoryCounts();
  const mapped = remapCounts(src, migrateCategoryId);
  for (const k of Object.keys(mapped)) {
    out[k as CategoryId] += Math.max(0, Math.floor(mapped[k]));
  }
  return out;
}

/** Material stock from a save: unknown ids dropped, every id present. */
function readMaterials(
  src: Record<string, number> | undefined,
): Record<MaterialId, number> {
  const out = emptyMaterials();
  for (const k of Object.keys(src ?? {})) {
    if (!isMaterialId(k)) continue;
    const v = (src as Record<string, number>)[k];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    out[k] += Math.max(0, Math.floor(v));
  }
  return out;
}

/**
 * Saves written before the rename still use the old German ids. Translates
 * `remaining` (`"sector|type"`), `bucket`, `jeepLoad`,
 * `stats.byCategoryCollected` and `settings.quality`; upgrade, mission and
 * sector ids never changed. Keys that match nothing are dropped silently.
 *
 * Saves written before the material system have neither `stationQueue` nor
 * `materials`/`recycleProgress`. Their `stationStored` items lost their
 * category, so they are booked as general waste – nothing is lost. Leftover
 * progress that already adds up to whole units is converted here, so
 * `recycleProgress` always stays below one unit per category.
 */
export function migrateSave(d: SaveData): SaveData {
  // Display case: unknown variant ids (removed catalog entries) are dropped.
  const collection: Record<string, number> = {};
  for (const k of Object.keys(d.collection ?? {})) {
    if (!COLLECTIBLE_BY_ID[k]) continue;
    const v = (d.collection as Record<string, number>)[k];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    collection[k] = v;
  }

  // Lighthouse quest: coerce to booleans; missing in old saves = untouched.
  const lighthouse = {
    hasKey: d.lighthouse?.hasKey === true,
    unlocked: d.lighthouse?.unlocked === true,
    lampOn: d.lighthouse?.lampOn === true,
  };

  // TEST MODE (temporary): keep flag + snapshot only when roughly shaped.
  const rawTest = d.test;
  const test: TestModeData | null =
    rawTest?.snapshot && typeof rawTest.snapshot.xp === "number"
      ? {
          snapshot: {
            xp: rawTest.snapshot.xp,
            recyclePoints:
              typeof rawTest.snapshot.recyclePoints === "number"
                ? rawTest.snapshot.recyclePoints
                : 0,
            upgrades: { ...rawTest.snapshot.upgrades },
            lighthouse: {
              hasKey: rawTest.snapshot.lighthouse?.hasKey === true,
              unlocked: rawTest.snapshot.lighthouse?.unlocked === true,
              lampOn: rawTest.snapshot.lighthouse?.lampOn === true,
            },
            tool:
              rawTest.snapshot.tool === "detector"
                ? ("detector" as const)
                : ("picker" as const),
          },
        }
      : null;

  // Equipped tool + buried digs: sanitize; missing in old saves.
  const tool =
    d.tool === "detector" ? ("detector" as const) : ("picker" as const);
  const buriedTaken: Record<string, number> = {};
  for (const [k, v] of Object.entries(d.buriedTaken ?? {})) {
    if (typeof v === "number" && Number.isFinite(v)) buriedTaken[k] = v;
  }

  // World spawns: unknown, already-owned or malformed entries are dropped.
  const collectSpawns: Record<string, [number, number, number]> = {};
  for (const k of Object.keys(d.collectSpawns ?? {})) {
    if (!COLLECTIBLE_BY_ID[k] || collection[k] != null) continue;
    const v = (d.collectSpawns as Record<string, unknown>)[k];
    if (!Array.isArray(v) || v.length !== 3) continue;
    if (!v.every((n) => typeof n === "number" && Number.isFinite(n))) continue;
    collectSpawns[k] = [v[0], v[1], v[2]];
  }

  const stationQueue = readCategoryCounts(d.stationQueue);
  const stored =
    typeof d.stationStored === "number" && Number.isFinite(d.stationStored)
      ? Math.max(0, Math.floor(d.stationStored))
      : 0;
  const queued = sumCounts(stationQueue);
  // Old save: only the total survived – treat it as unsorted general waste.
  if (queued < stored) stationQueue.GENERAL += stored - queued;

  const materials = readMaterials(d.materials);
  const recycleProgress = readCategoryCounts(d.recycleProgress);
  for (const c of CATEGORY_IDS) {
    const mat = MATERIALS[MATERIAL_BY_CATEGORY[c]];
    const units = Math.floor(recycleProgress[c] / mat.itemsPerUnit);
    if (units > 0) {
      recycleProgress[c] -= units * mat.itemsPerUnit;
      materials[mat.id] += units;
    }
  }

  return {
    ...d,
    stationStored: sumCounts(stationQueue),
    stationQueue,
    materials,
    recycleProgress,
    collection,
    collectSpawns,
    lighthouse,
    tool,
    buriedTaken,
    test,
    remaining: remapCounts(d.remaining, (k) => {
      const bar = k.indexOf("|");
      if (bar < 0) return null;
      const type = migrateTypeId(k.slice(bar + 1));
      return type ? `${k.slice(0, bar)}|${type}` : null;
    }),
    bucket: remapCounts(d.bucket, migrateTypeId),
    jeepLoad: remapCounts(d.jeepLoad, migrateTypeId),
    stats: {
      ...emptyStats(),
      ...d.stats,
      byCategoryCollected: remapCounts(
        d.stats?.byCategoryCollected,
        migrateCategoryId,
      ),
    },
    settings: {
      ...DEFAULT_SETTINGS,
      ...d.settings,
      quality: migrateQuality(d.settings?.quality),
    },
  };
}

function checkMissions(
  get: () => GameStore,
  set: (p: Partial<GameStore>) => void,
) {
  const st = get();
  const done = new Set(st.missionsDone);
  let changed = false;
  let bonusXp = 0;
  let bonusPoints = 0;
  const cleanedSectors = SECTORS.filter((s) => {
    let init = 0;
    let rem = 0;
    for (const k of Object.keys(st.initialCounts)) {
      if (k.startsWith(`${s.id}|`)) {
        init += st.initialCounts[k];
        rem += st.remaining[k] ?? 0;
      }
    }
    return init > 0 && rem === 0;
  }).length;
  for (const m of MISSIONS) {
    if (done.has(m.id)) continue;
    let value = 0;
    switch (m.metric) {
      case "collected":
        value = st.stats.collected;
        break;
      case "disposed":
        value = st.stats.disposed;
        break;
      case "collectedGlass":
        value = st.stats.byCategoryCollected.GLASS ?? 0;
        break;
      case "collectedChemicals":
        value = st.stats.byCategoryCollected.CHEMICALS ?? 0;
        break;
      case "collectedMetal":
        value = st.stats.byCategoryCollected.METAL ?? 0;
        break;
      case "level":
        value = st.level();
        break;
      case "jeepLoads":
        value = st.stats.jeepLoads;
        break;
      case "dogItems":
        value = st.stats.dogItems;
        break;
      case "sectorClean":
        value = cleanedSectors;
        break;
    }
    if (value >= m.target) {
      done.add(m.id);
      changed = true;
      bonusXp += m.rewardXp;
      bonusPoints += m.rewardPoints;
      st.toast(
        `Mission complete: ${m.name} (+${m.rewardXp} XP, +${m.rewardPoints} pts)`,
        "good",
      );
    }
  }
  if (changed) {
    set({
      missionsDone: Array.from(done),
      xp: st.xp + bonusXp,
      recyclePoints: st.recyclePoints + bonusPoints,
    });
  }
}

export function missionProgress(st: GameStore, metric: string): number {
  switch (metric) {
    case "collected":
      return st.stats.collected;
    case "disposed":
      return st.stats.disposed;
    case "collectedGlass":
      return st.stats.byCategoryCollected.GLASS ?? 0;
    case "collectedChemicals":
      return st.stats.byCategoryCollected.CHEMICALS ?? 0;
    case "collectedMetal":
      return st.stats.byCategoryCollected.METAL ?? 0;
    case "level":
      return st.level();
    case "jeepLoads":
      return st.stats.jeepLoads;
    case "dogItems":
      return st.stats.dogItems;
    case "sectorClean": {
      return SECTORS.filter((s) => {
        let init = 0;
        let rem = 0;
        for (const k of Object.keys(st.initialCounts)) {
          if (k.startsWith(`${s.id}|`)) {
            init += st.initialCounts[k];
            rem += st.remaining[k] ?? 0;
          }
        }
        return init > 0 && rem === 0;
      }).length;
    }
    default:
      return 0;
  }
}

export const useGame = create<GameStore>((set, get) => ({
  screen: "start",
  paused: false,
  menuOpen: false,
  menuTab: "upgrades",
  pointerLocked: false,
  isTouch: false,

  playerName: "Collector",
  seed: Math.floor(Math.random() * 1e9),
  xp: 0,
  recyclePoints: 0,
  upgrades: {},
  stats: emptyStats(),
  missionsDone: [],

  bucket: {},
  bucketCount: 0,
  jeepLoad: {},
  jeepCount: 0,
  stationStored: 0,
  stationQueue: emptyCategoryCounts(),
  materials: emptyMaterials(),
  recycleProgress: emptyCategoryCounts(),
  collection: {},
  collectSpawns: {},
  lighthouse: { hasKey: false, unlocked: false, lampOn: false },
  tool: "picker" as const,
  buriedTaken: {},
  test: null,
  remaining: {},
  initialCounts: {},
  initialTotal: 0,

  prompt: "",
  promptGrab: false,
  toasts: [],
  floats: [],
  env: {
    timeOfDay: 10,
    weather: "sunny",
    weatherName: "Sunny",
    sectorName: "",
  },
  inJeep: false,
  jeepSpeed: 0,

  cloudDirty: false,
  lastSavedAt: 0,
  cloudStatus: "offline",
  engineStatus: "idle",
  engineError: "",
  bootStep: "",
  cloudInfo: "Saved locally (guest)",

  settings: { ...DEFAULT_SETTINGS },

  setScreen: (s) => set({ screen: s }),
  setPaused: (p) => set({ paused: p }),
  setMenu: (open, tab) =>
    set({
      menuOpen: open,
      menuTab: tab ?? get().menuTab,
      paused: open ? true : get().paused,
    }),
  setPointerLocked: (l) => set({ pointerLocked: l }),
  setIsTouch: (t) => set({ isTouch: t }),
  setPrompt: (p, grab = false) => {
    const st = get();
    if (st.prompt !== p || st.promptGrab !== grab)
      set({ prompt: p, promptGrab: grab });
  },
  setEnv: (e) => set({ env: { ...get().env, ...e } }),
  setJeepState: (inJeep, speed) => {
    const st = get();
    if (st.inJeep !== inJeep || Math.abs(st.jeepSpeed - speed) > 0.15) {
      set({ inJeep, jeepSpeed: speed });
    }
  },
  setPlayerName: (n) => {
    set({ playerName: n.slice(0, 24), cloudDirty: true });
    get().markDirty();
  },
  updateSettings: (s) => {
    set({ settings: { ...get().settings, ...s } });
    get().markDirty();
  },

  toast: (text, kind = "info") => {
    const id = nextUiId++;
    set({ toasts: [...get().toasts.slice(-3), { id, text, kind }] });
    setTimeout(() => {
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    }, 4200);
  },
  float: (text, color = "#ffffff") => {
    const id = nextUiId++;
    set({ floats: [...get().floats.slice(-5), { id, text, color }] });
    setTimeout(() => {
      set({ floats: get().floats.filter((f) => f.id !== id) });
    }, 1300);
  },

  bucketCapacity: () =>
    upgradeValue("bucketCap", get().upgrades.bucketCap ?? 0),
  jeepCapacity: () => upgradeValue("jeepCap", get().upgrades.jeepCap ?? 0),
  level: () => levelFromXp(get().xp).level,

  registerWorld: (initial) => {
    const st = get();
    const remaining: Record<string, number> = {};
    for (const k of Object.keys(initial)) {
      remaining[k] =
        st.remaining[k] != null
          ? Math.min(st.remaining[k], initial[k])
          : initial[k];
    }
    set({
      initialCounts: initial,
      initialTotal: sumCounts(initial),
      remaining,
    });
  },
  decRemaining: (key) => {
    const rem = { ...get().remaining };
    rem[key] = Math.max(0, (rem[key] ?? 0) - 1);
    set({ remaining: rem });
  },
  incRemaining: (key, n) => {
    const rem = { ...get().remaining };
    rem[key] = (rem[key] ?? 0) + n;
    set({ remaining: rem });
  },

  pickup: (typeId, viaDog = false) => {
    const st = get();
    const cap = st.bucketCapacity();
    if (st.bucketCount >= cap) return false;
    const def = TRASH_BY_ID[typeId];
    if (!def) return false;
    const bucket = { ...st.bucket };
    bucket[typeId] = (bucket[typeId] ?? 0) + 1;
    const byCat = { ...st.stats.byCategoryCollected };
    byCat[def.category] = (byCat[def.category] ?? 0) + 1;
    const stats: StatsData = {
      ...st.stats,
      collected: st.stats.collected + 1,
      byCategoryCollected: byCat,
      dogItems: st.stats.dogItems + (viaDog ? 1 : 0),
    };
    const before = st.level();
    set({
      bucket,
      bucketCount: st.bucketCount + 1,
      xp: st.xp + XP_PER_PICKUP,
      stats,
      cloudDirty: true,
    });
    const after = get().level();
    if (after > before && after <= MAX_LEVEL) {
      sound.levelUp();
      get().toast(`Level ${after} reached!`, "good");
    }
    checkMissions(get, set);
    get().markDirty();
    return true;
  },

  transferBucketToJeep: () => {
    const st = get();
    const free = st.jeepCapacity() - st.jeepCount;
    if (free <= 0 || st.bucketCount === 0) return 0;
    let toMove = Math.min(free, st.bucketCount);
    const moved = toMove;
    const bucket = { ...st.bucket };
    const jeep = { ...st.jeepLoad };
    for (const k of Object.keys(bucket)) {
      if (toMove <= 0) break;
      const take = Math.min(bucket[k], toMove);
      bucket[k] -= take;
      if (bucket[k] === 0) delete bucket[k];
      jeep[k] = (jeep[k] ?? 0) + take;
      toMove -= take;
    }
    set({
      bucket,
      jeepLoad: jeep,
      bucketCount: st.bucketCount - moved,
      jeepCount: st.jeepCount + moved,
      stats: { ...st.stats, jeepLoads: st.stats.jeepLoads + 1 },
      cloudDirty: true,
    });
    checkMissions(get, set);
    get().markDirty();
    return moved;
  },

  droneDeliver: (typeId) => {
    const st = get();
    if (st.jeepCount >= st.jeepCapacity()) return false;
    const def = TRASH_BY_ID[typeId];
    if (!def) return false;
    const jeep = { ...st.jeepLoad };
    jeep[typeId] = (jeep[typeId] ?? 0) + 1;
    const byCat = { ...st.stats.byCategoryCollected };
    byCat[def.category] = (byCat[def.category] ?? 0) + 1;
    set({
      jeepLoad: jeep,
      jeepCount: st.jeepCount + 1,
      xp: st.xp + XP_PER_PICKUP,
      stats: {
        ...st.stats,
        collected: st.stats.collected + 1,
        byCategoryCollected: byCat,
        droneItems: st.stats.droneItems + 1,
      },
      cloudDirty: true,
    });
    checkMissions(get, set);
    get().markDirty();
    return true;
  },

  depositAtStation: () => {
    const st = get();
    const freeStation = STATION_CAPACITY - st.stationStored;
    if (freeStation <= 0) return { count: 0, points: 0 };
    let budget = freeStation;
    let count = 0;
    let points = 0;
    const magnetBonus = upgradeValue("magnet", st.upgrades.magnet ?? 0);
    // The station sorts by material, so the drop-off is booked per category.
    const queue = { ...st.stationQueue };
    const takeFrom = (src: Record<string, number>) => {
      const out = { ...src };
      for (const k of Object.keys(out)) {
        if (budget <= 0) break;
        const def = TRASH_BY_ID[k];
        const take = Math.min(out[k], budget);
        out[k] -= take;
        if (out[k] === 0) delete out[k];
        budget -= take;
        count += take;
        // Unknown types (from a foreign save) go into the general waste line.
        const cat = def?.category ?? "GENERAL";
        queue[cat] += take;
        if (def) {
          let v = CATEGORIES[def.category].value;
          if (def.category === "METAL") v += magnetBonus;
          points += v * take;
        }
      }
      return out;
    };
    const bucket = takeFrom(st.bucket);
    const jeep = takeFrom(st.jeepLoad);
    if (count === 0) return { count: 0, points: 0 };
    const before = st.level();
    set({
      bucket,
      jeepLoad: jeep,
      bucketCount: sumCounts(bucket),
      jeepCount: sumCounts(jeep),
      stationQueue: queue,
      stationStored: sumCounts(queue),
      xp: st.xp + count * XP_PER_DISPOSE,
      recyclePoints: st.recyclePoints + points,
      stats: { ...st.stats, disposed: st.stats.disposed + count },
      cloudDirty: true,
    });
    const after = get().level();
    if (after > before && after <= MAX_LEVEL) {
      sound.levelUp();
      get().toast(`Level ${after} reached!`, "good");
    }
    checkMissions(get, set);
    get().markDirty();
    return { count, points };
  },

  stationProcess: (n) => {
    const st = get();
    if (st.stationStored <= 0 || !Number.isFinite(n) || n < 1) return;
    let budget = Math.min(st.stationStored, Math.floor(n));
    const queue = { ...st.stationQueue };
    const progress = { ...st.recycleProgress };
    const materials = { ...st.materials };
    const produced: Partial<Record<MaterialId, number>> = {};
    let processed = 0;

    // Round robin over the occupied lines: a mixed load is sorted in parallel
    // instead of one category after the other.
    while (budget > 0) {
      const live = CATEGORY_IDS.filter((c) => queue[c] > 0);
      if (live.length === 0) break;
      const share = Math.max(1, Math.floor(budget / live.length));
      const start = sortCursor++ % live.length;
      for (let i = 0; i < live.length; i++) {
        const c = live[(start + i) % live.length];
        if (budget <= 0) break;
        const take = Math.min(queue[c], share, budget);
        queue[c] -= take;
        budget -= take;
        processed += take;
        const mat = MATERIALS[MATERIAL_BY_CATEGORY[c]];
        const total = progress[c] + take;
        const units = Math.floor(total / mat.itemsPerUnit);
        progress[c] = total - units * mat.itemsPerUnit;
        if (units > 0) {
          materials[mat.id] += units;
          produced[mat.id] = (produced[mat.id] ?? 0) + units;
        }
      }
    }
    if (processed === 0) return;

    set({
      stationQueue: queue,
      stationStored: st.stationStored - processed,
      recycleProgress: progress,
      materials,
      stats: { ...st.stats, recycled: st.stats.recycled + processed },
    });

    // One toast per call, no matter how many lines produced something.
    const parts: string[] = [];
    for (const id of MATERIAL_IDS) {
      const units = produced[id] ?? 0;
      if (units > 0)
        parts.push(`+${units} ${MATERIALS[id].unit} ${MATERIALS[id].name}`);
    }
    if (parts.length > 0) get().toast(`Recycled: ${parts.join(" · ")}`, "good");
    get().markDirty();
  },

  addMaterials: (id, n) => {
    const st = get();
    if (!isMaterialId(id) || !Number.isFinite(n)) return;
    const add = Math.floor(n);
    if (add <= 0) return;
    set({ materials: { ...st.materials, [id]: st.materials[id] + add } });
    get().markDirty();
  },

  takeMaterials: (id, n) => {
    const st = get();
    if (!isMaterialId(id) || !Number.isFinite(n)) return false;
    const take = Math.floor(n);
    if (take <= 0) return false;
    if (st.materials[id] < take) return false;
    set({ materials: { ...st.materials, [id]: st.materials[id] - take } });
    get().markDirty();
    return true;
  },

  foundCollectible: (id) => {
    const st = get();
    const def = COLLECTIBLE_BY_ID[id];
    if (!def || st.collection[id] != null) return false;
    set({
      collection: { ...st.collection, [id]: Date.now() },
      cloudDirty: true,
    });
    st.toast(`Rare find: ${def.name} – now in your display case`, "good");
    st.float(`✦ ${def.name}`, "#ffd76a");
    get().markDirty();
    return true;
  },

  setCollectSpawns: (s) => {
    set({ collectSpawns: s });
    get().markDirty();
  },

  setLighthouse: (patch) => {
    set({ lighthouse: { ...get().lighthouse, ...patch } });
    get().markDirty();
  },

  setTool: (t) => {
    set({ tool: t });
    get().markDirty();
  },

  setBuriedTaken: (m) => {
    set({ buriedTaken: m });
    get().markDirty();
  },

  // TEST MODE (temporary – remove together with the types.ts block and the
  // "Testing" section in PauseSettings.tsx).
  toggleTestMode: () => {
    const st = get();
    if (st.test) {
      const s = st.test.snapshot;
      set({
        test: null,
        xp: s.xp,
        recyclePoints: s.recyclePoints,
        upgrades: { ...s.upgrades },
        lighthouse: { ...s.lighthouse },
        tool: s.tool,
      });
      st.toast("Test mode off – your real progress is restored.", "info");
    } else {
      const upgrades: Record<string, number> = {};
      for (const u of UPGRADES) upgrades[u.id] = u.values.length - 1;
      set({
        test: {
          snapshot: {
            xp: st.xp,
            recyclePoints: st.recyclePoints,
            upgrades: { ...st.upgrades },
            lighthouse: { ...st.lighthouse },
            tool: st.tool,
          },
        },
        xp: 600000,
        recyclePoints: 999999,
        upgrades,
        lighthouse: { ...st.lighthouse, hasKey: true },
      });
      st.toast(
        "Test mode on – everything unlocked. Progress made while testing is not kept.",
        "good",
      );
    }
    get().markDirty();
  },

  addDeepBonus: (points, xp) => {
    const st = get();
    const before = st.level();
    set({
      recyclePoints: st.recyclePoints + Math.max(0, Math.round(points)),
      xp: st.xp + Math.max(0, Math.round(xp)),
      cloudDirty: true,
    });
    const after = get().level();
    if (after > before && after <= MAX_LEVEL) {
      sound.levelUp();
      get().toast(`Level ${after} reached!`, "good");
    }
    checkMissions(get, set);
    get().markDirty();
  },

  buyUpgrade: (id) => {
    const st = get();
    const def = UPGRADE_BY_ID[id];
    if (!def) return false;
    const stage = st.upgrades[id] ?? 0;
    if (stage >= def.values.length - 1) return false;
    const cost = def.costs[stage];
    const reqLevel = def.levelReq[stage];
    if (st.level() < reqLevel) {
      st.toast(`Requires level ${reqLevel}.`, "warn");
      return false;
    }
    if (st.recyclePoints < cost) {
      st.toast("Not enough recycling points.", "warn");
      return false;
    }
    set({
      recyclePoints: st.recyclePoints - cost,
      upgrades: { ...st.upgrades, [id]: stage + 1 },
      cloudDirty: true,
    });
    st.toast(`${def.name} upgraded!`, "good");
    get().markDirty();
    return true;
  },

  addPlaySeconds: (s) => {
    const st = get();
    set({ stats: { ...st.stats, playSeconds: st.stats.playSeconds + s } });
  },
  addDistance: (walked, driven) => {
    const st = get();
    set({
      stats: {
        ...st.stats,
        distanceWalked: st.stats.distanceWalked + walked,
        distanceDriven: st.stats.distanceDriven + driven,
      },
    });
  },

  serialize: () => {
    const st = get();
    return {
      version: SAVE_VERSION,
      seed: st.seed,
      playerName: st.playerName,
      xp: st.xp,
      recyclePoints: st.recyclePoints,
      upgrades: st.upgrades,
      stats: st.stats,
      missionsDone: st.missionsDone,
      remaining: st.remaining,
      stationStored: st.stationStored,
      stationQueue: st.stationQueue,
      materials: st.materials,
      recycleProgress: st.recycleProgress,
      collection: st.collection,
      collectSpawns: st.collectSpawns,
      lighthouse: st.lighthouse,
      tool: st.tool,
      buriedTaken: st.buriedTaken,
      test: st.test,
      jeepLoad: st.jeepLoad,
      bucket: st.bucket,
      settings: st.settings,
    };
  },

  applySave: (raw) => {
    // Old saves carry the pre-rename German ids – translate them first.
    const d = migrateSave(raw);
    set({
      seed: d.seed,
      playerName: d.playerName ?? "Collector",
      xp: d.xp ?? 0,
      recyclePoints: d.recyclePoints ?? 0,
      upgrades: d.upgrades ?? {},
      stats: d.stats,
      missionsDone: d.missionsDone ?? [],
      remaining: d.remaining,
      // migrateSave guarantees complete records and a matching total.
      stationStored: d.stationStored,
      stationQueue: d.stationQueue as Record<CategoryId, number>,
      materials: d.materials as Record<MaterialId, number>,
      recycleProgress: d.recycleProgress as Record<CategoryId, number>,
      collection: d.collection,
      collectSpawns: d.collectSpawns,
      lighthouse: d.lighthouse,
      tool: d.tool,
      buriedTaken: d.buriedTaken,
      test: d.test ?? null,
      jeepLoad: d.jeepLoad,
      jeepCount: sumCounts(d.jeepLoad),
      bucket: d.bucket,
      bucketCount: sumCounts(d.bucket),
      settings: d.settings,
    });
  },

  markDirty: () => {
    if (!get().cloudDirty) set({ cloudDirty: true });
  },

  newGame: (name) => {
    set({
      playerName: name || "Collector",
      seed: Math.floor(Math.random() * 1e9),
      xp: 0,
      recyclePoints: 0,
      upgrades: {},
      stats: emptyStats(),
      missionsDone: [],
      bucket: {},
      bucketCount: 0,
      jeepLoad: {},
      jeepCount: 0,
      stationStored: 0,
      stationQueue: emptyCategoryCounts(),
      materials: emptyMaterials(),
      recycleProgress: emptyCategoryCounts(),
      collection: {},
      collectSpawns: {},
      lighthouse: { hasKey: false, unlocked: false, lampOn: false },
      tool: "picker",
      buriedTaken: {},
      test: null,
      remaining: {},
      initialCounts: {},
      screen: "game",
      menuOpen: false,
      paused: false,
      cloudDirty: true,
    });
    get().markDirty();
  },

  resetAll: () => {
    set({ screen: "start", menuOpen: false, paused: false });
  },

  setCloud: (status, info) =>
    set({ cloudStatus: status, cloudInfo: info ?? get().cloudInfo }),
  setEngineStatus: (status, error) =>
    set({
      engineStatus: status,
      engineError: error ?? "",
      bootStep: status === "booting" ? get().bootStep : "",
    }),
  setBootStep: (label) => {
    if (get().bootStep !== label) set({ bootStep: label });
  },
  clearDirty: () => set({ cloudDirty: false, lastSavedAt: Date.now() }),
}));
