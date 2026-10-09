//! A repo's security policy (`DESIGN.md` mixed-visibility §4.7, D37): the `SECURITY.md` on the
//! default branch. Forge shows it as GitHub does (a "Security policy" link in the repo header,
//! the file at `/<owner>/<repo>/security`, a hint in the new-issue form) and `dg repo view` names
//! its path. There is no report form: intake is the email address and key the file gives.
//!
//! Where it is looked for follows GitHub's order of precedence for files that can live in more
//! than one place (docs.github.com, "Creating a default community health file"): the `.github`
//! folder, then the root, then `docs/`. The first that is a regular file wins. forge-web
//! (`lib/view/security-policy.ts`) holds the same list; both have a test on its order.

/// Where the policy is looked for, in order: the first path that is a regular file at the
/// default branch's tip is the repo's security policy.
pub const SECURITY_POLICY_PATHS: [&str; 3] =
    [".github/SECURITY.md", "SECURITY.md", "docs/SECURITY.md"];

/// The first of [`SECURITY_POLICY_PATHS`] for which `is_file` holds.
pub fn security_policy_path(is_file: impl Fn(&str) -> bool) -> Option<&'static str> {
    SECURITY_POLICY_PATHS.into_iter().find(|p| is_file(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_order_is_dot_github_then_root_then_docs() {
        assert_eq!(
            SECURITY_POLICY_PATHS,
            [".github/SECURITY.md", "SECURITY.md", "docs/SECURITY.md"]
        );
    }

    #[test]
    fn the_first_file_in_order_wins() {
        let all = |_: &str| true;
        assert_eq!(security_policy_path(all), Some(".github/SECURITY.md"));
        let root_and_docs = |p: &str| p == "SECURITY.md" || p == "docs/SECURITY.md";
        assert_eq!(security_policy_path(root_and_docs), Some("SECURITY.md"));
        let docs_only = |p: &str| p == "docs/SECURITY.md";
        assert_eq!(security_policy_path(docs_only), Some("docs/SECURITY.md"));
        assert_eq!(security_policy_path(|_| false), None);
    }
}
