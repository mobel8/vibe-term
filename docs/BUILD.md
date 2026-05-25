# Build from source

`vibe-term` builds on Ubuntu/Debian, Fedora, Arch, macOS 13+, and Windows
10 (22H2) / 11. The same `pnpm tauri:dev` / `pnpm tauri:build` commands work
on every host — the only differences are the system packages you need
beforehand.

> If you only want to **run** the app, grab a pre-built binary from
> [GitHub Releases](https://github.com/mobel8/vibe-term/releases) (when v0.1
> ships).

---

## 1. Toolchain prerequisites (all OSes)

| Tool | Minimum version | Notes |
|---|---|---|
| Rust | **1.77** (stable) | `rustup install stable` then `rustup default stable` |
| Node.js | **22.13** | exact: pinned in `package.json#engines.node` |
| pnpm | **11.3.0** | declared in `package.json#packageManager`; install once with `corepack enable && corepack prepare pnpm@11.3.0 --activate` |
| Git | any recent | for fetching submodules / hooks |

Verify with:

```bash
rustc --version          # rustc 1.77.x (or newer)
node --version           # v22.13.x
pnpm --version           # 11.3.0
```

If `pnpm` is missing, the simplest install is via Corepack (bundled with
Node):

```bash
corepack enable
corepack prepare pnpm@11.3.0 --activate
```

---

## 2. Linux

### 2.1 Ubuntu 22.04 / 24.04 / Xubuntu

There is a convenience script:

```bash
./scripts/setup-linux.sh
```

It installs the same packages CI uses:

```bash
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libxdo-dev \
  libssl-dev \
  libglib2.0-dev \
  libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev \
  pkg-config \
  build-essential \
  curl wget file patchelf
```

Optional but recommended:

```bash
sudo apt-get install -y wl-clipboard   # better Wayland paste, used as fallback
```

### 2.2 Fedora 40+

```bash
sudo dnf install -y \
  webkit2gtk4.1-devel \
  gtk3-devel \
  libayatana-appindicator-gtk3-devel \
  librsvg2-devel \
  libxdo-devel \
  openssl-devel \
  glib2-devel \
  libsoup3-devel \
  javascriptcoregtk4.1-devel \
  pkgconf-pkg-config \
  @"C Development Tools and Libraries" \
  patchelf curl wget
sudo dnf install -y wl-clipboard      # optional
```

### 2.3 Arch / Manjaro

```bash
sudo pacman -S --needed \
  webkit2gtk-4.1 \
  gtk3 \
  libayatana-appindicator \
  librsvg \
  xdotool \
  openssl \
  glib2 \
  libsoup3 \
  base-devel \
  pkgconf \
  patchelf curl wget file
sudo pacman -S --needed wl-clipboard  # optional
```

### 2.4 Other distros

