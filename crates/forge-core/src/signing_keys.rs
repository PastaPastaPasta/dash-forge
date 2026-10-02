//! Signing keys on a profile (P1-7): building `profile.pubkeys` entries from a user's SSH or
//! OpenPGP public key, publishing them, and reading a repository's candidate signers for its
//! commits' badges. The entry formats and the verdict are the shared rule in
//! [`crate::rules::signature`].

use std::collections::BTreeMap;

use base64::Engine as _;
use pgp::composed::{Deserializable as _, SignedPublicKey};
use pgp::ser::Serialize as _;
use pgp::types::KeyDetails as _;

use crate::error::{Error, Result};
use crate::members::MemberReader;
use crate::network::ForgeIds;
use crate::platform::{self, FieldValue, PlatformClient, QueryFilter, QueryOrder, WriteEngine};
use crate::profile::{profile_from_doc, Profile, ProfileWrite, DOC_PROFILE};
use crate::rules::signature::{read_pubkey_entry, Signer};
use crate::scope::RepoRef;

/// At most this many keys on a profile (`pubkeys.maxItems`).
pub const MAX_KEYS: usize = 4;
/// At most this many bytes per entry (`pubkeys.items.maxBytes`).
pub const MAX_ENTRY_BYTES: usize = 300;

/// A built entry, refused unless it is one the shared rule verifies and it fits.
fn checked(entry: String) -> Result<String> {
    if entry.len() > MAX_ENTRY_BYTES {
        return Err(Error::Config(format!(
            "the key entry is {} bytes, over the profile's {MAX_ENTRY_BYTES}: use an Ed25519 key (an RSA key does not fit)",
            entry.len()
        )));
    }
    if !read_pubkey_entry(&entry).verifiable {
        return Err(Error::Config(
            "Forge verifies Ed25519 SSH keys and Ed25519 or ECDSA (P-256/384/521) OpenPGP keys; this is neither"
                .into(),
        ));
    }
    Ok(entry)
}

/// The entry for an OpenSSH public key line (`ssh-ed25519 AAAA… comment`, a `.pub` file's
/// contents). The comment is kept when the entry still fits, else dropped.
pub fn ssh_entry(line: &str) -> Result<String> {
    let mut parts = line.split_whitespace();
    let (Some(typ), Some(data)) = (parts.next(), parts.next()) else {
        return Err(Error::Config(
            "an SSH public key line is `ssh-ed25519 AAAA… [comment]`".into(),
        ));
    };
    let comment = parts.collect::<Vec<_>>().join(" ");
    let bare = format!("{typ} {data}");
    let with_comment = format!("{bare} {comment}");
    if !comment.is_empty() && with_comment.len() <= MAX_ENTRY_BYTES {
        if let Ok(e) = checked(with_comment) {
            return Ok(e);
        }
    }
    checked(bare)
}

/// Whether `id` (a key id or fingerprint, hex, any case, an optional `0x` and a trailing `!`)
/// names a key with fingerprint `fpr` (upper-case hex).
fn names(id: &str, fpr: &str) -> bool {
    let id = id.trim_start_matches("0x").trim_end_matches('!');
    id.len() >= 8
        && id.bytes().all(|b| b.is_ascii_hexdigit())
        && fpr.ends_with(&id.to_ascii_uppercase())
}

/// Whether gpg would sign with subkey `s` of `primary`: its binding (and back-signature) verify,
/// it is not revoked, its newest binding lets it sign, and it has not expired.
fn usable_signing_subkey(
    primary: &pgp::packet::PublicKey,
    s: &pgp::composed::SignedPublicSubKey,
) -> bool {
    use pgp::packet::SignatureType;
    if s.verify_bindings(primary).is_err()
        || s.signatures
            .iter()
            .any(|g| g.typ() == Some(SignatureType::SubkeyRevocation))
    {
        return false;
    }
    let Some(binding) = s
        .signatures
        .iter()
        .filter(|g| g.typ() == Some(SignatureType::SubkeyBinding))
        .max_by_key(|g| g.created().map(pgp::types::Timestamp::as_secs))
    else {
        return false;
    };
    let alive = binding.key_expiration_time().is_none_or(|d| {
        u64::from(s.key.created_at().as_secs()) + u64::from(d.as_secs())
            > u64::from(pgp::types::Timestamp::now().as_secs())
    });
    binding.key_flags().sign() && alive
}

