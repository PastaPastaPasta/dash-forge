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
    epoch_key_bundles, history_cutoff, open_vis, published_keys, skip_reason, ConfigStamp,
    Conversion, PublishedBundle, SkipReason,
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
    /// A later client's members-only comment (`enc` v0x06, the first version this client does
    /// not know).
    later_comment: (DocHeader, Vec<u8>),
    /// The owner's make-public bundle (Everything mode only).
    bundle: Option<PublishedBundle>,
    /// The seal-off epoch the configs state (`E'`).
    seal_off: u32,
    /// The epoch keys readers hold by a wrap: `(reader, epoch, key)`; the rest of each chain is
    /// walked from there.
    wraps: Vec<([u8; 32], u32, EpochKey)>,
}

fn config(
    epoch: u32,
    k: &EpochKey,
    height: u64,
    prev: Option<(u32, EpochKey)>,
    id: u8,
) -> ConfigRow {
    config_by(OWNER, epoch, k, height, prev, id)
}

/// [`config`] written by `author`.
fn config_by(
    author: [u8; 32],
    epoch: u32,
    k: &EpochKey,
    height: u64,
    prev: Option<(u32, EpochKey)>,
    id: u8,
) -> ConfigRow {
    let mut header = DocHeader::new(DocKind::Config, author, epoch);
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
        owner: author,
        epoch,
        created_at_block_height: height,
        created_at: height * 1000,
        enc: doc::seal(&EpochKeys::derive(&REPO, epoch, k), &header, &f).unwrap(),
    }
}

// one fixture, built in the order a repository goes through its conversion
#[allow(clippy::too_many_lines)]
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
    later[0] = crate::private::doc::FIRST_UNKNOWN;

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
        seal_off: 1,
        wraps: vec![(MEMBER, 1, key(0x31))],
    }
}

/// What one reader ends up with.
struct Read {
    ctx: OpenContext,
    /// Bytes requested from storage, per pack: a head (36) or the whole pack.
    requested: Vec<usize>,
}

/// The keys `reader` holds (the member a wrap of epoch 1; anyone else none), with the epoch keys
/// the owner published.
fn keys_of(repo: &Converted, reader: [u8; 32]) -> OpenContext {
    resolution_of(repo, reader).open_context(&REPO)
}

/// [`keys_of`]'s resolution.
fn resolution_of(repo: &Converted, reader: [u8; 32]) -> crate::private::EpochResolution {
    let wraps: Vec<WrapRow> = repo
        .wraps
        .iter()
        .filter(|(who, ..)| *who == reader)
        .map(|(who, epoch, k)| WrapRow {
            id: [0xd1; 32],
            owner: OWNER,
            member_id: *who,
            epoch: *epoch,
            recipient_key_id: 4,
            key_enabled: true,
            key: Some(k.clone()),
        })
        .collect();
    let mut resolution = resolve_epochs(&REPO, &reader, &repo.members, &repo.configs, &wraps);
    let conversion =
        Conversion::of(true, &repo.stamps, |e| resolution.anchors.contains_key(&e)).unwrap();
    assert_eq!(conversion.seal_off_epoch, Some(repo.seal_off));
    let (published, alerts) = published_keys(
        &REPO,
        &OWNER,
        &conversion,
        &resolution.anchors,
        repo.bundle.as_slice(),
    );
    assert!(alerts.is_empty());
    assert!(
        !published.contains_key(&repo.seal_off),
        "the seal-off epoch is never published"
    );
    resolution.add_published(&REPO, &repo.configs, published, alerts);
    resolution
}

