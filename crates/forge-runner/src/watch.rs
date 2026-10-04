//! Finding work: which refs moved since the last poll.
//!
//! The runner lists the repo's refs (`git ls-remote dash://…`, which the helper answers from
//! Platform proofs) and compares them with the tips it saw last time, persisted per repo in
//! the state dir, so a restart re-runs nothing. The first poll of a repo only records the tips:
//! the runner reports pushes that happen while it watches, not the repository's history.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result};
use serde::{Deserialize, Serialize};

/// A ref and the commit it points at (hex, lowercase).
pub type Tips = BTreeMap<String, String>;

/// Parse `git ls-remote` output (`<oid>\t<ref>` lines): branches and tags, peeled tags as their
/// commit, `HEAD` and other symbolic lines dropped.
pub fn parse_ls_remote(out: &str) -> Tips {
    let mut tips = Tips::new();
    let mut peeled = Tips::new();
    for line in out.lines() {
        let Some((oid, name)) = line.split_once('\t') else {
            continue;
        };
        let oid = oid.trim().to_ascii_lowercase();
        if !(oid.len() == 40 || oid.len() == 64) || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        if let Some(tag) = name.strip_suffix("^{}") {
            peeled.insert(tag.to_string(), oid);
        } else if name.starts_with("refs/heads/") || name.starts_with("refs/tags/") {
            tips.insert(name.to_string(), oid);
        }
    }
    // An annotated tag runs on the commit it names.
    for (tag, commit) in peeled {
        if let Some(t) = tips.get_mut(&tag) {
            *t = commit;
        }
    }
    tips
}

/// The default branch `git ls-remote --symref` names (`ref: refs/heads/main\tHEAD`), and its tip
/// in `tips`.
pub fn default_branch(out: &str, tips: &Tips) -> Option<(String, String)> {
    out.lines()
        .filter_map(|l| l.strip_prefix("ref: ")?.split_once('\t'))
        .find(|(_, name)| *name == "HEAD")
        .and_then(|(target, _)| Some((target.to_string(), tips.get(target)?.clone())))
}

/// One ref that moved to a commit the runner has not run for that ref.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Push {
    /// `refs/heads/main`.
    pub refname: String,
    /// The new tip.
    pub oid: String,
    /// The previous tip, when there was one.
    pub before: Option<String>,
}

/// The pushes between `seen` and `now`: refs whose tip changed or that appeared. A deleted ref
/// runs nothing. Sorted by ref name.
pub fn pushes(seen: &Tips, now: &Tips) -> Vec<Push> {
    now.iter()
        .filter(|(r, oid)| seen.get(*r) != Some(*oid))
        .map(|(r, oid)| Push {
            refname: r.clone(),
            oid: oid.clone(),
            before: seen.get(r).cloned(),
        })
        .collect()
}

/// One pull request as `dg --json pr list` gives it.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PullRow {
    pub number: u64,
    #[serde(default)]
    pub title: String,
    /// The author's identity id.
    pub author: String,
    /// `open`, `closed` or `merged`.
    pub state: String,
    /// `refs/heads/main`: the base the PR was opened against.
    pub base_ref: String,
    /// The base a maintainer retargeted the PR to, if one did.
    #[serde(default)]
    pub retargeted_to: Option<String>,
    /// The base branch's tip, when `dg` could read it.
    #[serde(default)]
    pub base_tip: Option<String>,
    /// The head commit (hex).
    pub head_oid: String,
    /// The target repository's id.
    pub repo_id: String,
    /// The repository holding the head: the target itself, or a fork.
    pub source_repo_id: String,
    /// The head's branch there (`refs/heads/feature`); absent for an imported PR.
    #[serde(default)]
    pub source_ref_name: Option<String>,
    #[serde(default)]
    pub draft: bool,
}

impl PullRow {
    /// Whether the head lives in a fork (another repository).
    pub fn is_fork(&self) -> bool {
        self.source_repo_id != self.repo_id
    }

    /// The base the PR merges into now: where it was retargeted, else where it was opened.
    pub fn base(&self) -> &str {
        self.retargeted_to
            .as_deref()
            .filter(|b| !b.is_empty())
            .unwrap_or(&self.base_ref)
    }
}

