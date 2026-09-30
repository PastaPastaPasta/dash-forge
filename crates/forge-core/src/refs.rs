//! Ref-update reads: every ref's complete `refUpdate` + `protectedRefUpdate` history, and the
//! repository's `config` timeline.
//!
//! Shared by [`crate::repo::RepoService::read_refs`] (list every ref) and the PR base-tip
//! reader in [`crate::collab`] (one ref). forge-web's `lib/repo/refs.ts` implements the same
//! reads; the two must agree, because the fold over their output
//! ([`crate::rules::resolve_ref`]) is only as parity-safe as its input.
//!
//! ## How the history is read: a delta over `$createdAt`
//!
//! `refUpdate`, `protectedRefUpdate` and `config` are immutable and non-deletable, and each
//! has a `(repoId, $createdAt)` index (`reflog` / `created`). So the history is read through
//! [`crate::history`]: the first read of a repository pages each type by
//! `$createdAt >= cursor` (a range where-clause, never a `startAfter` cursor document), and
//! every later read fetches only what landed since, all three types in ONE composite request.
//! The copy is complete by construction: nothing below the cursor can change or disappear, and
//! the boundary block is re-read and deduplicated by `$id`.
//!
//! This replaces the `refState` keyset scan. That scan existed because paging the
//! `(refNameHash, $createdAt)` index with a `startAfter` cursor LOSES rows on protocol 13 (the
//! cursor's bounds leak into sibling `refNameHash` branches; dashpay/platform#4396). A
//! single-branch `(repoId, $createdAt)` range read has no sibling branches and no cursor
//! document, so neither failure applies; and the `reflog` read, which the scan kept only as its
//! fallback, is now the only read and costs O(new rows) instead of O(history).
//!
//! The fold sorts its input by `(createdAt, id)` itself, so a copy assembled across several
//! reads folds exactly like one complete read.

use std::collections::{BTreeMap, BTreeSet};

use crate::error::Result;
use crate::history::Freshness;
use crate::history::HistorySpec;
use crate::platform::{FetchedDocument, LoadedContract, PlatformClient};
use crate::rules::v2::{is_well_formed, ContentDoc, ContentKind, Visibility};
use crate::rules::{ConfigDoc, MergeBaseTips, RefUpdate};
use crate::scope::DocScope;

/// The plain ref-update document type.
pub(crate) const DOC_REF_UPDATE: &str = "refUpdate";
/// The MAINTAIN-gated ref-update document type.
pub(crate) const DOC_PROTECTED_REF_UPDATE: &str = "protectedRefUpdate";
/// The repository `config` document type (protected patterns, default branch).
pub(crate) const DOC_CONFIG: &str = "config";

/// Every ref's history, keyed by the raw `refNameHash`.
pub type RefHistories = BTreeMap<[u8; 32], Vec<RefUpdate>>;

/// Whether a public repository's `config` row is well-formed (forge-v2 §5): readers skip one
/// that is not, so a writer must not build on it either.
pub(crate) fn config_well_formed(d: &FetchedDocument) -> bool {
    well_formed_in(ContentKind::Config, d)
}

/// Whether `d` is well-formed for a PUBLIC repository (forge-v2 §5); private repositories
/// read through [`read_private_refs`], which checks the private form.
fn well_formed_in(kind: ContentKind, d: &FetchedDocument) -> bool {
    is_well_formed(&content_of(kind, d), Visibility::Public)
}

/// The §5 content view of a ref-update or config row.
fn content_of(kind: ContentKind, d: &FetchedDocument) -> ContentDoc {
    ContentDoc {
        kind,
        title: None,
        body: None,
        ref_name: d.field_str("refName"),
        base_ref_name: None,
        source_ref_name: None,
        ref_name_hash: d.field_hex("refNameHash"),
        base_ref_name_hash: None,
        source_ref_name_hash: None,
        path: None,
        default_branch: d.field_str("defaultBranch"),
        protected_patterns: Some(crate::scope::doc_text_list(d, "protectedPatterns"))
            .filter(|p| !p.is_empty()),
        enc: d.field_hex("enc").filter(|h| !h.is_empty()),
        epoch: d.field_u64("epoch").and_then(|e| u32::try_from(e).ok()),
        release_fields: Vec::new(),
    }
}

