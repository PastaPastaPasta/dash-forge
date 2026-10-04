//! The `dg --help` copy gate: the CLI half of the web's copy lint
//! (`forge-web/scripts/copy-lint.mjs`). The rules are the "Voice and tone" section of
//! `docs/design/style-guide.md`. Agents write most help text, so this test is what keeps
//! protocol jargon out of `--help`.
//!
//! - Every command's `about` (the line `dg <group> --help` lists) and every flag's short help
//!   is checked against the banned list. A command's `about` is also kept short.
//! - `dg --help` is compared with `tests/snapshots/dg-help.txt`. Run with
//!   `DG_UPDATE_SNAPSHOTS=1` to rewrite it after an intended change.

use clap::{Command, CommandFactory};

use crate::Cli;

/// Banned in help text: (term, why). A term with upper case matches case-sensitively, the rest
/// case-insensitively.
const BANNED: &[(&str, &str)] = &[
    ("forge-v1", "internal contract-set name"),
    ("forge-v2", "internal contract-set name"),
    ("RC1", "internal release name"),
    ("RC2", "internal release name"),
    ("PV14", "internal protocol name"),
    ("protocol 14", "internal protocol name"),
    ("gh-shaped", "say what the command does"),
    ("(patches)", "say pull requests"),
    ("FORGE_RULES", "code identifier"),
    ("objectLocator", "code identifier"),
    ("packManifest", "code identifier"),
    ("starBeat", "code identifier"),
    ("headUpdate", "code identifier"),
    ("forkOf", "code identifier"),
    ("asMaintainer", "code identifier"),
    ("config.backend", "code identifier"),
    ("fused star", "internal design name"),
    ("folded", "say read or build"),
    ("consensus", "say Platform enforces it"),
    ("client rule", "say Forge apps enforce it"),
    ("on chain", "say on Platform"),
    ("on-chain", "say on Platform"),
    ("forge-contracts/", "repository path"),
    ("(s)", "use a plural, not (s)"),
    ("recovery words", "say recovery phrase"),
];

/// Longest `about` (the summary in a command list), in words: the web's hard limit. The style
/// guide's target is eight; details belong in the paragraph after a blank `///` line.
const MAX_ABOUT_WORDS: usize = 40;

fn hits(text: &str) -> Vec<&'static str> {
    let lower = text.to_lowercase();
    BANNED
        .iter()
        .filter(|(term, _)| {
            if term.chars().any(|c| c.is_ascii_uppercase()) {
                text.contains(term)
            } else {
                lower.contains(term)
            }
        })
        .map(|(_, why)| *why)
        .collect()
}

fn walk(cmd: &Command, path: &str, out: &mut Vec<String>) {
    if cmd.is_hide_set() {
        return;
    }
    if let Some(about) = cmd.get_about() {
        let about = about.to_string();
        for why in hits(&about) {
            out.push(format!("{path}: about: {why}: {about}"));
        }
        let words = about.split_whitespace().count();
        if words > MAX_ABOUT_WORDS {
            out.push(format!(
                "{path}: about is {words} words (at most {MAX_ABOUT_WORDS}): {about}"
            ));
        }
    }
    for arg in cmd.get_arguments() {
        if arg.is_hide_set() {
            continue;
        }
        if let Some(help) = arg.get_help() {
            let help = help.to_string();
            for why in hits(&help) {
                out.push(format!("{path} --{}: help: {why}: {help}", arg.get_id()));
            }
        }
    }
    for sub in cmd.get_subcommands() {
        walk(sub, &format!("{path} {}", sub.get_name()), out);
    }
}

#[test]
fn help_text_uses_product_words() {
    let mut problems = Vec::new();
    walk(&Cli::command(), "dg", &mut problems);
    assert!(
        problems.is_empty(),
        "{} help problems (see docs/design/style-guide.md, \"Voice and tone\"):\n{}",
        problems.len(),
        problems.join("\n")
    );
}

#[test]
fn top_level_help_matches_its_snapshot() {
    let mut cmd = Cli::command();
    let help = cmd.render_help().to_string();
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/snapshots/dg-help.txt");
    if std::env::var_os("DG_UPDATE_SNAPSHOTS").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &help).unwrap();
        return;
    }
    let want = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        want == help,
        "`dg --help` changed. If that is intended, run `DG_UPDATE_SNAPSHOTS=1 cargo test -p dg help` and \
         commit tests/snapshots/dg-help.txt.\n--- snapshot\n{want}\n--- now\n{help}"
    );
}

#[test]
fn the_banned_list_catches_what_it_names() {
    assert_eq!(
        hits("Create a forge-v2 repository"),
        vec!["internal contract-set name"]
    );
    assert_eq!(hits("Pushed 3 file(s)"), vec!["use a plural, not (s)"]);
    assert!(hits("Create a repo").is_empty());
    // Upper-case terms match case-sensitively: "rc1" in a word is not a release name.
    assert!(hits("source1 rc1x").is_empty());
}
