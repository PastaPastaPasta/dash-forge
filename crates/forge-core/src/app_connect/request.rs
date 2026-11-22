//! App Connect request v2 (`request.ts`):
//!
//! ```text
//! body = 0x02 ‖ appEphPub(33) ‖ appId(32) ‖ labelLen(1) ‖ label ‖ TLV*
//! TLV  = type(1) ‖ len(1) ‖ value
//! uri  = dash-key:<base58(body)>?n=<m|t|d>&v=2
//! ```
//!
//! Even TLV types must be understood (a decoder refuses unknown ones); odd types are optional
//! and unknown ones are skipped. TLVs appear in ascending type order and only AUTH_BINDING and
//! ENC_BINDING repeat, so every request has exactly one encoding. The `cb` callback parameter
//! is left out: a terminal has no page for the wallet to return to.

use super::{encode_base58, hash160, level, purpose, Id};
use crate::network::Network;

/// The request version this module speaks.
pub const REQUEST_VERSION: u8 = 2;
/// The longest label, in UTF-8 bytes.
pub const MAX_LABEL_BYTES: usize = 64;
/// The most AUTH_BINDING TLVs.
pub const MAX_AUTH_BINDINGS: usize = 4;
/// The most ENC_BINDING TLVs.
pub const MAX_ENC_BINDINGS: usize = 2;
/// A wallet refuses a request created longer ago than this...
pub const MAX_REQUEST_AGE_MS: u64 = 10 * 60_000;
/// ...or further in the future than this (clock skew).
pub const MAX_REQUEST_SKEW_MS: u64 = 2 * 60_000;

/// TLV type numbers.
pub mod tlv {
    /// The identity a renewal is for (32 bytes).
    pub const IDENTITY_HINT: u8 = 0x01;
    /// A key the app asks for (repeatable).
    pub const AUTH_BINDING: u8 = 0x02;
    /// The app's connection id (16 bytes): the wallet disables the previous grant's key.
    pub const CONNECTION_ID: u8 = 0x03;
    /// An encryption key the app asks for (repeatable, 33 bytes).
    pub const ENC_BINDING: u8 = 0x04;
    /// 1 = renew; absent means login.
    pub const MODE: u8 = 0x05;
    /// When the request was made, ms since the epoch (8 bytes, big-endian).
    pub const CREATED_AT: u8 = 0x06;
}

/// The largest millisecond timestamp the TypeScript side reads (`Number.MAX_SAFE_INTEGER`).
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
const AUTH_BINDING_FIXED_BYTES: usize = 1 + 1 + 32 + 8 + 8;
const HEADER_BYTES: usize = 1 + 33 + 32 + 1;
const KNOWN_TLV_TYPES: [u8; 6] = [
    tlv::IDENTITY_HINT,
    tlv::AUTH_BINDING,
    tlv::CONNECTION_ID,
    tlv::ENC_BINDING,
    tlv::MODE,
    tlv::CREATED_AT,
];

/// What an AUTH_BINDING asks the key to be bound to; the wire tags equal Platform's
/// `ContractBounds` bincode tags.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindingKind {
    /// One contract.
    SingleContract,
    /// One document type of one contract.
    DocumentType,
    /// Every member of a contract group.
    ContractGroup,
}

impl BindingKind {
    fn tag(self) -> u8 {
        match self {
            Self::SingleContract => 0,
            Self::DocumentType => 1,
            Self::ContractGroup => 2,
        }
    }

    fn from_tag(tag: u8) -> Option<Self> {
        match tag {
            0 => Some(Self::SingleContract),
            1 => Some(Self::DocumentType),
            2 => Some(Self::ContractGroup),
            _ => None,
        }
    }
}

/// A key the app asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthBinding {
    /// What the key is bound to.
    pub kind: BindingKind,
    /// The contract id, or the group id for [`BindingKind::ContractGroup`].
    pub id: Id,
    /// Required for [`BindingKind::DocumentType`], absent otherwise.
    pub document_type_name: Option<String>,
    /// CRITICAL only on a group binding; HIGH everywhere.
    pub security_level: u8,
    /// Proposed lifetime budget in credits; mandatory on a group binding.
    pub total_budget: Option<u64>,
    /// Proposed expiry, block time in ms.
    pub expires_at_ms: Option<u64>,
}

