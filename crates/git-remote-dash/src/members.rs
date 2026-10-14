//! Members-only branches of a public repository, the helper's side (mixed-visibility DESIGN
//! §4.3, D12, D21, D22; `docs/security/private-repos.md` §19.5–§19.6).
//!
//! * [`GitGraph`]: the object graph the publication guard asks, backed by `git` with replace refs
//!   and grafts off;
//! * [`decide`]: a new branch's audience (D12): local intent, the push option, inheritance, the
//!   clone's default, else E811 once per clone;
//! * the guard's refusals: E805 (a push would publish members-only commits) and E806 (it cannot
//!   tell);
//! * the ledger writes of a members-only fetch or push, and the public tips the `pre-push` hook
//!   checks against;
//! * the `pre-push` hook ([`pre_push`], E810), its install on the first members-only fetch, and the
//!   refusal to fetch members-only branches through a helper that is not the one on `PATH`;
//! * grafts over a merge whose members-only parent this clone cannot read, written inside `fetch`
//!   ([`graft_missing_parents`]), and the commit-graph a clone writes for the guard.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context as _, Result};
use forge_core::members_git::guard::{self, Finding, FindingKind, GuardInput, ObjectGraph};
use forge_core::members_git::guard::{
    Gitlink, GitlinkNote, ObjectType, Outcome, Peeled, Remade, Verdict,
};
use forge_core::members_git::ledger::{self, Entry, EntryAudience, EntryKind};
use forge_core::members_git::plan::BatchRef;
use forge_core::members_git::{hook, Audience};
use forge_core::user_error::{codes, UserError};

use crate::git::{config_get, git_read_in, LocalRepo};

/// `git push -o members`: a new branch is members-only.
pub const OPTION_MEMBERS: &str = "members";
/// `git push -o public`: a new branch is public.
pub const OPTION_PUBLIC: &str = "public";
/// `git push -o publish-private=<oid>`: publish the members-only commits under that tip, as they are.
pub const OPTION_PUBLISH_PRIVATE: &str = "publish-private";

// --- the object graph ------------------------------------------------------------------------

/// The guard's object graph over the repository git spawned the helper for (`None`) or `repo`
/// (tests). Every call runs under `--no-replace-objects` and `GIT_GRAFT_FILE=/dev/null`
/// ([`git_read_in`]), so a local graft or replace ref cannot hide a members-only parent, and a
/// missing object is never lazily fetched. Objects the clone does not hold (a members-only tip it
/// never fetched, a public tip not fetched yet) are left out of every walk: what is not here cannot
/// be pushed from here.
pub struct GitGraph {
    repo: Option<PathBuf>,
}

impl GitGraph {
    /// The repository git spawned the helper for (or the hook runs in).
    pub fn here() -> Self {
        Self { repo: None }
    }

    /// The repository at `dir` (tests).
    #[cfg(test)]
    pub fn at(dir: &Path) -> Self {
        Self {
            repo: Some(dir.to_path_buf()),
        }
    }

    fn git(&self, args: &[&str], stdin: Option<&[u8]>) -> Result<Vec<u8>> {
        git_read_in(self.repo.as_deref(), args, stdin)
    }

    /// The objects of `oids` this repository holds.
    pub fn present(&self, oids: &[String]) -> Result<BTreeSet<String>> {
        let wanted = hex_oids(oids);
        if wanted.is_empty() {
            return Ok(BTreeSet::new());
        }
        let input = lines(&wanted);
        let out = self.git(
            &["cat-file", "--batch-check=%(objectname) %(objecttype)"],
            Some(input.as_bytes()),
        )?;
        Ok(String::from_utf8_lossy(&out)
            .lines()
            .filter_map(|l| {
                let (oid, kind) = l.split_once(' ')?;
                (kind != "missing").then(|| oid.to_owned())
            })
            .collect())
    }

    /// `rev-list [--objects] include ^exclude`, over the objects this repository holds.
    fn walk(
        &self,
        objects: bool,
        include: &[String],
        exclude: &[String],
    ) -> Result<BTreeSet<String>> {
        let Some(input) = self.range(include, exclude)? else {
            return Ok(BTreeSet::new());
        };
        let mut args = vec!["rev-list"];
        if objects {
            args.push("--objects");
        }
        args.push("--stdin");
        let out = self.git(&args, Some(input.as_bytes()))?;
        Ok(String::from_utf8_lossy(&out)
            .lines()
            .filter_map(|l| l.split(' ').next())
            .filter(|o| !o.is_empty())
            .map(str::to_owned)
            .collect())
    }

    /// `rev-list` input naming `include ^exclude`, over the objects this repository holds; `None`
    /// when nothing of `include` is here.
    fn range(&self, include: &[String], exclude: &[String]) -> Result<Option<String>> {
        let include = self.present(include)?;
        if include.is_empty() {
            return Ok(None);
        }
        let exclude = self.present(exclude)?;
        let mut input = lines(&include);
        for o in &exclude {
            input.push('^');
            input.push_str(o);
            input.push('\n');
        }
        Ok(Some(input))
    }

    /// `git log --no-walk` lines (`%h %s`) of `oids`, in the given order.
    pub fn describe(&self, oids: &[String]) -> Vec<String> {
        if oids.is_empty() {
            return Vec::new();
        }
        let mut args = vec!["log", "--no-walk=unsorted", "--format=%h %s"];
        args.extend(oids.iter().map(String::as_str));
        self.git(&args, None).map_or_else(
            |_| {
                oids.iter()
                    .map(|o| o[..o.len().min(12)].to_owned())
                    .collect()
            },
            |out| {
                String::from_utf8_lossy(&out)
                    .lines()
                    .map(str::to_owned)
                    .collect()
            },
        )
    }

    /// Whether `ancestor` is reachable from `tip` (replace refs off).
    pub fn reaches(&self, tip: &str, ancestor: &str) -> bool {
        is_hex_oid(tip)
            && is_hex_oid(ancestor)
            && crate::git::git_read_ok_in(
                self.repo.as_deref(),
                &["merge-base", "--is-ancestor", ancestor, tip],
            )
    }
}

impl ObjectGraph for GitGraph {
    fn commits(
        &self,
        include: &[String],
        exclude: &[String],
    ) -> forge_core::Result<BTreeSet<String>> {
        self.walk(false, include, exclude).map_err(graph_error)
    }

    fn objects(
        &self,
        include: &[String],
        exclude: &[String],
    ) -> forge_core::Result<BTreeSet<String>> {
        self.walk(true, include, exclude).map_err(graph_error)
    }

