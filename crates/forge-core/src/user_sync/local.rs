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
    load_checked(path).unwrap_or_default()
}

/// The file's contents (empty when there is none); an error for one that does not parse, which
/// is then never written over.
fn load_checked(path: &Path) -> Result<LocalState> {
    match std::fs::read_to_string(path) {
        Ok(raw) => toml::from_str(&raw)
            .map_err(|_| Error::Config(format!("{} does not parse", path.display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(LocalState::default()),
        Err(e) => Err(Error::Io(format!("reading {}: {e}", path.display()))),
    }
}

/// Run `f` on the file's contents under its lock, then save them when they changed.
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
    let mut state = load_checked(path)?;
    let serialize = |s: &LocalState| {
        toml::to_string_pretty(s)
            .map_err(|e| Error::Config(format!("serializing user-sync.toml: {e}")))
    };
    let before = serialize(&state)?;
    let out = f(&mut state);
    let raw = serialize(&state)?;
    if raw != before {
        crate::keystore::write_private_file(path, raw.as_bytes())?;
    }
    drop(lock);
    Ok(out)
}

fn account(network: &str, identity: &str) -> String {
    format!("{network}/{identity}")
}

fn valid_device(d: &str) -> bool {
    d.len() == 6 && d.bytes().all(|b| b.is_ascii_hexdigit())
}

fn new_device() -> String {
    let mut b = [0u8; 3];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut b);
    hex::encode(b)
}

/// This computer's short id, made (and saved) on first use (`<name>-<device>` keeps a clashing
/// profile). A file that cannot be written still gets an id for this run.
pub fn device() -> String {
    update(|s| {
        if !valid_device(&s.device) {
            s.device = new_device();
        }
        s.device.clone()
    })
    .unwrap_or_else(|_| {
        let held = path().map(|p| load(&p).device).unwrap_or_default();
        if valid_device(&held) {
            held
        } else {
            new_device()
        }
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
    fn nothing_changed_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("user-sync.toml");
        update_at(&path, |_| ()).unwrap();
        assert!(!path.exists());
        assert!(note_once_at(&path, "x"));
        let raw = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, format!("{raw}\n# kept\n")).unwrap();
        assert!(!note_once_at(&path, "x"));
        assert!(std::fs::read_to_string(&path)
            .unwrap()
            .ends_with("# kept\n"));
    }

    #[test]
    fn a_file_that_does_not_parse_is_never_written_over() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("user-sync.toml");
        std::fs::write(&path, "device = [not toml").unwrap();
        assert!(!note_once_at(&path, "x"));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "device = [not toml"
        );
    }

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
