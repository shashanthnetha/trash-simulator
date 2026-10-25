import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
// Trash Simulator – profile hookup: registration, save game, leaderboard, market
// There is no local save game: everything lives in the profile on chain.
import { useInternetIdentity } from "../auth/internetIdentity";
import {
  type GlobalStats,
  type LeaderboardEntry,
  type MarketPrice,
  type MarketSnapshot,
  type Order,
  type ProfileOutput,
  type Purchase,
  type SaveInput,
  type SaveOutput,
  type SwapQuote,
  type SwapReceipt,
  type backendInterface,
  createActor,
} from "../backend";
import { useGame } from "../game/state";
import { type SaveData, levelFromXp } from "../game/types";
import { useActor } from "./useActor";

/** Automatic save to the profile every five minutes. */
export const AUTOSAVE_MS = 300_000;

/**
 * Unwraps an optional Candid value, no matter how the generated bindings
 * represent it: caffeine-bindgen returns `T | null`, agent-js-style clients
 * return `[] | [T]`. Both end up as `T | null` here.
 */
export function unwrapOpt<T>(v: T | null | undefined | [] | [T]): T | null {
  if (v == null) return null;
  if (Array.isArray(v)) return (v as [T?])[0] ?? null;
  return v;
}

/**
 * Reads the constructor name of a Candid variant, no matter how the generated
 * bindings represent it ({ ok: ... }, { tag: "ok" } or "ok").
 */
export function variantKey(res: unknown): string {
  if (typeof res === "string") return res;
  if (res != null && typeof res === "object") {
    const o = res as Record<string, unknown>;
    for (const probe of ["tag", "kind", "type", "_tag", "__kind__"]) {
      const v = o[probe];
      if (typeof v === "string") return v;
    }
    const keys = Object.keys(o);
    if (keys.length === 1) return keys[0];
    for (const k of [
      "ok",
      "alreadyRegistered",
      "nameTaken",
      "invalidName",
      "anonymous",
    ]) {
      if (k in o) return k;
    }
  }
  return "";
}

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

const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);

/** Candid `nat` to a JS number. Cents stay far below 2^53 – clamp regardless. */
function natToNumber(v: bigint | number): number {
  if (typeof v === "number") return Math.max(0, Math.floor(v));
  if (v <= 0n) return 0;
  return v > MAX_SAFE_BIG ? Number.MAX_SAFE_INTEGER : Number(v);
}

/** Candid `int` to a JS number, sign preserved. */
function intToNumber(v: bigint | number): number {
  if (typeof v === "number") return Math.trunc(v);
  if (v > MAX_SAFE_BIG) return Number.MAX_SAFE_INTEGER;
  if (v < -MAX_SAFE_BIG) return -Number.MAX_SAFE_INTEGER;
  return Number(v);
}

/** Candid `int` nanoseconds to milliseconds. */
function nanosToMs(v: bigint | number): number {
  const ns = typeof v === "bigint" ? v : BigInt(Math.floor(v));
  return Number(ns / 1_000_000n);
}

/** A principal is a class instance in the generated client, text elsewhere. */
function principalText(seller: unknown): string {
  if (typeof seller === "string") return seller;
  const p = seller as { toText?: () => string } | null;
  return typeof p?.toText === "function" ? p.toText() : "";
}

function toMarketOrder(o: Order, me: string): MarketOrder {
  const seller = principalText(o.seller);
  return {
    id: natToNumber(o.id),
    seller,
    sellerName: o.sellerName,
    material: o.material,
    amount: natToNumber(o.amount),
    pricePerUnitCents: natToNumber(o.pricePerUnitCents),
    createdAt: nanosToMs(o.createdAt),
    mine: seller.length > 0 && seller === me,
  };
}

/** Reads the payload of one variant arm, whichever binding shape is used. */
function variantPayload(res: unknown, key: string): unknown {
  if (res != null && typeof res === "object" && key in res) {
    return (res as Record<string, unknown>)[key];
  }
  return null;
}

