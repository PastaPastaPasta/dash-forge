//! Sink config parsing, and each sink's request against a local stub server (HTTP and SMTP).

use std::sync::{Arc, Mutex};

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

use super::*;

fn sink(src: &str) -> Result<SinkSpec> {
    #[derive(Deserialize)]
    struct F {
        sink: Vec<SinkFile>,
    }
    let f: F = toml::from_str(src).map_err(|e| RelayError::Config(e.to_string()))?;
    f.sink.into_iter().next().unwrap().resolve()
}

/// Set an env var for one test (names are unique per test, so parallel tests do not clash).
fn set_env(k: &str, v: &str) {
    std::env::set_var(k, v);
}

#[test]
fn secrets_must_be_references() {
    set_env(
        "FORGE_SINK_T1_URL",
        "https://discord.com/api/webhooks/1/tok",
    );
    let ok = sink("[[sink]]\nname = \"d\"\nkind = \"discord\"\nurl = \"env:FORGE_SINK_T1_URL\"\n")
        .unwrap();
    assert_eq!(ok.kind, SinkKind::Discord);
    let dumped = format!("{ok:?}");
    assert!(!dumped.contains("tok"), "{dumped}");

    let err = sink("[[sink]]\nname = \"d\"\nkind = \"discord\"\nurl = \"https://discord.com/api/webhooks/1/hunter2\"\n")
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("secret reference") && !err.contains("hunter2"),
        "{err}"
    );

    let err =
        sink("[[sink]]\nname = \"d\"\nkind = \"discord\"\nurl = \"env:FORGE_SINK_T1_UNSET_X\"\n")
            .unwrap_err()
            .to_string();
    assert!(err.contains("not set"), "{err}");
}

#[test]
fn a_field_of_another_kind_or_a_typo_is_refused() {
    set_env("FORGE_SINK_T2_URL", "https://hooks.slack.com/services/x");
    let typo = sink("[[sink]]\nname = \"s\"\nkind = \"slack\"\nurl = \"env:FORGE_SINK_T2_URL\"\nevnets = [\"push\"]\n");
    assert!(typo.is_err());
    let wrong = sink("[[sink]]\nname = \"s\"\nkind = \"slack\"\nurl = \"env:FORGE_SINK_T2_URL\"\nroom = \"!a:b\"\n")
        .unwrap_err()
        .to_string();
    assert!(wrong.contains("a slack sink has no room"), "{wrong}");
    let bad_event = sink("[[sink]]\nname = \"s\"\nkind = \"slack\"\nurl = \"env:FORGE_SINK_T2_URL\"\nevents = [\"pushes\"]\n");
    assert!(bad_event.is_err());
    set_env("FORGE_SINK_T2_HTTP", "http://hooks.example/x");
    let plain_http =
        sink("[[sink]]\nname = \"s\"\nkind = \"slack\"\nurl = \"env:FORGE_SINK_T2_HTTP\"\n")
            .unwrap_err()
            .to_string();
    assert!(plain_http.contains("must be https"), "{plain_http}");
}