/// A key packet with a new-format header (tag 6 or 14), as an entry stores it.
fn framed(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut out = vec![0xc0 | tag];
    let n = u32::try_from(body.len()).unwrap_or(u32::MAX);
    match n {
        0..192 => out.push(n.to_be_bytes()[3]),
        192..8384 => {
            let [_, _, hi, lo] = (n - 192).to_be_bytes();
            out.push(hi + 192);
            out.push(lo);
        }
        _ => {
            out.push(0xff);
            out.extend_from_slice(&n.to_be_bytes());
        }
    }
    out.extend_from_slice(body);
    out
}

/// The entry for an OpenPGP key exported by `gpg --export` (binary or armored): the key git
/// signs with for `wanted` (`user.signingkey`), as gpg picks it: the (sub)key `wanted` names
/// when it ends with `!` or names a subkey; else the newest subkey that may sign, else the
/// primary key.
pub fn openpgp_entry(export: &[u8], wanted: Option<&str>) -> Result<String> {
    let key = if export.starts_with(b"-----BEGIN") {
        SignedPublicKey::from_armor_single(export).map(|(k, _)| k)
    } else {
        SignedPublicKey::from_bytes(export)
    }
    .map_err(|e| Error::Config(format!("not an OpenPGP public key: {e}")))?;
    let primary_fpr = hex::encode_upper(key.primary_key.fingerprint().as_bytes());
    let exact = wanted.is_some_and(|w| w.ends_with('!'));
    let sub_named = key.public_subkeys.iter().find(|s| {
        wanted.is_some_and(|w| names(w, &hex::encode_upper(s.key.fingerprint().as_bytes())))
    });
    if let Some(w) = wanted {
        if sub_named.is_none() && !names(w, &primary_fpr) {
            return Err(Error::Config(format!(
                "the exported key has no (sub)key {w:?}"
            )));
        }
    }
    let signing_sub = key
        .public_subkeys
        .iter()
        .filter(|s| usable_signing_subkey(&key.primary_key, s))
        .max_by_key(|s| s.key.created_at());
    let pick_sub = match (sub_named, exact) {
        (Some(s), _) => Some(s),
        // `<id>!` names exactly the primary key.
        (None, true) => None,
        (None, false) => signing_sub,
    };
    if pick_sub.is_none() {
        // A primary whose self-signatures give it flags without signing (certify-only) cannot sign.
        let flags: Vec<_> = key
            .details
            .users
            .iter()
            .flat_map(|u| u.signatures.iter().map(pgp::packet::Signature::key_flags))
            .collect();
        if flags.iter().any(|f| f.certify() && !f.sign()) {
            return Err(Error::Config(format!(
                "the primary key {primary_fpr} cannot sign (it only certifies) and no subkey that may sign was named"
            )));
        }
    }
    let (fpr, packet) = match pick_sub {
        Some(s) => (
            hex::encode_upper(s.key.fingerprint().as_bytes()),
            framed(
                14,
                &s.key.to_bytes().map_err(|e| Error::Config(e.to_string()))?,
            ),
        ),
        None => (
            primary_fpr,
            framed(
                6,
                &key.primary_key
                    .to_bytes()
                    .map_err(|e| Error::Config(e.to_string()))?,
            ),
        ),
    };
    checked(format!(
        "gpg:{fpr} {}",
        base64::engine::general_purpose::STANDARD.encode(packet)
    ))
}

/// The fingerprint an entry shows (its `SHA256:…` or hex), for listing and removal.
pub fn entry_fingerprint(entry: &str) -> Option<String> {
    read_pubkey_entry(entry).fingerprint
}

