//! Entirely local HTTP fixtures: never contact kubo or a public gateway.
use super::*;
use axum::body::Bytes;
use futures::StreamExt as _;
use tokio::sync::{mpsc, Notify};

struct Recorded {
    method: Method,
    uri: String,
    headers: HeaderMap,
    bytes: Vec<u8>,
}
#[derive(Clone)]
struct Upstream {
    records: mpsc::UnboundedSender<Recorded>,
    first_chunk: Arc<Notify>,
    response_release: Arc<Notify>,
}

async fn stub(State(state): State<Upstream>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let mut stream = body.into_data_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.unwrap();
        bytes.extend_from_slice(&chunk);
        state.first_chunk.notify_one();
    }
    let path = parts.uri.path().to_string();
    state
        .records
        .send(Recorded {
            method: parts.method,
            uri: parts.uri.to_string(),
            headers: parts.headers,
            bytes,
        })
        .unwrap();
    if path == "/ipfs/stream" {
        let stream =
            futures::stream::unfold((0, state.response_release), |(part, release)| async move {
                if part == 1 {
                    release.notified().await;
                }
                match part {
                    0 | 1 => Some((
                        Ok::<_, std::io::Error>(Bytes::from_static(b"streamed")),
                        (part + 1, release),
                    )),
                    _ => None,
                }
            });
        return Response::new(Body::from_stream(stream));
    }
    let value = match path.as_str() {
        "/api/v0/id" => json!({"ID":"test-peer"}),
        "/api/v0/version" => json!({"Version":"0.43.1"}),
        _ => json!({"ok":true}),
    };
    let mut response = Json(value).into_response();
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    response.headers_mut().insert(
        "access-control-allow-credentials",
        HeaderValue::from_static("true"),
    );
    response
        .headers_mut()
        .insert(header::ETAG, HeaderValue::from_static("\"stub\""));
    response
}

struct Harness {
    node: Node,
    state: Arc<Proxy>,
    client: reqwest::Client,
    records: mpsc::UnboundedReceiver<Recorded>,
    first_chunk: Arc<Notify>,
    response_release: Arc<Notify>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
    _temp: tempfile::TempDir,
}

