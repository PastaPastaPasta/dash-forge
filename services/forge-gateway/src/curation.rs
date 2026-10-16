//! Hosted-surface curation: the repositories and identities dashhq's builds keep out of their
//! discovery surfaces. The list is `forge-contracts/config/curation.json`, shared with the web
//! build and compiled in (a change ships with a rebuilt image). It is not moderation: a hidden
//! repository stays on Dash Platform, `dash://` still reads it, and this gateway still serves
//! its clones, badges and feeds (only `GATEWAY_DENY` stops those). What hiding changes here is
//! the link preview: a hidden repository's share link and card are the site's own, naming
//! nothing of it.
//!
//! The file is checked as the web build checks it (`forge-web/lib/view/curation.ts`): every
//! network's entries, whichever network this gateway serves, with a base58 `id`, a real
//! `YYYY-MM-DD` `added`, a `note` of 1 to 200 characters, no other field and no id twice, so one
//! file cannot pass one build and break the other.

use std::collections::{BTreeMap, HashSet};

use forge_core::platform::decode_identifier;
use serde::Deserialize;

use crate::upstream::RepoInfo;

/// The shared list, as shipped.
pub const EMBEDDED: &str = include_str!("../../../forge-contracts/config/curation.json");

#[derive(Debug, Deserialize)]
struct File {
    networks: BTreeMap<String, Network>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Network {
    hidden_repos: Vec<Entry>,
    hidden_identities: Vec<Entry>,
}

/// `{ "id": "<base58>", "added": "YYYY-MM-DD", "note": "..." }`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    id: String,
    added: String,
    note: String,
}

/// `YYYY-MM-DD`, a real calendar date.
fn is_date(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    let [y, m, d] = parts[..] else {
        return false;
    };
    let digits = |p: &str, n: usize| p.len() == n && p.bytes().all(|b| b.is_ascii_digit());
    if !(digits(y, 4) && digits(m, 2) && digits(d, 2)) {
        return false;
    }
    let (y, m, d): (u32, u32, u32) = (
        y.parse().unwrap_or(0),
        m.parse().unwrap_or(0),
        d.parse().unwrap_or(0),
    );
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let days = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&d)
}

/// The ids of `entries`, each checked; `at` names the list for the error.
fn checked_ids(entries: &[Entry], at: &str) -> Result<HashSet<String>, String> {
    let mut seen = HashSet::new();
    for (i, e) in entries.iter().enumerate() {
        let at = format!("curation list: {at}[{i}]");
        if decode_identifier(&e.id).is_err() {
            return Err(format!("{at}.id is not a base58 identifier"));
        }
        if !is_date(&e.added) {
            return Err(format!("{at}.added must be a YYYY-MM-DD date"));
        }
        if e.note.trim().is_empty() || e.note.chars().count() > 200 {
            return Err(format!("{at}.note must be 1 to 200 characters"));
        }
        if !seen.insert(e.id.clone()) {
            return Err(format!("{at}.id {} is listed twice", e.id));
        }
    }
    Ok(seen)
}

/// What one network hides.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Hidden {
    repos: HashSet<String>,
    identities: HashSet<String>,
}

