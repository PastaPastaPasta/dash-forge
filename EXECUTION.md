# Dash Forge — Execution Tracker

Session-continuity anchor. Docs in `docs/` are the spec; this file tracks build state. Update every session.

**Locked decisions**: testnet-complete (mainnet = runbook only) · GitHub `PastaPastaPasta/dash-forge` (private until Stage 4) · storage e2e docker-only (MinIO/kubo/static-http; Storacha+Pinata mock-tested) · import acceptance on medium repo (dashpay/dips-scale).

## Stage 0 — Repo, toolchain, scaffold ✅ COMPLETE
- [x] .gitignore, tracker
- [x] GitHub repo created + pushed (PastaPastaPasta/dash-forge, private)
- [x] Cargo workspace scaffold (`crates/*`, 20 tests, clippy/fmt clean; no rs-sdk dep yet — Stage 2)
- [x] forge-web scaffold (Next.js 14 static export + evo-sdk 4.0.0 + full style-guide tokens; builds to out/)
- [x] infra/ (docker-compose: kubo, MinIO, static-http — all smoke-tested) + CI workflows + Makefile
- [x] `tools/mint-identity` (S0.4) — LIVE smoke mint succeeded; CAP solved headlessly in Node
- [x] Fixture identity pool minted (9 roles) → `~/.config/dash-forge/test-identities/` + 9 GitHub secrets
- [ ] `brew install jj` (deferred to S0.9)

Pool identity IDs: OWNER=2S… see files. TREASURY=8igVywVvFTf8aNoaLfS9KsURfAfdHGb3gEeo3vGupZPV (~0.6 tDASH remaining for top-ups). Fan-out fee fixed to 2000 duffs (node maxtxfee wall).

## Stage 1 — Spikes S0.1–S0.9 → Design Freeze #1 ✅ COMPLETE — GO
- [x] S0.6 contracts validate, single template 11.7KB (no split); non-byteArray arrays unsupported → JSON/packed
- [x] S0.2 geometry frozen 3×4900=14700→14983B ST · [x] S0.1 **GO** ~4 docs/sec pipelined w8 · [x] S0.7 token-ACL validated (freeze blocks create+delete)
- [x] S0.8 in-batch starvation real→completeness fallback; skip-scan flat O(log n) · [x] S0.5 browse plane O(blob) confirmed, locator widths fixed · [x] S0.9 partial-clone works, shallow dropped, jj ✅ · [x] S0.3 trusted-connect only, proofs default
- [x] `docs/research/spike-results.md` + Design Freeze #1 applied across all docs
- Contracts: `forge-contracts/contracts/registry.json` + `templates/repo-v1.json` (validated). Throwaway spike contracts on testnet (permanent).
- WriteEngine spec frozen: broadcast+poll contractNonce (no waitForResponse), DIP-30 mask, window 8, base64 byteArray operands, CRITICAL key for token admin.
- Funding: DEPLOYER ~1.0 tDASH, OWNER ~0.07. Faucet+transfer+topup commands all work. Contract-create ~0.24 DASH (economics corrected).

## Stage 2 — Protocol + helper → M1  (IN PROGRESS)
- [x] Registry deployed testnet: `5fu48xTUVDj2QtBTY6pPH9w2t73YHb1fxf1WMg6Rt9pd` (cost 0.68 DASH — count-trees pricey; DEPLOYER ~0.32 left). `forge-contracts/scripts/deploy.mjs`, `deployments/testnet.json`.
- [x] rs-sdk de-risked: builds as path dep on `../platform/packages/rs-sdk` in ~48s with `default-features=false` (drop mocks/offline-testing). Rust forge-core viable.
- [x] forge-core **platform/WriteEngine + keystore + cost** — rs-sdk wired, LIVE-TESTED, reviewed (55c1567). Native put/wait works; sign-once + idempotent re-broadcast verified (AlreadyExists, no double-spend); structured errors (TokenFrozen 40702, CanRetry); redacted secrets; SDK isolated behind LoadedContract/LoadedIdentity. 26 tests.
- [ ] forge-core **rules** (FORGE_RULES_V1: ref resolution + divergence + protected as-of + event folds + staleness overlay + conformance vectors JSON) — pure logic, no SDK, most testable
- [ ] forge-core **pack** (fix-thin via system git, chunker w/ ST-size assert, offset index, locator/flatIndex builders per S0.5 corrected widths, supersedes planner)
- [x] forge-core **backends** — trait + https/s3/ipfs (live-tested ranged 206 + hash-verified failover against docker) + platform backend (write path + offline chunk codec; live read gated for M1). 76 tests. (infra fix: kubo binds 0.0.0.0 inside container.)
- [x] **forge-core FEATURE-COMPLETE** (platform, keystore, cost, rules, pack, backends) — workspace builds, 76 tests, clippy/fmt clean.
- [ ] repo-v1 template instantiation path (per-repo contract create from forge-core) + cost measurement (expect ≥1 DASH — pull faucet; DEPLOYER ~0.32)
- [ ] git-remote-dash helper (list/fetch/push; partial-clone via .promisor; shallow fails loud; post-push ref re-verify) — wires forge-core WriteEngine+pack+backends+rules
- [x] platform-backend live read helper (chunk query) — done in repo lifecycle build
- [x] **repo lifecycle (RepoService) + platform query helpers — LIVE-TESTED full lifecycle on testnet**: create_repo → resolve → write ref → read_refs (skip-scan + rules::resolve_ref resolved) → chunk round-trip bit-for-bit → teardown. **repo-v1 instantiation = ~1.18 DASH** (measured). Native rs-sdk: tokens-from-JSON ✓, raw byte operands (no base64) ✓. TokenPaymentInfo now attached to gated creates. resume_repo recovery path. 81 tests.
- [ ] git-remote-dash helper (list/fetch/push) wiring forge-core RepoService+pack+backends+rules → **the M1 payoff**
- [ ] M1 gate: byte-identical clone/push round-trip, frozen push rejected, fsck clean, 3rd-party verify

