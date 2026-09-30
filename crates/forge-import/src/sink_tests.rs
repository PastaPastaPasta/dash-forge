//! The sink against an offline, recorded chain ([`Recorded`]): the documents it writes are
//! kept in memory in landing order, as Platform would hold them, with the rules the pipeline
//! must keep enforced as it writes: dense numbers (`number == count + 1`), a comment, review,
//! event or transition only on an issue or PR that exists (`refersTo`), and a transition only
//! from the state its target is in (`c1`–`c6`). Every write takes a different simulated time,
//! so lanes overtake one another, and a write can "crash the process": it lands, but the
//! client never hears so, and nothing started after it lands.
//!
//! The tests run the real [`Sink`] (diff, resume, pipeline, budget) over it: a pipelined
//! import writes exactly what the sequential one does, each item's documents in the same
//! order; a run crashed mid-pipeline and run again ends with every document once; the spend
//! cap holds with writes in flight together.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;
use std::time::Duration;

use forge_core::collab::v2::{
    Created, ImportedRow, ImportedTarget, Provenance, Target, TargetKind,
};
use forge_core::collab::{CommentAnchor, Imported, Label, Release, ReleaseInput};
use forge_core::history::Freshness;
use forge_core::network::ForgeIds;
use forge_core::rules::v2::{TransitionMove, Visibility};
use forge_core::rules::{EventKind, MergeBaseTips};
use forge_core::scope::RepoRef;

use crate::budget::Budget;
use crate::chain::{Chain, Current, Written};
use crate::model::{SrcCollab, SrcComment, SrcPatch, SrcReview, SrcTarget};
use crate::pipeline::lock;
use crate::sink::{Ledger, Sink};

const SIGNER: &str = "mirror";
const START_BALANCE: u64 = 1_000_000_000_000_000;

/// One issue or PR on the recorded chain.
#[derive(Debug, Clone)]
struct Item {
    target: Target,
    url: String,
    upstream: u32,
    code: i64,
    labels: BTreeSet<String>,
    /// Its documents, in landing order: `c <url>`, `r <url>`, `e +label`, `t <kind>`.
    log: Vec<String>,
}

#[derive(Debug, Default)]
struct State {
    items: Vec<Item>,
    /// Writes begun, in order.
    begun: u64,
    /// The write that crashes the process: it lands, its caller hears an error, and no write
    /// begun after it lands.
    crash_at: Option<u64>,
    crashed: bool,
    /// Writes in flight now, and the most at once; creates in flight; per target.
    in_flight: usize,
    most: usize,
    creating: bool,
    busy_targets: BTreeSet<String>,
    balance: u64,
    /// A comment or review on a thread written while another of the same thread was in
    /// flight, or a transition refused: must never happen.
    violations: Vec<String>,
}

/// The recorded chain.
struct Recorded {
    state: Mutex<State>,
    /// What each write really costs, as a share of its estimate (percent).
    cost_pct: u64,
    /// Source URLs whose document the chain refuses for its content (before it lands).
    refuse: BTreeSet<String>,
}

impl Recorded {
    fn new() -> Self {
        Self {
            state: Mutex::new(State {
                balance: START_BALANCE,
                ..State::default()
            }),
            cost_pct: 100,
            refuse: BTreeSet::new(),
        }
    }