    fn peel(&self, oid: &str) -> forge_core::Result<Peeled> {
        let mut tags = Vec::new();
        let mut at = oid.to_owned();
        // a tag chain is short; a cycle cannot exist in a content-addressed store, but a bound
        // keeps a corrupted one from looping
        for _ in 0..64 {
            if !is_hex_oid(&at) {
                break;
            }
            let kind = self
                .git(&["cat-file", "-t", &at], None)
                .map_err(graph_error)?;
            let kind = String::from_utf8_lossy(&kind).trim().to_owned();
            let kind = match kind.as_str() {
                "commit" => ObjectType::Commit,
                "tree" => ObjectType::Tree,
                "blob" => ObjectType::Blob,
                "tag" => ObjectType::Tag,
                other => {
                    return Err(graph_error(anyhow!("object {at} has type {other}")));
                }
            };
            if kind != ObjectType::Tag {
                return Ok(Peeled {
                    tags,
                    target: at,
                    kind,
                });
            }
            let body = self
                .git(&["cat-file", "tag", &at], None)
                .map_err(graph_error)?;
            let target = String::from_utf8_lossy(&body)
                .lines()
                .find_map(|l| l.strip_prefix("object ").map(str::to_owned))
                .ok_or_else(|| graph_error(anyhow!("tag {at} names no object")))?;
            tags.push(std::mem::replace(&mut at, target));
        }
        Err(graph_error(anyhow!("the tag chain of {oid} does not end")))
    }

    fn gitlinks(&self, include: &[String], exclude: &[String]) -> forge_core::Result<Vec<Gitlink>> {
        let Some(input) = self.range(include, exclude).map_err(graph_error)? else {
            return Ok(Vec::new());
        };
        // every entry a commit changes against each parent (`-m`), a root commit's included; a
        // gitlink is mode 160000
        let out = self
            .git(
                &[
                    "log",
                    "--stdin",
                    "--raw",
                    "-m",
                    "--root",
                    "--no-abbrev",
                    "--no-renames",
                    "--ignore-submodules=none",
                    "--format=%x01%H",
                ],
                Some(input.as_bytes()),
            )
            .map_err(graph_error)?;
        let mut found = BTreeSet::new();
        let mut commit = String::new();
        for l in String::from_utf8_lossy(&out).lines() {
            if let Some(c) = l.strip_prefix('\u{1}') {
                c.clone_into(&mut commit);
                continue;
            }
            let Some((meta, path)) = l.strip_prefix(':').and_then(|l| l.split_once('\t')) else {
                continue;
            };
            let f: Vec<&str> = meta.split(' ').collect();
            if let [_, "160000", _, new, status] = f[..] {
                if status != "D" && is_hex_oid(new) {
                    found.insert(Gitlink {
                        commit: commit.clone(),
                        path: path.to_owned(),
                        target: new.to_owned(),
                    });
                }
            }
        }
        Ok(found.into_iter().collect())
    }

    fn patch_ids(&self, commits: &[String]) -> forge_core::Result<BTreeMap<String, String>> {
        let wanted = hex_oids(commits);
        if wanted.is_empty() {
            return Ok(BTreeMap::new());
        }
        // each commit's diff against its first parent (merges have none), then `patch-id`
        let patches = self
            .git(
                &[
                    "log",
                    "--no-walk=unsorted",
                    "--stdin",
                    "--no-merges",
                    "-p",
                    "--root",
                    "--no-renames",
                    "--no-color",
                    "--no-ext-diff",
                    "--format=commit %H",
                ],
                Some(lines(&wanted).as_bytes()),
            )
            .map_err(graph_error)?;
        let ids = self
            .git(&["patch-id", "--stable"], Some(&patches))
            .map_err(graph_error)?;
        Ok(String::from_utf8_lossy(&ids)
            .lines()
            .filter_map(|l| {
                let (pid, commit) = l.split_once(' ')?;
                Some((commit.to_owned(), pid.to_owned()))
            })
            .collect())
    }

    fn note_targets(&self, oid: &str) -> forge_core::Result<Vec<String>> {
        let out = self
            .git(&["ls-tree", "-r", "--name-only", oid], None)
            .map_err(graph_error)?;
        Ok(String::from_utf8_lossy(&out)
            .lines()
            .map(|p| p.replace('/', ""))
            .filter(|p| is_hex_oid(p))
            .collect())
    }
}

#[allow(clippy::needless_pass_by_value)] // a `map_err` function
fn graph_error(e: anyhow::Error) -> forge_core::Error {
    forge_core::Error::Config(format!(
        "reading this clone's history for the members-only check: {e:#}"
    ))
}

/// A lower-case hex object id (40 or 64 characters).
fn is_hex_oid(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// The `oids` that are object ids, as `git` is asked for them.
fn hex_oids(oids: &[String]) -> Vec<&str> {
    oids.iter()
        .map(String::as_str)
        .filter(|o| is_hex_oid(o))
        .collect()
}

/// `it`, one item per line.
fn lines<S: AsRef<str>>(it: impl IntoIterator<Item = S>) -> String {
    it.into_iter().fold(String::new(), |mut s, l| {
        s.push_str(l.as_ref());
        s.push('\n');
        s
    })
}

// --- a new branch's audience (D12) ------------------------------------------------------------

/// What the repository says about a push's new refs.
#[allow(clippy::struct_excessive_bools)] // independent facts D12 reads, not a state
#[derive(Debug, Clone, Default)]
pub struct RepoFacts {
    /// Members-only content is on (a members key exists).
    pub members_key: bool,
    /// At least one members-only ref update exists (rev 4.1: before that, nothing asks).
    pub has_members_branch: bool,
    /// The owner is the repository's only member (rev 4: nobody to hide anything from).
    pub owner_only: bool,
    /// No public ref is live: this push creates the default branch.
    pub empty: bool,
    /// The repository's default branch, `refs/heads/<name>`.
    pub default_ref: String,
}

/// Why a ref's audience is refused before anything is signed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// `-o members` (or `dg branch new --members`) for a branch that is already public (E809).
    AlreadyPublic,
    /// Members-only asked for the default branch, which is always public (E809).
    DefaultBranch,
    /// Members-only asked for in a repository without members-only content.
    MembersOff,
    /// A new branch and nothing says who can see it (E811, once per clone).
    Ask,
    /// `-o public` for a members-only branch: that is publishing it (E805).
    MembersBranchPublic,
}

/// What a ref's audience is decided from.
#[derive(Debug, Clone, Default)]
pub struct Signals {
    /// The ref's audience on the remote now: `None` for a new ref.
    pub existing: Option<Audience>,
    /// `branch.<b>.dashAudience` (`dg branch new --members`).
    pub intent: Option<Audience>,
    /// `-o members` / `-o public`.
    pub option: Option<Audience>,
    /// `dash.newBranches`.
    pub clone_default: Option<Audience>,
    /// E811 was already shown in this clone.
    pub asked_before: bool,
}

