//! Forge's App Connect request and rules (`forge-web/lib/auth/app-connect-v2.ts`).
//!
//! One request asks for ONE key: AUTHENTICATION / HIGH, bound to the dash-forge contract group,
//! with a budget and an expiry. It covers every Forge contract, so no further grants are asked
//! for. The request's app is forge-core (its owner is the group's owner, as the profile's owner
//! rule needs), and no encryption key is asked for: no Forge contract allows a wallet-issued one.
//!
//! A renewal names the identity (`IDENTITY_HINT`) and carries the same connection id, and no
//! `MODE`: wallets do not know `MODE` = renew yet, and its type is even, so a wallet that does
//! not know it refuses the whole request.
//!
//! Clocks: `CREATED_AT` is this machine's clock (the wallet compares it with its own); the
//! proposed expiry and the verifier's "now" are chain time (the latest block's).

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::time::Duration;

use super::poll::{self, ResponsePort};
use super::request::{self, AuthBinding, BindingKind, Request};
use super::verify::{self, Grant, IdentityPort, RejectReason, VerifyContext};
use super::SecretBytes;
use super::{
    decode_id, encode_base58, level, public_key_of, purpose, random_secret, Id, KeyBounds,
};
use crate::keystore::{self, Secret};
use crate::network::{ForgeIds, Network};

/// The name a wallet shows for Forge.
pub const LABEL: &str = "Dash Forge";
/// The App Connect contract and v2 requests exist from protocol 14.
pub const MIN_PROTOCOL: u32 = 14;
/// How long the poll keeps reading after the first answer, for a competing one.
pub const SETTLE_MS: u64 = 3_000;

/// A fresh random connection id. The caller keeps it per machine and identity: a wallet that
/// sees it again disables the key of its previous grant.
pub fn new_connection_id() -> crate::Result<[u8; 16]> {
    let mut id = [0u8; 16];
    getrandom::getrandom(&mut id)
        .map_err(|e| crate::Error::Config(format!("no randomness: {e}")))?;
    Ok(id)
}

/// What a sign-in request proposes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginParams {
    /// The app's connection id ([`new_connection_id`]).
    pub connection_id: [u8; 16],
    /// The proposed lifetime budget, in credits. The wallet may clamp it to its presets.
    pub budget_credits: u64,
    /// The proposed lifetime (ms), counted from `chain_now_ms`.
    pub lifetime_ms: u64,
    /// Chain time (ms): the latest block's.
    pub chain_now_ms: u64,
    /// This machine's clock (ms): `CREATED_AT`.
    pub now_ms: u64,
    /// The identity a renewal is for.
    pub identity_hint: Option<Id>,
}

/// Forge's request: one group-bound HIGH key with the proposed limits.
pub fn forge_request(
    forge: &ForgeIds,
    app_ephemeral_pub_key: [u8; 33],
    p: &LoginParams,
) -> crate::Result<Request> {
    let id = |text: &str, what: &str| {
        decode_id(text).ok_or_else(|| {
            crate::Error::Config(format!("the {what} id {text} is not a Platform id"))
        })
    };
    Ok(Request {
        app_ephemeral_pub_key,
        app_id: id(&forge.core, "forge-core")?,
        label: LABEL.into(),
        auth_bindings: vec![AuthBinding {
            kind: BindingKind::ContractGroup,
            id: id(&forge.group, "contract group")?,
            document_type_name: None,
            security_level: level::HIGH,
            total_budget: Some(p.budget_credits),
            expires_at_ms: Some(p.chain_now_ms.saturating_add(p.lifetime_ms)),
        }],
        enc_bindings: vec![],
        created_at_ms: p.now_ms,
        identity_hint: p.identity_hint,
        connection_id: Some(p.connection_id),
        mode: None,
    })
}

/// A sign-in request in flight. Its ephemeral private key stays in memory and is wiped on drop.
/// Read-only, so the request polled for is always the one the link carries.
#[derive(Debug)]
pub struct LoginRequest {
    request: Request,
    uri: String,
    request_hash: [u8; 20],
    created_at_ms: u64,
    expires_at_ms: u64,
    chain_time_at_creation_ms: u64,
    secret: SecretBytes,
}

impl LoginRequest {
    /// A fresh request on `network` with a new ephemeral key.
    pub fn new(network: &Network, forge: &ForgeIds, p: &LoginParams) -> crate::Result<Self> {
        Self::with_secret(network, forge, p, random_secret()?)
    }

