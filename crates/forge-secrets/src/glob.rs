//! Path globs for the allow file, close to `.gitignore`'s:
//!
//! - `*` matches any characters except `/`; `?` matches one character except `/`; `**` matches
//!   anything, `/` included, and `**/` also matches nothing (`a/**/b` matches `a/b`).
//! - A pattern with no `/` (a trailing one aside) matches a file or folder of that name at any
//!   depth: `*.pem` matches `certs/dev.pem`, `fixtures` matches `src/fixtures/key.pem`.
//! - Any other pattern matches from the root (a leading `/` is dropped): `config/dev.env`.
//! - A pattern also matches every file under a folder it matches; a trailing `/` makes it match
//!   folders only.

/// Whether `path` (`/`-separated, relative to the root) matches `pattern`.
pub fn path_matches(pattern: &str, path: &str) -> bool {
    let folders_only = pattern.ends_with('/');
    let p = pattern.trim_end_matches('/');
    let rooted = p.contains('/');
    let p = p.trim_start_matches('/');
    if p.is_empty() {
        return false;
    }
    let pat: Vec<char> = p.chars().collect();
    let parts: Vec<&str> = path.split('/').collect();
    let n = parts.len();
    if rooted {
        // Every leading run of parts: the folders, then (unless folders only) the whole path.
        (1..=n)
            .filter(|&k| k < n || !folders_only)
            .any(|k| glob(&pat, &parts[..k].join("/").chars().collect::<Vec<_>>()))
    } else {
        parts
            .iter()
            .enumerate()
            .filter(|&(i, _)| i + 1 < n || !folders_only)
            .any(|(_, part)| glob(&pat, &part.chars().collect::<Vec<_>>()))
    }
}

fn glob(p: &[char], s: &[char]) -> bool {
    match p {
        [] => s.is_empty(),
        ['*', '*', rest @ ..] => match rest {
            ['/', after @ ..] => {
                (0..=s.len()).any(|i| (i == 0 || s[i - 1] == '/') && glob(after, &s[i..]))
            }
            _ => (0..=s.len()).any(|i| glob(rest, &s[i..])),
        },
        ['*', rest @ ..] => (0..=s.len())
            .take_while(|&i| i == 0 || s[i - 1] != '/')
            .any(|i| glob(rest, &s[i..])),
        ['?', rest @ ..] => s.first().is_some_and(|&c| c != '/') && glob(rest, &s[1..]),
        [c, rest @ ..] => s.first() == Some(c) && glob(rest, &s[1..]),
    }
}

#[cfg(test)]
mod tests {
    use super::path_matches;

    #[test]
    fn a_name_matches_at_any_depth() {
        assert!(path_matches("*.pem", "certs/dev.pem"));
        assert!(path_matches(".env", ".env"));
        assert!(path_matches(".env", "app/.env"));
        assert!(!path_matches(".env", "app/.env.local"));
        assert!(path_matches("fixtures", "src/fixtures/key.pem"));
        assert!(path_matches("fixtures/", "src/fixtures/key.pem"));
        assert!(!path_matches("key.pem/", "src/key.pem"));
    }

    #[test]
    fn a_path_matches_from_the_root() {
        assert!(path_matches("config/dev.env", "config/dev.env"));
        assert!(!path_matches("config/dev.env", "app/config/dev.env"));
        assert!(path_matches("/config/*.env", "config/dev.env"));
        assert!(!path_matches("config/*.env", "config/sub/dev.env"));
        assert!(path_matches("config/**/*.env", "config/sub/dev.env"));
        assert!(path_matches("config/**/*.env", "config/dev.env"));
        assert!(path_matches("docs/examples", "docs/examples/a/b.pem"));
        assert!(path_matches("**/keys/*", "a/b/keys/k.pem"));
        assert!(!path_matches("", "a"));
        assert!(path_matches("a?c", "abc"));
        assert!(!path_matches("a?c", "a/c"));
    }
}