impl AuthBinding {
    /// The key bounds this binding asks for.
    pub fn bounds(&self) -> super::KeyBounds {
        use super::KeyBounds;
        match self.kind {
            BindingKind::SingleContract => KeyBounds::SingleContract {
                contract_id: self.id,
            },
            BindingKind::DocumentType => KeyBounds::DocumentType {
                contract_id: self.id,
                document_type_name: self.document_type_name.clone().unwrap_or_default(),
            },
            BindingKind::ContractGroup => KeyBounds::ContractGroup { group_id: self.id },
        }
    }
}

/// An encryption key the app asks for (`singleContract` on its contract).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncBinding {
    /// The contract.
    pub contract_id: Id,
    /// ENCRYPTION or DECRYPTION.
    pub purpose: u8,
}

/// The MODE TLV; absent means login.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// A renewal of an earlier grant.
    Renew,
}

/// An App Connect v2 request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    /// The app's ephemeral public key (compressed).
    pub app_ephemeral_pub_key: [u8; 33],
    /// The app's id: a contract whose owner owns every group the request binds.
    pub app_id: Id,
    /// The name the wallet shows.
    pub label: String,
    /// 1–4 keys; the first is the primary binding a wallet may not decline on its own.
    pub auth_bindings: Vec<AuthBinding>,
    /// 0–2 encryption keys.
    pub enc_bindings: Vec<EncBinding>,
    /// When the request was made, ms since the epoch.
    pub created_at_ms: u64,
    /// The identity a renewal is for.
    pub identity_hint: Option<Id>,
    /// The app's connection id.
    pub connection_id: Option<[u8; 16]>,
    /// Renew or (absent) login.
    pub mode: Option<Mode>,
}

/// Why a request was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestErrorCode {
    /// A version or mandatory field this decoder does not know (a newer app).
    Unsupported,
    /// Anything else that breaks the format.
    Invalid,
}

/// A request that breaks the format.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("App Connect request: {message}")]
pub struct RequestError {
    /// Unsupported or invalid.
    pub code: RequestErrorCode,
    /// What is wrong.
    pub message: String,
}

fn invalid(message: impl Into<String>) -> RequestError {
    RequestError {
        code: RequestErrorCode::Invalid,
        message: message.into(),
    }
}

fn unsupported(message: impl Into<String>) -> RequestError {
    RequestError {
        code: RequestErrorCode::Unsupported,
        message: message.into(),
    }
}

/// `hash160(appEphPub)`: the `appEphemeralPubKeyHash` answers are stored under.
pub fn request_hash(request: &Request) -> [u8; 20] {
    hash160(&request.app_ephemeral_pub_key)
}

/// C0 and C1 controls, and the bidi marks, embeddings, overrides and isolates a label could use
/// to disguise itself.
fn forbidden_in_label(c: char) -> bool {
    matches!(c,
        '\u{0000}'..='\u{001f}'
        | '\u{007f}'..='\u{009f}'
        | '\u{061c}'
        | '\u{200e}'
        | '\u{200f}'
        | '\u{202a}'..='\u{202e}'
        | '\u{2066}'..='\u{2069}')
}

fn valid_document_type_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn valid_ms(ms: u64) -> bool {
    (1..=MAX_SAFE_INTEGER).contains(&ms)
}

