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
use forge_core::rules::v2::{CloseReason, ClosedAs, TransitionMove, Visibility};
use forge_core::rules::{EventKind, MergeBaseTips};
use forge_core::scope::RepoRef;

use crate::budget::Budget;
use crate::chain::{Chain, Current, Written};
use crate::model::{SrcCloseReason, SrcCollab, SrcComment, SrcPatch, SrcReview, SrcTarget};
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
    /// The destination's live releases (a public repository's), and every release input
    /// written, in order.
    releases: Vec<Release>,
    release_inputs: Vec<ReleaseInput>,
    /// Each comment's `replyTo` and `reviewId` as written (document ids), by source URL, and
    /// each review's `commentCount`.
    links: BTreeMap<String, (Option<String>, Option<String>)>,
    counts: BTreeMap<String, Option<u16>>,
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
        Ok(written(id, &Recorded::item(&mut st, id).log, "c "))
    }

    async fn reviews(&self, _: &RepoRef, id: &str) -> forge_core::Result<Vec<Written>> {
        let mut st = self.st();
        Ok(written(id, &Recorded::item(&mut st, id).log, "r "))
    }

    async fn members(&self, _: &RepoRef) -> forge_core::Result<BTreeSet<String>> {
        Ok(BTreeSet::new())
    }

    async fn labels(&self, _: &RepoRef) -> forge_core::Result<Vec<Label>> {
        Ok(Vec::new())
    }

    async fn releases(&self, _: &RepoRef) -> forge_core::Result<Vec<Release>> {
        Ok(self.st().releases.clone())
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
        anchor: Option<&CommentAnchor>,
        imported: &Imported,
    ) -> forge_core::Result<String> {
        let links = anchor.map_or((None, None), |a| (a.reply_to.clone(), a.review_id.clone()));
        let id = self
            .append(target_id, format!("c {}", imported.url))
            .await?;
        self.st().links.insert(imported.url.clone(), links);
        Ok(id)
    }

    async fn review(
        &self,
        _: &RepoRef,
        patch_id: &str,
        _: &[u8],
        _: &str,
        comment_count: Option<u16>,
        imported: &Imported,
    ) -> forge_core::Result<String> {
        let id = self.append(patch_id, format!("r {}", imported.url)).await?;
        self.st().counts.insert(imported.url.clone(), comment_count);
        Ok(id)
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
        closed: Option<&ClosedAs>,
    ) -> forge_core::Result<String> {
        let mv = *mv;
        let why = closed.map_or(String::new(), |c| {
            format!(
                " as {}{}",
                c.reason.as_str(),
                c.duplicate_of
                    .map(|n| format!(" of #{n}"))
                    .unwrap_or_default()
            )
        });
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
            item.log.push(format!("t {}{why}", mv.kind));
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

    /// A public release: the newest revision of a tag replaces the last, as readers fold them.
    async fn create_release(
        &self,
        _: &RepoRef,
        input: &ReleaseInput,
    ) -> forge_core::Result<String> {
        let mut st = self.st();
        st.release_inputs.push(input.clone());
        st.releases.retain(|r| r.tag_name != input.tag_name);
        let document_id = format!("release-{}", st.release_inputs.len());
        st.releases.push(Release {
            document_id: document_id.clone(),
            tag_name: input.tag_name.clone(),
            name: input.name.clone(),
            notes: input.notes.clone(),
            yanked: false,
            assets: input.assets.clone(),
            publisher: SIGNER.into(),
            created_at: 1,
            delta: 0,
            sealed: None,
        });
        Ok(document_id)
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
            Ok(doc_id(target_id, item.log.len() - 1))
        })
        .await
    }
}

/// The `$id` of the `n`th document (from 0) logged on `target_id`.
fn doc_id(target_id: &str, n: usize) -> String {
    format!("{target_id}/d-{n}")
}

