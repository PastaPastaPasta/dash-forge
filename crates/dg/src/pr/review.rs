//! `dg pr review` and `dg pr comment` (review-parity §2.5 C1, C2; §4.1 R1, R2, R3, R5).
//!
//! A review is one `review` document plus one `comment` per inline comment, each naming the
//! review (`reviewId`) — `1 + N` transitions, since Platform takes one document per
//! transition. They are written from a local **draft** (the CLI's pending review), kept at
//! `~/.local/state/dash-forge/journals/reviews/<network>-<repo>-<pr>-<identity>.json`:
//!
//! * `dg pr review … --pending --file … --line … --body …` adds comments to the draft and
//!   writes nothing (GitHub's "Start a review").
//! * `dg pr review … --request-changes [--file …]` submits the draft plus the given comments:
//!   the review first (with `commentCount = N`), then each comment. Before its first broadcast
//!   every signed transition is saved in the draft, and each landed id after it lands, so a
//!   submit cut short (a crash, Ctrl-C, a network failure) resumes when the same command — or
//!   `--resume` — is run again: a saved transition is re-broadcast byte for byte, which lands
//!   at most once. Nothing is ever written twice.
//! * `--discard` throws the draft away.
//!
//! A draft of a review that is not public (`--members`, a members-only thread, or any review in
//! a private repository) never holds its text in the clear: the file is the draft sealed under
//! the repository's key for members (DFPK, as a sealed artifact), and
//! is opened with the reviewer's keys when the command runs again (mixed-visibility DESIGN §4.1:
//! no members-only text at rest).
//!
//! `dg pr comment` posts one comment at once (GitHub's "Add single comment"), inline, a
//! reply, or general.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;

use forge_core::collab::v2::{comment_props, review_props, Collab, PatchView};
use forge_core::collab::{CommentAnchor, Verdict};
use forge_core::create::default_journal_dir;
use forge_core::platform::WriteIntent;
use forge_core::rules::v2::{Audience, ContentKind};
use forge_core::user_error::{codes, UserError};

use super::inline::{read_body_file, InlineSpec};
use super::{estimate, patch, Est};
use crate::common::Session;
use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, safe, short};
use crate::{PrCommentArgs, PrReviewArgs, VerdictArg};

/// One comment of a draft.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftComment {
    /// Where and what.
    #[serde(flatten)]
    pub spec: InlineSpec,
    /// Its signed create, saved before the first broadcast.
    #[serde(default)]
    pub intent: Option<WriteIntent>,
    /// Its document id once it landed.
    #[serde(default)]
    pub landed_id: Option<String>,
}

/// A pending review (one per network, repo, PR and identity).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDraft {
    /// The PR's `$id`.
    pub pr_id: String,
    /// The PR number (for messages).
    pub pr_number: u32,
    /// The head the comments are anchored to (the PR head when the draft was started).
    pub head_oid: String,
    /// The verdict, once a submit began (1 approve, 2 request changes, 3 comment).
    #[serde(default)]
    pub verdict: Option<u64>,
    /// The summary.
    #[serde(default)]
    pub summary: String,
    /// The inline comments, in order.
    pub comments: Vec<DraftComment>,
    /// The review's signed create, saved before its first broadcast. Its presence means a
    /// submit is under way: the verdict, summary and comments are then fixed.
    #[serde(default)]
    pub review_intent: Option<WriteIntent>,
    /// The review's id once it landed.
    #[serde(default)]
    pub review_id: Option<String>,
    /// Not public (members-only, or in a private repository): the review and its inline
    /// comments are for the repository's members, and this draft is stored sealed
    /// ([`DraftFile`]). Its JSON name is kept for drafts already on disk.
    #[serde(default)]
    pub members: bool,
}

impl From<&InlineSpec> for DraftComment {
    fn from(spec: &InlineSpec) -> Self {
        Self {
            spec: spec.clone(),
            intent: None,
            landed_id: None,
        }
    }
}

impl ReviewDraft {
    /// An empty draft on `view`'s current head.
    fn new(view: &PatchView) -> Self {
        Self {
            pr_id: view.patch.document_id.clone(),
            pr_number: view.patch.number,
            head_oid: view.head.clone(),
            verdict: None,
            summary: String::new(),
            comments: Vec::new(),
            review_intent: None,
            review_id: None,
            members: false,
        }
    }

    /// Add the command's summary (when given) and inline comments.
    fn add_args(&mut self, a: &PrReviewArgs) -> Result<()> {
        if a.inline.summary_given() {
            self.summary = a.inline.summary_text()?;
        }
        self.comments
            .extend(a.inline.comments.iter().map(DraftComment::from));
        Ok(())
    }

    /// A submit has begun (something may be on chain).
    pub fn attempted(&self) -> bool {
        self.review_intent.is_some()
    }

    /// Documents already on chain.
    pub fn landed(&self) -> usize {
        usize::from(self.review_id.is_some())
            + self
                .comments
                .iter()
                .filter(|c| c.landed_id.is_some())
                .count()
    }
}

/// Where the draft of `pr` by `identity` lives.
fn draft_path(network: &str, repo_id: &str, pr_id: &str, identity: &str) -> Result<PathBuf> {
    Ok(default_journal_dir()?
        .join("reviews")
        .join(format!("{network}-{repo_id}-{pr_id}-{identity}.json")))
}