/// The protocol rules every request obeys, whoever built it. The encoder runs it before writing
/// and the decoder after reading, so neither side can produce or accept a request the other
/// would refuse.
pub fn validate(request: &Request) -> Result<(), RequestError> {
    if secp256k1::PublicKey::from_slice(&request.app_ephemeral_pub_key).is_err() {
        return Err(invalid(
            "app ephemeral public key is not a compressed secp256k1 point",
        ));
    }
    if request.label.len() > MAX_LABEL_BYTES {
        return Err(invalid(format!(
            "label is longer than {MAX_LABEL_BYTES} bytes"
        )));
    }
    if request.label.chars().any(forbidden_in_label) {
        return Err(invalid(
            "label contains control or bidirectional formatting characters",
        ));
    }

    let auth = &request.auth_bindings;
    if auth.is_empty() || auth.len() > MAX_AUTH_BINDINGS {
        return Err(invalid(format!(
            "expected 1 to {MAX_AUTH_BINDINGS} auth bindings, got {}",
            auth.len()
        )));
    }
    for (i, binding) in auth.iter().enumerate() {
        check_auth_binding(binding)?;
        if auth[..i].iter().any(|b| {
            b.kind == binding.kind
                && b.id == binding.id
                && b.document_type_name == binding.document_type_name
        }) {
            return Err(invalid("duplicate auth binding"));
        }
    }

    let enc = &request.enc_bindings;
    if enc.len() > MAX_ENC_BINDINGS {
        return Err(invalid(format!(
            "expected at most {MAX_ENC_BINDINGS} encryption bindings, got {}",
            enc.len()
        )));
    }
    for (i, binding) in enc.iter().enumerate() {
        if binding.purpose != purpose::ENCRYPTION && binding.purpose != purpose::DECRYPTION {
            return Err(invalid(format!(
                "encryption binding purpose {} is not ENCRYPTION or DECRYPTION",
                binding.purpose
            )));
        }
        if enc[..i].contains(binding) {
            return Err(invalid("duplicate encryption binding"));
        }
    }

    if !valid_ms(request.created_at_ms) {
        return Err(invalid(
            "created-at must be a positive millisecond timestamp",
        ));
    }
    Ok(())
}

fn check_auth_binding(binding: &AuthBinding) -> Result<(), RequestError> {
    let kind = binding.kind;
    match (&binding.document_type_name, kind) {
        (Some(name), BindingKind::DocumentType) if valid_document_type_name(name) => {}
        (_, BindingKind::DocumentType) => {
            return Err(invalid(
                "a documentType binding needs a document type name of 1-64 [A-Za-z0-9_-]",
            ))
        }
        (Some(_), _) => {
            return Err(invalid(format!(
                "a {kind:?} binding carries no document type name"
            )))
        }
        (None, _) => {}
    }

    let l = binding.security_level;
    let allowed = if kind == BindingKind::ContractGroup {
        l == level::CRITICAL || l == level::HIGH
    } else {
        l == level::HIGH
    };
    if !allowed {
        return Err(invalid(format!(
            "security level {l} is not allowed on a {kind:?} binding"
        )));
    }

    if binding.total_budget == Some(0) {
        return Err(invalid("total budget must be between 1 and 2^64-1 credits"));
    }
    if kind == BindingKind::ContractGroup && binding.total_budget.is_none() {
        return Err(invalid("a contractGroup binding must carry a budget"));
    }
    if binding.expires_at_ms.is_some_and(|e| !valid_ms(e)) {
        return Err(invalid(
            "expires-at must be a positive millisecond timestamp",
        ));
    }
    Ok(())
}

/// The canonical encoding of `request` (validated first).
pub fn encode(request: &Request) -> Result<Vec<u8>, RequestError> {
    validate(request)?;

    let mut out = vec![REQUEST_VERSION];
    out.extend_from_slice(&request.app_ephemeral_pub_key);
    out.extend_from_slice(&request.app_id);
    push_short(&mut out, request.label.as_bytes());

    let mut put = |kind: u8, value: &[u8]| {
        out.push(kind);
        push_short(&mut out, value);
    };
    if let Some(hint) = &request.identity_hint {
        put(tlv::IDENTITY_HINT, hint);
    }
    for binding in &request.auth_bindings {
        put(tlv::AUTH_BINDING, &encode_auth_binding(binding));
    }
    if let Some(id) = &request.connection_id {
        put(tlv::CONNECTION_ID, id);
    }
    for binding in &request.enc_bindings {
        let mut value = binding.contract_id.to_vec();
        value.push(binding.purpose);
        put(tlv::ENC_BINDING, &value);
    }
    if request.mode == Some(Mode::Renew) {
        put(tlv::MODE, &[1]);
    }
    put(tlv::CREATED_AT, &request.created_at_ms.to_be_bytes());
    Ok(out)
}

/// `len(1) ‖ bytes`; every caller's bytes are validated to fit.
fn push_short(out: &mut Vec<u8>, bytes: &[u8]) {
    out.push(u8::try_from(bytes.len()).expect("validated to fit in one length byte"));
    out.extend_from_slice(bytes);
}

