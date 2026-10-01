# Dash Forge — E2E & Production Test Plan

Full pyramid with emphasis on **real end-to-end testing against live networks**, using bridge.thepasta.org / faucet.thepasta.org for identities and funds. Acceptance criteria from `../INIT.md` are the north-star scenarios (marked ⭐).

## 1. Test infrastructure: identities & funding

forge-v2 (shared contracts forge-core + forge-collab, Platform protocol 14; [contracts/forge-v2.md](../contracts/forge-v2.md)) targets **devnet sakura** (the RC2 contracts on Platform v5.0.0-beta.1, registered 2026-10-01; bonsia with the RC1 contracts until 2026-10-01, moutai until 2026-09-29), so every live suite runs there. Testnet runs resume once protocol 14 reaches testnet and forge-v2 is registered there.

### 1.1 Obtaining identities (devnet sakura)

**A. Pre-provisioned fixture pool (primary).** Funded sakura identities minted by `make devnet-identities` (`tools/mint-identity pool`, funded from the devnet's faucet wallet key; manual top-ups from https://faucet.sakura.networks.dash.org), as bridge-format JSON (mnemonic + keys incl. High/Critical AUTH WIFs). Roles: OWNER (owns the test repos, adds and removes members), MAINTAINER, COLLAB (added as a writer, then removed), CONTRIB (never a member), CI-RUNNER, RELAY, DEPLOYER (registered the RC1 contracts on sakura), TREASURY. CI secrets; locally `~/.config/dash-forge/test-identities/devnet-sakura/` (gitignored — yappr's checked-in identity JSONs are explicitly not repeated). `make devnet-identities-verify` checks balances and keys.

**B. Programmatic minting (`tools/mint-identity`, built in Phase 0 S0.4).** Headless flow reimplementing the bridge: derive HD keys → fund the deposit address (a devnet funding key; on testnet `POST https://faucet.thepasta.org/api/core-faucet {address}`, **3/hour/IP**, with TREASURY as the fallback) → asset-lock tx → chain lock (devnet) or InstantSend lock (testnet) → `identities.create` → bridge-format JSON out. Used for onboarding tests, pool replenishment, top-ups.

### 1.2 Environments

| Env | Purpose |
|---|---|
| **Devnet sakura** (protocol 14, drive 5.0.0-beta.1) | All integration + e2e suites; contract re-registration rehearsals (`deploy-v2.mjs --force-new`) |
| Testnet | The same suites once protocol 14 and forge-v2 are live there |
| Mainnet | Production smoke (§8) after forge-v2 is registered there |

Contract ids from the `v2` section of `forge-contracts/deployments/<network>.json` (`devnet-sakura.json`); never hardcoded. forge-v2 repositories, issues, PRs, events and Platform-stored packs cannot be deleted, so suites reuse reserved fixture repos (e2e/README.md) and write fresh `e2e/<run-id>/…` branches, deleting the refs after each run, instead of creating and deleting repositories.

## 2. Pyramid

| Layer | Tooling | Network | When |
|---|---|---|---|
| Unit: chunker bounds, offset index, pack assembly, rules folds, cost math, backends (mocked) | cargo test / vitest | none | every PR |
| **Conformance vectors** (`FORGE_RULES_V2`, `forge-contracts/vectors/`): Rust and TS suites against shared JSON fixtures — ref resolution, protected patterns, issue/PR folds over `event` + `authorEvent`, numbering, approvals, pack reader rule and pack list, plaintext-or-`enc`, repo names | both | none | every PR |
| Contract validation: `tools/contract-validate` builds forge-core + forge-collab with `fullValidation` at `PlatformVersion` 14, signed transition < 20,480 B, index bounds; `--previous` checks an update against the registered schema | cargo | none | every PR |
| Integration: forge-core services against live contracts | cargo test (serial per identity) | devnet sakura | nightly + pre-merge label |
| E2E CLI (real `git` + helper + dg) | bash harness (`e2e/cli/run.sh`) | devnet sakura | nightly + release |
| E2E Web | Playwright | devnet sakura | nightly + release |
| Relay + import + chaos | mixed | devnet sakura | release |
| Production smoke | scripted | mainnet | post-deploy + weekly |

Flake policy: writes always via the idempotent WriteEngine (a timeout-flake is a product bug, not a test bug); one job-level retry; persistent failures invoke the network-instability playbook.

## 3. Membership-gate consensus suite (the novel risk)

