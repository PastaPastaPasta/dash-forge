//! Key letters on Platform (kind 10, `docs/security/private-repos.md` §20): the letters addressed
//! to a reader ([`received`]) and the members-only branches they share with it
//! ([`shared_branches`]). The letter format is [`crate::private::key_letter`]; storing one is
//! [`RepoService::store_key_letter`].

use std::collections::{BTreeMap, BTreeSet};

use futures::StreamExt as _;
use zeroize::Zeroizing;

use crate::envelope::PrivateKey;
use crate::error::{Error, Result};
use crate::platform::{self, PlatformClient};
use crate::private::key_letter::{self, BranchLetter, ManifestCheck, OpenError, TypedLetter};
use crate::private::named::{OwnerKey, Reader};
use crate::refs::GitState;
use crate::repo::{PackManifestInfo, RepoService, RoleMap};
use crate::scope::RepoRef;

/// Letters fetched at once.
const FETCH_WINDOW: usize = 8;

/// A key letter addressed to the reader, from a current maintainer or Write member.
#[derive(Debug, Clone)]
pub struct Received {
    /// Its kind-10 manifest (`$ownerId` is the sender).
    pub manifest: PackManifestInfo,
    /// Its typed body.
    pub letter: TypedLetter,
    /// How many people it is addressed to, the sender included.
    pub recipients: usize,
}

/// Who reads: an identity and its ENCRYPTION private keys.
pub struct LetterReader<'a> {
    /// The identity id.
    pub identity_id: [u8; 32],
    /// Its ENCRYPTION private keys.
    pub keys: &'a [PrivateKey],
}

/// What [`received`] found: the letters addressed to the reader, and the `packHash` of every
/// letter it opened that is not (a reader may remember those and never fetch them again).
#[derive(Debug, Default)]
pub struct Inbox {
    /// The letters addressed to the reader, oldest first.
    pub letters: Vec<Received>,
    /// The letters that opened for nobody among the reader's keys.
    pub not_mine: Vec<[u8; 32]>,
}

/// Every key letter of public `repo` addressed to `reader` (§20.1): the kind-10 manifests whose
/// `$ownerId` is a current maintainer or Write member in `roles`, but those in `skip` (letters
/// this reader already found are not its own), fetched, checked against their `packHash` and
/// opened with the reader's keys. A letter for someone else, a damaged or malformed one, and one
/// whose sender's keys cannot be read are skipped (with a log line), never an error.
pub async fn received(
    svc: &RepoService<'_>,
    client: &PlatformClient,
    repo: &RepoRef,
    manifests: &[PackManifestInfo],
    roles: &RoleMap,
    reader: &LetterReader<'_>,
    skip: &BTreeSet<[u8; 32]>,
) -> Result<Inbox> {
    let letters: Vec<&PackManifestInfo> = manifests
        .iter()
        .filter(|m| m.kind == u64::from(crate::pack::KIND_KEY_LETTER))
        .filter(|m| key_letter::trusted_sender(roles.get(&m.owner_id).copied()))
        .filter(|m| !skip.contains(&m.pack_hash))
        .collect();
    if letters.is_empty() || reader.keys.is_empty() {
        return Ok(Inbox::default());
    }
    let repo_id = repo.scope()?.repo_id;
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
    let mut out = Inbox::default();
    for (m, bytes) in fetched {
        let sealed = match bytes {
            Ok(b) => b,
            Err(e) => {
                tracing::info!(letter = %m.document_id, error = %e, "a key letter could not be fetched; skipped");
                continue;
            }
        };
        if !owner_keys.contains_key(&m.owner_id) {
            let keys = match client.fetch_identity(&m.owner_id).await {
                Ok(identity) => crate::env::codec::owner_keys(&identity.public_keys()),
                Err(Error::NotFound) => Vec::new(),
                Err(e) => {
                    tracing::info!(sender = %m.owner_id, error = %e, "a key letter's sender could not be read; skipped");
                    continue;
                }
            };
            owner_keys.insert(m.owner_id.clone(), keys);
        }
        let check = ManifestCheck {
            pack_hash: &m.pack_hash,
            size_bytes: m.size_bytes,
        };
        let r = Reader {
            identity_id: reader.identity_id,
            keys: reader.keys,
        };
        match key_letter::open(&repo_id, &check, &sealed, &owner_keys[&m.owner_id], &r) {
            Ok(o) => out.letters.push(Received {
                manifest: m.clone(),
                letter: o.letter,
                recipients: o.recipients,
            }),
            Err(OpenError::NotARecipient) => out.not_mine.push(m.pack_hash),
            Err(e) => {
                tracing::info!(letter = %m.document_id, error = %e, "a key letter did not open; skipped");
            }
        }
    }
    out.letters.sort_by(|a, b| {
        (a.manifest.created_at, &a.manifest.document_id)
            .cmp(&(b.manifest.created_at, &b.manifest.document_id))
    });
    Ok(out)
}

