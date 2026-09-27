//! Adding an `ENCRYPTION` key to an identity (private repositories, `docs/security/
//! private-repos.md` §5.1–§5.2), and deriving its private key from the identity's mnemonic.
//!
//! Most identities have no `ENCRYPTION` key. Adding one is an `IdentityUpdate` signed by the
//! identity's MASTER key; the new key is an `ECDSA_SECP256K1` key (a unique key type), so it
//! also signs the transition as proof of possession.
//!
//! **Derivation.** A bridge identity file records each key's DIP-13 path, e.g.
//! `m/9'/1'/5'/0'/0'/0'/4'` for key 4: every level hardened, the last one the key id. The key
//! with id `k` is derived at the same path with the last element `k'`. That is only done when
//! every recorded path follows that shape, all share one prefix, and the mnemonic reproduces
//! every recorded public key; otherwise [`derive_encryption_secret`] returns `None` and the
//! caller draws a random key ([`random_encryption_secret`]) and tells the user to back up the
//! identity file.

use std::fmt;

use async_trait::async_trait;
use dash_sdk::dpp::address_funds::AddressWitness;
use dash_sdk::dpp::consensus::fee::fee_error::FeeError;
use dash_sdk::dpp::dashcore::hashes::{hash160, Hash};
use dash_sdk::dpp::dashcore::secp256k1::{PublicKey, Secp256k1, SecretKey};
use dash_sdk::dpp::identity::accessors::IdentitySettersV0;
use dash_sdk::dpp::identity::identity_public_key::v0::IdentityPublicKeyV0;
use dash_sdk::dpp::key_wallet::{ChildNumber, ExtendedPrivKey, Mnemonic};
use dash_sdk::dpp::platform_value::BinaryData;
use dash_sdk::dpp::state_transition::identity_update_transition::methods::IdentityUpdateTransitionMethodsV0;
use dash_sdk::dpp::state_transition::identity_update_transition::IdentityUpdateTransition;
use dash_sdk::dpp::ProtocolError;
use zeroize::Zeroizing;

use super::{
    consensus_error_of, poll_confirm, to_dashcore, ConsensusError, IdentityGettersV0,
    IdentityPublicKey, IdentityPublicKeyGettersV0, KeyType, LoadedIdentity, Network,
    PlatformClient, Purpose, SecurityLevel, Signer, SingleKeySigner, StateError, StateTransition,
    StateTransitionProofResult,
};
use crate::error::{Error, Result};
use crate::keystore::{BridgeIdentity, IdentityKey, Secret};

/// The pre-sign estimate for one identity update that adds one key, in credits. An upper
/// bound: the measured cost is reported after the update lands.
pub const ADD_KEY_ESTIMATE_CREDITS: u64 = 50_000_000;

/// The `name` a new encryption key gets in the identity file.
pub const ENCRYPTION_KEY_NAME: &str = "Encryption";

/// A 32-byte secp256k1 private key for an `ENCRYPTION` identity key. `Debug` is redacted and
/// the bytes are wiped on drop. Derefs to `[u8; 32]`, so `&secret` passes where `&[u8; 32]`
/// is expected ([`add_encryption_key`]).
pub struct EncryptionSecret(Zeroizing<[u8; 32]>);

impl EncryptionSecret {
    /// Wrap 32 private-key bytes, refusing a value that is not a valid secp256k1 scalar.
    pub fn new(bytes: [u8; 32]) -> Result<Self> {
        let secret = Self(Zeroizing::new(bytes));
        secret.secret_key()?.non_secure_erase();
        Ok(secret)
    }

