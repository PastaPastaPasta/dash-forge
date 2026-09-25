//! Live forge-v2 repo lifecycle on devnet moutai (gated `#[ignore]`).
//!
//! With the moutai OWNER / COLLAB / CONTRIB fixtures:
//!
//! 1. create a repo (the `repo` + owner `maintainer` + `config` session) and check the cost
//!    is under 0.01 DASH; re-running the create costs nothing and writes nothing;
//! 2. resolve it by `owner/name` and by its id;
//! 3. OWNER writes a ref + a Platform-stored pack and reads both back;
//! 4. grant COLLAB `writer` → COLLAB writes a ref; revoke → COLLAB's next write is refused
//!    at consensus with 40120 ([`Error::NotAMember`]);
//! 5. CONTRIB (never a member) is refused the same way.
//!
//! ```text
//! cargo test -p forge-core --test repo_lifecycle -- --ignored --nocapture
//! ```
//! Identities: `$E2E_IDENTITY_DIR` (default `~/.config/dash-forge/test-identities/devnet-moutai`).

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use forge_core::backends::PackMeta;
use forge_core::create::{create_repo, CreateRepoOpts, StepOutcome};
use forge_core::keystore::BridgeIdentity;
use forge_core::members::{MemberReader, MemberService};
use forge_core::network::NetworkSettings;
use forge_core::platform::{LoadedIdentity, PlatformClient};
use forge_core::repo::{credits_to_dash, PackManifestInput, RepoService};
use forge_core::resolve::{resolve_id, resolve_named};
use forge_core::rules::v2::Role;
use forge_core::rules::RefState;
use forge_core::storage::PackReader;
use forge_core::Error;

fn fixture(role: &str) -> BridgeIdentity {
    let dir = std::env::var_os("E2E_IDENTITY_DIR").map_or_else(
        || {
            PathBuf::from(std::env::var_os("HOME").expect("HOME"))
                .join(".config/dash-forge/test-identities/devnet-moutai")
        },
        PathBuf::from,
    );
    BridgeIdentity::load_from_file(dir.join(format!("{role}.identity.json")))
        .unwrap_or_else(|e| panic!("load {role}: {e}"))
}

async fn loaded(client: &PlatformClient, b: &BridgeIdentity) -> LoadedIdentity {
    client
        .fetch_identity(&b.identity_id)
        .await
        .expect("fetch identity")
}

