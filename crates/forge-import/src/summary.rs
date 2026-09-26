//! The run summary: printed as a table, and written as JSON (`--summary-json`) for the
//! GitHub Mirror Action's job summary. The JSON shape is a contract with `action/`.

use serde::Serialize;

use forge_core::cost::CREDITS_PER_DASH;
use forge_core::repo::credits_to_dash;

/// What a run wrote (a dry run: would write).
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    /// Ref updates.
    pub refs: u64,
    /// Packs stored.
    pub packs: u64,
    /// Bytes of those packs.
    pub pack_bytes: u64,
    /// Issues created.
    pub issues: u64,
    /// Pull requests created.
    pub prs: u64,
    /// Comments.
    pub comments: u64,
    /// Reviews.
    pub reviews: u64,
    /// State events (close, reopen, merge, labels, draft).
    pub events: u64,
    /// Releases.
    pub releases: u64,
    /// Label definitions.
    pub labels: u64,
    /// Members granted (migrate).
    pub members: u64,
}

impl Counts {
    /// Add what a git push wrote (or would write).
    pub fn add_push(&mut self, push: &crate::gitsync::PushReport) {
        self.refs += push.refs;
        self.packs += push.packs;
        self.pack_bytes += push.pack_bytes;
    }
}

/// How the run ended.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Finished.
    Ok,
    /// A dry run finished (counts are an estimate).
    DryRun,
    /// Stopped at `--max-spend`.
    CapExceeded,
    /// Failed.
    Error,
}

/// The destination repository.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// Owner identity.
    pub owner: String,
    /// Slug.
    pub name: String,
    /// Repo id (empty in a dry run of a repo not created yet).
    pub id: String,
    /// `dash://owner/name`.
    pub url: String,
    /// Created by this run.
    pub created: bool,
}

/// The signing key's limits.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    /// Key id.
    pub id: Option<u32>,
    /// Total budget (credits); `None` = not a limited key.
    pub budget_credits: Option<u64>,
    /// What is left of it.
    pub remaining_credits: Option<u64>,
    /// Expiry (ms since the epoch).
    pub expires_at: Option<u64>,
}

/// The whole summary.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// How it ended.
    pub status: Status,
    /// `testnet`, `mainnet`, `devnet-<name>`.
    pub network: String,
    /// The source (`owner/repo`, or the v1 repo).
    pub source: String,
    /// The destination.
    pub repo: RepoInfo,
    /// What was written.
    pub counts: Counts,
    /// The up-front estimate (credits).
    pub estimate_credits: u64,
    /// What the run spent (credits): the larger of the estimates charged and the measured
    /// balance drop.
    pub spent_credits: u64,
    /// 10¹¹.
    pub credits_per_dash: u64,
    /// The signer's balance at the end.
    pub balance_credits: Option<u64>,
    /// The signing key.
    pub key: KeyInfo,
    /// Non-fatal problems.
    pub warnings: Vec<String>,
    /// The error, when `status` is `error` or `cap_exceeded`.
    pub error: Option<String>,
}

impl Summary {
    /// An empty summary for `network` and `source`.
    pub fn new(network: String, source: String) -> Self {
        Self {
            status: Status::Ok,
            network,
            source,
            repo: RepoInfo::default(),
            counts: Counts::default(),
            estimate_credits: 0,
            spent_credits: 0,
            credits_per_dash: CREDITS_PER_DASH,
            balance_credits: None,
            key: KeyInfo::default(),
            warnings: Vec::new(),
            error: None,
        }
    }

    /// Write the JSON to `path` (owner-readable only is not needed: it holds no secret).
    pub fn write_json(&self, path: &std::path::Path) -> anyhow::Result<()> {
        std::fs::write(path, serde_json::to_vec_pretty(self)?)?;
        Ok(())
    }

    /// The human table.
    pub fn print(&self) {
        let c = &self.counts;
        let label = if self.status == Status::DryRun {
            "would write"
        } else {
            "wrote"
        };
        eprintln!();
        eprintln!("{} → {} ({})", self.source, self.repo.url, self.network);
        eprintln!(
            "  {label}: {} ref updates · {} packs ({}) · {} issues · {} PRs · {} comments · \
             {} reviews · {} events · {} releases · {} labels{}",
            c.refs,
            c.packs,
            forge_core::storage::human_bytes(c.pack_bytes),
            c.issues,
            c.prs,
            c.comments,
            c.reviews,
            c.events,
            c.releases,
            c.labels,
            if c.members > 0 {
                format!(" · {} members", c.members)
            } else {
                String::new()
            }
        );
        if self.status == Status::DryRun {
            eprintln!(
                "  estimate: {:.6} DASH (dry run: nothing written)",
                credits_to_dash(self.spent_credits.max(self.estimate_credits))
            );
        } else {
            eprintln!(
                "  Platform charged: {:.6} DASH (estimated {:.6})",
                credits_to_dash(self.spent_credits),
                credits_to_dash(self.estimate_credits)
            );
        }
        if let Some(b) = self.balance_credits {
            eprintln!("  balance: {:.6} DASH", credits_to_dash(b));
        }
        if let (Some(total), Some(left)) = (self.key.budget_credits, self.key.remaining_credits) {
            eprintln!(
                "  key {} budget: {:.6} of {:.6} DASH left",
                self.key.id.unwrap_or_default(),
                credits_to_dash(left),
                credits_to_dash(total)
            );
        }
        for w in &self.warnings {
            eprintln!("  warning: {w}");
        }
        if let Some(e) = &self.error {
            eprintln!("  error: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_json_shape_matches_the_action_contract() {
        let mut s = Summary::new("devnet-moutai".into(), "o/r".into());
        s.status = Status::CapExceeded;
        s.counts.pack_bytes = 5;
        let v: serde_json::Value = serde_json::to_value(&s).unwrap();
        assert_eq!(v["status"], "cap_exceeded");
        assert_eq!(v["counts"]["packBytes"], 5);
        assert_eq!(v["creditsPerDash"], 100_000_000_000u64);
        for k in [
            "network",
            "source",
            "repo",
            "estimateCredits",
            "spentCredits",
            "balanceCredits",
            "key",
            "warnings",
            "error",
        ] {
            assert!(v.get(k).is_some(), "missing {k}");
        }
        assert!(v["key"].get("remainingCredits").is_some());
        assert!(v["repo"].get("created").is_some());
        let dry = serde_json::to_value(Status::DryRun).unwrap();
        assert_eq!(dry, "dry_run");
    }
}
