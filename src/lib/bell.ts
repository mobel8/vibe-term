// vibe-term — Terminal bell helpers.
//
// Two flavours: a soft sine-wave beep through the Web Audio API for the
// audible side, and a body-class toggle that drives a CSS animation when the
// visual flash is preferred (or both at once). Both are no-ops when the
// browser denies the request — terminal usability never depends on them.

let cachedCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (cachedCtx) return cachedCtx;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    cachedCtx = new Ctor();
  } catch {
    cachedCtx = null;
  }
  return cachedCtx;
}

/**
 * Play a short ~80 ms sine pulse at 880 Hz. Caps the gain at 0.04 so the
 * beep is gentle on headphones.
 */
export function playBeep(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    void ctx.resume().catch(() => undefined);
  }
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.setValueAtTime(880, now);
  osc.type = "sine";
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.04, now + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.1);
}

const VISUAL_CLASS = "vibe-bell-flash";

/** Toggle a body-level class for ~150 ms so global CSS can flash a border. */
export function flashVisualBell(): void {
  if (typeof document === "undefined") return;
  const body = document.body;
  body.classList.add(VISUAL_CLASS);
  window.setTimeout(() => body.classList.remove(VISUAL_CLASS), 150);
}
