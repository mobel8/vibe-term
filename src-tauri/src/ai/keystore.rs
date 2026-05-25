//! API key storage with OS-native secret store + obfuscated fallback file.
//!
//! ## Strategy
//!
//! 1. **Primary**: `keyring` crate (Keychain on macOS, Credential Manager on
//!    Windows, Secret Service / libsecret on Linux desktops).
//! 2. **Fallback**: `~/.config/vibe-term/secrets.bin` XOR-obfuscated with a
//!    machine-derived key. This is **obfuscation, not encryption** — anyone
//!    with FS access to the user's account can recover the key. We log a
//!    `WARN` so operators on headless Linux / WSL see they should install
//!    `libsecret-1-0` / `gnome-keyring` for real security.
//!
//! The fallback exists because keyring fails hard on headless Linux and on
//! certain WSL setups where no D-Bus session bus is reachable.
//!
//! ## Logging
//!
//! We **never** log the API key value. The `redact_key` helper emits a
//! `sk-ant-xxxx...••••` preview that is safe to put into traces.

#![warn(clippy::all, rust_2018_idioms)]

use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::OnceLock;

use sha2::{Digest, Sha256};

use crate::error::AppError;

/// `keyring` service name. Stable, used as the row key on every backend.
const SERVICE: &str = "vibe-term";
/// `keyring` user/account name — single-account product, fixed string.
const ACCOUNT: &str = "anthropic_api_key";
/// Filename for the obfuscated fallback blob.
const FALLBACK_FILENAME: &str = "secrets.bin";
/// Magic header used for the fallback file format (1 byte version + 4 byte
/// magic). Lets us evolve the format without orphaning user files.
const FALLBACK_MAGIC: &[u8; 5] = b"\x01VTK1";

/// Cached decision: should we use the OS keystore or the fallback file?
/// Resolved on first use, then sticky for process lifetime.
static USE_FALLBACK: OnceLock<bool> = OnceLock::new();

/// Return `true` if the OS keyring backend appears unusable on this machine.
///
/// We attempt a benign `get_password` against a probe entry — if it returns
/// `Ok(_)` or `NoEntry` the backend is alive. Anything else (e.g. D-Bus not
/// running, libsecret missing) means we fall back.
fn detect_fallback() -> bool {
    match keyring::Entry::new(SERVICE, "__probe__") {
        Ok(entry) => match entry.get_password() {
            Ok(_) => false,
            Err(keyring::Error::NoEntry) => false,
            Err(err) => {
                tracing::warn!(
                    "keystore: OS keyring unavailable ({err}); using obfuscated fallback file. \
                     Install libsecret/gnome-keyring (Linux) for real security."
                );
                true
            }
        },
        Err(err) => {
            tracing::warn!(
                "keystore: failed to create keyring entry ({err}); using obfuscated fallback file."
            );
            true
        }
    }
}

fn use_fallback() -> bool {
    *USE_FALLBACK.get_or_init(detect_fallback)
}

/// Persist the Anthropic API key. Overwrites any existing value silently.
pub fn store_api_key(key: &str) -> Result<(), AppError> {
    if key.is_empty() {
        return Err(AppError::InvalidInput("api key is empty".into()));
    }
    if use_fallback() {
        write_fallback(key)?;
    } else {
        let entry = keyring::Entry::new(SERVICE, ACCOUNT)
            .map_err(|e| AppError::other(format!("keyring entry: {e}")))?;
        entry
            .set_password(key)
            .map_err(|e| AppError::other(format!("keyring set: {e}")))?;
    }
    tracing::info!("keystore: key stored ({})", redact_key(key));
    Ok(())
}

/// Load the API key if present. `Ok(None)` means "no key configured yet".
pub fn load_api_key() -> Result<Option<String>, AppError> {
    if use_fallback() {
        return read_fallback();
    }
    let entry = keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(|e| AppError::other(format!("keyring entry: {e}")))?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(AppError::other(format!("keyring get: {err}"))),
    }
}

