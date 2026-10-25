// Trash Simulator – shared building blocks of the in-game menu
import type { ReactNode } from "react";

/** Thousands separators, British formatting like everywhere else in the UI. */
export function num(v: number): string {
  return new Intl.NumberFormat("en-GB").format(Math.round(v));
}

/** Framed surface – the carrier for every section inside the menu. */
export function Panel({
  children,
  className,
  tone,
}: {
  children: ReactNode;
  className?: string;
  tone?: "plain" | "good" | "warn";
}) {
  const skin =
    tone === "good"
      ? "border-emerald-400/25 bg-emerald-400/[0.06]"
      : tone === "warn"
        ? "border-amber-400/30 bg-amber-400/[0.06]"
        : "border-white/10 bg-white/[0.035]";
  return (
    <section className={`rounded-xl border ${skin} ${className ?? ""}`}>
      {children}
    </section>
  );
}

/** Section heading: stencil label on the left, a value block on the right. */
export function SectionHead({
  label,
  hint,
  right,
}: { label: string; hint?: string; right?: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="ts-label">{label}</div>
        {hint && (
          <div className="mt-1 text-[12px] leading-snug text-white/45">
            {hint}
          </div>
        )}
      </div>
      {right && <div className="shrink-0 text-right">{right}</div>}
    </div>
  );
}

/** Slim progress bar. */
export function MiniBar({
  value,
  max,
  color,
  thin,
}: { value: number; max: number; color: string; thin?: boolean }) {
  const f = Math.max(0, Math.min(1, max > 0 ? value / max : 0));
  return (
    <div
      className={`w-full overflow-hidden rounded-full bg-black/40 ${thin ? "h-1" : "h-1.5"}`}
    >
      <div
        className="h-full rounded-full transition-[width] duration-300"
        style={{ width: `${f * 100}%`, background: color }}
      />
    </div>
  );
}

/** Stage dots: filled = bought, hollow = still available. */
export function Pips({
  total,
  filled,
  id,
}: { total: number; filled: number; id: string }) {
  const dots: ReactNode[] = [];
  for (let i = 0; i < total; i++) {
    dots.push(
      <span
        key={`${id}-pip-${i}`}
        className={`h-[7px] w-[7px] rounded-full ${
          i < filled
            ? "bg-[var(--amber)] shadow-[0_0_6px_rgba(242,160,7,0.55)]"
            : "border border-white/25"
        }`}
      />,
    );
  }
  return <div className="flex items-center gap-[5px]">{dots}</div>;
}

/** Small status badge. */
export function Chip({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: "plain" | "good" | "warn" | "amber";
}) {
  const skin =
    tone === "good"
      ? "bg-emerald-400/15 text-emerald-200"
      : tone === "warn"
        ? "bg-amber-400/15 text-amber-200"
        : tone === "amber"
          ? "bg-[rgba(242,160,7,0.16)] text-[#ffca70]"
          : "bg-white/10 text-white/60";
  return (
    <span
      className={`ts-mono whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] ${skin}`}
    >
      {children}
    </span>
  );
}

/** Category colour marker. */
export function Dot({ color }: { color: string }) {
  return (
    <span
      className="mt-[5px] h-2 w-2 shrink-0 rounded-full"
      style={{ background: color, boxShadow: `0 0 7px ${color}66` }}
    />
  );
}

/** Helpful placeholder for a section without content. */
export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-white/12 px-3 py-4 text-center text-[12px] leading-relaxed text-white/45">
      {children}
    </div>
  );
}

/** Amount picker: −/+, free entry and a jump to the maximum. */
export function Stepper({
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  const clamp = (n: number) =>
    Math.max(min, Math.min(max, Number.isFinite(n) ? Math.floor(n) : min));
  const btn =
    "h-7 w-7 rounded-md border border-white/15 bg-white/5 text-[13px] font-bold leading-none text-white/80 transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-35";
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className={btn}
        disabled={disabled || value <= min}
        onClick={() => onChange(clamp(value - 1))}
      >
        −
      </button>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
        className="ts-mono h-7 w-16 rounded-md border border-white/15 bg-black/45 px-1 text-center text-[12px] text-white outline-none transition focus:border-[var(--amber)] disabled:opacity-40"
      />
      <button
        type="button"
        className={btn}
        disabled={disabled || value >= max}
        onClick={() => onChange(clamp(value + 1))}
      >
        +
      </button>
      <button
        type="button"
        className="ts-mono h-7 rounded-md border border-white/15 bg-white/5 px-2 text-[10px] uppercase tracking-[0.12em] text-white/60 transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-35"
        disabled={disabled || value >= max}
        onClick={() => onChange(max)}
      >
        Max
      </button>
    </div>
  );
}