function marketErrorText(err: unknown): string {
  switch (variantKey(err)) {
    case "anonymous":
      return "Please sign in first";
    case "notRegistered":
      return "You need a player profile first";
    case "unknownMaterial":
      return "Unknown material";
    case "invalidAmount":
      return "Invalid amount (1 – 100,000 units)";
    case "invalidPrice":
      return "Invalid price (1 cent – $10,000 per unit)";
    case "tooManyOrders":
      return "Too many open orders (30 at most)";
    case "notFound":
      return "This order no longer exists";
    case "notSeller":
      return "Only the seller can withdraw this order";
    case "ownOrder":
      return "You cannot buy your own order";
    case "insufficientFunds":
      return "Not enough money";
    case "unknownAsset":
      return "Unknown asset";
    case "identicalAssets":
      return "Pick two different assets";
    case "slippage":
      return "The price moved – the swap would pay less than your limit";
    case "poolTooThin":
      return MARKET_TOO_LARGE;
    default:
      return "The marketplace rejected the request";
  }
}

function marketOk(partial: Partial<MarketActionResult>): MarketActionResult {
  return {
    ok: true,
    error: null,
    order: null,
    costCents: null,
    balanceCents: null,
    swap: null,
    ...partial,
  };
}

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

// ---- exchange decoders ----

/** Prices arrive as ten-thousandths of a cent so cheap bulk materials keep
 *  their resolution; the UI only ever sees fractional cents. */
function centsFromE4(v: bigint | number, scale: number): number {
  return scale > 0 ? natToNumber(v) / scale : 0;
}

function toPriceRow(row: MarketPrice, scale: number): MarketPriceRow {
  return {
    material: row.material,
    oracleCents: centsFromE4(row.oracleCentsE4, scale),
    midCents: centsFromE4(row.midCentsE4, scale),
    wholesaleCents: natToNumber(row.wholesaleCents),
    deviationBp: intToNumber(row.deviationBp),
    poolUnits: natToNumber(row.poolUnits),
    poolCents: natToNumber(row.poolCents),
    maxSellUnits: natToNumber(row.maxSellUnits),
    maxBuyCents: natToNumber(row.maxBuyCents),
    trend: row.trend.map((p) => ({
      at: nanosToMs(p.at),
      midCents: centsFromE4(p.midCentsE4, scale),
    })),
  };
}

function toMarketPrices(snap: MarketSnapshot): MarketPrices {
  const scale = natToNumber(snap.priceScale);
  const list = snap.prices.map((row) => toPriceRow(row, scale));
  const rows: Record<string, MarketPriceRow> = {};
  for (const row of list) rows[row.material] = row;
  return {
    at: nanosToMs(snap.at),
    feeBp: natToNumber(snap.feeBp),
    wholesaleSpreadBp: natToNumber(snap.wholesaleSpreadBp),
    rows,
    list,
    swaps: natToNumber(snap.swaps),
    feeBurnedCents: natToNumber(snap.feeBurnedCents),
  };
}

function decodeQuoteResult(res: unknown, scale: number): MarketQuoteResult {
  if (variantKey(res) !== "ok") {
    return {
      ok: false,
      error: marketErrorText(variantPayload(res, "err")),
      quote: null,
    };
  }
  const q = variantPayload(res, "ok") as SwapQuote | null;
  if (!q) return { ok: false, error: MARKET_OFFLINE, quote: null };
  return {
    ok: true,
    error: null,
    quote: {
      fromAsset: q.fromAsset,
      toAsset: q.toAsset,
      amountIn: natToNumber(q.amountIn),
      amountOut: natToNumber(q.amountOut),
      midAmountOut: natToNumber(q.midAmountOut),
      midCents: centsFromE4(q.midCentsE4, scale),
      midCentsTo: centsFromE4(q.midCentsE4To, scale),
      priceImpactBp: natToNumber(q.priceImpactBp),
      feeCents: natToNumber(q.feeCents),
      route: [...q.route],
    },
  };
}