    fn with_secret(
        network: &Network,
        forge: &ForgeIds,
        p: &LoginParams,
        secret: SecretBytes,
    ) -> crate::Result<Self> {
        let app_pub = public_key_of(secret.expose())
            .ok_or_else(|| crate::Error::Config("not a secp256k1 private key".into()))?;
        let request = forge_request(forge, app_pub, p)?;
        let uri = request::build_uri(&request, network)
            .map_err(|e| crate::Error::Config(e.to_string()))?;
        Ok(Self {
            request_hash: request::request_hash(&request),
            uri,
            created_at_ms: p.now_ms,
            expires_at_ms: p.now_ms.saturating_add(request::MAX_REQUEST_AGE_MS),
            chain_time_at_creation_ms: p.chain_now_ms,
            request,
            secret,
        })
    }

    /// The request.
    pub fn request(&self) -> &Request {
        &self.request
    }

    /// The `dash-key:` link to show as a QR code and as text.
    pub fn uri(&self) -> &str {
        &self.uri
    }

    /// `hash160(appEphemeralPub)`: what the answers are stored under.
    pub fn request_hash(&self) -> &[u8; 20] {
        &self.request_hash
    }

    /// When the poll gives up: the protocol's 10 minutes after `CREATED_AT` (this machine's
    /// clock, ms).
    pub fn expires_at_ms(&self) -> u64 {
        self.expires_at_ms
    }
}

/// The key a wallet granted Forge, checked by the verifier and by Forge's rules: a live
/// AUTHENTICATION / HIGH key of [`WalletGrant::identity_id`], bound to the dash-forge group,
/// with a budget left and an expiry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalletGrant {
    /// The identity that granted it (base58).
    pub identity_id: String,
    /// The key's id on that identity.
    pub key_id: u32,
    /// Its key type ([`super::key_type`]). The released wallets register `ECDSA_HASH160`, which
    /// [`crate::platform::WriteEngine`] does not select yet: it signs with `ECDSA_SECP256K1`
    /// keys only, so the `dg` command that stores this key must widen that first.
    pub key_type: u8,
    /// Its lifetime budget, in credits (the wallet may have clamped what Forge proposed).
    pub total_budget: u64,
    /// What is left of it.
    pub remaining_budget: u64,
    /// When it stops signing (block time, ms).
    pub expires_at_ms: u64,
    secret: SecretBytes,
}

impl WalletGrant {
    /// The private key in WIF form for `network`.
    pub fn wif(&self, network: &Network) -> Secret {
        crate::platform::identity::wif_from_bytes(self.secret.expose(), network)
    }

    /// The `dfk1:<network_label>:<identity>:<keyId>:<wif>` limited key `dg` stores.
    pub fn to_dfk1(&self, network: &Network, network_label: &str) -> Secret {
        keystore::dfk1(
            network_label,
            &self.identity_id,
            self.key_id,
            self.wif(network).expose(),
        )
    }
}

/// Forge's own rules over a verified grant: exactly one key, for the group binding, at
/// AUTHENTICATION / HIGH, bound to the dash-forge group, with a budget left and an expiry, and
/// a private key that is one.
pub fn forge_grant(grant: Grant, forge: &ForgeIds) -> Result<WalletGrant, RejectReason> {
    let mut auth = grant.auth_keys.into_iter();
    let (Some(main), None, true) = (auth.next(), auth.next(), grant.encryption_keys.is_empty())
    else {
        return Err(RejectReason::Framing);
    };
    if main.role != verify::KeyRole::ContractGroup {
        return Err(RejectReason::Framing);
    }
    if public_key_of(main.private_key.expose()).is_none() {
        return Err(RejectReason::InvalidKey);
    }
    let key = &main.key;
    if key.purpose != purpose::AUTHENTICATION || key.security_level != level::HIGH {
        return Err(RejectReason::KeyLevel);
    }
    let group = decode_id(&forge.group).ok_or(RejectReason::KeyUnmatched)?;
    if key.bounds != Some(KeyBounds::ContractGroup { group_id: group }) {
        return Err(RejectReason::KeyUnmatched);
    }
    let (Some(total_budget), Some(expires_at_ms)) = (key.total_budget, key.expires_at_ms) else {
        return Err(RejectReason::KeyLimits);
    };
    let remaining_budget = match main.remaining_budget {
        None => return Err(RejectReason::BudgetUnknown),
        Some(0) => return Err(RejectReason::BudgetExhausted),
        Some(left) => left,
    };
    Ok(WalletGrant {
        identity_id: encode_base58(&grant.identity_id),
        key_id: key.id,
        key_type: key.key_type,
        total_budget,
        remaining_budget,
        expires_at_ms,
        secret: main.private_key,
    })
}

