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
| 2026-09-24 → 26 | forge-v2 (D-A) registered on devnet moutai and built out in the CLI, web app, importer, relay and Mirror Action. forge-v1 removed with no backwards compatibility (D-M); forge.dashhq.org and the nightly moved to moutai. |

**What the history tells us.** The architecture is sound and the hard protocol problems are solved. Consensus-enforced ACLs work: a frozen push is rejected with 40702. Proof-verified reads, resumable pushes, and a cross-client rules engine with 70 conformance vectors are all in place. The build log's "complete", though, meant *demonstrated once on testnet*, not *usable by a stranger*. Every audit since has found product claims the code doesn't back up. The first job is to make the product true. The second is to make it wanted.

## 2. Where it stood (verified on `master` @ `b0bc7bb`, 2026-09-24)

> This is the forge-v1 baseline the plan started from. Gaps 1 and 2 are closed by forge-v2 (D-A, D-M): contract ids come from per-network deployment records, a repository costs about 0.001 DASH, and v1 no longer exists. The execution tracker (§6) has the current state.

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
| D-J | **Mainnet contracts are registered by the owner** once PV14 is active on mainnet (expected ~1 month after 2026-09-24; testnet ~1–2 weeks). All PV14 development happens on a devnet until then: **devnet bonsia** (protocol 14, drive 4.2.0-beta.7) since 2026-09-29, devnet moutai before that (drive 4.2.0-beta.5; reset 2026-09-27). |
| D-L | **Sign in with a mobile Dash wallet (yappr / App Connect style)** is a launch requirement (owner, 2026-09-26). A user scans a QR (or taps a deep link on mobile) with the Dash Wallet app on iOS or Android, approves on the phone, and is signed in with a limited, contract-group-bound key. No key file and no key paste in the browser. See Phase 4. |
| D-K | External accounts (Apple signing, pinning services, cloud buckets) are **out of scope for now**. S3 and IPFS are tested against local MinIO and kubo only. |
| D-M | **2026-09-26: forge-v1 removed, no backwards compatibility; forge-v2 only.** The registry contract, the per-repo contract template, token ACLs, v1 read compatibility (`dash://<contract id>`, `?contract=` routes), the registry overrides and `dg collab suspend/unsuspend` are gone, and there is no migration path. The v1 data on testnet and on forge.dashhq.org was test data only the owner used. The hosted web app is built for the PV14 devnet (moutai, then bonsia) until forge-v2 is registered on testnet (when PV14 reaches it) and mainnet. |

### Still open
| # | Question | Default until decided |
|---|---|---|
| D-D | Who owns the mainnet forge-v2 contracts and contract group (identity and key custody)? | The owner decides before registering. The deploy script takes the owner identity as input. |
| D-C | Trust anchor: web app and CLI take quorum keys from a known HTTPS endpoint. | Cross-check ≥2 endpoints, disclose honestly in the trust panel; SPV quorum verification in the CLI later. |
| D-E | Should opening a PR require a token? | No: anyone may open one, with client-side spam filtering. |

## 6. Roadmap

Sizes: S ≈ days, M ≈ 1–2 weeks, L ≈ 3+ weeks of focused work. Phase 0 comes first. Phases 1 and 2 then run in parallel. Phase 2 targets devnet bonsia now (moutai until 2026-09-29) and moves to testnet when PV14 activates there.