    fn st(&self) -> std::sync::MutexGuard<'_, State> {
        lock(&self.state)
    }

    /// One write on `target_id` (`None`: a create). Waits a simulated time that differs per
    /// write, then lands `apply` unless the process crashed before it began.
    async fn land<T>(
        &self,
        target_id: Option<&str>,
        apply: impl FnOnce(&mut State) -> forge_core::Result<T>,
    ) -> forge_core::Result<T> {
        let n = {
            let mut st = self.st();
            if st.crashed {
                return Err(forge_core::Error::Platform("connection lost".into()));
            }
            st.begun += 1;
            st.in_flight += 1;
            st.most = st.most.max(st.in_flight);
            match target_id {
                None => {
                    if std::mem::replace(&mut st.creating, true) {
                        st.violations.push("two creates in flight".into());
                    }
                }
                Some(id) => {
                    if !st.busy_targets.insert(id.to_string()) {
                        st.violations.push(format!("two writes in flight on {id}"));
                    }
                }
            }
            st.begun
        };
        // 20–240 ms, different for neighbouring writes.
        tokio::time::sleep(Duration::from_millis(20 + (n * 37 % 23) * 10)).await;
        let mut st = self.st();
        st.in_flight -= 1;
        match target_id {
            None => st.creating = false,
            Some(id) => {
                st.busy_targets.remove(id);
            }
        }
        // Landed: begun before the crash (the crashing write itself included).
        let out = apply(&mut st);
        if st.crash_at == Some(n) {
            st.crashed = true;
        }
        if st.crashed {
            return Err(forge_core::Error::Platform("connection lost".into()));
        }
        out
    }

    fn charge(&self, st: &mut State, estimate: u64) {
        st.balance = st.balance.saturating_sub(estimate * self.cost_pct / 100);
    }

    fn row(item: &Item) -> ImportedRow {
        ImportedRow {
            target: item.target.clone(),
            imported: Some(Imported {
                url: item.url.clone(),
                ..Imported::default()
            }),
            upstream_number: Some(item.upstream),
            base: None,
        }
    }

    fn item<'s>(st: &'s mut State, id: &str) -> &'s mut Item {
        st.items
            .iter_mut()
            .find(|i| i.target.id == id)
            .unwrap_or_else(|| panic!("refersTo: no issue or PR {id}"))
    }

    /// Every item's log, by upstream number, and the numbers they hold.
    fn logs(&self) -> BTreeMap<u32, (u32, Vec<String>)> {
        self.st()
            .items
            .iter()
            .map(|i| (i.upstream, (i.target.number, i.log.clone())))
            .collect()
    }
}

/// What the recorded chain debits for a document (scaled by `cost_pct`): a little under the
/// sink's estimate for its kind (`crate::budget::CollabDoc::index_overhead` alone is 90M for
/// an issue or PR and at least 50M for the rest), as on the real networks.
fn price(kind: &str) -> u64 {
    match kind {
        "target" => 80_000_000,
        _ => 45_000_000,
    }
}

// The reads answer at once; the trait is async for the network.
#[allow(clippy::unused_async_trait_impl)]
impl Chain for &Recorded {
    async fn upstream_targets(
        &self,
        _: &RepoRef,
        kind: TargetKind,
        n: u32,
    ) -> forge_core::Result<Vec<ImportedRow>> {
        Ok(self
            .st()
            .items
            .iter()
            .filter(|i| i.target.kind == kind && i.upstream == n)
            .map(Recorded::row)
            .collect())
    }

    async fn upstream_numbered(
        &self,
        _: &RepoRef,
        kind: TargetKind,
        all: bool,
    ) -> forge_core::Result<Vec<ImportedRow>> {
        let mut rows: Vec<ImportedRow> = self
            .st()
            .items
            .iter()
            .filter(|i| i.target.kind == kind)
            .map(Recorded::row)
            .collect();
        rows.sort_by_key(|r| std::cmp::Reverse(r.upstream_number));
        if !all {
            rows.truncate(100);
        }
        Ok(rows)
    }

    async fn imported_targets(&self, _: &RepoRef) -> forge_core::Result<Vec<ImportedRow>> {
        Ok(self.st().items.iter().map(Recorded::row).collect())
    }

    async fn current(&self, _: &RepoRef, target: &Target) -> forge_core::Result<Current> {
        let mut st = self.st();
        let item = Recorded::item(&mut st, &target.id);
        Ok(Current {
            code: item.code,
            labels: item.labels.clone(),
        })
    }

