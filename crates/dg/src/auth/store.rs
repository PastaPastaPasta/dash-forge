//! Where `dg auth` keeps an identity's key (ux-dx-spec §2.4): the OS keychain (service
//! `dash-forge`, account `<network>/<identityId>`), else
//! `~/.config/dash-forge/identities/<network>-<id>.key` sealed under a passphrase, else — only
//! with `--insecure-plaintext` — the same file unencrypted (every later read warns).
//!
//! What is stored is a key *source text*: a `dfk1:` limited key (the default), or the whole
//! bridge identity JSON for `--full-key`. The value recorded as `default_identity` in
//! config.toml is where to find it (`keychain:dash-forge/<network>/<id>` or the file path), so
//! `dg`, `git-remote-dash` and the importer all load it through
//! `BridgeIdentity::load_from_file`.

use std::path::PathBuf;

use anyhow::{Context as _, Result};

use forge_core::keychain;
use forge_core::keystore::{self, Secret};
use forge_core::sealed;

use crate::config::{config_dir, Config};
use crate::context::Ctx;

/// How the key was stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stored {
    /// In the OS keychain.
    Keychain {
        /// The `keychain:` key source.
        source: String,
    },
    /// In a passphrase-sealed file.
    Sealed(PathBuf),
    /// In an unencrypted file (`--insecure-plaintext`).
    Plaintext(PathBuf),
}

impl Stored {
    /// The key source to record as the default identity.
    pub fn source(&self) -> String {
        match self {
            Stored::Keychain { source } => source.clone(),
            Stored::Sealed(p) | Stored::Plaintext(p) => p.to_string_lossy().into_owned(),
        }
    }

    /// Where it is, for people: "macOS Keychain (dash-forge/testnet/5Dtb…)".
    pub fn describe(&self) -> String {
        match self {
            Stored::Keychain { source } => format!(
                "{} ({})",
                keychain::store_name(),
                source.trim_start_matches(keystore::KEYCHAIN_PREFIX)
            ),
            Stored::Sealed(p) => format!("{} (passphrase-encrypted)", p.display()),
            Stored::Plaintext(p) => format!("{} (UNENCRYPTED)", p.display()),
        }
    }

    /// `keychain` / `sealed-file` / `plaintext-file`, for `--json`.
    pub fn kind(&self) -> &'static str {
        match self {
            Stored::Keychain { .. } => "keychain",
            Stored::Sealed(_) => "sealed-file",
            Stored::Plaintext(_) => "plaintext-file",
        }
    }
}

/// Describe an arbitrary key source the same way (for `dg auth status`).
pub fn describe_source(source: &str) -> (String, &'static str) {
    if source.starts_with(keystore::KEYCHAIN_PREFIX) {
        let s = Stored::Keychain {
            source: source.to_string(),
        };
        return (s.describe(), s.kind());
    }
    if source.starts_with(keystore::DFK1_PREFIX) {
        return ("inline dfk1: key (DASH_FORGE_KEY)".into(), "inline");
    }
    let path = PathBuf::from(source);
    let sealed_file = std::fs::read_to_string(&path).is_ok_and(|raw| sealed::is_sealed(&raw));
    if sealed_file {
        let s = Stored::Sealed(path);
        (s.describe(), s.kind())
    } else if path.extension().is_some_and(|e| e == "key") {
        let s = Stored::Plaintext(path);
        (s.describe(), s.kind())
    } else {
        (
            format!("{} (identity file)", path.display()),
            "identity-file",
        )
    }
}

/// The fallback key file for an identity: `identities/<network>-<id>.key`.
fn key_file(network: &str, identity_id: &str) -> Result<PathBuf> {
    Ok(config_dir()?
        .join("identities")
        .join(format!("{network}-{identity_id}.key")))
}

/// Store `text` (a `dfk1:` key or a bridge JSON) for `identity_id` on `network`, preferring
/// the keychain. `insecure_plaintext` allows an unencrypted file when there is no keychain.
pub fn store(
    network: &str,
    identity_id: &str,
    text: &Secret,
    insecure_plaintext: bool,
) -> Result<Stored> {
    if keychain::available() {
        let account = format!("{network}/{identity_id}");
        match keychain::set(keychain::SERVICE, &account, text.expose()) {
            Ok(()) => {
                // Read it back: a store that accepts writes it cannot serve is no store.
                if keychain::get(keychain::SERVICE, &account)?
                    .is_some_and(|v| v.expose() == text.expose())
                {
                    return Ok(Stored::Keychain {
                        source: keystore::keychain_source(network, identity_id),
                    });
                }
                tracing::warn!("the keychain did not return what was written; using a file");
            }
            Err(e) => tracing::warn!("keychain unavailable ({e}); using a file"),
        }
    }
    let path = key_file(network, identity_id)?;
    if insecure_plaintext {
        keystore::write_private_file(&path, text.expose().as_bytes())?;
        return Ok(Stored::Plaintext(path));
    }
    let pass = sealed::passphrase(
        &format!(
            "the key file {} (there is no OS keychain here)",
            path.display()
        ),
        true,
    )
    .context("no OS keychain, so the key is stored in a passphrase-encrypted file; set DASH_FORGE_PASSPHRASE for non-interactive use, or pass --insecure-plaintext")?;
    let sealed_text = sealed::seal(text.expose().as_bytes(), pass.expose())?;
    keystore::write_private_file(&path, sealed_text.as_bytes())?;
    Ok(Stored::Sealed(path))
}

/// Remove what [`store`] wrote for `identity_id` on `network` (keychain entry and key file).
/// Returns what was removed.
pub fn remove(network: &str, identity_id: &str) -> Result<Vec<String>> {
    let mut removed = Vec::new();
    let account = format!("{network}/{identity_id}");
    if keychain::available() && keychain::delete(keychain::SERVICE, &account)? {
        removed.push(format!(
            "{} entry {}/{account}",
            keychain::store_name(),
            keychain::SERVICE
        ));
    }
    let path = key_file(network, identity_id)?;
    if path.exists() {
        std::fs::remove_file(&path).with_context(|| format!("removing {}", path.display()))?;
        removed.push(path.display().to_string());
    }
    Ok(removed)
}

/// Record `source` as the default identity for the context's network (config.toml), with the
/// network settings the next command needs to reconnect.
pub fn set_default(ctx: &Ctx, identity_id: &str, source: &str) -> Result<()> {
    let mut config = Config::load().unwrap_or_default();
    config.network = Some(ctx.network().kind().to_string());
    config.devnet_name = ctx.network().devnet_name().map(str::to_string);
    config.dapi_addresses = super::explicit_dapi_addresses(ctx.network());
    config.default_identity = Some(source.to_string());
    config.default_identity_id = Some(identity_id.to_string());
    config.save()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_sources_and_descriptions() {
        let k = Stored::Keychain {
            source: keystore::keychain_source("testnet", "ID"),
        };
        assert_eq!(k.source(), "keychain:dash-forge/testnet/ID");
        assert!(k.describe().contains("dash-forge/testnet/ID"));
        assert_eq!(k.kind(), "keychain");
        let (d, kind) = describe_source("dfk1:testnet:ID:5:cWIF");
        assert_eq!(kind, "inline");
        assert!(!d.contains("cWIF"));
    }
}
