//! `dash://` URL parsing — two addressing forms.
//!
//! * `dash://<owner>/<repo>` — the human form. `owner` is a base58 Dash identity id (a DPNS
//!   label is a later addition, resolved upstream of this parser); a trailing `.git` on the
//!   repo name is stripped. Resolved as a forge-v2 `repo` by `(owner, name)`, falling back to
//!   the v1 registry listing (read-only repositories).
//! * `dash://<id>` — a single segment: a forge-v2 `repo` document id, or a v1 repo contract
//!   id (both are tried, v2 first; see `forge_core::resolve::resolve_id`). This is how a
//!   pull request points at the repo holding its head commit.
//!
//! The two are unambiguous: the human form always has a `/`.

use anyhow::{bail, Result};

/// The scheme this helper serves.
pub const SCHEME: &str = "dash";

/// A parsed `dash://` remote URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DashUrl {
    /// `dash://<owner>/<repo>`.
    Named {
        /// The repository owner (base58 identity id).
        owner: String,
        /// The repository name (any trailing `.git` removed).
        repo: String,
    },
    /// `dash://<id>` — a forge-v2 repo id or a v1 repo contract id.
    Id {
        /// The base58 id.
        id: String,
    },
}

impl std::fmt::Display for DashUrl {
    /// `owner/repo`, or the id — how the push plan line names the repo.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DashUrl::Named { owner, repo } => write!(f, "{owner}/{repo}"),
            DashUrl::Id { id } => f.write_str(id),
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
            // Single segment: id-addressed. Require it to LOOK like an id rather than
            // accepting any single word — otherwise `dash://alice` (a forgotten repo name)
            // would parse here and fail much later with a confusing "not found".
            let id = rest.strip_suffix(".git").unwrap_or(rest);
            if !looks_like_id(id) {
                bail!(
                    "{SCHEME}:// URL is missing a repo name: {url:?} \
                     (expected dash://<owner>/<repo>, or dash://<id> with a base58 repo id)"
                );
            }
            return Ok(Self::Id { id: id.to_string() });
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

/// Whether `s` is plausibly a base58 32-byte id: 40-44 characters from the base58
/// alphabet, which excludes `0`, `O`, `I` and `l`. Mirrors the heuristic `dg`'s repo
/// references use to tell an identity id from a DPNS label.
fn looks_like_id(s: &str) -> bool {
    (40..=44).contains(&s.len())
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() && !matches!(c, '0' | 'O' | 'I' | 'l'))
}

#[cfg(test)]
mod tests {
    use super::{looks_like_id, DashUrl};

    const ID: &str = "8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB";
    const REPO_ID: &str = "5rrwgjjVUqMghnessfiXPXubpiM2QLNNXH142Hv4PDyX";

    fn named(u: &DashUrl) -> (&str, &str) {
        match u {
            DashUrl::Named { owner, repo } => (owner, repo),
            DashUrl::Id { .. } => panic!("expected a named URL"),
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
    fn keeps_the_name_as_typed_for_resolution_to_normalize() {
        // Case folding is the resolver's job (rules::v2::normalize_repo_name), so a remote
        // added as `Dash-Forge` resolves to `dash-forge` there, not here.
        let u = DashUrl::parse(&format!("dash://{ID}/Dash-Forge")).unwrap();
        assert_eq!(named(&u), (ID, "Dash-Forge"));
    }

    #[test]
    fn parses_id_addressed() {
        let u = DashUrl::parse(&format!("dash://{REPO_ID}")).unwrap();
        assert_eq!(
            u,
            DashUrl::Id {
                id: REPO_ID.to_string()
            }
        );
        // `.git` is stripped here too, so a remote added with either spelling resolves.
        let u = DashUrl::parse(&format!("dash://{REPO_ID}.git")).unwrap();
        assert_eq!(
            u,
            DashUrl::Id {
                id: REPO_ID.to_string()
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
        // A single segment that is not a plausible id is still a missing repo name, not an
        // id-addressed URL — the id form must not swallow typos.
        assert!(DashUrl::parse("dash://alice").is_err());
        assert!(DashUrl::parse("dash://alice/").is_err());
        assert!(DashUrl::parse("dash:///project").is_err());
    }

    #[test]
    fn rejects_sub_paths() {
        assert!(DashUrl::parse("dash://alice/group/project").is_err());
    }

    #[test]
    fn id_shape() {
        assert!(looks_like_id(REPO_ID));
        assert!(looks_like_id(ID));
        assert!(!looks_like_id("alice"));
        // Base58 excludes these four characters, so a string containing one is not an id.
        assert!(!looks_like_id(&"0".repeat(44)));
        assert!(!looks_like_id(&"a".repeat(45)));
    }
}
