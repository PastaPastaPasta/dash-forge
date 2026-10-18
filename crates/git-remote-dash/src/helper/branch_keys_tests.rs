//! Offline regressions for a bot's explicit branch keys without any members epoch key.

use std::collections::BTreeSet;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use forge_core::keyring::Keyring;
use forge_core::network::{ForgeIds, Network};
use forge_core::platform::{encode_identifier, FetchedDocument, PlatformClient};
use forge_core::private::branch_key::{
    self, BranchKey, BranchKeyLetter, BranchKeys, BranchRing, LetterIn,
};
use forge_core::private::members_ref::{self, RefUpdateIn, SealedRefUpdate};
use forge_core::private::{DocKind, EpochKey, EpochKeys};
use forge_core::refs::GitState;
use forge_core::repo::{ArtifactRead, RepoService};
use forge_core::rules::v2::{Role, Visibility};
use forge_core::rules::RefState;
use forge_core::scope::RepoRef;

use super::{MembersKeys, ScratchRepo};

const REPO: [u8; 32] = [0x11; 32];
const OWNER: [u8; 32] = [0x22; 32];
const BOT: [u8; 32] = [0x33; 32];
const BRANCH: &str = "refs/heads/sec/maintainers";

fn keyring() -> Arc<Keyring> {
    Arc::new(Keyring::keyless_for_tests(
        REPO,
        BOT,
        vec![forge_core::members::Member {
            identity_id: encode_identifier(BOT),
            role: Role::Bot,
            document_id: "bot-row".into(),
            created_at: 1,
        }],
    ))
}

fn ring(keys: Vec<BranchKey>) -> Arc<BranchRing> {
    let audience = forge_core::env::Audience {
        group: Some(forge_core::env::Group::Maintainers),
        also: vec![encode_identifier(BOT)],
    };
    let letters = vec![LetterIn {
        id: "branch-letter".into(),
        height: 1,
        sender: encode_identifier(OWNER),
        letter: BranchKeyLetter {
            name: BRANCH.into(),
            keys,
            audience,
            to: vec![encode_identifier(OWNER), encode_identifier(BOT)],
        },
    }];
    Arc::new(BranchRing::new(
        &REPO,
        branch_key::fold(letters, |_, _| true),
        |_| [OWNER, BOT].into(),
    ))
}

fn empty_ring() -> Arc<BranchRing> {
    Arc::new(BranchRing::new(&REPO, Default::default(), |_| {
        BTreeSet::new()
    }))
}

fn document(id: u8, sealed: &SealedRefUpdate) -> FetchedDocument {
    FetchedDocument {
        id: encode_identifier([id; 32]),
        owner_id: encode_identifier(OWNER),
        created_at: Some(u64::from(id)),
        created_at_block_height: Some(10),
        updated_at: None,
        updated_at_block_height: None,
        revision: Some(1),
        fields: sealed.props(),
    }
}

fn input<'a>(name: &'a str, tip: &'a [u8]) -> RefUpdateIn<'a> {
    RefUpdateIn {
        kind: DocKind::RefUpdate,
        name,
        new_oid: tip,
        prev_oid: None,
        force: false,
    }
}

fn missing_hints(state: &GitState, kr: &Arc<Keyring>) -> Vec<String> {
    let open = |k, d: &FetchedDocument| kr.open(k, d);
    let view = forge_core::refs::refs_view(state, Some(&open));
    super::missing_ref_key_hints(
        &view.members.unwrap(),
        &MembersKeys::from_keyring(Arc::clone(kr)),
    )
}

fn repo() -> RepoRef {
    RepoRef {
        forge: ForgeIds::test_forge(),
        repo_id: encode_identifier(REPO),
        owner_id: encode_identifier(OWNER),
        name: "branch-key-fixture".into(),
        visibility: Visibility::Public,
    }
}

/// An SDK handle with only loopback addresses. Opening branch packs makes no network requests.
async fn offline_client() -> PlatformClient {
    PlatformClient::connect_network(Network::Devnet {
        name: "branch-key-offline".into(),
        dapi_addresses: vec!["https://127.0.0.1:1".into()],
        quorum_base_url: Some("http://127.0.0.1:1".into()),
    })
    .await
    .unwrap()
}

fn git(dir: &Path, args: &[&str], stdin: Option<&[u8]>) -> Vec<u8> {
    let mut cmd = Command::new("git");
    cmd.current_dir(dir)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .args(args);
    let (out, written) = forge_core::pack::run_feeding(&mut cmd, stdin).unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    written.unwrap();
    out.stdout
}

fn git_pack() -> (Vec<u8>, String) {
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "--bare", "-q"], None);
    let oid = |args: &[&str], body: &[u8]| {
        String::from_utf8(git(dir.path(), args, Some(body)))
            .unwrap()
            .trim()
            .to_owned()
    };
    let blob = oid(&["hash-object", "-w", "--stdin"], b"explicit branch only\n");
    let tree = oid(
        &["mktree"],
        format!("100644 blob {blob}\tfixture.txt\n").as_bytes(),
    );
    let commit = format!("tree {tree}\nauthor Fixture <fixture@example.org> 1 +0000\ncommitter Fixture <fixture@example.org> 1 +0000\n\nbranch-key fixture\n");
    let tip = oid(
        &["hash-object", "-w", "-t", "commit", "--stdin"],
        commit.as_bytes(),
    );
    (
        forge_core::pack::build_pack(dir.path(), &[&tip], &[])
            .unwrap()
            .bytes,
        tip,
    )
}

