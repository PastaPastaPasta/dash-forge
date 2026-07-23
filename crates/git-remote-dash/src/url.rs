//! `dash://<owner>/<repo>` URL parsing.
//!
//! `owner` is the repository owner — a base58 Dash identity id for M1 (a DPNS label is a
//! later addition, resolved to an identity id upstream of this parser). `repo` is the
//! repository name; a trailing `.git` (the convention many hosts accept) is stripped.

use anyhow::{bail, Result};

/// The scheme this helper serves.
pub const SCHEME: &str = "dash";

/// A parsed `dash://<owner>/<repo>` remote URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashUrl {
    /// The repository owner (base58 identity id for M1).
    pub owner: String,
    /// The repository name (any trailing `.git` removed).
    pub repo: String,
}

impl DashUrl {
    /// Parse a `dash://<owner>/<repo>` URL, rejecting anything that is not exactly one
    /// non-empty owner segment and one non-empty repo segment under the `dash` scheme.
    pub fn parse(url: &str) -> Result<Self> {
        let rest = url
            .strip_prefix(&format!("{SCHEME}://"))
            .ok_or_else(|| anyhow::anyhow!("not a {SCHEME}:// URL: {url:?}"))?;

        // Split into exactly owner / repo. Reject extra path segments (no sub-paths in M1)
        // and any empty component.
        let mut parts = rest.splitn(2, '/');
        let owner = parts.next().unwrap_or_default();
        let repo_seg = parts.next().unwrap_or_default();

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

        Ok(Self {
            owner: owner.to_string(),
            repo: repo.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::DashUrl;

    #[test]
    fn parses_owner_and_repo() {
        let u =
            DashUrl::parse("dash://8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB/m1-abcd").unwrap();
        assert_eq!(u.owner, "8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB");
        assert_eq!(u.repo, "m1-abcd");
    }

    #[test]
    fn strips_trailing_dot_git() {
        let u = DashUrl::parse("dash://alice/project.git").unwrap();
        assert_eq!(u.owner, "alice");
        assert_eq!(u.repo, "project");
    }

    #[test]
    fn rejects_wrong_scheme() {
        assert!(DashUrl::parse("https://alice/project").is_err());
        assert!(DashUrl::parse("dash:/alice/project").is_err());
    }

    #[test]
    fn rejects_missing_components() {
        assert!(DashUrl::parse("dash://").is_err());
        assert!(DashUrl::parse("dash://alice").is_err());
        assert!(DashUrl::parse("dash://alice/").is_err());
        assert!(DashUrl::parse("dash:///project").is_err());
    }

    #[test]
    fn rejects_sub_paths() {
        assert!(DashUrl::parse("dash://alice/group/project").is_err());
    }
}
