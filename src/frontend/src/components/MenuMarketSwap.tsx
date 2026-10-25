// Trash Simulator – exchange: the swap card. Market orders against the
// backend's virtual market maker. Layout follows the multidex swap panel:
// Sell block, a flip button punched into the seam, Buy block, then one tight
// column of preview rows. All money in this game is fictional.
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useGame } from "../game/state";
import type { MaterialId } from "../game/types";
import {
  MATERIALS,
  MATERIAL_IDS,
  formatCents,
  isMaterialId,
} from "../game/types";
import type {
  MarketPrices,
  MarketSlice,
  MarketSwapQuote,
  SwapAsset,
} from "../hooks/useBackendSync";
import { MARKET_TOO_LARGE, USD_ASSET } from "../hooks/useBackendSync";
import {
  ASSET_IDS,
  AssetIcon,
  EM_DASH,
  InfoRow,
  Spinner,
  ToneChip,
  assetName,
  assetTicker,
  formatAssetAmount,
  formatAssetShort,
  formatBpSigned,
  formatCentsFine,
  impactLabel,
  impactTone,
  isUsd,
} from "./MenuMarketUi";
import { EmptyNote, Panel, num } from "./MenuUi";

/** Both debounce layers in the multidex swap preview are 250 ms. */
const QUOTE_DEBOUNCE_MS = 250;

/** Slippage tolerance presets, in basis points. */
const SLIPPAGE_PRESETS: ReadonlyArray<readonly [number, string]> = [
  [50, "0.5 %"],
  [100, "1 %"],
  [300, "3 %"],
];

function toast(text: string, kind: "info" | "good" | "warn" = "info") {
  useGame.getState().toast(text, kind);
}