**repo-v1.json TEMPLATE RECONCILIATION (fixed at runtime in repo.rs; fix source template in a cleanup pass — needed for Stage 6 contract-validation CI):**
1. Group needs ≥2 members — template models org (MainGroup, 1 placeholder); solo owner can't form a group → runtime rewrites admin to ContractOwner + drops group. Org-repo group path is a follow-up.
2. Non-contiguous top-level `position`s — template numbers positions globally (nested imported/backend consume parent sequence); rs-dpp requires top-level 0..N contiguous → runtime renumbers per level.
3. Nested-object integers CBOR-canonicalize to smallest uint on proof read-back → runtime emits minimal-width uint. Cleaner fix: flatten config.backend to top-level fields.
Note: S0.6 fullValidation PASSED the broken template — these are caught at contract-create STATE validation, not schema validation. Add state-level checks to CI.
Economics: repo-v1 ~1.18 DASH, registry 0.68 DASH — update economics.md create-repo line. DEPLOYER ~0.91 tDASH (top up before next fresh repo create).

Next-session start: (1) add a chunk-query read helper to platform.rs + finish PlatformBackend.get live-tested; (2) build repo-v1 instantiation in forge-core (contract create from template + initial config/listing) — pull faucet grant for DEPLOYER first (repo-v1 with 2 tokens+15 types+count-trees likely ≥1 DASH); (3) wire git-remote-dash helper end-to-end; (4) M1 round-trip on testnet. All forge-core primitives are built, reviewed, and (write path) live-proven — M1 is integration.

Economics note: registry 0.68 DASH, S0.7 token contract ~0.24 — repo-v1 (2 tokens + 15 types + count-trees) likely ≥1 DASH to instantiate. Pull faucet grants as needed; delete-to-refund test repos.
Reusable JS platform patterns (for reference / evo-sdk web): spikes/S0.1/lib.mjs (nonce/broadcast), S0.7/lib.mjs (key+signer, fromJSON contract), tools/mint-identity/src/platform.mjs.

## Stage 3 — dg + relay → M2
- [ ] dg full surface · [ ] forge-relay + CI consumer · [ ] M2 gate + dogfood

## Stage 4 — Web + import → M3
- [ ] forge-web (browse plane → auth → issues → PR review → extras) · [ ] Pages deploy (repo → public) · [ ] forge-import · [ ] M3 gate

## Stage 5 — Backends GA + hardening → M4
- [ ] ipfs/s3/https/gitmirror live · [ ] repack/GC e2e · [ ] security/a11y/perf · [ ] Design Freeze #2 + mainnet runbook

## Stage 6 — E2E certification
- [ ] CLI suite (13) · [ ] token-ACL suite (10) · [ ] Playwright (12) · [ ] relay/import/chaos · [ ] Codex CU verification passes · [ ] 7-day green nightly

## Next action
Stage 2: deploy registry.json + repo-v1.json to testnet (DEPLOYER); build forge-core modules (platform/WriteEngine per frozen spec, keystore, cost, rules, pack, backends) with rs-sdk; git-remote-dash helper; → M1 gate.