/// A ref's audience (DESIGN D12). An existing ref keeps its own: `-o members` on a public one is
/// E809, `-o public` on a members-only one would publish it. A new branch takes the first of: local
/// intent, the push option, inheritance (`inherits`: its new commits build on members-only ones),
/// the clone's default; else E811 once per clone where a members-only branch exists, the owner is
/// not alone and the repository is not empty, and public otherwise. The default branch is always
/// public; a tag follows inheritance only; members-only needs members-only content on.
pub fn decide(
    dst: &str,
    s: &Signals,
    facts: &RepoFacts,
    inherits: impl FnOnce() -> Result<bool>,
) -> Result<std::result::Result<Audience, Refusal>> {
    use Audience::{Members, Public};
    match s.existing {
        Some(Members | Audience::Narrower(_)) if s.option == Some(Public) => {
            return Ok(Err(Refusal::MembersBranchPublic))
        }
        Some(ref a @ (Members | Audience::Narrower(_))) => return Ok(Ok(a.clone())),
        Some(Public) if s.option == Some(Members) || s.intent == Some(Members) => {
            return Ok(Err(Refusal::AlreadyPublic))
        }
        Some(Public) => return Ok(Ok(Public)),
        None => {}
    }
    if dst.starts_with("refs/tags/") {
        return Ok(Ok(if facts.members_key && inherits()? {
            Members
        } else {
            Public
        }));
    }
    let asked = s.intent.clone().or_else(|| s.option.clone());
    if dst == facts.default_ref {
        return Ok(if asked == Some(Members) {
            Err(Refusal::DefaultBranch)
        } else {
            Ok(Public)
        });
    }
    let chosen = match asked {
        Some(a) => Some(a),
        None if facts.members_key && inherits()? => Some(Members),
        // a clone default (often set globally) is no request for a repository without
        // members-only content
        None if facts.members_key => s.clone_default.clone(),
        None => None,
    };
    Ok(match chosen {
        Some(Members) if !facts.members_key => Err(Refusal::MembersOff),
        Some(a) => Ok(a),
        None if dst.starts_with("refs/heads/")
            && facts.members_key
            && facts.has_members_branch
            && !facts.owner_only
            && !facts.empty
            && !s.asked_before =>
        {
            Err(Refusal::Ask)
        }
        None => Ok(Public),
    })
}

/// `members` / `public` as an audience; anything else is no answer.
pub fn parse_audience(v: &str) -> Option<Audience> {
    match v.trim() {
        "members" => Some(Audience::Members),
        "public" => Some(Audience::Public),
        _ => None,
    }
}

/// `branch.<b>.dashAudience` for the branch a push names: its local source branch, else the
/// destination's name.
pub fn branch_intent(src: &str, dst: &str) -> Option<Audience> {
    let b = src
        .strip_prefix("refs/heads/")
        .or_else(|| dst.strip_prefix("refs/heads/"))?;
    config_get(&format!("branch.{b}.dashAudience")).and_then(|v| parse_audience(&v))
}

/// `dash.newBranches`.
pub fn clone_default() -> Option<Audience> {
    config_get("dash.newBranches").and_then(|v| parse_audience(&v))
}

/// Where a clone records that it was asked (E811) once: `<common dir>/dash/new-branch-asked`.
fn asked_marker() -> Option<PathBuf> {
    LocalRepo::common_dir()
        .ok()
        .map(|d| d.join("dash").join("new-branch-asked"))
}

/// Whether this clone was already asked (E811).
pub fn asked_before() -> bool {
    asked_marker().is_some_and(|p| p.exists())
}

/// Record that this clone was asked (E811): the next new branch with no other signal is public.
pub fn mark_asked() {
    if let Some(p) = asked_marker() {
        forge_core::cache::write(&p, b"asked\n");
    }
}

/// The refusal's error block and the short reason git shows per ref.
pub fn refusal_error(r: &Refusal, dst: &str, repo: &str) -> (UserError, &'static str) {
    let name = short(dst);
    match r {
        Refusal::AlreadyPublic | Refusal::DefaultBranch => (
            UserError::new(
                codes::BRANCH_ALREADY_PUBLIC,
                format!("{name} is already public; nothing already pushed can be hidden"),
            )
            .cause(if *r == Refusal::DefaultBranch {
                "the default branch is always public".to_owned()
            } else {
                format!("{name} exists on {repo} as a public branch")
            })
            .fix(format!(
                "start a members-only branch from here under another name: `dg branch new --members {name}-2`"
            ))
            .note(NOTE_NOTHING_SIGNED),
            "already public",
        ),
        Refusal::MembersOff => (
            UserError::new(
                codes::MEMBERS_ONLY_OFF,
                format!("{name} can't be members-only: {repo} has members-only content off"),
            )
            .cause("this push asks for a members-only branch, and the repository has no members key")
            .fix(format!("a maintainer turns it on: `dg repo members enable {repo}`"))
            .fix(format!("push it as a public branch: add `-o public` to the push, or set `git config branch.{name}.dashAudience public`"))
            .note(NOTE_NOTHING_SIGNED),
            "members-only content is off",
        ),
        Refusal::Ask => (
            UserError::new(
                codes::NEW_BRANCH_AUDIENCE,
                format!("new branch {name}: choose who can see it"),
            )
            .cause(format!(
                "{repo} has members-only branches, and nothing says whether {name} is public or members-only"
            ))
            .fix("set this clone's default, then push again: `git config dash.newBranches public` (or `members`)")
            .fix(format!(
                "answer for this push: add `-o public` (or `-o members`); or `dg branch new --members {name}` for this branch"
            ))
            .note("asked once in this clone: a later new branch with no setting is public; nothing was signed or stored"),
            "choose who can see this new branch",
        ),
        Refusal::MembersBranchPublic => (
            UserError::new(
                codes::PUBLISHES_MEMBERS_ONLY,
                format!("{name} is members-only; pushing it as public would publish it"),
            )
            .cause("-o public names a branch that exists as members-only")
            .fix(format!(
                "make one new public commit from it instead: `dg publish {name} --onto <public branch>`"
            ))
            .note(NOTE_NOTHING_SIGNED),
            "members-only branch",
        ),
    }
}

/// The refusal of a branch asked for narrower (`dg branch new --to`, phase 3F) that cannot be:
/// it exists already (public or for all members), it is the default branch or not a branch, or
/// the repository has members-only content off.
pub fn narrow_refusal(r: &Refusal, dst: &str, repo: &str) -> (UserError, &'static str) {
    let name = short(dst);
    match r {
        Refusal::AlreadyPublic => (
            UserError::new(
                codes::BRANCH_ALREADY_PUBLIC,
                format!("{name} already exists on {repo}; nothing already pushed can be shared with fewer people"),
            )
            .cause(format!("{name} is a public or members-only branch, readable by everyone it was pushed for"))
            .fix(format!("start a branch for fewer people from here under another name: `dg branch new --to maintainers {name}-2`"))
            .note(NOTE_NOTHING_SIGNED),
            "already exists for more people",
        ),
        Refusal::DefaultBranch => (
            UserError::new(
                codes::BRANCH_ALREADY_PUBLIC,
                format!("{name} can't be for fewer people"),
            )
            .cause(if dst.starts_with("refs/heads/") {
                "the default branch is always public"
            } else {
                "only branches can be shared with fewer people"
            })
            .fix(format!("unset it: `git config --unset branch.{name}.dashAudience`"))
            .note(NOTE_NOTHING_SIGNED),
            "can't be for fewer people",
        ),
        other => refusal_error(other, dst, repo),
    }
}