/// The raw, append-only git-data history of one repository: every `refUpdate`,
/// `protectedRefUpdate` and `config` row, ascending by `($createdAt, $id)`.
///
/// Read through the delta cache ([`crate::history`]): the first read of a repository pages
/// every type in batched requests, and every later one reads only what landed since, all
/// types in ONE composite request. Nothing here is folded or filtered: the rows are what
/// Platform holds (ciphertext, for a private repository), and callers apply the rules.
#[derive(Debug, Clone, Default)]
pub struct GitState {
    /// `refUpdate` rows.
    pub ref_updates: Vec<FetchedDocument>,
    /// `protectedRefUpdate` rows.
    pub protected_ref_updates: Vec<FetchedDocument>,
    /// `config` rows.
    pub configs: Vec<FetchedDocument>,
}

impl GitState {
    /// The three types' history specs of the repository `scope` names, in [`Self::from_rows`]
    /// order.
    pub fn specs<'c>(contract: &'c LoadedContract, scope: &DocScope) -> [HistorySpec<'c>; 3] {
        [
            HistorySpec::new(contract, DOC_REF_UPDATE, scope),
            HistorySpec::new(contract, DOC_PROTECTED_REF_UPDATE, scope),
            HistorySpec::new(contract, DOC_CONFIG, scope),
        ]
    }

    /// The state from the rows [`crate::history::sync`] returned for [`Self::specs`].
    pub fn from_rows(
        [ref_updates, protected_ref_updates, configs]: [Vec<FetchedDocument>; 3],
    ) -> Self {
        Self {
            ref_updates,
            protected_ref_updates,
            configs,
        }
    }

    /// The well-formed public updates, each with its `protected` flag and `refNameHash`.
    fn updates(&self) -> impl Iterator<Item = (&FetchedDocument, bool, [u8; 32])> {
        [
            (&self.ref_updates, false),
            (&self.protected_ref_updates, true),
        ]
        .into_iter()
        .flat_map(|(rows, protected)| rows.iter().map(move |d| (d, protected)))
        .filter(|(d, _)| well_formed_in(ContentKind::RefUpdate, d))
        .filter_map(|(d, protected)| Some((d, protected, d.field_bytes32("refNameHash")?)))
    }

    /// Every well-formed public ref update, grouped per ref (the public read's input).
    pub fn ref_histories(&self) -> RefHistories {
        let mut by_hash = RefHistories::new();
        for (d, protected, hash) in self.updates() {
            by_hash.entry(hash).or_default().push(ref_update_from_doc(
                d,
                &hex::encode(hash),
                protected,
            ));
        }
        by_hash
    }

    /// The well-formed public updates of the one ref keyed `hash`.
    pub fn ref_history(&self, hash: [u8; 32]) -> Vec<RefUpdate> {
        let hash_hex = hex::encode(hash);
        self.updates()
            .filter(|(_, _, h)| *h == hash)
            .map(|(d, protected, _)| ref_update_from_doc(d, &hash_hex, protected))
            .collect()
    }

    /// The well-formed public config timeline ([`read_config_history`]).
    pub fn config_history(&self) -> Vec<ConfigDoc> {
        self.configs
            .iter()
            .filter(|d| well_formed_in(ContentKind::Config, d))
            .map(crate::repo::config_doc)
            .collect()
    }

    /// The newest public config row (the one in force now), by `($createdAt, $id)`.
    pub fn newest_config(&self) -> Option<&FetchedDocument> {
        self.configs.last()
    }
}

/// Read the repository's git-data history (see [`GitState`]).
pub async fn read_git_state(
    client: &PlatformClient,
    contract: &LoadedContract,
    scope: &DocScope,
    freshness: Freshness,
) -> Result<GitState> {
    let rows = crate::history::sync(client, &GitState::specs(contract, scope), freshness).await?;
    Ok(GitState::from_rows(crate::history::take(rows)))
}

