//! LIVE devnet smoke of members-only branches and pull requests (mixed-visibility phase 3,
//! `docs/security/private-repos.md` §19), through the library only.
//!
//! Ignored by default. Run explicitly with:
//!
//! ```sh
//! P3_REPO=<public repo id with members-only content on> P3_WRITER=<owner or writer identity file> \
//! P3_READER=<another member's identity file> \
//!   cargo test -p forge-core --test live_members_branch -- --ignored --nocapture
//! ```
//!
//! As the writer: a members-only ref update of a fresh branch name (keyed name hash, blinded
//! `newOid`), a members-only PR from that branch into public `main` (public base hash, the copied
//! blind head with its real value and salt sealed), and a members-only head update (kind 16) to
//! a second blinded commit; consensus must admit all three on the live contracts. Then reads
//! them back as the second member (real values, verified blinds) and as an outsider (no key:
//! blinds only, the branch never a public ref, a members-only update count).
//!
//! Network: `DASH_FORGE_DEVNET` (default `sakura`).

use std::collections::BTreeMap;

use forge_core::collab::private::{
    seal_members_head_update_props, seal_members_patch_props, HeadBlind, MembersPatch,
};
use forge_core::keyring::{header_of, EncryptionKeys, Keyring};
use forge_core::keystore::BridgeIdentity;
use forge_core::network::NetworkSettings;
use forge_core::platform::{
    decode_identifier, BroadcastOutcome, FieldValue, PlatformClient, WriteEngine,
};
use forge_core::private::blind::{self, Head};
use forge_core::private::members_ref::{self, RefUpdateIn};
use forge_core::private::{DocKind, Opened};

const BRANCH_PREFIX: &str = "refs/heads/sec/p3core-smoke-";

fn sha1ish(label: &str) -> [u8; 20] {
    let d = forge_core::private::keys::sha256(label.as_bytes());
    d[..20].try_into().unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "live devnet write; run with --ignored"]