/// `pubkeys` with `entry` added (refused when its key is already there or the profile is full).
pub fn with_key(pubkeys: &[String], entry: String) -> Result<Vec<String>> {
    let fp = entry_fingerprint(&entry);
    if fp.is_some() && pubkeys.iter().any(|k| entry_fingerprint(k) == fp) {
        return Err(Error::Config(format!(
            "this key ({}) is already on your profile",
            fp.unwrap_or_default()
        )));
    }
    if pubkeys.len() >= MAX_KEYS {
        return Err(Error::Config(format!(
            "a profile lists at most {MAX_KEYS} keys: remove one first"
        )));
    }
    let mut out = pubkeys.to_vec();
    out.push(entry);
    Ok(out)
}

/// `pubkeys` without the entry whose fingerprint `id` names (its end, at least 8 characters,
/// any case), or the refusal naming what matched.
pub fn without_key(pubkeys: &[String], id: &str) -> Result<Vec<String>> {
    let want = id.trim().to_ascii_uppercase();
    let hits: Vec<usize> = pubkeys
        .iter()
        .enumerate()
        .filter(|(_, k)| {
            want.len() >= 8
                && entry_fingerprint(k).is_some_and(|f| f.to_ascii_uppercase().ends_with(&want))
        })
        .map(|(i, _)| i)
        .collect();
    match hits.as_slice() {
        [i] => Ok(pubkeys
            .iter()
            .enumerate()
            .filter(|(j, _)| j != i)
            .map(|(_, k)| k.clone())
            .collect()),
        [] => Err(Error::Config(format!(
            "no key on your profile has a fingerprint ending in {id:?}"
        ))),
        _ => Err(Error::Config(format!(
            "{id:?} matches more than one key: give more of the fingerprint"
        ))),
    }
}

/// Set the signer's `profile.pubkeys` (an empty list removes the property), creating the profile
/// when the identity has none.
pub async fn write_pubkeys(
    engine: &WriteEngine<'_>,
    client: &PlatformClient,
    forge: &ForgeIds,
    existing: Option<&Profile>,
    pubkeys: &[String],
) -> Result<ProfileWrite> {
    let community = client.fetch_contract(&forge.community).await?;
    let value = (!pubkeys.is_empty()).then(|| FieldValue::text_list(pubkeys.to_vec()));
    match (existing, value) {
        (None, None) => Err(Error::Config("there are no keys to publish".into())),
        (None, Some(value)) => Ok(ProfileWrite::Created(
            engine
                .create_document(
                    &community,
                    DOC_PROFILE,
                    BTreeMap::from([("pubkeys".to_string(), value)]),
                )
                .await?,
        )),
        (Some(p), value) => {
            let changes = BTreeMap::from([("pubkeys".to_string(), value)]);
            let replaced = engine
                .replace_document_guarded(&community, DOC_PROFILE, &p.id, &changes, p.revision)
                .await?;
            Ok(if replaced {
                ProfileWrite::Replaced(p.id.clone())
            } else {
                ProfileWrite::Unchanged(p.id.clone())
            })
        }
    }
}

/// The signing keys `identities` list on their profiles (identities with none left out): one
/// proved query per 100 identities.
pub async fn read_signing_keys(
    client: &PlatformClient,
    forge: &ForgeIds,
    identities: &[String],
) -> Result<Vec<Signer>> {
    let community = client.fetch_contract(&forge.community).await?;
    let mut ids: Vec<&String> = identities.iter().collect();
    ids.sort();
    ids.dedup();
    let mut out = Vec::new();
    for chunk in ids.chunks(100) {
        let values = chunk
            .iter()
            .map(|id| Ok(FieldValue::identifier(platform::decode_identifier(id)?)))
            .collect::<Result<Vec<_>>>()?;
        let docs = client
            .query_documents(
                &community,
                DOC_PROFILE,
                &[QueryFilter::in_list("$ownerId", values)],
                &[QueryOrder::asc("$ownerId")],
                100,
                None,
            )
            .await?;
        out.extend(docs.iter().map(profile_from_doc).filter_map(|p: Profile| {
            (!p.pubkeys.is_empty()).then_some(Signer {
                identity: p.owner,
                pubkeys: p.pubkeys,
            })
        }));
    }
    Ok(out)
}

