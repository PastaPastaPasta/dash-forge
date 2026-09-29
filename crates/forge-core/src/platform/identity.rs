//! Identity lifecycle on Platform: create an identity from an asset lock, register and disable
//! keys, read key limits, register DPNS names. Part of [`crate::platform`] because it drives the
//! SDK directly; everything it hands back is SDK-free.
//!
//! Keys follow the paths `tools/mint-identity`, the web app and the Dash bridge use, so an
//! identity created by any of them opens in the others:
//!
//! * identity keys (DIP-13): `m/9'/<coin>'/5'/0'/0'/<identityIndex>'/<keyIndex>'`
//! * the asset-lock (deposit) key (BIP-44): `m/44'/<coin>'/0'/0/0`
//!
//! with coin type 5 on mainnet and 1 elsewhere. The canonical key set (key id = index) is
//! MASTER, HIGH and CRITICAL authentication, CRITICAL transfer and MEDIUM encryption; a
//! Forge limited key is added after them (ux-dx-spec §2.1).

use std::collections::BTreeMap;
use std::str::FromStr;

use dash_sdk::dpp::address_funds::AddressWitness;
use dash_sdk::dpp::dashcore::consensus::encode::{deserialize, serialize};
use dash_sdk::dpp::dashcore::hashes::Hash as _;
use dash_sdk::dpp::dashcore::script::{Builder, PushBytesBuf};
use dash_sdk::dpp::dashcore::secp256k1::{Message, Secp256k1, SecretKey};
use dash_sdk::dpp::dashcore::sighash::SighashCache;
use dash_sdk::dpp::dashcore::transaction::special_transaction::asset_lock::AssetLockPayload;
use dash_sdk::dpp::dashcore::transaction::special_transaction::TransactionPayload;
use dash_sdk::dpp::dashcore::{
    Address, InstantLock, Network as DashcoreNetwork, OutPoint, PrivateKey, PublicKey, ScriptBuf,
    Transaction, TxIn, TxOut, Txid,
};
use dash_sdk::dpp::identity::accessors::{IdentityGettersV0, IdentitySettersV0};
use dash_sdk::dpp::identity::identity_public_key::accessors::v0::IdentityPublicKeyGettersV0;
use dash_sdk::dpp::identity::identity_public_key::contract_bounds::ContractBounds;
use dash_sdk::dpp::identity::identity_public_key::v0::IdentityPublicKeyV0;
use dash_sdk::dpp::identity::identity_public_key::v1::IdentityPublicKeyV1;
use dash_sdk::dpp::identity::signer::Signer;
use dash_sdk::dpp::identity::state_transition::asset_lock_proof::chain::ChainAssetLockProof;
use dash_sdk::dpp::identity::state_transition::asset_lock_proof::InstantAssetLockProof;
use dash_sdk::dpp::identity::{Identity, IdentityPublicKey, KeyType, Purpose, SecurityLevel};
use dash_sdk::dpp::key_wallet::bip32::{DerivationPath, ExtendedPrivKey};
use dash_sdk::dpp::key_wallet::mnemonic::{Language, Mnemonic};
use dash_sdk::dpp::platform_value::string_encoding::Encoding;
use dash_sdk::dpp::platform_value::BinaryData;
use dash_sdk::dpp::prelude::AssetLockProof;
use dash_sdk::dpp::state_transition::identity_update_transition::methods::IdentityUpdateTransitionMethodsV0;
use dash_sdk::dpp::state_transition::identity_update_transition::IdentityUpdateTransition;
use dash_sdk::dpp::state_transition::proof_result::StateTransitionProofResult;
use dash_sdk::dpp::ProtocolError;
use dash_sdk::platform::dpns_usernames::{
    convert_to_homograph_safe_chars, is_contested_username, is_valid_username,
    RegisterDpnsNameInput,
};
use dash_sdk::platform::fetch_current_no_parameters::FetchCurrent;
use dash_sdk::platform::transition::broadcast::BroadcastStateTransition;
use dash_sdk::platform::transition::put_identity::PutIdentity;
use dash_sdk::platform::types::identity::PublicKeyHash;
use dash_sdk::platform::{Fetch, Identifier};
use simple_signer::SingleKeySigner;
use zeroize::Zeroizing;

use super::{parse_id, retry_transient_read, LoadedIdentity, PlatformClient};
use crate::error::{Error, Result};
use crate::keystore::{AssetLockKey, BridgeIdentity, IdentityKey, Secret};
use crate::network::Network;

/// Duffs per DASH.
pub const DUFFS_PER_DASH: u64 = 100_000_000;
/// The L1 fee an asset lock pays, per input (duffs).
const ASSET_LOCK_FEE_PER_INPUT: u64 = 1_000;
/// The most inputs an asset lock may spend (Platform's `max_asset_lock_transaction_inputs`).
const MAX_ASSET_LOCK_INPUTS: usize = 100;
/// A signer over several private keys: signs with whichever one matches the key asked for.
#[derive(Debug, Default)]
struct KeyRing(Vec<SingleKeySigner>);

impl KeyRing {
    fn add(&mut self, secret: &SecretKey, network: &Network) {
        self.0
            .push(SingleKeySigner::from_private_key(PrivateKey::new(
                *secret,
                super::to_dashcore(network),
            )));
    }

    fn find(&self, key: &IdentityPublicKey) -> Option<&SingleKeySigner> {
        self.0.iter().find(|s| s.can_sign_with(key))
    }

    fn missing(key: &IdentityPublicKey) -> ProtocolError {
        ProtocolError::Generic(format!("no private key for key {}", key.id()))
    }
}

#[async_trait::async_trait]
impl Signer<IdentityPublicKey> for KeyRing {
    async fn sign(
        &self,
        key: &IdentityPublicKey,
        data: &[u8],
    ) -> std::result::Result<BinaryData, ProtocolError> {
        self.find(key)
            .ok_or_else(|| Self::missing(key))?
            .sign(key, data)
            .await
    }

    async fn sign_create_witness(
        &self,
        key: &IdentityPublicKey,
        data: &[u8],
    ) -> std::result::Result<AddressWitness, ProtocolError> {
        self.find(key)
            .ok_or_else(|| Self::missing(key))?
            .sign_create_witness(key, data)
            .await
    }

    fn can_sign_with(&self, key: &IdentityPublicKey) -> bool {
        self.0.iter().any(|s| s.can_sign_with(key))
    }
}

/// Keys an IdentityCreate may carry (`max_public_keys_in_creation`).
const MAX_KEYS_IN_CREATION: usize = 6;
/// The smallest deposit `dg auth new` accepts (spec §2.2: 0.02 DASH), in duffs.
pub const MIN_DEPOSIT_DUFFS: u64 = 2_000_000;

