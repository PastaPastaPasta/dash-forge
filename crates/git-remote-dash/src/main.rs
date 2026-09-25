//! `git-remote-dash` — the git remote helper for `dash://<owner>/<repo>` URLs.
//!
//! git invokes this binary as `git-remote-dash <remote> <url>` and speaks the remote
//! helper protocol over stdin/stdout (Radicle's helper is the reference for the
//! mechanics). This helper advertises the **connect-less** capability set
//! `fetch`/`push`/`option` (S0.9): git never hands it a live packfile socket, so it owns
//! want-set → pack transport itself and cannot serve shallow (`--depth`) — which therefore
//! fails loudly instead of silently cloning full history.
//!
//! - `capabilities` → advertise `fetch push option`.
//! - `option`      → recorded via [`options::handle_option`]; shallow refused loudly.
//! - `list` / `list for-push` → resolve the repo and emit refs + HEAD symref.
//! - `fetch`       → download + index packs (full clone; `--filter` partial clone).
//! - `push`        → build a self-contained pack, store it per the repo's storage policy
//!   (`dash.storage` / `dash.replicas`), write the manifest, then the ref updates.
//!
//! A `--`-prefixed first argument switches to admin mode (`--create-repo`, `--dump-refs`,
//! `--balance`, `--version`) used to provision/inspect repos outside the git protocol.
//!
//! **Errors.** Any failure is rendered once, as the `dash: error: … [Ennn]` block of
//! [`forge_core::user_error`] on stderr (git shows it verbatim), and the process exits with
//! the code's class digit — always non-zero, so git reports the operation as failed.
//!
//! The network comes from `DASH_FORGE_NETWORK` / `DASH_FORGE_DEVNET_NAME` /
//! `DASH_FORGE_DAPI_ADDRESSES`, else git config `dash.network` / `dash.devnetName` /
//! `dash.dapiAddresses` (e.g. `git clone -c dash.network=devnet -c dash.devnetName=moutai
//! dash://…`), else testnet. See `helper::network_target`.

mod admin;
mod git;
mod helper;
mod journal;
mod options;
mod policy;
mod progress;
mod url;

use std::io::{self, BufRead, Write};

use anyhow::{Context, Result};
use forge_core::user_error::{self, codes, ErrorContext, UserError};
use tokio::runtime::Runtime;

use helper::{Helper, PushSpec, Want};
use options::{handle_option, OptionState};
use url::DashUrl;

/// Advertised capabilities. `\n\n` terminates the capabilities block per protocol. Note
/// `list` is a *command* implied by `fetch`/`push`, not an advertised capability, and
/// `connect`/`stateless-connect` are deliberately absent (S0.9: connect-less helper).
const CAPABILITIES: &str = "fetch\npush\noption\n\n";

fn main() {
    let mut goal = Goal::default();
    if let Err(err) = run(&mut goal) {
        let ctx = ErrorContext {
            goal: Some(goal.lead),
            rejected: goal.rejected,
            repo: goal.repo.as_deref(),
            retry_is_idempotent: goal.idempotent,
        };
        let u = user_error::classify(err.chain(), &ctx);
        u.eprint("dash: ");
        std::process::exit(u.exit_code());
    }
}

/// What the helper was doing when it failed: the headline lead and the repo.
struct Goal {
    lead: &'static str,
    rejected: Option<&'static str>,
    repo: Option<String>,
    idempotent: bool,
}

impl Default for Goal {
    fn default() -> Self {
        Self {
            lead: "git-remote-dash failed",
            rejected: None,
            repo: None,
            idempotent: false,
        }
    }
}

impl Goal {
    /// Record what git asked for. Fetches and pushes are both safe to re-run.
    fn set(&mut self, pushing: bool, opts: &OptionState) {
        self.idempotent = true;
        (self.lead, self.rejected) = if pushing {
            ("push failed", Some("push rejected"))
        } else if opts.cloning {
            ("clone failed", None)
        } else {
            ("fetch failed", None)
        };
    }
}

