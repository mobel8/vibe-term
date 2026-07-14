// vibe-term — Live xterm.js instance registry, keyed by tab id.
//
// Lets app-level features (palette "Clear/Reset terminal", theme runtime,
// the e2e debug hook) reach the active Terminal without threading refs
// through React. useXterm registers each instance for the pane's lifetime.

import type { Terminal } from "@xterm/xterm";

const terms = new Map<string, Terminal>();

/** Register a live terminal; returns an unregister disposer. */
export function registerTerm(tabId: string, term: Terminal): () => void {
  terms.set(tabId, term);
  return () => {
    // Guard against a newer instance having replaced this slot already.
    if (terms.get(tabId) === term) terms.delete(tabId);
  };
}

export function getTerm(tabId: string): Terminal | undefined {
  return terms.get(tabId);
}

export function getAllTerms(): ReadonlyMap<string, Terminal> {
  return terms;
}
