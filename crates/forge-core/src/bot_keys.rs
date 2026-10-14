//! Bots' post keys on Platform (mixed-visibility DESIGN §4.9, `docs/security/private-repos.md`
//! §23): a maintainer sends each bot of a repository its post key `W_{e,b}` for the current
//! epoch in a `postKey` key letter (kind 10) when members-only content is turned on, when the
//! bot is added, on every rotation (in the same run as the wraps) and on a repair; a bot reads
//! the post keys addressed to it to write members-only posts (`enc` v0x05).
//!
//! A bot never holds the members key (L4) and is never wrapped to, so adding or removing one
//! rotates nothing. Its post key opens nothing but its own posts.

use std::collections::{BTreeMap, BTreeSet};

use crate::error::{Error, Result};
use crate::key_letters::{self, LetterReader};
use crate::keyring::{recipient_key, PrivateSigner};
use crate::members::Member;
use crate::platform::{self, PlatformClient};
use crate::private::bot_post::{PostKey, PostKeyLetter, TYPE_POST_KEY};
use crate::private::key_letter;
use crate::private::named::Recipient;
use crate::private::EpochKeys;
use crate::repo::RepoService;
use crate::rules::v2::Role;
use crate::scope::RepoRef;

/// The most a sealed `postKey` letter takes: a 512-byte plaintext sealed to the sender and the
/// bot (a DFPK 0x02 artifact, header and two slots).
pub const LETTER_BYTES: u64 = 1024;

/// What one `postKey` letter costs (a Platform chunk and its kind-10 manifest), for prompts.
#[must_use]
pub fn letter_credits() -> u64 {
    crate::env::service::snapshot_credits(LETTER_BYTES)
}

/// The bots among `members` (a Bot row, `writer.role` 4): identity ids (base58), each once, in
/// member order, but those in `exclude`.
#[must_use]
pub fn bots_of(members: &[Member], exclude: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for m in members {
        if m.role == Role::Bot && !exclude.contains(&m.identity_id) && !out.contains(&m.identity_id)
        {
            out.push(m.identity_id.clone());
        }
    }
    out
}

/// What [`issue`] did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Issued {
    /// The epoch the post keys are for.
    pub epoch: u32,
    /// Bots sent their post key.
    pub sent: Vec<String>,
    /// Bots that could not be sent one: no usable encryption key (or their identity could not
    /// be read). A repair sends it once they have one.
    pub skipped: Vec<String>,
    /// Why sending stopped before every bot got one, when it did (a key change that already
    /// landed never fails for it: a repair finishes the send).
    pub failed: Option<String>,
}

/// Send the post key of `keys`'s epoch to each of `bots` (base58 ids): one `postKey` letter per
/// bot, sealed to the signer (slot 0, so it can find what it sent) and the bot, stored on
/// Platform as a kind-10 manifest. A bot with no usable encryption key is skipped, never an
/// error; a failed write stops the run (what was sent stays sent; a repair finishes it).
pub async fn issue(
    signer: &PrivateSigner<'_>,
    repo: &RepoRef,
    keys: &EpochKeys,
    bots: &[String],
) -> Result<Issued> {
    let mut out = Issued {
        epoch: keys.epoch(),
        ..Issued::default()
    };
    if bots.is_empty() {
        return Ok(out);
    }
    let enc = signer.encryption_keys(repo);
    let (sender_key_id, sender) = enc.sender().ok_or_else(|| {
        crate::keyring::no_members_encryption_key_held(&format!(
            "give the bots of {} their keys",
            repo.display()
        ))
    })?;
    let me = platform::decode_identifier(&signer.identity.id())?;
    let repo_id = repo.scope()?.repo_id;
    let svc = RepoService::new(signer.client, signer.identity, signer.bridge);
    let core = repo.forge().core.clone();
    for bot in bots {
        let bot_id = platform::decode_identifier(bot)?;
        let public_key = match signer.client.fetch_identity(bot).await {
            Ok(identity) => recipient_key(&identity.public_keys(), &core)
                .and_then(|k| <[u8; 33]>::try_from(k.public_key.as_slice()).ok()),
            Err(Error::NotFound) => None,
            Err(e) => return Err(e),
        };
        let Some(public_key) = public_key else {
            out.skipped.push(bot.clone());
            continue;
        };
        let letter = PostKeyLetter::of(&PostKey::derive(keys, &bot_id)).to_typed();
        let recipients = [
            Recipient {
                identity_id: me,
                public_key: sender.public_key(),
            },
            Recipient {
                identity_id: bot_id,
                public_key,
            },
        ];
        let sealed = key_letter::seal(&repo_id, sender, sender_key_id, &me, &recipients, &letter)?;
        svc.store_key_letter(repo, &sealed).await?;
        out.sent.push(bot.clone());
    }
    Ok(out)
}

