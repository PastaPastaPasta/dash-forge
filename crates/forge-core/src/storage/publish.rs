//! Which storage read URLs may be recorded on chain.
//!
//! A push records every copy's public read URL (an S3 profile's `public_url`, an IPFS
//! profile's `public_gateway`) in a `packManifest`, and manifests are immutable: the URL is
//! read by every clone and every browser **forever**. So it must be a public https URL —
//! never plain http, never this machine or a private network (a copy only its uploader can
//! read, which would also point readers' browsers at their own local services), and not a
//! name that disappears when a process restarts.
//!
//! The private-host rules are a literal port of forge-web `lib/net.ts` (`isPrivateHost`,
//! `isPublicHttpsUrl`), which the web app already enforces; `forge-contracts/fixtures/
//! public-urls.json` is run by both test suites so the two cannot drift. The Rust side adds
//! [`PublishProblem::TemporaryTunnel`] and [`PublishProblem::DevOnly`], which the CLI
//! warns about (tunnels are also refused at push time unless overridden).
//!
//! Only literal addresses and reserved names are recognized: a public name that resolves
//! to a private address (`127.0.0.1.nip.io`) passes, as it does in the web app.

use reqwest::Url;

use crate::user_error::{codes, UserError};

use super::profiles::Profile;

/// The `git push -o <option>` that records a non-public address anyway.
pub const ALLOW_PRIVATE_URI_PUSH_OPTION: &str = "allow-private-uri";

/// The git config key (`dash.allowPrivateUri`) that records a non-public address anyway.
pub const ALLOW_PRIVATE_URI_GIT_KEY: &str = "dash.allowPrivateUri";

/// Why a URL should not be recorded on chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublishProblem {
    /// It does not parse as a URL.
    NotAUrl,
    /// It carries a user name or password.
    Credentials,
    /// It is not https (plain http, or another scheme).
    NotHttps,
    /// Loopback, a private / link-local / CGNAT / ULA address, or a `.local`,
    /// `.localhost` or `.internal` name.
    PrivateHost,
    /// A name that stops working when a process restarts or a machine is renamed:
    /// Cloudflare quick tunnels (`*.trycloudflare.com`), Tailscale Funnel (`*.ts.net`).
    TemporaryTunnel,
    /// Public, but documented by its provider as rate-limited and for development only
    /// (`*.r2.dev`). A warning, never a refusal.
    DevOnly,
}

impl PublishProblem {
    /// The stable label (the `problem` field of the shared vectors).
    pub fn label(self) -> &'static str {
        match self {
            Self::NotAUrl => "not-a-url",
            Self::Credentials => "credentials",
            Self::NotHttps => "not-https",
            Self::PrivateHost => "private-host",
            Self::TemporaryTunnel => "temporary-tunnel",
            Self::DevOnly => "dev-only",
        }
    }

    /// Whether a push refuses to record the URL (unless overridden). [`Self::DevOnly`] is
    /// only a warning: the URL is public, merely rate-limited.
    pub fn refused(self) -> bool {
        self != Self::DevOnly
    }
}

/// Whether `hostname` names this machine or a private / link-local network (forge-web
/// `isPrivateHost`, ported literally). Brackets around an IPv6 literal are ignored.
// Host-name suffixes on a lowercased name, not file extensions.
#[allow(clippy::case_sensitive_file_extension_comparisons)]
pub fn is_private_host(hostname: &str) -> bool {
    let lower = hostname.to_ascii_lowercase();
    let h = dns_name(lower.trim_start_matches('[').trim_end_matches(']'));
    if h == "localhost"
        || h.ends_with(".localhost")
        || h.ends_with(".local")
        || h.ends_with(".internal")
    {
        return true;
    }
    if let Some([a, b]) = dotted_quad_head(h) {
        return a == 0
            || a == 10
            || a == 127
            || (a == 100 && (64..=127).contains(&b))
            || (a == 169 && b == 254)
            || (a == 172 && (16..=31).contains(&b))
            || (a == 192 && b == 168);
    }
    if h.contains(':') {
        // IPv6: loopback, unspecified, unique-local fc00::/7, link-local fe80::/10,
        // IPv4-mapped.
        return h == "::1"
            || h == "::"
            || h.starts_with("fc")
            || h.starts_with("fd")
            || ["fe8", "fe9", "fea", "feb"]
                .iter()
                .any(|p| h.starts_with(p))
            || h.starts_with("::ffff:");
    }
    false
}

/// `host` without trailing root dots: `localhost.` and `nas.local.` are the same names
/// as `localhost` and `nas.local`, and URL parsers keep the dot.
fn dns_name(host: &str) -> &str {
    host.trim_end_matches('.')
}

