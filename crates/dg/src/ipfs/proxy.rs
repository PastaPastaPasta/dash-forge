//! Loopback-only browser boundary. Uploads and downloads remain streams.
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use axum::body::{to_bytes, Body};
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::{config::Tokens, pair, Node, FORGE_RPC_PATHS};

pub struct Proxy {
    pub node: Node,
    tokens: Tokens,
    client: reqwest::Client,
    identity: Mutex<Option<(String, String)>>,
}

impl Proxy {
    pub fn new(node: Node, tokens: Tokens) -> Result<Arc<Self>> {
        Ok(Arc::new(Self {
            node,
            tokens,
            client: reqwest::Client::builder()
                .no_proxy()
                .no_gzip()
                .no_brotli()
                .no_deflate()
                .no_zstd()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(5))
                .build()?,
            identity: Mutex::new(None),
        }))
    }
}

pub fn rpc_router(state: Arc<Proxy>) -> Router {
    Router::new().fallback(rpc).with_state(state)
}
pub fn gateway_router(state: Arc<Proxy>) -> Router {
    Router::new().fallback(gateway).with_state(state)
}

fn one_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut values = headers.get_all(name).iter();
    let first = values.next()?.to_str().ok()?;
    if values.next().is_some() {
        return None;
    }
    Some(first)
}

fn host_ok(headers: &HeaderMap, port: u16) -> bool {
    one_header(headers, "host").is_some_and(|host| {
        [
            format!("127.0.0.1:{port}"),
            format!("localhost:{port}"),
            format!("[::1]:{port}"),
        ]
        .iter()
        .any(|h| h == host)
    })
}

fn allowed_origin<'a>(headers: &'a HeaderMap, node: &Node) -> Option<&'a str> {
    one_header(headers, "origin").filter(|o| node.config.origins.iter().any(|allowed| allowed == o))
}

fn cors(response: &mut Response, origin: &str, gateway: bool) {
    if let Ok(origin) = HeaderValue::from_str(origin) {
        response
            .headers_mut()
            .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        response
            .headers_mut()
            .insert(header::VARY, HeaderValue::from_static("Origin"));
        if gateway {
            response.headers_mut().insert(
                header::ACCESS_CONTROL_EXPOSE_HEADERS,
                HeaderValue::from_static("Content-Range, Content-Length, ETag"),
            );
        }
    }
}

fn preflight(origin: Option<&str>, gateway: bool) -> Response {
    let Some(origin) = origin else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let mut response = StatusCode::NO_CONTENT.into_response();
    cors(&mut response, origin, gateway);
    let headers = response.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static(if gateway { "GET, HEAD" } else { "POST" }),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static(if gateway {
            "Range"
        } else {
            "Authorization, Content-Type"
        }),
    );
    headers.insert(
        "access-control-allow-private-network",
        HeaderValue::from_static("true"),
    );
    headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("600"),
    );
    response
}

async fn rpc(State(state): State<Arc<Proxy>>, request: Request) -> Response {
    if !host_ok(request.headers(), state.node.config.api_port) {
        return StatusCode::MISDIRECTED_REQUEST.into_response();
    }
    let origin = allowed_origin(request.headers(), &state.node).map(str::to_owned);
    if request.headers().contains_key(header::ORIGIN) && origin.is_none() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut response = if request.method() == Method::OPTIONS {
        preflight(origin.as_deref(), false)
    } else if request.method() == Method::POST && request.uri().path() == "/dash-forge/pair" {
        if origin.is_none() {
            StatusCode::FORBIDDEN.into_response()
        } else {
            pairing(&state, request).await
        }
    } else if request.method() == Method::POST && FORGE_RPC_PATHS.contains(&request.uri().path()) {
        forward(&state, request, false).await
    } else {
        StatusCode::NOT_FOUND.into_response()
    };
    if let Some(origin) = origin {
        cors(&mut response, &origin, false);
    }
    response
}

fn gateway_path(path: &str) -> bool {
    path.strip_prefix("/ipfs/")
        .and_then(|p| p.split('/').next())
        .is_some_and(|cid| !cid.is_empty() && cid.bytes().all(|b| b.is_ascii_alphanumeric()))
}