#[tokio::test]
async fn branch_key_only_reader_fetches_explicit_branch() {
    let original = keyring();
    assert!(original.resolution().keys.is_empty());
    let keys = MembersKeys::from_keyring(original);
    // This is the helper's gate before loading branchKey letters: it must retain this reader.
    let kr = keys
        .fetch_keyring()
        .expect("keep readers without epoch keys");
    let ring = ring(vec![BranchKey::from_bytes([7; 32])]);
    kr.set_branch_ring(Arc::clone(&ring));
    let (pack, tip) = git_pack();
    let branch_keys = ring.write_keys(BRANCH).unwrap();
    let state = GitState {
        ref_updates: vec![document(
            1,
            &branch_key::seal_ref(
                branch_keys,
                OWNER,
                &input(BRANCH, &hex::decode(&tip).unwrap()),
            )
            .unwrap(),
        )],
        ..GitState::default()
    };
    let open = |k, d: &FetchedDocument| kr.open(k, d);
    let view = forge_core::refs::refs_view(&state, Some(&open))
        .members
        .unwrap();
    assert!(missing_hints(&state, &kr).is_empty());
    assert_eq!(
        super::list_lines(&view.refs, "main", false),
        vec![format!("{tip} {BRANCH}"), format!("@{BRANCH} HEAD")]
    );
    let sealed = branch_key::seal_pack(branch_keys, &pack).unwrap();
    assert_eq!(super::unreadable_members_pack(&sealed, &kr), None);
    let mut manifest = super::tests::manifest(1, &encode_identifier(OWNER), &[]);
    manifest.kind = u64::from(forge_core::pack::KIND_MEMBERS_GIT_PACK);
    let selected = super::packs_to_fetch(&[manifest.clone()], None, true, None);
    assert_eq!(selected.len(), 1);
    let client = offline_client().await;
    let got = RepoService::reader(&client)
        .open_members_pack(&repo(), &kr, &[&manifest], sealed.len() as u64, sealed)
        .await
        .unwrap();
    let ArtifactRead::Bytes(bytes) = got else {
        panic!("the explicit branch pack must open")
    };
    assert_eq!(bytes, pack);
    let fetched = ScratchRepo::init().unwrap();
    fetched.index_pack(&bytes).unwrap();
    assert!(
        fetched.pack_filtered(&[tip], None).is_ok(),
        "the fetched branch's full history is present"
    );
}

#[tokio::test]
async fn branch_key_only_reader_cannot_fetch_other_branch_or_members_refs() {
    let kr = MembersKeys::from_keyring(keyring())
        .fetch_keyring()
        .expect("branch-only reader");
    kr.set_branch_ring(ring(vec![BranchKey::from_bytes([7; 32])]));
    let other = BranchKeys::derive(&REPO, 0, &BranchKey::from_bytes([8; 32]));
    let members = EpochKeys::derive(&REPO, 0, &EpochKey::from_bytes([9; 32]));
    let state = GitState {
        ref_updates: vec![
            document(
                1,
                &branch_key::seal_ref(&other, OWNER, &input("refs/heads/sec/other", &[1; 20]))
                    .unwrap(),
            ),
            document(
                2,
                &members_ref::seal(&members, OWNER, &input("refs/heads/members", &[2; 20]))
                    .unwrap(),
            ),
        ],
        ..GitState::default()
    };
    let open = |k, d: &FetchedDocument| kr.open(k, d);
    let view = forge_core::refs::refs_view(&state, Some(&open))
        .members
        .unwrap();
    for d in &state.ref_updates {
        assert!(matches!(
            kr.open(DocKind::RefUpdate, d),
            forge_core::private::Opened::Unreadable(forge_core::private::Unreadable::NoKey)
        ));
    }
    assert!(view.refs.is_empty());
    assert!(view.decryptable.is_empty() && view.decryptable_narrower.is_empty());
    assert_eq!(view.unreadable, 2);
    let client = offline_client().await;
    let svc = RepoService::reader(&client);
    let mut manifest = super::tests::manifest(1, &encode_identifier(OWNER), &[]);
    manifest.kind = u64::from(forge_core::pack::KIND_MEMBERS_GIT_PACK);
    for sealed in [
        branch_key::seal_pack(&other, b"other branch").unwrap(),
        forge_core::private::pack::seal(&members, b"members only").unwrap(),
    ] {
        assert!(
            super::unreadable_members_pack(&sealed, &kr).is_some(),
            "skip unheld audiences before downloading their packs"
        );
        let got = svc
            .open_members_pack(&repo(), &kr, &[&manifest], sealed.len() as u64, sealed)
            .await
            .unwrap();
        assert!(
            matches!(got, ArtifactRead::Skipped(_)),
            "unheld keys must never yield bytes"
        );
    }
    // Kind-64 plaintext is still refused even when a bot has a valid branch key.
    let got = svc
        .open_members_pack(&repo(), &kr, &[&manifest], 10, b"plaintext!".to_vec())
        .await
        .unwrap();
    assert!(matches!(got, ArtifactRead::Skipped(_)));
}

#[test]
fn missing_members_and_branch_keys_have_distinct_hints() {
    let kr = MembersKeys::from_keyring(keyring())
        .fetch_keyring()
        .unwrap();
    kr.set_branch_ring(ring(vec![BranchKey::from_bytes([7; 32])]));
    let members = EpochKeys::derive(&REPO, 0, &EpochKey::from_bytes([9; 32]));
    let state = GitState {
        ref_updates: vec![document(
            1,
            &members_ref::seal(&members, OWNER, &input("refs/heads/members", &[2; 20])).unwrap(),
        )],
        ..GitState::default()
    };
    let hints = missing_hints(&state, &kr);
    assert_eq!(hints, ["dash: some members-only branches aren't fetched (no members key has been shared with you)"]);
    let other = BranchKeys::derive(&REPO, 0, &BranchKey::from_bytes([8; 32]));
    let state = GitState {
        protected_ref_updates: vec![document(
            2,
            &branch_key::seal_ref(
                &other,
                OWNER,
                &RefUpdateIn {
                    kind: DocKind::ProtectedRefUpdate,
                    ..input("refs/heads/sec/other", &[1; 20])
                },
            )
            .unwrap(),
        )],
        ..GitState::default()
    };
    let hints = missing_hints(&state, &kr);
    assert_eq!(hints, ["dash: a branch for fewer people isn't fetched (no key for this branch has been shared with you)"]);
    let skipped = forge_core::repo::Skipped {
        pack: [1; 32],
        why: forge_core::repo::SkipReason::OtherFormat {
            version: branch_key::PACK_VERSION,
        },
    };
    let error = super::skipped_packs_needed(&repo(), true, &[skipped]);
    assert!(error.cause.unwrap().contains("no key for this branch"));
    assert!(error.fix[0].contains("share its branch key"));
    let error = super::branch_keys_unavailable(&MembersKeys::from_keyring(keyring()), None, None);
    assert_eq!(
        error.code,
        forge_core::user_error::codes::CANNOT_CHECK_MEMBERS_ONLY
    );
    assert!(error
        .message
        .contains("no key for a previously fetched branch"));
}