/// Why Forge refused a wallet's answer, in a user's words.
pub fn refusal_message(reason: RejectReason) -> &'static str {
    use RejectReason as R;
    match reason {
        R::KeyDisabled => "The key your wallet sent is already disabled.",
        R::KeyExpired => "The key your wallet sent expires within the hour.",
        R::BudgetExhausted => "The key your wallet sent has no budget left.",
        R::KeyLimits => "The key your wallet sent has no spending limit or no expiry.",
        R::KeyLevel => "The key your wallet sent can do more than Forge asked for.",
        R::KeyMaster => "Your wallet sent its master key.",
        R::KeyUnmatched => "The key your wallet sent is for something other than Dash Forge.",
        R::KeyUnbound => "The key your wallet sent is not limited to Dash Forge.",
        _ => "Your wallet's answer doesn't match what Forge asked for.",
    }
}

/// How a sign-in ends without a key.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LoginError {
    /// More than one identity answered: Forge cannot tell which is the user's (base58 ids).
    #[error(
        "more than one identity answered this sign-in request ({}); start again and keep the QR code private",
        .0.join(", ")
    )]
    Ambiguous(Vec<String>),
    /// More answers reached the request than Forge reads (junk).
    #[error(
        "so many answers reached this sign-in request that Forge can't check them all; start again and keep the QR code private"
    )]
    TooManyAnswers,
    /// Nobody answered within the protocol's 10 minutes. Carries the last failed read of
    /// Platform, when the last round's read failed (a node down, or no App Connect contract).
    #[error("the sign-in request expired before a wallet answered it; start again{}",
        .0.as_ref().map(|e| format!(" (the last read of Platform failed: {e})")).unwrap_or_default())]
    Expired(Option<String>),
    /// The sole answer is one Forge will not use.
    #[error("{} Forge didn't use it. Start again; if it happens again, sign in another way.", refusal_message(*.0))]
    Refused(RejectReason),
}

/// What a poll round saw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PollStatus {
    /// Every answer was read; none is usable yet.
    Waiting,
    /// An answer was found; waiting out the settle window.
    Answered,
    /// A read failed; the round does not count.
    IncompleteRead,
}

/// How [`await_forge_grant`] polls.
pub struct PollOptions<'a> {
    /// How long to keep reading after the first answer ([`SETTLE_MS`]); none for a renewal.
    pub settle_ms: u64,
    /// A fixed interval instead of the protocol's cadence ([`poll::poll_delay_ms`]).
    pub interval_ms: Option<u64>,
    /// This machine's clock (ms).
    pub now_ms: &'a (dyn Fn() -> u64 + Send + Sync),
    /// Called after every round.
    pub on_status: &'a (dyn Fn(PollStatus) + Send + Sync),
}

fn ignore_status(_: PollStatus) {}

impl Default for PollOptions<'static> {
    fn default() -> Self {
        Self {
            settle_ms: SETTLE_MS,
            interval_ms: None,
            now_ms: &crate::cache::now_ms,
            on_status: &ignore_status,
        }
    }
}

/// An answer's outcome: its grant or why Forge will not use it, or `None` to check it again.
type Outcome = Option<Result<WalletGrant, RejectReason>>;

/// One answer to `req`, or `None` when it is not one (another request's, or tampered): it did
/// not open with this request's key.
async fn check_answer<P: IdentityPort>(
    port: &P,
    req: &LoginRequest,
    forge: &ForgeIds,
    candidate: &verify::Candidate,
    chain_now_ms: u64,
) -> Option<Outcome> {
    let ctx = VerifyContext {
        request: &req.request,
        identity: port,
        now_ms: chain_now_ms,
        expiry_margin_ms: verify::EXPIRY_MARGIN_MS,
    };
    match verify::verify_candidate(&ctx, &req.secret, candidate).await {
        Ok(Err(r))
            if matches!(
                r.reason,
                RejectReason::Decrypt | RejectReason::Framing | RejectReason::HintMismatch
            ) =>
        {
            None
        }
        Ok(Ok(grant)) => Some(Some(forge_grant(grant, forge))),
        Ok(Err(r)) if !r.retryable() => Some(Some(Err(r.reason))),
        // A lagging read, or a read that failed past the decryption: check it again.
        Ok(Err(_)) | Err(_) => Some(None),
    }
}

