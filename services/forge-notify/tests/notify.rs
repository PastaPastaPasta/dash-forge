//! End to end against local stubs: signed requests through the HTTP API, the double opt-in,
//! preferences, push subscriptions, routing of relay events (watching, mentions, own actions),
//! the addressed and private pollers, one-click unsubscribe, export and delete. Platform is a
//! stub ([`Chain`], [`KeySource`]); mail and push are captured.

use std::collections::BTreeSet;
use std::net::SocketAddr;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, RwLock};

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use secp256k1::{PublicKey, Secp256k1, SecretKey};
use serde_json::{json, Value};
use tokio::sync::watch;
use tower::ServiceExt as _;
use web_push_native::p256::elliptic_curve::sec1::ToEncodedPoint as _;

use forge_core::network::ForgeIds;
use forge_core::platform::{IdentityKeyInfo, KeyBounds};
use forge_notify::api::{self, ApiSettings, App};
use forge_notify::auth::{sign, KeySource, KeysFuture};
use forge_notify::chain::{
    Addressed, Chain, Read, RepoInfo, TargetInfo, KIND_ASSIGN, KIND_REVIEW_REQUEST,
};
use forge_notify::config::Limits;
use forge_notify::crypto::Vault;
use forge_notify::dispatch::Dispatcher;
use forge_notify::index::{Indexer, ReindexQueue};
use forge_notify::limits::{RateLimiter, TrustProxy};
use forge_notify::mail::{CaptureMailer, Mailer};
use forge_notify::push::{CapturePusher, Pusher};
use forge_notify::route::{MentionIndex, Router};
use forge_notify::store::Store;
use forge_relay::payload::{issue_comment_event, issues_event, IssueObj, RepositoryMeta};

const ALICE: &str = "FrNpRnZQPP5gLFAjD7Foz4tZaML5DJ88CqaCvAkYNYjU";
const BOB: &str = "8vF9No9XcZvENMA6NiNQ9KeeYi7sQBGLhWYUd2FVYuaz";
const REPO: &str = "DEp9c8kkjc5LBheVBFScdjWsGhs77BtcYdfNGCHwQEtf";
const PRIVATE: &str = "8KBVQ41HTueY1nuGhpAGNUEy9BQSAgCHV9Z34VUw9ZuP";
const TARGET: &str = "G6D3ejKxgcc4yRSRyuLoPg9RGa7XWPwB9kBzU29hgEQH";
const OP: &str = "notify.test";
const ISSUE: &str = "4Rgqa4QcqiqYNXxvCZbKXFYZv1spbYaugUwuhaJ8ATzV";
const FOREIGN: &str = "BKhXUWPTj4ue2JxSLXwhv8LF4jmYbBD9aCPxjyXgv5Uy";

struct Keys(IdentityKeyInfo);

impl KeySource for Keys {
    fn keys<'a>(&'a self, identity: &'a str) -> KeysFuture<'a> {
        let found = (identity == ALICE).then(|| vec![self.0.clone()]);
        Box::pin(async move { Ok(found) })
    }
}

struct StubChain {
    latest: Mutex<u64>,
}