/// A branch for fewer people whose name already has a key from someone else (phase 3F): never
/// pushed under.
pub fn narrow_taken(dst: &str) -> (UserError, &'static str) {
    let name = short(dst);
    (
        UserError::new(
            codes::BRANCH_ALREADY_PUBLIC,
            format!("{name} already has a key that isn't yours to use"),
        )
        .cause("someone else started a branch of this name for fewer people, or you are not one of the people it is for")
        .fix(format!("push it under another name: `git branch -m {name} {name}-2`, then push again"))
        .note(NOTE_NOTHING_SIGNED),
        "another key exists for this name",
    )
}

/// Whether the clone's ledger records commits of a branch for fewer people (phase 3F).
pub fn ledger_holds_narrower() -> bool {
    match read_ledger() {
        ledger::State::Present(l) => l
            .commits
            .values()
            .any(|a| matches!(a, ledger::EntryAudience::Narrower(_))),
        ledger::State::Unknown => true,
        ledger::State::Absent => false,
    }
}

/// A narrower audience asked for the branch a push names (`branch.<b>.dashAudience`, which `dg
/// branch new --to` sets; phase 3F): its local source branch, else the destination's name.
pub fn narrow_intent(src: &str, dst: &str) -> Option<forge_core::env::Audience> {
    let b = src
        .strip_prefix("refs/heads/")
        .or_else(|| dst.strip_prefix("refs/heads/"))?;
    config_get(&format!("branch.{b}.dashAudience")).and_then(|v| forge_core::narrow::parse_spec(&v))
}

const NOTE_NOTHING_SIGNED: &str = "checked before anything was signed or stored";

/// E806 for a push that would change a branch this clone knows only as members-only (a delete,
/// or a new public branch of that name) while the key that reads members-only branches is not
/// available: written as public, it would publish the name.
pub fn members_branch_locked(dst: &str) -> (UserError, &'static str) {
    let name = short(dst);
    (
        UserError::new(
            codes::CANNOT_CHECK_MEMBERS_ONLY,
            format!("can't change {name}: it is a members-only branch and your encryption key isn't available"),
        )
        .cause("without the key this push would be written for everyone, which would publish the branch's name")
        .fix("dg auth unlock, then push again (a key protected by a passphrase needs a terminal, or DASH_FORGE_PASSPHRASE)")
        .note(NOTE_NOTHING_SIGNED),
        "members-only branch: unlock your key first",
    )
}

/// The refusal of `refs/replace/<M>` for a graft this helper wrote ([`graft_missing_parents`]).
pub fn graft_refusal(dst: &str) -> (UserError, &'static str) {
    (
        UserError::new(
            codes::PUBLISHES_MEMBERS_ONLY,
            format!("{dst} is a graft this clone wrote over a members-only parent it can't read"),
        )
        .cause("it stands in for history this clone doesn't have, and is never pushed")
        .fix("push the branches you mean to push by name, not every ref (`--mirror`, or `--all` with replace refs)")
        .note(NOTE_NOTHING_SIGNED),
        "a local graft",
    )
}

/// `refs/heads/x` → `x`, `refs/tags/v1` → `v1`.
pub fn short(r: &str) -> &str {
    r.strip_prefix("refs/heads/")
        .or_else(|| r.strip_prefix("refs/tags/"))
        .unwrap_or(r)
}

// --- the guard's refusals ---------------------------------------------------------------------

/// How many commits an E805 lists by name.
const NAMED: usize = 5;

/// The commits of `oids` an E805 lists by name.
fn named(oids: &[String]) -> &[String] {
    &oids[..oids.len().min(NAMED)]
}

/// E805 for `outcome`'s findings, and the lines printed above it: the first commits as `%h %s`
/// and a count. The error names the members-only branch they come from when a held tip reaches
/// them, and the two ways out. `members_tips`: members-only branch → its tip, as this pusher reads
/// them; `public_missing`: public tips this clone does not hold (a false finding is then likely:
/// fetch first).
pub fn publish_refusal(
    g: &GitGraph,
    outcome: &Outcome,
    batch: &[BatchRef],
    members_tips: &BTreeMap<String, String>,
    public_missing: usize,
) -> (UserError, Vec<String>) {
    let first = &outcome.findings[0];
    let tip = batch
        .iter()
        .find(|b| b.dst == first.dst)
        .and_then(|b| b.new.clone())
        .unwrap_or_else(|| "<new tip>".to_owned());
    let n = first.oids.len();
    let from = first.oids.first().and_then(|c| {
        members_tips
            .iter()
            .find(|(_, tip)| g.reaches(tip, c))
            .map(|(name, _)| short(name).to_owned())
    });
    let what = match first.kind {
        FindingKind::Commits => format!("{n} {}", plural(n, "commit", "commits")),
        FindingKind::Tag => "a members-only tag".to_owned(),
        FindingKind::Object => "a members-only file or directory".to_owned(),
        FindingKind::Note => format!(
            "a note on {n} members-only {}",
            plural(n, "commit", "commits")
        ),
        FindingKind::Replace => "a replacement of a members-only commit".to_owned(),
    };
    let origin = from.as_ref().map_or_else(
        || "a members-only branch".to_owned(),
        |b| format!("members-only branch {b}"),
    );
    let mut lines = Vec::new();
    for f in &outcome.findings {
        lines.push(format!("dash: {} would publish:", f.dst));
        lines.extend(
            g.describe(named(&f.oids))
                .into_iter()
                .map(|l| format!("dash:   {l}")),
        );
        if f.oids.len() > NAMED {
            lines.push(format!("dash:   … and {} more", f.oids.len() - NAMED));
        }
    }
    let branch = from.unwrap_or_else(|| "<members-only branch>".to_owned());
    // into a members-only or narrower branch (D21 rev 4, phase 3F): more people would read them
    let sealed_dst = batch
        .iter()
        .find(|b| b.dst == first.dst)
        .is_some_and(|b| b.audience.is_sealed());
    if sealed_dst {
        let e = UserError::new(
            codes::PUBLISHES_MEMBERS_ONLY,
            format!(
                "pushing {} would show {what} from branch {branch} to people who can't read them now",
                first.dst
            ),
        )
        .cause(format!(
            "{} is read by people {branch} isn't for, so nothing in this push was sent",
            short(&first.dst)
        ))
        .fix("push them to a branch for the same people, or start one: `dg branch new --to <who> <name>`")
        .fix(format!(
            "when the work is ready, make one new public commit: `dg publish {branch} --onto <public branch>`"
        ))
        .note(NOTE_NOTHING_SIGNED);
        return (e, lines);
    }
    let e = UserError::new(
        codes::PUBLISHES_MEMBERS_ONLY,
        format!("pushing {} would publish {what} from {origin}", first.dst),
    )
    .cause("anything pushed to a public branch can't be taken back, so nothing in this push was sent")
    .fix(format!(
        "make one new public commit, keeping the members-only history members-only: `dg publish {branch} --onto {}`",
        short(&first.dst)
    ))
    .fix(format!(
        "publish these commits as they are, which can't be undone: add `-o {OPTION_PUBLISH_PRIVATE}={tip}` to the same push"
    ));
    let e = if public_missing > 0 {
        e.note(format!(
            "{public_missing} public {} not in this clone yet: run `git fetch`, then push again (a public commit isn't refused once it is here)",
            plural(public_missing, "branch is", "branches are")
        ))
    } else {
        e.note(NOTE_NOTHING_SIGNED)
    };
    (e, lines)
}