/// A members-only draft on disk: the draft's JSON sealed under the repository's members key.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SealedDraft {
    /// The format (1).
    dash_forge_members_review_draft: u32,
    /// The sealed draft (DFPK, hex).
    sealed: String,
}

/// Where a draft lives and, for one that is not public, the key it is sealed under.
struct DraftFile {
    path: PathBuf,
    /// The members' write keys a draft that is not public is sealed under; `None` for a
    /// public draft.
    keys: Option<forge_core::private::EpochKeys>,
}

impl DraftFile {
    /// Save `draft`: in the clear when public, else sealed (and refused without the key).
    fn save(&self, draft: &ReviewDraft) -> std::io::Result<()> {
        if !draft.members {
            return save_draft(&self.path, &serde_json::to_vec_pretty(draft)?);
        }
        let keys = self.keys.as_ref().ok_or_else(|| {
            std::io::Error::other("a members-only review is never saved without its key")
        })?;
        let plain = zeroize::Zeroizing::new(serde_json::to_vec(draft)?);
        let sealed = forge_core::private::pack::seal(keys, &plain)
            .map_err(|_| std::io::Error::other("the members-only review could not be encrypted"))?;
        let file = SealedDraft {
            dash_forge_members_review_draft: 1,
            sealed: hex::encode(sealed),
        };
        save_draft(&self.path, &serde_json::to_vec_pretty(&file)?)
    }
}

/// A draft file as stored: the draft itself, or a members-only one sealed.
enum RawDraft {
    Plain(Vec<u8>),
    Sealed(Vec<u8>),
}

/// The draft file at `path`, as stored (`None`: there is none).
fn read_raw_draft(path: &Path) -> Result<Option<RawDraft>> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };
    Ok(Some(match serde_json::from_slice::<SealedDraft>(&bytes) {
        Ok(f) => RawDraft::Sealed(hex::decode(&f.sealed).with_context(|| unreadable(path))?),
        Err(_) => RawDraft::Plain(bytes),
    }))
}

fn unreadable(path: &Path) -> String {
    format!(
        "reading the pending review {} (delete it to start over)",
        path.display()
    )
}

/// The draft at `path`: a public one as it is, a members-only one opened with `open` (the
/// reviewer's keys).
fn decode_draft(
    path: &Path,
    raw: RawDraft,
    open: impl FnOnce(&[u8]) -> Result<Vec<u8>>,
) -> Result<ReviewDraft> {
    let plain = zeroize::Zeroizing::new(match raw {
        RawDraft::Plain(b) => b,
        RawDraft::Sealed(sealed) => open(&sealed).with_context(|| {
            format!(
                "opening your members-only pending review (`--discard` drops it): {}",
                path.display()
            )
        })?,
    });
    serde_json::from_slice(&plain).with_context(|| unreadable(path))
}

/// The draft at `path`: a public one as it is, a members-only one opened with the signer's keys
/// of `repo` (read through `collab`, only for a sealed file).
async fn load_draft(
    path: &Path,
    collab: &Collab<'_>,
    repo: &forge_core::scope::RepoRef,
) -> Result<Option<ReviewDraft>> {
    let Some(raw) = read_raw_draft(path)? else {
        return Ok(None);
    };
    let kr = match raw {
        RawDraft::Sealed(_) => Some(collab.keyring(repo).await?),
        RawDraft::Plain(_) => None,
    };
    decode_draft(path, raw, |sealed| {
        let kr = kr.ok_or_else(|| anyhow::anyhow!("no keys"))?;
        kr.open_pack(repo, sealed, sealed.len() as u64)
            .map_err(|_| anyhow::anyhow!("it does not open with your keys"))
    })
    .map(Some)
}

/// Save `bytes` atomically (write + rename), created readable by the user only.
fn save_draft(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    let mut open = std::fs::OpenOptions::new();
    open.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open.mode(0o600);
    }
    let mut f = open.open(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    std::fs::rename(&tmp, path)
}

#[allow(clippy::needless_pass_by_value)] // the shape `map_err` hands over
fn io_core(e: std::io::Error) -> forge_core::Error {
    forge_core::Error::Io(format!("saving the pending review: {e}"))
}

/// The anchor an inline comment is written with.
fn draft_anchor(spec: &InlineSpec, head: &[u8], review_id: Option<&str>) -> CommentAnchor {
    CommentAnchor {
        reply_to: None,
        commit_oid: Some(head.to_vec()),
        path: Some(spec.path.clone()),
        line: spec.line,
        side: spec.side.map(super::inline::SideArg::code),
        start_line: spec.start_line,
        review_id: review_id.map(str::to_string),
        diff_hunk: None,
    }
}

