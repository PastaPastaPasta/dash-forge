//! `dg verify-app <url>`: check a deployed copy of the web app, file by file, against a
//! published build manifest (docs/guides/verify-the-app.md).
//!
//! Every web build carries `forge-manifest.json` at its root: the SHA-256 of each file it made
//! (`forge-web/scripts/build-manifest.mjs`). Whoever serves the site could rewrite that file, so
//! it is trusted only when it is published elsewhere:
//!
//! - `--manifest <file or https URL>`: a manifest you got yourself, for example a release's
//!   `forge-web-<version>.manifest.json` from `dg release download` (proof-checked on Platform);
//! - otherwise a GitHub build-provenance attestation of the served manifest's SHA-256 by this
//!   repository's CI (the Pages deploy, or a release). It is looked up through GitHub's API;
//!   `gh attestation verify` checks the Sigstore signature too, and the output names that command.
//!
//! Then every file the trusted manifest lists is fetched from the site and hashed. Any file that
//! is missing or differs fails the check. It proves what this run was served, not what another
//! visitor gets.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use anyhow::{Context, Result};
use futures::stream::{self, StreamExt};
use serde::Deserialize;
use serde_json::json;

use forge_core::backends::sigv4::sha256_hex;
use forge_core::user_error::{codes, UserError};

use crate::context::Ctx;

/// Where the site serves its manifest (`MANIFEST_NAME` in build-manifest.mjs).
pub const MANIFEST_NAME: &str = "forge-manifest.json";

/// The repository whose CI attests the published builds.
const REPO: &str = "PastaPastaPasta/dash-forge";

/// Files fetched at once.
const CONCURRENCY: usize = 12;

/// A build manifest (`forge-web/scripts/build-manifest.mjs`, format 1).
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Manifest {
    pub format: u32,
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub network: Option<String>,
    #[serde(default)]
    pub variant: Option<String>,
    /// Path (relative to the site root, `/`-separated) → SHA-256, lowercase hex.
    pub files: BTreeMap<String, String>,
}

impl Manifest {
    /// Parse a manifest, refusing a format this dg does not know.
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let m: Self =
            serde_json::from_slice(bytes).context("the build manifest is not valid JSON")?;
        if m.format != 1 {
            anyhow::bail!(
                "the build manifest has format {}; this dg reads format 1 (update dg)",
                m.format
            );
        }
        Ok(m)
    }
}

/// `dg verify-app` arguments.
#[derive(Debug, clap::Args)]
pub struct VerifyAppArgs {
    /// The site to check, e.g. https://forge.dashhq.org or an IPFS gateway URL of a release.
    pub url: String,
    /// Check against this manifest (a file, or an https URL) instead of looking up the served
    /// one's GitHub attestation: for example a release's forge-web-<version>.manifest.json from
    /// `dg release download`.
    #[arg(long, value_name = "FILE|URL")]
    pub manifest: Option<String>,
    /// Also require the build to be this commit (7 characters or more): otherwise any build
    /// this repository ever published passes, an older one included.
    #[arg(long, value_name = "SHA")]
    pub commit: Option<String>,
}

/// The site's root URL with a trailing slash, so file paths join under it.
fn site_root(url: &str) -> Result<reqwest::Url> {
    let with_slash = if url.ends_with('/') {
        url.to_string()
    } else {
        format!("{url}/")
    };
    let root = reqwest::Url::parse(&with_slash)
        .map_err(|e| crate::errors::usage(format!("{url} is not a URL: {e}")))?;
    if !matches!(root.scheme(), "https" | "http") {
        return Err(crate::errors::usage(format!("{url} is not an http(s) URL")));
    }
    Ok(root)
}

/// `path` (a manifest key) as a URL under `root`: each character a server could read as
/// something else (`%`, `?`, `#`, brackets, spaces) is percent-encoded.
pub fn file_url(root: &reqwest::Url, path: &str) -> Result<reqwest::Url> {
    let mut encoded = String::with_capacity(path.len());
    for c in path.chars() {
        match c {
            'A'..='Z'
            | 'a'..='z'
            | '0'..='9'
            | '-'
            | '.'
            | '_'
            | '~'
            | '/'
            | '@'
            | '+'
            | '='
            | ',' => {
                encoded.push(c);
            }
            _ => {
                let mut buf = [0u8; 4];
                for b in c.encode_utf8(&mut buf).bytes() {
                    let _ = write!(encoded, "%{b:02X}");
                }
            }
        }
    }
    root.join(&encoded)
        .with_context(|| format!("joining {path} to {root}"))
}