/// The `postKey` letters `reader` can open in `repo`: `(sender, letter)`, oldest first. Only a
/// current maintainer's (only maintainers rotate the key); a letter of another type is skipped.
async fn post_key_letters(
    svc: &RepoService<'_>,
    client: &PlatformClient,
    repo: &RepoRef,
    reader: &LetterReader<'_>,
) -> Result<Vec<(String, PostKeyLetter)>> {
    let (manifests, roles) =
        futures::try_join!(svc.read_pack_manifests(repo), svc.copy_roles(repo))?;
    let inbox = key_letters::received(
        svc,
        client,
        repo,
        &manifests,
        &roles,
        reader,
        &BTreeSet::new(),
    )
    .await?;
    Ok(inbox
        .letters
        .into_iter()
        .filter(|r| r.letter.kind == TYPE_POST_KEY)
        .filter(|r| roles.get(&r.manifest.owner_id) == Some(&Role::Maintainer))
        .filter_map(|r| PostKeyLetter::from_typed(&r.letter).map(|l| (r.manifest.owner_id, l)))
        .collect())
}

/// The post keys addressed to the bot `reader` in `repo`, by epoch: from `postKey` letters of a
/// current maintainer, the newest letter of an epoch winning (honest maintainers send the same
/// key: it is derived).
pub async fn received(
    svc: &RepoService<'_>,
    client: &PlatformClient,
    repo: &RepoRef,
    reader: &LetterReader<'_>,
) -> Result<BTreeMap<u32, PostKey>> {
    let repo_id = repo.scope()?.repo_id;
    Ok(post_key_letters(svc, client, repo, reader)
        .await?
        .into_iter()
        .map(|(_, l)| (l.epoch, l.post_key(&repo_id, &reader.identity_id)))
        .collect())
}

/// Which of `bots` have no post key for `keys`'s epoch among the letters the signer sent (its
/// own letters are addressed to it too, slot 0): a letter counts for the bot whose post key it
/// carries (each bot's key differs). Letters other maintainers sent are not visible to the
/// signer, so a bot one of them keyed may be sent the same key again, which is harmless.
pub async fn missing(
    signer: &PrivateSigner<'_>,
    repo: &RepoRef,
    keys: &EpochKeys,
    bots: &[String],
) -> Result<Vec<String>> {
    if bots.is_empty() {
        return Ok(Vec::new());
    }
    let svc = RepoService::new(signer.client, signer.identity, signer.bridge);
    let (id, private_keys) = key_letters::signer_reader_keys(signer, repo)?;
    let reader = LetterReader {
        identity_id: id,
        keys: &private_keys,
    };
    let me = signer.identity.id();
    let sent: Vec<PostKeyLetter> = post_key_letters(&svc, signer.client, repo, &reader)
        .await?
        .into_iter()
        .filter(|(sender, l)| *sender == me && l.epoch == keys.epoch())
        .map(|(_, l)| l)
        .collect();
    let mut out = Vec::new();
    for bot in bots {
        let derived = PostKey::derive(keys, &platform::decode_identifier(bot)?);
        if !sent
            .iter()
            .any(|l| crate::private::keys::ct_eq(&*l.key, derived.key()))
        {
            out.push(bot.clone());
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(id: &str, role: Role) -> Member {
        Member {
            identity_id: id.into(),
            role,
            document_id: format!("d-{id}"),
            created_at: 0,
        }
    }

    #[test]
    fn a_sealed_letter_fits_its_estimate() {
        let sender = crate::envelope::PrivateKey::from_slice(&[7; 32]).unwrap();
        let bot = crate::envelope::PrivateKey::from_slice(&[8; 32]).unwrap();
        let keys = EpochKeys::derive(&[1; 32], 9, &crate::private::EpochKey::from_bytes([2; 32]));
        let letter = PostKeyLetter::of(&PostKey::derive(&keys, &[3; 32])).to_typed();
        let recipients = [
            Recipient {
                identity_id: [4; 32],
                public_key: sender.public_key(),
            },
            Recipient {
                identity_id: [3; 32],
                public_key: bot.public_key(),
            },
        ];
        let sealed =
            key_letter::seal(&[1; 32], &sender, 1, &[4; 32], &recipients, &letter).unwrap();
        assert!(sealed.len() as u64 <= LETTER_BYTES, "{}", sealed.len());
    }

    #[test]
    fn bots_are_the_role_4_rows_once() {
        let members = [
            member("a", Role::Maintainer),
            member("b", Role::Bot),
            member("c", Role::Reader),
            member("d", Role::Bot),
            member("b", Role::Bot),
        ];
        assert_eq!(bots_of(&members, &[]), ["b", "d"]);
        assert_eq!(bots_of(&members, &["d".to_string()]), ["b"]);
    }
}