impl Chain for StubChain {
    fn watched(&self, identity: &str) -> Read<'_, Vec<String>> {
        let v = if identity == ALICE {
            vec![REPO.to_string()]
        } else {
            vec![]
        };
        Box::pin(async move { Ok(v) })
    }
    fn member_repos(&self, identity: &str) -> Read<'_, Vec<String>> {
        let v = if identity == ALICE {
            vec![PRIVATE.to_string()]
        } else {
            vec![]
        };
        Box::pin(async move { Ok(v) })
    }
    fn repo(&self, repo_id: &str) -> Read<'_, Option<RepoInfo>> {
        let r = RepoInfo {
            id: repo_id.to_string(),
            owner: BOB.to_string(),
            name: if repo_id == PRIVATE {
                "secret"
            } else {
                "project"
            }
            .to_string(),
            private: repo_id == PRIVATE,
        };
        Box::pin(async move { Ok(Some(r)) })
    }
    fn addressed(&self, _identity: &str, _since: u64) -> Read<'_, Vec<Addressed>> {
        let ev = |doc_id: &str, kind, target: &str, via_author| Addressed {
            doc_id: doc_id.into(),
            kind,
            repo_id: REPO.into(),
            target_id: target.into(),
            author: BOB.into(),
            created_at: 2_000_000_000_000,
            via_author,
        };
        Box::pin(async move {
            Ok(vec![
                ev("EvReview1", KIND_REVIEW_REQUEST, TARGET, true),
                // Dropped: a review request on an issue asks nothing; a thread of another
                // repository; an assignment that is not a member's `event`.
                ev("EvReview2", KIND_REVIEW_REQUEST, ISSUE, true),
                ev("EvReview3", KIND_REVIEW_REQUEST, FOREIGN, false),
                ev("EvAssign1", KIND_ASSIGN, TARGET, true),
            ])
        })
    }
    fn target(&self, id: &str) -> Read<'_, Option<TargetInfo>> {
        let t = TargetInfo {
            is_pr: id != ISSUE,
            repo_id: if id == FOREIGN { PRIVATE } else { REPO }.into(),
            number: 7,
            title: Some("Fix the parser".into()),
        };
        Box::pin(async move { Ok(Some(t)) })
    }
    fn latest_activity(&self, _repo_id: &str) -> Read<'_, Option<(u64, String)>> {
        let mut l = self.latest.lock().unwrap();
        *l += 1000;
        let v = *l;
        Box::pin(async move { Ok(Some((v, BOB.to_string()))) })
    }
    fn dpns_label(&self, identity: &str) -> Read<'_, Option<String>> {
        let v = (identity == ALICE).then(|| "alice".to_string());
        Box::pin(async move { Ok(v) })
    }
}

struct World {
    app: Arc<App>,
    secret: SecretKey,
    mailer: Arc<CaptureMailer>,
    pusher: Arc<CapturePusher>,
    indexer: Indexer,
    router: Router,
    feed: watch::Receiver<BTreeSet<String>>,
}

fn world() -> World {
    let secret = SecretKey::from_slice(&[0x11; 32]).unwrap();
    let key = IdentityKeyInfo {
        id: 2,
        purpose: "AUTHENTICATION".into(),
        security_level: "HIGH".into(),
        key_type: "ECDSA_SECP256K1".into(),
        public_key: PublicKey::from_secret_key(&Secp256k1::new(), &secret)
            .serialize()
            .to_vec(),
        disabled: false,
        bound_to: Some("contract-group".into()),
        bounds: Some(KeyBounds::ContractGroup { id: "G".into() }),
    };
    let store = Store::memory().unwrap();
    let vault = Arc::new(Vault::new(&[3; 32]));
    let mailer = Arc::new(CaptureMailer::default());
    let pusher = Arc::new(CapturePusher::default());
    let dispatcher = Arc::new(Dispatcher {
        store: store.clone(),
        vault: Arc::clone(&vault),
        mailer: Some(Arc::clone(&mailer) as Arc<dyn Mailer>),
        pusher: Some(Arc::clone(&pusher) as Arc<dyn Pusher>),
        public_url: "https://notify.test".into(),
        web_url: "https://forge.test".into(),
        operator: OP.into(),
        contact: None,
        per_user_daily: 100,
        daily_budget: 1000,
    });
    let app = Arc::new(App {
        store: store.clone(),
        vault,
        keys: Arc::new(Keys(key)),
        dispatcher: Arc::clone(&dispatcher),
        limiter: RateLimiter::new(1000),
        reindex: Arc::new(ReindexQueue::default()),
        ready: Arc::new(AtomicBool::new(true)),
        settings: ApiSettings {
            operator: OP.into(),
            forge: ForgeIds::test_forge(),
            public_url: "https://notify.test".into(),
            allowed_origins: vec!["https://forge.test".into()],
            privacy_url: Some("https://notify.test/privacy".into()),
            contact: None,
            push_hosts: vec!["fcm.googleapis.com".into()],
            insecure_local: false,
            trust_proxy: TrustProxy::None,
            max_subscribers: 10,
            max_repos_per_user: 50,
            digest_hour: 8,
        },
    });
    let (feed_tx, feed) = watch::channel(BTreeSet::new());
    let mentions = Arc::new(RwLock::new(MentionIndex::default()));
    let indexer = Indexer::new(
        store.clone(),
        Arc::new(StubChain {
            latest: Mutex::new(1_000),
        }),
        Arc::clone(&dispatcher),
        feed_tx,
        Arc::clone(&mentions),
        Limits::default(),
        "https://forge.test".into(),
    );
    let router = Router {
        store,
        dispatcher,
        names: None,
        mentions,
    };
    World {
        app,
        secret,
        mailer,
        pusher,
        indexer,
        router,
        feed,
    }
}