    /// The private key of an identity-file entry: `privateKeyHex`, else `privateKeyWif`.
    pub fn from_identity_key(key: &IdentityKey) -> Result<Self> {
        let hex_key = key.private_key_hex.expose().trim();
        if !hex_key.is_empty() {
            let bytes =
                Zeroizing::new(hex::decode(hex_key).map_err(|_| {
                    Error::Config(format!("key {}: privateKeyHex is not hex", key.id))
                })?);
            let array: [u8; 32] = bytes.as_slice().try_into().map_err(|_| {
                Error::Config(format!("key {}: privateKeyHex is not 32 bytes", key.id))
            })?;
            return Self::new(array);
        }
        let wif = key.private_key_wif.expose().trim();
        if wif.is_empty() {
            return Err(Error::Config(format!(
                "key {}: no private key in the file",
                key.id
            )));
        }
        let mut private = dash_sdk::dpp::dashcore::PrivateKey::from_wif(wif).map_err(|_| {
            Error::Config(format!("key {}: privateKeyWif is not a valid WIF", key.id))
        })?;
        let secret = Self::new(private.inner.secret_bytes());
        private.inner.non_secure_erase();
        secret
    }

    fn secret_key(&self) -> Result<SecretKey> {
        SecretKey::from_byte_array(&self.0)
            .map_err(|_| Error::Config("not a valid secp256k1 private key".into()))
    }

    /// The compressed (33-byte) public key, as Platform stores an `ECDSA_SECP256K1` key.
    pub fn public_key(&self) -> [u8; 33] {
        let mut sk = self
            .secret_key()
            .expect("validated in EncryptionSecret::new");
        let public = PublicKey::from_secret_key(&Secp256k1::signing_only(), &sk).serialize();
        sk.non_secure_erase();
        public
    }
}

impl std::ops::Deref for EncryptionSecret {
    type Target = [u8; 32];

    fn deref(&self) -> &[u8; 32] {
        &self.0
    }
}

impl fmt::Debug for EncryptionSecret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("EncryptionSecret(<redacted>)")
    }
}

/// A fresh random encryption private key from the OS CSPRNG. Such a key cannot be re-derived:
/// the identity file that stores it is its only copy.
pub fn random_encryption_secret() -> Result<EncryptionSecret> {
    loop {
        let mut bytes = Zeroizing::new([0u8; 32]);
        getrandom::getrandom(bytes.as_mut())
            .map_err(|e| Error::Config(format!("the OS random number generator failed: {e}")))?;
        // A value outside [1, n) has probability ~2^-128; draw again.
        if let Ok(secret) = EncryptionSecret::new(*bytes) {
            return Ok(secret);
        }
    }
}

/// The id the next key added to `identity` gets: one above the highest existing key id.
pub fn next_key_id(identity: &LoadedIdentity) -> u32 {
    identity
        .0
        .public_keys()
        .keys()
        .max()
        .map_or(0, |id| id.saturating_add(1))
}

/// The hardened indices of a `m/i'/j'/…` path. `None` for anything else (a non-hardened
/// level, `m` alone, an index of 2^31 or more).
fn parse_hardened_path(path: &str) -> Option<Vec<u32>> {
    let mut parts = path.trim().split('/');
    if parts.next()? != "m" {
        return None;
    }
    let indices = parts
        .map(|p| {
            let n = p.strip_suffix('\'').or_else(|| p.strip_suffix('h'))?;
            n.parse::<u32>().ok().filter(|i| *i < (1 << 31))
        })
        .collect::<Option<Vec<u32>>>()?;
    (!indices.is_empty()).then_some(indices)
}

fn format_hardened_path(indices: &[u32]) -> String {
    std::iter::once("m".to_string())
        .chain(indices.iter().map(|i| format!("{i}'")))
        .collect::<Vec<_>>()
        .join("/")
}

/// The shared prefix of the identity file's key paths, and the entries that record one. `None`
/// unless every recorded path is fully hardened, ends in its key's id, and shares one prefix.
fn identity_key_branch(bridge: &BridgeIdentity) -> Option<(Vec<u32>, Vec<&IdentityKey>)> {
    let mut prefix: Option<Vec<u32>> = None;
    let mut entries = Vec::new();
    for key in &bridge.identity_keys {
        if key.derivation_path.trim().is_empty() {
            continue;
        }
        let mut indices = parse_hardened_path(&key.derivation_path)?;
        if indices.pop()? != key.id || indices.is_empty() {
            return None;
        }
        match &prefix {
            Some(p) if *p != indices => return None,
            Some(_) => {}
            None => prefix = Some(indices),
        }
        entries.push(key);
    }
    Some((prefix?, entries))
}

