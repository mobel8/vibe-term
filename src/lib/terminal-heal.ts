// vibe-term — Self-healing for leaked terminal modes.
//
// When a TUI dies without cleanup (ssh drop mid-claude/vim, killed process),
// the DEC private modes it enabled stay latched in the EMULATOR: mouse
// tracking eats the wheel (can't scroll up), bracketed paste wraps pastes in
// literal `200~…201~`, focus reporting types `[I`/`[O` on every alt-tab, the
// alternate screen freezes the last TUI frame over a live prompt. On this
// user's setup the trigger is real: Win10 conhost forwards 2004/1004 through
// ConPTY, and raw ssh pipes forward everything.
//
// The reset below is written INTO xterm (term.write = program→terminal
// direction, where modes are set), so it only rewinds emulator state — the
// shell underneath is untouched.

import type { Terminal } from "@xterm/xterm";

/**
 * Leave the alternate screen, disable every mouse protocol + encoding,
 * focus reporting, bracketed paste and application cursor keys; re-show the
 * cursor, restore wraparound, leave insert mode. Ordered so the alt-screen
 * exit happens first (the rest then applies to the normal buffer).
 */
export const MODE_RESET_SEQUENCE =
  "\x1b[?1049l" + // alternate screen off (restores normal buffer + scrollback)
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l" + // mouse: click / drag / any-motion off
  "\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l" + // mouse encodings off
  "\x1b[?1004l" + // focus reporting off (kills [I / [O parasites)
  "\x1b[?2004l" + // bracketed paste off (kills 200~ / 201~ parasites)
  "\x1b[?1l" + // application cursor keys off (arrows type normally again)
  "\x1b[?25h" + // cursor visible
  "\x1b[?7h" + // autowrap on
  "\x1b[4l"; // insert mode off

/**
 * True when the emulator is in a state that a plain shell prompt would never
 * ask for — used as the CHEAP gate before the (async) orphan check. A live
 * TUI legitimately triggers most of these, so callers must confirm the pane
 * has no running child before healing.
 */
export function isTerminalStateSuspicious(term: Terminal): boolean {
  const m = term.modes;
  return (
    m.mouseTrackingMode !== "none" ||
    m.bracketedPasteMode ||
    m.sendFocusMode ||
    m.applicationCursorKeysMode ||
    term.buffer.active.type === "alternate"
  );
}

/** Rewind all leaked modes in the local emulator. */
export function healTerminalModes(term: Terminal): void {
  term.write(MODE_RESET_SEQUENCE);
}