/// E806 for a push: the guard cannot tell what this clone holds.
pub fn cannot_check_push() -> UserError {
    UserError::new(
        codes::CANNOT_CHECK_MEMBERS_ONLY,
        "can't check for members-only commits: your encryption key isn't available and this clone has no record of what it holds",
    )
    .cause("the repository has members-only branches; a public push can't be checked without your key or this clone's record")
    .fix("dg auth unlock, then push again (a key protected by a passphrase needs a terminal, or DASH_FORGE_PASSPHRASE)")
    .fix("a clone that never fetched members-only branches can start its record: dg doctor --init-ledger")
    .note(NOTE_NOTHING_SIGNED)
}

/// E806 for a fetch: the clone holds members-only commits and the key that reads them is locked,
/// so the public view alone would make git prune its members-only branches.
pub fn cannot_check_fetch(why: &str) -> UserError {
    UserError::new(
        codes::CANNOT_CHECK_MEMBERS_ONLY,
        "can't fetch members-only branches: your encryption key isn't available",
    )
    .cause(format!(
        "this clone has fetched members-only branches, so fetching only the public view would drop them ({why})"
    ))
    .fix("dg auth unlock, then fetch again (a key protected by a passphrase needs a terminal, or DASH_FORGE_PASSPHRASE)")
    .note("nothing was fetched")
}

/// E806 when this clone's ledger is of a version this helper does not read or write.
pub fn ledger_unreadable() -> UserError {
    UserError::new(
        codes::CANNOT_CHECK_MEMBERS_ONLY,
        "can't check for members-only commits: this clone's record of them is from a newer version",
    )
    .cause("this clone's record of members-only commits (.git/dash/sealed-ledger) is a version this git-remote-dash does not read")
    .fix("update git-remote-dash and dg to the version that wrote it")
    .note(NOTE_NOTHING_SIGNED)
}

pub fn plural<'a>(n: usize, one: &'a str, many: &'a str) -> &'a str {
    if n == 1 {
        one
    } else {
        many
    }
}

/// The lines naming what `-o publish-private` lets through: a publication.
pub fn publication_lines(g: &GitGraph, published: &[Finding]) -> Vec<String> {
    let mut out = Vec::new();
    for f in published {
        out.push(format!(
            "dash: publishing {} members-only {} to {} as they are (-o {OPTION_PUBLISH_PRIVATE}):",
            f.oids.len(),
            plural(f.oids.len(), "object", "objects"),
            f.dst
        ));
        out.extend(
            g.describe(&f.oids)
                .into_iter()
                .map(|l| format!("dash:   {l}")),
        );
    }
    out
}

/// The notes for gitlinks (submodule entries) naming members-only commits that a push publishes:
/// allowed, since a gitlink carries a commit's id and none of its content (DESIGN §4.3, guard
/// step 5), but the id itself becomes public.
pub fn gitlink_lines(notes: &[GitlinkNote]) -> Vec<String> {
    notes
        .iter()
        .map(|n| {
            format!(
                "dash: note: {} in {} (on {}) points to the members-only commit {}: everyone can see that commit's id, not its content",
                n.path,
                &n.commit[..n.commit.len().min(9)],
                short(&n.dst),
                &n.target[..n.target.len().min(9)],
            )
        })
        .collect()
}

/// The warning for public commits that carry a members-only commit's changes under a new id
/// (the opt-in `patch-id` check): the guard follows ids, so a cherry-pick or a rebase of a
/// members-only commit passes it.
pub fn remade_lines(g: &GitGraph, remade: &[Remade]) -> Vec<String> {
    if remade.is_empty() {
        return Vec::new();
    }
    let mut out = vec![format!(
        "dash: warning: {} {} this push makes public {} the same changes as {}:",
        remade.len(),
        plural(remade.len(), "commit", "commits"),
        plural(remade.len(), "has", "have"),
        plural(
            remade.len(),
            "a members-only commit",
            "members-only commits"
        ),
    )];
    for r in remade {
        let public = g.describe(std::slice::from_ref(&r.commit)).concat();
        let members = g.describe(std::slice::from_ref(&r.like)).concat();
        out.push(format!(
            "dash:   {public} (on {}) is like {members}",
            short(&r.dst)
        ));
    }
    out.push("dash: this check only warns: the push goes on (git config dash.patchIdCheck)".into());
    out
}

/// The `-o publish-private=<oid>` of this push, unless `push.pushOption` sets it: the override is
/// bound to one push (security L6), so a permanent one is ignored with a warning.
pub fn publish_private(values: &[String]) -> Option<String> {
    let v = values.last()?;
    // a full id, or anything git resolves to one (`HEAD`, a short id)
    let v = LocalRepo::rev_parse(v).unwrap_or_else(|| v.to_ascii_lowercase());
    let permanent = std::process::Command::new("git")
        .args(["config", "--get-all", "push.pushOption"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    if permanent
        .lines()
        .any(|l| l.trim().starts_with(OPTION_PUBLISH_PRIVATE))
    {
        eprintln!(
            "dash: warning: push.pushOption sets {OPTION_PUBLISH_PRIVATE}; it is ignored: give -o {OPTION_PUBLISH_PRIVATE}=<oid> on the one push that publishes"
        );
        return None;
    }
    Some(v)
}

/// What the guard knows about narrower branches (phase 3F): who each is for, by ledger token,
/// and every one of their commits the pusher decrypts, with its token.
#[derive(Debug, Default, Clone)]
pub struct Narrower {
    /// Audiences by ledger token.
    pub audiences: guard::NarrowAudiences,
    /// `(newOid, token)` of every narrower branch's update the pusher opened.
    pub decryptable: Vec<(String, String)>,
}

/// Run the guard over this clone. A ledger that cannot be read at all is unknown (fail closed).
pub fn run_guard(
    members_key: bool,
    decryptable: Option<&[String]>,
    public_tips: &[String],
    batch: &[BatchRef],
    publish_private: Option<&str>,
    narrower: &Narrower,
) -> Result<Outcome> {
    let ledger = read_ledger();
    let g = GitGraph::here();
    Ok(guard::guard(
        &g,
        &GuardInput {
            members_key,
            ledger: &ledger,
            decryptable,
            public_tips,
            batch,
            publish_private,
            patch_ids: patch_id_check(),
            audiences: &narrower.audiences,
            decryptable_narrower: &narrower.decryptable,
        },
    )?)
}

/// The opt-in `patch-id` comparison of re-made commits (DESIGN §4.3 guard): `git config
/// dash.patchIdCheck true`.
pub fn patch_id_check() -> bool {
    std::process::Command::new("git")
        .args(["config", "--type=bool", "--get", "dash.patchIdCheck"])
        .output()
        .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).trim() == "true")
}

