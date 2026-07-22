# Dash Forge — Implementation Plan

Phased plan; each phase ends with runnable, tested software. Solo-or-small-team pacing assumed; phases are sequential with internal parallelism. Testnet throughout; mainnet only at Phase 7.

## Phase 0 — Spikes & de-risking (the "is this viable" gate)

Everything else depends on numbers only experiments can give. Spikes live in `spikes/`, throwaway code, results recorded in `docs/research/spike-results.md`.

1. **S0.1 Write throughput**: from Node+evo-sdk on testnet, create N `packChunk`-shaped docs (~15 KiB payload). Measure: serial ST latency; pipelined sequential-nonce broadcasting (window 2/4/8) success rate; nonce-desync recovery. *Go/no-go input for Tier P UX claims.*
2. **S0.2 ST size ceiling**: binary-search actual max data payload per document create (validate 3×5120 fields fit under 20,480 signed).
3. **S0.3 Proof-mode perf in browser**: `EvoSDK.testnet()` vs `testnetTrusted()` — connect time, query latency, WASM memory. Decides web default.
4. **S0.4 Identity mint in Node**: replicate bridge flow headlessly (faucet POST → asset-lock tx → InstantSend lock → `identities.create`) using `../mainnet-bridge/src/{transaction,proof,crypto,platform}` as reference. Deliverable: `spikes/mint-identity.mjs` — becomes the e2e fixture generator.
5. **S0.5 isomorphic-git pack reading** from an IndexedDB-backed store; index-pack in browser for a 10 MiB pack; time + memory.
6. **S0.6 Contract validation**: draft both contract JSONs, `fullValidation: true` construction locally, measure serialized size vs 16 KiB.

Exit criteria: all six spikes documented with numbers; contract drafts validate; identity minting scriptable.

## Phase 1 — Contracts + forge-core foundation

- `forge-contracts`: final v1 schemas (per data-contracts.md), schema lint, validation tests, `deploy.mjs`, testnet deployment → `deployments/testnet.json`.
- `forge-core`: PlatformClient (init/reconnect/preload), WriteEngine (idempotent ST + nonce serializer + pipelining behind a flag), document services (Repo/Ref/Collab), authz module (`AUTHZ_RULES_V1` + versioned test vectors), keystore (bridge-JSON import, encrypted at rest), constants.
- Unit tests: authz vectors, chunker bounds, error taxonomy. Integration tests (testnet): repo CRUD, collaborator grant/revoke, refUpdate resolution incl. unauthorized-writer filtering.

**Milestone M1**: `node demo.mjs` creates repo, grants collaborator, writes/reads refs — proof-verified — on testnet.

## Phase 2 — Pack pipeline + storage adapters

- PackPipeline: pack build (system git), sha256, chunk/assemble, `pack` manifest planning, supersedes graph, verifier.
- Adapters: https (read), IPFS Storacha+Pinata+gateway-race, S3. Registry + credential storage. Failover policy + corruption fail-over tests (tampered-fixture).
- Tier P chunk write/read path with pipelined writes.

**Milestone M2**: script pushes a real repo's pack to IPFS + manifests on testnet; second machine reassembles & `git fsck` passes. Same for Tier P with a small repo.

## Phase 3 — git-remote-dash + forge-cli

- Helper: list/fetch/push protocol, want/have negotiation vs manifests, force/delete refs, pending-ST crash recovery, progress meters.
- dforge: full command tree (PRD 02), `--json` everywhere, cost estimates, `storage status`, `reseed`, `repack`, `doctor`.
- Cross-platform: macOS + Linux (Windows best-effort v1.1); npm distribution (`npm i -g @dash-forge/cli` installs both bins).

**Milestone M3**: `git clone dash://…`, edit, `git push`, clone elsewhere — byte-identical; two-maintainer flow works; kill-mid-push recovers. This is the protocol-complete moment.

## Phase 4 — forge-web MVP

- Scaffold (static export + WASM config from yappr), design system implementation (style guide), platform-auth integration.
- Read surfaces: repo home/tree/blob/commits/commit-diff/branches/tags with verification chips; IndexedDB pack store.
- Write surfaces: repo create (cost preview), settings (storage tier, collaborators, delete+refund), issues (full lifecycle), stars.
- Discovery: landing, user profiles, DPNS.

**Milestone M4**: full PRD-03 v1 acceptance criteria green on testnet; deployed to GitHub Pages.

## Phase 5 — Hardening + e2e automation

- Full e2e suite per [e2e-test-plan.md](testing/e2e-test-plan.md): fixture-identity pool, CLI suite, Playwright web suite, cross-client (CLI↔web) suite, chaos tests (URI corruption, DAPI flap, faucet-funded fresh-identity onboarding).
- Perf against PRD budgets; a11y audit; security pass (key handling, XSS in rendered markdown/filenames — sanitize like yappr, CSP).
- Docs: user guide ("host your repo in 10 minutes"), forge-core API docs.

**Milestone M5**: nightly CI green on testnet 7 days straight.

## Phase 6 — v1.1 collaboration completion

- PR/review UI end-to-end, merge flows (FF web-native; merge-commit via CLI assist), fork chains + fork button, releases with assets, repack/gc UX, gitmirror adapter.

**Milestone M6**: PR opened from a fork in web, reviewed, merged by maintainer; release published with IPFS asset.

## Phase 7 — Mainnet launch

- Contracts deployed to mainnet (same deployer flow; IDs → `deployments/mainnet.json`); web network switcher; production smoke suite (real small-value identities — see e2e plan §7); docs + announcement; forge repo self-hosts on Forge (dogfood: `dash://forge/dash-forge` becomes a mirror of record).

## Dependency-driven ordering notes
- Phases 1→2→3 are strictly sequential (each consumes the previous layer).
- Phase 4 can start UI shell + auth in parallel with Phase 3 (depends only on forge-core services from M1/M2).
- e2e infra (S0.4 identity minting) is built in Phase 0 deliberately — every later phase's tests use it.

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Nonce pipelining unreliable → Tier P pushes very slow | Med | S0.1 measures early; fallback = serial writes + "platform tier is for small repos" positioning; batch-size>1 may land upstream (issue #2867) |
| evo-sdk 4.x RC churn / breaking changes | Med | Pin exact versions; forge-core isolates SDK; track `../platform` releases |
| Testnet instability breaks CI | High | Retry taxonomy; nightly (not per-PR) testnet suite; cached fixture identities; local devnet (dashmate) as contingency |
| IPFS gateway flakiness in browser | High | Gateway race + multi-URI manifests + packMirror reseeding |
| 100-doc query cap makes huge repos slow to enumerate packs | Low | Repack consolidation keeps live manifest count small by design |
| Contract size > 16 KiB | Low | S0.6 validates; split further if needed (packChunk into its own contract) |
| Faucet rate-limit/CAP blocks CI identity minting | Med | Pre-provisioned identity pool topped up out-of-band; mint only for onboarding tests |
