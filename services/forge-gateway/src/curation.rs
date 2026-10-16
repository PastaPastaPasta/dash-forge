//! Hosted-surface curation: the repositories and identities dashhq's builds keep out of their
//! discovery surfaces. The list is `forge-contracts/config/curation.json`, shared with the web
//! build and compiled in (a change ships with a rebuilt image). It is not moderation: a hidden
//! repository stays on Dash Platform, `dash://` still reads it, and this gateway still serves
//! its clones, badges and feeds (only `GATEWAY_DENY` stops those). What hiding changes here is
//! the link preview: a hidden repository's share link and card are the site's own, naming
//! nothing of it.

use std::collections::{BTreeMap, HashSet};

use serde::Deserialize;

use crate::upstream::RepoInfo;

/// The shared list, as shipped.
pub const EMBEDDED: &str = include_str!("../../../forge-contracts/config/curation.json");

#[derive(Debug, Deserialize)]
struct File {
    networks: BTreeMap<String, Network>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Network {
    #[serde(default)]
    hidden_repos: Vec<Entry>,
    #[serde(default)]
    hidden_identities: Vec<Entry>,
}

/// `{ "id": "<base58>", "added": "YYYY-MM-DD", "note": "..." }`.
#[derive(Debug, Deserialize)]
struct Entry {
    id: String,
}

/// What one network hides.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Hidden {
    repos: HashSet<String>,
    identities: HashSet<String>,
}

impl Hidden {
    /// What `json` hides on `network` (`testnet`, `mainnet`, `devnet-<name>`: the gateway's own
    /// network key). A network the file does not list hides nothing.
    pub fn parse(json: &str, network: &str) -> Result<Self, String> {
        let file: File = serde_json::from_str(json).map_err(|e| format!("curation list: {e}"))?;
        let Some(n) = file.networks.get(network) else {
            return Ok(Self::default());
        };
        let ids = |entries: &[Entry], what: &str| -> Result<HashSet<String>, String> {
            entries
                .iter()
                .map(|e| {
                    let id = e.id.trim();
                    if id.is_empty() || id.contains(char::is_whitespace) {
                        Err(format!(
                            "curation list: {what} has an entry without a usable id"
                        ))
                    } else {
                        Ok(id.to_string())
                    }
                })
                .collect()
        };
        Ok(Self {
            repos: ids(&n.hidden_repos, "hiddenRepos")?,
            identities: ids(&n.hidden_identities, "hiddenIdentities")?,
        })
    }

    /// What the compiled-in list hides on `network`. A list that does not parse (a test keeps
    /// the shipped one valid) hides nothing, and says so.
    pub fn embedded(network: &str) -> Self {
        Self::parse(EMBEDDED, network).unwrap_or_else(|e| {
            tracing::error!(error = %e, "the compiled-in curation list is unusable; nothing is hidden");
            Self::default()
        })
    }

    /// Whether `repo`, or its owner, is hidden.
    pub fn hides(&self, repo: &RepoInfo) -> bool {
        self.repos.contains(&repo.repo_id) || self.identities.contains(&repo.owner_id)
    }

    /// Whether nothing is hidden.
    pub fn is_empty(&self) -> bool {
        self.repos.is_empty() && self.identities.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(id: &str, owner: &str) -> RepoInfo {
        RepoInfo {
            repo_id: id.into(),
            owner_id: owner.into(),
            name: "n".into(),
            public: true,
        }
    }

    const LIST: &str = r#"{
      "$comment": "x",
      "networks": {
        "testnet": {
          "hiddenRepos": [{ "id": "RepoBad", "added": "2026-10-16", "note": "spam" }],
          "hiddenIdentities": [{ "id": "OwnerBad", "added": "2026-10-16", "note": "phishing" }]
        },
        "mainnet": { "hiddenRepos": [{ "id": "MainRepo" }], "hiddenIdentities": [] }
      }
    }"#;

    #[test]
    fn the_shipped_list_parses_for_every_network() {
        for network in ["testnet", "devnet-sakura", "mainnet", "devnet-other"] {
            Hidden::parse(EMBEDDED, network).unwrap();
        }
    }

    #[test]
    fn a_repo_or_its_owner_is_hidden_on_its_network_only() {
        let t = Hidden::parse(LIST, "testnet").unwrap();
        assert!(t.hides(&repo("RepoBad", "Someone")));
        assert!(t.hides(&repo("Fine", "OwnerBad")));
        assert!(!t.hides(&repo("Fine", "Someone")));
        // Another network's entries do not apply, and an unlisted network hides nothing.
        assert!(!t.hides(&repo("MainRepo", "Someone")));
        let m = Hidden::parse(LIST, "mainnet").unwrap();
        assert!(m.hides(&repo("MainRepo", "Someone")) && !m.hides(&repo("RepoBad", "x")));
        let other = Hidden::parse(LIST, "devnet-sakura").unwrap();
        assert!(other.is_empty() && !other.hides(&repo("RepoBad", "OwnerBad")));
    }

    #[test]
    fn a_malformed_list_is_refused() {
        assert!(Hidden::parse("{", "testnet").is_err());
        assert!(Hidden::parse(r#"{"networks": 3}"#, "testnet").is_err());
        assert!(Hidden::parse(
            r#"{"networks": {"testnet": {"hiddenRepos": [{"id": " "}]}}}"#,
            "testnet"
        )
        .is_err());
        // Missing lists are empty ones.
        assert!(Hidden::parse(r#"{"networks": {"testnet": {}}}"#, "testnet")
            .unwrap()
            .is_empty());
    }
}
