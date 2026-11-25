//! A push's view of synced storage: the pusher's own synced profiles and policies, and, for a
//! current maintainer, the storage the repository's owner shared with them (for that repository
//! only).

use std::collections::BTreeSet;

use super::{effective, storage, Effective, Origin, UserSync, SLOT_STORAGE};
use crate::error::Result;
use crate::platform::PlatformClient;
use crate::rules::v2::Role;
use crate::scope::RepoRef;
use crate::storage::policy::StoragePolicy;
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
    /// The synced policy for this repository, used when git config sets none: the first of the
    /// pusher's own for it, the one its owner shared, and the pusher's synced default that
    /// resolves (one naming a profile that is gone or unusable here is skipped).
    pub policy: Option<StoragePolicy>,
    /// The owner whose storage this push may use, when it is shared with the pusher.
    pub shared_by: Option<String>,
    /// Whether [`Self::policy`] is the one the owner shared.
    pub policy_from_share: bool,
    /// Why the owner's share was not used although the pusher is a maintainer (it could not be
    /// read, or a shared name is one of the pusher's own profiles).
    pub share_skipped: Option<String>,
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
    if is_maintainer {
        match sync.granted_share(repo_id, owner_id).await {
            Ok(Some(share)) => {
                let (profiles, policy) = share.as_profiles(owner_id);
                // A shared name the pusher already uses is never replaced: the share is left out.
                if let Some(clash) = profiles
                    .keys()
                    .find(|n| out.effective.profiles.profiles.contains_key(*n))
                {
                    out.share_skipped = Some(format!(
                        "your own storage profile {clash} has the name its share would use"
                    ));
                } else {
                    for (name, p) in profiles {
                        out.effective.origin.insert(name.clone(), Origin::Shared);
                        out.effective.profiles.profiles.insert(name, p);
                    }
                    shared_policy = policy;
                    out.shared_by = Some(owner_id.to_string());
                }
            }
            Ok(None) => {}
            Err(e) => out.share_skipped = Some(format!("it could not be read ({e})")),
        }
    }
    let usable = |p: &Option<StoragePolicy>| {
        p.as_ref()
            .filter(|p| p.resolve(&out.effective.profiles).is_ok())
            .cloned()
    };
    let (own_repo, shared_policy, own_default) = (
        usable(&own_repo),
        usable(&shared_policy),
        usable(&own_default),
    );
    out.policy_from_share = own_repo.is_none() && shared_policy.is_some();
    out.policy = own_repo.or(shared_policy).or(own_default);
    Ok(out)
}