function decodeSwapResult(res: unknown, scale: number): MarketActionResult {
  if (variantKey(res) !== "ok") {
    return marketFail(marketErrorText(variantPayload(res, "err")));
  }
  const r = variantPayload(res, "ok") as SwapReceipt | null;
  if (!r) return marketOk({});
  const balanceCents = natToNumber(r.balanceCents);
  return marketOk({
    balanceCents,
    swap: {
      fromAsset: r.fromAsset,
      toAsset: r.toAsset,
      amountIn: natToNumber(r.amountIn),
      amountOut: natToNumber(r.amountOut),
      feeCents: natToNumber(r.feeCents),
      priceImpactBp: natToNumber(r.priceImpactBp),
      balanceCents,
      midCents: centsFromE4(r.midCentsE4, scale),
      midCentsTo: centsFromE4(r.midCentsE4To, scale),
      at: nanosToMs(r.at),
    },
  });
}

function decodeOrderResult(res: unknown, me: string): MarketActionResult {
  if (variantKey(res) !== "ok") {
    return marketFail(marketErrorText(variantPayload(res, "err")));
  }
  const order = variantPayload(res, "ok") as Order | null;
  return marketOk({ order: order ? toMarketOrder(order, me) : null });
}

function decodeBuyResult(res: unknown, me: string): MarketActionResult {
  if (variantKey(res) !== "ok") {
    return marketFail(marketErrorText(variantPayload(res, "err")));
  }
  const bought = variantPayload(res, "ok") as Purchase | null;
  if (!bought) return marketOk({});
  return marketOk({
    order: toMarketOrder(bought.order, me),
    costCents: natToNumber(bought.costCents),
  });
}

function decodeBalanceResult(res: unknown): MarketActionResult {
  if (variantKey(res) !== "ok") {
    return marketFail(marketErrorText(variantPayload(res, "err")));
  }
  const cents = variantPayload(res, "ok") as bigint | number | null;
  return marketOk({ balanceCents: cents == null ? null : natToNumber(cents) });
}

type MarketAction =
  | {
      kind: "create";
      material: string;
      amount: number;
      pricePerUnitCents: number;
    }
  | { kind: "cancel"; orderId: number }
  | { kind: "buy"; orderId: number; amount: number }
  | { kind: "wholesale"; material: string; amount: number }
  | {
      kind: "swap";
      fromAsset: SwapAsset;
      toAsset: SwapAsset;
      amountIn: number;
      minAmountOut: number;
      /** Snapshot scale, so the receipt can be decoded without a refetch. */
      priceScale: number;
    };

