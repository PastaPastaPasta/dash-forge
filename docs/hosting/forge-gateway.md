# Host forge-gateway (plain git over HTTPS, badges, feeds, link previews)

`forge-gateway` is an **optional** read-only mirror of the **public** repositories of one network. With it, a plain `git clone https://<gateway>/<owner>/<name>.git` works without `git-remote-dash`, which helps GitHub Actions `checkout`, Go modules, Cargo and npm git dependencies, Nix, Renovate, IDEs and locked-down machines. The same binary serves README badges, Atom feeds and link-preview cards.

dashhq runs one for forge.dashhq.org. Anyone can run their own from the same image with the same settings. This page covers both.

1. [What a gateway is trusted for](#what-a-gateway-is-trusted-for)
2. [What you need](#what-you-need)
3. [Run it](#run-it)
4. [Settings](#settings)
5. [DNS and TLS](#dns-and-tls)
6. [Freshness: polling and relay wakes](#freshness-polling-and-relay-wakes)
7. [Routes](#routes)
8. [Rate limits and abuse controls](#rate-limits-and-abuse-controls)
9. [Monitoring](#monitoring)
10. [Logs](#logs)
11. [Backups and upgrades](#backups-and-upgrades)
12. [Show it in the web app](#show-it-in-the-web-app)
13. [Measured on sakura](#measured-on-sakura)
14. [Billing (later)](#billing-later)
15. [Privacy notice (draft)](#privacy-notice-draft)
16. [Checklist for dashhq](#checklist-for-dashhq)

---

## What a gateway is trusted for

Very little, and every part of it can be checked.

- **Git objects are content-addressed.** A gateway cannot change a commit, a tree or a file without changing its id, and git checks every object it receives. So a gateway is trusted only for **which tips it serves for which refs, and how fresh they are**.
- **Every repository publishes its claim.** `GET /<owner>/<name>.git/forge-manifest.json` lists every ref the mirror serves with the `$id` of the Platform `refUpdate` (or `protectedRefUpdate`) that set its tip, plus the Platform block height and time of the snapshot. Anyone can re-read those documents with proofs.
- **Anyone can check it.** `dg verify-mirror https://<gateway>/<owner>/<name>.git` lists what the mirror serves (`git ls-remote`), folds the refs from Platform with proofs, and reports each ref as `match`, `stale` (an earlier tip of the ref, which moved after the snapshot) or `MISMATCH` (a tip the ref never had, a ref Platform does not have, an omission, or a manifest claim Platform does not back). The web app's clone box has a **verify** link that runs the same comparison in the browser for the branches and tags the page proved.
- **The worst a dishonest or broken gateway can do is delay or omit,** and either shows. It can never make you accept code nobody pushed.
- **It is never required.** `git clone dash://<owner>/<name>` reads Platform and storage directly. The survivability drill has a "gateway down" case: no crate on the `dash://` read path depends on the gateway, and the web clone box keeps working with the gateway unreachable.
- **It holds no keys.** It reads anonymously. A **private repository is refused** with the same `404` as a repository that does not exist, so the gateway does not even confirm it exists. It never fetches one.
- **No push.** `git-receive-pack` answers `403`. Push with `dash://`, which signs your own push.

How a refresh works: the gateway reads a proof-verified snapshot (chain tip first, then every ref, the default branch and the recorded packs), fetches the objects through the shipped `git-remote-dash` helper (the same proof-checked fetch every client runs) into a hidden staging namespace, checks every snapshot tip is present, and only then moves the served refs to exactly the snapshot's in one transaction. The manifest is written after the refs, so it never claims more than is served. A failed refresh changes nothing: the mirror keeps serving its last snapshot, whose manifest says how old it is.

## What you need

| | Minimum | dashhq (forge.dashhq.org) |
|---|---|---|
| Host | 2 vCPU, 2 GiB RAM, Docker | An LXC or VM on the home Proxmox (proxmox3), Docker Compose |
| Disk | The mirror cap (`GATEWAY_CACHE_MAX`, default 20 GiB) plus 5 GiB | 40 GiB volume |
| Network out | HTTPS to the network's DAPI nodes (port 1443) and to the storage the repos use (IPFS gateways, S3 endpoints) | as is |
| Network in | HTTPS only, through a TLS proxy | Cloudflare tunnel |
| Domain | One hostname | `git.forge.dashhq.org` (suggested) |
| Contact | An abuse contact address | the owner's choice |

A repository costs about its pack size on disk: the dash mirror (606 refs, a 258.7 MiB pack) is about 300 MB with its bitmap index. CPU is spent on the first mirror of a repository and on repacks; serving a warm clone streams from disk.

## Run it

Build the image from the repository root (or pull a release image once one is published):

```sh
docker build -f services/forge-gateway/Dockerfile -t forge-gateway .
```

Then, in `services/forge-gateway/`, write a `.env` and start it:

```sh
cat > .env <<'EOF'
DASH_FORGE_NETWORK=devnet
DASH_FORGE_DEVNET_NAME=sakura
GATEWAY_PUBLIC_URL=https://git.forge.dashhq.org
GATEWAY_WEB_URL=https://forge.dashhq.org
GATEWAY_ALL_PUBLIC=true
GATEWAY_TRUST_PROXY=cloudflare
EOF
docker compose up -d
curl -fsS http://127.0.0.1:8080/readyz
```

The compose file binds the gateway to `127.0.0.1:8080` on the host. Put TLS in front of it ([DNS and TLS](#dns-and-tls)); never expose it as plain HTTP.

Without Docker: `cargo build --release -p forge-gateway -p git-remote-dash`, put both binaries on `PATH` (or set `GATEWAY_HELPER_DIR`), install `git` and a font (`fonts-dejavu-core`), and run `forge-gateway` with the variables below.

To mirror only some repositories (a project hosting its own), set `GATEWAY_ALL_PUBLIC=false` and list them: `GATEWAY_REPOS=alice/project,G6D3ejKx…/other`. Listed repositories are mirrored at start, kept warm and never evicted; every other one answers `404`.

## Settings

Every setting is a flag (`forge-gateway --help`) and an environment variable. Empty values count as unset.

**Network** (forge-core's own variables, as for `dg` and `git-remote-dash`):

| Variable | Default | Meaning |
|---|---|---|
| `DASH_FORGE_NETWORK` | `testnet` | `testnet`, `mainnet` or `devnet` (or `devnet-<name>`). |
| `DASH_FORGE_DEVNET_NAME` | none | The devnet's name (`sakura`). |
| `DASH_FORGE_DAPI_ADDRESSES` | the deployment file's | DAPI nodes, comma-separated. |
| `DASH_FORGE_QUORUM_URL` | the network's | Where quorum keys come from (the trust anchor every proof is checked against; see [verify-forge](../guides/verify-forge.md#the-one-trusted-input-quorum-keys)). |

**Gateway:**

| Variable | Default | Meaning |
|---|---|---|
| `GATEWAY_LISTEN` | `127.0.0.1:8080` (image: `0.0.0.0:8080`) | Listen address. |
| `GATEWAY_DATA_DIR` | `./forge-gateway-data` (image: `/data`) | Mirrors, manifests and the Platform read cache. |
| `GATEWAY_PUBLIC_URL` | `http://<listen>` | This gateway's public URL, used in feeds, previews and the index page. Never taken from the request's `Host`. |
| `GATEWAY_WEB_URL` | `https://forge.dashhq.org` | The web app links point at. |
| `GATEWAY_ALL_PUBLIC` | `false` (compose: `true`) | Serve any public repository on demand. |
| `GATEWAY_REPOS` | none | `owner/name` list: mirrored at start, kept warm, never evicted (and the only ones served without `GATEWAY_ALL_PUBLIC`). |
| `GATEWAY_CACHE_MAX` | `20G` | Disk cap for all mirrors; the least recently served are evicted above it. |
| `GATEWAY_REPO_MAX` | `2G` | The largest repository mirrored (its recorded packs). Larger ones answer `403` and point at `dash://`. |
| `GATEWAY_POLL_SECS` | `120` | How often a warm mirror is checked against Platform. A check whose refs did not move costs a few proved reads and no fetch. |
| `GATEWAY_WARM_HOURS` | `24` | A mirror served within this window is polled; older ones refresh on their next request. |
| `GATEWAY_WAKE_URL` | none | A forge-relay whose `[wake]` stream announces pushes. |
| `GATEWAY_WAKE_SECRET_FILE` | none | That relay's `[wake]` secret, in a file. |
| `GATEWAY_TRUST_PROXY` | `none` (compose: `cloudflare`) | Which header names the client for rate limits: `none` (the TCP peer), `cloudflare` (`CF-Connecting-IP`), `x-forwarded-for` (its last entry). Set it only behind that proxy, or clients can pick their own address. |
| `GATEWAY_RATE_PER_MIN` | `240` | Requests per minute per client, every route but the probes. |
| `GATEWAY_CLONES_PER_MIN` | `30` | Clones and fetches per minute per client. |
| `GATEWAY_CLONES_PER_CLIENT` | `2` | Concurrent clones per client. |
| `GATEWAY_CLONES_MAX` | `16` | Concurrent clones in total. |
| `GATEWAY_NEW_MIRRORS_PER_HOUR` | `10` | New (cold) mirrors one client may start per hour. |
| `GATEWAY_REFRESH_MAX` | `2` | Refreshes running at once. |
| `GATEWAY_COLD_WAIT_SECS` | `20` | How long a request waits for a first mirror before answering `503 Retry-After: 30`. Keep it under your proxy's timeout (Cloudflare: 100 s). |
| `GATEWAY_FETCH_TIMEOUT_SECS` | `1800` | The longest one refresh's fetch may run. |
| `GATEWAY_SERVE_TIMEOUT_SECS` | `900` | The longest one clone response may stream. |
| `GATEWAY_RENDER_TTL_SECS` | `300` | Badge, feed and preview cache lifetime. |
| `GATEWAY_GIT` | `git` | The `git` binary. |
| `GATEWAY_HELPER_DIR` | `PATH` | The directory holding `git-remote-dash`. |
| `GATEWAY_FONT_DIR` | none | Extra fonts for preview cards (system fonts are always loaded). |
| `RUST_LOG` | `info` | Log level. |

The fetch runs with `HOME` set to `<data>/home` and without `DASH_FORGE_KEY`: no operator identity, `dg` config or git config reaches it.

## DNS and TLS

**dashhq, through a Cloudflare tunnel** (no inbound port on the home network):

1. In the Cloudflare dashboard (Zero Trust → Networks → Tunnels), add a public hostname to the tunnel that runs on the gateway's host: `git.forge.dashhq.org` → `http://localhost:8080`. Cloudflare creates the proxied `CNAME git.forge.dashhq.org → <tunnel-id>.cfargotunnel.com` and terminates TLS.
2. Keep `GATEWAY_TRUST_PROXY=cloudflare`.
3. Cache rules: let Cloudflare cache `/badge/*`, `/feed/*` and `/og/*` (they send `Cache-Control: public, max-age=300`). Do **not** cache `*/info/refs`, `*/git-upload-pack` or `*/forge-manifest.json` (they say `no-cache` or `max-age=30`; the default rules already respect that).
4. Cloudflare's 100-second origin timeout applies to the first byte only: a clone streams, and a cold mirror answers `503 Retry-After` after `GATEWAY_COLD_WAIT_SECS`.

**A plain VPS:** an `A` (and `AAAA`) record for the hostname pointing at the VPS, and a TLS proxy. With Caddy:

```
git.example.org {
    reverse_proxy 127.0.0.1:8080
}
```

and `GATEWAY_TRUST_PROXY=x-forwarded-for` (Caddy appends the client to `X-Forwarded-For`). Caddy gets and renews the certificate itself.

## Freshness: polling and relay wakes

Every warm mirror is checked every `GATEWAY_POLL_SECS` (120 s), and every request for a mirror older than that starts a refresh in the background while the current snapshot is served. So a push shows on the gateway within about two minutes.

For seconds instead, point the gateway at a forge-relay's wake stream (the same one forge-runner uses; see [Wake a runner](../../crates/forge-relay/README.md#wake-a-runner)): list the repositories in the relay's `[wake] repos`, share its secret, and set `GATEWAY_WAKE_URL` and `GATEWAY_WAKE_SECRET_FILE`. A wake only says "refresh now"; the refresh still reads Platform with proofs, so a relay that is down or lies costs latency and nothing else.

## Routes

| Route | What |
|---|---|
| `GET /<owner>/<name>.git/info/refs?service=git-upload-pack`, `POST …/git-upload-pack` | git smart HTTP (protocol v0 and v2), read only. `CORS: *` on `info/refs` so the web app can verify. |
| `GET /<owner>/<name>.git/forge-manifest.json` | The snapshot's claim (`forge-gateway-manifest/v1`). `CORS: *`. |
| `GET /<owner>/<name>` | Redirect to the web app's page for the repository. |
| `GET /badge/<owner>/<name>/<kind>.svg` | Badges: `stars`, `ci` (the newest trusted check run per name on the default branch's tip, or `?branch=`), `release` (the latest release's tag), `issues` (open issues). Each also as `.json`, shields.io's [endpoint](https://shields.io/badges/endpoint-badge) format. |
| `GET /feed/<owner>/<name>/<kind>.atom` | Atom feeds: `releases`, `commits` (the default branch), `issues` (issues a maintainer hid are left out). |
| `GET /og/<owner>/<name>` | A page with `og:` and `twitter:` tags that redirects people to the web app: share this link to get a preview card. |
| `GET /og/<owner>/<name>.png` | The 1200×630 card. |
| `GET /healthz`, `/readyz`, `/metrics` | Liveness, readiness, Prometheus metrics. |

`<owner>` is an identity id or a DPNS name. A README badge: `[![checks](https://git.forge.dashhq.org/badge/alice/project/ci.svg)](https://forge.dashhq.org/alice/project)`.

Badges, feeds and previews are cached for `GATEWAY_RENDER_TTL_SECS`. When Platform cannot be read, the last render is served (marked by `Cache-Control: max-age=60`); a badge with nothing cached says `unavailable`.

## Rate limits and abuse controls

- **Per client** (an IPv6 client by its /64): a request budget for every route, a clone budget, at most two clones at once, and a budget for starting new mirrors, so one client cannot fill the disk by walking every repository. Over a limit: `429` with `Retry-After`.
- **Globally:** at most `GATEWAY_CLONES_MAX` clones and `GATEWAY_REFRESH_MAX` refreshes at once; `GATEWAY_REPO_MAX` per repository; `GATEWAY_CACHE_MAX` in total (least recently served evicted first; listed and in-use mirrors never are).
- **Request size and time:** a clone's request body is capped at 16 MiB and must arrive within 30 s; the gateway's clone slots are taken only once it has, so a client that trickles its body holds only its own. Any response must start within `GATEWAY_COLD_WAIT_SECS` plus 120 s, and a clone streams for at most `GATEWAY_SERVE_TIMEOUT_SECS`. The gateway does not time out slow request headers itself (its HTTP server has no such setting); the TLS proxy in front of it reads them first.
- **Surface:** only the routes above. Mirrors are configured `http.getanyfile=false` (no dumb-HTTP file serving) and `http.receivepack=false`; the staging namespace is hidden from the advertisement. The client's address never reaches git.
- **Content:** the gateway serves what Platform's refs point at. Hiding an issue (kinds 24/25) affects the issue feed, not git objects. A takedown is the operator's policy: stop serving a repository by leaving `GATEWAY_ALL_PUBLIC` off and listing the rest, or block the path at the proxy.
- **Outbound requests:** a repository's pack URLs are written by whoever pushed it, so a stranger can make the gateway fetch them. The fetch only follows public `https` URLs, refuses a redirect to anything else, and drops DNS answers that are private, loopback, link-local, CGNAT (100.64/10) or unique-local (fc00::/7) addresses. Back that up with an egress firewall.

### Egress firewall

The gateway needs to reach only the internet: DNS, the network's DAPI nodes (port 1443), its quorum URL, and the storage repositories use (IPFS gateways and S3 endpoints, port 443). On a home or office network, refuse everything else from the gateway's container, so no bug in the gateway, `git` or the helper can reach the LAN. With Docker, rules for traffic leaving a container go in the `DOCKER-USER` chain; the host's own addresses are reached through `INPUT`:

```sh
# The compose network's subnet: docker network inspect forge-gateway_default
SUBNET=172.18.0.0/16
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16; do
  iptables -I DOCKER-USER -s "$SUBNET" -d "$net" -j REJECT
done
iptables -I DOCKER-USER -s "$SUBNET" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -I INPUT -s "$SUBNET" -m conntrack --ctstate NEW -j REJECT
# IPv6, if the network has it:
# ip6tables -I DOCKER-USER -s <subnet6> -d fc00::/7 -j REJECT
# ip6tables -I DOCKER-USER -s <subnet6> -d fe80::/10 -j REJECT
```

Rules inserted with `-I` go first, so the `ESTABLISHED` rule, inserted last, keeps replies flowing. If the forge-relay of `GATEWAY_WAKE_URL` (or a DAPI node) is on the LAN, allow exactly its address and port by running `iptables -I DOCKER-USER -s "$SUBNET" -d <address> -p tcp --dport <port> -j ACCEPT` after the rules above, so it lands above the rejects. Make the rules persistent the way the host does (`iptables-persistent`, or the Proxmox firewall on the LXC or VM, which can express the same rules per guest).

## Monitoring

- `GET /healthz`: `200 ok` while the process serves (the container health check).
- `GET /readyz`: `200` when the newest Platform read succeeded, `503` with `"platform": "failing"` when the newest failed. Mirrors keep serving meanwhile; alert if it stays `503` for more than 10 minutes.
- `GET /metrics` (Prometheus text): requests by route class, clones started and bytes streamed, rate-limited requests, refreshes (ok, failed, changed), mirrors created and evicted, private-repository refusals, relay wakes, stale renders, and gauges for mirrors, ready mirrors, bytes on disk and its cap, clones streaming, and the times of the last Platform success and failure. No series is labelled by repository or client. Suggested alerts: `forge_gateway_cache_bytes > 0.9 * forge_gateway_cache_max_bytes`; a rising `forge_gateway_refresh_failed_total`; `forge_gateway_upstream_last_ok_seconds` older than 15 minutes.

Restrict `/metrics` at the proxy if you do not want it public (it holds no personal data).

## Logs

One line per request: method, path, status and duration. Plus refresh outcomes (repository id, whether refs moved, duration) and warnings.

Never logged: client addresses, user agents, request headers, query strings and request bodies. Client addresses live in memory only, in rate-limit buckets that are dropped once full again. git's own output stays inside the gateway (debug level only). `docker compose logs` keeps what Docker keeps: set Docker's log rotation (`max-size`, `max-file`) to match the privacy notice.

## Backups and upgrades

Nothing in `GATEWAY_DATA_DIR` needs a backup: every mirror is rebuilt from Platform on its next request. Back up only your `.env` and the wake secret. Losing the volume costs a cold first clone per repository (the dash mirror took 299 s in the prototype).

Upgrade: rebuild or pull the image and `docker compose up -d`. The mirrors on the volume are reused; a mirror whose manifest is missing or from another schema is removed and rebuilt. `SIGTERM` stops it gracefully (compose waits 30 s).

## Show it in the web app

The clone box shows the HTTPS URL only when the web build names a gateway:

```sh
NEXT_PUBLIC_GATEWAY_URL=https://git.forge.dashhq.org NEXT_PUBLIC_GATEWAY_LABEL="dashhq gateway" pnpm build
```

`dash://` stays first; the HTTPS line reads "HTTPS via dashhq gateway · plain git, read only, an optional mirror · verify". Without the variable there is no HTTPS line.

## Measured on sakura

See the PR that added the gateway for the run's numbers (cold and warm clones of the dash mirror and of dips through a local gateway, HEAD checked against Platform). The prototype measured 299 s for the first proof-verified mirror of dash and 16 s for each later plain clone.

## Billing (later)

The MVP is free with rate limits. A paid tier is a later spike, and needs no contract change in this service:

- **What would be sold:** a "warm" tier per repository (prefetch on push through relay wakes, bitmaps kept current, higher limits, a vanity alias), about 0.01 DASH per repository per 30 days.
- **How it would be paid:** a prepaid credit transfer to the operator's service identity, or Platform's `actionFees` on an operator-owned subscription contract (`forge-svc`). The gateway would read the payer's subscription with proofs, as it reads everything else.
- **The open question:** whether the JS and Rust SDKs can build `$actionFeeAgreement` yet. That spike comes before any billing code.

## Privacy notice (draft)

> **Dash Forge gateway: privacy notice**
>
> The gateway at `git.forge.dashhq.org` is run by dashhq. It serves read-only copies of **public** Dash Forge repositories, which anyone can already read on Dash Platform.
>
> **What we process.** To answer a request we see your IP address, the URL you request and your client's request headers. We use your IP address only to apply rate limits, in memory, for at most a few minutes. We do not log IP addresses, user agents or request headers. Our logs record the requested path, the response status and its duration, and are kept for 14 days.
>
> **What we do not do.** We use no cookies, no analytics and no tracking. We do not serve private repositories and hold no keys for them. We do not sell or share data.
>
> **Our provider.** Requests pass through Cloudflare, which processes them under its own privacy policy.
>
> **Your choice.** Using the gateway is optional: `git clone dash://<owner>/<name>` reads Dash Platform directly and never contacts us.
>
> **Contact.** `<abuse and privacy contact>`. Last updated `<date>`.

## Checklist for dashhq

What the owner provides; the software is ready:

1. **A host:** an LXC or VM on proxmox3 with Docker, 2 vCPU, 2–4 GiB RAM, a 40 GiB volume.
2. **The hostname:** `git.forge.dashhq.org` (or another), added as a public hostname on a Cloudflare tunnel → `http://localhost:8080` (dashboard step, or a Cloudflare API token scoped to the tunnel and the `dashhq.org` DNS zone).
3. **Build and start:** the commands under [Run it](#run-it), with `GATEWAY_PUBLIC_URL=https://git.forge.dashhq.org`.
4. **Optional, for seconds-fresh mirrors:** a forge-relay with `[wake]` listing the repositories, and its secret in `GATEWAY_WAKE_SECRET_FILE`.
5. **The web app:** set `NEXT_PUBLIC_GATEWAY_URL` (and the label) in the Pages build.
6. **An abuse and privacy contact,** filled into the privacy notice, and the notice published (for example on the gateway's index page or the docs site).
7. **Software Heritage (optional):** ask SWH to allowlist the gateway's domain, so public repositories can be archived from their HTTPS URLs.