/// The first two octets of a `d.d.d.d` literal (each 1-3 digits, as `lib/net.ts` matches).
fn dotted_quad_head(h: &str) -> Option<[u32; 2]> {
    let parts: Vec<&str> = h.split('.').collect();
    let ok = parts.len() == 4
        && parts
            .iter()
            .all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()));
    ok.then(|| [parts[0].parse().unwrap_or(0), parts[1].parse().unwrap_or(0)])
}

/// Whether `url` is a public https URL (forge-web `isPublicHttpsUrl`): what readers may
/// fetch and a manifest may record.
pub fn is_public_https_url(url: &str) -> bool {
    Url::parse(url).is_ok_and(|u| {
        u.scheme() == "https"
            && !u.host_str().is_some_and(is_private_host)
            && u.username().is_empty()
            && u.password().is_none()
    })
}

/// Why `url` should not be recorded on chain, or `None` when it is fine.
pub fn publish_problem(url: &str) -> Option<PublishProblem> {
    let Ok(u) = Url::parse(url) else {
        return Some(PublishProblem::NotAUrl);
    };
    if !u.username().is_empty() || u.password().is_some() {
        return Some(PublishProblem::Credentials);
    }
    let lower = u.host_str().unwrap_or_default().to_ascii_lowercase();
    let host = dns_name(&lower);
    if !matches!(u.scheme(), "http" | "https") {
        return Some(PublishProblem::NotHttps);
    }
    if is_private_host(host) {
        return Some(PublishProblem::PrivateHost);
    }
    if u.scheme() != "https" {
        return Some(PublishProblem::NotHttps);
    }
    if host.ends_with(".trycloudflare.com") || host.ends_with(".ts.net") {
        return Some(PublishProblem::TemporaryTunnel);
    }
    if host.ends_with(".r2.dev") {
        return Some(PublishProblem::DevOnly);
    }
    None
}

/// The host (with port) of `url`, for messages; the raw value when it does not parse. Never
/// echoes a user name or password.
fn host_of(url: &str) -> String {
    Url::parse(url).map_or_else(
        |_| "the URL".to_string(),
        |u| {
            let host = u.host_str().unwrap_or_default();
            match u.port() {
                Some(p) => format!("{host}:{p}"),
                None => host.to_string(),
            }
        },
    )
}

/// What is wrong with `url` and what to use instead, in user terms (one line).
pub fn describe(url: &str, problem: PublishProblem) -> String {
    let host = host_of(url);
    let why = match problem {
        PublishProblem::NotAUrl => "is not a URL".to_string(),
        PublishProblem::Credentials => {
            format!("{host} carries a user name or password, which would be published")
        }
        PublishProblem::NotHttps => {
            format!("{host} is not https: the web app refuses to read it")
        }
        PublishProblem::PrivateHost => format!(
            "{host} is only reachable from this machine or its network, so nobody else can \
             read what is stored there"
        ),
        PublishProblem::TemporaryTunnel if host.ends_with(".ts.net") => format!(
            "{host} is a Tailscale Funnel name, which stops working when the machine or \
             tailnet is renamed or Funnel is switched off"
        ),
        PublishProblem::TemporaryTunnel => format!(
            "{host} is a Cloudflare quick tunnel, whose random name changes every time the \
             tunnel restarts"
        ),
        PublishProblem::DevOnly => format!(
            "{host} is an r2.dev development URL, which Cloudflare rate-limits and does not \
             recommend for production"
        ),
    };
    let instead = match problem {
        PublishProblem::DevOnly => "connect a custom domain to the bucket for real repositories",
        _ => {
            "use a stable public https URL: the bucket's public domain, a CDN, a named \
             Cloudflare Tunnel or a reverse proxy with TLS on your own domain"
        }
    };
    format!("{why}. The public URL is recorded on chain forever with every pack; {instead}")
}

/// Every URL `profile` would record on chain for readers (the S3 public URL, the IPFS
/// public gateway), with its field name.
pub fn published_urls(profile: &Profile) -> Vec<(&'static str, &str)> {
    match profile {
        Profile::S3(p) => p
            .public_url
            .as_deref()
            .map(|u| vec![("public_url", u)])
            .unwrap_or_default(),
        other => other
            .public_gateway()
            .map(|g| vec![("public_gateway", g)])
            .unwrap_or_default(),
    }
}

/// One published URL of a profile with a problem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileUrlProblem {
    /// `public_url` or `public_gateway`.
    pub field: &'static str,
    /// The URL.
    pub url: String,
    /// What is wrong with it.
    pub problem: PublishProblem,
}

impl ProfileUrlProblem {
    /// [`describe`] for this URL.
    pub fn describe(&self) -> String {
        describe(&self.url, self.problem)
    }
}

