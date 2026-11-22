//! The verifier (`verify.ts`): whether one `loginKeyResponse` is a valid grant for the request
//! it answers.
//!
//! It accepts only when every slot is a live key on the candidate's `$ownerId` that matches one
//! requested binding exactly (bounds, purpose, level, limits), the primary binding is granted,
//! no key is about to expire or out of budget, and each encryption key is the one Platform
//! currently resolves for its contract. Anything else rejects the whole candidate: there is no
//! partial accept of a response that holds a key the app did not ask for.
//!
//! An accepted grant comes from [`Grant::identity_id`], not necessarily from the user: anyone
//! can answer a request with their own identity.

use std::collections::BTreeMap;

use async_trait::async_trait;

use super::request::{AuthBinding, BindingKind, Request};
use super::{crypto, hash160, key_type, level, public_key_of, purpose, ChainKey, Id, SecretBytes};
use crate::Result;

/// A granted key must stay valid this long past `now` to be accepted.
pub const EXPIRY_MARGIN_MS: u64 = 60 * 60_000;

/// The identity reads the verifier needs. Every read should be proved, and
/// [`IdentityPort::identity_keys`] must bypass any identity cache: a key added moments ago is
/// exactly what is being checked.
#[async_trait]
pub trait IdentityPort: Send + Sync {
    /// The keys of `identity_id`, or `None` when the identity does not exist.
    async fn identity_keys(&self, identity_id: &Id) -> Result<Option<Vec<ChainKey>>>;

    /// What is left of each key's budget; a key without a budget, or unknown, is absent.
    async fn remaining_budgets(
        &self,
        identity_id: &Id,
        key_ids: &[u32],
    ) -> Result<BTreeMap<u32, u64>>;

    /// The keys Platform currently resolves for `contract_id` and `purpose`
    /// (`identities.contractKeys`). Only asked for when the request has encryption bindings.
    async fn contract_keys(
        &self,
        identity_id: &Id,
        contract_id: &Id,
        purpose: u8,
    ) -> Result<Vec<ChainKey>>;
}

/// One `loginKeyResponse` entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    /// The identity that published it.
    pub owner_id: Id,
    /// The wallet's ephemeral public key.
    pub wallet_ephemeral_pub_key: Vec<u8>,
    /// The sealed slots.
    pub encrypted_payload: Vec<u8>,
}

/// Why a candidate was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RejectReason {
    /// The request named an identity and the candidate is someone else.
    HintMismatch,
    /// The payload's length is not `28 + 32n` with `1 <= n <= 17`.
    Framing,
    /// The payload opened but holds more keys than the request has bindings. `verify.ts` calls
    /// this `framing` too; it is separate here so a poll counts the identity as having answered
    /// (it opened with this request's key) instead of skipping it as not an answer.
    ExtraKeys,
    /// Wrong request, wrong owner (a copied response) or tampered ciphertext.
    Decrypt,
    /// A slot is not a private key.
    InvalidKey,
    /// The identity cannot be read (yet).
    IdentityNotFound,
    /// A slot's key is not on the candidate identity (yet).
    KeyNotFound,
    /// The key is disabled.
    KeyDisabled,
    /// A MASTER key.
    KeyMaster,
    /// Not an AUTHENTICATION, ENCRYPTION or DECRYPTION key.
    KeyPurpose,
    /// A key type the binding cannot use.
    KeyType,
    /// The key has no contract bounds.
    KeyUnbound,
    /// Bound to something the request did not ask for (foreign contract, wrong group or type).
    KeyUnmatched,
    /// A security level the binding does not allow.
    KeyLevel,
    /// Missing the budget or expiry the request asked for, or the group key's mandatory budget.
    KeyLimits,
    /// Expired, or expires within the margin.
    KeyExpired,
    /// The budget is spent.
    BudgetExhausted,
    /// Platform returned no remaining budget for a budgeted key (a lagging read).
    BudgetUnknown,
    /// The encryption key is not the one Platform resolves for its contract (yet).
    EncryptionKeyNotCurrent,
    /// One key twice, or two keys for one binding.
    DuplicateBinding,
    /// The first binding is not granted.
    PrimaryMissing,
}

impl From<crypto::PayloadError> for RejectReason {
    fn from(e: crypto::PayloadError) -> Self {
        match e {
            crypto::PayloadError::Framing => Self::Framing,
            crypto::PayloadError::Decrypt => Self::Decrypt,
        }
    }
}