impl Harness {
    async fn new() -> Self {
        let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let gateway = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let temp = tempfile::tempdir().unwrap();
        let node = Node {
            dir: temp.path().into(),
            config: super::super::config::NodeConfig {
                api_port: api.local_addr().unwrap().port(),
                gateway_port: gateway.local_addr().unwrap().port(),
                internal_api_port: upstream.local_addr().unwrap().port(),
                internal_gateway_port: upstream.local_addr().unwrap().port(),
                ..Default::default()
            },
        };
        let tokens = Tokens::load_or_create(&node, false).unwrap();
        let state = Proxy::new(node.clone(), tokens).unwrap();
        let (records_tx, records_rx) = mpsc::unbounded_channel();
        let first_chunk = Arc::new(Notify::new());
        let response_release = Arc::new(Notify::new());
        let app = Router::new().fallback(stub).with_state(Upstream {
            records: records_tx,
            first_chunk: first_chunk.clone(),
            response_release: response_release.clone(),
        });
        let mut tasks = vec![tokio::spawn(async move {
            axum::serve(upstream, app).await.unwrap();
        })];
        let app = rpc_router(state.clone());
        tasks.push(tokio::spawn(async move {
            axum::serve(api, app).await.unwrap();
        }));
        let app = gateway_router(state.clone());
        tasks.push(tokio::spawn(async move {
            axum::serve(gateway, app).await.unwrap();
        }));
        Self {
            node,
            state,
            client: reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap(),
            records: records_rx,
            first_chunk,
            response_release,
            tasks,
            _temp: temp,
        }
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

const ORIGIN: &str = "https://forge.dashhq.org";

#[tokio::test]
async fn rpc_boundary_table_and_preflight_headers() {
    let mut h = Harness::new().await;
    let host = format!("127.0.0.1:{}", h.node.config.api_port);
    // host, origin, method, path, status
    for (host_value, origin, method, path, expected) in [
        ("evil.test", Some(ORIGIN), Method::POST, "/api/v0/id", 421),
        ("127.0.0.1:1", None, Method::POST, "/api/v0/id", 421),
        (
            host.as_str(),
            Some("https://evil.test"),
            Method::POST,
            "/api/v0/id",
            403,
        ),
        (host.as_str(), Some("null"), Method::POST, "/api/v0/id", 403),
        (host.as_str(), None, Method::OPTIONS, "/api/v0/id", 403),
        (
            host.as_str(),
            Some(ORIGIN),
            Method::OPTIONS,
            "/api/v0/id",
            204,
        ),
        (
            host.as_str(),
            Some(ORIGIN),
            Method::POST,
            "/debug/vars",
            404,
        ),
        (host.as_str(), None, Method::GET, "/webui", 404),
        (host.as_str(), None, Method::GET, "/ipfs/x", 404),
        (
            host.as_str(),
            None,
            Method::POST,
            "/api/v0/config/show",
            404,
        ),
        (host.as_str(), None, Method::POST, "/api/v0/add/", 404),
        (host.as_str(), None, Method::GET, "/api/v0/id", 404),
        (host.as_str(), None, Method::POST, "/dash-forge/pair", 403),
        (host.as_str(), None, Method::POST, "/api/v0/id", 200),
        (
            host.as_str(),
            Some(ORIGIN),
            Method::POST,
            "/api/v0/pin/add?arg=bafytest",
            200,
        ),
    ] {
        let mut request = h
            .client
            .request(method.clone(), format!("{}{path}", h.node.api()))
            .header("host", host_value);
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        let response = request.send().await.unwrap();
        assert_eq!(response.status().as_u16(), expected, "{method} {path}");
        if expected == 204 {
            let headers = response.headers();
            assert_eq!(headers["access-control-allow-origin"], ORIGIN);
            assert_eq!(headers["vary"], "Origin");
            assert_eq!(headers["access-control-allow-methods"], "POST");
            assert_eq!(
                headers["access-control-allow-headers"],
                "Authorization, Content-Type"
            );
            assert_eq!(headers["access-control-allow-private-network"], "true");
            assert_eq!(headers["access-control-max-age"], "600");
        }
        if expected == 200 {
            let record = h.records.recv().await.unwrap();
            assert_eq!(record.uri, path);
            assert!(!record.headers.contains_key("origin"));
            assert!(!record.headers.contains_key("authorization"));
            assert!(!response
                .headers()
                .contains_key("access-control-allow-credentials"));
            if origin.is_none() {
                assert!(!response
                    .headers()
                    .contains_key("access-control-allow-origin"));
            } else {
                assert_eq!(response.headers()["access-control-allow-origin"], ORIGIN);
            }
        }
    }
    let mut headers = HeaderMap::new();
    headers.append("host", HeaderValue::from_str(&host).unwrap());
    headers.append("host", HeaderValue::from_str(&host).unwrap());
    assert!(!host_ok(&headers, h.node.config.api_port));
    headers.insert("origin", HeaderValue::from_static(ORIGIN));
    headers.append("origin", HeaderValue::from_static(ORIGIN));
    assert!(allowed_origin(&headers, &h.node).is_none());
}

#[tokio::test]
async fn upstream_receives_only_selected_headers_and_uploads_stream() {
    let mut h = Harness::new().await;
    let (release, gate) = mpsc::unbounded_channel::<()>();
    let stream = futures::stream::unfold((0, gate), |(part, mut gate)| async move {
        if part == 1 {
            gate.recv().await.unwrap();
        }
        match part {
            0 | 1 => Some((
                Ok::<_, std::io::Error>(Bytes::from(vec![b'a'; 64 * 1024])),
                (part + 1, gate),
            )),
            _ => None,
        }
    });
    let request = h
        .client
        .post(format!("{}/api/v0/add?pin=true", h.node.api()))
        .header("host", format!("localhost:{}", h.node.config.api_port))
        .header("origin", ORIGIN)
        .header("referer", "https://forge.dashhq.org/settings/storage/")
        .header("authorization", "Bearer test-token")
        .header("content-type", "multipart/form-data; boundary=test")
        .body(reqwest::Body::wrap_stream(stream));
    let sent = tokio::spawn(async move { request.send().await.unwrap() });
    // If the proxy buffers the upload, the upstream cannot observe the first chunk and
    // this times out before we release the second chunk.
    tokio::time::timeout(Duration::from_secs(3), h.first_chunk.notified())
        .await
        .unwrap();
    release.send(()).unwrap();
    let response = sent.await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let record = h.records.recv().await.unwrap();
    assert_eq!(record.bytes.len(), 128 * 1024);
    assert_eq!(record.method, Method::POST);
    assert_eq!(record.headers["authorization"], "Bearer test-token");
    assert_eq!(
        record.headers["content-type"],
        "multipart/form-data; boundary=test"
    );
    assert_eq!(
        record.headers["host"],
        format!("127.0.0.1:{}", h.node.config.internal_api_port)
    );
    assert!(!record.headers.contains_key("origin"));
    assert!(!record.headers.contains_key("referer"));
}

#[tokio::test]
async fn gateway_is_read_only_and_cors_is_scoped() {
    let mut h = Harness::new().await;
    for (method, path, origin, expected) in [
        (Method::GET, "/ipfs/bafytest/file", Some(ORIGIN), 200),
        (Method::HEAD, "/ipfs/bafytest", None, 200),
        (
            Method::GET,
            "/ipfs/bafytest",
            Some("https://evil.test"),
            200,
        ),
        (Method::POST, "/ipfs/bafytest", Some(ORIGIN), 404),
        (Method::GET, "/ipns/name", None, 404),
        (Method::GET, "/ipfs/", None, 404),
        (Method::GET, "/debug/vars", None, 404),
        (Method::OPTIONS, "/ipfs/bafytest", Some(ORIGIN), 204),
        (Method::OPTIONS, "/ipfs/bafytest", None, 403),
    ] {
        let mut request = h
            .client
            .request(method, format!("{}{path}", h.node.gateway()))
            .header("range", "bytes=0-1")
            .header("if-none-match", "\"old\"");
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        let response = request.send().await.unwrap();
        assert_eq!(response.status().as_u16(), expected);
        if expected == 200 {
            let record = h.records.recv().await.unwrap();
            assert_eq!(record.headers["range"], "bytes=0-1");
            assert_eq!(record.headers["if-none-match"], "\"old\"");
            assert!(!record.headers.contains_key("origin"));
            assert!(!response
                .headers()
                .contains_key("access-control-allow-credentials"));
            if origin == Some(ORIGIN) {
                assert_eq!(response.headers()["access-control-allow-origin"], ORIGIN);
                assert_eq!(
                    response.headers()["access-control-expose-headers"],
                    "Content-Range, Content-Length, ETag"
                );
            } else {
                assert!(!response
                    .headers()
                    .contains_key("access-control-allow-origin"));
            }
        }
        if expected == 204 {
            assert_eq!(
                response.headers()["access-control-allow-methods"],
                "GET, HEAD"
            );
            assert_eq!(response.headers()["access-control-allow-headers"], "Range");
        }
    }
    let response = h
        .client
        .get(format!("{}/ipfs/bafytest", h.node.gateway()))
        .header("host", "evil.test")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::MISDIRECTED_REQUEST);
}

#[tokio::test]
async fn pairing_requires_origin_and_consumes_codes() {
    let h = Harness::new().await;
    let url = format!("{}/dash-forge/pair", h.node.api());
    let connection = pair::create(&h.node).unwrap();
    let response = h
        .client
        .post(&url)
        .json(&json!({"code":connection.code}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = h
        .client
        .post(&url)
        .header("origin", ORIGIN)
        .json(&json!({"code":connection.code.to_ascii_lowercase()}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let payload: Value = response.json().await.unwrap();
    let expected_auth = format!("Bearer {}", h.state.tokens.forge);
    assert_eq!(payload["auth"].as_str(), Some(expected_auth.as_str()));
    assert_eq!(payload["peerId"], "test-peer");
    assert_eq!(payload["version"], "0.43.1");
    let response = h
        .client
        .post(&url)
        .header("origin", ORIGIN)
        .json(&json!({"code":connection.code}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::GONE);
    let expired = pair::create(&h.node).unwrap();
    let path = h.node.dir.join("pair.json");
    let mut persisted: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    persisted["expiresAt"] = json!(0);
    super::super::config::write_private(&path, &serde_json::to_vec(&persisted).unwrap()).unwrap();
    let response = h
        .client
        .post(&url)
        .header("origin", ORIGIN)
        .json(&json!({"code":expired.code}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::GONE);
    let connection = pair::create(&h.node).unwrap();
    for _ in 0..5 {
        let response = h
            .client
            .post(&url)
            .header("origin", ORIGIN)
            .json(&json!({"code":"wrong"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            response.json::<Value>().await.unwrap(),
            json!({"error":"code"})
        );
    }
    let response = h
        .client
        .post(&url)
        .header("origin", ORIGIN)
        .json(&json!({"code":connection.code}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::GONE);
}

#[tokio::test]
async fn response_bodies_are_delivered_before_upstream_finishes() {
    let h = Harness::new().await;
    let response = h
        .client
        .get(format!("{}/ipfs/stream", h.node.gateway()))
        .send()
        .await
        .unwrap();
    let mut stream = response.bytes_stream();
    let first = tokio::time::timeout(Duration::from_secs(3), stream.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(first, Bytes::from_static(b"streamed"));
    h.response_release.notify_one();
    assert_eq!(
        stream.next().await.unwrap().unwrap(),
        Bytes::from_static(b"streamed")
    );
    assert!(stream.next().await.is_none());
}

#[tokio::test]
async fn content_length_and_each_loopback_host_are_preserved_or_rewritten() {
    let mut h = Harness::new().await;
    for hostname in ["localhost", "127.0.0.1", "[::1]"] {
        let response = h
            .client
            .post(format!("{}/api/v0/add", h.node.api()))
            .header("host", format!("{hostname}:{}", h.node.config.api_port))
            .header("content-length", "4")
            .body("data")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let received = h.records.recv().await.unwrap();
        assert_eq!(received.headers["content-length"], "4");
        assert_eq!(received.bytes, b"data");
        assert_eq!(
            received.headers["host"],
            format!("127.0.0.1:{}", h.node.config.internal_api_port)
        );
    }
}
