// Trash Simulator – exchange: the price board. Live pool mid, oracle
// reference, deviation and a 24-point trend line for every material.
import { useEffect } from "react";
import { MATERIALS, formatCents, isMaterialId } from "../game/types";
import type { MarketPriceRow, MarketSlice } from "../hooks/useBackendSync";
import {
  AssetIcon,
  EM_DASH,
  Sparkline,
  Spinner,
  ToneChip,
  assetColor,
  assetName,
  assetTicker,
  formatCentsFine,
} from "./MenuMarketUi";
import { EmptyNote, Panel, SectionHead, num } from "./MenuUi";

export interface PricesViewProps {
  market: MarketSlice;
}

export function PricesView({ market }: PricesViewProps) {
  const prices = market.prices;
  const refresh = market.refreshPrices;

  // A fresh snapshot whenever the board is opened.
  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <Panel className="p-4">
      <SectionHead
        label="Price board"
        hint="Pool mid against the reference price. The pool moves with every swap; the reference does not."
        right={
          <div className="flex h-4 items-center justify-end">
            {market.pricesBusy ? (
              <Spinner size={13} />
            ) : (
              <span className="ts-mono text-[11px] text-white/35">
                {prices ? `${prices.list.length} markets` : EM_DASH}
              </span>
            )}
          </div>
        }
      />

      {!prices ? (
        <EmptyNote>
          No connection to the exchange. Sign in to see live prices.
        </EmptyNote>
      ) : (
        <>
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full min-w-[520px] border-collapse">
              <thead>
                <tr className="border-b border-white/10">
                  <th className="ts-label pb-2 text-left font-normal">
                    Material
                  </th>
                  <th className="ts-label pb-2 text-right font-normal">
                    Pool mid
                  </th>
                  <th className="ts-label pb-2 text-right font-normal">
                    Reference
                  </th>
                  <th className="ts-label pb-2 text-right font-normal">
                    Deviation
                  </th>
                  <th className="ts-label pb-2 text-right font-normal">
                    Trend
                  </th>
                </tr>
              </thead>
              <tbody>
                {prices.list.map((row) => (
                  <PriceRow key={row.material} row={row} />
                ))}
              </tbody>
            </table>
          </div>

          <p className="ts-mono mt-3 text-[11px] leading-relaxed text-white/30">
            Wholesale desk pays {(prices.wholesaleSpreadBp / 100).toFixed(0)} %
            below the reference · {num(prices.swaps)} swaps ·{" "}
            {formatCents(prices.feeBurnedCents)} in fees burnt. Every figure is
            in-game money.
          </p>
        </>
      )}
    </Panel>
  );
}

function PriceRow({ row }: { row: MarketPriceRow }) {
  const def = isMaterialId(row.material) ? MATERIALS[row.material] : null;
  const color = assetColor(row.material);
  const dev = Math.round(row.deviationBp);

  return (
    <tr className="border-b border-white/[0.05] last:border-0">
      <td className="py-2 pr-3 align-middle">
        <div className="flex items-center gap-2.5">
          <AssetIcon asset={row.material} size={24} />
          <div className="min-w-0">
            <div className="truncate text-[13px] text-white/85">
              {assetName(row.material)}
              <span className="ts-mono ml-1.5 text-[11px] text-white/35">
                {assetTicker(row.material)}
              </span>
            </div>
            <div className="ts-mono text-[10px] text-white/30">
              max {num(row.maxSellUnits)} {def?.unit ?? "units"} sell ·{" "}
              {formatCents(row.maxBuyCents)} buy
            </div>
          </div>
        </div>
      </td>
      <td className="ts-mono py-2 pr-3 text-right align-middle text-[13px] text-white/85">
        {formatCentsFine(row.midCents)}
        {def && (
          <span className="ml-1 text-[10px] text-white/30">/{def.unit}</span>
        )}
      </td>
      <td className="ts-mono py-2 pr-3 text-right align-middle text-[12px] text-white/45">
        {formatCentsFine(row.oracleCents)}
      </td>
      <td className="py-2 pr-3 text-right align-middle">
        <ToneChip tone={dev < 0 ? "bad" : "good"}>
          {dev > 0 ? "+" : dev < 0 ? "−" : ""}
          {Math.abs(dev)} bp
        </ToneChip>
      </td>
      <td className="py-2 text-right align-middle">
        <div className="flex justify-end">
          <Sparkline points={row.trend} color={color} />
        </div>
      </td>
    </tr>
  );
}
