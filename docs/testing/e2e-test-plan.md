# Dash Forge — E2E & Production Test Plan

Full pyramid with emphasis on **real end-to-end testing against live networks**, using bridge.thepasta.org / faucet.thepasta.org for identities and funds. Acceptance criteria from `../INIT.md` are the north-star scenarios (marked ⭐).

## 1. Test infrastructure: identities & funding

### 1.1 Obtaining identities (testnet)

**A. Pre-provisioned fixture pool (primary).** 8+ funded testnet identities minted via bridge.thepasta.org (`?network=testnet`), exported bridge-format JSON (mnemonic + 5 keys incl. High/Critical AUTH WIFs). Roles: OWNER, MAINTAINER, COLLAB, CONTRIB (no tokens), FROZEN (suspended collaborator), CI-RUNNER, RELAY, DEPLOYER, TREASURY. CI secrets; locally `~/.config/dash-forge/test-identities/` (gitignored — yappr's checked-in identity JSONs are explicitly not repeated). `pretest` balance guard auto-tops-up or fails with instructions.

**B. Programmatic minting (`spikes/mint-identity` → `tools/mint-identity`, built in Phase 0 S0.4).** Headless flow reimplementing the bridge: derive HD keys → `POST https://faucet.thepasta.org/api/core-faucet {address}` (~1 tDASH; **3/hour/IP**, optional CAP PoW solver; on 429 fall back to L1 spend from TREASURY) → poll Insight for UTXO → type-8 asset-lock tx → InstantSend lock → `identities.create` → bridge-format JSON out. Used for onboarding tests, pool replenishment, top-ups.

### 1.2 Environments

| Env | Purpose |
|---|---|
| Local devnet (dashmate, `../platform`) | Contract/template update rehearsals, destructive token-ACL probing |
| **Testnet** | All integration + e2e suites (default) |
| Mainnet | Phase 1 M1 protocol validation (small repos) + production smoke (§8) |

Contract/template IDs from `forge-contracts/deployments/<network>.json`; never hardcoded. Test repos namespaced `e2e-<runId>-*`, deleted in teardown (refunds keep the pool solvent — deletion is itself under test).

## 2. Pyramid

| Layer | Tooling | Network | When |
|---|---|---|---|
| Unit: chunker bounds, offset index, pack assembly, rules folds, cost math, backends (mocked) | cargo test / vitest | none | every PR |
| **Conformance vectors** (`FORGE_RULES_V1`): Rust and TS suites against shared JSON fixtures — ref resolution, protected patterns, event folds, claim mapping | both | none | every PR |
| Contract validation: registry+template construct `fullValidation`, serialized < 16 KiB, index bounds, tokenCost config | wasm-sdk harness | none | every PR |
| Integration: forge-core services against live contracts | cargo test (serial per identity) | testnet | nightly + pre-merge label |
| E2E CLI (real `git` + helper + dg) | bash/rust harness | testnet | nightly + release |
| E2E Web | Playwright | testnet | nightly + release |
| Relay + import + chaos | mixed | testnet | release |
| Production smoke | scripted | mainnet | post-deploy + weekly |

Flake policy: writes always via the idempotent WriteEngine (a timeout-flake is a product bug, not a test bug); one job-level retry; persistent failures invoke the testnet-instability playbook (devnet contingency).

## 3. Token-ACL consensus suite (the novel risk — S0.7 grown into permanent tests)

1. ⭐ **Frozen identity's push fails at consensus**: OWNER grants COLLAB (mint 10⁹ WRITE) → COLLAB pushes OK → OWNER freezes → COLLAB's next chunk/refUpdate ST **rejected by the network** (assert consensus error, not client refusal).
2. Revoke = freeze + destroy frozen funds → balance query shows removal (on-chain collaborator list correct).
3. CONTRIB (no tokens) refUpdate ST rejected; un-gated `issue`/`comment`/`patch` creation succeeds.
4. MAINTAIN gating: COLLAB (WRITE only) cannot create `protectedRefUpdate`/`release`/`label`/`webhook`; MAINTAINER can.
5. Group-held admin: two-identity group mints/freezes (org scenario).
6. Edge probes (documented, not asserted until semantics reviewed): frozen identity delete-for-refund; re-grant after destroy; token behavior across contract update.

## 4. E2E CLI suite

Assertions: `git fsck` clean, `git rev-parse` equality, object counts, worktree `diff -r`.

1. **Round-trip, platform backend**: seeded repo (100 commits, binaries, tags, symlinks) push → fresh clone byte-identical; proof-verified refs.
2. ⭐ **Monorepo round-trip**: clone/push of the **Dash Platform monorepo** itself (mixed backend).
3. **Scale ladder** (from S0.1, kept as regression): 5 MB / 25 MB / 100 MB packfile pushes — wall-clock + credits vs estimates recorded; alert on >20% drift (fees-ledger regression).
4. ⭐ **Interrupted 100 MB push resumes**: kill -9 mid-upload → re-push completes **without re-paying for uploaded chunks** (journal), fees ≈ single-push.
5. **Multi-maintainer**: grant → COLLAB pushes → third machine sees COLLAB's tip; suspend → push fails (overlaps §3.1 at git-porcelain level).
6. **Force-push / delete / protected refs**: non-FF refused without `+`; force flag recorded; zero-OID delete; protected pattern routes to `protectedRefUpdate` and WRITE-only pusher fails.
7. **Partial/shallow clone**: `--depth 1` and sparse path fetch via offset index — bytes transferred ≪ full pack (assert ranged fetch happened).
8. ⭐ **jj compatibility**: jj (git backend) init/fetch/push against dash:// remote unmodified.
9. **Repack/GC**: 10 pushes → `dg repack` → superseded docs deleted → clone exact; **storage refund observed** in balance; steady-state cost ≈ current size.
10. **Backends**: same pack via IPFS and S3 (MinIO) clones identically; tampered URI detected + failed over; `dg reseed` after host loss restores availability; mixed-mode cold/hot split works.
11. **dg workflow** ⭐: maintainer triages issues, reviews and lands a PR (`pr checkout`→`review`→`merge`), cuts a release — terminal only.
12. **Fresh-user onboarding**: mint identity via §1.1-B → `dg auth login` → repo create → push (zero prior state).
13. ⭐ **Third-party verification**: standalone script (no forge-core) reconstructs a clone from raw DAPI queries + manifests and verifies every hash — "no trust in any server" acceptance.

## 5. E2E Web suite (Playwright vs static build on testnet)

1. **Logged-out browse**: tree/blob/blame/history/README/diff on CLI-seeded repo; verification chips; request-interception proves zero non-DAPI/non-backend origins.
2. **Auth**: key login, password vault, passkey PRF (virtual authenticator), logout clears storage.
3. **Repo lifecycle**: create (contract instantiate + cost preview), settings, backend switch, delete + refund estimate.
4. **Issues**: full lifecycle across two browser identities; labels (MAINTAIN); event timeline order; visitor sees updates within poll interval.
5. ⭐ **Full review flow**: line comment → request changes → re-review → **merge from browser** (FF/clean via isomorphic-git); merged state visible to CLI clone.
6. **Browser edit**: CodeMirror edit → commit → push → visible in CLI clone.
7. **Collaborator token UI ↔ CLI parity**: web grant → immediate CLI push; web suspend → CLI push fails at consensus.
8. **checkRun rendering**: CI-RUNNER writes check docs → PR shows status.
9. **Large-repo UX**: 100 MB fixture → lazy-fetch tree view within budget; size warning; warm reload < 1.5 s.
10. **Search**: per-repo client-side index finds seeded symbol; index persists in IndexedDB.
11. **Failure UX**: DAPI blackhole → reconnect; insufficient credits → bridge deep link.
12. **A11y/perf**: axe-core 0 serious; Lighthouse perf ≥ 80 / a11y ≥ 95. ⭐ IPFS-served deploy passes the same smoke.

## 6. Relay & import suites

**Relay**: ⭐ push → GitHub-shape webhook delivered < 30 s (HMAC verified; payload schema-validated against GitHub fixtures); ⭐ instance swap = one webhook-doc update, no other repo-side change; at-least-once + consumer dedupe documented test; reference CI consumer re-fetches from Platform and writes `checkRun` back; SSRF guard tests.

**Import**: ⭐ dashpay/platform import — fidelity spot-check script (GitHub API vs Platform docs: counts, titles, states, threads, labels) and ⭐ **cost within 10% of pre-estimate**; `--dry-run` writes nothing; interrupt + `--resume` no duplicates/double fees; gist-claim flow renders claimed identity in web + dg.

## 7. Contract & template lifecycle testing

Devnet → testnet rehearsal for every registry/template change; post-deploy assertion (fetch, diff vs source, canary doc per type incl. token-gated ones); template-migration drill: repo on template v1 while v2 exists — listing `templateVersion` honored by all clients; backward-compat CI gate (additive-only schema changes).

## 8. Production (mainnet) smoke — post-deploy + weekly, budget ≤ 0.05 DASH/run (mostly refunded)

1. PROD identity creates `forge-smoke-<date>` (platform backend) → tiny push → fresh clone verify → issue create/close → **repo delete** (refund reclaimed).
2. Playwright against production web deploy (Pages + IPFS mirror) on mainnet: browse dogfood repo (`dash://forge/dash-forge`), chips green.
3. Relay heartbeat: smoke webhook delivered from mainnet push.
4. Alerting: failure → repo issue + notification channel; balance watchdog at < 2× run cost.

## 9. CI wiring

- **PR**: unit + vectors + contract validation + builds (< 10 min, no network).
- **Nightly**: testnet integration + token-ACL + CLI e2e + web e2e; pool balance check first; teardown deletes `e2e-*` repos (`finally` + weekly orphan sweeper).
- **Release**: nightly + scale ladder + backends/chaos + relay + import + fees ledger + onboarding.
- **Post-deploy/weekly**: mainnet smoke.
- Serialization: one testnet job per fixture identity (nonce discipline); parallelism across identities, not within.
