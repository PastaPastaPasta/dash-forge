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
use forge_core::user_error::{codes, UserError};

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

/// Describe an arbitrary key source the same way (for `dg auth status`). Key material
/// pasted where a path belongs (an identity JSON in `DASH_FORGE_KEY`) is never shown.
pub fn describe_source(source: &str) -> (String, &'static str) {
    if keystore::looks_like_pasted_key(std::path::Path::new(source)) {
        return (
            keystore::describe_key_source(std::path::Path::new(source)),
            "pasted",
        );
    }
    if source.starts_with(keystore::KEYCHAIN_PREFIX) {
        if keystore::parse_keychain_source(source).is_none() {
            // Malformed: whatever follows the prefix may be a pasted key.
            return ("keychain:[redacted]".into(), "keychain");
        }
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
            // Not `path.display()`: a value that names no file may be a pasted key.
            format!("{} (identity file)", keystore::describe_key_source(&path)),
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

/// Which slot a key goes to: the one in use, or the staging slot a new key waits in until the
/// chain has it (so the key in use is never overwritten by one that might not register).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Slot {
    /// The key this computer signs with.
    Main,
    /// A new key, not yet confirmed on chain.
    Pending,
}

impl Slot {
    fn suffix(self) -> &'static str {
        match self {
            Slot::Main => "",
            Slot::Pending => ".pending",
        }
    }
}

fn account(network: &str, identity_id: &str, slot: Slot) -> String {
    format!("{network}/{identity_id}{}", slot.suffix())
}

fn slot_file(network: &str, identity_id: &str, slot: Slot) -> Result<PathBuf> {
    let f = key_file(network, identity_id)?;
    Ok(match slot {
        Slot::Main => f,
        Slot::Pending => f.with_extension("key.pending"),
    })
}

/// How a key is stored: where, and (for a sealed file) the passphrase, so one run asks once.
#[derive(Debug, Default)]
pub struct Storer {
    /// Allow an unencrypted file where there is no keychain.
    pub insecure_plaintext: bool,
    /// Never use the keychain (a full identity with its master key).
    pub no_keychain: bool,
    pass: Option<Secret>,
}

impl Storer {
    /// A storer for a limited key.
    pub fn new(insecure_plaintext: bool) -> Self {
        Self {
            insecure_plaintext,
            ..Self::default()
        }
    }

    /// A storer for a full identity (master key included): never the keychain.
    pub fn sealed_only(insecure_plaintext: bool) -> Self {
        Self {
            insecure_plaintext,
            no_keychain: true,
            ..Self::default()
        }
    }

    /// Store `text` (a `dfk1:` key or a bridge JSON) for `identity_id` on `network` in `slot`,
    /// preferring the keychain (never for a full identity: its master key goes behind a
    /// passphrase). `insecure_plaintext` allows an unencrypted file when there is no keychain.
    pub fn store(
        &mut self,
        network: &str,
        identity_id: &str,
        text: &Secret,
        slot: Slot,
    ) -> Result<Stored> {
        if !self.no_keychain && keychain::available() {
            let acct = account(network, identity_id, slot);
            // keychain::set reads the value back before it reports success.
            match keychain::set(keychain::SERVICE, &acct, text.expose()) {
                Ok(()) => {
                    return Ok(Stored::Keychain {
                        source: format!(
                            "{}{}/{acct}",
                            keystore::KEYCHAIN_PREFIX,
                            keychain::SERVICE
                        ),
                    })
                }
                Err(e) => eprintln!("note: the keychain refused the key ({e}); using a file"),
            }
        }
        let path = slot_file(network, identity_id, slot)?;
        if self.insecure_plaintext && !self.no_keychain {
            keystore::write_private_file(&path, text.expose().as_bytes())?;
            return Ok(Stored::Plaintext(path));
        }
        if self.pass.is_none() {
            let why = if self.no_keychain {
                "a full identity (master key included) is only ever stored behind a passphrase"
            } else {
                "there is no OS keychain here, so the key goes to a passphrase-encrypted file"
            };
            let pass = sealed::passphrase(&format!("the key file {}", path.display()), true)
                .map_err(|e| {
                    UserError::new(codes::USAGE, "the key could not be stored")
                        .cause(format!("{why}, and {e}"))
                        .fix("run it in a terminal to type a passphrase, or set DASH_FORGE_PASSPHRASE")
                        .note("nothing was registered on chain")
                })?;
            self.pass = Some(pass);
        }
        let pass = self.pass.as_ref().context("no passphrase")?;
        let sealed_text = sealed::seal(text.expose().as_bytes(), pass.expose())?;
        keystore::write_private_file(&path, sealed_text.as_bytes())?;
        Ok(Stored::Sealed(path))
    }
}