/// The DIP-13 path key `key_id` of this identity derives at (see the module docs), or `None`
/// when the identity file's paths do not follow that shape. Does not check the mnemonic:
/// [`derive_encryption_secret`] does.
pub fn identity_key_path(bridge: &BridgeIdentity, key_id: u32) -> Option<String> {
    if key_id >= 1 << 31 {
        return None;
    }
    let (mut prefix, _) = identity_key_branch(bridge)?;
    prefix.push(key_id);
    Some(format_hardened_path(&prefix))
}

fn derive_at(master: &ExtendedPrivKey, prefix: &[u32], key_id: u32) -> Option<SecretKey> {
    let path = prefix
        .iter()
        .chain(std::iter::once(&key_id))
        .map(|i| ChildNumber::from_hardened_idx(*i).ok())
        .collect::<Option<Vec<ChildNumber>>>()?;
    let derived = master.derive_priv(&Secp256k1::signing_only(), &path).ok()?;
    Some(derived.private_key)
}

/// The private key of identity key `key_id`, derived from the identity's mnemonic at the path
/// of [`identity_key_path`]. `None` when the file has no mnemonic, its key paths do not follow
/// the DIP-13 shape, or the mnemonic does not reproduce every public key the file records (so
/// a derived key is never one the user could not re-derive from their 12 words).
pub fn derive_encryption_secret(
    bridge: &BridgeIdentity,
    key_id: u32,
    network: &Network,
) -> Option<EncryptionSecret> {
    if key_id >= 1 << 31 {
        return None;
    }
    let (prefix, recorded) = identity_key_branch(bridge)?;
    let phrase = bridge.mnemonic.expose().trim();
    if phrase.is_empty() || recorded.iter().all(|k| k.public_key_hex.trim().is_empty()) {
        return None;
    }
    let mnemonic = Mnemonic::from_phrase(phrase).ok()?;
    let seed = Zeroizing::new(mnemonic.to_seed(""));
    let master = ExtendedPrivKey::new_master(to_dashcore(network), seed.as_slice()).ok()?;
    let secp = Secp256k1::signing_only();
    for key in recorded
        .iter()
        .filter(|k| !k.public_key_hex.trim().is_empty())
    {
        let mut sk = derive_at(&master, &prefix, key.id)?;
        let public = hex::encode(PublicKey::from_secret_key(&secp, &sk).serialize());
        sk.non_secure_erase();
        if !public.eq_ignore_ascii_case(key.public_key_hex.trim()) {
            return None;
        }
    }
    let mut sk = derive_at(&master, &prefix, key_id)?;
    let secret = EncryptionSecret::new(sk.secret_bytes()).ok();
    sk.non_secure_erase();
    secret
}

/// Whether the identity file's recorded keys are the identity's own: every entry with a
/// derivation path and a public key has the same public key on chain under its id, and the
/// on-chain MASTER key is among them. [`derive_encryption_secret`] checks the mnemonic against
/// those recorded keys, so both together tie the mnemonic to the identity on chain: a file
/// whose mnemonic is not the one that created the identity never yields a derived key.
pub fn recorded_keys_match(bridge: &BridgeIdentity, on_chain: &[super::IdentityKeyInfo]) -> bool {
    let recorded: Vec<&IdentityKey> = bridge
        .identity_keys
        .iter()
        .filter(|k| !k.derivation_path.trim().is_empty() && !k.public_key_hex.trim().is_empty())
        .collect();
    let matches = |k: &IdentityKey| {
        on_chain.iter().any(|c| {
            c.id == k.id && hex::encode(&c.public_key).eq_ignore_ascii_case(k.public_key_hex.trim())
        })
    };
    let master_recorded = on_chain.iter().any(|c| {
        c.security_level == "MASTER"
            && c.purpose == "AUTHENTICATION"
            && recorded.iter().any(|k| k.id == c.id)
    });
    master_recorded && recorded.iter().all(|k| matches(k))
}

