// Trash Simulator – upgrades tab: level, XP and the skill cards
import { useState } from "react";
import { sound } from "../game/sound";
import { useGame } from "../game/state";
import type { UpgradeDef } from "../game/types";
import { UPGRADES, formatCents, levelFromXp } from "../game/types";
import { Chip, MiniBar, Panel, Pips, num } from "./MenuUi";

export interface UpgradesTabProps {
  /** Wallet balance in cents, null while offline. */
  balanceCents: number | null;
}

/** Thematic groups – anything unknown lands in the last group. */
const GROUPS: Array<{ label: string; ids: readonly string[] }> = [
  {
    label: "Field kit",
    ids: [
      "bucketCap",
      "grabRange",
      "grabSpeed",
      "magnet",
      "detector",
      "detectorTune",
    ],
  },
  { label: "Jeep", ids: ["jeepCap", "jeepEngine", "jeepSusp"] },
  { label: "Helpers", ids: ["dog", "dogSpeed", "drone", "droneSpeed"] },
  { label: "Recycling station", ids: ["stationRate"] },
];

/** Upgrades that are either owned or not – no numeric value to show. */
const TOGGLE_IDS: readonly string[] = ["dog", "drone", "detector"];

function groupedUpgrades(): Array<{ label: string; items: UpgradeDef[] }> {
  const used = new Set<string>();
  const out = GROUPS.map((g) => {
    const items = UPGRADES.filter((u) => g.ids.includes(u.id));
    for (const u of items) used.add(u.id);
    return { label: g.label, items };
  }).filter((g) => g.items.length > 0);
  const rest = UPGRADES.filter((u) => !used.has(u.id));
  if (rest.length > 0) out.push({ label: "More", items: rest });
  return out;
}

/** 4.8 → "4.8", 20 → "20" – no trailing zeroes. */
function fmtValue(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(2)));
}

export function UpgradesTab({ balanceCents }: UpgradesTabProps) {
  const st = useGame();
  const lv = levelFromXp(st.xp);
  const [flash, setFlash] = useState<string | null>(null);

  const buy = (id: string) => {
    if (!useGame.getState().buyUpgrade(id)) return;
    sound.uiClick();
    setFlash(id);
    window.setTimeout(() => setFlash((f) => (f === id ? null : f)), 800);
  };

  return (
    <div className="space-y-4">
      {/* Progress board */}
      <Panel className="p-4">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div>
            <div className="ts-label">Operator level</div>
            <div className="ts-display mt-1 text-[42px] text-[var(--amber)]">
              {lv.level}
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-x-7 gap-y-3">
            <div className="text-right">
              <div className="ts-label">Recycling points</div>
              <div className="ts-mono mt-1 text-[20px] font-semibold text-emerald-300">
                {num(st.recyclePoints)}
              </div>
            </div>
            {balanceCents !== null && (
              <div className="text-right">
                <div className="ts-label">Balance</div>
                <div className="ts-mono mt-1 text-[20px] font-semibold text-white">
                  {formatCents(balanceCents)}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="mt-4">
          <MiniBar
            value={lv.into}
            max={Math.max(1, lv.needed)}
            color="linear-gradient(90deg,#f2a007,#ffd27a)"
          />
          <div className="ts-mono mt-1.5 flex justify-between text-[11px] text-white/50">
            <span>
              {num(lv.into)} / {num(lv.needed)} XP
            </span>
            <span>
              {lv.needed > 0
                ? `Level ${lv.level + 1} next`
                : "Maximum level reached"}
            </span>
          </div>
        </div>
      </Panel>

      {/* Upgrade cards, grouped by area */}
      {groupedUpgrades().map((group) => (
        <div key={group.label}>
          <div className="ts-label mb-2">{group.label}</div>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {group.items.map((u) => (
              <UpgradeCard
                key={u.id}
                def={u}
                stage={st.upgrades[u.id] ?? 0}
                points={st.recyclePoints}
                level={lv.level}
                flash={flash === u.id}
                onBuy={() => buy(u.id)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function UpgradeCard({
  def,
  stage,
  points,
  level,
  flash,
  onBuy,
}: {
  def: UpgradeDef;
  stage: number;
  points: number;
  level: number;
  flash: boolean;
  onBuy: () => void;
}) {
  const stages = def.values.length - 1;
  const maxed = stage >= stages;
  const cost = maxed ? 0 : def.costs[stage];
  const reqLevel = maxed ? 0 : def.levelReq[stage];
  const levelOk = level >= reqLevel;
  const canAfford = points >= cost;
  const buyable = !maxed && levelOk && canAfford;
  const toggle = TOGGLE_IDS.includes(def.id);

  const border = maxed
    ? "border-emerald-400/30 bg-emerald-400/[0.06]"
    : !levelOk
      ? "border-white/[0.07] bg-white/[0.02]"
      : buyable
        ? "border-[rgba(242,160,7,0.35)] bg-[rgba(242,160,7,0.05)]"
        : "border-white/10 bg-white/[0.035]";

  return (
    <div
      className={`flex flex-col rounded-xl border p-3 transition duration-300 ${border} ${
        flash ? "ring-2 ring-emerald-300/80" : "ring-0"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[14px] font-semibold leading-tight text-white">
            {def.name}
          </div>
          <p className="mt-1 text-[12px] leading-snug text-white/50">
            {def.desc}
          </p>
        </div>
        {maxed ? (
          <Chip tone="good">Max</Chip>
        ) : !levelOk ? (
          <Chip tone="warn">Lv. {reqLevel}</Chip>
        ) : (
          <Chip tone="plain">
            Stage {stage}/{stages}
          </Chip>
        )}
      </div>

      {/* Current → next, the unit printed once */}
      <div className="ts-mono mt-2.5 text-[13px]">
        {toggle ? (
          <span className={stage >= 1 ? "text-emerald-300" : "text-white/40"}>
            {stage >= 1 ? "Unlocked" : "Not unlocked yet"}
          </span>
        ) : (
          <>
            <span className="text-white/80">{fmtValue(def.values[stage])}</span>
            {!maxed && (
              <>
                <span className="mx-1.5 text-white/30">→</span>
                <span className="font-semibold text-[var(--amber)]">
                  {fmtValue(def.values[stage + 1])}
                </span>
              </>
            )}
            {def.unit && <span className="ml-1 text-white/45">{def.unit}</span>}
          </>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <Pips total={stages} filled={stage} id={def.id} />
        {maxed ? (
          <span className="text-[12px] font-medium text-emerald-300/80">
            Fully upgraded
          </span>
        ) : (
          <button
            type="button"
            disabled={!buyable}
            onClick={onBuy}
            className={`rounded-lg px-3 py-1.5 text-[12px] font-bold transition active:translate-y-px ${
              buyable
                ? "bg-[var(--amber)] text-[#17130a] hover:bg-[#ffb42a]"
                : "cursor-not-allowed bg-white/[0.07] text-white/35"
            }`}
          >
            {!levelOk
              ? `Requires level ${reqLevel}`
              : `${num(cost)} points${canAfford ? "" : ` · ${num(cost - points)} short`}`}
          </button>
        )}
      </div>
    </div>
  );
}
