//! A push's view of synced storage: the pusher's own synced profiles and policies, and, for a
//! current maintainer, the storage the repository's owner shared with them (for that repository
//! only).

use std::collections::{BTreeMap, BTreeSet};

use super::{effective, storage, Effective, Origin, ShareContent, UserSync, SLOT_STORAGE};
use crate::error::Result;
use crate::platform::PlatformClient;
use crate::rules::v2::Role;
use crate::scope::RepoRef;
use crate::storage::policy::{ResolvedPolicy, StoragePolicy};
use crate::storage::StorageProfiles;

/// The current maintainers of `repo` (members' documents through the role oracle), without
/// its owner.
pub async fn current_maintainers(
    client: &PlatformClient,
    repo: &RepoRef,
) -> Result<BTreeSet<String>> {
    let members = crate::members::MemberReader::new(client).list(repo).await?;
    let oracle = crate::members::oracle(&members);
    Ok(members
        .iter()
        .map(|m| m.identity_id.clone())
        .filter(|id| id != repo.owner_id() && oracle.current_role(id) == Some(Role::Maintainer))
        .collect())
}

/// What a push to one repository uses.
#[derive(Debug, Clone, Default)]
pub struct PushStorage {
    /// `storage.toml`, the pusher's synced profiles, and the owner's shared ones
    /// (`share.<owner8>.<name>`).
    pub effective: Effective,
    /// The synced policy for this repository, used when git config sets none: the pusher's own
    /// for it, else the one its owner shared, else the pusher's synced default.
    pub policy: Option<StoragePolicy>,
    /// The owner whose storage this push may use, when it is shared with the pusher.
    pub shared_by: Option<String>,
}

/// [`PushStorage`] for `sync`'s identity pushing to `repo_id`, owned by `owner_id`, over
/// `local` (`storage.toml`). `is_maintainer`: the caller checked the pusher is a current
/// maintainer (a share is read only then).
pub async fn push_storage(
    sync: &UserSync<'_>,
    repo_id: &str,
    owner_id: &str,
    is_maintainer: bool,
    local: &StorageProfiles,
) -> Result<PushStorage> {
    let own = sync.read_slot(SLOT_STORAGE).await?.map(|r| r.doc);
    let mut out = PushStorage {
        effective: effective(local, own.as_ref()),
        ..PushStorage::default()
    };
    let own_repo = own
        .as_ref()
        .and_then(|d| d.get(&storage::repo_key(repo_id)))
        .and_then(storage::policy_from_synced);
    let own_default = own
        .as_ref()
        .and_then(|d| d.get(storage::DEFAULT_KEY))
        .and_then(storage::policy_from_synced);
    let mut shared_policy = None;
    if is_maintainer && owner_id != sync.key().identity_id {
        if let Some(share) = sync.granted_share(repo_id, owner_id).await? {
            let (profiles, policy) = share.as_profiles(owner_id);
            for (name, p) in profiles {
                out.effective.origin.insert(name.clone(), Origin::Shared);
                out.effective.profiles.profiles.insert(name, p);
            }
            shared_policy = policy;
            out.shared_by = Some(owner_id.to_string());
        }
    }
    out.policy = own_repo.or(shared_policy).or(own_default);
    Ok(out)
}

impl ShareContent {
    /// The share a push's resolved policy makes: its external targets and the policy over them.
    /// `None` when it names none (Platform only) or one that is itself shared with this owner.
    pub fn for_resolved(policy: &ResolvedPolicy) -> Option<Self> {
        let mut profiles = BTreeMap::new();
        for (name, p) in &policy.external {
            if name.starts_with("share.") {
                return None;
            }
            profiles.insert(name.clone(), storage::profile_to_synced(p).ok()?);
        }
        if profiles.is_empty() {
            return None;
        }
        let raw = StoragePolicy {
            targets: policy.target_names(),
            replicas: Some(policy.replicas),
            platform_fallback: policy.platform_fallback,
        };
        Some(Self {
            profiles,
            policy: storage::policy_to_synced(&raw),
            extra: serde_json::Map::new(),
        })
    }
}
