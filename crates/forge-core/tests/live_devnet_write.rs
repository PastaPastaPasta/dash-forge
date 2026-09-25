//! LIVE devnet write test: the native write path on a protocol-14 network.
//!
//! Ignored by default. Run explicitly with:
//!
//! ```sh
//! cargo test -p forge-core --test live_devnet_write -- --ignored --nocapture
//! ```
//!
//! Protocol 14 changed how a new document's id is derived: it now commits to the
//! identity-contract nonce of the create transition as well as the entropy. `WriteEngine`
//! reports the id before broadcast (the resumable-push journal is keyed on it), so on a
//! protocol-14 network a stale derivation would name a document that never exists. This
//! creates a `profile` in the devnet's forge-collab contract, checks the reported id is the one
//! that landed, re-broadcasts the same signed bytes (must be `AlreadyExists`), and deletes it.
//!
//! `profile` is a stored document type. The `indexOnly` types (`star`, `follow`) need a
//! different delete on protocol 14 (it carries the document's values, not just its id), which
//! `WriteEngine::prepare_delete` does not build yet.
//!
//! Network: `DASH_FORGE_DEVNET` (default `moutai`), resolved from its deployment file.
//! Identity: `DASH_FORGE_TEST_IDENTITY`, else the devnet DEPLOYER fixture.

use std::collections::BTreeMap;

use forge_core::keystore::BridgeIdentity;
use forge_core::network::NetworkSettings;
use forge_core::platform::{
    decode_identifier, BroadcastOutcome, FieldValue, PlatformClient, QueryFilter, QueryOrder,
    WriteEngine,
};

const DOC_TYPE: &str = "profile";

fn default_identity() -> String {
    let home = std::env::var("HOME").expect("HOME");
    format!("{home}/.config/dash-forge/test-identities/devnet-moutai/DEPLOYER.identity.json")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "live devnet write; run with --ignored"]
async fn protocol_14_create_reports_the_landed_id_and_is_idempotent() {
    let devnet = std::env::var("DASH_FORGE_DEVNET").unwrap_or_else(|_| "moutai".to_string());
    let target = NetworkSettings {
        network: Some("devnet".into()),
        devnet_name: Some(devnet),
        ..Default::default()
    }
    .resolve()
    .expect("resolve devnet");
    let ids = target.v2.clone().expect("the devnet records forge-v2 ids");

    let identity_file =
        std::env::var("DASH_FORGE_TEST_IDENTITY").unwrap_or_else(|_| default_identity());
    let bridge = BridgeIdentity::load_from_file(&identity_file).expect("load identity");

    let client = PlatformClient::connect(target).await.expect("connect");
    let contract = client
        .fetch_contract(&ids.collab)
        .await
        .expect("fetch forge-collab");
    let identity = client
        .fetch_identity(&bridge.identity_id)
        .await
        .expect("fetch identity");
    let protocol = client.protocol_version();
    eprintln!("protocol version {protocol}");
    assert!(
        protocol >= 14,
        "expected a protocol-14 devnet, got {protocol}"
    );

    let key = bridge.doc_op_key().expect("a HIGH/CRITICAL auth key");
    let engine = WriteEngine::new(&client, &identity, key).expect("write engine");

    // A profile is unique per owner: clear one an interrupted run left behind.
    let leftovers = client
        .query_all_documents(
            &contract,
            DOC_TYPE,
            &[QueryFilter::eq(
                "$ownerId",
                FieldValue::identifier(decode_identifier(&bridge.identity_id).expect("owner id")),
            )],
            &[QueryOrder::asc("$ownerId")],
        )
        .await
        .expect("list own profiles");
    for doc in leftovers {
        eprintln!("deleting leftover profile {}", doc.id);
        engine
            .delete_document(&contract, DOC_TYPE, &doc.id)
            .await
            .expect("delete leftover profile");
    }

    let mut props = BTreeMap::new();
    props.insert(
        "displayName".to_string(),
        FieldValue::text("sdk-4.2 devnet write check"),
    );
    let prepared = engine
        .prepare_create(&contract, DOC_TYPE, props)
        .await
        .expect("prepare profile");
    let doc_id = prepared.document_id().to_string();
    eprintln!("prepared profile {doc_id}");

    let outcome = engine.execute(&prepared).await.expect("create profile");
    assert_eq!(outcome, BroadcastOutcome::Applied);
    assert!(
        client
            .document_exists(&contract, DOC_TYPE, &doc_id)
            .await
            .expect("read back"),
        "the id reported before broadcast must be the id that landed"
    );

    let again = engine.execute(&prepared).await.expect("re-broadcast");
    assert_eq!(again, BroadcastOutcome::AlreadyExists);

    engine
        .delete_document(&contract, DOC_TYPE, &doc_id)
        .await
        .expect("delete profile");
    assert!(!client
        .document_exists(&contract, DOC_TYPE, &doc_id)
        .await
        .expect("read back after delete"));
    eprintln!("devnet write OK: {doc_id}");
}
