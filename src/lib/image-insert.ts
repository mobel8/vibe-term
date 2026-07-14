// Shared image → terminal insertion logic, used by BOTH the clipboard-paste
// handler (TerminalView) and the image-gallery drag/drop + insert affordances.
// Keeping it in one place guarantees the two surfaces behave identically and
// can't drift — the paste path is load-bearing (it carries the proven
// SSH/local @~/.vibe-shots flow), so the gallery reuses it verbatim.

import { pty } from "@/ipc";
import { writePty } from "@/lib/pty-writer";
import { toast } from "@/state/toastStore";

/**
 * MIME tag for an in-app drag of a gallery thumbnail onto a terminal pane. The
 * payload is the image id; the terminal's drop handler resolves the local path
 * and reuses {@link insertImageIntoTerminal}. Shared by the gallery (drag
 * source) and TerminalView (drop target) so the two can never drift.
 */
export const GALLERY_DRAG_MIME = "application/x-vibe-image";

// SSH-host detection walks the remote process tree on the Rust side, which is
// slow enough to visibly stall a paste. Cache it briefly per PTY so repeated
// screenshot pastes/drops don't re-scan; the short TTL bounds staleness if the
// user exits ssh in the same tab.
const SSH_HOST_TTL_MS = 3000;
const sshHostCache = new Map<string, { at: number; host: string | null }>();

export async function detectSshHost(ptyId: string): Promise<string | null> {
  const now = Date.now();
  const cached = sshHostCache.get(ptyId);
  if (cached && now - cached.at < SSH_HOST_TTL_MS) return cached.host;
  // Sweep expired entries so the cache can't grow unbounded as tabs (and their
  // PTYs) come and go — every closed tab used to leave a dead entry behind that
  // was never reclaimed. Deleting during Map iteration is safe in JS.
  for (const [id, entry] of sshHostCache) {
    if (now - entry.at >= SSH_HOST_TTL_MS) sshHostCache.delete(id);
  }
  const host = await pty.sshHost(ptyId).catch(() => null);
  sshHostCache.set(ptyId, { at: Date.now(), host });
  return host;
}

// Predict the remote path `ssh_upload_image` will write to, so we can insert the
// functional @-mention IMMEDIATELY (Claude Code reads images from an @path) while
// the upload runs in the background. The backend names the remote file from the
// same stem (first 8 chars) + extension, so this matches what actually lands at
// ~/.vibe-shots/.
export function remoteShotPath(localPath: string): string {
  const base = localPath.split(/[\\/]/).pop() ?? localPath;
  const dot = base.lastIndexOf(".");
  const stem = (dot > 0 ? base.slice(0, dot) : base).slice(0, 8);
  const ext = dot > 0 ? base.slice(dot + 1) : "png";
  return `~/.vibe-shots/${stem}.${ext}`;
}

/**
 * Insert a functional `@<path> ` image mention into a terminal's PTY so a CLI
 * such as Claude Code reads the image — handling BOTH local and SSH sessions
 * identically to the clipboard-paste path:
 *   - SSH  → insert the predicted remote @path INSTANTLY, upload in background.
 *   - Local → stage a copy under ~/.vibe-shots/ and insert that @path (falling
 *             back to ESC v / Alt+V if staging fails).
 *
 * `sshHost` may be passed pre-resolved (the paste path detects it in parallel
 * with the clipboard read for fluidity); pass `undefined` to detect it here.
 */
export async function insertImageIntoTerminal(
  ptyId: string,
  localPath: string,
  sshHost?: string | null,
): Promise<void> {
  const host = sshHost === undefined ? await detectSshHost(ptyId) : sshHost;

  if (host) {
    const remotePath = remoteShotPath(localPath);
    // Serialized writer: the mention must never splice into keystrokes or a
    // TUI's in-flight query replies (parasitic-characters corruption).
    writePty(ptyId, `@${remotePath} `);
    void pty
      .sshUploadImage(host, localPath)
      .then(() => toast.success(`Screenshot ready → ${host} (${remotePath})`))
      .catch((err: unknown) =>
        toast.error(
          err instanceof Error ? err.message : "Screenshot upload failed",
        ),
      );
    return;
  }

  // Local: stage at ~/.vibe-shots/<id>.png and insert the SAME @-mention shape
  // as SSH so a local Claude Code reads it identically. The copy is ~instant;
  // fall back to Alt+V (ESC v) if it fails.
  try {
    const localShot = await pty.stageLocalShot(localPath);
    writePty(ptyId, `@${localShot} `);
  } catch {
    writePty(ptyId, "\x1b\x76");
  }
}
