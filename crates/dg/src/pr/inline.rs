//! Inline review comments on the command line (review-parity §2.5 C1, §4.1):
//!
//! ```text
//! dg pr review o/r 7 --request-changes --body-file summary.md \
//!   --file src/a.rs --line 12 --body "…" \
//!   --file src/b.rs --start-line 3 --line 5 --side old --body "…" \
//!   --file src/c.rs --line 9 --suggest "let x = 1;" --body "simpler"
//! ```
//!
//! A `--body` before the first `--file` is the review's summary; every flag after a `--file`
//! belongs to that file's comment, until the next `--file`. clap's derive cannot keep that
//! order, so [`InlineArgs`] implements `clap::Args` itself and groups the flags by their
//! position on the command line ([`group`]).

use std::path::PathBuf;

use clap::{Arg, ArgAction, ArgMatches, Command};
use serde::{Deserialize, Serialize};

/// Which side of the diff a line is on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SideArg {
    /// The base (removed / old lines).
    Old,
    /// The head (added / new lines).
    New,
}

impl SideArg {
    /// The stored `side` (0 old, 1 new).
    pub fn code(self) -> u64 {
        match self {
            SideArg::Old => 0,
            SideArg::New => 1,
        }
    }

    /// The side a stored code names.
    pub fn from_code(code: u8) -> Self {
        if code == 0 {
            SideArg::Old
        } else {
            SideArg::New
        }
    }

    /// `old` / `new`.
    pub fn label(self) -> &'static str {
        match self {
            SideArg::Old => "old",
            SideArg::New => "new",
        }
    }
}

/// One inline comment as given: a file, optionally a line or range on one side, a body,
/// optionally a suggestion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InlineSpec {
    /// The file.
    pub path: String,
    /// The line (the last of a range); `None` for a file-level comment.
    pub line: Option<u64>,
    /// The first line of a range.
    pub start_line: Option<u64>,
    /// The side (new unless `--side old`); `None` for a file-level comment.
    pub side: Option<SideArg>,
    /// The comment text, with any suggestion block appended ([`with_suggestion`]).
    pub body: String,
}

impl InlineSpec {
    /// `src/a.rs:12`, `src/a.rs:3-5 (old)`, `src/a.rs` (file-level).
    pub fn location(&self) -> String {
        location(
            &self.path,
            self.start_line,
            self.line,
            self.side.map(SideArg::code),
        )
    }
}

/// `path:line`, `path:start-end`, with ` (old)` for the old side; `path` without a line.
pub fn location(path: &str, start: Option<u64>, line: Option<u64>, side: Option<u64>) -> String {
    let old = if side == Some(0) { " (old)" } else { "" };
    match (start, line) {
        (_, None) => path.to_string(),
        (Some(s), Some(l)) if s != l => format!("{path}:{s}-{l}{old}"),
        (_, Some(l)) => format!("{path}:{l}{old}"),
    }
}

/// The summary and inline comments of a `dg pr review`, in command-line order.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InlineArgs {
    /// `--body` before the first `--file`.
    pub summary: Option<String>,
    /// `--body-file` (the summary from a file, `-` for stdin).
    pub summary_file: Option<PathBuf>,
    /// One per `--file`.
    pub comments: Vec<InlineSpec>,
}

impl InlineArgs {
    /// The summary text: `--body`, else `--body-file`'s content, else empty.
    pub fn summary_text(&self) -> anyhow::Result<String> {
        match (&self.summary, &self.summary_file) {
            (Some(s), _) => Ok(s.clone()),
            (None, Some(p)) => read_body_file(p),
            (None, None) => Ok(String::new()),
        }
    }

    /// Whether anything at all was given.
    pub fn is_empty(&self) -> bool {
        self.summary.is_none() && self.summary_file.is_none() && self.comments.is_empty()
    }
}

/// Read a body from `path` (`-`: stdin), trailing newlines trimmed.
pub fn read_body_file(path: &std::path::Path) -> anyhow::Result<String> {
    use anyhow::Context as _;
    let text = if path.as_os_str() == "-" {
        let mut s = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut s).context("reading stdin")?;
        s
    } else {
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?
    };
    Ok(text.trim_end_matches(['\n', '\r']).to_string())
}