/// What the runner remembers of a pull request.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PullSeen {
    /// The head it last handled.
    pub head: String,
    pub open: bool,
    pub draft: bool,
    /// Its author was a member when its activity was last judged: an open PR of a member is
    /// followed beyond the listing window and never forgotten while it is open.
    #[serde(default)]
    pub member: bool,
}

/// A pull request's activity that may run workflows: GitHub's `pull_request` action and the PR.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullEvent {
    /// `opened`, `synchronize`, `reopened` or `ready_for_review`.
    pub action: &'static str,
    /// The head before a `synchronize`.
    pub before: Option<String>,
    pub pr: PullRow,
}

/// The activity between what was `seen` and the pull requests listed `now` (open ones only; a
/// PR without a source branch, an imported one, never runs). Sorted by PR number.
pub fn pull_events(seen: &BTreeMap<u64, PullSeen>, now: &[PullRow]) -> Vec<PullEvent> {
    let mut out: Vec<PullEvent> = now
        .iter()
        .filter(|p| p.state == "open" && p.source_ref_name.is_some())
        .filter_map(|p| {
            let head = p.head_oid.to_ascii_lowercase();
            let (action, before) = match seen.get(&p.number) {
                None => ("opened", None),
                Some(s) if !s.open => ("reopened", None),
                Some(s) if s.head != head => ("synchronize", Some(s.head.clone())),
                Some(s) if s.draft && !p.draft => ("ready_for_review", None),
                Some(_) => return None,
            };
            let mut pr = p.clone();
            pr.head_oid = head;
            Some(PullEvent { action, before, pr })
        })
        .collect();
    out.sort_by_key(|e| e.pr.number);
    out
}

/// What the runner remembers per repo.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct RepoState {
    /// The tips the last poll saw (and handled).
    pub tips: Tips,
    /// Whether the first poll happened (its tips are recorded, not run).
    pub primed: bool,
    /// Pushes whose run could not start (a fetch or checkout error), keyed `<ref> <oid>`, with
    /// how many polls tried them.
    #[serde(default)]
    pub failed: std::collections::BTreeMap<String, u32>,
    /// The pull requests the last poll listed (and handled), by number.
    #[serde(default)]
    pub pulls: BTreeMap<u64, PullSeen>,
    /// Whether the pull requests were read once (that read is recorded, not run).
    #[serde(default)]
    pub pulls_primed: bool,
    /// The last PR number followed beyond the listing window: the next poll follows the ones
    /// after it, so every member's open PR is read in turn.
    #[serde(default)]
    pub followed_to: u64,
    /// CI re-run requests: the newest `$createdAt` handled (ms), and the requests handled at
    /// exactly that time. `None` until the first poll, which records the runner's clock and runs
    /// nothing older.
    #[serde(default)]
    pub reruns_since: Option<u64>,
    #[serde(default)]
    pub reruns_seen: std::collections::BTreeSet<String>,
    /// `schedule`: when the last poll judged the cron expressions (ms, the runner's clock).
    /// `None` until the first poll with `schedule = true`, which runs nothing.
    #[serde(default)]
    pub schedule_since: Option<u64>,
    /// The default branch's tip whose expressions [`Self::schedule_crons`] holds.
    #[serde(default)]
    pub schedule_tip: Option<String>,
    /// That tip's valid `on.schedule` expressions, each with the workflow file listing it.
    #[serde(default)]
    pub schedule_crons: Vec<(String, String)>,
}

impl RepoState {
    /// Record what `row` is now; `member` says whether its author is a member, when the poll
    /// knows (else what was known stays).
    pub fn saw_pull(&mut self, row: &PullRow, member: Option<bool>) {
        let known = self.pulls.get(&row.number).is_some_and(|s| s.member);
        self.pulls.insert(
            row.number,
            PullSeen {
                head: row.head_oid.to_ascii_lowercase(),
                open: row.state == "open",
                draft: row.draft,
                member: member.unwrap_or(known),
            },
        );
    }

