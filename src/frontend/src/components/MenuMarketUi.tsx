// Trash Simulator – shared parts of the exchange: asset identity, round asset
// icons, price formatting, the impact/deviation chips and the trend sparkline.
import type { ReactNode } from "react";
import type { MaterialId } from "../game/types";
import {
  CATEGORIES,
  MATERIALS,
  MATERIAL_IDS,
  formatCents,
  isMaterialId,
} from "../game/types";
import type { MarketPricePoint, SwapAsset } from "../hooks/useBackendSync";
import { USD_ASSET } from "../hooks/useBackendSync";
import { num } from "./MenuUi";

/** Selector order: the dollar first, then the eight materials. */
export const ASSET_IDS: readonly SwapAsset[] = [USD_ASSET, ...MATERIAL_IDS];

/** The dollar has no category colour of its own. */
const USD_COLOR = "#7fe3a5";

/** Short exchange ticker, the way a trading screen abbreviates a commodity. */
const TICKERS: Record<MaterialId, string> = {
  glass_cullet: "CULLET",
  pet_flake: "PET",
  metal_scrap: "SCRAP",
  paper_pulp: "PULP",
  wood_chips: "CHIPS",
  aggregate: "AGGR",
  chem_recovered: "CHEM",
  rdf_pellets: "RDF",
};

/** Two-letter glyph inside the round icon – no image files anywhere. */
const GLYPHS: Record<MaterialId, string> = {
  glass_cullet: "GC",
  pet_flake: "PT",
  metal_scrap: "MS",
  paper_pulp: "PP",
  wood_chips: "WC",
  aggregate: "AG",
  chem_recovered: "CX",
  rdf_pellets: "RD",
};

export function isUsd(asset: SwapAsset): boolean {
  return asset === USD_ASSET;
}

export function assetTicker(asset: SwapAsset): string {
  return isMaterialId(asset) ? TICKERS[asset] : "USD";
}

export function assetName(asset: SwapAsset): string {
  return isMaterialId(asset) ? MATERIALS[asset].name : "Dollars";
}

/** "kg" / "L" for a material, "$" for the dollar. */
export function assetUnit(asset: SwapAsset): string {
  return isMaterialId(asset) ? MATERIALS[asset].unit : "$";
}

export function assetColor(asset: SwapAsset): string {
  return isMaterialId(asset)
    ? CATEGORIES[MATERIALS[asset].category].color
    : USD_COLOR;
}

/** "12 kg PET flakes" / "$40.12" – for toasts and summaries. */
export function formatAssetAmount(asset: SwapAsset, amount: number): string {
  if (!isMaterialId(asset)) return formatCents(amount);
  const def = MATERIALS[asset];
  return `${num(amount)} ${def.unit} ${def.name}`;
}

/** "12 kg" / "$40.12" – for the tight balance and info lines. */
export function formatAssetShort(asset: SwapAsset, amount: number): string {
  return isMaterialId(asset)
    ? `${num(amount)} ${MATERIALS[asset].unit}`
    : formatCents(amount);
}

/**
 * Cents with the precision a price actually needs: $3.42 for a normal price,
 * $0.175 and $0.0412 for the cheap bulk materials whose whole value sits below
 * a cent of resolution.
 */
export function formatCentsFine(cents: number): string {
  const v = Number.isFinite(cents) ? cents : 0;
  const abs = Math.abs(v);
  const dp = abs >= 100 ? 2 : abs >= 10 ? 3 : 4;
  const body = new Intl.NumberFormat("en-GB", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  }).format(abs / 100);
  return `${v < 0 ? "−" : ""}$${body}`;
}

/** Basis points as a percentage: 30 → "0.30 %", 1240 → "12.4 %". */
export function formatBpPercent(bp: number): string {
  const abs = Math.abs(bp);
  if (abs > 0 && abs < 1) return "<0.01 %";
  const v = abs / 100;
  return `${abs >= 100 ? v.toFixed(1) : v.toFixed(2)} %`;
}

/** Signed percentage with a real minus sign: −2.3 %. */
export function formatBpSigned(bp: number): string {
  const sign = bp < 0 ? "−" : bp > 0 ? "+" : "";
  return `${sign}${formatBpPercent(bp)}`;
}

export type ExchangeTone = "plain" | "good" | "warn" | "bad";

/** Universal "no value" marker, as on the multidex screens – never a bare 0. */
export const EM_DASH = "—";

/**
 * Price-impact bands, copied from the multidex swap preview: green below 2 %,
 * amber from 2 to 5 %, red with a warning sign at 5 % and above.
 */
export function impactTone(bp: number): ExchangeTone {
  if (bp < 200) return "good";
  if (bp < 500) return "warn";
  return "bad";
}

/**
 * Impact wording, also from multidex: under half a percent it collapses to a
 * literal instead of printing precision the number does not carry.
 */
