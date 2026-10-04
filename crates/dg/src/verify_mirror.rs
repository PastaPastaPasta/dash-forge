//! `dg verify-mirror <url>`: check a plain-git mirror of a Forge repository (a forge-gateway's
//! `https://<gateway>/<owner>/<name>.git`) against Dash Platform.
//!
//! The mirror is asked what it serves (`git ls-remote <url>`) and what it claims
//! (`<url>/forge-manifest.json`: the Platform block its snapshot reflects and the `refUpdate`
//! behind each ref). The refs are folded from Platform with proofs, and each served ref is a
//! **match**, **stale** (an earlier tip of the ref, which moved after the mirror's snapshot) or a
//! **MISMATCH** (a tip the ref never had, a ref Platform does not have, or a claim the manifest
//! cannot back). Only a mismatch fails the command, unless `--strict`.

use std::collections::BTreeMap;
use std::process::Command;
use std::time::Duration;

use anyhow::{bail, Context as _, Result};
use forge_core::mirror::{
    compare, parse_ls_remote, Comparison, Manifest, Verdict, MANIFEST_FILE, MANIFEST_SCHEMA,
};
use forge_core::repo::RefRecord;
use forge_core::user_error::{codes, UserError};
use serde_json::json;

use crate::common::Reader;
use crate::context::Ctx;
use crate::fmt::safe;

/// The largest manifest read (a repository with thousands of refs stays far below).
const MAX_MANIFEST_BYTES: usize = 8 * 1024 * 1024;

/// `owner/name` from a mirror URL `http(s)://host[:port]/<owner>/<name>[.git][/]`.
pub fn repo_of_url(url: &str) -> Result<(String, String)> {
    let usage = || {
        UserError::new(codes::USAGE, format!("{url:?} is not a mirror URL"))
            .fix("pass the https clone URL a gateway shows, e.g. https://git.example.org/<owner>/<name>.git")
    };
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .ok_or_else(usage)?;
    let path = rest.split_once('/').map(|(_, p)| p).ok_or_else(usage)?;
    let path = path.split(['?', '#']).next().unwrap_or_default();
    let parts: Vec<&str> = path.trim_end_matches('/').split('/').collect();
    let [owner, name] = parts.as_slice() else {
        bail!(usage());
    };
    let name = name.strip_suffix(".git").unwrap_or(name);
    if owner.is_empty() || name.is_empty() {
        bail!(usage());
    }
    Ok(((*owner).to_string(), name.to_string()))
}

/// The URL git clones (`…/<name>.git`), with no trailing slash.
fn git_url(url: &str) -> String {
    let u = url.trim_end_matches('/');
    if u.strip_suffix(".git").is_some() {
        u.to_string()
    } else {
        format!("{u}.git")
    }
}

/// What the mirror's manifest claims that Platform does not back: a different repository or
/// network, a ref the manifest says it serves but the mirror does not, or a `refUpdate` id that
/// is not the one behind the proved tip.
pub fn manifest_problems(
    m: &Manifest,
    served: &BTreeMap<String, String>,
    records: &[RefRecord],
    repo_id: &str,
    network: &str,
) -> Vec<String> {
    let mut out = Vec::new();
    if m.schema != MANIFEST_SCHEMA {
        out.push(format!("unknown manifest schema {:?}", m.schema));
    }
    if m.repo_id != repo_id {
        out.push(format!("names repository {}, not {repo_id}", m.repo_id));
    }
    if m.network != network {
        out.push(format!("is for network {}, not {network}", m.network));
    }
    let proved: BTreeMap<&str, &forge_core::repo::RefTip> = records
        .iter()
        .filter_map(|r| r.tip.as_ref().map(|t| (r.name.as_str(), t)))
        .collect();
    for r in &m.refs {
        if served.get(&r.name) != Some(&r.oid) {
            out.push(format!(
                "lists {} at {} but the mirror does not serve it",
                r.name,
                short(&r.oid)
            ));
        } else if let Some(t) = proved.get(r.name.as_str()) {
            if t.oid == r.oid && t.ref_update_id != r.ref_update_id {
                out.push(format!(
                    "names {} for {}, but Platform's update behind that tip is {}",
                    r.ref_update_id, r.name, t.ref_update_id
                ));
            }
        }
    }
    out
}

fn short(oid: &str) -> &str {
    &oid[..oid.len().min(12)]
}