impl RejectReason {
    /// Whether the identity read may lag the wallet's update: check again shortly.
    pub fn retryable(self) -> bool {
        matches!(
            self,
            Self::IdentityNotFound
                | Self::KeyNotFound
                | Self::BudgetUnknown
                | Self::EncryptionKeyNotCurrent
        )
    }
}

/// A rejected candidate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rejection {
    /// Why.
    pub reason: RejectReason,
    /// The slot that failed, when one did.
    pub slot: Option<usize>,
}

impl Rejection {
    fn new(reason: RejectReason) -> Self {
        Self { reason, slot: None }
    }

    fn at(reason: RejectReason, slot: usize) -> Self {
        Self {
            reason,
            slot: Some(slot),
        }
    }

    /// See [`RejectReason::retryable`].
    pub fn retryable(&self) -> bool {
        self.reason.retryable()
    }
}

/// What a granted key is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyRole {
    /// An AUTHENTICATION key for one contract.
    SingleContract,
    /// An AUTHENTICATION key for one document type.
    DocumentType,
    /// An AUTHENTICATION key for a contract group.
    ContractGroup,
    /// An ENCRYPTION key.
    Encryption,
    /// A DECRYPTION key.
    Decryption,
}

impl KeyRole {
    fn is_auth(self) -> bool {
        !matches!(self, Self::Encryption | Self::Decryption)
    }

    fn of(kind: BindingKind) -> Self {
        match kind {
            BindingKind::SingleContract => Self::SingleContract,
            BindingKind::DocumentType => Self::DocumentType,
            BindingKind::ContractGroup => Self::ContractGroup,
        }
    }
}

/// One verified key of a grant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrantedKey {
    /// What it is for.
    pub role: KeyRole,
    /// The index of its binding in `auth_bindings` or `enc_bindings`.
    pub binding_index: usize,
    /// The private key.
    pub private_key: SecretBytes,
    /// The key as the chain holds it.
    pub key: ChainKey,
    /// What is left of its budget, for a budgeted key.
    pub remaining_budget: Option<u64>,
}

/// A verified grant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grant {
    /// The identity that granted the keys.
    pub identity_id: Id,
    /// The AUTHENTICATION keys, in slot order.
    pub auth_keys: Vec<GrantedKey>,
    /// The ENCRYPTION / DECRYPTION keys, in slot order.
    pub encryption_keys: Vec<GrantedKey>,
}

/// The verifier's verdict.
pub type Verification = std::result::Result<Grant, Rejection>;

/// What a grant is checked against.
pub struct VerifyContext<'a> {
    /// The request the keys answer.
    pub request: &'a Request,
    /// The chain reads.
    pub identity: &'a dyn IdentityPort,
    /// The latest block time (ms), or the wall clock when that is unavailable.
    pub now_ms: u64,
    /// How long a key must stay valid past `now_ms` ([`EXPIRY_MARGIN_MS`] by default).
    pub expiry_margin_ms: u64,
}

/// Verify one candidate against the request it answers. `Err` is a failed chain read only.
pub async fn verify_candidate(
    ctx: &VerifyContext<'_>,
    app_ephemeral_secret: &SecretBytes,
    candidate: &Candidate,
) -> Result<Verification> {
    if ctx
        .request
        .identity_hint
        .is_some_and(|hint| hint != candidate.owner_id)
    {
        return Ok(Err(Rejection::new(RejectReason::HintMismatch)));
    }
    let slots = match crypto::open(
        app_ephemeral_secret,
        &candidate.owner_id,
        &candidate.wallet_ephemeral_pub_key,
        &candidate.encrypted_payload,
    ) {
        Ok(slots) => slots,
        Err(e) => return Ok(Err(Rejection::new(e.into()))),
    };
    verify_keys(ctx, &candidate.owner_id, slots).await
}