/** Typed text → whole cents (dollars) or whole units (material). */
function parseAmount(asset: SwapAsset, text: string): number {
  const n = Number.parseFloat(text.replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return isUsd(asset) ? Math.round(n * 100) : Math.floor(n);
}

/** Whole cents/units → the text the input shows. */
function amountToText(asset: SwapAsset, amount: number): string {
  if (amount <= 0) return "";
  return isUsd(asset) ? (amount / 100).toFixed(2) : String(amount);
}

/** Largest swap this pool takes right now, in the sold asset's own unit. */
function poolCap(
  from: SwapAsset,
  to: SwapAsset,
  prices: MarketPrices | null,
): number {
  if (!prices) return Number.POSITIVE_INFINITY;
  if (isMaterialId(from))
    return prices.rows[from]?.maxSellUnits ?? Number.POSITIVE_INFINITY;
  // Selling dollars: the limit belongs to the pool being bought into.
  if (isMaterialId(to))
    return prices.rows[to]?.maxBuyCents ?? Number.POSITIVE_INFINITY;
  return Number.POSITIVE_INFINITY;
}

/**
 * The rate always reads from the material's side – "1 kg PET flakes ≈ $3.42"
 * is legible, "$1.00 ≈ 0.29 kg" is not. Like multidex it is net of the fee,
 * because that is what the player actually gets per unit.
 */
function rateLine(q: MarketSwapQuote): string | null {
  if (q.amountIn <= 0 || q.amountOut <= 0) return null;
  if (isMaterialId(q.fromAsset)) {
    const def = MATERIALS[q.fromAsset];
    const per = q.amountOut / q.amountIn;
    if (isMaterialId(q.toAsset)) {
      const other = MATERIALS[q.toAsset];
      const dp = per >= 100 ? 0 : per >= 1 ? 2 : 4;
      return `1 ${def.unit} ${def.name} ≈ ${per.toFixed(dp)} ${other.unit} ${other.name}`;
    }
    return `1 ${def.unit} ${def.name} ≈ ${formatCentsFine(per)}`;
  }
  if (isMaterialId(q.toAsset)) {
    const def = MATERIALS[q.toAsset];
    return `1 ${def.unit} ${def.name} ≈ ${formatCentsFine(q.amountIn / q.amountOut)}`;
  }
  return null;
}

export interface SwapViewProps {
  market: MarketSlice;
}

export function SwapView({ market }: SwapViewProps) {
  const materials = useGame((s) => s.materials);
  const prices = market.prices;
  const offline = market.balanceCents === null;

  const owned = MATERIAL_IDS.filter((m) => materials[m] > 0);
  // Start on the most valuable stack – that is what a player comes here to sell.
  const [sellAsset, setSellAsset] = useState<SwapAsset>(() => {
    let best: SwapAsset = USD_ASSET;
    let bestValue = 0;
    for (const m of owned) {
      const v = materials[m] * MATERIALS[m].basePriceCents;
      if (v > bestValue) {
        bestValue = v;
        best = m;
      }
    }
    return best;
  });
  const [buyAsset, setBuyAsset] = useState<SwapAsset>(() =>
    owned[0] ? USD_ASSET : "pet_flake",
  );
  const [amountText, setAmountText] = useState("");
  const [slippageBp, setSlippageBp] = useState(100);
  const [quote, setQuote] = useState<MarketSwapQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [picker, setPicker] = useState<"sell" | "buy" | null>(null);

  const amountIn = parseAmount(sellAsset, amountText);
  const cap = poolCap(sellAsset, buyAsset, prices);
  const sellBalance = isMaterialId(sellAsset)
    ? materials[sellAsset]
    : market.balanceCents;
  const buyBalance = isMaterialId(buyAsset)
    ? materials[buyAsset]
    : market.balanceCents;

  // Quote on every keystroke, debounced, with a sequence guard: the promises
  // may resolve out of order, so a stale reply must never win.
  const askQuote = market.quote;
  const seqRef = useRef(0);
  useEffect(() => {
    if (amountIn <= 0 || sellAsset === buyAsset) {
      seqRef.current++;
      setQuote(null);
      setQuoteError(null);
      setQuoting(false);
      return;
    }
    const seq = ++seqRef.current;
    setQuoting(true);
    const timer = window.setTimeout(async () => {
      const res = await askQuote(sellAsset, buyAsset, amountIn);
      if (seqRef.current !== seq) return;
      setQuoting(false);
      if (seqRef.current !== seq) return;
      if (res.ok && res.quote) {
        setQuote(res.quote);
        setQuoteError(null);
      } else {
        setQuote(null);
        setQuoteError(res.error);
      }
    }, QUOTE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [askQuote, sellAsset, buyAsset, amountIn]);

  const pickAsset = (side: "sell" | "buy", id: SwapAsset) => {
    setPicker(null);
    // Never the same asset twice: multidex moves the other side instead of
    // greying options out, so the pair the player built is preserved.
    if (side === "sell") {
      if (id === buyAsset) setBuyAsset(sellAsset);
      setSellAsset(id);
      setAmountText((t) => (isUsd(id) === isUsd(sellAsset) ? t : ""));
    } else {
      if (id === sellAsset) setSellAsset(buyAsset);
      setBuyAsset(id);
    }
  };

  const flip = () => {
    setPicker(null);
    const from = sellAsset;
    setSellAsset(buyAsset);
    setBuyAsset(from);
    // The output becomes the new input – keep it if the unit still matches.
    setAmountText(quote ? amountToText(buyAsset, quote.amountOut) : "");
  };

  const fillMax = () => {
    const max = Math.min(sellBalance ?? 0, cap);
    setAmountText(max > 0 ? amountToText(sellAsset, Math.floor(max)) : "");
  };

  const amountOut = quote?.amountOut ?? 0;
  const minOut = quote
    ? Math.floor(quote.amountOut * (1 - slippageBp / 10_000))
    : 0;
  const legs = Math.max(1, quote ? quote.route.length - 1 : 1);
  const feeBp = (prices?.feeBp ?? 30) * legs;

  const refAsset: MaterialId | null = isMaterialId(sellAsset)
    ? sellAsset
    : isMaterialId(buyAsset)
      ? buyAsset
      : null;
  const refRow = refAsset && prices ? (prices.rows[refAsset] ?? null) : null;

  const insufficient = sellBalance !== null && amountIn > sellBalance;
  const tooLarge = amountIn > cap || quoteError === MARKET_TOO_LARGE;

  const canSwap =
    !offline &&
    !market.busy &&
    !submitting &&
    !quoting &&
    !insufficient &&
    !tooLarge &&
    amountIn > 0 &&
    quote !== null &&
    quote.amountOut > 0;

  const doSwap = market.swap;
  const onSwap = useCallback(async () => {
    // Revalidate here as well – the button is only the first gate.
    if (!quote || quote.amountOut <= 0 || amountIn <= 0) return;
    const st = useGame.getState();
    const sellId = isMaterialId(sellAsset) ? sellAsset : null;
    // Escrow: the material leaves the store before the call, so a failed swap
    // can never spend it twice. It goes straight back if the call is refused.
    if (sellId && !st.takeMaterials(sellId, amountIn)) {
      toast("Not enough material in store.", "warn");
      return;
    }
    setSubmitting(true);
    const limit = Math.floor(quote.amountOut * (1 - slippageBp / 10_000));
    const res = await doSwap(sellAsset, buyAsset, amountIn, limit);
    setSubmitting(false);
    if (!res.ok) {
      if (sellId) useGame.getState().addMaterials(sellId, amountIn);
      toast(res.error ?? "The swap did not go through.", "warn");
      return;
    }
    const receipt = res.swap;
    const paid = receipt?.amountIn ?? amountIn;
    const got = receipt?.amountOut ?? quote.amountOut;
    if (isMaterialId(buyAsset)) useGame.getState().addMaterials(buyAsset, got);
    toast(
      `Swapped ${formatAssetAmount(sellAsset, paid)} → ${formatAssetAmount(buyAsset, got)}`,
      "good",
    );
    setAmountText("");
    setQuote(null);
  }, [quote, amountIn, sellAsset, buyAsset, slippageBp, doSwap]);

  // Button ladder – offline first, then the reasons the player can act on.
  let label = "Swap";
  let spinner = false;
  if (offline) label = "Sign in to trade";
  else if (submitting) {
    label = "Swapping …";
    spinner = true;
  } else if (amountIn <= 0) label = "Enter an amount";
  else if (insufficient)
    label = isMaterialId(sellAsset)
      ? `Insufficient ${MATERIALS[sellAsset].name}`
      : "Insufficient balance";
  else if (tooLarge) label = "Too large for this market";
  else if (quoting) label = "Fetching a quote …";
  else if (!quote) label = quoteError ?? "No quote available";

  const sellOptions: SwapAsset[] = [USD_ASSET, ...owned];
  const impact = quote?.priceImpactBp ?? 0;

  return (
    <div className="space-y-3">
      <Panel className="p-3">
        <div className="mb-2.5 flex items-center justify-between gap-3 px-1">
          <div className="ts-display text-[20px] tracking-normal">Swap</div>
          <span className="ts-mono text-[11px] text-white/35">
            {prices
              ? `Fee ${(prices.feeBp / 100).toFixed(2)} % per leg`
              : "Market maker offline"}
          </span>
        </div>

        {/* Sell / flip / Buy – the flip button is punched into the seam */}
        <div className="relative">
          <SwapSide
            label="Sell"
            asset={sellAsset}
            balance={sellBalance}
            options={sellOptions}
            pickerOpen={picker === "sell"}
            onTogglePicker={() => setPicker(picker === "sell" ? null : "sell")}
            onPick={(id) => pickAsset("sell", id)}
            materials={materials}
            balanceCents={market.balanceCents}
            onMax={fillMax}
            maxDisabled={offline && !isMaterialId(sellAsset)}
          >
            <div className="flex min-w-0 items-baseline gap-0.5">
              {isUsd(sellAsset) && (
                <span
                  className={`ts-mono shrink-0 text-[26px] font-medium ${
                    amountIn > 0 ? "text-white/60" : "text-white/25"
                  }`}
                >
                  $
                </span>
              )}
              <input
                type="text"
                inputMode="decimal"
                value={amountText}
                placeholder="0.0"
                aria-label={`Amount of ${assetName(sellAsset)} to sell`}
                onChange={(e) => setAmountText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canSwap) void onSwap();
                }}
                className="ts-mono w-full min-w-0 bg-transparent text-[26px] font-medium text-white outline-none placeholder:text-white/25"
              />
            </div>
          </SwapSide>

          <div className="mt-1.5" />

          <SwapSide
            label="Buy"
            note={quoting ? "estimating …" : undefined}
            asset={buyAsset}
            balance={buyBalance}
            options={ASSET_IDS}
            pickerOpen={picker === "buy"}
            onTogglePicker={() => setPicker(picker === "buy" ? null : "buy")}
            onPick={(id) => pickAsset("buy", id)}
            materials={materials}
            balanceCents={market.balanceCents}
          >
            <div
              className={`ts-mono truncate text-[26px] font-medium ${
                quoting
                  ? "animate-pulse text-white/30"
                  : amountOut > 0
                    ? "text-white"
                    : "text-white/25"
              }`}
            >
              {amountOut > 0
                ? isUsd(buyAsset)
                  ? formatCents(amountOut)
                  : num(amountOut)
                : "0.0"}
            </div>
          </SwapSide>

          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <button
              type="button"
              onClick={flip}
              aria-label="Swap the two assets"
              className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full border-[3px] border-[rgba(9,20,28,0.95)] bg-[#1e2f3a] text-[17px] leading-none text-white/85 transition hover:bg-[#2a4150] hover:text-[var(--amber)] active:translate-y-px"
            >
              ↓
            </button>
          </div>
        </div>

        {/* Preview rows – a reserved minimum height so nothing jumps */}
        <div className="mt-3 min-h-[22px] px-1">
          {quote && (
            <>
              <InfoRow label="Rate">
                <span>{rateLine(quote) ?? EM_DASH}</span>
              </InfoRow>
              {refRow && (
                <InfoRow label="Oracle reference">
                  <span>
                    ref. {formatCentsFine(refRow.oracleCents)} · pool{" "}
                    <span
                      className={
                        refRow.deviationBp < 0
                          ? "text-red-300/90"
                          : "text-emerald-300/90"
                      }
                    >
                      {formatBpSigned(refRow.deviationBp)}
                    </span>
                  </span>
                </InfoRow>
              )}
              <InfoRow label="Price impact">
                <ToneChip tone={impactTone(impact)}>
                  {impactLabel(impact)}
                </ToneChip>
              </InfoRow>
              <InfoRow label="Fee">
                <span>
                  {formatCents(quote.feeCents)} · {(feeBp / 100).toFixed(2)} %
                  {legs > 1 ? ` (${legs} legs)` : ""}
                </span>
              </InfoRow>
              <InfoRow label="Minimum received">
                <span>{formatAssetShort(buyAsset, minOut)}</span>
              </InfoRow>
            </>
          )}
          {!quote &&
            !quoting &&
            amountIn > 0 &&
            quoteError &&
            !tooLarge &&
            !insufficient && (
              <p className="text-[12px] leading-relaxed text-amber-200/85">
                {quoteError}
              </p>
            )}
          {!quote && !quoteError && !quoting && (
            <p className="text-[12px] text-white/35">
              Enter an amount to see the rate, the price impact and the fee.
            </p>
          )}
        </div>

        {/* Slippage tolerance */}
        <div className="mt-3 flex items-center justify-between gap-3 px-1">
          <span className="text-[12px] text-white/45">Max. slippage</span>
          <div className="flex gap-1">
            {SLIPPAGE_PRESETS.map(([bp, text]) => (
              <button
                key={bp}
                type="button"
                onClick={() => setSlippageBp(bp)}
                className={`ts-mono rounded-md px-2 py-1 text-[11px] transition ${
                  slippageBp === bp
                    ? "bg-white/15 text-white"
                    : "bg-white/[0.05] text-white/45 hover:bg-white/10"
                }`}
              >
                {text}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          onClick={() => void onSwap()}
          disabled={!canSwap}
          className={`mt-3 flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-[14px] font-bold transition active:translate-y-px ${
            canSwap
              ? "bg-[var(--amber)] text-[#17130a] hover:bg-[#ffb42a]"
              : "cursor-not-allowed bg-white/[0.07] text-white/35"
          }`}
        >
          {spinner && <Spinner size={14} />}
          {label}
        </button>

        {tooLarge && !insufficient && amountIn > 0 && Number.isFinite(cap) && (
          // Like the multidex partial-fill hint, the limit is also the fix.
          <button
            type="button"
            onClick={() => setAmountText(amountToText(sellAsset, cap))}
            className="ts-mono mt-1.5 px-1 text-left text-[11px] text-amber-200/80 underline decoration-amber-200/30 underline-offset-2 transition hover:text-amber-100"
          >
            This pool takes at most {formatAssetShort(sellAsset, cap)} in one go
            – tap to fill.
          </button>
        )}
      </Panel>

      {offline && (
        <EmptyNote>
          The exchange is offline. Sign in to swap materials for dollars at the
          live pool price.
        </EmptyNote>
      )}
      {!offline && owned.length === 0 && (
        <EmptyNote>
          No materials in store yet – you can still buy some with dollars, or
          hand trash in at the station first.
        </EmptyNote>
      )}
    </div>
  );
}

/** One half of the card: label, big amount, asset chip, balance line. */
function SwapSide({
  label,
  note,
  asset,
  balance,
  options,
  pickerOpen,
  onTogglePicker,
  onPick,
  materials,
  balanceCents,
  onMax,
  maxDisabled,
  children,
}: {
  label: string;
  note?: string;
  asset: SwapAsset;
  balance: number | null;
  options: readonly SwapAsset[];
  pickerOpen: boolean;
  onTogglePicker: () => void;
  onPick: (id: SwapAsset) => void;
  materials: Record<MaterialId, number>;
  balanceCents: number | null;
  onMax?: () => void;
  maxDisabled?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // A ref keeps the listener effect stable across renders.
  const closeRef = useRef(onTogglePicker);
  closeRef.current = onTogglePicker;

  // Close on an outside click or Escape, like the multidex dropdown.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closeRef.current();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen]);

  return (
    <div
      ref={ref}
      className="relative rounded-2xl border border-white/[0.08] bg-black/30 px-4 py-3"
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="ts-label">{label}</span>
        {note && (
          <span className="ts-mono animate-pulse text-[11px] text-white/40">
            {note}
          </span>
        )}
      </div>

      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">{children}</div>
        <button
          type="button"
          onClick={onTogglePicker}
          className="flex shrink-0 items-center gap-1.5 rounded-full border border-white/12 bg-white/[0.07] py-1 pl-1 pr-2.5 text-[13px] font-semibold text-white/90 transition hover:bg-white/[0.14]"
        >
          <AssetIcon asset={asset} size={24} />
          <span className="ts-mono">{assetTicker(asset)}</span>
          <span className="text-[10px] text-white/45">▾</span>
        </button>
      </div>

      <div className="mt-1.5 flex items-center gap-2">
        <span className="ts-mono text-[12px] text-white/40">
          Balance:{" "}
          {balance === null ? EM_DASH : formatAssetShort(asset, balance)}
        </span>
        {onMax && (
          <button
            type="button"
            onClick={onMax}
            disabled={maxDisabled || !balance}
            className="ts-mono rounded px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] text-[var(--amber)] transition hover:bg-[rgba(242,160,7,0.14)] disabled:cursor-not-allowed disabled:text-white/25 disabled:hover:bg-transparent"
          >
            Max
          </button>
        )}
      </div>

      {pickerOpen && (
        <div className="scroll-thin absolute right-3 top-[66px] z-20 max-h-64 w-60 overflow-y-auto rounded-xl border border-white/12 bg-[#0c1a23] p-1 shadow-2xl">
          {options.map((id) => {
            const bal = isMaterialId(id) ? materials[id] : balanceCents;
            return (
              <button
                key={id}
                type="button"
                onClick={() => onPick(id)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition ${
                  id === asset ? "bg-white/[0.09]" : "hover:bg-white/[0.06]"
                }`}
              >
                <AssetIcon asset={id} size={22} />
                <span className="min-w-0 flex-1">
                  <span className="ts-mono block text-[12px] text-white/85">
                    {assetTicker(id)}
                  </span>
                  <span className="block truncate text-[11px] text-white/40">
                    {assetName(id)}
                  </span>
                </span>
                <span className="ts-mono shrink-0 text-[11px] text-white/45">
                  {bal === null ? EM_DASH : formatAssetShort(id, bal)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