#[test]
fn branch_key_only_reader_cannot_open_unshared_generation() {
    let kr = MembersKeys::from_keyring(keyring())
        .fetch_keyring()
        .unwrap();
    let old = BranchKey::from_bytes([7; 32]);
    let new = BranchKey::from_bytes([8; 32]);
    kr.set_branch_ring(ring(vec![old.clone()]));
    let current = ring(vec![old, new]);
    let keys = current.write_keys(BRANCH).unwrap();
    let state = GitState {
        ref_updates: vec![document(
            1,
            &branch_key::seal_ref(keys, OWNER, &input(BRANCH, &[1; 20])).unwrap(),
        )],
        ..GitState::default()
    };
    let open = |k, d: &FetchedDocument| kr.open(k, d);
    assert!(forge_core::refs::refs_view(&state, Some(&open))
        .members
        .unwrap()
        .refs
        .is_empty());
    let sealed = branch_key::seal_pack(keys, b"next generation").unwrap();
    assert!(super::unreadable_members_pack(&sealed, &kr).is_some());
    kr.set_branch_ring(current);
    assert_eq!(super::unreadable_members_pack(&sealed, &kr), None);
    assert!(missing_hints(&state, &kr).is_empty());
    assert_eq!(
        forge_core::refs::refs_view(&state, Some(&open))
            .members
            .unwrap()
            .refs
            .len(),
        1
    );
}

#[tokio::test]
async fn a_branch_pack_with_a_held_kcv_still_must_authenticate() {
    let kr = MembersKeys::from_keyring(keyring())
        .fetch_keyring()
        .unwrap();
    let ring = ring(vec![BranchKey::from_bytes([7; 32])]);
    kr.set_branch_ring(Arc::clone(&ring));
    let mut sealed =
        branch_key::seal_pack(ring.write_keys(BRANCH).unwrap(), b"branch data").unwrap();
    *sealed.last_mut().unwrap() ^= 1;
    assert_eq!(
        super::unreadable_members_pack(&sealed, &kr),
        None,
        "a KCV is only an exclusion hint"
    );
    let client = offline_client().await;
    let mut manifest = super::tests::manifest(1, &encode_identifier(OWNER), &[]);
    manifest.kind = u64::from(forge_core::pack::KIND_MEMBERS_GIT_PACK);
    assert!(RepoService::reader(&client)
        .open_members_pack(&repo(), &kr, &[&manifest], sealed.len() as u64, sealed)
        .await
        .is_err());
}

#[test]
fn deleted_unreadable_narrower_branch_has_no_missing_key_hint() {
    let kr = keyring();
    kr.set_branch_ring(empty_ring());
    let other = BranchKeys::derive(&REPO, 0, &BranchKey::from_bytes([8; 32]));
    let state = GitState {
        ref_updates: vec![
            document(
                1,
                &branch_key::seal_ref(&other, OWNER, &input(BRANCH, &[1; 20])).unwrap(),
            ),
            document(
                2,
                &branch_key::seal_ref(
                    &other,
                    OWNER,
                    &RefUpdateIn {
                        prev_oid: Some(&[1; 20]),
                        ..input(BRANCH, &[0; 20])
                    },
                )
                .unwrap(),
            ),
        ],
        ..GitState::default()
    };
    let calls = std::cell::Cell::new(0);
    let open = |k, d: &FetchedDocument| {
        calls.set(calls.get() + 1);
        kr.open(k, d)
    };
    let view = forge_core::refs::refs_view(&state, Some(&open))
        .members
        .unwrap();
    assert_eq!(calls.get(), 2);
    assert_eq!(view.unreadable, 2);
    assert_eq!(view.unreadable_members, 0);
    assert!(view.unreadable_narrower.is_empty());
    assert!(super::missing_ref_key_hints(&view, &MembersKeys::from_keyring(kr)).is_empty());
    assert_eq!(
        calls.get(),
        2,
        "the hint reuses the fold without reopening documents"
    );
}

#[test]
fn missing_key_hint_tracks_live_generations_across_both_ref_tables() {
    let kr = keyring();
    kr.set_branch_ring(empty_ring());
    let old = BranchKeys::derive(&REPO, 0, &BranchKey::from_bytes([8; 32]));
    let current = BranchKeys::derive(&REPO, 1, &BranchKey::from_bytes([9; 32]));
    let deletion = |keys: &BranchKeys, id, kind| {
        document(
            id,
            &branch_key::seal_ref(
                keys,
                OWNER,
                &RefUpdateIn {
                    kind,
                    prev_oid: Some(&[1; 20]),
                    ..input(BRANCH, &[0; 20])
                },
            )
            .unwrap(),
        )
    };
    let mut state = GitState {
        ref_updates: vec![
            document(
                3,
                &branch_key::seal_ref(&current, OWNER, &input(BRANCH, &[1; 20])).unwrap(),
            ),
            document(
                1,
                &branch_key::seal_ref(&old, OWNER, &input(BRANCH, &[1; 20])).unwrap(),
            ),
        ],
        protected_ref_updates: vec![deletion(&old, 2, DocKind::ProtectedRefUpdate)],
        ..GitState::default()
    };
    let view = forge_core::refs::refs_view(&state, Some(&|k, d| kr.open(k, d)))
        .members
        .unwrap();
    assert_eq!(view.unreadable, 3);
    assert_eq!(view.unreadable_narrower.len(), 1);
    assert_eq!(
        super::missing_ref_key_hints(&view, &MembersKeys::from_keyring(Arc::clone(&kr))).len(),
        1
    );
    state
        .protected_ref_updates
        .push(deletion(&current, 4, DocKind::ProtectedRefUpdate));
    assert!(missing_hints(&state, &kr).is_empty());
}

#[test]
fn keyless_nonmember_keeps_the_not_a_member_reason() {
    let kr = Arc::new(Keyring::keyless_for_tests(REPO, BOT, Vec::new()));
    assert_eq!(
        MembersKeys::from_keyring(kr).unavailable_reason(),
        "you are not a member"
    );
    assert_eq!(
        MembersKeys::from_keyring(keyring()).unavailable_reason(),
        "no members key has been shared with you"
    );
}