/// The clone's ledger as the guard reads it; an I/O failure other than "not there" is unknown.
pub fn read_ledger() -> ledger::State {
    let Ok(dir) = LocalRepo::common_dir() else {
        return ledger::State::Absent;
    };
    ledger::read(&dir).unwrap_or(ledger::State::Unknown)
}

/// Whether the clone's ledger records members-only objects, or cannot be read: the fetch trigger
/// of E806 (DESIGN §11).
pub fn ledger_holds_members_only() -> bool {
    holds_members_only(&read_ledger())
}

fn holds_members_only(state: &ledger::State) -> bool {
    match state {
        ledger::State::Absent => false,
        ledger::State::Unknown => true,
        ledger::State::Present(l) => !l.is_empty(),
    }
}

/// Whether serving only the public view to this fetch would drop branches the clone holds: a
/// name under `refs/remotes/<remote>/` that no live public branch has (a members-only branch
/// fetched before, which `git fetch --prune` would delete). Without a remote name (a URL fetch)
/// it cannot tell, so it says yes (fail closed).
pub fn public_view_drops_branches(remote: Option<&str>, public_live: &BTreeSet<&str>) -> bool {
    dropped_branches(remote, public_live).is_none_or(|d| !d.is_empty())
}

/// The branches (`refs/heads/<b>`) under `refs/remotes/<remote>/` that `live` lacks, or `None`
/// when it cannot tell (a URL fetch, git failing).
pub fn dropped_branches(remote: Option<&str>, live: &BTreeSet<&str>) -> Option<Vec<String>> {
    let remote = remote.filter(|r| !r.is_empty() && !r.contains("://"))?;
    let prefix = format!("refs/remotes/{remote}/");
    let out = std::process::Command::new("git")
        .args(["for-each-ref", "--format=%(refname)", &prefix])
        .output()
        .ok()?;
    Some(
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|r| r.strip_prefix(&prefix))
            .filter(|b| *b != "HEAD")
            .map(|b| format!("refs/heads/{b}"))
            .filter(|b| !live.contains(b.as_str()))
            .collect(),
    )
}

/// `<common dir>/dash/shared-branches`: the members-only branches this clone fetched because
/// someone shared them with its reader (`dg branch share`), one full ref name per line.
fn shared_branches_path(common: &Path) -> PathBuf {
    common.join("dash").join("shared-branches")
}

/// The branch names in `path`, one per line (a line that is not one is skipped).
fn read_branch_lines(path: &Path) -> BTreeSet<String> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with("refs/heads/") && forge_core::rules::is_git_ref_name(l))
        .map(str::to_owned)
        .collect()
}

/// Add `names` to the branches this clone was given ([`shared_branches_path`]). Best effort.
pub fn remember_shared_branches(names: &[String]) {
    let Ok(common) = LocalRepo::common_dir() else {
        return;
    };
    let p = shared_branches_path(&common);
    let mut all = read_branch_lines(&p);
    let before = all.len();
    all.extend(names.iter().cloned());
    if all.len() != before {
        forge_core::cache::write(&p, lines(&all).as_bytes());
    }
}

/// The branches this clone was given ([`remember_shared_branches`]).
pub fn shared_branches_given() -> BTreeSet<String> {
    LocalRepo::common_dir()
        .map(|c| read_branch_lines(&shared_branches_path(&c)))
        .unwrap_or_default()
}

/// E806 when branches someone shared with this reader are no longer shared (the share's writer
/// lost Write access, or its push was by someone since removed): the public view would drop them.
pub fn shared_branches_gone(remote: &str, names: &[String]) -> UserError {
    let list = names
        .iter()
        .map(|n| short(n))
        .collect::<Vec<_>>()
        .join(", ");
    let mut e = UserError::new(
        codes::CANNOT_CHECK_MEMBERS_ONLY,
        format!("can't fetch: {list} isn't shared with you anymore"),
    )
    .cause("whoever shared it can no longer share this repository's members-only branches, so fetching would drop it from this clone");
    for n in names {
        e = e.fix(format!(
            "git branch -dr {remote}/{}     # forget it here, then fetch again",
            short(n)
        ));
    }
    e.fix("or ask a member with Write access to share it again (`dg branch share`)")
        .note("nothing was fetched")
}

/// Append `commits` and `packs` (members-only, the members key's audience) to the clone's ledger,
/// before the objects arrive or are published. A clone with no ledger gets one now: this helper
/// records everything members-only it fetches or pushes from here on, and before members-only
/// branches no helper could hold any. A ledger of another version is never written to (E806).
pub fn record(commits: &[String], packs: &[[u8; 32]]) -> Result<()> {
    record_as(&EntryAudience::Members, commits, packs)
}

/// [`record`] for `audience`: a narrower branch's commits and packs carry its ledger token
/// (phase 3F).
pub fn record_as(audience: &EntryAudience, commits: &[String], packs: &[[u8; 32]]) -> Result<()> {
    if commits.is_empty() && packs.is_empty() {
        return Ok(());
    }
    let dir = LocalRepo::common_dir()?;
    let held = match ledger::read(&dir) {
        Ok(ledger::State::Present(l)) => l,
        Ok(ledger::State::Absent) => {
            ledger::create_empty(&dir)
                .context("starting this clone's record of members-only commits")?;
            ledger::Ledger::default()
        }
        Ok(ledger::State::Unknown) | Err(_) => return Err(ledger_unreadable().into()),
    };
    let new_commits = hex_oids(commits)
        .into_iter()
        .filter(|c| !held.commits.contains_key(*c))
        .map(|c| (EntryKind::Commit, c.to_owned()));
    let new_packs = packs
        .iter()
        .map(hex::encode)
        .filter(|p| !held.packs.contains_key(p))
        .map(|p| (EntryKind::Pack, p));
    let new: Vec<Entry> = new_commits
        .chain(new_packs)
        .map(|(kind, id)| Entry {
            kind,
            id,
            audience: audience.clone(),
        })
        .collect();
    ledger::append(&dir, &new).map_err(|e| {
        if e.kind() == std::io::ErrorKind::InvalidData {
            anyhow::Error::from(ledger_unreadable())
        } else {
            anyhow::Error::from(e).context("recording members-only commits in this clone's record")
        }
    })
}

/// `<common dir>/dash/public-tips`: every public tip a fetch of a dash remote listed, so the
/// `pre-push` hook (which has no network) can tell members-only commits from the public history
/// they build on. Union over fetches: once public, always public.
fn public_tips_path(common: &Path) -> PathBuf {
    common.join("dash").join("public-tips")
}

/// Add `tips` to the clone's public tips ([`public_tips_path`]). Best effort: a missing file only
/// makes the hook refuse more.
pub fn remember_public_tips(tips: &[String]) {
    let Ok(common) = LocalRepo::common_dir() else {
        return;
    };
    let p = public_tips_path(&common);
    let mut all = read_lines(&p);
    let before = all.len();
    all.extend(hex_oids(tips).into_iter().map(str::to_owned));
    if all.len() != before || !p.exists() {
        forge_core::cache::write(&p, lines(&all).as_bytes());
    }
}