### Phase 0 — Make it true and green (S–M) · *gate: nightly green 7 days, zero misleading UI*
- [ ] Land PR #4 (browse index on push). Rebase and land `fix/pull-request-diff` (PR diff renderer).
- [ ] Fix the nightly: the landing-page contrast failure; the scenario 07 hang/timeout; transport flakes retried until they give a verdict rather than a SKIP.
- [ ] Trust panel driven by actual verification state, with "unverified" and "partial" states; remove the hard-coded "verified" chips.
- [ ] Show "Merge" only to writers and maintainers and label it for what it does until Phase 4. Star/follow read their initial state; Archive is implemented or removed.
- [ ] Network config: contract ids per network (testnet, **devnet** with a name such as `moutai`, mainnet) loaded from `forge-contracts/deployments/<network>.json` in forge-core, dg, the relay, doctor and web. No hard-coded ids.
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
- [x] Remove forge-v1 (registry, per-repo contracts, token ACL) entirely, with no read compatibility and no migration (D-M).
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
- [x] DPNS everywhere: `dash://alice/project`, web `/alice/project`, collaborator grants by name, profile names.
- [ ] Web onboarding: create an identity in the browser from the user's own funds (QR asset lock), an encrypted key vault (passphrase/passkey), and limited keys (Phase 2).
- [ ] **Forge Mirror Action**: a GitHub Action that pushes every GitHub push into Forge using the repo's own bucket and a runner identity with a limited key. Issue/PR sync is incremental.
- [ ] `dg import` → forge-import, plus a continuous mirror mode.
- [ ] User docs: quick start, "bring your bucket" guides (R2, B2, S3, MinIO, kubo), migrating from GitHub, how to verify the forge isn't lying to you, key backup and recovery.

**Mobile wallet sign-in (D-L)**

The user scans a QR code (or taps a `dash-key:` deep link on the phone itself), approves in the Dash Wallet app, and the browser is signed in. No key file, no key paste. This is the QR key exchange yappr implements (`yappr/components/auth/key-exchange-*.tsx`, `@pastapastapasta/platform-auth`); Forge re-implements it in `forge-web/lib/auth/wallet-protocol.ts`.

