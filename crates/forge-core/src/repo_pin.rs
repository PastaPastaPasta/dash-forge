//! The repository-id pin a clone records for a named `dash://<owner>/<name>` URL (BACKLOG S2),
//! shared by `git-remote-dash` (which records and checks it on every fetch and push) and `dg`
//! (which checks it before reading or writing the repository a clone names, QW4-013).
//!
//! A DPNS name is a pointer, not an identity: it can change hands, and the same URL would then
//! resolve to another identity's repository of the same name. So the clone keeps what the URL
//! resolved to in its own git config, per network:
//!
//! ```text
//! [dash "devnet-sakura:dash://alice/project"]
//!     repoId = <base58 repo document id>
//!     ownerId = <base58 owner identity id>
//! ```

/// The git config key that lets one fetch or push accept a re-pointed URL (and re-pin it), and
/// lets a `dg` command act on the repository the name names now.
pub const ALLOW_REPIN_GIT_KEY: &str = "dash.allowRepin";

/// The git config section of the pin of `dash://<owner>/<repo>` on `network`
/// (`dash.devnet-sakura:dash://alice/project`). A DPNS owner is keyed as DPNS compares it
/// (case-insensitive, without `@` or `.dash`), and the repo name as the resolver does
/// (lowercase), so the spellings that resolve alike share one pin; an identity id keeps its
/// case (base58 is case-sensitive).
#[must_use]
pub fn section(owner: &str, repo: &str, network: &str) -> String {
    let owner = owner.strip_prefix('@').unwrap_or(owner);
    let owner = match crate::resolve::dpns_label(owner) {
        Some(label) if !crate::resolve::looks_like_identity_id(owner) => label.to_ascii_lowercase(),
        _ => owner.to_string(),
    };
    format!(
        "dash.{network}:dash://{owner}/{}",
        repo.to_ascii_lowercase()
    )
}

/// A pin as recorded: either key may be missing (a hand-edited or partly written pin).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Recorded {
    /// `repoId`.
    pub repo_id: Option<String>,
    /// `ownerId`.
    pub owner_id: Option<String>,
}

impl Recorded {
    /// Nothing is pinned.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.repo_id.is_none() && self.owner_id.is_none()
    }

    /// Whether the repository `repo_id` of `owner_id` is the pinned one: every recorded key
    /// agrees (a missing key is not a mismatch).
    #[must_use]
    pub fn matches(&self, repo_id: &str, owner_id: &str) -> bool {
        let same = |v: &Option<String>, now: &str| v.as_deref().is_none_or(|v| v == now);
        same(&self.repo_id, repo_id) && same(&self.owner_id, owner_id)
    }
}

/// A recorded value for messages.
#[must_use]
pub fn shown(v: Option<&str>) -> &str {
    v.unwrap_or("(not recorded)")
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER: &str = "8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB";

    #[test]
    fn spellings_that_resolve_alike_share_a_section() {
        let alice = "dash.devnet-sakura:dash://alice/project";
        for (owner, repo) in [
            ("alice", "project"),
            ("Alice.dash", "Project"),
            ("@alice", "project"),
        ] {
            assert_eq!(
                section(owner, repo, "devnet-sakura"),
                alice,
                "{owner}/{repo}"
            );
        }
        assert_eq!(
            section(OWNER, "project", "testnet"),
            format!("dash.testnet:dash://{OWNER}/project")
        );
    }

    #[test]
    fn a_pin_matches_only_the_repository_it_recorded() {
        let pin = Recorded {
            repo_id: Some("R1".into()),
            owner_id: Some("O1".into()),
        };
        assert!(pin.matches("R1", "O1"));
        assert!(!pin.matches("R2", "O1"));
        assert!(!pin.matches("R1", "O2"));
        let partial = Recorded {
            repo_id: Some("R1".into()),
            owner_id: None,
        };
        assert!(partial.matches("R1", "anyone"));
        assert!(Recorded::default().is_empty());
        assert!(!partial.is_empty());
    }
}