/// Every problem (warnings included) with the URLs `profile` would publish.
pub fn profile_problems(profile: &Profile) -> Vec<ProfileUrlProblem> {
    published_urls(profile)
        .into_iter()
        .filter_map(|(field, url)| {
            publish_problem(url).map(|problem| ProfileUrlProblem {
                field,
                url: url.to_string(),
                problem,
            })
        })
        .collect()
}

/// The overrides that let a command record a non-public address, for the refusal's fix
/// line: the command's own (`git push -o allow-private-uri`, `dg init --allow-private-uri`),
/// then the ones every command honours (git config, the profile flag).
pub fn overrides(own: Option<&str>, profile: &str) -> Vec<String> {
    own.map(|o| format!("`{o}`"))
        .into_iter()
        .chain([
            format!("`git config {ALLOW_PRIVATE_URI_GIT_KEY} true`"),
            format!("`dg storage add {profile} … --allow-private-uri`"),
        ])
        .collect()
}

/// Refuse to record a non-public URL: the first refused problem among `profiles`, as the
/// E501 a push (or `dg init`, `dg repack`, …) stops with **before** building, uploading or
/// paying for anything. A profile with `allow_private_uri = true` is exempt, and
/// `allowed` (the push option / git config override) exempts every profile. `lead` is the
/// headline's goal ("push not started"); `own` is the command's own override, if it has one
/// (see [`overrides`]).
// A refusal happens at most once per command; boxing it buys nothing.
#[allow(clippy::result_large_err)]
pub fn refuse_unpublishable<'a>(
    profiles: impl IntoIterator<Item = (&'a str, &'a Profile)>,
    allowed: bool,
    lead: &str,
    own: Option<&str>,
) -> std::result::Result<(), UserError> {
    if allowed {
        return Ok(());
    }
    for (name, profile) in profiles {
        if profile.allow_private_uri() {
            continue;
        }
        if let Some(p) = profile_problems(profile)
            .into_iter()
            .find(|p| p.problem.refused())
        {
            return Err(UserError::new(
                codes::STORAGE_CONFIG,
                format!("{lead}: storage profile {name:?} would record a non-public {} on chain", p.field),
            )
            .cause(p.describe())
            .fix(format!(
                "give the profile a public https address: `dg storage add {name} …` with the same flags and a new --{}",
                p.field.replace('_', "-")
            ))
            .fix(format!(
                "to record it anyway (a test, a LAN-only mirror): {}",
                overrides(own, name).join(", or ")
            ))
            .note("nothing was built, uploaded or paid for"));
        }
    }
    Ok(())
}

