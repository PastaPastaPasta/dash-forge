//! The one place a `dg` failure becomes output and an exit code (UX spec §7.3).
//!
//! Every subcommand returns `anyhow::Result`; `main` hands any error to [`report`], which
//! classifies it into a [`UserError`] (forge-core owns the mapping and the code table) and
//! prints either the human block on stderr or `{"error": …}` on stdout (`--json`), then
//! returns the exit code — the code's class digit.
//!
//! Commands that understand their own failure raise a [`UserError`] directly with the
//! helpers below (`usage`, `not_found`, …). A failing command that also has a result to
//! show (a doctor report, a storage test) returns [`Reported`]: its human output was
//! already printed, and in `--json` mode its result object is printed once, with the
//! `"error"` block merged in, so scripts get one document carrying both.

use forge_core::user_error::{self, codes, ErrorContext, UserError};
use serde_json::Value;

use crate::{
    CollabCommand, Command, CostCommand, IssueCommand, LabelCommand, MilestoneCommand, PrCommand,
    ReleaseCommand, RepoBackendCommand, RepoCommand, StorageCommand,
};

/// A failure with a result of its own: `body` is the command's `--json` object (printed
/// with `"error"` added), and the error block goes to stderr in human mode. The command
/// must not have emitted `body` itself. The exit code is the error's.
#[derive(Debug)]
pub struct Reported {
    /// The error.
    pub error: UserError,
    /// The command's JSON result.
    pub body: Value,
}

impl std::fmt::Display for Reported {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.error.fmt(f)
    }
}

impl std::error::Error for Reported {}

/// `error`, reported alongside the command's JSON result `body` (see [`Reported`]).
pub fn reported(error: UserError, body: Value) -> anyhow::Error {
    Reported { error, body }.into()
}

/// E201: arguments that do not work together.
pub fn usage(message: impl Into<String>) -> anyhow::Error {
    UserError::new(codes::USAGE, message)
        .fix("see `dg <command> --help`")
        .into()
}

/// E102: a named thing does not exist.
pub fn not_found(message: impl Into<String>, fix: impl Into<String>) -> anyhow::Error {
    UserError::new(codes::NOT_FOUND, message).fix(fix).into()
}

/// E803: the user said no at a prompt.
pub fn cancelled() -> anyhow::Error {
    UserError::new(codes::CANCELLED, "cancelled at the confirmation prompt")
        .note("nothing was written")
        .into()
}

/// Render `err` for the user and return the process exit code.
pub fn report(json: bool, err: &anyhow::Error, ctx: &ErrorContext<'_>) -> i32 {
    let (user, body) = match err.downcast_ref::<Reported>() {
        Some(r) => (r.error.clone(), Some(&r.body)),
        None => (user_error::classify(err.chain(), ctx), None),
    };
    if json {
        print_json(&with_error(body, &user));
    } else {
        user.eprint("");
    }
    user.exit_code()
}

/// `body` (an object) with the `"error"` block of `user` added; just the error without one.
fn with_error(body: Option<&Value>, user: &UserError) -> Value {
    let mut out = user.to_json();
    if let Some(Value::Object(fields)) = body {
        let error = out["error"].take();
        let mut merged = fields.clone();
        merged.insert("error".into(), error);
        out = Value::Object(merged);
    }
    out
}

/// Pretty-print a JSON value on stdout (the `--json` output of every command).
pub fn print_json(v: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(v).unwrap_or_else(|_| v.to_string())
    );
}

