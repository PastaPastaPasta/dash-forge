//! `git-remote-dash` — the git remote helper for `dash://<owner>/<repo>` URLs.
//!
//! git invokes this binary as `git-remote-dash <remote> <url>` and speaks the remote
//! helper protocol over stdin/stdout (Radicle's helper is the reference for the
//! mechanics). This scaffold implements the connect-less handshake: it answers
//! `capabilities` with the supported command list and terminates on a blank line.
//! `list`, `fetch`, `push` and `option` are recognized but not yet implemented.
//!
//! The command dispatch is factored into [`dispatch`] and [`run`] so the line loop is
//! unit-testable without spawning git.

use std::io::{self, BufRead, Write};

use anyhow::Result;

/// Advertised capabilities. `\n\n` terminates the capabilities block per protocol.
const CAPABILITIES: &str = "fetch\npush\noption\n\n";

/// The helper's response to a single protocol command line.
#[derive(Debug, PartialEq, Eq)]
enum Dispatch {
    /// Write this text to stdout and keep looping.
    Reply(&'static str),
    /// A recognized command whose handler is not yet implemented; keep looping.
    Unimplemented(&'static str),
    /// Blank line (or EOF): the current command batch is finished — terminate.
    End,
}

/// Map one protocol command line to the helper's response.
fn dispatch(line: &str) -> Dispatch {
    // The protocol is line-oriented; commands may carry arguments after a space.
    let command = line.split_whitespace().next().unwrap_or("");
    match command {
        "" => Dispatch::End,
        "capabilities" => Dispatch::Reply(CAPABILITIES),
        "list" => Dispatch::Unimplemented("list"),
        "fetch" => Dispatch::Unimplemented("fetch"),
        "push" => Dispatch::Unimplemented("push"),
        "option" => Dispatch::Reply("unsupported\n"),
        _ => Dispatch::Unimplemented("unknown"),
    }
}

/// Drive the remote-helper line loop against arbitrary reader/writer streams.
fn run<R: BufRead, W: Write>(reader: R, mut writer: W) -> Result<()> {
    for line in reader.lines() {
        let line = line?;
        match dispatch(&line) {
            Dispatch::Reply(text) => {
                writer.write_all(text.as_bytes())?;
                writer.flush()?;
            }
            Dispatch::Unimplemented(command) => {
                // Stage 2 wires these to forge-core services. For now, surface a
                // diagnostic on stderr and end the batch cleanly.
                tracing::warn!(command, "remote-helper command not yet implemented");
                return Ok(());
            }
            Dispatch::End => break,
        }
    }
    Ok(())
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_writer(io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let stdin = io::stdin();
    let stdout = io::stdout();
    run(stdin.lock(), stdout.lock())
}

#[cfg(test)]
mod tests {
    use super::{dispatch, run, Dispatch, CAPABILITIES};

    #[test]
    fn capabilities_advertises_fetch_push_option() {
        assert_eq!(dispatch("capabilities"), Dispatch::Reply(CAPABILITIES));
        assert_eq!(CAPABILITIES, "fetch\npush\noption\n\n");
    }

    #[test]
    fn blank_line_terminates() {
        assert_eq!(dispatch(""), Dispatch::End);
    }

    #[test]
    fn commands_with_args_dispatch_on_first_token() {
        assert_eq!(dispatch("list for-push"), Dispatch::Unimplemented("list"));
        assert_eq!(
            dispatch("option verbosity 2"),
            Dispatch::Reply("unsupported\n")
        );
    }

    #[test]
    fn run_emits_capabilities_then_stops_on_blank_line() {
        let input = b"capabilities\n\n".as_slice();
        let mut output: Vec<u8> = Vec::new();
        run(input, &mut output).expect("loop should succeed");
        assert_eq!(String::from_utf8(output).unwrap(), CAPABILITIES);
    }
}