fn run(goal: &mut Goal) -> Result<()> {
    tracing_subscriber::fmt()
        .with_writer(io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .init();

    let args: Vec<String> = std::env::args().collect();

    // `--version` / `-V`: what `dg doctor` compares against its own version. Checked before
    // admin mode, whose `--` prefix it shares.
    if matches!(args.get(1).map(String::as_str), Some("--version" | "-V")) {
        println!("{}", version_line());
        return Ok(());
    }

    // Admin mode: `git-remote-dash --create-repo <name>` etc. (outside the git protocol).
    if let Some(first) = args.get(1) {
        if first.starts_with("--") {
            let rt = runtime()?;
            return admin::run(&rt, &args[1..]);
        }
    }

    // Remote-helper mode: git passes `<remote-name> <url>`. When a bare URL is used
    // (`git clone dash://…` with no named remote), both args are the URL.
    let url_arg = args.get(2).or_else(|| args.get(1)).ok_or_else(|| {
        UserError::new(codes::USAGE, "git-remote-dash is run by git, not by hand")
            .cause("usage: git-remote-dash <remote-name> <url>")
            .fix("use it through git: `git clone dash://<owner>/<repo>`")
    })?;
    let dash_url = DashUrl::parse(url_arg).map_err(|e| {
        UserError::new(codes::INVALID_REPO_REF, "invalid dash:// URL")
            .cause(e.to_string())
            .fix("use dash://<owner identity id>/<repo>, or dash://<contract id>")
    })?;
    goal.repo = Some(dash_url.to_string());

    // git invokes the helper with a *relative* `GIT_DIR=.git` and cwd = the worktree.
    // We shell out to `git -C <other-dir> …` (in forge-core's pack builder and in scratch
    // repos), where a relative `GIT_DIR` would resolve against the wrong directory. Pin it
    // to an absolute path once so every child agrees on the repository.
    normalize_git_dir_env();

    // A named remote (`git push origin`) selects its `remote.<name>.dash*` storage
    // settings; a bare URL has no remote name (git passes the URL twice).
    let remote_name = args
        .get(1)
        .filter(|a| !a.contains("://") && args.get(2).is_some_and(|u| u != *a))
        .cloned();

    let rt = runtime()?;
    let mut helper = Helper::new(dash_url, remote_name)?;
    let stdin = io::stdin();
    let stdout = io::stdout();
    protocol_loop(&rt, &mut helper, stdin.lock(), stdout.lock(), goal)
}

/// `git-remote-dash <version> (<sha> <target>)` — the same shape as `dg --version`.
fn version_line() -> String {
    format!("git-remote-dash {}", env!("DASH_FORGE_VERSION"))
}

/// Rewrite a relative `GIT_DIR` to an absolute path (no-op when unset or already absolute).
fn normalize_git_dir_env() {
    if let Some(raw) = std::env::var_os("GIT_DIR") {
        match std::fs::canonicalize(&raw) {
            Ok(abs) => std::env::set_var("GIT_DIR", abs),
            Err(e) => tracing::warn!(
                git_dir = %std::path::Path::new(&raw).display(),
                error = %e,
                "could not canonicalize GIT_DIR to an absolute path; leaving it as-is (git subprocesses run with -C may misresolve it)"
            ),
        }
    }
}

/// Build the multi-threaded tokio runtime the rs-sdk paths run on.
fn runtime() -> Result<Runtime> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("building tokio runtime")
}

/// Parse a `fetch <sha> <name>` line into a [`Want`] (the object id is the first token).
fn parse_fetch_line(line: &str) -> Option<Want> {
    let mut it = line.split_whitespace();
    if it.next()? != "fetch" {
        return None;
    }
    let oid = it.next()?.to_string();
    Some(Want { oid })
}

/// Parse a `push [+]<src>:<dst>` line into a [`PushSpec`]. A leading `+` on the source is
/// the force flag; an empty source is a deletion.
fn parse_push_line(line: &str) -> Option<PushSpec> {
    let rest = line.strip_prefix("push ")?;
    let (src_raw, dst) = rest.split_once(':')?;
    let force = src_raw.starts_with('+');
    let src = src_raw.strip_prefix('+').unwrap_or(src_raw).to_string();
    Some(PushSpec {
        force,
        src,
        dst: dst.trim().to_string(),
    })
}