/// One of the canonical identity keys: (key id, purpose, security level, name).
const CANONICAL: [(u32, Purpose, SecurityLevel, &str); 5] = [
    (0, Purpose::AUTHENTICATION, SecurityLevel::MASTER, "Master"),
    (1, Purpose::AUTHENTICATION, SecurityLevel::HIGH, "High Auth"),
    (
        2,
        Purpose::AUTHENTICATION,
        SecurityLevel::CRITICAL,
        "Critical Auth",
    ),
    (3, Purpose::TRANSFER, SecurityLevel::CRITICAL, "Transfer"),
    (4, Purpose::ENCRYPTION, SecurityLevel::MEDIUM, "Encryption"),
];

/// The DPNS system contract (the same id on every network).
const DPNS_CONTRACT_ID: &str = "GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec";

/// The key id a limited key created together with the identity gets (after the canonical set).
pub const FIRST_LIMITED_KEY_ID: u32 = 5;

// ---------------------------------------------------------------------------------------
// Keys and mnemonics
// ---------------------------------------------------------------------------------------

fn coin_type(network: &Network) -> u32 {
    if matches!(network, Network::Mainnet) {
        5
    } else {
        1
    }
}

/// A fresh 12-word English recovery phrase (128 bits of entropy from the OS).
pub fn new_mnemonic() -> Result<Secret> {
    let m = Mnemonic::generate(12, Language::English)
        .map_err(|e| Error::Config(format!("generating the recovery words: {e}")))?;
    Ok(Secret::new(m.phrase()))
}

/// Lowercase, single-spaced words; `Err` unless it is a valid BIP-39 phrase (checksum too).
pub fn normalize_mnemonic(words: &str) -> Result<Secret> {
    let norm = Zeroizing::new(
        words
            .split_whitespace()
            .map(str::to_lowercase)
            .collect::<Vec<_>>()
            .join(" "),
    );
    Mnemonic::from_phrase(&norm)
        .map_err(|_| Error::Config("those words are not a valid recovery phrase".into()))?;
    Ok(Secret::new(norm.as_str()))
}

/// A private key derived from a mnemonic, with what the chain needs to know about it.
struct Derived {
    secret: SecretKey,
    public: PublicKey,
    path: String,
}

fn derive(mnemonic: &Secret, path: &str, network: &Network) -> Result<Derived> {
    let m = Mnemonic::from_phrase(mnemonic.expose())
        .map_err(|_| Error::Config("the recovery phrase is not valid".into()))?;
    let seed = Zeroizing::new(m.to_seed(""));
    let net = super::to_dashcore(network);
    let secp = Secp256k1::new();
    let master = ExtendedPrivKey::new_master(net, seed.as_ref())
        .map_err(|e| Error::Config(format!("deriving keys: {e}")))?;
    let dp = DerivationPath::from_str(path)
        .map_err(|e| Error::Config(format!("derivation path {path}: {e}")))?;
    let key = master
        .derive_priv(&secp, &dp)
        .map_err(|e| Error::Config(format!("deriving {path}: {e}")))?;
    let secret = key.private_key;
    let public = PublicKey::new(secret.public_key(&secp));
    Ok(Derived {
        secret,
        public,
        path: path.to_string(),
    })
}

fn identity_key_path(network: &Network, key_index: u32) -> String {
    format!("m/9'/{}'/5'/0'/0'/0'/{key_index}'", coin_type(network))
}

fn asset_lock_path(network: &Network) -> String {
    format!("m/44'/{}'/0'/0/0", coin_type(network))
}

fn wif(secret: &SecretKey, network: &Network) -> Secret {
    Secret::new(PrivateKey::new(*secret, super::to_dashcore(network)).to_wif())
}

fn p2pkh_address(public: &PublicKey, network: &Network) -> String {
    Address::p2pkh(public, super::to_dashcore(network)).to_string()
}

/// The public key of `secret`.
fn public_of(secret: &SecretKey) -> PublicKey {
    PublicKey::new(secret.public_key(&Secp256k1::new()))
}

/// A fresh random secp256k1 key (OS RNG).
fn random_secret() -> SecretKey {
    use dash_sdk::dpp::dashcore::secp256k1::rand::rngs::OsRng;
    SecretKey::new(&mut OsRng)
}

fn secret_from_wif(wif: &str, network: &Network) -> Result<SecretKey> {
    let pk = PrivateKey::from_wif(wif.trim())
        .map_err(|_| Error::Config("not a valid private key (WIF)".into()))?;
    let expected_mainnet = matches!(network, Network::Mainnet);
    if (pk.network == DashcoreNetwork::Mainnet) != expected_mainnet {
        return Err(Error::Config(format!(
            "that key is for a different network than {network}"
        )));
    }
    Ok(pk.inner)
}

/// A new identity's recovery material: the words and everything derived from them.
pub struct NewIdentityKeys {
    mnemonic: Secret,
    network: Network,
    asset_lock: Derived,
    canonical: Vec<(u32, Purpose, SecurityLevel, &'static str, Derived)>,
}

impl std::fmt::Debug for NewIdentityKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NewIdentityKeys")
            .field("network", &self.network)
            .field("deposit_address", &self.deposit_address())
            .finish_non_exhaustive()
    }
}