export function impactLabel(bp: number): string {
  if (bp < 50) return "< 0.5 % impact";
  const pct = (bp / 100).toFixed(2);
  return bp >= 500 ? `⚠ ${pct} % impact` : `${pct} % impact`;
}

/** Small coloured badge – like Chip, but with a red band for danger. */
export function ToneChip({
  tone,
  children,
}: { tone: ExchangeTone; children: ReactNode }) {
  const skin =
    tone === "good"
      ? "bg-emerald-400/15 text-emerald-200"
      : tone === "warn"
        ? "bg-amber-400/18 text-amber-200"
        : tone === "bad"
          ? "bg-red-500/20 text-red-200"
          : "bg-white/10 text-white/60";
  return (
    <span
      className={`ts-mono whitespace-nowrap rounded px-1.5 py-[2px] text-[11px] ${skin}`}
    >
      {children}
    </span>
  );
}

/** Round, colour-coded asset disc. Pure SVG – there are no asset files. */
export function AssetIcon({
  asset,
  size = 24,
}: { asset: SwapAsset; size?: number }) {
  const color = assetColor(asset);
  const glyph = isMaterialId(asset) ? GLYPHS[asset] : "$";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className="shrink-0"
      aria-hidden="true"
    >
      <title>{assetName(asset)}</title>
      <circle
        cx="12"
        cy="12"
        r="11"
        fill={color}
        fillOpacity="0.18"
        stroke={color}
        strokeOpacity="0.7"
        strokeWidth="1.3"
      />
      <text
        x="12"
        y="12.9"
        textAnchor="middle"
        dominantBaseline="middle"
        fontFamily="'IBM Plex Mono', ui-monospace, monospace"
        fontSize={glyph.length > 1 ? 8.6 : 12}
        fontWeight="700"
        fill={color}
      >
        {glyph}
      </text>
    </svg>
  );
}

/** 24-point mid-price trend, drawn inline – no charting library. */
export function Sparkline({
  points,
  color,
  width = 90,
  height = 24,
}: {
  points: readonly MarketPricePoint[];
  color: string;
  width?: number;
  height?: number;
}) {
  const pad = 3;
  const n = points.length;
  if (n < 2) {
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        aria-hidden="true"
      >
        <title>No history yet</title>
        <line
          x1={pad}
          y1={height / 2}
          x2={width - pad}
          y2={height / 2}
          stroke={color}
          strokeOpacity="0.3"
          strokeWidth="1"
          strokeDasharray="2 3"
        />
      </svg>
    );
  }
  let lo = points[0].midCents;
  let hi = lo;
  for (const p of points) {
    if (p.midCents < lo) lo = p.midCents;
    if (p.midCents > hi) hi = p.midCents;
  }
  const span = hi - lo;
  const px = (i: number) => pad + (i * (width - 2 * pad)) / (n - 1);
  const py = (v: number) =>
    span > 0
      ? height - pad - ((v - lo) / span) * (height - 2 * pad)
      : height / 2;
  const line = points
    .map((p, i) => `${px(i).toFixed(1)},${py(p.midCents).toFixed(1)}`)
    .join(" ");
  const area = `${pad},${height} ${line} ${(width - pad).toFixed(1)},${height}`;
  const lastX = px(n - 1);
  const lastY = py(points[n - 1].midCents);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      <title>Mid price over the last {n} samples</title>
      <polyline points={area} fill={color} fillOpacity="0.1" stroke="none" />
      <polyline
        points={line}
        fill="none"
        stroke={color}
        strokeOpacity="0.85"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={lastX} cy={lastY} r="1.8" fill={color} />
    </svg>
  );
}

/**
 * Segmented control – the exchange's own sub-navigation. Deliberately not
 * amber: like multidex we keep the accent colour for the top-level tabs and
 * the primary call to action, and mark a sub-tab with an underline instead.
 */
export function SubNav<T extends string>({
  items,
  value,
  onChange,
}: {
  items: ReadonlyArray<readonly [T, string]>;
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="inline-flex gap-1 rounded-xl border border-white/[0.07] bg-black/30 p-1">
      {items.map(([id, label]) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={`whitespace-nowrap rounded-lg px-4 py-1.5 text-[12px] font-semibold transition ${
            value === id
              ? "bg-white/[0.09] text-white shadow-[inset_0_-2px_0_#4fa3e0]"
              : "text-white/50 hover:bg-white/[0.06] hover:text-white/80"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Small spinner that never changes the layout around it. */
export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <span
      className="inline-block shrink-0 animate-spin rounded-full border-2 border-white/20 border-t-white/75"
      style={{ width: size, height: size }}
    />
  );
}

/** One label/value line under the swap card. */
export function InfoRow({
  label,
  children,
}: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-[3px]">
      <span className="text-[12px] text-white/45">{label}</span>
      <span className="ts-mono flex items-center gap-1.5 text-right text-[12px] text-white/75">
        {children}
      </span>
    </div>
  );
}