/// Drive the remote-helper line loop against arbitrary reader/writer streams.
fn protocol_loop<R: BufRead, W: Write>(
    rt: &Runtime,
    helper: &mut Helper,
    reader: R,
    mut writer: W,
    goal: &mut Goal,
) -> Result<()> {
    let mut opts = OptionState::default();
    let mut lines = reader.lines();

    while let Some(line) = lines.next() {
        let line = line?;
        let command = line.split_whitespace().next().unwrap_or("");
        match command {
            // A blank line at the top level ends the session.
            "" => break,
            "capabilities" => {
                writer.write_all(CAPABILITIES.as_bytes())?;
                writer.flush()?;
            }
            "option" => {
                let rest = line.strip_prefix("option ").unwrap_or("");
                let reply = handle_option(&mut opts, rest);
                writeln!(writer, "{}", reply.wire())?;
                writer.flush()?;
            }
            "list" => {
                goal.set(line.contains("for-push"), &opts);
                fail_if_shallow(&opts)?;
                let out = rt.block_on(helper.list()).context("list refs")?;
                for l in &out {
                    writeln!(writer, "{l}")?;
                }
                writeln!(writer)?; // terminating blank
                writer.flush()?;
            }
            "fetch" => {
                goal.set(false, &opts);
                fail_if_shallow(&opts)?;
                let mut wants = Vec::new();
                if let Some(w) = parse_fetch_line(&line) {
                    wants.push(w);
                }
                // Collect the rest of the fetch batch up to the terminating blank line.
                for next in lines.by_ref() {
                    let next = next?;
                    if next.is_empty() {
                        break;
                    }
                    if let Some(w) = parse_fetch_line(&next) {
                        wants.push(w);
                    }
                }
                rt.block_on(helper.fetch(&wants, &opts))
                    .context("fetch objects")?;
                writeln!(writer)?; // end-of-batch
                writer.flush()?;
            }
            "push" => {
                goal.set(true, &opts);
                let mut specs = Vec::new();
                if let Some(s) = parse_push_line(&line) {
                    specs.push(s);
                }
                for next in lines.by_ref() {
                    let next = next?;
                    if next.is_empty() {
                        break;
                    }
                    if let Some(s) = parse_push_line(&next) {
                        specs.push(s);
                    }
                }
                let outcomes = rt
                    .block_on(helper.push(&specs, &opts))
                    .context("push refs")?;
                for o in &outcomes {
                    writeln!(writer, "{}", o.wire())?;
                }
                writeln!(writer)?; // end-of-batch
                writer.flush()?;
            }
            other => {
                tracing::warn!(
                    command = other,
                    "unrecognized remote-helper command; ignoring"
                );
            }
        }
    }
    Ok(())
}

/// Abort loudly if a shallow request was latched (`--depth`/`--shallow-*`), rather than
/// letting git silently produce a full clone (S0.9).
fn fail_if_shallow(opts: &OptionState) -> Result<()> {
    if let Some(msg) = &opts.fatal {
        return Err(UserError::new(
            codes::UNSUPPORTED,
            "shallow clone is not supported by dash://",
        )
        .cause(msg.as_str())
        .fix("use a partial clone instead: `git clone --filter=blob:none dash://…`")
        .into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        fail_if_shallow, parse_fetch_line, parse_push_line, version_line, ErrorContext,
        CAPABILITIES,
    };
    use crate::options::{handle_option, OptionState};

    #[test]
    fn version_line_names_version_commit_and_target() {
        let v = version_line();
        assert!(
            v.starts_with(concat!("git-remote-dash ", env!("CARGO_PKG_VERSION"), " (")),
            "{v}"
        );
        assert!(v.contains(env!("DASH_FORGE_GIT_SHA")), "{v}");
        assert!(
            v.ends_with(concat!(" ", env!("DASH_FORGE_TARGET"), ")")),
            "{v}"
        );
    }

    #[test]
    fn shallow_fails_with_its_own_code_and_the_e2e_wording() {
        let mut opts = OptionState::default();
        handle_option(&mut opts, "depth 1");
        let err = fail_if_shallow(&opts).unwrap_err();
        let u = forge_core::user_error::classify(err.chain(), &ErrorContext::default());
        assert_eq!((u.code, u.exit_code()), ("E205", 2));
        // e2e 07 recognizes the refusal by these words.
        let text = u.render("dash: ", false);
        assert!(text.contains("shallow clone"), "{text}");
        assert!(text.contains("--filter=blob:none"), "{text}");
    }

    #[test]
    fn capabilities_advertise_connectless_set() {
        assert_eq!(CAPABILITIES, "fetch\npush\noption\n\n");
        assert!(!CAPABILITIES.contains("connect"));
    }

    #[test]
    fn fetch_line_yields_oid() {
        let w = parse_fetch_line("fetch 34dfa99abc refs/heads/main").unwrap();
        assert_eq!(w.oid, "34dfa99abc");
        // Lazy promisor fetch: name == oid.
        let w = parse_fetch_line("fetch f1f36270 f1f36270").unwrap();
        assert_eq!(w.oid, "f1f36270");
        assert!(parse_fetch_line("list").is_none());
    }

    #[test]
    fn push_line_parses_force_and_delete() {
        let p = parse_push_line("push refs/heads/main:refs/heads/main").unwrap();
        assert!(!p.force);
        assert_eq!(p.src, "refs/heads/main");
        assert_eq!(p.dst, "refs/heads/main");

        let p = parse_push_line("push +refs/heads/main:refs/heads/main").unwrap();
        assert!(p.force);
        assert_eq!(p.src, "refs/heads/main");

        // Deletion: empty source.
        let p = parse_push_line("push :refs/heads/gone").unwrap();
        assert!(p.src.is_empty());
        assert_eq!(p.dst, "refs/heads/gone");

        assert!(parse_push_line("list for-push").is_none());
    }
}
