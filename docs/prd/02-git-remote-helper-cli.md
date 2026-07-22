# PRD 02 — git-remote-dash & dg

One **Rust workspace** (shared `forge-core` crate on rs-sdk/rs-dpp), multiple binaries. Radicle's remote helper is the reference implementation for helper-protocol mechanics.

## A. git-remote-dash (remote helper)

### Goal
`git remote add origin dash://alice/project`, then normal git — zero workflow change. jj (git backend) works unmodified.

### URL scheme & config
```
dash://<owner>/<repo>        # owner = DPNS label or base58 identity id
```
Config in git config: `dash.identity`, `dash.network`, `dash.costWarnThreshold`, per-remote backend override (`remote.<name>.dashBackend`).

### Protocol
- Capabilities: `fetch`, `push`, `option`, `list` (connect-less semantics, same pattern as git-remote-ipfs/s3).
- `list` / `list for-push`: DPNS → registry → repo contract → refs (newest `refUpdate`/`protectedRefUpdate` per name, proof-verified) + HEAD symref.
- `fetch`: want/have negotiation vs local odb → select non-superseded manifests covering want-set → download chunks via DAPI or CID/URL per manifest → SHA-256-verify reassembled packs → `git index-pack`. **Partial/shallow clone** via manifest per-object offset index (ranged chunk fetch by seq / HTTP range).
- `push`: thin pack vs remote refs → **cost estimate; display and prompt above `dash.costWarnThreshold`** → chunk upload as pipelined single-transition STs (sequential nonces; batch=1 platform constraint) → `packManifest` (+ `manifestPart`s) → `refUpdate` docs (prevOid recorded; non-FF refused without `+`; delete = zero OID; protected patterns route to `protectedRefUpdate`).
- **Resumable pushes**: journal file (`.git/dash/journal/<packHash>.json`) records uploaded chunk IDs; interrupted push resumes **without re-paying for uploaded chunks** (INIT.md acceptance).
- Idempotent ST engine: sign → persist bytes → broadcast → wait → rebroadcast same bytes on timeout; "already exists" = success.

### Auth
Local Dash identity key via OS keychain/agent (SSH-key UX shape); `DASH_FORGE_KEY` env for CI; unauthorized push fails client-side pre-fee *and* at consensus (token gate).

### Acceptance (v1)
- Round-trip clone/push of **the Dash Platform monorepo itself** (mixed backend).
- Interrupted 100 MB push (kill -9 mid-upload) resumes; total fees ≈ single-push fees.
- `git fsck` clean after every e2e clone; jj works unmodified; frozen identity's push fails at consensus.

## B. dg (gh replacement)

Command surface mirrors `gh` deliberately; honors gh-style aliases; `--json` on everything.

```
dg auth login|status                    # identity import (bridge JSON), keychain storage
dg repo create|clone|fork|view|delete   # create = contract instantiate + listing + token setup
dg repo backend set <mode>              # platform|ipfs|s3|https|mixed
dg issue list|view|create|comment|close|reopen|label
dg pr create|list|view|checkout|review|merge|diff
dg release create|list|download
dg collab add|suspend|remove|list       # mint / freeze / freeze+destroy / balances query
dg cost estimate|audit                  # pre-write quotes; running spend report
dg repack                               # optimized pack, upload, delete superseded → refund
dg reseed [--to ipfs|s3]                # re-upload packs, append mirror URIs
dg storage status                       # per-URI availability matrix
dg import <github-url>                  # thin wrapper over forge-import (PRD 06)
dg doctor
```

### Behaviors
- `pr merge`: merge happens client-side (it's just git) → push merge commit → `merged` event closes patch doc. `pr checkout` fetches the patch manifest's pack.
- `repo fork`: new repo contract + copied refs pointing at same content where backend allows (shared CIDs), else re-upload; listing gets `forkOf`.
- `collab`: grants are 10⁹-unit mints; `suspend` freezes; `remove` freezes + destroys frozen funds; `list` = token-balance query (on-chain collaborator list).
- Cost engine: every mutating command prints DASH (primary) + USD (secondary) estimate; `--yes` for automation; `cost audit` reconciles actual credits consumed vs estimates.
- Never prints secrets; `--reveal-secrets` required for key export.

### Acceptance (v1)
A maintainer runs a real project — triage issues, review and land PRs, cut a release — **without ever opening a browser**. All commands non-interactive with env keys (CI). Two-maintainer flow: A grants B via `collab add`; B pushes; C's fresh clone sees B's tip; A `collab suspend` B; B's next push fails at consensus.

## C. forge-core crate requirements (shared substance)

1. **PlatformClient**: rs-sdk wrapper — connect/retry, proof verification on, registry+template preload, nonce serializer with pipelining mode (window configurable; S0.1-tuned).
2. **WriteEngine**: idempotent ST lifecycle + journal persistence + fee accounting.
3. **PackPipeline**: pack build (system git), sha256, chunker (≤ 4,900 B/field, ST-size assertion), offset-index builder, assembler + verifier, supersedes planner.
4. **Backends**: `platform | ipfs | s3 | https` trait (put/get/probe), mixed-mode policy, failover + hash re-verify on every read.
5. **RulesEngine**: `FORGE_RULES_V1` — ref resolution, event folds, protected-pattern matching; conformance vectors shared with forge-web.
6. **CostEngine**: fee constants (27,000 credits/byte etc.), estimate/audit, DASH/USD formatting (price feed optional/offline-safe).
7. **Keystore**: bridge-JSON import, OS keychain, agent protocol (later).
