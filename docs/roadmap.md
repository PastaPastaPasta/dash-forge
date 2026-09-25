# Dash Forge — Product Roadmap (2026-09-24)

**The promise:** git hosting that nobody can take down. Refs, issues, PRs and access control live on Dash Platform under the users' own keys. Bulk pack data lives on Platform, or on cheap storage providers (S3, IPFS, HTTPS, other git hosts) that it is checked against by hash. No server is ever trusted, and every server can be replaced.

This document covers three things:
- where the project actually stands, checked against the code on `master` and not against the tracker's status lines;
- the owner's decisions, and the questions still open;
- the ordered plan that turns a testnet proof-of-concept into something real users would choose.

---

## 1. History

| When | What happened |
|---|---|
| 2026-07-22 | Design brief (`../INIT.md`), then a full planning suite in one day: research, architecture, contracts, 6 PRDs and an economics model. Nine de-risking spikes (throughput, chunk sizing, proofs, token ACL, browse plane, query cursors, helper transport) led to Design Freeze #1, verdict **GO**. Testnet registry deployed. |
| 2026-07-22 → 23 | Stages 2–6 built in about 36 hours: `forge-core`, `git-remote-dash` (**M1**: byte-identical `git clone`/`git push` round-trip on testnet), `dg` plus `forge-relay` (**M2**: push → webhook → CI check written back), `forge-web` plus `forge-import` (**M3**: web app live, GitHub import within 1.1% of the cost estimate), backends and repack/GC (**M4**), CLI and Playwright e2e suites. The registry was redeployed to fix a `$createdAt` index defect. `EXECUTION.md` declared "ALL STAGES COMPLETE". |
| 2026-08-06 → 26 | Maintenance: a watchdog for stalled pushes in the importer, GFM tables, a persistent in-browser clone cache, and moving the web app to `forge.dashhq.org`. A web PR-diff renderer was written on `fix/pull-request-diff` but **never merged**. |
| 2026-09-10 → 22 | An honesty and correctness pass (PRs #1–#4):<br>• **#1** The Rust workspace did not even parse, and the nightly had been passing without running anything.<br>• **#2** Every read was silently capped at 100 rows. That made folds confidently wrong: issues showed open after being closed, branches froze at push #100, packs were read from the wrong index, and branch protection turned itself off.<br>• **#3** Three PR commands reported success for work they never did, and review verdicts were written but never read.<br>• **#4** No code path ever published the browse index (open). |

**What the history tells us.** The architecture is sound and the hard protocol problems are solved. Consensus-enforced ACLs work: a frozen push is rejected with 40702. Proof-verified reads, resumable pushes, and a cross-client rules engine with 70 conformance vectors are all in place. The build log's "complete", though, meant *demonstrated once on testnet*, not *usable by a stranger*. Every audit since has found product claims the code doesn't back up. The first job is to make the product true. The second is to make it wanted.

## 2. Where it stands today (verified on `master` @ `b0bc7bb`)

### Works
- `git clone`/`git push` over `dash://<ownerId>/<repo>`: resumable push, partial clone, jj compatibility, consensus-rejected unauthorized pushes.
- `dg`: issues, PRs (list/view/review/checkout/diff), releases, collaborator grant/suspend/revoke, cost estimate and audit, repack, reseed, doctor.
- `forge-import`: GitHub import of code, issues, PRs, releases, labels and milestones, with a spending cap, a dry run and resume.
- Web: browsing code (tree, blob, README, highlighting, branch switcher), issues (create/comment/close), repo creation with a cost preview, collaborator management, an in-browser fallback clone.

### Gaps that stop real users (ordered by severity)
1. **Testnet only.** There is no mainnet registry. The CLI, relay and doctor hard-code `TESTNET_REGISTRY_CONTRACT_ID` (`crates/forge-core/src/repo.rs:51`), and the web app's mainnet ids are `null`.
2. **A repo costs ~1.18 DASH (~$40), with no refund.** This is structural, not waste. Platform's contract registration fees (`rs-platform-version/.../data_contract_registration/v2.rs`) charge 0.1 base + 0.02 per document type + 0.01 per index + 0.1 per token. For repo-v1 (15 types, 28 indices, 2 tokens) that comes to **0.88 DASH in fees alone**, plus storage. Trimming the template can't get this under ~0.5 DASH, and a fork costs the same again.
3. **The headline feature is not wired into pushes.** `git push` always stores packs on Platform (`storage: 0`, `crates/git-remote-dash/src/helper.rs:518`) whatever the repo's backend setting says. Cheap storage only happens through `dg repack`/`reseed`. S3 has no SigV4, so authenticated buckets (AWS, R2, B2) don't work. There is no IPFS pinning service, and reads are pinned to the single `ipfs.io` gateway.
4. **No path in for a new user.** No release binaries (users must build a large Rust tree with protoc), no DPNS names (URLs need 44-character base58 ids), plaintext key files, no identity creation in the web app, and login means pasting a raw private key.
5. **The web app says things that aren't true.** The trust panel hard-codes `refs: 'verified', packs: 'verified'` (`components/repo/repo-rail.tsx:35`). "Merge" records an event but merges nothing, and it is shown to users who can't merge. Star/follow buttons always start un-set. The Archive button does nothing.
6. **The trust story has single points of failure.** The web app is served from GitHub Pages behind one domain. Both the CLI and the web app get quorum keys from one HTTPS endpoint: the docs say the CLI is "fully trustless", but it uses `TrustedHttpContextProvider` (`crates/forge-core/src/platform.rs:219`). There is one IPFS gateway. Identity bootstrap points at one bridge site.
7. **No real code review.** No PR diff on `master`, no line-level commit diffs, no inline comments, no approve/request-changes in the web app, no opening a PR or merging from the browser. `dg repo fork` is a stub.
8. **CI is red.** The testnet nightly has failed every night since 2026-09-11, which is the first night it actually ran. The causes: a landing-page contrast (a11y) failure, scenario 07 hitting the 60-minute timeout, and transport flakes turning scenarios 02 and 04 into SKIPs.

## 3. Who it's for (the beachhead)

**Forge hosts nothing.** It is a static frontend (GitHub Pages) plus a CLI. A user brings exactly one thing: an S3-compatible bucket (AWS, R2, B2, MinIO…), an IPFS node or pinning account, or Platform credits (highest cost, maximum decentralization). Forge never runs infrastructure on anyone's behalf: no default replicas, no public relay, no sponsored identities.

Trust has to come before commitment. Nobody moves their main repo to a new host on day one, but plenty will add a **mirror that can't be taken down** if it takes one YAML file and their own bucket.

| Persona | Why they care | First product they touch |
|---|---|---|
| **OSS maintainer at risk of takedown** (privacy tools, crypto, anything near DMCA or sanctions) | GitHub has removed repos like theirs before | **Forge Mirror Action**: a continuous GitHub → Forge mirror into their own bucket |
| **Dash ecosystem** (launch partner: **dashpay mirrors on mainnet**) | Dogfooding; a credible "we host ourselves" | Mirror, then primary hosting |
| **Developers who want to own their setup** | Their identity, their bucket, their history | `dg` + `git-remote-dash` |
| **Teams with sensitive code** | Private repos with no host who can read them | Private repos (encrypted to recipients) |
| **Visitors / contributors** | Read, clone, file an issue, send a PR | forge web |

**How it grows:** first a mirror (insurance), then Forge's own issues and PRs (a second home), then Forge as the primary host with GitHub as the mirror.

## 4. Non-negotiable invariants (the ethos)

Every roadmap item must keep all of these true:
1. **We host nothing.** No feature may require infrastructure operated by the Forge project. Anything that looks hosted is either a static asset or something the user runs.
2. **No server in the trust path.** Anything the product contacts (web host, DAPI node, gateway, relay, bucket) may lie or disappear. Correctness comes from proofs and hashes, and availability from redundancy the user controls.
3. **No moderation.** The contracts are registered without Platform contract moderation, so no one can ban identities or delete content at the protocol level.
4. **The UI shows only what was verified.** A "verified" badge comes from a check that actually passed, and a button's label says what the click actually does.
5. **Cost honesty.** Show an estimate before every paid write, split into deposit and burn, with DASH primary. No surprise spend, including on `git push`.
6. **Zero workflow change.** Plain git and jj; `dg` mirrors `gh`.

## 5. Decisions

### Decided (owner, 2026-09-24)
| # | Decision |
|---|---|
| D-A | **One shared forge-v2 contract pair (forge-core + forge-collab, in one PV14 contract group) with PV14 writer gates.** Membership docs (`maintainer`/`writer`, keyed by repo and member) are granted by the repo owner only. Write-path types declare `ownerRefersTo` lookups, and `event` is gated too so authorization survives revocation. Refs, manifests, config and events can't be deleted, because PV14 doesn't check references on deletes. The owner enrolls themselves as a maintainer at creation. **The per-repo "sovereign" tier is dropped:** anyone who wants their own rules registers their own copy of the template. Reviewed by a protocol architect (Fable 5.1), 2026-09-24. Spec: `docs/contracts/forge-v2.md`. |
| D-B | **Bring your own storage.** A repo's packs go to the backends its owner configures (S3-compatible, IPFS) or to Platform. Manifests and refs always stay on Platform. No Forge-run defaults. |
| D-F | **No moderation** on the contracts. |
| D-G | **Users fund their own identities.** No sponsored grants and no faucet in the product (the testnet/devnet faucet links are only for development). |
| D-H | **Private repos are in the first release.** |
| D-I | **Hosting = GitHub Pages only** (plus a published IPFS build users can pin themselves). |
| D-J | **Mainnet contracts are registered by the owner** once PV14 is active on mainnet (expected ~1 month after 2026-09-24; testnet ~1–2 weeks). All PV14 development happens on **devnet moutai** (protocol 14, drive 4.2.0-beta.4) until then. |
| D-K | External accounts (Apple signing, pinning services, cloud buckets) are **out of scope for now**. S3 and IPFS are tested against local MinIO and kubo only. |

### Still open
| # | Question | Default until decided |
|---|---|---|
| D-D | Who owns the mainnet registry and shared contract (identity and key custody)? | The owner decides before registering. The deploy script takes the owner identity as input. |
| D-C | Trust anchor: web app and CLI take quorum keys from a known HTTPS endpoint. | Cross-check ≥2 endpoints, disclose honestly in the trust panel; SPV quorum verification in the CLI later. |
| D-E | Should opening a PR require a token? | No: anyone may open one, with client-side spam filtering. |

## 6. Roadmap

Sizes: S ≈ days, M ≈ 1–2 weeks, L ≈ 3+ weeks of focused work. Phase 0 comes first. Phases 1 and 2 then run in parallel. Phase 2 targets moutai now and moves to testnet when PV14 activates there.

### Phase 0 — Make it true and green (S–M) · *gate: nightly green 7 days, zero misleading UI*
- [ ] Land PR #4 (browse index on push). Rebase and land `fix/pull-request-diff` (PR diff renderer).
- [ ] Fix the nightly: the landing-page contrast failure; the scenario 07 hang/timeout; transport flakes retried until they give a verdict rather than a SKIP.
- [ ] Trust panel driven by actual verification state, with "unverified" and "partial" states; remove the hard-coded "verified" chips.
- [ ] Show "Merge" only to WRITE/MAINTAIN holders and label it for what it does until Phase 4. Star/follow read their initial state; Archive is implemented or removed.
- [ ] Network config: registry and contract ids per network (testnet, **devnet** with a name such as `moutai`, mainnet) loaded from `forge-contracts/deployments/<network>.json` in forge-core, dg, the relay, doctor and web. No hard-coded ids.
- [ ] Docs: correct the CLI trust mode, the README status and domain, `EXECUTION.md` → this roadmap.

### Phase 1 — Bring your own storage, for real (L) · *gate: the survivability drill passes*
- [ ] `git push` honors the repo's storage config: packs go to the owner's backends, the manifest records every URI plus the hash, refs go to Platform. Platform chunks are used only when Platform is the configured tier.
- [ ] Storage profiles the user supplies once (`dg storage add`, and the web app's settings): S3-compatible with **SigV4** (AWS/R2/B2/MinIO), IPFS via their kubo API or any Pinning Service API endpoint they choose. Credentials stay local (OS keychain / browser-encrypted vault) and never go on-chain.
- [ ] Browser push: the web app uploads to the user's bucket directly (presigned or SigV4 in-browser; CORS setup guide), so web-only users can publish without the CLI.
- [ ] A replication policy chosen by the user (N targets; the push fails if fewer than N confirm).
- [ ] `packMirror` document so anyone can record extra mirrors on-chain (`dg reseed`). Readers race every recorded URI plus a user-configurable gateway list, with Platform chunks as the last resort.
- [ ] Web app IPFS build published on each release (users pin it themselves), reproducible, with its hash recorded on-chain so the loaded app can be verified.
- [ ] **Survivability drill** in CI (local MinIO + kubo): delete the bucket, stop a gateway, take down the web host, kill the relay. Clone and browse must still work from the remaining sources and must say why.

### Phase 2 — Shared contract on PV14 (L) · *gate: repo create ≤ 0.01 DASH on moutai; consensus rejects a revoked writer*
- [ ] Bump the Platform SDK pins to `v4.2.0-beta.4` (Rust git tag + `@dashevo/evo-sdk@4.2.0-beta.4`); add `--network devnet --devnet-name moutai` (DAPI addresses + `quorums.moutai.networks.dash.org`).
- [ ] `forge-v2` shared contract: `repo`, `writer`/`maintainer` membership docs keyed `(repoId, memberId)`, with the owner-only grant enforced by a `$ownerId` `propertyAgreement` against the repo doc; `ownerRefersTo` writer gates on ref/pack/manifest/release/config types; no moderation; `readonly` once final. Validated offline against rs-dpp beta.4, then registered on moutai.
- [ ] If the schema exceeds 16 KiB, split it into core and collab contracts that reference each other, joined by a PV14 contract group.
- [ ] forge-core, the web app and the conformance vectors on the new model. Cross-repo queries arrive for free (my PRs, activity, issue search), and forks point at parent packs.
- [ ] Migration: the importer copies v1 repos into forge-v2 (history preserved); v1 stays readable.
- [ ] Remove the per-repo contract (repo-v1 token ACL) write paths once forge-v2 is the default. Keep read compatibility.
- [ ] e2e on moutai: grant → push → revoke → the push is rejected at consensus, plus everything from the CLI suite.
- [ ] `git push` cost guard (`dash.costWarnThreshold`, `dash.confirm`).
- [ ] PV14 extras: **budget- and expiry-limited keys** bound to the forge contract for web login and CI runners (in place of raw key paste); `encryptedFor` for relay webhook secrets; `indexOnly` stars/follows.

### Phase 3 — Private repos (L) · *gate: an outsider with full bucket + chain access learns nothing but sizes and timing*
- [ ] Design (security-reviewed): a per-repo content key that encrypts packs and the private collab docs. The key is wrapped per member to their identity encryption key (ECDH, PV14 `encryptedFor` envelope where it fits). Key rotation on member removal re-wraps and re-encrypts future pushes; past content stays readable to past members (stated plainly).
- [ ] Encrypted packs in the user's bucket and on Platform; encrypted issue/PR bodies; ref names hashed.
- [ ] CLI and web decrypt paths; the trust panel shows the "private" state.

### Phase 4 — Adoptable (L) · *gate: public beta on testnet/moutai*
- [ ] Release pipeline: `dg` + `git-remote-dash` binaries for Linux, macOS and Windows as GitHub Release assets (unsigned on macOS for now), plus a checksummed install script, `cargo binstall`, and a Docker image for the relay that users run themselves.
- [ ] `dg auth`: OS keychain, 0600 fallback files; `dg auth new` guides the user through funding their own identity (QR asset lock; the faucet on test networks). DPNS username registration.
- [ ] DPNS everywhere: `dash://alice/project`, web `/alice/project`, collaborator grants by name, profile names.
- [ ] Web onboarding: create an identity in the browser from the user's own funds (QR asset lock), an encrypted key vault (passphrase/passkey), and limited keys (Phase 2).
- [ ] **Forge Mirror Action**: a GitHub Action that pushes every GitHub push into Forge using the repo's own bucket and a runner identity with a limited key. Issue/PR sync is incremental.
- [ ] `dg import` → forge-import, plus a continuous mirror mode.
- [ ] User docs: quick start, "bring your bucket" guides (R2, B2, S3, MinIO, kubo), migrating from GitHub, how to verify the forge isn't lying to you, key backup and recovery.

### Phase 5 — Daily-driver parity (L) · *gate: a maintainer runs a real project from the web app for a month*
- [ ] Line-level commit/PR diffs, inline review comments, approve/request-changes, re-review on new heads.
- [ ] Real merges from the browser (fast-forward and clean merges via isomorphic-git, pushed to the user's bucket), respecting protected refs.
- [ ] Open a PR from the browser; forks (`dg repo fork` = a few documents on forge-v2).
- [ ] Web editing (CodeMirror → commit → push); releases page with assets in the user's bucket; labels and assignees UI; history pagination, blame, in-repo code search; a poll-based notification inbox (local state).
- [ ] Relay: users run it (Docker), with `encryptedFor` webhook secrets and a check-run write-back Action.

### Phase 6 — Mainnet launch (S, gated on PV14 mainnet ≈ 1 month)
- [ ] The owner registers the forge-v2 contracts (D-D); commit `deployments/mainnet.json`; mainnet web build (network switch retained).
- [ ] dashpay mirrors on mainnet; Dash Forge hosts itself on Forge with GitHub as its mirror.
- [ ] Weekly mainnet smoke run from a user-funded CI identity.

### Later
Organizations (multi-member admin sets, key custody guide), template versioning, audit-log compaction, large files through pointers to the user's bucket, SHA-256 repos, optional user-run indexer for global search.

## 7. Launch criteria (what "real users would want it" means)

Public beta ships when all of these hold on **mainnet**:
1. A GitHub user with their own bucket goes from nothing to a continuously synced mirror that can't be taken down in **under 10 minutes**, without building from source and without any Forge-run service.
2. The **survivability drill** passes in CI: any single host, bucket, gateway, relay or domain can disappear and clone and browse still work.
3. Nothing in the UI claims more than was verified. The nightly has been green for 14 days.
4. Creating a repo costs **≤ 0.01 DASH**. A 100 KiB push to the user's own bucket costs **< $0.05** in Platform fees.
5. Private repos pass their security review.
6. dashpay and Dash Forge itself are on Forge mainnet.

## 8. Risks

| Risk | Mitigation |
|---|---|
| PV14 semantics shift before mainnet (4.2 is beta), or the devnet is reset | Pin the SDK tag, keep the forge-v2 schema in tests validated against each new 4.2 tag, and script the full moutai deploy so a reset costs minutes. |
| A revoked writer can still delete the Platform chunks they uploaded (no token cost on delete) | External storage is the default, and repack re-uploads. Documented in the trust model. |
| Private-repo key handling mistakes | A separate design doc, an independent security review, test vectors, and no "private" label in the UI until it passes. |
| A user's bucket disappears (unpaid, deleted) | Replication to N targets the user chooses, `packMirror` + reseed by anyone, a storage-status warning when a pack's live copies drop below N, and Platform as a fallback tier. |
| Testnet instability makes CI flaky | Tell transport flakes apart from real failures, retry with backoff, and record flake rates. |
| Platform SDK / protocol churn (fee schedule v3, SDK tags) | Pin SDK tags, run a nightly against the next tag, and keep the fee model read from the live platform version. |
| DASH price volatility | DASH-primary pricing, an optional user-selected price source, and bring-your-own storage keeping Platform spend small. |
| Mainnet deploy mistakes cannot be undone | Rehearse the exact deploy on moutai and then testnet; a runbook canary; a contract-group version pointer so a successor contract can be adopted. |