#[test]
fn narrower_refusal_preserves_unlock_reason_and_local_names() {
    let keys = MembersKeys::Locked("the passphrase is wrong".into());
    let error = super::branch_keys_unavailable(&keys, Some("origin"), Some(&[BRANCH.into()]));
    assert!(error
        .cause
        .as_deref()
        .unwrap()
        .contains(keys.unavailable_reason()));
    assert!(error.message.contains("sec/maintainers"));
    assert!(error
        .fix
        .iter()
        .any(|f| f.contains("git branch -dr origin/sec/maintainers")));
}

fn list_fixture(kr: &Keyring) -> forge_core::refs::RefsView {
    use forge_core::platform::FieldValue;
    let branch = BranchKeys::derive(&REPO, 0, &BranchKey::from_bytes([7; 32]));
    let sealed = document(
        2,
        &branch_key::seal_ref(&branch, OWNER, &input(BRANCH, &[2; 20])).unwrap(),
    );
    let public = FetchedDocument {
        fields: [
            ("refName".into(), FieldValue::text("refs/heads/main")),
            (
                "refNameHash".into(),
                FieldValue::bytes32(forge_core::private::keys::sha256(b"refs/heads/main")),
            ),
            ("newOid".into(), FieldValue::bytes(vec![1; 20])),
            ("force".into(), FieldValue::Bool(false)),
        ]
        .into(),
        id: encode_identifier([1; 32]),
        created_at: Some(1),
        ..sealed.clone()
    };
    let state = GitState {
        ref_updates: vec![public, sealed],
        ..GitState::default()
    };
    forge_core::refs::refs_view(&state, Some(&|k, d| kr.open(k, d)))
}

fn tip_share() -> forge_core::key_letters::SharedBranch {
    forge_core::key_letters::SharedBranch {
        name: "refs/heads/per-tip".into(),
        head: hex::encode([3; 20]),
        packs: [([4; 32], zeroize::Zeroizing::new([5; 32]))].into(),
        sender: encode_identifier(OWNER),
        as_of: 3,
        letter_id: "tip-share".into(),
        letter_head: forge_core::private::key_letter::LetterHead {
            blind: vec![6; 20],
            oid: vec![3; 20],
            salt: [7; 32],
        },
    }
}

#[test]
fn list_plan_keeps_branch_key_tips_out_of_publication_guard() {
    let kr = keyring();
    kr.set_branch_ring(ring(vec![BranchKey::from_bytes([7; 32])]));
    let view = list_fixture(&kr);
    let plan = super::shared_ref_plan(
        &view.public,
        view.members.as_ref(),
        &MembersKeys::from_keyring(kr),
        &[],
    );
    assert!(plan.branch_keys);
    assert_eq!(super::live_tips(&plan.refs).len(), 2);
    assert!(plan.covered.contains(BRANCH));
    // This exact field is what the list path passes to remember_public_tips, now or deferred.
    assert_eq!(plan.public_tips, [hex::encode([1; 20])]);
    assert!(!plan.public_tips.contains(&hex::encode([2; 20])));
}

#[test]
fn list_plan_empty_branch_ring_falls_back_to_public_view() {
    let kr = keyring();
    kr.set_branch_ring(ring(vec![BranchKey::from_bytes([7; 32])]));
    let view = list_fixture(&kr);
    // Even an earlier opened view cannot grant access once no explicit branch key is held.
    for ring in [None, Some(empty_ring())] {
        let empty = keyring();
        if let Some(ring) = ring {
            empty.set_branch_ring(ring);
        }
        let plan = super::shared_ref_plan(
            &view.public,
            view.members.as_ref(),
            &MembersKeys::from_keyring(empty),
            &[],
        );
        assert!(!plan.branch_keys);
        assert_eq!(plan.refs, view.public);
        assert_eq!(plan.covered, BTreeSet::from(["refs/heads/main".into()]));
        assert_eq!(plan.public_tips, [hex::encode([1; 20])]);
    }
}

#[test]
fn list_plan_nonempty_ring_refuses_uncovered_previously_fetched_names() {
    use forge_core::members_git::ledger::{EntryAudience, Ledger, State};
    let kr = keyring();
    kr.set_branch_ring(ring(vec![BranchKey::from_bytes([7; 32])]));
    let view = list_fixture(&kr);
    let keys = MembersKeys::from_keyring(kr);
    let plan = super::shared_ref_plan(&view.public, view.members.as_ref(), &keys, &[]);
    let local = [
        BRANCH.to_owned(),
        "refs/heads/sec/unshared".into(),
        "refs/heads/members".into(),
    ];
    let dropped: Vec<String> = local
        .into_iter()
        .filter(|n| !plan.covered.contains(n))
        .collect();
    assert_eq!(dropped, ["refs/heads/sec/unshared", "refs/heads/members"]);
    let ledger = State::Present(Ledger {
        commits: [(
            hex::encode([2; 20]),
            EntryAudience::Narrower("branch:fixture".into()),
        )]
        .into(),
        ..Ledger::default()
    });
    let error = super::uncovered_refs_error(
        &keys,
        &ledger,
        Some(&dropped),
        Some("origin"),
        &BTreeSet::new(),
    );
    assert_eq!(
        error.code,
        forge_core::user_error::codes::CANNOT_CHECK_MEMBERS_ONLY
    );
    assert!(error.message.contains("sec/unshared, members"));
    assert!(error
        .fix
        .iter()
        .any(|f| f.contains("git branch -dr origin/sec/unshared")));
    assert!(error
        .fix
        .iter()
        .any(|f| f.contains("git branch -dr origin/members")));
}

#[test]
fn list_plan_combines_branch_key_and_per_tip_share_without_publicizing_either() {
    let kr = keyring();
    kr.set_branch_ring(ring(vec![BranchKey::from_bytes([7; 32])]));
    let view = list_fixture(&kr);
    let keys = MembersKeys::from_keyring(kr);
    let plan = super::shared_ref_plan(&view.public, view.members.as_ref(), &keys, &[tip_share()]);
    assert_eq!(super::live_tips(&plan.refs).len(), 3);
    assert!(plan.branch_keys);
    assert_eq!(
        plan.covered,
        BTreeSet::from([
            "refs/heads/main".into(),
            BRANCH.into(),
            "refs/heads/per-tip".into()
        ])
    );
    assert_eq!(plan.public_tips, [hex::encode([1; 20])]);
    assert_eq!(plan.shared_names, ["refs/heads/per-tip"]);
    let next = super::shared_ref_plan(&view.public, view.members.as_ref(), &keys, &[]);
    assert!(
        next.shared_names.is_empty(),
        "a later list uses only its own shared names"
    );
}

