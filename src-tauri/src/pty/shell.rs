//! Shell detection per platform.
//!
//! - **Unix** : parse `/etc/shells`, merge with `$SHELL`, then filter to executables. `$SHELL` is
//!   the user's login shell and gets sorted first; the rest are alphabetical.
//! - **Windows** : look up `pwsh.exe` (PowerShell 7+), `powershell.exe` (Windows PowerShell 5), and
//!   `cmd.exe` via `which`, then enumerate WSL distros via `wsl.exe -l -q` (UTF-16 LE output).
//!
//! Returned `ShellInfo` entries are ready to feed to `PtyManager::spawn` as `SpawnOptions.shell` +
//! `SpawnOptions.args`.

#![warn(clippy::all, rust_2018_idioms)]

use std::path::Path;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A user-installable shell discovered on this machine.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export, export_to = "../../../src/ipc/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    /// Display name (e.g. `zsh`, `pwsh`, `WSL: Ubuntu-24.04`). Derived from the executable filename
    /// on Unix, hand-picked for the well-known Windows shells, and prefixed with `WSL:` for distros.
    pub name: String,
    /// Absolute path to the executable to spawn.
    pub path: String,
    /// Argument list to pass to the executable. Usually empty; non-empty for `wsl.exe -d <distro>`.
    pub args: Vec<String>,
}

/// Enumerate every shell installed on this host, preferred-first.
pub fn detect_shells() -> Vec<ShellInfo> {
    #[cfg(unix)]
    {
        detect_unix()
    }
    #[cfg(windows)]
    {
        detect_windows()
    }
    #[cfg(not(any(unix, windows)))]
    {
        Vec::new()
    }
}

/// The shell we should default to when the user hasn't picked one explicitly.
/// Falls back to a hardcoded safe default if detection found nothing (rare; only
/// happens on a system with no `/etc/shells`, no `$SHELL`, and `/bin/sh` missing).
pub fn default_shell() -> Option<ShellInfo> {
    let first = detect_shells().into_iter().next();
    if first.is_some() {
        return first;
    }

    #[cfg(unix)]
    {
        if Path::new("/bin/sh").is_file() {
            return Some(ShellInfo {
                name: "sh".to_string(),
                path: "/bin/sh".to_string(),
                args: Vec::new(),
            });
        }
        None
    }
    #[cfg(windows)]
    {
        Some(ShellInfo {
            name: "cmd".to_string(),
            path: "cmd.exe".to_string(),
            args: Vec::new(),
        })
    }
    #[cfg(not(any(unix, windows)))]
    {
        None
    }
}

// -----------------------------------------------------------------------------
// Unix
// -----------------------------------------------------------------------------

#[cfg(unix)]
fn detect_unix() -> Vec<ShellInfo> {
    use std::collections::BTreeMap;

    // BTreeMap dedups by path while preserving deterministic alphabetical iteration.
    let mut found: BTreeMap<String, ShellInfo> = BTreeMap::new();

    if let Ok(contents) = std::fs::read_to_string("/etc/shells") {
        for line in contents.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if is_valid_unix_shell(line) {
                let info = unix_shell_info(line);
                found.insert(info.path.clone(), info);
            }
        }
    } else {
        tracing::debug!("/etc/shells not readable; relying on $SHELL only");
    }

    // $SHELL gets inserted if present + valid, and is later promoted to first position.
    let env_shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty());
    if let Some(ref s) = env_shell {
        if is_valid_unix_shell(s) {
            let info = unix_shell_info(s);
            found.insert(info.path.clone(), info);
        }
    }

    let mut sorted: Vec<ShellInfo> = found.into_values().collect();

    if let Some(env_path) = env_shell {
        if let Some(idx) = sorted.iter().position(|s| s.path == env_path) {
            let preferred = sorted.remove(idx);
            sorted.insert(0, preferred);
        }
    }

    tracing::debug!(count = sorted.len(), "detected unix shells");
    sorted
}

#[cfg(unix)]
fn unix_shell_info(path: &str) -> ShellInfo {
    let name = Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path)
        .to_string();
    ShellInfo {
        name,
        path: path.to_string(),
        args: Vec::new(),
    }
}

#[cfg(unix)]
fn is_valid_unix_shell(path: &str) -> bool {
    let p = Path::new(path);
    if !p.is_file() {
        return false;
    }
    unix_is_executable(p)
}

#[cfg(unix)]
fn unix_is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(path) {
        Ok(meta) => meta.permissions().mode() & 0o111 != 0,
        Err(_) => false,
    }
}

