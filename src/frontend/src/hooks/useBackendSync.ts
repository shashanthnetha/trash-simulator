// Trash Simulator – STANDALONE BUILD: local profile + local save.
//
// This file replaces the on-chain sync layer (Internet Identity + Motoko
// backend canister) with a browser-local implementation for the standalone
// web build. The exported interface (BackendSync, MarketSlice, all types) is
// unchanged, so App.tsx and the components work exactly as before.
//
// Differences from the original:
// - No sign-in: the game always runs as a local "operator" profile.
// - Registration = choosing the operator ID once; stored in localStorage.
// - Saving = the same SaveData JSON, written to localStorage instead of the
//   canister (auto-save every five minutes + manual save, as before).
// - No shared leaderboard/global stats and no marketplace (the backend owned
//   them): the market slice is inert and the UI hides those tabs.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { GlobalStats, LeaderboardEntry, ProfileOutput } from "../backend";
import { useGame } from "../game/state";
import { type SaveData, levelFromXp } from "../game/types";

/** Automatic save every five minutes. */
export const AUTOSAVE_MS = 300_000;

export type RegisterOutcome =
  | "ok"
  | "nameTaken"
  | "invalidName"
  | "anonymous"
  | "error";

// ---------------------------------------------------------------- marketplace

/** Shown whenever the market is used without a backend connection. */
export const MARKET_OFFLINE = "The marketplace is offline – please sign in";
/**
 * Stable message for the pool's per-swap size cap (#poolTooThin). The swap UI
 * compares against this constant – never rephrase it in one place only.
 */
export const MARKET_TOO_LARGE =
  "Too large for this market – try a smaller amount";

/** An open sell order, converted from Candid to plain numbers. */
export interface MarketOrder {
  id: number;
  /** Seller principal as text. */
  seller: string;
  sellerName: string;
  material: string;
  amount: number;
  pricePerUnitCents: number;
  /** Creation time in milliseconds since the epoch. */
  createdAt: number;
  /** True when the signed-in player is the seller. */
  mine: boolean;
}

// ------------------------------------------------------------------ exchange
// Instant swaps against the backend's virtual market maker. An "asset" is
// either the dollar (USD_ASSET) or a MaterialId. Amounts are whole cents when
// the asset is USD and whole material units otherwise - on both sides of a
// swap, so USD -> pet_flake takes cents in and gives units out.

/** The dollar side of every swap. Anything else is a MaterialId. */
export const USD_ASSET = "USD";

/** "USD" or a MaterialId. */
export type SwapAsset = string;

/** One sample of a pool's mid price, for the sparkline. */
export interface MarketPricePoint {
  /** Milliseconds since the epoch. */
  at: number;
  /** Cents per unit; fractional, e.g. 350.28. */
  midCents: number;
}

/** Everything the UI needs to price and chart one material. */
export interface MarketPriceRow {
  material: string;
  /** Real-world-calibrated reference price, cents per unit (fractional). */
  oracleCents: number;
  /** What the pool trades at right now, cents per unit (fractional). */
  midCents: number;
  /** What the station's wholesale desk pays, whole cents per unit. */
  wholesaleCents: number;
  /** (mid - oracle) / oracle in basis points. Negative = below the oracle. */
  deviationBp: number;
  /** Virtual pool depth. Only meaningful as a relative measure. */
  poolUnits: number;
  poolCents: number;
  /** Largest single swap the pool accepts right now - use them as slider caps. */
  maxSellUnits: number;
  maxBuyCents: number;
  /** Oldest first, at most 24 samples, at least 5 minutes apart. */
  trend: MarketPricePoint[];
}