/// `body` with a ```` ```suggestion ```` block for `text` appended. The fence is longer than
/// any backtick run in `text`, so the suggestion can itself contain a code fence.
pub fn with_suggestion(body: &str, text: &str) -> String {
    let longest = text.split(|c| c != '`').map(str::len).max().unwrap_or(0);
    let fence = "`".repeat(longest.max(2) + 1);
    let block = format!("{fence}suggestion\n{text}\n{fence}");
    if body.trim().is_empty() {
        block
    } else {
        format!("{body}\n\n{block}")
    }
}

/// One flag occurrence, by its position on the command line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Token {
    /// `--file`.
    File(String),
    /// `--line`.
    Line(u64),
    /// `--start-line`.
    StartLine(u64),
    /// `--side`.
    Side(SideArg),
    /// `--body`.
    Body(String),
    /// `--suggest`.
    Suggest(String),
}

/// Group positioned flags into the summary and one comment per `--file` (see the module
/// docs). Errors name the flag that is out of place.
#[allow(clippy::too_many_lines)] // one state machine; splitting it scatters the rules
pub fn group(tokens: Vec<Token>, summary_file: Option<PathBuf>) -> Result<InlineArgs, String> {
    #[derive(Default)]
    struct Open {
        path: String,
        line: Option<u64>,
        start: Option<u64>,
        side: Option<SideArg>,
        body: Option<String>,
        suggest: Option<String>,
    }
    fn close(o: Open) -> Result<InlineSpec, String> {
        let at = &o.path;
        if o.path.is_empty() {
            return Err("--file needs a path".into());
        }
        if o.line.is_none() && (o.start.is_some() || o.side.is_some() || o.suggest.is_some()) {
            return Err(format!(
                "--file {at}: --start-line, --side and --suggest need --line"
            ));
        }
        if let (Some(s), Some(l)) = (o.start, o.line) {
            if s > l {
                return Err(format!("--file {at}: --start-line {s} is after --line {l}"));
            }
        }
        if o.line == Some(0) || o.start == Some(0) {
            return Err(format!("--file {at}: lines are numbered from 1"));
        }
        let side = o.line.map(|_| o.side.unwrap_or(SideArg::New));
        if o.suggest.is_some() && side == Some(SideArg::Old) {
            return Err(format!(
                "--file {at}: a suggestion replaces lines of the new side; drop --side old"
            ));
        }
        let body = o.body.unwrap_or_default();
        let body = match &o.suggest {
            Some(text) => with_suggestion(&body, text),
            None => body,
        };
        if body.trim().is_empty() {
            return Err(format!(
                "--file {at}: the comment needs a --body (or --suggest)"
            ));
        }
        Ok(InlineSpec {
            path: o.path,
            line: o.line,
            start_line: o.start.filter(|s| Some(*s) != o.line),
            side,
            body,
        })
    }

    let mut out = InlineArgs {
        summary_file,
        ..InlineArgs::default()
    };
    let mut open: Option<Open> = None;
    for t in tokens {
        let Some(o) = open.as_mut() else {
            match t {
                Token::File(path) => {
                    open = Some(Open {
                        path,
                        ..Open::default()
                    });
                }
                Token::Body(b) if out.summary.is_none() => out.summary = Some(b),
                Token::Body(_) => {
                    return Err(
                        "two --body flags before the first --file (the review summary)".into(),
                    )
                }
                other => {
                    return Err(format!(
                        "{} must follow the --file it belongs to",
                        flag_name(&other)
                    ))
                }
            }
            continue;
        };
        let dup = |what: &str| Err(format!("--file {}: {what} given twice", o.path));
        match t {
            Token::File(path) => {
                let done = open.replace(Open {
                    path,
                    ..Open::default()
                });
                out.comments.push(close(done.expect("open"))?);
            }
            Token::Line(l) if o.line.is_none() => o.line = Some(l),
            Token::StartLine(s) if o.start.is_none() => o.start = Some(s),
            Token::Side(s) if o.side.is_none() => o.side = Some(s),
            Token::Body(b) if o.body.is_none() => o.body = Some(b),
            Token::Suggest(s) if o.suggest.is_none() => o.suggest = Some(s),
            other => return dup(flag_name(&other)),
        }
    }
    if let Some(o) = open {
        out.comments.push(close(o)?);
    }
    if out.summary.is_some() && out.summary_file.is_some() {
        return Err("pass the summary as --body or --body-file, not both".into());
    }
    Ok(out)
}

