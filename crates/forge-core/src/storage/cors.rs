//! Browser-readability checks for a storage profile's public URL, and the exact CORS
//! configuration to paste for each provider.
//!
//! The web app reads packs with `fetch(url, { headers: { Range } })` from its own origin.
//! That needs, on the PUBLIC read URL:
//! - `Access-Control-Allow-Origin` (`*` or the app origin) on GET responses,
//! - a successful preflight for the `Range` request header,
//! - a `206` answer to a ranged GET.
//!
//! `Content-Range` in `Access-Control-Expose-Headers` is nice to have, not needed: the
//! browse reader (`forge-web/lib/view/browse-source.ts`, `fetchExternalRange` /
//! `fetchBody`) accepts any `ok`/`206` body and slices a whole-body answer itself; it never
//! reads `Content-Range`. So a store that does not expose it (Storj linksharing sends no
//! `Access-Control-Expose-Headers` at all) is a warning, not a failure.
//!
//! Response headers are read the way a browser reads them (Fetch standard, "extract header
//! list values"): every line of a repeated header counts, values are comma-separated
//! lists, and names compare case-insensitively. kubo and the public IPFS gateways send
//! `Access-Control-Allow-Headers` / `Access-Control-Expose-Headers` as several lines. `*`
//! is a wildcard in both lists for a request without credentials, which is what the web
//! app's reads are (`fetch` defaults to `credentials: "same-origin"`).

use reqwest::header::HeaderMap;
use reqwest::{Client, Method, StatusCode};

/// The origin the checks present (any https origin works for a `*` policy; a policy
/// restricted to specific origins must include the forge web app's origin).
pub const PROBE_ORIGIN: &str = "https://forge.dashhq.org";

/// What the CORS probe found.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[allow(clippy::struct_excessive_bools)]
pub struct CorsReport {
    /// A GET with `Origin` returned `Access-Control-Allow-Origin` matching it (or `*`).
    pub get_allows_origin: bool,
    /// The `OPTIONS` preflight for a ranged GET succeeded and allowed `range`.
    pub preflight_allows_range: bool,
    /// `Content-Range` is exposed to scripts (nice to have; see the module docs).
    pub exposes_content_range: bool,
    /// A ranged GET came back `206`.
    pub range_206: bool,
    /// Problems, one line each, in user terms.
    pub problems: Vec<String>,
    /// Things that do not stop the web app, one line each.
    pub warnings: Vec<String>,
}

impl CorsReport {
    /// Whether a browser can read packs from the URL. `Content-Range` exposure is not
    /// required (the reader does not use it).
    pub fn browser_ok(&self) -> bool {
        self.get_allows_origin && self.preflight_allows_range && self.range_206
    }
}

/// A response header as a browser "gets" it: every line of `name`, joined with `, `
/// (Fetch: "get"), or `None` when absent or not text.
fn header_combined(h: &HeaderMap, name: &str) -> Option<String> {
    let values: Vec<&str> = h
        .get_all(name)
        .iter()
        .map(|v| v.to_str().ok())
        .collect::<Option<_>>()?;
    (!values.is_empty()).then(|| values.join(", "))
}

/// Whether the list header `name` (every line, comma-separated) names `needle`
/// (case-insensitively) or holds the `*` wildcard (valid for a request without
/// credentials, which is what the web app sends).
fn header_list_contains(h: &HeaderMap, name: &str, needle: &str) -> bool {
    header_combined(h, name).is_some_and(|v| {
        v.split(',')
            .map(str::trim)
            .any(|item| item == "*" || item.eq_ignore_ascii_case(needle))
    })
}

/// Whether `Access-Control-Allow-Origin` admits the web app (exactly `*` or its origin),
/// and the value. Repeated lines combine (`*, *`), which a browser rejects too.
fn allows_probe_origin(h: &HeaderMap) -> (bool, String) {
    let allow = header_combined(h, "access-control-allow-origin").unwrap_or_default();
    (allow == "*" || allow == PROBE_ORIGIN, allow)
}