/// The repository's **complete** `config` history (append-only, non-deletable), as
/// [`ConfigDoc`]s ordered by `$createdAt`.
///
/// Complete by construction (the delta cache is exact for an append-only type), and read now
/// (one delta request): its callers route a ref write by it, and a config that landed since
/// this process last read one must not be missed (a newly protected ref would get an inert
/// plain `refUpdate`). `config_as_of` treats "no config in force at time T" as UNPROTECTED, so
/// a truncated history does not merely go stale — it silently re-admits plain `refUpdate`s on
/// protected refs that the rules had correctly rendered inert. forge-web reads the same
/// timeline, and the two clients must fold the same input.
pub async fn read_config_history(
    client: &PlatformClient,
    contract: &LoadedContract,
    scope: &DocScope,
) -> Result<Vec<ConfigDoc>> {
    Ok(read_git_state(client, contract, scope, Freshness::Now)
        .await?
        .config_history())
}

/// The history of the ref named `ref_name` that a PR opened at `opened_at` (its `$createdAt`)
/// is merged against ([`crate::rules::pr_base_tips`]): its updates and the config timeline,
/// folded so that a plain `refUpdate` on a protected ref (inert, §4) never counts as a base
/// tip, and a base that was no branch when the PR was opened has no tips.
///
/// `freshness` [`Freshness::Synced`] reuses a history this process already read (a list of
/// PRs folds every row against one read of the refs, not one per row).
pub async fn read_merge_base(
    client: &PlatformClient,
    contract: &LoadedContract,
    scope: &DocScope,
    ref_name: &str,
    opened_at: u64,
    freshness: Freshness,
) -> Result<MergeBaseTips> {
    let state = read_git_state(client, contract, scope, freshness).await?;
    Ok(merge_base_of(
        &state,
        &state.config_history(),
        ref_name,
        opened_at,
    ))
}

/// [`read_merge_base`] over a history already read, with its config timeline
/// ([`GitState::config_history`], computed once by a caller folding many PRs).
pub fn merge_base_of(
    state: &GitState,
    configs: &[ConfigDoc],
    ref_name: &str,
    opened_at: u64,
) -> MergeBaseTips {
    let hash = crate::backends::sha256(ref_name.as_bytes());
    crate::rules::pr_base_tips(
        &state.ref_history(hash),
        configs,
        &hex::encode(hash),
        opened_at,
    )
}

/// Every ref of a PRIVATE repository and its resolved state (`docs/security/private-repos.md`
/// §4.5, §8.1).
///
/// A private ref's `refNameHash` is keyed per epoch, so one ref's history spans a hash per
/// epoch, and its name is only inside `enc`. So this reads the complete reflog of both types
/// (no keyset scan: the hash groups nothing across epochs), opens every update with
/// [`open_content`](crate::private::open_content) (framing, epoch, key, AD with the hash, the
/// oids and `force`, the ref-name hash check, the late-content rule), and groups the readable
/// ones by their decrypted name. Each opened update is then restated with the public key
/// (`refNameHash = sha256(refName)`, the name set) and folded by the same
/// [`crate::rules::resolve_ref`] as a public repository, over the decrypted config timeline.
/// Updates that do not open are skipped, as malformed ones are in a public repository.
pub async fn read_private_refs(
    client: &PlatformClient,
    contract: &LoadedContract,
    scope: &DocScope,
    keyring: &crate::keyring::Keyring,
) -> Result<Vec<(String, crate::rules::RefState)>> {
    let configs = &keyring.config().history;
    Ok(read_private_updates(client, contract, scope, keyring)
        .await?
        .into_iter()
        .map(|(name, updates)| {
            let hash_hex = hex::encode(crate::backends::sha256(name.as_bytes()));
            let state = crate::rules::resolve_ref(&updates, configs, &hash_hex, |a, b| a == b);
            (name, state)
        })
        .collect())
}

/// [`read_merge_base`] for a PRIVATE repository: the base ref's decrypted history, across
/// every epoch the reader holds, over the decrypted config timeline.
pub async fn read_private_merge_base(
    client: &PlatformClient,
    contract: &LoadedContract,
    scope: &DocScope,
    keyring: &crate::keyring::Keyring,
    ref_name: &str,
    opened_at: u64,
) -> Result<MergeBaseTips> {
    let updates = read_private_updates(client, contract, scope, keyring).await?;
    Ok(private_merge_base(&updates, keyring, ref_name, opened_at))
}

