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
- [x] **git-remote-dash helper — M1 ACHIEVED** (merged 7ff894e). `git clone dash://…` + `git push` byte-identical round-trip LIVE on testnet: fsck clean, HEAD+tag equal, trees identical (binary byte-for-byte), non-FF refused, --depth fails loud, partial-clone(.promisor) works. Reviewed + hardened: idempotent contract-create (no double-pay), refName-injection inert (3 layers), resumable push (journal, live-proven chunk not re-paid), DAG-based causal ref ordering. 86 forge-core + 19 helper tests.
- [x] M1 costs: repo-v1 create 1.18 DASH, tiny push ~0.0033, refund on teardown. Non-FF refused ✓, depth fails loud ✓.
- [ ] M1 remaining for FULL gate (Stage 6): frozen-push-rejected e2e, 3rd-party verify script, multi-maintainer — these are e2e suite items, deferred to Stage 6.

**M1 DONE. Stage 2 essentially complete.** Template fix applied: $createdAt now required on refUpdate/protectedRefUpdate/event/config (was the root of the timestamp-0 ref-ordering issue; resolution is DAG-robust regardless). Remaining repo-v1 template runtime-patches (group members, positions, nested-int) still applied at runtime in repo.rs — fix source template + add contract-state CI check before Stage 6.

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
**Stage 3 — dg CLI + forge-relay → M2.** Build `dg` (clap; full PRD 02B surface: auth/repo/issue/pr/release/collab token mgmt/cost/repack/reseed/backend/storage-status/doctor; --json) on forge-core RepoService. Then forge-relay (DAPI ingest → GitHub-shape webhooks). Dogfood. Then M2 gate. forge-core is feature-complete + M1-proven; dg is mostly CLI surface over existing RepoService methods (+ add issue/PR/collab-token methods to forge-core). Funds: DEPLOYER ~0.72 tDASH; faucet hard-cap bypass works (node tools/mint-identity topup). Deployed: registry 5fu48x…, m1 repo 5rrwgjj….
Template cleanup (before Stage 6 CI): fix repo-v1.json source for the 3 runtime-patched issues + add contract-state validation to CI.

## Contract template reconciliation backlog (fix repo-v1.json + registry.json source before Stage 6 CI)
Runtime-patched in repo.rs (from repo-lifecycle build): (1) group needs ≥2 members → solo-owner rewrite; (2) non-contiguous positions → renumber; (3) nested-object integers → minimal-width uint.
$createdAt: fixed in template (refUpdate/protectedRefUpdate/event/config now required) — but DEPLOYED M1 contract predates it, so M1 issue/event folds are non-deterministic on M1 only; fresh repos fold deterministically.
From collab/tokens build: (4) registry countable indices are compound (field,$createdAt) → single-field star/follower/following counts rejected by count-proof; add single-property countable index (listingId)/(identityId)/(ownerId). Fallback (count-tree→row-count) implemented meanwhile. (5) two-clause (ownerId,listingId) star query fails proof → using single-field + client filter. (6) issue/comment have documentsKeepHistory:true → NON-deletable at consensus, contradicting data-contracts §2.2 "author-deletable w/ refund" — DECISION NEEDED: drop KeepHist (deletable) OR keep audit history (update §2.2 to non-deletable). Leaning keep-KeepHist (issues cheap, audit valued) → update §2.2.