/// The PR author's own approve or request changes never counts (`count_approvals`; GitHub:
/// authors can't approve their own PR), so it is refused before anything is paid for; a
/// comment-only review is fine. The web offers the author only that one.
fn refuse_own_verdict(
    v: VerdictArg,
    author: &str,
    signer: &str,
    repo: &str,
    number: u64,
) -> Result<()> {
    if matches!(v, VerdictArg::Comment) || author != signer {
        return Ok(());
    }
    Err(UserError::new(
        codes::USAGE,
        format!("you opened PR #{number}: your own approval or request for changes never counts"),
    )
    .cause("Forge clients never count the PR author's own verdict (as on GitHub, authors can't approve their own PR)")
    .fix(format!(
        "leave a comment-only review (`dg pr review {repo} {number} --comment`), or ask another member to review"
    ))
    .note("checked before anything was signed; nothing was written or paid")
    .into())
}

/// The verdict of `dg pr review`'s flags, or `None` when none was given.
fn verdict_of(a: &PrReviewArgs) -> Result<Option<VerdictArg>> {
    let given: Vec<VerdictArg> = [
        (a.approve, VerdictArg::Approve),
        (a.request_changes, VerdictArg::RequestChanges),
        (a.comment, VerdictArg::Comment),
    ]
    .into_iter()
    .filter_map(|(on, v)| on.then_some(v))
    .chain(a.verdict)
    .collect();
    match given.as_slice() {
        [] => Ok(None),
        [one] => Ok(Some(*one)),
        _ => Err(crate::errors::usage(
            "pass exactly one of --approve, --request-changes or --comment",
        )),
    }
}

/// What the flags ask for.
enum Mode {
    Pending,
    Discard,
    Submit(Option<VerdictArg>),
}

/// `dg pr review`.
pub async fn review(ctx: &Ctx, a: &PrReviewArgs) -> Result<()> {
    let mode = if a.pending {
        Mode::Pending
    } else if a.discard {
        Mode::Discard
    } else {
        let v = verdict_of(a)?;
        if v.is_none() && !a.resume {
            return Err(UserError::new(codes::USAGE, "no verdict given")
                .fix("pass --approve, --request-changes or --comment to submit a review")
                .fix("pass --pending to add the comments to your pending review without writing anything")
                .into());
        }
        Mode::Submit(v)
    };
    if matches!(mode, Mode::Submit(_)) {
        ctx.require_confirmable("`dg pr review`")?;
    }
    let s = Session::open_for_write(ctx, &a.repo, "review not posted").await?;
    let collab = s.collab();
    let p = patch(&collab, &s.repo, &a.repo, a.number).await?;
    let view = collab.patch_view(&s.repo, p).await?;
    let me = s.identity.id();
    let path = draft_path(
        &ctx.network_label(),
        s.repo.id(),
        &view.patch.document_id,
        &me,
    )?;
    let existing = match load_draft(&path, &collab, &s.repo).await {
        Ok(d) => d,
        // a members-only draft this identity can no longer open is still thrown away
        Err(e) if matches!(mode, Mode::Discard) && path.exists() => {
            tracing::warn!(error = %e, "the pending review could not be read; removing it");
            None
        }
        Err(e) => return Err(e),
    };
    if let Mode::Discard = mode {
        if existing.is_none() && path.exists() {
            std::fs::remove_file(&path).with_context(|| format!("removing {}", path.display()))?;
            ctx.emit(
                json!({ "status": "discarded", "pr": a.number, "discarded": null }),
                || {
                    println!(
                        "✓ discarded the pending review on PR #{} (it could not be read)",
                        a.number
                    );
                },
            );
            return Ok(());
        }
        return discard(ctx, &path, existing, a.number);
    }
    // Who the review is for: what `--members` (or a members-only draft) asks, else the PR's
    // (every review of a private repository is for its members). Refused here when it cannot
    // be written; a draft that is not public is kept sealed, never in the clear.
    let asked = a.members || existing.as_ref().is_some_and(|d| d.members);
    let audience =
        crate::audience::requested(&collab, &s.repo, asked, Some(&view.patch.document_id), None)
            .await?;
    let sealed = audience != Audience::Public;
    if let Some(d) = existing
        .as_ref()
        .filter(|d| d.attempted() && d.members != sealed)
    {
        return Err(refuse_attempted(d, &a.repo, a.number));
    }
    let keys = if sealed {
        let kr = collab.keyring(&s.repo).await?;
        Some(
            if s.repo.visibility == forge_core::rules::v2::Visibility::Private {
                kr.writer(&s.repo)?.write_keys().clone()
            } else {
                kr.lane(&s.repo)?.write_keys().clone()
            },
        )
    } else {
        None
    };
    let file = DraftFile { path, keys };
    let shown = Shown {
        repo: &s.repo,
        audience,
    };
    match mode {
        Mode::Discard => unreachable!("handled above"),
        Mode::Pending => pending(ctx, a, &view, &file, existing, shown),
        Mode::Submit(v) => submit(ctx, a, (&s, &collab), &view, &file, existing, v, shown).await,
    }
}

/// Who a review is for, and the repository it is in: what its output names.
#[derive(Clone, Copy)]
struct Shown<'r> {
    repo: &'r forge_core::scope::RepoRef,
    audience: Audience,
}

impl Shown<'_> {
    /// Stored sealed (members-only, or any review of a private repository).
    fn sealed(self) -> bool {
        self.audience != Audience::Public
    }

    /// "members-only " before a noun in a public repository, else "".
    fn prefix(self) -> &'static str {
        crate::audience::prefix(self.repo, self.audience)
    }

    /// Members-only in a public repository (what is worth saying).
    fn marked(self) -> bool {
        crate::audience::marked(self.repo, self.audience)
    }
}

