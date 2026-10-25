// Trash Simulator – exchange: limit orders and the wholesale desk. A limit
// order sits in the book until someone buys it; the wholesale desk pays out
// instantly at the reference price. Market orders live in the Swap view.
import { useEffect, useState } from "react";
import { useGame } from "../game/state";
import type { MaterialId } from "../game/types";
import {
  CATEGORIES,
  MATERIALS,
  MATERIAL_IDS,
  formatCents,
  isMaterialId,
} from "../game/types";
import type { MarketOrder, MarketSlice } from "../hooks/useBackendSync";
import {
  Chip,
  Dot,
  EmptyNote,
  Panel,
  SectionHead,
  Stepper,
  num,
} from "./MenuUi";

const MAX_AMOUNT = 100_000;
const MAX_PRICE_CENTS = 1_000_000;

function toast(text: string, kind: "info" | "good" | "warn" = "info") {
  useGame.getState().toast(text, kind);
}

function matName(id: string): string {
  return isMaterialId(id) ? MATERIALS[id].name : id;
}

function matUnit(id: string): string {
  return isMaterialId(id) ? MATERIALS[id].unit : "units";
}

function matColor(id: string): string {
  return isMaterialId(id)
    ? CATEGORIES[MATERIALS[id].category].color
    : "#8a9aa0";
}

/** Own orders first, then by material and cheapest price. */
function sortOrders(orders: MarketOrder[]): MarketOrder[] {
  return [...orders].sort(
    (a, b) =>
      Number(b.mine) - Number(a.mine) ||
      matName(a.material).localeCompare(matName(b.material)) ||
      a.pricePerUnitCents - b.pricePerUnitCents ||
      a.createdAt - b.createdAt,
  );
}

export interface BookViewProps {
  market: MarketSlice;
}