impl Hidden {
    /// What `json` hides on `network` (`testnet`, `mainnet`, `devnet-<name>`: the gateway's own
    /// network key). A network the file does not list hides nothing. The whole file is checked,
    /// not only `network`'s part.
    pub fn parse(json: &str, network: &str) -> Result<Self, String> {
        let file: File = serde_json::from_str(json).map_err(|e| format!("curation list: {e}"))?;
        let mut mine = Self::default();
        for (key, n) in &file.networks {
            let repos = checked_ids(&n.hidden_repos, &format!("networks.{key}.hiddenRepos"))?;
            let identities = checked_ids(
                &n.hidden_identities,
                &format!("networks.{key}.hiddenIdentities"),
            )?;
            if key == network {
                mine = Self { repos, identities };
            }
        }
        Ok(mine)
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

    const REPO: &str = "29d2S7vB453rNYFdR5Ycwt7y9haRT5fwVwL9zTmBhfV2";
    const OWNER: &str = "3JF3sEqM796hk5WFqA6EtmEwJQ9quALszsfJyvXNQKy3";
    const MAIN: &str = "4Ss5JMkXAD9Z7cktFEdrqeMuT6jGMF1pVozTyPHZ6zT4";

    fn repo(id: &str, owner: &str) -> RepoInfo {
        RepoInfo {
            repo_id: id.into(),
            owner_id: owner.into(),
            name: "n".into(),
            public: true,
        }
    }

    fn list() -> String {
        format!(
            r#"{{
      "$comment": "x",
      "networks": {{
        "testnet": {{
          "hiddenRepos": [{{ "id": "{REPO}", "added": "2026-10-16", "note": "spam" }}],
          "hiddenIdentities": [{{ "id": "{OWNER}", "added": "2026-10-16", "note": "phishing" }}]
        }},
        "mainnet": {{
          "hiddenRepos": [{{ "id": "{MAIN}", "added": "2028-02-29", "note": "n" }}],
          "hiddenIdentities": []
        }}
      }}
    }}"#
        )
    }

    #[test]
    fn the_shipped_list_parses_for_every_network() {
        for network in ["testnet", "devnet-sakura", "mainnet", "devnet-other"] {
            Hidden::parse(EMBEDDED, network).unwrap();
        }
    }

    #[test]
    fn a_repo_or_its_owner_is_hidden_on_its_network_only() {
        let list = list();
        let t = Hidden::parse(&list, "testnet").unwrap();
        assert!(t.hides(&repo(REPO, "Someone")));
        assert!(t.hides(&repo("Fine", OWNER)));
        assert!(!t.hides(&repo("Fine", "Someone")));
        // Another network's entries do not apply, and an unlisted network hides nothing.
        assert!(!t.hides(&repo(MAIN, "Someone")));
        let m = Hidden::parse(&list, "mainnet").unwrap();
        assert!(m.hides(&repo(MAIN, "Someone")) && !m.hides(&repo(REPO, "x")));
        let other = Hidden::parse(&list, "devnet-sakura").unwrap();
        assert!(other.is_empty() && !other.hides(&repo(REPO, OWNER)));
    }

    #[test]
    fn a_malformed_list_is_refused_as_the_web_build_refuses_it() {
        let entries = |e: &str| {
            format!(
                r#"{{"networks": {{"testnet": {{"hiddenRepos": [{e}], "hiddenIdentities": []}}}}}}"#
            )
        };
        let ok = format!(r#"{{"id": "{REPO}", "added": "2026-10-16", "note": "n"}}"#);
        assert!(Hidden::parse(&entries(&ok), "testnet").is_ok());
        assert!(Hidden::parse("{", "testnet").is_err());
        assert!(Hidden::parse(r#"{"networks": 3}"#, "testnet").is_err());
        let long = "x".repeat(201);
        for bad in [
            // not an id; no calendar date; a missing, blank or long note; a field the web
            // schema does not know; an id twice
            r#"{"id": "short", "added": "2026-10-16", "note": "n"}"#.to_string(),
            format!(r#"{{"id": "{REPO}", "added": "2026-02-30", "note": "n"}}"#),
            format!(r#"{{"id": "{REPO}", "added": "16/10/2026", "note": "n"}}"#),
            format!(r#"{{"id": "{REPO}", "added": "2026-10-16"}}"#),
            format!(r#"{{"id": "{REPO}", "added": "2026-10-16", "note": " "}}"#),
            format!(r#"{{"id": "{REPO}", "added": "2026-10-16", "note": "{long}"}}"#),
            format!(r#"{{"id": "{REPO}", "added": "2026-10-16", "note": "n", "extra": 1}}"#),
            format!("{ok}, {ok}"),
        ] {
            assert!(Hidden::parse(&entries(&bad), "testnet").is_err(), "{bad}");
            // Whichever network this gateway serves: the file is one file.
            assert!(Hidden::parse(&entries(&bad), "mainnet").is_err(), "{bad}");
        }
        // Both lists are required, as in the web build; an empty one is fine.
        assert!(Hidden::parse(r#"{"networks": {"testnet": {}}}"#, "testnet").is_err());
        assert!(Hidden::parse(
            r#"{"networks": {"testnet": {"hiddenRepos": [], "hiddenIdentities": [], "x": 1}}}"#,
            "testnet"
        )
        .is_err());
    }
}
