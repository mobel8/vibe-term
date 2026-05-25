# vibe-term — task runner
#
# `just --list` to see every available recipe. Install just from
# https://just.systems (cargo install just / brew install just / scoop install just).
#
# Keep this file small and idiomatic: each recipe should call into a single
# pnpm script, cargo command, or one of the helper shell scripts under
# `scripts/`. Multi-step logic belongs in a script, not here.

set shell := ["bash", "-cu"]

# ─── Discovery ────────────────────────────────────────────────────────────────

# Default recipe: list everything.
default:
    @just --list

# ─── Day-to-day ───────────────────────────────────────────────────────────────

# Start the full Tauri dev loop (Vite + cargo run).
dev:
    pnpm tauri:dev

# Build the production bundle for the host platform.
build:
    pnpm tauri:build

# Run every check that CI runs, in the order CI runs them.
test:
    pnpm typecheck
    pnpm lint
    pnpm test
    cd src-tauri && cargo fmt --all -- --check
    cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings
    cd src-tauri && cargo test --all-features

# Auto-format every supported source tree (frontend + Rust).
fmt:
    cd src-tauri && cargo fmt --all
    pnpm prettier --write "src/**/*.{ts,tsx,css,md}"

# Lint frontend + Rust without writing anything.
lint:
    pnpm lint
    cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings

# Build the bundle then run the end-to-end suite against it.
e2e:
    pnpm tauri:build
    pnpm test:e2e

# Print an environment snapshot suitable for pasting into a bug report.
doctor:
    @bash scripts/dev-snapshot.sh

# Bump the project version in Cargo.toml + package.json + tauri.conf.json
# and prepend an entry in CHANGELOG.md. Usage: `just bump 0.2.0`.
bump version:
    @bash scripts/version-bump.sh {{version}}

# Run every pre-release check (clean tree, version coherence, tests, …).
release-check:
    @bash scripts/release-precheck.sh