async fn get(client: &reqwest::Client, url: reqwest::Url) -> Result<Option<Vec<u8>>> {
    // Asked as a browser asks: a host or CDN that rewrites pages only for browsers (an injected
    // script) must not serve this check something else.
    let resp = client
        .get(url.clone())
        .header("Accept", "text/html,application/xhtml+xml,*/*;q=0.8")
        .send()
        .await
        .with_context(|| format!("fetching {url}"))?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let resp = resp
        .error_for_status()
        .with_context(|| format!("fetching {url}"))?;
    Ok(Some(
        resp.bytes()
            .await
            .with_context(|| format!("reading {url}"))?
            .to_vec(),
    ))
}

/// How many attestations GitHub holds for `digest` (hex SHA-256) from [`REPO`]'s workflows.
async fn attestations(client: &reqwest::Client, digest: &str) -> Result<usize> {
    #[derive(Deserialize)]
    struct Listing {
        attestations: Vec<serde_json::Value>,
    }
    let url = format!("https://api.github.com/repos/{REPO}/attestations/sha256:{digest}");
    let mut req = client
        .get(&url)
        .header("Accept", "application/vnd.github+json");
    // A token lifts the anonymous rate limit (60 an hour per address, shared on CI runners).
    if let Some(token) = ["GITHUB_TOKEN", "GH_TOKEN"]
        .into_iter()
        .find_map(|k| std::env::var(k).ok().filter(|t| !t.is_empty()))
    {
        req = req.bearer_auth(token);
    }
    let resp = req
        .send()
        .await
        .context("asking GitHub for the manifest's attestation")?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(0);
    }
    let listing: Listing = resp
        .error_for_status()
        .context("asking GitHub for the manifest's attestation")?
        .json()
        .await
        .context("reading GitHub's attestation list")?;
    Ok(listing.attestations.len())
}

/// The outcome of comparing what a site served with a trusted manifest.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Comparison {
    pub matched: usize,
    /// Served, with other bytes.
    pub differ: Vec<String>,
    /// Not served (404).
    pub missing: Vec<String>,
}

impl Comparison {
    pub fn ok(&self) -> bool {
        self.differ.is_empty() && self.missing.is_empty()
    }

    /// "2 files differ, 1 is missing", leaving out a zero count.
    pub fn summary(&self) -> String {
        let count =
            |n: usize, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
        [
            (
                self.differ.len(),
                count(self.differ.len(), "file differs", "files differ"),
            ),
            (
                self.missing.len(),
                count(self.missing.len(), "is missing", "are missing"),
            ),
        ]
        .into_iter()
        .filter(|(n, _)| *n > 0)
        .map(|(_, s)| s)
        .collect::<Vec<_>>()
        .join(", ")
    }
}

/// Compare each file of `trusted` with what `served` says came back for it (`None`: not found).
pub fn compare(
    trusted: &Manifest,
    served: impl IntoIterator<Item = (String, Option<String>)>,
) -> Comparison {
    let served: BTreeMap<String, Option<String>> = served.into_iter().collect();
    let mut out = Comparison::default();
    for (path, want) in &trusted.files {
        match served.get(path) {
            Some(Some(got)) if got.eq_ignore_ascii_case(want) => out.matched += 1,
            Some(Some(_)) => out.differ.push(path.clone()),
            _ => out.missing.push(path.clone()),
        }
    }
    out
}