/// Read `repo` as `reader` would, the way the helper, the gateway and every other public reader
/// of artifacts do: documents with the reader's keys, packs with the published keys alone
/// (`RepoService::public_keys`, §18.2): judged by their first bytes when they may be sealed,
/// downloaded, then opened or skipped, and indexed into the bare repository `dst`.
fn read(repo: &Converted, reader: [u8; 32], dst: &Path) -> Read {
    let ctx = keys_of(repo, reader);
    let published = keys_of(repo, [0; 32]);
    let conversion = Conversion::of(true, &repo.stamps, |_| true).unwrap();
    let holds = |e: u32| published.keys.contains_key(&e);

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
            None => pack::open(&p.bytes, p.bytes.len() as u64, |e| published.keys.get(&e)).unwrap(),
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
fn code_only_a_member_opens_the_old_content_and_no_public_reader_opens_its_packs() {
    let (src, dst) = (
        tempfile::TempDir::new().unwrap(),
        tempfile::TempDir::new().unwrap(),
    );
    let repo = build(false, src.path());
    let r = read(&repo, MEMBER, dst.path());
    // epoch 1's wrap walks the chain to epoch 0 for the member's documents, but a public
    // repository's packs feed public data and open with the published keys only: none here
    assert_eq!(r.ctx.keys.keys().copied().collect::<Vec<_>>(), vec![0, 1]);
    assert_eq!(
        r.requested,
        vec![pack::HEADER_LEN, repo.packs[1].bytes.len()]
    );
    assert!(has(dst.path(), &repo.main) && !has(dst.path(), &repo.deleted));
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

/// Which epochs are public in effect is what the owner published, whatever the reader holds: a
/// member's own keys open the same old documents, which still read for everyone (Everything),
/// while Code only publishes no key, so the old documents stay members-only for all.
#[test]
fn the_published_epochs_do_not_depend_on_the_keys_a_reader_holds() {
    let src = tempfile::TempDir::new().unwrap();
    let everything = build(true, src.path());
    for reader in [STRANGER, MEMBER] {
        let res = resolution_of(&everything, reader);
        assert_eq!(res.published, BTreeSet::from([0]), "reader {reader:?}");
        assert!(res.keys.contains_key(&0));
    }
    // the member holds epoch 1 too, which is never published
    assert!(resolution_of(&everything, MEMBER).keys.contains_key(&1));
    let src = tempfile::TempDir::new().unwrap();
    let code_only = build(false, src.path());
    for reader in [STRANGER, MEMBER] {
        assert!(resolution_of(&code_only, reader).published.is_empty());
    }
    // a bundle from anyone but the owner publishes nothing
    let src = tempfile::TempDir::new().unwrap();
    let mut forged = build(true, src.path());
    if let Some(b) = forged.bundle.as_mut() {
        b.owner = MEMBER;
    }
    assert!(resolution_of(&forged, STRANGER).published.is_empty());
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

/// Another maintainer's identity, whose rotation lands between the owner's seal-off rotation and
/// the flip.
const MAINT: [u8; 32] = [0xa2; 32];

/// A conversion whose seal-off rotation (epoch 1, the owner's, block 30) was followed by another
/// maintainer's rotation (epoch 2, block 35) before the flip (the marker, block 40), so the
/// configs state `E' = 2` while the run's own seal-off epoch is 1. No packs: this fixture is
/// about documents and keys.
struct Race {
    repo: Converted,
    /// An issue a member wrote under epoch 1 (v0x01, still private), after the owner's seal-off.
    window: (DocHeader, Vec<u8>),
}

fn build_race() -> Race {
    let (k0, k1, k2) = (key(0x30), key(0x31), key(0x32));
    let (e0, e1, e2) = (
        EpochKeys::derive(&REPO, 0, &k0),
        EpochKeys::derive(&REPO, 1, &k1),
        EpochKeys::derive(&REPO, 2, &k2),
    );
    let configs = vec![
        config(0, &k0, 10, None, 0xc0),
        config(1, &k1, 30, Some((0, k0.clone())), 0xc1), // the run's seal-off rotation
        config_by(MAINT, 2, &k2, 35, Some((1, k1.clone())), 0xc2), // the other rotation
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

    let issue_at = |epoch: u32, author, number, height, keys: &EpochKeys, title: &str| {
        let mut h = DocHeader::new(DocKind::Issue, author, epoch);
        h.number = Some(number);
        h.created_at_block_height = Some(height);
        let enc = doc::seal(
            keys,
            &h,
            &Fields {
                title: Some(title.into()),
                ..Fields::default()
            },
        )
        .unwrap();
        (h, enc)
    };
    let pre_seal = issue_at(0, OWNER, 1, 20, &e0, "pre seal-off");
    let window = issue_at(1, MEMBER, 2, 32, &e1, "after the owner's seal-off");
    let mut comment = DocHeader::new(DocKind::Comment, MEMBER, 2);
    comment.vis = Visibility::Public;
    comment.target_id = Some([0x33; 32]);
    comment.created_at_block_height = Some(60);
    let comment_enc = doc::seal_members(
        &e2,
        &comment,
        &Fields {
            body: Some("after the flip".into()),
            ..Fields::default()
        },
    )
    .unwrap();
    let repo = Converted {
        configs,
        stamps,
        members: vec![
            MemberRow {
                identity: OWNER,
                role: Role::Maintainer,
                created_at: 1,
            },
            MemberRow {
                identity: MAINT,
                role: Role::Maintainer,
                created_at: 2,
            },
            MemberRow {
                identity: MEMBER,
                role: Role::Writer,
                created_at: 3,
            },
        ],
        packs: Vec::new(),
        main: String::new(),
        deleted: String::new(),
        old_issue: pre_seal,
        new_comment: (comment.clone(), comment_enc.clone()),
        later_comment: (comment, comment_enc),
        bundle: None,
        seal_off: 2,
        // the owner holds the current epoch's key, and the chain gives it the earlier ones
        wraps: vec![(OWNER, 2, k2)],
    };
    Race { repo, window }
}

/// What a run publishes when it records `recorded` as its own seal-off epoch: the owner's keys
/// below [`history_cutoff`] (as `Keyring::epoch_keys_below` takes them) in bundles, and the
/// epochs of the 0x06 entries those carry.
fn owner_bundles(repo: &Converted, recorded: Option<u32>) -> (Vec<PublishedBundle>, Vec<u32>) {
    let conversion = Conversion::of(true, &repo.stamps, |e| {
        repo.configs.iter().any(|c| c.epoch == e)
    })
    .unwrap();
    let cutoff = history_cutoff(conversion.seal_off_epoch, recorded).unwrap();
    let held: BTreeMap<u32, EpochKey> = resolution_of(repo, OWNER)
        .keys
        .into_iter()
        .filter(|(e, _)| *e < cutoff)
        .collect();
    let bundles: Vec<PublishedBundle> = epoch_key_bundles(&REPO, &held)
        .unwrap()
        .into_iter()
        .map(|bytes| PublishedBundle {
            owner: OWNER,
            bytes,
        })
        .collect();
    let epochs = bundles
        .iter()
        .flat_map(|b| bundle::parse(&b.bytes).unwrap().entries)
        .filter(|e| e.kind == bundle::ENTRY_EPOCH_KEY)
        .map(|e| e.revision)
        .collect();
    (bundles, epochs)
}

/// A rotation by another maintainer between the owner's seal-off and the flip raises the stated
/// seal-off epoch, but the run's own seal-off key is never published and nothing written under
/// it opens for anyone who lacks it.
#[test]
fn a_rotation_racing_the_flip_never_publishes_the_runs_seal_off_key() {
    let Race { mut repo, window } = build_race();
    let existing = |e: u32| repo.configs.iter().any(|c| c.epoch == e);

    // 1. the stated cutoff moved up
    let conversion = Conversion::of(true, &repo.stamps, existing).unwrap();
    assert_eq!(conversion.seal_off_epoch, Some(2));
    // 2. the run recorded its own seal-off epoch, which is lower
    assert_eq!(history_cutoff(Some(2), Some(1)), Some(1));
    // 3. the owner holds all three epochs and publishes those below the cutoff
    assert_eq!(
        resolution_of(&repo, OWNER)
            .keys
            .keys()
            .copied()
            .collect::<Vec<_>>(),
        vec![0, 1, 2]
    );
    let (bundles, epochs) = owner_bundles(&repo, Some(1));
    assert_eq!(epochs, vec![0]);

    // 4. what a reader makes of them
    let resolution = resolution_of(&repo, OWNER);
    let (published, alerts) = published_keys(
        &REPO,
        &OWNER,
        &conversion,
        &resolution.anchors,
        bundles.as_slice(),
    );
    assert!(alerts.is_empty());
    assert_eq!(published.keys().copied().collect::<Vec<_>>(), vec![0]);
    repo.bundle = Some(bundles.into_iter().next().unwrap());
    // a stranger, and a member who holds no wrap for epochs 1 and 2
    for reader in [STRANGER, MEMBER] {
        let ctx = keys_of(&repo, reader);
        assert_eq!(ctx.keys.keys().copied().collect::<Vec<_>>(), vec![0]);
        assert!(matches!(
            open(&ctx, &repo.old_issue, "private"),
            Opened::Readable(f) if f.title.as_deref() == Some("pre seal-off")
        ));
        assert_eq!(
            open(&ctx, &window, "private"),
            Opened::Unreadable(Unreadable::NoKey),
            "reader {reader:?}"
        );
        assert_eq!(
            open(&ctx, &repo.new_comment, "public"),
            Opened::Unreadable(Unreadable::NoKey),
            "reader {reader:?}"
        );
    }
}

/// With no record of the run's seal-off (another machine resumes it), the cutoff is the stated
/// one. Pinned until the cutoff is derived from the chain.
#[test]
fn a_rotation_racing_the_flip_record_lost_cutoff_is_stated() {
    let Race { repo, .. } = build_race();
    assert_eq!(history_cutoff(Some(2), None), Some(2));
    let (bundles, epochs) = owner_bundles(&repo, None);
    assert_eq!(epochs, vec![0, 1]);
    // the reader's rule is "below the stated seal-off epoch", so it honours what the bundle holds
    let conversion = Conversion::of(true, &repo.stamps, |e| {
        repo.configs.iter().any(|c| c.epoch == e)
    })
    .unwrap();
    let (published, alerts) = published_keys(
        &REPO,
        &OWNER,
        &conversion,
        &resolution_of(&repo, OWNER).anchors,
        bundles.as_slice(),
    );
    assert!(alerts.is_empty());
    assert_eq!(published.keys().copied().collect::<Vec<_>>(), vec![0, 1]);
}
