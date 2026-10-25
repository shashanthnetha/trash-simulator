// Trash Simulator – control room: sign-in, operator ID, main menu
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GlobalStats, LeaderboardEntry, ProfileOutput } from "../backend";
import { useGame } from "../game/state";
import { levelFromXp } from "../game/types";
import type { RegisterOutcome } from "../hooks/useBackendSync";

export interface StartScreenProps {
  isAuthenticated: boolean;
  isLoggingIn: boolean;
  authInitializing: boolean;
  loginError: string | null;
  onLogin: () => void;
  onLogout: () => void;
  profile: ProfileOutput | null;
  profileChecking: boolean;
  profileError: boolean;
  onRetryProfile: () => void;
  needsRegistration: boolean;
  onRegister: (name: string) => void;
  registerBusy: boolean;
  registerOutcome: RegisterOutcome | null;
  checkNameAvailable: (name: string) => Promise<boolean>;
  hasSave: boolean;
  onContinue: () => void;
  onNewRun: () => void;
  loadBusy: boolean;
  leaderboard: LeaderboardEntry[] | null;
  globalStats: GlobalStats | null;
}

const NAME_PATTERN = /^[A-Za-zÄÖÜäöüß0-9 ._-]{3,24}$/;

function num(v: bigint | number): string {
  return new Intl.NumberFormat("en-GB").format(Number(v));
}

/** Dot-leader row, like on a weighbridge ticket. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="board-row py-[5px]">
      <span className="text-[12px] text-[var(--muted)]">{label}</span>
      <span className="lead" />
      <span className="ts-mono text-[13px] text-[var(--chalk)]">{value}</span>
    </div>
  );
}

function StatusChip({ text, tone }: { text: string; tone: "on" | "off" }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="h-[7px] w-[7px] rounded-full"
        style={{
          background: tone === "on" ? "var(--sorted)" : "var(--seam)",
          boxShadow: tone === "on" ? "0 0 8px rgba(155,197,61,0.7)" : "none",
        }}
      />
      <span className="ts-label">{text}</span>
    </div>
  );
}

export function StartScreen(props: StartScreenProps) {
  const {
    isAuthenticated,
    isLoggingIn,
    authInitializing,
    loginError,
    onLogin,
    onLogout,
    profile,
    profileChecking,
    profileError,
    onRetryProfile,
    needsRegistration,
    onRegister,
    registerBusy,
    registerOutcome,
    checkNameAvailable,
    hasSave,
    onContinue,
    onNewRun,
    loadBusy,
    leaderboard,
    globalStats,
  } = props;

  const isTouchLike = typeof window !== "undefined" && "ontouchstart" in window;

  const mode: "locked" | "checking" | "error" | "register" | "menu" =
    authInitializing
      ? "checking"
      : !isAuthenticated
        ? "locked"
        : profile
          ? "menu"
          : needsRegistration
            ? "register"
            : profileError
              ? "error"
              : "checking";

  return (
    <div className="ts-shell ts-grain">
      {/* Signature: hazard stripe along the left edge */}
      <div className="hazard-rail anim-rail absolute inset-y-0 left-0 w-[10px] md:w-[14px]" />

      <div className="relative mx-auto flex min-h-full w-full max-w-6xl flex-col gap-8 py-10 pl-[26px] pr-5 md:gap-10 md:py-14 md:pl-14 md:pr-10">
        <Header
          isAuthenticated={isAuthenticated}
          name={profile?.name ?? null}
        />

        <div className="grid flex-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)] lg:gap-10">
          <section className="anim-rise d2 order-2 lg:order-1">
            {mode === "locked" && (
              <LockedPanel
                isLoggingIn={isLoggingIn}
                onLogin={onLogin}
                loginError={loginError}
              />
            )}
            {mode === "checking" && <CheckingPanel busy={profileChecking} />}
            {mode === "error" && <ProfileErrorPanel onRetry={onRetryProfile} />}
            {mode === "register" && (
              <RegisterPanel
                onRegister={onRegister}
                busy={registerBusy}
                outcome={registerOutcome}
                checkNameAvailable={checkNameAvailable}
              />
            )}
            {mode === "menu" && profile && (
              <MenuPanel
                profile={profile}
                hasSave={hasSave}
                onContinue={onContinue}
                onNewRun={onNewRun}
                onLogout={onLogout}
                loadBusy={loadBusy}
              />
            )}
          </section>

        </div>

        <ControlLegend touch={isTouchLike} />
      </div>
    </div>
  );
}