fn encode_auth_binding(binding: &AuthBinding) -> Vec<u8> {
    let mut out = vec![binding.kind.tag(), binding.security_level];
    out.extend_from_slice(&binding.id);
    out.extend_from_slice(&binding.total_budget.unwrap_or(0).to_be_bytes());
    out.extend_from_slice(&binding.expires_at_ms.unwrap_or(0).to_be_bytes());
    if let Some(name) = &binding.document_type_name {
        push_short(&mut out, name.as_bytes());
    }
    out
}

fn read_u64(bytes: &[u8], offset: usize) -> u64 {
    u64::from_be_bytes(
        bytes[offset..offset + 8]
            .try_into()
            .expect("callers check the length"),
    )
}

/// A millisecond field: `None` for zero, refused past `Number.MAX_SAFE_INTEGER`.
fn read_ms(bytes: &[u8], offset: usize, what: &str) -> Result<Option<u64>, RequestError> {
    match read_u64(bytes, offset) {
        0 => Ok(None),
        v if v > MAX_SAFE_INTEGER => Err(invalid(format!("{what} is out of range"))),
        v => Ok(Some(v)),
    }
}

fn fixed_value_bytes(kind: u8) -> Option<usize> {
    match kind {
        tlv::IDENTITY_HINT => Some(32),
        tlv::CONNECTION_ID => Some(16),
        tlv::ENC_BINDING => Some(33),
        tlv::MODE => Some(1),
        tlv::CREATED_AT => Some(8),
        _ => None,
    }
}

/// Decode and validate a request body.
pub fn decode(bytes: &[u8]) -> Result<Request, RequestError> {
    let Some(&version) = bytes.first() else {
        return Err(invalid("empty request"));
    };
    if version != REQUEST_VERSION {
        return Err(unsupported(format!(
            "unsupported request version {version}"
        )));
    }
    if bytes.len() < HEADER_BYTES {
        return Err(invalid("request is truncated"));
    }
    let app_ephemeral_pub_key: [u8; 33] = bytes[1..34].try_into().expect("checked length");
    let app_id: Id = bytes[34..66].try_into().expect("checked length");
    let label_len = usize::from(bytes[66]);
    if label_len > MAX_LABEL_BYTES {
        return Err(invalid("label is too long"));
    }
    let mut offset = HEADER_BYTES;
    let label = bytes
        .get(offset..offset + label_len)
        .ok_or_else(|| invalid("request is truncated"))?;
    let label = std::str::from_utf8(label)
        .map_err(|_| invalid("label is not valid UTF-8"))?
        .to_string();
    offset += label_len;

    let mut request = Request {
        app_ephemeral_pub_key,
        app_id,
        label,
        auth_bindings: vec![],
        enc_bindings: vec![],
        created_at_ms: 0,
        identity_hint: None,
        connection_id: None,
        mode: None,
    };
    let mut previous = 0u8;

    while offset < bytes.len() {
        let (Some(&kind), Some(&len)) = (bytes.get(offset), bytes.get(offset + 1)) else {
            return Err(invalid("TLV header is truncated"));
        };
        offset += 2;
        let value = bytes
            .get(offset..offset + usize::from(len))
            .ok_or_else(|| invalid(format!("TLV 0x{kind:02x} is truncated")))?;
        offset += usize::from(len);

        // The repeatable known types, and any unknown optional type (a future one may repeat).
        let repeatable = kind == tlv::AUTH_BINDING
            || kind == tlv::ENC_BINDING
            || (kind % 2 == 1 && !KNOWN_TLV_TYPES.contains(&kind));
        if kind < previous || (kind == previous && !repeatable) {
            return Err(invalid(format!(
                "TLV 0x{kind:02x} is out of order or repeated"
            )));
        }
        previous = kind;

        read_tlv(&mut request, kind, value)?;
    }

    // CREATED_AT is never zero, so zero means it was absent.
    if request.created_at_ms == 0 {
        return Err(invalid("request has no created-at"));
    }
    validate(&request)?;
    Ok(request)
}

