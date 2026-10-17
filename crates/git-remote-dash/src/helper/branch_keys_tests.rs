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
    let error =
        super::branch_keys_unavailable("no members key has been shared with you", None, None);
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
    let error = super::branch_keys_unavailable(
        keys.unavailable_reason(),
        Some("origin"),
        Some(&[BRANCH.into()]),
    );
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