function Header({
  isAuthenticated,
  name,
}: {
  isAuthenticated: boolean;
  name: string | null;
}) {
  return (
    <header className="anim-rise d1">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="ts-eyebrow">
          Coastal Section North · Cleaning Service
        </span>
        <StatusChip
          text={
            isAuthenticated
              ? `Local profile${name ? ` · ${name}` : ""}`
              : "No profile yet"
          }
          tone={isAuthenticated ? "on" : "off"}
        />
      </div>

      <h1 className="ts-display mt-5 text-[clamp(3rem,11vw,6.5rem)]">
        <span className="block">Trash</span>
        <span className="block text-[var(--amber)]">Simulator</span>
      </h1>

      <div
        className="mt-5 h-[3px] w-[120px]"
        style={{ background: "var(--amber)" }}
      />
      <p className="mt-4 max-w-md text-[15px] leading-relaxed text-[var(--muted)]">
        One stretch of coast, thousands of finds, eight recyclable categories.
        Pick them up, sort them right, hand them in at the station.
      </p>
    </header>
  );
}

function LockedPanel({
  isLoggingIn,
  onLogin,
  loginError,
}: {
  isLoggingIn: boolean;
  onLogin: () => void;
  loginError: string | null;
}) {
  return (
    <div className="plate plate-riveted px-5 py-6 md:px-8 md:py-7">
      <div className="ts-label mb-1">Access</div>
      <h2 className="ts-display mb-3 text-[22px] tracking-normal">
        Sign-in required
      </h2>
      <p className="mb-6 max-w-sm text-[14px] leading-relaxed text-[var(--muted)]">
        Your progress lives in your profile on the Internet Computer — that way
        it stays with you on every device. There is no local save game.
      </p>
      <button
        type="button"
        className="btn btn-primary"
        onClick={onLogin}
        disabled={isLoggingIn}
      >
        <span>
          {isLoggingIn ? "Signing in" : "Sign in with Internet Identity"}
        </span>
        <span className="tag">Step 1 of 2</span>
      </button>
      {loginError && (
        <p className="ts-mono mt-4 text-[11px] leading-relaxed text-[var(--amber)]">
          Sign-in failed: {loginError}
        </p>
      )}
      <p className="ts-mono mt-4 text-[11px] leading-relaxed text-[var(--muted)]">
        The first time, you pick your display name right afterwards.
      </p>
    </div>
  );
}

function CheckingPanel({ busy }: { busy: boolean }) {
  return (
    <div className="plate plate-riveted px-5 py-8 md:px-8">
      <div className="ts-label mb-2">Profile</div>
      <p className="text-[14px] text-[var(--muted)]">
        {busy ? "Loading profile …" : "Connecting …"}
      </p>
    </div>
  );
}

function ProfileErrorPanel({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="plate plate-riveted px-5 py-6 md:px-8 md:py-7">
      <div className="ts-label mb-1">Profile</div>
      <h2 className="ts-display mb-3 text-[22px] tracking-normal">
        Profile could not be loaded
      </h2>
      <p className="mb-5 max-w-sm text-[14px] leading-relaxed text-[var(--muted)]">
        The connection to your profile failed. Check your internet connection
        and try again.
      </p>
      <button type="button" className="btn btn-primary" onClick={onRetry}>
        <span>Try again</span>
      </button>
    </div>
  );
}