You need: GTK 3, WebKitGTK 4.1, libsoup 3, libayatana-appindicator,
librsvg, libxdo, OpenSSL, pkg-config, a C toolchain, and `patchelf`. The
Tauri docs maintain a [per-distro list](https://v2.tauri.app/start/prerequisites/).

---

## 3. macOS (Sonoma 14+ / Sequoia 15)

```bash
xcode-select --install     # Apple Command Line Tools (clang + Make)
```

That's it. Tauri 2 needs no extra Homebrew packages on a clean macOS
install. If you want OCR models pre-fetched:

```bash
./scripts/fetch-ocr-models.sh    # downloads ~50 MB into ~/.cache/vibe-term/models/
```

> macOS 12 (Monterey) and earlier are not supported — Tauri 2 requires the
> WebKit version that ships with 13+.

---

## 4. Windows 10 (22H2+) / Windows 11

You need two things:

1. **WebView2 Runtime.** Ships with Windows 11 by default. On Windows 10,
   download from [Microsoft](https://developer.microsoft.com/microsoft-edge/webview2/)
   and install the **Evergreen Bootstrapper**.
2. **Visual Studio C++ Build Tools** — at minimum the workload "Desktop
   development with C++" (gives you MSVC, the Windows SDK, and CMake).
   Download from [visualstudio.microsoft.com/downloads/](https://visualstudio.microsoft.com/downloads/)
   and pick *Build Tools for Visual Studio*.

In an Administrator PowerShell:

```powershell
# Install pnpm if you don't have it
corepack enable
corepack prepare pnpm@11.3.0 --activate
```

If you plan to build WSL distros from the shell list, install at least one
WSL distribution (`wsl --install -d Ubuntu-24.04`).

---

## 5. Cloning and running

```bash
git clone https://github.com/mobel8/vibe-term.git
cd vibe-term
pnpm install
pnpm tauri:dev
```

The first build takes 5–10 minutes (Rust crate graph cold-compile) — the
console will scroll a lot. Subsequent builds are sub-30-seconds thanks to
the workspace cache.

A native window appears once Vite is ready and Rust has linked the binary.
DevTools open with `Ctrl+Shift+I` (Windows / Linux) or `Cmd+Option+I` (macOS).

---

## 6. Building a release bundle

```bash
pnpm tauri:build
```

Artefacts land in:

```
src-tauri/target/release/bundle/
├── appimage/  vibe-term_<version>_amd64.AppImage      # Linux portable
├── deb/       vibe-term_<version>_amd64.deb           # Debian / Ubuntu
├── rpm/       vibe-term-<version>-1.x86_64.rpm        # Fedora / RHEL
├── dmg/       vibe-term_<version>_aarch64.dmg         # macOS (arm64)
│              vibe-term_<version>_x64.dmg             # macOS (Intel)
├── msi/       vibe-term_<version>_x64_en-US.msi       # Windows MSI
└── nsis/      vibe-term_<version>_x64-setup.exe       # Windows NSIS installer
```

Bundles are unsigned (no notarisation / SmartScreen reputation). See
[TROUBLESHOOTING.md](./TROUBLESHOOTING.md#1-macos-gatekeeper-blocks-first-launch)
for the Gatekeeper / SmartScreen first-launch dance.

---

## 7. Cross-compiling

CI builds four targets in parallel (see `.github/workflows/build.yml`):

| Target triple | Runner |
|---|---|
| `x86_64-unknown-linux-gnu` | `ubuntu-24.04` |
| `aarch64-apple-darwin` | `macos-14` |
| `x86_64-apple-darwin` | `macos-13` |
| `x86_64-pc-windows-msvc` | `windows-2022` |

Local cross-compilation between OS families is intentionally not supported
(Tauri 2 bundler relies on per-OS tooling). Use the CI matrix on a feature
branch instead.

---

## 8. Running tests

```bash
# Frontend
pnpm typecheck
pnpm lint
pnpm test

# Backend
cd src-tauri
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
```

CI runs the same set; `cargo clippy` is enforced with `-D warnings`, so a
single warning fails the build.

---

## 9. Common build failures

See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for runtime issues. The most
frequent **build** issues:

| Error | Cause | Fix |
|---|---|---|
| `error: failed to run custom build command for openssl-sys` | Linux: missing `libssl-dev` | install via the OS section above |
| `linker 'cc' not found` | missing `build-essential` / `Xcode CLI` / MSVC | run the platform's setup step |
| `error[E0463]: can't find crate for std` for `aarch64-apple-darwin` | missing rustup target | `rustup target add aarch64-apple-darwin` |
| `pnpm install` says `WARN  Unsupported engine` | Node < 22.13 | update Node, or `nvm install 22 && nvm use 22` |
| `error: pkg-config exited with status code 1` on `glib-2.0` | Linux: missing `libglib2.0-dev` | install via the OS section above |
| `cargo build` reuses cached artifacts after a Rust toolchain bump | stale `target/` directory | `cargo clean` inside `src-tauri/` |
| `webkit2gtk-4.1.pc not found` | Ubuntu 22.04 with WebKitGTK 4.0 only | add the Tauri PPA *or* upgrade to 24.04 |