fn written(target_id: &str, log: &[String], prefix: &str) -> Vec<Written> {
    log.iter()
        .enumerate()
        .filter_map(|(n, e)| Some((n, e.strip_prefix(prefix)?)))
        .map(|(n, url)| Written {
            id: doc_id(target_id, n),
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
                    reply_key: None,
                    review_key: None,
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
                close_reason: None,
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

fn sink(chain: &Recorded, dry_run: bool, budget: Budget, lanes: usize) -> Sink<'_, &Recorded> {
    Sink::new(
        chain,
        Some(repo()),
        Ledger::detached(Some(SIGNER.into()), dry_run, budget),
    )
    .with_lanes(lanes)
}

async fn import(chain: &Recorded, src: &SrcCollab, lanes: usize, cap: Option<u64>) -> Run {
    let mut budget = Budget::new(cap);
    budget.start(chain.st().balance);
    let sink = sink(chain, false, budget, lanes);
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
    let sink = sink(chain, true, Budget::new(None), lanes);
    sink.sync(src).await.unwrap();
    sink.into_ledger().counts
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
    assert_eq!(
        r8.counts.item_documents(),
        landed + src.targets.len() as u64
    );
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
        assert_eq!(again.counts.item_documents(), 0);
        assert_eq!(again.spent, 0);
    }
    assert_eq!(chain.logs(), before);
    assert_eq!(dry(&chain, &src, 8).await.item_documents(), 0);
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

/// An item mirrored without a part GitHub refused to list (dashpay/dash#6498's reviews) is
/// still an item on chain: a later incremental run, with the part still refused or readable
/// again, passes the order check (it concerns missing items, not missing parts), writes
/// nothing else, and adds just what was left out.
#[tokio::test(start_paused = true)]
async fn an_item_mirrored_without_its_reviews_does_not_stop_a_later_run() {
    let src = source(12);
    let mut partial = src.clone();
    let pr = partial.targets.iter_mut().find(|t| t.number == 7).unwrap();
    let left_out = std::mem::take(&mut pr.reviews).len() as u64;
    let pr = partial.targets.iter_mut().find(|t| t.number == 2).unwrap();
    let left_out = left_out + std::mem::take(&mut pr.reviews).len() as u64;
    assert!(left_out > 0);
    partial.incomplete = true;

    let chain = Recorded::new();
    import(&chain, &partial, 8, None).await.result.unwrap();
    let incremental = |s: &SrcCollab| SrcCollab {
        incremental: true,
        ..s.clone()
    };
    let still = import(&chain, &incremental(&partial), 8, None).await;
    still.result.unwrap();
    assert_eq!(still.counts.item_documents(), 0, "the partial item alone");

    let readable = import(&chain, &incremental(&src), 8, None).await;
    readable.result.unwrap();
    assert_eq!(readable.counts.reviews, left_out);
    assert_eq!(
        readable.counts.item_documents(),
        left_out,
        "only the reviews"
    );
    let logs = chain.logs();
    for n in [2, 7] {
        let want = &expected(&src)[&n];
        let (number, got) = &logs[&n];
        assert_eq!(*number, n, "still at its number");
        let mut got = got.clone();
        let mut want = want.clone();
        got.sort();
        want.sort();
        assert_eq!(got, want, "#{n} now has everything");
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
        capped.counts.item_documents(),
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

/// A public release whose notes were emptied at the source is written again with no notes (a
/// public revision states its notes afresh), and a release with no notes on either side is
/// left alone.
#[tokio::test(start_paused = true)]
async fn a_public_release_whose_notes_were_emptied_is_written_again_without_them() {
    let release = |notes: &str| crate::model::SrcRelease {
        tag_name: "v1".into(),
        name: "One".into(),
        notes: notes.into(),
        assets: Vec::new(),
        omitted: Vec::new(),
        source_url: String::new(),
        published: None,
    };
    let with = |notes: &str| SrcCollab {
        releases: Some(vec![release(notes)]),
        ..SrcCollab::default()
    };
    let chain = Recorded::new();
    import(&chain, &with("the notes"), 1, None)
        .await
        .result
        .unwrap();
    assert_eq!(chain.st().releases[0].notes, "the notes");

    let emptied = import(&chain, &with(""), 1, None).await;
    emptied.result.unwrap();
    assert_eq!(emptied.counts.releases, 1, "a new revision");
    assert_eq!(chain.st().releases[0].notes, "", "cleared");

    let again = import(&chain, &with(""), 1, None).await;
    again.result.unwrap();
    assert_eq!(again.counts.releases, 0, "stable once empty on both sides");
    assert_eq!(chain.st().release_inputs.len(), 2);
}

/// A PR's mirrored review thread (QW2-010): each review lands just before its first comment
/// and announces how many name it; a comment names its review (`reviewId`) and a reply its
/// root (`replyTo`), by the ids they landed at, across runs too.
#[tokio::test(start_paused = true)]
async fn review_comments_name_their_review_and_their_root() {
    let at = |path: &str, t: u64| Imported {
        created_at: t,
        ..imported(path)
    };
    let line = |k: &str, t: u64, review: &str, reply: Option<&str>| SrcComment {
        body: format!("line comment {k}"),
        imported: at(&format!("pull/1#discussion_r{k}"), t),
        anchor: Some(CommentAnchor {
            path: Some("a.rs".into()),
            line: Some(3),
            side: Some(1),
            diff_hunk: Some("@@ -1,3 +1,3 @@\n a\n b\n+c".into()),
            ..CommentAnchor::default()
        }),
        reply_key: reply.map(|r| format!("https://github.com/o/r/pull/1#discussion_r{r}")),
        review_key: Some(format!(
            "https://github.com/o/r/pull/1#pullrequestreview-{review}"
        )),
    };
    let review = |k: &str, t: u64| SrcReview {
        verdict: forge_core::collab::Verdict::Comment,
        commit_oid: vec![1; 20],
        body: format!("review {k}"),
        imported: at(&format!("pull/1#pullrequestreview-{k}"), t),
    };
    let mut src = source(1);
    let pr = &mut src.targets[0];
    assert_eq!(pr.kind, TargetKind::Patch);
    pr.comments = vec![line("10", 5, "100", None)];
    // the review was submitted after its pending comment; a later one has none
    pr.reviews = vec![review("100", 9), review("200", 20)];
    let chain = Recorded::new();
    import(&chain, &src, 4, None).await.result.unwrap();
    // a later run brings a reply (in its own one-comment review, as GitHub files it)
    let pr = &mut src.targets[0];
    pr.comments.push(line("11", 30, "300", Some("10")));
    pr.reviews.push(review("300", 31));
    import(&chain, &src, 4, None).await.result.unwrap();

    let (_, log) = chain.logs()[&1].clone();
    let docs: Vec<&str> = log
        .iter()
        .map(String::as_str)
        .filter(|e| e.starts_with("c ") || e.starts_with("r "))
        .collect();
    assert_eq!(
        docs,
        [
            "r https://github.com/o/r/pull/1#pullrequestreview-100",
            "c https://github.com/o/r/pull/1#discussion_r10",
            "r https://github.com/o/r/pull/1#pullrequestreview-200",
            "r https://github.com/o/r/pull/1#pullrequestreview-300",
            "c https://github.com/o/r/pull/1#discussion_r11",
        ]
    );
    let id = |n: usize| Some(doc_id("doc-1", n));
    let st = chain.st();
    let url = |k: &str| format!("https://github.com/o/r/pull/1#{k}");
    assert_eq!(st.links[&url("discussion_r10")], (None, id(0)));
    // the first run's thread, its label and draft transition, then the second run's
    assert_eq!(log.len(), 7, "{log:?}");
    assert_eq!(st.links[&url("discussion_r11")], (id(1), id(5)));
    assert_eq!(st.counts[&url("pullrequestreview-100")], Some(1));
    assert_eq!(st.counts[&url("pullrequestreview-200")], None);
    assert!(st.violations.is_empty(), "{:?}", st.violations);
}

/// An issue closed as a duplicate (QW-069) names its canonical by the mirror's number, which
/// may differ from the source's; one whose canonical is not mirrored is a duplicate of nothing.
#[tokio::test(start_paused = true)]
async fn a_duplicate_names_its_canonical_by_its_mirror_number() {
    let mut src = source(6);
    // #3 and #6 are issues (every third item); #6 duplicates #3, #3 duplicates #99 (unmirrored)
    let dup = |n: u32| SrcCloseReason {
        reason: CloseReason::Duplicate,
        duplicate_of: Some((n, format!("https://github.com/o/r/issues/{n}"))),
    };
    for t in &mut src.targets {
        match t.number {
            3 => (t.closed, t.close_reason) = (true, Some(dup(99))),
            6 => t.close_reason = Some(dup(3)),
            _ => {}
        }
    }
    // the mirror numbers from 2 on: #1 lands elsewhere first
    let chain = Recorded::new();
    chain.st().items.push(Item {
        target: Target {
            kind: TargetKind::Issue,
            id: "squat".into(),
            number: 1,
            author: "someone".into(),
        },
        url: String::new(),
        upstream: 0,
        code: 0,
        labels: BTreeSet::new(),
        log: Vec::new(),
    });
    import(&chain, &src, 4, None).await.result.unwrap();
    let mirrored = chain.logs();
    let (n3, three) = &mirrored[&3];
    let (n6, six) = &mirrored[&6];
    assert_eq!(*n3, 4, "numbers moved up by one");
    assert!(three.contains(&"t 1 as duplicate".to_string()), "{three:?}");
    assert!(
        six.contains(&format!("t 1 as duplicate of #{n3}")),
        "{six:?} (#6 is #{n6})"
    );
}

/// Plain open issues numbered `numbers`, as GitHub would list them; `closes` closes some as
/// duplicates: `(issue, Some(canonical))` of an issue of this repository, `(issue, None)` of
/// one of another repository (GitHub names no same-repository canonical then).
fn issues(numbers: impl IntoIterator<Item = u32>, closes: &[(u32, Option<u32>)]) -> SrcCollab {
    let targets = numbers
        .into_iter()
        .map(|number| {
            let close = closes.iter().find(|(n, _)| *n == number);
            SrcTarget {
                kind: TargetKind::Issue,
                number,
                title: format!("issue {number}"),
                body: "b".into(),
                imported: imported(&format!("issues/{number}")),
                closed: close.is_some(),
                close_reason: close.map(|(_, of)| SrcCloseReason {
                    reason: CloseReason::Duplicate,
                    duplicate_of: of.map(|n| (n, format!("https://github.com/o/r/issues/{n}"))),
                }),
                merged_oid: None,
                merged_without_sha: false,
                labels: BTreeSet::new(),
                draft: false,
                patch: None,
                comments: Vec::new(),
                reviews: Vec::new(),
            }
        })
        .collect();
    SrcCollab {
        targets,
        ..SrcCollab::default()
    }
}

/// A recorded chain whose mirror numbers start at 2 (#1 is a stranger's), so a canonical's
/// mirror number differs from its source number.
fn shifted() -> Recorded {
    let chain = Recorded::new();
    chain.st().items.push(Item {
        target: Target {
            kind: TargetKind::Issue,
            id: "squat".into(),
            number: 1,
            author: "someone".into(),
        },
        url: String::new(),
        upstream: 0,
        code: 0,
        labels: BTreeSet::new(),
        log: Vec::new(),
    });
    chain
}

/// The spend a dry run prices for `src` over `chain`.
async fn dry_spend(
    chain: &Recorded,
    src: &SrcCollab,
    lanes: usize,
) -> (u64, crate::summary::Counts) {
    let sink = sink(chain, true, Budget::new(None), lanes);
    sink.sync(src).await.unwrap();
    let ledger = sink.into_ledger();
    (ledger.budget.spent(), ledger.counts)
}

/// QW-069: on a first import a duplicate whose canonical is numbered after it still names it.
/// Its close waits until every item is placed, then is written once with the canonical's
/// mirror number; one of a lower-numbered canonical names it at once; one whose canonical never
/// appears, or is in another repository, is a duplicate of nothing, also once. Sequential or
/// pipelined alike, and the dry run prices exactly what lands.
#[tokio::test(start_paused = true)]
async fn a_duplicate_of_a_later_issue_names_it_on_a_first_import() {
    // #2 duplicates #5 (later); #6 duplicates #3 (earlier); #4 duplicates #99 (never mirrored);
    // #7 duplicates an issue of another repository.
    let src = issues(
        1..=8,
        &[(2, Some(5)), (6, Some(3)), (4, Some(99)), (7, None)],
    );
    for lanes in [1, 8] {
        let (priced, priced_counts) = dry_spend(&shifted(), &src, lanes).await;
        let chain = shifted();
        let run = import(&chain, &src, lanes, None).await;
        run.result.unwrap();
        let logs = chain.logs();
        let n = |upstream: u32| logs[&upstream].0;
        assert_eq!(n(5), 6, "numbers moved up by one");
        assert_eq!(
            logs[&2].1,
            [format!("t 1 as duplicate of #{}", n(5))],
            "lanes {lanes}"
        );
        assert_eq!(
            logs[&6].1,
            [format!("t 1 as duplicate of #{}", n(3))],
            "lanes {lanes}"
        );
        assert_eq!(logs[&4].1, ["t 1 as duplicate"], "lanes {lanes}");
        assert_eq!(logs[&7].1, ["t 1 as duplicate"], "lanes {lanes}");
        for open in [1, 3, 5, 8] {
            assert!(logs[&open].1.is_empty(), "#{open} stays open");
        }
        assert_eq!(run.counts.transitions, 4, "each close once");
        assert_eq!(
            run.counts, priced_counts,
            "the dry run counts the deferred close once"
        );
        assert_eq!(run.spent, priced, "and prices it with its dupNumber");
        let violations = chain.st().violations.clone();
        assert!(violations.is_empty(), "{violations:?}");

        // A re-run writes nothing: a close is immutable, never written twice.
        let again = import(&chain, &src, lanes, None).await;
        again.result.unwrap();
        assert_eq!(again.counts.item_documents(), 0);
        assert_eq!(chain.logs(), logs);
    }
}

/// A canonical numbered after its duplicate that the destination refuses (so it is never
/// placed): the duplicate still closes, once, as a duplicate of nothing.
#[tokio::test(start_paused = true)]
async fn a_duplicate_whose_later_canonical_is_refused_closes_without_it() {
    let src = issues(1..=5, &[(2, Some(5))]);
    let mut chain = shifted();
    chain
        .refuse
        .insert("https://github.com/o/r/issues/5".into());
    let run = import(&chain, &src, 4, None).await;
    run.result.unwrap();
    let logs = chain.logs();
    assert!(!logs.contains_key(&5), "#5 refused");
    assert_eq!(logs[&2].1, ["t 1 as duplicate"]);
    assert_eq!(run.counts.transitions, 1);
}

/// An incremental run whose canonical is already mirrored names it at once; one that brings a
/// new duplicate of a new later issue defers it to the end of the run as a first import does.
#[tokio::test(start_paused = true)]
async fn an_incremental_duplicate_names_a_canonical_already_mirrored() {
    let chain = shifted();
    import(&chain, &issues(1..=5, &[]), 4, None)
        .await
        .result
        .unwrap();
    // #2 is now closed as a duplicate of #5 (mirrored); new #7 duplicates new #8.
    let mut src = issues([2, 6, 7, 8], &[(2, Some(5)), (7, Some(8))]);
    src.incremental = true;
    for lanes in [1, 4] {
        let run = import(&chain, &src, lanes, None).await;
        run.result.unwrap();
        let logs = chain.logs();
        assert_eq!(logs[&2].1, [format!("t 1 as duplicate of #{}", logs[&5].0)]);
        assert_eq!(logs[&7].1, [format!("t 1 as duplicate of #{}", logs[&8].0)]);
        let want = if lanes == 1 { 2 } else { 0 };
        assert_eq!(
            run.counts.transitions, want,
            "each close once, over both runs"
        );
        let st = chain.st();
        assert!(st.violations.is_empty(), "{:?}", st.violations);
    }
}