/// [`read_private_merge_base`] over the decrypted updates already read ([`PrivateUpdates`]):
/// a list of pull requests reads the reflog once, not once per row.
#[must_use]
pub fn private_merge_base(
    updates: &PrivateUpdates,
    keyring: &crate::keyring::Keyring,
    ref_name: &str,
    opened_at: u64,
) -> MergeBaseTips {
    let empty = Vec::new();
    // the PR's base must have been a branch when it was opened (D-501), as in a public repo
    crate::rules::pr_base_tips(
        updates.get(ref_name).unwrap_or(&empty),
        &keyring.config().history,
        &hex::encode(crate::backends::sha256(ref_name.as_bytes())),
        opened_at,
    )
}

/// Every readable ref update of a private repository by decrypted ref name.
pub type PrivateUpdates = BTreeMap<String, Vec<RefUpdate>>;

/// Every readable ref update of a private repository, grouped by its decrypted name and
/// restated with the public key (`refNameHash = sha256(refName)`), so the public folds apply.
pub async fn read_private_updates(
    client: &PlatformClient,
    contract: &LoadedContract,
    scope: &DocScope,
    keyring: &crate::keyring::Keyring,
) -> Result<PrivateUpdates> {
    // The raw (sealed) rows through the delta cache; they are opened on every read and never
    // stored opened.
    let state = read_git_state(client, contract, scope, Freshness::Now).await?;
    Ok(private_updates_of(&state, keyring))
}

/// [`read_private_updates`] over a history already read: every update `keyring` opens,
/// grouped by its decrypted name.
pub fn private_updates_of(state: &GitState, keyring: &crate::keyring::Keyring) -> PrivateUpdates {
    use crate::private::{DocKind, Opened};
    let mut by_name: BTreeMap<String, Vec<RefUpdate>> = BTreeMap::new();
    for (rows, protected, kind) in [
        (&state.ref_updates, false, DocKind::RefUpdate),
        (
            &state.protected_ref_updates,
            true,
            DocKind::ProtectedRefUpdate,
        ),
    ] {
        for d in rows {
            if !is_well_formed(&content_of(ContentKind::RefUpdate, d), Visibility::Private) {
                continue;
            }
            let Opened::Readable(fields) = keyring.open(kind, d) else {
                continue;
            };
            let Some(name) = fields.ref_name.clone() else {
                continue;
            };
            let hash_hex = hex::encode(crate::backends::sha256(name.as_bytes()));
            let mut u = ref_update_from_doc(d, &hash_hex, protected);
            u.ref_name.clone_from(&name);
            by_name.entry(name).or_default().push(u);
        }
    }
    by_name
}

/// Whether some update's non-null `prevOid` is no update's `newOid` in the same ref — a
/// parent that should have been read and was not. Parity: forge-web `hasMissingParent`.
pub fn has_missing_parent(updates: &[RefUpdate]) -> bool {
    let tips: BTreeSet<&str> = updates.iter().map(|u| u.new_oid.as_str()).collect();
    updates.iter().any(|u| {
        let null = u.prev_oid.is_empty() || u.prev_oid.bytes().all(|b| b == b'0');
        !null && !tips.contains(u.prev_oid.as_str())
    })
}

/// Flatten a ref-update document to the [`RefUpdate`] shape the fold consumes.
pub fn ref_update_from_doc(d: &FetchedDocument, hash_hex: &str, protected: bool) -> RefUpdate {
    RefUpdate {
        id: d.id.clone(),
        ref_name_hash: hash_hex.to_string(),
        ref_name: d.field_str("refName").unwrap_or_default(),
        prev_oid: d.field_hex("prevOid").unwrap_or_default(),
        new_oid: d.field_hex("newOid").unwrap_or_default(),
        force: d.field_bool("force"),
        protected,
        author: d.owner_id.clone(),
        created_at: d.created_at.unwrap_or(0),
    }
}

