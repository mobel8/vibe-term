#!/usr/bin/env bash
# vibe-term — environment snapshot.
#
# Prints a markdown report describing the current developer environment.
# Useful for filing reproducible bug reports: the output is intentionally
# verbose, scoped to what affects builds and runtime behaviour, and free of
# secrets.
#
# Usage:
#   ./scripts/dev-snapshot.sh
#   ./scripts/dev-snapshot.sh > snapshot.md
#
# Exit code: always 0 — a missing tool is reported in-band, not as a failure.

set -euo pipefail

# ─── Helpers ──────────────────────────────────────────────────────────────────

repo_root() {
  # Resolve the repo root from the script location so the snapshot works
  # whether you call it from `just doctor` or `./scripts/dev-snapshot.sh`.
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cd "${script_dir}/.." && pwd
}

# `safe_run <cmd> [args...]` runs the command, captures stdout, falls back to
# "(not installed)" if it is missing or fails. We never abort the script —
# the whole point is to gather what *is* available.
safe_run() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "(not installed)"
    return 0
  fi
  if ! out="$("$@" 2>&1)"; then
    echo "(failed: ${out})"
    return 0
  fi
  # Keep only the first non-empty line — every CLI here prints a one-liner.
  echo "${out}" | head -n 1
}

# `hash_file <path>` returns the sha256 (first 12 chars) of a file or
# "(missing)" if it is not present.
hash_file() {
  local path="$1"
  if [[ ! -f "${path}" ]]; then
    echo "(missing)"
    return 0
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${path}" | cut -c1-12
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "${path}" | cut -c1-12
  else
    echo "(no sha256 tool)"
  fi
}

# `pkg_version <pkg>` queries pkg-config for a system library. Returns
# "(missing)" when either pkg-config or the package itself is absent.
pkg_version() {
  if ! command -v pkg-config >/dev/null 2>&1; then
    echo "(no pkg-config)"
    return 0
  fi
  if ! out="$(pkg-config --modversion "$1" 2>/dev/null)"; then
    echo "(missing)"
    return 0
  fi
  echo "${out}"
}

# `env_or <var>` prints the value of an env var, or "(unset)" if it is
# empty/undefined. We never leak the full environment — only the variables
# that materially change vibe-term's behaviour.
env_or() {
  local val="${!1-}"
  if [[ -z "${val}" ]]; then
    echo "(unset)"
  else
    echo "${val}"
  fi
}

# ─── Collect ──────────────────────────────────────────────────────────────────

ROOT="$(repo_root)"
TS="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

OS_NAME="$(uname -s)"
KERNEL="$(uname -r 2>/dev/null || echo unknown)"
ARCH="$(uname -m 2>/dev/null || echo unknown)"

case "${OS_NAME}" in
  Linux)
    if [[ -r /etc/os-release ]]; then
      # shellcheck disable=SC1091
      . /etc/os-release
      DISTRO="${PRETTY_NAME:-Linux}"
    else
      DISTRO="Linux"
    fi
    ;;
  Darwin)
    DISTRO="macOS $(sw_vers -productVersion 2>/dev/null || echo unknown)"
    ;;
  *)
    DISTRO="${OS_NAME}"
    ;;
esac

RUSTC="$(safe_run rustc --version)"
CARGO="$(safe_run cargo --version)"
NODE="$(safe_run node --version)"
PNPM="$(safe_run pnpm --version)"
TAURI="$(safe_run tauri --version)"
JUST="$(safe_run just --version)"
PKG_CONFIG="$(safe_run pkg-config --version)"

PNPM_LOCK="$(hash_file "${ROOT}/pnpm-lock.yaml")"
CARGO_LOCK="$(hash_file "${ROOT}/src-tauri/Cargo.lock")"

# System libs that matter for the Linux bundle. On macOS / Windows these
# legitimately come back as "(missing)" — that is fine, the report makes that
# clear.
WEBKIT="$(pkg_version webkit2gtk-4.1)"
SOUP="$(pkg_version libsoup-3.0)"
GTK="$(pkg_version gtk+-3.0)"
APPINDICATOR="$(pkg_version ayatana-appindicator3-0.1)"

WAYLAND="$(env_or WAYLAND_DISPLAY)"
X11="$(env_or DISPLAY)"
SESSION_TYPE="$(env_or XDG_SESSION_TYPE)"
RUST_LOG="$(env_or RUST_LOG)"
TAURI_DEV_HOST="$(env_or TAURI_DEV_HOST)"

# ─── Render ───────────────────────────────────────────────────────────────────

cat <<EOF
## vibe-term — Environment snapshot

_Generated: ${TS}_

### Operating system

- Distribution: \`${DISTRO}\`
- Kernel: \`${OS_NAME} ${KERNEL}\`
- Architecture: \`${ARCH}\`

### Toolchains

- rustc: \`${RUSTC}\`
- cargo: \`${CARGO}\`
- node: \`${NODE}\`
- pnpm: \`${PNPM}\`
- tauri CLI: \`${TAURI}\`
- just: \`${JUST}\`
- pkg-config: \`${PKG_CONFIG}\`

### Lockfiles (sha256, first 12 chars)

- \`pnpm-lock.yaml\`: \`${PNPM_LOCK}\`
- \`src-tauri/Cargo.lock\`: \`${CARGO_LOCK}\`

### System libraries (pkg-config)

- webkit2gtk-4.1: \`${WEBKIT}\`
- libsoup-3.0: \`${SOUP}\`
- gtk+-3.0: \`${GTK}\`
- ayatana-appindicator3-0.1: \`${APPINDICATOR}\`

### Runtime environment

- \`WAYLAND_DISPLAY\`: \`${WAYLAND}\`
- \`DISPLAY\`: \`${X11}\`
- \`XDG_SESSION_TYPE\`: \`${SESSION_TYPE}\`
- \`RUST_LOG\`: \`${RUST_LOG}\`
- \`TAURI_DEV_HOST\`: \`${TAURI_DEV_HOST}\`
EOF
