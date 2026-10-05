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

/// Whether all of `s` matches all of `p`. Memoized on (pattern position, text position), so
/// patterns with several `*` or `**` stay linear in their size times the path's.
fn glob(pat: &[char], text: &[char]) -> bool {
    let mut memo = vec![None; (pat.len() + 1) * (text.len() + 1)];
    glob_at(pat, text, 0, 0, &mut memo)
}

/// Whether `text[at..]` matches `pat[pi..]`.
fn glob_at(
    pat: &[char],
    text: &[char],
    pi: usize,
    at: usize,
    memo: &mut Vec<Option<bool>>,
) -> bool {
    let key = pi * (text.len() + 1) + at;
    if let Some(known) = memo[key] {
        return known;
    }
    let end = text.len();
    let matched = match &pat[pi..] {
        [] => at == end,
        // `**/` also matches nothing: at `at`, or after any later `/`.
        ['*', '*', '/', ..] => (at..=end)
            .any(|t| (t == at || text[t - 1] == '/') && glob_at(pat, text, pi + 3, t, memo)),
        ['*', '*', ..] => (at..=end).any(|t| glob_at(pat, text, pi + 2, t, memo)),
        ['*', ..] => (at..=end)
            .take_while(|&t| t == at || text[t - 1] != '/')
            .any(|t| glob_at(pat, text, pi + 1, t, memo)),
        ['?', ..] => {
            text.get(at).is_some_and(|&ch| ch != '/') && glob_at(pat, text, pi + 1, at + 1, memo)
        }
        [ch, ..] => text.get(at) == Some(ch) && glob_at(pat, text, pi + 1, at + 1, memo),
    };
    memo[key] = Some(matched);
    matched
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

    #[test]
    fn many_stars_stay_fast() {
        let pattern = "**/".repeat(30) + &"*a".repeat(30) + "b";
        let path = "x/".repeat(60) + &"a".repeat(200);
        assert!(!path_matches(&pattern, &path));
    }
}