fn discard(ctx: &Ctx, path: &Path, draft: Option<ReviewDraft>, number: u64) -> Result<()> {
    let Some(d) = draft else {
        ctx.emit(
            json!({ "status": "no_pending_review", "pr": number, "discarded": 0 }),
            || println!("no pending review on PR #{number}"),
        );
        return Ok(());
    };
    std::fs::remove_file(path).with_context(|| format!("removing {}", path.display()))?;
    let note = d.attempted().then(|| {
        format!(
            "{} of its {} documents were already on chain and stay there",
            d.landed(),
            1 + d.comments.len()
        )
    });
    ctx.emit(
        json!({
            "status": "discarded",
            "pr": number,
            "discarded": d.comments.len(),
            "landed": d.landed(),
            "reviewId": d.review_id,
        }),
        || {
            println!(
                "✓ discarded the pending review on PR #{number} ({} comments)",
                d.comments.len()
            );
            if let Some(n) = &note {
                println!("  note: {n}");
            }
        },
    );
    Ok(())
}

fn refuse_attempted(d: &ReviewDraft, repo: &str, number: u64) -> anyhow::Error {
    UserError::new(
        codes::USAGE,
        format!(
            "PR #{number} has a review submit under way ({} of {} documents written)",
            d.landed(),
            1 + d.comments.len()
        ),
    )
    .cause("its verdict, summary and comments are fixed once it has begun, so nothing is written twice")
    .fix(format!("finish it: `dg pr review {repo} {number} --resume`"))
    .fix(format!(
        "drop what is not written yet: `dg pr review {repo} {number} --discard`"
    ))
    .note("nothing was written")
    .into()
}

fn pending(
    ctx: &Ctx,
    a: &PrReviewArgs,
    view: &PatchView,
    file: &DraftFile,
    existing: Option<ReviewDraft>,
    shown: Shown<'_>,
) -> Result<()> {
    if let Some(d) = existing.as_ref().filter(|d| d.attempted()) {
        return Err(refuse_attempted(d, &a.repo, a.number));
    }
    let path = &file.path;
    let mut draft = existing.unwrap_or_else(|| ReviewDraft::new(view));
    draft.members = shown.sealed();
    draft.add_args(a)?;
    file.save(&draft)
        .with_context(|| format!("saving {}", path.display()))?;
    let moved = draft.head_oid != view.head;
    ctx.emit(
        json!({
            "status": "pending",
            "pr": a.number,
            "added": a.inline.comments.len(),
            "comments": draft.comments.iter().map(|c| {
                let mut j = spec_json(&c.spec);
                j["body"] = json!(c.spec.body);
                j
            }).collect::<Vec<_>>(),
            "anchoredTo": draft.head_oid,
            "headMoved": moved,
            "audience": crate::audience::json(shown.audience),
            "encrypted": shown.sealed(),
            "draftFile": path.display().to_string(),
        }),
        || {
            println!(
                "✓ pending {}review on PR #{}: {}, kept on this machine{} until you submit",
                shown.prefix(),
                a.number,
                crate::fmt::plural(draft.comments.len(), "comment"),
                if shown.sealed() { " (encrypted)" } else { "" }
            );
            for c in &draft.comments {
                println!("  {}  {}", c.spec.location(), first_line(&c.spec.body));
            }
            println!(
                "  submit: dg pr review {} {} --approve | --request-changes | --comment [--body …]",
                a.repo, a.number
            );
            if moved {
                println!(
                    "  note: the PR moved to {} since you started; these comments are anchored to {} and will show as outdated",
                    short(&view.head),
                    short(&draft.head_oid)
                );
            }
        },
    );
    Ok(())
}

/// An inline comment's anchor for `--json`: `path`, `line`, `startLine`, `side`, `location`.
fn spec_json(spec: &InlineSpec) -> serde_json::Value {
    json!({
        "path": spec.path,
        "line": spec.line,
        "startLine": spec.start_line,
        "side": spec.side.map(super::inline::SideArg::code),
        "location": spec.location(),
    })
}

fn first_line(s: &str) -> String {
    let l = s.lines().next().unwrap_or("");
    let l = safe(l);
    if l.chars().count() > 60 {
        format!("{}…", l.chars().take(60).collect::<String>())
    } else {
        l.into_owned()
    }
}

/// The documents a submit writes and their estimate (review-parity §6: review 34.9M, comment
/// 47.3M, each + 27.5k per text byte).
fn submit_estimate(d: &ReviewDraft) -> u64 {
    let pending: u64 = d
        .comments
        .iter()
        .filter(|c| c.landed_id.is_none())
        .map(|c| estimate(Est::Comment, c.spec.body.len() + c.spec.path.len()))
        .sum();
    let review = if d.review_id.is_none() {
        estimate(Est::Review, d.summary.len())
    } else {
        0
    };
    review + pending
}

