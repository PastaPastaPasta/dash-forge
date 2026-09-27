//! Parse errors in Dash Forge's own TOML files (`config.toml`, `storage.toml`).
//!
//! An error names the file, the line and the column where the parser stopped, and never the
//! text there: a value in these files may be a pasted secret, so neither the source snippet
//! nor a quoted value from the parser's message is repeated.

use std::path::Path;

use crate::user_error::{codes, UserError};

/// `line L, column C: <message>` for a TOML parse error in `raw`, every quoted run in the
/// parser's message replaced by `…` ([`strip_quoted`]).
pub(crate) fn describe_toml_error(raw: &str, e: &toml::de::Error) -> String {
    // One line: the parser puts what it expected on a line of its own.
    let message = strip_quoted(e.message().trim()).replace('\n', ": ");
    match e.span().map(|s| line_column(raw, s.start)) {
        Some((line, column)) => format!("line {line}, column {column}: {message}"),
        None => message,
    }
}

/// The 1-based line and column (counted in characters) of byte offset `at` in `raw`.
fn line_column(raw: &str, at: usize) -> (usize, usize) {
    let before = &raw[..raw.floor_char_boundary(at)];
    let line = before.matches('\n').count() + 1;
    let column = before.rsplit('\n').next().unwrap_or("").chars().count() + 1;
    (line, column)
}

/// E204: `config.toml` at `path` (contents `raw`) does not parse. Every `dg` command and the
/// helper's default-identity lookup refuse it rather than silently running on defaults
/// (testnet, no identity).
pub fn config_toml_error(path: &Path, raw: &str, e: &toml::de::Error) -> UserError {
    let line = e.span().map(|s| line_column(raw, s.start).0);
    UserError::new(
        codes::INVALID_CONFIG,
        "invalid configuration: config.toml does not parse",
    )
    .cause(format!(
        "{}: {}",
        path.display(),
        describe_toml_error(raw, e)
    ))
    .fix(match line {
        Some(n) => format!("fix line {n} of {}", path.display()),
        None => format!("fix {}", path.display()),
    })
    .fix("or move it aside and sign in again with `dg auth login`, which writes a new one")
}

/// Replace every quoted run (`"…"`, `'…'`, `` `…` ``) in a parser message with `…`: serde
/// quotes offending VALUES (`invalid type: string "wJalr…", expected a boolean`), and a
/// value may be a pasted secret. Field names are unquoted in these messages or harmless to
/// lose.
fn strip_quoted(message: &str) -> String {
    let mut out = String::with_capacity(message.len());
    let mut open: Option<char> = None;
    for c in message.chars() {
        match open {
            Some(q) if c == q => {
                open = None;
                out.push('…');
            }
            Some(_) => {}
            None if matches!(c, '"' | '\'' | '`') => open = Some(c),
            None => out.push(c),
        }
    }
    if open.is_some() {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_err(raw: &str) -> toml::de::Error {
        toml::from_str::<toml::Value>(raw).unwrap_err()
    }

    #[test]
    fn a_syntax_error_names_its_line_and_column() {
        let raw = "network = \"devnet\"\ndevnet_name = \"moutai\"\ndefault_identity = \n";
        let msg = describe_toml_error(raw, &parse_err(raw));
        assert!(msg.starts_with("line 3, column 20: "), "{msg}");
    }

    #[test]
    fn columns_count_characters_not_bytes() {
        assert_eq!(line_column("é = x", 4), (1, 4));
        assert_eq!(line_column("a\nbé", 5), (2, 3));
        // Inside a multi-byte character: the character's own column.
        assert_eq!(line_column("é", 1), (1, 1));
        assert_eq!(line_column("ab", 99), (1, 3));
    }

    #[test]
    fn the_config_error_is_e204_and_never_quotes_the_value() {
        let raw = "network = \"devnet\"\ndefault_identity = \"dfk1:SECRET-VALUE\" junk\n";
        let u = config_toml_error(
            Path::new("/home/u/.config/dash-forge/config.toml"),
            raw,
            &parse_err(raw),
        );
        assert_eq!(u.code, codes::INVALID_CONFIG);
        let text = u.render("", false);
        assert!(!text.contains("SECRET-VALUE"), "{text}");
        assert!(
            text.contains("/home/u/.config/dash-forge/config.toml: line 2, column "),
            "{text}"
        );
        assert!(
            text.contains("fix line 2 of /home/u/.config/dash-forge/config.toml"),
            "{text}"
        );
    }

    #[test]
    fn strip_quoted_removes_every_quoted_run() {
        assert_eq!(
            strip_quoted(r#"invalid type: string "s3cr3t", expected a boolean"#),
            "invalid type: string …, expected a boolean"
        );
        assert_eq!(
            strip_quoted("unknown `x` and 'y' and \"z"),
            "unknown … and … and …"
        );
    }
}