/// Verify private keys kept from an earlier grant exactly as [`verify_candidate`] verifies a
/// wallet's answer, against the request the app makes today. A refusal says why, so an expired
/// or spent grant can lead to a renewal rather than a dead session.
pub async fn verify_keys(
    ctx: &VerifyContext<'_>,
    owner_id: &Id,
    slots: Vec<SecretBytes>,
) -> Result<Verification> {
    let request = ctx.request;
    if slots.len() > request.auth_bindings.len() + request.enc_bindings.len() {
        return Ok(Err(Rejection::new(RejectReason::ExtraKeys)));
    }
    let Some(keys) = ctx.identity.identity_keys(owner_id).await? else {
        return Ok(Err(Rejection::new(RejectReason::IdentityNotFound)));
    };

    let mut matches: Vec<GrantedKey> = Vec::with_capacity(slots.len());
    for (slot, private_key) in slots.into_iter().enumerate() {
        let checked = find_key_for_slot(&keys, &private_key, slot).and_then(|key| {
            let (role, binding_index) = match_binding(request, key, slot)?;
            check_key_limits(ctx, key, role, binding_index, slot)?;
            Ok((key, role, binding_index))
        });
        let (key, role, binding_index) = match checked {
            Ok(m) => m,
            Err(rejection) => return Ok(Err(rejection)),
        };
        if matches
            .iter()
            .any(|m| m.key.id == key.id || (m.role == role && m.binding_index == binding_index))
        {
            return Ok(Err(Rejection::at(RejectReason::DuplicateBinding, slot)));
        }
        matches.push(GrantedKey {
            role,
            binding_index,
            private_key,
            key: key.clone(),
            remaining_budget: None,
        });
    }

    if !matches
        .iter()
        .any(|m| m.role.is_auth() && m.binding_index == 0)
    {
        return Ok(Err(Rejection::new(RejectReason::PrimaryMissing)));
    }

    for (slot, m) in matches
        .iter()
        .enumerate()
        .filter(|(_, m)| !m.role.is_auth())
    {
        let binding = &request.enc_bindings[m.binding_index];
        let current = ctx
            .identity
            .contract_keys(owner_id, &binding.contract_id, binding.purpose)
            .await?;
        if !current
            .iter()
            .any(|k| k.id == m.key.id && k.data == m.key.data)
        {
            return Ok(Err(Rejection::at(
                RejectReason::EncryptionKeyNotCurrent,
                slot,
            )));
        }
    }

    let budgeted: Vec<u32> = matches
        .iter()
        .filter(|m| m.key.total_budget.is_some())
        .map(|m| m.key.id)
        .collect();
    let remaining = if budgeted.is_empty() {
        BTreeMap::new()
    } else {
        ctx.identity.remaining_budgets(owner_id, &budgeted).await?
    };
    for (slot, m) in matches.iter_mut().enumerate() {
        m.remaining_budget = remaining.get(&m.key.id).copied();
        if m.key.total_budget.is_none() {
            continue;
        }
        match m.remaining_budget {
            None => return Ok(Err(Rejection::at(RejectReason::BudgetUnknown, slot))),
            Some(0) => return Ok(Err(Rejection::at(RejectReason::BudgetExhausted, slot))),
            Some(_) => {}
        }
    }

    let (auth_keys, encryption_keys) = matches.into_iter().partition(|m| m.role.is_auth());
    Ok(Ok(Grant {
        identity_id: *owner_id,
        auth_keys,
        encryption_keys,
    }))
}

fn find_key_for_slot<'k>(
    keys: &'k [ChainKey],
    private_key: &SecretBytes,
    slot: usize,
) -> std::result::Result<&'k ChainKey, Rejection> {
    let public =
        public_key_of(private_key.expose()).ok_or(Rejection::at(RejectReason::InvalidKey, slot))?;
    let hash = hash160(&public);
    let mut found = keys.iter().filter(|k| {
        (k.key_type == key_type::ECDSA_SECP256K1 && k.data == public)
            || (k.key_type == key_type::ECDSA_HASH160 && k.data == hash)
    });
    match (found.next(), found.next()) {
        (Some(key), None) => Ok(key),
        (None, _) => Err(Rejection::at(RejectReason::KeyNotFound, slot)),
        (Some(_), Some(_)) => Err(Rejection::at(RejectReason::DuplicateBinding, slot)),
    }
}

