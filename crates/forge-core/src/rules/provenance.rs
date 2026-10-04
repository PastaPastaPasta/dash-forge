//! Release provenance (epic E5, TS-04): what a release's tag pointed at when the release was
//! first published, and whether the tag or the release's assets changed since. Everything comes
//! from the chain: the tag's ref updates and config timeline (non-deletable), and the release's
//! revisions (no deletes; an edit is a new revision).
//!
//! A release names no commit of its own on a public repository, so its baseline is the tag's
//! tip when its first revision was published, folded by [`super::resolve_ref`] over the updates
//! written by then. A release that records its commit (`pin`: a sealed release's `target`, or a
//! later `release.targetOid`) is judged against that instead. A tag first pushed after the
//! release (an import that wrote the release before the code) takes its first tip as the
//! baseline, and says so.
//!
//! Parity: `releaseProvenance` in `forge-web/lib/rules/releaseProvenance.ts` (vectors
//! `release_provenance__*`).

use serde::{Deserialize, Serialize};

use super::{is_null_oid, resolve_ref, valid_updates, ConfigDoc, RefState, RefUpdate};

/// One revision of a release, as provenance needs it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvenanceRevision {
    /// Document `$id`.
    pub id: String,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
    /// +1 a publish, 0 an edit or yank, −1 an unpublish.
    pub delta: i64,
    /// `$ownerId`.
    pub publisher: String,
    /// Name and SHA-256 of each asset.
    pub assets: Vec<ProvenanceAsset>,
}

/// An asset's name and hash.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProvenanceAsset {
    /// File name.
    pub name: String,
    /// Hex SHA-256.
    pub sha256: String,
}

/// A tip and the update that set it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProvenanceTip {
    /// The commit or tag object.
    pub oid: String,
    /// Who set it (`$ownerId`).
    pub by: String,
    /// When (`$createdAt`, ms).
    pub at: u64,
}

/// A later update that moved the tag; `to` `None` is a deletion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TagMove {
    /// The update's `$id`.
    pub id: String,
    /// Its `$createdAt` (ms).
    pub at: u64,
    /// Its `$ownerId`.
    pub by: String,
    /// The tip before it.
    pub from: Option<String>,
    /// The tip it set.
    pub to: Option<String>,
}

/// Where the tag stands against the baseline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TagVerdict {
    /// It points where it did, and never moved since.
    Unchanged,
    /// It moved since, and points where it did again.
    Restored,
    /// It points at something else now.
    Moved,
    /// It no longer exists.
    Deleted,
    /// Two tips race: it points nowhere for sure.
    Diverged,
    /// It never existed.
    Missing,
}

/// The newest revision's assets against the first published revision's, by name.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetChanges {
    /// Names only the newest revision lists.
    pub added: Vec<String>,
    /// Names only the first revision listed.
    pub removed: Vec<String>,
    /// Same name, another SHA-256.
    pub replaced: Vec<String>,
}

impl AssetChanges {
    /// No asset changed.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty() && self.replaced.is_empty()
    }
}

/// The first published revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Published {
    /// Its `$id`.
    pub id: String,
    /// Its `$createdAt` (ms).
    pub at: u64,
    /// Its publisher.
    pub by: String,
}

/// What [`release_provenance`] finds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseProvenance {
    /// The first published revision; `None` when the tag has none.
    pub published: Option<Published>,
    /// What the tag pointed at when the release was published (or the release's own pin).
    pub baseline: Option<ProvenanceTip>,
    /// `release`: the baseline is the release's own record; `tag`: the tag's history.
    pub pinned_by: String,
    /// The tag was first pushed after the release was published.
    pub late_tag: bool,
    /// Where the tag points now; `None` when deleted, diverged or never pushed.
    pub current: Option<ProvenanceTip>,
    /// Updates that moved the tag after the baseline was set, oldest first.
    pub moves: Vec<TagMove>,
    /// The tag's verdict.
    pub tag: TagVerdict,
    /// Asset changes since the first publish.
    pub assets: AssetChanges,
}

impl ReleaseProvenance {
    /// The tag or the assets differ from what was first published: readers show it in red
    /// and `dg release verify` exits non-zero.
    #[must_use]
    pub fn altered(&self) -> bool {
        matches!(
            self.tag,
            TagVerdict::Moved | TagVerdict::Deleted | TagVerdict::Diverged | TagVerdict::Missing
        ) || !self.assets.is_empty()
    }
}

fn tip_of(state: &RefState) -> Option<ProvenanceTip> {
    match state {
        RefState::Resolved {
            oid,
            author,
            created_at,
        } => Some(ProvenanceTip {
            oid: oid.clone(),
            by: author.clone(),
            at: *created_at,
        }),
        _ => None,
    }
}