    async fn comments(&self, _: &RepoRef, id: &str) -> forge_core::Result<Vec<Written>> {
        let mut st = self.st();
        Ok(written(&Recorded::item(&mut st, id).log, "c "))
    }

    async fn reviews(&self, _: &RepoRef, id: &str) -> forge_core::Result<Vec<Written>> {
        let mut st = self.st();
        Ok(written(&Recorded::item(&mut st, id).log, "r "))
    }

    async fn members(&self, _: &RepoRef) -> forge_core::Result<BTreeSet<String>> {
        Ok(BTreeSet::new())
    }

    async fn labels(&self, _: &RepoRef) -> forge_core::Result<Vec<Label>> {
        Ok(Vec::new())
    }

    async fn releases(&self, _: &RepoRef) -> forge_core::Result<Vec<Release>> {
        Ok(Vec::new())
    }

    async fn merge_base(
        &self,
        _: &RepoRef,
        _: &str,
        _: u64,
        _: Freshness,
    ) -> forge_core::Result<MergeBaseTips> {
        Ok(MergeBaseTips::default())
    }

    fn refs_changed(&self) {}

    async fn balance(&self, _: &str) -> Option<u64> {
        Some(self.st().balance)
    }

    async fn create_imported(
        &self,
        _: &RepoRef,
        what: ImportedTarget<'_>,
        from: Provenance<'_>,
    ) -> forge_core::Result<Created> {
        let kind = match what {
            ImportedTarget::Issue { .. } => TargetKind::Issue,
            ImportedTarget::Patch(_) => TargetKind::Patch,
        };
        let url = from.imported.map(|i| i.url.clone()).unwrap_or_default();
        let upstream = from.upstream_number.unwrap_or_default();
        if self.refuse.contains(&url) {
            return Err(forge_core::Error::RuleRefused {
                document_type: kind.doc_type().into(),
                rule: "hasTitle".into(),
                detail: url,
            });
        }
        self.land(None, |st| {
            // dense: the count of issues and PRs, plus one
            let number = u32::try_from(st.items.len()).unwrap() + 1;
            let id = format!("doc-{number}");
            st.items.push(Item {
                target: Target {
                    kind,
                    id: id.clone(),
                    number,
                    author: SIGNER.into(),
                },
                url,
                upstream,
                code: 0,
                labels: BTreeSet::new(),
                log: Vec::new(),
            });
            self.charge(st, price("target"));
            Ok(Created {
                number,
                document_id: id,
                resumed: false,
                draft_transition: None,
            })
        })
        .await
    }

    async fn comment(
        &self,
        _: &RepoRef,
        target_id: &str,
        _: &str,
        _: Option<&CommentAnchor>,
        imported: &Imported,
    ) -> forge_core::Result<String> {
        self.append(target_id, format!("c {}", imported.url)).await
    }

    async fn review(
        &self,
        _: &RepoRef,
        patch_id: &str,
        _: &[u8],
        _: &str,
        imported: &Imported,
    ) -> forge_core::Result<String> {
        self.append(patch_id, format!("r {}", imported.url)).await
    }

    async fn post_event(
        &self,
        _: &RepoRef,
        target: &Target,
        kind: EventKind,
        value: &str,
    ) -> forge_core::Result<String> {
        let add = kind == EventKind::LabelAdd;
        let value = value.to_string();
        self.land(Some(&target.id), |st| {
            self.charge(st, price("doc"));
            let item = Recorded::item(st, &target.id);
            if add {
                item.labels.insert(value.clone());
            } else {
                item.labels.remove(&value);
            }
            item.log
                .push(format!("e {}{value}", if add { '+' } else { '-' }));
            Ok(format!("e-{}", item.log.len()))
        })
        .await
    }

