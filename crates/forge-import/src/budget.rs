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

/// The kinds of forge-collab document the importer writes. Each pays a different index and
/// count-tree cost beyond its bytes: a document type with more indexes (an issue or PR:
/// number, state, author, updated) pays more than a label.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CollabDoc {
    /// An issue or a pull request.
    Target,
    /// A comment.
    Comment,
    /// A review.
    Review,
    /// A member event (a label).
    Event,
    /// A state transition (close, reopen, merge, draft, ready).
    Transition,
    /// A label definition.
    Label,
    /// A release.
    Release,
}

impl CollabDoc {
    /// Index storage beyond the document's bytes, credits. Calibrated on moutai from
    /// per-write balance drops (two clean imports of `PastaPastaPasta/dash-faucet`, and one
    /// of `backports-validation-script`) and, since beta.6, from whole showcase runs: each
    /// figure sits at or above what its kind paid, so a run's total estimate comes out over
    /// what it pays (1.02–1.25x on the recorded runs, never under).
    pub fn index_overhead(self) -> u64 {
        match self {
            // Issues and PRs: measured 58–92M (mean 70–81M). Releases were not measured
            // separately; they are priced as the largest kind (tag, notes, assets).
            CollabDoc::Target | CollabDoc::Release => 90_000_000,
            // Measured 40–55M, mean 43–53M on beta.5; 54M covers the beta.6 dash window.
            CollabDoc::Comment => 54_000_000,
            // Measured 18–113M, mean 21–45M on beta.5; the beta.6 dash window needs 50M.
            CollabDoc::Review => 50_000_000,
            // Events paid 58.4M each on beta.6 (129 merge events on dips, 29 on docs-platform,
            // 2026-09-29: 53.2M estimated, 0.91x). The contract grew (forge-collab 19.5 kB,
            // read on every write) and the event type's indexes (`addressee`, the target's
            // log) fill up; 56M keeps a merge event 10% over.
            //
            // A transition is not measured yet (wipe day, WIPE-PLAN §3 step 8): it is priced as
            // the close / merge event it replaces. It has three indexes (the target's sum and
            // count tree, the per-kind count tree, the feed) and its writer reads two totals;
            // the gate is "≤ 1.15 × the close event", so it is re-measured and raised if over.
            CollabDoc::Event | CollabDoc::Transition => 56_000_000,
            // Measured 27–68M, mean 28–36M.
            CollabDoc::Label => 35_000_000,
        }
    }
}

