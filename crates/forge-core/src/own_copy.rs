//! Copies of another repository's packs on the user's own storage (`docs/design/pin-and-fork-copies.md`):
//! a **pin** stores each pack on the user's profile and records a `packMirror` naming it, and a
//! **fork** stores each parent pack before recording it, with its own address first.
//!
//! Bytes are read through the verified read path (recorded copies, then mirrors) and stored
//! through the same verified upload a push uses ([`ExternalTarget`]), so a copy is never anything
//! but the pack.

use crate::backends::{PackMeta, Uri};
use crate::error::{Error, Result};
use crate::platform::LoadedContract;
use crate::repo::{PackManifestInfo, PackManifestInput, RepoService, RoleMap, MANIFEST_URIS_V2};
use crate::rules::pack_mirror::{check_mirror_uris, UriCheck, MAX_URIS};
use crate::scope::RepoRef;
use crate::storage::publish::publish_problem;
use crate::storage::targets::{ExternalTarget, StorageTarget as _};
use crate::storage::{PackReader, Profile};

/// Why `profile` cannot hold a pin other readers use; `None` when it can.
#[must_use]
pub fn pin_profile_problem(profile: &Profile) -> Option<&'static str> {
    match profile {
        Profile::Platform(_) => Some(
            "Platform storage is already permanent, so it needs no pin; pin to storage you run (an IPFS node or a bucket)",
        ),
        Profile::S3(p) if p.public_url.is_none() => Some(
            "this bucket has no public URL, so nobody else could read your copy; set its public URL first",
        ),
        _ => None,
    }
}

/// The addresses a `packMirror` records for a copy stored at `stored`: its public `https://`
/// addresses (an S3 public URL, an IPFS public gateway URL), else its `ipfs://` CID. `None` when
/// the copy has neither (a private bucket's `s3://` locator).
#[must_use]
pub fn mirror_uris(stored: &[String]) -> Option<Vec<String>> {
    let https: Vec<String> = stored
        .iter()
        .filter(|u| u.starts_with("https://") && publish_problem(u).is_none())
        .take(MAX_URIS)
        .cloned()
        .collect();
    let pick = if https.is_empty() {
        stored
            .iter()
            .find(|u| u.starts_with("ipfs://"))
            .map(|u| vec![u.clone()])?
    } else {
        https
    };
    matches!(check_mirror_uris(&pick), UriCheck::Ok { .. }).then_some(pick)
}

/// `input` with `own` addresses first and its own after them, each once, cut to the manifest's
/// URI budget: the parent's private `s3://` locators go first, then the tail.
#[must_use]
pub fn with_own_first(mut input: PackManifestInput, own: &[String]) -> PackManifestInput {
    let mut uris: Vec<String> = Vec::new();
    for u in own.iter().chain(input.uris.iter()) {
        if !uris.contains(u) && u.len() <= MANIFEST_URIS_V2.max_item_len {
            uris.push(u.clone());
        }
    }
    if !MANIFEST_URIS_V2.fits(&uris) {
        let mine = own.len();
        let mut i = 0;
        uris.retain(|u| {
            i += 1;
            i <= mine || !u.starts_with("s3://")
        });
    }
    uris.truncate(MANIFEST_URIS_V2.max_items);
    input.uris = uris;
    input
}

/// Reads packs of `source` and stores them on one target.
pub struct OwnCopy<'a> {
    svc: &'a RepoService<'a>,
    source: &'a RepoRef,
    contract: LoadedContract,
    roles: RoleMap,
    reader: PackReader,
    target: ExternalTarget,
}

impl<'a> OwnCopy<'a> {
    /// A copier of `source`'s packs onto `target`.
    pub async fn new(
        svc: &'a RepoService<'a>,
        source: &'a RepoRef,
        roles: RoleMap,
        target: ExternalTarget,
    ) -> Result<Self> {
        let contract = svc.repo_contract(source).await?;
        Ok(Self {
            svc,
            source,
            contract,
            roles,
            reader: PackReader::from_user_config(),
            target,
        })
    }

    /// The target's profile name.
    #[must_use]
    pub fn target_name(&self) -> &str {
        self.target.name()
    }

    /// Store the pack `copies` record (verified against its hash) on the target; returns the
    /// addresses it is stored at, and where the bytes were read from.
    pub async fn copy(&self, copies: &[&PackManifestInfo]) -> Result<(Vec<String>, String)> {
        let first = copies
            .first()
            .ok_or_else(|| Error::InvalidInput("no copy of the pack to read".into()))?;
        let (bytes, from, _) = self
            .svc
            .fetch_pin_copy_or_mirror(
                self.source,
                &self.contract,
                copies,
                &self.roles,
                &self.reader,
            )
            .await?;
        let meta = PackMeta::for_bytes(&bytes);
        if meta.pack_hash != hex::encode(first.pack_hash) {
            return Err(Error::Io(
                "the pack read back did not hash to its manifest".into(),
            ));
        }
        let stored = self.target.store(&bytes, &meta).await?;
        Ok((stored.into_iter().map(|Uri(u)| u).collect(), from))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|u| (*u).to_string()).collect()
    }

    #[test]
    fn a_mirror_prefers_public_https_then_the_cid() {
        assert_eq!(
            mirror_uris(&s(&[
                "https://gw.example.org/ipfs/bafyabc",
                "ipfs://bafyabc"
            ])),
            Some(s(&["https://gw.example.org/ipfs/bafyabc"]))
        );
        assert_eq!(
            mirror_uris(&s(&["ipfs://bafyabc"])),
            Some(s(&["ipfs://bafyabc"]))
        );
        assert_eq!(
            mirror_uris(&s(&["https://127.0.0.1/ipfs/bafyabc", "ipfs://bafyabc"])),
            Some(s(&["ipfs://bafyabc"]))
        );
        assert_eq!(mirror_uris(&s(&["s3://bucket/key"])), None);
    }

    fn input(uris: &[&str]) -> PackManifestInput {
        PackManifestInput {
            pack_hash: [1; 32],
            kind: 0,
            size_bytes: 1,
            object_count: 1,
            chunk_count: 0,
            storage: 1,
            uris: s(uris),
            supersedes: Vec::new(),
            tips: Vec::new(),
        }
    }

    #[test]
    fn own_addresses_go_first_and_the_parents_fill_the_rest() {
        let got = with_own_first(
            input(&["https://parent.example/p", "ipfs://bafyabc"]),
            &s(&["https://mine.example/p", "ipfs://bafyabc"]),
        );
        assert_eq!(
            got.uris,
            s(&[
                "https://mine.example/p",
                "ipfs://bafyabc",
                "https://parent.example/p"
            ])
        );
    }

    #[test]
    fn an_overfull_list_drops_the_parents_private_locators_then_the_tail() {
        let parent: Vec<String> = (0..8).map(|i| format!("https://p{i}.example/x")).collect();
        let mut with_s3 = parent.clone();
        with_s3.insert(0, "s3://parent/x".into());
        let refs: Vec<&str> = with_s3.iter().map(String::as_str).collect();
        let got = with_own_first(input(&refs), &s(&["https://mine.example/x"]));
        assert_eq!(got.uris.len(), MANIFEST_URIS_V2.max_items);
        assert_eq!(got.uris[0], "https://mine.example/x");
        assert!(!got.uris.iter().any(|u| u.starts_with("s3://")));
    }
}