/// The identity-file entry for a new `ENCRYPTION` key: `ECDSA_SECP256K1`, `MEDIUM`, the WIF for
/// `network`, and `derivation_path` (empty for a random key).
pub fn encryption_key_entry(
    secret: &EncryptionSecret,
    key_id: u32,
    network: &Network,
    derivation_path: &str,
) -> IdentityKey {
    let mut private = dash_sdk::dpp::dashcore::PrivateKey::new(
        secret
            .secret_key()
            .expect("validated in EncryptionSecret::new"),
        to_dashcore(network),
    );
    let wif = Secret::new(private.to_wif());
    private.inner.non_secure_erase();
    let hex_key = Zeroizing::new(hex::encode(secret.as_slice()));
    IdentityKey {
        id: key_id,
        name: ENCRYPTION_KEY_NAME.into(),
        key_type: "ECDSA_SECP256K1".into(),
        purpose: "ENCRYPTION".into(),
        security_level: "MEDIUM".into(),
        private_key_wif: wif,
        private_key_hex: Secret::new(hex_key.as_str()),
        public_key_hex: hex::encode(secret.public_key()),
        derivation_path: derivation_path.into(),
    }
}

/// Whether the identity file holds the private key of on-chain key `key`: an entry with its id
/// whose private key yields its public key (`ECDSA_SECP256K1`) or public-key hash
/// (`ECDSA_HASH160`). Other key types are never matched.
pub fn file_holds_key(bridge: &BridgeIdentity, key: &super::IdentityKeyInfo) -> bool {
    bridge
        .identity_keys
        .iter()
        .filter(|entry| entry.id == key.id)
        .filter_map(|entry| EncryptionSecret::from_identity_key(entry).ok())
        .any(|secret| {
            let public = secret.public_key();
            match key.key_type.as_str() {
                "ECDSA_SECP256K1" => key.public_key.as_slice() == public.as_slice(),
                "ECDSA_HASH160" => {
                    key.public_key.as_slice() == hash160::Hash::hash(&public).as_byte_array()
                }
                _ => false,
            }
        })
}

/// The signer for an identity update that adds keys: the MASTER key and each new key (which
/// signs its own proof of possession). `Debug` is redacted, unlike rs-dpp's `SimpleSigner`,
/// whose `Debug` and error messages print private keys.
struct UpdateSigner(Vec<SingleKeySigner>);

impl fmt::Debug for UpdateSigner {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "UpdateSigner(<{} keys redacted>)", self.0.len())
    }
}

impl UpdateSigner {
    fn signer_for(&self, key: &IdentityPublicKey) -> Option<&SingleKeySigner> {
        self.0.iter().find(|s| s.can_sign_with(key))
    }
}

fn no_private_key(key: &IdentityPublicKey) -> ProtocolError {
    ProtocolError::Generic(format!("no private key for identity key {}", key.id()))
}

#[async_trait]
impl Signer<IdentityPublicKey> for UpdateSigner {
    async fn sign(
        &self,
        key: &IdentityPublicKey,
        data: &[u8],
    ) -> std::result::Result<BinaryData, ProtocolError> {
        let signer = self.signer_for(key).ok_or_else(|| no_private_key(key))?;
        signer.sign(key, data).await
    }

    async fn sign_create_witness(
        &self,
        key: &IdentityPublicKey,
        data: &[u8],
    ) -> std::result::Result<AddressWitness, ProtocolError> {
        let signer = self.signer_for(key).ok_or_else(|| no_private_key(key))?;
        signer.sign_create_witness(key, data).await
    }

    fn can_sign_with(&self, key: &IdentityPublicKey) -> bool {
        self.0.iter().any(|s| s.can_sign_with(key))
    }
}

/// The error for an identity file without a MASTER key.
fn no_master_key() -> Error {
    Error::Config(
        "adding a key needs the identity's MASTER authentication key, and the identity file \
         has none (a dfk1: limited key or a keys-only file); nothing was sent"
            .into(),
    )
}