/// The manifest to trust and where it came from: `--manifest`, else the served one (`served`,
/// fetched from `manifest_url`) when GitHub holds an attestation of it from [`REPO`]'s CI.
async fn trusted_manifest(
    client: &reqwest::Client,
    args: &VerifyAppArgs,
    served: Option<&[u8]>,
    manifest_url: &reqwest::Url,
) -> Result<(Manifest, String)> {
    if let Some(m) = &args.manifest {
        let bytes = if m.starts_with("https://") || m.starts_with("http://") {
            let url = reqwest::Url::parse(m)
                .map_err(|e| crate::errors::usage(format!("--manifest {m}: {e}")))?;
            get(client, url).await?.ok_or_else(|| {
                crate::errors::not_found(format!("{m} was not found"), "check the URL")
            })?
        } else {
            std::fs::read(m).with_context(|| format!("reading {m}"))?
        };
        return Ok((Manifest::parse(&bytes)?, format!("the manifest in {m}")));
    }
    let Some(bytes) = served else {
        return Err(UserError::new(codes::INTEGRITY, "the site has no build manifest")
            .cause(format!("{manifest_url} was not found: the site is not a Forge web build, or one older than the manifest"))
            .fix("pass the manifest of the build it should be with --manifest <file>")
            .into());
    };
    if attestations(client, &sha256_hex(bytes)).await? == 0 {
        let commit = Manifest::parse(bytes).ok().and_then(|m| m.commit);
        return Err(
            UserError::new(codes::INTEGRITY, "the site's build is not a published one")
                .cause(format!(
                    "GitHub has no attestation from {REPO} for the site's build manifest{}",
                    commit
                        .map(|c| format!(" (it says it is commit {c})"))
                        .unwrap_or_default()
                ))
                .fix(UNPUBLISHED_FIX)
                .into(),
        );
    }
    Ok((
        Manifest::parse(bytes)?,
        format!("attested by {REPO}'s CI (`gh attestation verify --repo {REPO}` on the manifest checks the signature)"),
    ))
}

const UNPUBLISHED_FIX: &str = "do not unlock a private repository there; use a release's IPFS build (docs/guides/verify-the-app.md)";

/// Fetch every file `trusted` lists from `root` and hash it (`None`: not found). Any other
/// failure fails the whole check: nothing is compared on a partial read.
async fn fetch_all(
    client: &reqwest::Client,
    root: &reqwest::Url,
    trusted: &Manifest,
) -> Result<Vec<(String, Option<String>)>> {
    let jobs = trusted.files.keys().cloned().map(|path| async move {
        let got = match file_url(root, &path) {
            Ok(url) => get(client, url).await.map(|b| b.map(|b| sha256_hex(&b))),
            Err(e) => Err(e),
        };
        (path, got)
    });
    let mut served = Vec::with_capacity(trusted.files.len());
    let mut failures = Vec::new();
    let mut results = stream::iter(jobs).buffer_unordered(CONCURRENCY);
    while let Some((path, got)) = results.next().await {
        match got {
            Ok(h) => served.push((path, h)),
            Err(e) => failures.push(format!("{path}: {e:#}")),
        }
    }
    if let Some(first) = failures.first() {
        return Err(
            UserError::new(codes::INTEGRITY, "could not fetch the site's files")
                .cause(format!(
                    "{} of {} failed; first: {first}",
                    failures.len(),
                    trusted.files.len()
                ))
                .fix("run it again; nothing was compared")
                .into(),
        );
    }
    Ok(served)
}

