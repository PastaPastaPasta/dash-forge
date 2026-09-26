# forge-relay

Delivers forge-v2 repository activity as GitHub-shaped webhooks (`push`, `issues`,
`pull_request`, `issue_comment`, `pull_request_review`, `release`, `check_run`), signed
with `X-Hub-Signature-256`. A relay is trusted for availability only: consumers verify what a
webhook says against Platform (see `examples/ci_consumer.rs`, which folds the pushed ref's
history and checks the tip). forge-v1 repositories are read-only and are not served.

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
| `--config <toml>` | none | The same settings as a file, plus static `[[webhook]]` blocks (`repo`, `url`, `events`, plaintext `secret`) for local testing. |

## Delivery semantics

- **Best effort, with retries inside one window.** Each delivery gets up to 5 attempts with
  backoff within 30 s; then it is logged as `DEAD-LETTER` and dropped. There is no durable
  queue: nothing is retried later, and events queued when the relay stops are lost.
- `X-GitHub-Delivery` is derived from the hook id and the source document id, so every relay
  sends the same id for the same document; dedupe on it.
- Polling never waits on a receiver. Each hook has its own worker and queue (256 events;
  beyond that, events are dead-lettered). After 3 failed deliveries in a row a hook's circuit
  opens for 1 minute, doubling up to an hour while it keeps failing; one success closes it.
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