/// Refuse, before anything is written or sent, an identity file that cannot sign an identity
/// update: one without a MASTER authentication key with a private key.
pub fn require_master_key(bridge: &BridgeIdentity) -> Result<()> {
    bridge
        .auth_key("MASTER")
        .filter(|k| !k.private_key_wif.expose().trim().is_empty())
        .map(|_| ())
        .ok_or_else(no_master_key)
}

/// Whether the identity now holds key `key_id` as an enabled `ENCRYPTION` key with `public`.
fn holds_encryption_key(identity: &LoadedIdentity, key_id: u32, public: &[u8]) -> bool {
    identity.0.public_keys().get(&key_id).is_some_and(|k| {
        !k.is_disabled() && k.purpose() == Purpose::ENCRYPTION && k.data().as_slice() == public
    })
}

/// Add an `ECDSA_SECP256K1` / `ENCRYPTION` / `MEDIUM` key (unbound, not read-only) with private
/// key `secret` to `identity`, in one `IdentityUpdate` signed by `bridge`'s MASTER
/// authentication key, and return its key id: one above the highest existing id
/// ([`next_key_id`]). The new key signs its own proof of possession.
///
/// Resolves once a proved re-read of the identity shows the key present, enabled and holding
/// `secret`'s public key. When the identity already holds that exact public key as an enabled
/// `ENCRYPTION` key (an earlier run landed), returns its id without sending anything.
///
/// Errors: no MASTER key in `bridge` ([`Error::Config`], nothing sent), insufficient credits
/// ([`Error::InsufficientCredits`]), a consensus rejection or a timeout.
pub async fn add_encryption_key(
    client: &PlatformClient,
    identity: &LoadedIdentity,
    bridge: &BridgeIdentity,
    secret: &[u8; 32],
) -> Result<u32> {
    use dash_sdk::platform::transition::broadcast::BroadcastStateTransition;

    let secret = EncryptionSecret::new(*secret)?;
    let public = secret.public_key();
    if let Some(id) = already_on_identity(identity, &public)? {
        return Ok(id);
    }
    let (transition, key_id) = build_update(client, identity, bridge, &secret).await?;

    let identity_id = identity.id();
    let landed = || async {
        let fresh = client.fetch_identity(&identity_id).await?;
        Ok(holds_encryption_key(&fresh, key_id, &public))
    };
    match transition
        .broadcast_and_wait::<StateTransitionProofResult>(client.sdk(), None)
        .await
    {
        Ok(_) => {
            if !poll_confirm(&landed).await? {
                return Err(Error::Platform(format!(
                    "the identity update was accepted, but key {key_id} is not on the identity \
                     yet; run `dg auth keys list` in a minute"
                )));
            }
        }
        Err(e) => {
            if let Some(err) = insufficient_credits(&e) {
                return Err(err);
            }
            // A rejection is final. Anything else (no answer, a node problem, the bytes
            // already in the mempool, a proof the SDK could not match, a revision or nonce an
            // earlier broadcast of ours consumed) may still have landed: a proved re-read
            // decides.
            if !update_may_have_landed(&e) || !poll_confirm(&landed).await? {
                return Err(Error::Platform(format!(
                    "adding encryption key {key_id}: {e}"
                )));
            }
        }
    }
    Ok(key_id)
}

/// The id of the identity's key holding `public`, when it is an enabled `ENCRYPTION` key; an
/// error when the identity holds `public` as any other key; `None` when it does not hold it.
fn already_on_identity(identity: &LoadedIdentity, public: &[u8; 33]) -> Result<Option<u32>> {
    let Some((id, existing)) = identity
        .0
        .public_keys()
        .iter()
        .find(|(_, k)| k.data().as_slice() == public.as_slice())
    else {
        return Ok(None);
    };
    if holds_encryption_key(identity, *id, public) {
        return Ok(Some(*id));
    }
    Err(Error::Config(format!(
        "the identity already holds this public key as key {id} ({:?}, {}); nothing was sent",
        existing.purpose(),
        if existing.is_disabled() {
            "disabled"
        } else {
            "enabled"
        }
    )))
}

