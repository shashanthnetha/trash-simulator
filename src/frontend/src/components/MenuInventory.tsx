// Trash Simulator – inventory tab: bucket, jeep, depot and materials store
import { useGame } from "../game/state";
import type { CategoryId } from "../game/types";
import {
  CATEGORIES,
  CATEGORY_IDS,
  MATERIALS,
  MATERIAL_BY_CATEGORY,
  MATERIAL_IDS,
  STATION_CAPACITY,
  TRASH_BY_ID,
  formatCents,
} from "../game/types";
import { Dot, EmptyNote, MiniBar, Panel, SectionHead, num } from "./MenuUi";

/** Counted trash types, heaviest stack first. */
function sortedItems(rec: Record<string, number>): Array<[string, number]> {
  return Object.entries(rec)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function TrashList({ rec }: { rec: Record<string, number> }) {
  const items = sortedItems(rec);
  return (
    <ul className="grid gap-x-5 gap-y-1.5 sm:grid-cols-2">
      {items.map(([id, n]) => {
        const def = TRASH_BY_ID[id];
        const cat = def ? CATEGORIES[def.category] : null;
        return (
          <li key={id} className="flex items-start gap-2">
            <Dot color={cat?.color ?? "#8a9aa0"} />
            <span className="min-w-0 flex-1 truncate text-[13px] text-white/80">
              {def?.name ?? id}
            </span>
            <span className="ts-mono text-[12px] text-white/60">×{n}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Carrier({
  label,
  hint,
  empty,
  rec,
  count,
  capacity,
  color,
}: {
  label: string;
  hint: string;
  empty: string;
  rec: Record<string, number>;
  count: number;
  capacity: number;
  color: string;
}) {
  const full = count >= capacity;
  return (
    <Panel className="p-4">
      <SectionHead
        label={label}
        hint={hint}
        right={
          <span
            className={`ts-mono text-[13px] ${full ? "font-bold text-amber-300" : "text-white/70"}`}
          >
            {num(count)} / {num(capacity)}
          </span>
        }
      />
      <MiniBar value={count} max={capacity} color={color} />
      <div className="mt-3">
        {count === 0 ? <EmptyNote>{empty}</EmptyNote> : <TrashList rec={rec} />}
      </div>
    </Panel>
  );
}

export function InventoryTab() {
  const st = useGame();
  const lines = CATEGORY_IDS.filter(
    (c) => st.stationQueue[c] > 0 || st.recycleProgress[c] > 0,
  );
  const owned = MATERIAL_IDS.filter((m) => st.materials[m] > 0);
  const stockValue = owned.reduce(
    (sum, m) => sum + st.materials[m] * MATERIALS[m].basePriceCents,
    0,
  );

  return (
    <div className="space-y-3">
      <Carrier
        label="Bucket"
        hint="What you are carrying right now."
        empty="Your bucket is empty. Aim at a piece of trash and pick it up with the left mouse button."
        rec={st.bucket}
        count={st.bucketCount}
        capacity={st.bucketCapacity()}
        color="#e8762c"
      />

      <Carrier
        label="Jeep"
        hint="The load bed – tip your bucket in with F next to the jeep."
        empty="The load bed is empty. Stand beside the jeep and press F to tip your bucket in."
        rec={st.jeepLoad}
        count={st.jeepCount}
        capacity={st.jeepCapacity()}
        color="#4fa3e0"
      />

      <Panel className="p-4">
        <SectionHead
          label="Your depot"
          hint="Everything handed in at the recycling station. Each line is baled into one sellable material."
          right={
            <span className="ts-mono text-[13px] text-white/70">
              {num(st.stationStored)} / {num(STATION_CAPACITY)}
            </span>
          }
        />
        <MiniBar
          value={st.stationStored}
          max={STATION_CAPACITY}
          color="#9bc53d"
        />

        <div className="mt-3 space-y-2.5">
          {lines.length === 0 ? (
            <EmptyNote>
              Nothing waiting at the station. Drive a load over and press F at
              the ramp to hand it in.
            </EmptyNote>
          ) : (
            lines.map((c) => <StationLine key={c} cat={c} />)
          )}
        </div>

        <div className="mt-4 border-t border-white/10 pt-3">
          <SectionHead
            label="Materials store"
            hint="Baled and ready to trade on the marketplace."
            right={
              owned.length > 0 ? (
                <span className="ts-mono text-[13px] text-emerald-300">
                  {formatCents(stockValue)}
                </span>
              ) : undefined
            }
          />
          {owned.length === 0 ? (
            <EmptyNote>
              No materials yet. The station keeps processing what you hand in –
              come back once a line is full.
            </EmptyNote>
          ) : (
            <ul className="grid gap-x-5 gap-y-1.5 sm:grid-cols-2">
              {owned.map((m) => {
                const def = MATERIALS[m];
                const n = st.materials[m];
                return (
                  <li key={m} className="flex items-start gap-2">
                    <Dot color={CATEGORIES[def.category].color} />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-white/80">
                      {def.name}
                    </span>
                    <span className="ts-mono text-[12px] text-white/70">
                      {num(n)} {def.unit}
                    </span>
                    <span className="ts-mono w-16 text-right text-[12px] text-emerald-300/85">
                      {formatCents(n * def.basePriceCents)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Panel>
    </div>
  );
}

/** One sorting line: waiting items and the progress to the next whole unit. */
function StationLine({ cat }: { cat: CategoryId }) {
  const queue = useGame((s) => s.stationQueue[cat]);
  const progress = useGame((s) => s.recycleProgress[cat]);
  const def = CATEGORIES[cat];
  const mat = MATERIALS[MATERIAL_BY_CATEGORY[cat]];

  return (
    <div className="rounded-lg border border-white/[0.07] bg-black/20 px-3 py-2">
      <div className="flex items-start gap-2">
        <Dot color={def.color} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] text-white/85">{def.name}</div>
          <div className="text-[11px] text-white/40">→ {mat.name}</div>
        </div>
        <span className="ts-mono text-[12px] text-white/70">
          {num(queue)} waiting
        </span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <div className="flex-1">
          <MiniBar
            value={progress}
            max={mat.itemsPerUnit}
            color={def.color}
            thin
          />
        </div>
        <span className="ts-mono shrink-0 text-[10px] text-white/40">
          {progress} / {mat.itemsPerUnit} to the next {mat.unit}
        </span>
      </div>
    </div>
  );
}