    async fn write_transition(
        &self,
        _: &RepoRef,
        target: &Target,
        mv: &TransitionMove,
        _: Option<&[u8]>,
    ) -> forge_core::Result<String> {
        let mv = *mv;
        self.land(Some(&target.id), |st| {
            // c1–c6: a move from the state the target is in, and nowhere else.
            let code = Recorded::item(st, &target.id).code;
            if code + mv.delta != mv.after {
                let why = format!("kind {} from {code} on {}", mv.kind, target.id);
                st.violations.push(format!("refused transition {why}"));
                return Err(forge_core::Error::RuleRefused {
                    document_type: "transition".into(),
                    rule: "c1_closedAfter".into(),
                    detail: why,
                });
            }
            self.charge(st, price("doc"));
            let item = Recorded::item(st, &target.id);
            item.code = mv.after;
            item.log.push(format!("t {}", mv.kind));
            Ok(format!("t-{}", item.log.len()))
        })
        .await
    }

    async fn create_label(
        &self,
        _: &RepoRef,
        _: &str,
        _: &str,
        _: &str,
    ) -> forge_core::Result<String> {
        unreachable!("no label definitions in these tests")
    }

    async fn create_release(&self, _: &RepoRef, _: &ReleaseInput) -> forge_core::Result<String> {
        unreachable!("no releases in these tests")
    }

    async fn sync_sealed_releases(
        &self,
        _: &mut Ledger<'_>,
        _: &RepoRef,
        _: &[crate::model::SrcRelease],
        _: Option<&crate::sealed_release::ReleaseStorage>,
    ) -> anyhow::Result<()> {
        unreachable!("no releases in these tests")
    }
}

impl Recorded {
    async fn append(&self, target_id: &str, entry: String) -> forge_core::Result<String> {
        if self.refuse.contains(&entry[2..]) {
            return Err(forge_core::Error::Config("comment body too long".into()));
        }
        self.land(Some(target_id), |st| {
            self.charge(st, price("doc"));
            let item = Recorded::item(st, target_id);
            item.log.push(entry);
            Ok(format!("d-{}", item.log.len()))
        })
        .await
    }
}

fn written(log: &[String], prefix: &str) -> Vec<Written> {
    log.iter()
        .filter_map(|e| e.strip_prefix(prefix))
        .map(|url| Written {
            author: SIGNER.into(),
            url: Some(url.to_string()),
        })
        .collect()
}

fn repo() -> RepoRef {
    RepoRef {
        forge: ForgeIds::test_forge(),
        repo_id: "R".into(),
        owner_id: SIGNER.into(),
        name: "proj".into(),
        visibility: Visibility::Public,
    }
}

fn imported(path: &str) -> Imported {
    Imported {
        author: "gh-user".into(),
        created_at: 1,
        url: format!("https://github.com/o/r/{path}"),
    }
}

/// A source of `n` items numbered 1..=n like GitHub's (issues and PRs in one sequence), with
/// threads of different lengths, labels, and every state: open, closed, merged, draft.
fn source(n: u32) -> SrcCollab {
    let targets = (1..=n)
        .map(|number| {
            let pr = number % 3 != 0;
            let path = if pr { "pull" } else { "issues" };
            let comments = (0..(number * 7 % 6))
                .map(|k| SrcComment {
                    body: format!("comment {k}"),
                    imported: imported(&format!("{path}/{number}#issuecomment-{k}")),
                    anchor: None,
                })
                .collect();
            let reviews = if pr {
                (0..(number % 4))
                    .map(|k| SrcReview {
                        verdict: forge_core::collab::Verdict::Comment,
                        commit_oid: vec![1; 20],
                        body: format!("review {k}"),
                        imported: imported(&format!("pull/{number}#pullrequestreview-{k}")),
                    })
                    .collect()
            } else {
                Vec::new()
            };
            let labels = (0..(number % 3)).map(|k| format!("label-{k}")).collect();
            SrcTarget {
                kind: if pr {
                    TargetKind::Patch
                } else {
                    TargetKind::Issue
                },
                number,
                title: format!("item {number}"),
                body: "b".into(),
                imported: imported(&format!("{path}/{number}")),
                closed: number % 2 == 0,
                merged_oid: (pr && number % 4 == 0).then(|| vec![2; 20]),
                merged_without_sha: false,
                labels,
                draft: pr && number % 5 == 1,
                patch: pr.then(|| SrcPatch {
                    base_ref_name: "refs/heads/main".into(),
                    source_ref_name: None,
                    head_oid: vec![3; 20],
                }),
                comments,
                reviews,
            }
        })
        .collect();
    SrcCollab {
        targets,
        ..SrcCollab::default()
    }
}