fn flag_name(t: &Token) -> &'static str {
    match t {
        Token::File(_) => "--file",
        Token::Line(_) => "--line",
        Token::StartLine(_) => "--start-line",
        Token::Side(_) => "--side",
        Token::Body(_) => "--body",
        Token::Suggest(_) => "--suggest",
    }
}

const IDS: [&str; 6] = ["file", "line", "start_line", "side", "body", "suggest"];

impl clap::Args for InlineArgs {
    fn augment_args(cmd: Command) -> Command {
        let many =
            |id: &'static str, long: &'static str, value: &'static str, help: &'static str| {
                Arg::new(id)
                    .long(long)
                    .value_name(value)
                    .action(ArgAction::Append)
                    .help(help)
            };
        cmd.arg(many(
            "body",
            "body",
            "TEXT",
            "Before any --file: the review summary. After a --file: that comment's text",
        ))
        .arg(
            Arg::new("body_file")
                .long("body-file")
                .value_name("FILE")
                .value_parser(clap::value_parser!(PathBuf))
                .help("Read the review summary from a file (`-` for stdin)"),
        )
        .arg(many(
            "file",
            "file",
            "PATH",
            "Start an inline comment on this file (repeatable; the flags after it are its own)",
        ))
        .arg(
            many(
                "line",
                "line",
                "N",
                "The comment's line (the last line of a range)",
            )
            .value_parser(clap::value_parser!(u64)),
        )
        .arg(
            many("start_line", "start-line", "N", "The first line of a range")
                .value_parser(clap::value_parser!(u64)),
        )
        .arg(
            many(
                "side",
                "side",
                "old|new",
                "The side of the diff (default: new)",
            )
            .value_parser(clap::builder::EnumValueParser::<SideArg>::new()),
        )
        .arg(many(
            "suggest",
            "suggest",
            "TEXT",
            "Suggest this text for the comment's lines (a ```suggestion block)",
        ))
    }

    fn augment_args_for_update(cmd: Command) -> Command {
        Self::augment_args(cmd)
    }
}

impl clap::FromArgMatches for InlineArgs {
    fn from_arg_matches(m: &ArgMatches) -> Result<Self, clap::Error> {
        let mut tokens: Vec<(usize, Token)> = Vec::new();
        for id in IDS {
            let Some(idx) = m.indices_of(id) else {
                continue;
            };
            let idx: Vec<usize> = idx.collect();
            match id {
                "line" | "start_line" => {
                    for (i, v) in idx
                        .into_iter()
                        .zip(m.get_many::<u64>(id).into_iter().flatten())
                    {
                        tokens.push((
                            i,
                            if id == "line" {
                                Token::Line(*v)
                            } else {
                                Token::StartLine(*v)
                            },
                        ));
                    }
                }
                "side" => {
                    for (i, v) in idx
                        .into_iter()
                        .zip(m.get_many::<SideArg>(id).into_iter().flatten())
                    {
                        tokens.push((i, Token::Side(*v)));
                    }
                }
                _ => {
                    for (i, v) in idx
                        .into_iter()
                        .zip(m.get_many::<String>(id).into_iter().flatten())
                    {
                        let v = v.clone();
                        tokens.push((
                            i,
                            match id {
                                "file" => Token::File(v),
                                "body" => Token::Body(v),
                                _ => Token::Suggest(v),
                            },
                        ));
                    }
                }
            }
        }
        tokens.sort_by_key(|(i, _)| *i);
        let summary_file = m.get_one::<PathBuf>("body_file").cloned();
        group(tokens.into_iter().map(|(_, t)| t).collect(), summary_file)
            .map_err(|e| clap::Error::raw(clap::error::ErrorKind::ValueValidation, e + "\n"))
    }

