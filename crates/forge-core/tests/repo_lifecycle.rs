//! Live testnet repo-lifecycle test (gated `#[ignore]`).
//!
//! Exercises the full M1 loop against real testnet with the funded DEPLOYER identity:
//! create a repo (measuring the repo-v1 instantiation cost), resolve it via the registry,
//! write + read a ref, round-trip a pack chunk through `PlatformBackend`, then clean up
//! the deletable docs (chunks / manifest / listing — refund; the contract is permanent).
//!
//! Run with:
//! ```text
//! cargo test -p forge-core --test repo_lifecycle -- --ignored --nocapture
//! ```

use std::time::{SystemTime, UNIX_EPOCH};

use forge_core::backends::PackMeta;
use forge_core::keystore::BridgeIdentity;
use forge_core::platform::{Network, PlatformClient};
use forge_core::repo::{credits_to_dash, CreateRepoOpts, PackManifestInput, RepoService};
use forge_core::rules::RefState;

const DEPLOYER_PATH: &str =
    "/Users/pasta/.config/dash-forge/test-identities/DEPLOYER.identity.json";

#[tokio::test]
#[ignore = "live testnet; spends ~1-2 tDASH; run manually"]
#[allow(clippy::too_many_lines)]
async fn full_repo_lifecycle_on_testnet() {
    let bridge = BridgeIdentity::load_from_file(DEPLOYER_PATH).expect("load DEPLOYER identity");
    let owner_id = bridge.identity_id.clone();
    println!("owner (DEPLOYER): {owner_id}");

    let client = PlatformClient::connect(Network::Testnet)
        .await
        .expect("connect testnet");
    let identity = client
        .fetch_identity(&owner_id)
        .await
        .expect("fetch DEPLOYER identity");
    println!("balance before: {} credits", identity.balance());

    let service = RepoService::new(&client, &identity, &bridge);

    // Unique per run so a re-run does not collide on the (ownerId, normalizedName) index.
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let name = format!("m1-test-{suffix}");

    // --- 1. create_repo (headline cost) ---
    //
    // `FORGE_REUSE_CONTRACT=<id>` resumes against an already-created repo-v1 contract
    // (skipping the paid DataContractCreate) — used when the funded identity already paid
    // for a create whose follow-ups failed, so the ~1.18 DASH create is not repeated.
    let opts = CreateRepoOpts {
        default_branch: "main".into(),
        backend_mode: 0,
        description: "M1 lifecycle test repo".into(),
        template_version: 1,
    };
    let reuse = std::env::var("FORGE_REUSE_CONTRACT").unwrap_or_default();
    let created = if reuse.is_empty() {
        service
            .create_repo(&name, &opts)
            .await
            .expect("create_repo")
    } else {
        println!("resuming against existing repo contract {reuse}");
        service
            .resume_repo(&reuse, &name, &opts)
            .await
            .expect("resume_repo")
    };
    let handle = created.handle.clone();
    let cost = created.repo_v1_instantiation_cost_credits;
    println!(
        "REPO-V1 INSTANTIATION COST: {cost} credits = {:.6} DASH",
        credits_to_dash(cost)
    );
    println!("repo contract id: {}", handle.repo_contract_id);
    if reuse.is_empty() {
        assert!(cost > 0, "instantiation cost should be measured");
    }

    // --- 2. resolve via registry ---
    let resolved = service
        .resolve_repo(&owner_id, &name)
        .await
        .expect("resolve_repo");
    assert_eq!(
        resolved.repo_contract_id, handle.repo_contract_id,
        "resolved contract id must match the created one"
    );
    println!("resolve_repo OK -> {}", resolved.repo_contract_id);

    // --- 3. write a ref update (refs/heads/main -> oid) ---
    let oid = [0x11u8; 20];
    let ref_name = "refs/heads/main";
    let ref_doc_id = service
        .write_ref_update(&handle, ref_name, &oid, None, false)
        .await
        .expect("write_ref_update");
    println!("wrote refUpdate {ref_doc_id}");

    // --- 4. read_refs resolves it ---
    let refs = service.read_refs(&handle).await.expect("read_refs");
    println!("read_refs -> {refs:?}");
    let main = refs
        .iter()
        .find(|(n, _)| n == ref_name)
        .expect("refs/heads/main present");
    match &main.1 {
        RefState::Resolved { oid: got, .. } => {
            assert_eq!(
                *got,
                hex::encode(oid),
                "resolved tip must equal written oid"
            );
        }
        other => panic!("expected Resolved, got {other:?}"),
    }
    println!("ref resolved correctly");

    // --- 5. write a small pack (chunk) + manifest via PlatformBackend ---
    let pack_bytes: Vec<u8> = (0..5000u32).map(|i| (i % 251) as u8).collect();
    let meta = PackMeta::for_bytes(&pack_bytes);
    let pack_hash = meta.pack_hash_bytes().expect("pack hash bytes");
    let locators = service
        .put_pack(&handle, &pack_bytes, &meta)
        .await
        .expect("put_pack");
    println!("put_pack -> {locators:?}");
    let locator = locators.first().expect("one locator").clone();

    let manifest = PackManifestInput {
        pack_hash,
        kind: 0,
        size_bytes: pack_bytes.len() as u64,
        object_count: 1,
        chunk_count: 1,
        storage: 0,
        offset_index_parts: 1,
        uris: vec![locator.0.clone()],
        supersedes: Vec::new(),
        tips: Vec::new(),
    };
    let manifest_id = service
        .write_pack_manifest(&handle, &manifest)
        .await
        .expect("write_pack_manifest");
    println!("wrote packManifest {manifest_id}");

    let manifests = service
        .read_pack_manifests(&handle)
        .await
        .expect("read_pack_manifests");
    assert!(
        manifests.iter().any(|m| m.pack_hash == pack_hash),
        "manifest should be readable"
    );

    // --- 6. read the chunk back and verify bytes ---
    let got = service
        .get_pack(&handle, &locator, None)
        .await
        .expect("get_pack");
    assert_eq!(got, pack_bytes, "chunk round-trip must be bit-for-bit");
    println!("chunk round-trip OK ({} bytes)", got.len());

    // --- 7. cleanup (refund the deletable docs) ---
    let removed = service
        .delete_chunks(&handle, pack_hash)
        .await
        .expect("delete_chunks");
    println!("deleted {removed} chunk(s)");
    service
        .delete_document(&handle.repo_contract_id, "packManifest", &manifest_id)
        .await
        .expect("delete packManifest");
    service
        .delete_document(
            forge_core::repo::TESTNET_REGISTRY_CONTRACT_ID,
            "repoListing",
            &created.listing_document_id,
        )
        .await
        .expect("delete repoListing");
    println!("cleanup done (contract + non-deletable config/refUpdate remain permanently)");

    let after = client.get_balance(&owner_id).await.expect("balance after");
    println!("balance after (post-refund): {after} credits");
}
