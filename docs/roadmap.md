# Dash Forge — Product Roadmap (2026-09-24)

**The promise:** git hosting that nobody can take down. Refs, issues, PRs and access control live on Dash Platform under the users' own keys. Bulk pack data lives on Platform, or on cheap storage providers (S3, IPFS, HTTPS, other git hosts) that it is checked against by hash. No server is ever trusted, and every server can be replaced.

This document covers three things:
- where the project actually stands, checked against the code on `master` and not against the tracker's status lines;
- the decisions the owner needs to make;
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
6. **The trust story has single points of failure.** The web app is served from GitHub Pages behind one domain. Both the CLI and the web app get quorum keys from one HTTPS endpoint: the docs say the CLI is "fully trustless", but it uses `TrustedHttpContextProvider` (`crates/forge-core/src/platform.rs:219`). There is one IPFS gateway. Identity bootstrap goes through one bridge/faucet.
7. **No real code review.** No PR diff on `master`, no line-level commit diffs, no inline comments, no approve/request-changes in the web app, no opening a PR or merging from the browser. `dg repo fork` is a stub.
8. **CI is red.** The testnet nightly has failed every night since 2026-09-11, which is the first night it actually ran. The causes: a landing-page contrast (a11y) failure, scenario 07 hitting the 60-minute timeout, and transport flakes turning scenarios 02 and 04 into SKIPs.

## 3. Who it's for (the beachhead)

The sequence has to earn trust before it asks for commitment. Users will not move their primary repo to a new host on day one. They will add an **unkillable mirror** if it takes one YAML file and costs under a dollar.