impl NewIdentityKeys {
    /// Derive the deposit key and the canonical identity keys from `mnemonic`.
    pub fn from_mnemonic(mnemonic: &Secret, network: &Network) -> Result<Self> {
        let asset_lock = derive(mnemonic, &asset_lock_path(network), network)?;
        let canonical = CANONICAL
            .iter()
            .map(|(id, p, l, name)| {
                derive(mnemonic, &identity_key_path(network, *id), network)
                    .map(|d| (*id, *p, *l, *name, d))
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Self {
            mnemonic: mnemonic.clone(),
            network: network.clone(),
            asset_lock,
            canonical,
        })
    }

    /// The deposit (asset-lock) address to fund.
    pub fn deposit_address(&self) -> String {
        p2pkh_address(&self.asset_lock.public, &self.network)
    }

    /// The identity's master key as a bridge-format key entry.
    pub fn master_key(&self) -> IdentityKey {
        self.key_entry(0)
    }

    fn key_entry(&self, id: u32) -> IdentityKey {
        let (_, p, l, name, d) = self
            .canonical
            .iter()
            .find(|(i, ..)| *i == id)
            .expect("canonical key ids are 0..=4");
        IdentityKey {
            id,
            name: (*name).to_string(),
            key_type: "ECDSA_SECP256K1".into(),
            purpose: super::purpose_name(*p).into(),
            security_level: super::level_name(*l).into(),
            private_key_wif: wif(&d.secret, &self.network),
            private_key_hex: Secret::new(hex::encode(d.secret.secret_bytes())),
            public_key_hex: hex::encode(d.public.to_bytes()),
            derivation_path: d.path.clone(),
        }
    }

    /// The whole identity as a bridge-format file (the same shape `tools/mint-identity` and the
    /// bridge write), for `identity_id`.
    pub fn to_bridge(&self, identity_id: &str) -> BridgeIdentity {
        BridgeIdentity {
            network: self.network.key(),
            identity_id: identity_id.to_string(),
            identity_keys: self
                .canonical
                .iter()
                .map(|(id, ..)| self.key_entry(*id))
                .collect(),
            mnemonic: self.mnemonic.clone(),
            asset_lock_key: AssetLockKey {
                wif: wif(&self.asset_lock.secret, &self.network),
                public_key_hex: hex::encode(self.asset_lock.public.to_bytes()),
                derivation_path: self.asset_lock.path.clone(),
            },
        }
    }
}

/// A freshly generated key that is not (yet) on any identity.
pub struct FreshKey {
    secret: SecretKey,
    network: Network,
}

impl std::fmt::Debug for FreshKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("FreshKey(<redacted>)")
    }
}

impl FreshKey {
    /// A new random key for `network`.
    pub fn generate(network: &Network) -> Self {
        Self {
            secret: random_secret(),
            network: network.clone(),
        }
    }

    /// The private key (WIF).
    pub fn wif(&self) -> Secret {
        wif(&self.secret, &self.network)
    }

    fn public(&self) -> PublicKey {
        public_of(&self.secret)
    }
}

/// The usage limits of a Forge limited key (ux-dx-spec §2.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LimitedKeySpec {
    /// Total credits the key may spend.
    pub budget_credits: u64,
    /// When it stops signing (Unix ms).
    pub expires_at_ms: u64,
    /// The contract group it is bound to (base58).
    pub group: String,
}

fn key_v0(
    id: u32,
    purpose: Purpose,
    level: SecurityLevel,
    public: &PublicKey,
    bounds: Option<ContractBounds>,
) -> IdentityPublicKeyV0 {
    IdentityPublicKeyV0 {
        id,
        purpose,
        security_level: level,
        contract_bounds: bounds,
        key_type: KeyType::ECDSA_SECP256K1,
        read_only: false,
        data: BinaryData::new(public.to_bytes()),
        disabled_at: None,
    }
}

/// A key bound to one document type of one contract (`ContractBounds::SingleContractDocumentType`,
/// protocol 14 admits it on AUTHENTICATION keys): consensus refuses every batch member outside
/// that type with `ContractBoundedKeyOutOfBoundsError` (20014). A CI runner's key is bound to
/// `(forge-collab, checkRun)` this way (platform-parity-spec §2.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocTypeKeySpec {
    /// Total credits the key may spend.
    pub budget_credits: u64,
    /// When it stops signing (Unix ms).
    pub expires_at_ms: u64,
    /// The contract (base58) the key is bound to.
    pub contract: String,
    /// The one document type of `contract` it may write.
    pub document_type: String,
}

fn with_limits(v0: IdentityPublicKeyV0, budget: u64, expires_at_ms: u64) -> IdentityPublicKey {
    IdentityPublicKeyV1::from_v0_with_limits(v0, Some(budget), Some(expires_at_ms)).into()
}

fn limited_public_key(id: u32, key: &FreshKey, spec: &LimitedKeySpec) -> Result<IdentityPublicKey> {
    let group = parse_id(&spec.group, "contract group id")?;
    let v0 = key_v0(
        id,
        Purpose::AUTHENTICATION,
        SecurityLevel::HIGH,
        &key.public(),
        Some(ContractBounds::ContractGroup { id: group }),
    );
    Ok(with_limits(v0, spec.budget_credits, spec.expires_at_ms))
}

fn doc_type_public_key(
    id: u32,
    key: &FreshKey,
    spec: &DocTypeKeySpec,
) -> Result<IdentityPublicKey> {
    let contract = parse_id(&spec.contract, "contract id")?;
    let v0 = key_v0(
        id,
        Purpose::AUTHENTICATION,
        SecurityLevel::HIGH,
        &key.public(),
        Some(ContractBounds::SingleContractDocumentType {
            id: contract,
            document_type_name: spec.document_type.clone(),
        }),
    );
    Ok(with_limits(v0, spec.budget_credits, spec.expires_at_ms))
}

fn plain_public_key(
    id: u32,
    p: Purpose,
    l: SecurityLevel,
    public: &PublicKey,
) -> IdentityPublicKey {
    key_v0(id, p, l, public, None).into()
}

// ---------------------------------------------------------------------------------------
// Asset lock (Core)
// ---------------------------------------------------------------------------------------

/// A deposit output, proven from its raw funding transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedUtxo {
    /// Funding txid (display hex).
    pub txid: String,
    /// Output index.
    pub vout: u32,
    /// Value in duffs, read from the raw transaction.
    pub duffs: u64,
}

/// Check that output `vout` of the raw transaction `raw` (which must hash to `txid`) pays
/// `address`, and return its real value. The explorer's claimed value is never used: the
/// legacy sighash does not commit to input values, so trusting it would let a lying explorer
/// turn the deposit into miner fees.
pub fn verify_deposit(raw: &[u8], txid: &str, vout: u32, address: &str) -> Result<VerifiedUtxo> {
    let tx: Transaction = deserialize(raw).map_err(|e| {
        Error::Io(format!(
            "the explorer's transaction {txid} does not decode: {e}"
        ))
    })?;
    if tx.txid().to_string() != txid {
        return Err(Error::Io(format!(
            "the block explorer returned a transaction that is not {txid}"
        )));
    }
    let out = tx
        .output
        .get(vout as usize)
        .ok_or_else(|| Error::Io(format!("{txid} has no output {vout}")))?;
    let want = Address::from_str(address)
        .map_err(|e| Error::Config(format!("deposit address {address}: {e}")))?
        .assume_checked()
        .script_pubkey();
    if out.script_pubkey != want {
        return Err(Error::Io(format!("{txid}:{vout} does not pay {address}")));
    }
    Ok(VerifiedUtxo {
        txid: txid.to_string(),
        vout,
        duffs: out.value,
    })
}

/// A signed asset-lock transaction, ready to broadcast.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedAssetLock {
    /// Raw transaction bytes.
    pub raw: Vec<u8>,
    /// Its txid (display hex).
    pub txid: String,
    /// Duffs locked into the credit output.
    pub locked_duffs: u64,
}

