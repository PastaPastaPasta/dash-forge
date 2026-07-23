//! LIVE testnet integration test: create + verify + delete + refund a single document.
//!
//! Ignored by default so `cargo test` stays offline/fast. Run explicitly with:
//!
//! ```sh
//! cargo test -p forge-core --test live_roundtrip -- --ignored --nocapture
//! ```
//!
//! Identity: `DASH_FORGE_TEST_IDENTITY` (path to a bridge-format identity JSON), else
//! the default CONTRIB test identity. Target contract: the S0.1 throwaway chunk
//! contract (open creation, single `chunk` doc type: packHash + seq + d0..d2).
//!
//! This proves the single most important Stage 2 unknown: the rs-sdk *native* write
//! path (`document_create` / `document_delete` via `broadcast_and_wait`) works on
//! native Rust — the `waitForResponse` panic in the spikes was WASM-only.

use std::collections::BTreeMap;

use forge_core::keystore::BridgeIdentity;
use forge_core::platform::{BroadcastOutcome, FieldValue, Network, PlatformClient, WriteEngine};

/// S0.1 throwaway contract: single `chunk` doc type, open creation.
const CHUNK_CONTRACT: &str = "9hqcGGpuvN86bkbVUQNL99V1Qd5D9pgKjQd5xEXDv8EP";
const DOC_TYPE: &str = "chunk";

const DEFAULT_IDENTITY: &str =
    "/Users/pasta/.config/dash-forge/test-identities/CONTRIB.identity.json";

fn identity_path() -> String {
    std::env::var("DASH_FORGE_TEST_IDENTITY").unwrap_or_else(|_| DEFAULT_IDENTITY.to_string())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "live testnet round-trip; run with --ignored"]
