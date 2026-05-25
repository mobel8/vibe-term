#!/usr/bin/env bash
# vibe-term — pre-release sanity checks.
#
# Run this *before* tagging a release. It refuses to continue on the first
# failure so the human keeps a clear signal of what to fix, in what order.
#
# Checks, in order:
#   1.  Working tree is clean.
#   2.  We are on the `main` branch.
#   3.  No git tag `vX.Y.Z` already exists for the current version.
#   4.  Cargo.toml, package.json and tauri.conf.json agree on the version.
#   5.  `cargo fmt --check` is happy.
#   6.  `cargo clippy --all-targets --all-features -- -D warnings` is happy.
#   7.  `pnpm typecheck` is happy.
#   8.  `pnpm lint` is happy.
#   9.  `pnpm test` is happy.
#  10.  `cargo test --all-features` is happy.
#  11.  CHANGELOG.md contains a `## [X.Y.Z]` section for the current version.

set -euo pipefail

# ─── Pretty printing ──────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
  C_DIM="\033[2m"
  C_RED="\033[31m"
  C_GREEN="\033[32m"
  C_YELLOW="\033[33m"
  C_RESET="\033[0m"
else
  C_DIM=""
  C_RED=""
  C_GREEN=""
  C_YELLOW=""
  C_RESET=""
fi

STEP=0

step() {
  STEP=$((STEP + 1))
  printf "${C_DIM}[%02d/11]${C_RESET} %s\n" "${STEP}" "$1"
}

ok() {
  printf "       ${C_GREEN}OK${C_RESET}   %s\n" "$1"
}

fail() {
  printf "       ${C_RED}FAIL${C_RESET} %s\n" "$1" >&2
  exit 1
}

warn() {
  printf "       ${C_YELLOW}WARN${C_RESET} %s\n" "$1" >&2
}

# ─── Setup ────────────────────────────────────────────────────────────────────

repo_root() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cd "${script_dir}/.." && pwd
}

ROOT="$(repo_root)"
cd "${ROOT}"

# Pull versions out of the three manifests. We parse with grep/sed rather
# than calling `jq`/`tomlq` so this script has zero runtime dependencies
# beyond a POSIX shell + git.
cargo_version() {
  # First `version = "x.y.z"` line under `[package]` in src-tauri/Cargo.toml.
  awk '
    /^\[package\]/ { in_pkg = 1; next }
    /^\[/         { in_pkg = 0 }
    in_pkg && /^version[[:space:]]*=/ {
      match($0, /"[^"]+"/)
      print substr($0, RSTART + 1, RLENGTH - 2)
      exit
    }
  ' "${ROOT}/src-tauri/Cargo.toml"
}

package_json_version() {
  # We grep the top-level `"version"` field. node is not available everywhere
  # this script may run (e.g. release branch CI before pnpm install).
  grep -m1 '"version"' "${ROOT}/package.json" \
    | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'
}

tauri_conf_version() {
  grep -m1 '"version"' "${ROOT}/src-tauri/tauri.conf.json" \
    | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'
}

# ─── 1. Clean working tree ────────────────────────────────────────────────────

step "Working tree is clean"
if [[ -n "$(git status --porcelain)" ]]; then
  git status --short >&2
  fail "Uncommitted changes — stash or commit before release."
fi
ok "no uncommitted changes"

# ─── 2. On main ───────────────────────────────────────────────────────────────

step "On branch main"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "${BRANCH}" != "main" ]]; then
  fail "Current branch is '${BRANCH}', expected 'main'."
fi
ok "branch=main"

# ─── 3. Version coherence ─────────────────────────────────────────────────────

step "Cargo.toml / package.json / tauri.conf.json agree on a single version"
V_CARGO="$(cargo_version || echo '')"
V_PKG="$(package_json_version || echo '')"
V_TAURI="$(tauri_conf_version || echo '')"

if [[ -z "${V_CARGO}" || -z "${V_PKG}" || -z "${V_TAURI}" ]]; then
  fail "Could not parse versions: cargo=${V_CARGO:-?} pkg=${V_PKG:-?} tauri=${V_TAURI:-?}"
fi
if [[ "${V_CARGO}" != "${V_PKG}" || "${V_CARGO}" != "${V_TAURI}" ]]; then
  fail "Version mismatch: Cargo=${V_CARGO}, package.json=${V_PKG}, tauri.conf.json=${V_TAURI}"
fi
VERSION="${V_CARGO}"
ok "v${VERSION}"

# ─── 4. Tag not already taken ─────────────────────────────────────────────────

step "Tag v${VERSION} does not already exist"
if git rev-parse "v${VERSION}" >/dev/null 2>&1; then
  fail "Tag v${VERSION} already exists locally."
fi
# Also check the default remote when it is reachable — best-effort, so a
# missing/offline remote only emits a warning.
if git remote get-url origin >/dev/null 2>&1; then
  if git ls-remote --tags --exit-code origin "refs/tags/v${VERSION}" >/dev/null 2>&1; then
    fail "Tag v${VERSION} already exists on origin."
  fi
else
  warn "No 'origin' remote — skipping remote tag check."
fi
ok "tag v${VERSION} is free"

# ─── 5. cargo fmt ─────────────────────────────────────────────────────────────

step "cargo fmt --check"
( cd "${ROOT}/src-tauri" && cargo fmt --all -- --check ) || fail "cargo fmt --check failed"
ok "rustfmt clean"

# ─── 6. cargo clippy ──────────────────────────────────────────────────────────

step "cargo clippy -D warnings"
( cd "${ROOT}/src-tauri" && cargo clippy --all-targets --all-features -- -D warnings ) \
  || fail "clippy reported warnings (treated as errors)"
ok "clippy clean"

# ─── 7. pnpm typecheck ────────────────────────────────────────────────────────

step "pnpm typecheck"
( cd "${ROOT}" && pnpm typecheck ) || fail "TypeScript reported errors"
ok "tsc --noEmit clean"

# ─── 8. pnpm lint ─────────────────────────────────────────────────────────────

step "pnpm lint (--max-warnings=0)"
( cd "${ROOT}" && pnpm lint ) || fail "ESLint reported errors or warnings"
ok "eslint clean"

# ─── 9. pnpm test ─────────────────────────────────────────────────────────────

step "pnpm test (vitest)"
( cd "${ROOT}" && pnpm test ) || fail "vitest reported failures"
ok "vitest green"

# ─── 10. cargo test ───────────────────────────────────────────────────────────

step "cargo test --all-features"
( cd "${ROOT}/src-tauri" && cargo test --all-features ) || fail "cargo test reported failures"
ok "cargo test green"

# ─── 11. CHANGELOG entry ──────────────────────────────────────────────────────

step "CHANGELOG.md has a section for v${VERSION}"
if ! grep -Eq "^##[[:space:]]+\[${VERSION}\]" "${ROOT}/CHANGELOG.md"; then
  fail "No '## [${VERSION}]' section in CHANGELOG.md — run 'just bump ${VERSION}' or edit manually."
fi
ok "CHANGELOG.md references v${VERSION}"

# ─── Done ─────────────────────────────────────────────────────────────────────

printf "\n${C_GREEN}All pre-release checks passed for v%s.${C_RESET}\n" "${VERSION}"
printf "${C_DIM}Next: git tag -a v%s -m 'v%s' && git push origin v%s${C_RESET}\n" \
  "${VERSION}" "${VERSION}" "${VERSION}"
