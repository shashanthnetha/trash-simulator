// Trash Simulator – app root
import { useEffect } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { GameCanvas } from "./components/GameCanvas";
import { HUD } from "./components/HUD";
import { Menus } from "./components/Menus";
import { PauseSettings } from "./components/PauseSettings";
import { StartScreen } from "./components/StartScreen";
import { TouchUI } from "./components/TouchUI";
import { DEV } from "./game/dev";
import { getGame } from "./game/engine";
import { useGame } from "./game/state";
import { useBackendSync } from "./hooks/useBackendSync";

export default function App() {
  const screen = useGame((s) => s.screen);
  const menuOpen = useGame((s) => s.menuOpen);
  const paused = useGame((s) => s.paused);
  const isTouch = useGame((s) => s.isTouch);
  const cloudStatus = useGame((s) => s.cloudStatus);
  const engineStatus = useGame((s) => s.engineStatus);
  const bootStep = useGame((s) => s.bootStep);
  const engineError = useGame((s) => s.engineError);
  const sync = useBackendSync();

  // Surface runtime errors from outside React too (instead of silent blue)
  useEffect(() => {
    const onErr = (e: ErrorEvent) => {
      const st = useGame.getState();
      if (st.screen === "game" && st.engineStatus !== "error")
        st.setEngineStatus(
          "error",
          `${e.message}\n${e.error instanceof Error ? (e.error.stack ?? "") : ""}`,
        );
    };
    window.addEventListener("error", onErr);
    return () => window.removeEventListener("error", onErr);
  }, []);

  // No sign-in, no game: straight back to the control room.
  useEffect(() => {
    if (DEV.enabled) return;
    if (!sync.isAuthenticated && useGame.getState().screen === "game") {
      const st = useGame.getState();
      st.setPaused(false);
      st.setMenu(false);
      st.setScreen("start");
    }
  }, [sync.isAuthenticated]);

  // Dev harness (Vite dev mode + ?dev=1 only): straight into the game, no login.
  useEffect(() => {
    if (!DEV.enabled) return;
    const st = useGame.getState();
    if (DEV.quality) st.updateSettings({ quality: DEV.quality });
    if (st.screen === "start") {
      st.newGame("Dev");
      // newGame rolls a seed; pin it so screenshots stay comparable.
      useGame.setState({ seed: DEV.seed });
    }
  }, []);

  // Last chance to save when the tab is closed
  useEffect(() => {
    const onLeave = () => {
      const st = useGame.getState();
      if (st.screen === "game" && st.cloudDirty && sync.isAuthenticated)
        sync.saveToProfile();
    };
    window.addEventListener("pagehide", onLeave);
    return () => window.removeEventListener("pagehide", onLeave);
  }, [sync.isAuthenticated, sync.saveToProfile]);

  const toMainMenu = () => {
    const st = useGame.getState();
    if (sync.isAuthenticated && st.cloudDirty) sync.saveToProfile();
    st.setPaused(false);
    st.setMenu(false);
    st.setScreen("start");
  };

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#07141c] font-sans">
      {screen === "start" ? (
        <StartScreen
          isAuthenticated={sync.isAuthenticated}
          isLoggingIn={sync.isLoggingIn}
          authInitializing={sync.authInitializing}
          loginError={sync.loginError}
          onLogin={sync.login}
          onLogout={sync.logout}
          profile={sync.profile}
          profileChecking={sync.profileChecking}
          profileError={sync.profileError}
          onRetryProfile={sync.retryProfile}
          needsRegistration={sync.needsRegistration}
          onRegister={sync.registerName}
          registerBusy={sync.registerBusy}
          registerOutcome={sync.registerOutcome}
          checkNameAvailable={sync.checkNameAvailable}
          hasSave={sync.profile?.hasSave === true}
          onContinue={sync.loadProfileIntoGame}
          onNewRun={sync.startFreshRun}
          loadBusy={sync.loadBusy}
          leaderboard={sync.leaderboard}
          globalStats={sync.globalStats}
        />
      ) : (
        <>
          <GameCanvas />
          {engineStatus === "ready" && (
            <HUD balanceCents={sync.market.balanceCents} />
          )}
          {engineStatus === "booting" && (
            <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-[#06202e]">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-cyan-300/30 border-t-cyan-300" />
              <div className="text-sm font-semibold tracking-wide text-cyan-100/90">
                Preparing the beach …
              </div>
              <div className="text-xs text-white/50">
                {bootStep ? `Building ${bootStep}` : "Starting up the waves"}
              </div>
            </div>
          )}
          {engineStatus === "error" && (
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-[#06202e] p-6">
              <div className="w-full max-w-lg rounded-2xl border border-amber-400/40 bg-[#0b2a3a] p-5 shadow-2xl">
                <div className="mb-2 text-lg font-bold text-amber-300">
                  The game could not start
                </div>
                <pre className="scroll-thin mb-4 max-h-52 select-text overflow-auto whitespace-pre-wrap rounded-lg bg-black/40 p-3 text-[11px] leading-snug text-amber-100">
                  {engineError}
                </pre>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => window.location.reload()}
                    className="rounded-xl bg-cyan-500 px-4 py-2 text-sm font-bold text-[#04222e] hover:bg-cyan-400"
                  >
                    Reload
                  </button>
                  <button
                    type="button"
                    onClick={toMainMenu}
                    className="rounded-xl bg-white/10 px-4 py-2 text-sm font-bold text-white hover:bg-white/20"
                  >
                    Back to start
                  </button>
                </div>
              </div>
            </div>
          )}
          {engineStatus === "ready" && isTouch && !paused && !menuOpen && (
            <TouchUI />
          )}
          {menuOpen && (
            <Menus
              leaderboard={sync.leaderboard}
              globalStats={sync.globalStats}
              leaderboardBusy={sync.leaderboardBusy}
              onRefreshLeaderboard={sync.refreshLeaderboard}
              market={sync.market}
              onClose={() => getGame()?.resume()}
            />
          )}
          {paused && !menuOpen && (
            <PauseSettings
              isAuthenticated={sync.isAuthenticated}
              cloudBusy={sync.saveBusy}
              onCloudSave={sync.saveToProfile}
              onMainMenu={toMainMenu}
            />
          )}
          {/* Cloud status, discreetly in the bottom right */}
          {!paused && !menuOpen && (
            <div className="pointer-events-none absolute bottom-1.5 right-2 text-[10px] text-white/40">
              {cloudStatus === "online" && "Profile saved"}
              {cloudStatus === "sync" && "Saving …"}
              {cloudStatus === "error" && "Save failed"}
              {cloudStatus === "offline" && "Not signed in"}
            </div>
          )}
        </>
      )}
    </div>
  );
}