/// A resumed submit given the same command again: the same verdict, summary and comments are
/// a resume; anything else is refused.
fn same_submit(d: &ReviewDraft, verdict: Option<VerdictArg>, a: &PrReviewArgs) -> Result<bool> {
    let summary_given = a.inline.summary_given();
    if a.resume && verdict.is_none() && !summary_given && a.inline.comments.is_empty() {
        return Ok(true);
    }
    let verdict_same = verdict.is_none_or(|v| Some(v.code()) == d.verdict);
    let summary_same = !summary_given || a.inline.summary_text()? == d.summary;
    // Re-running the same command repeats its --file flags: they are the draft's last ones.
    let given = &a.inline.comments;
    let comments_same = given.is_empty()
        || (given.len() <= d.comments.len()
            && d.comments[d.comments.len() - given.len()..]
                .iter()
                .zip(given)
                .all(|(c, g)| &c.spec == g));
    Ok(verdict_same && summary_same && comments_same)
}

#[allow(
    clippy::too_many_lines,
    clippy::many_single_char_names,
    clippy::too_many_arguments
)]
async fn submit(
    ctx: &Ctx,
    a: &PrReviewArgs,
    (s, collab): (&Session, &Collab<'_>),
    view: &PatchView,
    file: &DraftFile,
    existing: Option<ReviewDraft>,
    verdict: Option<VerdictArg>,
    shown: Shown<'_>,
) -> Result<()> {
    let path = &file.path;
    let resumed = existing.as_ref().is_some_and(ReviewDraft::attempted);
    let mut draft = match existing {
        Some(d) if d.attempted() => {
            if !same_submit(&d, verdict, a)? {
                return Err(refuse_attempted(&d, &a.repo, a.number));
            }
            d
        }
        // A pending draft (or none): this submit's verdict, summary and comments are added.
        pending => {
            let v = verdict.ok_or_else(|| {
                crate::errors::usage(format!(
                    "PR #{} has no interrupted review to resume: pass --approve, --request-changes or --comment",
                    a.number
                ))
            })?;
            refuse_own_verdict(v, &view.patch.author, &s.identity.id(), &a.repo, a.number)?;
            let mut d = pending.unwrap_or_else(|| ReviewDraft::new(view));
            d.verdict = Some(v.code());
            d.members = shown.sealed();
            d.add_args(a)?;
            d
        }
    };
    // A locked PR takes reviews from members only (`lockGate`): refused before the prompt.
    collab
        .require_unlocked_or_member(&s.repo, &view.patch.document_id)
        .await?;
    // A member's approve / request changes is written as 1 / 2 (with its proof), anyone
    // else's as 4 / 5: shown, never counted (RC1 `member_verdicts`).
    let v = collab
        .verdict_for(&s.repo, Verdict::from_code(draft.verdict.unwrap_or(3)))
        .await?;
    let n = draft.comments.len();
    let count = u16::try_from(n)
        .map_err(|_| crate::errors::usage("a review holds at most 65535 comments"))?;
    let head = hex::decode(&draft.head_oid).context("the draft's head oid")?;
    // Validate every document before anything is signed.
    review_props(
        &draft.pr_id,
        v,
        &head,
        &draft.summary,
        (n > 0).then_some(count),
        None,
    )?;
    for c in &draft.comments {
        comment_props(
            &draft.pr_id,
            &c.spec.body,
            Some(&draft_anchor(&c.spec, &head, Some(&draft.pr_id))),
            None,
        )?;
    }
    let price = ctx.usd_price();
    let todo = 1 + n - draft.landed();
    let est = submit_estimate(&draft);
    let moved = draft.head_oid != view.head;
    if !ctx.json {
        // What the question below asks about. With --yes nothing is asked, and the ✓ line
        // after the write says the same (QW4-065: the review printed twice).
        if !ctx.yes {
            eprintln!(
                "{} {}review on PR #{} at {}: {}",
                v.label(),
                shown.prefix(),
                a.number,
                short(&draft.head_oid),
                crate::fmt::plural(n, "inline comment")
            );
        }
        if moved {
            eprintln!(
                "  note: the PR moved to {} since this review was started; it is recorded on {} and will read as stale",
                short(&view.head),
                short(&draft.head_oid)
            );
        }
    }
    ctx.confirm_or_cancel(&format!(
        "{}{}, {}. Submit?",
        if resumed {
            "Finish the interrupted submit: "
        } else {
            ""
        },
        crate::fmt::plural(todo, "write"),
        cost_line(est, price)
    ))?;

    let before = s.balance().await;
    // Not saved here: the first save is the one that records the review's signed transition
    // (`write_all`). Until then the file keeps what `--pending` saved, so a submit that fails
    // before anything was signed can be run again as it was, without adding its comments twice.
    let result = write_all(collab, s, &mut draft, file, &head, v, count).await;
    let spent = s.spent_since(before).await;
    let landed = draft.landed();
    let comments_json: Vec<_> = draft
        .comments
        .iter()
        .map(|c| {
            json!({
                "id": c.landed_id,
                "path": c.spec.path,
                "line": c.spec.line,
                "startLine": c.spec.start_line,
                "side": c.spec.side.map(super::inline::SideArg::code),
                "location": c.spec.location(),
            })
        })
        .collect();
    let body = json!({
        "status": if result.is_ok() { "reviewed" } else { "partial" },
        "pr": a.number,
        "verdict": v.code(),
        "verdictLabel": v.label(),
        "audience": crate::audience::json(shown.audience),
        "commitOid": draft.head_oid,
        "reviewId": draft.review_id,
        "comments": comments_json,
        "documents": 1 + n,
        "landed": landed,
        "failed": 1 + n - landed,
        "resumed": resumed,
        "cost": cost_json(spent, price),
    });
    if let Err(e) = result {
        let u = forge_core::user_error::classify(
            e.chain(),
            &forge_core::user_error::ErrorContext {
                goal: Some("review not fully submitted"),
                repo: Some(&a.repo),
                ..Default::default()
            },
        );
        let recorded = if draft.review_id.is_some() {
            format!(
                "your {} review is recorded with {} of {n} comments; the rest are kept in your pending review",
                v.label(),
                landed - 1
            )
        } else {
            "nothing was recorded yet; the review is kept in your pending review".to_string()
        };
        return Err(crate::errors::reported(
            u.note(recorded).fix(format!(
                "run the same command again (or `dg pr review {} {} --resume`) to finish: nothing is written twice",
                a.repo, a.number
            )),
            body,
        ));
    }
    let _ = std::fs::remove_file(path);
    // Approvals count only from approvers (maintainers and role-1 writers): a triage member's
    // or reader's verdict is recorded, not counted (RC2 member roles).
    let role = collab.signer_role(&s.repo).await.unwrap_or(None);
    let counts = role.is_some_and(forge_core::rules::v2::Role::is_approver);
    let mut body = body;
    body["counts"] = json!(counts);
    ctx.emit(body, || {
        println!(
            "✓ {} PR #{} at {}{} · {} · {}",
            v.label(),
            a.number,
            short(&draft.head_oid),
            if resumed { " (finished an interrupted submit)" } else { "" },
            crate::fmt::plural(n, "inline comment"),
            cost_line(spent, price)
        );
        if shown.marked() {
            println!("  review text visible to members; the verdict counts for everyone");
        }
        for c in &draft.comments {
            println!(
                "  {}  {}",
                c.spec.location(),
                c.landed_id.as_deref().map_or("", short)
            );
        }
        if !counts && v != Verdict::Comment {
            match role {
                Some(r) => println!("  note: your role here is {r}: recorded, not counted"),
                None => println!(
                    "  note: you are not a member of {}, so this review does not count toward approvals",
                    s.repo.display()
                ),
            }
        }
    });
    Ok(())
}

/// Write the review, then each comment, saving the draft around every write.
async fn write_all(
    collab: &Collab<'_>,
    s: &Session,
    draft: &mut ReviewDraft,
    file: &DraftFile,
    head: &[u8],
    v: Verdict,
    count: u16,
) -> Result<()> {
    #[cfg(debug_assertions)]
    let fail_after: Option<usize> = std::env::var("DASH_FORGE_TEST_FAIL_AFTER_DOCS")
        .ok()
        .and_then(|n| n.parse().ok());
    #[cfg(debug_assertions)]
    let check = |d: &ReviewDraft| -> Result<()> {
        if fail_after.is_some_and(|n| d.landed() >= n) {
            anyhow::bail!(
                "simulated interruption after {} documents (DASH_FORGE_TEST_FAIL_AFTER_DOCS)",
                d.landed()
            );
        }
        Ok(())
    };
    #[cfg(not(debug_assertions))]
    let check = |_: &ReviewDraft| -> Result<()> { Ok(()) };

    if draft.review_id.is_none() {
        let props = review_props(
            &draft.pr_id,
            v,
            head,
            &draft.summary,
            (count > 0).then_some(count),
            None,
        )?;
        let saved = draft.review_intent.clone();
        let id = collab
            .create_once(
                &s.repo,
                ContentKind::Review,
                props,
                saved.as_ref(),
                |intent| {
                    draft.review_intent = Some(intent.clone());
                    file.save(draft).map_err(io_core)
                },
            )
            .await?;
        draft.review_id = Some(id);
        file.save(draft)?;
    }
    let review_id = draft.review_id.clone().expect("set above");
    for i in 0..draft.comments.len() {
        check(draft)?;
        if draft.comments[i].landed_id.is_some() {
            continue;
        }
        let spec = draft.comments[i].spec.clone();
        let props = comment_props(
            &draft.pr_id,
            &spec.body,
            Some(&draft_anchor(&spec, head, Some(&review_id))),
            None,
        )?;
        let saved = draft.comments[i].intent.clone();
        let id = collab
            .create_once(
                &s.repo,
                ContentKind::Comment,
                props,
                saved.as_ref(),
                |intent| {
                    draft.comments[i].intent = Some(intent.clone());
                    file.save(draft).map_err(io_core)
                },
            )
            .await?;
        draft.comments[i].landed_id = Some(id);
        file.save(draft)?;
    }
    Ok(())
}

/// `dg pr comment`.
#[allow(clippy::too_many_lines)]
pub async fn comment(ctx: &Ctx, a: &PrCommentArgs) -> Result<()> {
    let body = match (&a.body, &a.body_file) {
        (Some(b), _) => b.clone(),
        (None, Some(p)) => read_body_file(p)?,
        (None, None) if a.suggest.is_some() => String::new(),
        (None, None) => return Err(crate::errors::usage("pass --body or --body-file")),
    };
    // An inline comment is checked by the same rules as `dg pr review --file`; its body gains
    // the suggestion block.
    let (spec, body) = match &a.file {
        Some(file) => {
            let spec = InlineSpec::build(
                file.clone(),
                a.line,
                a.start_line,
                a.side,
                body,
                a.suggest.as_deref(),
            )
            .map_err(crate::errors::usage)?;
            let body = spec.body.clone();
            (Some(spec), body)
        }
        None if a.suggest.is_some() => {
            return Err(crate::errors::usage("--suggest needs --file and --line"))
        }
        None if body.trim().is_empty() => {
            return Err(crate::errors::usage("the comment needs a --body"))
        }
        None => (None, body),
    };
    let s = Session::open_for_write(ctx, &a.repo, "comment not posted").await?;
    let collab = s.collab();
    let p = patch(&collab, &s.repo, &a.repo, a.number).await?;
    let view = collab.patch_view(&s.repo, p).await?;
    let head = hex::decode(&view.head).context("PR head oid")?;
    // A reply names its thread's root (RC1 `reply_thread`: a reply to a reply is refused), so
    // `--reply-to` any comment of a thread replies to the thread.
    let (anchor, kind) = if let Some(reply) = &a.reply_to {
        let (comments, sealed, _) = collab
            .comments_read(&s.repo, &view.patch.document_id)
            .await?;
        let Some(root) = super::threads::root_id(&comments, reply) else {
            // a members-only comment this signer cannot open: its thread is members-only
            if sealed.iter().any(|m| m.document_id == *reply) {
                return Err(crate::audience::members_only_thread(&s.repo));
            }
            return Err(crate::errors::not_found(
                format!("comment {reply} is not on PR #{}", a.number),
                format!(
                    "`dg pr view {} {} --comments` lists its comments",
                    a.repo, a.number
                ),
            ));
        };
        (
            Some(CommentAnchor {
                reply_to: Some(root),
                ..CommentAnchor::default()
            }),
            "reply",
        )
    } else if let Some(spec) = &spec {
        (Some(draft_anchor(spec, &head, None)), "inline")
    } else {
        (None, "general")
    };
    let price = ctx.usd_price();
    let path_len = spec.as_ref().map_or(0, |s| s.path.len());
    // Who it is for: the PR's, the comment replied to and its thread root's, as the write reads
    // them (DESIGN §3.3); `--reply-to` names any comment of the thread.
    // `--members` asks for members-only; refused here, before the price, when it cannot be.
    let audience = crate::audience::requested(
        &collab,
        &s.repo,
        a.members,
        Some(&view.patch.document_id),
        a.reply_to.as_deref(),
    )
    .await?;
    // A body longer than the field is stored as a repository artifact (forge-v2.md §6.3).
    let planned = crate::long_body::Planned::new(
        &s.repo,
        forge_core::collab::long_body::BodyField::Comment {
            path: spec.as_ref().map(|s| s.path.as_str()),
        },
        None,
        &body,
        audience,
    )?;
    let field_bytes = usize::try_from(planned.field_bytes()).unwrap_or(usize::MAX);
    let est = estimate(Est::Comment, field_bytes + path_len) + planned.extra_credits(&s.repo);
    ctx.confirm_or_cancel(&format!(
        "Post a {}{kind} comment on PR #{}? (one document, {}{})",
        crate::audience::prefix(&s.repo, audience),
        a.number,
        cost_line(est, price),
        planned.clause()
    ))?;
    let body = planned.field_text(&collab, &s.repo, None).await?;
    let id = collab
        .comment(
            &s.repo,
            &view.patch.document_id,
            &body,
            anchor.as_ref(),
            None,
        )
        .await?;
    let location = spec.as_ref().map(InlineSpec::location);
    ctx.emit(
        json!({
            "status": "commented",
            "pr": a.number,
            "commentId": id,
            "kind": kind,
            "audience": crate::audience::json(audience),
            "replyTo": anchor.as_ref().and_then(|a| a.reply_to.as_ref()),
            "location": location,
            "commitOid": (kind == "inline").then(|| view.head.clone()),
        }),
        || {
            println!(
                "✓ commented on PR #{}{} ({}){}",
                a.number,
                location
                    .as_deref()
                    .map(|l| format!(" at {l}"))
                    .unwrap_or_default(),
                short(&id),
                crate::audience::suffix(&s.repo, audience)
            );
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pr::inline::SideArg;

    #[test]
    fn the_author_cannot_approve_or_request_changes_on_their_own_pr() {
        for v in [VerdictArg::Approve, VerdictArg::RequestChanges] {
            let e = refuse_own_verdict(v, "alice", "alice", "o/r", 3).unwrap_err();
            let text = format!("{e:#}");
            assert!(text.contains("your own approval"), "{text}");
            assert!(refuse_own_verdict(v, "alice", "bob", "o/r", 3).is_ok());
        }
        // A comment-only review by the author is fine.
        assert!(refuse_own_verdict(VerdictArg::Comment, "alice", "alice", "o/r", 3).is_ok());
    }

    fn spec(path: &str, line: u64) -> InlineSpec {
        InlineSpec {
            path: path.into(),
            line: Some(line),
            start_line: None,
            side: Some(SideArg::New),
            body: "b".into(),
        }
    }

    fn draft(n: usize) -> ReviewDraft {
        ReviewDraft {
            pr_id: "p".into(),
            pr_number: 1,
            head_oid: "a".repeat(40),
            verdict: Some(2),
            summary: "s".into(),
            comments: (0..n)
                .map(|i| DraftComment {
                    spec: spec("f", i as u64 + 1),
                    intent: None,
                    landed_id: None,
                })
                .collect(),
            review_intent: None,
            review_id: None,
            members: false,
        }
    }

    #[test]
    fn a_draft_round_trips_and_counts_what_landed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("d.json");
        let mut d = draft(3);
        d.review_id = Some("r".into());
        d.comments[0].landed_id = Some("c0".into());
        let file = DraftFile {
            path: path.clone(),
            keys: None,
        };
        file.save(&d).unwrap();
        let back = load_plain(&path).unwrap();
        assert_eq!(back.landed(), 2);
        assert_eq!(back.comments[1].spec, spec("f", 2));
        assert!(read_raw_draft(&dir.path().join("none.json"))
            .unwrap()
            .is_none());
    }

    /// The draft of a public review, read back as it was saved.
    fn load_plain(path: &Path) -> Option<ReviewDraft> {
        let raw = read_raw_draft(path).unwrap()?;
        Some(decode_draft(path, raw, |_| anyhow::bail!("not sealed")).unwrap())
    }

    /// A members-only draft is never on disk in the clear: the file holds it sealed under the
    /// members key, opens with that key, and is refused without one.
    #[test]
    fn a_members_only_draft_is_stored_sealed() {
        use forge_core::private::{EpochKey, EpochResolution, Lane};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("m.json");
        let mut res = EpochResolution::default();
        res.keys.insert(0, EpochKey::from_bytes([5; 32]));
        res.write_epoch = Some(0);
        let lane = Lane::from_resolution(&[9; 32], &res).unwrap();
        let keys = lane.write_keys().clone();
        let mut d = draft(2);
        d.members = true;
        d.summary = "SECRET-MEMBERS-SUMMARY".into();
        d.comments[0].spec.body = "SECRET-MEMBERS-COMMENT".into();
        DraftFile {
            path: path.clone(),
            keys: Some(keys),
        }
        .save(&d)
        .unwrap();
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(!on_disk.contains("SECRET-MEMBERS"), "{on_disk}");
        assert!(on_disk.contains("dashForgeMembersReviewDraft"));
        let lane = Lane::from_resolution(&[9; 32], &res).unwrap();
        let raw = read_raw_draft(&path).unwrap().unwrap();
        let back = decode_draft(&path, raw, |sealed| {
            Ok(lane.open_artifact(sealed, sealed.len() as u64)?)
        })
        .unwrap();
        assert!(back.members);
        assert_eq!(back.summary, "SECRET-MEMBERS-SUMMARY");
        assert_eq!(back.comments[0].spec.body, "SECRET-MEMBERS-COMMENT");
        // without the key it is not read (and not mistaken for a public draft)
        let raw = read_raw_draft(&path).unwrap().unwrap();
        assert!(decode_draft(&path, raw, |_| anyhow::bail!("no key")).is_err());
        // and without a key it is never saved in the clear
        let keyless = DraftFile {
            path: dir.path().join("k.json"),
            keys: None,
        };
        assert!(keyless.save(&d).is_err());
        assert!(!dir.path().join("k.json").exists());
    }

    /// A submit that fails before the review's transition is saved leaves the draft file as
    /// `--pending` left it, so running the same command again adds its `--file` comments once.
    #[test]
    fn a_failed_submit_before_signing_does_not_append_twice() {
        use clap::Parser;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("d.json");
        let pending = draft(1);
        DraftFile {
            path: path.clone(),
            keys: None,
        }
        .save(&pending)
        .unwrap();
        let cli = crate::Cli::parse_from([
            "dg",
            "pr",
            "review",
            "o/r",
            "1",
            "--request-changes",
            "--file",
            "g",
            "--line",
            "9",
            "--body",
            "new",
        ]);
        let crate::Command::Pr(crate::PrCommand::Review(a)) = cli.command else {
            panic!("expected pr review");
        };
        // What `submit` builds, twice (a run that failed before signing, then its re-run):
        // each starts from the file, which the failed run did not touch.
        for _ in 0..2 {
            let mut d = load_plain(&path).unwrap();
            assert!(!d.attempted());
            d.verdict = Some(2);
            d.add_args(&a).unwrap();
            assert_eq!(
                d.comments.len(),
                2,
                "the pending comment + the given one, once"
            );
        }
    }

    #[test]
    fn only_documents_still_to_write_are_estimated() {
        let mut d = draft(2);
        let full = submit_estimate(&d);
        d.review_id = Some("r".into());
        d.comments[0].landed_id = Some("c".into());
        assert!(submit_estimate(&d) < full);
        assert_eq!(
            submit_estimate(&d),
            estimate(Est::Comment, 1 + 1),
            "one comment of 1-byte body and 1-byte path left"
        );
    }
}
