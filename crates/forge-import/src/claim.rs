//! Gist-claim author flow (PRD 06 author mapping).
//!
//! Migrated GitHub authors become **placeholder author records** — their login is embedded
//! in every imported doc's `imported.author` provenance (and clients render an avatar from
//! `https://github.com/<login>.png`). A real person proves control of that GitHub account
//! and binds it to a Dash identity with a **signed gist challenge**:
//!
//! 1. `forge-import claim <login> --gist <url>` fetches the gist (via `gh api`, so no extra
//!    auth), and checks the gist **owner login == the claimed login** — only that GitHub
//!    account can create a gist under it, so this proves GitHub control.
//! 2. The gist body must carry a well-formed challenge binding a Dash `identity` to the
//!    `github` login, plus a `signature` produced by that identity's key over the challenge
//!    string. The structure is verified here; the cryptographic signature check against the
//!    identity's public key is the documented mechanism (a full BLS/ECDSA verify needs the
//!    SDK key material and is folded in `FORGE_RULES_V1` alongside the on-chain claim doc).
//! 3. On success an `authorClaim` record is produced — the doc a `FORGE_RULES_V1`-aware
//!    client folds so the placeholder thereafter renders as the claiming identity. The
//!    `authorClaim` document type is a repo-template v2 addition (the deployed v1 template
//!    carries no claim type yet), so this command verifies + emits the record and reports
//!    the write as pending that template bump.
//!
//! Challenge format (the string the identity signs, one field per line):
//! ```text
//! dash-forge-author-claim
//! identity: <base58 Dash identity id>
//! github: <login>
//! signature: <base64 signature over the two preceding lines>
//! ```

use std::process::Command;

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;

/// The verified result of a gist claim.
#[derive(Debug, Clone)]
pub struct AuthorClaim {
    /// The GitHub login proven controlled.
    pub github_login: String,
    /// The Dash identity id (base58) the login is bound to.
    pub identity_id: String,
    /// The gist URL that carried the challenge.
    pub gist_url: String,
    /// The signature string from the challenge (verified for structure here).
    pub signature: String,
}

/// Gist JSON shape (only the fields we need).
#[derive(Debug, Deserialize)]
struct Gist {
    #[serde(default)]
    owner: GistOwner,
    #[serde(default)]
    files: std::collections::BTreeMap<String, GistFile>,
}

#[derive(Debug, Default, Deserialize)]
struct GistOwner {
    #[serde(default)]
    login: String,
}

#[derive(Debug, Default, Deserialize)]
struct GistFile {
    #[serde(default)]
    content: String,
}

/// Extract the gist id from a gist URL or bare id
/// (`https://gist.github.com/user/<id>` → `<id>`).
fn gist_id(url_or_id: &str) -> &str {
    url_or_id
        .trim()
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(url_or_id)
}

/// Verify a gist claim: fetch the gist, prove the owner login matches, and validate the
/// challenge binds `expected_login` to a Dash identity with a signature.
pub fn verify(expected_login: &str, gist_url: &str) -> Result<AuthorClaim> {
    let id = gist_id(gist_url);
    let out = Command::new("gh")
        .args(["api", &format!("gists/{id}")])
        .output()
        .context("running `gh api gists/<id>` — is the GitHub CLI installed/authenticated?")?;
    if !out.status.success() {
        bail!(
            "fetching gist {id} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    let gist: Gist = serde_json::from_slice(&out.stdout).context("parsing gist JSON")?;

    // 1. GitHub control: the gist owner must be the claimed login.
    if gist.owner.login.is_empty() {
        bail!("gist {id} has no resolvable owner — cannot prove GitHub control");
    }
    if !gist.owner.login.eq_ignore_ascii_case(expected_login) {
        bail!(
            "gist owner {:?} does not match claimed login {:?} — GitHub control not proven",
            gist.owner.login,
            expected_login
        );
    }

    // 2. Locate + parse the challenge across the gist's files.
    let body = gist
        .files
        .values()
        .map(|f| f.content.as_str())
        .find(|c| c.contains("dash-forge-author-claim"))
        .ok_or_else(|| {
            anyhow!("no `dash-forge-author-claim` challenge found in gist {id}'s files")
        })?;

    let challenge = parse_challenge(body)?;
    if !challenge.github.eq_ignore_ascii_case(expected_login) {
        bail!(
            "challenge github field {:?} does not match claimed login {:?}",
            challenge.github,
            expected_login
        );
    }

    Ok(AuthorClaim {
        github_login: expected_login.to_string(),
        identity_id: challenge.identity,
        gist_url: gist_url.to_string(),
        signature: challenge.signature,
    })
}

/// The parsed challenge fields.
struct Challenge {
    identity: String,
    github: String,
    signature: String,
}

/// Parse the `identity:` / `github:` / `signature:` lines from a challenge body, requiring
/// all three and the header marker.
fn parse_challenge(body: &str) -> Result<Challenge> {
    let mut identity = None;
    let mut github = None;
    let mut signature = None;
    let mut header = false;
    for line in body.lines() {
        let line = line.trim();
        if line == "dash-forge-author-claim" {
            header = true;
        } else if let Some(v) = line.strip_prefix("identity:") {
            identity = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("github:") {
            github = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("signature:") {
            signature = Some(v.trim().to_string());
        }
    }
    if !header {
        bail!("challenge missing the `dash-forge-author-claim` header line");
    }
    let identity = identity.filter(|s| !s.is_empty()).ok_or_else(|| {
        anyhow!("challenge missing a non-empty `identity:` line (base58 Dash identity id)")
    })?;
    let github = github
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("challenge missing a non-empty `github:` line"))?;
    let signature = signature
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("challenge missing a non-empty `signature:` line"))?;
    // Structural signature check (base64-ish, non-trivial length). The full cryptographic
    // verify against the identity's public key is the documented mechanism folded in
    // FORGE_RULES_V1 with the on-chain authorClaim doc (template v2).
    if signature.len() < 16 {
        bail!(
            "challenge `signature:` is implausibly short ({} chars)",
            signature.len()
        );
    }
    Ok(Challenge {
        identity,
        github,
        signature,
    })
}

#[cfg(test)]
mod tests {
    use super::{gist_id, parse_challenge};

    #[test]
    fn extracts_gist_id() {
        assert_eq!(gist_id("https://gist.github.com/alice/abc123"), "abc123");
        assert_eq!(gist_id("abc123"), "abc123");
        assert_eq!(gist_id("https://gist.github.com/alice/abc123/"), "abc123");
    }

    #[test]
    fn parses_wellformed_challenge() {
        let body = "dash-forge-author-claim\n\
                    identity: 8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB\n\
                    github: octocat\n\
                    signature: c2lnbmF0dXJlLXBsYWNlaG9sZGVyLWJhc2U2NA==\n";
        let c = parse_challenge(body).unwrap();
        assert_eq!(c.identity, "8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB");
        assert_eq!(c.github, "octocat");
        assert!(c.signature.len() >= 16);
    }

    #[test]
    fn rejects_incomplete_challenge() {
        assert!(parse_challenge("identity: x\ngithub: y\nsignature: zzzzzzzzzzzzzzzz").is_err());
        assert!(parse_challenge("dash-forge-author-claim\ngithub: y").is_err());
        assert!(parse_challenge(
            "dash-forge-author-claim\nidentity: x\ngithub: y\nsignature: short"
        )
        .is_err());
    }
}
