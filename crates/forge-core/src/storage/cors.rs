//! Browser-readability checks for a storage profile's public URL, and the exact CORS
//! configuration to paste for each provider.
//!
//! The web app reads packs with `fetch(url, { headers: { Range } })` from its own origin.
//! That needs, on the PUBLIC read URL:
//! - `Access-Control-Allow-Origin` (`*` or the app origin) on GET responses,
//! - a successful preflight for the `Range` request header,
//! - `Access-Control-Expose-Headers` including `Content-Range`, `Content-Length` and
//!   `ETag`, so the app can see partial-content framing.

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
    /// `Content-Range` is exposed to scripts.
    pub exposes_content_range: bool,
    /// A ranged GET came back `206`.
    pub range_206: bool,
    /// Problems, one line each, in user terms.
    pub problems: Vec<String>,
}

impl CorsReport {
    /// Whether a browser can read packs from the URL.
    pub fn browser_ok(&self) -> bool {
        self.get_allows_origin
            && self.preflight_allows_range
            && self.exposes_content_range
            && self.range_206
    }
}

fn header_list_contains(value: Option<&reqwest::header::HeaderValue>, needle: &str) -> bool {
    value.and_then(|v| v.to_str().ok()).is_some_and(|v| {
        v.split(',')
            .map(str::trim)
            .any(|h| h == "*" || h.eq_ignore_ascii_case(needle))
    })
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
            let allow = h
                .get("access-control-allow-origin")
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default();
            r.get_allows_origin = allow == "*" || allow == PROBE_ORIGIN;
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
                header_list_contains(h.get("access-control-expose-headers"), "content-range");
            if r.get_allows_origin && !r.exposes_content_range {
                r.problems.push(
                    "Content-Range is not in Access-Control-Expose-Headers — the web app cannot \
                     frame ranged reads"
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
                && h.contains_key("access-control-allow-origin")
                && header_list_contains(h.get("access-control-allow-headers"), "range");
            if !r.preflight_allows_range {
                r.problems.push(format!(
                    "the CORS preflight for a Range request was refused (status {}) — allow the \
                     `Range` request header",
                    resp.status()
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
    let h = resp.headers();
    let origin = h
        .get("access-control-allow-origin")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    if !resp.status().is_success() || !(origin == "*" || origin == PROBE_ORIGIN) {
        return Err(format!(
            "the CORS preflight from {PROBE_ORIGIN} was refused (status {}{})",
            resp.status(),
            if origin.is_empty() {
                ", no Access-Control-Allow-Origin".to_string()
            } else {
                format!(", Access-Control-Allow-Origin {origin:?}")
            }
        ));
    }
    if !header_list_contains(h.get("access-control-allow-headers"), "range") {
        return Err("the CORS preflight does not allow the `Range` request header".into());
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
        .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
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

/// The exact CORS configuration to apply for `provider`, with how to apply it.
pub fn cors_fix(provider: Provider, bucket: &str) -> String {
    match provider {
        Provider::R2 => format!(
            "Cloudflare dashboard → R2 → {bucket} → Settings → CORS Policy → Add CORS policy, paste:\n\
[\n  {{\n    \"AllowedOrigins\": [\"*\"],\n    \"AllowedMethods\": [\"GET\", \"HEAD\"],\n    \"AllowedHeaders\": [\"Range\"],\n    \"ExposeHeaders\": [\"Content-Range\", \"Content-Length\", \"ETag\"],\n    \"MaxAgeSeconds\": 86400\n  }}\n]\n\
Also enable public access: Settings → Public access → R2.dev subdomain (or connect a custom domain)."
        ),
        Provider::B2 => format!(
            "Save as cors.json and run `b2 bucket update --cors-rules \"$(cat cors.json)\" {bucket} allPublic`:\n\
[\n  {{\n    \"corsRuleName\": \"dashForgeRead\",\n    \"allowedOrigins\": [\"*\"],\n    \"allowedOperations\": [\"s3_get\", \"s3_head\", \"b2_download_file_by_name\"],\n    \"allowedHeaders\": [\"range\"],\n    \"exposeHeaders\": [\"content-range\", \"content-length\", \"etag\"],\n    \"maxAgeSeconds\": 86400\n  }}\n]"
        ),
        Provider::Aws => format!(
            "Save as cors.json and run `aws s3api put-bucket-cors --bucket {bucket} --cors-configuration file://cors.json`:\n\
{{\n  \"CORSRules\": [\n    {{\n      \"AllowedOrigins\": [\"*\"],\n      \"AllowedMethods\": [\"GET\", \"HEAD\"],\n      \"AllowedHeaders\": [\"Range\"],\n      \"ExposeHeaders\": [\"Content-Range\", \"Content-Length\", \"ETag\"],\n      \"MaxAgeSeconds\": 86400\n    }}\n  ]\n}}\n\
The objects also need public read: a bucket policy granting s3:GetObject on arn:aws:s3:::{bucket}/*, \
or a CloudFront distribution as public_url."
        ),
        Provider::Other => format!(
            "MinIO answers CORS for every origin by default (`MINIO_API_CORS_ALLOW_ORIGIN`, default \"*\"). \
If it is restricted, set MINIO_API_CORS_ALLOW_ORIGIN=\"*\" on the server. For public reads run \
`mc anonymous set download <alias>/{bucket}`. Other S3-compatible stores: apply this S3 CORS document \
with their put-bucket-cors equivalent:\n\
{{\"CORSRules\":[{{\"AllowedOrigins\":[\"*\"],\"AllowedMethods\":[\"GET\",\"HEAD\"],\"AllowedHeaders\":[\"Range\"],\"ExposeHeaders\":[\"Content-Range\",\"Content-Length\",\"ETag\"],\"MaxAgeSeconds\":86400}}]}}"
        ),
    }
}

/// The CORS fix for a kubo gateway (IPFS public gateway readability).
pub fn kubo_cors_fix() -> &'static str {
    "kubo's gateway sends Access-Control-Allow-Origin: * by default. If it was changed, reset it:\n\
ipfs config --json Gateway.HTTPHeaders.Access-Control-Allow-Origin '[\"*\"]'\n\
ipfs config --json Gateway.HTTPHeaders.Access-Control-Expose-Headers '[\"Content-Range\", \"Content-Length\", \"ETag\"]'\n\
then restart the daemon."
}

#[cfg(test)]
mod tests {
    use super::*;

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
    }

    #[test]
    fn fixes_are_valid_json_and_name_the_bucket() {
        for p in [Provider::R2, Provider::B2, Provider::Aws] {
            let fix = cors_fix(p, "my-bucket");
            assert!(fix.contains("my-bucket"));
            let start = fix.find(['[', '{']).unwrap();
            let end = fix.rfind([']', '}']).unwrap();
            let json: serde_json::Value = serde_json::from_str(&fix[start..=end])
                .unwrap_or_else(|e| panic!("{p:?} fix is not JSON: {e}\n{fix}"));
            assert!(json.to_string().to_ascii_lowercase().contains("range"));
        }
    }

    #[test]
    fn report_needs_every_piece() {
        let mut r = CorsReport {
            get_allows_origin: true,
            preflight_allows_range: true,
            exposes_content_range: true,
            range_206: true,
            problems: vec![],
        };
        assert!(r.browser_ok());
        r.exposes_content_range = false;
        assert!(!r.browser_ok());
    }
}
