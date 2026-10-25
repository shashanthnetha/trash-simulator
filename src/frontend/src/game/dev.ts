// Dev harness – ONLY in the Vite dev build (import.meta.env.DEV) and only when
// the URL contains ?dev=1. Starts the game without login and allows the time of
// day, weather, position and view direction to be set via the URL – for
// screenshots, visual reviews and performance measurements. In the production
// build DEV.enabled is always false.
//
//   ?dev=1&tod=22.5&weather=rain&pos=10,40&yaw=0.3&pitch=-0.1&freeze=1&q=high
//
//   tod      time of day 0..24 (hours)
//   weather  sunny | partly_cloudy | overcast | rain | storm
//   pos      x,z world coordinates of the player
//   yaw      view direction (rad, 0 = -Z), pitch (rad, negative = looking down)
//   freeze   1 = freeze time of day and weather
//   q        ultra | high | medium | low
//   injeep   1 = start sitting in the jeep (driver view; pos/yaw are ignored)
//   seed     world seed (default: fixed, so that runs are reproducible)

import { QUALITY_IDS, WEATHER_IDS } from "./types";
import type { QualityId, WeatherId } from "./types";

export interface DevParams {
  enabled: boolean;
  tod?: number;
  weather?: WeatherId;
  pos?: [number, number];
  yaw?: number;
  pitch?: number;
  freeze: boolean;
  quality?: QualityId;
  /** 1 = start sitting in the jeep (driver view). */
  inJeep: boolean;
  /**
   * World seed. Fixed in dev mode so that runs are reproducible: both the trash
   * distribution AND the initial weather depend on the seed (Environment rolls
   * with `mulberry32(seed ^ 0x5eed)`). Without it the same call yields
   * "sunny" once and "rain" the next time – screenshots would not be
   * comparable.
   */
  seed: number;
}

const DEFAULT_DEV_SEED = 20260824;

// The accepted values come straight from types.ts so they cannot drift apart.
const WEATHERS: readonly string[] = WEATHER_IDS;
const QUALITIES: readonly string[] = QUALITY_IDS;

function parse(): DevParams {
  const off: DevParams = {
    enabled: false,
    freeze: false,
    inJeep: false,
    seed: DEFAULT_DEV_SEED,
  };
  if (!import.meta.env.DEV || typeof window === "undefined") return off;
  const p = new URLSearchParams(window.location.search);
  if (!p.has("dev")) return off;
  const num = (key: string): number | undefined => {
    const v = p.get(key);
    if (v == null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const weather = p.get("weather");
  const q = p.get("q");
  const posRaw = p.get("pos")?.split(",").map(Number);
  return {
    enabled: true,
    tod: num("tod"),
    weather:
      weather && WEATHERS.includes(weather)
        ? (weather as WeatherId)
        : undefined,
    pos:
      posRaw && posRaw.length === 2 && posRaw.every(Number.isFinite)
        ? [posRaw[0], posRaw[1]]
        : undefined,
    yaw: num("yaw"),
    pitch: num("pitch"),
    freeze: p.get("freeze") === "1",
    quality: q && QUALITIES.includes(q) ? (q as QualityId) : undefined,
    inJeep: p.get("injeep") === "1",
    seed: num("seed") ?? DEFAULT_DEV_SEED,
  };
}

export const DEV: DevParams = parse();
