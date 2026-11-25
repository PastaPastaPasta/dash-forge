//! `user-sync.toml` beside config.toml, nothing secret: this computer's short device id, when
//! each identity's first sync was checked, and which one-time notes it has shown. Read and
//! written under `user-sync.lock` by dg and git-remote-dash alike; fields this build does not
//! know are kept.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

#[derive(Debug, Default, Serialize, Deserialize)]
struct LocalState {
    #[serde(default)]
    device: String,
    /// `<network>/<identity>` → ms of the checked first upload.
    #[serde(default)]
    synced: BTreeMap<String, u64>,
    /// A one-time note's key → ms it was shown.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    noted: BTreeMap<String, u64>,
    #[serde(flatten)]
    extra: toml::Table,
}

/// The file's path (`$XDG_CONFIG_HOME/dash-forge/user-sync.toml`).
pub fn path() -> Option<PathBuf> {
    crate::keystore::forge_config_dir().map(|d| d.join("user-sync.toml"))
}

fn load(path: &Path) -> LocalState {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| toml::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Run `f` on the file's contents under its lock, then save them.
fn update<T>(f: impl FnOnce(&mut LocalState) -> T) -> Result<T> {
    let path = path().ok_or_else(|| Error::Config("no config directory".into()))?;
    update_at(&path, f)
}

fn update_at<T>(path: &Path, f: impl FnOnce(&mut LocalState) -> T) -> Result<T> {
    if let Some(dir) = path.parent() {
        crate::keystore::ensure_private_dir(dir)
            .map_err(|e| Error::Io(format!("creating {}: {e}", dir.display())))?;
    }
    let lock = std::fs::File::options()
        .write(true)
        .create(true)
        .truncate(false)
        .open(path.with_extension("lock"))
        .and_then(|f| f.lock().map(|()| f))
        .map_err(|e| Error::Io(format!("locking {}: {e}", path.display())))?;
    let mut state = load(path);
    let out = f(&mut state);
    let raw = toml::to_string_pretty(&state)
        .map_err(|e| Error::Config(format!("serializing user-sync.toml: {e}")))?;
    crate::keystore::write_private_file(path, raw.as_bytes())?;
    drop(lock);
    Ok(out)
}

fn account(network: &str, identity: &str) -> String {
    format!("{network}/{identity}")
}

/// This computer's short id, made on first use (`<name>-<device>` keeps a clashing profile).
pub fn device() -> Result<String> {
    update(|s| {
        if !(s.device.len() == 6 && s.device.bytes().all(|b| b.is_ascii_hexdigit())) {
            let mut b = [0u8; 3];
            rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut b);
            s.device = hex::encode(b);
        }
        s.device.clone()
    })
}

/// When this computer's first upload for `identity` on `network` was checked, if it was.
pub fn synced_at(network: &str, identity: &str) -> Option<u64> {
    load(&path()?)
        .synced
        .get(&account(network, identity))
        .copied()
}

/// Record that the first upload for `identity` on `network` was checked at `at`.
pub fn record_synced(network: &str, identity: &str, at: u64) -> Result<()> {
    update(|s| {
        s.synced.insert(account(network, identity), at);
    })
}

/// Whether the one-time note `what` is to be shown now: `true` the first time on this computer
/// (and records it), `false` after. A file that cannot be written shows nothing.
pub fn note_once(what: &str) -> bool {
    path().is_some_and(|p| note_once_at(&p, what))
}

/// [`note_once`] in the file at `path`.
pub fn note_once_at(path: &Path, what: &str) -> bool {
    update_at(path, |s| {
        if s.noted.contains_key(what) {
            false
        } else {
            s.noted.insert(what.to_string(), super::now_ms());
            true
        }
    })
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_fields_survive_and_a_note_shows_once() {
        let raw = "device = \"a1b2c3\"\nfuture = 7\n\n[synced]\n\"testnet/X\" = 5\n";
        let mut s: LocalState = toml::from_str(raw).unwrap();
        assert_eq!(s.device, "a1b2c3");
        s.noted.insert("k".into(), 1);
        let back: LocalState = toml::from_str(&toml::to_string_pretty(&s).unwrap()).unwrap();
        assert_eq!(
            back.extra.get("future").and_then(toml::Value::as_integer),
            Some(7)
        );
        assert_eq!(back.synced["testnet/X"], 5);
        assert_eq!(back.noted["k"], 1);
        let old: LocalState = toml::from_str("device = \"a1b2c3\"\n").unwrap();
        assert!(old.noted.is_empty());
    }
}
