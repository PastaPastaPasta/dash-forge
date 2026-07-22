# Dash Forge — Implementation Plan

Phasing per INIT.md's design path, with constraint-forced adjustments (reconciliation D1) folded in. Each phase ends with runnable, tested software.

## Phase 0 — De-risk (2–4 wks) — the go/no-go gate

Everything else is conventional engineering; this phase is not. Spikes in `spikes/`, results in `docs/research/spike-results.md`. **All nine spikes are ✅ done against live testnet — headline: GO. Design Freeze #1 is folded into the docs.**

1. **S0.1 Chunker vs testnet at scale**: push **5 MB, 25 MB, and 100 MB packfiles** as chunk documents. Measure real credits consumed vs estimates, wall-clock time, and identity **nonce sequencing under thousands of sequential STs**. Because `max_transitions_in_documents_batch = 1` (D1 — INIT.md's "batch ST packing" isn't available), the throughput lever is **pipelined sequential-nonce broadcasting** (windows 2/4/8/16): success rate, desync recovery, sustained docs/s. **✅ done — see spike-results.md**: pipelined ~4 docs/sec (10× serial, 0% fail) at window=8; broadcast-only + poll `contractNonce` (not `waitForResponse`), DIP-30 masked sequential nonces, ~24 in-flight cap.
2. **S0.2 ST size ceiling**: empirically validate 3 × 4,900 B fields per chunk doc under the 20,480 B signed-ST cap; fix final chunk geometry. **✅ done — see spike-results.md**: 3×4,900 B = 14,700 payload → 14,983 B signed ST (27% headroom); binding cap is 5,120 B/field. Geometry frozen.
3. **S0.3 Browser proof-mode perf**: `EvoSDK.testnet()` vs `testnetTrusted()` — decides forge-web default. **✅ done — see spike-results.md**: only `testnetTrusted()` works in WASM (both `EvoSDK.testnet()` and `{proofs:false}` crash); proofs always on, ~0% per-query overhead → proof-verified default, trust-minimized (quorum keys from a known endpoint).
4. **S0.4 Headless identity minting**: faucet POST → asset-lock → InstantSend lock → `identities.create` in a script (reference: `../mainnet-bridge` pure modules). Becomes the e2e fixture generator. **✅ done — see spike-results.md**: scripted mint works; e2e fixture generator in place.
5. **S0.5 Browse plane + materialization**: (a) build `objectLocator` + `flatIndex` for a real large repo (e.g. the platform monorepo); measure cold "repo home + blob view" over ranged reads — target < 500 KB / < 3 s at any repo size; validate delta-chain-span reads against IPFS-gateway and S3 Range support; (b) full materialization path (isomorphic-git + lightning-fs worker) for the search/blame tier at 100 MB. (INIT.md risk 3: "build it early not late.") **✅ done — see spike-results.md**: O(blob) ranged reads confirmed (IPFS/MinIO/nginx honor Range); locator widths corrected (`deltaChainSpan` 4 B/varint, `length` 4 B, +delta-hint; ~34–36 B/object); flatIndex is O(files) (471 KB @ 10k) → cold-home loads root tree via locator (~101 KB), flatIndex deferred; single-span read sound for blobs, per-base fallback for trees.
6. **S0.6 Contract template validation**: registry + repo-template drafts construct with `fullValidation`; serialized size vs 16 KiB (D4); split decision. Also validates the flag combinations the design leans on: `countable` on unique indices, `documentsCountable`, `tokenCost.delete`, `documentsKeepHistory` + author replace, `canBeDeleted: false` per doc type. **✅ done — see spike-results.md**: both contracts validate; single repo template 11.7 KB (no split); **non-byteArray arrays unsupported** (protocol v12) → list fields re-encoded as JSON-string / packed byteArray; index sort is asc-only.
7. **S0.7 Token-cost ACL prototype**: contract where document creation costs a WRITE token, tokens declared with `baseSupply` credited to owner at creation; verify **freeze actually blocks the push at consensus**; verify **freeze blocks token-gated deletes** (availability protection after revocation); verify past-holdings reconstruction from the token-history contract (event-fold authorization); probe destroy-frozen semantics and group-held admin. Findings → Platform-core review (INIT.md risk 2: pattern is clever but unaudited). **✅ done — see spike-results.md**: freeze blocks create **and** delete at consensus (40702); `baseSupply` auto-credits owner; token admin needs a **CRITICAL** key (HIGH rejected); tokenCost payments recirculate to the owner; contract create ~0.24 DASH; upstream `tokens.mint()` return-value bug on keepsHistory tokens (verify mint via query).
8. **S0.8 query-cursor semantics**: (a) measure Drive's behavior when one `in`-clause key holds far more rows than the global query limit (does it starve sibling keys?) — the per-key completeness fallback ships regardless; (b) verify `limit 1` skip-scan hops on `(refNameHash, $createdAt)` are true O(log n) seeks (ref enumeration correctness depends on it). **✅ done — see spike-results.md**: in-batch starvation is real & can be TOTAL (9/9 keys starved) → per-key completeness fallback is the **normal path** (parallelized); skip-scan is a flat O(log n) seek; **byteArray query operands must be base64 strings**.
9. **S0.9 remote-helper transport mechanics**: (a) shallow/partial protocol bookkeeping for a non-`connect` helper — `option depth`, `.git/shallow` grafting, `--unshallow` deepening (Radicle's helper as reference); (b) **jj compatibility** — confirm jj's gitoxide-based transport actually delegates `dash://` to `git-remote-dash` on PATH (a ⭐ acceptance criterion currently resting on an unverified assumption). **✅ done — see spike-results.md**: partial clone works via `fetch` (bare-OID + `.promisor` markers); **shallow is impossible** via a fetch/push helper (no reply channel) → **dropped**, `--depth` fails loudly; **jj works unmodified** (gitoxide, jj ≥ 0.43, no colocation) ⭐.

**Exit**: all nine documented with numbers ✅; go/no-go call = **GO**; chunk geometry + contract topology (single template, no split) frozen at Design Freeze #1.

## Phase 1 — Protocol + remote helper

Ship the data contracts and `git-remote-dash`. **Success = `git clone dash://name/repo` and `git push` work against mainnet with on-Platform storage.** No UI — this alone is a usable product for sovereignty-minded devs.

- forge-contracts: final registry + repo template v1 (token config, tokenCosts), deploy scripts, devnet→testnet→**mainnet** registry deployment.
- forge-core (Rust): PlatformClient, WriteEngine (+ journal resume), PackPipeline (+ offset index), RulesEngine (`FORGE_RULES_V1` + conformance vectors), CostEngine, Keystore.
  - **WriteEngine spec (frozen at Design Freeze #1, from S0.1/S0.7/S0.8)**: pipeline is **broadcast-only (`broadcastStateTransition`) + poll `contractNonce`** for confirmation — `waitForResponse`/`broadcastAndWait` panic under Node/WASM (`time not implemented`), so never used. **DIP-30 nonce masking mandatory**: mask raw nonce with `& (2^40−1)` before computing the next, or the batch desyncs. **Sequential-nonce pipelining, window 8** (block-bound ~4 docs/sec landing), **~24 in-flight cap** (bulk writes chunk ~18 then poll). **byteArray query operands must be base64 strings** (not Uint8Array/base58). **CRITICAL-level auth key for token admin** (mint/freeze/destroy); HIGH for document ops. **Upstream SDK caveat**: `tokens.mint()` return-value bug on keepsHistory tokens — tx lands at consensus but the JS return throws, so **verify mint via query**, never the return value (file upstream).
- git-remote-dash: full helper protocol; platform backend; cost prompt; resumable push.
- **Phase 1 design review** (INIT.md "decide early"): repo-contract template under DCG identity — versioning + migration of existing repos across template versions.

**M1**: monorepo-scale round-trip on testnet; small-repo round-trip on **mainnet**; frozen-identity push rejected at consensus.

## Phase 2 — CLI + relay

- dg: full gh-mirroring surface (PRD 02B) — repo/issue/pr/release/collab (token mint/freeze)/cost/repack/backend.
- forge-relay: ST-stream ingest, GitHub-shape webhooks, HMAC delivery, on-Platform `webhook` subscriptions; Docker deploy; CI reference consumer (fetch-and-verify + `checkRun` writeback).
- **Dogfood: host the forge's own repos on the forge** (with GitHub read-only mirror during transition).

**M2**: maintainer runs a real project entirely from terminal; push → Blacksmith build < 30 s; relay instance swap requires no repo-side changes.

## Phase 3 — Web app + importer

- forge-web: full PRD 03 v1 — browse plane (flatIndex/locator + staleness overlay), materialization tier (worker, Shiki, diff view per rendering-research decision), **blame algorithm** (isomorphic-git ships none — incremental line-history walk is its own task, rename-tracking best-effort), issues, PR review flow (line comments, approve/request-changes, browser merge for FF/clean via isomorphic-git), releases, repo create/settings, collaborator token UI, stars/follows/profiles, per-repo client-side search, checkRun display; platform-auth; IPFS + static-host deploy.
- forge-import: PRD 06 — Forgejo-semantics mapping, cost gate, resume, gist claim flow.

**M3**: full review flow (line comment → request changes → re-review → merge) completes against mainnet from a browser served off IPFS; dashpay/platform imported within 10% of estimate.

## Phase 4 — Hardening

- Alternative backends GA: IPFS/S3/HTTPS/mixed write paths, `reseed`, `storage status`, gitmirror; **repack/GC with refunds** end-to-end.
- Full e2e + chaos suites green (e2e plan); perf/a11y/security passes; **private-repo encryption design doc** (v2 feature, design only); mirror mode (import v1.1).
- Production smoke on mainnet weekly; public launch.

## Risk register (ordered, per INIT.md + research)

| # | Risk | Mitigation |
|---|---|---|
| 1 | Bulk ST throughput makes big pushes painful (batch=1 today) | S0.1 measures pipelining first; **mixed-backend mode is the escape hatch**; upstream batch>1 (issue #2867) inherited if it lands |
| 2 | Token-cost-as-ACL unaudited as a pattern | S0.7 prototype + Platform-core review of freeze semantics/edge cases before Phase 1 ships |
| 3 | In-browser materialization UX on large repos | Lazy fetch via offset index built in Phase 0 (S0.5), not bolted on; ≤ 100 MB excellent-UX target, size warnings above |
| 4 | DASH price volatility swings $/MB | Cost UX: DASH primary, USD secondary; fee-multiplier governance lever flagged internally |
| 5 | Testnet instability vs CI | Idempotent engine + nightly cadence + fixture identity pool + dashmate devnet contingency |
| 6 | evo/rs-sdk 4.x RC churn | Pin versions; SDK isolated in forge-core/PlatformClient |
| 7 | Template >16 KiB or migration pain | S0.6 size check; Phase 1 design review owns migration story |
| 8 | Faucet rate limits block CI minting | Pre-provisioned identity pool; mint only for onboarding tests |