export interface MarketPrices {
  /** Backend clock when the snapshot was taken, in milliseconds. */
  at: number;
  /** Fee per swap leg in basis points; 30 = 0.30 %. Burned, not paid to anyone. */
  feeBp: number;
  /** How far the wholesale desk sits below the oracle, in basis points. */
  wholesaleSpreadBp: number;
  /** Keyed by material id. */
  rows: Record<string, MarketPriceRow>;
  /** The same rows in the backend's table order. */
  list: MarketPriceRow[];
  /** Lifetime counters of the exchange. */
  swaps: number;
  feeBurnedCents: number;
}

export interface MarketSwapQuote {
  fromAsset: SwapAsset;
  toAsset: SwapAsset;
  amountIn: number;
  /** What the swap pays out, after impact and fee. */
  amountOut: number;
  /** What it would pay at the mid price, with neither impact nor fee. */
  midAmountOut: number;
  /** Mid price of the sold material in cents/unit, 0 when selling dollars. */
  midCents: number;
  /** Mid price of the bought material in cents/unit, 0 when buying dollars. */
  midCentsTo: number;
  /** Curve impact in basis points. The fee is separate. */
  priceImpactBp: number;
  feeCents: number;
  /** ["USD", mat] / [mat, "USD"] / [mat, "USD", mat] - a cross pays 2 fees. */
  route: SwapAsset[];
}

export interface MarketQuoteResult {
  ok: boolean;
  error: string | null;
  quote: MarketSwapQuote | null;
}

/**
 * What a completed swap did. The dollar leg is already settled on chain; the
 * material leg is the caller's job, exactly like the order book:
 *   fromAsset !== USD_ASSET -> remove `amountIn` units locally
 *   toAsset   !== USD_ASSET -> add    `amountOut` units locally
 */
export interface MarketSwapReceipt {
  fromAsset: SwapAsset;
  toAsset: SwapAsset;
  amountIn: number;
  amountOut: number;
  feeCents: number;
  priceImpactBp: number;
  /** The wallet after the swap, in cents. */
  balanceCents: number;
  /** Pool mids AFTER the swap, cents per unit; 0 on a dollar side. */
  midCents: number;
  midCentsTo: number;
  /** Milliseconds since the epoch. */
  at: number;
}

/** Uniform outcome of every market action. */
export interface MarketActionResult {
  ok: boolean;
  error: string | null;
  /** create/cancel/buy: the affected order (amount 0 = fully bought). */
  order: MarketOrder | null;
  /** buy: what the purchase cost in cents. */
  costCents: number | null;
  /** sellWholesale/swap: the new balance in cents. */
  balanceCents: number | null;
  /** swap: what to add to / remove from the local material stock. */
  swap: MarketSwapReceipt | null;
}

export interface MarketSlice {
  balanceCents: number | null;
  orders: MarketOrder[];
  busy: boolean;
  error: string | null;
  refresh: () => void;
  createOrder: (
    material: string,
    amount: number,
    pricePerUnitCents: number,
  ) => Promise<MarketActionResult>;
  cancelOrder: (orderId: number) => Promise<MarketActionResult>;
  buy: (orderId: number, amount: number) => Promise<MarketActionResult>;
  sellWholesale: (
    material: string,
    amount: number,
  ) => Promise<MarketActionResult>;

  // ---- exchange ----
  /** null while offline or before the first snapshot arrives. */
  prices: MarketPrices | null;
  pricesBusy: boolean;
  /** Force a snapshot now; it also refreshes itself every 20 s. */
  refreshPrices: () => void;
  /**
   * Prices a swap without executing it. Cheap query, safe to call on every
   * keystroke behind a debounce - guard against out-of-order replies with a
   * sequence counter, the promise resolution order is not guaranteed.
   */
  quote: (
    fromAsset: SwapAsset,
    toAsset: SwapAsset,
    amountIn: number,
  ) => Promise<MarketQuoteResult>;
  /**
   * Executes a swap. Pass `minAmountOut` from the last quote (minus the
   * tolerance the player picked) to be slippage-protected; 0 accepts any price.
   */
  swap: (
    fromAsset: SwapAsset,
    toAsset: SwapAsset,
    amountIn: number,
    minAmountOut: number,
  ) => Promise<MarketActionResult>;
}

