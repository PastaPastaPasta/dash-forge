//! Which git packs a repack superseded, for the readers that skip them when the consolidated
//! pack is at hand: a fetch (git-remote-dash, Q5-B15) and `dg reseed --from-local` (Q5-B17).
//!
//! Only a git-pack manifest recorded by a current maintainer or writer supersedes anything (as
//! in [`super::copies`]): a stranger's manifest naming every pack must not hide them.

use std::collections::{BTreeMap, BTreeSet};

use crate::pack::KIND_GIT_PACK;
use crate::repo::{PackManifestInfo, RoleMap};
use crate::rules::v2::Role;

/// Each superseded pack, with the packs that supersede it.
pub type Claims = BTreeMap<[u8; 32], BTreeSet<[u8; 32]>>;

/// Each git pack a repack superseded, with the packs that supersede it: the `supersedes` of
/// git-pack manifests recorded by a current maintainer or writer (`roles`). Anyone else's
/// manifest naming every pack supersedes nothing, and no pack supersedes itself.
pub fn superseded_by(manifests: &[PackManifestInfo], roles: &RoleMap) -> Claims {
    let mut claims = Claims::new();
    // Only those who may record a pack at all (as reseed requires): a maintainer or a writer.
    for m in manifests.iter().filter(|m| {
        m.kind == u64::from(KIND_GIT_PACK)
            && matches!(
                roles.get(&m.owner_id),
                Some(Role::Maintainer | Role::Writer)
            )
    }) {
        for old in m.supersedes.iter().filter(|old| **old != m.pack_hash) {
            claims.entry(*old).or_default().insert(m.pack_hash);
        }
    }
    claims
}

/// The packs of `pending` to handle this round: those no other pending pack supersedes
/// (`claims`, [`superseded_by`]), so a repack is handled before the packs it replaces. When
/// every pending pack waits on another (repacks naming each other), all of them.
pub fn round_now(pending: &[[u8; 32]], claims: &Claims) -> BTreeSet<[u8; 32]> {
    let waiting: BTreeSet<[u8; 32]> = pending.iter().copied().collect();
    let now: BTreeSet<[u8; 32]> = pending
        .iter()
        .filter(|h| {
            claims
                .get(*h)
                .is_none_or(|by| by.iter().all(|s| !waiting.contains(s)))
        })
        .copied()
        .collect();
    if now.is_empty() {
        waiting
    } else {
        now
    }
}

/// The superseded packs ([`superseded_by`]) a reader need not handle: those a pack it `has`
/// supersedes, directly or through a chain of repacks (a pack superseded by a covered pack is
/// covered too).
pub fn covered_packs(claims: &Claims, has: impl Fn(&[u8; 32]) -> bool) -> BTreeSet<[u8; 32]> {
    let mut covered = BTreeSet::new();
    loop {
        let more: Vec<[u8; 32]> = claims
            .iter()
            .filter(|(old, by)| {
                !covered.contains(*old) && by.iter().any(|s| has(s) || covered.contains(s))
            })
            .map(|(old, _)| *old)
            .collect();
        if more.is_empty() {
            return covered;
        }
        covered.extend(more);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(hash: u8, owner: &str, supersedes: &[u8]) -> PackManifestInfo {
        PackManifestInfo {
            document_id: format!("d{hash}{owner}"),
            created_at: u64::from(hash),
            owner_id: owner.into(),
            pack_hash: [hash; 32],
            kind: 0,
            size_bytes: 10,
            object_count: 1,
            chunk_count: 0,
            storage: 1,
            uris: Vec::new(),
            supersedes: supersedes.iter().map(|h| [*h; 32]).collect(),
            tips: Vec::new(),
            created_at_block_height: 0,
        }
    }

    fn members() -> RoleMap {
        [("m".to_string(), Role::Writer)].into()
    }

    /// Q5-B15: only a member's git-pack manifest supersedes, and never its own pack.
    #[test]
    fn only_a_members_repack_supersedes_packs() {
        let mut env = manifest(9, "m", &[1]);
        env.kind = 3;
        let claims = superseded_by(
            &[
                manifest(1, "m", &[]),
                manifest(2, "m", &[]),
                manifest(3, "m", &[1, 2, 3]),
                manifest(4, "stranger", &[1, 2, 3, 5]),
                env,
            ],
            &members(),
        );
        let want: Claims = [([1; 32], [[3; 32]].into()), ([2; 32], [[3; 32]].into())].into();
        assert_eq!(claims, want);
    }

    /// Q5-B15: a superseded pack is covered once a pack superseding it is here, through a
    /// chain of repacks; while none is, it is not.
    #[test]
    fn a_pack_is_covered_only_when_its_superseding_pack_is_here() {
        // 3 superseded 1 and 2; 5 later superseded 3 and 4.
        let claims = superseded_by(
            &[
                manifest(3, "m", &[1, 2]),
                manifest(5, "m", &[3, 4]),
                manifest(6, "m", &[]),
            ],
            &members(),
        );
        let all: BTreeSet<[u8; 32]> = [[1; 32], [2; 32], [3; 32], [4; 32]].into();
        assert_eq!(covered_packs(&claims, |h| *h == [5; 32]), all);
        let under_3: BTreeSet<[u8; 32]> = [[1; 32], [2; 32]].into();
        assert_eq!(covered_packs(&claims, |h| *h == [3; 32]), under_3);
        assert!(covered_packs(&claims, |h| *h == [6; 32]).is_empty());
        // Two repacks that name each other (a cycle) cover nothing unless one is here.
        let cycle = superseded_by(
            &[manifest(7, "m", &[8]), manifest(8, "m", &[7])],
            &members(),
        );
        assert!(covered_packs(&cycle, |_| false).is_empty());
    }

    /// Q5-B15: a round handles the newest repack first; its packs wait for it, and a cycle of
    /// repacks naming each other is handled at once.
    #[test]
    fn a_round_handles_a_repack_before_the_packs_it_replaces() {
        let claims = superseded_by(
            &[
                manifest(3, "m", &[1, 2]),
                manifest(5, "m", &[3, 4]),
                manifest(6, "m", &[]),
            ],
            &members(),
        );
        let all = [[1; 32], [2; 32], [3; 32], [4; 32], [5; 32], [6; 32]];
        let first: BTreeSet<[u8; 32]> = [[5; 32], [6; 32]].into();
        assert_eq!(round_now(&all, &claims), first);
        // 5 did not arrive: 3 and 4 come next, and 1 and 2 still wait for 3.
        let next: BTreeSet<[u8; 32]> = [[3; 32], [4; 32]].into();
        assert_eq!(round_now(&all[..4], &claims), next);
        let cycle = superseded_by(
            &[manifest(7, "m", &[8]), manifest(8, "m", &[7])],
            &members(),
        );
        assert_eq!(round_now(&[[7; 32], [8; 32]], &cycle).len(), 2);
    }

    /// Q5-B15: a triage member's or reader's manifest supersedes nothing (only a maintainer or
    /// a writer records packs).
    #[test]
    fn only_a_pusher_supersedes() {
        let roles: RoleMap = [
            ("t".to_string(), Role::Triage),
            ("r".to_string(), Role::Reader),
        ]
        .into();
        assert!(
            superseded_by(&[manifest(3, "t", &[1]), manifest(4, "r", &[2])], &roles).is_empty()
        );
    }
}
