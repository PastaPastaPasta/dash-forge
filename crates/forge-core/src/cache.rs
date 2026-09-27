//! The on-disk cache under `~/.cache/dash-forge` (`$XDG_CACHE_HOME/dash-forge`).
//!
//! Two things live here, both keyed so that a stale entry can never be read as current:
//!
//! - `contracts/<network>/<contract id>.json`: data contracts (serialized, with their version),
//!   re-validated against the on-chain version at most once per [`CONTRACT_RECHECK`]
//!   ([`crate::platform::PlatformClient::fetch_contract`]).
//! - `history/<network>/<contract id>-v<version>/<repo id>/<type>.jsonl`: the raw rows of the
//!   append-only document types ([`crate::history`]). A contract re-registration (a new id) or an
//!   in-place update (a new version) starts a fresh directory, so a cache written against the old
//!   contract is never read against the new one.
//!
//! Only documents as Platform stores them are cached: a private repository's rows are ciphertext
//! here too, and nothing decrypted is ever written.
//!
//! `DASH_FORGE_NO_CACHE=1` (or `true`, `yes`) turns the disk cache off (every read goes to the network);
//! `DASH_FORGE_CACHE_DIR` moves it. A cache that cannot be read or written costs requests, never
//! a result: every failure falls back to the network.

use std::path::{Path, PathBuf};

/// Disables the disk cache when set to `1`, `true` or `yes`.
pub const NO_CACHE_ENV: &str = "DASH_FORGE_NO_CACHE";
/// Overrides the cache directory.
pub const CACHE_DIR_ENV: &str = "DASH_FORGE_CACHE_DIR";

/// How long a cached contract is used before its version is checked again (one proved
/// `getDataContractsLatestVersions` request).
pub const CONTRACT_RECHECK: std::time::Duration = std::time::Duration::from_hours(1);

/// The cache directory, or `None` when the cache is off or no home is known.
pub fn dir() -> Option<PathBuf> {
    if matches!(
        std::env::var(NO_CACHE_ENV).as_deref(),
        Ok("1" | "true" | "yes")
    ) {
        return None;
    }
    if let Some(d) = std::env::var_os(CACHE_DIR_ENV).filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(d));
    }
    let xdg = std::env::var_os("XDG_CACHE_HOME").filter(|d| !d.is_empty());
    xdg.map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
        .map(|base| base.join("dash-forge"))
}

/// A path component made safe: base58 ids and network keys pass through; anything else is
/// hex-encoded so a name can never climb out of its directory.
pub fn component(s: &str) -> String {
    if !s.is_empty()
        && s.len() <= 100
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
        && s != "."
        && s != ".."
    {
        s.to_string()
    } else {
        format!("x{}", hex::encode(s.as_bytes()))
    }
}

/// Read a cache file; `None` when absent or unreadable.
pub fn read(path: &Path) -> Option<Vec<u8>> {
    std::fs::read(path).ok()
}

/// Write a cache file atomically (a temporary sibling renamed into place), so a reader never
/// sees half a file and two writers leave one complete file. Failures are logged and ignored.
pub fn write(path: &Path, bytes: &[u8]) {
    let result = (|| -> std::io::Result<()> {
        let parent = path
            .parent()
            .ok_or_else(|| std::io::Error::other("no parent"))?;
        std::fs::create_dir_all(parent)?;
        let tmp = parent.join(format!(
            ".{}.{}.tmp",
            path.file_name().and_then(|n| n.to_str()).unwrap_or("cache"),
            std::process::id()
        ));
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, path)
    })();
    if let Err(e) = result {
        tracing::debug!(path = %path.display(), error = %e, "could not write the cache");
    }
}

/// Milliseconds since the epoch (0 before it).
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

#[cfg(test)]
mod tests {
    use super::component;

    #[test]
    fn components_cannot_escape_their_directory() {
        assert_eq!(component("devnet-moutai"), "devnet-moutai");
        assert_eq!(
            component("9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD"),
            "9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD"
        );
        assert!(!component("../etc").contains('/'));
        assert!(!component("..").starts_with('.'));
        assert!(component("").starts_with('x'));
        assert!(!component("a/b").contains('/'));
    }
}
