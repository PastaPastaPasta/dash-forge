//! Ref-name collisions: a new ref that git clients could not hold next to an existing one.
//!
//! Consensus admits both `refs/heads/feature` and `refs/heads/feature/x`, and case variants
//! (`Foo`, `foo`). git cannot: a ref is a file, so `feature` cannot also be a directory (a
//! "D/F conflict", which every git server refuses), and on the case-insensitive file systems of
//! macOS and Windows `Foo` and `foo` are the same file. Clients refuse to create such a ref
//! (git-remote-dash's push, the web's "New branch"); readers still show any that exist. Shared
//! with forge-web's `ref-collision.ts` through the `ref_collision__*` vectors.

/// The existing ref that `name` would collide with, if any: one that is `name`'s parent or child
/// path (`refs/heads/a` and `refs/heads/a/b`), or that differs from it only in ASCII case; the
/// two combine (`Feature` and `feature/x` share one folder on macOS and Windows).
/// `name` itself in `existing` is no collision (that is an update). The first collision in
/// byte order is returned, so every client names the same one.
#[must_use]
pub fn ref_collision<'a, I>(existing: I, name: &str) -> Option<String>
where
    I: IntoIterator<Item = &'a str>,
{
    existing
        .into_iter()
        .filter(|e| *e != name)
        .filter(|e| {
            is_path_prefix(e, name) || is_path_prefix(name, e) || e.eq_ignore_ascii_case(name)
        })
        .min()
        .map(str::to_string)
}

/// `parent` is a directory of `child`, ignoring ASCII case: `child` starts with `parent/`.
fn is_path_prefix(parent: &str, child: &str) -> bool {
    child.len() > parent.len()
        && child.as_bytes()[..parent.len()].eq_ignore_ascii_case(parent.as_bytes())
        && child.as_bytes()[parent.len()] == b'/'
}

/// Why `name` cannot be created next to `existing` (the ref [`ref_collision`] returned), in the
/// words every client uses.
#[must_use]
pub fn collision_reason(name: &str, existing: &str) -> String {
    if existing.eq_ignore_ascii_case(name) {
        format!("{existing} exists and differs only in letter case")
    } else if is_path_prefix(existing, name) {
        format!("{existing} exists, so {name} cannot be created under it")
    } else {
        format!("{existing} exists under it")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folders_and_case_collide_but_siblings_and_updates_do_not() {
        let refs = [
            "refs/heads/feature",
            "refs/heads/Main",
            "refs/heads/featured",
        ];
        let hit = |n: &str| ref_collision(refs.iter().copied(), n);
        assert_eq!(
            hit("refs/heads/feature/x").as_deref(),
            Some("refs/heads/feature")
        );
        assert_eq!(hit("refs/heads/main").as_deref(), Some("refs/heads/Main"));
        assert_eq!(hit("refs/heads").as_deref(), Some("refs/heads/Main"));
        assert_eq!(hit("refs/heads/feature"), None);
        assert_eq!(hit("refs/heads/feat"), None);
        assert_eq!(hit("refs/heads/featured-2"), None);
        assert_eq!(
            hit("refs/heads/Feature/x").as_deref(),
            Some("refs/heads/feature")
        );
    }

    #[test]
    fn reasons_name_the_existing_ref() {
        assert_eq!(
            collision_reason("refs/heads/a/b", "refs/heads/a"),
            "refs/heads/a exists, so refs/heads/a/b cannot be created under it"
        );
        assert_eq!(
            collision_reason("refs/heads/a", "refs/heads/a/b"),
            "refs/heads/a/b exists under it"
        );
        assert_eq!(
            collision_reason("refs/heads/a", "refs/heads/A"),
            "refs/heads/A exists and differs only in letter case"
        );
    }
}