/// Apply one TLV to `request`, refusing a known one of the wrong length.
fn read_tlv(request: &mut Request, kind: u8, value: &[u8]) -> Result<(), RequestError> {
    if let Some(fixed) = fixed_value_bytes(kind) {
        if value.len() != fixed {
            return Err(invalid(format!("TLV 0x{kind:02x} must be {fixed} bytes")));
        }
    }
    match kind {
        tlv::IDENTITY_HINT => {
            request.identity_hint = Some(value.try_into().expect("fixed length"));
        }
        tlv::AUTH_BINDING => {
            if request.auth_bindings.len() == MAX_AUTH_BINDINGS {
                return Err(invalid("too many auth bindings"));
            }
            request.auth_bindings.push(decode_auth_binding(value)?);
        }
        tlv::CONNECTION_ID => {
            request.connection_id = Some(value.try_into().expect("fixed length"));
        }
        tlv::ENC_BINDING => {
            if request.enc_bindings.len() == MAX_ENC_BINDINGS {
                return Err(invalid("too many encryption bindings"));
            }
            request.enc_bindings.push(EncBinding {
                contract_id: value[..32].try_into().expect("fixed length"),
                purpose: value[32],
            });
        }
        tlv::MODE => {
            if value[0] != 1 {
                return Err(invalid(format!("unknown mode {}", value[0])));
            }
            request.mode = Some(Mode::Renew);
        }
        tlv::CREATED_AT => {
            request.created_at_ms =
                read_ms(value, 0, "created-at")?.ok_or_else(|| invalid("created-at is zero"))?;
        }
        k if k % 2 == 0 => {
            return Err(unsupported(format!("unknown mandatory TLV 0x{k:02x}")));
        }
        _ => {}
    }
    Ok(())
}

fn decode_auth_binding(value: &[u8]) -> Result<AuthBinding, RequestError> {
    if value.len() < AUTH_BINDING_FIXED_BYTES {
        return Err(invalid("auth binding is truncated"));
    }
    let kind = BindingKind::from_tag(value[0])
        .ok_or_else(|| unsupported(format!("unknown auth binding kind {}", value[0])))?;
    let mut binding = AuthBinding {
        kind,
        security_level: value[1],
        id: value[2..34].try_into().expect("checked length"),
        document_type_name: None,
        total_budget: Some(read_u64(value, 34)).filter(|b| *b > 0),
        expires_at_ms: read_ms(value, 42, "expires-at")?,
    };

    let rest = &value[AUTH_BINDING_FIXED_BYTES..];
    if kind == BindingKind::DocumentType {
        let name = match rest.split_first() {
            Some((&len, name)) if usize::from(len) == name.len() => name,
            _ => return Err(invalid("document type name length does not match")),
        };
        binding.document_type_name = Some(
            std::str::from_utf8(name)
                .map_err(|_| invalid("document type name is not valid UTF-8"))?
                .to_string(),
        );
    } else if !rest.is_empty() {
        return Err(invalid(format!(
            "a {kind:?} binding carries trailing bytes"
        )));
    }
    Ok(binding)
}

/// The one-letter network id of the `n=` parameter.
pub fn network_id(network: &Network) -> char {
    match network {
        Network::Mainnet => 'm',
        Network::Testnet => 't',
        Network::Devnet { .. } => 'd',
    }
}

/// The `dash-key:<base58(body)>?n=<m|t|d>&v=2` link a wallet scans (no `cb`).
pub fn build_uri(request: &Request, network: &Network) -> Result<String, RequestError> {
    Ok(format!(
        "dash-key:{}?n={}&v={REQUEST_VERSION}",
        encode_base58(&encode(request)?),
        network_id(network)
    ))
}

/// How a request's age stands against the wallet's freshness rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestAge {
    /// Created more than 10 minutes before `now`.
    Stale,
    /// Created more than 2 minutes after `now`.
    Future,
}

