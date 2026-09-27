//! After a push: move the head of every open PR the pushed branch is the source of
//! (review-parity R14, §4.6; `dg pr sync` is the same write by hand).
//!
//! For each branch this push moved (not a deletion), the PRs opened from it in this repo are
//! found through the forge-collab `sourceRef` index (`Collab::prs_following`, which also skips
//! closed PRs and PRs already at the new tip). One whose author is the signer gets a
//! `headUpdate` (`authorEvent`, or a member `event` when the author is also a member of the
//! PR's repo): `PR #7 follows this branch: updating its head (≈ 0.0007 DASH)`. Any other PR
//! is only named, with the `dg pr sync` line its author (or a member) can run.
//!
//! `git config dash.prAutoSync false` (or `remote.<name>.dashPrAutoSync`) turns the write
//! off; the helper then prints the `dg pr sync` line for each PR instead. The code that
//! commits to a PR branch on the user's behalf (`dg pr suggestion apply`, `update-branch`)
//! turns it off and posts the head update itself.
//!
//! A failure here never fails the push (the refs already landed): it is reported, with the
//! command that finishes the job.

use anyhow::Result;
use forge_core::collab::v2::{Collab, EventPayload};
use forge_core::rules::EventKind;
use forge_core::storage::policy::parse_git_bool;

use crate::progress::Progress;

/// The git config key (and its per-remote form `remote.<name>.dashPrAutoSync`).
pub const AUTO_SYNC_KEY: &str = "dash.prAutoSync";

/// Whether the push should post head updates: `dash.prAutoSync` (default true), or its
/// per-remote `remote.<name>.dashPrAutoSync`.
pub fn auto_sync_enabled(remote: Option<&str>) -> Result<bool> {
    match crate::policy::config_value(remote, "dashPrAutoSync", "prAutoSync") {
        Some(v) => Ok(parse_git_bool(AUTO_SYNC_KEY, &v)?),
        None => Ok(true),
    }
}

/// A branch this push moved to `oid`.
pub struct Moved {
    /// `refs/heads/…`.
    pub ref_name: String,
    /// The new tip (hex).
    pub oid: String,
}

/// One PR the push concerns, and what happened to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Its head was moved.
    Synced {
        /// The PR's repo (`owner/name`).
        repo: String,
        /// Its number.
        number: u32,
        /// The event's id.
        event: String,
    },
    /// Not moved: auto-sync is off, or the signer is not its author, or the write failed.
    Hint {
        /// The PR's repo.
        repo: String,
        /// Its number.
        number: u32,
        /// Why.
        reason: String,
    },
}

/// The estimate shown on the sync line (an `authorEvent` with an `oid`, measured 71.9M on
/// moutai, review-parity §3.11). The same figure as `dg`'s `Est::AuthorEvent`; the helper
/// does not link `dg`, so it is repeated here.
const HEAD_UPDATE_CREDITS: u64 = 72_000_000;

/// Move the PRs that follow the branches in `moved` (branches of `source`, the repo pushed
/// to), as the collab service's signer.
pub async fn sync_after_push(
    collab: &Collab<'_>,
    source: &forge_core::scope::RepoRef,
    moved: &[Moved],
    enabled: bool,
    progress: Progress,
) -> Vec<Outcome> {
    let mut out = Vec::new();
    let Ok(me) = collab.signer_id() else {
        return out;
    };
    for m in moved
        .iter()
        .filter(|m| m.ref_name.starts_with("refs/heads/"))
    {
        let prs = match collab
            .prs_following(source.forge(), source.id(), &m.ref_name, &m.oid)
            .await
        {
            Ok(p) => p,
            Err(e) => {
                progress.note(&format!(
                    "could not look up pull requests from {}: {e}",
                    crate::progress::short_ref(&m.ref_name)
                ));
                continue;
            }
        };
        for (repo, view) in prs {
            let n = view.patch.number;
            let label = repo.display();
            let hint = |reason: String| Outcome::Hint {
                repo: label.clone(),
                number: n,
                reason,
            };
            let sync_line = format!("dg pr sync {label} {n}");
            if !enabled {
                progress.note(&format!(
                    "PR #{n} in {label} follows this branch; {AUTO_SYNC_KEY} is off: run `{sync_line}` to move its head"
                ));
                out.push(hint(format!("{AUTO_SYNC_KEY} is false")));
                continue;
            }
            if view.patch.author != me {
                progress.note(&format!(
                    "PR #{n} in {label} follows this branch but is not yours; its author (or a member) can run `{sync_line}`"
                ));
                out.push(hint("not the PR's author".into()));
                continue;
            }
            let Ok(oid) = hex::decode(&m.oid) else {
                continue;
            };
            progress.note(&format!(
                "PR #{n} in {label} follows this branch: updating its head to {} (≈ {} DASH)",
                &m.oid[..m.oid.len().min(12)],
                forge_core::repo::credits_to_dash(HEAD_UPDATE_CREDITS)
            ));
            match collab
                .post_target_event(
                    &repo,
                    &view.patch.target(),
                    EventKind::HeadUpdate,
                    &EventPayload {
                        oid: Some(&oid),
                        ..EventPayload::default()
                    },
                )
                .await
            {
                Ok((_, id)) => out.push(Outcome::Synced {
                    repo: label,
                    number: n,
                    event: id,
                }),
                Err(e) => {
                    progress.note(&format!(
                        "the push landed, but PR #{n}'s head was not moved ({e}); run `{sync_line}`"
                    ));
                    out.push(hint(e.to_string()));
                }
            }
        }
    }
    out
}