/// What the command was for: the headline lead ("issue not created") and the repo.
#[allow(clippy::too_many_lines)] // one arm per command
pub fn context_for(cmd: &Command) -> (Option<&'static str>, Option<&str>) {
    use CollabCommand as C;
    use IssueCommand as I;
    use PrCommand as P;
    use ReleaseCommand as R;
    use RepoCommand as Rp;
    use StorageCommand as S;
    let (goal, repo): (&'static str, Option<&String>) = match cmd {
        Command::Auth(a) => (a.context(), None),
        Command::Repo(Rp::Create(a)) => ("repository not created", a.name.as_ref()),
        Command::Init(a) => ("repository not published", a.name.as_ref()),
        Command::Repo(Rp::Clone { repo, .. }) => ("repository not cloned", Some(repo)),
        Command::Repo(Rp::View { repo }) => ("could not show the repository", Some(repo)),
        Command::Repo(Rp::Fork { repo, .. }) => ("repository not forked", Some(repo)),
        Command::Repo(Rp::Reindex { repo, .. }) => ("browse index not published", Some(repo)),
        Command::Repo(Rp::Star { repo, .. }) => ("repository not starred", Some(repo)),
        Command::Repo(Rp::Unstar { repo }) => ("star not removed", Some(repo)),
        Command::Repo(Rp::Watch { repo }) => ("repository not watched", Some(repo)),
        Command::Repo(Rp::Unwatch { repo }) => ("watch not removed", Some(repo)),
        Command::Repo(Rp::Topic { repo, .. }) => ("topics not changed", Some(repo)),
        Command::Repo(Rp::List { .. }) => ("could not list repositories", None),
        Command::Repo(Rp::Keys(crate::RepoKeysCommand::Status { repo })) => {
            ("could not read the repository's keys", Some(repo))
        }
        Command::Repo(Rp::Keys(crate::RepoKeysCommand::Repair { repo })) => {
            ("key not repaired", Some(repo))
        }
        Command::Repo(Rp::Keys(crate::RepoKeysCommand::Rotate { repo })) => {
            ("key not rotated", Some(repo))
        }
        Command::Repo(Rp::Backend(RepoBackendCommand::Set { repo, .. })) => {
            ("backend not changed", Some(repo))
        }
        Command::Repo(Rp::Edit(a)) => ("repository not edited", Some(&a.repo)),
        Command::Repo(Rp::Protect(crate::RepoProtectCommand::List { repo })) => {
            ("could not read the protected branches", Some(repo))
        }
        Command::Repo(Rp::Protect(
            crate::RepoProtectCommand::Add { repo, .. }
            | crate::RepoProtectCommand::Remove { repo, .. },
        )) => ("protection not changed", Some(repo)),
        Command::Repo(Rp::Policy(crate::RepoPolicyCommand::Show { repo })) => {
            ("could not read the branch policy", Some(repo))
        }
        Command::Repo(Rp::Policy(crate::RepoPolicyCommand::Set(a))) => {
            ("branch policy not set", Some(&a.repo))
        }
        Command::Repo(Rp::Archive { repo }) => ("repository not archived", Some(repo)),
        Command::Repo(Rp::Unarchive { repo }) => ("repository not unarchived", Some(repo)),
        Command::Issue(I::List(a)) => ("could not read issues", Some(&a.repo)),
        Command::Issue(I::View { repo, .. }) => ("could not read issues", Some(repo)),
        Command::Issue(I::Assign { repo, .. } | I::Unassign { repo, .. }) => {
            ("assignees not changed", Some(repo))
        }
        Command::Issue(I::Create { repo, .. }) => ("issue not created", Some(repo)),
        Command::Issue(I::Comment { repo, .. }) => ("comment not posted", Some(repo)),
        Command::Issue(I::Close { repo, .. }) => ("issue not closed", Some(repo)),
        Command::Issue(I::Pin { repo, .. }) => ("pin not changed", Some(repo)),
        Command::Issue(I::Lock { repo, .. }) => ("lock not changed", Some(repo)),
        Command::Milestone(MilestoneCommand::List { repo }) => {
            ("could not list milestones", Some(repo))
        }
        Command::Issue(I::Milestone { repo, .. })
        | Command::Milestone(
            MilestoneCommand::Create { repo, .. } | MilestoneCommand::Close { repo, .. },
        ) => ("milestone not changed", Some(repo)),
        Command::Issue(I::Reopen { repo, .. }) => ("issue not reopened", Some(repo)),
        Command::Issue(I::Edit { repo, .. }) => ("issue not edited", Some(repo)),
        Command::Issue(I::EditComment { repo, .. }) => ("comment not edited", Some(repo)),
        Command::Issue(I::DeleteComment { repo, .. }) => ("comment not deleted", Some(repo)),
        Command::Pr(P::Create(args)) => ("pull request not created", Some(&args.repo)),
        Command::Pr(P::Close { repo, .. }) => ("pull request not closed", Some(repo)),
        Command::Pr(P::Reopen { repo, .. }) => ("pull request not reopened", Some(repo)),
        Command::Pr(
            P::List { repo, .. }
            | P::View { repo, .. }
            | P::Diff { repo, .. }
            | P::Checkout { repo, .. }
            | P::Checks { repo, .. }
            | P::Commits { repo, .. },
        ) => ("could not read the pull request", Some(repo)),
        Command::Pr(P::Review(a)) => ("review not posted", Some(&a.repo)),
        Command::Pr(P::Comment(a)) => ("comment not posted", Some(&a.repo)),
        Command::Pr(P::Merge(a)) => ("merge failed", Some(&a.repo)),
        Command::Pr(P::Edit { repo, .. }) => ("pull request not edited", Some(repo)),
        Command::Pr(P::Sync { repo, .. }) => ("pull request head not moved", Some(repo)),
        Command::Pr(P::Ready { repo, .. }) => ("pull request not marked ready", Some(repo)),
        Command::Pr(P::Draft { repo, .. }) => ("pull request not converted to a draft", Some(repo)),
        Command::Pr(P::Lock { repo, .. }) => ("pull request lock not changed", Some(repo)),
        Command::Pr(P::Resolve { repo, .. }) => ("conversation not resolved", Some(repo)),
        Command::Pr(P::Unresolve { repo, .. }) => ("conversation not unresolved", Some(repo)),
        Command::Pr(P::RequestReview { repo, .. } | P::UnrequestReview { repo, .. }) => {
            ("review request not changed", Some(repo))
        }
        Command::Pr(P::DismissReview { repo, .. }) => ("review not dismissed", Some(repo)),
        Command::Pr(P::UpdateBranch { repo, .. }) => ("branch not updated", Some(repo)),
        Command::Pr(P::Suggestion(crate::PrSuggestionCommand::Apply { repo, .. })) => {
            ("suggestions not applied", Some(repo))
        }
        Command::Release(R::Create(args)) => ("release not created", Some(&args.repo)),
        Command::Release(R::List { repo }) => ("could not read releases", Some(repo)),
        // A download also fetches from storage and writes local files: "read" was wrong
        // for those failures (L-22).
        Command::Release(R::Download { repo, .. }) => ("release not downloaded", Some(repo)),
        Command::Release(R::Unpublish { repo, .. }) => ("release not unpublished", Some(repo)),
        Command::Label(LabelCommand::List { repo, .. }) => ("could not list labels", Some(repo)),
        Command::Issue(I::Label { repo, .. })
        | Command::Label(
            LabelCommand::Create { repo, .. }
            | LabelCommand::Retire { repo, .. }
            | LabelCommand::Delete { repo, .. },
        ) => ("label not changed", Some(repo)),
        Command::Collab(C::Add { repo, .. }) => ("collaborator not added", Some(repo)),
        Command::Collab(C::Remove { repo, .. }) => ("collaborator not removed", Some(repo)),
        Command::Collab(C::List { repo }) => ("could not list collaborators", Some(repo)),
        Command::Collab(C::Accept { repo, .. }) => ("membership not accepted", Some(repo)),
        Command::Cost(CostCommand::Estimate { .. }) => ("no estimate", None),
        Command::Cost(CostCommand::Audit { repo, .. }) => ("audit failed", repo.as_ref()),
        Command::Cost(CostCommand::Prices) => ("no price reference", None),
        Command::Repack { repo, .. } => ("repack failed", repo.as_ref()),
        Command::Reseed { repo, .. } => ("reseed failed", repo.as_ref()),
        Command::Storage(S::Status { repo } | S::Advertise { repo, .. }) => {
            ("storage command failed", Some(repo))
        }
        Command::Storage(S::Add(_)) => ("storage profile not added", None),
        Command::Storage(_) => ("storage command failed", None),
        Command::Webhook(w) => w.context(),
        Command::Ci(c) => c.context(),
        Command::Import(a) => ("import failed", a.repo.as_ref()),
        Command::Doctor { .. } => ("doctor found problems", None),
        Command::Completions { .. } => ("could not print completions", None),
    };
    (Some(goal), repo.map(String::as_str))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn classify(err: &anyhow::Error) -> UserError {
        user_error::classify(err.chain(), &ErrorContext::default())
    }

    #[test]
    fn helpers_carry_their_codes_through_anyhow_context() {
        use anyhow::Context as _;
        let e = Err::<(), _>(usage("pass exactly one of --add or --remove"))
            .context("labeling")
            .unwrap_err();
        let u = classify(&e);
        assert_eq!((u.code, u.exit_code()), ("E201", 2));
        assert_eq!(classify(&cancelled()).exit_code(), 8);
        assert_eq!(classify(&not_found("issue #4 not found", "x")).code, "E102");
    }

    #[test]
    fn reported_errors_keep_their_exit_code() {
        let e = reported(
            UserError::new(codes::CHECKS_FAILED, "2 checks failed"),
            serde_json::json!({ "ok": false }),
        );
        assert_eq!(report(true, &e, &ErrorContext::default()), 1);
        let e = reported(
            UserError::new(codes::STORAGE_TEST, "x"),
            serde_json::json!({}),
        );
        assert_eq!(report(true, &e, &ErrorContext::default()), 5);
    }

    #[test]
    fn a_reported_body_carries_the_error_block() {
        let u = UserError::new(codes::NOT_IMPLEMENTED, "dg import is not wired yet");
        let v = with_error(
            Some(&serde_json::json!({ "status": "not_implemented", "url": "u" })),
            &u,
        );
        assert_eq!(v["status"], "not_implemented");
        assert_eq!(v["url"], "u");
        assert_eq!(v["error"]["code"], "E103");
        assert_eq!(v["error"]["exitCode"], 1);
        // Without a body it is the plain error document.
        assert_eq!(with_error(None, &u), u.to_json());
    }

    #[test]
    fn every_error_path_exits_non_zero() {
        let e = anyhow::anyhow!("something odd");
        assert_eq!(report(true, &e, &ErrorContext::default()), 1);
        let core: anyhow::Error = forge_core::Error::NotAMember {
            document_type: "refUpdate".into(),
            detail: "40120".into(),
        }
        .into();
        assert_eq!(report(true, &core, &ErrorContext::default()), 6);
    }
}