/// `dg verify-app`.
pub async fn run(ctx: &Ctx, args: &VerifyAppArgs) -> Result<()> {
    let root = site_root(&args.url)?;
    let client = reqwest::Client::builder()
        .user_agent(concat!(
            "Mozilla/5.0 (compatible; dg-verify-app/",
            env!("CARGO_PKG_VERSION"),
            ")"
        ))
        .timeout(std::time::Duration::from_secs(60))
        .build()?;
    let manifest_url = file_url(&root, MANIFEST_NAME)?;
    let served_bytes = get(&client, manifest_url.clone()).await?;
    let (trusted, source) =
        trusted_manifest(&client, args, served_bytes.as_deref(), &manifest_url).await?;
    if let Some(want) = args.commit.as_deref() {
        let got = trusted.commit.as_deref().unwrap_or("");
        if want.len() < 7 || !got.starts_with(&want.to_ascii_lowercase()) {
            return Err(UserError::new(codes::INTEGRITY, "the site serves another build")
                .cause(format!("it is commit {}, not {want}", if got.is_empty() { "unknown" } else { got }))
                .fix("an older published build can still have bugs fixed since; pass at least 7 characters of the commit you expect")
                .into());
        }
    }
    let result = compare(&trusted, fetch_all(&client, &root, &trusted).await?);
    // With --manifest, the site's own manifest should agree with it too.
    let manifest_agrees = served_bytes
        .as_deref()
        .and_then(|b| Manifest::parse(b).ok())
        .map(|m| m.files == trusted.files);

    let body = json!({
        "url": root.as_str(),
        "manifest": {
            "source": match args.manifest.as_deref() {
                None => "attestation",
                Some(m) if m.starts_with("https://") || m.starts_with("http://") => "url",
                Some(_) => "file",
            },
            "commit": trusted.commit,
            "network": trusted.network,
            "variant": trusted.variant,
        },
        "servedManifestAgrees": manifest_agrees,
        "files": trusted.files.len(),
        "matched": result.matched,
        "differ": result.differ,
        "missing": result.missing,
        "ok": result.ok(),
    });
    let human = || {
        println!("Site:      {root}");
        println!(
            "Build:     commit {} ({}, {} build)",
            trusted.commit.as_deref().unwrap_or("unknown"),
            trusted.network.as_deref().unwrap_or("network unknown"),
            trusted.variant.as_deref().unwrap_or("unknown")
        );
        println!("Manifest:  {source}");
        if manifest_agrees == Some(false) {
            println!("           the site's own manifest lists other files");
        }
        println!(
            "Files:     {} of {} match",
            result.matched,
            trusted.files.len()
        );
        for p in &result.differ {
            println!("  differs: {p}");
        }
        for p in &result.missing {
            println!("  missing: {p}");
        }
    };
    if result.ok() {
        ctx.emit(body, human);
        return Ok(());
    }
    if !ctx.json {
        human();
    }
    let err = UserError::new(codes::INTEGRITY, "the site does not match its build")
        .cause(result.summary())
        .fix(UNPUBLISHED_FIX);
    Err(crate::errors::reported(err, body))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(files: &[(&str, &str)]) -> Manifest {
        Manifest {
            format: 1,
            commit: None,
            network: None,
            variant: None,
            files: files
                .iter()
                .map(|(p, h)| ((*p).to_string(), (*h).to_string()))
                .collect(),
        }
    }

    #[test]
    fn every_listed_file_must_be_served_with_its_bytes() {
        let m = manifest(&[("index.html", "aa"), ("a.js", "bb"), ("b.js", "cc")]);
        let r = compare(
            &m,
            [
                ("index.html".into(), Some("AA".into())),
                ("a.js".into(), Some("00".into())),
                ("b.js".into(), None),
                ("extra.js".into(), Some("dd".into())),
            ],
        );
        assert_eq!(r.matched, 1);
        assert_eq!(r.differ, ["a.js"]);
        assert_eq!(r.missing, ["b.js"]);
        assert!(!r.ok());
        assert_eq!(r.summary(), "1 file differs, 1 is missing");
    }

    #[test]
    fn paths_are_encoded_under_the_site_root() {
        let root = site_root("https://forge.example/sub").unwrap();
        assert_eq!(
            file_url(&root, "_next/static/chunks/app/[owner]/page-1.js")
                .unwrap()
                .as_str(),
            "https://forge.example/sub/_next/static/chunks/app/%5Bowner%5D/page-1.js"
        );
        assert_eq!(
            file_url(&root, "a b%#?.txt").unwrap().as_str(),
            "https://forge.example/sub/a%20b%25%23%3F.txt"
        );
        assert!(site_root("ftp://x").is_err());
    }

    #[test]
    fn a_manifest_of_another_format_is_refused() {
        assert!(Manifest::parse(br#"{"format":1,"files":{"a":"b"}}"#).is_ok());
        assert!(Manifest::parse(br#"{"format":2,"files":{}}"#).is_err());
        assert!(Manifest::parse(b"nope").is_err());
    }
}