| Persona | Why they care | First product they touch |
|---|---|---|
| **Takedown-exposed OSS maintainer** (privacy tools, crypto, DRM/scraper tools, anything DMCA- or sanction-adjacent) | GitHub has removed repos like theirs before | **Forge Mirror Action**: continuous GitHub → Forge mirror |
| **Dash ecosystem projects** (dashpay/*, Platform apps) | Dogfooding; credible "we host ourselves" | import + mirror, then primary hosting |
| **Sovereignty-minded developers** | They own their identity and their history | `dg` + `git-remote-dash` |
| **Archivists** | Preserving repos at risk | `forge-import`, reseed, multi-backend replication |
| **Visitors / contributors** | Read, clone, file an issue, send a PR | forge web |

**Wedge → expansion:** the mirror (insurance) leads to a Forge-native issue/PR flow (a second home), which leads to Forge as primary (GitHub becomes the mirror).

## 4. Non-negotiable invariants (the ethos)

Every roadmap item must keep all of these true:
1. **No server in the trust path.** Anything the product contacts (web host, DAPI node, gateway, relay, bucket) may lie or disappear. Correctness comes from proofs and hashes, and availability comes from having more than one of each.
2. **Every server is replaceable by anyone.** No component may require infrastructure run by us. Anything we host is a convenience with documented alternatives.
3. **The UI shows only what was verified.** A "verified" badge must come from an actual check that passed. A button's label must describe what the click actually does.
4. **Cost honesty.** Show an estimate before every paid write, split into deposit and burn, with DASH primary. No surprise spend, and that includes `git push`.
5. **Zero workflow change.** Plain git and jj. `dg` mirrors `gh`.

## 5. Decisions needed from the owner

| # | Decision | Recommendation | Why |
|---|---|---|---|
| **D-A** | **Repo cost model.** Per-repo contracts cost ≥0.5–1.2 DASH by protocol fee. | **Two tiers.** *Community repos*: documents in one shared `forge-repos` contract, with access control enforced by the deterministic client rules (the same mechanism that already governs un-gated `patch`/`event`). Target < 0.02 DASH to create. *Sovereign repos*: the existing per-repo contract with consensus-enforced token ACLs, for projects that need it. Community → sovereign upgrade as a first-class flow. | $40 per repo kills adoption, and forks become unaffordable. Client-rule ACL still trusts no server: unauthorized writes cost the attacker fees and are inert for every reader, exactly as events are today. Consensus enforcement stays available where it matters. |
| **D-B** | Where does push data go by default? | **External (IPFS pinned in ≥2 places, and/or S3-compatible), with Platform as an opt-in premium tier.** The manifest and refs always stay on Platform. | ~100× cheaper, and this *is* the value proposition. |
| **D-C** | How does the web app get its trust anchor? | Short term: cross-check quorum keys from ≥2 independent endpoints and show the result honestly. Long term: SPV-verified quorums (Core light client) in the CLI; the web app keeps a disclosed trusted mode. | Removes the single trusted endpoint without blocking launch. |
| **D-D** | Who holds the mainnet registry owner key? | A jointly held owner identity (keys held by ≥2 people, documented custody) before deploy. | Cannot be changed after deploy (`docs/mainnet-runbook.md`). |
| **D-E** | Should opening a PR require a WRITE token? | Keep PRs un-gated, with client-side spam filtering (hide PRs from identities with no history or no DPNS name unless someone expands them). | Drive-by contributions are the point of open source. |

## 6. Roadmap

Sizes: S ≈ days, M ≈ 1–2 weeks, L ≈ 3+ weeks of focused work. Phases 1 and 2 can run in parallel once Phase 0 is done.

### Phase 0 — Make it true and green (S–M) · *gate: nightly green 7 days, zero misleading UI*
- [ ] Land PR #4 (browse index on push). Rebase and land `fix/pull-request-diff` (PR diff renderer).
- [ ] Fix the nightly: the landing-page contrast failure; the scenario 07 timeout (hang in `git-remote-dash` under `timeout`); retry transport flakes, so that 02/04 produce a verdict and not a SKIP.
- [ ] Trust panel driven by actual verification state (proof-verified ref reads, pack hash checks), with "unverified"/"partial" states. Remove the hard-coded "verified" chips.
- [ ] Show "Merge" only to WRITE/MAINTAIN holders and label it for what it does ("Mark merged"), until Phase 4 makes a real browser merge.
- [ ] Star/follow buttons read their initial state and surface errors. Remove or implement Archive.
- [ ] Make the registry id per-network configuration in forge-core, dg, the relay and doctor (not a constant). Load `forge-contracts/deployments/<network>.json`.
- [ ] Correct the docs: the CLI trust mode, the README status and domain, and `EXECUTION.md` pointing at this roadmap.

### Phase 1 — Make "unbreakable" real (L) · *gate: the survivability drill passes*
Storage:
- [ ] `git push` honors the repo's backend setting. Packs are uploaded to the configured external backends; the manifest records every URI and the hash, and refs go to Platform. Platform chunks are used only for the Platform tier or as a fallback.
- [ ] S3 SigV4 (AWS, Cloudflare R2, Backblaze B2, MinIO), with credentials from env/keychain and never on-chain.
- [ ] IPFS pinning services (Pinata, Filebase, Storacha, any Pinning Service API) plus local kubo. **Replication policy**: N ≥ 2 independent targets per pack, and the push fails if fewer than N confirm.
- [ ] Template v2 `packMirror` document, so `dg reseed` (and anyone else) can *record* new mirrors on-chain. Readers use every recorded mirror.
- [ ] Gateway lists: several IPFS gateways, raced in the browser and the CLI, with Platform chunks as the last resort.

Access and hosting:
- [ ] Web app published to IPFS on every release (CID and DNSLink), with Pages kept as one of several mirrors. Reproducible build, with the build hash published on-chain in a `forgeRelease` registry document so users can verify the app they loaded.
- [ ] Several DAPI seed sources, and quorum keys cross-checked from ≥2 endpoints (D-C).

**Survivability drill** (automated, in the nightly): delete the S3 bucket, block `ipfs.io`, take down the Pages host, and kill the relay. `git clone dash://…` and the IPFS-served web app must still work, and must report *why*.

### Phase 2 — Make it affordable (M–L, needs D-A) · *gate: creating a repo < 0.02 DASH, a typical push < $0.05*
- [ ] Shared `forge-repos` contract (community tier): repo, ACL (owner-appended maintainer set), ref, manifest and collab documents keyed by `repoId`. Rules-engine ACL fold plus conformance vectors, shared by Rust and TS.
- [ ] Cheap fork: a new community repo whose manifests point at the parent's external packs (nothing re-uploaded).
- [ ] Community → sovereign upgrade: deploy a per-repo contract, re-point the listing, keep the old history readable.
- [ ] `git push` cost guard: `dash.costWarnThreshold` in git config. Above the threshold, the push shows the estimate and requires confirmation (`dash.confirm=always|threshold|never`). Push is the one paid path that has no guard today.
- [ ] Price feed (optional, multi-source) in place of the hard-coded $30/DASH.

### Phase 3 — Make it adoptable, and launch on mainnet (L) · *gate: public beta*
Distribution and identity:
- [ ] Release pipeline: signed `dg` + `git-remote-dash` binaries for macOS, Linux and Windows; a Homebrew tap; `cargo binstall`; `curl | sh` with checksum; a Docker image for the relay.
- [ ] `dg auth`: keys in the OS keychain, and fallback files written with mode 0600. `dg auth new` creates an identity, funding it by QR asset lock (mainnet) or faucet (testnet). DPNS username registration.
- [ ] DPNS everywhere: `dash://alice/project`, web `/alice/project`, collaborator grant by name, profile names and avatars.
- [ ] Web onboarding: create an identity in the browser (QR asset lock), an encrypted key vault (passphrase/passkey) in place of raw key paste, and wallet integration where available.

Wedge:
- [ ] **Forge Mirror Action**: a GitHub Action (plus `dg mirror` for other CI) that pushes every GitHub push to Forge and syncs issues and PRs incrementally. One YAML file, a runner identity with a WRITE token, external storage by default.
- [ ] `dg import` delegates to forge-import, and import gains a continuous mirror mode.

Launch:
- [ ] Execute `docs/mainnet-runbook.md` (after D-D): mainnet registry and shared contract, web build on mainnet (testnet as a switchable network), the weekly mainnet smoke run, and a balance watchdog.
- [ ] Dogfood: Dash Forge's own repo hosted on Forge mainnet, with GitHub as the mirror.
- [ ] A landing page that explains the promise, the survivability drill results, and the cost in plain numbers.

### Phase 4 — Daily-driver parity (L) · *gate: a maintainer runs a real project from the web app for a month*
- [ ] Code review: line-level commit and PR diffs, inline review comments (a `reviewComment` anchored to path/line/commit), approve/request-changes in the web app, re-review on new heads.
- [ ] Real merges: fast-forward and clean merges from the browser (isomorphic-git builds the merge commit and pushes the pack + ref through the browser WriteEngine), respecting protected refs.
- [ ] Open a PR from the browser (choose a fork branch); `dg repo fork`.
- [ ] Web editing: CodeMirror edit → commit → push, for small changes.
- [ ] Releases page, and asset upload to external backends with hashes recorded on-chain.
- [ ] Label and assignee UI, commit history pagination, blame, in-repo code search (a client-side index cached in IndexedDB).
- [ ] Notifications: a poll-based inbox over watched repos (local state only).
- [ ] Relay: encrypted webhook secrets (decrypted by the relay identity), a public instance, and a check-run write-back Action for GitHub Actions runners.

### Phase 5 — Organizations and longevity (L)
- [ ] Organizations: multi-member groups for token administration (sovereign tier) and multi-maintainer ACL sets (community tier); a key-custody guide.
- [ ] Template versioning and migration (repo-v2 → vN) with a readers' compatibility matrix.
- [ ] Audit-log compaction design (checkpoint documents), large files via external backends (LFS-style pointers), SHA-256 object-format repos.
- [ ] Optional community-run indexer, following the relay's pattern (availability-only trust): global search, explore/trending, activity feeds.
- [ ] Private repos: client-side encryption to recipient identities (design → prototype).

## 7. Launch criteria (what "real users would want it" means)

Public beta ships when all of these hold on **mainnet**:
1. A GitHub user goes from nothing to an unkillable, continuously synced mirror in **under 10 minutes, for under $1**, without building from source.
2. The **survivability drill** passes in CI: any single host, bucket, gateway, relay or domain can disappear and clone and browse still work.
3. Nothing in the UI claims more than was verified. The nightly has been green for 14 days.
4. Creating a repo costs **< 0.02 DASH** (community tier). A 100 KiB push costs **< $0.05** by default.
5. Dash Forge itself, plus at least 3 external projects, are hosted or mirrored on Forge mainnet.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Client-rule ACL (D-A) is seen as weaker than consensus enforcement | Keep the sovereign tier. Show which tier a repo is on in the trust panel. Conformance vectors for the ACL fold. |
| External storage disappears (unpaid pinning) | N ≥ 2 replication, `packMirror` + reseed by anyone, a storage-status warning when a pack's live mirrors drop below N. |
| Testnet instability makes CI flaky | Tell transport flakes apart from real failures, retry with backoff, and record flake rates. |
| Platform SDK / protocol churn (fee schedule v3, SDK tags) | Pin SDK tags, run a nightly against the next tag, and keep the fee model read from the live platform version. |
| DASH price volatility | DASH-primary pricing, a multi-source price feed, and external storage keeping absolute costs small. |
| Mainnet deploy mistakes cannot be undone | Runbook canary, a jointly held owner, and a registry version pointer so a successor registry can be adopted. |