What exists today, checked 2026-09-26:
- **Forge web (PR #43):** the wallet tile emits a `dash-key:` request for one Forge contract (forge-core; forge-collab takes a second approval), reads both the legacy key-exchange contract and the PV14 App Connect system contract `H8F9mP1BM55TE1ShsxPZHzhyinaMdY9bMmP85mkDhcJJ`, shows the `dash-st:` registration QR on a first login, and verifies the granted key on chain. It accepts the wallets' keys without budget or expiry, with a warning. It shows the full identity and DPNS name for confirmation; two answerers are refused on App Connect only. See [wallet-login](design/wallet-login.md).
- **Dash Wallet Android** (`dash-wallet`, "DashConnect", `PlatformDashConnectRepository`) and **iOS** (`dashwallet-ios`, `Sources/Models/DashConnect`) both implement the yappr key exchange, including the `dash-st:` first-login key registration. Today they are **testnet-only** and **unreleased** (on `master`/`develop`, not in dash-wallet v11.9.0 or dashwallet-ios v9.0.2); iOS internal builds can also use a devnet with the contract entered by hand. They publish `loginKeyResponse` to yappr's own key-exchange contract `7UaqHGBJBbRLJ4fUWS45cnud8PPUugJWoGTt1SKwHJ2P`, not the PV14 system contract, and their request layout is `version ‖ appEphemeralPub ‖ contractId(32) ‖ labelLen ‖ label`. The wallet binds the key to that one contract.

The gap: no released wallet has DashConnect, and Forge is not on testnet (protocol 13), so no user can complete a wallet sign-in on a network Forge runs on today. The wallets' keys carry no budget or expiry.

Work:
- [ ] **Talk to both formats.** Read responses from both the PV14 App Connect system contract and the legacy key-exchange contract, behind one interface; the verification rules stay the same.
  - Accept a key bound to forge-core **or** to the group, whichever the wallet grants. Its contract bounds limit what it can sign: a forge-core-only key covers repos and pushes, so collab writes need a second grant or a group-bound key.
  - Use `platform-auth`'s `yappr-protocol` as the reference implementation, or depend on it directly.
- [ ] **First-login key registration (`dash-st:`).** When the wallet has no suitable key yet, show the second QR carrying the unsigned IdentityUpdate that adds the key bound to the requested contract. The wallets drop any budget or expiry (Android also the bound); limits wait on the upstream work below.
- [ ] **Mobile-browser UX.** On a phone, show an "Open in DashPay (Dash Wallet)" deep link instead of a QR. Show a countdown, then offer to protect the session with a passkey (as yappr does).
- [ ] **Wallet side (upstream, dashpay):** request group-scoped grants (the Forge contract group) and publish to the PV14 system contract on protocol 14 / mainnet. File issues and PRs against `dashpay/dash-wallet` and `dashpay/dashwallet-ios`, with a spec note agreed with the App Connect authors. Until they ship, Forge supports the legacy contract on testnet.
- [ ] **Test on real devices.** A scripted e2e with a simulated wallet responder (both formats), plus a manual check with the Dash Wallet Android testnet build and the iOS simulator (`run-ios-simulator`), recorded as evidence.

**Gate:** a user on Dash Wallet (Android or iOS) signs in to Forge on testnet or moutai by scanning one QR code and does a write, with no key file anywhere. On mainnet this is gated on the wallets supporting group-scoped grants on protocol 14.

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

### Execution tracker (updated 2026-09-27)
Landed on master:
- **Phase 0:** #4 browse index · #6 honest UI · #8 PR/commit diffs · #10 + #14 nightly green (CLI and Playwright, fixture isolation, keyset ref reads) · #11 per-network config.
- **Phase 1:** #12 bring-your-own storage on push (SigV4 S3, IPFS/pinning, replication, `dg storage`, `dg reseed --from-local`) · #37 web storage wizard, credentials in the browser vault, and the browser upload path · #41 `dg storage add` prompts with the OS keychain, `dg init` / `dg repo create --push` (storage chosen before any spend, E508).
- **Phase 2 (forge-v2 on devnet moutai):** #5 devnet tooling · #7 forge-v2 contracts · #9 FORGE_RULES_V2 + authorEvent · #15 SDK 4.2 · #18 CLI data plane (repo create ≈0.0013 DASH, consensus-enforced membership) · #17 web reads · #25 moutai re-registration · #22 CLI issues/PRs/real merges/releases/forks/stars · #23 web writes and cost UX (previews, spend ledger) · #26 web fork reads · #27 relay (chain-encrypted webhook secrets) · #39 relay durable retry queue · #30 forge-import on v2 (`dg import`) · #33 import estimate calibrated as an upper bound · #35 v2 rule parity (ref-name hashes, protected merges) and the concurrent-write hang fix.
- **Phase 3 (private repos):** #21 cryptographic design (reviewed) · #29 crypto core and the contract fields (no user-facing create/read yet).
- **Phase 4:** #24 web limited-key sign-in, vault and in-browser identity creation · #31 GitHub Mirror Action · #32 key top-up in place (`IdentityKeyLimitsUpdate`) · #42 `dg auth new/login/status/keys/name/export/logout`: limited keys on the OS keychain (passphrase-sealed fallback), `dfk1:` runner keys, DPNS registration · #43 mobile Dash wallet sign-in (D-L) speaking the shipped wallets' key exchange on both response contracts, with a second approval for forge-collab and warnings for their unlimited keys ([design/wallet-login.md](design/wallet-login.md); upstream drafts in `docs/upstream/`).
- **Phase 5:** #32 local notifications inbox, Explore, header with jump box · #34 Verification card with the two-source quorum-key cross-check, repo home, clone box with zip, short URLs, releases pages · #40 publish a release with assets from the browser.
- **Adoption:** #13 release pipeline + install.sh (no release tagged yet) · #16 actionable errors (`docs/errors.md`) and `dg doctor` sections · #19 user guides, refreshed for the forge-v2 product.
- **D-M:** #38 forge-v1 removed; forge.dashhq.org and the nightly ("Devnet Nightly") target moutai.

Launch checklist (`ux-dx-spec.md` §11 P0), where it stands: done 1, 2, 3, 4, 5, 6, 7, 9, 11, 18, 19, 20 · done except a CLI-side part: 8 (the web spend ledger is done; `dg cost audit` totals pending), 10 (the private-repo state waits for private repos), 17 (pipeline merged; first tag pending) · in progress 12 and 13 (web PR create, inline review, browser merge) and 14 (web Fork; `dg repo fork` is done) · open 15 (private repos, after its security review) and 16 (`/mirror` wizard; the Action itself is done).

Next:
- **In progress:** web PR create, inline review, Fork and browser merge · private-repo create/read paths (Phase 3; [docs/security/private-repos.md](security/private-repos.md) §13 lists contract changes required before mainnet registration) · the wallet-side changes D-L needs on mainnet (group-scoped, limited grants through App Connect; a signed responder), drafted for dashpay in `docs/upstream/` (not yet filed) · the D-L gate (a real Dash Wallet sign-in on a device, then a write) is not yet run.
- **Not started:** the `/mirror` setup wizard · tag the first release so `install.sh`, `cargo binstall` and the Action's `install: 'true'` work · the published, reproducible IPFS build of the web app · the survivability drill in CI · `dg cost audit` spend totals.
- **Networks:** register forge-v2 on testnet when PV14 reaches it, and move the nightly and a testnet web build there; mainnet after PV14 (Phase 6, D-D, D-J).

Launch UX/DX is specified in [docs/design/ux-dx-spec.md](design/ux-dx-spec.md) §11. Its **P0 backlog is the launch checklist** and supersedes the per-phase bullet lists below where they overlap.

## 7. Launch criteria (what "real users would want it" means)

Public beta ships when all of these hold on **mainnet**:
1. A user signs in with their mobile Dash wallet by scanning one QR code (D-L).
2. A GitHub user with their own bucket goes from nothing to a continuously synced mirror that can't be taken down in **under 10 minutes**, without building from source and without any Forge-run service.
3. The **survivability drill** passes in CI: any single host, bucket, gateway, relay or domain can disappear and clone and browse still work.
4. Nothing in the UI claims more than was verified. The nightly has been green for 14 days.
5. Creating a repo costs **≤ 0.01 DASH**. A 100 KiB push to the user's own bucket costs **< $0.05** in Platform fees.
6. Private repos pass their security review.
7. dashpay and Dash Forge itself are on Forge mainnet.

## 8. Risks

| Risk | Mitigation |
|---|---|
| PV14 semantics shift before mainnet (4.2 is beta), or the devnet is reset | Pin the SDK tag, keep the forge-v2 schema in tests validated against each new 4.2 tag, and script the full moutai deploy so a reset costs minutes. |
| A revoked member can still delete their own deletable documents (Platform does not reference-check deletes) | Every history-bearing type (refs, packs, chunks, config, events, issues, PRs) is non-deletable. The residual case is a revoked maintainer deleting a release they published; readers fall back to the next-newest release for that tag ([forge-v2.md §4](contracts/forge-v2.md#4-non-deletable-audit-types)). |
| Private-repo key handling mistakes | A separate design doc, an independent security review, test vectors, and no "private" label in the UI until it passes. |
| A user's bucket disappears (unpaid, deleted) | Replication to N targets the user chooses, `packMirror` + reseed by anyone, a storage-status warning when a pack's live copies drop below N, and Platform as a fallback tier. |
| Testnet instability makes CI flaky | Tell transport flakes apart from real failures, retry with backoff, and record flake rates. |
| Platform SDK / protocol churn (fee schedule v3, SDK tags) | Pin SDK tags, run a nightly against the next tag, and keep the fee model read from the live platform version. |
| DASH price volatility | DASH-primary pricing, an optional user-selected price source, and bring-your-own storage keeping Platform spend small. |
| Mainnet deploy mistakes cannot be undone | Rehearse the exact deploy on moutai and then testnet; a runbook canary; a contract-group version pointer so a successor contract can be adopted. |