1. ⭐ **Revoked writer's push fails at consensus**: OWNER adds COLLAB (`dg collab add <owner/name> <COLLAB> --role writer`) → COLLAB pushes OK → OWNER removes it (`dg collab remove`, deleting the `writer` document) → COLLAB's next chunk/refUpdate ST **rejected by the network** with 40120 (assert the consensus error, not a client refusal). CLI scenario 04.
2. `dg collab list` reflects adds and removes (the on-chain member list is correct).
3. CONTRIB (never a member) refUpdate ST rejected at consensus (40120, CLI scenario 05); un-gated `issue`/`comment`/`patch`/`review` creation succeeds.
4. Maintainer gating: a writer cannot create `protectedRefUpdate`/`config`/`release`/`webhook`/`repoKey`; a maintainer can. Only the repo owner can create `maintainer`/`writer` documents.
5. **Events**: a member's `event` is accepted for every kind; the target's author may post `authorEvent` close/reopen only; a stranger's close is refused at consensus (40120, CLI scenario 09). A revoked member's past events stay valid.
6. **Non-deletable types**: any identity's attempt to delete its own `refUpdate`/`protectedRefUpdate`/`config`/`packManifest`/`manifestPart`/`chunk`/`event`/`authorEvent`/`issue`/`patch`/`repo` is rejected by the platform — the branch-rewind, silent-reopen and pack-yank attacks are structurally impossible.
7. **Protected-ref rules**: MAINTAINER posts `config` protecting `refs/heads/main` → a writer's plain refUpdate on main is accepted at consensus but **inert under FORGE_RULES_V2** (fresh clone ignores it; conformance vectors cover the as-of-time boundary: pre-protection updates remain valid, tie-at-same-timestamp resolves protected).
8. **Pack front-running**: a stranger (or revoked writer) posting a manifest or chunk with an honest pack's hash does not block the honest upload (`$ownerId` in every pack-write unique index) and is ranked last by the reader rule.
9. **Count correctness**: star/follow/issue/PR/comment counts via count queries (+WithProof) match paginated ground truth after concurrent create/delete churn; `chunk(packHash)` count vs `manifest.chunkCount` audit detects a deliberately withheld chunk.
10. Edge probes (documented, not asserted until semantics reviewed): re-add after remove (counts from the new document); contract update that tries to loosen a gate (refused by `validate_update`).

## 4. E2E CLI suite

Assertions: `git fsck` clean, `git rev-parse` equality, object counts, worktree `diff -r`.

**Implemented today** (`e2e/cli/run.sh`, `make e2e`, 11 scenarios on sakura against the OWNER-owned `e2e-cli` repo; details in `e2e/README.md`): 01 round-trip, 02 non-ff, 03 ref delete, 04 revoked-writer push, 05 non-member push, 06 third-party verify, 07 depth + filter, 09 issue lifecycle, 10 PR from a fork, 11 release asset, 12 star/unstar. (08 was the forge-v1 read-compat scenario, removed with v1; the number is not reused.) `make storage-e2e` (`e2e/cli/storage-byo.sh`) covers bring-your-own storage. The full plan:

1. **Round-trip, platform backend**: seeded repo (100 commits, binaries, tags, symlinks) push → fresh clone byte-identical; proof-verified refs.
2. ⭐ **Monorepo round-trip**: clone/push of the **Dash Platform monorepo** itself (mixed backend).
3. **Scale ladder** (from S0.1, kept as regression): 5 MB / 25 MB / 100 MB packfile pushes — wall-clock + credits vs estimates recorded; alert on >20% drift (fees-ledger regression).
4. ⭐ **Interrupted 100 MB push resumes**: kill -9 mid-upload → re-push completes **without re-paying for uploaded chunks** (journal), fees ≈ single-push.
5. **Multi-member**: `dg collab add` → COLLAB pushes → third machine sees COLLAB's tip; `dg collab remove` → push fails at consensus (overlaps §3.1 at git-porcelain level; scenario 04).
5b. **Concurrent-push race**: OWNER and COLLAB both push fast-forwards from the identical prevOid simultaneously → both STs land at consensus; the losing helper's post-push verification reports a late non-fast-forward (never a silent success); fresh clone shows the ref as diverged/provisional per FORGE_RULES until a superseding merge/force push; conformance vectors cover the divergence fold.
6. **Force-push / delete / protected refs**: non-FF refused without `+`; force flag recorded; zero-OID delete; protected pattern routes to `protectedRefUpdate` and a writer (not maintainer) pusher fails.
7. **Partial clone**: `--filter=blob:none` clone writes `.promisor` markers, then a lazy blob read triggers a bare-OID fetch via offset index — bytes transferred ≪ full pack (assert ranged fetch happened). **Shallow clone unsupported**: `--depth 1` **fails loudly** with a clear error (never a silent full clone) — Design Freeze #1, S0.9.
8. ⭐ **jj compatibility**: jj (git backend, ≥ 0.43, **no colocation**) init/fetch/push against dash:// remote unmodified — S0.9-confirmed; kept as a CI smoke test guarding the gitoxide transport-delegation guarantee.
9. **Repack**: 10 pushes → `dg repack` → a superseding consolidated pack; nothing deleted on Platform (non-deletable chunks/manifests); readers prefer the consolidated pack; clone exact.
10. **Backends**: same pack via IPFS and S3 (MinIO) clones identically; tampered URI detected + failed over; `dg reseed` after host loss restores availability; mixed-mode cold/hot split works.
11. **dg workflow** ⭐: maintainer triages issues, reviews and lands a PR (`pr checkout`→`review`→`merge`), cuts a release — terminal only.
12. **Fresh-user onboarding**: mint identity via §1.1-B → `dg auth login` → repo create → push (zero prior state).
13. ⭐ **Third-party verification**: standalone script (no forge-core) reconstructs a clone from raw DAPI queries + manifests and verifies every hash — "no trust in any server" acceptance.