/// Probe `url` (an object that exists and is at least 2 bytes long) for browser readability.
pub async fn probe_cors(client: &Client, url: &str) -> CorsReport {
    let mut r = CorsReport::default();

    match client
        .get(url)
        .header("origin", PROBE_ORIGIN)
        .header("range", "bytes=0-1")
        .send()
        .await
    {
        Ok(resp) => {
            r.range_206 = resp.status() == StatusCode::PARTIAL_CONTENT;
            if !r.range_206 {
                r.problems.push(format!(
                    "a ranged GET returned {} instead of 206 Partial Content — partial clone and \
                     browsing need HTTP Range support on the public URL",
                    resp.status()
                ));
            }
            let h = resp.headers();
            let allow;
            (r.get_allows_origin, allow) = allows_probe_origin(h);
            if !r.get_allows_origin {
                r.problems.push(if allow.is_empty() {
                    "GET responses carry no Access-Control-Allow-Origin header — browsers cannot \
                     read the objects (configure CORS on the bucket)"
                        .to_string()
                } else {
                    format!(
                        "Access-Control-Allow-Origin is {allow:?}, which excludes the web app \
                         ({PROBE_ORIGIN}); allow \"*\" (the objects are public anyway)"
                    )
                });
            }
            r.exposes_content_range =
                header_list_contains(h, "access-control-expose-headers", "content-range");
            if r.get_allows_origin && !r.exposes_content_range {
                r.warnings.push(
                    "Content-Range is not in Access-Control-Expose-Headers; browsing works \
                     without it (the web app slices ranged reads itself)"
                        .to_string(),
                );
            }
        }
        Err(e) => r.problems.push(format!("GET {url} failed: {e}")),
    }

    match client
        .request(Method::OPTIONS, url)
        .header("origin", PROBE_ORIGIN)
        .header("access-control-request-method", "GET")
        .header("access-control-request-headers", "range")
        .send()
        .await
    {
        Ok(resp) => {
            let h = resp.headers();
            r.preflight_allows_range = resp.status().is_success()
                && allows_probe_origin(h).0
                && header_list_contains(h, "access-control-allow-headers", "range");
            if !r.preflight_allows_range {
                // QW3-072: "refused (status 200 OK)" read as a contradiction; say what the
                // answer lacked, in the words `dg doctor` uses too.
                let why = preflight_verdict(resp.status(), h)
                    .err()
                    .unwrap_or_default();
                r.problems.push(format!(
                    "{why} — allow the `Range` request header for the web app's origin"
                ));
            }
        }
        Err(e) => r.problems.push(format!("OPTIONS {url} failed: {e}")),
    }
    r
}

/// The CORS preflight alone, for a ranged GET of `url` from the web app's origin: `Ok` when
/// a browser may send it. Read-only and object-agnostic (a preflight does not need the
/// object to exist), so `dg doctor` can run it without uploading a probe; `dg storage test`
/// does the full check.
pub async fn probe_preflight(client: &Client, url: &str) -> Result<(), String> {
    let resp = client
        .request(Method::OPTIONS, url)
        .header("origin", PROBE_ORIGIN)
        .header("access-control-request-method", "GET")
        .header("access-control-request-headers", "range")
        .send()
        .await
        .map_err(|e| format!("OPTIONS {url} failed: {e}"))?;
    preflight_verdict(resp.status(), resp.headers())
}

/// What a preflight's answer lacked, in `dg storage test`'s words (QW3-072 / QW4-056: doctor's
/// row said "was refused (status 200 OK, …)", which reads as a contradiction).
fn preflight_verdict(status: StatusCode, h: &HeaderMap) -> Result<(), String> {
    let (allowed, origin) = allows_probe_origin(h);
    if !status.is_success() {
        return Err(format!(
            "the CORS preflight from {PROBE_ORIGIN} answered {status}"
        ));
    }
    if !allowed {
        return Err(if origin.is_empty() {
            format!(
                "the CORS preflight from {PROBE_ORIGIN} answered {status} with no Access-Control-Allow-Origin"
            )
        } else {
            format!(
                "the CORS preflight from {PROBE_ORIGIN} answered {status} with Access-Control-Allow-Origin {origin:?}, which excludes it"
            )
        });
    }
    if !header_list_contains(h, "access-control-allow-headers", "range") {
        return Err(format!(
            "the CORS preflight from {PROBE_ORIGIN} answered {status} without `Range` in Access-Control-Allow-Headers"
        ));
    }
    Ok(())
}