/// Build and sign the identity update adding `secret` as the next key id, and return it with
/// that id. Nothing is sent.
async fn build_update(
    client: &PlatformClient,
    identity: &LoadedIdentity,
    bridge: &BridgeIdentity,
    secret: &EncryptionSecret,
) -> Result<(StateTransition, u32)> {
    require_master_key(bridge)?;
    let master_entry = bridge.auth_key("MASTER").ok_or_else(no_master_key)?;
    let master_signer = super::signer_from_key(master_entry)?;
    let master_key = identity
        .0
        .public_keys()
        .values()
        .find(|k| {
            !k.is_disabled()
                && k.purpose() == Purpose::AUTHENTICATION
                && k.security_level() == SecurityLevel::MASTER
                && master_signer.can_sign_with(k)
        })
        .ok_or_else(|| {
            Error::Config(
                "the identity file's MASTER authentication key is not an enabled MASTER key of \
                 the identity on chain; nothing was sent"
                    .into(),
            )
        })?
        .id();

    let key_id = next_key_id(identity);
    let new_key: IdentityPublicKey = IdentityPublicKeyV0 {
        id: key_id,
        purpose: Purpose::ENCRYPTION,
        security_level: SecurityLevel::MEDIUM,
        contract_bounds: None,
        key_type: KeyType::ECDSA_SECP256K1,
        read_only: false,
        data: BinaryData::new(secret.public_key().to_vec()),
        disabled_at: None,
    }
    .into();
    let new_signer =
        SingleKeySigner::new_from_slice(secret.as_slice(), to_dashcore(client.network()))
            .map_err(|e| Error::Config(format!("invalid encryption key: {e}")))?;
    let signer = UpdateSigner(vec![master_signer, new_signer]);

    let sdk = client.sdk();
    let mut updated = identity.0.clone();
    updated.set_revision(identity.0.revision() + 1);
    let nonce = sdk
        .get_identity_nonce(identity.0.id(), true, None)
        .await
        .map_err(|e| Error::Platform(format!("fetching the identity nonce: {e}")))?;
    let transition = IdentityUpdateTransition::try_from_identity_with_signer(
        &updated,
        &master_key,
        vec![new_key],
        Vec::new(),
        nonce,
        0,
        &signer,
        sdk.version(),
        None,
    )
    .await
    .map_err(|e| Error::Platform(format!("building the identity update: {e}")))?;
    Ok((transition, key_id))
}

/// The typed insufficient-credits error for a broadcast the identity cannot pay for.
fn insufficient_credits(e: &dash_sdk::Error) -> Option<Error> {
    match consensus_error_of(e)? {
        ConsensusError::StateError(StateError::IdentityInsufficientBalanceError(err)) => {
            Some(Error::InsufficientCredits {
                needed: err.required_balance(),
                available: err.balance(),
            })
        }
        ConsensusError::FeeError(FeeError::BalanceIsNotEnoughError(err)) => {
            Some(Error::InsufficientCredits {
                needed: err.fee(),
                available: err.balance(),
            })
        }
        _ => None,
    }
}