#[test]
fn list_plan_covers_authenticated_deletions_but_not_a_letter_alone() {
    let kr = keyring();
    kr.set_branch_ring(ring(vec![BranchKey::from_bytes([7; 32])]));
    let view = list_fixture(&kr);
    let mut members = view.members.unwrap();
    members
        .refs
        .iter_mut()
        .find(|(name, _)| name == BRANCH)
        .unwrap()
        .1 = RefState::Unborn;
    let keys = MembersKeys::from_keyring(kr);
    let plan = super::shared_ref_plan(&view.public, Some(&members), &keys, &[]);
    assert!(plan.covered.contains(BRANCH));
    members.refs.retain(|(name, _)| name != BRANCH);
    let plan = super::shared_ref_plan(&view.public, Some(&members), &keys, &[]);
    assert!(!plan.covered.contains(BRANCH));
}

#[test]
fn narrower_refusal_requires_a_present_exclusively_narrower_ledger() {
    use forge_core::members_git::ledger::{EntryAudience, Ledger, State};
    let narrow = EntryAudience::Narrower("branch:fixture".into());
    let only_narrow = Ledger {
        commits: [(hex::encode([2; 20]), narrow.clone())].into(),
        packs: [(hex::encode([3; 32]), narrow.clone())].into(),
    };
    let mixed = Ledger {
        packs: [(hex::encode([3; 32]), EntryAudience::Members)].into(),
        ..only_narrow.clone()
    };
    let member_commits = Ledger {
        commits: [(hex::encode([2; 20]), EntryAudience::Members)].into(),
        ..only_narrow.clone()
    };
    let only_packs = Ledger {
        packs: [(hex::encode([3; 32]), narrow)].into(),
        ..Ledger::default()
    };
    let keys = [
        MembersKeys::Locked("the passphrase is wrong".into()),
        MembersKeys::Locked("a passphrase is required".into()),
        MembersKeys::from_keyring(keyring()),
        MembersKeys::Anonymous,
    ];
    for keys in keys {
        for (state, narrower) in [
            (State::Absent, false),
            (State::Unknown, false),
            (State::Present(Ledger::default()), false),
            (State::Present(mixed.clone()), false),
            (State::Present(member_commits.clone()), false),
            (State::Present(only_narrow.clone()), true),
            (State::Present(only_packs.clone()), true),
        ] {
            let error = super::uncovered_refs_error(
                &keys,
                &state,
                Some(&[BRANCH.into()]),
                Some("origin"),
                &BTreeSet::new(),
            );
            assert_eq!(
                error.message.contains("no key for previously fetched"),
                narrower,
                "{state:?}"
            );
            assert!(error
                .cause
                .as_deref()
                .unwrap()
                .contains(keys.unavailable_reason()));
        }
    }
    // Older per-tip share refusals retain their own recovery instructions.
    let names = vec!["refs/heads/per-tip".into()];
    let error = super::uncovered_refs_error(
        &MembersKeys::Anonymous,
        &State::Unknown,
        Some(&names),
        Some("origin"),
        &names.iter().cloned().collect(),
    );
    assert!(error.message.contains("isn't shared with you anymore"));
}

// Exercise the real recorder in a subprocess so its git/common-dir lookup cannot write
// into the source worktree or race tests that use process-wide environment/cwd state.
fn ledger_test_worker(name: &str) -> bool {
    const WORKER: &str = "DASH_FORGE_TEST_BRANCH_PACK_LEDGER";
    if std::env::var(WORKER).as_deref() == Ok(name) {
        return true;
    }
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "--bare", "-q"], None);
    let out = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            &format!("helper::branch_keys_tests::{name}"),
            "--nocapture",
        ])
        .current_dir(dir.path())
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env(WORKER, name)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    false
}

#[tokio::test]
async fn branch_key_only_fetch_records_narrower_packs_and_keeps_narrower_refusal() {
    use forge_core::members_git::ledger::{self, EntryAudience, State};
    if !ledger_test_worker(
        "branch_key_only_fetch_records_narrower_packs_and_keeps_narrower_refusal",
    ) {
        return;
    }
    let kr = keyring();
    let ring = ring(vec![BranchKey::from_bytes([7; 32])]);
    kr.set_branch_ring(Arc::clone(&ring));
    let token = ring.get(BRANCH).unwrap().ledger_token(&REPO);
    let (pack, tip) = git_pack();
    let m = super::MembersFetch {
        keyring: Arc::clone(&kr),
        decryptable: Vec::new(),
        narrower: vec![(tip.clone(), token.clone())],
    };
    let mut manifest = super::tests::manifest(1, &encode_identifier(OWNER), &[]);
    manifest.kind = u64::from(forge_core::pack::KIND_MEMBERS_GIT_PACK);
    let sealed = branch_key::seal_pack(ring.write_keys(BRANCH).unwrap(), &pack).unwrap();
    let client = offline_client().await;
    let (read, narrower) = RepoService::reader(&client)
        .open_members_pack_with_audience(&repo(), &kr, &[&manifest], sealed.len() as u64, sealed)
        .await
        .unwrap();
    let ArtifactRead::Bytes(bytes) = read else {
        panic!("explicit branch pack must open")
    };
    assert_eq!(bytes, pack);
    let fetched = vec![(manifest.pack_hash, super::Got::Bytes { bytes, narrower })];
    super::record_members_fetch(&m, &[manifest.clone()], &fetched).unwrap();
    super::record_narrower(&m.narrower).unwrap();
    let state = ledger::read(&crate::git::LocalRepo::common_dir().unwrap()).unwrap();
    let State::Present(held) = &state else {
        panic!("fetch must create its ledger")
    };
    assert_eq!(
        held.commits.get(&tip),
        Some(&EntryAudience::Narrower(token.clone()))
    );
    assert_eq!(
        held.packs.get(&hex::encode(manifest.pack_hash)),
        Some(&EntryAudience::Narrower(token))
    );
    assert!(held
        .commits
        .values()
        .chain(held.packs.values())
        .all(|a| matches!(a, EntryAudience::Narrower(_))));
    let error = super::uncovered_refs_error(
        &MembersKeys::from_keyring(m.keyring),
        &state,
        Some(&[BRANCH.into()]),
        Some("origin"),
        &BTreeSet::new(),
    );
    assert!(error
        .message
        .contains("no key for previously fetched branches"));
    assert!(error
        .fix
        .iter()
        .any(|f| f.contains("git branch -dr origin/sec/maintainers")));
}