/// A members-only branch someone shared with the reader (§20.2), checked against the
/// repository's history.
#[derive(Clone)]
pub struct SharedBranch {
    /// The full ref name.
    pub name: String,
    /// The real head commit, lowercase hex.
    pub head: String,
    /// The members-only packs to fetch (`packHash` → file key).
    pub packs: BTreeMap<[u8; 32], Zeroizing<[u8; 32]>>,
    /// Who shared it (base58 identity id).
    pub sender: String,
    /// When the shared head was pushed (ms).
    pub as_of: u64,
    /// The letter's manifest id.
    pub letter_id: String,
}

/// It carries file keys: `Debug` shows counts only.
impl std::fmt::Debug for SharedBranch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SharedBranch")
            .field("packs", &self.packs.len())
            .finish_non_exhaustive()
    }
}

/// Why a `branch` letter was not taken.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ignored {
    /// No members-only ref update by a current member carries its name hash and blind.
    NoSuchUpdate,
    /// A pack it names is not a members-only pack a current member stored here.
    UnknownPack,
    /// A public branch of the same name is live (public names win).
    PublicName,
}

/// The `branch` letters among `received`, each checked against public `repo`'s history `state`
/// (§20.2): a members-only ref update written by a current member (`roles`) carries the letter's
/// `refNameHash` and blind; every pack it names is a kind-64 manifest in `manifests` by a current
/// member; no live public branch has its name. The newest letter per name wins. Returns what was
/// taken and, per letter id, why the others were not.
#[must_use]
pub fn shared_branches(
    received: &[Received],
    state: &GitState,
    public_live: &BTreeSet<String>,
    manifests: &[PackManifestInfo],
    roles: &RoleMap,
) -> (Vec<SharedBranch>, Vec<(String, Ignored)>) {
    let members_kind = u64::from(crate::pack::KIND_MEMBERS_GIT_PACK);
    let stored: BTreeSet<[u8; 32]> = manifests
        .iter()
        .filter(|m| m.kind == members_kind && crate::repo::trusted_member(roles, &m.owner_id))
        .map(|m| m.pack_hash)
        .collect();
    let updates: BTreeSet<([u8; 32], Vec<u8>)> = state
        .ref_updates
        .iter()
        .chain(&state.protected_ref_updates)
        .filter(|d| crate::repo::trusted_member(roles, &d.owner_id))
        .filter(|d| crate::refs::is_members_only_ref(d))
        .filter_map(|d| Some((d.field_bytes32("refNameHash")?, d.field_bytes("newOid")?)))
        .collect();
    let mut by_name: BTreeMap<String, SharedBranch> = BTreeMap::new();
    let mut ignored = Vec::new();
    // `received` is oldest first, so a newer letter of a name replaces an older one
    for r in received {
        let Some(b) = BranchLetter::from_typed(&r.letter) else {
            continue;
        };
        let id = r.manifest.document_id.clone();
        let why = if public_live.contains(&b.name) {
            Some(Ignored::PublicName)
        } else if !updates.contains(&(b.ref_name_hash, b.head.blind.clone())) {
            Some(Ignored::NoSuchUpdate)
        } else if !b.packs.iter().all(|p| stored.contains(&p.pack_hash)) {
            Some(Ignored::UnknownPack)
        } else {
            None
        };
        if let Some(why) = why {
            ignored.push((id, why));
            continue;
        }
        by_name.insert(
            b.name.clone(),
            SharedBranch {
                head: hex::encode(&b.head.oid),
                packs: b
                    .packs
                    .iter()
                    .map(|p| (p.pack_hash, p.key.clone()))
                    .collect(),
                sender: r.manifest.owner_id.clone(),
                as_of: b.as_of,
                letter_id: id,
                name: b.name,
            },
        );
    }
    (by_name.into_values().collect(), ignored)
}

