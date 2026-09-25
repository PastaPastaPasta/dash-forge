//! AWS Signature Version 4 request signing, for S3-compatible object stores (AWS S3,
//! Cloudflare R2, Backblaze B2, MinIO).
//!
//! Implemented here rather than pulled in: the pieces SigV4 needs (HMAC-SHA256, SHA-256,
//! RFC 3986 percent-encoding) are already in the dependency tree, while the maintained
//! crates either drag in the AWS SDK's HTTP abstractions (`aws-sigv4`) or a second copy of
//! the RustCrypto stack at newer major versions (`rusty-s3`). The algorithm is small and
//! fully specified; correctness is pinned by the official test vectors (the AWS SigV4 test
//! suite and the worked S3 examples in the S3 API reference) in this module's tests, and
//! exercised live against MinIO by `make storage-it`.
//!
//! Two forms are provided:
//! - [`sign_request`] — header-based auth (`Authorization: AWS4-HMAC-SHA256 …`), used by
//!   the CLI for `PUT`/`GET`/`HEAD`/`DELETE`. The payload hash is always the real SHA-256
//!   of the body, so the store verifies the upload's integrity server-side.
//! - [`presign_url`] — query-string auth, for handing a browser a time-limited URL (the
//!   web app's future direct-upload path) without giving it the secret.
//!
//! S3 canonicalization rules (which differ from the generic SigV4 rules): the path is
//! percent-encoded ONCE, each segment separately, keeping `/`; it is never normalized
//! (`.`/`..` segments are rejected by the caller instead, because an HTTP stack would
//! normalize them after signing and break the signature).

use std::time::{SystemTime, UNIX_EPOCH};

use hmac::{Hmac, Mac};
use sha2::{Digest as _, Sha256};

/// The SHA-256 of the empty string — the payload hash of every body-less request.
pub const EMPTY_PAYLOAD_SHA256: &str =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/// The payload-hash placeholder for presigned URLs (the body is not known at signing time).
pub const UNSIGNED_PAYLOAD: &str = "UNSIGNED-PAYLOAD";

const ALGORITHM: &str = "AWS4-HMAC-SHA256";

/// The credentials a request is signed with. `secret_access_key` and `session_token` are
/// borrowed from a redacting holder ([`crate::keystore::Secret`]); this type never
/// formats them.
#[derive(Clone, Copy)]
pub struct SigningKeys<'a> {
    /// The access key id (appears in the `Credential=` scope; not secret).
    pub access_key_id: &'a str,
    /// The secret access key (never logged).
    pub secret_access_key: &'a str,
    /// An STS session token, when the credentials are temporary.
    pub session_token: Option<&'a str>,
}

impl std::fmt::Debug for SigningKeys<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SigningKeys")
            .field("access_key_id", &self.access_key_id)
            .field("secret_access_key", &"<redacted>")
            .field("session_token", &self.session_token.map(|_| "<redacted>"))
            .finish()
    }
}

/// A signing timestamp in the two forms SigV4 uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AmzDate {
    /// `YYYYMMDD` (the credential-scope date).
    pub date: String,
    /// `YYYYMMDDTHHMMSSZ` (the `x-amz-date` value).
    pub datetime: String,
}

impl AmzDate {
    /// The current UTC time.
    pub fn now() -> Self {
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        Self::from_unix(secs)
    }

    /// The UTC time `secs` seconds after the Unix epoch.
    pub fn from_unix(secs: u64) -> Self {
        let days = i64::try_from(secs / 86_400).unwrap_or(i64::MAX);
        let rem = secs % 86_400;
        let (y, m, d) = civil_from_days(days);
        let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
        let date = format!("{y:04}{m:02}{d:02}");
        let datetime = format!("{date}T{hh:02}{mm:02}{ss:02}Z");
        Self { date, datetime }
    }
}

/// Days since 1970-01-01 → proleptic Gregorian `(year, month, day)` (H. Hinnant's
/// `civil_from_days`), so no date/time crate is needed for a UTC stamp.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (
        y,
        u32::try_from(m).unwrap_or(1),
        u32::try_from(d).unwrap_or(1),
    )
}

