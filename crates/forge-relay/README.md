# forge-relay

Delivers forge-v2 repository activity as GitHub-shaped webhooks (`push`, `issues`,
`pull_request`, `issue_comment`, `pull_request_review`, `release`, `check_run`), signed
with `X-Hub-Signature-256`. A relay is trusted for availability only: consumers verify what a
webhook says against Platform (see `examples/ci_consumer.rs`, which folds the pushed ref's
history and checks the tip).

## How a hook reaches a relay

A maintainer adds a hook:

```sh
dg webhook add <owner>/<repo> --url https://ci.example/hook \
   --relay <relay identity id> --events push,pull_request --name ci
# no --secret-env: a random secret is generated and printed once
```

This writes a forge-community `webhook` document. **The URL and event list are public on
chain**; the contract accepts only `https://` to a DNS name (no IP address, `localhost` or
`user:password@`), and `dg` refuses a query string unless `--force`, so do not put tokens in
it (the signature authenticates deliveries). Private repositories cannot have webhooks. For
local tests against `http://127.0.0.1`, use a static `[[webhook]]` block in `--config`
(below): it never goes on chain. The `secret` (32–96 printable
ASCII characters) is encrypted (`encryptedFor`, `ecdh-secp256k1-aes256-cbc`) from the
maintainer's ENCRYPTION key to the relay identity's ENCRYPTION key. The relay:

1. finds every hook addressed to its identity (the `relay` index) and resolves each hook to its
   newest document per `(repoId, hookId)`, across all relays, so re-pointing a hook to another
   relay stops this one; disabled hooks stop too;
2. requires the hook's writer to be a maintainer **now** (a revoked maintainer's hook stops);
3. decrypts the secret in memory with its ENCRYPTION private key and the writer's ENCRYPTION
   public key, and requires 32–96 printable ASCII bytes (the scheme has no authentication tag;
   this is what rejects a wrong key);
4. polls those repos every `--poll-interval` seconds and re-reads the hooks every
   `--refresh-cycles` cycles.

To move a repo to another relay, run `dg webhook add` again with the same `--name` and
`--relay <other relay>`. To stop it, run `dg webhook remove <owner>/<repo> ci`.

## Run it

The relay needs only its identity id and its ENCRYPTION private key; it never signs or spends,
so its balance can be zero. Give it a **relay-only key file** rather than a full identity
export, so the host holds no signing keys or mnemonic:

```json
{ "identityId": "<base58 identity id>",
  "identityKeys": [ { "id": 4, "purpose": "ENCRYPTION", "privateKeyHex": "<64 hex>" } ] }
```

(A full bridge identity file works too; only its ENCRYPTION keys are read.) The ENCRYPTION key
must be unbound or bound to forge-community, the contract `webhook` lives in: a maintainer's
`dg webhook add` encrypts to such a key only. Mount it read-only:

```sh
docker build -f crates/forge-relay/Dockerfile -t forge-relay .   # or ghcr.io/pastapastapasta/forge-relay:<version>
docker run --rm --read-only \
  -v "$PWD/relay-key.json:/id/relay.json:ro" \
  -v relay-state:/state \
  forge-relay --identity /id/relay.json --network testnet
# a devnet: --network devnet --devnet-name bonsia
```