/// What each item's log must be after a complete import: its comments and reviews in source
/// order, then its label events, then its transitions (L-46), each once.
fn expected(src: &SrcCollab) -> BTreeMap<u32, Vec<String>> {
    src.targets
        .iter()
        .map(|t| {
            let mut log: Vec<String> = t
                .comments
                .iter()
                .map(|c| format!("c {}", c.imported.url))
                .collect();
            log.extend(t.reviews.iter().map(|r| format!("r {}", r.imported.url)));
            log.extend(t.labels.iter().map(|l| format!("e +{l}")));
            let path = crate::sink::state_path(
                t.kind.transition_target(),
                0,
                crate::sink::wanted_code(t),
                t.number,
            );
            log.extend(path.iter().map(|mv| format!("t {}", mv.kind)));
            (t.number, log)
        })
        .collect()
}

struct Run {
    result: anyhow::Result<()>,
    counts: crate::summary::Counts,
    spent: u64,
    refused: BTreeSet<(u8, u32)>,
}

async fn import(chain: &Recorded, src: &SrcCollab, lanes: usize, cap: Option<u64>) -> Run {
    let mut budget = Budget::new(cap);
    budget.start(chain.st().balance);
    let sink = Sink::new(
        chain,
        Some(repo()),
        Ledger::detached(Some(SIGNER.into()), false, budget),
    )
    .with_lanes(lanes);
    let result = sink.sync(src).await;
    let ledger = sink.into_ledger();
    Run {
        result,
        counts: ledger.counts,
        spent: ledger.budget.spent(),
        refused: ledger.refused,
    }
}

async fn dry(chain: &Recorded, src: &SrcCollab, lanes: usize) -> crate::summary::Counts {
    let sink = Sink::new(
        chain,
        Some(repo()),
        Ledger::detached(Some(SIGNER.into()), true, Budget::new(None)),
    )
    .with_lanes(lanes);
    sink.sync(src).await.unwrap();
    sink.into_ledger().counts
}

fn docs(c: &crate::summary::Counts) -> u64 {
    c.issues + c.prs + c.comments + c.reviews + c.events + c.transitions
}

fn assert_complete(chain: &Recorded, src: &SrcCollab) {
    let want = expected(src);
    let got = chain.logs();
    assert_eq!(got.len(), want.len(), "every item once");
    for (upstream, (number, log)) in &got {
        // A fresh mirror of a source with no gaps numbers identically, in upstream order.
        assert_eq!(number, upstream, "dense numbers in upstream order");
        assert_eq!(log, &want[upstream], "item #{upstream}'s documents");
    }
    let st = chain.st();
    assert!(st.violations.is_empty(), "{:?}", st.violations);
}