/// Poll the App Connect contract until an identity's answer to `req` is verified, then keep
/// polling for the settle window for a competing answer before returning it; only rounds that
/// read every answer count towards that window. Every answer that opens with this request's
/// key counts as an identity answering, accepted or not, so an attacker's quick answer cannot
/// win over the user's slow one: two is [`LoginError::Ambiguous`].
///
/// A renewal (an identity hint) reads only that identity's answer, so nothing can compete: no
/// settle window, and its refusal is final at once. An answer whose key a node does not show
/// yet (or whose budget it has not seen) is checked again on the next poll.
///
/// The request is consumed: its ephemeral key is wiped when this returns.
pub async fn await_forge_grant<P: IdentityPort + ResponsePort>(
    port: &P,
    req: LoginRequest,
    forge: &ForgeIds,
    opts: &PollOptions<'_>,
) -> Result<WalletGrant, LoginError> {
    let now = opts.now_ms;
    let hint = req.request.identity_hint;
    let settle_ms = if hint.is_some() { 0 } else { opts.settle_ms };
    // Per answering identity: its outcome, or `None` to check again.
    let mut answered: BTreeMap<Id, Outcome> = BTreeMap::new();
    // Every identity whose answer opened with this request's key.
    let mut responders: BTreeSet<Id> = BTreeSet::new();
    // Answers already found not to be answers to this request, by exact contents.
    let mut not_answers: HashSet<(Id, [u8; 32])> = HashSet::new();
    let mut clean_since: Option<u64> = None;
    let mut first_at: Option<u64> = None;
    let mut last_read_error: Option<String>;

    loop {
        // A failed read is never "no answers": the round does not count towards the settle
        // window.
        let page = match poll::list_candidates(
            port,
            &req.request_hash,
            hint.as_ref(),
            poll::PAGE_SIZE,
            poll::MAX_CANDIDATES,
        )
        .await
        {
            Ok(page) => {
                last_read_error = None;
                Some(page)
            }
            Err(e) => {
                last_read_error = Some(e.to_string());
                None
            }
        };
        if page.as_ref().is_some_and(|p| p.truncated) {
            return Err(LoginError::TooManyAnswers);
        }
        let complete = page.is_some();
        for candidate in page.map(|p| p.candidates).unwrap_or_default() {
            if matches!(answered.get(&candidate.owner_id), Some(Some(_))) {
                continue;
            }
            let contents = poll::candidate_key(&candidate);
            if not_answers.contains(&contents) {
                continue;
            }
            let chain_now_ms = req
                .chain_time_at_creation_ms
                .saturating_add(now().saturating_sub(req.created_at_ms));
            let Some(answer) = check_answer(port, &req, forge, &candidate, chain_now_ms).await
            else {
                not_answers.insert(contents);
                continue;
            };
            // It opened: this identity saw the QR code and answered, whatever its key is.
            responders.insert(candidate.owner_id);
            if let (Some(Err(reason)), Some(_)) = (&answer, hint) {
                return Err(LoginError::Refused(*reason));
            }
            if answer.is_some() && first_at.is_none() {
                first_at = Some(now());
            }
            answered.insert(candidate.owner_id, answer);
        }
        if responders.len() > 1 {
            return Err(LoginError::Ambiguous(
                responders.iter().map(|id| encode_base58(id)).collect(),
            ));
        }

        let t = now();
        clean_since = if complete {
            clean_since.or(Some(t))
        } else {
            None
        };
        (opts.on_status)(match (complete, first_at) {
            (false, _) => PollStatus::IncompleteRead,
            (true, Some(_)) => PollStatus::Answered,
            (true, None) => PollStatus::Waiting,
        });
        if let (Some(first), Some(clean)) = (first_at, clean_since) {
            if t.saturating_sub(first.max(clean)) >= settle_ms {
                let only = answered
                    .into_values()
                    .flatten()
                    .next()
                    .expect("first_at is set only with an answer");
                return only.map_err(LoginError::Refused);
            }
        }
        let delay = opts
            .interval_ms
            .or_else(|| poll::poll_delay_ms(t.saturating_sub(req.created_at_ms)));
        let Some(delay) = delay.filter(|_| t < req.expires_at_ms) else {
            return Err(LoginError::Expired(last_read_error));
        };
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::super::crypto;
    use super::super::test_vectors::{secret, seed, VECTOR_CREATED_AT as T0};
    use super::super::verify::tests::FakeChain;
    use super::super::verify::Candidate;
    use super::super::{hash160, key_type, ChainKey};
    use super::*;
    use async_trait::async_trait;
    use std::sync::Mutex;

    const CHAIN_T0: u64 = T0 - 5_000;
    const DAY: u64 = 24 * 60 * 60 * 1000;

    fn forge() -> ForgeIds {
        ForgeIds {
            core: encode_base58(&seed("forge core")),
            group: encode_base58(&seed("forge group")),
            ..ForgeIds::test_forge()
        }
    }

    fn params(hint: Option<Id>) -> LoginParams {
        LoginParams {
            connection_id: seed("connection id")[..16].try_into().unwrap(),
            budget_credits: 25_000_000_000,
            lifetime_ms: 180 * DAY,
            chain_now_ms: CHAIN_T0,
            now_ms: T0,
            identity_hint: hint,
        }
    }

    fn login(hint: Option<Id>) -> LoginRequest {
        LoginRequest::with_secret(
            &Network::Testnet,
            &forge(),
            &params(hint),
            SecretBytes::new(seed("forge app ephemeral")),
        )
        .unwrap()
    }

    /// The wallet's key for `owner`, registered as the released wallets do (`ECDSA_HASH160`).
    fn wallet_key(owner: &str) -> ChainKey {
        ChainKey {
            id: 4,
            key_type: key_type::ECDSA_HASH160,
            purpose: purpose::AUTHENTICATION,
            security_level: level::HIGH,
            data: hash160(&super::super::public_key_of(&seed(&format!("{owner} key"))).unwrap())
                .to_vec(),
            disabled: false,
            bounds: Some(KeyBounds::ContractGroup {
                group_id: seed("forge group"),
            }),
            total_budget: Some(5_000_000_000),
            expires_at_ms: Some(CHAIN_T0 + 90 * DAY),
        }
    }

    /// The fake chain and the answers published so far.
    struct World {
        chain: Mutex<FakeChain>,
        /// Each answer with the request hash it is stored under.
        answers: Mutex<Vec<([u8; 20], Candidate)>>,
        fail_reads: Mutex<u32>,
    }

    impl World {
        fn new() -> Self {
            Self {
                chain: Mutex::new(FakeChain::default()),
                answers: Mutex::new(vec![]),
                fail_reads: Mutex::new(0),
            }
        }

        fn register(&self, owner: &str, key: ChainKey) {
            let mut chain = self.chain.lock().unwrap();
            chain.identities.insert(seed(owner), vec![key]);
            chain.budgets.insert(4, 4_000_000_000);
        }

        /// `owner` answers `request` with its key, sealed to `sealed_for`.
        fn answer(&self, request: &Request, owner: &str, sealed_for: &str) {
            self.answer_with(request, owner, sealed_for, &[seed(&format!("{owner} key"))]);
        }

        fn answer_with(&self, request: &Request, owner: &str, sealed_for: &str, keys: &[[u8; 32]]) {
            let (pub_key, payload) = crypto::seal_with(
                &request.app_ephemeral_pub_key,
                &seed(sealed_for),
                keys,
                &secret(&format!("{owner} wallet eph")),
                [1; 12],
            )
            .unwrap();
            let mut answers = self.answers.lock().unwrap();
            answers.push((
                request::request_hash(request),
                Candidate {
                    owner_id: seed(owner),
                    wallet_ephemeral_pub_key: pub_key.to_vec(),
                    encrypted_payload: payload,
                },
            ));
            answers.sort_by_key(|(_, c)| c.owner_id);
        }
    }

    #[async_trait]
    impl IdentityPort for World {
        async fn identity_keys(&self, id: &Id) -> crate::Result<Option<Vec<ChainKey>>> {
            Ok(self.chain.lock().unwrap().identities.get(id).cloned())
        }
        async fn remaining_budgets(&self, _: &Id, k: &[u32]) -> crate::Result<BTreeMap<u32, u64>> {
            Ok(self.chain.lock().unwrap().remaining(k))
        }
        async fn contract_keys(&self, _: &Id, _: &Id, _: u8) -> crate::Result<Vec<ChainKey>> {
            panic!("Forge asks for no encryption key")
        }
    }

    #[async_trait]
    impl ResponsePort for World {
        async fn list_candidates(
            &self,
            hash: &[u8; 20],
            hint: Option<&Id>,
            after: Option<&Id>,
            limit: u32,
        ) -> crate::Result<Vec<Candidate>> {
            {
                let mut fail = self.fail_reads.lock().unwrap();
                if *fail > 0 {
                    *fail -= 1;
                    return Err(crate::Error::Platform("node down".into()));
                }
            }
            Ok(self
                .answers
                .lock()
                .unwrap()
                .iter()
                .filter(|(h, _)| h == hash)
                .map(|(_, c)| c)
                .filter(|c| hint.is_none_or(|h| *h == c.owner_id))
                .filter(|c| after.is_none_or(|a| c.owner_id > *a))
                .take(limit as usize)
                .cloned()
                .collect())
        }
    }

    /// Runs the poll on paused tokio time, with this machine's clock following it.
    async fn run(world: &World, req: LoginRequest) -> Result<WalletGrant, LoginError> {
        let start = tokio::time::Instant::now();
        let now = move || T0 + u64::try_from(start.elapsed().as_millis()).unwrap();
        let opts = PollOptions {
            now_ms: &now,
            ..PollOptions::default()
        };
        await_forge_grant(world, req, &forge(), &opts).await
    }

    #[test]
    fn forge_request_is_one_group_bound_high_key_with_the_proposed_limits() {
        let req = login(None);
        let r = req.request();
        assert_eq!(r.label, "Dash Forge");
        assert_eq!(r.app_id, seed("forge core"));
        assert_eq!(r.auth_bindings.len(), 1);
        let b = &r.auth_bindings[0];
        assert_eq!(b.kind, BindingKind::ContractGroup);
        assert_eq!(b.id, seed("forge group"));
        assert_eq!(b.security_level, level::HIGH);
        assert_eq!(b.total_budget, Some(25_000_000_000));
        assert_eq!(b.expires_at_ms, Some(CHAIN_T0 + 180 * DAY));
        assert!(r.enc_bindings.is_empty());
        assert_eq!(r.mode, None);
        assert_eq!(r.created_at_ms, T0);
        assert_eq!(req.expires_at_ms(), T0 + 600_000);
        assert!(req.uri().starts_with("dash-key:"));
        assert!(req.uri().ends_with("?n=t&v=2"));
        assert_eq!(*req.request_hash(), hash160(&r.app_ephemeral_pub_key));
        assert_eq!(request::decode(&request::encode(r).unwrap()).unwrap(), *r);
        assert!(!format!("{req:?}").contains(&hex::encode(seed("forge app ephemeral"))));
    }

    /// `forge_vectors.json`: Forge's request and a one-key answer, made by the TypeScript module.
    fn ts_vectors() -> serde_json::Value {
        serde_json::from_str(include_str!("forge_vectors.json")).unwrap()
    }

    #[test]
    fn forge_requests_match_the_typescript_byte_for_byte() {
        let v = ts_vectors();
        assert_eq!(v["inputs"]["forgeCore"], forge().core);
        assert_eq!(v["inputs"]["forgeGroup"], forge().group);
        let first = login(None);
        let bytes = request::encode(first.request()).unwrap();
        assert_eq!(hex::encode(bytes), v["login"]["bytes"].as_str().unwrap());
        assert_eq!(first.uri(), v["login"]["uri"].as_str().unwrap());
        assert_eq!(
            hex::encode(first.request_hash()),
            v["login"]["requestHash"].as_str().unwrap()
        );

        let renewal = login(Some(seed("alice")));
        let bytes = request::encode(renewal.request()).unwrap();
        assert_eq!(hex::encode(bytes), v["renewal"]["bytes"].as_str().unwrap());
        assert_eq!(
            request::build_uri(renewal.request(), &Network::Mainnet).unwrap(),
            v["renewal"]["uri"].as_str().unwrap()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn accepts_the_answer_the_typescript_sealed() {
        let v = ts_vectors();
        let world = World::new();
        world.register("alice", wallet_key("alice"));
        let req = login(None);
        world.answer(req.request(), "alice", "alice");
        {
            let answers = world.answers.lock().unwrap();
            assert_eq!(
                hex::encode(&answers[0].1.wallet_ephemeral_pub_key),
                v["answer"]["walletEphemeralPubKey"].as_str().unwrap()
            );
            assert_eq!(
                hex::encode(&answers[0].1.encrypted_payload),
                v["answer"]["encryptedPayload"].as_str().unwrap()
            );
        }
        assert_eq!(
            run(&world, req).await.unwrap().identity_id,
            v["inputs"]["alice"]
        );
    }

    #[test]
    fn a_renewal_carries_the_hint_and_no_mode() {
        let req = login(Some(seed("alice")));
        assert_eq!(req.request().identity_hint, Some(seed("alice")));
        assert_eq!(req.request().mode, None);
    }

    #[test]
    fn fresh_requests_draw_fresh_keys() {
        let a = LoginRequest::new(&Network::Testnet, &forge(), &params(None)).unwrap();
        let b = LoginRequest::new(&Network::Testnet, &forge(), &params(None)).unwrap();
        assert_ne!(a.request_hash, b.request_hash);
        assert_ne!(new_connection_id().unwrap(), new_connection_id().unwrap());
    }

    #[tokio::test(start_paused = true)]
    async fn accepts_the_wallets_key_after_the_settle_window_and_stores_it_as_dfk1() {
        let world = World::new();
        world.register("alice", wallet_key("alice"));
        let req = login(None);
        world.answer(req.request(), "alice", "alice");
        let started = tokio::time::Instant::now();
        let grant = run(&world, req).await.unwrap();
        assert!(started.elapsed() >= Duration::from_millis(SETTLE_MS));
        assert_eq!(grant.identity_id, encode_base58(&seed("alice")));
        assert_eq!(grant.key_id, 4);
        assert_eq!(grant.key_type, key_type::ECDSA_HASH160);
        assert_eq!(grant.total_budget, 5_000_000_000);
        assert_eq!(grant.remaining_budget, 4_000_000_000);
        assert_eq!(grant.expires_at_ms, CHAIN_T0 + 90 * DAY);

        let dfk1 = grant.to_dfk1(&Network::Testnet, "testnet");
        let bridge = keystore::BridgeIdentity::from_dfk1(dfk1.expose()).unwrap();
        assert_eq!(bridge.identity_id, grant.identity_id);
        assert_eq!(bridge.identity_keys[0].id, 4);
        let wif = bridge.identity_keys[0].private_key_wif.expose().to_string();
        assert_eq!(
            crate::platform::identity::public_key_hex(&wif, &Network::Testnet).unwrap(),
            hex::encode(super::super::public_key_of(&seed("alice key")).unwrap())
        );
        assert!(!format!("{grant:?}").contains(&wif));
    }

    #[tokio::test(start_paused = true)]
    async fn keeps_polling_until_the_key_shows_up_on_the_identity() {
        let world = World::new();
        world
            .chain
            .lock()
            .unwrap()
            .identities
            .insert(seed("alice"), vec![]);
        let req = login(None);
        world.answer(req.request(), "alice", "alice");
        let poll = run(&world, req);
        tokio::pin!(poll);
        tokio::select! {
            r = &mut poll => panic!("must keep polling while the key is missing: {r:?}"),
            () = tokio::time::sleep(Duration::from_secs(20)) => {}
        }
        world.register("alice", wallet_key("alice"));
        assert_eq!(poll.await.unwrap().key_id, 4);
    }

    #[tokio::test(start_paused = true)]
    async fn waits_for_an_answer_that_arrives_later() {
        let world = World::new();
        world.register("alice", wallet_key("alice"));
        let req = login(None);
        let request = req.request().clone();
        let poll = run(&world, req);
        tokio::pin!(poll);
        tokio::select! {
            r = &mut poll => panic!("nobody answered yet: {r:?}"),
            () = tokio::time::sleep(Duration::from_secs(90)) => {}
        }
        world.answer(&request, "alice", "alice");
        assert!(poll.await.is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn refuses_two_identities_answering() {
        let world = World::new();
        world.register("alice", wallet_key("alice"));
        world.register("mallory", wallet_key("mallory"));
        let req = login(None);
        world.answer(req.request(), "alice", "alice");
        world.answer(req.request(), "mallory", "mallory");
        let err = run(&world, req).await.unwrap_err();
        let LoginError::Ambiguous(ids) = &err else {
            panic!("{err:?}")
        };
        assert_eq!(ids.len(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn a_bad_answer_still_counts_as_an_identity_answering() {
        let world = World::new();
        world.register("alice", wallet_key("alice"));
        let mut master = wallet_key("mallory");
        master.security_level = level::MASTER;
        world.register("mallory", master);
        let req = login(None);
        world.answer(req.request(), "alice", "alice");
        world.answer(req.request(), "mallory", "mallory");
        assert!(matches!(
            run(&world, req).await,
            Err(LoginError::Ambiguous(_))
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn ignores_answers_that_do_not_open_for_this_request() {
        let world = World::new();
        world.register("alice", wallet_key("alice"));
        let req = login(None);
        world.answer(req.request(), "alice", "alice");
        // Copied under another identity: the AAD does not match, so it is not an answer.
        world.answer(req.request(), "mallory", "alice");
        assert_eq!(
            run(&world, req).await.unwrap().identity_id,
            encode_base58(&seed("alice"))
        );
    }

    #[tokio::test(start_paused = true)]
    async fn refuses_the_sole_answer_forge_will_not_use() {
        let world = World::new();
        let mut unlimited = wallet_key("alice");
        unlimited.expires_at_ms = Some(CHAIN_T0 + 10 * 60_000);
        world.register("alice", unlimited);
        let req = login(None);
        world.answer(req.request(), "alice", "alice");
        let err = run(&world, req).await.unwrap_err();
        assert_eq!(err, LoginError::Refused(RejectReason::KeyExpired));
        assert!(err.to_string().contains("expires within the hour"));
    }

    #[tokio::test(start_paused = true)]
    async fn a_renewal_needs_no_settle_window_and_refuses_at_once() {
        let world = World::new();
        world.register("alice", wallet_key("alice"));
        let req = login(Some(seed("alice")));
        world.answer(req.request(), "alice", "alice");
        let started = tokio::time::Instant::now();
        assert!(run(&world, req).await.is_ok());
        assert_eq!(started.elapsed(), Duration::ZERO);

        let world = World::new();
        let mut disabled = wallet_key("alice");
        disabled.disabled = true;
        world.register("alice", disabled);
        let req = login(Some(seed("alice")));
        world.answer(req.request(), "alice", "alice");
        assert_eq!(
            run(&world, req).await,
            Err(LoginError::Refused(RejectReason::KeyDisabled))
        );
    }

    #[tokio::test(start_paused = true)]
    async fn too_many_answers_and_expiry() {
        let world = World::new();
        let req = login(None);
        for i in 0..=poll::MAX_CANDIDATES {
            world.answer(req.request(), &format!("spam {i}"), &format!("spam {i}"));
        }
        assert_eq!(run(&world, req).await, Err(LoginError::TooManyAnswers));

        let world = World::new();
        let started = tokio::time::Instant::now();
        assert_eq!(
            run(&world, login(None)).await,
            Err(LoginError::Expired(None))
        );
        assert!(started.elapsed() >= Duration::from_millis(request::MAX_REQUEST_AGE_MS));
    }

    #[tokio::test(start_paused = true)]
    async fn expiry_says_when_platform_could_not_be_read() {
        let world = World::new();
        *world.fail_reads.lock().unwrap() = u32::MAX;
        let err = run(&world, login(None)).await.unwrap_err();
        assert!(
            matches!(&err, LoginError::Expired(Some(e)) if e.contains("node down")),
            "{err:?}"
        );
        assert!(err.to_string().contains("the last read of Platform failed"));
    }

    #[tokio::test(start_paused = true)]
    async fn an_answer_with_extra_keys_still_counts_as_an_identity_answering() {
        let world = World::new();
        world.register("alice", wallet_key("alice"));
        world.register("bob", wallet_key("bob"));
        let req = login(None);
        world.answer(req.request(), "alice", "alice");
        // It opens with this request's key, so bob answered, even with a key nobody asked for.
        world.answer_with(
            req.request(),
            "bob",
            "bob",
            &[seed("bob key"), seed("bob extra")],
        );
        assert!(matches!(
            run(&world, req).await,
            Err(LoginError::Ambiguous(_))
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn failed_reads_do_not_count_towards_the_settle_window() {
        let world = World::new();
        world.register("alice", wallet_key("alice"));
        let req = login(None);
        world.answer(req.request(), "alice", "alice");
        *world.fail_reads.lock().unwrap() = 3;
        let started = tokio::time::Instant::now();
        assert!(run(&world, req).await.is_ok());
        // Three failed rounds (2 s apart), then the settle window from the first clean read.
        assert!(started.elapsed() >= Duration::from_millis(3 * 2_000 + SETTLE_MS));
    }

    /// A Forge-rule case: its name, a change to the wallet key, the budget left, the refusal.
    type RuleCase = (&'static str, fn(&mut ChainKey), Option<u64>, RejectReason);

    #[test]
    fn forge_rules_refuse_what_the_verifier_alone_would_accept() {
        let granted = |key: ChainKey, remaining| Grant {
            identity_id: seed("alice"),
            auth_keys: vec![verify::GrantedKey {
                role: verify::KeyRole::ContractGroup,
                binding_index: 0,
                private_key: SecretBytes::new(seed("alice key")),
                key,
                remaining_budget: remaining,
            }],
            encryption_keys: vec![],
        };
        assert!(forge_grant(granted(wallet_key("alice"), Some(1)), &forge()).is_ok());
        let cases: [RuleCase; 5] = [
            (
                "CRITICAL",
                |k| k.security_level = level::CRITICAL,
                Some(1),
                RejectReason::KeyLevel,
            ),
            (
                "another group",
                |k| {
                    k.bounds = Some(KeyBounds::ContractGroup {
                        group_id: seed("other group"),
                    });
                },
                Some(1),
                RejectReason::KeyUnmatched,
            ),
            (
                "no expiry",
                |k| k.expires_at_ms = None,
                Some(1),
                RejectReason::KeyLimits,
            ),
            ("spent", |_| {}, Some(0), RejectReason::BudgetExhausted),
            ("budget unread", |_| {}, None, RejectReason::BudgetUnknown),
        ];
        for (name, change, remaining, reason) in cases {
            let mut key = wallet_key("alice");
            change(&mut key);
            assert_eq!(
                forge_grant(granted(key, remaining), &forge()),
                Err(reason),
                "{name}"
            );
        }
        let mut not_a_key = granted(wallet_key("alice"), Some(1));
        not_a_key.auth_keys[0].private_key = SecretBytes::new([0; 32]);
        assert_eq!(
            forge_grant(not_a_key, &forge()),
            Err(RejectReason::InvalidKey)
        );
        let mut two = granted(wallet_key("alice"), Some(1));
        two.auth_keys.push(two.auth_keys[0].clone());
        assert_eq!(forge_grant(two, &forge()), Err(RejectReason::Framing));
    }
}