/// `git ls-remote <url>`, with no prompts and no credential helpers.
fn ls_remote(url: &str) -> Result<String> {
    let out = Command::new("git")
        .args(["-c", "credential.helper=", "ls-remote", url])
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .context("running git ls-remote")?;
    if !out.status.success() {
        bail!(UserError::new(
            codes::UNREACHABLE,
            format!("the mirror at {url} could not be listed")
        )
        .cause(String::from_utf8_lossy(&out.stderr).trim().to_string())
        .fix("check the URL; `git clone dash://<owner>/<name>` never needs a mirror"));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The mirror's manifest, if it publishes one (a plain mirror may not).
async fn fetch_manifest(url: &str) -> Result<Option<Manifest>, String> {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = http
        .get(format!("{url}/{MANIFEST_FILE}"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status().as_u16() == 404 {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let body = resp.bytes().await.map_err(|e| e.to_string())?;
    if body.len() > MAX_MANIFEST_BYTES {
        return Err("the manifest is too large".into());
    }
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|e| format!("not a forge manifest: {e}"))
}

/// One look at the mirror: what it serves and claims, against Platform's refs read after it.
struct Look {
    manifest: Option<Manifest>,
    manifest_error: Option<String>,
    cmp: Comparison,
    problems: Vec<String>,
    verdict: Verdict,
}

async fn look(r: &Reader, url: &str, network: &str) -> Result<Look> {
    // The mirror first, Platform after: a tip the mirror serves is then never newer than the
    // refs it is checked against.
    let served = parse_ls_remote(&ls_remote(url)?);
    let (manifest, manifest_error) = match fetch_manifest(url).await {
        Ok(m) => (m, None),
        Err(e) => (None, Some(e)),
    };
    let records = r.service().read_ref_records(&r.repo).await?;
    let cmp = compare(
        &served,
        &records,
        manifest.as_ref().map(|m| m.platform_time_ms),
    );
    let problems = manifest
        .as_ref()
        .map(|m| manifest_problems(m, &served, &records, r.repo.id(), network))
        .unwrap_or_default();
    let verdict = if problems.is_empty() {
        cmp.verdict
    } else {
        Verdict::Mismatch
    };
    Ok(Look {
        manifest,
        manifest_error,
        cmp,
        problems,
        verdict,
    })
}

/// `dg verify-mirror`.
pub async fn run(ctx: &Ctx, url: &str, strict: bool) -> Result<()> {
    let (owner, name) = repo_of_url(url)?;
    let url = git_url(url);
    let r = Reader::open(ctx, &format!("{owner}/{name}")).await?;
    r.repo.require_public("verifying a mirror")?;
    let network = ctx.network().key();
    let mut l = look(&r, &url, &network).await?;
    if l.verdict == Verdict::Mismatch {
        // A refresh between the listing and the manifest, or a DAPI node a block behind,
        // reads as a mismatch for a moment: look once more before saying so.
        tokio::time::sleep(Duration::from_secs(3)).await;
        l = look(&r, &url, &network).await?;
    }
    let behind = match (&l.manifest, r.client.chain_tip().await.ok()) {
        (Some(m), Some(t)) => Some(t.height.saturating_sub(m.platform_height)),
        _ => None,
    };
    report(
        ctx,
        &url,
        &r.repo.display(),
        l.verdict,
        &l.cmp,
        l.manifest.as_ref(),
        l.manifest_error.as_deref(),
        &l.problems,
        behind,
    );
    match l.verdict {
        Verdict::Mismatch => bail!(UserError::new(
            codes::INTEGRITY,
            format!("the mirror at {url} does not match Dash Platform")
        )
        .cause("it serves a tip, a ref or a claim that Platform's proved refs do not back")
        .fix(format!(
            "clone from Platform instead: git clone dash://{owner}/{name}"
        ))),
        Verdict::Stale if strict => bail!(UserError::new(
            codes::INTEGRITY,
            format!("the mirror at {url} is behind Dash Platform")
        )
        .cause("--strict: a stale ref counts as a failure")
        .fix("wait for the mirror's next refresh, or clone with dash://")),
        _ => Ok(()),
    }
}

#[allow(clippy::too_many_arguments)]
fn report(
    ctx: &Ctx,
    url: &str,
    repo: &str,
    verdict: Verdict,
    cmp: &Comparison,
    manifest: Option<&Manifest>,
    manifest_error: Option<&str>,
    problems: &[String],
    blocks_behind: Option<u64>,
) {
    ctx.emit(
        json!({
            "url": url,
            "repo": repo,
            "verdict": verdict,
            "refs": cmp.refs,
            "manifest": manifest.map(|m| json!({
                "platformHeight": m.platform_height,
                "platformTimeMs": m.platform_time_ms,
                "fetchedAtMs": m.fetched_at_ms,
                "blocksBehind": blocks_behind,
            })),
            "manifestError": manifest_error,
            "manifestProblems": problems,
        }),
        || {
            println!("{}  {}", safe(url), repo);
            for c in &cmp.refs {
                let tip = c
                    .served
                    .as_deref()
                    .or(c.proved.as_deref())
                    .map_or("-", short);
                println!(
                    "  {:<8}  {}  {}  ({})",
                    c.verdict.label(),
                    tip,
                    safe(&c.name),
                    c.why
                );
            }
            match (manifest, manifest_error) {
                (Some(m), _) => println!(
                    "  manifest: snapshot at Platform height {}{}",
                    m.platform_height,
                    blocks_behind.map_or(String::new(), |b| format!(
                        " ({b} blocks behind the chain tip)"
                    ))
                ),
                (None, Some(e)) => println!("  manifest: unreadable ({})", safe(e)),
                (None, None) => {
                    println!("  manifest: none published (staleness is judged without it)")
                }
            }
            for p in problems {
                println!("  MISMATCH  the manifest {}", safe(p));
            }
            let (m, s, x) = (
                cmp.count(Verdict::Match),
                cmp.count(Verdict::Stale),
                cmp.count(Verdict::Mismatch),
            );
            println!(
                "{}: {m} match, {s} stale, {x} mismatch",
                match verdict {
                    Verdict::Match => "match",
                    Verdict::Stale => "stale",
                    Verdict::Mismatch => "MISMATCH",
                }
            );
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::mirror::MANIFEST_SCHEMA;
    use forge_core::repo::RefTip;

    #[test]
    fn mirror_urls_name_the_repository() {
        assert_eq!(
            repo_of_url("https://git.example.org/alice/proj.git").unwrap(),
            ("alice".into(), "proj".into())
        );
        assert_eq!(
            repo_of_url("http://127.0.0.1:8080/G6D3ej/proj/").unwrap(),
            ("G6D3ej".into(), "proj".into())
        );
        for bad in [
            "dash://alice/proj",
            "https://git.example.org/proj.git",
            "https://git.example.org/a/b/c.git",
            "https://git.example.org",
        ] {
            assert!(repo_of_url(bad).is_err(), "{bad}");
        }
        assert_eq!(git_url("https://g/a/b/"), "https://g/a/b.git");
        assert_eq!(git_url("https://g/a/b.git"), "https://g/a/b.git");
    }

    fn tip(name: &str, oid: &str, update: &str) -> RefTip {
        RefTip {
            name: name.into(),
            oid: oid.into(),
            ref_update_id: update.into(),
            document_type: "refUpdate".into(),
            created_at: 1,
            diverged: false,
        }
    }

    #[test]
    fn a_manifest_must_back_what_it_claims() {
        let a = "a".repeat(40);
        let records = vec![RefRecord {
            name: "refs/heads/main".into(),
            tip: Some(tip("refs/heads/main", &a, "U1")),
            tips_ever: [a.clone()].into(),
            changed_at: 1,
        }];
        let served: BTreeMap<String, String> = [("refs/heads/main".to_string(), a.clone())].into();
        let mut m = Manifest {
            schema: MANIFEST_SCHEMA.into(),
            network: "devnet-sakura".into(),
            forge_core: "C".into(),
            repo_id: "R".into(),
            owner_id: "O".into(),
            name: "proj".into(),
            default_branch: None,
            platform_height: 1,
            platform_time_ms: 2,
            fetched_at_ms: 3,
            refs: vec![tip("refs/heads/main", &a, "U1")],
            packs: vec![],
        };
        assert!(manifest_problems(&m, &served, &records, "R", "devnet-sakura").is_empty());
        m.refs[0].ref_update_id = "FORGED".into();
        assert_eq!(
            manifest_problems(&m, &served, &records, "R", "devnet-sakura").len(),
            1
        );
        m.refs[0] = tip("refs/heads/other", &a, "U2");
        assert_eq!(
            manifest_problems(&m, &served, &records, "R", "devnet-sakura").len(),
            1
        );
        assert_eq!(
            manifest_problems(&m, &served, &records, "X", "testnet").len(),
            3
        );
    }
}