/// The wallet's freshness rule; `None` when the request is fresh.
pub fn check_request_age(created_at_ms: u64, now_ms: u64) -> Option<RequestAge> {
    if now_ms.saturating_sub(created_at_ms) > MAX_REQUEST_AGE_MS {
        Some(RequestAge::Stale)
    } else if created_at_ms.saturating_sub(now_ms) > MAX_REQUEST_SKEW_MS {
        Some(RequestAge::Future)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_vectors::{
        dashpay, hex, renew_request, seed, vectors, yappr_request, VECTOR_CREATED_AT,
    };
    use super::*;

    // Layout of the Yappr vector request: a 72-byte header (version, key, app id, label
    // "Yappr"), the group AUTH_BINDING TLV at 72 (52 bytes), the DashPay profile AUTH_BINDING at
    // 124 (60 bytes), CONNECTION_ID at 184, ENC_BINDING at 202 and CREATED_AT last.
    const GROUP_KIND_AT: usize = 74;
    const PROFILE_LEVEL_AT: usize = 127;
    const CONNECTION_ID_AT: usize = 184;

    fn with_tlv(bytes: &[u8], kind: u8, value: &[u8]) -> Vec<u8> {
        let mut out = bytes.to_vec();
        out.push(kind);
        out.push(u8::try_from(value.len()).unwrap());
        out.extend_from_slice(value);
        out
    }

    fn code(bytes: &[u8]) -> RequestErrorCode {
        decode(bytes).unwrap_err().code
    }

    #[test]
    fn encodes_the_vector_requests_byte_for_byte() {
        let v = vectors();
        assert_eq!(
            hex::encode(yappr_request().app_ephemeral_pub_key),
            v["request"]["appEphemeralPubKey"].as_str().unwrap()
        );
        assert_eq!(
            encode(&yappr_request()).unwrap(),
            hex(&v["request"]["bytes"])
        );
        assert_eq!(
            encode(&renew_request()).unwrap(),
            hex(&v["renewRequest"]["bytes"])
        );
        assert_eq!(
            request_hash(&yappr_request()).to_vec(),
            hex(&v["request"]["appEphemeralPubKeyHash"])
        );
    }

    #[test]
    fn builds_the_vector_uris() {
        let v = vectors();
        // The renewal's URI carries no callback, so it is reproduced exactly.
        assert_eq!(
            build_uri(&renew_request(), &Network::Testnet).unwrap(),
            v["renewRequest"]["uri"].as_str().unwrap()
        );
        // The login's URI adds `&cb=…` (a web app's), which this side never builds.
        let devnet = Network::Devnet {
            name: "x".into(),
            dapi_addresses: vec![],
            quorum_base_url: None,
        };
        let ours = build_uri(&yappr_request(), &devnet).unwrap();
        let theirs = v["request"]["uri"].as_str().unwrap();
        assert_eq!(theirs.split_once("&cb=").unwrap().0, ours);
    }

    #[test]
    fn decodes_the_vector_bytes_and_uri_bodies() {
        let v = vectors();
        assert_eq!(
            decode(&hex(&v["request"]["bytes"])).unwrap(),
            yappr_request()
        );
        assert_eq!(
            decode(&hex(&v["renewRequest"]["bytes"])).unwrap(),
            renew_request()
        );
        for (uri, expected) in [
            (&v["request"]["uri"], yappr_request()),
            (&v["renewRequest"]["uri"], renew_request()),
        ] {
            let body = uri.as_str().unwrap()["dash-key:".len()..]
                .split_once('?')
                .unwrap()
                .0;
            assert_eq!(
                decode(&bs58::decode(body).into_vec().unwrap()).unwrap(),
                expected
            );
        }
        let decoded = decode(&encode(&yappr_request()).unwrap()).unwrap();
        assert_eq!(decoded.auth_bindings[1].id, dashpay());
    }

    #[test]
    fn ignores_unknown_optional_tlvs_even_repeated() {
        let bytes = encode(&yappr_request()).unwrap();
        let odd = with_tlv(&with_tlv(&bytes, 0x07, &[0xaa, 0xbb]), 0x09, &[]);
        assert_eq!(decode(&odd).unwrap(), yappr_request());
        let repeated = with_tlv(&with_tlv(&bytes, 0x07, &[1]), 0x07, &[2]);
        assert_eq!(decode(&repeated).unwrap(), yappr_request());
    }

    #[test]
    fn refuses_unknown_mandatory_tlvs_and_binding_kinds_as_unsupported() {
        let bytes = encode(&yappr_request()).unwrap();
        assert_eq!(
            code(&with_tlv(&bytes, 0x08, &[1])),
            RequestErrorCode::Unsupported
        );
        let mut tampered = bytes.clone();
        tampered[GROUP_KIND_AT] = 7;
        assert_eq!(code(&tampered), RequestErrorCode::Unsupported);
    }

    #[test]
    fn refuses_every_truncation() {
        let bytes = encode(&yappr_request()).unwrap();
        for len in 0..bytes.len() {
            assert!(decode(&bytes[..len]).is_err(), "length {len}");
        }
    }

    #[test]
    fn refuses_a_v1_body_as_unsupported() {
        let mut bytes = encode(&yappr_request()).unwrap();
        bytes[0] = 1;
        assert_eq!(code(&bytes), RequestErrorCode::Unsupported);
    }

    #[test]
    fn refuses_tlvs_out_of_order_and_repeated_singletons() {
        let base = encode(&yappr_request()).unwrap();
        let again = with_tlv(&base, 0x06, &[0, 0, 1, 0x99, 0, 0, 0, 0]);
        assert_eq!(code(&again), RequestErrorCode::Invalid);
        let hint_after = with_tlv(&base, 0x01, &[1; 32]);
        assert_eq!(code(&hint_after), RequestErrorCode::Invalid);
    }

    #[test]
    fn refuses_known_tlvs_with_the_wrong_length() {
        let mut request = yappr_request();
        request.connection_id = None;
        let bytes = encode(&request).unwrap();
        let mut spliced = bytes[..CONNECTION_ID_AT].to_vec();
        spliced.extend_from_slice(&[0x03, 15]);
        spliced.extend_from_slice(&[0; 15]);
        spliced.extend_from_slice(&bytes[CONNECTION_ID_AT..]);
        assert_eq!(code(&spliced), RequestErrorCode::Invalid);
    }

    #[test]
    fn only_knows_mode_renew() {
        let renew = encode(&renew_request()).unwrap();
        let mode_at = renew.len() - 10 - 3;
        assert_eq!(renew[mode_at..mode_at + 3], [0x05, 1, 1]);
        let mut zero = renew.clone();
        zero[mode_at + 2] = 0;
        assert_eq!(code(&zero), RequestErrorCode::Invalid);
    }

    #[test]
    fn keeps_a_leading_bom_instead_of_stripping_it() {
        let mut labelled = yappr_request();
        labelled.label = "\u{feff}Yappr".into();
        assert_eq!(
            decode(&encode(&labelled).unwrap()).unwrap().label,
            "\u{feff}Yappr"
        );

        // A DashPay binding whose name is EF BB BF "profile" must not decode as "profile".
        let bytes = encode(&yappr_request()).unwrap();
        let name_at = PROFILE_LEVEL_AT + 1 + 32 + 16;
        assert_eq!(bytes[name_at], 7);
        let mut spliced = bytes[..PROFILE_LEVEL_AT - 3].to_vec();
        spliced.extend_from_slice(&[0x02, 61]);
        spliced.extend_from_slice(&bytes[PROFILE_LEVEL_AT - 1..name_at]);
        spliced.extend_from_slice(&[10, 0xef, 0xbb, 0xbf]);
        spliced.extend_from_slice(&bytes[name_at + 1..]);
        assert!(decode(&spliced)
            .unwrap_err()
            .message
            .contains("document type name"));
    }

    #[test]
    fn requires_created_at() {
        let bytes = encode(&yappr_request()).unwrap();
        assert_eq!(code(&bytes[..bytes.len() - 10]), RequestErrorCode::Invalid);
    }

    #[test]
    fn refuses_timestamps_javascript_cannot_hold() {
        let bytes = encode(&yappr_request()).unwrap();
        let mut late = bytes[..bytes.len() - 8].to_vec();
        late.extend_from_slice(&(MAX_SAFE_INTEGER + 1).to_be_bytes());
        assert!(decode(&late).unwrap_err().message.contains("out of range"));
        let mut request = yappr_request();
        request.created_at_ms = MAX_SAFE_INTEGER + 1;
        assert!(encode(&request).is_err());
    }

    #[test]
    fn enforces_binding_rules_on_encode_and_decode() {
        let request = yappr_request();
        let group = request.auth_bindings[0].clone();
        let profile = request.auth_bindings[1].clone();
        let with = |f: &dyn Fn(&mut Request)| {
            let mut r = yappr_request();
            f(&mut r);
            r
        };
        let named = |name: &str| AuthBinding {
            document_type_name: Some(name.into()),
            ..profile.clone()
        };
        let mut bad_key = [0xffu8; 33];
        bad_key[0] = 2;
        let cases: Vec<(&str, Request)> = vec![
            (
                "CRITICAL on a documentType binding",
                with(&|r| r.auth_bindings[1].security_level = level::CRITICAL),
            ),
            (
                "MASTER on a group binding",
                with(&|r| r.auth_bindings[0].security_level = level::MASTER),
            ),
            (
                "MEDIUM on a group binding",
                with(&|r| r.auth_bindings[0].security_level = level::MEDIUM),
            ),
            (
                "a group binding without a budget",
                with(&|r| r.auth_bindings[0].total_budget = None),
            ),
            (
                "a zero budget",
                with(&|r| r.auth_bindings[1].total_budget = Some(0)),
            ),
            (
                "a documentType binding without a name",
                with(&|r| r.auth_bindings[1].document_type_name = None),
            ),
            (
                "a bad document type name",
                with(&|r| r.auth_bindings[1].document_type_name = Some("pro file".into())),
            ),
            (
                "a name on a group binding",
                with(&|r| r.auth_bindings[0].document_type_name = Some("post".into())),
            ),
            ("no auth bindings", with(&|r| r.auth_bindings.clear())),
            (
                "five auth bindings",
                with(&|r| {
                    r.auth_bindings = vec![
                        group.clone(),
                        profile.clone(),
                        named("a"),
                        named("b"),
                        named("c"),
                    ];
                }),
            ),
            (
                "duplicate auth bindings",
                with(&|r| r.auth_bindings = vec![group.clone(), group.clone()]),
            ),
            (
                "an encryption binding with the AUTHENTICATION purpose",
                with(&|r| r.enc_bindings[0].purpose = purpose::AUTHENTICATION),
            ),
            (
                "duplicate encryption bindings",
                with(&|r| r.enc_bindings.push(r.enc_bindings[0].clone())),
            ),
            ("a long label", with(&|r| r.label = "x".repeat(65))),
            (
                "a label with a bidi override",
                with(&|r| r.label = "Yappr\u{202e}".into()),
            ),
            (
                "a label with a control character",
                with(&|r| r.label = "Yap\npr".into()),
            ),
            (
                "an invalid ephemeral key",
                with(&|r| r.app_ephemeral_pub_key = bad_key),
            ),
            ("no created-at", with(&|r| r.created_at_ms = 0)),
        ];
        for (name, bad) in cases {
            assert!(encode(&bad).is_err(), "{name}");
        }

        // The decoder applies the same rules to bytes a lax encoder produced.
        let mut tampered = encode(&request).unwrap();
        assert_eq!(tampered[PROFILE_LEVEL_AT], level::HIGH);
        tampered[PROFILE_LEVEL_AT] = level::CRITICAL;
        assert!(decode(&tampered)
            .unwrap_err()
            .message
            .contains("security level 1"));
    }

    #[test]
    fn a_64_byte_label_fits() {
        let mut request = yappr_request();
        request.label = "é".repeat(32);
        assert_eq!(decode(&encode(&request).unwrap()).unwrap(), request);
    }

    #[test]
    fn applies_the_wallet_freshness_window() {
        let t = VECTOR_CREATED_AT;
        assert_eq!(check_request_age(t, t + 10 * 60_000), None);
        assert_eq!(
            check_request_age(t, t + 10 * 60_000 + 1),
            Some(RequestAge::Stale)
        );
        assert_eq!(check_request_age(t, t - 2 * 60_000), None);
        assert_eq!(
            check_request_age(t, t - 2 * 60_000 - 1),
            Some(RequestAge::Future)
        );
    }

    #[test]
    fn the_hint_and_ids_are_raw_bytes() {
        assert_eq!(renew_request().identity_hint, Some(seed("owner")));
    }
}
