//! The mirror back-link (forge-v2.md §6.4; TypeScript `forge-web/lib/rules/mirror-backlink.ts`):
//! a file at the root of the source repository that names its Forge mirrors by repo id.
//!
//! A repo's description saying `Mirror of github.com/o/r` is the mirror owner's own claim, and
//! anyone can write it. Only someone who can push to github.com/o/r can add `.dash-forge.json`
//! there, so a mirror the file lists is one the source's maintainers vouch for.
//!
//! ```json
//! {"mirrors":["<repo id>"]}
//! ```
//!
//! The file is read leniently: other keys are ignored (later versions may add some), and so is
//! any entry of `mirrors` that is not a string. Matching is exact: repo ids are case-sensitive
//! base58. Vectors: `forge-contracts/vectors/mirror_backlink__*`.

use serde::{Deserialize, Serialize};

/// The file's name, at the root of the source's default branch.
pub const BACKLINK_FILE: &str = ".dash-forge.json";

/// Larger files are not read: a list of mirrors fits easily, and a reader fetches it unasked.
pub const BACKLINK_MAX_BYTES: usize = 4096;

/// What a back-link file says about one repo.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Backlink {
    /// The file is a JSON object whose `mirrors` is a list, within [`BACKLINK_MAX_BYTES`].
    pub valid: bool,
    /// It lists the repo (never true when the file is not valid).
    pub listed: bool,
}

/// Read a back-link file's text for `repo_id`.
#[must_use]
pub fn read_backlink(text: &str, repo_id: &str) -> Backlink {
    let invalid = Backlink {
        valid: false,
        listed: false,
    };
    if text.len() > BACKLINK_MAX_BYTES {
        return invalid;
    }
    let Ok(serde_json::Value::Object(file)) = serde_json::from_str::<serde_json::Value>(text)
    else {
        return invalid;
    };
    let Some(serde_json::Value::Array(mirrors)) = file.get("mirrors") else {
        return invalid;
    };
    Backlink {
        valid: true,
        listed: !repo_id.is_empty() && mirrors.iter().any(|m| m.as_str() == Some(repo_id)),
    }
}

/// The file that lists `repo_ids`, as a mirror's owner adds it to the source.
#[must_use]
pub fn backlink_file(repo_ids: &[String]) -> String {
    format!("{}\n", serde_json::json!({ "mirrors": repo_ids }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_written_file_lists_its_repos() {
        let ids = vec!["a".to_string(), "b".to_string()];
        let file = backlink_file(&ids);
        assert_eq!(file, "{\"mirrors\":[\"a\",\"b\"]}\n");
        assert!(read_backlink(&file, "b").listed);
        assert!(!read_backlink(&file, "c").listed);
        assert!(!read_backlink(&file, "").listed);
    }
}