/// Whether a failed broadcast-and-wait of an identity update can still have landed: anything
/// but a consensus rejection, and among those a revision or nonce that is already used (an
/// earlier broadcast of these bytes).
fn update_may_have_landed(e: &dash_sdk::Error) -> bool {
    !matches!(
        consensus_error_of(e),
        Some(consensus) if !matches!(
            consensus,
            ConsensusError::StateError(
                StateError::InvalidIdentityRevisionError(_)
                    | StateError::InvalidIdentityNonceError(_)
            )
        )
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The public BIP39 test mnemonic (all its keys are public knowledge).
    const ABANDON: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
                           abandon abandon abandon about";

    // Computed independently (pure-Python BIP39 PBKDF2 + BIP32 hardened CKD + secp256k1), not
    // with the code under test.
    const PUB_0: &str = "03a00f4853081aeb8c9debe37267303fa133bd7f6678bfb3299dfa001bfd0341db";
    const PUB_4: &str = "03d3c6c2629ff5c15703717a7a14c8a01b04b55dbf511cafc58d96519206f0213c";
    const PUB_5: &str = "02f521bfa606ef60d9a1b3582d9bdc6ed00c95177cd3546e3eef95e424a912795a";

    fn key(id: u32, path: &str, public: &str) -> IdentityKey {
        IdentityKey {
            id,
            name: "k".into(),
            key_type: "ECDSA_SECP256K1".into(),
            purpose: "AUTHENTICATION".into(),
            security_level: "MASTER".into(),
            private_key_wif: Secret::new(""),
            private_key_hex: Secret::new(""),
            public_key_hex: public.into(),
            derivation_path: path.into(),
        }
    }

    fn bridge(mnemonic: &str, keys: Vec<IdentityKey>) -> BridgeIdentity {
        let mut b = BridgeIdentity::from_dfk1("dfk1:testnet:ID:1:x").unwrap();
        b.mnemonic = Secret::new(mnemonic);
        b.identity_keys = keys;
        b
    }

    fn abandon() -> BridgeIdentity {
        bridge(ABANDON, vec![key(0, "m/9'/1'/5'/0'/0'/0'/0'", PUB_0)])
    }

    #[test]
    fn derives_the_next_key_on_the_identity_path() {
        let b = abandon();
        for (id, want) in [(4, PUB_4), (5, PUB_5)] {
            let secret = derive_encryption_secret(&b, id, &Network::Testnet).unwrap();
            assert_eq!(hex::encode(secret.public_key()), want);
        }
        assert_eq!(
            identity_key_path(&b, 5).as_deref(),
            Some("m/9'/1'/5'/0'/0'/0'/5'")
        );
        // The xprv network does not change the key.
        let on_mainnet = derive_encryption_secret(&b, 4, &Network::Mainnet).unwrap();
        assert_eq!(hex::encode(on_mainnet.public_key()), PUB_4);
    }

    #[test]
    fn no_derivation_without_a_matching_mnemonic_or_path_shape() {
        // No mnemonic (a dfk1: key or a keys-only file).
        let b = bridge("", vec![key(0, "m/9'/1'/5'/0'/0'/0'/0'", PUB_0)]);
        assert!(derive_encryption_secret(&b, 4, &Network::Testnet).is_none());
        // The mnemonic does not reproduce the recorded key.
        let b = bridge(ABANDON, vec![key(0, "m/9'/1'/5'/0'/0'/0'/0'", PUB_4)]);
        assert!(derive_encryption_secret(&b, 4, &Network::Testnet).is_none());
        // A non-hardened level, a last element that is not the key id, mixed prefixes.
        for keys in [
            vec![key(0, "m/9'/1'/5'/0'/0'/0'/0", PUB_0)],
            vec![key(1, "m/9'/1'/5'/0'/0'/0'/0'", PUB_0)],
            vec![
                key(0, "m/9'/1'/5'/0'/0'/0'/0'", PUB_0),
                key(1, "m/9'/1'/5'/0'/0'/1'/1'", ""),
            ],
            vec![key(0, "", PUB_0)],
        ] {
            let b = bridge(ABANDON, keys);
            assert!(derive_encryption_secret(&b, 4, &Network::Testnet).is_none());
        }
        assert!(derive_encryption_secret(&abandon(), 1 << 31, &Network::Testnet).is_none());
    }

    #[test]
    fn a_new_entry_round_trips_its_secret_and_never_prints_it() {
        let secret = derive_encryption_secret(&abandon(), 4, &Network::Testnet).unwrap();
        let entry = encryption_key_entry(&secret, 4, &Network::Testnet, "m/9'/1'/5'/0'/0'/0'/4'");
        assert_eq!(entry.purpose, "ENCRYPTION");
        assert_eq!(entry.security_level, "MEDIUM");
        assert_eq!(entry.public_key_hex, PUB_4);
        assert!(
            entry.private_key_wif.expose().starts_with('c'),
            "a testnet WIF"
        );
        let from_hex = EncryptionSecret::from_identity_key(&entry).unwrap();
        assert_eq!(*from_hex, *secret);
        let mut wif_only = entry.clone();
        wif_only.private_key_hex = Secret::new("");
        assert_eq!(
            *EncryptionSecret::from_identity_key(&wif_only).unwrap(),
            *secret
        );

        let hex_key = entry.private_key_hex.expose().to_string();
        for shown in [format!("{secret:?}"), format!("{entry:?}")] {
            assert!(!shown.contains(&hex_key), "{shown}");
            assert!(!shown.contains(entry.private_key_wif.expose()), "{shown}");
        }
        let signer = UpdateSigner(vec![SingleKeySigner::new_from_slice(
            secret.as_slice(),
            to_dashcore(&Network::Testnet),
        )
        .unwrap()]);
        assert_eq!(format!("{signer:?}"), "UpdateSigner(<1 keys redacted>)");
    }

    fn on_chain(id: u32, level: &str, public: &str) -> super::super::IdentityKeyInfo {
        super::super::IdentityKeyInfo {
            id,
            purpose: "AUTHENTICATION".into(),
            security_level: level.into(),
            key_type: "ECDSA_SECP256K1".into(),
            public_key: hex::decode(public).unwrap(),
            disabled: false,
            bound_to: None,
        }
    }

    #[test]
    fn recorded_keys_must_be_the_identity_keys_on_chain() {
        let b = abandon();
        assert!(recorded_keys_match(&b, &[on_chain(0, "MASTER", PUB_0)]));
        // The file's key 0 is not the identity's master key: its mnemonic is someone else's.
        assert!(!recorded_keys_match(&b, &[on_chain(0, "MASTER", PUB_4)]));
        // The on-chain master is not among the recorded keys.
        assert!(!recorded_keys_match(
            &b,
            &[on_chain(0, "HIGH", PUB_0), on_chain(7, "MASTER", PUB_5)]
        ));
    }

    #[test]
    fn file_holds_key_matches_on_the_public_key() {
        let secret = derive_encryption_secret(&abandon(), 4, &Network::Testnet).unwrap();
        let entry = encryption_key_entry(&secret, 4, &Network::Testnet, "");
        let b = bridge(ABANDON, vec![entry]);
        let mut info = super::super::IdentityKeyInfo {
            id: 4,
            purpose: "ENCRYPTION".into(),
            security_level: "MEDIUM".into(),
            key_type: "ECDSA_SECP256K1".into(),
            public_key: hex::decode(PUB_4).unwrap(),
            disabled: false,
            bound_to: None,
        };
        assert!(file_holds_key(&b, &info));
        info.public_key = hex::decode(PUB_5).unwrap();
        assert!(!file_holds_key(&b, &info));
        info.public_key = hex::decode(PUB_4).unwrap();
        info.id = 5;
        assert!(!file_holds_key(&b, &info));
    }

    /// Against a real bridge identity file (`DASH_FORGE_TEST_IDENTITY=<path>`, e.g. a moutai
    /// fixture): every recorded key re-derives from the mnemonic when it is left out of the
    /// file. Skipped when the variable is unset; nothing from the file is printed.
    #[test]
    fn rederives_every_key_of_a_real_identity_file() {
        let Some(path) = std::env::var_os("DASH_FORGE_TEST_IDENTITY") else {
            return;
        };
        let full = BridgeIdentity::load_from_file(path).unwrap();
        for target in &full.identity_keys {
            let mut rest = full.clone();
            rest.identity_keys.retain(|k| k.id != target.id);
            let secret = derive_encryption_secret(&rest, target.id, &Network::Testnet)
                .unwrap_or_else(|| panic!("key {} does not derive", target.id));
            assert_eq!(
                hex::encode(secret.public_key()),
                target.public_key_hex,
                "key {}",
                target.id
            );
            assert_eq!(
                identity_key_path(&rest, target.id).as_deref(),
                Some(target.derivation_path.as_str())
            );
        }
    }

    #[test]
    fn random_secrets_are_valid_and_distinct() {
        let a = random_encryption_secret().unwrap();
        let b = random_encryption_secret().unwrap();
        assert_ne!(*a, *b);
        assert!(EncryptionSecret::new([0u8; 32]).is_err());
    }
}
