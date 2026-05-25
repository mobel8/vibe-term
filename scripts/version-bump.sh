#!/usr/bin/env bash
# vibe-term — version bumper.
#
# Updates the project version in src-tauri/Cargo.toml, package.json and
# src-tauri/tauri.conf.json, and rotates CHANGELOG.md so the new version
# gets its own section dated today.
#
# Usage:
#   ./scripts/version-bump.sh 0.2.0
#
# Refuses to bump when:
#   - the argument is not a valid X.Y.Z (or X.Y.Z-suffix) semver,
#   - the current and target versions are equal,
#   - any of the three manifests cannot be found.

set -euo pipefail

# ─── Args ─────────────────────────────────────────────────────────────────────

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <new-version>" >&2
  exit 2
fi

NEW="$1"

# semver core (X.Y.Z) with an optional pre-release / build suffix.
if [[ ! "${NEW}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
  echo "error: '${NEW}' is not a valid semver (expected X.Y.Z[-suffix])" >&2
  exit 2
fi

# ─── Setup ────────────────────────────────────────────────────────────────────

repo_root() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cd "${script_dir}/.." && pwd
}

ROOT="$(repo_root)"
CARGO="${ROOT}/src-tauri/Cargo.toml"
PKG="${ROOT}/package.json"
TAURI="${ROOT}/src-tauri/tauri.conf.json"
CHANGELOG="${ROOT}/CHANGELOG.md"

for f in "${CARGO}" "${PKG}" "${TAURI}" "${CHANGELOG}"; do
  if [[ ! -f "${f}" ]]; then
    echo "error: missing required file: ${f}" >&2
    exit 1
  fi
done

# `portable_sed_inplace <file> <expr>` — GNU and BSD sed disagree on the -i
# flag. This wrapper writes to a temp file and moves it back, which is both
# portable and safe under SIGINT.
portable_sed_inplace() {
  local file="$1"
  local expr="$2"
  local tmp
  tmp="$(mktemp "${file}.tmp.XXXXXX")"
  sed -E "${expr}" "${file}" > "${tmp}"
  mv "${tmp}" "${file}"
}

current_cargo_version() {
  awk '
    /^\[package\]/ { in_pkg = 1; next }
    /^\[/         { in_pkg = 0 }
    in_pkg && /^version[[:space:]]*=/ {
      match($0, /"[^"]+"/)
      print substr($0, RSTART + 1, RLENGTH - 2)
      exit
    }
  ' "${CARGO}"
}

OLD="$(current_cargo_version)"
if [[ -z "${OLD}" ]]; then
  echo "error: could not read current version from ${CARGO}" >&2
  exit 1
fi
if [[ "${OLD}" == "${NEW}" ]]; then
  echo "error: already on v${NEW}; nothing to do." >&2
  exit 1
fi

TODAY="$(date -u +%Y-%m-%d)"

echo "==> bumping ${OLD} -> ${NEW}"

# ─── 1. Cargo.toml ────────────────────────────────────────────────────────────
#
# Scope the substitution to the `[package]` table — workspace deps may also
# carry `version = "..."` strings and we must not touch them.
{
  awk -v new="${NEW}" '
    BEGIN { in_pkg = 0; done = 0 }
    /^\[package\]/ {
      in_pkg = 1
      print
      next
    }
    /^\[/ {
      in_pkg = 0
      print
      next
    }
    in_pkg && !done && /^version[[:space:]]*=/ {
      sub(/"[^"]+"/, "\"" new "\"")
      done = 1
    }
    { print }
  ' "${CARGO}" > "${CARGO}.tmp"
  mv "${CARGO}.tmp" "${CARGO}"
}

# ─── 2. package.json ──────────────────────────────────────────────────────────
#
# Replace only the first occurrence — npm wants a leading `"version":` field
# in object position; later occurrences (e.g. in `engines.node`) must stay.
portable_sed_inplace "${PKG}" \
  "0,/\"version\"[[:space:]]*:[[:space:]]*\"[^\"]+\"/{s//\"version\": \"${NEW}\"/}"

# ─── 3. tauri.conf.json ───────────────────────────────────────────────────────
portable_sed_inplace "${TAURI}" \
  "0,/\"version\"[[:space:]]*:[[:space:]]*\"[^\"]+\"/{s//\"version\": \"${NEW}\"/}"

# ─── 4. CHANGELOG.md ──────────────────────────────────────────────────────────
#
# We insert a fresh `## [NEW] - YYYY-MM-DD` section right after the existing
# `## [Unreleased]` block — but leave Unreleased intact so future PRs keep
# a clear staging area. If `[Unreleased]` is missing, abort with an error.
if ! grep -q '^## \[Unreleased\]' "${CHANGELOG}"; then
  echo "error: CHANGELOG.md is missing a '## [Unreleased]' section" >&2
  exit 1
fi

# Use awk so we do not depend on GNU-only sed extensions.
awk -v new="${NEW}" -v today="${TODAY}" '
  BEGIN { done = 0 }
  /^## \[Unreleased\]/ && !done {
    print
    print ""
    print "## [" new "] - " today
    done = 1
    next
  }
  { print }
' "${CHANGELOG}" > "${CHANGELOG}.tmp"
mv "${CHANGELOG}.tmp" "${CHANGELOG}"

# ─── Summary ──────────────────────────────────────────────────────────────────

echo
echo "==> Updated:"
printf "  %-32s %s -> %s\n" "src-tauri/Cargo.toml"       "${OLD}" "${NEW}"
printf "  %-32s %s -> %s\n" "package.json"               "${OLD}" "${NEW}"
printf "  %-32s %s -> %s\n" "src-tauri/tauri.conf.json"  "${OLD}" "${NEW}"
printf "  %-32s + ## [%s] - %s\n" "CHANGELOG.md" "${NEW}" "${TODAY}"

echo
echo "==> Next steps:"
echo "    1. Edit CHANGELOG.md to describe the v${NEW} release."
echo "    2. Run 'just release-check' to validate every gate."
echo "    3. Commit: git commit -am 'release: v${NEW}'"
echo "    4. Tag:    git tag -a v${NEW} -m 'v${NEW}' && git push --follow-tags"