/// RFC 3986 percent-encoding as SigV4 specifies it: every byte except the unreserved set
/// `A-Z a-z 0-9 - . _ ~` becomes `%XX` (uppercase hex). With `keep_slash`, `/` is left
/// as-is (object-key paths); query keys and values encode it.
pub fn uri_encode(input: &str, keep_slash: bool) -> String {
    let mut out = String::with_capacity(input.len());
    for &b in input.as_bytes() {
        let unreserved = b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~');
        if unreserved || (keep_slash && b == b'/') {
            out.push(char::from(b));
        } else {
            const HEX: &[u8; 16] = b"0123456789ABCDEF";
            out.push('%');
            out.push(char::from(HEX[usize::from(b >> 4)]));
            out.push(char::from(HEX[usize::from(b & 0xf)]));
        }
    }
    out
}

/// Lowercase-hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().into()
}

/// The derived signing key: `HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), service),
/// "aws4_request")`.
pub fn signing_key(secret: &str, date: &str, region: &str, service: &str) -> [u8; 32] {
    let k_date = hmac_sha256(format!("AWS4{secret}").as_bytes(), date.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, service.as_bytes());
    hmac_sha256(&k_service, b"aws4_request")
}

/// The canonical query string: each key and value URI-encoded (slashes included), sorted
/// by encoded key then encoded value, joined with `&`. A key with no value keeps its `=`.
pub fn canonical_query(pairs: &[(String, String)]) -> String {
    let mut enc: Vec<(String, String)> = pairs
        .iter()
        .map(|(k, v)| (uri_encode(k, false), uri_encode(v, false)))
        .collect();
    enc.sort();
    enc.iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&")
}

/// Canonical headers + the `SignedHeaders` list: names lowercased, values trimmed with
/// inner whitespace runs collapsed to one space, sorted by name, duplicates joined by `,`.
pub fn canonical_headers(headers: &[(String, String)]) -> (String, String) {
    let mut norm: Vec<(String, String)> = headers
        .iter()
        .map(|(k, v)| {
            (
                k.trim().to_ascii_lowercase(),
                v.split_whitespace().collect::<Vec<_>>().join(" "),
            )
        })
        .collect();
    // Stable sort keeps duplicate names in the order they were given.
    norm.sort_by(|a, b| a.0.cmp(&b.0));
    let mut merged: Vec<(String, String)> = Vec::with_capacity(norm.len());
    for (k, v) in norm {
        match merged.last_mut() {
            Some((lk, lv)) if *lk == k => {
                lv.push(',');
                lv.push_str(&v);
            }
            _ => merged.push((k, v)),
        }
    }
    let mut canonical = String::new();
    for (k, v) in &merged {
        canonical.push_str(k);
        canonical.push(':');
        canonical.push_str(v);
        canonical.push('\n');
    }
    let signed = merged
        .iter()
        .map(|(k, _)| k.as_str())
        .collect::<Vec<_>>()
        .join(";");
    (canonical, signed)
}

/// The full canonical request (the text whose hash is signed).
pub fn canonical_request(
    method: &str,
    canonical_uri: &str,
    canonical_query: &str,
    headers: &[(String, String)],
    payload_hash: &str,
) -> String {
    let (canon_headers, signed_headers) = canonical_headers(headers);
    format!(
        "{method}\n{canonical_uri}\n{canonical_query}\n{canon_headers}\n{signed_headers}\n{payload_hash}"
    )
}

/// The credential scope `date/region/service/aws4_request`.
pub fn credential_scope(date: &str, region: &str, service: &str) -> String {
    format!("{date}/{region}/{service}/aws4_request")
}

/// The string to sign for `canonical_request`.
pub fn string_to_sign(datetime: &str, scope: &str, canonical_request: &str) -> String {
    format!(
        "{ALGORITHM}\n{datetime}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    )
}

/// One request to sign with [`sign_request`].
#[derive(Debug, Clone)]
pub struct RequestToSign<'a> {
    /// HTTP method (`GET`, `PUT`, `HEAD`, `DELETE`, …).
    pub method: &'a str,
    /// The `Host` header value exactly as it will be sent (`host` or `host:port` for a
    /// non-default port).
    pub host: &'a str,
    /// The already-encoded path (see [`uri_encode`] with `keep_slash`).
    pub canonical_uri: &'a str,
    /// Raw (unencoded) query pairs.
    pub query: &'a [(String, String)],
    /// Extra headers to sign (e.g. `range`, `content-type`); `host`, `x-amz-date` and
    /// the payload/token headers are added by the signer.
    pub headers: &'a [(String, String)],
    /// Hex SHA-256 of the body (or [`EMPTY_PAYLOAD_SHA256`]).
    pub payload_hash: &'a str,
    /// Region (`us-east-1`, R2's `auto`, B2's `us-west-004`, …).
    pub region: &'a str,
    /// Service name (`s3`).
    pub service: &'a str,
    /// Whether to send + sign `x-amz-content-sha256` (S3 requires it; the generic test
    /// suite does not use it).
    pub content_sha256_header: bool,
}