function RegisterPanel({
  onRegister,
  busy,
  outcome,
  checkNameAvailable,
}: {
  onRegister: (name: string) => void;
  busy: boolean;
  outcome: RegisterOutcome | null;
  checkNameAvailable: (name: string) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [available, setAvailable] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const seq = useRef(0);

  const formatOk = NAME_PATTERN.test(name.trim());

  useEffect(() => {
    if (!formatOk) {
      setAvailable(null);
      return;
    }
    const mine = ++seq.current;
    setChecking(true);
    const t = window.setTimeout(async () => {
      const ok = await checkNameAvailable(name.trim());
      if (seq.current === mine) {
        setAvailable(ok);
        setChecking(false);
      }
    }, 400);
    return () => {
      window.clearTimeout(t);
      setChecking(false);
    };
  }, [name, formatOk, checkNameAvailable]);

  const hint = useMemo(() => {
    if (name.trim().length === 0)
      return "3 to 24 characters. Letters (umlauts allowed), digits, spaces, dot, hyphen, underscore.";
    if (!formatOk)
      return "This name contains invalid characters or is too short.";
    if (checking) return "Checking availability …";
    if (available === false) return "This name is already taken.";
    if (available === true) return "Name is available.";
    return " ";
  }, [name, formatOk, checking, available]);

  const hintTone =
    available === true
      ? "var(--sorted)"
      : available === false || (name.length > 0 && !formatOk)
        ? "var(--amber)"
        : "var(--muted)";

  const submit = useCallback(() => {
    if (formatOk && !busy) onRegister(name.trim());
  }, [formatOk, busy, name, onRegister]);

  return (
    <div className="plate plate-riveted px-5 py-6 md:px-8 md:py-7">
      <div className="ts-label mb-1">Operator ID</div>
      <h2 className="ts-display mb-3 text-[22px] tracking-normal">
        Create operator ID
      </h2>
      <p className="mb-5 max-w-sm text-[14px] leading-relaxed text-[var(--muted)]">
        This is the name on your local profile, saved in this browser. It is
        assigned once and cannot be changed later.
      </p>

      <label className="ts-label mb-2 block" htmlFor="operatorName">
        Display name
      </label>
      <input
        id="operatorName"
        className="ts-input"
        value={name}
        maxLength={24}
        autoComplete="off"
        spellCheck={false}
        placeholder="e.g. Northwind"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />
      <div className="mt-2 flex items-baseline justify-between gap-3">
        <span className="ts-mono text-[11px]" style={{ color: hintTone }}>
          {hint}
        </span>
        <span className="ts-mono text-[11px] text-[var(--muted)]">
          {name.trim().length}/24
        </span>
      </div>

      {outcome === "nameTaken" && (
        <p className="ts-mono mt-3 text-[11px] text-[var(--amber)]">
          Someone else just claimed that name. Please choose another one.
        </p>
      )}
      {outcome === "invalidName" && (
        <p className="ts-mono mt-3 text-[11px] text-[var(--amber)]">
          The name was rejected. Please check its length and characters.
        </p>
      )}
      {outcome === "anonymous" && (
        <p className="ts-mono mt-3 text-[11px] text-[var(--amber)]">
          Your session is no longer valid. Please sign in again.
        </p>
      )}
      {outcome === "error" && (
        <p className="ts-mono mt-3 text-[11px] text-[var(--amber)]">
          The connection failed. Please try again.
        </p>
      )}

      <div className="mt-6">
        <button
          type="button"
          className="btn btn-primary"
          onClick={submit}
          disabled={!formatOk || busy || available === false}
        >
          <span>{busy ? "Creating" : "Set name"}</span>
          <span className="tag">one-time</span>
        </button>
      </div>
    </div>
  );
}

function MenuPanel({
  profile,
  hasSave,
  onContinue,
  onNewRun,
  onLogout,
  loadBusy,
}: {
  profile: ProfileOutput;
  hasSave: boolean;
  onContinue: () => void;
  onNewRun: () => void;
  onLogout: () => void;
  loadBusy: boolean;
}) {
  const [confirmNew, setConfirmNew] = useState(false);
  const lvl = levelFromXp(Number(profile.xp));
  const pct = Math.round((lvl.into / Math.max(1, lvl.needed)) * 100);

  return (
    <div className="flex flex-col gap-4">
      {/* Operator ID */}
      <div className="plate plate-riveted px-5 py-5 md:px-8 md:py-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="ts-label mb-1">Operator ID</div>
            <div className="ts-display text-[30px] tracking-normal">
              {profile.name}
            </div>
          </div>
          <div className="text-right">
            <div className="ts-label mb-1">Level</div>
            <div className="ts-display text-[30px] text-[var(--amber)]">
              {String(lvl.level)}
            </div>
          </div>
        </div>

        <div className="mt-4 h-[6px] w-full" style={{ background: "#0c1113" }}>
          <div
            className="h-full transition-[width] duration-500"
            style={{ width: `${pct}%`, background: "var(--amber)" }}
          />
        </div>
        <div className="ts-mono mt-2 flex justify-between text-[11px] text-[var(--muted)]">
          <span>
            {num(lvl.into)} / {num(lvl.needed)} XP to level {lvl.level + 1}
          </span>
          <span>{num(profile.recyclePoints)} points</span>
        </div>

        <div
          className="mt-4 border-t pt-3"
          style={{ borderColor: "var(--seam)" }}
        >
          <Row label="Picked up" value={num(profile.totalCollected)} />
          <Row label="Disposed of" value={num(profile.totalDisposed)} />
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-2">
        {hasSave && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={onContinue}
            disabled={loadBusy}
          >
            <span>{loadBusy ? "Loading" : "Resume shift"}</span>
            <span className="tag">Level {lvl.level}</span>
          </button>
        )}

        {!confirmNew ? (
          <button
            type="button"
            className={hasSave ? "btn" : "btn btn-primary"}
            onClick={() => (hasSave ? setConfirmNew(true) : onNewRun())}
          >
            <span>Start a new shift</span>
            <span className="tag">{hasSave ? "resets" : "Start"}</span>
          </button>
        ) : (
          <div
            className="plate px-4 py-4"
            style={{ borderColor: "var(--amber-dim)" }}
          >
            <p className="mb-3 text-[13px] leading-relaxed text-[var(--chalk)]">
              A new shift deletes the progress saved in this browser. Level,
              points and statistics all start over from zero.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setConfirmNew(false);
                  onNewRun();
                }}
              >
                <span>Delete progress and start</span>
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setConfirmNew(false)}
              >
                <span>Cancel</span>
              </button>
            </div>
          </div>
        )}

        <button type="button" className="btn" onClick={onLogout}>
          <span>Sign out</span>
          <span className="tag">save is kept</span>
        </button>
      </div>
    </div>
  );
}