#[allow(clippy::too_many_lines)]
async fn members_only_branch_and_pr_round_trip_on_the_live_contracts() {
    let devnet = std::env::var("DASH_FORGE_DEVNET").unwrap_or_else(|_| "sakura".to_string());
    let target = NetworkSettings {
        network: Some("devnet".into()),
        devnet_name: Some(devnet),
        ..Default::default()
    }
    .resolve()
    .expect("resolve devnet");
    let client = PlatformClient::connect(target).await.expect("connect");
    let repo_id = std::env::var("P3_REPO").expect("P3_REPO");
    let repo = forge_core::resolve::resolve_id(&client, &repo_id)
        .await
        .expect("resolve the repository");
    let scope = repo.scope().unwrap();
    let core = client.fetch_contract(&repo.forge().core).await.unwrap();
    let collab = client.fetch_contract(&repo.forge().collab).await.unwrap();
    let community = client
        .fetch_contract(&repo.forge().community)
        .await
        .unwrap();

    let load = |var: &str| BridgeIdentity::load_from_file(std::env::var(var).expect(var)).unwrap();
    let writer = load("P3_WRITER");
    let reader = load("P3_READER");
    let writer_identity = client.fetch_identity(&writer.identity_id).await.unwrap();
    let reader_identity = client.fetch_identity(&reader.identity_id).await.unwrap();
    let enc = |b: &BridgeIdentity, i: &forge_core::platform::LoadedIdentity| {
        EncryptionKeys::held(b, &i.public_keys(), &repo.forge().core, client.network())
    };
    let wkr = Keyring::load(
        &client,
        &repo,
        &writer.identity_id,
        &enc(&writer, &writer_identity),
    )
    .await
    .unwrap();
    let lane = wkr.lane(&repo).expect("the writer holds the members key");
    let owner = decode_identifier(&writer.identity_id).unwrap();
    let engine = WriteEngine::new(
        &client,
        &writer_identity,
        writer.doc_op_key().expect("a HIGH/CRITICAL auth key"),
    )
    .unwrap();
    let run = format!(
        "{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
    );
    let branch = format!("{BRANCH_PREFIX}{run}");
    let (h1, h2) = (sha1ish(&format!("{run} h1")), sha1ish(&format!("{run} h2")));
    println!(
        "repo {repo_id}, write epoch {}, branch (members-only) {branch}",
        lane.write_epoch()
    );

    // 1. the members-only ref update
    let push = |new: &[u8; 20], prev: Option<&[u8; 20]>| {
        members_ref::seal(
            lane.write_keys(),
            owner,
            &RefUpdateIn {
                kind: DocKind::RefUpdate,
                name: &branch,
                new_oid: new,
                prev_oid: prev.map(|p| &p[..]),
                force: false,
            },
        )
        .unwrap()
    };
    let p1 = push(&h1, None);
    let mut props = scope.scoped(p1.props());
    props.insert("r".into(), FieldValue::integer(1));
    let prepared = engine
        .prepare_create(&core, "refUpdate", props)
        .await
        .unwrap();
    let ru_id = prepared.document_id().to_string();
    assert_eq!(
        engine.execute(&prepared).await.unwrap(),
        BroadcastOutcome::Applied
    );
    println!(
        "ADMITTED refUpdate {ru_id}: refName absent, newOid {} (blind of the real head)",
        hex::encode(&p1.new_oid)
    );

    // 2. the members-only PR from it into public main
    let number = std::env::var("P3_PR_NUMBER").map_or(1, |n| n.parse().unwrap());
    let mut pr = BTreeMap::new();
    for (k, v) in [
        ("number", FieldValue::integer(number)),
        ("tk", FieldValue::integer(1)),
        ("title", FieldValue::text("p3-core smoke: members-only PR")),
        (
            "body",
            FieldValue::text("Sealed with forge-core's members-only PR writer."),
        ),
        ("baseRefName", FieldValue::text("refs/heads/main")),
        ("sourceRefName", FieldValue::text(branch.clone())),
        ("sourceRepoId", FieldValue::identifier(scope.repo_id)),
        ("headOid", FieldValue::bytes(p1.new_oid.clone())),
        ("vis", FieldValue::text("public")),
        ("asMember", FieldValue::identifier(owner)),
    ] {
        pr.insert(k.to_string(), v);
    }
    let members = MembersPatch {
        base_public: true,
        source_public: false,
        head: Some(HeadBlind {
            real: h1.to_vec(),
            salt: p1.salt,
        }),
    };
    let sealed = seal_members_patch_props(&lane, owner, scope.scoped(pr), &members).unwrap();
    let prepared = engine
        .prepare_create(&collab, "patch", sealed)
        .await
        .unwrap();
    let pr_id = prepared.document_id().to_string();
    assert_eq!(
        engine.execute(&prepared).await.unwrap(),
        BroadcastOutcome::Applied
    );
    println!(
        "ADMITTED patch {pr_id} (#{number}): title/body/branch names absent, headOid {}",
        hex::encode(&p1.new_oid)
    );

    // 3. the branch moves (a second members-only update) and the PR's head follows (kind 16)
    let p2 = push(&h2, Some(&h1));
    let mut props = scope.scoped(p2.props());
    props.insert("r".into(), FieldValue::integer(1));
    let prepared = engine
        .prepare_create(&core, "refUpdate", props)
        .await
        .unwrap();
    assert_eq!(
        engine.execute(&prepared).await.unwrap(),
        BroadcastOutcome::Applied
    );
    let mut hu = BTreeMap::new();
    for (k, v) in [
        (
            "targetId",
            FieldValue::identifier(decode_identifier(&pr_id).unwrap()),
        ),
        ("targetNumber", FieldValue::integer(number)),
        ("kind", FieldValue::integer(16)),
        ("oid", FieldValue::bytes(p2.new_oid.clone())),
        ("r", FieldValue::integer(1)),
    ] {
        hu.insert(k.to_string(), v);
    }
    let sealed = seal_members_head_update_props(
        &lane,
        owner,
        scope.scoped(hu),
        &HeadBlind {
            real: h2.to_vec(),
            salt: p2.salt,
        },
    )
    .unwrap();
    let prepared = engine
        .prepare_create(&community, "event", sealed)
        .await
        .unwrap();
    let hu_id = prepared.document_id().to_string();
    assert_eq!(
        engine.execute(&prepared).await.unwrap(),
        BroadcastOutcome::Applied
    );
    println!(
        "ADMITTED event {hu_id} (kind 16): oid {}",
        hex::encode(&p2.new_oid)
    );

    // 4. the second member reads real values
    let rkr = Keyring::load(
        &client,
        &repo,
        &reader.identity_id,
        &enc(&reader, &reader_identity),
    )
    .await
    .unwrap();
    let (refs, updates) = forge_core::refs::read_members_refs(&client, &core, &scope, &rkr)
        .await
        .unwrap();
    let state = refs
        .iter()
        .find(|(n, _)| n == &branch)
        .map(|(_, s)| s.clone());
    println!(
        "MEMBER refs: {branch} -> {state:?}; alerts {}; unreadable {}",
        updates.alerts.len(),
        updates.unreadable
    );
    match state {
        Some(forge_core::rules::RefState::Resolved { oid, .. }) => assert_eq!(oid, hex::encode(h2)),
        other => panic!("the member reads the branch at its real tip: {other:?}"),
    }
    assert!(updates.alerts.is_empty());
    let pr_doc = client
        .fetch_document(&collab, "patch", &pr_id)
        .await
        .unwrap()
        .unwrap();
    let head = header_of(DocKind::Patch, &pr_doc).unwrap();
    let Opened::Readable(f) = rkr.open(DocKind::Patch, &pr_doc) else {
        panic!("the member opens the PR");
    };
    let plain = pr_doc.field_bytes("headOid").unwrap();
    let Some(Head::Real { real, .. }) =
        blind::head_of(&plain, f.head_oid.as_deref(), f.oid_salt.as_ref())
    else {
        panic!("a verified head");
    };
    assert_eq!(real, h1.to_vec());
    assert_eq!(
        head.base_ref_name_hash,
        Some(forge_core::private::keys::sha256(b"refs/heads/main"))
    );
    println!(
        "MEMBER PR #{number}: title {:?}, source {:?}, headOid (blind) {} -> real {}",
        f.title.as_deref().unwrap_or(""),
        f.source_ref_name.as_deref().unwrap_or(""),
        hex::encode(&plain),
        hex::encode(&real)
    );
    let ev = client
        .fetch_document(&community, "event", &hu_id)
        .await
        .unwrap()
        .unwrap();
    let Opened::Readable(ef) = rkr.open(DocKind::Event, &ev) else {
        panic!("the member opens the head update");
    };
    let Some(Head::Real { real, .. }) = blind::head_of(
        &ev.field_bytes("oid").unwrap(),
        ef.head_oid.as_deref(),
        ef.oid_salt.as_ref(),
    ) else {
        panic!("a verified head update");
    };
    assert_eq!(real, h2.to_vec());
    println!(
        "MEMBER head update: oid (blind) {} -> real {}",
        hex::encode(ev.field_bytes("oid").unwrap()),
        hex::encode(&real)
    );

    // 5. an outsider: no key, blinds only, never a public ref, a count of members-only updates
    let anon = Keyring::load_anonymous(&client, &repo).await.unwrap();
    assert!(matches!(
        anon.open(DocKind::Patch, &pr_doc),
        Opened::Unreadable(_)
    ));
    assert!(matches!(
        anon.open(DocKind::Event, &ev),
        Opened::Unreadable(_)
    ));
    let state = forge_core::refs::read_git_state(
        &client,
        &core,
        &scope,
        forge_core::history::Freshness::Now,
    )
    .await
    .unwrap();
    let public_names: Vec<String> = state
        .ref_histories()
        .values()
        .filter_map(|us| us.first().map(|u| u.ref_name.clone()))
        .collect();
    assert!(!public_names.iter().any(|n| n.starts_with(BRANCH_PREFIX)));
    let outsider = forge_core::refs::members_updates_of(&state, |k, d| anon.open(k, d));
    assert!(!outsider.by_name.contains_key(&branch));
    let (sealed_updates, names) = forge_core::refs::members_only_ref_count(&state);
    assert!(sealed_updates >= 2);
    println!(
        "OUTSIDER: public refs {public_names:?}; members-only ref updates {sealed_updates} under {names} name hash(es), {} unreadable to them; PR headOid {} (no real value), title absent: {}",
        outsider.unreadable,
        hex::encode(&plain),
        pr_doc.field_str("title").is_none()
    );
    assert_ne!(plain, h1.to_vec());
    println!("LIVE OK");
}