#[test]
fn fetch_without_branch_pack_token_keeps_members_audience() {
    use forge_core::members_git::ledger::{self, EntryAudience, State};
    if !ledger_test_worker("fetch_without_branch_pack_token_keeps_members_audience") {
        return;
    }
    let tip = hex::encode([2; 20]);
    let m = super::MembersFetch {
        keyring: keyring(),
        decryptable: vec![tip.clone()],
        narrower: Vec::new(),
    };
    let mut members = super::tests::manifest(1, &encode_identifier(OWNER), &[]);
    members.kind = u64::from(forge_core::pack::KIND_MEMBERS_GIT_PACK);
    let mut skipped = members.clone();
    skipped.pack_hash = [2; 32];
    let public = super::tests::manifest(3, &encode_identifier(OWNER), &[]);
    let fetched = vec![
        (
            members.pack_hash,
            super::Got::Bytes {
                bytes: Vec::new(),
                narrower: None,
            },
        ),
        (
            skipped.pack_hash,
            super::Got::Skipped(forge_core::repo::Skipped {
                pack: skipped.pack_hash,
                why: forge_core::repo::SkipReason::NoKey { epoch: 0 },
            }),
        ),
        (
            public.pack_hash,
            super::Got::Bytes {
                bytes: Vec::new(),
                narrower: None,
            },
        ),
    ];
    super::record_members_fetch(&m, &[members.clone(), skipped, public], &fetched).unwrap();
    let state = ledger::read(&crate::git::LocalRepo::common_dir().unwrap()).unwrap();
    let State::Present(held) = &state else {
        panic!("fetch must create its ledger")
    };
    assert_eq!(held.commits.get(&tip), Some(&EntryAudience::Members));
    assert_eq!(
        held.packs.len(),
        1,
        "unopened and public packs stay out of the sealed ledger"
    );
    assert_eq!(
        held.packs.get(&hex::encode(members.pack_hash)),
        Some(&EntryAudience::Members)
    );
    let error = super::uncovered_refs_error(
        &MembersKeys::from_keyring(m.keyring),
        &state,
        Some(&["refs/heads/members".into()]),
        Some("origin"),
        &BTreeSet::new(),
    );
    assert!(error.message.contains("can't fetch members-only branches"));
}

#[test]
fn members_key_coverage_refuses_only_locally_recorded_narrower_names() {
    use forge_core::members_git::ledger::{EntryAudience, Ledger, State};
    let keys = MembersKeys::Held(keyring());
    let old_tip = hex::encode([2; 20]);
    let local = vec![(BRANCH.into(), old_tip.clone())];
    let ledger = Ledger {
        commits: [
            (
                old_tip.clone(),
                EntryAudience::Narrower("branch:fixture".into()),
            ),
            (hex::encode([3; 20]), EntryAudience::Members),
        ]
        .into(),
        packs: [(hex::encode([4; 32]), EntryAudience::Members)].into(),
    };
    let present = State::Present(ledger.clone());
    let err =
        super::check_narrower_coverage(&BTreeSet::new(), &present, &local, Some("origin"), &keys)
            .expect_err("members-key path must refuse dropping a locally held narrower branch")
            .downcast::<forge_core::user_error::UserError>()
            .expect("preserve the coded error and its fixes");
    assert_eq!(
        err.code,
        forge_core::user_error::codes::CANNOT_CHECK_MEMBERS_ONLY
    );
    assert!(err.message.contains("sec/maintainers"));
    assert!(err
        .cause
        .unwrap()
        .contains("no longer opens with your keys"));
    assert!(err
        .fix
        .iter()
        .any(|f| f.contains("git branch -dr origin/sec/maintainers")));
    for state in [
        State::Absent,
        State::Unknown,
        State::Present(Ledger::default()),
        State::Present(Ledger {
            commits: [(old_tip.clone(), EntryAudience::Members)].into(),
            ..ledger.clone()
        }),
    ] {
        assert!(super::check_narrower_coverage(
            &BTreeSet::new(),
            &state,
            &local,
            Some("origin"),
            &keys
        )
        .is_ok());
    }
    // An unrelated narrower entry never makes an unrecorded local branch narrower.
    let unrelated = vec![(BRANCH.into(), hex::encode([5; 20]))];
    assert!(super::check_narrower_coverage(
        &BTreeSet::new(),
        &present,
        &unrelated,
        Some("origin"),
        &keys
    )
    .is_ok());
    // Authenticated deletions are covered, as on the branch-key-only path.
    let deleted = vec![(BRANCH.into(), RefState::Unborn)];
    let ring = ring(vec![BranchKey::from_bytes([7; 32])]);
    let covered = super::covered_ref_names(&deleted, Some(&ring));
    assert!(
        super::check_narrower_coverage(&covered, &present, &local, Some("origin"), &keys).is_ok()
    );
    let unopened = super::covered_ref_names(&deleted, None);
    assert!(
        super::check_narrower_coverage(&unopened, &present, &local, Some("origin"), &keys).is_err()
    );
    let readable = vec![(
        BRANCH.into(),
        RefState::Resolved {
            oid: old_tip,
            author: "reader".into(),
            created_at: 1,
        },
    )];
    assert!(super::check_narrower_coverage(
        &super::covered_ref_names(&readable, None),
        &present,
        &local,
        Some("origin"),
        &keys
    )
    .is_ok());
    assert!(
        super::check_narrower_coverage(&BTreeSet::new(), &present, &[], Some("origin"), &keys)
            .is_ok()
    );
}