/// Who may have signed `repo`'s commits: its owner and its current members of every role (and
/// `extra`), each with the keys their profile lists. The same candidates the web reads
/// (`forge-web/lib/repo/signers.ts`).
pub async fn repo_signers(
    client: &PlatformClient,
    repo: &RepoRef,
    extra: &[String],
) -> Result<Vec<Signer>> {
    let mut ids = vec![repo.owner_id().to_string()];
    ids.extend(
        MemberReader::new(client)
            .list(repo)
            .await?
            .into_iter()
            .map(|m| m.identity_id),
    );
    ids.extend(extra.iter().cloned());
    read_signing_keys(client, repo.forge(), &ids).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const SSH: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKlxwBdl5BMou7QztNy8uRfENRcuLEe0EvX22UgM0jQI";

    #[test]
    fn ssh_lines_keep_a_comment_that_fits() {
        let e = ssh_entry(&format!("{SSH} alice@laptop")).unwrap();
        assert_eq!(e, format!("{SSH} alice@laptop"));
        let long = format!("{SSH} {}", "x".repeat(300));
        assert_eq!(
            ssh_entry(&long).unwrap(),
            SSH,
            "a comment that does not fit is dropped"
        );
        assert!(ssh_entry("ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ").is_err());
    }

    #[test]
    fn keys_are_added_once_and_removed_by_fingerprint() {
        let keys = with_key(&[], SSH.to_string()).unwrap();
        assert!(with_key(&keys, SSH.to_string()).is_err(), "no duplicate");
        let fp = entry_fingerprint(SSH).unwrap();
        assert!(without_key(&keys, &fp[fp.len() - 10..]).unwrap().is_empty());
        assert!(without_key(&keys, "zzzzzzzzzz").is_err());
    }

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../forge-contracts/fixtures/signing")
                .join(name),
        )
        .expect("fixture")
    }

    fn vector_entry(name: &str) -> String {
        let v: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(
                format!("../../forge-contracts/vectors/pubkey_entry__{name}.json"),
            ))
            .expect("vector"),
        )
        .expect("json");
        v["input"]["entry"].as_str().expect("entry").to_string()
    }

    /// The same fixtures and entries as `forge-web/lib/repo/signing-keys.test.ts`.
    #[test]
    fn builds_the_entries_the_vectors_hold() {
        let a = fixture("gpg-a.asc");
        assert_eq!(
            openpgp_entry(a.as_bytes(), None).unwrap(),
            vector_entry("gpg_ed25519_primary")
        );
        assert_eq!(
            openpgp_entry(fixture("gpg-b.asc").as_bytes(), None).unwrap(),
            vector_entry("gpg_ed25519_subkey"),
            "a certify-only primary gives its signing subkey"
        );
        assert!(openpgp_entry(fixture("gpg-c.asc").as_bytes(), None).is_err());
        let b = fixture("gpg-b.asc");
        assert_eq!(
            openpgp_entry(b.as_bytes(), Some("BAF14469!")).unwrap(),
            vector_entry("gpg_ed25519_subkey"),
            "a short subkey id, exactly"
        );
        assert_eq!(
            openpgp_entry(b.as_bytes(), Some("002A8C2F6CFBCB36")).unwrap(),
            vector_entry("gpg_ed25519_subkey"),
            "the primary's id signs with its newest valid signing subkey, as gpg does"
        );
        assert!(
            openpgp_entry(b.as_bytes(), Some("002A8C2F6CFBCB36!")).is_err(),
            "the certify-only primary itself cannot sign"
        );
        assert!(openpgp_entry(b.as_bytes(), Some("FFFFFFFF")).is_err());
        assert_eq!(
            ssh_entry(fixture("e.pub").trim()).unwrap(),
            vector_entry("ssh_ed25519")
        );
    }

    #[test]
    fn frames_lengths_as_openpgp_new_format() {
        assert_eq!(framed(6, &[0u8; 51])[..2], [0xc6, 51]);
        assert_eq!(framed(14, &[0u8; 269])[..3], [0xce, 192, 77]);
    }
}
