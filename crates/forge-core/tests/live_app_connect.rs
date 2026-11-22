//! LIVE testnet read smoke of App Connect v2's Platform port (`forge_core::app_connect`):
//! the `loginKeyResponse` query is accepted by the App Connect system contract, and identity
//! keys and budgets read back proved. Reads only; nothing is written or spent.
//!
//! Ignored by default. Run explicitly with:
//!
//! ```sh
//! cargo test -p forge-core --test live_app_connect -- --ignored --nocapture
//! ```

use forge_core::app_connect::poll::{self, ResponsePort};
use forge_core::app_connect::verify::IdentityPort;
use forge_core::app_connect::{decode_id, forge};
use forge_core::network::Network;
use forge_core::platform::PlatformClient;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "live testnet read; run with --ignored"]
async fn the_platform_port_reads_testnet() {
    let client = PlatformClient::connect_network(Network::Testnet)
        .await
        .expect("connect");
    assert!(client.refresh_protocol_version().await.expect("protocol") >= forge::MIN_PROTOCOL);

    // Nobody answers a request nobody made: an empty, complete read.
    let page = poll::list_candidates(
        &client,
        &[0xa5; 20],
        None,
        poll::PAGE_SIZE,
        poll::MAX_CANDIDATES,
    )
    .await
    .expect("list answers");
    assert!(page.candidates.is_empty() && !page.truncated);
    let after = [0x10; 32];
    assert!(client
        .list_candidates(&[0xa5; 20], None, Some(&after), 3)
        .await
        .expect("list answers after a cursor")
        .is_empty());
    assert!(client
        .list_candidates(&[0xa5; 20], Some(&after), None, 3)
        .await
        .expect("list one identity's answer")
        .is_empty());

    // The Forge deployer's identity and its keys.
    let forge_ids = client
        .target()
        .require_v2()
        .expect("forge on testnet")
        .clone();
    let owner = decode_id(forge_ids.group_owner.as_deref().expect("group owner")).unwrap();
    let keys = client
        .identity_keys(&owner)
        .await
        .expect("identity read")
        .expect("the deployer exists");
    assert!(!keys.is_empty());
    let ids: Vec<u32> = keys.iter().map(|k| k.id).collect();
    let budgets = client
        .remaining_budgets(&owner, &ids)
        .await
        .expect("budget read");
    println!("deployer keys {ids:?}, budgets {budgets:?}");
    assert!(client
        .identity_keys(&[0x5a; 32])
        .await
        .expect("absent identity read")
        .is_none());
}

/// Wallets have answered other apps' requests on testnet: read one back through the port by
/// its request hash, with and without the identity hint, and check its framing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "live testnet read; run with --ignored"]
async fn reads_a_real_wallet_answer_by_its_request_hash() {
    use forge_core::app_connect::{crypto, APP_CONNECT_CONTRACT_ID, RESPONSE_DOCUMENT_TYPE};
    use forge_core::platform::QueryOrder;

    let client = PlatformClient::connect_network(Network::Testnet)
        .await
        .expect("connect");
    let contract = client
        .fetch_contract(APP_CONNECT_CONTRACT_ID)
        .await
        .expect("the App Connect contract");
    let order = [
        QueryOrder::asc("appEphemeralPubKeyHash"),
        QueryOrder::asc("$ownerId"),
    ];
    let rows = client
        .query_documents(&contract, RESPONSE_DOCUMENT_TYPE, &[], &order, 1, None)
        .await
        .expect("any answer");
    let Some(row) = rows.first() else {
        println!("no wallet answer on testnet yet; nothing to read back");
        return;
    };
    let hash: [u8; 20] = row
        .field_bytes("appEphemeralPubKeyHash")
        .expect("hash")
        .try_into()
        .expect("20 bytes");
    let owner = decode_id(&row.owner_id).expect("owner");

    let page = poll::list_candidates(&client, &hash, None, poll::PAGE_SIZE, poll::MAX_CANDIDATES)
        .await
        .expect("list by hash");
    let answer = page
        .candidates
        .iter()
        .find(|c| c.owner_id == owner)
        .expect("the answer is listed under its hash");
    assert_eq!(answer.wallet_ephemeral_pub_key.len(), 33);
    assert!(crypto::slot_count(answer.encrypted_payload.len()).is_some());
    let hinted = client
        .list_candidates(&hash, Some(&owner), None, poll::PAGE_SIZE)
        .await
        .expect("list by hint");
    assert_eq!(hinted.len(), 1);
    assert_eq!(hinted[0], *answer);
}