fn peer() -> ConnectInfo<SocketAddr> {
    ConnectInfo("192.0.2.10:4000".parse().unwrap())
}

async fn call(w: &World, req: Request<Body>) -> (StatusCode, String) {
    let mut req = req;
    req.extensions_mut().insert(peer());
    let res = api::router(Arc::clone(&w.app)).oneshot(req).await.unwrap();
    let status = res.status();
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    (status, String::from_utf8_lossy(&body).to_string())
}

fn envelope(w: &World, action: &str, payload: &Value, nonce: &str) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let request = json!({
        "v": 1, "service": OP, "action": action, "identity": ALICE, "key": 2,
        "nonce": nonce, "time": now, "payload": payload,
    })
    .to_string();
    json!({"request": request, "signature": sign(&request, &w.secret)}).to_string()
}

async fn signed(w: &World, action: &str, payload: Value) -> (StatusCode, Value) {
    let nonce = URL_SAFE_NO_PAD.encode(rand_bytes());
    let body = envelope(w, action, &payload, &nonce);
    let (s, b) = call(
        w,
        Request::post("/v1/request")
            .header("content-type", "application/json")
            .body(Body::from(body))
            .unwrap(),
    )
    .await;
    (s, serde_json::from_str(&b).unwrap_or(Value::String(b)))
}

fn rand_bytes() -> [u8; 18] {
    use rand::RngCore as _;
    let mut b = [0u8; 18];
    rand::thread_rng().fill_bytes(&mut b);
    b
}

fn meta() -> RepositoryMeta {
    RepositoryMeta {
        repo_id: REPO.into(),
        owner_id: BOB.into(),
        name: "project".into(),
        default_branch: "main".into(),
        web_base_url: "https://forge.test".into(),
    }
}

fn issue(author: &str, body: &str) -> IssueObj {
    IssueObj {
        number: 3,
        document_id: "IssueDoc3".into(),
        author: author.into(),
        title: "Crash on start".into(),
        body: body.into(),
        open: true,
        is_pr: false,
    }
}

fn mails(w: &World) -> Vec<forge_notify::mail::Mail> {
    w.mailer.sent.lock().unwrap().clone()
}