async fn gateway(State(state): State<Arc<Proxy>>, request: Request) -> Response {
    if !host_ok(request.headers(), state.node.config.gateway_port) {
        return StatusCode::MISDIRECTED_REQUEST.into_response();
    }
    let origin = allowed_origin(request.headers(), &state.node).map(str::to_owned);
    let mut response = if request.method() == Method::OPTIONS {
        preflight(origin.as_deref(), true)
    } else if !gateway_path(request.uri().path()) {
        StatusCode::NOT_FOUND.into_response()
    } else if matches!(*request.method(), Method::GET | Method::HEAD) {
        forward(&state, request, true).await
    } else {
        StatusCode::NOT_FOUND.into_response()
    };
    if let Some(origin) = origin {
        cors(&mut response, &origin, true);
    }
    response
}

async fn forward(state: &Proxy, request: Request, gateway: bool) -> Response {
    let port = if gateway {
        state.node.config.internal_gateway_port
    } else {
        state.node.config.internal_api_port
    };
    let path = request
        .uri()
        .path_and_query()
        .map_or("/", axum::http::uri::PathAndQuery::as_str);
    let Ok(url) = reqwest::Url::parse(&format!("http://127.0.0.1:{port}{path}")) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    // URL parsers normalize dot segments, including escaped ones. Never let that escape
    // the gateway prefix or change the CID selected by the original request.
    if gateway && url.path().split('/').nth(2) != request.uri().path().split('/').nth(2) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let mut upstream = state.client.request(request.method().clone(), url);
    let names: &[&str] = if gateway {
        &["range", "if-none-match"]
    } else {
        &["authorization", "content-type", "content-length"]
    };
    for name in names {
        if let Some(value) = request.headers().get(*name) {
            upstream = upstream.header(*name, value);
        }
    }
    // Construct a fresh request, never copying Origin, Referer or the incoming Host.
    let body = reqwest::Body::wrap_stream(request.into_body().into_data_stream());
    let Ok(upstream) = upstream.body(body).send().await else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let mut response = Response::builder().status(upstream.status());
    // Explicit response headers avoid hop-by-hop headers, kubo's wildcard CORS and cookies.
    for name in [
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
        "etag",
        "last-modified",
        "cache-control",
        "content-disposition",
        "content-encoding",
        "x-ipfs-path",
        "x-ipfs-roots",
    ] {
        if let Some(value) = upstream.headers().get(name) {
            response = response.header(name, value);
        }
    }
    response
        .body(Body::from_stream(upstream.bytes_stream()))
        .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
}

async fn pairing(state: &Proxy, request: Request) -> Response {
    let Ok(bytes) = to_bytes(request.into_body(), 4096).await else {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    };
    let Ok(body) = serde_json::from_slice::<Value>(&bytes) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let Some(code) = body["code"].as_str() else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    match pair::consume(&state.node, code, pair::now()) {
        Ok(pair::Verdict::Gone) => return StatusCode::GONE.into_response(),
        Ok(pair::Verdict::Wrong) => {
            return (StatusCode::FORBIDDEN, Json(json!({"error":"code"}))).into_response()
        }
        Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
        Ok(pair::Verdict::Success) => {}
    }
    let mut identity = state.identity.lock().await;
    if identity.is_none() {
        let (Ok(id), Ok(version)) = tokio::join!(
            super::status::admin_rpc(&state.node, &state.tokens, "id"),
            super::status::admin_rpc(&state.node, &state.tokens, "version")
        ) else {
            return StatusCode::BAD_GATEWAY.into_response();
        };
        let (Some(id), Some(version)) = (id["ID"].as_str(), version["Version"].as_str()) else {
            return StatusCode::BAD_GATEWAY.into_response();
        };
        *identity = Some((id.into(), version.into()));
    }
    let Some((peer_id, version)) = identity.as_ref() else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    Json(json!({"name":state.node.config.name, "api":state.node.api(), "gateway":state.node.gateway(), "auth":format!("Bearer {}", state.tokens.forge), "peerId":peer_id, "version":version})).into_response()
}

#[cfg(test)]
mod tests;
