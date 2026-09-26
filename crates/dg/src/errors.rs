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
    AuthCommand, CollabCommand, Command, CostCommand, IssueCommand, LabelCommand, PrCommand,
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
pub fn context_for(cmd: &Command) -> (Option<&'static str>, Option<&str>) {
    use AuthCommand as A;
    use CollabCommand as C;
    use IssueCommand as I;
    use PrCommand as P;
    use ReleaseCommand as R;
    use RepoCommand as Rp;
    use StorageCommand as S;
    let (goal, repo): (&'static str, Option<&String>) = match cmd {
        Command::Auth(A::Login) => ("login failed", None),
        Command::Auth(A::Status) => ("could not show auth status", None),
        Command::Auth(A::Balance) => ("could not read the balance", None),
        Command::Repo(Rp::Create { name, .. }) => ("repository not created", Some(name)),
        Command::Repo(Rp::Clone { repo } | Rp::View { repo }) => {
            ("could not show the repository", Some(repo))
        }
        Command::Repo(Rp::Fork { repo, .. }) => ("repository not forked", Some(repo)),
        Command::Repo(Rp::Star { repo }) => ("repository not starred", Some(repo)),
        Command::Repo(Rp::Unstar { repo }) => ("star not removed", Some(repo)),
        Command::Repo(Rp::List { .. }) => ("could not list repositories", None),
        Command::Repo(Rp::Backend(RepoBackendCommand::Set { repo, .. })) => {
            ("backend not changed", Some(repo))
        }
        Command::Issue(I::List { repo, .. } | I::View { repo, .. }) => {
            ("could not read issues", Some(repo))
        }
        Command::Issue(I::Create { repo, .. }) => ("issue not created", Some(repo)),
        Command::Issue(I::Comment { repo, .. }) => ("comment not posted", Some(repo)),
        Command::Issue(I::Close { repo, .. }) => ("issue not closed", Some(repo)),
        Command::Issue(I::Reopen { repo, .. }) => ("issue not reopened", Some(repo)),
        Command::Issue(I::Label { repo, .. }) => ("label not changed", Some(repo)),
        Command::Pr(P::Create(args)) => ("pull request not created", Some(&args.repo)),
        Command::Pr(P::Close { repo, .. }) => ("pull request not closed", Some(repo)),
        Command::Pr(P::Reopen { repo, .. }) => ("pull request not reopened", Some(repo)),
        Command::Pr(
            P::List { repo, .. }
            | P::View { repo, .. }
            | P::Diff { repo, .. }
            | P::Checkout { repo, .. },
        ) => ("could not read the pull request", Some(repo)),
        Command::Pr(P::Review { repo, .. }) => ("review not posted", Some(repo)),
        Command::Pr(P::Merge { repo, .. }) => ("merge failed", Some(repo)),
        Command::Release(R::Create(args)) => ("release not created", Some(&args.repo)),
        Command::Release(R::List { repo } | R::Download { repo, .. }) => {
            ("could not read releases", Some(repo))
        }
        Command::Label(LabelCommand::List { repo, .. }) => ("could not list labels", Some(repo)),
        Command::Label(LabelCommand::Create { repo, .. } | LabelCommand::Retire { repo, .. }) => {
            ("label not changed", Some(repo))
        }
        Command::Collab(C::Add { repo, .. }) => ("collaborator not added", Some(repo)),
        Command::Collab(C::Suspend { repo, .. }) => ("collaborator not suspended", Some(repo)),
        Command::Collab(C::Unsuspend { repo, .. }) => ("collaborator not unsuspended", Some(repo)),
        Command::Collab(C::Remove { repo, .. }) => ("collaborator not removed", Some(repo)),
        Command::Collab(C::List { repo }) => ("could not list collaborators", Some(repo)),
        Command::Cost(CostCommand::Estimate { .. }) => ("no estimate", None),
        Command::Cost(CostCommand::Audit { repo }) => ("audit failed", repo.as_ref()),
        Command::Repack { repo, .. } => ("repack failed", repo.as_ref()),
        Command::Reseed { repo, .. } => ("reseed failed", repo.as_ref()),
        Command::Storage(S::Status { repo } | S::Advertise { repo, .. }) => {
            ("storage command failed", Some(repo))
        }
        Command::Storage(_) => ("storage command failed", None),
        Command::Webhook(w) => w.context(),
        Command::Import { .. } => ("import failed", None),
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
        let core: anyhow::Error = forge_core::Error::TokenFrozen.into();
        assert_eq!(report(true, &core, &ErrorContext::default()), 6);
    }
}