#[tokio::test]
#[allow(clippy::too_many_lines, clippy::many_single_char_names)]
async fn subscribe_confirm_route_unsubscribe_export_delete() {
    let w = world();

    // Info is public; health answers.
    let (s, body) = call(&w, Request::get("/v1/info").body(Body::empty()).unwrap()).await;
    assert_eq!(s, StatusCode::OK);
    let info: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(info["channels"], json!({"email": true, "push": true}));
    assert_eq!(info["operator"], OP);

    // A replayed request is refused.
    let replay = envelope(&w, "account.get", &json!({}), "ReplayNonce000000000");
    for expect in [StatusCode::OK, StatusCode::UNAUTHORIZED] {
        let (s, _) = call(
            &w,
            Request::post("/v1/request")
                .header("content-type", "application/json")
                .body(Body::from(replay.clone()))
                .unwrap(),
        )
        .await;
        assert_eq!(s, expect);
    }

    // Double opt-in: the address is pending until the link's POST.
    let (s, v) = signed(&w, "email.set", json!({"email": "alice@example.org"})).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let confirm = mails(&w).pop().unwrap();
    assert_eq!(confirm.to, "alice@example.org");
    assert!(confirm.unsubscribe.is_none());
    let link = confirm
        .text
        .lines()
        .find(|l| l.starts_with("https://notify.test/v1/verify?token="))
        .unwrap()
        .to_string();
    let token = link.split("token=").nth(1).unwrap().to_string();
    let (_, v) = signed(&w, "account.get", json!({})).await;
    assert_eq!(v["email"]["verified"], false);
    let (s, page) = call(
        &w,
        Request::get(format!("/v1/verify?token={token}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert!(page.contains("Confirm") && page.contains("alice@example.org"));
    // The form posts to the public URL, which may carry a path prefix.
    assert!(
        page.contains("action=\"https://notify.test/v1/verify\""),
        "{page}"
    );
    let (_, v) = signed(&w, "account.get", json!({})).await;
    assert_eq!(v["email"]["verified"], false, "a GET does not confirm");
    let (s, page) = call(
        &w,
        Request::post("/v1/verify")
            .header("content-type", "application/x-www-form-urlencoded")
            .body(Body::from(format!("token={token}")))
            .unwrap(),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert!(page.contains("Email confirmed"));
    let (_, v) = signed(&w, "account.get", json!({})).await;
    assert_eq!(v["email"]["verified"], true);
    assert_eq!(v["email"]["address"], "a•••@example.org");

    // Preferences: unknown fields are refused; private activity on.
    let (s, _) = signed(&w, "prefs.set", json!({"prefs": {"bogus": true}})).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, v) = signed(&w, "prefs.set", json!({"prefs": {"privateActivity": true}})).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["prefs"]["privateActivity"], true);

    // Push: only a known push service.
    let ua = web_push_native::p256::SecretKey::random(&mut rand::rngs::OsRng);
    let p256dh = URL_SAFE_NO_PAD.encode(ua.public_key().to_encoded_point(false).as_bytes());
    let auth = URL_SAFE_NO_PAD.encode([5u8; 16]);
    let (s, _) = signed(
        &w,
        "push.add",
        json!({"endpoint": "https://169.254.169.254/x", "p256dh": p256dh, "auth": auth}),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, v) = signed(&w, "push.add", json!({"endpoint": "https://fcm.googleapis.com/fcm/send/abc", "p256dh": p256dh, "auth": auth, "label": "Firefox"})).await;
    assert_eq!(s, StatusCode::OK, "{v}");

    // The index: alice watches REPO and belongs to PRIVATE; the relay polls REPO only.
    w.indexer.refresh_all().await.unwrap();
    assert_eq!(*w.feed.borrow(), BTreeSet::from([REPO.to_string()]));

    // Bob opens an issue mentioning alice: one mail (mention outranks watching) and one push.
    let before = mails(&w).len();
    let e = issues_event(
        &meta(),
        "IssueDoc3",
        "opened",
        &issue(BOB, "cc @alice please look"),
    );
    w.router.route(REPO, &e).await.unwrap();
    let got = mails(&w);
    assert_eq!(got.len(), before + 1);
    let m = got.last().unwrap();
    assert_eq!(m.to, "alice@example.org");
    assert!(
        m.subject.contains("opened issue #3: Crash on start"),
        "{}",
        m.subject
    );
    assert!(m.text.contains("because you were mentioned"), "{}", m.text);
    assert!(m
        .unsubscribe
        .as_deref()
        .unwrap()
        .starts_with("https://notify.test/u/"));
    assert_eq!(w.pusher.sent.lock().unwrap().len(), 1);
    // The same event again: no second notice.
    w.router.route(REPO, &e).await.unwrap();
    assert_eq!(mails(&w).len(), before + 1);
    // Alice's own comment: nothing.
    let own = issue_comment_event(&meta(), "C1", &issue(BOB, ""), "C1", ALICE, "on it");
    w.router.route(REPO, &own).await.unwrap();
    assert_eq!(mails(&w).len(), before + 1);
    // Bob replies: alice now participates in the thread.
    let bob_answer = issue_comment_event(&meta(), "C2", &issue(BOB, ""), "C2", BOB, "thanks");
    w.router.route(REPO, &bob_answer).await.unwrap();
    assert!(mails(&w)
        .last()
        .unwrap()
        .text
        .contains("you took part in this conversation"));

    // A review request, read from the addressee index (the first poll only sets the cursor).
    w.indexer.poll_addressed().await.unwrap();
    let n = mails(&w).len();
    w.indexer.poll_addressed().await.unwrap();
    let got = mails(&w);
    assert_eq!(got.len(), n + 1);
    assert!(got
        .last()
        .unwrap()
        .subject
        .contains("requested your review on pull request #7: Fix the parser"));

    // Private repo activity: no title, no text.
    w.indexer.poll_private().await.unwrap();
    let n = mails(&w).len();
    w.indexer.poll_private().await.unwrap();
    let got = mails(&w);
    assert_eq!(got.len(), n + 1);
    let p = got.last().unwrap();
    assert!(p
        .subject
        .contains("New activity in a private repository you belong to"));
    assert!(p.subject.contains("/secret]"));

    // One-click unsubscribe (RFC 8058): any POST body, no login.
    let unsub = p.unsubscribe.clone().unwrap();
    let path = unsub.trim_start_matches("https://notify.test");
    let (s, page) = call(&w, Request::get(path).body(Body::empty()).unwrap()).await;
    assert_eq!(s, StatusCode::OK);
    assert!(page.contains(&format!("action=\"{unsub}\"")), "{page}");
    let (s, _) = call(
        &w,
        Request::post(path)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(Body::from("List-Unsubscribe=One-Click"))
            .unwrap(),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let (_, v) = signed(&w, "account.get", json!({})).await;
    assert_eq!(v["email"]["address"], Value::Null);
    let n = mails(&w).len();
    let e2 = issues_event(
        &meta(),
        "IssueDoc4",
        "opened",
        &IssueObj {
            number: 4,
            document_id: "IssueDoc4".into(),
            ..issue(BOB, "@alice again")
        },
    );
    w.router.route(REPO, &e2).await.unwrap();
    assert_eq!(mails(&w).len(), n, "no mail after unsubscribing");
    assert_eq!(w.pusher.sent.lock().unwrap().len(), 5, "push is unaffected");

    // Export, then delete.
    let (_, v) = signed(&w, "data.export", json!({})).await;
    assert_eq!(v["identity"], ALICE);
    assert_eq!(
        v["push"][0]["subscription"]["endpoint"],
        "https://fcm.googleapis.com/fcm/send/abc"
    );
    assert_eq!(v["following"].as_array().unwrap().len(), 2);

    // Metrics are counts only: no identity, no address.
    let (s, body) = call(&w, Request::get("/metrics").body(Body::empty()).unwrap()).await;
    assert_eq!(s, StatusCode::OK);
    assert!(body.contains("forge_notify_subscribers 1\n"), "{body}");
    assert!(
        body.contains("forge_notify_push_subscriptions 1\n"),
        "{body}"
    );
    assert!(!body.contains(ALICE) && !body.contains('@'), "{body}");

    let (s, _) = signed(&w, "data.delete", json!({})).await;
    assert_eq!(s, StatusCode::OK);
    let (_, v) = signed(&w, "account.get", json!({})).await;
    assert_eq!(v["subscribed"], false);
}

#[tokio::test]
async fn re_adding_a_browser_at_the_cap_refreshes_it() {
    let w = world();
    let ua = web_push_native::p256::SecretKey::random(&mut rand::rngs::OsRng);
    let p256dh = URL_SAFE_NO_PAD.encode(ua.public_key().to_encoded_point(false).as_bytes());
    let auth = URL_SAFE_NO_PAD.encode([5u8; 16]);
    let add = |n: u32| json!({"endpoint": format!("https://fcm.googleapis.com/fcm/send/{n}"), "p256dh": p256dh, "auth": auth});
    for n in 0..10 {
        let (s, v) = signed(&w, "push.add", add(n)).await;
        assert_eq!(s, StatusCode::OK, "{v}");
    }
    let (s, v) = signed(&w, "push.add", add(3)).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let (s, _) = signed(&w, "push.add", add(10)).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn cors_allows_only_the_configured_origin_and_pages_forbid_scripts() {
    let w = world();
    let preflight = |origin: &str| {
        Request::builder()
            .method("OPTIONS")
            .uri("/v1/request")
            .header("origin", origin)
            .header("access-control-request-method", "POST")
            .header("access-control-request-headers", "content-type")
            .body(Body::empty())
            .unwrap()
    };
    let mut req = preflight("https://forge.test");
    req.extensions_mut().insert(peer());
    let res = api::router(Arc::clone(&w.app)).oneshot(req).await.unwrap();
    assert_eq!(
        res.headers()["access-control-allow-origin"],
        "https://forge.test"
    );
    let mut req = preflight("https://evil.example");
    req.extensions_mut().insert(peer());
    let res = api::router(Arc::clone(&w.app)).oneshot(req).await.unwrap();
    assert!(res.headers().get("access-control-allow-origin").is_none());

    let mut req = Request::get("/u/not-a-token").body(Body::empty()).unwrap();
    req.extensions_mut().insert(peer());
    let res = api::router(Arc::clone(&w.app)).oneshot(req).await.unwrap();
    assert!(res.headers()["content-security-policy"]
        .to_str()
        .unwrap()
        .starts_with("default-src 'none'"));
    assert_eq!(res.headers()["referrer-policy"], "no-referrer");
}