/// Which provider an S3 endpoint belongs to, for tailored fix instructions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    /// Cloudflare R2.
    R2,
    /// Backblaze B2.
    B2,
    /// AWS S3.
    Aws,
    /// MinIO / anything else S3-compatible.
    Other,
}

/// Classify an S3 endpoint.
pub fn provider_of(endpoint: &str) -> Provider {
    let host = reqwest::Url::parse(endpoint)
        .ok()
        .and_then(|u| {
            u.host_str()
                .map(|h| h.trim_end_matches('.').to_ascii_lowercase())
        })
        .unwrap_or_default();
    if host.ends_with(".r2.cloudflarestorage.com") {
        Provider::R2
    } else if host.ends_with(".backblazeb2.com") {
        Provider::B2
    } else if host.ends_with(".amazonaws.com") {
        Provider::Aws
    } else {
        Provider::Other
    }
}

/// The request headers a signed browser request sends that are not CORS-safelisted (the web
/// app's S3 client, `forge-web/lib/storage/cors.ts` `SIGNED_HEADERS`).
pub const SIGNED_HEADERS: [&str; 6] = [
    "authorization",
    "content-type",
    "range",
    "x-amz-content-sha256",
    "x-amz-date",
    "x-amz-security-token",
];

/// The response headers the rules expose (`Content-Range` is nice to have; see the module
/// docs).
const EXPOSE: [&str; 3] = ["Content-Range", "Content-Length", "ETag"];

/// The two S3 CORS rules (parity with forge-web `lib/storage/cors.ts` `s3Rules`):
/// - **read**, any origin: `GET`/`HEAD` with the `range` request header. The objects are
///   public; every Forge web app, and any mirror of it, reads them.
/// - **write**, the web app's origin only: `PUT`/`GET`/`HEAD`/`DELETE` with the SigV4
///   headers, so pushes, merges and release uploads from the browser can sign requests.
///
/// Header names are lowercase: browsers send `Access-Control-Request-Headers` as sorted,
/// byte-lowercased names (Fetch standard), and some stores match `AllowedHeaders`
/// case-sensitively (Garage refuses a `range` preflight for `["Range"]`). Names are listed
/// rather than `*`, which Cloudflare's R2 documentation does not describe.
pub fn s3_cors_rules(origin: &str) -> serde_json::Value {
    serde_json::json!([
        {
            "AllowedOrigins": ["*"],
            "AllowedMethods": ["GET", "HEAD"],
            "AllowedHeaders": ["range"],
            "ExposeHeaders": EXPOSE,
            "MaxAgeSeconds": 86400
        },
        {
            "AllowedOrigins": [origin],
            "AllowedMethods": ["PUT", "GET", "HEAD", "DELETE"],
            "AllowedHeaders": SIGNED_HEADERS,
            "ExposeHeaders": EXPOSE,
            "MaxAgeSeconds": 86400
        }
    ])
}

/// The same two rules in Backblaze B2's native form (`b2 bucket update --cors-rules`).
fn b2_cors_rules(origin: &str) -> serde_json::Value {
    let expose: Vec<String> = EXPOSE.iter().map(|h| h.to_ascii_lowercase()).collect();
    serde_json::json!([
        {
            "corsRuleName": "dashForgeRead",
            "allowedOrigins": ["*"],
            "allowedOperations": ["s3_get", "s3_head", "b2_download_file_by_name"],
            "allowedHeaders": ["range"],
            "exposeHeaders": expose,
            "maxAgeSeconds": 86400
        },
        {
            "corsRuleName": "dashForgeWrite",
            "allowedOrigins": [origin],
            "allowedOperations": ["s3_put", "s3_get", "s3_head", "s3_delete"],
            "allowedHeaders": SIGNED_HEADERS,
            "exposeHeaders": expose,
            "maxAgeSeconds": 86400
        }
    ])
}