Both images keep the retry queue in `/state` (`FORGE_RELAY_STATE_DIR=/state`, owned by the
image's non-root user, mode 0700). The named volume `relay-state` keeps pending retries across
container restarts; a fresh named volume takes the image's ownership. Without `-v ...:/state`,
Docker gives the container an anonymous volume there, which `--rm` deletes.

If the state dir cannot be used (not writable, a symlink, or owned by another user; a
directory of the relay user's with looser permissions is tightened to 0700):

- when it was set explicitly (`--state-dir`, or `state-dir` in the config file) the relay
  exits with an error;
- when it is the default (including `FORGE_RELAY_STATE_DIR`, which the images set, so a
  container without a usable `/state` still runs), the relay starts on an
  in-memory queue: retries work but are lost on restart. It logs a warning on every start, and
  the health endpoint reports `"durable": false`.

**Upgrading from an image without `/state`:** a `relay-state` volume that an older image
created (or that was first mounted somewhere else) can be owned by root, which the non-root
relay cannot write. Give it to the image's user once, then start the relay as usual:

```sh
# the release image (ghcr.io/...; distroless, user nonroot = uid 65532)
docker run --rm -v relay-state:/state busybox sh -c 'chown 65532:65532 /state && chmod 700 /state'
# an image built from crates/forge-relay/Dockerfile (user relay = uid 10001)
docker run --rm -v relay-state:/state busybox sh -c 'chown 10001:10001 /state && chmod 700 /state'
```

`docker stop` (SIGTERM) and ctrl-c stop the relay gracefully: it stops delivering, writes each
hook's undelivered events (the in-flight one and those still in its in-memory queue) to the
retry queue, due at once, and flushes it to disk, within 5 s of the signal.

| Flag | Default | Meaning |
|---|---|---|
| `--identity <file>` | none | Relay key file. Without it only static `[[webhook]]` blocks from `--config` are served. |
| `--repos a/b,<repoId>` | all | Serve only these repos. |
| `--poll-interval <s>` | 15 | Seconds between polls. |
| `--refresh-cycles <n>` | 4 | Re-read the webhook documents every n polls. |
| `--lookback <n>` | 0 | At startup, deliver the last n documents of each stream. |
| `--listen <addr>` | off | Health endpoint: `200` with `{"status":"ok","durable":true}` (`durable` is false when the retry queue fell back to memory). Also serves runner wake-ups (`GET /v1/wake`) when `[wake]` is configured: see [Wake a runner](#wake-a-runner). |
| `--allow-private` | off | Deliver to private and loopback addresses. **Local testing only**: without it, any maintainer of any repo could make a public relay probe its network. |
| `--state-dir <dir>` | `$FORGE_RELAY_STATE_DIR` (`/state` in the images), else `$XDG_STATE_HOME/dash-forge/relay`, else `~/.local/state/dash-forge/relay` | Where the retry queue lives (`<dir>/deliveries`: a real directory owned by the relay user, created or tightened to mode 0700). Setting it explicitly makes an unusable dir fatal instead of a fallback to memory. One relay per state dir: a second relay on the same dir refuses to start. |
| `--web-base-url <url>` | `https://forge.dashhq.org` | The forge-web origin that the payloads' `html_url`, `compare` and profile links point at. Include the base path of a sub-path deploy (`https://<owner>.github.io/dash-forge`). File key: `web-base-url`. See [Payloads](#payloads). |
| `--config <toml>` | none | The same settings as a file, plus `[wake]` ([Wake a runner](#wake-a-runner)), static `[[webhook]]` blocks (`repo`, `url`, `events`, plaintext `secret`) for local testing, and `retry-schedule-secs = [60, 300, ...]`. |

## Wake a runner

A [forge-runner](../../docs/guides/self-host-runner.md) polls its repositories every
`interval_secs` (two minutes by default). Your relay can wake it as soon as it sees a push, so a
run starts within seconds. The runner connects to the relay (no port is opened on the runner's
machine), so it works behind NAT. There is no central service: you run the relay, and your
runner subscribes to it.

```toml
# relay.toml (forge-relay run --config relay.toml --listen 0.0.0.0:8080)
[wake]
repos = ["alice/project"]            # owner/name or repo ids; polled even without a webhook
secret-file = "/run/secrets/wake"    # or secret = "…": 32–96 printable ASCII characters
```

```toml
# runner.toml
[relay]
url = "http://relay:8080"            # the relay's --listen address (http or https, no path)
secret_file = "/etc/forge-runner/relay.secret"   # the same secret
```

`openssl rand -hex 32` makes a good secret. `[wake]` needs `--listen`: the wake endpoint is
`GET /v1/wake` on the same listener as the health check.

- **A wake carries no trust.** It only tells the runner to poll a repository now. The runner
  reads the refs from Platform proofs, as on any poll, and runs only what that read shows. A
  relay that is down, lies or is impersonated costs latency, never a run. Polling stays on:
  every `interval_secs`, whatever the relay says.
- **Authentication.** Each request is a long-poll signed with the shared secret: HMAC-SHA256
  over the path and query (with a fresh nonce) and the time, in `X-Forge-Wake-Time` and
  `X-Forge-Wake-Signature` (`sha256=` and 64 lowercase hex digits). The relay refuses a request
  more than 5 minutes off its clock, so keep both clocks in sync (NTP), or one whose signature
  it has seen. Each answer is signed over the request's signature and the body, so the runner
  refuses a forged or replayed answer. The secret never crosses the wire. Someone on the
  network path can still hold wake-ups back, which only costs latency; use https or a private
  network to keep that and the fact of activity private.
- **What a runner learns.** Which configured repositories had a push (`{"cursor", "resync",
  "repos": [{"id", "name", "label"}]}`), all public chain data. The relay keeps the last 1,024
  wakes. A runner whose cursor is older, or from before a relay restart, is told `resync` and
  polls everything at once (and again 20 s later, as after any wake).
- **Names must match.** A runner matches a woken repository by its `repo` in runner.toml,
  which must equal either the relay's `[wake] repos` entry or `<owner id>/<name>`. It logs the
  names once when a wake matches none of its repositories.
- **Limits.** 256 connections at once; 64 requests held open, more get `503` and the runner
  retries. A request head is capped at 8 KiB and 10 s. Wakes arriving within 300 ms are
  answered together.

## Payloads

The bodies reuse GitHub's field names and shapes, so a GitHub webhook parser (go-github,
octokit) reads them:

- **Ids are integers.** Every `id` (repository, issue, pull request, comment, review,
  release, check run, user) is an integer from 1 to 2^53 − 1: the first 8 bytes of
  `sha256(<base58 Platform id>)`, big-endian, masked to 53 bits. It fits `int64`, JavaScript
  reads it exactly, and every relay derives the same one. The base58 document or identity id
  is in `node_id` (GitHub's opaque global id), and `repository.dash_repo_id` repeats the repo's.
  Verify against the Platform id you configured, never the payload's.
- **Links** point at forge-web's routes under `--web-base-url`:

  | Field | Link |
  |---|---|
  | `repository.html_url`, `repository.url` | `/repo/?owner=<owner id>&name=<name>` |
  | `issue.html_url` | `/repo/issue/?owner=…&name=…&number=<n>` |
  | `pull_request.html_url` (and `issue.html_url` of a PR) | `/repo/pull/?owner=…&name=…&number=<n>` |
  | `comment.html_url`, `review.html_url` | the issue or PR (forge-web has no per-comment anchor) |
  | `release.html_url` | `/repo/release/?owner=…&name=…&tag=<tag>` |
  | `push.compare` | the pushed commit, `/repo/commit/?owner=…&name=…&oid=<after>` (forge-web has no compare page); the repo for a branch deletion |
  | `check_run.html_url` | its commit, `/repo/commit/?…&oid=<head_sha>` (no page per check run) |
  | `sender.html_url`, `user.html_url`, `owner.html_url` | `/u/?name=<identity id>` |

## Delivery semantics

- **Retried durably once a delivery has failed; events not yet attempted at shutdown are
  lost.** Each delivery gets up to 5 attempts within 30 s. If they all fail, the delivery goes
  to the relay's **retry queue** on local disk and is retried 1 min, 5 min, 30 min, 2 h, 12 h
  and 24 h later (then every 24 h), across restarts, until it succeeds or is 48 h old; then it
  is dropped with one `DEAD-LETTER` log line. A graceful stop (SIGTERM, ctrl-c) also writes
  the events still waiting in a hook's in-memory queue, or in flight; a crash or `kill -9`
  loses them, and documents not yet polled are not replayed either (cursors are not persisted;
  see "No cursor state" below). A failure retrying cannot fix is not queued: a body over
  1 MiB, a receiver answering 4xx other than 408 or 429, or a URL the SSRF guard refuses (also
  when its host resolves to a private address, even briefly), is logged as `DEAD-LETTER` at
  once; a host that does not resolve is retried. See [Delivery queue](#delivery-queue).
- `X-GitHub-Delivery` is derived from the hook id and the source document id, so every relay
  and every retry sends the same id for the same document; dedupe on it.
- Polling never waits on a receiver. Each hook has its own worker and in-memory queue (256
  events; beyond that, events go to the retry queue). After 3 failed deliveries in a row a
  hook's circuit opens for 1 minute, doubling up to an hour while it keeps failing; one
  success closes it. While it is open, the hook's new events and retries wait in the retry
  queue until it closes (they are not spent against it).
  Each attempt takes a slot (2 per destination host and address, 8 per address) and frees it
  before backing off; an attempt that waits 5 s for a slot is retried. Known limit: receivers
  behind one shared CDN/anycast address share its 8 slots, so a few slow tenants there can
  delay another one's deliveries (at worst to a `DEAD-LETTER`, which does not open its
  circuit). A removed or disabled hook's queued events are dropped.
- Repos are polled concurrently (8 at a time), each within a 20 s budget per cycle, checked
  between streams; a poll cut short resumes at the stage it stopped in. Discovery runs in its
  own task, and a new repo is polled only once its hooks are registered.
- No cursor state on disk (only the retry queue, and the check runs seen, below). A restart
  starts from "now" (or `--lookback` for the repo-level streams). A repo first served while the relay runs is read from its earliest hook's
  `$createdAt`, never from before the relay started; a repo that drops out and returns
  resumes where it stopped, but not before its hook's own `$createdAt` (nothing from while a
  hook was disabled). A stream only some hooks need (comments, reviews, check runs) starts no
  earlier than the earliest hook that wants it.
- What is reported: a `push` only for a ref update that moves its ref by forge's rules (a
  plain `refUpdate` on a protected branch is inert and is not reported). A merge is
  `merged: true` when a member's transition landed a merge, even one an unverified base-branch
  update could not confirm (`merged` is the chain fact); an unverified merge instead adds
  `dash_merge_unverified: true`. A lock or unlock on an already-merged PR keeps reporting
  `merged: true`. A newly-yanked release is `release` / `unpublished`; a further edit of one
  already yanked is `edited`, not a repeated `unpublished`.
- Comments and reviews: per cycle and repo, up to 40 open or recently active threads, plus 10
  of the others in rotation, so a quiet closed thread is read every few cycles (with N such
  threads, every N/10 cycles).
- Check runs: for the 50 most recent heads (pushed commits, PR heads seen live or opened in the
  last 7 days), each cycle reads the head's `checkRun` documents from its oldest run not yet
  completed (or its newest run, when all have completed; never past its newest 400), at most
  5 pages per head and cycle, and compares each one's `$revision` with the last seen. So a run
  a runner replaces in place (`queued` → `in_progress` → `completed`) is observed even behind
  hundreds of newer runs, and a quiet head costs one short read. A run that disappears while
  open (deleted) stops holding the read's start; an open run with more than 400 newer runs
  behind it is given up.
  - Actions: GitHub's `check_run` has four; a repository webhook gets only `created` and
    `completed` (`rerequested` and `requested_action` are GitHub-UI requests to a GitHub App,
    which Forge has no analogue of). The relay sends `created` for a run first seen (created
    after the head was first watched), and `completed` when its status becomes `completed`:
    on a run created already completed (after its `created`), or on a replace of one that was
    not. A replace to `in_progress`, or an edit of a completed run, has no GitHub action and is
    not sent.
  - Re-runs: a re-run is a new `checkRun` document, as on GitHub (re-running a check creates a
    new check run), and gets its own `created` and `completed`. forge-community's `checkRun` is
    monotonic: a completed run is final (`dg ci report` of a finished run starts a new one).
  - Delivery ids: `created` uses the document id, `completed` the document id plus the
    `$revision` seen completed. Two relays that first see a completed run at different
    revisions send different ids, so dedupe on `check_run.id` and `status` as well.
  - Who may post: consensus admits a `checkRun` create and every replace only from a current
    `runner`, `maintainer` or `writer` of the repo, so a revoked runner cannot advance its
    runs, and the relay adds no filter of its own.
  - **Persisted:** the watched heads and the runs seen are kept in
    `<state dir>/check-runs/<repo id>.json` (when the retry queue is durable) and restored at
    startup, so a restart does not re-send a run, and a run it knew that completed while it
    was down is sent `completed`. Runs created while it was down are not replayed, as for
    every other stream. Heads first seen more than 7 days ago are not restored.
  - **Hooks removed and re-added:** while no hook of a repo wants `check_run` (or the repo is
    no longer served), what was seen is dropped. A hook added later starts from its own time:
    runs created before it are not sent, and a run that was already open when it was added
    does not get `completed` either.
- SSRF guard: http(s) only, no userinfo, private/loopback/link-local/CGNAT/multicast and
  IPv6 forms embedding them (mapped, 6to4, NAT64, Teredo) refused, DNS resolved once and the
  connection pinned to the validated addresses, redirects and proxies off. Bodies are capped
  at 1 MiB.
- Logs never contain secrets or payload bodies; URLs are logged as scheme and host only.

## Delivery queue

The retry queue is local to your relay: one JSON file per delivery in
`<state dir>/deliveries/`, the directory mode 0700 and each file 0600. Nothing is sent
anywhere else.

- **What is stored:** the delivery id, repo id, hook id, event name, source document id, the
  JSON body (built from public chain data), attempt count, times, and the last error (URLs
  reduced to scheme and host). **Not** the secret and not the URL.
- **Retries** go through the hook's *current* subscription: they are signed with its current
  secret and sent to its current URL, through the same SSRF guard (resolved again and pinned).
  If the hook was removed or disabled meanwhile, the entry is dropped with a log line and
  never delivered. So **changing a hook's URL redirects its queued events (up to 48 h of
  them) to the new URL, signed with the new secret.** The bodies are public chain data; if
  the new receiver must not get the old events, remove the hook and add a new one (a new hook
  id) instead of re-pointing it.
- **Retention:** pending entries are dropped after 48 h. At most 500 pending entries per hook,
  1000 per repo, 5000 in total and 256 MiB of bodies. Past a hook's or repo's bound its own
  oldest entry is dropped; past a global bound, the oldest entry of the repo holding the most,
  so one busy or hostile repo cannot push out the others' retries. Every drop logs a line.
  Dropped entries are kept without their body for 7 days (at most 1000) so you can see what
  was lost.
- **Inspect it** (reads the files only; no network):

  ```sh
  forge-relay deliveries [--state-dir <dir> | --config <toml>] [--json]
  ```

  It works while the relay runs (it takes no lock).

  It lists each pending or dropped delivery: status, hook id, repo, event, attempts, time
  to the next attempt, age, and the last error or drop reason.
- **Schedule:** the default is 1 min, 5 min, 30 min, 2 h, 12 h, 24 h. `retry-schedule-secs` in
  the config file, or `FORGE_RELAY_RETRY_SCHEDULE=10,20` (comma-separated seconds, for
  testing), overrides it; each delay must be 1 s to 48 h.
