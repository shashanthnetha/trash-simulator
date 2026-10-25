// Trash Simulator – Internet Identity sign-in
//
// Rebuilt following the official skill (skills.internetcomputer.org,
// "internet-identity", @icp-sdk/auth 7.x):
// - The AuthClient is constructed ONCE; the identity provider URL must
//   include the /authorize path (7.x no longer appends it itself).
// - signIn() is promise-based, awaited and caught (popup closed = error).
// - Signing in is pure authentication: NO backend calls in the login path.
//   (The previous integration called canister methods on login that this
//   backend does not have – so the login appeared to fail even though the
//   delegation had long since been stored.)
// - The anonymous principal (2vxsx-fae) never counts as signed in.
// - derivationOrigin comes from the platform configuration so that the
//   principal stays stable across all delivery domains.
import { loadConfig } from "@caffeineai/core-infrastructure";
import { AuthClient } from "@icp-sdk/auth/client";
import type { Identity } from "@icp-sdk/core/agent";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/** 30 days – the allowed maximum; after that a new sign-in is required. */
const MAX_TIME_TO_LIVE_NS = BigInt(30 * 24) * BigInt(3_600_000_000_000);

declare const process: { env: Record<string, string | undefined> };

/** Forces the /authorize path – without it 7.x only opens the II home page. */
function identityProviderUrl(): URL {
  // Vite replaces process.env.II_URL with a literal string at build time;
  // the try block guards runtimes without a process object.
  let fromEnv: string | undefined;
  try {
    fromEnv = process.env.II_URL;
  } catch {
    fromEnv = undefined;
  }
  const url = new URL(fromEnv || "https://id.ai");
  url.pathname = "/authorize";
  return url;
}

function isUsable(identity: Identity | null): identity is Identity {
  return identity != null && !identity.getPrincipal().isAnonymous();
}

export interface InternetIdentityContextValue {
  identity: Identity | null;
  isAuthenticated: boolean;
  /** true while the stored session state is still being loaded. */
  isInitializing: boolean;
  isLoggingIn: boolean;
  login: () => void;
  clear: () => void;
  loginError: string | null;
}

const Ctx = createContext<InternetIdentityContextValue | null>(null);

export function InternetIdentityProvider({
  children,
}: {
  children: ReactNode;
}) {
  const clientRef = useRef<AuthClient | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [phase, setPhase] = useState<
    "initializing" | "ready" | "signingIn" | "error"
  >("initializing");
  const [loginError, setLoginError] = useState<string | null>(null);

  // Build the client once and restore an existing session.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        let derivationOrigin: string | undefined;
        try {
          derivationOrigin = (await loadConfig()).ii_derivation_origin;
        } catch {
          /* Configuration unreachable – signing in still works */
        }
        if (cancelled) return;

        const client = new AuthClient({
          identityProvider: identityProviderUrl(),
          derivationOrigin,
          // Do not end game sessions because of inactivity.
          idleOptions: { disableIdle: true, disableDefaultIdleCallback: true },
        });
        clientRef.current = client;

        if (client.isAuthenticated()) {
          const restored = await client.getIdentity();
          if (cancelled) return;
          setIdentity(isUsable(restored) ? restored : null);
        }
        setPhase("ready");
      } catch (e) {
        if (cancelled) return;
        setLoginError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(() => {
    const client = clientRef.current;
    if (!client) {
      setLoginError("Sign-in is not ready yet. Please wait a moment.");
      setPhase("error");
      return;
    }
    setPhase("signingIn");
    setLoginError(null);
    // signIn has to start synchronously inside the click (user activation for
    // the popup); that is why there is no await in front of it.
    void client
      .signIn({ maxTimeToLive: MAX_TIME_TO_LIVE_NS })
      .then((fresh) => {
        if (isUsable(fresh)) {
          setIdentity(fresh);
          setPhase("ready");
        } else {
          // Anonymous principal after signIn: authentication failed silently
          // (skill, failure pattern no. 6).
          setIdentity(null);
          setLoginError("The sign-in was not completed. Please try again.");
          setPhase("error");
        }
      })
      .catch((e: unknown) => {
        setIdentity(null);
        setLoginError(
          e instanceof Error && e.message ? e.message : "Sign-in cancelled.",
        );
        setPhase("error");
      });
  }, []);

  const clear = useCallback(() => {
    const client = clientRef.current;
    setIdentity(null);
    setPhase("ready");
    setLoginError(null);
    void client?.signOut().catch(() => {
      /* Signing out is local – errors here are not critical */
    });
  }, []);

  const value = useMemo<InternetIdentityContextValue>(
    () => ({
      identity,
      isAuthenticated: isUsable(identity),
      isInitializing: phase === "initializing",
      isLoggingIn: phase === "signingIn",
      login,
      clear,
      loginError: phase === "error" ? loginError : null,
    }),
    [identity, phase, login, clear, loginError],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useInternetIdentity(): InternetIdentityContextValue {
  const ctx = useContext(Ctx);
  if (!ctx)
    throw new Error(
      "useInternetIdentity needs an InternetIdentityProvider around the tree.",
    );
  return ctx;
}