/// Build and sign a type-8 asset lock that spends `utxos` (all paid to the deposit key) into
/// one credit output controlled by that same key.
pub fn build_asset_lock(keys: &NewIdentityKeys, utxos: &[VerifiedUtxo]) -> Result<SignedAssetLock> {
    let (secret, public) = (&keys.asset_lock.secret, &keys.asset_lock.public);
    if utxos.is_empty() {
        return Err(Error::Config("no funds to lock".into()));
    }
    if utxos.len() > MAX_ASSET_LOCK_INPUTS {
        return Err(Error::Config(format!(
            "the deposit is spread over {} payments; an asset lock takes at most \
             {MAX_ASSET_LOCK_INPUTS}",
            utxos.len()
        )));
    }
    let total: u64 = utxos.iter().map(|u| u.duffs).sum();
    let fee = ASSET_LOCK_FEE_PER_INPUT * utxos.len() as u64;
    let locked = total
        .checked_sub(fee)
        .filter(|l| *l > 0)
        .ok_or_else(|| Error::Config("the deposit is too small to cover the fee".into()))?;
    let script = ScriptBuf::new_p2pkh(&public.pubkey_hash());
    let input = utxos
        .iter()
        .map(|u| {
            Ok(TxIn {
                previous_output: OutPoint::new(
                    Txid::from_str(&u.txid)
                        .map_err(|e| Error::Config(format!("txid {}: {e}", u.txid)))?,
                    u.vout,
                ),
                script_sig: ScriptBuf::new(),
                sequence: 0xFFFF_FFFF,
                witness: dash_sdk::dpp::dashcore::Witness::default(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let mut tx = Transaction {
        version: 3,
        lock_time: 0,
        input,
        output: vec![TxOut {
            value: locked,
            script_pubkey: ScriptBuf::new_op_return(&[]),
        }],
        special_transaction_payload: Some(TransactionPayload::AssetLockPayloadType(
            AssetLockPayload::new(vec![TxOut {
                value: locked,
                script_pubkey: script.clone(),
            }]),
        )),
    };
    let secp = Secp256k1::new();
    let mut sigs = Vec::with_capacity(tx.input.len());
    {
        let cache = SighashCache::new(&tx);
        for i in 0..tx.input.len() {
            let hash = cache
                .legacy_signature_hash(i, &script, 1)
                .map_err(|e| Error::Config(format!("sighash: {e}")))?;
            let sig = secp.sign_ecdsa(&Message::from_digest(hash.to_byte_array()), secret);
            let mut der = sig.serialize_der().to_vec();
            der.push(1); // SIGHASH_ALL
            let der = PushBytesBuf::try_from(der)
                .map_err(|_| Error::Config("signature too long".into()))?;
            sigs.push(
                Builder::new()
                    .push_slice(der)
                    .push_slice(public.inner.serialize())
                    .into_script(),
            );
        }
    }
    for (inp, sig) in tx.input.iter_mut().zip(sigs) {
        inp.script_sig = sig;
    }
    Ok(SignedAssetLock {
        raw: serialize(&tx),
        txid: tx.txid().to_string(),
        locked_duffs: locked,
    })
}

/// How an asset lock is proven to Platform.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LockProof {
    /// An InstantSend lock (testnet, mainnet with an islock source).
    Instant {
        /// The raw asset-lock transaction.
        raw_tx: Vec<u8>,
        /// The raw InstantSend lock.
        islock: Vec<u8>,
    },
    /// A chain lock at this Core height (devnets; any network once mined and chain-locked).
    Chain {
        /// The asset-lock txid (display hex).
        txid: String,
        /// Height the transaction was mined at (Platform must have chain-locked it).
        height: u32,
    },
}

fn to_sdk_proof(proof: &LockProof) -> Result<AssetLockProof> {
    Ok(match proof {
        LockProof::Instant { raw_tx, islock } => {
            let tx: Transaction = deserialize(raw_tx)
                .map_err(|e| Error::Config(format!("asset-lock transaction: {e}")))?;
            let lock: InstantLock =
                deserialize(islock).map_err(|e| Error::Config(format!("InstantSend lock: {e}")))?;
            AssetLockProof::Instant(InstantAssetLockProof::new(lock, tx, 0))
        }
        LockProof::Chain { txid, height } => AssetLockProof::Chain(ChainAssetLockProof {
            core_chain_locked_height: *height,
            out_point: OutPoint::new(
                Txid::from_str(txid).map_err(|e| Error::Config(format!("txid {txid}: {e}")))?,
                0,
            ),
        }),
    })
}

fn identifier_of(proof: &AssetLockProof) -> Result<Identifier> {
    proof
        .create_identifier()
        .map_err(|e| Error::Config(format!("identity id from the asset lock: {e}")))
}

/// The identity id an asset lock will create (base58).
pub fn identity_id_for(proof: &LockProof) -> Result<String> {
    Ok(identifier_of(&to_sdk_proof(proof)?)?.to_string(Encoding::Base58))
}

// ---------------------------------------------------------------------------------------
// Platform operations
// ---------------------------------------------------------------------------------------

fn sdk_err(what: &str, e: impl std::fmt::Display) -> Error {
    Error::Platform(format!("{what}: {e}"))
}

impl PlatformClient {
    /// Platform's chain-locked Core height: the most a chain asset-lock proof may claim.
    pub async fn core_chain_locked_height(&self) -> Result<u32> {
        let (_epoch, metadata) =
            dash_sdk::dpp::block::extended_epoch_info::ExtendedEpochInfo::fetch_current_with_metadata(self.sdk())
            .await
            .map_err(|e| sdk_err("reading Platform's chain-locked height", e))?;
        Ok(metadata.core_chain_locked_height)
    }

    /// Contract group `group`'s owner and admins, proof-verified (`getContractGroupInfo`), or
    /// `None` when no group has the id. Only they can add members, so they are the trust root
    /// of every key bound to the group.
    pub async fn contract_group_info(&self, group: &str) -> Result<Option<GroupOwnership>> {
        use dash_sdk::platform::contract_groups::ContractGroupInfo;
        let id = parse_id(group, "contract group id")?;
        let info = retry_transient_read("fetch contract group info", || {
            ContractGroupInfo::fetch(self.sdk(), id)
        })
        .await
        .map_err(|e| sdk_err(&format!("reading contract group {group}"), e))?;
        Ok(info.map(|info| {
            let owner = info.owner();
            GroupOwnership {
                owner: owner.owner_id().to_string(Encoding::Base58),
                admins: owner
                    .admin_ids()
                    .into_iter()
                    .flatten()
                    .map(|a| a.to_string(Encoding::Base58))
                    .collect(),
            }
        }))
    }

    /// Everything contract group `group` holds, proof-verified: whole contracts, and the
    /// document-type and token members with the contract each belongs to (base58). A limited
    /// key bound to the group can sign for exactly these, so `dg auth` checks each one.
    pub async fn contract_group_members(&self, group: &str) -> Result<GroupMembers> {
        use dash_sdk::platform::contract_groups::{
            ContractGroupMembersPage, ContractGroupMembersPageQuery,
        };
        let id = parse_id(group, "contract group id")?;
        let mut out = GroupMembers::default();
        for first in [
            ContractGroupMembersPageQuery::contracts(id),
            ContractGroupMembersPageQuery::document_types(id),
            ContractGroupMembersPageQuery::tokens(id),
        ] {
            let mut query = Some(first.with_limit(100));
            let mut pages = 0;
            while let Some(q) = query.take() {
                pages += 1;
                if pages > 20 {
                    return Err(Error::Platform(format!(
                        "contract group {group} has more members than dg checks"
                    )));
                }
                let page = retry_transient_read("fetch contract group members", || {
                    ContractGroupMembersPage::fetch(self.sdk(), q.clone())
                })
                .await
                .map_err(|e| sdk_err(&format!("reading contract group {group}"), e))?;
                let Some(page) = page else { break };
                let n = match &page {
                    ContractGroupMembersPage::Contracts(v) => {
                        out.contracts
                            .extend(v.iter().map(|c| c.to_string(Encoding::Base58)));
                        v.len()
                    }
                    ContractGroupMembersPage::DocumentTypes(v) => {
                        out.document_types.extend(
                            v.iter()
                                .map(|(c, name)| (c.to_string(Encoding::Base58), name.clone())),
                        );
                        v.len()
                    }
                    ContractGroupMembersPage::Tokens(v) => {
                        out.tokens.extend(
                            v.iter()
                                .map(|(c, position)| (c.to_string(Encoding::Base58), *position)),
                        );
                        v.len()
                    }
                };
                // Always ask for the next page: a node may cap pages below the limit. An
                // empty page ends it.
                if n > 0 {
                    query = q.after(&page);
                }
            }
        }
        Ok(out)
    }

    /// Broadcast a raw Core transaction through DAPI.
    pub async fn broadcast_core_tx(&self, raw: &[u8]) -> Result<()> {
        use dapi_grpc::core::v0::BroadcastTransactionRequest;
        use dash_sdk::dapi_client::{DapiRequestExecutor, IntoInner, RequestSettings};
        self.sdk()
            .execute(
                BroadcastTransactionRequest {
                    transaction: raw.to_vec(),
                    allow_high_fees: false,
                    bypass_limits: false,
                },
                RequestSettings::default(),
            )
            .await
            .into_inner()
            .map(|_| ())
            .map_err(|e| sdk_err("broadcasting the asset lock through DAPI", e))
    }

    /// Whether an identity with `identity_id` exists (proved either way).
    pub async fn identity_exists(&self, identity_id: &str) -> Result<bool> {
        let id = parse_id(identity_id, "identity id")?;
        retry_transient_read("fetch identity", || Identity::fetch(self.sdk(), id))
            .await
            .map(|i| i.is_some())
            .map_err(|e| sdk_err(&format!("fetching identity {identity_id}"), e))
    }

    /// The identity that holds a key controlled by `wif` (found by the key's hash), if any.
    pub async fn identity_by_key(&self, wif: &str) -> Result<Option<LoadedIdentity>> {
        let secret = secret_from_wif(wif, self.network())?;
        let public = public_of(&secret);
        let hash = PublicKeyHash(public.pubkey_hash().to_byte_array());
        retry_transient_read("fetch identity by key", || {
            Identity::fetch(self.sdk(), hash.clone())
        })
        .await
        .map(|o| o.map(LoadedIdentity))
        .map_err(|e| sdk_err("looking the key up on Platform", e))
    }

    /// Register a new identity from a proven asset lock: the canonical key set plus a limited
    /// key (`limited`, id [`FIRST_LIMITED_KEY_ID`]) in the same IdentityCreate, so no second
    /// signature is needed (ux-dx-spec §2.2).
    pub async fn create_identity(
        &self,
        keys: &NewIdentityKeys,
        proof: &LockProof,
        limited: &FreshKey,
        spec: &LimitedKeySpec,
    ) -> Result<()> {
        let sdk_proof = to_sdk_proof(proof)?;
        let id = identifier_of(&sdk_proof)?;
        let mut public_keys = BTreeMap::new();
        let mut signer = KeyRing::default();
        for (kid, p, l, _, d) in &keys.canonical {
            let pk = plain_public_key(*kid, *p, *l, &d.public);
            signer.add(&d.secret, self.network());
            public_keys.insert(*kid, pk);
        }
        let lk = limited_public_key(FIRST_LIMITED_KEY_ID, limited, spec)?;
        signer.add(&limited.secret, self.network());
        public_keys.insert(FIRST_LIMITED_KEY_ID, lk);
        debug_assert!(public_keys.len() <= MAX_KEYS_IN_CREATION);
        let identity = Identity::new_with_id_and_keys(id, public_keys, self.sdk().version())
            .map_err(|e| sdk_err("building the identity", e))?;
        let lock_key = PrivateKey::new(keys.asset_lock.secret, super::to_dashcore(self.network()));
        identity
            .put_to_platform_and_wait_for_response_with_private_key(
                self.sdk(),
                sdk_proof,
                &lock_key,
                &signer,
                None,
            )
            .await
            .map_err(|e| sdk_err("registering the identity", e))?;
        Ok(())
    }

    /// One IdentityUpdate signed by the master key (`master_wif`): add `add` (fresh keys with
    /// their specs, getting consecutive ids after the identity's highest) and disable
    /// `disable`. Returns the ids the added keys got.
    pub async fn update_identity_keys(
        &self,
        identity_id: &str,
        master_wif: &Secret,
        add: &[(&FreshKey, KeySpec)],
        disable: &[u32],
    ) -> Result<Vec<u32>> {
        let id = parse_id(identity_id, "identity id")?;
        let mut identity = self.fetch_identity(identity_id).await?.0;
        let master_secret = secret_from_wif(master_wif.expose(), self.network())?;
        let master_public = public_of(&master_secret).to_bytes();
        let master = identity
            .public_keys()
            .values()
            .find(|k| {
                k.security_level() == SecurityLevel::MASTER
                    && k.purpose() == Purpose::AUTHENTICATION
                    && !k.is_disabled()
                    && k.data().as_slice() == master_public.as_slice()
            })
            .cloned()
            .ok_or_else(|| {
                Error::Config(
                    "authentication key: that key is not this identity's master key".into(),
                )
            })?;
        let mut signer = KeyRing::default();
        signer.add(&master_secret, self.network());
        let first = identity.public_keys().keys().max().copied().unwrap_or(0) + 1;
        let mut added = Vec::new();
        let mut new_keys = Vec::new();
        for (next, (key, spec)) in (first..).zip(add) {
            let pk = match spec {
                KeySpec::Limited(s) => limited_public_key(next, key, s)?,
                KeySpec::DocumentType(s) => doc_type_public_key(next, key, s)?,
                KeySpec::Encryption => plain_public_key(
                    next,
                    Purpose::ENCRYPTION,
                    SecurityLevel::MEDIUM,
                    &key.public(),
                ),
            };
            signer.add(&key.secret, self.network());
            new_keys.push(pk);
            added.push(next);
        }
        let nonce = self
            .sdk()
            .get_identity_nonce(id, true, None)
            .await
            .map_err(|e| sdk_err("reading the identity nonce", e))?;
        identity.set_revision(identity.revision() + 1);
        let st = IdentityUpdateTransition::try_from_identity_with_signer(
            &identity,
            &master.id(),
            new_keys,
            disable.to_vec(),
            nonce,
            0,
            &signer,
            self.sdk().version(),
            None,
        )
        .await
        .map_err(|e| sdk_err("signing the identity update", e))?;
        st.broadcast_and_wait::<StateTransitionProofResult>(self.sdk(), None)
            .await
            .map_err(|e| sdk_err("updating the identity's keys", e))?;
        Ok(added)
    }

    /// Whether DPNS name `label` is free.
    pub async fn dpns_name_available(&self, label: &str) -> Result<bool> {
        // The trusted context provider verifies proofs only for contracts it was given:
        // fetching DPNS through `fetch_contract` registers it.
        self.fetch_contract(DPNS_CONTRACT_ID).await?;
        self.sdk()
            .is_dpns_name_available(label)
            .await
            .map_err(|e| sdk_err("checking the name", e))
    }

    /// The DPNS names that resolve to `identity_id` (`alice.dash`).
    pub async fn dpns_names_of(&self, identity_id: &str) -> Result<Vec<String>> {
        // The trusted context provider verifies proofs only for contracts it was given:
        // fetching DPNS through `fetch_contract` registers it.
        self.fetch_contract(DPNS_CONTRACT_ID).await?;
        let id = parse_id(identity_id, "identity id")?;
        self.sdk()
            .get_dpns_usernames_by_identity(id, Some(5))
            .await
            .map(|v| v.into_iter().map(|n| n.full_name).collect())
            .map_err(|e| sdk_err("reading DPNS names", e))
    }

    /// The identity DPNS name `name` (`alice` or `alice.dash`, compared homograph-safe as
    /// DPNS does) resolves to, or `None` when no such name is registered. A proof-verified
    /// read of the DPNS `domain` document (`normalizedParentDomainName == "dash"`,
    /// `normalizedLabel == <label>`) and its `records.identity`, as rs-sdk
    /// `Sdk::resolve_dpns_name` does it.
    pub async fn resolve_dpns_name(&self, name: &str) -> Result<Option<String>> {
        // The trusted context provider verifies proofs only for contracts it was given:
        // fetching DPNS through `fetch_contract` registers it.
        self.fetch_contract(DPNS_CONTRACT_ID).await?;
        self.sdk()
            .resolve_dpns_name(name)
            .await
            .map(|id| id.map(|id| id.to_string(Encoding::Base58)))
            .map_err(|e| sdk_err("resolving the DPNS name", e))
    }

    /// Register DPNS name `label` for `identity_id`, signed by its CRITICAL (else HIGH)
    /// unbound authentication key from `bridge`. Returns the name as registered (`alice.dash`).
    pub async fn register_dpns_name(&self, bridge: &BridgeIdentity, label: &str) -> Result<String> {
        // The trusted context provider verifies proofs only for contracts it was given:
        // fetching DPNS through `fetch_contract` registers it.
        self.fetch_contract(DPNS_CONTRACT_ID).await?;
        let identity = self.fetch_identity(&bridge.identity_id).await?.0;
        let (on_chain, secret) = ["CRITICAL", "HIGH"]
            .iter()
            .filter_map(|lvl| bridge.auth_key(lvl))
            .find_map(|k| {
                let s = secret_from_wif(k.private_key_wif.expose(), self.network()).ok()?;
                let public = public_of(&s).to_bytes();
                identity
                    .public_keys()
                    .values()
                    .find(|pk| {
                        !pk.is_disabled()
                            && pk.contract_bounds().is_none()
                            && pk.data().as_slice() == public.as_slice()
                    })
                    .cloned()
                    .map(|pk| (pk, s))
            })
            .ok_or_else(|| {
                Error::Config(
                    "authentication key: registering a DPNS name needs an unbound CRITICAL or \
                     HIGH authentication key (a Forge limited key is bound to the forge \
                     contracts)"
                        .into(),
                )
            })?;
        let mut signer = KeyRing::default();
        signer.add(&secret, self.network());
        let result = self
            .sdk()
            .register_dpns_name(RegisterDpnsNameInput {
                label: label.to_string(),
                identity,
                identity_public_key: on_chain,
                signer,
                preorder_callback: None,
                // Contested (short) names: state the fund to join the SDK reads just before
                // submitting the domain (beta.5 default, PV14 contender pricing).
                contest_fund: None,
            })
            .await
            .map_err(|e| sdk_err("registering the name", e))?;
        // The SDK reports the homograph-safe form (`alice` → `a11ce.dash`); the name as
        // registered and displayed is the label as given.
        let _ = result.full_domain_name;
        Ok(format!("{label}.dash"))
    }
}

impl LoadedIdentity {
    /// The id the next key added to this identity gets (one past the highest).
    pub fn next_key_id(&self) -> u32 {
        self.0.public_keys().keys().max().map_or(0, |m| m + 1)
    }

    /// Whether key `key_id` is a live Forge limited key: AUTHENTICATION / HIGH, bound to a
    /// contract group, with a budget. Only such keys are renewed over or disabled by `dg auth`
    /// without `--force`.
    pub fn is_limited_key(&self, key_id: u32) -> bool {
        use dash_sdk::dpp::identity::identity_public_key::accessors::v1::IdentityPublicKeyGettersV1;
        self.0.public_keys().get(&key_id).is_some_and(|k| {
            !k.is_disabled()
                && k.purpose() == Purpose::AUTHENTICATION
                && k.security_level() == SecurityLevel::HIGH
                && matches!(
                    k.contract_bounds(),
                    Some(ContractBounds::ContractGroup { .. })
                )
                && k.total_budget().is_some()
        })
    }

    /// The contract group key `key_id` is bound to (base58), if it is group-bound.
    pub fn key_group(&self, key_id: u32) -> Option<String> {
        match self.0.public_keys().get(&key_id)?.contract_bounds()? {
            ContractBounds::ContractGroup { id } => Some(id.to_string(Encoding::Base58)),
            _ => None,
        }
    }

    /// Whether key `key_id` is live and exactly what `spec` asks for: AUTHENTICATION / HIGH,
    /// bound to `(spec.contract, spec.document_type)`, with `spec`'s budget and expiry, and
    /// controlled by `wif`.
    pub fn check_doc_type_key(
        &self,
        key_id: u32,
        wif: &str,
        network: &Network,
        spec: &DocTypeKeySpec,
    ) -> Result<()> {
        use dash_sdk::dpp::identity::identity_public_key::accessors::v1::IdentityPublicKeyGettersV1;
        let bad = |why: &str| Error::Platform(format!("key {key_id} on {}: {why}", self.id()));
        let k = self
            .0
            .public_keys()
            .get(&key_id)
            .ok_or_else(|| bad("not on the identity"))?;
        if k.is_disabled() {
            return Err(bad("disabled"));
        }
        if k.purpose() != Purpose::AUTHENTICATION || k.security_level() != SecurityLevel::HIGH {
            return Err(bad("not an AUTHENTICATION / HIGH key"));
        }
        if self.key_doc_type(key_id) != Some((spec.contract.clone(), spec.document_type.clone())) {
            return Err(bad("not bound to the requested document type"));
        }
        if k.total_budget() != Some(spec.budget_credits)
            || k.expires_at() != Some(spec.expires_at_ms)
        {
            return Err(bad("its budget or expiry differs from what was requested"));
        }
        if self.key_id_for(wif, network) != Some(key_id) {
            return Err(bad("the private key does not control it"));
        }
        Ok(())
    }

    /// The `(contract, document type)` key `key_id` is bound to (base58 contract id), if it is
    /// bound to one document type.
    pub fn key_doc_type(&self, key_id: u32) -> Option<(String, String)> {
        match self.0.public_keys().get(&key_id)?.contract_bounds()? {
            ContractBounds::SingleContractDocumentType {
                id,
                document_type_name,
            } => Some((id.to_string(Encoding::Base58), document_type_name.clone())),
            _ => None,
        }
    }

    /// The id of the live key `bridge` signs documents with, if this identity has it.
    pub fn signing_key_id(&self, bridge: &BridgeIdentity, network: &Network) -> Option<u32> {
        bridge
            .doc_op_key()
            .ok()
            .and_then(|k| self.key_id_for(k.private_key_wif.expose(), network))
    }

    /// The id of the live key `wif` controls, if this identity has one.
    pub fn key_id_for(&self, wif: &str, network: &Network) -> Option<u32> {
        let public = public_key_hex(wif, network).ok()?;
        self.0
            .public_keys()
            .values()
            .find(|k| !k.is_disabled() && hex::encode(k.data().as_slice()) == public)
            .map(IdentityPublicKeyGettersV0::id)
    }

    /// Check that key `key_id` is what a Forge limited key must be: live, AUTHENTICATION /
    /// HIGH, bound to `spec.group`, with exactly `spec`'s budget and expiry, and controlled by
    /// `wif`.
    pub fn check_limited_key(
        &self,
        key_id: u32,
        wif: &str,
        network: &Network,
        spec: &LimitedKeySpec,
    ) -> Result<()> {
        use dash_sdk::dpp::identity::identity_public_key::accessors::v1::IdentityPublicKeyGettersV1;
        let bad = |why: &str| Error::Platform(format!("key {key_id} on {}: {why}", self.id()));
        let k = self
            .0
            .public_keys()
            .get(&key_id)
            .ok_or_else(|| bad("not on the identity"))?;
        if k.is_disabled() {
            return Err(bad("disabled"));
        }
        if k.purpose() != Purpose::AUTHENTICATION || k.security_level() != SecurityLevel::HIGH {
            return Err(bad("not an AUTHENTICATION / HIGH key"));
        }
        if self.key_group(key_id).as_deref() != Some(spec.group.as_str()) {
            return Err(bad("not bound to the dash-forge contract group"));
        }
        if k.total_budget() != Some(spec.budget_credits)
            || k.expires_at() != Some(spec.expires_at_ms)
        {
            return Err(bad("its budget or expiry differs from what was requested"));
        }
        if self.key_id_for(wif, network) != Some(key_id) {
            return Err(bad("the stored private key does not control it"));
        }
        Ok(())
    }
}

/// What a contract group holds ([`PlatformClient::contract_group_members`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GroupMembers {
    /// Whole contracts, base58.
    pub contracts: Vec<String>,
    /// Individual document-type members: (contract, document type name).
    pub document_types: Vec<(String, String)>,
    /// Token members: (contract, token position).
    pub tokens: Vec<(String, u16)>,
}

/// Who may add members to a contract group ([`PlatformClient::contract_group_info`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupOwnership {
    /// The identity that registered the group and owns it (base58).
    pub owner: String,
    /// Identities that may add members besides the owner (base58); empty for a single owner.
    pub admins: Vec<String>,
}

/// What a key added by [`PlatformClient::update_identity_keys`] is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeySpec {
    /// A Forge limited key (AUTHENTICATION / HIGH, group-bound, budget + expiry).
    Limited(LimitedKeySpec),
    /// A key for one document type only (AUTHENTICATION / HIGH, budget + expiry): a CI
    /// runner's `checkRun` key.
    DocumentType(DocTypeKeySpec),
    /// An ENCRYPTION / MEDIUM key (private repositories).
    Encryption,
}

/// Whether `label` is a valid DPNS label, and whether it is contested (short names that go to
/// a masternode vote and cost more): `(valid, contested)`.
pub fn dpns_label_kind(label: &str) -> (bool, bool) {
    (is_valid_username(label), is_contested_username(label))
}

/// The homograph-safe form DPNS compares names in (`Alice` → `a11ce`).
pub fn dpns_normalize(label: &str) -> String {
    convert_to_homograph_safe_chars(label)
}

/// The public key (hex) a WIF controls, for display and matching.
pub fn public_key_hex(wif: &str, network: &Network) -> Result<String> {
    let secret = secret_from_wif(wif, network)?;
    Ok(hex::encode(public_of(&secret).to_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ABANDON: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    fn testnet() -> Network {
        Network::Testnet
    }

    #[test]
    fn mnemonics_are_twelve_valid_words() {
        let m = new_mnemonic().unwrap();
        assert_eq!(m.expose().split(' ').count(), 12);
        assert!(normalize_mnemonic(m.expose()).is_ok());
        assert_eq!(
            normalize_mnemonic("  Abandon abandon ABANDON abandon abandon abandon abandon abandon abandon abandon abandon about ")
                .unwrap()
                .expose(),
            ABANDON
        );
        assert!(normalize_mnemonic("abandon abandon abandon").is_err());
    }

    #[test]
    fn keys_derive_on_the_shared_paths() {
        let keys = NewIdentityKeys::from_mnemonic(&Secret::new(ABANDON), &testnet()).unwrap();
        let bridge = keys.to_bridge("X");
        assert_eq!(bridge.identity_keys.len(), 5);
        assert_eq!(
            bridge.identity_keys[0].derivation_path,
            "m/9'/1'/5'/0'/0'/0'/0'"
        );
        assert_eq!(bridge.identity_keys[4].purpose, "ENCRYPTION");
        assert_eq!(bridge.asset_lock_key.derivation_path, "m/44'/1'/0'/0/0");
        // The same keys tools/mint-identity (and so the bridge and the web app) derive from
        // the "abandon…about" phrase on testnet.
        assert_eq!(keys.deposit_address(), "yRd4FhXfVGHXpsuZXPNkMrfD9GVj46pnjt");
        let pubs: Vec<&str> = bridge
            .identity_keys
            .iter()
            .map(|k| k.public_key_hex.as_str())
            .collect();
        assert_eq!(
            pubs,
            [
                "03a00f4853081aeb8c9debe37267303fa133bd7f6678bfb3299dfa001bfd0341db",
                "03280859fd14d1b8a7a75d918dd0a1bf922be5af7eff9aafa26f446ea5f16da616",
                "02cb109b54e542efbb86f3e5ba1d6a2da97d02cc4de0c706c23ab8ddb53ff7fe3e",
                "02711df617d984f97ad43dfb5eab5e780055f4a4dd68a1d95fe708ae1e9c9e17aa",
                "03d3c6c2629ff5c15703717a7a14c8a01b04b55dbf511cafc58d96519206f0213c",
            ]
        );
        // Deterministic: the same words give the same keys.
        let again = NewIdentityKeys::from_mnemonic(&Secret::new(ABANDON), &testnet()).unwrap();
        assert_eq!(
            again.master_key().public_key_hex,
            keys.master_key().public_key_hex
        );
        // Mainnet uses coin type 5.
        let main =
            NewIdentityKeys::from_mnemonic(&Secret::new(ABANDON), &Network::Mainnet).unwrap();
        assert!(main.deposit_address().starts_with('X'));
    }

    #[test]
    fn debug_output_never_shows_keys() {
        let keys = NewIdentityKeys::from_mnemonic(&Secret::new(ABANDON), &testnet()).unwrap();
        let d = format!("{keys:?}");
        assert!(!d.contains("abandon"));
        let f = FreshKey::generate(&testnet());
        assert_eq!(format!("{f:?}"), "FreshKey(<redacted>)");
    }

    #[test]
    fn an_asset_lock_spends_the_deposit_into_one_credit_output() {
        let keys = NewIdentityKeys::from_mnemonic(&Secret::new(ABANDON), &testnet()).unwrap();
        let utxos = [VerifiedUtxo {
            txid: "11".repeat(32),
            vout: 1,
            duffs: 5_000_000,
        }];
        let lock = build_asset_lock(&keys, &utxos).unwrap();
        let tx: Transaction = deserialize(&lock.raw).unwrap();
        assert_eq!(tx.version, 3);
        assert_eq!(lock.locked_duffs, 5_000_000 - 1_000);
        assert_eq!(tx.txid().to_string(), lock.txid);
        let Some(TransactionPayload::AssetLockPayloadType(p)) = &tx.special_transaction_payload
        else {
            panic!("not an asset lock");
        };
        assert_eq!(p.credit_outputs.len(), 1);
        assert_eq!(p.credit_outputs[0].value, lock.locked_duffs);
        assert!(!tx.input[0].script_sig.is_empty(), "inputs are signed");
        assert!(build_asset_lock(&keys, &[]).is_err());
        let dust = [VerifiedUtxo {
            txid: "22".repeat(32),
            vout: 0,
            duffs: 500,
        }];
        assert!(build_asset_lock(&keys, &dust).is_err());
    }

    #[test]
    fn deposits_are_checked_against_the_raw_transaction() {
        let keys = NewIdentityKeys::from_mnemonic(&Secret::new(ABANDON), &testnet()).unwrap();
        // Use the asset lock itself as a "raw transaction" whose output 0 pays OP_RETURN.
        let lock = build_asset_lock(
            &keys,
            &[VerifiedUtxo {
                txid: "33".repeat(32),
                vout: 0,
                duffs: 3_000_000,
            }],
        )
        .unwrap();
        let addr = keys.deposit_address();
        assert!(verify_deposit(&lock.raw, &lock.txid, 0, &addr)
            .unwrap_err()
            .to_string()
            .contains("does not pay"));
        assert!(verify_deposit(&lock.raw, &"44".repeat(32), 0, &addr)
            .unwrap_err()
            .to_string()
            .contains("is not"));
    }

    #[test]
    fn chain_proofs_name_the_identity_they_create() {
        let proof = LockProof::Chain {
            txid: "55".repeat(32),
            height: 100,
        };
        let a = identity_id_for(&proof).unwrap();
        assert_eq!(a, identity_id_for(&proof).unwrap());
        assert!((40..=44).contains(&a.len()));
    }

    #[test]
    fn wifs_are_checked_against_the_network() {
        let f = FreshKey::generate(&testnet());
        assert!(secret_from_wif(f.wif().expose(), &testnet()).is_ok());
        assert!(secret_from_wif(f.wif().expose(), &Network::Mainnet).is_err());
        assert!(secret_from_wif("not a wif", &testnet()).is_err());
    }

    #[test]
    fn dpns_labels() {
        assert_eq!(dpns_label_kind("alice"), (true, true));
        assert_eq!(dpns_label_kind("alice-the-developer-2"), (true, false));
        assert!(!dpns_label_kind("a").0);
        assert_eq!(dpns_normalize("Alice"), "a11ce");
    }
}
