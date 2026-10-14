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
use crate::private::branch_key::{self, Branch, BranchKey, BranchKeyLetter, BranchRing, LetterIn};
use crate::private::key_letter::{self, ManifestCheck, OpenError};
use crate::private::named::{OwnerKey, Reader, Recipient};
use crate::repo::{PackManifestInfo, RepoService};
use crate::scope::RepoRef;
use crate::user_error::{codes, UserError};

/// Letters fetched at once.
const FETCH_WINDOW: usize = 8;

/// Who `audience` is now: its group's members (the owner in every group) and its people.
#[must_use]
pub fn resolve_now(audience: &Audience, owner: &str, members: &[Member]) -> BTreeSet<String> {
    crate::env::service::resolve_people(audience, owner, members)
}

/// Parse the spelling of a narrower audience (`git config branch.<b>.dashAudience`, `dg branch
/// new --to`): a comma list of at most one group (`maintainers`, `writers`, `members`) and
/// identity ids (base58). `None` for anything else, and for `members` or `public` alone (All
/// members and Public are not narrower: they have no branch key).
#[must_use]
pub fn parse_spec(s: &str) -> Option<Audience> {
    let mut group = None;
    let mut people = BTreeSet::new();
    for item in s.split(',').map(str::trim) {
        match crate::env::Group::parse(item) {
            Some(g) if group.is_none() => group = Some(g),
            Some(_) => return None,
            None => {
                let id = platform::decode_identifier(item).ok()?;
                people.insert(platform::encode_identifier(id));
            }
        }
    }
    if people.is_empty() && matches!(group, None | Some(crate::env::Group::Members)) {
        return None;
    }
    Some(Audience {
        group,
        also: people.into_iter().collect(),
    })
}

/// The spelling [`parse_spec`] reads.
#[must_use]
pub fn spec(a: &Audience) -> String {
    a.group
        .map(|g| g.as_str().to_owned())
        .into_iter()
        .chain(a.also.iter().cloned())
        .collect::<Vec<_>>()
        .join(",")
}

/// How the product names a narrower audience (DESIGN §10): "Maintainers", "Writers and
/// maintainers", "All members + 1 person", "2 people".
#[must_use]
pub fn label(a: &Audience) -> String {
    let people = |n: usize| {
        if n == 1 {
            "1 person".to_owned()
        } else {
            format!("{n} people")
        }
    };
    match (a.group, a.also.len()) {
        (Some(g), 0) => g.label().to_owned(),
        (Some(g), n) => format!("{} + {}", g.label(), people(n)),
        (None, n) => people(n),
    }
}