#[test]
fn smtp_and_matrix_and_ntfy_blocks() {
    set_env("FORGE_SINK_T3_PW", "pw-secret-value");
    let s = sink(
        "[[sink]]\nname = \"mail\"\nkind = \"smtp\"\nhost = \"smtp.example.com\"\nusername = \"u\"\npassword = \"env:FORGE_SINK_T3_PW\"\nfrom = \"Forge <forge@example.com>\"\nto = [\"a@example.com\", \"b@example.com\"]\n",
    )
    .unwrap();
    let SinkTarget::Smtp(t) = &s.target else {
        panic!()
    };
    assert_eq!((t.port, t.tls, t.to.len()), (587, SmtpTls::Starttls, 2));
    assert!(!format!("{s:?}").contains("pw-secret"));
    let clear = sink(
        "[[sink]]\nname = \"mail\"\nkind = \"smtp\"\nhost = \"smtp.example.com\"\ntls = \"none\"\nusername = \"u\"\npassword = \"env:FORGE_SINK_T3_PW\"\nfrom = \"f@example.com\"\nto = [\"a@example.com\"]\n",
    );
    assert!(clear.unwrap_err().to_string().contains("in the clear"));
    let bad_to = sink(
        "[[sink]]\nname = \"mail\"\nkind = \"smtp\"\nhost = \"h\"\nfrom = \"f@example.com\"\nto = [\"not an address\"]\n",
    );
    assert!(bad_to.is_err());

    set_env("FORGE_SINK_T3_TOK", "syt_token");
    let alias = sink(
        "[[sink]]\nname = \"m\"\nkind = \"matrix\"\nhomeserver = \"https://matrix.org\"\nroom = \"#forge:matrix.org\"\naccess-token = \"env:FORGE_SINK_T3_TOK\"\n",
    );
    assert!(alias.unwrap_err().to_string().contains("room id"));
    // Room version 12 ids have no server part.
    let v12 = sink(
        "[[sink]]\nname = \"m\"\nkind = \"matrix\"\nhomeserver = \"https://matrix.org\"\nroom = \"!31hneApxJ_1o-63DmFrpeqnkFfWppnzWso1JvH3ogLM\"\naccess-token = \"env:FORGE_SINK_T3_TOK\"\n",
    );
    assert!(v12.is_ok());

    let n =
        sink("[[sink]]\nname = \"n\"\nkind = \"ntfy\"\ntopic = \"forge-alerts\"\npriority = 4\n")
            .unwrap();
    let SinkTarget::Ntfy { server, .. } = &n.target else {
        panic!()
    };
    assert_eq!(server.as_str(), "https://ntfy.sh/");
    assert!(sink("[[sink]]\nname = \"n\"\nkind = \"ntfy\"\ntopic = \"bad topic!\"\n").is_err());
}

#[test]
fn watch_needs_something_to_watch() {
    let parse = |s: &str| -> Result<WatchConfig> {
        let f: WatchFile = toml::from_str(s).map_err(|e| RelayError::Config(e.to_string()))?;
        f.resolve()
    };
    assert!(parse("").is_err());
    assert!(parse("repos = [\"a/b\"]\nevents = [\"nope\"]\n").is_err());
    let w = parse("identity = \"alice\"\n").unwrap();
    assert_eq!(w.identity.as_deref(), Some("alice"));
}

/// One request a stub saw.
#[derive(Debug, Clone)]
struct Seen {
    method: String,
    path: String,
    auth: Option<String>,
    body: serde_json::Value,
}