/// Remove the stored key. No-op if there is no key.
pub fn delete_api_key() -> Result<(), AppError> {
    if use_fallback() {
        let path = fallback_path()?;
        if path.exists() {
            fs::remove_file(&path)?;
        }
        return Ok(());
    }
    let entry = keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(|e| AppError::other(format!("keyring entry: {e}")))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(AppError::other(format!("keyring delete: {err}"))),
    }
}

/// Produce a safe preview (`sk-ant-abcd...••••`) of a secret for logs.
pub fn redact_key(key: &str) -> String {
    if key.len() <= 12 {
        return "(redacted)".to_string();
    }
    let prefix = &key[..12.min(key.len())];
    format!("{prefix}...••••")
}

// ---- Fallback file storage ----------------------------------------------

fn fallback_path() -> Result<PathBuf, AppError> {
    let mut dir =
        dirs::config_dir().ok_or_else(|| AppError::other("could not resolve user config dir"))?;
    dir.push("vibe-term");
    fs::create_dir_all(&dir)?;
    dir.push(FALLBACK_FILENAME);
    Ok(dir)
}

/// Build a 32-byte key derived from `username + hostname + service`. This is
/// stable across runs for the same user on the same machine. It is **not**
/// cryptographic — its sole purpose is to make a casually-grepping attacker's
/// life a little less easy.
fn obfuscation_key() -> [u8; 32] {
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "unknown".into());
    let host = hostname_best_effort();
    let mut hasher = Sha256::new();
    hasher.update(SERVICE.as_bytes());
    hasher.update(b":");
    hasher.update(user.as_bytes());
    hasher.update(b"@");
    hasher.update(host.as_bytes());
    let out = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&out);
    key
}

fn hostname_best_effort() -> String {
    // Avoid pulling in a `gethostname` crate; rely on env + uname fallback.
    if let Ok(h) = std::env::var("HOSTNAME") {
        if !h.is_empty() {
            return h;
        }
    }
    if let Ok(h) = std::env::var("COMPUTERNAME") {
        if !h.is_empty() {
            return h;
        }
    }
    // Final fallback: read /etc/hostname on Unix, ignore failures.
    fs::read_to_string("/etc/hostname")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "localhost".into())
}

fn xor_inplace(buf: &mut [u8], key: &[u8; 32]) {
    for (i, byte) in buf.iter_mut().enumerate() {
        *byte ^= key[i % key.len()];
    }
}

fn write_fallback(key: &str) -> Result<(), AppError> {
    let path = fallback_path()?;
    let mut bytes = key.as_bytes().to_vec();
    xor_inplace(&mut bytes, &obfuscation_key());

    let tmp = path.with_extension("bin.tmp");
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(FALLBACK_MAGIC)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    // Tighten permissions on Unix — best-effort; ignore on Windows.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(0o600);
        let _ = fs::set_permissions(&tmp, perms);
    }
    fs::rename(&tmp, &path)?;
    Ok(())
}

fn read_fallback() -> Result<Option<String>, AppError> {
    let path = fallback_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let mut file = fs::File::open(&path)?;
    let mut header = [0u8; FALLBACK_MAGIC.len()];
    if file.read_exact(&mut header).is_err() {
        return Err(AppError::other("fallback secrets file is truncated"));
    }
    if &header != FALLBACK_MAGIC {
        return Err(AppError::other(
            "fallback secrets file has unknown magic; refusing to read",
        ));
    }
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;
    xor_inplace(&mut buf, &obfuscation_key());
    let value = String::from_utf8(buf)
        .map_err(|e| AppError::other(format!("fallback secrets utf8: {e}")))?;
    Ok(Some(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_long_keys() {
        let redacted = redact_key("sk-ant-api03-abcdefghij1234567890");
        assert!(redacted.starts_with("sk-ant-api03"));
        assert!(redacted.ends_with("••••"));
        assert!(!redacted.contains("abcdefghij"));
    }

    #[test]
    fn redacts_short_keys() {
        assert_eq!(redact_key("short"), "(redacted)");
    }

    #[test]
    fn xor_roundtrip() {
        let key = [0x42u8; 32];
        let original = b"hello world".to_vec();
        let mut buf = original.clone();
        xor_inplace(&mut buf, &key);
        assert_ne!(buf, original);
        xor_inplace(&mut buf, &key);
        assert_eq!(buf, original);
    }
}
