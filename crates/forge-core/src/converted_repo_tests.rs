//! A repository made public, as every reader meets it (`docs/security/private-repos.md` §18;
//! DESIGN §4.10, phase R6). No Platform: the repository's documents and packs are built in
//! memory with the production sealers, in both conversion modes, and read back through the same
//! functions the helper, the gateway, `dg` and forks use:
//!
//! * **Code only**: a fresh plaintext pack of `main` and plaintext refs; everything sealed while
//!   private stays sealed.
//! * **Everything**: the same, plus a kind-7 bundle from the owner publishing the pre-seal-off
//!   epoch key.
//!
//! The private era: epoch 0 (the owner's anchor, vis "private"), then the seal-off rotation to
//! epoch 1 (still private, carrying epoch 0's key), then the flip and the first plaintext config
//! (the conversion marker). A pack pushed while private holds `main` and a branch deleted later;
//! an issue written while private is sealed v0x01. After the conversion a members-only comment
//! is sealed v0x03 under epoch 1.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use super::roundtrip_tests::{commit, git, index_pack};
use crate::private::convert::{
    open_vis, published_keys, skip_reason, ConfigStamp, Conversion, PublishedBundle, SkipReason,
};
use crate::private::epoch::{ConfigRow, MemberRow, WrapRow};
use crate::private::{
    bundle, doc, pack, resolve_epochs, DocHeader, DocKind, EpochKey, EpochKeys, Fields,
    OpenContext, Opened, Unreadable,
};
use crate::rules::v2::{Role, Visibility};

const REPO: [u8; 32] = [0x11; 32];
const OWNER: [u8; 32] = [0xa1; 32];
const MEMBER: [u8; 32] = [0xb0; 32];
const STRANGER: [u8; 32] = [0xcc; 32];
/// The conversion marker's block height (the first plaintext config).
const MARKER: u64 = 40;

fn key(b: u8) -> EpochKey {
    EpochKey::from_bytes([b; 32])
}