/// The estimated credits of one collaboration document of `kind` whose properties total
/// `bytes`.
pub fn collab_doc_credits(kind: CollabDoc, bytes: u64) -> u64 {
    estimate_document_storage(bytes + DOC_SYSTEM_OVERHEAD).total() + kind.index_overhead()
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

    /// Whether a write of `credits` would fit under the cap now.
    pub fn fits(&self, credits: u64) -> bool {
        self.cap
            .is_none_or(|cap| self.spent().saturating_add(credits) <= cap)
    }

    /// What may still be spent (`None`: uncapped).
    pub fn remaining(&self) -> Option<u64> {
        self.cap.map(|cap| cap.saturating_sub(self.spent()))
    }

    /// [`Self::check_plan`], and the signer can pay for it: its balance, and a limited
    /// key's remaining budget (Platform refuses a transition past either, mid-run).
    pub fn check_funds(
        &self,
        estimate: u64,
        balance: u64,
        key_remaining: Option<u64>,
    ) -> Result<()> {
        self.check_plan(estimate)?;
        let (available, what) = match key_remaining {
            Some(k) if k < balance => (k, "the signing key's remaining budget"),
            _ => (balance, "the identity's balance"),
        };
        if estimate > available {
            bail!(
                "this run is estimated at {:.6} DASH, more than {what} ({:.6} DASH); top up or \
                 renew the key, or narrow the run (--sync, --limit)",
                credits_to_dash(estimate),
                credits_to_dash(available)
            );
        }
        Ok(())
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

    /// Take back an admitted charge whose write stored nothing (a taken number). The
    /// measured drop still counts whatever fee was really paid.
    pub fn refund(&mut self, credits: u64) {
        self.estimated = self.estimated.saturating_sub(credits);
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
        assert_eq!(b.spent(), 95);
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
        let c = CollabDoc::Comment;
        assert!(collab_doc_credits(c, 0) > c.index_overhead());
        assert!(collab_doc_credits(c, 1000) > collab_doc_credits(c, 10));
    }

    /// A clean, traced import of `PastaPastaPasta/dash-faucet` into moutai (2026-09-26,
    /// `RUST_LOG=forge_import::cost=debug`, an identity nothing else was using): every
    /// collaboration write's properties size (bytes) and measured balance drop. The Mirror
    /// Action's CI run of the same import paid 0.0781 DASH against a 0.0649 estimate (20%
    /// under); the estimate must stay an upper bound, 0–15% over. (Its git pushes are priced
    /// by `forge_core::cost::push_fees`, tested in `gitsync` and `forge_core::cost`.)
    #[test]
    fn estimates_cover_a_recorded_run() {
        const COLLAB: &[(CollabDoc, u64, u64)] = &[
            (CollabDoc::Label, 93, 41_750_760),
            (CollabDoc::Label, 122, 35_258_160),
            (CollabDoc::Label, 117, 34_957_560),
            (CollabDoc::Label, 100, 34_863_920),
            (CollabDoc::Label, 101, 35_103_980),
            (CollabDoc::Label, 103, 34_757_160),
            (CollabDoc::Label, 97, 34_332_380),
            (CollabDoc::Label, 107, 34_826_300),
            (CollabDoc::Label, 100, 34_442_600),
            (CollabDoc::Target, 1051, 125_761_060),
            (CollabDoc::Event, 120, 58_658_220),
            (CollabDoc::Event, 120, 41_859_680),
            (CollabDoc::Comment, 5357, 204_426_380),
            (CollabDoc::Target, 818, 85_828_680),
            (CollabDoc::Event, 120, 50_567_500),
            (CollabDoc::Event, 120, 42_209_020),
            (CollabDoc::Comment, 2562, 130_017_520),
            (CollabDoc::Target, 3067, 149_111_560),
            (CollabDoc::Comment, 5357, 203_214_840),
            (CollabDoc::Comment, 1995, 103_288_200),
            (CollabDoc::Comment, 1796, 96_714_740),
            (CollabDoc::Comment, 1486, 91_613_340),
            (CollabDoc::Comment, 2936, 127_491_260),
            (CollabDoc::Comment, 2349, 113_656_880),
            (CollabDoc::Comment, 401, 58_625_380),
            (CollabDoc::Comment, 1610, 58_625_380),
            (CollabDoc::Comment, 1367, 84_708_880),
            (CollabDoc::Comment, 1155, 82_548_300),
            (CollabDoc::Comment, 1026, 78_135_800),
            (CollabDoc::Review, 4814, 165_590_500),
            (CollabDoc::Review, 1743, 165_590_500),
            (CollabDoc::Review, 1287, 60_499_720),
            (CollabDoc::Review, 4072, 136_509_040),
        ];
        let est: u64 = COLLAB
            .iter()
            .map(|&(kind, bytes, _)| collab_doc_credits(kind, bytes))
            .sum();
        let paid: u64 = COLLAB.iter().map(|&(_, _, paid)| paid).sum();
        #[allow(clippy::cast_precision_loss)] // the ratio for the assertion message only
        let ratio = est as f64 / paid as f64;
        assert!(
            est >= paid && est <= paid + paid * 15 / 100,
            "collab: estimate {est} vs paid {paid} ({ratio:.3})"
        );
    }

    /// The showcase merge repair on moutai beta.6 (2026-09-29, forge-import 01c87ca0, one
    /// identity per run, measured by balance drop): runs that wrote only merge events, and
    /// dashpay/dash's window (5 PRs, 103 comments, 64 reviews, 112 events). The estimates
    /// before this calibration were 0.91x, 0.91x and 0.95x the charge. Each estimate must
    /// cover its charge. Event documents: 120 bytes of properties.
    #[test]
    fn estimates_cover_the_beta6_merge_repair() {
        let event = collab_doc_credits(CollabDoc::Event, 120);
        for (events, paid) in [(129_u64, 7_536_815_200_u64), (29, 1_693_638_900)] {
            let est = event * events;
            assert!(
                est >= paid && est <= paid + paid * 15 / 100,
                "{events} events: estimate {est} vs paid {paid}"
            );
        }
        // dash: the old estimate 24,314,254,724 was priced at the old overheads (comment 52M,
        // review 45M, event 45M); the same writes at the current ones.
        let old = 24_314_254_724_u64;
        let est = old
            + 103 * (CollabDoc::Comment.index_overhead() - 52_000_000)
            + 64 * (CollabDoc::Review.index_overhead() - 45_000_000)
            + 112 * (CollabDoc::Event.index_overhead() - 45_000_000);
        let paid = 25_566_132_540_u64;
        assert!(
            est >= paid && est <= paid + paid * 15 / 100,
            "dash window: estimate {est} vs paid {paid}"
        );
    }
}
