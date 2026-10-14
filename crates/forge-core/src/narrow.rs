//! Narrower branches on Platform (phase 3F; mixed-visibility DESIGN §4.3, D34;
//! `docs/security/private-repos.md` §21): the `branchKey` letters a reader holds, read into its
//! [`BranchRing`]; writing them; and the re-lettering an audience or role change needs.
//!
//! **Who gets a letter.** A branch's audience (a group, a group plus people, or people) resolves
//! against the member documents now ([`crate::env::resolve_people`], the owner in every group),
//! and only people with a usable encryption key can be sent one. When the audience grows, the
//! joiners get a letter of the current generation (they read the whole history). When it
//! shrinks, generation g+1 goes to everyone left ([`plan`]). The person making the change does it
//! when they hold the branch key; otherwise the branch's next pusher's client does.

use std::collections::{BTreeMap, BTreeSet};

use futures::StreamExt as _;

use crate::env::Audience;
use crate::error::{Error, Result};
use crate::members::Member;
use crate::platform;
use crate::private::branch_key::{
    self, Branch, BranchKey, BranchKeyLetter, BranchRing, LetterIn,
};
use crate::private::key_letter::{self, ManifestCheck, OpenError};
use crate::private::named::{OwnerKey, Reader, Recipient};
use crate::repo::{PackManifestInfo, PackManifestInput, PlatformChunkTarget, RepoService};
use crate::scope::RepoRef;
use crate::storage::StorageTarget;
use crate::user_error::{codes, UserError};

/// Letters fetched at once.
const FETCH_WINDOW: usize = 8;

/// Who `audience` is now: its group's members (the owner in every group) and its people.
#[must_use]
pub fn resolve_now(audience: &Audience, owner: &str, members: &[Member]) -> BTreeSet<String> {
    crate::env::service::resolve_people(audience, owner, members)
}

/// Every `branchKey` letter of public `repo` addressed to the signer, opened and folded into a
/// ring (each branch's audience resolved now against `members`). Letters are taken from any
/// sender consensus admitted (a maintainer or Write member when written): a removed creator's
/// letters still carry the real keys, and the fold keeps a branch on its first chain. A letter
/// that cannot be fetched or does not open is skipped with a log line.
pub async fn read_ring(
    svc: &RepoService<'_>,
    repo: &RepoRef,
    members: &[Member],
) -> Result<BranchRing> {
    let repo_id = repo.scope()?.repo_id;
    let manifests = svc.read_pack_manifests(repo).await?;
    let letters: Vec<&PackManifestInfo> = manifests
        .iter()
        .filter(|m| m.kind == u64::from(crate::pack::KIND_KEY_LETTER))
        .collect();
    let signer = svc.signer()?;
    let reader_keys = signer.encryption_keys(repo).private_keys();
    let reader_id = platform::decode_identifier(&signer.identity.id())?;
    let mut opened = Vec::new();
    if !letters.is_empty() && !reader_keys.is_empty() {
        let store = crate::storage::PackReader::from_user_config();
        let fetched: Vec<(&PackManifestInfo, Result<Vec<u8>>)> =
            futures::stream::iter(letters.iter().map(|m| {
                let store = &store;
                async move { (*m, svc.fetch_artifact(repo, m, store).await) }
            }))
            .buffer_unordered(FETCH_WINDOW)
            .collect()
            .await;
        let mut owner_keys: BTreeMap<String, Vec<OwnerKey>> = BTreeMap::new();
        let reader = Reader {
            identity_id: reader_id,
            keys: &reader_keys,
        };
        for (m, bytes) in fetched {
            let sealed = match bytes {
                Ok(b) => b,
                Err(e) => {
                    tracing::info!(letter = %m.document_id, error = %e, "a key letter could not be fetched; skipped");
                    continue;
                }
            };
            if !owner_keys.contains_key(&m.owner_id) {
                let keys = match signer.client.fetch_identity(&m.owner_id).await {
                    Ok(identity) => crate::env::owner_keys(&identity.public_keys()),
                    Err(Error::NotFound) => Vec::new(),
                    Err(e) => return Err(e),
                };
                owner_keys.insert(m.owner_id.clone(), keys);
            }
            let check = ManifestCheck {
                pack_hash: &m.pack_hash,
                size_bytes: m.size_bytes,
            };
            let letter = match key_letter::open(&repo_id, &check, &sealed, &owner_keys[&m.owner_id], &reader) {
                Ok(o) => o.letter,
                Err(OpenError::NotARecipient) => continue,
                Err(e) => {
                    tracing::info!(letter = %m.document_id, error = %e, "a key letter did not open; skipped");
                    continue;
                }
            };
            match BranchKeyLetter::from_typed(&letter) {
                Ok(Some(letter)) => opened.push(LetterIn {
                    id: m.document_id.clone(),
                    height: m.created_at_block_height,
                    letter,
                }),
                Ok(None) => {}
                Err(why) => {
                    tracing::info!(letter = %m.document_id, ?why, "a branch key letter was ignored");
                }
            }
        }
    }
    let owner = repo.owner_id();
    Ok(BranchRing::new(&repo_id, branch_key::fold(opened), |b| {
        resolve_now(&b.audience, owner, members)
            .iter()
            .filter_map(|p| platform::decode_identifier(p).ok())
            .collect()
    }))
}