/// A pipelined import writes exactly what a sequential one does: every item created in
/// upstream order at its number, each item's documents in the same order, the counts equal to
/// what landed, and the spend equal to the measured drop. And it really runs lanes at once.
#[tokio::test(start_paused = true)]
async fn a_pipelined_import_writes_what_a_sequential_one_does() {
    let src = source(40);
    let one = Recorded::new();
    let r1 = import(&one, &src, 1, None).await;
    r1.result.unwrap();
    assert_complete(&one, &src);
    assert!(one.st().most == 1, "one write at a time");

    let eight = Recorded::new();
    let t0 = tokio::time::Instant::now();
    let r8 = import(&eight, &src, 8, None).await;
    let pipelined = t0.elapsed();
    r8.result.unwrap();
    assert_complete(&eight, &src);
    assert_eq!(one.logs(), eight.logs());
    let most = eight.st().most;
    assert!((3..=9).contains(&most), "lanes plus the head: {most}");

    // The progress and summary counts are what landed, and the spend what was paid.
    assert_eq!(r8.counts, r1.counts);
    let landed: u64 = eight.logs().values().map(|(_, l)| l.len() as u64).sum();
    assert_eq!(docs(&r8.counts), landed + src.targets.len() as u64);
    // The spend reported: the estimates (the chain charged a little less), whatever the lanes.
    assert_eq!(r8.spent, r1.spent);
    assert!(r8.spent >= START_BALANCE - eight.st().balance);

    // Simulated time: the pipeline is several times faster.
    let t0 = tokio::time::Instant::now();
    let again = Recorded::new();
    import(&again, &src, 1, None).await.result.unwrap();
    let sequential = t0.elapsed();
    assert!(
        pipelined * 3 < sequential,
        "pipelined {pipelined:?} vs sequential {sequential:?}"
    );
}

/// A re-run over a complete mirror writes nothing, sequential or pipelined, and a dry run
/// prices the same at any lane count.
#[tokio::test(start_paused = true)]
async fn a_rerun_writes_nothing_and_dry_runs_agree() {
    let src = source(25);
    let chain = Recorded::new();
    let fresh_dry = dry(&chain, &src, 1).await;
    assert_eq!(dry(&chain, &src, 8).await, fresh_dry);
    let first = import(&chain, &src, 8, None).await;
    first.result.unwrap();
    assert_eq!(
        first.counts, fresh_dry,
        "the dry run priced exactly what was written"
    );
    let before = chain.logs();
    for lanes in [1, 8] {
        let again = import(&chain, &src, lanes, None).await;
        again.result.unwrap();
        assert_eq!(docs(&again.counts), 0);
        assert_eq!(again.spent, 0);
    }
    assert_eq!(chain.logs(), before);
    assert_eq!(docs(&dry(&chain, &src, 8).await), 0);
}

/// The process dies mid-pipeline (a write lands but its caller never hears; nothing begun
/// after it lands). Run again, incrementally (the order check must not refuse it) and
/// pipelined: every item and document ends up on chain exactly once, in order, and the
/// resumed run writes exactly what a dry run between the two said was left.
#[tokio::test(start_paused = true)]
async fn a_run_crashed_mid_pipeline_resumes_to_the_same_mirror() {
    let src = source(60);
    for crash_at in [1, 7, 60, 131, 190] {
        let chain = Recorded::new();
        chain.st().crash_at = Some(crash_at);
        let crashed = import(&chain, &src, 8, None).await;
        let err = crashed.result.unwrap_err();
        assert!(format!("{err:#}").contains("connection lost"), "{err:#}");
        let partial = chain.logs();
        assert!(
            partial.len() < src.targets.len(),
            "stopped early at {crash_at}"
        );
        // Created items are a prefix in upstream order, at dense numbers.
        for (n, (upstream, (number, _))) in (1u32..).zip(partial.iter()) {
            assert_eq!((*upstream, *number), (n, n));
        }
        {
            let mut st = chain.st();
            st.crashed = false;
            st.crash_at = None;
        }
        let left = dry(&chain, &src, 8).await;
        let resumed_src = SrcCollab {
            incremental: true,
            ..src.clone()
        };
        let resumed = import(&chain, &resumed_src, 8, None).await;
        resumed.result.unwrap();
        assert_eq!(
            resumed.counts, left,
            "resumed exactly what was left ({crash_at})"
        );
        assert_complete(&chain, &src);
    }
}

