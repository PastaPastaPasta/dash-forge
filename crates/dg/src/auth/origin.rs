//! Where this computer's key came from, for `dg auth status`: a wallet grant, the recovery
//! phrase, an identity file, a `dfk1` key, or the OS keychain (a key an older dg stored there).
//!
//! `key-origins.toml` beside `config.toml` records how dg got the key it stored last (`dg auth
//! new`, `dg auth login`, `dg auth keys add`). Nothing secret: per `<network>/<identity>`, the
//! key id and its origin. A wallet grant is also recorded in `app-connect.toml`
//! ([`super::wallet`]). A key with no record is named by where it is kept.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// How a key reached this computer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KeyOrigin {
    /// A DashPay wallet granted it (App Connect).
    Wallet,
    /// dg registered it with the master key the recovery phrase derives.
    Phrase,
    /// dg registered it with an identity file's master key, or the file holds it.
    File,
    /// An inline `dfk1:` key (DASH_FORGE_KEY).
    Dfk1,
    /// The OS keychain holds it, and dg did not record how it got there.
    Keychain,
}

impl KeyOrigin {
    /// The `keyOrigin` JSON value.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Wallet => "wallet",
            Self::Phrase => "phrase",
            Self::File => "file",
            Self::Dfk1 => "dfk1",
            Self::Keychain => "keychain",
        }
    }

    /// The status's `Origin:` line.
    pub(crate) fn describe(self) -> &'static str {
        match self {
            Self::Wallet => "your DashPay wallet (App Connect)",
            Self::Phrase => "registered with your recovery phrase",
            Self::File => "an identity file",
            Self::Dfk1 => "a dfk1 key (DASH_FORGE_KEY)",
            Self::Keychain => "the OS keychain (stored by an earlier dg)",
        }
    }

    /// A recorded `keyOrigin` value; `None` for one this dg does not know (a newer dg's).
    fn parse(s: &str) -> Option<Self> {
        [
            Self::Wallet,
            Self::Phrase,
            Self::File,
            Self::Dfk1,
            Self::Keychain,
        ]
        .into_iter()
        .find(|o| o.as_str() == s)
    }

    /// The origin of a key with no record, from the kind of source it is read from
    /// ([`super::store::describe_source`]): an inline `dfk1`, the keychain, or an identity file.
    /// `None` for a key file dg wrote itself (sealed or not), whose origin only the record knows,
    /// and for a pasted key.
    pub(crate) fn from_storage(kind: &str) -> Option<Self> {
        match kind {
            "inline" => Some(Self::Dfk1),
            "keychain" => Some(Self::Keychain),
            "identity-file" => Some(Self::File),
            _ => None,
        }
    }
}

/// One identity's record. The origin is kept as text, so a value a newer dg writes is skipped
/// here instead of making the whole file unreadable (and dropped at the next write).
#[derive(Debug, Serialize, Deserialize)]
struct Recorded {
    key_id: u32,
    origin: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Origins {
    #[serde(default)]
    keys: BTreeMap<String, Recorded>,
}

fn path() -> Result<PathBuf> {
    Ok(crate::config::config_dir()?.join("key-origins.toml"))
}

fn name(network: &str, identity_id: &str) -> String {
    format!("{network}/{identity_id}")
}

fn load(path: &Path) -> Origins {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| toml::from_str(&raw).ok())
        .unwrap_or_default()
}

fn record_at(
    path: &Path,
    network: &str,
    identity_id: &str,
    key_id: u32,
    origin: KeyOrigin,
) -> Result<()> {
    let _lock = super::wallet::lock_state(path)?;
    let mut origins = load(path);
    origins.keys.insert(
        name(network, identity_id),
        Recorded {
            key_id,
            origin: origin.as_str().to_string(),
        },
    );
    let raw = toml::to_string_pretty(&origins).context("serializing the key origins")?;
    forge_core::keystore::write_private_file(path, raw.as_bytes())
        .with_context(|| format!("writing {}", path.display()))
}

fn recorded_at(
    path: &Path,
    network: &str,
    identity_id: &str,
    key_id: Option<u32>,
) -> Option<KeyOrigin> {
    load(path)
        .keys
        .get(&name(network, identity_id))
        .filter(|r| key_id.is_none_or(|id| r.key_id == id))
        .and_then(|r| KeyOrigin::parse(&r.origin))
}