    /// Record re-run request `id` (written at `created_at`) as handled: the cursor moves to the
    /// newest time handled, and remembers the ids handled at that time.
    pub fn handled_rerun(&mut self, id: &str, created_at: u64) {
        match self.reruns_since {
            Some(t) if created_at < t => {}
            Some(t) if created_at == t => {
                self.reruns_seen.insert(id.to_string());
            }
            _ => {
                self.reruns_since = Some(created_at);
                self.reruns_seen = std::collections::BTreeSet::from([id.to_string()]);
            }
        }
    }

    /// The members' open PRs the listing did not include, at most `max`, taken in turn after
    /// [`Self::followed_to`] (which this advances).
    pub fn next_to_follow(&mut self, listed: &[PullRow], max: usize) -> Vec<u64> {
        let beyond: Vec<u64> = self
            .pulls
            .iter()
            .filter(|(n, s)| s.open && s.member && !listed.iter().any(|r| r.number == **n))
            .map(|(n, _)| *n)
            .collect();
        let start = beyond.partition_point(|n| *n <= self.followed_to);
        let picked: Vec<u64> = beyond[start..]
            .iter()
            .chain(&beyond[..start])
            .take(max)
            .copied()
            .collect();
        if let Some(last) = picked.last() {
            self.followed_to = *last;
        }
        picked
    }
}

/// `<state_dir>/repos/<owner>__<name>.json`.
pub fn state_path(state_dir: &Path, repo: &str) -> PathBuf {
    state_dir
        .join("repos")
        .join(format!("{}.json", repo.replace('/', "__")))
}