#[allow(clippy::too_many_lines)]
async fn create_verify_delete_refund_roundtrip() {
    // --- Load identity + pick a document-op signing key (HIGH, falling back CRITICAL).
    let id_file = identity_path();
    let bridge = BridgeIdentity::load_from_file(&id_file)
        .unwrap_or_else(|e| panic!("load identity {id_file}: {e}"));
    assert_eq!(bridge.network, "testnet", "test identity must be testnet");
    let key = bridge.doc_op_key().expect("a HIGH/CRITICAL auth key");
    eprintln!(
        "identity {} signing with {} ({})",
        bridge.identity_id, key.name, key.security_level
    );

    // --- Connect to testnet (proof-verified via trusted context provider).
    let client = PlatformClient::connect(Network::Testnet)
        .await
        .expect("connect to testnet");

    let balance_start = client
        .get_balance(&bridge.identity_id)
        .await
        .expect("fetch balance");
    eprintln!("balance start:  {balance_start} credits");
    assert!(balance_start > 0, "identity has no credits to spend");

    let contract = client
        .fetch_contract(CHUNK_CONTRACT)
        .await
        .expect("fetch chunk contract");

    let identity = client
        .fetch_identity(&bridge.identity_id)
        .await
        .expect("fetch identity");
    let engine = WriteEngine::new(&client, &identity, key).expect("build write engine");
    eprintln!(
        "write engine on-chain signing key id: {}",
        engine.signing_key_id()
    );

    // --- Build a small chunk document: random packHash + seq, tiny payload.
    // Small payload keeps the deposit cheap (CONTRIB holds only ~0.048 tDASH).
    let mut pack_hash = [0u8; 32];
    let seed_bytes = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
        .to_le_bytes();
    let n = seed_bytes.len();
    for (i, b) in pack_hash.iter_mut().enumerate() {
        // Two different strides over the timestamp bytes → unique-per-run packHash,
        // no numeric casts (keeps the pedantic lints quiet).
        *b = seed_bytes[i % n].wrapping_add(seed_bytes[(i * 7 + 3) % n]);
    }

    let mut props: BTreeMap<String, FieldValue> = BTreeMap::new();
    props.insert("packHash".to_string(), FieldValue::bytes32(pack_hash));
    props.insert("seq".to_string(), FieldValue::integer(0));
    props.insert("d0".to_string(), FieldValue::bytes(vec![0xAB; 256]));

    // --- CREATE: sign ONCE, then broadcast. Keep the PreparedWrite so we can force a
    // re-broadcast of the identical signed bytes and prove idempotency (fix #2).
    let prepared_create = engine
        .prepare_create(&contract, DOC_TYPE, props)
        .await
        .expect("prepare create");
    let doc_id = prepared_create.document_id().to_string();
    eprintln!(
        "prepared create: doc_id={doc_id}, nonce={}, signed_bytes={}",
        prepared_create.signed().nonce,
        prepared_create.signed().bytes.len()
    );

    let outcome = engine
        .execute(&prepared_create)
        .await
        .expect("create chunk document");
    eprintln!("create outcome: {outcome:?}");
    assert_eq!(
        outcome,
        BroadcastOutcome::Applied,
        "first create should apply"
    );

    let balance_after_create = client
        .get_balance(&bridge.identity_id)
        .await
        .expect("balance after create");
    eprintln!("balance after create: {balance_after_create} credits");
    let create_cost = balance_start.saturating_sub(balance_after_create);
    eprintln!("create cost (deposit+burn): {create_cost} credits");
    assert!(create_cost > 0, "create should have cost credits");

    // --- VERIFY EXISTS.
    let exists = client
        .document_exists(&contract, DOC_TYPE, &doc_id)
        .await
        .expect("query document");
    assert!(exists, "document should exist after create");
    eprintln!("verified: document exists on-chain");

    // --- IDEMPOTENT RE-BROADCAST (fix #2): re-execute the SAME PreparedWrite. The
    // signed bytes carry the already-consumed nonce, so this must NOT create a second
    // document — it must report AlreadyExists.
    let rebroadcast = engine
        .execute(&prepared_create)
        .await
        .expect("re-broadcast should not error");
    eprintln!("re-broadcast outcome: {rebroadcast:?}");
    assert_eq!(
        rebroadcast,
        BroadcastOutcome::AlreadyExists,
        "re-broadcasting the same signed bytes must be idempotent (AlreadyExists), not a duplicate write"
    );

    let balance_after_rebroadcast = client
        .get_balance(&bridge.identity_id)
        .await
        .expect("balance after re-broadcast");
    eprintln!("balance after re-broadcast: {balance_after_rebroadcast} credits");
    assert_eq!(
        balance_after_rebroadcast, balance_after_create,
        "idempotent re-broadcast must not spend additional credits"
    );

    // --- DELETE (sign once + execute).
    engine
        .delete_document(&contract, DOC_TYPE, &doc_id)
        .await
        .expect("delete chunk document");
    eprintln!("deleted document id: {doc_id}");

    let balance_after_delete = client
        .get_balance(&bridge.identity_id)
        .await
        .expect("balance after delete");
    eprintln!("balance after delete: {balance_after_delete} credits");

    // --- VERIFY GONE.
    let still_exists = client
        .document_exists(&contract, DOC_TYPE, &doc_id)
        .await
        .expect("re-query document");
    assert!(!still_exists, "document should be gone after delete");
    eprintln!("verified: document no longer exists on-chain");

    // --- VERIFY REFUND: delete returns most of the storage deposit, so the balance
    // recovers versus the post-create low. The delete itself also burns a little
    // processing, so the refund is the net credit back into the balance.
    let refund = balance_after_delete.saturating_sub(balance_after_create);
    eprintln!("observed storage refund on delete: {refund} credits");
    assert!(
        balance_after_delete > balance_after_create,
        "delete should refund storage deposit (before={balance_after_create}, after={balance_after_delete})"
    );

    eprintln!(
        "ROUND-TRIP OK: create_cost={create_cost}, refund={refund}, net_spent={}",
        balance_start.saturating_sub(balance_after_delete)
    );
}