/// The people a letter goes to: the signer first (slot 0), then everyone of `people` with a usable
/// encryption key, by id; and who was left out for having none.
pub struct Recipients {
    /// Slot order.
    pub list: Vec<Recipient>,
    /// The recipients (base58, ascending): the letter's `to`.
    pub to: Vec<String>,
    /// People with no usable encryption key.
    pub skipped: Vec<String>,
}

async fn recipients(
    svc: &RepoService<'_>,
    repo: &RepoRef,
    people: &BTreeSet<String>,
    sender: &crate::envelope::PrivateKey,
    action: &str,
) -> Result<Recipients> {
    let signer = svc.signer()?;
    let me = signer.identity.id();
    let mut list = vec![Recipient {
        identity_id: platform::decode_identifier(&me)?,
        public_key: sender.public_key(),
    }];
    let mut skipped = Vec::new();
    let core = repo.forge().core.clone();
    for other in people.iter().filter(|p| **p != me) {
        let keys = match signer.client.fetch_identity(other).await {
            Ok(identity) => identity.public_keys(),
            Err(Error::NotFound) => Vec::new(),
            Err(e) => return Err(e),
        };
        match crate::keyring::recipient_key(&keys, &core)
            .and_then(|k| <[u8; 33]>::try_from(k.public_key.as_slice()).ok())
        {
            Some(public_key) => list.push(Recipient {
                identity_id: platform::decode_identifier(other)?,
                public_key,
            }),
            None => skipped.push(other.clone()),
        }
    }
    if list.len() > crate::private::named::MAX_ARTIFACT_RECIPIENTS {
        return Err(UserError::new(
            codes::USAGE,
            format!(
                "{action}: {} people. A members-only branch can be for at most {}.",
                list.len(),
                crate::private::named::MAX_ARTIFACT_RECIPIENTS
            ),
        )
        .fix("choose a smaller group or fewer people")
        .note("nothing was written")
        .into());
    }
    let mut to: Vec<String> = list
        .iter()
        .map(|r| platform::encode_identifier(r.identity_id))
        .collect();
    to.sort();
    Ok(Recipients { list, to, skipped })
}

/// A letter written.
#[derive(Debug, Clone)]
pub struct Written {
    /// Its kind-10 manifest's id.
    pub manifest: String,
    /// The generation it carries the key of.
    pub gen: u32,
    /// Who it went to (base58, ascending, the writer among them).
    pub to: Vec<String>,
    /// People of the audience it could not go to: no usable encryption key.
    pub skipped: Vec<String>,
}

/// Seal and store a `branchKey` letter of branch `name` (every generation's key in `keys`, the
/// audience `audience`) to the signer and `people`, as a kind-10 artifact on Platform chunks.
pub async fn write_letter(
    svc: &RepoService<'_>,
    repo: &RepoRef,
    name: &str,
    keys: Vec<BranchKey>,
    audience: Audience,
    people: &BTreeSet<String>,
) -> Result<Written> {
    let action = format!("share {}", crate::keyring::short_branch(name));
    let enc = svc.signer()?.encryption_keys(repo);
    let (sender_key_id, sender) = enc
        .sender()
        .ok_or_else(|| crate::keyring::no_encryption_key_held(&action))?;
    let r = recipients(svc, repo, people, sender, &action).await?;
    let letter = BranchKeyLetter {
        name: name.to_owned(),
        keys,
        audience,
        to: r.to.clone(),
    };
    let me = r.list[0].identity_id;
    let sealed = key_letter::seal(
        &repo.scope()?.repo_id,
        sender,
        sender_key_id,
        &me,
        &r.list,
        &letter.to_typed(),
    )
    .map_err(|e| Error::Config(format!("{action}: {e}")))?;
    let manifest = store_letter(svc, repo, &sealed).await?;
    Ok(Written {
        manifest,
        gen: letter.gen(),
        to: r.to,
        skipped: r.skipped,
    })
}

/// Store a sealed key letter as Platform chunks and record its kind-10 `packManifest` (Platform
/// only: every recipient must find it).
async fn store_letter(svc: &RepoService<'_>, repo: &RepoRef, sealed: &[u8]) -> Result<String> {
    let chain = PlatformChunkTarget::new(svc, repo, crate::storage::PLATFORM_PROFILE);
    let targets: Vec<&dyn StorageTarget> = vec![&chain];
    let meta = crate::backends::PackMeta::for_bytes(sealed);
    let pack_hash = meta.pack_hash_bytes()?;
    let rep = crate::storage::replicate(&targets, sealed, &meta, 1)
        .await
        .map_err(|e| {
            Error::from(UserError::storage_policy_not_met(
                &e,
                "store the branch key",
                false,
            ))
        })?;
    let stored = crate::repo::StoredArtifact::from_replication(&rep, sealed)?;
    svc.write_pack_manifest(
        repo,
        &PackManifestInput {
            pack_hash,
            kind: u64::from(crate::pack::KIND_KEY_LETTER),
            size_bytes: sealed.len() as u64,
            object_count: 0,
            chunk_count: stored.chunk_count,
            storage: stored.storage,
            uris: stored.uris,
            supersedes: Vec::new(),
            tips: Vec::new(),
        },
    )
    .await
}