function DataBoard({ globalStats }: { globalStats: GlobalStats | null }) {
  return (
    <div className="plate px-5 py-4">
      <div className="ts-label mb-3">Operating data, all time</div>
      {globalStats ? (
        <>
          <Row label="Active IDs" value={num(globalStats.players)} />
          <Row label="Picked up" value={num(globalStats.totalCollected)} />
          <Row label="Disposed of" value={num(globalStats.totalDisposed)} />
        </>
      ) : (
        <p className="ts-mono text-[12px] text-[var(--muted)]">
          No data available.
        </p>
      )}
    </div>
  );
}

function ShiftBoard({
  leaderboard,
  you,
}: {
  leaderboard: LeaderboardEntry[] | null;
  you: string | null;
}) {
  const rows = (leaderboard ?? []).slice(0, 8);
  return (
    <div className="plate px-5 py-4">
      <div className="ts-label mb-3">Leaderboard</div>
      {rows.length === 0 ? (
        <p className="ts-mono text-[12px] text-[var(--muted)]">
          No entries yet. First place is still open.
        </p>
      ) : (
        <ol className="flex flex-col">
          {rows.map((r, i) => {
            const mine = you != null && r.name === you;
            return (
              <li
                key={r.name}
                className="board-row py-[5px]"
                style={{ color: mine ? "var(--amber)" : undefined }}
              >
                <span className="ts-mono w-5 text-[12px] text-[var(--muted)]">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="truncate text-[13px]">{r.name}</span>
                <span className="lead" />
                <span className="ts-mono text-[12px]">
                  {num(r.totalDisposed)}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function ControlLegend({ touch }: { touch: boolean }) {
  const items: [string, string][] = touch
    ? [
        ["Left stick", "Move"],
        ["Right half", "Look around"],
        ["Grab", "Pick up"],
        ["E", "Jeep"],
        ["Use", "Unload · Use"],
        ["Horn", "Horn (hold, in the jeep)"],
      ]
    : [
        ["WASD", "Move"],
        ["Mouse", "Look around"],
        ["Left click", "Pick up"],
        ["Shift", "Sprint · Brake"],
        ["Space", "Jump"],
        ["E", "Jeep"],
        ["F", "Unload · Use"],
        ["1/2 · Wheel", "Tool"],
        ["H", "Horn (hold, in the jeep)"],
        ["Tab", "Menu"],
        ["I", "Inventory"],
        ["Esc", "Pause"],
      ];

  return (
    <footer className="anim-rise d4">
      <div className="ts-label mb-3">Controls</div>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {items.map(([key, what]) => (
          <div key={key} className="flex items-baseline gap-2">
            <span
              className="ts-mono px-[6px] py-[2px] text-[11px]"
              style={{
                background: "#0c1113",
                border: "1px solid var(--seam)",
                color: "var(--chalk)",
              }}
            >
              {key}
            </span>
            <span className="text-[12px] text-[var(--muted)]">{what}</span>
          </div>
        ))}
      </div>
    </footer>
  );
}