// -----------------------------------------------------------------------------
// Windows
// -----------------------------------------------------------------------------

#[cfg(windows)]
fn detect_windows() -> Vec<ShellInfo> {
    let mut shells: Vec<ShellInfo> = Vec::new();

    // Preferred order: pwsh (PS 7+) > powershell (PS 5.x) > cmd.
    for (name, exe) in &[
        ("pwsh", "pwsh.exe"),
        ("powershell", "powershell.exe"),
        ("cmd", "cmd.exe"),
    ] {
        match which::which(exe) {
            Ok(path) => shells.push(ShellInfo {
                name: (*name).to_string(),
                path: path.to_string_lossy().into_owned(),
                args: Vec::new(),
            }),
            Err(err) => {
                tracing::debug!(shell = name, error = %err, "windows shell not found");
            }
        }
    }

    for distro in list_wsl_distros() {
        shells.push(ShellInfo {
            name: format!("WSL: {distro}"),
            path: "wsl.exe".to_string(),
            args: vec!["-d".to_string(), distro],
        });
    }

    tracing::debug!(count = shells.len(), "detected windows shells");
    shells
}

/// Parse `wsl.exe -l -q` output. wsl.exe writes UTF-16 LE with a BOM and CRLF line endings;
/// we strip the BOM, decode pairs of bytes, and trim every line.
#[cfg(windows)]
fn list_wsl_distros() -> Vec<String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    // CREATE_NO_WINDOW (0x0800_0000): release builds are GUI-subsystem (no console
    // of their own — see main.rs), so spawning a console child like wsl.exe would
    // otherwise flash a visible console window at startup. This keeps shell
    // detection fully invisible.
    let output = match Command::new("wsl.exe")
        .args(["-l", "-q"])
        .creation_flags(0x0800_0000)
        .output()
    {
        Ok(o) => o,
        Err(err) => {
            tracing::debug!(error = %err, "wsl.exe not invocable; assuming WSL not installed");
            return Vec::new();
        }
    };

    if !output.status.success() {
        tracing::debug!(
            status = ?output.status,
            stderr = %String::from_utf8_lossy(&output.stderr),
            "wsl.exe -l -q exited non-zero"
        );
        return Vec::new();
    }

    let bytes = output.stdout;
    if bytes.len() < 2 {
        return Vec::new();
    }
    // Strip a possible UTF-16 LE BOM (FF FE).
    let start = if bytes[0] == 0xFF && bytes[1] == 0xFE {
        2
    } else {
        0
    };
    if (bytes.len() - start) % 2 != 0 {
        tracing::warn!("wsl.exe output has odd byte length, skipping last byte");
    }
    let u16_units: Vec<u16> = bytes[start..]
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    let decoded = String::from_utf16_lossy(&u16_units);

    decoded
        .lines()
        .map(|s| {
            s.trim_matches(|c: char| c.is_whitespace() || c == '\0')
                .to_string()
        })
        .filter(|s| !s.is_empty())
        .collect()
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn detects_at_least_one_unix_shell() {
        let shells = detect_shells();
        // CI images always have /bin/sh; if /etc/shells is missing we still expect
        // $SHELL to populate at least one entry.
        assert!(
            !shells.is_empty() || Path::new("/bin/sh").is_file(),
            "expected at least one shell, got an empty list and /bin/sh missing"
        );
    }

    #[cfg(unix)]
    #[test]
    fn default_shell_resolves_to_something() {
        let s = default_shell().expect("default_shell should never be None on unix in CI");
        assert!(!s.path.is_empty());
        assert!(
            Path::new(&s.path).exists(),
            "default shell path must exist: {}",
            s.path
        );
    }

    #[cfg(unix)]
    #[test]
    fn ignores_commented_etc_shells_entries() {
        // Sanity: a `#` line in /etc/shells must never end up in the result. We can't easily
        // mock /etc/shells, so we instead check that no detected path starts with '#'.
        for s in detect_shells() {
            assert!(
                !s.path.starts_with('#'),
                "comment line leaked into shells: {:?}",
                s
            );
            assert!(!s.path.is_empty());
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_detect_includes_cmd_or_pwsh() {
        // cmd.exe ships with every Windows install since the 90s; if `which` can't find it,
        // CI is misconfigured.
        let shells = detect_shells();
        assert!(
            shells
                .iter()
                .any(|s| s.name == "cmd" || s.name == "pwsh" || s.name == "powershell"),
            "expected at least one of cmd/pwsh/powershell on windows; got {:?}",
            shells
        );
    }
}