/// A JSON array of rules, one key per line with its value inline (shorter to read and paste
/// than a fully expanded document).
fn rules_json(rules: &serde_json::Value, indent: &str) -> String {
    let rule = |r: &serde_json::Value| {
        let fields: Vec<String> = r
            .as_object()
            .into_iter()
            .flatten()
            .map(|(k, v)| format!("{indent}    {k:?}: {v}"))
            .collect();
        format!("{indent}  {{\n{}\n{indent}  }}", fields.join(",\n"))
    };
    let items: Vec<String> = rules.as_array().into_iter().flatten().map(rule).collect();
    format!("[\n{}\n{indent}]", items.join(",\n"))
}

/// The exact CORS configuration to apply for `provider`, with how to apply it: a read rule
/// for every origin and a write rule for the web app ([`s3_cors_rules`]).
pub fn cors_fix(provider: Provider, bucket: &str) -> String {
    let rules = s3_cors_rules(PROBE_ORIGIN);
    let document = format!("{{\n  \"CORSRules\": {}\n}}", rules_json(&rules, "  "));
    let tail = format!(
        "The first rule lets any browser read the (public) packs; the second lets the web app \
         at {PROBE_ORIGIN} push, merge and upload with your key."
    );
    match provider {
        Provider::R2 => format!(
            "Cloudflare dashboard → R2 → {bucket} → Settings → CORS Policy → Add CORS policy, paste:\n\
             {}\n{tail}\n\
             Also give the bucket a public address: Settings → Custom Domains → connect a domain of yours (the r2.dev subdomain is rate-limited and for development only).",
            rules_json(&rules, "")
        ),
        Provider::B2 => format!(
            "Save as cors.json and run `b2 bucket update --cors-rules \"$(cat cors.json)\" {bucket} allPublic` \
             (with a key that has writeBuckets):\n{}\n{tail}",
            rules_json(&b2_cors_rules(PROBE_ORIGIN), "")
        ),
        Provider::Aws => format!(
            "Save as cors.json and run `aws s3api put-bucket-cors --bucket {bucket} --cors-configuration file://cors.json`:\n\
             {document}\n{tail}\n\
             The objects also need public read: a bucket policy granting s3:GetObject on arn:aws:s3:::{bucket}/*, \
             or a CloudFront distribution as public_url."
        ),
        Provider::Other => format!(
            "Garage, RustFS and most S3-compatible stores take this document through the S3 API: save it as \
             cors.json and run `aws --endpoint-url <your endpoint> s3api put-bucket-cors --bucket {bucket} \
             --cors-configuration file://cors.json`:\n{document}\n{tail}\n\
             Garage applies it to its web endpoint too (the public URL). MinIO community edition (archived) \
             has no per-bucket CORS: it answers every origin unless `mc admin config set <alias> api \
             cors_allow_origin=…` restricted it; for public reads run `mc anonymous set download <alias>/{bucket}`."
        ),
    }
}

/// The CORS fix for a kubo gateway (IPFS public gateway readability).
pub fn kubo_cors_fix() -> &'static str {
    "kubo's gateway sends Access-Control-Allow-Origin: * by default. If it was changed, reset it:\n\
ipfs config --json Gateway.HTTPHeaders.Access-Control-Allow-Origin '[\"*\"]'\n\
then restart the daemon."
}

#[cfg(test)]
mod tests {
    use super::*;