/// Sign `req`, returning the headers to add to the outgoing request (including
/// `Authorization`). The `Host` header is signed but not returned — the HTTP client sets
/// it from the URL, which must therefore produce exactly `req.host`.
pub fn sign_request(
    req: &RequestToSign<'_>,
    keys: SigningKeys<'_>,
    when: &AmzDate,
) -> Vec<(String, String)> {
    let mut added: Vec<(String, String)> = vec![("x-amz-date".into(), when.datetime.clone())];
    if req.content_sha256_header {
        added.push(("x-amz-content-sha256".into(), req.payload_hash.to_string()));
    }
    if let Some(token) = keys.session_token {
        added.push(("x-amz-security-token".into(), token.to_string()));
    }

    let mut all: Vec<(String, String)> = Vec::with_capacity(req.headers.len() + added.len() + 1);
    all.push(("host".into(), req.host.to_string()));
    all.extend(req.headers.iter().cloned());
    all.extend(added.iter().cloned());

    let creq = canonical_request(
        req.method,
        req.canonical_uri,
        &canonical_query(req.query),
        &all,
        req.payload_hash,
    );
    let scope = credential_scope(&when.date, req.region, req.service);
    let sts = string_to_sign(&when.datetime, &scope, &creq);
    let key = signing_key(keys.secret_access_key, &when.date, req.region, req.service);
    let signature = hex::encode(hmac_sha256(&key, sts.as_bytes()));
    let (_, signed_headers) = canonical_headers(&all);

    added.push((
        "authorization".into(),
        format!(
            "{ALGORITHM} Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
            keys.access_key_id
        ),
    ));
    added
}

