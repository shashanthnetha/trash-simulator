// Trash Simulator – marketplace tab, structured like an exchange:
//   Swap       market orders against the pool (instant, price impact, fee)
//   Order book limit orders and the wholesale desk
//   Prices     the live price board with trend lines
import { useEffect, useState } from "react";
import { formatCents } from "../game/types";
import type { MarketSlice } from "../hooks/useBackendSync";
import { BookView } from "./MenuMarketBook";
import { PricesView } from "./MenuMarketPrices";
import { SwapView } from "./MenuMarketSwap";
import { EM_DASH, SubNav } from "./MenuMarketUi";
import { Panel } from "./MenuUi";

export interface MarketTabProps {
  market: MarketSlice;
}

/** The order book is polled while the tab is open. */
const REFRESH_MS = 20_000;

type MarketView = "swap" | "book" | "prices";

const VIEWS: ReadonlyArray<readonly [MarketView, string]> = [
  ["swap", "Swap"],
  ["book", "Order book"],
  ["prices", "Prices"],
];

export function MarketTab({ market }: MarketTabProps) {
  const refresh = market.refresh;
  const [view, setView] = useState<MarketView>("swap");

  // Fresh on open, then kept up to date while the tab is visible.
  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  const offline = market.balanceCents === null;

  return (
    <div className="space-y-3">
      {/* Wallet */}
      <Panel className="px-4 py-3" tone={offline ? "warn" : "plain"}>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="ts-label">Balance</div>
            <div className="ts-display mt-1 text-[30px] tracking-normal text-white">
              {offline ? EM_DASH : formatCents(market.balanceCents ?? 0)}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {market.busy && (
              <span className="ts-mono text-[11px] text-white/45">
                Syncing …
              </span>
            )}
            <button
              type="button"
              onClick={refresh}
              disabled={market.busy}
              className="rounded-lg bg-white/10 px-3 py-1.5 text-[12px] font-medium transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Refresh
            </button>
          </div>
        </div>
        {offline && (
          <p className="mt-2 text-[12px] leading-relaxed text-amber-200/85">
            Offline — sign in to trade. You can still see your materials; swaps,
            orders and wholesale sales need a connection.
          </p>
        )}
        {!offline && market.error && (
          <p className="mt-2 text-[12px] leading-relaxed text-amber-200/85">
            {market.error}
          </p>
        )}
      </Panel>

      <SubNav items={VIEWS} value={view} onChange={setView} />

      {view === "swap" && <SwapView market={market} />}
      {view === "book" && <BookView market={market} />}
      {view === "prices" && <PricesView market={market} />}
    </div>
  );
}