export interface BackendSync {
  isAuthenticated: boolean;
  isLoggingIn: boolean;
  authInitializing: boolean;
  loginError: string | null;
  login: () => void;
  logout: () => void;

  profile: ProfileOutput | null;
  profileChecking: boolean;
  profileError: boolean;
  retryProfile: () => void;
  needsRegistration: boolean;
  registerName: (name: string) => void;
  registerBusy: boolean;
  registerOutcome: RegisterOutcome | null;
  clearRegisterOutcome: () => void;
  checkNameAvailable: (name: string) => Promise<boolean>;

  cloudSave: { data: string } | null;
  cloudChecking: boolean;
  loadProfileIntoGame: () => void;
  loadBusy: boolean;
  saveToProfile: () => void;
  saveBusy: boolean;
  startFreshRun: () => void;
  resetBusy: boolean;

  leaderboard: LeaderboardEntry[] | null;
  globalStats: GlobalStats | null;
  leaderboardBusy: boolean;
  refreshLeaderboard: () => void;

  market: MarketSlice;
}

// ------------------------------------------------------------- local storage

const PROFILE_KEY = "trash-simulator:profile:v1";
const SAVE_KEY = "trash-simulator:save:v1";

interface LocalProfile {
  name: string;
}

/** Same fields the backend's SaveInput carried. */
interface LocalSave {
  xp: number;
  level: number;
  totalCollected: number;
  totalDisposed: number;
  recyclePoints: number;
  /** JSON-stringified SaveData, exactly like the backend's `data` field. */
  data: string;
  /** Milliseconds since the epoch. */
  updatedAt: number;
}

function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function toProfileOutput(p: LocalProfile, s: LocalSave | null): ProfileOutput {
  return {
    name: p.name,
    xp: BigInt(s?.xp ?? 0),
    recyclePoints: BigInt(s?.recyclePoints ?? 0),
    hasSave: s != null && s.data.length > 0,
    totalCollected: BigInt(s?.totalCollected ?? 0),
    totalDisposed: BigInt(s?.totalDisposed ?? 0),
    level: BigInt(s?.level ?? 1),
    updatedAt: BigInt(s?.updatedAt ?? Date.now()) * 1_000_000n,
  };
}

const NAME_PATTERN = /^[A-Za-zÄÖÜäöüß0-9 ._-]{3,24}$/;

const MARKET_UNAVAILABLE = "The marketplace is not part of the standalone version";

function marketFail(error: string): MarketActionResult {
  return {
    ok: false,
    error,
    order: null,
    costCents: null,
    balanceCents: null,
    swap: null,
  };
}

/** Inert market slice: no balance, no orders, every action explains itself. */
const OFFLINE_MARKET: MarketSlice = {
  balanceCents: null,
  orders: [],
  busy: false,
  error: null,
  refresh: () => {},
  createOrder: async () => marketFail(MARKET_UNAVAILABLE),
  cancelOrder: async () => marketFail(MARKET_UNAVAILABLE),
  buy: async () => marketFail(MARKET_UNAVAILABLE),
  sellWholesale: async () => marketFail(MARKET_UNAVAILABLE),
  prices: null,
  pricesBusy: false,
  refreshPrices: () => {},
  quote: async () => ({ ok: false, error: MARKET_UNAVAILABLE, quote: null }),
  swap: async () => marketFail(MARKET_UNAVAILABLE),
};

