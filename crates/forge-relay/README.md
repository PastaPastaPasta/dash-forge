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

This writes a forge-collab `webhook` document. **The URL and event list are public on
chain**; `dg` refuses a URL with a query string or `user:password@` unless `--force`, so do
not put tokens in it (the signature authenticates deliveries). The `secret` (32–96 printable
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

(A full bridge identity file works too; only its ENCRYPTION keys are read.) Mount it read-only:

```sh
docker build -f crates/forge-relay/Dockerfile -t forge-relay .   # or ghcr.io/pastapastapasta/forge-relay:<version>
docker run --rm --read-only \
  -v "$PWD/relay-key.json:/id/relay.json:ro" \
  forge-relay --identity /id/relay.json --network testnet
# a devnet: --network devnet --devnet-name moutai
```

| Flag | Default | Meaning |
|---|---|---|
| `--identity <file>` | none | Relay key file. Without it only static `[[webhook]]` blocks from `--config` are served. |
| `--repos a/b,<repoId>` | all | Serve only these repos. |
| `--poll-interval <s>` | 15 | Seconds between polls. |
| `--refresh-cycles <n>` | 4 | Re-read the webhook documents every n polls. |
| `--lookback <n>` | 0 | At startup, deliver the last n documents of each stream. |
| `--listen <addr>` | off | Health endpoint (`200 ok`). |
| `--allow-private` | off | Deliver to private and loopback addresses. **Local testing only**: without it, any maintainer of any repo could make a public relay probe its network. |
| `--state-dir <dir>` | `$FORGE_RELAY_STATE_DIR`, else `$XDG_STATE_HOME/dash-forge/relay`, else `~/.local/state/dash-forge/relay` | Where the retry queue lives. In Docker, mount a volume here (`-v relay-state:/state --state-dir /state`) to keep retries across container restarts. |
| `--config <toml>` | none | The same settings as a file, plus static `[[webhook]]` blocks (`repo`, `url`, `events`, plaintext `secret`) for local testing, and `retry-schedule-secs = [60, 300, ...]`. |

## Delivery semantics

- **At-least-once, with a durable retry queue.** Each delivery gets up to 5 attempts within
  30 s. If they all fail, the delivery goes to the relay's **retry queue** on local disk and
  is retried 1 min, 5 min, 30 min, 2 h, 12 h and 24 h later (then every 24 h), across
  restarts, until it succeeds or is 48 h old; then it is dropped with one `DEAD-LETTER` log
  line. See [Delivery queue](#delivery-queue).
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
- No state on disk. A restart starts from "now" (or `--lookback` for the repo-level
  streams). A repo first served while the relay runs is read from its earliest hook's
  `$createdAt`, never from before the relay started; a repo that drops out and returns
  resumes where it stopped, but not before its hook's own `$createdAt` (nothing from while a
  hook was disabled). A stream only some hooks need (comments, reviews, check runs) starts no
  earlier than the earliest hook that wants it.
- What is reported: a `push` only for a ref update that moves its ref by forge's rules (a
  plain `refUpdate` on a protected branch is inert and is not reported). A merge is
  `merged: true` only when a valid update set the PR's base branch to its commit (and the PR's
  `baseRefNameHash` matches its `baseRefName`); otherwise `merged: false` with
  `dash_merge_unverified: true`. A yanked release is `release` / `unpublished`.
- Comments and reviews: per cycle and repo, up to 40 open or recently active threads, plus 10
  of the others in rotation, so a quiet closed thread is read every few cycles (with N such
  threads, every N/10 cycles).
- Check runs: for the 50 most recent heads (pushed commits, PR heads seen live or opened in the
  last 7 days), runs created after the head was first watched. A `checkRun` updated in place
  (status progression) is not observed; only new documents are seen.
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
  never delivered.
- **Retention:** pending entries are dropped after 48 h. At most 500 pending entries per hook,
  5000 in total and 256 MiB of bodies; past a bound the oldest are dropped with a log line.
  Dropped entries are kept without their body for 7 days (at most 1000) so you can see what
  was lost.
- **Inspect it** (reads the files only; no network):

  ```sh
  forge-relay deliveries [--state-dir <dir>] [--json]
  ```

  It lists each pending or dropped delivery: status, hook id, repo, event, attempts, time
  to the next attempt, age, and the last error or drop reason.
- **Schedule:** the default is 1 min, 5 min, 30 min, 2 h, 12 h, 24 h. `retry-schedule-secs` in
  the config file, or `FORGE_RELAY_RETRY_SCHEDULE=10,20` (comma-separated seconds, for
  testing), overrides it.