/// `--max-spend` with lanes in flight together: the run stops at the cap with the spend-cap
/// error, the measured drop never crosses the cap, every write it counted landed (in-flight
/// writes finish before it reports), and a re-run with a higher cap completes the mirror.
#[tokio::test(start_paused = true)]
async fn the_spend_cap_holds_with_lanes_in_flight() {
    let src = source(50);
    let chain = Recorded::new();
    let cap = 2_500_000_000;
    let capped = import(&chain, &src, 8, Some(cap)).await;
    let err = capped.result.unwrap_err();
    assert!(
        err.downcast_ref::<crate::budget::CapExceeded>().is_some(),
        "{err:#}"
    );
    let paid = START_BALANCE - chain.st().balance;
    assert!(paid <= cap, "paid {paid} over the cap {cap}");
    assert!(capped.spent <= cap);
    let landed: u64 = chain.logs().values().map(|(_, l)| l.len() as u64).sum();
    assert_eq!(
        docs(&capped.counts),
        landed + chain.logs().len() as u64,
        "the counts are what landed"
    );
    import(&chain, &src, 8, None).await.result.unwrap();
    assert_complete(&chain, &src);
}

/// Estimates that run low: the measured drop stops the run, pipelined too. What the lanes
/// already had in flight can take it past the cap by at most their own under-estimates.
#[tokio::test(start_paused = true)]
async fn a_low_estimate_is_caught_by_the_measured_drop_with_lanes() {
    let src = source(50);
    let mut chain = Recorded::new();
    chain.cost_pct = 150;
    let cap = 2_500_000_000;
    let capped = import(&chain, &src, 8, Some(cap)).await;
    assert!(capped.result.is_err());
    let paid = START_BALANCE - chain.st().balance;
    // Nine writes in flight at most (eight lanes and the head), each paid at most 1.5 times
    // what the chain prices it at (a create: 80M), over its estimate.
    let slack = 9 * 120_000_000;
    assert!(paid <= cap + slack, "paid {paid}, cap {cap}");
    assert!(capped.spent >= paid, "the ledger reports what was paid");
}

/// Items the destination refuses for their content are skipped, in the head (a create) and in
/// a lane (a comment), and the run carries on: the refused create takes no number (the next
/// item takes it), and an item whose comment was refused still gets its labels and state,
/// but nothing after the refused comment. Both are recorded refused, and the result is the
/// same at one lane and at eight.
#[tokio::test(start_paused = true)]
async fn refused_items_are_skipped_and_the_run_carries_on() {
    let src = source(30);
    let comment = src.targets[9].comments[1].imported.url.clone();
    let create = src.targets[19].imported.url.clone();
    let want = expected(&src);
    let mut results = Vec::new();
    for lanes in [1, 8] {
        let mut chain = Recorded::new();
        chain.refuse = [comment.clone(), create.clone()].into();
        let run = import(&chain, &src, lanes, None).await;
        run.result.unwrap();
        assert_eq!(run.counts.skipped, 2);
        let refused: Vec<u32> = run.refused.iter().map(|(_, n)| *n).collect();
        assert_eq!(refused, [10, 20]);
        let logs = chain.logs();
        assert!(
            !logs.contains_key(&20),
            "the refused create is not on chain"
        );
        for (upstream, (number, log)) in &logs {
            let n = if *upstream > 20 {
                upstream - 1
            } else {
                *upstream
            };
            assert_eq!(*number, n, "dense: #{upstream} takes the next number");
            if *upstream != 10 {
                assert_eq!(log, &want[upstream], "item #{upstream}");
            }
        }
        // #10: its first comment, then (past the refused one) its labels and state only.
        let mut ten = vec![want[&10][0].clone()];
        ten.extend(
            want[&10]
                .iter()
                .filter(|e| e.starts_with("e ") || e.starts_with("t "))
                .cloned(),
        );
        assert_eq!(logs[&10].1, ten);
        assert!(chain.st().violations.is_empty());
        results.push(logs);
    }
    assert_eq!(results[0], results[1]);
}