export function useBackendSync(): BackendSync {
  const [localProfile, setLocalProfile] = useState<LocalProfile | null>(() =>
    readJson<LocalProfile>(PROFILE_KEY),
  );
  const [localSave, setLocalSave] = useState<LocalSave | null>(() =>
    readJson<LocalSave>(SAVE_KEY),
  );
  const [registerOutcome, setRegisterOutcome] =
    useState<RegisterOutcome | null>(null);

  const profile = useMemo(
    () => (localProfile ? toProfileOutput(localProfile, localSave) : null),
    [localProfile, localSave],
  );

  // Mirror profile name + cloud status into the store (as the original did).
  useEffect(() => {
    const st = useGame.getState();
    if (st.cloudStatus === "offline") st.setCloud("online");
    if (profile && profile.name !== st.playerName)
      st.setPlayerName(profile.name);
  }, [profile]);

  const saveToProfile = useCallback(() => {
    const st = useGame.getState();
    st.setCloud("sync");
    try {
      const rec: LocalSave = {
        xp: Math.floor(st.xp),
        level: levelFromXp(st.xp).level,
        totalCollected: st.stats.collected,
        totalDisposed: st.stats.disposed,
        recyclePoints: Math.floor(st.recyclePoints),
        data: JSON.stringify(st.serialize()),
        updatedAt: Date.now(),
      };
      window.localStorage.setItem(SAVE_KEY, JSON.stringify(rec));
      setLocalSave(rec);
      st.setCloud("online");
      st.clearDirty();
    } catch {
      useGame.getState().setCloud("error", "Saving locally failed");
    }
  }, []);

  // Automatic save every five minutes, provided there are changes.
  useEffect(() => {
    const t = window.setInterval(() => {
      const st = useGame.getState();
      if (st.cloudDirty && st.screen === "game") saveToProfile();
    }, AUTOSAVE_MS);
    return () => window.clearInterval(t);
  }, [saveToProfile]);

  const loadProfileIntoGame = useCallback(() => {
    const st = useGame.getState();
    if (!localSave || localSave.data.length === 0) return;
    try {
      st.applySave(JSON.parse(localSave.data) as SaveData);
      st.setScreen("game");
      st.setCloud("online");
      st.clearDirty();
    } catch {
      st.setCloud("error", "The local save game is unreadable");
    }
  }, [localSave]);

  const startFreshRun = useCallback(() => {
    try {
      window.localStorage.removeItem(SAVE_KEY);
    } catch {
      /* storage unavailable – the in-memory newGame below still works */
    }
    setLocalSave(null);
    const name = useGame.getState().playerName;
    useGame.getState().newGame(name);
  }, []);

  const registerName = useCallback((name: string) => {
    const trimmed = name.trim();
    if (!NAME_PATTERN.test(trimmed)) {
      setRegisterOutcome("invalidName");
      return;
    }
    const p: LocalProfile = { name: trimmed };
    try {
      window.localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
    } catch {
      /* storage unavailable – the session profile still works */
    }
    setLocalProfile(p);
    setRegisterOutcome("ok");
  }, []);

  // Sign-out ends the local session only: the save stays in the browser, so
  // signing back in (choosing an operator ID again) restores it.
  const logout = useCallback(() => {
    try {
      window.localStorage.removeItem(PROFILE_KEY);
    } catch {
      /* ignore */
    }
    setLocalProfile(null);
    setRegisterOutcome(null);
  }, []);

  return {
    isAuthenticated: true,
    isLoggingIn: false,
    authInitializing: false,
    loginError: null,
    login: () => {},
    logout,

    profile,
    profileChecking: false,
    profileError: false,
    retryProfile: () => {},
    needsRegistration: localProfile == null,
    registerName,
    registerBusy: false,
    registerOutcome,
    clearRegisterOutcome: () => setRegisterOutcome(null),
    checkNameAvailable: async (name: string) => NAME_PATTERN.test(name.trim()),

    cloudSave: localSave ? { data: localSave.data } : null,
    cloudChecking: false,
    loadProfileIntoGame,
    loadBusy: false,
    saveToProfile,
    saveBusy: false,
    startFreshRun,
    resetBusy: false,

    // No shared leaderboard or global stats in the standalone build.
    leaderboard: null,
    globalStats: null,
    leaderboardBusy: false,
    refreshLeaderboard: () => {},

    market: OFFLINE_MARKET,
  };
}