/// Build a presigned URL (query-string auth, `UNSIGNED-PAYLOAD`, only `host` signed).
///
/// `origin` is `scheme://host[:port]` exactly as the URL will be requested and
/// `canonical_uri` the already-encoded path. The returned URL embeds a signature valid for
/// `expires_secs`; treat it as a bearer credential for that window.
#[allow(clippy::too_many_arguments)]
pub fn presign_url(
    method: &str,
    origin: &str,
    host: &str,
    canonical_uri: &str,
    region: &str,
    service: &str,
    keys: SigningKeys<'_>,
    when: &AmzDate,
    expires_secs: u64,
) -> String {
    let scope = credential_scope(&when.date, region, service);
    let mut query: Vec<(String, String)> = vec![
        ("X-Amz-Algorithm".into(), ALGORITHM.into()),
        (
            "X-Amz-Credential".into(),
            format!("{}/{scope}", keys.access_key_id),
        ),
        ("X-Amz-Date".into(), when.datetime.clone()),
        ("X-Amz-Expires".into(), expires_secs.to_string()),
        ("X-Amz-SignedHeaders".into(), "host".into()),
    ];
    if let Some(token) = keys.session_token {
        query.push(("X-Amz-Security-Token".into(), token.to_string()));
    }
    let cq = canonical_query(&query);
    let creq = canonical_request(
        method,
        canonical_uri,
        &cq,
        &[("host".into(), host.into())],
        UNSIGNED_PAYLOAD,
    );
    let sts = string_to_sign(&when.datetime, &scope, &creq);
    let key = signing_key(keys.secret_access_key, &when.date, region, service);
    let signature = hex::encode(hmac_sha256(&key, sts.as_bytes()));
    format!("{origin}{canonical_uri}?{cq}&X-Amz-Signature={signature}")
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- AWS SigV4 test suite (aws-signing-test-suite/v4, generic "service") ----------
    // Credentials, region, service and timestamp shared by every suite vector.
    const SUITE_AKID: &str = "AKIDEXAMPLE";
    const SUITE_SECRET: &str = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

    fn suite_date() -> AmzDate {
        AmzDate {
            date: "20150830".into(),
            datetime: "20150830T123600Z".into(),
        }
    }

    fn suite_sign(
        method: &str,
        path: &str,
        query: &[(&str, &str)],
        extra: &[(&str, &str)],
        token: Option<&str>,
    ) -> String {
        let query: Vec<(String, String)> = query
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        let headers: Vec<(String, String)> = extra
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        let uri = uri_encode(path, true);
        let out = sign_request(
            &RequestToSign {
                method,
                host: "example.amazonaws.com",
                canonical_uri: &uri,
                query: &query,
                headers: &headers,
                payload_hash: EMPTY_PAYLOAD_SHA256,
                region: "us-east-1",
                service: "service",
                content_sha256_header: false,
            },
            SigningKeys {
                access_key_id: SUITE_AKID,
                secret_access_key: SUITE_SECRET,
                session_token: token,
            },
            &suite_date(),
        );
        let auth = &out.iter().find(|(k, _)| k == "authorization").unwrap().1;
        auth.rsplit("Signature=").next().unwrap().to_string()
    }

    #[test]
    fn suite_get_vanilla() {
        assert_eq!(
            suite_sign("GET", "/", &[], &[], None),
            "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
        );
    }

    #[test]
    fn suite_get_space_unnormalized() {
        // The S3 rule: encode once, never normalize.
        assert_eq!(
            suite_sign("GET", "/example space/", &[], &[], None),
            "652487583200325589f1fba4c7e578f72c47cb61beeca81406b39ddec1366741"
        );
    }

    #[test]
    fn suite_get_utf8_path() {
        assert_eq!(
            suite_sign("GET", "/\u{1234}", &[], &[], None),
            "8318018e0b0f223aa2bbf98705b62bb787dc9c0e678f255a891fd03141be5d85"
        );
    }

    #[test]
    fn suite_get_unreserved() {
        assert_eq!(
            suite_sign(
                "GET",
                "/-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
                &[],
                &[],
                None
            ),
            "07ef7494c76fa4850883e2b006601f940f8a34d404d0cfa977f52a65bbf5f24f"
        );
    }

    #[test]
    fn suite_query_order_key_case() {
        assert_eq!(
            suite_sign(
                "GET",
                "/",
                &[("Param2", "value2"), ("Param1", "value1")],
                &[],
                None
            ),
            "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500"
        );
    }

    #[test]
    fn suite_utf8_query_key() {
        assert_eq!(
            suite_sign("GET", "/", &[("\u{1234}", "bar")], &[], None),
            "2cdec8eed098649ff3a119c94853b13c643bcf08f8b0a1d91e12c9027818dd04"
        );
    }

    #[test]
    fn suite_post_header_key_sort() {
        assert_eq!(
            suite_sign("POST", "/", &[], &[("My-Header1", "value1")], None),
            "c5410059b04c1ee005303aed430f6e6645f61f4dc9e1461ec8f8916fdf18852c"
        );
    }

    #[test]
    fn suite_session_token_is_signed() {
        assert_eq!(
            suite_sign(
                "GET",
                "/",
                &[],
                &[],
                Some("6e86291e8372ff2a2260956d9b8aae1d763fbf315fa00fa31553b73ebf194267")
            ),
            "07ec1639c89043aa0e3e2de82b96708f198cceab042d4a97044c66dd9f74e7f8"
        );
    }

    // ---- S3 API reference worked examples (examplebucket, 2013-05-24) -----------------
    const S3_AKID: &str = "AKIAIOSFODNN7EXAMPLE";
    const S3_SECRET: &str = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

    fn s3_date() -> AmzDate {
        AmzDate::from_unix(1_369_353_600) // 2013-05-24T00:00:00Z
    }

    fn s3_keys() -> SigningKeys<'static> {
        SigningKeys {
            access_key_id: S3_AKID,
            secret_access_key: S3_SECRET,
            session_token: None,
        }
    }

    #[test]
    fn amz_date_formats_utc() {
        assert_eq!(
            s3_date(),
            AmzDate {
                date: "20130524".into(),
                datetime: "20130524T000000Z".into()
            }
        );
        assert_eq!(
            AmzDate::from_unix(1_440_938_160).datetime,
            "20150830T123600Z"
        );
        // Leap day and end-of-year boundaries.
        assert_eq!(AmzDate::from_unix(951_782_400).date, "20000229");
        assert_eq!(
            AmzDate::from_unix(1_704_067_199).datetime,
            "20231231T235959Z"
        );
    }

    #[test]
    fn s3_get_object_with_range() {
        let out = sign_request(
            &RequestToSign {
                method: "GET",
                host: "examplebucket.s3.amazonaws.com",
                canonical_uri: "/test.txt",
                query: &[],
                headers: &[("range".into(), "bytes=0-9".into())],
                payload_hash: EMPTY_PAYLOAD_SHA256,
                region: "us-east-1",
                service: "s3",
                content_sha256_header: true,
            },
            s3_keys(),
            &s3_date(),
        );
        let auth = &out.iter().find(|(k, _)| k == "authorization").unwrap().1;
        assert_eq!(
            auth,
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, \
             SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, \
             Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
    }

    #[test]
    fn s3_put_object_with_special_char_key() {
        // Key `test$file.text` → `/test%24file.text`: the `$` must be percent-encoded.
        let body = b"Welcome to Amazon S3.";
        let payload = sha256_hex(body);
        assert_eq!(
            payload,
            "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072"
        );
        let uri = format!("/{}", uri_encode("test$file.text", true));
        assert_eq!(uri, "/test%24file.text");
        let out = sign_request(
            &RequestToSign {
                method: "PUT",
                host: "examplebucket.s3.amazonaws.com",
                canonical_uri: &uri,
                query: &[],
                headers: &[
                    ("Date".into(), "Fri, 24 May 2013 00:00:00 GMT".into()),
                    ("x-amz-storage-class".into(), "REDUCED_REDUNDANCY".into()),
                ],
                payload_hash: &payload,
                region: "us-east-1",
                service: "s3",
                content_sha256_header: true,
            },
            s3_keys(),
            &s3_date(),
        );
        let auth = &out.iter().find(|(k, _)| k == "authorization").unwrap().1;
        assert!(
            auth.ends_with(
                "SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, \
                 Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd"
            ),
            "{auth}"
        );
    }

    #[test]
    fn s3_presigned_get() {
        let url = presign_url(
            "GET",
            "https://examplebucket.s3.amazonaws.com",
            "examplebucket.s3.amazonaws.com",
            "/test.txt",
            "us-east-1",
            "s3",
            s3_keys(),
            &s3_date(),
            86_400,
        );
        assert_eq!(
            url,
            "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256\
             &X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request\
             &X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host\
             &X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"
        );
    }

    #[test]
    fn uri_encode_edge_cases() {
        assert_eq!(uri_encode("a b+c=d&e", true), "a%20b%2Bc%3Dd%26e");
        assert_eq!(uri_encode("dir/file", true), "dir/file");
        assert_eq!(uri_encode("dir/file", false), "dir%2Ffile");
        assert_eq!(uri_encode("~-._", false), "~-._");
        assert_eq!(uri_encode("ü", true), "%C3%BC");
        assert_eq!(uri_encode("100%", true), "100%25");
    }

    #[test]
    fn canonical_headers_trim_collapse_and_merge() {
        let (canon, signed) = canonical_headers(&[
            ("X-B".into(), "  two   words ".into()),
            ("x-a".into(), "1".into()),
            ("X-A".into(), "2".into()),
        ]);
        assert_eq!(canon, "x-a:1,2\nx-b:two words\n");
        assert_eq!(signed, "x-a;x-b");
    }

    #[test]
    fn empty_query_value_keeps_equals() {
        assert_eq!(
            canonical_query(&[("b".into(), String::new()), ("a".into(), "x y".into())]),
            "a=x%20y&b="
        );
    }

    #[test]
    fn debug_never_shows_secrets() {
        let rendered = format!(
            "{:?}",
            SigningKeys {
                access_key_id: "AKID",
                secret_access_key: "super-secret",
                session_token: Some("tok-secret"),
            }
        );
        assert!(!rendered.contains("super-secret"));
        assert!(!rendered.contains("tok-secret"));
    }
}