impl RepoState {
    /// Load, or a fresh state when there is none yet.
    pub fn load(path: &Path) -> Result<Self> {
        match std::fs::read_to_string(path) {
            Ok(t) => {
                serde_json::from_str(&t).with_context(|| format!("reading {}", path.display()))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
        }
    }

    /// Save atomically (write a sibling, then rename).
    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const C: &str = "cccccccccccccccccccccccccccccccccccccccc";

    #[test]
    fn the_default_branch_is_heads_symref() {
        let out = format!(
            "ref: refs/heads/trunk\tHEAD\n{A}\tHEAD\n{A}\trefs/heads/trunk\n{B}\trefs/heads/main\n"
        );
        let tips = parse_ls_remote(&out);
        assert_eq!(
            default_branch(&out, &tips),
            Some(("refs/heads/trunk".to_string(), A.to_string()))
        );
        assert_eq!(
            default_branch(&format!("{A}\tHEAD\n"), &tips),
            None,
            "no symref"
        );
        assert_eq!(
            default_branch("ref: refs/heads/gone\tHEAD\n", &tips),
            None,
            "a default branch with no tip"
        );
    }

    #[test]
    fn ls_remote_keeps_branches_and_tags_and_peels_tags() {
        let out = format!(
            "{A}\tHEAD\n{A}\trefs/heads/main\n{B}\trefs/tags/v1\n{C}\trefs/tags/v1^{{}}\nzz\trefs/heads/bad\n{A}\trefs/pull/1/head\n"
        );
        let t = parse_ls_remote(&out);
        assert_eq!(t.len(), 2, "{t:?}");
        assert_eq!(t["refs/heads/main"], A);
        assert_eq!(t["refs/tags/v1"], C, "an annotated tag runs on its commit");
    }

    #[test]
    fn only_moved_or_new_refs_run() {
        let seen = Tips::from([
            ("refs/heads/main".into(), A.into()),
            ("refs/heads/old".into(), A.into()),
        ]);
        let now = Tips::from([
            ("refs/heads/main".into(), B.into()),
            ("refs/heads/new".into(), C.into()),
        ]);
        let p = pushes(&seen, &now);
        assert_eq!(
            p,
            [
                Push {
                    refname: "refs/heads/main".into(),
                    oid: B.into(),
                    before: Some(A.into())
                },
                Push {
                    refname: "refs/heads/new".into(),
                    oid: C.into(),
                    before: None
                },
            ]
        );
        assert!(pushes(&now, &now).is_empty());
    }

    fn row(n: u64, state: &str, head: &str, draft: bool) -> PullRow {
        PullRow {
            number: n,
            title: format!("pr {n}"),
            author: "AUTHOR".into(),
            state: state.into(),
            base_ref: "refs/heads/main".into(),
            retargeted_to: None,
            base_tip: None,
            head_oid: head.into(),
            repo_id: "REPO".into(),
            source_repo_id: "REPO".into(),
            source_ref_name: Some("refs/heads/feat".into()),
            draft,
        }
    }

    #[test]
    fn pull_activity_is_opened_synchronize_reopened_or_ready() {
        let at_a = |open, draft| PullSeen {
            head: A.into(),
            open,
            draft,
            member: false,
        };
        let seen = BTreeMap::from([
            (1, at_a(true, false)),
            (2, at_a(false, false)),
            (3, at_a(true, true)),
            (4, at_a(true, false)),
        ]);
        let mut imported = row(6, "open", C, false);
        imported.source_ref_name = None;
        let now = [
            row(1, "open", &B.to_ascii_uppercase(), false),
            row(2, "open", A, false),
            row(3, "open", A, false),
            row(4, "open", A, false),
            row(5, "open", C, true),
            imported,
            row(7, "closed", C, false),
        ];
        let got: Vec<(u64, &str, Option<String>)> = pull_events(&seen, &now)
            .into_iter()
            .map(|e| (e.pr.number, e.action, e.before))
            .collect();
        assert_eq!(
            got,
            [
                (1, "synchronize", Some(A.to_string())),
                (2, "reopened", None),
                (3, "ready_for_review", None),
                (5, "opened", None),
            ],
            "an unchanged PR, an imported one and a closed one run nothing"
        );
        assert_eq!(
            pull_events(&seen, &now)[0].pr.head_oid,
            B,
            "heads are lowercased"
        );
        let mut fork = row(8, "open", C, false);
        assert!(!fork.is_fork());
        fork.source_repo_id = "FORK".into();
        assert!(fork.is_fork());
    }

    #[test]
    fn members_open_prs_beyond_the_window_are_followed_in_turn() {
        let mut s = RepoState::default();
        for n in 1..=5 {
            s.saw_pull(&row(n, "open", A, false), Some(n != 3));
        }
        s.saw_pull(&row(6, "closed", A, false), Some(true));
        // A later sighting that does not know the author keeps what was known.
        s.saw_pull(&row(1, "open", B, false), None);
        assert!(s.pulls[&1].member);
        let listed = [row(5, "open", A, false)];
        assert_eq!(
            s.next_to_follow(&listed, 2),
            [1, 2],
            "members' open PRs not listed; not #3"
        );
        assert_eq!(s.next_to_follow(&listed, 2), [4, 1], "in turn, wrapping");
        assert_eq!(s.next_to_follow(&listed, 9), [2, 4, 1]);
        assert!(s.next_to_follow(&[], 0).is_empty());
    }

    #[test]
    fn the_rerun_cursor_keeps_the_ids_at_its_time() {
        let mut s = RepoState {
            reruns_since: Some(100),
            ..RepoState::default()
        };
        s.handled_rerun("a", 100);
        s.handled_rerun("b", 100);
        assert_eq!(s.reruns_seen.len(), 2);
        s.handled_rerun("old", 50);
        assert_eq!(
            s.reruns_since,
            Some(100),
            "an older request never moves it back"
        );
        s.handled_rerun("c", 120);
        assert_eq!(s.reruns_since, Some(120));
        assert_eq!(s.reruns_seen.iter().collect::<Vec<_>>(), ["c"]);
        let back: RepoState = serde_json::from_str("{\"tips\":{},\"primed\":true}").unwrap();
        assert!(
            back.reruns_since.is_none(),
            "a state from before re-runs primes afresh"
        );
    }

    #[test]
    fn state_round_trips() {
        let d = tempfile::tempdir().unwrap();
        let p = state_path(d.path(), "alice/project");
        assert!(p.ends_with("repos/alice__project.json"));
        let s = RepoState::load(&p).unwrap();
        assert!(!s.primed && s.tips.is_empty());
        let s = RepoState {
            tips: Tips::from([("refs/heads/main".into(), A.into())]),
            primed: true,
            ..RepoState::default()
        };
        s.save(&p).unwrap();
        let back = RepoState::load(&p).unwrap();
        assert!(back.primed);
        assert_eq!(back.tips, s.tips);
    }
}
