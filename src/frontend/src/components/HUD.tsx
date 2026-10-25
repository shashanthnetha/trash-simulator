// Trash Simulator – minimal HUD
import { useGame } from "../game/state";
import { formatCents, levelFromXp } from "../game/types";

export interface HUDProps {
  /** Wallet balance in cents; null while offline (then it stays hidden). */
  balanceCents: number | null;
}

/** t = time of day in hours (0..24), as delivered by the engine. */
function fmtClock(t: number): string {
  const hours = ((t % 24) + 24) % 24;
  const h = Math.floor(hours);
  const m = Math.floor((hours - h) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function Bar({
  value,
  max,
  color,
}: { value: number; max: number; color: string }) {
  const f = Math.min(1, max > 0 ? value / max : 0);
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
      <div
        className="h-full rounded-full transition-all duration-300"
        style={{ width: `${f * 100}%`, background: color }}
      />
    </div>
  );
}

export function HUD({ balanceCents }: HUDProps) {
  const st = useGame();
  const lv = levelFromXp(st.xp);
  const level = lv.level;
  const inLevel = lv.into;
  const need = Math.max(1, lv.needed);
  const bucketCap = st.bucketCapacity();
  const jeepCap = st.jeepCapacity();
  const cleaned =
    st.initialTotal > 0 ? 1 - remainingSum(st.remaining) / st.initialTotal : 0;

  return (
    <div className="pointer-events-none absolute inset-0 select-none text-white">
      <div className="vignette" />

      {/* Crosshair */}
      {!st.inJeep && (
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <div className={`crosshair-dot ${st.promptGrab ? "active" : ""}`} />
        </div>
      )}

      {/* Top left: level + XP */}
      <div className="hud-panel absolute left-3 top-3 w-56 p-3">
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-bold tracking-wide">Level {level}</span>
          <span className="text-[11px] text-white/60">
            {Math.floor(inLevel)} / {need} XP
          </span>
        </div>
        <div className="mt-1.5">
          <Bar value={inLevel} max={need} color="#7fe3a0" />
        </div>
        <div className="mt-2 flex items-center justify-between gap-2 text-[12px]">
          <span className="text-emerald-300">{st.recyclePoints} points</span>
          {balanceCents !== null && (
            <span className="font-semibold tabular-nums text-white/85">
              {formatCents(balanceCents)}
            </span>
          )}
          <span className="text-white/60">
            {Math.round(cleaned * 100)}% clean
          </span>
        </div>
      </div>

      {/* Top right: environment */}
      <div className="hud-panel absolute right-3 top-3 px-3 py-2 text-right text-[12px] leading-5">
        <div className="font-semibold">
          {fmtClock(st.env.timeOfDay)} · {st.env.weatherName}
        </div>
        <div className="text-white/60">{st.env.sectorName}</div>
      </div>

      {/* Bottom left: bucket + jeep */}
      <div className="hud-panel absolute bottom-3 left-3 w-52 space-y-2 p-3 text-[12px]">
        <div>
          <div className="mb-1 flex justify-between">
            <span>Bucket</span>
            <span
              className={
                st.bucketCount >= bucketCap
                  ? "font-bold text-amber-300"
                  : "text-white/70"
              }
            >
              {st.bucketCount} / {bucketCap}
            </span>
          </div>
          <Bar value={st.bucketCount} max={bucketCap} color="#e8762c" />
        </div>
        <div>
          <div className="mb-1 flex justify-between">
            <span>Jeep</span>
            <span
              className={
                st.jeepCount >= jeepCap
                  ? "font-bold text-amber-300"
                  : "text-white/70"
              }
            >
              {st.jeepCount} / {jeepCap}
            </span>
          </div>
          <Bar value={st.jeepCount} max={jeepCap} color="#4fa3e0" />
        </div>
        {st.stationStored > 0 && (
          <div className="text-white/55">
            At the station: {st.stationStored}
          </div>
        )}
        {/* Equipped hand tool – only once the detector is owned */}
        {!st.inJeep && (st.upgrades.detector ?? 0) >= 1 && (
          <div className="flex justify-between text-white/55">
            <span>Tool</span>
            <span className="text-white/80">
              {st.tool === "detector" ? "Metal detector" : "Litter picker"}
            </span>
          </div>
        )}
      </div>

      {/* Jeep speedometer */}
      {st.inJeep && (
        // On touch the button cluster sits in the bottom right – move up above it
        <div
          className={`hud-panel absolute right-3 px-4 py-2 text-center ${
            st.isTouch ? "bottom-52" : "bottom-3"
          }`}
        >
          <div className="text-2xl font-bold tabular-nums">
            {Math.round(st.jeepSpeed * 3.6)}
          </div>
          <div className="text-[10px] text-white/60">km/h</div>
        </div>
      )}

      {/* Prompt */}
      {st.prompt && (
        <div className="absolute bottom-28 left-1/2 -translate-x-1/2">
          <div className="hud-panel whitespace-pre-line px-4 py-2 text-center text-[13px] font-medium">
            {st.prompt}
          </div>
        </div>
      )}

      {/* Floating texts */}
      {st.floats.map((f) => (
        <div
          key={f.id}
          className="float-text absolute left-1/2 top-[46%] text-sm font-bold drop-shadow-lg"
          style={{ color: f.color }}
        >
          {f.text}
        </div>
      ))}

      {/* Toasts – above the menu overlay, so market feedback stays readable */}
      <div className="absolute bottom-3 left-1/2 z-40 flex -translate-x-1/2 flex-col items-center gap-1.5">
        {st.toasts.map((t) => (
          <div
            key={t.id}
            className={`toast-item hud-panel px-3 py-1.5 text-[12px] ${
              t.kind === "good"
                ? "text-emerald-300"
                : t.kind === "warn"
                  ? "text-amber-300"
                  : "text-white/85"
            }`}
          >
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function remainingSum(rec: Record<string, number>): number {
  let n = 0;
  for (const k of Object.keys(rec)) n += rec[k];
  return n;
}