#[cfg(test)]
mod tests {
    use super::{has_missing_parent, GitState};
    use crate::platform::{FetchedDocument, FieldValue};
    use std::collections::BTreeMap;

    fn update(name: &str, id: u32, t: u64, prev: u8, new: u8) -> FetchedDocument {
        let mut fields = BTreeMap::new();
        fields.insert(
            "refNameHash".into(),
            FieldValue::Bytes32(crate::backends::sha256(name.as_bytes())),
        );
        fields.insert("refName".into(), FieldValue::Text(name.into()));
        fields.insert("newOid".into(), FieldValue::Bytes(vec![new; 20]));
        if prev != 0 {
            fields.insert("prevOid".into(), FieldValue::Bytes(vec![prev; 20]));
        }
        FetchedDocument {
            id: format!("id{id:05}"),
            owner_id: "pusher".into(),
            created_at: Some(t),
            created_at_block_height: None,
            updated_at_block_height: None,
            revision: None,
            fields,
        }
    }

    /// The fold's input is independent of how the rows were assembled: rows in delta order
    /// (arrival), grouped per ref, give each ref its whole history.
    #[test]
    fn git_state_groups_every_update_per_ref() {
        let state = GitState {
            ref_updates: vec![
                update("refs/heads/main", 1, 10, 0, 1),
                update("refs/heads/dev", 2, 11, 0, 7),
                update("refs/heads/main", 3, 12, 1, 2),
            ],
            protected_ref_updates: vec![update("refs/heads/main", 4, 13, 2, 3)],
            configs: Vec::new(),
        };
        let by = state.ref_histories();
        let main = &by[&crate::backends::sha256(b"refs/heads/main")];
        assert_eq!(main.len(), 3);
        assert_eq!(main.iter().filter(|u| u.protected).count(), 1);
        assert_eq!(by.len(), 2);
        let base = super::merge_base_of(&state, &[], "refs/heads/main", 11);
        assert!(base.historical.contains(&"02".repeat(20)), "{base:?}");
    }

    #[test]
    fn v2_readers_skip_malformed_ref_updates() {
        use crate::backends::sha256;
        use crate::rules::v2::ContentKind;
        let doc = |name: &str, hash: [u8; 32], enc: bool| {
            let mut fields = BTreeMap::new();
            fields.insert("refNameHash".into(), FieldValue::Bytes32(hash));
            fields.insert("refName".into(), FieldValue::Text(name.into()));
            fields.insert("newOid".into(), FieldValue::Bytes(vec![1; 20]));
            if enc {
                fields.insert("enc".into(), FieldValue::Bytes(vec![9; 40]));
                fields.insert("epoch".into(), FieldValue::integer(0));
            }
            FetchedDocument {
                id: "d".into(),
                owner_id: "o".into(),
                created_at: Some(1),
                created_at_block_height: None,
                updated_at_block_height: None,
                revision: None,
                fields,
            }
        };
        let main = sha256(b"refs/heads/main");
        let ok = doc("refs/heads/main", main, false);
        assert!(super::well_formed_in(ContentKind::RefUpdate, &ok));
        assert!(!super::well_formed_in(
            ContentKind::RefUpdate,
            &doc("refs/heads/main", main, true)
        ));
        assert!(!super::well_formed_in(
            ContentKind::RefUpdate,
            &doc("refs/heads/other", main, false)
        ));
    }

    #[test]
    fn missing_parent_detection() {
        let u = |prev: &str, new: &str| crate::rules::RefUpdate {
            id: new.into(),
            ref_name_hash: "h".into(),
            ref_name: "refs/heads/x".into(),
            prev_oid: prev.into(),
            new_oid: new.into(),
            force: false,
            protected: false,
            author: "a".into(),
            created_at: 0,
        };
        assert!(!has_missing_parent(&[u("", "aa"), u("aa", "bb")]));
        assert!(
            !has_missing_parent(&[u("0000", "aa"), u("aa", "0000")]),
            "create + delete"
        );
        assert!(has_missing_parent(&[u("", "aa"), u("cc", "dd")]));
    }
}
