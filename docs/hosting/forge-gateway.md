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
11. [Backups and upgrades](#backups-and-upgrades) (and [Deploy a release](#deploy-a-release))
12. [Show it in the web app](#show-it-in-the-web-app)
13. [Measured on a devnet](#measured-on-a-devnet)
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
- **It holds no keys.** It reads anonymously. A **private repository is refused** exactly as a repository that does not exist: the same `404` and text, cached for the same time, and counted in the same `/metrics` counter (`forge_gateway_repo_not_found_total`, which also counts absent and deleted repositories). So the gateway does not confirm that a private repository exists. It never fetches one.
- **It serves the public lane only.** A public repository can also have **members-only branches** (sealed under the members key, `private-repos.md` §19). The gateway has no key, so it neither lists nor fetches them: its refs, objects, feeds, badges and cards are exactly what an outsider's `git clone dash://` gets, and a clone through the gateway equals that clone byte for byte. It can see only that sealed ref updates exist, so the manifest says `"membersOnlyRefsNotServed": N` (absent when none): the number of distinct name hashes of those updates, an upper bound on the branches left out (one branch has a hash per key epoch, and a deleted one still counts). The names, commits and contents stay sealed, and a badge or card for a members-only branch answers as for one that does not exist. The web app and the text output of `dg` tell people only that "this repository also has members-only branches"; the number appears in machine-readable output alone (this manifest, `dg verify-mirror --json`).
- **No push.** `git-receive-pack` answers `403`. Push with `dash://`, which signs your own push.

How a refresh works: the gateway reads a proof-verified snapshot (chain tip first, then every ref, the default branch and the recorded packs), fetches the objects through the shipped `git-remote-dash` helper (the same proof-checked fetch every client runs) into a hidden staging namespace, checks every snapshot tip is present, and only then moves the served refs to exactly the snapshot's in one transaction. The manifest is written after the refs, so it never claims more than is served. A failed refresh changes nothing: the mirror keeps serving its last snapshot, whose manifest says how old it is.

**When Platform cannot be read** (a DAPI outage), the gateway keeps serving what it has, for a while, and says so:

- A repository resolved in the last hour is still served from its mirror. Past an hour without a successful read of its name, the gateway answers `503` instead: it can no longer show the repository still exists.
- Every git, manifest and feed response served from a snapshot that may be behind carries `X-Forge-Stale: <seconds>`, the snapshot's age. A badge, feed or preview served from an expired render carries it too, with the render's age. Fresh responses have no such header.

**When a repository is gone.** A repository is never deleted on a live network, but a reset devnet loses every one. Every refresh first reads the repository's `repo` document by id, with proofs. When Platform proves it absent (twice, 5 s apart, since a node a block behind can miss a repository just created), or the forge contracts are gone, or the document no longer has the owner and name the mirror served, the gateway removes the mirror, drops everything it cached about the repository, and answers `404` for it like any unknown repository. Only a proof counts: a failed read never removes a mirror, and a node that says a forge contract is missing is checked with a proved read of the contract first. At start, the gateway checks every mirror on its volume the same way (one proved read each) and removes the ones Platform lost, and a mirror of other forge contracts is removed without a read. A repository created again under the same name gets a new mirror.

## What you need

| | Minimum | dashhq (forge.dashhq.org) |
|---|---|---|
| Host | 2 vCPU, 2 GiB RAM, Docker | An LXC or VM on the home Proxmox (proxmox3), Docker Compose |
| Disk | The mirror cap (`GATEWAY_CACHE_MAX`, default 20 GiB) plus 5 GiB | 40 GiB volume |
| Network out | HTTPS to the network's DAPI nodes (port 1443) and to the storage the repos use (IPFS gateways, S3 endpoints) | as is |
| Network in | HTTPS only, through a TLS proxy | Cloudflare tunnel |
| Domain | One hostname | `git-forge.dashhq.org` (suggested) |
| Contact | An abuse contact address | the owner's choice |

A repository costs about its pack size on disk: the dash mirror (606 refs, a 258.7 MiB pack) is about 300 MB with its bitmap index. CPU is spent on the first mirror of a repository and on repacks; serving a warm clone streams from disk.

## Run it

Use a release image, or build one from source.

**A release image** (the normal way): every release publishes `ghcr.io/pastapastapasta/forge-gateway:<version>`, and `:latest` for a non-pre-release. Pull it and point the compose file at it with `GATEWAY_IMAGE` in `.env` (see [Deploy a release](#deploy-a-release)).

**From source** (self-hosters who want their own build): from the repository root, always with the build argument, so that the running gateway names its commit in `/readyz`:

```sh
docker build -f services/forge-gateway/Dockerfile \
  --build-arg DASH_FORGE_BUILD_SHA=$(git rev-parse HEAD) -t forge-gateway .
```

This compiles the Platform SDK tree, 20 to 40 minutes on a small host. Build it on a bigger machine and move the image over (`docker save forge-gateway | gzip` there, `gunzip -c | docker load` on the host) rather than building on the box that serves.

Then, in `services/forge-gateway/`, write a `.env` and start it:

```sh
cat > .env <<'EOF'
DASH_FORGE_NETWORK=testnet
GATEWAY_PUBLIC_URL=https://git-forge.dashhq.org
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
| `DASH_FORGE_DEVNET_NAME` | none | The devnet's name; required with `devnet`, ignored otherwise. |
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
| `GATEWAY_REPO_MAX` | `512M` | The largest repository mirrored (its recorded git packs). Larger ones answer `403` and point at `dash://`. Keep it well below the container's memory limit (compose: 2 GiB): `git-remote-dash` holds a pack in memory while it indexes it. |
| `GATEWAY_UNPINNED_REPO_MAX` | `256M` | The same for a repository that is not in `GATEWAY_REPOS` (anyone can ask for it); the lower of the two applies. A repository above it that you want served (a showcase mirror) goes in `GATEWAY_REPOS`: dashhq's `.env` pins its showcase mirrors there. |
| `GATEWAY_DENY` | none | A file of repositories and owners this gateway refuses with `451`. Optional, but when it is set and cannot be read at start, the gateway refuses to start; see [Takedowns](#takedowns-and-hidden-repositories). |
| `GATEWAY_POLL_SECS` | `120` | How often a warm mirror is checked against Platform. A check whose refs did not move costs a few proved reads and no fetch. |
| `GATEWAY_WARM_HOURS` | `24` | A mirror served within this window is polled; older ones refresh on their next request. The time of the last serve survives a restart (a `forge-gateway-served` file in the mirror); a refresh alone never makes a mirror warm. |
| `GATEWAY_WAKE_URL` | none | A forge-relay whose `[wake]` stream announces pushes. |
| `GATEWAY_WAKE_SECRET_FILE` | none | That relay's `[wake]` secret, in a file. |
| `GATEWAY_TRUST_PROXY` | `none` (compose: `cloudflare`) | Which header names the client for rate limits: `none` (the TCP peer), `cloudflare` (`CF-Connecting-IP`), `x-forwarded-for` (its last entry). Set it only behind that proxy, or clients can pick their own address. With `cloudflare` the gateway warns at startup, and once an hour when a request arrives without `CF-Connecting-IP` (counted in `forge_gateway_proxy_header_missing_total`): that is a gateway that is not behind Cloudflare. |
| `GATEWAY_RATE_PER_MIN` | `240` | Requests per minute per client, every route but the probes. |
| `GATEWAY_CLONES_PER_MIN` | `30` | Clones and fetches per minute per client. |
| `GATEWAY_CLONES_PER_CLIENT` | `2` | Concurrent clones per client. |
| `GATEWAY_CLONES_MAX` | `16` | Concurrent clones in total. |
| `GATEWAY_NEW_MIRRORS_PER_HOUR` | `10` | New (cold) mirrors one client may start per hour. |
| `GATEWAY_REFRESH_MAX` | `2` | Refreshes running at once. |
| `GATEWAY_PINNED_REFRESH_MAX` | `1` | Refreshes of `GATEWAY_REPOS` mirrors running at once, on permits of their own, so a hostile repository cannot starve them. |
| `GATEWAY_COLD_WAIT_SECS` | `20` | How long a request waits for a first mirror before answering `503 Retry-After: 30`. Keep it under your proxy's timeout (Cloudflare: 100 s). |
| `GATEWAY_FETCH_TIMEOUT_SECS` | `1800` | The longest one refresh's fetch may run. |
| `GATEWAY_FETCH_MIN_RATE` | `256K` | The slowest average transfer an on-demand (not `GATEWAY_REPOS`) mirror's fetch may have, in bytes per second (`0`: off): a repository of `n` declared bytes is fetched for at most `60 s + n / rate`, so a host that trickles its pack is cut off long before `GATEWAY_FETCH_TIMEOUT_SECS`. |
| `GATEWAY_SERVE_TIMEOUT_SECS` | `900` | The longest one clone response may stream. |
| `GATEWAY_RENDER_TTL_SECS` | `300` | Badge, feed and preview cache lifetime. |
| `GATEWAY_GIT` | `git` | The `git` binary. |
| `GATEWAY_HELPER_DIR` | `PATH` | The directory holding `git-remote-dash`. |
| `GATEWAY_FONT_DIR` | none | Extra fonts for preview cards (system fonts are always loaded). |
| `RUST_LOG` | `info` | Log level. |

The fetch runs with `HOME` set to `<data>/home` and without `DASH_FORGE_KEY`: no operator identity, `dg` config or git config reaches it.

## DNS and TLS

**dashhq, through a Cloudflare tunnel** (no inbound port on the home network):

1. In the Cloudflare dashboard (Zero Trust → Networks → Tunnels), add a public hostname to the tunnel that runs on the gateway's host: `git-forge.dashhq.org` → `http://localhost:8080`. Cloudflare creates the proxied `CNAME git-forge.dashhq.org → <tunnel-id>.cfargotunnel.com` and terminates TLS.
   - **Use a hostname one level under the zone.** Cloudflare's free certificate covers `dashhq.org` and `*.dashhq.org` only, so a deeper name such as `git.forge.dashhq.org` fails the TLS handshake (alert 40) unless the zone buys Advanced Certificate Manager. That is why dashhq's gateway is `git-forge.dashhq.org`.
   - When `cloudflared` runs as a container next to the gateway (dashhq does this: a `cloudflared` service in a `docker-compose.override.yml`, its token in a `0600` env file), point the hostname at `http://forge-gateway:8080` instead of `localhost`.
2. Keep `GATEWAY_TRUST_PROXY=cloudflare`.
3. Cache rules: let Cloudflare cache `/badge/*`, `/feed/*` and `/og/*` (they send `Cache-Control: public, max-age=300`; a share page is the same for every client, so caching it is safe). Do **not** cache `*/info/refs`, `*/git-upload-pack` or `*/forge-manifest.json` (they say `no-cache` or `max-age=30`; the default rules already respect that).
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

For seconds instead, point the gateway at a forge-relay's wake stream (the same one forge-runner uses; see [Wake a runner](../../crates/forge-relay/README.md#wake-a-runner)): list the repositories in the relay's `[wake] repos`, share its secret, and set `GATEWAY_WAKE_URL` and `GATEWAY_WAKE_SECRET_FILE`. With the compose file, the secret goes in `services/forge-gateway/wake-secret`, readable by the container's user (`sudo chown 10002:10002 wake-secret && sudo chmod 400 wake-secret`); uncomment the two `secrets` blocks in `docker-compose.yml` and add to `.env`:

```sh
GATEWAY_WAKE_URL=https://relay.example.org
GATEWAY_WAKE_SECRET_FILE=/run/secrets/wake
```

`GATEWAY_WAKE_SECRET_FILE` is the path inside the container. A wake only says "refresh now"; the refresh still reads Platform with proofs, so a relay that is down or lies costs latency and nothing else.

## Routes

| Route | What |
|---|---|
| `GET /<owner>/<name>.git/info/refs?service=git-upload-pack`, `POST …/git-upload-pack` | git smart HTTP (protocol v0 and v2), read only. `CORS: *` on `info/refs` so the web app can verify. |
| `GET /<owner>/<name>.git/forge-manifest.json` | The snapshot's claim (`forge-gateway-manifest/v1`): the served refs with the Platform `refUpdate` behind each, the Platform block of the snapshot, the git packs, and `membersOnlyRefsNotServed` when the repository has members-only branches. `CORS: *`. |
| `GET /<owner>/<name>` | Redirect to the web app's page for the repository. |
| `GET /badge/<owner>/<name>/<kind>.svg` | Badges: `stars`, `ci` (the newest trusted check run per name on the default branch's tip, or `?branch=`), `release` (the latest release's tag), `issues` (open issues; when some are members-only it says so, "3 open (2 members-only)", as the web's Issues tab does). Each also as `.json`, shields.io's [endpoint](https://shields.io/badges/endpoint-badge) format. |
| `GET /feed/<owner>/<name>/<kind>.atom` | Atom feeds: `releases`, `commits` (the default branch), `issues` (issues a maintainer hid are left out). |
| `GET /og/<owner>/<name>[/<short path>]` | A share link: a page with `og:` and `twitter:` tags that sends people on to the same short URL on the web app. See [Share links](#share-links-preview-cards). |
| `GET /og/<owner>/<name>.png` | The repository's 1200×630 card. |
| `GET /og/<owner>/<name>/issues/<n>.png`, `…/pull/<n>.png` | An issue's or pull request's card (the repository's when the item shows nothing). |
| `GET /healthz`, `/readyz`, `/metrics` | Liveness, readiness (with the gateway's `version`), Prometheus metrics. |
| `GET /.well-known/security.txt` | How to report a vulnerability ([RFC 9116](https://www.rfc-editor.org/rfc/rfc9116)): the Dash Forge project's contacts and policy, with this gateway's own `Canonical` URL when `GATEWAY_PUBLIC_URL` is https. If you run your own gateway and want reports about your deployment to reach you, answer this path at your proxy. |

`<owner>` is an identity id or a DPNS name. A README badge: `[![checks](https://git-forge.dashhq.org/badge/alice/project/ci.svg)](https://forge.dashhq.org/alice/project)`.

### Share links (preview cards)

forge.dashhq.org is a static site: a short URL such as `https://forge.dashhq.org/alice/project/issues/7` is first answered with the host's `404.html`, whose script opens the page. People never notice, but Slack, Discord, forums and other link unfurlers read that 404 and show no card. A share link is the same short URL on the gateway under `/og`:

| Share link | Opens |
|---|---|
| `https://git-forge.dashhq.org/og/alice/project` | `https://forge.dashhq.org/alice/project` |
| `https://git-forge.dashhq.org/og/alice/project/issues/7` | `https://forge.dashhq.org/alice/project/issues/7` |
| `https://git-forge.dashhq.org/og/alice/project/pull/7/files` | `https://forge.dashhq.org/alice/project/pull/7/files` |
| `https://git-forge.dashhq.org/og/alice/project/tree/feature%2Fx/src?repo=<id>` | `https://forge.dashhq.org/alice/project/tree/feature%2Fx/src?repo=<id>` |

This scheme is stable: everything after `/og` is the web app's short path (`forge-web/lib/short-url.ts`), owner by DPNS name or identity id, kept exactly as written (a `%2F` in a ref stays one segment). Only a `?repo=<id>` pin is carried along; any other query string is dropped. The page always opens `GATEWAY_WEB_URL` plus that path, never a host taken from the request, so a share link cannot send anyone elsewhere. A path that is not a short URL (a bad `%` escape, a `.` or `..` segment, plain or escaped as `%2e`, characters a short URL never has) answers `404`.

Every share link answers `200` with the same page for every client, crawler or person (a cache in front never mixes two versions): the `og:`/`twitter:` tags, `og:url` naming the share link itself, `<link rel="canonical">` naming the web app's page, a visible link to it and a one-line script that opens it. There is no `<meta http-equiv="refresh">` and `og:url` is not the web app's URL on purpose: Facebook's crawler follows both, and would read the web app's 404 page instead of the card.

What the card shows:

| Link | Card |
|---|---|
| A public repository, or any view of it (`tree/…`, `releases`, …) | `owner/name`, its description, its stars and default branch on the image |
| A public issue or pull request (`issues/<n>`, `pull/<n>`, `pull/<n>/files`, …) | Its title, the start of its body, open / closed / merged / draft, its own image |
| A members-only, specific-people, hidden (by a maintainer, or its author banned), absent or malformed issue or pull request, or one written while a repository made public was still private | Only what the link says: "Issue #7 · owner/name", the repository's image. No title, author, body or count |
| A private, absent or unlisted repository, or one Platform cannot resolve now | The site's own card ("Dash Forge", the web app's `og.png`) |

A card's title and text come only from a document stored in plaintext (no `enc`) and stamped `vis: "public"`; the gateway reads Platform anonymously, so nothing members-only can reach it anyway. The web app's **Copy link** copies the share link for a public repository when the build names a gateway ([Show it in the web app](#show-it-in-the-web-app)); without one, or for a private repository, it copies the plain short URL as before.

Each repository's description and each item's data is read at most once per `GATEWAY_RENDER_TTL_SECS` (while reads succeed; a failing read is retried on the next request, within the rate limits, as for badges) however many views or tabs are shared (an issue costs one read by number, its log of transitions and events, and a read of the repository's bans; a pull request also its base branch's history).

Badges, feeds and previews are cached for `GATEWAY_RENDER_TTL_SECS`. When Platform cannot be read, the last render is served (marked by `Cache-Control: max-age=60` and `X-Forge-Stale: <seconds>`); a badge with nothing cached says `unavailable`.

## Rate limits and abuse controls

- **Per client:** a request budget for every route, a clone budget, at most two clones at once, and a budget for starting new mirrors, so one client cannot fill the disk by walking every repository. An IPv4 client is one address. The request budget keys an IPv6 client by its /64; the clone budget, the concurrent clones and the new-mirror budget (the costly work) by its /48, because free tunnel brokers hand out a /48, whose 65,536 /64s would each get a fresh allowance. Over a limit: `429` with `Retry-After`.
- **Failing repositories:** a repository whose own data fails to refresh (it is over its size cap, its packs are refused, or its fetch stalls past the deadline) is not fetched again while the snapshot that failed (its tips and packs) is unchanged. It waits 1 minute after the first failure, 5 after the second, 30 after the third, then 6 hours, and a success resets it (`GATEWAY_REPOS` mirrors wait at most 30 minutes). During the wait its snapshot (a few proved reads) is looked at at most once a minute, and at once when a relay wake names it; a new push is fetched immediately, backoff or not, and fails into a longer wait if it fails again. After three failures in a row, a new push is tried at most every 5 minutes, so pushing before every attempt cannot keep a refresh slot busy. A failure the helper blames on Platform (error codes E701 to E703, see [errors](../errors.md)) or on the gateway's own Platform reads is not the repository's fault: it does not count, and is retried as before. Unreadable packs (E503) do count: the storage belongs to the repository's owner. Those mirrors refresh on `GATEWAY_PINNED_REFRESH_MAX` permits of their own, and an on-demand repository is held to `GATEWAY_UNPINNED_REPO_MAX` and `GATEWAY_FETCH_MIN_RATE`, so a hostile repository cannot occupy `GATEWAY_REFRESH_MAX` for long or starve the listed ones.
- **Memory:** this bounds the common cases; it does not make one fetch's memory exactly predictable. `git-remote-dash` reads all the packs of a fetch into memory, each capped by the size its manifest declares (at most the repository's cap in total), and indexes each with `index-pack --max-input-size` set to that cap (the helper reads it from the `dash.maxPackInput` git setting, a size such as `268435456` or `256m`, which the gateway passes to its fetch with `git -c`; unset, as for any clone you make yourself, there is no cap). `pack.windowMemory=128m` and `core.bigFileThreshold=32m` (set on every fetch and repack, and in each mirror's config) bound a repack's delta search and large blobs; they do **not** bound the memory of resolving deltas while indexing a pack, so a delta bomb inside a pack of the allowed size can still use much more than the pack. That is why `GATEWAY_REPO_MAX` is far below the container's memory limit. As a last line the gateway starts its fetches and repacks through `sh`, which raises their `oom_score_adj` to 500 (Linux; quietly nothing elsewhere): if the kernel runs out of memory it picks these processes before the gateway and the clones it is serving. It does not set an address-space limit (`RLIMIT_AS` breaks the allocators `git` and the Platform SDK use).
- **Issue and PR cards:** a card for `/og/<owner>/<name>/issues/<n>` (or `pull/<n>`) with `n` above the repository's issue-plus-PR count (they share one sequence; one proved count per repository, cached for a minute) is the repository's card, with no read of the item, so walking fresh numbers costs nothing upstream.
- **Globally:** at most `GATEWAY_CLONES_MAX` clones and `GATEWAY_REFRESH_MAX` refreshes at once; `GATEWAY_REPO_MAX` per repository; `GATEWAY_CACHE_MAX` in total (least recently served evicted first; listed and in-use mirrors never are).
- **Request size and time:** a clone's request body is capped at 16 MiB and must arrive within 30 s; the gateway's clone slots are taken only once it has, so a client that trickles its body holds only its own. Any response must start within `GATEWAY_COLD_WAIT_SECS` plus 120 s, and a clone streams for at most `GATEWAY_SERVE_TIMEOUT_SECS`. The gateway does not time out slow request headers itself (its HTTP server has no such setting); the TLS proxy in front of it reads them first.
- **Surface:** only the routes above. Mirrors are configured `http.getanyfile=false` (no dumb-HTTP file serving) and `http.receivepack=false`; the staging namespace is hidden from the advertisement. The client's address never reaches git.
- **Content:** the gateway serves what Platform's refs point at. Hiding an issue (kinds 24/25) affects the issue feed, not git objects. A takedown is the operator's policy: refuse a repository or an owner with the deny list ([Takedowns](#takedowns-and-hidden-repositories)), without a restart.
- **Outbound requests:** a repository's pack URLs are written by whoever pushed it, so a stranger can make the gateway fetch them. The fetch only follows public `https` URLs, refuses a redirect to anything else, and drops DNS answers that are private, loopback, link-local, CGNAT (100.64/10) or unique-local (fc00::/7) addresses. Do not give the gateway an `HTTPS_PROXY` or `ALL_PROXY`: a proxy resolves names itself, so the DNS check would not apply. Back all of this up with an egress firewall.

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

## Takedowns and hidden repositories

dashhq's gateway may refuse a repository. That is a decision about what dashhq serves, not protocol moderation: the repository stays on Dash Platform, `dash://` and git-remote-dash still read it, and every refusal says so.

### The deny list (`GATEWAY_DENY`)

`GATEWAY_DENY` is the path of a text file. It is optional: unset (or empty), nothing is denied. When it is set, the file must be readable at start (an empty file is fine): the gateway refuses to start otherwise, so a takedown list that cannot be read is never mistaken for an empty one. One entry per line, `#` starts a comment:

```text
# 2026-10-16 notice 41: this repository (a base58 Platform id)
29d2S7vB453rNYFdR5Ycwt7y9haRT5fwVwL9zTmBhfV2
# an owner: every repository of the identity
3JF3sEqM796hk5WFqA6EtmEwJQ9quALszsfJyvXNQKy3
# an owner (id or DPNS name) and a repository name
alice/project
```

An entry is a repository id, an owner identity id (every repository of that owner), or `<owner id or DPNS name>/<repository name>`. A bare entry that is not a Platform id is not stored as one: the line is ignored and logged by its number. Names are compared the way Platform and forge-core compare them, so one spelling in the file covers the others: a repository name is lower-cased and loses `.git` (`Project`, `project.git`); a DPNS name loses `.dash` and is compared in its homograph-safe form (`Alice`, `alice.dash`, `a1ice`). An owner id is exact. These match at once, before any Platform read.

A `<DPNS name>/<name>` entry is also resolved, in the background, to the repository it names, so the request that names that repository by its owner's id is refused too. Until that has run (or when its read failed, or found no such repository the last time it looked), the gateway does not guess: before it serves any repository whose name is a listed name it reads the entry inline, and if it cannot, answers `503` instead of serving it. The list fails closed. At most 4 such inline reads run at once; a request that finds them busy gets the same `503` without a read, so a flood of requests while Platform is failing is not passed on one for one. An entry that found no repository is looked at again after 30 seconds, so a repository created under a listed name can be served by its owner id for up to that long. A DPNS name that was not registered when the gateway first looked it up stays unknown to that process (forge-core caches the miss): restart the gateway after such a name is registered.

- **Reload:** the file is looked at when the gateway starts and again whenever its modification time or size has changed, at most every 5 seconds, so editing it takes effect without a restart. A changed file is applied only once it has not been modified for a second, so a half-written file is not applied: save by writing a temporary file in the same directory and `mv`-ing it over `deny.txt` (an editor's atomic save does the same). A file that is deleted, unreadable or larger than 4 MiB is not applied and the last good list stays (a takedown never lapses because an editor left the file half-written). To lift every entry, empty the file; do not delete it. `/readyz` shows `"deny": {"state": "ok" | "unreadable" | "off", "entries": n}` (`unreadable`: the latest look at the file failed, so the list in force may be out of date), and `/metrics` has the gauges `forge_gateway_deny_entries` and `forge_gateway_deny_unreadable`; alert on the second. In Docker, mount the file's directory (`./deny:/etc/forge-gateway:ro`, `GATEWAY_DENY=/etc/forge-gateway/deny.txt`), not the file: an editor that replaces the file leaves a single-file mount on the old copy. The compose file has the commented lines.
- **Refusal:** the git routes, `forge-manifest.json`, `/badge`, `/feed` and `/og` (every form, images included) answer `451 Unavailable For Legal Reasons` ([RFC 7725](https://www.rfc-editor.org/rfc/rfc7725)), before any Platform read when the request names the entry. `GET /<owner>/<name>` alone only redirects to the web app and is not refused: the web app has its own policy (curation, below). The response is `Cache-Control: no-store`. The body says the repository is not served by this gateway, that this is the operator's decision and not a change to Dash Platform, and that `git clone dash://<owner>/<name>` still works. A `Link: <gateway>; rel="blocked-by"` header names the gateway. A badge shows "not served here".
- **Purge:** the cached mirror directory is deleted (once the clones streaming from it end) and the repository's cached resolutions, renders and counts are dropped, when the list is applied (a check every 5 seconds) and when a request meets the entry. A `GATEWAY_REPOS` entry that is denied is not mirrored. A purged mirror is not made again while the entry stays.
- **Metrics:** `forge_gateway_denied_total` (requests refused with `451`) and `forge_gateway_mirrors_purged_total` (mirrors deleted).
- **Runbook:** (1) append the entry with the notice's date in a comment; (2) save; within seconds `curl -i https://<gateway>/<owner>/<name>.git/info/refs?service=git-upload-pack` answers `451`; (3) check `forge_gateway_mirrors_purged_total` rose and the directory under `<data>/mirrors/<network>/` is gone; (4) in front of the gateway Cloudflare may hold copies of what it served before (badges, feeds and cards are cacheable for `GATEWAY_RENDER_TTL_SECS`, 300 s by default): purge the cache for the denied paths (dashboard, Caching, Configuration, Purge by URL: `/<owner>/<name>.git/…`, `/badge/<owner>/<name>/…`, `/feed/<owner>/<name>/…`, `/og/<owner>/<name>…`); the `451` itself is `no-store`; (5) to restore, remove the line. This does not hide the repository from the web app or other gateways (see below).

### Hidden repositories (curation)

`forge-contracts/config/curation.json` lists repositories and identities that dashhq's builds keep out of their discovery surfaces: the web app's landing page, Explore, search and ranked lists (see `docs/hosted-curation.md`), and this gateway's link previews. It is shared by the web build and the gateway and compiled into both, so a change ships with a rebuilt image. The gateway has no listing page of repositories, so hiding changes only the previews: a hidden repository's (or hidden identity's) share link and card are the site's own, naming nothing of it. Its clones, badges and feeds are still served unless it is also in `GATEWAY_DENY`.

## Monitoring

- `GET /healthz`: `200 ok` while the process serves (the container health check).
- `GET /readyz`: `200` when the newest Platform read succeeded, `503` with `"platform": "failing"` when the newest failed. Mirrors keep serving meanwhile; alert if it stays `503` for more than 10 minutes. The body also carries `"version": {"crate": "0.1.0", "buildSha": "<commit>"}`: `buildSha` is the commit the image was built from when `docker build` was given `--build-arg DASH_FORGE_BUILD_SHA=$(git rev-parse HEAD)` (otherwise `null`), so you can tell which commit is running.
- `GET /metrics` (Prometheus text): requests by route class, clones started and bytes streamed, rate-limited requests, refreshes (ok, failed, changed), mirrors created, evicted and removed because their repository is gone, requests for repositories not served (absent, private and gone counted together, so the counter never confirms a private repository), relay wakes, stale renders, requests refused by the deny list and mirrors it purged, item cards answered without an item read, requests without the trusted proxy header, and gauges for mirrors, ready mirrors, bytes on disk and its cap, clones streaming, and the times of the last Platform success and failure. No series is labelled by repository or client. Suggested alerts: `forge_gateway_cache_bytes > 0.9 * forge_gateway_cache_max_bytes`; a rising `forge_gateway_refresh_failed_total`; `forge_gateway_upstream_last_ok_seconds` older than 15 minutes.

Restrict `/metrics` at the proxy if you do not want it public (it holds no personal data).

## Logs

One line per request: method, path, status and duration. Plus refresh outcomes (repository id, whether refs moved, duration) and warnings.

Never logged: client addresses, user agents, request headers, query strings and request bodies. Client addresses live in memory only, in rate-limit buckets that are dropped once full again: at most two limiter periods after a client's last request (two minutes for the request limits, two hours for the new-mirror limit). git's own output stays inside the gateway (debug level only). `docker compose logs` keeps what Docker keeps: the compose file sets the `local` log driver with `max-size: 50m` and `max-file: 5`, which bounds the log's size (250 MB), not its age. Docker's drivers have no maximum age, so the notice's "kept for 14 days" is true only as far as your traffic fills those files in 14 days or less; with little traffic they hold longer. Either lower `max-size` until five files span about two weeks at your traffic (watch `docker inspect --format '{{.LogPath}}'` and its rotated files), prune older rotations yourself, or word the notice by size. Do not publish "14 days" without one of them.

## Backups and upgrades

Nothing in `GATEWAY_DATA_DIR` needs a backup: every mirror is rebuilt from Platform on its next request. Back up only your `.env` and the wake secret. Losing the volume costs a cold first clone per repository (the dash mirror took 299 s in the prototype).

### Deploy a release

Deploy by tag or, better, by digest, so that what runs is exactly what the release job built and attested:

```sh
# The release's "push forge-gateway image" job prints the digest in its summary; or ask the registry:
docker buildx imagetools inspect ghcr.io/pastapastapasta/forge-gateway:<version>
# Verify where it came from (needs the gh CLI):
gh attestation verify oci://ghcr.io/pastapastapasta/forge-gateway@sha256:<digest> --repo PastaPastaPasta/dash-forge
# In services/forge-gateway/.env:
GATEWAY_IMAGE=ghcr.io/pastapastapasta/forge-gateway@sha256:<digest>
docker compose pull && docker compose up -d
curl -fsS http://127.0.0.1:8080/readyz     # "version": {..., "buildSha": "<the release commit>"}
```

`/readyz` reports `version.buildSha`, the full commit the image was built from. Check it against the release tag's commit (`git rev-parse v<version>^{commit}`) after every deploy, and append the date, the digest and that commit to your deploy log. **Rolling back is one line:** put the previous digest (from that log) in `GATEWAY_IMAGE` and run `docker compose up -d` again. The mirrors on the volume are reused either way, so a rollback costs no cold clones.

The network's contract ids are compiled in (forge-core embeds `forge-contracts/deployments/*.json`), so a gateway needs a release whose deployment files name the network it serves. A Platform reset that changes them needs a new image.

### Upgrades

Upgrade: deploy a new release image (above), or rebuild from source, and `docker compose up -d`. The mirrors on the volume are reused; a mirror whose manifest is missing or from another schema is removed and rebuilt. A mirror is polled after a restart only if it was served within `GATEWAY_WARM_HOURS`; the others refresh on their next request. Mirrors left by an older build start cold. `SIGTERM` stops it gracefully (compose waits 30 s).

## Show it in the web app

The clone box shows the HTTPS URL only when the web build names a gateway:

```sh
NEXT_PUBLIC_GATEWAY_URL=https://git-forge.dashhq.org NEXT_PUBLIC_GATEWAY_LABEL="dashhq gateway" pnpm build
```

`dash://` stays first; the HTTPS line reads "HTTPS via dashhq gateway · plain git, read only, an optional mirror · verify". Without the variable there is no HTTPS line.

The same variable turns **Copy link** on a public repository's pages into a [share link](#share-links-preview-cards) (`https://git-forge.dashhq.org/og/alice/project/issues/7`), which unfurls with a preview card and opens the page. The gateway sends people to its own `GATEWAY_WEB_URL`, so point a build at a gateway whose `GATEWAY_WEB_URL` is that build's site.

For forge.dashhq.org, the Pages workflow (`.github/workflows/pages.yml`) reads the URL and the label from repository variables, so turning the gateway on or off needs no code change:

1. Repository **Settings → Secrets and variables → Actions → Variables**: set `PAGES_GATEWAY_URL` to `https://git-forge.dashhq.org`, and `PAGES_GATEWAY_LABEL` if the default "dashhq gateway" is wrong. Use `https://`: the site's content policy blocks the browser's "verify" check on a plain `http://` gateway.
2. Deploy: **Actions → Deploy forge-web to Pages → Run workflow** on master (or push to master). Don't re-run an older run: that deploys its older commit.

Delete the variable and deploy again to hide the HTTPS line. A value that is not an `https://` or `http://` URL, or that carries a query, a fragment or credentials, is ignored, and the row stays hidden. Set it only once the gateway answers: the clone box doesn't check that the gateway is up before it shows the row.

## Measured on a devnet

See the PR that added the gateway for the run's numbers (cold and warm clones of the dash mirror and of dips through a local gateway, HEAD checked against Platform). The prototype measured 299 s for the first proof-verified mirror of dash and 16 s for each later plain clone.

## Billing (later)

The MVP is free with rate limits. A paid tier is a later spike, and needs no contract change in this service:

- **What would be sold:** a "warm" tier per repository (prefetch on push through relay wakes, bitmaps kept current, higher limits, a vanity alias), about 0.01 DASH per repository per 30 days.
- **How it would be paid:** a prepaid credit transfer to the operator's service identity, or Platform's `actionFees` on an operator-owned subscription contract (`forge-svc`). The gateway would read the payer's subscription with proofs, as it reads everything else.
- **The open question:** whether the JS and Rust SDKs can build `$actionFeeAgreement` yet. That spike comes before any billing code.

## Privacy notice (draft)

> **Dash Forge gateway: privacy notice**
>
> The gateway at `git-forge.dashhq.org` is run by dashhq. It serves read-only copies of **public** Dash Forge repositories, which anyone can already read on Dash Platform.
>
> **What we process.** To answer a request we see your IP address, the URL you request and your client's request headers. We use your IP address only to apply rate limits, in memory, for at most two hours after your last request. We do not log IP addresses, user agents or request headers. Our logs record the requested path, the response status and its duration, and are kept for 14 days.
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
2. **The hostname:** `git-forge.dashhq.org` (or another), added as a public hostname on a Cloudflare tunnel → `http://localhost:8080` (dashboard step, or a Cloudflare API token scoped to the tunnel and the `dashhq.org` DNS zone).
3. **Build and start:** the commands under [Run it](#run-it), with `GATEWAY_PUBLIC_URL=https://git-forge.dashhq.org`.
4. **Optional, for seconds-fresh mirrors:** a forge-relay with `[wake]` listing the repositories, and its secret in `GATEWAY_WAKE_SECRET_FILE`.
5. **The web app:** set the repository variable `PAGES_GATEWAY_URL` (and `PAGES_GATEWAY_LABEL`), then deploy ([Show it in the web app](#show-it-in-the-web-app)).
6. **An abuse and privacy contact,** filled into the privacy notice, and the notice published (for example on the gateway's index page or the docs site).
7. **Software Heritage (optional):** ask SWH to allowlist the gateway's domain, so public repositories can be archived from their HTTPS URLs.