### RESOLVED (2026-07-23) — SOURCE templates reconciled with the runtime fixes
Fixed the on-disk SOURCE so future repos + Stage 6 contract-validation CI are correct; runtime patches in repo.rs kept as idempotent no-op-safe compat shims (they still coerce any older/org-shaped template).
- `templates/repo-v1.json`: (a) **positions** renumbered to per-object-level contiguous 0..N (nested `imported`/`backend` children now local 0-based; each top-level 0..N with no gaps) — matches `normalize_document_positions`. (b) **solo-owner**: `groups` dropped, every token mint/freeze/unfreeze/destroy/emergency rule re-pointed `MainGroup`→`ContractOwner`, `mainControlGroup`→null — matches `apply_solo_owner_token_rules`. Org multi-sig stays a documented v2/opt-in variant (would re-add a ≥2-member group). (c) `$createdAt` in `required` for refUpdate/protectedRefUpdate/event/config — verified present. (d) **config.backend NOT flattened** — decided against `backendMode`/`backendUris` top-level fields: the deployed M1 contract (and every already-deployed repo) has the nested `backend` schema, and repo.rs's `config_properties`/`set_backend_mode`/config-read paths all address it nested; flattening the schema would force those write paths flat and break config writes to already-deployed repos (or require schema-version branching). Kept `backend` nested (positions now local-contiguous) and retained the platform.rs minimal-width-uint handling for the nested `mode` integer. Validated: fullValidation PASS (`spikes/S0.6-contracts/validate.mjs`, 11722 B < 16 KiB, 2 tokens / 0 groups) + static check (all object levels contiguous, no groups, no MainGroup refs, mainControlGroup null).
- `contracts/registry.json`: added single-property countable indices — `repoListing.recent (($createdAt) countable)` for total-count + recency listing; `star.listingCount ((listingId) countable)`; `follow.identityCount ((identityId) countable)`. fullValidation PASS (2845 B).
- **MIGRATION NOTE (deployed vs source):** the DEPLOYED testnet registry `5fu48x…` and the M1 repo contract `5rrwgjjV…` predate these source fixes; their on-chain schemas are immutable, so they do NOT benefit — a future re-deploy of the registry is required to pick up the new countable indices, and only repos created *after* this fix get contiguous positions / solo-owner from the source directly. NOT re-deployed here (costs DASH + orphans existing test data). Runtime reads/writes address fields by name (not position), so deployed contracts remain fully functional.

## Stage 3 ✅ COMPLETE — M2 achieved
- [x] forge-core collab + token services (issues/PRs/releases/social + ACL) — live-tested, reviewed+hardened (PR-merge-persists, pagination, owner-freeze, ref-injection). 92 tests.
- [x] dg CLI — full gh-replacement surface, --json, live-tested (doctor 5/5, repo view, cost). repack/reseed/import/fork stubbed w/ TODO.
- [x] forge-relay — Platform→webhook daemon, live M2 CI loop (push→webhook ~5s, CI consumer re-verify + checkRun writeback), SSRF/HMAC, interchangeable. 34 tests.
- dg + relay reviews deferred to Stage 5 consolidated security pass (relay is availability-only; consumers re-verify).
- M2 gate: terminal workflow ✓, webhook <30s ✓, CI loop ✓. Multi-instance swap = webhook-doc update (deterministic delivery id).

## Stage 4 — Web + import → M3 (IN PROGRESS)
Web needs: TS port of FORGE_RULES_V1 validated vs forge-contracts/vectors (66 vectors — parity contract); TS browse-plane reader (objectLocator/flatIndex/ranged); evo-sdk services; full Next.js UI. forge-import: Rust, reuses helper push + collab.
Deployed contracts: registry 5fu48x…, m1 repo 5rrwgjj…. DEPLOYER ~0.68 tDASH (faucet hard-cap bypass works).

## Stage 4 ✅ COMPLETE — M3
- [x] forge-web TS core: FORGE_RULES_V1 port — ALL 66 conformance vectors pass (cross-client parity proof); browse reader; evo-sdk services.
- [x] forge-web auth + write path — key login, browser WriteEngine, live CLI-web interop (issue created via browser, folded correctly).
- [x] forge-web UI — 17 routes, foundry aesthetic + Assay trust panel, static export. **LIVE at https://pastapastapasta.github.io/dash-forge/**.
- [x] forge-import — GitHub migrator, live import within 1.1% of estimate, gist-claim.
- [x] Pages deploy (repo public, CI web job green). Fixed: remote was SSH (agent refused) → HTTPS; many commits were local-only, now all pushed.
- CI split: ci.yml = web+parity (per-push, green); rust.yml = nightly (clones platform, heavy dep tree); local+testnet authoritative for Rust.
- Web hardening gaps for Stage 5: token-history authz unwired in TS core (maintainer folds); evo-sdk WASM 9.4MB not lazy; browse-source ordering/fill assumptions; no syntax highlighting; dg+relay+web-UI reviews pending.

## Stage 5 — Backends GA + hardening → M4 (NEXT)
- [ ] Consolidated hardening reviews: dg, forge-relay, forge-web UI (+ browse-source) → fixes
- [ ] gitmirror backend + repack/GC wiring (dg stubs) + reseed
- [ ] token-history authz wiring in TS core; WASM lazy-load; syntax highlighting
- [ ] security/a11y/perf pass; Design Freeze #2 + mainnet runbook + repo-v1 template source cleanup (backlog above)

