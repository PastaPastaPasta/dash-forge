# forge-gateway

An optional, read-only git-over-HTTPS mirror of the public repositories of one Dash Forge
network, with README badges, Atom feeds and link-preview cards on the same binary.

```sh
git clone https://<gateway>/<owner>/<name>.git          # plain git, no helper
dg verify-mirror https://<gateway>/<owner>/<name>.git   # check it against Dash Platform
```

It is a hint, never an authority: every repository's `forge-manifest.json` names the Platform
`refUpdate` behind each served ref, `dg verify-mirror` and the web clone box's "verify" check
it, it holds no keys and refuses private repositories, and `dash://` never needs it.

Hosting (Docker image, compose file, every setting, DNS and TLS, monitoring, logs, rate limits,
the privacy notice draft): [docs/hosting/forge-gateway.md](../../docs/hosting/forge-gateway.md).

Code map:

| File | What |
|---|---|
| `src/upstream.rs` | The `Upstream` trait and its Platform implementation (proof-verified reads through forge-core). |
| `src/mirror.rs` | The mirror store: refresh from a snapshot, the staging namespace, the manifest, LRU eviction. |
| `src/git_http.rs` | Smart HTTP through `git http-backend`, streamed. |
| `src/server.rs` | Routes, resolution, limits, badges, feeds, previews, health and metrics. |
| `src/limits.rs`, `src/cache.rs` | Per-client token buckets and concurrency; the render cache. |
| `src/badge.rs`, `src/feed.rs`, `src/og.rs` | Badge SVG and shields JSON; Atom; share links and their preview cards (resvg). |
| `src/wake.rs` | forge-relay wake stream client (`forge-wake-v1`). |
| `tests/gateway.rs` | End to end with a stub upstream: plain `git` clones, fetches, push refused, private refused, Platform down, a repository proved gone, restarts, eviction, limits. |

The manifest schema and the comparison `dg verify-mirror` runs live in forge-core
(`crates/forge-core/src/mirror.rs`).
