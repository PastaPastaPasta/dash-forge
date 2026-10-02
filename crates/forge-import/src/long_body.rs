//! Long bodies in a mirror (`docs/contracts/forge-v2.md` §6.3): a source issue, PR, comment,
//! review or release longer than its field holds (5,120 bytes, less in a private destination)
//! keeps its whole text. The full text is stored as a repository artifact on the run's storage
//! policy (the mirror's `dash.storage`, else Platform), and the field holds its first part and
//! a line naming the artifact. When the artifact cannot be stored, the text is cut to the field
//! with a link to the source, as before long bodies (and the run warns).

use std::path::Path;

use forge_core::storage::{ExternalTarget, ResolvedPolicy};

/// Where a run stores long bodies' full texts: its storage policy, resolved.
#[derive(Debug, Clone)]
pub struct BodyStorage {
    resolved: ResolvedPolicy,
}

impl Default for BodyStorage {
    /// Platform `chunk` documents only.
    fn default() -> Self {
        Self::platform()
    }
}

impl BodyStorage {
    /// Platform `chunk` documents only (no storage policy of your own).
    #[must_use]
    pub fn platform() -> Self {
        Self {
            resolved: ResolvedPolicy {
                external: Vec::new(),
                platform: true,
                replicas: 1,
                platform_fallback: false,
            },
        }
    }

    /// The storage policy in `git_dir`'s git config (any scope, as a push reads it).
    pub fn from_git_dir(git_dir: &Path) -> anyhow::Result<Self> {
        Ok(Self {
            resolved: crate::gitsync::resolved_storage(git_dir)?,
        })
    }

    /// An upper bound on the credits of storing `bytes` of text (`sealed`: in a private
    /// destination).
    #[must_use]
    pub fn credits(&self, bytes: u64, sealed: bool) -> u64 {
        forge_core::cost::push_fees::long_body(
            bytes,
            sealed,
            self.resolved.external.len() as u64,
            self.resolved.platform,
        )
    }

    /// The external targets, opened.
    pub(crate) fn external_targets(&self) -> forge_core::Result<Vec<ExternalTarget>> {
        crate::gitsync::external_targets(&self.resolved)
            .map_err(|e| forge_core::error::Error::Config(format!("{e:#}")))
    }

    /// Whether Platform `chunk` documents are one of the targets.
    #[must_use]
    pub fn platform_targeted(&self) -> bool {
        self.resolved.platform
    }

    /// How many copies must confirm.
    #[must_use]
    pub fn replicas(&self) -> usize {
        self.resolved.replicas
    }
}