## 5. E2E Web suite (Playwright vs a static build for devnet sakura)

The specs read the forge-v2 read fixture (`forge-v2-demo` and `forge-v2-empty` on sakura), seeded idempotently by `forge-contracts/scripts/seed-v2-fixture.mjs`.

1. **Logged-out browse**: tree/blob/blame/history/README/diff on the seeded repo; verification chips; request-interception proves zero non-DAPI/non-backend origins.
2. **Auth**: key login, password vault, passkey PRF (virtual authenticator), logout clears storage.
3. **Repo lifecycle**: create (three documents + cost preview), settings, backend switch.
4. **Issues**: full lifecycle across two browser identities; labels (member); event timeline order; visitor sees updates within poll interval.
5. ⭐ **Full review flow**: line comment → request changes → re-review → **merge from browser** (fast-forward or a disjoint-path merge commit, by Forge's own merge engine); merged state visible to CLI clone.
6. **Browser edit**: CodeMirror edit → commit → push → visible in CLI clone.
7. **Collaborator UI ↔ CLI parity**: web add member → immediate CLI push; web remove → CLI push fails at consensus (40120).
8. **checkRun rendering**: CI-RUNNER writes check docs → PR shows status.
9. **Browse plane**: repo-of-any-size fixture (largest available, e.g. imported platform monorepo) → cold repo home renders < 500 KB transferred / < 3 s (request-interception byte accounting); blob + directory + commit-log views stay O(view); degraded path (repo with no flatIndex/locator) still renders via object walk; materialization-tier features (search/blame) show the 100 MB size warning; warm reload < 1.5 s.
10. **Search**: per-repo client-side index finds seeded symbol; index persists in IndexedDB.
11. **Failure UX**: DAPI blackhole → reconnect; insufficient credits → bridge deep link.
12. **A11y/perf**: axe-core 0 serious; Lighthouse perf ≥ 80 / a11y ≥ 95. ⭐ IPFS-served deploy passes the same smoke.

## 6. Relay & import suites

**Relay**: ⭐ push → GitHub-shape webhook delivered < 30 s (HMAC verified; payload schema-validated against GitHub fixtures); ⭐ instance swap = one webhook-doc update, no other repo-side change; at-least-once + consumer dedupe documented test; reference CI consumer re-fetches from Platform and writes `checkRun` back; SSRF guard tests.

**Import**: ⭐ dashpay/platform import — fidelity spot-check script (GitHub API vs Platform docs: counts, titles, states, threads, labels) and ⭐ **cost within 10% of pre-estimate**; `--dry-run` writes nothing; interrupt + `--resume` no duplicates/double fees; gist-claim flow renders claimed identity in web + dg.

## 7. Contract lifecycle testing

Every forge-core/forge-collab schema change: `tools/contract-validate` (with `--previous` against the registered schema, to tell an in-place update from a re-registration) → register or update on sakura (`deploy-v2.mjs`, `--force-new` when the update rules refuse the change) → re-seed the read fixture → full nightly; testnet the same once it runs protocol 14. Post-deploy assertion: both contracts fetch with proof and are enrolled in the recorded contract group (`dg doctor` checks this), plus a canary document per gated type.

## 8. Production (mainnet) smoke — post-deploy + weekly, budget ≤ 0.05 DASH/run

forge-v2 repositories, issues and Platform-stored packs are permanent, so the smoke reuses one repository rather than creating and deleting one per run.

1. PROD identity pushes a tiny commit to a fresh `smoke/<date>` branch of `forge-smoke` (platform backend) → fresh clone verify → issue create/close → delete the branch.
2. Playwright against production web deploy (Pages + IPFS mirror) on mainnet: browse dogfood repo (`dash://forge/dash-forge`), chips green.
3. Relay heartbeat: smoke webhook delivered from mainnet push.
4. Alerting: failure → repo issue + notification channel; balance watchdog at < 2× run cost.

## 9. CI wiring

- **PR**: unit + vectors + contract validation + builds (< 10 min, no network).
- **Nightly** (`Devnet Nightly` workflow): seeds the v2 read fixture (`forge-contracts/scripts/seed-v2-fixture.mjs`, idempotent) → Playwright against a sakura build → CLI e2e suite (`e2e/cli`, 11 scenarios) on sakura. Funded jobs run only when the fixture identity secrets are configured and report SKIP otherwise. Teardown deletes the run's `e2e/<run-id>/…` refs; documents that cannot be deleted stay in the reserved fixture repos.
- **Release**: nightly + scale ladder + backends/chaos + relay + import + fees ledger + onboarding.
- **Post-deploy/weekly**: mainnet smoke.
- Serialization: one live job per fixture identity (nonce discipline); parallelism across identities, not within.