#[test]
fn readable_tip_deletion_and_public_refs_keep_their_existing_policy() {
    let refs = missing_tip_refs();
    let sealed = BTreeSet::from([BRANCH.into()]);
    let plan = super::readable_ref_plan(refs.clone(), &sealed, &BTreeSet::new(), &[], |_| true);
    assert_eq!(plan.refs, refs);
    assert!(plan.warnings.is_empty());
    let deleted = vec![(BRANCH.into(), RefState::Unborn)];
    let plan = super::readable_ref_plan(deleted.clone(), &sealed, &BTreeSet::new(), &[], |_| false);
    assert_eq!(plan.refs, deleted);
    assert!(plan.warnings.is_empty());
    // Public tips may arrive with the public packs during the later fetch.
    let plan = super::readable_ref_plan(
        refs.clone(),
        &BTreeSet::new(),
        &BTreeSet::new(),
        &[],
        |_| false,
    );
    assert_eq!(plan.refs, refs);
    assert!(plan.warnings.is_empty());
}

#[test]
fn members_key_coverage_uses_local_remote_names_and_drop_hint_recovers() {
    use forge_core::members_git::ledger::{EntryAudience, Ledger, State};
    if !ledger_test_worker("members_key_coverage_uses_local_remote_names_and_drop_hint_recovers") {
        return;
    }
    let dir = std::env::current_dir().unwrap();
    let tip = String::from_utf8(git(
        &dir,
        &["hash-object", "-w", "--stdin"],
        Some(b"local tip"),
    ))
    .unwrap()
    .trim()
    .to_owned();
    git(
        &dir,
        &["update-ref", "refs/remotes/origin/sec/maintainers", &tip],
        None,
    );
    git(
        &dir,
        &["update-ref", "refs/remotes/other/unrelated", &tip],
        None,
    );
    git(
        &dir,
        &[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/sec/maintainers",
        ],
        None,
    );
    let ledger = State::Present(Ledger {
        commits: [(
            tip.clone(),
            EntryAudience::Narrower("branch:fixture".into()),
        )]
        .into(),
        ..Ledger::default()
    });
    let local = crate::members::remote_tracking_tips(Some("origin")).unwrap();
    assert_eq!(local, vec![(BRANCH.into(), tip.clone())]);
    let err = super::check_narrower_coverage(
        &BTreeSet::new(),
        &ledger,
        &local,
        Some("origin"),
        &MembersKeys::Held(keyring()),
    )
    .unwrap_err();
    let err = err
        .downcast::<forge_core::user_error::UserError>()
        .expect("preserve the coded error");
    assert!(err
        .fix
        .iter()
        .any(|f| f.contains("git branch -dr origin/sec/maintainers")));
    // The refused list leaves the existing tracking branch untouched.
    assert_eq!(
        crate::members::remote_tracking_tips(Some("origin")).unwrap(),
        local
    );
    git(&dir, &["branch", "-dr", "origin/sec/maintainers"], None);
    let local = crate::members::remote_tracking_tips(Some("origin")).unwrap();
    assert!(local.is_empty());
    assert!(super::check_narrower_coverage(
        &BTreeSet::new(),
        &ledger,
        &local,
        Some("origin"),
        &MembersKeys::Held(keyring())
    )
    .is_ok());
    assert!(crate::members::remote_tracking_tips(None).is_none());
    assert!(crate::members::remote_tracking_tips(Some("dash://owner/repo")).is_none());
}

fn missing_tip_refs() -> Vec<(String, RefState)> {
    vec![(
        BRANCH.into(),
        RefState::Resolved {
            oid: hex::encode([9; 20]),
            author: "writer".into(),
            created_at: 2,
        },
    )]
}

#[test]
fn unheld_missing_tip_is_omitted_without_blocking_other_refs() {
    for shared in [BTreeSet::new(), BTreeSet::from([BRANCH.into()])] {
        let public = (
            "refs/heads/main".into(),
            RefState::Resolved {
                oid: hex::encode([1; 20]),
                author: "owner".into(),
                created_at: 1,
            },
        );
        let mut refs = missing_tip_refs();
        refs.push(public.clone());
        let plan =
            super::readable_ref_plan(refs, &BTreeSet::from([BRANCH.into()]), &shared, &[], |_| {
                false
            });
        assert_eq!(plan.refs, vec![public]);
        let warning = if shared.is_empty() {
            "dash: warning: members-only branch sec/maintainers isn't fetched: no stored pack holds its commits (whoever pushed it can push it again)"
        } else {
            "dash: warning: sec/maintainers was shared with you, but its commits didn't arrive; ask whoever shared it to share it again"
        };
        assert_eq!(plan.warnings, [warning]);
    }
}

#[test]
fn held_missing_tip_with_missing_local_objects_is_omitted() {
    let local = vec![(BRANCH.into(), hex::encode([2; 20]))];
    let plan = super::readable_ref_plan(
        missing_tip_refs(),
        &BTreeSet::from([BRANCH.into()]),
        &BTreeSet::new(),
        &local,
        |_| false,
    );
    assert!(
        plan.refs.is_empty(),
        "never advertise a tip without its objects"
    );
    assert_eq!(plan.warnings, ["dash: warning: members-only branch sec/maintainers isn't fetched: no stored pack holds its commits (whoever pushed it can push it again)"]);
}