/// The public tips this clone's fetches of dash remotes listed ([`public_tips_path`]).
pub fn known_public_tips() -> Vec<String> {
    LocalRepo::common_dir()
        .map(|c| read_public_tips(&c))
        .unwrap_or_default()
}

fn read_public_tips(common: &Path) -> Vec<String> {
    read_lines(&public_tips_path(common)).into_iter().collect()
}

// --- the pre-push hook ------------------------------------------------------------------------

/// The `git-remote-dash` git runs for a `dash://` remote: the first on `PATH` (git puts its
/// exec-path first for the processes it starts), canonicalized.
pub fn helper_on_path() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join("git-remote-dash"))
        .find(|p| p.is_file())
        .and_then(|p| std::fs::canonicalize(p).ok())
}

/// This binary, canonicalized.
pub fn this_helper() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| std::fs::canonicalize(p).ok())
}

/// `Some((on PATH, this))` when git would run another `git-remote-dash` than this one (two
/// installs, product J11): a members-only fetch is refused, since the other may not guard pushes.
pub fn helper_mismatch() -> Option<(PathBuf, PathBuf)> {
    let me = this_helper()?;
    let first = helper_on_path()?;
    (first != me).then_some((first, me))
}

/// The hooks directory git uses for this repository (`git rev-parse --git-path hooks`, which
/// honours `core.hooksPath`), absolute.
pub fn hooks_dir() -> Result<PathBuf> {
    let out = std::process::Command::new("git")
        .args(["rev-parse", "--git-path", "hooks"])
        .output()
        .context("running git rev-parse --git-path hooks")?;
    if !out.status.success() {
        return Err(anyhow!(
            "git rev-parse --git-path hooks failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let p = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
    Ok(if p.is_absolute() {
        p
    } else {
        std::env::current_dir()?.join(p)
    })
}

/// Why this clone may not hold members-only branches yet (fetch them, or push the first one), or
/// `None` when it may: the `pre-push` hook is in place (installed now in the repository's own
/// hooks directory), and git runs this helper.
pub fn hook_blocked() -> Option<UserError> {
    if let Some((first, me)) = helper_mismatch() {
        return Some(
            UserError::new(
                codes::MEMBERS_ONLY_TO_OTHER_REMOTE,
                "members-only branches aren't fetched: another git-remote-dash comes first on PATH",
            )
            .cause(format!(
                "git runs {} for dash:// remotes, and this one is {}; the other may not check pushes for members-only commits",
                first.display(),
                me.display()
            ))
            .fix("remove the older install, or put this one first on PATH; `dg doctor` shows both"),
        );
    }
    let me = this_helper().unwrap_or_else(|| PathBuf::from("git-remote-dash"));
    let dir = match hooks_dir() {
        Ok(d) => d,
        Err(e) => return Some(hook_error(&format!("{e:#}"))),
    };
    if hook::status(&dir, &me) == (hook::Status::Ours { current: true }) {
        return None;
    }
    if config_get("core.hooksPath").is_some() {
        return Some(
            UserError::new(
                codes::MEMBERS_ONLY_TO_OTHER_REMOTE,
                "members-only branches aren't fetched until a pre-push hook protects them",
            )
            .cause(format!(
                "core.hooksPath points at {}, a directory other repositories may share; git-remote-dash does not change it on its own",
                dir.display()
            ))
            .fix("dg doctor --install-hook     # adds the hook there, keeping any pre-push hook it finds"),
        );
    }
    match hook::install(&dir, &me) {
        Ok(done) => {
            tracing::info!(?done, dir = %dir.display(), "pre-push hook in place");
            None
        }
        Err(e) => Some(hook_error(&e.to_string())),
    }
}

fn hook_error(why: &str) -> UserError {
    UserError::new(
        codes::MEMBERS_ONLY_TO_OTHER_REMOTE,
        "members-only branches aren't fetched until a pre-push hook protects them",
    )
    .cause(format!("the hook could not be installed: {why}"))
    .fix("dg doctor --install-hook")
}

/// One line of the `pre-push` hook's input.
#[derive(Debug, Clone, PartialEq, Eq)]
struct HookLine {
    local_oid: String,
    remote_ref: String,
    remote_oid: String,
}

fn parse_hook_input(input: &str) -> Vec<HookLine> {
    input
        .lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let (_local_ref, local_oid, remote_ref, remote_oid) =
                (it.next()?, it.next()?, it.next()?, it.next()?);
            Some(HookLine {
                local_oid: local_oid.to_owned(),
                remote_ref: remote_ref.to_owned(),
                remote_oid: remote_oid.to_owned(),
            })
        })
        .collect()
}

fn is_null_oid(o: &str) -> bool {
    o.bytes().all(|b| b == b'0')
}

/// `git-remote-dash --pre-push <remote> <url>`, run by the hook with git's input on stdin: refuse
/// (E810, exit 1) to push a commit the clone's ledger records as members-only, or that builds on
/// one, to a remote that is not a dash remote this helper serves. A dash remote served by this
/// helper is checked by its own guard, which knows each ref's audience. Exit 0 otherwise.
pub fn pre_push(args: &[String], input: &mut dyn std::io::Read) -> Result<i32> {
    let remote = args.first().map_or("", String::as_str);
    let url = args.get(1).map_or(remote, String::as_str);
    let mut text = String::new();
    input.read_to_string(&mut text)?;
    let updates = parse_hook_input(&text);
    let state = read_ledger();
    if !holds_members_only(&state) {
        return Ok(0);
    }
    if url.starts_with("dash://") && helper_mismatch().is_none() {
        return Ok(0);
    }
    if state == ledger::State::Unknown {
        let e = ledger_unreadable();
        eprintln!("pre-push: {} {}", e.code, e.message);
        eprintln!("          {}", e.cause.unwrap_or_default());
        eprintln!(
            "          git push --no-verify skips this check, and publishes what it would refuse"
        );
        return Ok(1);
    }
    let common = LocalRepo::common_dir()?;
    let g = GitGraph::here();
    // what is public, and what the remote already has (its tips in git's input): neither is
    // published by this push. Never this clone's remote-tracking refs: a dash remote's members-only
    // branches keep their real names there, and a remote may fetch from dash and push elsewhere
    // (`pushurl`, `pushInsteadOf`).
    let mut known = read_public_tips(&common);
    known.extend(
        updates
            .iter()
            .filter(|u| !is_null_oid(&u.remote_oid))
            .map(|u| u.remote_oid.clone()),
    );
    let batch: Vec<BatchRef> = updates
        .iter()
        .map(|u| BatchRef {
            dst: u.remote_ref.clone(),
            new: (!is_null_oid(&u.local_oid)).then(|| u.local_oid.clone()),
            audience: Audience::Public,
        })
        .collect();
    let outcome = guard::guard(
        &g,
        &GuardInput {
            members_key: true,
            ledger: &state,
            decryptable: None,
            public_tips: &known,
            batch: &batch,
            publish_private: None,
            patch_ids: false,
            audiences: &BTreeMap::default(),
            decryptable_narrower: &[],
        },
    )?;
    let grafts = written_grafts();
    let graft_refs: Vec<&str> = updates
        .iter()
        .filter(|u| !is_null_oid(&u.local_oid))
        .filter_map(|u| u.remote_ref.strip_prefix("refs/replace/"))
        .filter(|x| grafts.contains(*x))
        .collect();
    for x in &graft_refs {
        eprintln!(
            "pre-push: {} refs/replace/{x} is a graft this clone wrote over a members-only parent it can't read; not pushing it to {remote}",
            codes::MEMBERS_ONLY_TO_OTHER_REMOTE
        );
    }
    if outcome.verdict == Verdict::Pass {
        return Ok(i32::from(!graft_refs.is_empty()));
    }
    for f in &outcome.findings {
        eprintln!(
            "pre-push: {} {} contains members-only commits from a Dash Forge repository; not pushing to {remote}",
            codes::MEMBERS_ONLY_TO_OTHER_REMOTE,
            f.dst
        );
        for l in g.describe(named(&f.oids)) {
            eprintln!("          {l}");
        }
        if f.oids.len() > NAMED {
            eprintln!("          … and {} more", f.oids.len() - NAMED);
        }
    }
    eprintln!("          publish them first with `dg publish <branch> --onto <public branch>`");
    eprintln!("          git push --no-verify skips this check, and publishes them");
    Ok(1)
}

// --- fetch: grafts and the commit-graph -------------------------------------------------------

/// The merges reachable from `wants` with a parent this clone does not hold and one it does, each
/// with the parents it holds (`rev-list --missing=print --parents`, replace refs off). A commit
/// none of whose parents is here is not one: that is lost history, never grafted over.
pub fn commits_missing_parents(
    repo: Option<&Path>,
    wants: &[String],
) -> Result<Vec<(String, Vec<String>)>> {
    let wants = hex_oids(wants);
    if wants.is_empty() {
        return Ok(Vec::new());
    }
    let out = git_read_in(
        repo,
        &["rev-list", "--missing=print", "--parents", "--stdin"],
        Some(lines(&wants).as_bytes()),
    )?;
    let text = String::from_utf8_lossy(&out);
    let missing: BTreeSet<&str> = text.lines().filter_map(|l| l.strip_prefix('?')).collect();
    Ok(text
        .lines()
        .filter(|l| !l.starts_with('?'))
        .filter_map(|l| {
            let mut it = l.split(' ');
            let c = it.next()?;
            let parents: Vec<&str> = it.collect();
            let cut = parents.iter().any(|p| missing.contains(p))
                && parents.iter().any(|p| !missing.contains(p));
            cut.then(|| {
                (
                    c.to_owned(),
                    parents
                        .iter()
                        .filter(|p| !missing.contains(*p))
                        .map(|p| (*p).to_owned())
                        .collect(),
                )
            })
        })
        .collect())
}

/// A merge whose members-only parent this clone cannot read (DESIGN §4.3 "Merging a members branch
/// into a public one": a modified client pushed it): graft each such commit to the parents the
/// clone holds (`refs/replace/<M>`), inside `fetch` before git's connectivity check, and mark
/// `packs` (this fetch's) as promisor packs with this remote as their promisor, so `fsck`, `gc`
/// and `repack` keep working. Returns the grafted commits. Never pushed: the helper refuses
/// `refs/replace/*` grafts it wrote (they name public commits, and a push sends no graft).
pub fn graft_missing_parents(
    repo: Option<&Path>,
    wants: &[String],
    packs: &[String],
    remote: Option<&str>,
) -> Result<Vec<String>> {
    let cut = commits_missing_parents(repo, wants)?;
    let mut grafted = Vec::new();
    for (commit, held) in &cut {
        let mut args = vec!["replace", "-f", "--graft", commit.as_str()];
        args.extend(held.iter().map(String::as_str));
        run_git_in(repo, &args)?;
        grafted.push(commit.clone());
    }
    if grafted.is_empty() {
        return Ok(grafted);
    }
    // recorded, so a push never sends them (`refs/replace/*`, DESIGN §4.3)
    let common = git_read_in(
        repo,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        None,
    )?;
    let path = grafts_path(Path::new(String::from_utf8_lossy(&common).trim()));
    let mut all = read_lines(&path);
    all.extend(grafted.iter().cloned());
    forge_core::cache::write(&path, lines(&all).as_bytes());
    let pack_dir = objects_dir(repo)?.join("pack");
    for sha in packs {
        let marker = pack_dir.join(format!("pack-{sha}.promisor"));
        if !marker.exists() {
            std::fs::write(&marker, b"")
                .with_context(|| format!("writing {}", marker.display()))?;
        }
    }
    if let Some(remote) = remote.filter(|r| !r.is_empty() && !r.contains("://")) {
        run_git_in(repo, &["config", "core.repositoryformatversion", "1"])?;
        run_git_in(repo, &["config", "extensions.partialClone", remote])?;
        run_git_in(
            repo,
            &["config", &format!("remote.{remote}.promisor"), "true"],
        )?;
    }
    Ok(grafted)
}

/// `<common dir>/dash/grafts`: the commits this helper grafted over an unreadable members-only
/// parent ([`graft_missing_parents`]), whose `refs/replace/<M>` a push never sends.
fn grafts_path(common: &Path) -> PathBuf {
    common.join("dash").join("grafts")
}

fn read_lines(path: &Path) -> BTreeSet<String> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter(|l| is_hex_oid(l))
        .map(str::to_owned)
        .collect()
}