/// The reader of a signer: its identity id and ENCRYPTION private keys for `repo`.
pub fn signer_reader_keys(
    signer: &crate::keyring::PrivateSigner<'_>,
    repo: &RepoRef,
) -> Result<([u8; 32], Vec<PrivateKey>)> {
    let id = platform::decode_identifier(&signer.identity.id())?;
    Ok((id, signer.encryption_keys(repo).private_keys()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::{FetchedDocument, FieldValue};
    use crate::private::blind;
    use crate::private::key_letter::{LetterHead, LetterPack};
    use crate::rules::v2::Role;

    const MEMBER: &str = "member";
    const STRANGER: &str = "stranger";

    fn letter(name: &str, rnh: [u8; 32], pack: [u8; 32]) -> (BranchLetter, Vec<u8>) {
        let salt = [5u8; 32];
        let oid = vec![0x42; 20];
        let b = blind::blind(&salt, &oid).unwrap();
        (
            BranchLetter {
                name: name.into(),
                ref_name_hash: rnh,
                head: LetterHead {
                    blind: b.clone(),
                    oid,
                    salt,
                },
                packs: vec![LetterPack {
                    pack_hash: pack,
                    key: Zeroizing::new([1; 32]),
                }],
                as_of: 7,
            },
            b,
        )
    }

    fn received(l: &BranchLetter, id: &str, created_at: u64) -> Received {
        Received {
            manifest: manifest(
                id,
                crate::pack::KIND_KEY_LETTER,
                [0; 32],
                MEMBER,
                created_at,
            ),
            letter: l.to_typed().unwrap(),
            recipients: 2,
        }
    }

    fn manifest(
        id: &str,
        kind: u8,
        hash: [u8; 32],
        owner: &str,
        created_at: u64,
    ) -> PackManifestInfo {
        PackManifestInfo {
            document_id: id.into(),
            created_at,
            owner_id: owner.into(),
            pack_hash: hash,
            kind: u64::from(kind),
            size_bytes: 0,
            object_count: 0,
            chunk_count: 0,
            storage: 0,
            uris: Vec::new(),
            supersedes: Vec::new(),
            tips: Vec::new(),
            created_at_block_height: 0,
        }
    }

    fn update(owner: &str, rnh: [u8; 32], new_oid: &[u8]) -> FetchedDocument {
        let mut fields = std::collections::BTreeMap::new();
        fields.insert("refNameHash".into(), FieldValue::Bytes32(rnh));
        fields.insert("newOid".into(), FieldValue::Bytes(new_oid.to_vec()));
        fields.insert("enc".into(), FieldValue::Bytes(vec![3, 1, 2]));
        fields.insert("vis".into(), FieldValue::Text("public".into()));
        FetchedDocument {
            id: "u1".into(),
            owner_id: owner.into(),
            created_at: Some(7),
            created_at_block_height: Some(1),
            updated_at_block_height: None,
            updated_at: None,
            fields,
            revision: None,
        }
    }

    fn roles() -> RoleMap {
        [(MEMBER.to_owned(), Role::Writer)].into_iter().collect()
    }

    #[test]
    fn a_letter_counts_only_against_a_members_push_and_stored_packs() {
        let (l, b) = letter("refs/heads/fix", [9; 32], [4; 32]);
        let packs = [manifest(
            "p",
            crate::pack::KIND_MEMBERS_GIT_PACK,
            [4; 32],
            MEMBER,
            1,
        )];
        let state = GitState {
            ref_updates: vec![update(MEMBER, [9; 32], &b)],
            ..GitState::default()
        };
        let live = BTreeSet::new();
        let (got, ignored) =
            shared_branches(&[received(&l, "l1", 5)], &state, &live, &packs, &roles());
        assert_eq!(got.len(), 1);
        assert!(ignored.is_empty());
        assert_eq!(got[0].head, hex::encode([0x42; 20]));
        assert_eq!(got[0].sender, MEMBER);

        // a push by someone who is not a member, another name hash, a pack nobody stored, a
        // public branch of the same name: each is left out with its reason
        let stranger = GitState {
            ref_updates: vec![update(STRANGER, [9; 32], &b)],
            ..GitState::default()
        };
        let r = [received(&l, "l1", 5)];
        assert_eq!(
            shared_branches(&r, &stranger, &live, &packs, &roles()).1,
            vec![("l1".into(), Ignored::NoSuchUpdate)]
        );
        let other = GitState {
            ref_updates: vec![update(MEMBER, [8; 32], &b)],
            ..GitState::default()
        };
        assert_eq!(
            shared_branches(&r, &other, &live, &packs, &roles()).1,
            vec![("l1".into(), Ignored::NoSuchUpdate)]
        );
        assert_eq!(
            shared_branches(&r, &state, &live, &[], &roles()).1,
            vec![("l1".into(), Ignored::UnknownPack)]
        );
        let public: BTreeSet<String> = ["refs/heads/fix".to_owned()].into();
        assert_eq!(
            shared_branches(&r, &state, &public, &packs, &roles()).1,
            vec![("l1".into(), Ignored::PublicName)]
        );
    }

    #[test]
    fn the_newest_letter_of_a_name_wins() {
        let (l, b) = letter("refs/heads/fix", [9; 32], [4; 32]);
        let mut newer = l.clone();
        newer.as_of = 9;
        let packs = [manifest(
            "p",
            crate::pack::KIND_MEMBERS_GIT_PACK,
            [4; 32],
            MEMBER,
            1,
        )];
        let state = GitState {
            ref_updates: vec![update(MEMBER, [9; 32], &b)],
            ..GitState::default()
        };
        let r = [received(&l, "old", 5), received(&newer, "new", 6)];
        let (got, _) = shared_branches(&r, &state, &BTreeSet::new(), &packs, &roles());
        assert_eq!(got.len(), 1);
        assert_eq!((got[0].letter_id.as_str(), got[0].as_of), ("new", 9));
    }
}
