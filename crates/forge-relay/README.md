# forge-relay

Delivers forge-v2 repository activity as GitHub-shaped webhooks (`push`, `issues`,
`pull_request`, `issue_comment`, `pull_request_review`, `release`, `check_run`), signed
with `X-Hub-Signature-256`. A relay is trusted for availability only: consumers verify what a
webhook says against Platform (see `examples/ci_consumer.rs`). forge-v1 repositories are
read-only and are not served.

## How a hook reaches a relay

A maintainer adds a hook:

```sh
dg webhook add <owner>/<repo> --url https://ci.example/hook \
   --relay <relay identity id> --events push,pull_request --name ci
# no --secret-env: a random secret is generated and printed once
```

This writes a forge-collab `webhook` document. Its `secret` is encrypted (`encryptedFor`,
`ecdh-secp256k1-aes256-cbc`) from the maintainer's ENCRYPTION key to the relay identity's
ENCRYPTION key. The relay:

1. finds every hook addressed to its identity (the `relay` index) and resolves each hook to its
   newest document per `(repoId, hookId)`, across all relays, so re-pointing a hook to another
   relay stops this one; disabled hooks stop too;
2. requires the hook's writer to be a maintainer **now** (a revoked maintainer's hook stops);
3. decrypts the secret in memory with its ENCRYPTION private key and the writer's ENCRYPTION
   public key, and checks the plaintext is 32..=96 bytes (the scheme has no authentication tag);
4. polls those repos every `--poll-interval` seconds and re-reads the hooks every
   `--refresh-cycles` cycles.

To move a repo to another relay, run `dg webhook add` again with the same `--name` and
`--relay <other relay>`. To stop it, run `dg webhook remove <owner>/<repo> ci`.

## Run it

The relay identity is a bridge-format identity file with an `ECDSA_SECP256K1` ENCRYPTION key
(key 4 on bridge exports). The relay reads its keys and never signs or spends, so its balance
can be zero. Mount the file read-only:

```sh
docker build -f crates/forge-relay/Dockerfile -t forge-relay .   # or ghcr.io/pastapastapasta/forge-relay:<version>
docker run --rm --read-only \
  -v "$PWD/relay.identity.json:/id/relay.json:ro" \
  forge-relay --identity /id/relay.json --network testnet
# a devnet: --network devnet --devnet-name moutai
```

| Flag | Default | Meaning |
|---|---|---|
| `--identity <file>` | none | Relay identity. Without it only static `[[webhook]]` blocks from `--config` are served. |
| `--repos a/b,<repoId>` | all | Serve only these repos. |
| `--poll-interval <s>` | 15 | Seconds between polls. |
| `--refresh-cycles <n>` | 4 | Re-read the webhook documents every n polls. |
| `--lookback <n>` | 0 | At startup, deliver the last n documents of each stream. |
| `--listen <addr>` | off | Health endpoint (`200 ok`). |
| `--allow-private` | off | Deliver to private and loopback addresses. **Local testing only**: without it, any maintainer of any repo could make a public relay probe its network. |
| `--config <toml>` | none | The same settings as a file, plus static `[[webhook]]` blocks (`repo`, `url`, `events`, plaintext `secret`) for local testing. |

## Delivery

- At-least-once. `X-GitHub-Delivery` is derived from the hook id and the source document id,
  so every relay sends the same id for the same document; dedupe on it.
- No state on disk. A restart starts from "now" (or `--lookback`). A repo whose first hook
  appears while the relay runs is read from that hook's `$createdAt`.
- SSRF guard: http(s) only, no userinfo, private/loopback/link-local/CGNAT/multicast and
  IPv6 forms embedding them (mapped, 6to4, NAT64, Teredo) refused, DNS resolved once and the
  connection pinned to the validated addresses, redirects and proxies off.
- At most 2 deliveries in flight per destination host, 30 s budget per delivery (5 attempts
  with backoff), bodies capped at 1 MiB. A delivery that fails every attempt is logged as
  `DEAD-LETTER`.
- Logs never contain secrets or payload bodies; URLs are logged without their query.