/// A pack of `revs` (`git pack-objects --revs`) from `dir`.
fn pack_of(dir: &Path, revs: &[&str]) -> Vec<u8> {
    use std::io::Write as _;
    let mut child = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["pack-objects", "--stdout", "--revs", "-q"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    for r in revs {
        writeln!(stdin, "{r}").unwrap();
    }
    drop(stdin);
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    out.stdout
}

/// One stored pack: its first-upload height and its bytes as storage holds them.
struct Stored {
    height: u64,
    bytes: Vec<u8>,
}

/// The repository as Platform and storage would hold it.
struct Converted {
    configs: Vec<ConfigRow>,
    stamps: Vec<ConfigStamp>,
    members: Vec<MemberRow>,
    packs: Vec<Stored>,
    /// `main` (published by the fresh pack) and the branch deleted while private.
    main: String,
    deleted: String,
    /// The issue written while private: its header (vis private) and `enc` (v0x01).
    old_issue: (DocHeader, Vec<u8>),
    /// A members-only comment written after the conversion (vis public, v0x03, epoch 1).
    new_comment: (DocHeader, Vec<u8>),
    /// A later client's members-only comment (`enc` v0x05).
    later_comment: (DocHeader, Vec<u8>),
    /// The owner's make-public bundle (Everything mode only).
    bundle: Option<PublishedBundle>,
}

fn config(
    epoch: u32,
    k: &EpochKey,
    height: u64,
    prev: Option<(u32, EpochKey)>,
    id: u8,
) -> ConfigRow {
    let mut header = DocHeader::new(DocKind::Config, OWNER, epoch);
    header.vis = Visibility::Private;
    let mut f = Fields {
        default_branch: Some("refs/heads/main".into()),
        ..Fields::default()
    };
    if let Some((p, pk)) = prev {
        f.prev_epoch = Some(p);
        f.prev_epoch_key = Some(pk);
    }
    ConfigRow {
        id: [id; 32],
        owner: OWNER,
        epoch,
        created_at_block_height: height,
        created_at: height * 1000,
        enc: doc::seal(&EpochKeys::derive(&REPO, epoch, k), &header, &f).unwrap(),
    }
}

fn build(everything: bool, src: &Path) -> Converted {
    let (k0, k1) = (key(0x30), key(0x31));
    let e0 = EpochKeys::derive(&REPO, 0, &k0);
    let e1 = EpochKeys::derive(&REPO, 1, &k1);
    git(src, &["init", "-q", "-b", "main"]);
    commit(src, "a.txt", "a", "a");
    let main = commit(src, "b.txt", "b", "b");
    git(src, &["checkout", "-q", "-b", "gone"]);
    let deleted = commit(src, "c.txt", "c", "c (deleted before the conversion)");
    git(src, &["checkout", "-q", "main"]);

    // the private era: one pack of everything, sealed under epoch 0
    let private_pack = pack::seal(&e0, &pack_of(src, &["main", "gone"])).unwrap();
    // after the flip: one fresh plaintext pack of the published ref
    let fresh = pack_of(src, &["main"]);
    let configs = vec![
        config(0, &k0, 10, None, 0xc0),
        config(1, &k1, 30, Some((0, k0.clone())), 0xc1), // the seal-off rotation, still private
    ];
    let mut stamps: Vec<ConfigStamp> = configs
        .iter()
        .map(|c| ConfigStamp {
            id: c.id,
            epoch: Some(c.epoch),
            private: true,
            height: c.created_at_block_height,
        })
        .collect();
    stamps.push(ConfigStamp {
        id: [0xcf; 32],
        epoch: None,
        private: false,
        height: MARKER,
    });

    let mut issue = DocHeader::new(DocKind::Issue, OWNER, 0);
    issue.number = Some(1);
    issue.created_at_block_height = Some(20);
    let issue_enc = doc::seal(
        &e0,
        &issue,
        &Fields {
            title: Some("written while private".into()),
            ..Fields::default()
        },
    )
    .unwrap();
    let mut comment = DocHeader::new(DocKind::Comment, MEMBER, 1);
    comment.vis = Visibility::Public;
    comment.target_id = Some([0x33; 32]);
    comment.created_at_block_height = Some(60);
    let comment_enc = doc::seal_members(
        &e1,
        &comment,
        &Fields {
            body: Some("after the conversion".into()),
            ..Fields::default()
        },
    )
    .unwrap();
    let mut later = comment_enc.clone();
    later[0] = 0x05;

    let bundle = everything.then(|| PublishedBundle {
        owner: OWNER,
        bytes: bundle::encode(
            &[
                bundle::Entry {
                    kind: bundle::ENTRY_EPOCH_KEY,
                    target: REPO,
                    revision: 0,
                    key: k0.clone(),
                },
                // the seal-off epoch is never honoured, whoever writes it
                bundle::Entry {
                    kind: bundle::ENTRY_EPOCH_KEY,
                    target: REPO,
                    revision: 1,
                    key: k1.clone(),
                },
            ],
            "",
        )
        .unwrap(),
    });
    Converted {
        configs,
        stamps,
        members: vec![
            MemberRow {
                identity: OWNER,
                role: Role::Maintainer,
                created_at: 1,
            },
            MemberRow {
                identity: MEMBER,
                role: Role::Writer,
                created_at: 2,
            },
        ],
        packs: vec![
            Stored {
                height: 15,
                bytes: private_pack,
            },
            Stored {
                height: 50,
                bytes: fresh,
            },
        ],
        main,
        deleted,
        old_issue: (issue, issue_enc),
        new_comment: (comment.clone(), comment_enc.clone()),
        later_comment: (comment, later),
        bundle,
    }
}

/// What one reader ends up with.
struct Read {
    ctx: OpenContext,
    /// Bytes requested from storage, per pack: a head (36) or the whole pack.
    requested: Vec<usize>,
}

/// Read `repo` as `reader` would (the member holds a wrap of epoch 1; anyone else none), the way
/// the helper does: conversion facts from the configs, the published keys, then every pack:
/// judged by its first bytes when it may be sealed, downloaded, then opened or skipped, and
/// indexed into the bare repository `dst`.
fn read(repo: &Converted, reader: [u8; 32], dst: &Path) -> Read {
    let wraps: Vec<WrapRow> = (reader == MEMBER)
        .then(|| WrapRow {
            id: [0xd1; 32],
            owner: OWNER,
            member_id: MEMBER,
            epoch: 1,
            recipient_key_id: 4,
            key_enabled: true,
            key: Some(key(0x31)),
        })
        .into_iter()
        .collect();
    let mut resolution = resolve_epochs(&REPO, &reader, &repo.members, &repo.configs, &wraps);
    let conversion =
        Conversion::of(true, &repo.stamps, |e| resolution.anchors.contains_key(&e)).unwrap();
    assert_eq!(conversion.seal_off_epoch, Some(1));
    let (published, alerts) = published_keys(
        &REPO,
        &OWNER,
        &conversion,
        &resolution.anchors,
        repo.bundle.as_slice(),
    );
    assert!(alerts.is_empty());
    assert!(
        !published.contains_key(&1),
        "the seal-off epoch is never published"
    );
    resolution.add_published(&REPO, &repo.configs, published, alerts);
    let ctx = resolution.open_context(&REPO);
    let holds = |e: u32| ctx.keys.contains_key(&e);

    git(dst, &["init", "-q", "--bare"]);
    let mut requested = Vec::new();
    for p in &repo.packs {
        if conversion.may_be_sealed(p.height) {
            requested.push(pack::HEADER_LEN);
            if skip_reason(&p.bytes[..pack::HEADER_LEN], holds).is_some() {
                continue; // skipped without downloading the rest
            }
        }
        requested.push(p.bytes.len());
        // the whole (hash-verified) artifact is judged again: a host that lied about the head
        // costs a download, never a wrong read
        let bytes = match skip_reason(&p.bytes, holds) {
            Some(_) => continue,
            None if pack::sniff(&p.bytes) == pack::Head::Plain => p.bytes.clone(),
            None => pack::open(&p.bytes, p.bytes.len() as u64, |e| ctx.keys.get(&e)).unwrap(),
        };
        index_pack(dst, &bytes);
    }
    Read { ctx, requested }
}

fn has(dst: &Path, oid: &str) -> bool {
    std::process::Command::new("git")
        .arg("-C")
        .arg(dst)
        .args(["cat-file", "-e", &format!("{oid}^{{commit}}")])
        .status()
        .unwrap()
        .success()
}

/// `open_content` the way `Keyring::open` takes a stored document: its own `vis` stamp.
fn open(ctx: &OpenContext, (header, enc): &(DocHeader, Vec<u8>), stamp: &str) -> Opened {
    let mut h = header.clone();
    h.vis = open_vis(Some(stamp), Visibility::Public, true, enc.first().copied()).unwrap();
    doc::open_content(ctx, &h, enc)
}

#[test]
fn code_only_a_non_member_clones_the_published_code_and_downloads_no_sealed_pack() {
    let (src, dst) = (
        tempfile::TempDir::new().unwrap(),
        tempfile::TempDir::new().unwrap(),
    );
    let repo = build(false, src.path());
    for reader in [STRANGER, OWNER] {
        let dst = tempfile::TempDir::new().unwrap();
        // the owner holds no wrap in this fixture: like a stranger, it reads the published side
        let r = read(&repo, reader, dst.path());
        assert_eq!(
            r.requested,
            vec![pack::HEADER_LEN, repo.packs[1].bytes.len()]
        );
        assert!(has(dst.path(), &repo.main), "the published branch clones");
        assert!(!has(dst.path(), &repo.deleted));
        assert_eq!(
            open(&r.ctx, &repo.old_issue, "private"),
            Opened::Unreadable(Unreadable::NoKey),
            "old issues stay members-only placeholders"
        );
    }
    let r = read(&repo, STRANGER, dst.path());
    assert_eq!(
        open(&r.ctx, &repo.new_comment, "public"),
        Opened::Unreadable(Unreadable::NoKey)
    );
    assert_eq!(
        open(&r.ctx, &repo.later_comment, "public"),
        Opened::Unreadable(Unreadable::UnknownVersion)
    );
}

#[test]
fn code_only_a_member_opens_the_old_content_and_the_whole_history() {
    let (src, dst) = (
        tempfile::TempDir::new().unwrap(),
        tempfile::TempDir::new().unwrap(),
    );
    let repo = build(false, src.path());
    let r = read(&repo, MEMBER, dst.path());
    // epoch 1's wrap walks the chain to epoch 0: the sealed pack is downloaded and opened
    assert_eq!(
        r.requested,
        vec![
            pack::HEADER_LEN,
            repo.packs[0].bytes.len(),
            repo.packs[1].bytes.len()
        ]
    );
    assert!(has(dst.path(), &repo.main) && has(dst.path(), &repo.deleted));
    assert!(matches!(
        open(&r.ctx, &repo.old_issue, "private"),
        Opened::Readable(f) if f.title.as_deref() == Some("written while private")
    ));
    assert!(matches!(
        open(&r.ctx, &repo.new_comment, "public"),
        Opened::Readable(f) if f.body.as_deref() == Some("after the conversion")
    ));
    // a later client's envelope is members-only to this reader too, never malformed
    assert_eq!(
        open(&r.ctx, &repo.later_comment, "public"),
        Opened::Unreadable(Unreadable::UnknownVersion)
    );
}

#[test]
fn everything_anyone_opens_what_was_written_before_the_seal_off_and_nothing_after() {
    let (src, dst) = (
        tempfile::TempDir::new().unwrap(),
        tempfile::TempDir::new().unwrap(),
    );
    let repo = build(true, src.path());
    let r = read(&repo, STRANGER, dst.path());
    assert_eq!(r.ctx.keys.keys().copied().collect::<Vec<_>>(), vec![0]);
    // the published key opens the pack of the private era: deleted history included
    assert!(has(dst.path(), &repo.main) && has(dst.path(), &repo.deleted));
    assert!(matches!(
        open(&r.ctx, &repo.old_issue, "private"),
        Opened::Readable(f) if f.title.as_deref() == Some("written while private")
    ));
    // what members write from the seal-off rotation on stays theirs
    assert_eq!(
        open(&r.ctx, &repo.new_comment, "public"),
        Opened::Unreadable(Unreadable::NoKey)
    );
}

#[test]
fn a_bundle_from_anyone_but_the_owner_publishes_nothing() {
    let src = tempfile::TempDir::new().unwrap();
    let mut repo = build(true, src.path());
    if let Some(b) = repo.bundle.as_mut() {
        b.owner = MEMBER;
    }
    let dst = tempfile::TempDir::new().unwrap();
    let r = read(&repo, STRANGER, dst.path());
    assert!(r.ctx.keys.is_empty());
    assert!(!has(dst.path(), &repo.deleted));
}

#[test]
fn a_later_header_version_is_skipped_never_fatal() {
    let src = tempfile::TempDir::new().unwrap();
    let repo = build(false, src.path());
    let mut later = repo.packs[0].bytes.clone();
    later[4] = 0x03;
    assert_eq!(
        skip_reason(&later, |_| true),
        Some(SkipReason::OtherFormat { version: 3 })
    );
    assert_eq!(
        pack::open(&later, later.len() as u64, |_| None),
        Err(crate::private::PrivateError::UnknownVersion(3))
    );
}

/// A fork of a repository made public never records its sealed packs: only the plaintext ones
/// ([`crate::fork::plan_manifests`] skipping what [`crate::fork::sealed_parent_packs`] found).
#[test]
fn a_fork_plans_only_the_plaintext_packs() {
    let src = tempfile::TempDir::new().unwrap();
    let repo = build(false, src.path());
    let manifests: Vec<super::PackManifestInfo> = repo
        .packs
        .iter()
        .enumerate()
        .map(|(i, p)| super::PackManifestInfo {
            document_id: format!("m{i}"),
            created_at: p.height * 1000,
            owner_id: crate::platform::encode_identifier(OWNER),
            pack_hash: crate::private::keys::sha256(&p.bytes),
            kind: 0,
            size_bytes: p.bytes.len() as u64,
            object_count: 1,
            chunk_count: 1,
            storage: 0,
            uris: Vec::new(),
            supersedes: Vec::new(),
            tips: Vec::new(),
            created_at_block_height: p.height,
        })
        .collect();
    let conversion = Conversion::of(true, &repo.stamps, |_| true).unwrap();
    // what sealed_parent_packs decides from each pack's first bytes, with no keys
    let sealed: BTreeSet<[u8; 32]> = manifests
        .iter()
        .zip(&repo.packs)
        .filter(|(m, p)| {
            conversion.may_be_sealed(m.created_at_block_height)
                && skip_reason(&p.bytes[..pack::HEADER_LEN], |_| false).is_some()
        })
        .map(|(m, _)| m.pack_hash)
        .collect();
    let plan = crate::fork::plan_manifests(&manifests, &BTreeMap::new(), &sealed);
    assert_eq!(plan.len(), 1);
    assert_eq!(plan[0][0].pack_hash, manifests[1].pack_hash);
}