fn match_binding(
    request: &Request,
    key: &ChainKey,
    slot: usize,
) -> std::result::Result<(KeyRole, usize), Rejection> {
    let reject = |reason| Err(Rejection::at(reason, slot));
    if key.disabled {
        return reject(RejectReason::KeyDisabled);
    }
    if key.security_level == level::MASTER {
        return reject(RejectReason::KeyMaster);
    }
    let is_auth = key.purpose == purpose::AUTHENTICATION;
    if !is_auth && key.purpose != purpose::ENCRYPTION && key.purpose != purpose::DECRYPTION {
        return reject(RejectReason::KeyPurpose);
    }
    let Some(bounds) = &key.bounds else {
        return reject(RejectReason::KeyUnbound);
    };

    if is_auth {
        let Some(index) = request
            .auth_bindings
            .iter()
            .position(|b| b.bounds() == *bounds)
        else {
            return reject(RejectReason::KeyUnmatched);
        };
        let binding = &request.auth_bindings[index];
        if !auth_level_allowed(binding, key.security_level) {
            return reject(RejectReason::KeyLevel);
        }
        if key.key_type != key_type::ECDSA_SECP256K1 && key.key_type != key_type::ECDSA_HASH160 {
            return reject(RejectReason::KeyType);
        }
        return Ok((KeyRole::of(binding.kind), index));
    }

    let Some(index) = request
        .enc_bindings
        .iter()
        .position(|b| b.purpose == key.purpose && b.bounds() == *bounds)
    else {
        return reject(RejectReason::KeyUnmatched);
    };
    if key.security_level != level::MEDIUM {
        return reject(RejectReason::KeyLevel);
    }
    // Peers need the full point for ECDH, so a hash-only key is useless here.
    if key.key_type != key_type::ECDSA_SECP256K1 {
        return reject(RejectReason::KeyType);
    }
    let role = if key.purpose == purpose::ENCRYPTION {
        KeyRole::Encryption
    } else {
        KeyRole::Decryption
    };
    Ok((role, index))
}

/// A group key may be CRITICAL or HIGH and never more privileged than asked; everything else is
/// exactly HIGH. (Lower numbers are more privileged.)
fn auth_level_allowed(binding: &AuthBinding, l: u8) -> bool {
    if binding.kind == BindingKind::ContractGroup {
        (l == level::CRITICAL || l == level::HIGH) && l >= binding.security_level
    } else {
        l == level::HIGH
    }
}