/// The commits this clone's helper grafted ([`grafts_path`]).
pub fn written_grafts() -> BTreeSet<String> {
    LocalRepo::common_dir()
        .map(|d| read_lines(&grafts_path(&d)))
        .unwrap_or_default()
}

fn objects_dir(repo: Option<&Path>) -> Result<PathBuf> {
    let out = git_read_in(
        repo,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "objects",
        ],
        None,
    )?;
    Ok(PathBuf::from(String::from_utf8_lossy(&out).trim()))
}

fn run_git_in(repo: Option<&Path>, args: &[&str]) -> Result<()> {
    let mut cmd = std::process::Command::new("git");
    if let Some(dir) = repo {
        cmd.current_dir(dir)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE");
    }
    let out = cmd.args(args).output().context("running git")?;
    if !out.status.success() {
        return Err(anyhow!(
            "git {} failed: {}",
            args.first().copied().unwrap_or_default(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// Write a commit-graph for the history of `tips` (DESIGN §4.3, S4: without one the guard costs a
/// second on a large import). Best effort.
pub fn write_commit_graph(tips: &[String]) {
    let tips = hex_oids(tips);
    if tips.is_empty() {
        return;
    }
    if let Err(e) = git_read_in(
        None,
        &["commit-graph", "write", "--no-progress", "--stdin-commits"],
        Some(lines(&tips).as_bytes()),
    ) {
        tracing::info!(error = %e, "could not write a commit-graph; the members-only check runs without one");
    }
}

#[cfg(test)]
mod tests;