function toNat(n: number): bigint {
  return BigInt(Math.max(0, Math.floor(n)));
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

  cloudSave: SaveOutput | null;
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

export function useBackendSync(): BackendSync {
  const {
    identity,
    isAuthenticated,
    isLoggingIn,
    isInitializing,
    loginError,
    login,
    clear,
  } = useInternetIdentity();
  const { actor } = useActor<backendInterface>(createActor);
  const qc = useQueryClient();
  const principal = identity?.getPrincipal().toText() ?? "anon";

  const profileQuery = useQuery({
    queryKey: ["profile", principal],
    enabled: !!actor && isAuthenticated,
    retry: false,
    staleTime: 30_000,
    queryFn: async (): Promise<ProfileOutput | null> => {
      if (!actor) return null;
      return unwrapOpt(await actor.getProfile());
    },
  });

  const profile = profileQuery.data ?? null;

  // Mirror connection status and display name into the store
  useEffect(() => {
    const st = useGame.getState();
    if (!isAuthenticated) {
      st.setCloud("offline");
      return;
    }
    if (st.cloudStatus === "offline") st.setCloud("online");
    if (profile && profile.name !== st.playerName)
      st.setPlayerName(profile.name);
  }, [isAuthenticated, profile]);

  const cloudQuery = useQuery({
    queryKey: ["cloudSave", principal],
    enabled: !!actor && isAuthenticated && !!profile?.hasSave,
    retry: false,
    staleTime: 30_000,
    queryFn: async (): Promise<SaveOutput | null> => {
      if (!actor) return null;
      return unwrapOpt(await actor.loadGame());
    },
  });

  const lbQuery = useQuery({
    queryKey: ["leaderboard"],
    enabled: !!actor,
    retry: false,
    staleTime: 20_000,
    queryFn: async (): Promise<LeaderboardEntry[]> => {
      if (!actor) return [];
      return await actor.getLeaderboard(25n);
    },
  });

  const gsQuery = useQuery({
    queryKey: ["globalStats"],
    enabled: !!actor,
    retry: false,
    staleTime: 30_000,
    queryFn: async (): Promise<GlobalStats | null> => {
      if (!actor) return null;
      return await actor.getGlobalStats();
    },
  });

  // ---------------- Marketplace ----------------
  // Wallet and order book live on chain; the materials themselves stay in the
  // local save, so the caller deducts/restocks them when an action succeeds.

  const balanceQuery = useQuery({
    queryKey: ["marketBalance", principal],
    enabled: !!actor && isAuthenticated,
    retry: false,
    staleTime: 15_000,
    queryFn: async (): Promise<number> => {
      if (!actor) return 0;
      return natToNumber(await actor.marketBalance());
    },
  });

  const ordersQuery = useQuery({
    queryKey: ["marketOrders"],
    enabled: !!actor,
    retry: false,
    staleTime: 15_000,
    queryFn: async (): Promise<Order[]> => {
      if (!actor) return [];
      return await actor.marketOrders();
    },
  });

  const marketOrders = useMemo(
    () => (ordersQuery.data ?? []).map((o) => toMarketOrder(o, principal)),
    [ordersQuery.data, principal],
  );

  // Exchange snapshot: oracle price, pool price and recent trend per material.
  // A public query, so it also works while signed out - the market can be
  // browsed before logging in. It keeps itself fresh on the same 20 s cycle
  // the leaderboard uses.
  const pricesQuery = useQuery({
    queryKey: ["marketPrices"],
    enabled: !!actor,
    retry: false,
    staleTime: 20_000,
    refetchInterval: 20_000,
    queryFn: async (): Promise<MarketSnapshot | null> => {
      if (!actor) return null;
      return await actor.marketPrices();
    },
  });

  const marketPrices = useMemo(
    () => (pricesQuery.data ? toMarketPrices(pricesQuery.data) : null),
    [pricesQuery.data],
  );

  // The scale is a backend constant; fall back to it so a quote taken before
  // the first snapshot still converts correctly.
  const priceScale = pricesQuery.data
    ? natToNumber(pricesQuery.data.priceScale)
    : 10_000;

  const marketMutation = useMutation({
    mutationFn: async (action: MarketAction): Promise<MarketActionResult> => {
      if (!actor || !isAuthenticated) return marketFail(MARKET_OFFLINE);
      switch (action.kind) {
        case "create":
          return decodeOrderResult(
            await actor.marketCreate(
              action.material,
              toNat(action.amount),
              toNat(action.pricePerUnitCents),
            ),
            principal,
          );
        case "cancel":
          return decodeOrderResult(
            await actor.marketCancel(toNat(action.orderId)),
            principal,
          );
        case "buy":
          return decodeBuyResult(
            await actor.marketBuy(toNat(action.orderId), toNat(action.amount)),
            principal,
          );
        case "wholesale":
          return decodeBalanceResult(
            await actor.marketSellWholesale(
              action.material,
              toNat(action.amount),
            ),
          );
        default:
          return decodeSwapResult(
            await actor.marketSwap(
              action.fromAsset,
              action.toAsset,
              toNat(action.amountIn),
              toNat(action.minAmountOut),
            ),
            action.priceScale,
          );
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["marketOrders"] });
      void qc.invalidateQueries({ queryKey: ["marketBalance", principal] });
      void qc.invalidateQueries({ queryKey: ["marketPrices"] });
    },
  });

  const runMarket = marketMutation.mutateAsync;
  const marketAction = useCallback(
    async (action: MarketAction): Promise<MarketActionResult> => {
      if (!actor || !isAuthenticated) return marketFail(MARKET_OFFLINE);
      try {
        return await runMarket(action);
      } catch {
        return marketFail("The marketplace is not reachable");
      }
    },
    [actor, isAuthenticated, runMarket],
  );

  const createOrder = useCallback(
    (material: string, amount: number, pricePerUnitCents: number) =>
      marketAction({ kind: "create", material, amount, pricePerUnitCents }),
    [marketAction],
  );
  const cancelOrder = useCallback(
    (orderId: number) => marketAction({ kind: "cancel", orderId }),
    [marketAction],
  );
  const buyOrder = useCallback(
    (orderId: number, amount: number) =>
      marketAction({ kind: "buy", orderId, amount }),
    [marketAction],
  );
  const sellWholesale = useCallback(
    (material: string, amount: number) =>
      marketAction({ kind: "wholesale", material, amount }),
    [marketAction],
  );

  const marketSwap = useCallback(
    (
      fromAsset: SwapAsset,
      toAsset: SwapAsset,
      amountIn: number,
      minAmountOut: number,
    ) =>
      marketAction({
        kind: "swap",
        fromAsset,
        toAsset,
        amountIn,
        minAmountOut,
        priceScale,
      }),
    [marketAction, priceScale],
  );

  // A plain query, not a mutation: it must not flip `busy` or invalidate
  // anything, so the UI can call it on every keystroke behind a debounce.
  const marketQuote = useCallback(
    async (
      fromAsset: SwapAsset,
      toAsset: SwapAsset,
      amountIn: number,
    ): Promise<MarketQuoteResult> => {
      if (!actor) return { ok: false, error: MARKET_OFFLINE, quote: null };
      try {
        return decodeQuoteResult(
          await actor.marketQuote(fromAsset, toAsset, toNat(amountIn)),
          priceScale,
        );
      } catch {
        return {
          ok: false,
          error: "The marketplace is not reachable",
          quote: null,
        };
      }
    },
    [actor, priceScale],
  );

  const refreshMarket = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["marketOrders"] });
    void qc.invalidateQueries({ queryKey: ["marketBalance", principal] });
    void qc.invalidateQueries({ queryKey: ["marketPrices"] });
  }, [qc, principal]);

  const refreshPrices = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["marketPrices"] });
  }, [qc]);

  const registerMutation = useMutation({
    mutationFn: async (name: string): Promise<RegisterOutcome> => {
      if (!actor) throw new Error("No connection");
      const res = await actor.registerProfile(name);
      const key = variantKey(res);
      if (key === "ok" || key === "alreadyRegistered") return "ok";
      if (key === "nameTaken") return "nameTaken";
      if (key === "invalidName") return "invalidName";
      if (key === "anonymous") return "anonymous";
      // Unknown response format: do not guess - the profile fetch below
      // decides whether the registration actually went through.
      return "error";
    },
    onSettled: async () => {
      // Whatever the response format: the truth is in the profile.
      // If it exists now, the control room switches to the menu right away.
      try {
        if (actor) {
          const p = unwrapOpt(await actor.getProfile());
          if (p) qc.setQueryData(["profile", principal], p);
        }
      } catch {
        /* Direct fetch failed - the invalidation below picks it up */
      }
      void qc.invalidateQueries({ queryKey: ["profile", principal] });
      void qc.invalidateQueries({ queryKey: ["leaderboard"] });
    },
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!actor || !isAuthenticated) throw new Error("Not signed in");
      const st = useGame.getState();
      const input: SaveInput = {
        xp: BigInt(Math.floor(st.xp)),
        level: BigInt(levelFromXp(st.xp).level),
        totalCollected: BigInt(st.stats.collected),
        totalDisposed: BigInt(st.stats.disposed),
        recyclePoints: BigInt(Math.floor(st.recyclePoints)),
        data: JSON.stringify(st.serialize()),
      };
      useGame.getState().setCloud("sync");
      const ok = await actor.saveGame(input);
      if (!ok) throw new Error("Save rejected");
    },
    onSuccess: () => {
      const st = useGame.getState();
      st.setCloud("online");
      st.clearDirty();
      void qc.invalidateQueries({ queryKey: ["leaderboard"] });
      void qc.invalidateQueries({ queryKey: ["globalStats"] });
      void qc.invalidateQueries({ queryKey: ["profile", principal] });
      void qc.invalidateQueries({ queryKey: ["cloudSave", principal] });
    },
    onError: () => {
      useGame.getState().setCloud("error", "Saving to the profile failed");
    },
  });

  const resetMutation = useMutation({
    mutationFn: async () => {
      if (!actor || !isAuthenticated) throw new Error("Not signed in");
      await actor.resetProgress();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["profile", principal] });
      void qc.invalidateQueries({ queryKey: ["cloudSave", principal] });
    },
  });

  // Automatic save every five minutes, provided there are changes
  const savingRef = useRef(false);
  savingRef.current = saveMutation.isPending;
  const saveFn = saveMutation.mutate;
  useEffect(() => {
    if (!isAuthenticated || !actor) return;
    const t = window.setInterval(() => {
      const st = useGame.getState();
      if (st.cloudDirty && st.screen === "game" && !savingRef.current) saveFn();
    }, AUTOSAVE_MS);
    return () => window.clearInterval(t);
  }, [isAuthenticated, actor, saveFn]);

  const loadProfileIntoGame = useCallback(() => {
    const out = cloudQuery.data;
    const st = useGame.getState();
    if (!out || out.data.length === 0) return;
    try {
      st.applySave(JSON.parse(out.data) as SaveData);
      st.setScreen("game");
      st.setCloud("online");
      st.clearDirty();
    } catch {
      st.setCloud("error", "The save game in the profile is unreadable");
    }
  }, [cloudQuery.data]);

  const startFreshRun = useCallback(() => {
    const name = useGame.getState().playerName;
    resetMutation.mutate();
    useGame.getState().newGame(name);
  }, [resetMutation.mutate]);

  const checkNameAvailable = useCallback(
    async (name: string): Promise<boolean> => {
      if (!actor) return false;
      try {
        return await actor.isNameAvailable(name);
      } catch {
        return false;
      }
    },
    [actor],
  );

  return {
    isAuthenticated,
    isLoggingIn,
    authInitializing: isInitializing,
    loginError,
    login: () => login(),
    logout: clear,

    profile,
    profileChecking:
      isAuthenticated && !profileQuery.isSuccess && !profileQuery.isError,
    profileError: profileQuery.isError,
    retryProfile: () => {
      void profileQuery.refetch();
    },
    needsRegistration: isAuthenticated && profileQuery.isSuccess && !profile,
    registerName: (name: string) => {
      registerMutation.mutate(name);
    },
    registerBusy: registerMutation.isPending,
    registerOutcome: registerMutation.isError
      ? "error"
      : (registerMutation.data ?? null),
    clearRegisterOutcome: () => registerMutation.reset(),
    checkNameAvailable,

    cloudSave: cloudQuery.data ?? null,
    cloudChecking: cloudQuery.isFetching,
    loadProfileIntoGame,
    loadBusy: cloudQuery.isFetching,
    saveToProfile: () => saveMutation.mutate(),
    saveBusy: saveMutation.isPending,
    startFreshRun,
    resetBusy: resetMutation.isPending,

    // null = no connection (so the UI shows "No connection" instead of the
    // misleading "No entries yet" when there is simply no actor/session).
    leaderboard: !actor || lbQuery.isError ? null : (lbQuery.data ?? []),
    globalStats: gsQuery.data ?? null,
    leaderboardBusy: lbQuery.isFetching,
    refreshLeaderboard: () => {
      void qc.invalidateQueries({ queryKey: ["leaderboard"] });
      void qc.invalidateQueries({ queryKey: ["globalStats"] });
    },

    market: {
      // Without a connection the market renders empty instead of failing.
      balanceCents:
        !actor || !isAuthenticated ? null : (balanceQuery.data ?? null),
      orders: marketOrders,
      busy:
        marketMutation.isPending ||
        ordersQuery.isFetching ||
        balanceQuery.isFetching,
      error: !actor
        ? MARKET_OFFLINE
        : ordersQuery.isError || balanceQuery.isError
          ? "The marketplace is not reachable"
          : marketMutation.data && !marketMutation.data.ok
            ? marketMutation.data.error
            : null,
      refresh: refreshMarket,
      createOrder,
      cancelOrder,
      buy: buyOrder,
      sellWholesale,

      // Without a connection the exchange renders empty and every action
      // answers MARKET_OFFLINE, so no material is ever moved locally.
      prices: !actor || pricesQuery.isError ? null : marketPrices,
      pricesBusy: pricesQuery.isFetching,
      refreshPrices,
      quote: marketQuote,
      swap: marketSwap,
    },
  };
}