async fn ref_tip(
    svc: &RepoService<'_>,
    repo: &forge_core::scope::RepoRef,
    name: &str,
) -> Option<String> {
    for _ in 0..8 {
        let refs = svc.read_refs(repo).await.expect("read_refs");
        if let Some((_, RefState::Resolved { oid, .. })) = refs.iter().find(|(n, _)| n == name) {
            return Some(oid.clone());
        }
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    }
    None
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "live devnet moutai; spends ~0.01 DASH; run manually"]
#[allow(clippy::too_many_lines)]
async fn forge_v2_repo_lifecycle_on_moutai() {
    let target = NetworkSettings {
        devnet_name: Some("moutai".into()),
        ..Default::default()
    }
    .resolve()
    .unwrap();
    let client = PlatformClient::connect(target)
        .await
        .expect("connect moutai");
    let owner_b = fixture("OWNER");
    let collab_b = fixture("COLLAB");
    let contrib_b = fixture("CONTRIB");
    let owner = loaded(&client, &owner_b).await;
    let collab = loaded(&client, &collab_b).await;
    let contrib = loaded(&client, &contrib_b).await;
    let journals = tempfile::tempdir().unwrap();

    // --- 1. create ---
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut opts = CreateRepoOpts::public(format!("v2-life-{suffix}"));
    opts.description = "forge-v2 lifecycle test".into();
    let created = create_repo(&client, &owner, &owner_b, &opts, journals.path())
        .await
        .expect("create_repo");
    println!(
        "created {} ({}) cost {} credits = {:.6} DASH; steps {:?}",
        created.repo.display(),
        created.repo.id(),
        created.cost_credits,
        credits_to_dash(created.cost_credits),
        created.steps
    );
    assert!(created
        .steps
        .iter()
        .all(|(_, o)| *o == StepOutcome::Created));
    assert!(
        credits_to_dash(created.cost_credits) <= 0.01,
        "repo create must cost ≤ 0.01 DASH"
    );
    let again = create_repo(&client, &owner, &owner_b, &opts, journals.path())
        .await
        .expect("re-run create");
    assert!(again.already_existed(), "{:?}", again.steps);
    assert_eq!(again.repo, created.repo);
    println!("re-run cost {} credits (no double-pay)", again.cost_credits);
    let repo = created.repo;

    // --- 2. resolve ---
    let by_name = resolve_named(&client, &owner.id(), &opts.name.to_uppercase())
        .await
        .expect("resolve by name");
    assert_eq!(by_name, repo);
    assert_eq!(
        resolve_id(&client, repo.id()).await.expect("resolve by id"),
        repo
    );

    // --- 3. OWNER writes a ref + pack ---
    let svc = RepoService::new(&client, &owner, &owner_b);
    assert_eq!(
        svc.read_default_branch(&repo).await.unwrap().as_deref(),
        Some("main")
    );
    let oid = [0x11u8; 20];
    svc.write_ref_update(&repo, "refs/heads/main", &oid, None, false)
        .await
        .expect("owner ref write");
    assert_eq!(
        ref_tip(&svc, &repo, "refs/heads/main").await,
        Some(hex::encode(oid))
    );

    let payload: Vec<u8> = (0..9000u32)
        .map(|i| u8::try_from(i % 251).unwrap())
        .collect();
    let meta = PackMeta::for_bytes(&payload);
    let uris = svc
        .put_pack(&repo, &payload, &meta)
        .await
        .expect("put_pack");
    println!("pack stored at {uris:?}");
    svc.write_pack_manifest(
        &repo,
        &PackManifestInput {
            pack_hash: meta.pack_hash_bytes().unwrap(),
            kind: 3, // not a git pack: stays out of fetch and the locator space
            size_bytes: payload.len() as u64,
            object_count: 0,
            chunk_count: forge_core::pack::split(&payload).len() as u64,
            storage: 0,
            offset_index_parts: 0,
            uris: uris.iter().map(|u| u.0.clone()).collect(),
            supersedes: Vec::new(),
            tips: Vec::new(),
        },
    )
    .await
    .expect("manifest");
    let manifests = svc.read_pack_manifests(&repo).await.unwrap();
    let m = manifests
        .iter()
        .find(|m| m.pack_hash == meta.pack_hash_bytes().unwrap())
        .unwrap();
    assert_eq!(m.owner_id, owner.id());
    let got = svc
        .fetch_artifact(&repo, m, &PackReader::from_user_config())
        .await
        .expect("read pack back");
    assert_eq!(got, payload);

    // --- 4. writer grant → write → revoke → 40120 ---
    let members = MemberService::new(&client, &owner, &owner_b);
    members
        .grant(&repo, &collab.id(), Role::Writer)
        .await
        .expect("grant");
    let listed = MemberReader::new(&client).list(&repo).await.unwrap();
    assert!(listed
        .iter()
        .any(|m| m.identity_id == collab.id() && m.role == Role::Writer));
    assert!(listed
        .iter()
        .any(|m| m.identity_id == owner.id() && m.role == Role::Maintainer));
    let collab_svc = RepoService::new(&client, &collab, &collab_b);
    collab_svc
        .write_ref_update(&repo, "refs/heads/collab", &[0x22; 20], None, false)
        .await
        .expect("writer can push");
    assert!(members
        .revoke(&repo, &collab.id(), Role::Writer)
        .await
        .unwrap());
    let err = collab_svc
        .write_ref_update(&repo, "refs/heads/collab", &[0x33; 20], None, false)
        .await
        .expect_err("revoked writer must be refused");
    println!("revoked writer: {err}");
    assert!(matches!(err, Error::NotAMember { .. }), "{err}");
    assert!(err.to_string().contains("40120"), "{err}");

    // --- 4b. protected refs are maintainer-only ---
    // Protect refs/heads/main (owner = maintainer), re-grant COLLAB as a writer: COLLAB may
    // update other refs but its update of main is refused at consensus with the typed
    // "maintainer-only" refusal.
    let core = client
        .fetch_contract(
            &forge_core::network::NetworkSettings {
                devnet_name: Some("moutai".into()),
                ..Default::default()
            }
            .resolve()
            .unwrap()
            .v2
            .unwrap()
            .core,
        )
        .await
        .unwrap();
    let mut backend = std::collections::BTreeMap::new();
    backend.insert("mode".into(), forge_core::platform::FieldValue::integer(0));
    let props = repo.scope().unwrap().props([
        (
            "defaultBranch",
            forge_core::platform::FieldValue::text("main"),
        ),
        (
            "protectedPatterns",
            forge_core::platform::FieldValue::text_list(["refs/heads/main"]),
        ),
        ("backend", forge_core::platform::FieldValue::Object(backend)),
    ]);
    forge_core::platform::WriteEngine::new(&client, &owner, owner_b.doc_op_key().unwrap())
        .unwrap()
        .create_document(&core, "config", props)
        .await
        .expect("protect main");
    for _ in 0..8 {
        if svc.protected_patterns(&repo).await.unwrap() == ["refs/heads/main"] {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    }
    members
        .grant(&repo, &collab.id(), Role::Writer)
        .await
        .expect("re-grant");
    let err = collab_svc
        .write_ref_update(&repo, "refs/heads/main", &[0x55; 20], None, false)
        .await
        .expect_err("a writer cannot update a protected ref");
    println!("writer on protected main: {err}");
    assert!(
        matches!(&err, Error::NotAMember { document_type, .. } if document_type == "protectedRefUpdate"),
        "{err}"
    );
    collab_svc
        .write_ref_update(&repo, "refs/heads/feature", &[0x66; 20], None, false)
        .await
        .expect("a writer can update an unprotected ref");
    assert!(members
        .revoke(&repo, &collab.id(), Role::Writer)
        .await
        .unwrap());

    // --- 5. never a member ---
    let err = RepoService::new(&client, &contrib, &contrib_b)
        .write_ref_update(&repo, "refs/heads/contrib", &[0x44; 20], None, false)
        .await
        .expect_err("non-member must be refused");
    assert!(matches!(err, Error::NotAMember { .. }), "{err}");

    let after = client.get_balance(&owner.id()).await.unwrap();
    println!("OWNER balance now {after} credits");
}
