// vibe-term — First-run detection hook.
//
// A tiny localStorage-backed gate. We deliberately don't round-trip through
// the backend config for this — the onboarding decision is per-installation
// (a fresh user on the same machine should still get the wizard), and the
// frontend is the only one that needs to act on it.

import { useCallback, useEffect, useState } from "react";

export const ONBOARDED_STORAGE_KEY = "vt:onboarded";

export interface UseFirstRunResult {
  /** True until the user (or our migration) marks the wizard as done. */
  needsOnboarding: boolean;
  /** Persist the "done" flag and flip the state. */
  completeOnboarding: () => void;
  /** Reset the flag — useful from settings → advanced → "Replay onboarding". */
  resetOnboarding: () => void;
}

function readOnboarded(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(ONBOARDED_STORAGE_KEY) === "true";
  } catch {
    // Private mode / quota errors — best to assume the user already saw the
    // wizard rather than block boot.
    return true;
  }
}

export function useFirstRun(): UseFirstRunResult {
  const [onboarded, setOnboarded] = useState<boolean>(() => readOnboarded());

  // Keep multiple tabs / windows in sync via the storage event.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (e: StorageEvent) => {
      if (e.key !== ONBOARDED_STORAGE_KEY) return;
      setOnboarded(e.newValue === "true");
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  const completeOnboarding = useCallback(() => {
    try {
      window.localStorage.setItem(ONBOARDED_STORAGE_KEY, "true");
    } catch {
      // ignore — the in-memory flag below still works for this session.
    }
    setOnboarded(true);
  }, []);

  const resetOnboarding = useCallback(() => {
    try {
      window.localStorage.removeItem(ONBOARDED_STORAGE_KEY);
    } catch {
      // ignore.
    }
    setOnboarded(false);
  }, []);

  return {
    needsOnboarding: !onboarded,
    completeOnboarding,
    resetOnboarding,
  };
}

export default useFirstRun;