/// [`refuse_unpublishable`] for a bare read base with no profile (the legacy
/// `FORGE_S3_ENDPOINT` targets of `dg repack --backend s3` / `dg reseed --to s3`).
#[allow(clippy::result_large_err)]
pub fn refuse_unpublishable_url(
    source: &str,
    url: &str,
    allowed: bool,
    lead: &str,
) -> std::result::Result<(), UserError> {
    match publish_problem(url).filter(|p| p.refused() && !allowed) {
        None => Ok(()),
        Some(problem) => Err(UserError::new(
            codes::STORAGE_CONFIG,
            format!("{lead}: {source} would record a non-public address on chain"),
        )
        .cause(describe(url, problem))
        .fix("use a storage profile with a public https address: `dg storage add …`, then --profile <name>")
        .fix(format!(
            "to record it anyway (a test, a LAN-only mirror): `git config {ALLOW_PRIVATE_URI_GIT_KEY} true`"
        ))
        .note("nothing was built, uploaded or paid for")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::StorageProfiles;

    /// `forge-contracts/fixtures/public-urls.json`, which forge-web's `lib/net.test.ts`
    /// also runs.
    #[test]
    fn shared_public_url_vectors() {
        let raw = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../forge-contracts/fixtures/public-urls.json"
        ));
        let v: serde_json::Value = serde_json::from_str(raw).unwrap();
        let cases = v["urls"].as_array().unwrap();
        assert!(cases.len() >= 40, "{} cases", cases.len());
        for c in cases {
            let url = c["url"].as_str().unwrap();
            assert_eq!(
                is_public_https_url(url),
                c["public"].as_bool().unwrap(),
                "public: {url}"
            );
            assert_eq!(
                publish_problem(url).map(PublishProblem::label),
                c["problem"].as_str(),
                "problem: {url}"
            );
            if let Some(private) = c["private"].as_bool() {
                let host = Url::parse(url).unwrap();
                assert_eq!(
                    is_private_host(host.host_str().unwrap()),
                    private,
                    "private: {url}"
                );
            }
        }
    }

    #[test]
    fn descriptions_say_on_chain_forever_and_never_echo_credentials() {
        let d = describe(
            "https://user:hunter2@files.example.org",
            PublishProblem::Credentials,
        );
        assert!(!d.contains("hunter2"), "{d}");
        let d = describe("http://127.0.0.1:9100/forge", PublishProblem::PrivateHost);
        assert!(
            d.contains("127.0.0.1:9100") && d.contains("on chain forever"),
            "{d}"
        );
        assert!(describe(
            "https://x.trycloudflare.com",
            PublishProblem::TemporaryTunnel
        )
        .contains("quick tunnel"));
        assert!(
            describe("https://nas.tail1.ts.net", PublishProblem::TemporaryTunnel)
                .contains("Tailscale Funnel")
        );
    }

    fn profiles(extra: &str) -> StorageProfiles {
        StorageProfiles::parse(&format!(
            "[profiles.loop]\nkind = \"s3\"\nendpoint = \"http://127.0.0.1:9000\"\nbucket = \"b\"\n\
             public_url = \"http://127.0.0.1:9000/b\"\n{extra}\n\
             [profiles.r2]\nkind = \"s3\"\nendpoint = \"https://a.r2.cloudflarestorage.com\"\n\
             bucket = \"b\"\npublic_url = \"https://pub-1.r2.dev\"\n\
             [profiles.kubo]\nkind = \"ipfs-kubo\"\napi = \"http://127.0.0.1:5001\"\n\
             public_gateway = \"https://abc.trycloudflare.com\"\n\
             [profiles.private]\nkind = \"s3\"\nendpoint = \"http://127.0.0.1:9000\"\nbucket = \"b\"\n"
        ))
        .unwrap()
    }

    #[test]
    fn refusal_names_the_profile_and_every_override() {
        let p = profiles("");
        let loopback = [("loop", &p.profiles["loop"])];
        let push = format!("git push -o {ALLOW_PRIVATE_URI_PUSH_OPTION} …");
        let err =
            refuse_unpublishable(loopback, false, "push not started", Some(&push)).unwrap_err();
        assert_eq!((err.code, err.exit_code()), ("E501", 5));
        let text = err.render("", false);
        for want in [
            "\"loop\"",
            "public_url",
            "127.0.0.1:9000",
            "on chain forever",
            "git push -o allow-private-uri",
            "dash.allowPrivateUri",
            "--allow-private-uri",
            "nothing was built, uploaded or paid for",
        ] {
            assert!(text.contains(want), "{want}\n{text}");
        }
        // A command without a flag of its own offers only the overrides it honours.
        let text = refuse_unpublishable(loopback, false, "x", None)
            .unwrap_err()
            .render("", false);
        assert!(!text.contains("git push -o"), "{text}");
        assert!(text.contains("dash.allowPrivateUri"), "{text}");
        // The override exempts everything.
        assert!(refuse_unpublishable(loopback, true, "x", None).is_ok());
        // A bare legacy read base is judged the same way.
        let err =
            refuse_unpublishable_url("FORGE_S3_ENDPOINT", "http://127.0.0.1:9000/b", false, "x")
                .unwrap_err();
        assert_eq!(err.code, "E501");
        assert!(refuse_unpublishable_url("s", "http://127.0.0.1:9000/b", true, "x").is_ok());
        assert!(refuse_unpublishable_url("s", "https://files.example.org/b", false, "x").is_ok());
        // A tunnel gateway is refused; r2.dev is only a warning; no public URL is fine.
        let err =
            refuse_unpublishable([("kubo", &p.profiles["kubo"])], false, "x", None).unwrap_err();
        assert!(err.render("", false).contains("public_gateway"));
        assert!(refuse_unpublishable([("r2", &p.profiles["r2"])], false, "x", None).is_ok());
        assert_eq!(
            profile_problems(&p.profiles["r2"])[0].problem,
            PublishProblem::DevOnly
        );
        assert!(
            refuse_unpublishable([("private", &p.profiles["private"])], false, "x", None).is_ok()
        );
    }

    #[test]
    fn the_profile_flag_exempts_that_profile_and_round_trips() {
        let p = profiles("allow_private_uri = true");
        assert!(p.profiles["loop"].allow_private_uri());
        assert!(refuse_unpublishable([("loop", &p.profiles["loop"])], false, "x", None).is_ok());
        let again = StorageProfiles::parse(&p.to_toml().unwrap()).unwrap();
        assert!(again.profiles["loop"].allow_private_uri());
        // Unset is not written out.
        assert!(!profiles("")
            .to_toml()
            .unwrap()
            .contains("allow_private_uri"));
    }
}