fn asset_changes(first: &ProvenanceRevision, newest: &ProvenanceRevision) -> AssetChanges {
    use std::collections::BTreeMap;
    let map = |r: &ProvenanceRevision| -> BTreeMap<String, String> {
        r.assets
            .iter()
            .map(|a| (a.name.clone(), a.sha256.to_ascii_lowercase()))
            .collect()
    };
    let (was, now) = (map(first), map(newest));
    AssetChanges {
        added: now
            .keys()
            .filter(|n| !was.contains_key(*n))
            .cloned()
            .collect(),
        removed: was
            .keys()
            .filter(|n| !now.contains_key(*n))
            .cloned()
            .collect(),
        replaced: now
            .iter()
            .filter(|(n, h)| was.get(*n).is_some_and(|w| w != *h))
            .map(|(n, _)| n.clone())
            .collect(),
    }
}

/// The provenance of the release of one tag: `ref_name_hash` is `sha256(refs/tags/<tag>)`
/// (hex), `updates` the tag's updates of both types, `revisions` every revision of the tag's
/// release, `pin` the commit (or tag object) the release itself records, when it records one.
#[must_use]
pub fn release_provenance(
    ref_name_hash: &str,
    updates: &[RefUpdate],
    configs: &[ConfigDoc],
    revisions: &[ProvenanceRevision],
    pin: Option<&str>,
) -> ReleaseProvenance {
    let same = |a: &str, b: &str| a == b;
    let mut revisions: Vec<&ProvenanceRevision> = revisions.iter().collect();
    revisions.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
    let live: Vec<&ProvenanceRevision> = revisions.into_iter().filter(|r| r.delta >= 0).collect();
    let (first, newest) = (live.first().copied(), live.last().copied());
    let assets = match (first, newest) {
        (Some(f), Some(n)) => asset_changes(f, n),
        _ => AssetChanges::default(),
    };
    let valid = valid_updates(updates, configs, ref_name_hash);
    let now_state = resolve_ref(updates, configs, ref_name_hash, same);
    let current = tip_of(&now_state);
    let published_at = first.map_or(u64::MAX, |f| f.created_at);

    // The baseline: the release's own pin, else the tag's tip at the first publish, else (a
    // tag pushed later) its first tip.
    let before: Vec<RefUpdate> = valid
        .iter()
        .filter(|u| u.created_at <= published_at)
        .map(|u| (*u).clone())
        .collect();
    let at_publish = tip_of(&resolve_ref(&before, configs, ref_name_hash, same));
    let later: Vec<&RefUpdate> = valid
        .iter()
        .copied()
        .filter(|u| u.created_at > published_at)
        .collect();
    let first_later = later.iter().position(|u| !is_null_oid(&u.new_oid));
    let pin = pin.filter(|p| !is_null_oid(p)).map(str::to_ascii_lowercase);
    let late_tag = at_publish.is_none() && first_later.is_some();
    let tag_baseline = at_publish.or_else(|| {
        first_later.map(|i| ProvenanceTip {
            oid: later[i].new_oid.clone(),
            by: later[i].author.clone(),
            at: later[i].created_at,
        })
    });
    let baseline = match &pin {
        Some(p) => Some(ProvenanceTip {
            oid: p.clone(),
            by: first.map(|f| f.publisher.clone()).unwrap_or_default(),
            at: published_at,
        }),
        None => tag_baseline.clone(),
    };

    // Moves: each later update that changed the tip, walked in the causal order.
    let mut moves = Vec::new();
    let mut tip = tag_baseline.as_ref().map(|t| t.oid.clone());
    let walk = match (late_tag, first_later) {
        (true, Some(i)) => &later[i + 1..],
        _ => &later[..],
    };
    for u in walk {
        let to = (!is_null_oid(&u.new_oid)).then(|| u.new_oid.clone());
        if to == tip {
            continue;
        }
        moves.push(TagMove {
            id: u.id.clone(),
            at: u.created_at,
            by: u.author.clone(),
            from: tip.clone(),
            to: to.clone(),
        });
        tip = to;
    }

    let tag = if valid.is_empty() {
        TagVerdict::Missing
    } else if matches!(now_state, RefState::Diverged { .. }) {
        TagVerdict::Diverged
    } else {
        match (&current, &baseline) {
            (None, _) => TagVerdict::Deleted,
            (Some(c), Some(b)) if c.oid == b.oid => {
                if moves.is_empty() {
                    TagVerdict::Unchanged
                } else {
                    TagVerdict::Restored
                }
            }
            _ => TagVerdict::Moved,
        }
    };

    ReleaseProvenance {
        published: first.map(|f| Published {
            id: f.id.clone(),
            at: f.created_at,
            by: f.publisher.clone(),
        }),
        baseline,
        pinned_by: if pin.is_some() { "release" } else { "tag" }.to_string(),
        late_tag,
        current,
        moves,
        tag,
        assets,
    }
}