#[test]
fn planned_local_tip_survives_fetch_prune_in_a_git_transport_fixture() {
    if !ledger_test_worker("planned_local_tip_survives_fetch_prune_in_a_git_transport_fixture") {
        return;
    }
    let dir = std::env::current_dir().unwrap();
    let (pack, tip) = git_pack();
    git(&dir, &["index-pack", "--stdin"], Some(&pack));
    let remote = tempfile::tempdir().unwrap();
    git(remote.path(), &["init", "--bare", "-q"], None);
    git(remote.path(), &["index-pack", "--stdin"], Some(&pack));
    git(
        &dir,
        &["remote", "add", "origin", remote.path().to_str().unwrap()],
        None,
    );
    for shared in [BTreeSet::new(), BTreeSet::from([BRANCH.into()])] {
        git(
            &dir,
            &["update-ref", "refs/remotes/origin/sec/maintainers", &tip],
            None,
        );
        let local = crate::members::remote_tracking_tips(Some("origin")).unwrap();
        let plan = super::readable_ref_plan(
            missing_tip_refs(),
            &BTreeSet::from([BRANCH.into()]),
            &shared,
            &local,
            crate::git::LocalRepo::object_exists,
        );
        assert_eq!(super::remote_tip(&plan.refs, BRANCH), Some(tip.clone()));
        let remedy = if shared.is_empty() {
            "whoever pushed it can push it again"
        } else {
            "ask whoever shared it to share it again"
        };
        assert_eq!(plan.warnings, [format!("dash: warning: branch sec/maintainers: its newer tip didn't arrive; keeping the version this clone has ({remedy})")]);
        // Materialize exactly the policy's advertised refs in a local Git transport fixture.
        for (name, state) in &plan.refs {
            git(
                remote.path(),
                &["update-ref", name, &super::tip_oid(state).unwrap()],
                None,
            );
        }
        git(&dir, &["fetch", "--prune", "origin"], None);
        assert_eq!(
            crate::members::remote_tracking_tips(Some("origin")).unwrap(),
            local,
            "fetch --prune must keep the held branch at its servable tracking tip"
        );
        // Control: this fixture really does prune when a name is absent from the advertisement.
        git(remote.path(), &["update-ref", "-d", BRANCH], None);
        git(&dir, &["fetch", "--prune", "origin"], None);
        assert!(crate::members::remote_tracking_tips(Some("origin"))
            .unwrap()
            .is_empty());
    }
}

#[test]
fn round4_members_caller_skips_unnamed_remote_but_checks_named_failures() {
    use forge_core::members_git::ledger::{EntryAudience, Ledger, State};
    let keys = MembersKeys::Held(keyring());
    let ledger = State::Present(Ledger {
        commits: [(
            hex::encode([2; 20]),
            EntryAudience::Narrower("branch:fixture".into()),
        )]
        .into(),
        ..Ledger::default()
    });
    let view = forge_core::refs::MembersView::default();
    for remote in [None, Some(""), Some("dash://owner/repo")] {
        let called = std::cell::Cell::new(false);
        let result =
            super::check_members_fetch_coverage(true, remote, &[], &view, &keys, &ledger, |_| {
                called.set(true);
                None
            });
        assert!(
            result.is_ok(),
            "URL fetch/pull/list has no tracking refs to prune: {result:?}"
        );
        assert!(
            !called.get(),
            "unnamed remotes must not try to read tracking refs"
        );
    }
    let err = super::check_members_fetch_coverage(
        true,
        Some("origin"),
        &[],
        &view,
        &keys,
        &ledger,
        |_| None,
    )
    .unwrap_err();
    assert!(err
        .to_string()
        .contains("reading this clone's remote-tracking branches"));
    for check in [false, true] {
        let called = std::cell::Cell::new(false);
        super::check_members_fetch_coverage(
            check,
            Some("origin"),
            &[],
            &view,
            &keys,
            &ledger,
            |remote| {
                assert_eq!(remote, "origin");
                called.set(true);
                Some(Vec::new())
            },
        )
        .unwrap();
        assert_eq!(called.get(), check);
    }
}

#[test]
fn round4_members_caller_covers_deleted_public_and_opened_members_names() {
    use forge_core::members_git::ledger::{EntryAudience, Ledger, State};
    let keys = MembersKeys::Held(keyring());
    let oid = hex::encode([2; 20]);
    let ledger = State::Present(Ledger {
        commits: [(
            oid.clone(),
            EntryAudience::Narrower("branch:fixture".into()),
        )]
        .into(),
        ..Ledger::default()
    });
    let name = "refs/heads/feature-x";
    let deleted = vec![(name.into(), RefState::Unborn)];
    let local = vec![(name.into(), oid)];
    let empty = forge_core::refs::MembersView::default();
    super::check_members_fetch_coverage(
        true,
        Some("origin"),
        &deleted,
        &empty,
        &keys,
        &ledger,
        |_| Some(local.clone()),
    )
    .expect("a signed public deletion must not be mistaken for losing a narrower key");
    let opened = forge_core::refs::MembersView {
        refs: deleted,
        ..Default::default()
    };
    super::check_members_fetch_coverage(true, Some("origin"), &[], &opened, &keys, &ledger, |_| {
        Some(local.clone())
    })
    .expect("a deletion opened with the members key retains the base behavior");
    assert!(
        super::check_members_fetch_coverage(
            true,
            Some("origin"),
            &[],
            &empty,
            &keys,
            &ledger,
            |_| Some(local)
        )
        .is_err(),
        "a genuinely uncovered locally recorded narrower name still refuses"
    );
}

#[test]
fn round4_shared_notice_finds_the_shared_head_after_a_deletion() {
    let head = hex::encode([2; 20]);
    let refs = vec![
        (BRANCH.into(), RefState::Unborn),
        (
            BRANCH.into(),
            RefState::Resolved {
                oid: head.clone(),
                author: "sharer".into(),
                created_at: 2,
            },
        ),
    ];
    assert!(super::offered_shared_head(&refs, BRANCH, &head));
    assert!(!super::offered_shared_head(
        &refs,
        BRANCH,
        &hex::encode([3; 20])
    ));
    assert!(!super::offered_shared_head(&refs[..1], BRANCH, &head));
}

#[test]
fn round4_held_key_refusal_suggests_sharing_without_unlocking() {
    let keys = MembersKeys::Held(keyring());
    let error = super::branch_keys_unavailable(&keys, Some("origin"), Some(&[BRANCH.into()]));
    assert!(error
        .fix
        .iter()
        .any(|fix| fix.contains("share its branch key again")));
    assert!(!error.fix.iter().any(|fix| fix.contains("unlock")));
    let locked = MembersKeys::Locked("the passphrase is wrong".into());
    let error = super::branch_keys_unavailable(&locked, Some("origin"), Some(&[BRANCH.into()]));
    assert!(error
        .fix
        .iter()
        .any(|fix| fix.contains("unlock your encryption key")));
    let nonmember =
        MembersKeys::from_keyring(Arc::new(Keyring::keyless_for_tests(REPO, BOT, Vec::new())));
    let error = super::branch_keys_unavailable(&nonmember, Some("origin"), Some(&[BRANCH.into()]));
    assert!(error.cause.unwrap().contains("you are not a member"));
}