## Stage 6 — Full e2e + Codex CU verification
- [ ] CLI suite (13), token-ACL (10), Playwright web (12), relay/import/chaos
- [ ] Codex computer-use verification of the deployed app
- [ ] 7-day green nightly (adapted: testnet suites)

## Stage 5 ✅ COMPLETE — M4
- [x] forge-relay security review + fixes (SSRF IP-pinning vs DNS-rebind, concurrent delivery, ci-consumer trust). 35 tests.
- [x] Backends GA: gitmirror backend + repack/GC (live refund observed) + reseed. dg wired.
- [x] forge-web hardening: token-history authz wired (maintainer folds), lazy WASM (7.31MB→151kB first-load), syntax highlighting, browse-source ordering fix. 119 tests.
- [x] dg collab unsuspend + token-op read-after-write poll; repo-v1/registry source template reconciliation (contiguous positions, solo-owner, count indices).
- [x] Design Freeze #2 (docs/design-freeze-2.md) + mainnet runbook (docs/mainnet-runbook.md).

## Stage 6 ✅ COMPLETE
- [x] CLI e2e suite (e2e/cli): 6 PASS + 1 SKIP live — round-trip byte-identical, frozen-push rejected at consensus (40702), no-token rejected (40700), third-party verify, --depth fails loud, partial clone. ⭐ criteria proven.
- [x] Playwright web e2e (forge-web/e2e): 8/8 PASS in real chromium vs testnet — landing/repo-home/issues render live data + trust panel, zero-backend proven (only DAPI+quorum hosts), a11y 0-serious, responsive. Caught+fixed the browser read bug.
- [x] Codex CU: environment-blocked (no browser window); Playwright headless substituted (better/repeatable) — kept threadId to retry.
- [x] Token-ACL consensus scenarios covered by CLI e2e (frozen/no-token) + S0.7. Relay/import live-tested. Nightly workflow exists (7-day soak = ongoing).

## Post-freeze fix — registry redeploy (2026-07-23)
- [x] Landing "Recent repos" read failed: `orderBy $createdAt` hit a non-indexed property. Two root causes — the deployed `5fu48x…` predated the `recent` index (added after deploy), **and** `repoListing`/`star`/`follow` indexed `$createdAt` without listing it in `required`, so Platform never stored the timestamp (every live listing had `$createdAt: null`). Indices are immutable post-creation (`rs-dpp` `index_level::validate_update` — "we do not allow any index modifications"), so a contract update could fix neither.
- [x] registry.json: `$createdAt` added to `required` on repoListing/star/follow. Redeployed testnet registry → `DXocbV5xJb9hYwSAUGsyTTskdem7nVmngeJbH5TRzLnh` (0.713 DASH; funded by a TREASURY→DEPLOYER credit transfer). Both M1 listings re-published; superseded id recorded in `deployments/testnet.json`.
- [x] `listReposByOwner` had the same class of bug (ordered by `$ownerId,$createdAt`; the only `$ownerId` index is `ownerName` = `$ownerId,normalizedName`, and an equality-constrained field must not appear in orderBy) — now traverses `normalizedName` and sorts newest-first client-side.
- [x] Same defect found (code review) in `templates/repo-v1.json` + its forge-web copy: nine types — packManifest, issue, patch, comment, review, label, release, checkRun, webhook — indexed `$createdAt` without requiring it, so `listIssues`/`listPulls`/`readPackManifests`/comment reads silently ordered on null timestamps instead of erroring (their compound indices exist, so no query error surfaced). Both copies patched in lockstep — cross-client interop needs web- and CLI-created repos identical. Already-deployed repos (5rrwgjjV…) keep the defect; only new repos inherit the fix. repo-v1 revalidates at 11.48 KiB.
- [x] mint-identity islock poll: backs off on consecutive failures (3s→30s). The flat 3s poll got the whole IP TLS-reset by `trpc.digitalcash.dev`, which reads as a permanent outage.

## ✅ ALL STAGES COMPLETE — testnet-complete product
Live: web app https://pastapastapasta.github.io/dash-forge/ · registry DXocbV5… (supersedes 5fu48x…) · m1 repo 5rrwgjjV…
Components: forge-contracts, forge-core (platform/keystore/cost/rules/pack/backends/repo/collab/tokens), git-remote-dash, dg, forge-relay, forge-import, forge-web. All gates green, live-tested, reviewed. Mainnet = funded runbook away (docs/mainnet-runbook.md).