/// Store a limited key in the main slot (one-off).
pub fn store(
    network: &str,
    identity_id: &str,
    text: &Secret,
    insecure_plaintext: bool,
) -> Result<Stored> {
    Storer::new(insecure_plaintext).store(network, identity_id, text, Slot::Main)
}

/// Move a key from the pending slot to the main slot (the chain has confirmed it), then drop
/// the pending copy. Returns where the main copy is.
pub fn promote(
    storer: &mut Storer,
    network: &str,
    identity_id: &str,
    text: &Secret,
) -> Result<Stored> {
    let main = storer.store(network, identity_id, text, Slot::Main)?;
    discard_pending(network, identity_id);
    Ok(main)
}

/// Delete the pending slot (keychain entry and file), best effort.
pub fn discard_pending(network: &str, identity_id: &str) {
    let _ = keychain::delete(
        keychain::SERVICE,
        &account(network, identity_id, Slot::Pending),
    );
    if let Ok(p) = slot_file(network, identity_id, Slot::Pending) {
        let _ = std::fs::remove_file(p);
    }
}

/// Remove what [`store`] wrote for `identity_id` on `network` (keychain entries and key files,
/// main and pending), and the keychain entry `source` names if it is another one. Returns what
/// was removed; fails if an entry exists but could not be removed.
pub fn remove(network: &str, identity_id: &str, source: Option<&str>) -> Result<Vec<String>> {
    let mut removed = Vec::new();
    let mut entries: Vec<(String, String)> = [Slot::Main, Slot::Pending]
        .iter()
        .map(|s| {
            (
                keychain::SERVICE.to_string(),
                account(network, identity_id, *s),
            )
        })
        .collect();
    if let Some((svc, acct)) = source.and_then(keystore::parse_keychain_source) {
        if !entries.iter().any(|(s, a)| s == svc && a == acct) {
            entries.push((svc.to_string(), acct.to_string()));
        }
    }
    let mut failures = Vec::new();
    for (svc, acct) in &entries {
        // Tried even with the keychain switched off: the entry may predate the switch.
        match keychain::delete(svc, acct) {
            Ok(true) => removed.push(format!("{} entry {svc}/{acct}", keychain::store_name())),
            Ok(false) => {}
            Err(e) => failures.push(format!("{svc}/{acct}: {e}")),
        }
    }
    for slot in [Slot::Main, Slot::Pending] {
        let path = slot_file(network, identity_id, slot)?;
        if path.exists() {
            std::fs::remove_file(&path).with_context(|| format!("removing {}", path.display()))?;
            removed.push(path.display().to_string());
        }
    }
    if !failures.is_empty() {
        return Err(UserError::new(codes::IDENTITY_UNREADABLE, "the stored key was not removed")
            .cause(failures.join("; "))
            .fix("unlock the keychain and run `dg auth logout` again, or delete the entry in Keychain Access")
            .into());
    }
    Ok(removed)
}

/// Record `source` as the default identity for the context's network (config.toml), with the
/// network settings the next command needs to reconnect.
pub fn set_default(ctx: &Ctx, identity_id: &str, source: &str) -> Result<()> {
    // An unreadable config is reported, not silently replaced by a default one.
    let mut config = Config::load()?;
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

    /// `dg auth status` with an identity JSON pasted into `DASH_FORGE_KEY` never prints it.
    #[test]
    fn a_pasted_identity_is_never_described() {
        let pasted = r#"{"identityId":"X","identityKeys":[{"privateKeyWif":"cSECRETwif"}]}"#;
        let (d, kind) = describe_source(pasted);
        assert_eq!(kind, "pasted");
        assert!(!d.contains("cSECRET"), "{d}");
    }
}
