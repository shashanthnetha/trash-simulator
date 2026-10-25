// Trash Simulator – pause menu with settings
import { getGame } from "../game/engine";
import { useGame } from "../game/state";
import type { QualityId } from "../game/types";

export interface PauseProps {
  isAuthenticated: boolean;
  cloudBusy: boolean;
  onCloudSave: () => void;
  onMainMenu: () => void;
}

/** Shows when progress was last saved to the profile. */
function SaveHint() {
  const dirty = useGame((st) => st.cloudDirty);
  const lastSavedAt = useGame((st) => st.lastSavedAt);
  const text =
    lastSavedAt === 0
      ? "Not saved yet."
      : `Last saved at ${new Date(lastSavedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}.`;
  return (
    <div className="mt-3 rounded-xl border border-white/10 bg-white/5 p-3 text-[12px] leading-relaxed text-white/60">
      {text} Your progress is saved to the profile automatically every five
      minutes{dirty ? " – there are unsaved changes." : "."}
    </div>
  );
}

function Row({
  label,
  children,
}: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="text-sm text-white/75">{label}</span>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

function Slider({
  value,
  min,
  max,
  step,
  onChange,
  fmt,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  fmt?: (v: number) => string;
}) {
  return (
    <>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-36 accent-emerald-400"
      />
      <span className="w-12 text-right text-xs tabular-nums text-white/60">
        {fmt ? fmt(value) : value}
      </span>
    </>
  );
}

function Toggle({
  value,
  onChange,
}: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={`h-6 w-11 rounded-full p-0.5 transition ${value ? "bg-emerald-500/80" : "bg-white/15"}`}
    >
      <div
        className={`h-5 w-5 rounded-full bg-white transition ${value ? "translate-x-5" : ""}`}
      />
    </button>
  );
}

const QUALITIES: Array<[QualityId, string]> = [
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["ultra", "Ultra"],
];

export function PauseSettings({
  isAuthenticated,
  cloudBusy,
  onCloudSave,
  onMainMenu,
}: PauseProps) {
  const st = useGame();
  const s = st.settings;
  const up = st.updateSettings;

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/55 p-3">
      <div className="menu-panel scroll-thin max-h-[92vh] w-full max-w-md overflow-y-auto rounded-2xl p-5 text-white shadow-2xl">
        <h2 className="mb-1 text-xl font-bold">Paused</h2>
        <p className="mb-4 text-[12px] text-white/50">
          The beach is waiting for you.
        </p>

        <div className="space-y-1 rounded-xl border border-white/10 bg-white/5 p-3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-white/45">
            Graphics
          </div>
          <Row label="Quality">
            <div className="flex gap-1">
              {QUALITIES.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => up({ quality: id })}
                  className={`rounded-md px-2 py-1 text-[11px] ${
                    s.quality === id
                      ? "bg-emerald-500/30 text-emerald-200"
                      : "bg-white/10 text-white/60"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </Row>
          <p className="pb-1 text-[10px] text-white/40">
            Quality only takes full effect after “Main menu → Resume shift”.
          </p>
          <Row label="Render resolution">
            <Slider
              value={s.renderScale}
              min={0.5}
              max={1}
              step={0.05}
              onChange={(v) => up({ renderScale: v })}
              fmt={(v) => `${Math.round(v * 100)}%`}
            />
          </Row>
          <Row label="Shadows">
            <Toggle value={s.shadows} onChange={(v) => up({ shadows: v })} />
          </Row>
          <Row label="Field of view (FOV)">
            <Slider
              value={s.fov}
              min={60}
              max={100}
              step={1}
              onChange={(v) => up({ fov: v })}
              fmt={(v) => `${v}°`}
            />
          </Row>
        </div>

        <div className="mt-3 space-y-1 rounded-xl border border-white/10 bg-white/5 p-3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-white/45">
            Controls
          </div>
          <Row label="Mouse sensitivity">
            <Slider
              value={s.sensitivity}
              min={0.3}
              max={2.5}
              step={0.05}
              onChange={(v) => up({ sensitivity: v })}
              fmt={(v) => v.toFixed(2)}
            />
          </Row>
          <Row label="Invert Y axis">
            <Toggle value={s.invertY} onChange={(v) => up({ invertY: v })} />
          </Row>
        </div>

        <div className="mt-3 space-y-1 rounded-xl border border-white/10 bg-white/5 p-3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-white/45">
            Audio
          </div>
          <Row label="Master">
            <Slider
              value={s.volMaster}
              min={0}
              max={1}
              step={0.05}
              onChange={(v) => up({ volMaster: v })}
              fmt={(v) => `${Math.round(v * 100)}%`}
            />
          </Row>
          <Row label="Ambience">
            <Slider
              value={s.volAmbience}
              min={0}
              max={1}
              step={0.05}
              onChange={(v) => up({ volAmbience: v })}
              fmt={(v) => `${Math.round(v * 100)}%`}
            />
          </Row>
          <Row label="Effects">
            <Slider
              value={s.volSfx}
              min={0}
              max={1}
              step={0.05}
              onChange={(v) => up({ volSfx: v })}
              fmt={(v) => `${Math.round(v * 100)}%`}
            />
          </Row>
        </div>

        <div className="mt-3 rounded-xl border border-white/10 bg-white/5 p-3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-white/45">
            Game world
          </div>
          <Row label="Tide washes up new trash">
            <Toggle value={s.washUp} onChange={(v) => up({ washUp: v })} />
          </Row>
        </div>

        {/* TEST MODE (temporary – remove this section together with the
            `test`/`toggleTestMode` members in state.ts and the block in
            types.ts). */}
        <div className="mt-3 rounded-xl border border-amber-400/25 bg-amber-400/[0.06] p-3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-amber-200/70">
            Testing
          </div>
          <Row label="Test mode – unlock everything">
            <Toggle
              value={st.test !== null}
              onChange={() => st.toggleTestMode()}
            />
          </Row>
          <p className="pb-1 text-[10px] text-white/40">
            Max level, points, every upgrade and the lighthouse key. Switching
            it off restores your real progress – anything earned while testing
            is discarded.
          </p>
        </div>

        <SaveHint />

        <div className="mt-4 space-y-2">
          <button
            type="button"
            onClick={() => getGame()?.resume()}
            className="w-full rounded-xl bg-emerald-500/90 py-2.5 font-semibold text-emerald-950 transition hover:bg-emerald-400"
          >
            Resume
          </button>
          <button
            type="button"
            onClick={onCloudSave}
            disabled={!isAuthenticated || cloudBusy}
            className={`w-full rounded-xl py-2.5 font-semibold transition ${
              isAuthenticated
                ? "bg-sky-500/25 text-sky-200 hover:bg-sky-500/35"
                : "cursor-not-allowed bg-white/5 text-white/35"
            }`}
          >
            {cloudBusy ? "Saving …" : "Save to profile now"}
          </button>
          <button
            type="button"
            onClick={onMainMenu}
            className="w-full rounded-xl bg-white/10 py-2.5 font-semibold text-white/85 transition hover:bg-white/20"
          >
            Save and back to main menu
          </button>
        </div>
      </div>
    </div>
  );
}