export function BookView({ market }: BookViewProps) {
  const materials = useGame((s) => s.materials);
  const owned = MATERIAL_IDS.filter((m) => materials[m] > 0);
  const orders = sortOrders(market.orders);

  return (
    <div className="space-y-3">
      {/* Order book */}
      <Panel className="p-4">
        <SectionHead
          label="Limit order book"
          hint="Open sell orders from every operator on the coast. A limit order waits for a buyer instead of paying the pool price."
          right={
            <span className="ts-mono text-[12px] text-white/50">
              {num(orders.length)} open
            </span>
          }
        />
        {orders.length === 0 ? (
          <EmptyNote>
            No open orders right now. Put your own material up for sale below.
          </EmptyNote>
        ) : (
          <ul className="space-y-2">
            {orders.map((o) => (
              <OrderRow key={o.id} order={o} market={market} />
            ))}
          </ul>
        )}
      </Panel>

      {/* Create an order */}
      <SellPanel market={market} owned={owned} />

      {/* Wholesaler */}
      <Panel className="p-4">
        <SectionHead
          label="Wholesale desk"
          hint="Instant sale at the reference price – no waiting for a buyer."
        />
        {owned.length === 0 ? (
          <EmptyNote>
            Nothing in store yet. Hand trash in at the station and let it be
            processed into material.
          </EmptyNote>
        ) : (
          <ul className="space-y-2">
            {owned.map((m) => (
              <WholesaleRow
                key={m}
                id={m}
                amount={materials[m]}
                market={market}
              />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------- order book

function OrderRow({
  order,
  market,
}: { order: MarketOrder; market: MarketSlice }) {
  const [amount, setAmount] = useState(1);
  const unit = matUnit(order.material);
  const max = Math.max(1, order.amount);
  const take = Math.min(Math.max(1, amount), max);
  const cost = take * order.pricePerUnitCents;
  const balance = market.balanceCents;
  const affordable = balance !== null && balance >= cost;

  const onCancel = async () => {
    const res = await market.cancelOrder(order.id);
    if (!res.ok) {
      toast(res.error ?? "The order could not be withdrawn.", "warn");
      return;
    }
    // The returned order carries what was left – that goes back into the store.
    const back = res.order?.amount ?? order.amount;
    if (isMaterialId(order.material) && back > 0) {
      useGame.getState().addMaterials(order.material, back);
    }
    toast(
      `Order withdrawn: ${num(back)} ${unit} ${matName(order.material)} back in store`,
      "good",
    );
  };

  const onBuy = async () => {
    const res = await market.buy(order.id, take);
    if (!res.ok) {
      toast(res.error ?? "The purchase failed.", "warn");
      return;
    }
    if (isMaterialId(order.material)) {
      useGame.getState().addMaterials(order.material, take);
    }
    toast(
      `Bought ${num(take)} ${unit} ${matName(order.material)} for ${formatCents(res.costCents ?? cost)}`,
      "good",
    );
  };

  return (
    <li
      className={`rounded-lg border px-3 py-2 ${
        order.mine
          ? "border-[rgba(242,160,7,0.3)] bg-[rgba(242,160,7,0.05)]"
          : "border-white/[0.07] bg-black/20"
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Dot color={matColor(order.material)} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] text-white/85">
              {matName(order.material)}
            </span>
            {order.mine && <Chip tone="amber">Yours</Chip>}
          </div>
          <div className="ts-mono text-[11px] text-white/40">
            {num(order.amount)} {unit} @ {formatCents(order.pricePerUnitCents)}/
            {unit} · {order.sellerName || "Unknown"}
          </div>
        </div>
        <div className="ts-mono text-right">
          <div className="text-[13px] text-white/75">
            {formatCents(order.amount * order.pricePerUnitCents)}
          </div>
          <div className="text-[10px] uppercase tracking-[0.14em] text-white/35">
            total
          </div>
        </div>
        {order.mine ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={market.busy}
            className="rounded-lg bg-white/10 px-3 py-1.5 text-[12px] font-semibold transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Withdraw
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <Stepper
              value={take}
              min={1}
              max={max}
              disabled={market.busy}
              onChange={setAmount}
            />
            <button
              type="button"
              onClick={onBuy}
              disabled={market.busy || !affordable}
              className={`rounded-lg px-3 py-1.5 text-[12px] font-bold transition active:translate-y-px ${
                affordable && !market.busy
                  ? "bg-emerald-400/90 text-emerald-950 hover:bg-emerald-300"
                  : "cursor-not-allowed bg-white/[0.07] text-white/35"
              }`}
            >
              Buy {formatCents(cost)}
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

// ------------------------------------------------------------- create orders

function SellPanel({
  market,
  owned,
}: { market: MarketSlice; owned: MaterialId[] }) {
  const materials = useGame((s) => s.materials);
  const [picked, setPicked] = useState<MaterialId | null>(null);
  const [amount, setAmount] = useState(1);
  const [priceText, setPriceText] = useState("");
  const offline = market.balanceCents === null;

  const active = picked !== null && materials[picked] > 0 ? picked : owned[0];

  // A fresh pick starts from the pool price, falling back to the reference.
  const mid = active ? market.prices?.rows[active]?.midCents : undefined;
  useEffect(() => {
    if (!active) return;
    const start = mid && mid > 0 ? mid : MATERIALS[active].basePriceCents;
    setPriceText((start / 100).toFixed(2));
  }, [active, mid]);

  if (!active) {
    return (
      <Panel className="p-4">
        <SectionHead
          label="New limit order"
          hint="Offer your own material at a price of your choosing."
        />
        <EmptyNote>
          You have no material to sell yet. The station turns handed-in trash
          into sellable goods.
        </EmptyNote>
      </Panel>
    );
  }

  const def = MATERIALS[active];
  const stock = materials[active];
  const max = Math.min(MAX_AMOUNT, stock);
  const take = Math.min(Math.max(1, amount), max);
  const parsed = Number.parseFloat(priceText.replace(",", "."));
  const cents = Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
  const priceOk = cents >= 1 && cents <= MAX_PRICE_CENTS;
  const total = take * cents;

  const onCreate = async () => {
    const st = useGame.getState();
    // Escrow: the material leaves the store first, so it can never be sold twice.
    if (!st.takeMaterials(active, take)) {
      toast("Not enough material in store.", "warn");
      return;
    }
    const res = await market.createOrder(active, take, cents);
    if (!res.ok) {
      useGame.getState().addMaterials(active, take);
      toast(res.error ?? "The order could not be created.", "warn");
      return;
    }
    toast(
      `Order created: ${num(take)} ${def.unit} ${def.name} @ ${formatCents(cents)}/${def.unit}`,
      "good",
    );
  };

  return (
    <Panel className="p-4">
      <SectionHead
        label="New limit order"
        hint="Offer your own material at a price of your choosing."
      />

      <div className="flex flex-wrap gap-1.5">
        {owned.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setPicked(m);
              setAmount(1);
            }}
            className={`rounded-lg px-2.5 py-1.5 text-[12px] transition ${
              m === active
                ? "bg-[rgba(242,160,7,0.18)] text-[#ffca70] ring-1 ring-inset ring-[rgba(242,160,7,0.4)]"
                : "bg-white/[0.07] text-white/60 hover:bg-white/15"
            }`}
          >
            {MATERIALS[m].name}
            <span className="ts-mono ml-1.5 text-white/40">
              {num(materials[m])}
            </span>
          </button>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-x-5 gap-y-3">
        <div>
          <div className="ts-label mb-1.5">Amount ({def.unit})</div>
          <Stepper
            value={take}
            min={1}
            max={max}
            disabled={market.busy}
            onChange={setAmount}
          />
        </div>
        <div>
          <div className="ts-label mb-1.5">Price per {def.unit}</div>
          <div className="flex items-center gap-1">
            <span className="ts-mono text-[13px] text-white/50">$</span>
            <input
              type="text"
              inputMode="decimal"
              value={priceText}
              aria-label={`Price per ${def.unit} of ${def.name}`}
              onChange={(e) => setPriceText(e.target.value)}
              className="ts-mono h-7 w-20 rounded-md border border-white/15 bg-black/45 px-2 text-right text-[12px] text-white outline-none transition focus:border-[var(--amber)]"
            />
            <span className="ts-mono text-[11px] text-white/35">
              ref. {formatCents(def.basePriceCents)}
            </span>
          </div>
        </div>
        <div className="ml-auto text-right">
          <div className="ts-label mb-1.5">You receive</div>
          <div className="ts-mono text-[18px] font-semibold text-emerald-300">
            {formatCents(total)}
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={onCreate}
        disabled={
          offline || market.busy || !priceOk || take < 1 || stock < take
        }
        className={`mt-3 w-full rounded-lg py-2 text-[13px] font-bold transition active:translate-y-px ${
          !offline && !market.busy && priceOk && stock >= take
            ? "bg-[var(--amber)] text-[#17130a] hover:bg-[#ffb42a]"
            : "cursor-not-allowed bg-white/[0.07] text-white/35"
        }`}
      >
        {offline
          ? "Sign in to trade"
          : market.busy
            ? "Working …"
            : "Create sell order"}
      </button>
      {!priceOk && (
        <p className="mt-1.5 text-[11px] text-amber-200/80">
          Please enter a price between $0.01 and $10,000.00 per {def.unit}.
        </p>
      )}
    </Panel>
  );
}

// -------------------------------------------------------------- wholesaler

function WholesaleRow({
  id,
  amount,
  market,
}: { id: MaterialId; amount: number; market: MarketSlice }) {
  const def = MATERIALS[id];
  const perUnit = market.prices?.rows[id]?.wholesaleCents ?? def.basePriceCents;
  const total = amount * perUnit;
  const offline = market.balanceCents === null;

  const onSell = async () => {
    const st = useGame.getState();
    if (!st.takeMaterials(id, amount)) {
      toast("Not enough material in store.", "warn");
      return;
    }
    const res = await market.sellWholesale(id, amount);
    if (!res.ok) {
      useGame.getState().addMaterials(id, amount);
      toast(res.error ?? "The wholesaler rejected the sale.", "warn");
      return;
    }
    toast(
      `Sold ${num(amount)} ${def.unit} ${def.name} for ${formatCents(total)}`,
      "good",
    );
  };

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-white/[0.07] bg-black/20 px-3 py-2">
      <Dot color={CATEGORIES[def.category].color} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-white/85">{def.name}</div>
        <div className="ts-mono text-[11px] text-white/40">
          {num(amount)} {def.unit} in store
        </div>
      </div>
      <span className="ts-mono text-[13px] text-emerald-300/85">
        {formatCents(total)}
      </span>
      <button
        type="button"
        onClick={onSell}
        disabled={offline || market.busy}
        className="rounded-lg bg-white/10 px-3 py-1.5 text-[12px] font-semibold transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {offline
          ? "Sign in to trade"
          : `Sell to wholesaler @ ${formatCents(perUnit)}/${def.unit}`}
      </button>
    </li>
  );
}