/// `audience` with `me` among its people when it does not resolve to include them: whoever sets
/// a narrower branch's audience is always in it (as for an environment's Specific people).
#[must_use]
pub fn with_me(audience: &Audience, me: &str, owner: &str, members: &[Member]) -> Audience {
    if resolve_now(audience, owner, members).contains(me) {
        return audience.clone();
    }
    let mut a = audience.clone();
    a.also.push(me.to_owned());
    a.also.sort();
    a.also.dedup();
    a
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
    // a letter with no block height cannot be ordered against the others (nor judged late)
    let letters: Vec<PackManifestInfo> = manifests
        .into_iter()
        .filter(|m| {
            m.kind == u64::from(crate::pack::KIND_KEY_LETTER) && m.created_at_block_height > 0
        })
        .collect();
    let signer = svc.signer()?;
    let reader_keys = signer.encryption_keys(repo).private_keys();
    let reader_id = platform::decode_identifier(&signer.identity.id())?;
    let mut opened = Vec::new();
    if !letters.is_empty() && !reader_keys.is_empty() {
        let store = crate::storage::PackReader::from_user_config();
        // owned manifests: a stream of futures borrowing from a closure's argument is not
        // general enough to be awaited from every caller (the gateway's Send futures)
        let store = &store;
        let fetched: Vec<(PackManifestInfo, Result<Vec<u8>>)> =
            futures::stream::iter(letters.into_iter().map(|m| async move {
                let got = svc.fetch_artifact(repo, &m, store).await;
                (m, got)
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
            let (letter, recipients) = match key_letter::open(
                &repo_id,
                &check,
                &sealed,
                &owner_keys[&m.owner_id],
                &reader,
            ) {
                Ok(o) => (o.letter, o.recipients),
                Err(OpenError::NotARecipient) => continue,
                Err(e) => {
                    tracing::info!(letter = %m.document_id, error = %e, "a key letter did not open; skipped");
                    continue;
                }
            };
            match BranchKeyLetter::from_typed(&letter) {
                // `to` must list exactly the letter's recipients, the reader among them: the
                // next re-lettering trusts it for who holds the key
                Ok(Some(letter))
                    if letter.to.len() != recipients
                        || !letter.to.contains(&platform::encode_identifier(reader_id)) =>
                {
                    tracing::info!(letter = %m.document_id, "a branch key letter's recipient list does not match it; ignored");
                }
                Ok(Some(letter)) => opened.push(LetterIn {
                    id: m.document_id.clone(),
                    height: m.created_at_block_height,
                    sender: m.owner_id.clone(),
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
    let folded = branch_key::fold(opened, |sender, a| {
        resolve_now(a, owner, members).contains(sender)
    });
    Ok(BranchRing::new(&repo_id, folded, |b| {
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

/// The public keys of identity `id`; none for an identity Platform does not have.
async fn public_keys_of(
    client: &platform::PlatformClient,
    id: &str,
) -> Result<Vec<platform::IdentityKeyInfo>> {
    match client.fetch_identity(id).await {
        Ok(identity) => Ok(identity.public_keys()),
        Err(Error::NotFound) => Ok(Vec::new()),
        Err(e) => Err(e),
    }
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
        let keys = public_keys_of(signer.client, other).await?;
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
    /// The KCV prefix of the generation it carries: what the writer's ring must be on once
    /// the letter is read back.
    pub top_kcv: [u8; 4],
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
    let repo_id = repo.scope()?.repo_id;
    let top_kcv = letter
        .keys
        .last()
        .map(|k| branch_key::BranchKeys::derive(&repo_id, letter.gen(), k).kcv4())
        .unwrap_or_default();
    let sealed = key_letter::seal(
        &repo_id,
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
        top_kcv,
    })
}

/// Store a sealed key letter ([`RepoService::store_key_letter`]): its `packManifest` id.
async fn store_letter(svc: &RepoService<'_>, repo: &RepoRef, sealed: &[u8]) -> Result<String> {
    Ok(svc.store_key_letter(repo, sealed).await?.0)
}

/// What a narrower branch's letters need now that its audience resolves to `now`. Every letter
/// goes to everyone in `now`, so every holder's record of who holds the key stays complete.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reletter {
    /// Everyone who should hold the current generation does, and nobody else.
    Nothing,
    /// The audience grew (these people joined): a letter of the current generation.
    Joiners(BTreeSet<String>),
    /// The audience shrank (these people left): generation g+1.
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
    let keys = match plan(branch, now) {
        Reletter::Nothing => return Ok(None),
        Reletter::Joiners(_) => branch.keys().to_vec(),
        Reletter::NewGeneration(_) => {
            let mut keys = branch.keys().to_vec();
            if keys.len() >= branch_key::MAX_GENERATIONS {
                return Err(UserError::new(
                    codes::USAGE,
                    format!(
                        "{} can't get a new key: it has had {} already",
                        crate::keyring::short_branch(&branch.name),
                        keys.len()
                    ),
                )
                .fix("publish its work, then start a new branch for the people it is for now")
                .note("nothing was written")
                .into());
            }
            keys.push(BranchKey::generate().map_err(|e| Error::Config(e.to_string()))?);
            keys
        }
    };
    write_letter(svc, repo, &branch.name, keys, audience.clone(), now)
        .await
        .map(Some)
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
        let keys = public_keys_of(client, p).await?;
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
        let (mut b, _) = fold(
            vec![LetterIn {
                id: "a".into(),
                height: 1,
                sender: "a".into(),
                letter,
            }],
            |_, _| true,
        );
        b.remove("refs/heads/sec/x").unwrap()
    }

    fn set(xs: &[&str]) -> BTreeSet<String> {
        xs.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn specs_round_trip_and_members_alone_is_not_narrower() {
        let id = platform::encode_identifier([7; 32]);
        let a = parse_spec(&format!("maintainers, {id}")).unwrap();
        assert_eq!(a.group, Some(Group::Maintainers));
        assert_eq!(a.also, vec![id.clone()]);
        assert_eq!(parse_spec(&spec(&a)), Some(a.clone()));
        assert_eq!(label(&a), "Maintainers + 1 person");
        assert!(parse_spec("members").is_none() && parse_spec("public").is_none());
        assert!(parse_spec("maintainers,writers").is_none());
        assert!(parse_spec("maintainers,not-an-id").is_none());
        assert_eq!(
            parse_spec(&format!("members,{id}")).unwrap().group,
            Some(Group::Members)
        );
        assert_eq!(
            label(&parse_spec("writers").unwrap()),
            "Writers and maintainers"
        );
    }

    #[test]
    fn a_grown_audience_letters_the_joiners_and_a_shrunk_one_starts_a_generation() {
        let b = branch(&["a", "b"]);
        assert_eq!(plan(&b, &set(&["a", "b"])), Reletter::Nothing);
        assert_eq!(
            plan(&b, &set(&["a", "b", "c"])),
            Reletter::Joiners(set(&["c"]))
        );
        assert_eq!(plan(&b, &set(&["a"])), Reletter::NewGeneration(set(&["b"])));
        // someone left and someone joined: one new generation for everyone now
        assert_eq!(
            plan(&b, &set(&["a", "c"])),
            Reletter::NewGeneration(set(&["b"]))
        );
    }
}
