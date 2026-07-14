// vibe-term — Single serialized writer per PTY.
//
// EVERY byte the frontend sends to a PTY must funnel through here. xterm's
// onData (keystrokes, pastes, auto-replies to TUI queries like `\x1b[6n`),
// the image @-mention inserter, the screenshot path inserter and the
// Ctrl+Alt+V base64 streamer used to fire independent, un-awaited
// `pty.write` IPC calls. Those calls resolve on the backend's spawn_blocking
// pool with NO FIFO guarantee, so two in-flight writes could interleave —
// splicing an inserted `@~/.vibe-shots/x.png` (or a CPR reply) INTO the
// middle of the user's typed command. That is exactly the "parasitic
// characters" corruption observed at a PowerShell prompt ("abcrite-Host").
//
// The queue below keeps AT MOST ONE pty_write in flight per PTY; bytes that
// arrive while a write is pending are appended in order and flushed in the
// next write. Order is preserved end-to-end (the backend serialises writes
// on a per-pane mutex once they arrive in order).

import { pty } from "@/ipc";

interface WriterState {
  buf: string;
  writing: boolean;
}

const writers = new Map<string, WriterState>();

/**
 * Queue `data` for the given PTY, preserving global FIFO order across every
 * caller in the renderer. Fire-and-forget: errors are logged and the pending
 * buffer for that PTY is dropped (the PTY is almost certainly dead).
 */
export function writePty(ptyId: string, data: string): void {
  if (!ptyId || !data) return;
  let st = writers.get(ptyId);
  if (!st) {
    st = { buf: "", writing: false };
    writers.set(ptyId, st);
  }
  st.buf += data;
  if (st.writing) return;
  st.writing = true;
  void (async () => {
    while (st.buf) {
      const chunk = st.buf;
      st.buf = "";
      try {
        await pty.write(ptyId, chunk);
      } catch (err) {
        console.warn("[pty-writer] write failed; dropping pending bytes", ptyId, err);
        st.buf = "";
        break;
      }
    }
    st.writing = false;
  })();
}

/** Drop the queue for a PTY that no longer exists (tab closed / exited). */
export function disposePtyWriter(ptyId: string): void {
  writers.delete(ptyId);
}