/// A stub HTTP server answering each request with the next of `answers` (status, extra
/// headers), then 200s.
async fn http_stub(answers: Vec<(u16, &'static str)>) -> (String, Arc<Mutex<Vec<Seen>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let answers = Arc::new(Mutex::new(answers.into_iter().collect::<VecDeque<_>>()));
    let s = Arc::clone(&seen);
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let (s, answers) = (Arc::clone(&s), Arc::clone(&answers));
            tokio::spawn(async move {
                let mut r = BufReader::new(stream);
                loop {
                    let mut first = String::new();
                    if r.read_line(&mut first).await.unwrap_or(0) == 0 {
                        return;
                    }
                    let mut parts = first.split_whitespace();
                    let method = parts.next().unwrap_or("").to_string();
                    let path = parts.next().unwrap_or("").to_string();
                    let (mut len, mut auth) = (0usize, None);
                    loop {
                        let mut line = String::new();
                        r.read_line(&mut line).await.unwrap();
                        let line = line.trim_end();
                        if line.is_empty() {
                            break;
                        }
                        let (k, v) = line.split_once(':').unwrap();
                        match k.to_ascii_lowercase().as_str() {
                            "content-length" => len = v.trim().parse().unwrap(),
                            "authorization" => auth = Some(v.trim().to_string()),
                            _ => {}
                        }
                    }
                    let mut body = vec![0; len];
                    r.read_exact(&mut body).await.unwrap();
                    s.lock().unwrap().push(Seen {
                        method,
                        path,
                        auth,
                        body: serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null),
                    });
                    let (status, extra) = answers.lock().unwrap().pop_front().unwrap_or((200, ""));
                    let reply =
                        format!("HTTP/1.1 {status} X\r\ncontent-length: 2\r\n{extra}\r\n{{}}");
                    if r.get_mut().write_all(reply.as_bytes()).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    (format!("http://{addr}"), seen)
}

fn notice() -> Notice {
    Notice {
        repo_id: "REPO".into(),
        repo: "alice/x".into(),
        event: "pull_request",
        action: "opened".into(),
        actor: "A".into(),
        title: "alice opened pull request #1: Hello".into(),
        excerpt: "body".into(),
        url: "https://forge.example/repo/pull/?owner=O&name=x&number=1".into(),
        thread: Some((true, 1)),
        id: "pull_request:DOC".into(),
    }
}

fn spec(name: &str, target: SinkTarget) -> SinkSpec {
    SinkSpec {
        name: name.into(),
        kind: SinkKind::Slack,
        repos: vec![],
        events: vec![],
        max_per_minute: 60,
        target,
    }
}

fn transport() -> send::Transport {
    send::Transport {
        http: send::http_client(),
        smtp: None,
    }
}

#[tokio::test]
async fn each_http_sink_sends_its_shape() {
    let (base, seen) = http_stub(vec![]).await;
    let t = transport();
    let discord = spec(
        "d",
        SinkTarget::Discord {
            url: Secret::new(format!("{base}/api/webhooks/1/tok")),
        },
    );
    assert!(deliver(&discord, &t, &notice()).await);
    let slack = spec(
        "s",
        SinkTarget::Slack {
            url: Secret::new(format!("{base}/services/x")),
        },
    );
    assert!(deliver(&slack, &t, &notice()).await);
    let matrix = spec(
        "m",
        SinkTarget::Matrix {
            homeserver: url::Url::parse(&base).unwrap(),
            room: "!room:example.org".into(),
            token: Secret::new("syt_tok".to_string()),
        },
    );
    assert!(deliver(&matrix, &t, &notice()).await);
    let ntfy = spec(
        "n",
        SinkTarget::Ntfy {
            server: url::Url::parse(&base).unwrap(),
            topic: Secret::new("forge-t".to_string()),
            token: Some(Secret::new("tk_x".to_string())),
            priority: None,
        },
    );
    assert!(deliver(&ntfy, &t, &notice()).await);

    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 4, "{seen:?}");
    assert_eq!(
        (seen[0].method.as_str(), seen[0].path.as_str()),
        ("POST", "/api/webhooks/1/tok?wait=true")
    );
    assert_eq!(
        seen[0].body["allowed_mentions"]["parse"],
        serde_json::json!([])
    );
    assert_eq!(seen[1].body["unfurl_links"], false);
    assert_eq!(seen[2].method, "PUT");
    assert!(
        seen[2]
            .path
            .starts_with("/_matrix/client/v3/rooms/!room:example.org/send/m.room.message/"),
        "{}",
        seen[2].path
    );
    assert_eq!(seen[2].auth.as_deref(), Some("Bearer syt_tok"));
    assert_eq!(seen[3].body["topic"], "forge-t");
    assert_eq!(seen[3].auth.as_deref(), Some("Bearer tk_x"));
}

#[tokio::test]
async fn a_429_is_retried_and_a_403_is_not() {
    let (base, seen) = http_stub(vec![(429, "retry-after: 0\r\n"), (200, "")]).await;
    let slack = spec(
        "s",
        SinkTarget::Slack {
            url: Secret::new(format!("{base}/a")),
        },
    );
    assert!(deliver(&slack, &transport(), &notice()).await);
    assert_eq!(seen.lock().unwrap().len(), 2);

    let (base, seen) = http_stub(vec![(403, "")]).await;
    let slack = spec(
        "s",
        SinkTarget::Slack {
            url: Secret::new(format!("{base}/a")),
        },
    );
    assert!(!deliver(&slack, &transport(), &notice()).await);
    assert_eq!(seen.lock().unwrap().len(), 1, "a 403 is permanent");
}

/// A minimal SMTP server: accepts one message and returns its DATA.
async fn smtp_stub() -> (u16, tokio::sync::oneshot::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut r = BufReader::new(stream);
        r.get_mut().write_all(b"220 stub ESMTP\r\n").await.unwrap();
        let mut data = String::new();
        let mut in_data = false;
        let mut tx = Some(tx);
        loop {
            let mut line = String::new();
            if r.read_line(&mut line).await.unwrap_or(0) == 0 {
                return;
            }
            if in_data {
                if line == ".\r\n" {
                    in_data = false;
                    if let Some(tx) = tx.take() {
                        let _ = tx.send(std::mem::take(&mut data));
                    }
                    r.get_mut().write_all(b"250 queued\r\n").await.unwrap();
                } else {
                    data.push_str(&line);
                }
                continue;
            }
            let cmd = line.to_ascii_uppercase();
            let reply: &[u8] = if cmd.starts_with("EHLO") {
                b"250-stub\r\n250 8BITMIME\r\n"
            } else if cmd.starts_with("DATA") {
                in_data = true;
                b"354 go\r\n"
            } else if cmd.starts_with("QUIT") {
                let _ = r.get_mut().write_all(b"221 bye\r\n").await;
                return;
            } else {
                b"250 ok\r\n"
            };
            r.get_mut().write_all(reply).await.unwrap();
        }
    });
    (port, rx)
}

