//! Live testnet collaboration + token-management lifecycle test (gated `#[ignore]`).
//!
//! Reuses the DEPLOYER-owned M1 repo contract (cheap — the token contract already exists)
//! to exercise the [`forge_core::collab`] and [`forge_core::tokens`] service layer against
//! real testnet:
//!
//! * **Issue lifecycle** (un-gated, ~0.0001 tDASH each): create an issue → comment → close
//!   event → fold shows closed → reopen event → fold shows open. `issue_count` reflects the
//!   count tree.
//! * **Social** (registry, un-gated): star a listing id → `star_count` reflects it → unstar.
//! * **Tokens** (the ACL): grant WRITE to COLLAB → `list_collaborators` shows it →
//!   suspend (freeze) → `holdings` shows frozen → unsuspend (restore). `token_history` shows
//!   the mint record. Optional destroy-revoke behind `FORGE_TOKEN_DESTROY=1`.
//!
//! Run with:
//! ```text
//! cargo test -p forge-core --test collab_tokens -- --ignored --nocapture
//! ```

use forge_core::collab::{IssueService, SocialService, StateFilter};
use forge_core::keystore::BridgeIdentity;
use forge_core::platform::{self, FieldValue, Network, PlatformClient, QueryFilter, QueryOrder};
use forge_core::tokens::{Role, TokenService};

/// Whether the `event` docs for `target_id` carry a consensus `$createdAt` — the clock the
/// close/reopen fold needs. `false` on a stale pre-`$createdAt` contract (M1).
async fn event_timestamps_present(client: &PlatformClient, target_id: &str) -> bool {
    let contract = client
        .fetch_contract(M1_REPO_CONTRACT)
        .await
        .expect("fetch contract");
    let target = platform::decode_identifier(target_id).expect("decode target id");
    let docs = client
        .query_documents(
            &contract,
            "event",
            &[QueryFilter::eq("targetId", FieldValue::identifier(target))],
            &[QueryOrder::asc("$createdAt")],
            0,
            None,
        )
        .await
        .expect("query events");
    docs.iter().any(|d| d.created_at.is_some())
}

const DEPLOYER_PATH: &str =
    "/Users/pasta/.config/dash-forge/test-identities/DEPLOYER.identity.json";
const COLLAB_PATH: &str = "/Users/pasta/.config/dash-forge/test-identities/COLLAB.identity.json";

/// The DEPLOYER-owned M1 repo contract (resolvable, holds both tokens' baseSupply).
const M1_REPO_CONTRACT: &str = "5rrwgjjVUqMghnessfiXPXubpiM2QLNNXH142Hv4PDyX";