    /// QW4-056: doctor's preflight row says what the answer lacked, as `dg storage test` does,
    /// never "refused (status 200 OK, …)".
    #[test]
    fn a_preflight_verdict_names_what_the_answer_lacked() {
        let mut h = HeaderMap::new();
        let e = preflight_verdict(StatusCode::OK, &h).unwrap_err();
        assert_eq!(
            e,
            format!("the CORS preflight from {PROBE_ORIGIN} answered 200 OK with no Access-Control-Allow-Origin")
        );
        assert!(!e.contains("refused"), "{e}");
        let e = preflight_verdict(StatusCode::FORBIDDEN, &h).unwrap_err();
        assert!(e.ends_with("answered 403 Forbidden"), "{e}");
        h.insert("access-control-allow-origin", "*".parse().unwrap());
        let e = preflight_verdict(StatusCode::OK, &h).unwrap_err();
        assert!(
            e.ends_with("without `Range` in Access-Control-Allow-Headers"),
            "{e}"
        );
        h.insert("access-control-allow-headers", "range".parse().unwrap());
        assert_eq!(preflight_verdict(StatusCode::OK, &h), Ok(()));
    }

    #[test]
    fn classifies_providers() {
        assert_eq!(
            provider_of("https://abc.r2.cloudflarestorage.com"),
            Provider::R2
        );
        assert_eq!(
            provider_of("https://s3.us-west-004.backblazeb2.com"),
            Provider::B2
        );
        assert_eq!(
            provider_of("https://s3.eu-west-1.amazonaws.com"),
            Provider::Aws
        );
        assert_eq!(provider_of("http://127.0.0.1:9000"), Provider::Other);
        // A fully qualified name is the same host.
        assert_eq!(
            provider_of("https://s3.eu-west-1.amazonaws.com."),
            Provider::Aws
        );
    }

