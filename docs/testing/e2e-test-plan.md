# Dash Forge — E2E & Production Test Plan

Covers the full pyramid with emphasis on **real end-to-end testing against live networks**, using bridge.thepasta.org / faucet.thepasta.org for identities and funds.

## 1. Test infrastructure: identities & funding

### 1.1 How identities are obtained (testnet)

Two mechanisms, both derived from `../mainnet-bridge` + `../platform-identity-faucet` research:

**A. Pre-provisioned fixture pool (primary, fast path).**
- 6+ funded testnet identities minted once via bridge.thepasta.org (`?network=testnet`), exported as `dash-identity-<id>.json` (mnemonic + 5 keys incl. High/Critical AUTH WIFs).
- Stored as CI secrets (`FORGE_TEST_IDENTITY_{OWNER,COLLAB,CONTRIB,VISITOR,SEEDER,DEPLOYER}`); local dev keeps them in `~/.config/dash-forge/test-identities/` (gitignored — yappr's checked-in `testing-identity-*.json` precedent is explicitly NOT followed).
- A `pretest` guard checks each balance via `sdk.identities.fetch`; below threshold → auto top-up (B) or fail with instructions.

**B. Programmatic minting (`tools/mint-identity.mjs`, built in Phase 0 S0.4).**
Headless Node reimplementation of the bridge flow:
1. Derive keys from fresh mnemonic (`generateDefaultIdentityKeysHD` port).
2. `POST https://faucet.thepasta.org/api/core-faucet {address}` (~1 tDASH; **3/hour/IP limit**, may require CAP PoW token — solver step included; on 429, fall back to spending from a funded "treasury" fixture identity via L1 send).
3. Poll Insight for UTXO → build type-8 asset-lock tx → wait InstantSend lock → `sdk.identities.create` with proof.
4. Emit bridge-format identity JSON.
Used by: onboarding e2e (fresh-user journey), identity-pool replenishment, and top-ups (`identities.topUp` with same asset-lock flow).

### 1.2 Environments

| Env | Purpose | Notes |
|---|---|---|
| Local devnet (dashmate, `../platform`) | Contingency + destructive tests (contract-update rehearsals) | Heavy; not in default CI |
| **Testnet** | All integration + e2e suites | Default for everything |
| Mainnet | Production smoke only (§7) | Real (small) DASH |

Contract IDs per env from `forge-contracts/deployments/<network>.json`; suites never hardcode IDs. Test repos namespaced `e2e-<runId>-<name>` and **deleted in teardown** (storage refunds keep the pool solvent — deletion is part of the test).

## 2. Test pyramid

| Layer | Tooling | Network | When |
|---|---|---|---|
| Unit (codec, chunker bounds, authz vectors, event folds, adapters w/ mocks) | vitest | none | every PR |
| Contract validation (schemas construct with `fullValidation`, size < 16 KiB, index bounds) | vitest + wasm-sdk | none | every PR |
| Integration (each forge-core service against live contracts) | vitest, serial per identity | testnet | nightly + pre-merge label |
| E2E CLI (real `git` + helper) | bash+node harness | testnet | nightly + release |
| E2E Web | Playwright | testnet | nightly + release |
| Cross-client + chaos | mixed | testnet | release |
| Production smoke | scripted | mainnet | post-deploy + weekly |

Flake policy: every testnet test wraps writes in the idempotent WriteEngine (retries are the product's own machinery — a test that flakes on timeout indicates a product bug, not a test bug); suites retry once at job level; persistent failure pages the risk-register "testnet instability" playbook.

## 3. E2E CLI suite (`e2e/cli/`)

Each scenario runs with `git` proper against testnet, asserting with `git fsck` + byte-compare (`git rev-parse`, object counts, `diff -r` of worktrees).

1. **Round-trip (Tier X/IPFS)**: OWNER `dforge repo create` → push seeded repo (100 commits, binaries, tags, symlink) → fresh clone elsewhere → byte-identical; verification chain assertions (proof-verified refs, sha256 packs).
2. **Round-trip (Tier P)**: small repo (~200 KiB) chunked on-platform; clone with **zero external dependencies** (offline from IPFS); measure pipelined push throughput vs S0.1 baseline.
3. **Incremental push/fetch**: 3 successive pushes → thin-pack manifests accumulate; clone applies in order; `fetch` no-op < 3 s.
4. **Multi-maintainer**: OWNER grants COLLAB write → COLLAB pushes → CONTRIB (unauthorized) writes a forged refUpdate directly via SDK → fresh clone sees COLLAB's tip, **ignores forged update** (authz e2e), then revoke COLLAB → their new push invisible.
5. **Force-push & ref delete**: non-FF rejected without force; `+push` works with `force` flag set; branch delete; tag push/delete.
6. **Crash recovery**: kill helper mid-push (after N chunk STs); re-push completes; no duplicate manifests; total fees ≈ single-push fees.
7. **Repack/GC**: 10 pushes → `dforge repack` → old packs superseded+deleted → clone still exact; storage refund observed in balance.
8. **Storage failover**: manifest with 2 URIs, first tampered (corrupt fixture server) → clone succeeds via second, corruption logged. `dforge reseed` after primary "loss" restores availability; `storage status` matrix correct.
9. **S3 + https adapters**: same round-trip via MinIO container + static file server.
10. **Fees ledger**: assert per-operation credit deltas within ±20% of documented estimates (economics regression).
11. **Fresh-user onboarding**: mint brand-new identity via §1.2-B, import, create repo, push — the full new-user journey with zero prior state.

## 4. E2E Web suite (Playwright, `e2e/web/`)

Runs against the static build (`npx serve out/`) pointed at testnet.

1. **Logged-out browse**: seeded repo (from CLI suite fixtures) — tree nav, blob render, README markdown, commit log pagination, diff view; all verification chips green; no network calls except DAPI + bundle URIs (request interception assertion — zero-backend proof).
2. **Auth flows**: private-key login; password-vault create/unlock; passkey PRF (Playwright virtual authenticator); logout clears secure storage.
3. **Repo lifecycle**: create (cost preview shown), settings edit, collaborator add/remove, delete with refund estimate.
4. **Issues**: create/comment/label/close/reopen across two browser contexts (two identities); event timeline order; state visible to logged-out visitor after poll.
5. **CLI↔web cross-client**: CLI pushes during web session → new commits appear within poll interval; web-granted collaborator immediately pushes via CLI (shared authz parity — the critical consistency test).
6. **Large repo UX**: 50 MiB fixture → interstitial, progressive load, IndexedDB warm-cache reload < 1.5 s.
7. **Failure UX**: DAPI node blackhole (route interception) → reconnect banner + recovery; insufficient credits → bridge deep-link flow.
8. **A11y/perf**: axe-core scan on core pages (0 serious violations); Lighthouse budgets (perf ≥ 80 / a11y ≥ 95).

## 5. Protocol conformance vectors

`forge-core/src/authz/vectors/*.json`: canonical scenarios (grants, revocations, forged docs, timestamp edges, force-push chains) with expected resolved state. Consumed by: unit tests, CLI suite (replayed against real testnet docs), and any future third-party client. Versioned with `AUTHZ_RULES_V1`.

## 6. Contract deployment testing

- Rehearse every contract deploy/update on local devnet, then testnet, before mainnet; post-deploy assertion script fetches contract, diffs against source JSON, runs a canary doc create+delete per type.
- Backward-compat gate: `rs-json-schema-compatibility-validator` semantics mirrored — CI fails if a contract change is non-additive.

## 7. Production (mainnet) smoke suite

Post-mainnet-deploy and weekly cron; budget ≤ 0.05 DASH/run (mostly refunded):
1. Mainnet PROD identity (manually funded via bridge, small balance) creates `forge-smoke-<date>` repo, Tier X push of tiny repo, fresh clone verify, issue create/close, **repo delete** (refund reclaimed — keeps cost near zero).
2. Web smoke: Playwright against production Pages deploy on mainnet — browse the canonical dogfood repo, verification chips green.
3. Alerting: failures push notification (repo issue + configured channel); balance watchdog warns when PROD identity < 2× run cost.

## 8. CI wiring

- **PR**: unit + contract validation + build + lint (< 5 min, no network).
- **Nightly**: testnet integration + CLI e2e + web e2e; identity-pool balance check/top-up first; teardown deletes all `e2e-*` repos even on failure (`finally` + orphan-sweeper that also runs weekly).
- **Release**: nightly suite + chaos/failover + fees-ledger + fresh-onboarding.
- **Post-deploy/weekly**: mainnet smoke.
- Serialization: one testnet job per fixture identity at a time (nonce discipline); parallelism achieved across identities, not within.