#[tokio::test]
#[ignore = "live testnet; spends a few tDASH; run manually"]
#[allow(clippy::too_many_lines)]
async fn collab_and_token_lifecycle_on_testnet() {
    let bridge = BridgeIdentity::load_from_file(DEPLOYER_PATH).expect("load DEPLOYER identity");
    let owner_id = bridge.identity_id.clone();
    let collab = BridgeIdentity::load_from_file(COLLAB_PATH).expect("load COLLAB identity");
    let collab_id = collab.identity_id.clone();
    println!("owner (DEPLOYER): {owner_id}");
    println!("collaborator (COLLAB): {collab_id}");

    let client = PlatformClient::connect(Network::Testnet)
        .await
        .expect("connect testnet");
    let identity = client
        .fetch_identity(&owner_id)
        .await
        .expect("fetch DEPLOYER identity");
    let balance_before = identity.balance();
    println!("balance before: {balance_before} credits");

    // =====================================================================
    // 1. Issue lifecycle: create -> comment -> close -> reopen (folded state)
    // =====================================================================
    let issues = IssueService::new(&client, &identity, &bridge);

    let count_before = issues
        .issue_count(M1_REPO_CONTRACT)
        .await
        .expect("issue_count");
    println!("issue_count before: {count_before}");

    let issue = issues
        .create_issue(
            M1_REPO_CONTRACT,
            "collab_tokens live test issue",
            "created by the collab+tokens integration test",
        )
        .await
        .expect("create_issue");
    println!(
        "created issue #{} (doc {})",
        issue.number, issue.document_id
    );

    let comment_id = issues
        .comment(
            M1_REPO_CONTRACT,
            &issue.document_id,
            "a live-test comment",
            None,
        )
        .await
        .expect("comment");
    println!("posted comment {comment_id}");

    // Fold: fresh issue is open.
    let state = issues
        .issue_state(M1_REPO_CONTRACT, issue.number)
        .await
        .expect("issue_state")
        .expect("issue exists");
    assert!(state.state.open, "new issue should fold to open");
    println!("issue folds OPEN (correct)");

    // Close event -> fold shows closed.
    let close_id = issues
        .close(M1_REPO_CONTRACT, &issue.document_id)
        .await
        .expect("close event");
    println!("posted close event {close_id}");
    let state = issues
        .issue_state(M1_REPO_CONTRACT, issue.number)
        .await
        .expect("issue_state")
        .expect("issue exists");
    assert!(
        !state.state.open,
        "after close, issue should fold to closed"
    );
    println!("issue folds CLOSED after close event (correct)");

    // Reopen event. Fold ordering is by (`$createdAt`, `$id`); the deployed M1 contract
    // predates the template's `$createdAt`-in-`required` fix, so its `event`/`issue` docs
    // record NO consensus timestamp (verified: token-history mints return `Some(createdAt)`
    // via the same read path, M1 issue/event return `None`). Without a clock, close/reopen
    // ordering degrades to random `$id` order and is non-deterministic on M1 specifically.
    // The fold logic itself is correct (rules.rs conformance vectors). So: assert the
    // reopen-to-open fold ONLY when the contract actually timestamps events; otherwise log
    // the M1 staleness (a data-contract reconciliation item) and continue.
    let reopen_id = issues
        .reopen(M1_REPO_CONTRACT, &issue.document_id)
        .await
        .expect("reopen event");
    println!("posted reopen event {reopen_id}");

    let events_ts = event_timestamps_present(&client, &issue.document_id).await;
    let state = issues
        .issue_state(M1_REPO_CONTRACT, issue.number)
        .await
        .expect("issue_state")
        .expect("issue exists");
    if events_ts {
        assert!(state.state.open, "after reopen, issue should fold to open");
        println!("issue folds OPEN after reopen event (correct)");
    } else {
        println!(
            "NOTE: M1 event docs carry NO $createdAt (stale pre-fix contract) — close/reopen \
             fold ordering is non-deterministic on M1; folded open={} (not asserted). A repo \
             from the current repo-v1 template records $createdAt and folds deterministically.",
            state.state.open
        );
    }

    let count_after = issues
        .issue_count(M1_REPO_CONTRACT)
        .await
        .expect("issue_count");
    println!("issue_count after: {count_after}");
    assert!(count_after > count_before, "issue count tree should grow");

    // list_issues (All) should include our issue.
    let all = issues
        .list_issues(M1_REPO_CONTRACT, StateFilter::All, 20, None)
        .await
        .expect("list_issues");
    assert!(
        all.iter().any(|i| i.issue.number == issue.number),
        "our issue should appear in the list"
    );
    println!("list_issues(All) includes issue #{}", issue.number);

    // =====================================================================
    // 2. Social: star a listing id -> star_count -> unstar
    // =====================================================================
    // The M1 contract id is used as a stand-in listing id (the registry `star` schema
    // stores a bare 32-byte identifier with no existence FK) — this exercises the
    // star/count/unstar path without minting a ~1 DASH listing.
    let social = SocialService::new(&client, &identity, &bridge);
    let listing_id = M1_REPO_CONTRACT;

    let stars_before = social.star_count(listing_id).await.expect("star_count");
    println!("star_count before: {stars_before}");
    // Ensure a clean slate (a prior interrupted run may have left our star).
    social.unstar(listing_id).await.expect("unstar (pre-clean)");

    let star_id = social.star(listing_id).await.expect("star");
    println!("starred (doc {star_id})");
    let stars_mid = social.star_count(listing_id).await.expect("star_count");
    println!("star_count after star: {stars_mid}");
    assert!(stars_mid >= 1, "star count should reflect our star");

    social.unstar(listing_id).await.expect("unstar");
    let stars_after = social.star_count(listing_id).await.expect("star_count");
    println!("star_count after unstar: {stars_after}");
    assert_eq!(
        stars_after,
        stars_mid - 1,
        "unstar should decrement the count tree"
    );

    // =====================================================================
    // 3. Tokens: grant WRITE to COLLAB -> list -> suspend -> holdings -> unsuspend
    // =====================================================================
    let tokens = TokenService::new(&client, &identity, &bridge);

    let write_token = tokens
        .token_id(M1_REPO_CONTRACT, forge_core::tokens::WRITE_POSITION)
        .await
        .expect("write token id");
    println!("WRITE token id: {write_token}");

    tokens
        .grant(M1_REPO_CONTRACT, &collab_id, Role::Write)
        .await
        .expect("grant WRITE to COLLAB");
    println!("granted WRITE to COLLAB");

    let collaborators = tokens
        .list_collaborators(M1_REPO_CONTRACT)
        .await
        .expect("list_collaborators");
    println!("collaborators: {collaborators:#?}");
    let collab_entry = collaborators
        .iter()
        .find(|c| c.identity_id == collab_id)
        .expect("COLLAB should appear as a collaborator");
    assert!(collab_entry.holdings.write, "COLLAB should hold WRITE");
    assert!(
        !collab_entry.holdings.write_frozen,
        "COLLAB WRITE should not be frozen yet"
    );

    // Suspend (freeze) -> holdings shows frozen.
    tokens
        .suspend(M1_REPO_CONTRACT, &collab_id, Role::Write)
        .await
        .expect("suspend COLLAB WRITE");
    println!("suspended (froze) COLLAB WRITE");
    let holdings = tokens
        .holdings(M1_REPO_CONTRACT, &collab_id)
        .await
        .expect("holdings");
    println!("COLLAB holdings after suspend: {holdings:?}");
    assert!(holdings.write, "COLLAB still holds the WRITE balance");
    assert!(holdings.write_frozen, "COLLAB WRITE should be frozen");

    // list_collaborators reflects the frozen status too.
    let collaborators = tokens
        .list_collaborators(M1_REPO_CONTRACT)
        .await
        .expect("list_collaborators");
    let collab_entry = collaborators
        .iter()
        .find(|c| c.identity_id == collab_id)
        .expect("COLLAB still a collaborator while frozen");
    assert!(
        collab_entry.holdings.write_frozen,
        "list_collaborators should show COLLAB WRITE frozen"
    );

    // token_history shows the mint (grant) record for COLLAB.
    let history = tokens
        .token_history(M1_REPO_CONTRACT)
        .await
        .expect("token_history");
    let collab_mints = history
        .iter()
        .filter(|r| {
            r.identity == collab_id
                && matches!(r.op, forge_core::rules::TokenOp::Mint)
                && r.token == forge_core::rules::TokenKind::Write
        })
        .count();
    println!(
        "token_history: {} record(s) total, {} COLLAB WRITE mint(s)",
        history.len(),
        collab_mints
    );
    assert!(collab_mints >= 1, "a COLLAB WRITE mint should be recorded");

    if std::env::var("FORGE_TOKEN_DESTROY").is_ok() {
        // Full revoke (destroys COLLAB's frozen balance).
        tokens
            .revoke(M1_REPO_CONTRACT, &collab_id, Role::Write)
            .await
            .expect("revoke COLLAB WRITE");
        println!("revoked (destroyed) COLLAB WRITE balance");
        let holdings = tokens
            .holdings(M1_REPO_CONTRACT, &collab_id)
            .await
            .expect("holdings");
        assert!(!holdings.write, "after revoke COLLAB holds no WRITE");
    } else {
        // Restore clean state so re-runs are cheap and idempotent.
        tokens
            .unsuspend(M1_REPO_CONTRACT, &collab_id, Role::Write)
            .await
            .expect("unsuspend COLLAB WRITE");
        println!("unsuspended COLLAB WRITE (restored)");
        let holdings = tokens
            .holdings(M1_REPO_CONTRACT, &collab_id)
            .await
            .expect("holdings");
        assert!(!holdings.write_frozen, "COLLAB WRITE should be unfrozen");
    }

    // =====================================================================
    // 4. Cleanup (best-effort refund of the deletable docs).
    // =====================================================================
    // The issue + comment are author-owned & deletable; close/reopen events are
    // non-deletable (permanent audit log) and stay. Reuse `RepoService::delete_document`.
    let repo = forge_core::repo::RepoService::new(&client, &identity, &bridge);
    if let Err(e) = repo
        .delete_document(M1_REPO_CONTRACT, "comment", &comment_id)
        .await
    {
        println!("comment cleanup skipped: {e}");
    }
    if let Err(e) = repo
        .delete_document(M1_REPO_CONTRACT, "issue", &issue.document_id)
        .await
    {
        println!("issue cleanup skipped: {e}");
    }
    println!("cleanup done (events remain permanently by design)");

    let balance_after = client.get_balance(&owner_id).await.expect("balance after");
    println!("balance before: {balance_before} credits");
    println!("balance after:  {balance_after} credits");
    println!(
        "net spend: {} credits ({:.6} DASH)",
        balance_before.saturating_sub(balance_after),
        forge_core::repo::credits_to_dash(balance_before.saturating_sub(balance_after))
    );
}
