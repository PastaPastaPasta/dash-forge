# PRD 02 — git-remote-dash & forge-cli (`dforge`)

Two Node ≥ 18 executables from one codebase, both thin shells over **forge-core**.

## A. git-remote-dash (remote helper)

### What it is
A [git remote helper](https://git-scm.com/docs/gitremote-helpers) named `git-remote-dash`, on `$PATH`. Git invokes it for any remote whose URL starts with `dash://`. Users get native `git clone / fetch / push / pull` with zero new commands.

### URL scheme
```
dash://<owner>/<repo>            # owner = DPNS label ("alice") or base58 identity id
dash://<owner>/<repo>#<network>  # optional network override (testnet default until mainnet GA)
```

### Helper protocol implementation
- Capabilities advertised: `fetch`, `push`, `option`, `list` (stateless-connect not needed; we implement the dumb-ish `fetch`/`push` capability pair which lets the helper manage objects directly).
- `list` / `list for-push`: resolve repo → authorized ref heads (forge-core authz resolution) → print `<oid> <refname>` lines + `@refs/heads/<default>` HEAD symref.
- `fetch <oid> <ref>`: compute needed packs from manifests (want/have negotiation against local odb), download (adapter failover), sha256-verify, `git index-pack --stdin` into the local repo.
- `push <src>:<dst>`: `git pack-objects --thin --revs` for `dst`-tip..`src`; upload per storage tier; write `pack` manifest + `refUpdate` (with `prevOid` = last known remote tip; refuse non-FF without `+`/`--force`). Delete ref: `refUpdate` with zero OID.
- Options honored: `option verbosity`, `option progress`, `option dry-run`.

### Auth & signing
- Identity/key discovery order: `DASH_FORGE_KEY` env (WIF) → `~/.config/dash-forge/identities/<network>/<identity>.json` (bridge-export format, optionally encrypted with OS keychain) → interactive prompt.
- Signs with AUTHENTICATION/HIGH key. Writes use yappr's idempotent ST pattern (persist signed bytes in `.git/dash-forge/pending/` for crash-safe rebroadcast).
- Push to a repo without authorization fails fast with a clear message (client-side check before spending fees).

### Performance requirements
- Clone 10 MiB repo (Tier X, IPFS gateway): < 90 s. Fetch no-op: < 3 s (refs query only).
- Tier P push: pipeline chunk STs with sequential nonces (target ≥ 3 docs/s sustained; Phase 0 spike validates; fallback: serial with progress meter).
- All pack downloads cached/reused via local git odb — the helper never re-downloads objects git already has.

## B. forge-cli (`dforge`)

Repo/identity management that doesn't belong in git's porcelain. Command tree:

```
dforge identity import <file.json>        # bridge-export JSON → local keystore
dforge identity list|balance|topup-info   # balance in credits + DASH; points to bridge for topup
dforge repo create <name> [--storage external|platform|hybrid] [--description …]
dforge repo list [--owner <name>] | info | delete        # delete = docs cleanup + refunds
dforge repo set-storage <name> <mode>
dforge collab add <repo> <identity|dpns> --role write|maintain
dforge collab remove|list <repo>
dforge storage login ipfs-storacha|ipfs-pinata|s3        # provider credentials (local keychain)
dforge storage status <repo>              # pack availability audit: probe every URI, report health
dforge reseed <repo> [--to ipfs|s3]       # re-upload local packs, publish packMirror docs
dforge repack <repo>                      # consolidate packs, publish supersedes, prune own old docs
dforge cost estimate <path|--pack size>   # credits/DASH quote per tier before pushing
dforge issue list|view|create <repo>      # minimal CLI issue access (web is primary surface)
dforge doctor                             # connectivity, contract IDs, key sanity, WASM health
```

### Requirements
- `--json` output flag on every command (scripting/e2e).
- `--network testnet|mainnet` global flag; config file `~/.config/dash-forge/config.toml`.
- Cost estimates use the fee constants from research doc §4 and print both prepaid and refundable amounts.
- `repo delete` prompts with total refund estimate; `--yes` for automation.
- Never prints private keys; `identity export` requires explicit `--reveal-secrets`.

## Shared: forge-core library requirements (the substance behind both)

1. **PlatformClient**: evo-sdk singleton (init/reconnect per yappr `evo-sdk-service.ts`), contract preload, network switch.
2. **WriteEngine**: build→sign→persist→broadcast→wait→retry; nonce serialization + pipelining mode; error taxonomy port from yappr `error-utils.ts`.
3. **Services**: RepoService, RefService (authz resolution `AUTHZ_RULES_V1` + test vectors), PackService (manifest planning, supersedes graph), CollabService, IssueService, EventFold (issue/PR state reducer).
4. **PackPipeline**: pack build (spawn system `git` in CLI; isomorphic-git in browser), sha256, chunker (≤ 15,360 B/doc, ST-size assertion), assembler + verifier.
5. **StorageAdapters**: see PRD 04; registry pattern from yappr `lib/upload/`.
6. **Keystore**: bridge-JSON import, encrypted-at-rest (OS keychain in CLI, platform-auth secure storage in web).

## Acceptance criteria (v1)
- `git clone dash://<owner>/<repo>` and `git push` round-trip byte-identical objects on testnet, both tiers, including force-push, ref deletion, tags, and a 2-maintainer repo (B pushes after A grants; B's push visible to C).
- Helper passes `git fsck` after every e2e clone.
- All commands run non-interactively with env-provided keys (CI requirement).
- Crash mid-push (kill -9) → re-run push completes without duplicate fees (idempotent ST replay) and without corrupt state.