/// Record that dg stored `key_id` of `identity_id` from `origin`. A failure is a note, not an
/// error: the key is stored, and `dg auth status` then names it by where it is kept.
pub(crate) fn record(
    ctx: &crate::context::Ctx,
    network: &str,
    identity_id: &str,
    key_id: u32,
    origin: KeyOrigin,
) {
    if let Err(e) = path().and_then(|p| record_at(&p, network, identity_id, key_id, origin)) {
        if !ctx.json {
            eprintln!("note: `dg auth status` will not know where key #{key_id} came from ({e:#})");
        }
    }
}

/// The recorded origin of `key_id`, when it is the key recorded for the identity; with no key
/// id (a sealed key not opened in this run), the origin of the key recorded for the identity.
pub(crate) fn recorded(network: &str, identity_id: &str, key_id: Option<u32>) -> Option<KeyOrigin> {
    recorded_at(&path().ok()?, network, identity_id, key_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_recorded_origin_is_read_back_for_its_key_only() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("key-origins.toml");
        assert_eq!(recorded_at(&p, "testnet", "Id1", Some(6)), None);
        record_at(&p, "testnet", "Id1", 6, KeyOrigin::Phrase).unwrap();
        record_at(&p, "testnet", "Id2", 3, KeyOrigin::File).unwrap();
        assert_eq!(
            recorded_at(&p, "testnet", "Id1", Some(6)),
            Some(KeyOrigin::Phrase)
        );
        assert_eq!(recorded_at(&p, "testnet", "Id1", Some(7)), None);
        assert_eq!(
            recorded_at(&p, "testnet", "Id1", None),
            Some(KeyOrigin::Phrase)
        );
        assert_eq!(recorded_at(&p, "devnet-sakura", "Id1", Some(6)), None);
        assert_eq!(
            recorded_at(&p, "testnet", "Id2", Some(3)),
            Some(KeyOrigin::File)
        );
        record_at(&p, "testnet", "Id1", 7, KeyOrigin::File).unwrap();
        assert_eq!(recorded_at(&p, "testnet", "Id1", Some(6)), None);
        assert_eq!(
            recorded_at(&p, "testnet", "Id1", Some(7)),
            Some(KeyOrigin::File)
        );
        record_at(&p, "testnet", "Id1", 8, KeyOrigin::Wallet).unwrap();
        assert_eq!(
            recorded_at(&p, "testnet", "Id1", None),
            Some(KeyOrigin::Wallet)
        );
        std::fs::write(&p, "not toml [").unwrap();
        assert_eq!(recorded_at(&p, "testnet", "Id1", Some(7)), None);
    }

    /// A value a newer dg recorded is skipped for its identity only, and survives a write.
    #[test]
    fn an_unknown_origin_keeps_the_other_records() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("key-origins.toml");
        std::fs::write(
            &p,
            "[keys.\"testnet/Id1\"]\nkey_id = 4\norigin = \"hardware\"\n\n[keys.\"testnet/Id2\"]\nkey_id = 3\norigin = \"phrase\"\n",
        )
        .unwrap();
        assert_eq!(recorded_at(&p, "testnet", "Id1", Some(4)), None);
        assert_eq!(
            recorded_at(&p, "testnet", "Id2", Some(3)),
            Some(KeyOrigin::Phrase)
        );
        record_at(&p, "testnet", "Id3", 6, KeyOrigin::Wallet).unwrap();
        let raw = std::fs::read_to_string(&p).unwrap();
        assert!(raw.contains("hardware"), "{raw}");
        assert_eq!(
            recorded_at(&p, "testnet", "Id2", Some(3)),
            Some(KeyOrigin::Phrase)
        );
    }

    #[test]
    fn an_unrecorded_key_is_named_by_where_it_is_kept() {
        assert_eq!(KeyOrigin::from_storage("inline"), Some(KeyOrigin::Dfk1));
        assert_eq!(
            KeyOrigin::from_storage("keychain"),
            Some(KeyOrigin::Keychain)
        );
        assert_eq!(
            KeyOrigin::from_storage("identity-file"),
            Some(KeyOrigin::File)
        );
        assert_eq!(KeyOrigin::from_storage("sealed-file"), None);
        assert_eq!(KeyOrigin::from_storage("plaintext-file"), None);
        assert_eq!(KeyOrigin::from_storage("pasted"), None);
        for o in [
            KeyOrigin::Wallet,
            KeyOrigin::Phrase,
            KeyOrigin::File,
            KeyOrigin::Dfk1,
            KeyOrigin::Keychain,
        ] {
            assert_eq!(KeyOrigin::parse(o.as_str()), Some(o));
        }
    }
}