#[tokio::test]
async fn smtp_sends_a_plain_text_notice() {
    let (port, rx) = smtp_stub().await;
    let target = SmtpTarget {
        host: "127.0.0.1".into(),
        port,
        tls: SmtpTls::None,
        credentials: None,
        from: "Forge <forge@example.com>".parse().unwrap(),
        to: vec!["dev@example.com".parse().unwrap()],
    };
    let t = send::Transport {
        http: send::http_client(),
        smtp: Some(send::smtp_transport(&target).unwrap()),
    };
    let s = SinkSpec {
        kind: SinkKind::Smtp,
        ..spec("mail", SinkTarget::Smtp(target))
    };
    assert!(deliver(&s, &t, &notice()).await);
    let data = rx.await.unwrap();
    assert!(
        data.contains("Subject: [alice/x] alice opened pull request #1: Hello"),
        "{data}"
    );
    assert!(data.contains("Auto-Submitted: auto-generated"), "{data}");
    assert!(data.contains("To: dev@example.com"), "{data}");
}

#[test]
fn the_hub_filters_by_repo_and_event() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let (base, seen) = http_stub(vec![]).await;
        let mut s = spec(
            "s",
            SinkTarget::Slack {
                url: Secret::new(format!("{base}/a")),
            },
        );
        s.events = vec!["issues".into()];
        let hub = SinkHub::start(vec![(s, BTreeSet::from(["R1".to_string()]))], None).unwrap();
        let meta = crate::payload::RepositoryMeta {
            repo_id: "R1".into(),
            owner_id: "O".into(),
            name: "x".into(),
            default_branch: "main".into(),
            web_base_url: "https://forge.example".into(),
        };
        let push = crate::payload::push_event(
            &meta,
            "D1",
            "refs/heads/main",
            "",
            &"aa".repeat(20),
            false,
            "A",
        );
        let issue = crate::payload::IssueObj {
            number: 1,
            document_id: "I".into(),
            author: "A".into(),
            title: "T".into(),
            body: String::new(),
            open: true,
            is_pr: false,
        };
        let opened = crate::payload::issues_event(&meta, "I", "opened", &issue);
        hub.accept("R1", &push); // not an event it wants
        hub.accept("R2", &opened); // not a repo it wants
        hub.accept("R1", &opened);
        for _ in 0..50 {
            if !seen.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert!(seen[0].body["text"]
            .as_str()
            .unwrap()
            .contains("opened issue #1"));
    });
}