    #[test]
    fn fixes_are_valid_json_with_the_read_and_the_write_rule() {
        for p in [Provider::R2, Provider::B2, Provider::Aws, Provider::Other] {
            let fix = cors_fix(p, "my-bucket");
            assert!(fix.contains("my-bucket"));
            let start = fix.find("\n[").or_else(|| fix.find("\n{")).unwrap() + 1;
            let end = fix.rfind([']', '}']).unwrap();
            let json: serde_json::Value = serde_json::from_str(&fix[start..=end])
                .unwrap_or_else(|e| panic!("{p:?} fix is not JSON: {e}\n{fix}"));
            let rules = json.get("CORSRules").unwrap_or(&json).as_array().unwrap();
            assert_eq!(rules.len(), 2, "{p:?}: a read and a write rule");
            let text = json.to_string();
            // Lowercase header names: Garage matches AllowedHeaders case-sensitively and
            // browsers send lowercase names.
            assert!(text.contains(r#"["range"]"#), "{p:?}: {text}");
            assert!(!text.contains(r#""Range""#), "{p:?}: {text}");
            assert!(text.contains(PROBE_ORIGIN), "{p:?}: {text}");
            for h in SIGNED_HEADERS {
                assert!(text.contains(h), "{p:?}: {h}");
            }
            assert!(text.to_ascii_lowercase().contains("put"), "{p:?}");
        }
        let other = cors_fix(Provider::Other, "b");
        assert!(
            other.contains("Garage") && other.contains("RustFS"),
            "{other}"
        );
        assert!(!other.contains("MINIO_API_CORS_ALLOW_ORIGIN"), "{other}");
    }

    #[test]
    fn report_needs_every_piece() {
        let mut r = CorsReport {
            get_allows_origin: true,
            preflight_allows_range: true,
            exposes_content_range: true,
            range_206: true,
            problems: vec![],
            warnings: vec![],
        };
        assert!(r.browser_ok());
        // The reader never reads Content-Range: not exposing it is only a warning.
        r.exposes_content_range = false;
        assert!(r.browser_ok());
        let broken: [fn(&mut CorsReport); 3] = [
            |r| r.get_allows_origin = false,
            |r| r.preflight_allows_range = false,
            |r| r.range_206 = false,
        ];
        for breaks in broken {
            let mut b = r.clone();
            breaks(&mut b);
            assert!(!b.browser_ok());
        }
    }

    #[test]
    fn header_lists_follow_fetch() {
        let mut h = HeaderMap::new();
        h.append(
            "access-control-allow-headers",
            "Content-Type".parse().unwrap(),
        );
        h.append(
            "access-control-allow-headers",
            " RANGE , x-a".parse().unwrap(),
        );
        assert!(header_list_contains(
            &h,
            "access-control-allow-headers",
            "range"
        ));
        assert!(header_list_contains(
            &h,
            "Access-Control-Allow-Headers",
            "x-a"
        ));
        assert!(!header_list_contains(
            &h,
            "access-control-allow-headers",
            "etag"
        ));
        h.append("access-control-expose-headers", "*".parse().unwrap());
        assert!(header_list_contains(
            &h,
            "access-control-expose-headers",
            "content-range"
        ));
        assert!(!header_list_contains(&h, "access-control-max-age", "x"));
        // Access-Control-Allow-Origin: one `*` or the exact origin; two lines combine.
        h.insert("access-control-allow-origin", "*".parse().unwrap());
        assert!(allows_probe_origin(&h).0);
        h.append("access-control-allow-origin", "*".parse().unwrap());
        assert_eq!(allows_probe_origin(&h), (false, "*, *".to_string()));
        h.insert("access-control-allow-origin", PROBE_ORIGIN.parse().unwrap());
        assert!(allows_probe_origin(&h).0);
    }

    /// Storj linksharing: `Access-Control-Allow-Origin: *`, `Allow-Headers: *`, and no
    /// `Access-Control-Expose-Headers` at all. Browsing works, so the test passes with a
    /// warning.
    #[tokio::test]
    async fn no_exposed_content_range_passes_with_a_warning() {
        use crate::test_http::{serve, Reply};
        let (base, _) = serve(|req| {
            let r = if req.method == "OPTIONS" {
                Reply::new(200, "")
            } else {
                Reply::new(206, "ab").header("content-range", "bytes 0-1/10")
            };
            r.header("access-control-allow-origin", "*")
                .header("access-control-allow-headers", "*")
                .header("access-control-allow-methods", "GET, HEAD")
        });
        let r = probe_cors(&reqwest::Client::new(), &format!("{base}/raw/k/b/o")).await;
        assert!(r.browser_ok(), "{r:?}");
        assert!(!r.exposes_content_range);
        assert!(r.problems.is_empty(), "{r:?}");
        assert_eq!(r.warnings.len(), 1, "{r:?}");
    }

    /// kubo (and ipfs.io, 4everland) send `Access-Control-Expose-Headers` and
    /// `Access-Control-Allow-Headers` as several header lines; the first line alone does not
    /// name Content-Range / Range.
    #[tokio::test]
    async fn repeated_cors_header_lines_are_all_read() {
        use crate::test_http::{serve, Reply};
        let (base, _) = serve(|req| {
            let r = if req.method == "OPTIONS" {
                Reply::new(200, "")
            } else {
                Reply::new(206, "ab").header("content-range", "bytes 0-1/10")
            };
            r.header("access-control-allow-origin", "*")
                .header("access-control-allow-headers", "Content-Type")
                .header("access-control-allow-headers", "Range")
                .header(
                    "access-control-allow-headers",
                    "User-Agent, X-Requested-With",
                )
                .header("access-control-expose-headers", "Content-Length")
                .header("access-control-expose-headers", "Content-Range")
                .header("access-control-expose-headers", "X-Ipfs-Path")
        });
        let url = format!("{base}/ipfs/bafkqaaa");
        let client = reqwest::Client::new();
        let r = probe_cors(&client, &url).await;
        assert!(r.exposes_content_range, "{r:?}");
        assert!(r.preflight_allows_range, "{r:?}");
        assert!(r.browser_ok() && r.problems.is_empty(), "{r:?}");
        assert_eq!(probe_preflight(&client, &url).await, Ok(()));
    }
}
