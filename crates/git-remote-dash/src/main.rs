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
//! - `push`        → build a self-contained pack, upload, write manifest + ref updates.
//!
//! A `--`-prefixed first argument switches to admin mode (`--create-repo`, `--teardown`,
//! `--balance`) used to provision/inspect repos outside the git protocol.

mod admin;
mod git;
mod helper;
mod options;
mod url;

use std::io::{self, BufRead, Write};

use anyhow::{bail, Context, Result};
use tokio::runtime::Runtime;

use helper::{Helper, PushSpec, Want};
use options::{handle_option, OptionState};
use url::DashUrl;

/// Advertised capabilities. `\n\n` terminates the capabilities block per protocol. Note
/// `list` is a *command* implied by `fetch`/`push`, not an advertised capability, and
/// `connect`/`stateless-connect` are deliberately absent (S0.9: connect-less helper).
const CAPABILITIES: &str = "fetch\npush\noption\n\n";

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_writer(io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .init();

    let args: Vec<String> = std::env::args().collect();

    // Admin mode: `git-remote-dash --create-repo <name>` etc. (outside the git protocol).
    if let Some(first) = args.get(1) {
        if first.starts_with("--") {
            let rt = runtime()?;
            return admin::run(&rt, &args[1..]);
        }
    }

    // Remote-helper mode: git passes `<remote-name> <url>`. When a bare URL is used
    // (`git clone dash://…` with no named remote), both args are the URL.
    let url_arg = args
        .get(2)
        .or_else(|| args.get(1))
        .ok_or_else(|| anyhow::anyhow!("usage: git-remote-dash <remote-name> <url>"))?;
    let dash_url = DashUrl::parse(url_arg).context("parsing dash:// URL")?;

    // git invokes the helper with a *relative* `GIT_DIR=.git` and cwd = the worktree.
    // We shell out to `git -C <other-dir> …` (in forge-core's pack builder and in scratch
    // repos), where a relative `GIT_DIR` would resolve against the wrong directory. Pin it
    // to an absolute path once so every child agrees on the repository.
    normalize_git_dir_env();

    let rt = runtime()?;
    let mut helper = Helper::new(dash_url)?;
    let stdin = io::stdin();
    let stdout = io::stdout();
    protocol_loop(&rt, &mut helper, stdin.lock(), stdout.lock())
}

/// Rewrite a relative `GIT_DIR` to an absolute path (no-op when unset or already absolute).
fn normalize_git_dir_env() {
    if let Some(raw) = std::env::var_os("GIT_DIR") {
        if let Ok(abs) = std::fs::canonicalize(&raw) {
            std::env::set_var("GIT_DIR", abs);
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
                fail_if_shallow(&opts)?;
                let out = rt.block_on(helper.list()).context("list refs")?;
                for l in &out {
                    writeln!(writer, "{l}")?;
                }
                writeln!(writer)?; // terminating blank
                writer.flush()?;
            }
            "fetch" => {
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
        bail!("{msg}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{parse_fetch_line, parse_push_line, CAPABILITIES};

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