    fn update_from_arg_matches(&mut self, m: &ArgMatches) -> Result<(), clap::Error> {
        *self = Self::from_arg_matches(m)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[derive(Debug, Parser)]
    struct T {
        #[command(flatten)]
        inline: InlineArgs,
    }

    fn parse(args: &[&str]) -> Result<InlineArgs, String> {
        let mut cmdline = vec!["t"];
        cmdline.extend_from_slice(args);
        T::try_parse_from(cmdline)
            .map(|t| t.inline)
            .map_err(|e| e.to_string())
    }

    #[test]
    fn flags_after_a_file_belong_to_it_in_order() {
        let a = parse(&[
            "--body",
            "summary",
            "--file",
            "src/a.rs",
            "--line",
            "12",
            "--body",
            "one",
            "--file",
            "src/b.rs",
            "--start-line",
            "3",
            "--line",
            "5",
            "--side",
            "old",
            "--body",
            "two",
            "--file",
            "README.md",
            "--body",
            "file-level",
        ])
        .unwrap();
        assert_eq!(a.summary.as_deref(), Some("summary"));
        assert_eq!(a.comments.len(), 3);
        assert_eq!(a.comments[0].location(), "src/a.rs:12");
        assert_eq!(a.comments[0].side, Some(SideArg::New));
        assert_eq!(a.comments[1].location(), "src/b.rs:3-5 (old)");
        assert_eq!(a.comments[1].body, "two");
        assert_eq!(a.comments[2].line, None);
        assert_eq!(a.comments[2].side, None);
        assert_eq!(a.comments[2].location(), "README.md");
    }

    #[test]
    fn a_suggestion_becomes_a_fenced_block() {
        let a = parse(&[
            "--file",
            "a.rs",
            "--line",
            "4",
            "--suggest",
            "let x = 1;",
            "--body",
            "simpler",
        ])
        .unwrap();
        assert_eq!(
            a.comments[0].body,
            "simpler\n\n```suggestion\nlet x = 1;\n```"
        );
        let parsed = forge_core::rules::v2::parse_suggestions(&a.comments[0].body);
        assert_eq!(parsed[0].text, "let x = 1;");
        // A suggestion containing a fence gets a longer one, and still parses back.
        let body = with_suggestion("", "```rust\nx\n```");
        assert!(body.starts_with("````suggestion\n"), "{body}");
        assert_eq!(
            forge_core::rules::v2::parse_suggestions(&body)[0].text,
            "```rust\nx\n```"
        );
    }

    #[test]
    fn misplaced_or_inconsistent_flags_are_refused() {
        for (args, want) in [
            (vec!["--line", "3"], "must follow the --file"),
            (
                vec!["--file", "a", "--line", "3", "--line", "4", "--body", "x"],
                "given twice",
            ),
            (
                vec![
                    "--file",
                    "a",
                    "--start-line",
                    "5",
                    "--line",
                    "3",
                    "--body",
                    "x",
                ],
                "after --line",
            ),
            (
                vec!["--file", "a", "--side", "old", "--body", "x"],
                "need --line",
            ),
            (vec!["--file", "a", "--line", "3"], "needs a --body"),
            (
                vec!["--file", "a", "--line", "0", "--body", "x"],
                "numbered from 1",
            ),
            (
                vec![
                    "--file",
                    "a",
                    "--line",
                    "3",
                    "--side",
                    "old",
                    "--suggest",
                    "y",
                ],
                "new side",
            ),
            (vec!["--body", "a", "--body", "b"], "two --body"),
        ] {
            let err = parse(&args).unwrap_err();
            assert!(err.contains(want), "{args:?}: {err}");
        }
    }

    #[test]
    fn a_single_line_range_is_a_line() {
        let a = parse(&[
            "--file",
            "a",
            "--start-line",
            "3",
            "--line",
            "3",
            "--body",
            "x",
        ])
        .unwrap();
        assert_eq!(a.comments[0].start_line, None);
        assert_eq!(a.comments[0].location(), "a:3");
    }
}
