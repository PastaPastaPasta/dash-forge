//! The forge-user encryption key `E` a wallet sign-in hands dg, and where this computer keeps
//! it: the OS keychain (service `dash-forge`, account `<network>/<identity>.sync`), else
//! `identities/<network>-<identity>.key.sync` beside the signing key (sealed like it). Older
//! builds never read either, so they are unaffected.

use std::path::PathBuf;

use crate::app_connect::SecretBytes;
use crate::error::{Error, Result};
use crate::keystore::Secret;

/// The text form: `fue1:<network>:<identity>:<keyId>:<private key hex>`.
pub const SYNC_KEY_PREFIX: &str = "fue1:";

/// `E`, with the identity and network it belongs to and its key id on the identity.
#[derive(Clone)]
pub struct SyncKey {
    /// Forge's network key (`testnet`, `devnet-<name>`).
    pub network: String,
    /// The identity (base58).
    pub identity_id: String,
    /// Its id on the identity.
    pub key_id: u32,
    identity: [u8; 32],
    secret: SecretBytes,
}

impl std::fmt::Debug for SyncKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SyncKey")
            .field("network", &self.network)
            .field("identity_id", &self.identity_id)
            .field("key_id", &self.key_id)
            .finish_non_exhaustive()
    }
}

impl SyncKey {
    /// `secret` as key `key_id` of `identity_id` on `network`.
    pub fn new(network: &str, identity_id: &str, key_id: u32, secret: SecretBytes) -> Result<Self> {
        let identity = crate::app_connect::decode_id(identity_id)
            .ok_or_else(|| Error::InvalidInput("the sync key names no identity".into()))?;
        super::crypto::public_key(&secret)?;
        if network.is_empty() || network.contains(':') {
            return Err(Error::InvalidInput("the sync key names no network".into()));
        }
        Ok(Self {
            network: network.to_string(),
            identity_id: identity_id.to_string(),
            key_id,
            identity,
            secret,
        })
    }

    /// The identity's 32 bytes.
    pub fn identity(&self) -> &[u8; 32] {
        &self.identity
    }

    /// The private key.
    pub fn secret(&self) -> &SecretBytes {
        &self.secret
    }

    /// The compressed public key.
    pub fn public_key(&self) -> [u8; 33] {
        super::crypto::public_key(&self.secret).expect("checked in new")
    }

    /// The `fue1:` text to store.
    pub fn to_text(&self) -> Secret {
        Secret::new(format!(
            "{SYNC_KEY_PREFIX}{}:{}:{}:{}",
            self.network,
            self.identity_id,
            self.key_id,
            hex::encode(self.secret.expose())
        ))
    }

    /// Parse the `fue1:` text. Errors never echo it.
    pub fn from_text(text: &str) -> Result<Self> {
        let bad = || Error::InvalidInput("the stored sync key is not a fue1: key".into());
        let rest = text.trim().strip_prefix(SYNC_KEY_PREFIX).ok_or_else(bad)?;
        let mut parts = rest.split(':');
        let (Some(network), Some(identity), Some(key_id), Some(hex_key), None) = (
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
        ) else {
            return Err(bad());
        };
        let key_id: u32 = key_id.parse().map_err(|_| bad())?;
        let bytes = zeroize::Zeroizing::new(hex::decode(hex_key).map_err(|_| bad())?);
        let secret: [u8; 32] = bytes.as_slice().try_into().map_err(|_| bad())?;
        Self::new(network, identity, key_id, SecretBytes::new(secret))
    }
}

/// The keychain account of `identity_id`'s sync key on `network`.
pub fn keychain_account(network: &str, identity_id: &str) -> String {
    format!("{network}/{identity_id}.sync")
}

/// The file the sync key goes to where there is no keychain.
pub fn key_file(network: &str, identity_id: &str) -> Option<PathBuf> {
    crate::keystore::forge_config_dir().map(|d| {
        d.join("identities")
            .join(format!("{network}-{identity_id}.key.sync"))
    })
}

/// What this computer holds for an identity.
#[derive(Debug)]
pub enum LocalKey {
    /// The key.
    Held(SyncKey),
    /// No key here: sync is off.
    Absent,
    /// A key sealed under a passphrase that is not in the environment: it is not asked for.
    Locked,
}

/// The sync key of `identity_id` on `network`, without ever prompting.
pub fn load(network: &str, identity_id: &str) -> LocalKey {
    let check = |key: SyncKey| {
        if key.network == network && key.identity_id == identity_id {
            LocalKey::Held(key)
        } else {
            LocalKey::Absent
        }
    };
    if !crate::keychain::disabled_by_env() {
        if let Ok(Some(text)) = crate::keychain::get(
            crate::keychain::SERVICE,
            &keychain_account(network, identity_id),
        ) {
            if let Ok(key) = SyncKey::from_text(text.expose()) {
                return check(key);
            }
        }
    }
    let Some(path) = key_file(network, identity_id) else {
        return LocalKey::Absent;
    };
    let Ok(raw) = std::fs::read_to_string(&path).map(zeroize::Zeroizing::new) else {
        return LocalKey::Absent;
    };
    if crate::sealed::is_sealed(&raw) {
        if crate::sealed::passphrase_env_in_use(&[crate::sealed::PASSPHRASE_ENV]).is_none() {
            return LocalKey::Locked;
        }
        let Ok(pass) = crate::sealed::passphrase(&path.display().to_string(), false) else {
            return LocalKey::Locked;
        };
        return match crate::sealed::open(&raw, pass.expose())
            .ok()
            .and_then(|plain| std::str::from_utf8(&plain).ok().map(SyncKey::from_text))
        {
            Some(Ok(key)) => check(key),
            _ => LocalKey::Locked,
        };
    }
    match SyncKey::from_text(&raw) {
        Ok(key) => check(key),
        Err(_) => LocalKey::Absent,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_round_trips_and_never_prints_the_key() {
        let id = crate::app_connect::encode_base58(&[7u8; 32]);
        let k = SyncKey::new("testnet", &id, 9, SecretBytes::new([3u8; 32])).unwrap();
        let back = SyncKey::from_text(k.to_text().expose()).unwrap();
        assert_eq!(back.key_id, 9);
        assert_eq!(back.secret().expose(), &[3u8; 32]);
        assert!(!format!("{k:?}").contains("0303"));
        assert!(SyncKey::from_text("fue1:testnet:x:1:00").is_err());
        assert!(SyncKey::from_text("dfk1:a:b:c:d").is_err());
    }
}
