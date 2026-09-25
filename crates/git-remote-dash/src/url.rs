//! `dash://` URL parsing — two addressing forms.
//!
//! * `dash://<owner>/<repo>` — the human form. `owner` is a base58 Dash identity id (a DPNS
//!   label is a later addition, resolved upstream of this parser); a trailing `.git` on the
//!   repo name is stripped. Resolved through the registry's `(ownerId, normalizedName)`
//!   index.
//! * `dash://<contractId>` — contract-addressed, a single segment. The registry indexes
//!   name-to-contract but nothing indexes contract-to-name, so a repo referenced only by
//!   contract id — which is how a pull request points at the repo holding its head commit
//!   (`patch.sourceContractId`) — would otherwise be unaddressable. The contract carries
//!   its own owner, so this form needs no registry lookup at all, and it also works for a
//!   repo whose listing is missing.
//!
//! The two are unambiguous: the human form always has a `/`.

use anyhow::{bail, Result};

/// The scheme this helper serves.
pub const SCHEME: &str = "dash";

/// A parsed `dash://` remote URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DashUrl {
    /// `dash://<owner>/<repo>` — resolved through the registry.
    Named {
        /// The repository owner (base58 identity id for M1).
        owner: String,
        /// The repository name (any trailing `.git` removed).
        repo: String,
    },
    /// `dash://<contractId>` — resolved directly from the contract.
    Contract {
        /// Base58 repo contract id.
        contract_id: String,
    },
}

impl std::fmt::Display for DashUrl {
    /// `owner/repo`, or the contract id — how the push plan line names the repo.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DashUrl::Named { owner, repo } => write!(f, "{owner}/{repo}"),
            DashUrl::Contract { contract_id } => f.write_str(contract_id),
        }
    }
}

impl DashUrl {
    /// Parse either addressing form, rejecting anything else under the `dash` scheme.
    pub fn parse(url: &str) -> Result<Self> {
        let rest = url
            .strip_prefix(&format!("{SCHEME}://"))
            .ok_or_else(|| anyhow::anyhow!("not a {SCHEME}:// URL: {url:?}"))?;

        let Some((owner, repo_seg)) = rest.split_once('/') else {
            // Single segment: contract-addressed. Require it to LOOK like a contract id
            // rather than accepting any single word — otherwise `dash://alice` (a
            // forgotten repo name, previously a clear error) would parse here and fail
            // much later with a confusing "contract not found".
            let contract_id = rest.strip_suffix(".git").unwrap_or(rest);
            if !looks_like_contract_id(contract_id) {
                bail!(
                    "{SCHEME}:// URL is missing a repo name: {url:?} \
                     (expected dash://<owner>/<repo>, or dash://<contractId> with a base58 contract id)"
                );
            }
            return Ok(Self::Contract {
                contract_id: contract_id.to_string(),
            });
        };

        if owner.is_empty() {
            bail!("{SCHEME}:// URL is missing an owner: {url:?}");
        }
        if repo_seg.is_empty() {
            bail!("{SCHEME}:// URL is missing a repo name: {url:?}");
        }
        if repo_seg.contains('/') {
            bail!("{SCHEME}:// URL has an unexpected sub-path: {url:?} (expected dash://<owner>/<repo>)");
        }

        let repo = repo_seg.strip_suffix(".git").unwrap_or(repo_seg);
        if repo.is_empty() {
            bail!("{SCHEME}:// URL repo name is empty after stripping .git: {url:?}");
        }

        Ok(Self::Named {
            owner: owner.to_string(),
            repo: repo.to_string(),
        })
    }
}

/// Whether `s` is plausibly a base58 32-byte id (a contract id or an identity id): 40-44
/// characters from the base58 alphabet, which excludes `0`, `O`, `I` and `l`. Mirrors the
/// same heuristic `dg`'s `RepoRef` uses to tell an identity id from a DPNS label.
fn looks_like_contract_id(s: &str) -> bool {
    (40..=44).contains(&s.len())
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() && !matches!(c, '0' | 'O' | 'I' | 'l'))
}

#[cfg(test)]
mod tests {
    use super::{looks_like_contract_id, DashUrl};

    const ID: &str = "8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB";
    const CONTRACT: &str = "5rrwgjjVUqMghnessfiXPXubpiM2QLNNXH142Hv4PDyX";

    fn named(u: &DashUrl) -> (&str, &str) {
        match u {
            DashUrl::Named { owner, repo } => (owner, repo),
            DashUrl::Contract { .. } => panic!("expected a named URL"),
        }
    }

    #[test]
    fn parses_owner_and_repo() {
        let u = DashUrl::parse(&format!("dash://{ID}/m1-abcd")).unwrap();
        assert_eq!(named(&u), (ID, "m1-abcd"));
    }

    #[test]
    fn strips_trailing_dot_git() {
        let u = DashUrl::parse("dash://alice/project.git").unwrap();
        assert_eq!(named(&u), ("alice", "project"));
    }

    #[test]
    fn parses_contract_addressed() {
        let u = DashUrl::parse(&format!("dash://{CONTRACT}")).unwrap();
        assert_eq!(
            u,
            DashUrl::Contract {
                contract_id: CONTRACT.to_string()
            }
        );
        // `.git` is stripped here too, so a remote added with either spelling resolves.
        let u = DashUrl::parse(&format!("dash://{CONTRACT}.git")).unwrap();
        assert_eq!(
            u,
            DashUrl::Contract {
                contract_id: CONTRACT.to_string()
            }
        );
    }

    #[test]
    fn rejects_wrong_scheme() {
        assert!(DashUrl::parse("https://alice/project").is_err());
        assert!(DashUrl::parse("dash:/alice/project").is_err());
    }

    #[test]
    fn rejects_missing_components() {
        assert!(DashUrl::parse("dash://").is_err());
        // A single segment that is not a plausible contract id is still a missing repo
        // name, not a contract-addressed URL — the contract form must not swallow typos.
        assert!(DashUrl::parse("dash://alice").is_err());
        assert!(DashUrl::parse("dash://alice/").is_err());
        assert!(DashUrl::parse("dash:///project").is_err());
    }

    #[test]
    fn rejects_sub_paths() {
        assert!(DashUrl::parse("dash://alice/group/project").is_err());
    }

    #[test]
    fn contract_id_shape() {
        assert!(looks_like_contract_id(CONTRACT));
        assert!(looks_like_contract_id(ID));
        assert!(!looks_like_contract_id("alice"));
        // Base58 excludes these four characters, so a string containing one is not an id.
        assert!(!looks_like_contract_id(&"0".repeat(44)));
        assert!(!looks_like_contract_id(&"a".repeat(45)));
    }
}