/// What a narrower branch's letters need now that its audience resolves to `now`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reletter {
    /// Everyone who should hold the current generation does, and nobody else.
    Nothing,
    /// The audience grew: a letter of the current generation to these people.
    Joiners(BTreeSet<String>),
    /// The audience shrank (these people left): generation g+1 to everyone in `now`.
    NewGeneration(BTreeSet<String>),
}

/// What `branch` needs when its audience resolves to `now` (people with no usable encryption key
/// already left out by the caller, `me` included): someone holding the current generation who is
/// not in `now` starts a new generation; otherwise someone in `now` not holding it gets a letter.
#[must_use]
pub fn plan(branch: &Branch, now: &BTreeSet<String>) -> Reletter {
    let left: BTreeSet<String> = branch.holders.difference(now).cloned().collect();
    if !left.is_empty() {
        return Reletter::NewGeneration(left);
    }
    let joined: BTreeSet<String> = now.difference(&branch.holders).cloned().collect();
    if joined.is_empty() {
        Reletter::Nothing
    } else {
        Reletter::Joiners(joined)
    }
}

/// Carry out [`plan`] for `branch` with its audience as `audience` resolving to `now`: a new
/// generation (a fresh key, every earlier key carried) to everyone in `now`, or the current
/// generation to the joiners. `Ok(None)` when nothing is needed.
pub async fn reletter(
    svc: &RepoService<'_>,
    repo: &RepoRef,
    branch: &Branch,
    audience: &Audience,
    now: &BTreeSet<String>,
) -> Result<Option<Written>> {
    match plan(branch, now) {
        Reletter::Nothing => Ok(None),
        Reletter::Joiners(joined) => {
            write_letter(
                svc,
                repo,
                &branch.name,
                branch.keys().to_vec(),
                audience.clone(),
                &joined,
            )
            .await
            .map(Some)
        }
        Reletter::NewGeneration(_) => {
            let mut keys = branch.keys().to_vec();
            keys.push(BranchKey::generate().map_err(|e| Error::Config(e.to_string()))?);
            write_letter(svc, repo, &branch.name, keys, audience.clone(), now)
                .await
                .map(Some)
        }
    }
}

/// Who of `people` can be sent a letter now (a usable encryption key), and who cannot.
pub async fn with_keys(
    svc: &RepoService<'_>,
    repo: &RepoRef,
    people: &BTreeSet<String>,
) -> Result<(BTreeSet<String>, Vec<String>)> {
    let client = svc.signer()?.client;
    let core = repo.forge().core.clone();
    let mut ok = BTreeSet::new();
    let mut skipped = Vec::new();
    for p in people {
        let keys = match client.fetch_identity(p).await {
            Ok(identity) => identity.public_keys(),
            Err(Error::NotFound) => Vec::new(),
            Err(e) => return Err(e),
        };
        if crate::keyring::recipient_key(&keys, &core).is_some() {
            ok.insert(p.clone());
        } else {
            skipped.push(p.clone());
        }
    }
    Ok((ok, skipped))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::Group;
    use crate::private::branch_key::fold;

    fn branch(holders: &[&str]) -> Branch {
        let letter = BranchKeyLetter {
            name: "refs/heads/sec/x".into(),
            keys: vec![BranchKey::from_bytes([1; 32])],
            audience: Audience::group(Group::Maintainers),
            to: holders.iter().map(|s| (*s).to_owned()).collect(),
        };
        let (mut b, _) = fold(vec![LetterIn {
            id: "a".into(),
            height: 1,
            letter,
        }]);
        b.remove("refs/heads/sec/x").unwrap()
    }

    fn set(xs: &[&str]) -> BTreeSet<String> {
        xs.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn a_grown_audience_letters_the_joiners_and_a_shrunk_one_starts_a_generation() {
        let b = branch(&["a", "b"]);
        assert_eq!(plan(&b, &set(&["a", "b"])), Reletter::Nothing);
        assert_eq!(
            plan(&b, &set(&["a", "b", "c"])),
            Reletter::Joiners(set(&["c"]))
        );
        assert_eq!(
            plan(&b, &set(&["a"])),
            Reletter::NewGeneration(set(&["b"]))
        );
        // someone left and someone joined: one new generation for everyone now
        assert_eq!(
            plan(&b, &set(&["a", "c"])),
            Reletter::NewGeneration(set(&["b"]))
        );
    }
}
