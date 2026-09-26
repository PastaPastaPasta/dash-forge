//! The spend cap, enforced before every write.
//!
//! `--max-spend` is a hard cap for one run. It is checked twice: up front against the whole
//! estimate (refuse before any write), and again before **each** write against what this run
//! has spent so far plus that write's own estimate. "Spent so far" is the larger of the sum of
//! the estimates of the writes made and the identity's measured balance drop, so an
//! estimate that runs low cannot carry the run past the cap for long: every
//! [`Budget::reconcile`] pulls the measured figure in.

use anyhow::{bail, Result};

use forge_core::cost::{estimate_document_storage, CREDITS_PER_DASH};
use forge_core::repo::credits_to_dash;

/// Serialized system fields + CBOR framing added to a document's own property bytes.
const DOC_SYSTEM_OVERHEAD: u64 = 180;

/// Index and count-tree storage a forge-collab document pays beyond its bytes, credits.
/// Measured on moutai (forge-v2): 45 migrated collab docs (issues, comments, events,
/// labels) cost about 42M credits each beyond their bytes; rounded up.
const COLLAB_INDEX_OVERHEAD: u64 = 45_000_000;

/// Index storage a forge-v2 git-data document (`chunk`, `packManifest`, `refUpdate`,
/// membership) pays beyond its bytes, credits. Measured on moutai: a `dg migrate` of 25 ref
/// updates, 121 manifests and 115 chunks cost 0.1998 DASH against 0.0571 by bytes alone,
/// about 55M credits a document (v2 indexes carry `repoId` and the uploader).
pub const GIT_DOC_INDEX_OVERHEAD: u64 = 55_000_000;

/// The estimated credits of one forge-v2 git-data document of `bytes` bytes.
pub fn git_doc_credits(bytes: u64) -> u64 {
    forge_core::cost::estimate(bytes).total() + GIT_DOC_INDEX_OVERHEAD
}

/// The estimated credits of one collaboration document whose properties total `bytes`.
pub fn collab_doc_credits(bytes: u64) -> u64 {
    estimate_document_storage(bytes + DOC_SYSTEM_OVERHEAD).total() + COLLAB_INDEX_OVERHEAD
}

/// Why a run stopped at the cap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapExceeded {
    /// The cap, credits.
    pub cap: u64,
    /// Spent before the refused write, credits.
    pub spent: u64,
    /// The refused write's estimate, credits.
    pub next: u64,
    /// What the write was.
    pub what: String,
}

impl std::fmt::Display for CapExceeded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "--max-spend {:.6} DASH reached: spent {:.6} DASH, and {} would cost ~{:.6} more; \
             stopped before writing it (re-run with a higher cap to continue; nothing is \
             written twice)",
            credits_to_dash(self.cap),
            credits_to_dash(self.spent),
            self.what,
            credits_to_dash(self.next)
        )
    }
}

impl std::error::Error for CapExceeded {}

/// A run's spend ledger against an optional cap.
#[derive(Debug, Clone)]
pub struct Budget {
    cap: Option<u64>,
    estimated: u64,
    measured: u64,
    balance_start: Option<u64>,
}

impl Budget {
    /// A ledger capped at `cap` credits (`None` = uncapped).
    pub fn new(cap: Option<u64>) -> Self {
        Self {
            cap,
            estimated: 0,
            measured: 0,
            balance_start: None,
        }
    }

    /// Record the balance the run started from (enables [`Self::reconcile`]).
    pub fn start(&mut self, balance: u64) {
        self.balance_start = Some(balance);
    }

    /// What this run has spent, as far as it can tell (credits).
    pub fn spent(&self) -> u64 {
        self.estimated.max(self.measured)
    }

    /// The measured balance drop, when a start balance was recorded.
    pub fn measured(&self) -> u64 {
        self.measured
    }

    /// The cap, credits.
    pub fn cap(&self) -> Option<u64> {
        self.cap
    }

    /// How much may still be spent (`None` = uncapped).
    pub fn remaining(&self) -> Option<u64> {
        self.cap.map(|c| c.saturating_sub(self.spent()))
    }

    /// Refuse the whole plan up front when its estimate alone exceeds the cap.
    pub fn check_plan(&self, estimate: u64) -> Result<()> {
        if let Some(cap) = self.cap {
            if estimate > cap {
                bail!(CapExceeded {
                    cap,
                    spent: 0,
                    next: estimate,
                    what: "this run".into(),
                });
            }
        }
        Ok(())
    }

    /// Admit one write estimated at `credits`, or refuse it (before anything is signed).
    /// An admitted write is charged at its estimate.
    pub fn charge(&mut self, credits: u64, what: impl Into<String>) -> Result<()> {
        if let Some(cap) = self.cap {
            let spent = self.spent();
            if spent.saturating_add(credits) > cap {
                bail!(CapExceeded {
                    cap,
                    spent,
                    next: credits,
                    what: what.into(),
                });
            }
        }
        self.estimated = self.estimated.saturating_add(credits);
        Ok(())
    }

    /// Fold in the measured balance drop (`balance_now` after some writes).
    pub fn reconcile(&mut self, balance_now: u64) {
        if let Some(start) = self.balance_start {
            self.measured = self.measured.max(start.saturating_sub(balance_now));
        }
    }
}

/// DASH (from the CLI) to credits, rejecting negative and non-finite amounts.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
pub fn dash_to_credits(dash: f64) -> Result<u64> {
    if !dash.is_finite() || dash < 0.0 {
        bail!("--max-spend must be a non-negative DASH amount");
    }
    Ok((dash * CREDITS_PER_DASH as f64).round() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_write_is_checked_against_what_was_already_spent() {
        let mut b = Budget::new(Some(100));
        b.charge(60, "a").unwrap();
        b.charge(40, "b").unwrap();
        let e = b.charge(1, "c").unwrap_err();
        let cap = e.downcast_ref::<CapExceeded>().unwrap();
        assert_eq!((cap.spent, cap.next, cap.what.as_str()), (100, 1, "c"));
        assert_eq!(b.spent(), 100, "a refused write is not charged");
    }

    #[test]
    fn a_measured_overrun_stops_the_next_write() {
        let mut b = Budget::new(Some(100));
        b.start(1_000);
        b.charge(10, "a").unwrap();
        // The chain says the run really cost 95, not the estimated 10.
        b.reconcile(905);
        assert_eq!(b.spent(), 95);
        assert!(b.charge(10, "b").is_err());
        assert_eq!(b.remaining(), Some(5));
    }

    #[test]
    fn the_plan_is_refused_whole_before_any_write() {
        let b = Budget::new(Some(50));
        assert!(b.check_plan(51).is_err());
        assert!(b.check_plan(50).is_ok());
        assert!(Budget::new(None).check_plan(u64::MAX).is_ok());
    }

    #[test]
    fn dash_amounts_convert_and_bad_ones_are_refused() {
        assert_eq!(dash_to_credits(0.05).unwrap(), 5_000_000_000);
        assert!(dash_to_credits(-1.0).is_err());
        assert!(dash_to_credits(f64::NAN).is_err());
    }

    #[test]
    fn collab_docs_cost_their_bytes_plus_index_overhead() {
        assert!(collab_doc_credits(0) > COLLAB_INDEX_OVERHEAD);
        assert!(collab_doc_credits(1000) > collab_doc_credits(10));
    }
}
