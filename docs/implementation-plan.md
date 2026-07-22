# Dash Forge — Implementation Plan

Phasing per INIT.md's design path, with constraint-forced adjustments (reconciliation D1) folded in. Each phase ends with runnable, tested software.

## Phase 0 — De-risk (2–4 wks) — the go/no-go gate

Everything else is conventional engineering; this phase is not. Spikes in `spikes/`, results in `docs/research/spike-results.md`.

1. **S0.1 Chunker vs testnet at scale**: push **5 MB, 25 MB, and 100 MB packfiles** as chunk documents. Measure real credits consumed vs estimates, wall-clock time, and identity **nonce sequencing under thousands of sequential STs**. Because `max_transitions_in_documents_batch = 1` (D1 — INIT.md's "batch ST packing" isn't available), the throughput lever is **pipelined sequential-nonce broadcasting** (windows 2/4/8/16): success rate, desync recovery, sustained docs/s.
2. **S0.2 ST size ceiling**: empirically validate 3 × 4,900 B fields per chunk doc under the 20,480 B signed-ST cap; fix final chunk geometry.
3. **S0.3 Browser proof-mode perf**: `EvoSDK.testnet()` vs `testnetTrusted()` — decides forge-web default.
4. **S0.4 Headless identity minting**: faucet POST → asset-lock → InstantSend lock → `identities.create` in a script (reference: `../mainnet-bridge` pure modules). Becomes the e2e fixture generator.
5. **S0.5 In-browser materialization**: isomorphic-git + lightning-fs in a worker; lazy fetch via offset index; 100 MB-repo tree view time/memory. (INIT.md risk 3: "build it early not late.")
6. **S0.6 Contract template validation**: registry + repo-template drafts construct with `fullValidation`; serialized size vs 16 KiB (D4); split decision. Also validates the flag combinations the design leans on: `countable` on unique indices, `documentsCountable`, `tokenCost.delete`, `documentsKeepHistory` + author replace, `canBeDeleted: false` per doc type.
7. **S0.7 Token-cost ACL prototype**: contract where document creation costs a WRITE token, tokens declared with `baseSupply` credited to owner at creation; verify **freeze actually blocks the push at consensus**; verify **freeze blocks token-gated deletes** (availability protection after revocation); verify past-holdings reconstruction from the token-history contract (event-fold authorization); probe destroy-frozen semantics and group-held admin. Findings → Platform-core review (INIT.md risk 2: pattern is clever but unaudited).
8. **S0.8 `in`-batch limit semantics**: measure Drive's behavior when one `in`-clause key holds far more rows than the global query limit (does it starve sibling keys?); tune batch sizes for ref-tip lookups and event folds; the per-key completeness-check fallback (data-contracts §3) ships regardless.

**Exit**: all eight documented with numbers; go/no-go call on Tier-platform UX claims; chunk geometry + contract split frozen.

## Phase 1 — Protocol + remote helper

Ship the data contracts and `git-remote-dash`. **Success = `git clone dash://name/repo` and `git push` work against mainnet with on-Platform storage.** No UI — this alone is a usable product for sovereignty-minded devs.

- forge-contracts: final registry + repo template v1 (token config, tokenCosts), deploy scripts, devnet→testnet→**mainnet** registry deployment.
- forge-core (Rust): PlatformClient, WriteEngine (+ journal resume), PackPipeline (+ offset index), RulesEngine (`FORGE_RULES_V1` + conformance vectors), CostEngine, Keystore.
- git-remote-dash: full helper protocol; platform backend; cost prompt; resumable push.
- **Phase 1 design review** (INIT.md "decide early"): repo-contract template under DCG identity — versioning + migration of existing repos across template versions.

**M1**: monorepo-scale round-trip on testnet; small-repo round-trip on **mainnet**; frozen-identity push rejected at consensus.

## Phase 2 — CLI + relay

- dg: full gh-mirroring surface (PRD 02B) — repo/issue/pr/release/collab (token mint/freeze)/cost/repack/backend.
- forge-relay: ST-stream ingest, GitHub-shape webhooks, HMAC delivery, on-Platform `webhook` subscriptions; Docker deploy; CI reference consumer (fetch-and-verify + `checkRun` writeback).
- **Dogfood: host the forge's own repos on the forge** (with GitHub read-only mirror during transition).

**M2**: maintainer runs a real project entirely from terminal; push → Blacksmith build < 30 s; relay instance swap requires no repo-side changes.

## Phase 3 — Web app + importer

- forge-web: full PRD 03 v1 — browse (worker materialization, lazy fetch, Shiki, diff view per rendering-research decision), issues, PR review flow (line comments, approve/request-changes, browser merge for FF/clean via isomorphic-git), releases, repo create/settings, collaborator token UI, stars/follows/profiles, per-repo client-side search, checkRun display; platform-auth; IPFS + static-host deploy.
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