fn check_key_limits(
    ctx: &VerifyContext<'_>,
    key: &ChainKey,
    role: KeyRole,
    binding_index: usize,
    slot: usize,
) -> std::result::Result<(), Rejection> {
    if role.is_auth() {
        let binding = &ctx.request.auth_bindings[binding_index];
        // The wallet may change the values (clamps, presets) but never drop a limit.
        let budget_required =
            binding.kind == BindingKind::ContractGroup || binding.total_budget.is_some();
        if budget_required && key.total_budget.unwrap_or(0) == 0 {
            return Err(Rejection::at(RejectReason::KeyLimits, slot));
        }
        if binding.expires_at_ms.is_some() && key.expires_at_ms.is_none() {
            return Err(Rejection::at(RejectReason::KeyLimits, slot));
        }
    }
    if key
        .expires_at_ms
        .is_some_and(|e| e <= ctx.now_ms.saturating_add(ctx.expiry_margin_ms))
    {
        return Err(Rejection::at(RejectReason::KeyExpired, slot));
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::test_vectors::{
        dashpay, secret, seed, slot_seeds, yappr_request, NINETY_DAYS_MS, VECTOR_CREATED_AT,
    };
    use super::super::KeyBounds;
    use super::*;
    use std::collections::HashMap;

    pub const EXPIRES_AT: u64 = VECTOR_CREATED_AT + NINETY_DAYS_MS;
    pub const NOW: u64 = VECTOR_CREATED_AT + 60_000;

    pub fn pub_of(label: &str) -> Vec<u8> {
        public_key_of(&seed(label)).unwrap().to_vec()
    }

    pub fn group_key() -> ChainKey {
        ChainKey {
            id: 5,
            key_type: key_type::ECDSA_HASH160,
            purpose: purpose::AUTHENTICATION,
            security_level: level::CRITICAL,
            data: hash160(&pub_of("slot group key")).to_vec(),
            disabled: false,
            bounds: Some(KeyBounds::ContractGroup {
                group_id: seed("group id"),
            }),
            total_budget: Some(50_000_000_000),
            expires_at_ms: Some(EXPIRES_AT),
        }
    }

    fn profile_key() -> ChainKey {
        ChainKey {
            id: 6,
            key_type: key_type::ECDSA_SECP256K1,
            purpose: purpose::AUTHENTICATION,
            security_level: level::HIGH,
            data: pub_of("slot dashpay profile key"),
            disabled: false,
            bounds: Some(KeyBounds::DocumentType {
                contract_id: dashpay(),
                document_type_name: "profile".into(),
            }),
            total_budget: Some(1_000_000_000),
            expires_at_ms: Some(EXPIRES_AT),
        }
    }

    fn encryption_key() -> ChainKey {
        ChainKey {
            id: 7,
            key_type: key_type::ECDSA_SECP256K1,
            purpose: purpose::ENCRYPTION,
            security_level: level::MEDIUM,
            data: pub_of("slot encryption key"),
            disabled: false,
            bounds: Some(KeyBounds::SingleContract {
                contract_id: seed("app id"),
            }),
            total_budget: None,
            expires_at_ms: None,
        }
    }

    fn master_key() -> ChainKey {
        ChainKey {
            id: 0,
            key_type: key_type::ECDSA_SECP256K1,
            purpose: purpose::AUTHENTICATION,
            security_level: level::MASTER,
            data: pub_of("master"),
            disabled: false,
            bounds: None,
            total_budget: None,
            expires_at_ms: None,
        }
    }

    /// An in-memory chain: identities, budgets and the current encryption keys.
    #[derive(Default)]
    pub struct FakeChain {
        pub identities: HashMap<Id, Vec<ChainKey>>,
        pub budgets: BTreeMap<u32, u64>,
        pub current_encryption_keys: Vec<ChainKey>,
    }

    impl FakeChain {
        /// The budgets Platform reports for `key_ids`.
        pub fn remaining(&self, key_ids: &[u32]) -> BTreeMap<u32, u64> {
            key_ids
                .iter()
                .filter_map(|k| self.budgets.get(k).map(|b| (*k, *b)))
                .collect()
        }
    }

    #[async_trait]
    impl IdentityPort for FakeChain {
        async fn identity_keys(&self, id: &Id) -> Result<Option<Vec<ChainKey>>> {
            Ok(self.identities.get(id).cloned())
        }

        async fn remaining_budgets(&self, _: &Id, key_ids: &[u32]) -> Result<BTreeMap<u32, u64>> {
            Ok(self.remaining(key_ids))
        }

        async fn contract_keys(&self, id: &Id, contract: &Id, p: u8) -> Result<Vec<ChainKey>> {
            Ok(
                if *id == seed("owner") && *contract == seed("app id") && p == purpose::ENCRYPTION {
                    self.current_encryption_keys.clone()
                } else {
                    vec![]
                },
            )
        }
    }

    struct Scenario {
        request: Request,
        slots: Vec<[u8; 32]>,
        sealed_for: Id,
        published_as: Id,
        chain: FakeChain,
        now: u64,
    }

    impl Scenario {
        fn with_keys(keys: Vec<ChainKey>) -> Self {
            let mut s = Self::default();
            s.chain.identities.insert(seed("owner"), keys);
            s
        }
    }

    impl Default for Scenario {
        fn default() -> Self {
            let mut chain = FakeChain {
                budgets: BTreeMap::from([(5, 49_000_000_000), (6, 900_000_000)]),
                current_encryption_keys: vec![encryption_key()],
                ..FakeChain::default()
            };
            chain.identities.insert(
                seed("owner"),
                vec![master_key(), group_key(), profile_key(), encryption_key()],
            );
            Self {
                request: yappr_request(),
                slots: slot_seeds().to_vec(),
                sealed_for: seed("owner"),
                published_as: seed("owner"),
                chain,
                now: NOW,
            }
        }
    }

    async fn verify(s: Scenario) -> Verification {
        let (wallet, payload) = crypto::seal_with(
            &s.request.app_ephemeral_pub_key,
            &s.sealed_for,
            &s.slots,
            &secret("wallet ephemeral"),
            [3; 12],
        )
        .unwrap();
        let ctx = VerifyContext {
            request: &s.request,
            identity: &s.chain,
            now_ms: s.now,
            expiry_margin_ms: EXPIRY_MARGIN_MS,
        };
        let candidate = Candidate {
            owner_id: s.published_as,
            wallet_ephemeral_pub_key: wallet.to_vec(),
            encrypted_payload: payload,
        };
        verify_candidate(&ctx, &SecretBytes::new(seed("app ephemeral")), &candidate)
            .await
            .unwrap()
    }

    fn rejected(v: Verification) -> Rejection {
        v.expect_err("expected a rejection")
    }

    #[tokio::test]
    async fn accepts_the_full_yappr_grant_and_classifies_each_key() {
        let grant = verify(Scenario::default()).await.unwrap();
        assert_eq!(grant.identity_id, seed("owner"));
        let auth: Vec<_> = grant
            .auth_keys
            .iter()
            .map(|k| (k.role, k.key.id, k.remaining_budget))
            .collect();
        assert_eq!(
            auth,
            [
                (KeyRole::ContractGroup, 5, Some(49_000_000_000)),
                (KeyRole::DocumentType, 6, Some(900_000_000))
            ]
        );
        let enc: Vec<_> = grant
            .encryption_keys
            .iter()
            .map(|k| (k.role, k.key.id))
            .collect();
        assert_eq!(enc, [(KeyRole::Encryption, 7)]);
        assert_eq!(
            grant.auth_keys[0].private_key.expose(),
            &seed("slot group key")
        );
    }

    #[tokio::test]
    async fn accepts_a_partial_grant_that_keeps_the_primary_binding_in_any_order() {
        let s = Scenario {
            slots: vec![seed("slot encryption key"), seed("slot group key")],
            ..Scenario::default()
        };
        let grant = verify(s).await.unwrap();
        let roles: Vec<_> = grant.auth_keys.iter().map(|k| k.role).collect();
        assert_eq!(roles, [KeyRole::ContractGroup]);
    }

    #[tokio::test]
    async fn accepts_a_high_group_key_when_critical_was_asked() {
        let mut g = group_key();
        g.security_level = level::HIGH;
        assert!(verify(Scenario::with_keys(vec![
            g,
            profile_key(),
            encryption_key()
        ]))
        .await
        .is_ok());
    }

    #[tokio::test]
    async fn matches_both_hash160_and_secp256k1_key_data() {
        let mut g = group_key();
        g.key_type = key_type::ECDSA_SECP256K1;
        g.data = pub_of("slot group key");
        let mut p = profile_key();
        p.key_type = key_type::ECDSA_HASH160;
        p.data = hash160(&pub_of("slot dashpay profile key")).to_vec();
        assert!(verify(Scenario::with_keys(vec![g, p, encryption_key()]))
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn refuses_hash160_key_data_of_the_wrong_length() {
        for len in [0usize, 1, 19, 21, 33, 65] {
            let mut g = group_key();
            let mut data = vec![0u8; len];
            let n = len.min(g.data.len());
            data[..n].copy_from_slice(&g.data[..n]);
            g.data = data;
            let r = rejected(
                verify(Scenario::with_keys(vec![
                    g,
                    profile_key(),
                    encryption_key(),
                ]))
                .await,
            );
            assert_eq!(
                r,
                Rejection::at(RejectReason::KeyNotFound, 0),
                "length {len}"
            );
            assert!(r.retryable());
        }
    }

    #[tokio::test]
    async fn honours_the_identity_hint() {
        let mut s = Scenario::default();
        s.request.identity_hint = Some(seed("owner"));
        assert!(verify(s).await.is_ok());
        let mut s = Scenario::default();
        s.request.identity_hint = Some(seed("stranger"));
        assert_eq!(rejected(verify(s).await).reason, RejectReason::HintMismatch);
    }

    fn with(f: impl FnOnce(&mut ChainKey), make: fn() -> ChainKey) -> ChainKey {
        let mut k = make();
        f(&mut k);
        k
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)] // one table: every rejection reason
    async fn rejects_every_bad_grant_with_its_reason() {
        use RejectReason as R;
        let keys3 = |g: ChainKey, p: ChainKey, e: ChainKey| Scenario::with_keys(vec![g, p, e]);
        let g = group_key;
        let p = profile_key;
        let e = encryption_key;
        let stranger = seed("stranger");
        let cases: Vec<(&str, Scenario, RejectReason)> = vec![
            (
                "a response copied under another identity",
                {
                    let mut s = Scenario {
                        published_as: stranger,
                        ..Scenario::default()
                    };
                    s.chain.identities.insert(stranger, vec![group_key()]);
                    s
                },
                R::Decrypt,
            ),
            (
                "keys that live on another identity",
                {
                    let mut s = Scenario {
                        sealed_for: stranger,
                        published_as: stranger,
                        ..Scenario::default()
                    };
                    s.chain.identities.insert(stranger, vec![master_key()]);
                    s
                },
                R::KeyNotFound,
            ),
            (
                "an identity that cannot be read yet",
                {
                    let mut s = Scenario::default();
                    s.chain.identities.clear();
                    s
                },
                R::IdentityNotFound,
            ),
            (
                "an unregistered key",
                Scenario::with_keys(vec![master_key(), p(), e()]),
                R::KeyNotFound,
            ),
            (
                "a disabled key",
                keys3(with(|k| k.disabled = true, g), p(), e()),
                R::KeyDisabled,
            ),
            (
                "an unbound auth key",
                keys3(with(|k| k.bounds = None, g), p(), e()),
                R::KeyUnbound,
            ),
            (
                "a MASTER key",
                keys3(with(|k| k.security_level = level::MASTER, g), p(), e()),
                R::KeyMaster,
            ),
            (
                "a CRITICAL key on the DashPay binding",
                keys3(g(), with(|k| k.security_level = level::CRITICAL, p), e()),
                R::KeyLevel,
            ),
            (
                "a MEDIUM group key",
                keys3(with(|k| k.security_level = level::MEDIUM, g), p(), e()),
                R::KeyLevel,
            ),
            (
                "a key bound to another group",
                keys3(
                    with(
                        |k| {
                            k.bounds = Some(KeyBounds::ContractGroup {
                                group_id: seed("stranger"),
                            });
                        },
                        g,
                    ),
                    p(),
                    e(),
                ),
                R::KeyUnmatched,
            ),
            (
                "a key bound to another DashPay type",
                keys3(
                    g(),
                    with(
                        |k| {
                            k.bounds = Some(KeyBounds::DocumentType {
                                contract_id: dashpay(),
                                document_type_name: "contactRequest".into(),
                            });
                        },
                        p,
                    ),
                    e(),
                ),
                R::KeyUnmatched,
            ),
            (
                "a key bound to a foreign contract",
                keys3(
                    with(
                        |k| {
                            k.bounds = Some(KeyBounds::SingleContract {
                                contract_id: seed("stranger"),
                            });
                        },
                        g,
                    ),
                    p(),
                    e(),
                ),
                R::KeyUnmatched,
            ),
            (
                "a TRANSFER key",
                keys3(with(|k| k.purpose = purpose::TRANSFER, g), p(), e()),
                R::KeyPurpose,
            ),
            (
                "a key that expires within the margin",
                keys3(
                    with(|k| k.expires_at_ms = Some(NOW + 30 * 60_000), g),
                    p(),
                    e(),
                ),
                R::KeyExpired,
            ),
            (
                "an expired key",
                keys3(with(|k| k.expires_at_ms = Some(NOW - 1), g), p(), e()),
                R::KeyExpired,
            ),
            (
                "a group key without a budget",
                keys3(with(|k| k.total_budget = None, g), p(), e()),
                R::KeyLimits,
            ),
            (
                "a key that dropped the requested budget",
                keys3(g(), with(|k| k.total_budget = None, p), e()),
                R::KeyLimits,
            ),
            (
                "a key that dropped the requested expiry",
                keys3(with(|k| k.expires_at_ms = None, g), p(), e()),
                R::KeyLimits,
            ),
            (
                "a spent budget",
                {
                    let mut s = Scenario::default();
                    s.chain.budgets = BTreeMap::from([(5, 0), (6, 1)]);
                    s
                },
                R::BudgetExhausted,
            ),
            (
                "a budget Platform does not report yet",
                {
                    let mut s = Scenario::default();
                    s.chain.budgets = BTreeMap::from([(6, 1)]);
                    s
                },
                R::BudgetUnknown,
            ),
            (
                "an encryption key that is not current",
                {
                    let mut s = Scenario::default();
                    s.chain.current_encryption_keys = vec![with(
                        |k| {
                            k.id = 9;
                            k.data = pub_of("newer");
                        },
                        e,
                    )];
                    s
                },
                R::EncryptionKeyNotCurrent,
            ),
            (
                "an encryption key at HIGH",
                keys3(g(), p(), with(|k| k.security_level = level::HIGH, e)),
                R::KeyLevel,
            ),
            (
                "a hash-only encryption key",
                keys3(
                    g(),
                    p(),
                    with(
                        |k| {
                            k.key_type = key_type::ECDSA_HASH160;
                            k.data = hash160(&pub_of("slot encryption key")).to_vec();
                        },
                        e,
                    ),
                ),
                R::KeyType,
            ),
            (
                "an unbound encryption key",
                keys3(g(), p(), with(|k| k.bounds = None, e)),
                R::KeyUnbound,
            ),
            (
                "an encryption key bound elsewhere",
                keys3(
                    g(),
                    p(),
                    with(
                        |k| {
                            k.bounds = Some(KeyBounds::SingleContract {
                                contract_id: seed("stranger"),
                            });
                        },
                        e,
                    ),
                ),
                R::KeyUnmatched,
            ),
            (
                "a grant without the primary binding",
                Scenario {
                    slots: vec![
                        seed("slot dashpay profile key"),
                        seed("slot encryption key"),
                    ],
                    ..Scenario::default()
                },
                R::PrimaryMissing,
            ),
            (
                "the same key twice",
                Scenario {
                    slots: vec![seed("slot group key"), seed("slot group key")],
                    ..Scenario::default()
                },
                R::DuplicateBinding,
            ),
            (
                "more slots than bindings",
                Scenario {
                    slots: [slot_seeds().as_slice(), &[seed("extra")]].concat(),
                    ..Scenario::default()
                },
                R::ExtraKeys,
            ),
            (
                "a slot that is not a private key",
                Scenario {
                    slots: vec![seed("slot group key"), [0; 32]],
                    ..Scenario::default()
                },
                R::InvalidKey,
            ),
            (
                "two keys for one binding",
                {
                    let mut s = Scenario::with_keys(vec![
                        group_key(),
                        with(
                            |k| {
                                k.id = 8;
                                k.data = hash160(&pub_of("second group key")).to_vec();
                            },
                            g,
                        ),
                    ]);
                    s.slots = vec![seed("slot group key"), seed("second group key")];
                    s
                },
                R::DuplicateBinding,
            ),
        ];
        for (name, scenario, reason) in cases {
            let r = rejected(verify(scenario).await);
            assert_eq!(r.reason, reason, "{name}");
            assert_eq!(
                r.retryable(),
                matches!(
                    reason,
                    R::KeyNotFound
                        | R::IdentityNotFound
                        | R::BudgetUnknown
                        | R::EncryptionKeyNotCurrent
                ),
                "{name}"
            );
        }
    }

    #[tokio::test]
    async fn reports_which_slot_failed() {
        let s = Scenario::with_keys(vec![
            group_key(),
            with(|k| k.disabled = true, profile_key),
            encryption_key(),
        ]);
        assert_eq!(rejected(verify(s).await).slot, Some(1));
    }

    #[tokio::test]
    async fn rejects_a_critical_group_key_when_only_high_was_asked() {
        let mut s = Scenario::default();
        s.request.auth_bindings[0].security_level = level::HIGH;
        assert_eq!(rejected(verify(s).await).reason, RejectReason::KeyLevel);
    }

    fn kept() -> Vec<SecretBytes> {
        slot_seeds().map(SecretBytes::new).to_vec()
    }

    async fn verify_kept(chain: &FakeChain, owner: Id, margin: u64) -> Verification {
        let request = yappr_request();
        let ctx = VerifyContext {
            request: &request,
            identity: chain,
            now_ms: NOW,
            expiry_margin_ms: margin,
        };
        verify_keys(&ctx, &owner, kept()).await.unwrap()
    }

    #[tokio::test]
    async fn verify_keys_rebuilds_a_kept_grant_from_chain() {
        let chain = Scenario::default().chain;
        let grant = verify_kept(&chain, seed("owner"), EXPIRY_MARGIN_MS)
            .await
            .unwrap();
        let ids: Vec<_> = grant.auth_keys.iter().map(|k| k.key.id).collect();
        assert_eq!(ids, [5, 6]);
        assert_eq!(grant.encryption_keys[0].key.id, 7);
    }

    #[tokio::test]
    async fn verify_keys_says_expired_spent_revoked_or_someone_else() {
        let mut chain = Scenario::with_keys(vec![
            with(|k| k.expires_at_ms = Some(NOW - 1), group_key),
            profile_key(),
            encryption_key(),
        ])
        .chain;
        assert_eq!(
            rejected(verify_kept(&chain, seed("owner"), EXPIRY_MARGIN_MS).await).reason,
            RejectReason::KeyExpired
        );
        chain = Scenario::default().chain;
        chain.budgets = BTreeMap::from([(5, 0), (6, 1)]);
        assert_eq!(
            rejected(verify_kept(&chain, seed("owner"), EXPIRY_MARGIN_MS).await).reason,
            RejectReason::BudgetExhausted
        );
        chain = Scenario::with_keys(vec![
            with(|k| k.disabled = true, group_key),
            profile_key(),
            encryption_key(),
        ])
        .chain;
        assert_eq!(
            rejected(verify_kept(&chain, seed("owner"), EXPIRY_MARGIN_MS).await).reason,
            RejectReason::KeyDisabled
        );
        assert_eq!(
            rejected(verify_kept(&chain, seed("stranger"), EXPIRY_MARGIN_MS).await).reason,
            RejectReason::IdentityNotFound
        );
    }

    #[tokio::test]
    async fn verify_keys_takes_the_callers_expiry_margin() {
        let chain = Scenario::with_keys(vec![
            with(|k| k.expires_at_ms = Some(NOW + 30 * 60_000), group_key),
            profile_key(),
            encryption_key(),
        ])
        .chain;
        assert_eq!(
            rejected(verify_kept(&chain, seed("owner"), EXPIRY_MARGIN_MS).await).reason,
            RejectReason::KeyExpired
        );
        assert!(verify_kept(&chain, seed("owner"), 5 * 60_000).await.is_ok());
    }
}
