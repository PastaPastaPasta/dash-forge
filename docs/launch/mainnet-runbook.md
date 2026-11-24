# Mainnet launch runbook (2026-11-24)

**For the people who take Forge to Dash mainnet this morning:** Pasta (keys, funds, DNS, the go) and the agent on the launch thread (everything else). Read it all before the first step. The general procedure behind it is [Deploying Forge to a network](../deploying-to-a-network.md). This page is that procedure turned into today's ordered steps, with the decisions already made.

Contract registration is the only step that cannot be undone. Everything after it (the site, the CLI release, the announcement) can be reverted in minutes. The window to abandon a bad registration cheaply is **before the announcement** ([Rollback](#6-rollback)).

1. [Decisions](#1-decisions)
2. [What Pasta does personally](#2-what-pasta-does-personally)
3. [Ready before the go](#3-ready-before-the-go)
4. [The steps, in order](#4-the-steps-in-order)
5. [Smoke tests](#5-smoke-tests)
6. [Rollback](#6-rollback)
7. [Risks](#7-risks)
8. [Testnet rehearsal](#8-testnet-rehearsal)

## 1. Decisions

| Question | Decision | Why |
|---|---|---|
| Which contracts | The committed four-contract `mainnet` set, `forge-contracts/contracts/mainnet/`: forge-core, forge-collab, forge-community, forge-meta (refs, packs, members, ACL and config in core; issues, PRs, reviews and comments in collab; events, stars, checks and webhooks in community; boards, labels, profiles and the passkey vault in meta), in one contract group with **no admins**. | It is the same JSON testnet runs, including forge-meta's later `vaultEntry`, `board` and `card` types. On mainnet they are all version 1. |
| From which identity | A **fresh, dedicated deployer** created by Pasta today. It is never the testnet deployer and never a personal identity. | It owns the contracts forever, and only it can update them. Its mnemonic and asset-lock txid are the only way to restore the same ids after a Platform reset. |
| Cost | About **1.9 DASH** for the four registrations (the testnet rehearsal measured it, [§8](#8-testnet-rehearsal)). Fund the deployer with **3 DASH**, plus **0.5 DASH** for a mainnet smoke identity. | Same fee schedule as testnet (Platform 5.0, protocol 14). |
| Key exchange for wallet sign-in | **None needed.** | Mainnet wallet sign-in is DashPay App Connect v2. It uses the App Connect system contract `H8F9mP1BM55TE1ShsxPZHzhyinaMdY9bMmP85mkDhcJJ`, which has the same id on every protocol-14 network, and DashPay Android pins exactly that id. |
| Domains | **Mainnet at `forge.dashhq.org`. Testnet moves to `testnet-forge.dashhq.org`.** | `forge.dashhq.org` is the product. Testnet users today are mostly QA and demos, so this is the cheapest moment to move them. The testnet host is a **sibling, not `testnet.forge.dashhq.org`**: a page on a child host may ask the browser for `forge.dashhq.org`'s passkeys, so a compromised testnet site could unlock mainnet passkey-vault entries. A one-level name also matches `git-forge.dashhq.org`. |
| Hosting | Both sites are GitHub Pages behind a DNS-only (grey-cloud) CNAME, so GitHub issues their certificates. `forge.dashhq.org` stays this repo's Pages site (`pages.yml`). Testnet is a second site, `PastaPastaPasta/dash-forge-testnet-site` (`pages-testnet.yml`). | Pages serves one custom domain per repository. Both deploy from `master`, and both manifests are attested by this repo's CI. |
| Gateway (`git-forge.dashhq.org`) | It **stays on testnet** (existing clone URLs keep working) and moves to the testnet site's settings. The mainnet site launches **without** the HTTPS clone row. A mainnet gateway instance is post-launch work. | The gateway is optional by design. A mainnet build must not name a testnet gateway. |
| CLI | **v0.3.0**, tagged after the registration PR merges, with the mainnet record compiled in. The default network **stays testnet** in v0.3.0: mainnet users pass `--network mainnet` or sign in with `dg auth` on mainnet, which saves it. | Contract ids are compiled into the binaries, so v0.2.0 says "not deployed" on mainnet. A plain `git clone dash://…` made without `dg` follows the default, so flipping it would silently move those clones to another network. Flip the default in a later release, after an announcement. |
| Network switch in the app | The header badge links to `/networks`. A testnet build shows a dismissible "Forge is live on mainnet" banner once the bundled mainnet record is live. The mainnet build has a discreet testnet link. The site URLs come from `PAGES_MAINNET_SITE_URL` and `PAGES_TESTNET_SITE_URL`. | One build serves one network. |

## 2. What Pasta does personally

Nothing below needs Pasta to share a key, phrase or WIF with an agent. Run the key steps on your own Mac, in a checkout of `master` at the commit named in step 3.

| # | When | What | Exactly |
|---|---|---|---|
| P1 | Now (any time before the flip) | **DNS for the testnet site** | Cloudflare → dashhq.org → DNS → add `CNAME testnet-forge → pastapastapasta.github.io`, **DNS only (grey cloud)**. Then reply "dns done". The agent sets the Pages custom domain and waits for the certificate. |
| P2 | T-60 min | **Say go** | One message on the launch thread: "go mainnet". Nothing touches mainnet before it. |
| P3 | T-55 | **Create the deployer** | Open `https://bridge.thepasta.org/?network=mainnet`. Create a new identity funded with **3 DASH** from your wallet. Click **Download Key Backup**, save it as `~/forge-secrets/mainnet/deployer/FORGE_MAINNET_DEPLOYER.identity.json` (mode 0600), and note the identity id, the asset-lock **txid** and its **block height** (from the bridge, or `https://insight.dash.org/insight/tx/<txid>`). Escrow the file, or at least its 12 words plus the txid, **offline in two places** before going on. Never send it to an agent. |
| P4 | T-50 | **Sign the sums** | In the checkout: `node forge-contracts/scripts/deploy-v2.mjs --print-sha256 --set mainnet > ~/forge-secrets/mainnet/forge-mainnet.sha256`. Compare the four lines with the sums the agent posts on the launch thread (they come from the same commit). Your file is the signed input. |
| P5 | T-45 | **Dry run** | `node forge-contracts/scripts/launch-network.mjs --network mainnet --identity ~/forge-secrets/mainnet/deployer/FORGE_MAINNET_DEPLOYER.identity.json --deployer-created-height <height> --expect-sha256 ~/forge-secrets/mainnet/forge-mainnet.sha256`. It must end with `dry run clean`. Any `WARNING` line fails it: paste the output (it has no secrets) on the thread and stop. |
| P6 | T-40 | **Register** | The same command plus `--execute`. Type `mainnet` at the prompt. About 2 minutes. If it is interrupted, **run the same command again**: it completes what landed and never registers twice. Then send the agent `forge-contracts/deployments/mainnet.json`, `forge-contracts/contracts/registered/mainnet/`, `forge-contracts/deployments/contracts/mainnet.json` and `launch-evidence-mainnet/` (none of these hold secrets), or push them to a branch. |
| P7 | After P6 | **Remove the key** | Delete the identity file from the Mac once the escrow copies are verified. The record holds everything the clients need. |
| P8 | T-20 | **Approve the site flip** | Reply "flip" once the registration PR is merged (step 7). The agent runs the commands in step 9, which needs this box's admin `gh`. Doing it yourself is the same commands. |
| P9 | T+30 | **Smoke identity and wallet sign-in** | On `https://forge.dashhq.org`, sign in with the **DashPay Android** wallet (App Connect v2) or create an identity from the app with about 0.5 DASH, then run the web smoke ([§5](#5-smoke-tests), M-W). It is the first time App Connect v2 runs on mainnet. |
| P10 | After the smoke tests | **Approve the release** | The v0.3.0 `release` environment asks for your approval twice (attest+publish, then the image pushes). Tagging is by you, or by the agent under an explicit "tag v0.3.0". |
| P11 | After the release | **Announce** | Only after C1, the smoke tests and the release are green. |

Funds summary: **3 DASH** to the deployer (about 1.9 is spent) and **about 0.5 DASH** to a smoke identity. Nothing else needs mainnet funds. Access summary: Cloudflare DNS for one CNAME. Everything else on GitHub is done by this box's login, which has repo admin.

## 3. Ready before the go

Prepared overnight. The launch thread checks each item again at T-60.

- [ ] Mainnet Platform runs protocol 14: `node forge-contracts/scripts/refresh-dapi.mjs --network mainnet --check` gives `10/10 recorded seeds pass`, chain `evo1` (true at 2026-11-24 06:09Z, median height 478,280, 189 protocol-14 nodes).
- [ ] `master` has the launch tooling merged: `launch-network.mjs` (#676), the Pages network guard (#677), the testnet site (#678), the web network switch, and the per-network web origin and top-up links in the Rust clients.
- [ ] `build.py --check`, `contract-validate` and the deploy script tests are green on that `master` commit (the `contracts` workflow).
- [ ] The testnet rehearsal of these exact steps passed ([§8](#8-testnet-rehearsal)).
- [ ] The testnet site serves the testnet build at `https://testnet-forge.dashhq.org` (after P1), and its `/forge-manifest.json` says `"network": "testnet"`.
- [ ] The launch-day docs PR (mainnet live, v0.3.0 bumps, `RELEASE_NETWORK='mainnet'`) is open as a draft.
- [ ] No other PR is about to merge: **freeze merges to `master` from step 7 until the flip is live** (step 9). The Pages guard reads the live manifest, which GitHub's CDN caches for up to 10 minutes, and `cancel-in-progress` would let a merge cancel the flip run.

## 4. The steps, in order

The times are relative to the 08:30 CT announcement. Every step names its check, and a failed check stops the launch at that step.

### Step 1: testnet site up (now, after P1)

```bash
gh api -X PUT repos/PastaPastaPasta/dash-forge-testnet-site/pages -f cname=testnet-forge.dashhq.org  # or POST once to create
gh workflow run pages-testnet.yml -R PastaPastaPasta/dash-forge --ref master
gh variable set TESTNET_SITE_GATEWAY_URL -R PastaPastaPasta/dash-forge -b https://git-forge.dashhq.org
gh variable set PAGES_TESTNET_SITE_URL   -R PastaPastaPasta/dash-forge -b https://testnet-forge.dashhq.org
```

`PAGES_MAINNET_SITE_URL` is set only at the flip (step 9). Before that, a testnet build's "Forge is live on mainnet" banner would point at a forge.dashhq.org that still serves testnet.

The site repo's first Pages setup is `gh api -X POST repos/PastaPastaPasta/dash-forge-testnet-site/pages -f 'source[branch]=gh-pages' -f 'source[path]=/'`, after the first deploy has created `gh-pages`. Then turn on `https_enforced` once the certificate exists.

**Check:** `curl -s https://testnet-forge.dashhq.org/forge-manifest.json | jq .network` gives `"testnet"`. The testnet smoke suite T-W passes against it ([§5](#5-smoke-tests)).

### Step 2: go (P2), and the commit

The agent posts the `master` commit to register from and its four `--print-sha256` lines. That commit must have every item of [§3](#3-ready-before-the-go). Pasta checks out exactly that commit: `git fetch && git checkout --detach <sha> && (cd forge-contracts/sdk-v2 && npm ci)`. `deploy-v2` refuses to register files that differ from `HEAD`, or a `HEAD` that is not on `origin`.

### Step 3: deployer (P3) and sums (P4)

**Check:** `node tools/mint-identity/mint.mjs balance --identity <file>` is refused on mainnet (the tool is testnet-only). Instead, the dry run in step 4 prints the balance and refuses a key that is missing, different from the file, or disabled on chain.

### Step 4: dry run (P5)

`launch-network.mjs` runs, in order:
1. `deploy-v2 --self-test` (offline id derivation and schemas).
2. `--print-sha256`, compared with the signed file.
3. `refresh-dapi --check`.
4. `deploy-v2 --dry-run`: it proves chain `evo1` with a DPNS proof, checks protocol 14, builds and sizes all four transitions (each must leave at least 2,000 B under 20,480), and checks the CRITICAL key on chain.

**Check:** it ends with `dry run clean. Nothing was broadcast.` The four transition sizes match the rehearsal's (16.4, 17.3, 15.7 and 10.9 KB).

### Step 5: register (P6)

`--execute` repeats step 4, then asks for `mainnet` and registers forge-core (which creates the group), forge-collab, forge-community and forge-meta, recording each nonce before it broadcasts. It then runs, read-only:
- **C1** (`freeze-c1-check`): every contract on chain equals the signed JSON, with ids substituted; 44 checks.
- **the group check**: owner = deployer, no admins.
- **freeze-registered**: writes `contracts/registered/mainnet/*.v1.json` and prints the `NETWORK_REGISTRATIONS` line for `build.py`.
- **snapshot-contracts**: writes `deployments/contracts/mainnet.json`.

**Check:**
- C1 prints `{"passed":44,"total":44,"failed":[]}`.
- The output has `PASS group`.
- `launch-evidence-mainnet/` holds `c1.json`, `group.json` and `sha256sums.txt`.

**If C1 fails, stop.** The fix is [Rollback R3](#6-rollback). Nothing has been announced, and no client reads the new ids yet.

### Step 6: the registration PR (agent, about 15 minutes)

On a branch from `master`:
1. Commit `forge-contracts/deployments/mainnet.json` (the `v2` record).
2. Commit `contracts/registered/mainnet/`.
3. Add the printed `NETWORK_REGISTRATIONS` line in `forge-contracts/schema/build.py`.
4. Commit `deployments/contracts/mainnet.json`.
5. Add `mainnet` to `SNAPSHOTS` in `forge-web/lib/sdk/contract-seed.ts` (`contract-seed.test.ts` fails without it).
6. Commit `forge-contracts/evidence/mainnet/` (C1, group, sums).
7. Run `node forge-contracts/scripts/refresh-dapi.mjs --network mainnet --write`.

**Checks:**
- `python3 forge-contracts/schema/build.py --check`
- `node --test forge-contracts/scripts/lib/deployments.test.mjs`
- `cd forge-web && pnpm vitest run lib/sdk/contract-seed lib/deployments lib/networks`
- `cargo test -p forge-core`: the record is embedded by `build.rs`
- `dg doctor --network mainnet`: built from the branch, its `forge-v2` rows show the new core, collab and community ids and the group, and enrolment checks OK

The PR gets the usual independent review, CI and PastaClaw, then merges. Merging it starts push-triggered runs of both Pages workflows. They deploy testnet builds as before (the live network does not change, so the guard lets them through), now with the mainnet record bundled, so `/networks` already lists mainnet as live. Nothing else user-visible happens until step 9.

### Step 7: merge freeze

From here until step 9's check passes, nothing else merges to `master`.

### Step 8: last look at the testnet site

**Check:** `https://testnet-forge.dashhq.org` loads, and a testnet repo opens there. Testnet users must have somewhere to go before `forge.dashhq.org` flips.

### Step 9: flip forge.dashhq.org to mainnet (after P8)

```bash
R=PastaPastaPasta/dash-forge
gh variable delete PAGES_GATEWAY_URL -R $R                # it names the testnet gateway
gh variable set PAGES_MAINNET_SITE_URL -R $R -b https://forge.dashhq.org
gh variable set PAGES_NETWORK -R $R -b mainnet
gh workflow run pages.yml -R $R --ref master -f confirm_network=mainnet
gh run watch -R $R "$(gh run list -R $R --workflow pages.yml --limit 1 --json databaseId -q '.[0].databaseId')"
gh workflow run pages-testnet.yml -R $R --ref master          # the testnet site picks up the mainnet banner
```

The network guard in `pages.yml` refuses this run unless `deployments/mainnet.json` is complete, and refuses any push-triggered run that would change the live network. So the flip happens only by this manual, confirmed dispatch.

**Check:**
- `curl -s https://forge.dashhq.org/forge-manifest.json | jq '{network,commit}'` gives `"mainnet"` and the run's commit (allow up to 10 minutes for the CDN).
- The header badge is gone, because mainnet hides it.
- `/networks` shows Mainnet live, with the group id from the record.
- Then lift the merge freeze.

### Step 10: smoke tests on mainnet

[§5](#5-smoke-tests), M-R first (read-only, free), then M-W with the smoke identity (P9).

### Step 11: CLI v0.3.0

1. Merge the launch-day docs PR. It flips the docs to "mainnet live", bumps the versions and sets `RELEASE_NETWORK='mainnet'`. Fill its `<MAINNET_GROUP_ID>` placeholders from the record.
2. Run the release dry run: `gh workflow run release.yml -f dry_run=true`. Its `plan` job runs `check-release-network.mjs`, which refuses a final release whose networks have no complete record.
3. Tag `v0.3.0` on the merge commit: Pasta, or the agent on his explicit word. Approve the `release` environment twice (P10).
4. After publishing, merge the post-tag link PR, and bump the Mirror Action and GitLab pins if the docs PR left them.

**Check:** `install.sh` installs v0.3.0, and `dg doctor --network mainnet` is green from the released binary.

### Step 12: announce (P11)

Only after steps 5, 9, 10 and 11 are green. The announcement says:
- the network
- the site
- `--network mainnet` for the CLI
- that testnet moved to testnet-forge.dashhq.org
- what testnet users must redo (below)

**What testnet users see and must do.** forge.dashhq.org becomes mainnet, so a returning testnet user there appears signed out. Their testnet state (vault, session, journals) is stored under testnet keys and is never read or mixed up, and their testnet identities don't exist on mainnet. On testnet-forge.dashhq.org they start on a new origin:
- They sign in again with the wallet, a recovery phrase or an identity file.
- Browser-vault keys don't carry over (IndexedDB is per-origin).
- Cross-device passkeys made on forge.dashhq.org don't work on the new host.
- Bring-your-own storage buckets need `https://testnet-forge.dashhq.org` added to their CORS allowed origins.

`dg` and `git-remote-dash` are unaffected: their clones record their network, and the gateway stays on testnet.

## 5. Smoke tests

Registered repositories and Platform-stored packs can't be deleted, so the write tests reuse one labelled smoke repository (`forge-smoke`), with a fresh branch per run.

| Id | Where | What | Pass |
|---|---|---|---|
| T-W | testnet site | landing, `/networks`, the demo repo, one sign-in with a QA identity file | pages render. The demo repo's tree, commits and issues load. Sign-in works. |
| M-0 | mainnet chain | `launch-network.mjs --network mainnet --post-only` (C1, group, snapshot) | 44/44, `PASS group` |
| M-C | CLI built from the registration branch | `dg doctor --network mainnet` | forge-v2 rows green, enrolment OK |
| M-R | forge.dashhq.org | landing, `/networks`, `/explore` (empty is fine), the docs hub, `/forge-manifest.json`, the app's own verify check | no "not deployed", network `mainnet`, the manifest is attested (`dg verify-app https://forge.dashhq.org` passes) |
| M-W | forge.dashhq.org + CLI | sign in (DashPay App Connect v2 on Android, else an identity file). Then: create the public repo `forge-smoke`; push one commit with `dg push --network mainnet`; open an issue and comment; open a PR from a branch; star it; `dg clone --network mainnet` it back into an empty directory and compare `git log` | every step lands. The clone matches. Cost is about 0.02 DASH (repo 0.0013, small push about 0.005, issue 0.001, comment 0.0007, PR about 0.002). |
| M-X | forge.dashhq.org | the testnet link and the `/networks` "Open Forge on Testnet" link go to testnet-forge.dashhq.org. A testnet repo URL on mainnet says "not found", not an error. | as described |

## 6. Rollback

**What can't be undone.** Registered contracts are permanent. They can't be deleted or re-owned, and an update may only add types and optional properties. Every repository, issue and pack written under them stays on chain. The deployer's nonces are spent.

**How a bad registration is superseded.** Register a fresh set from the same deployer with `deploy-v2.mjs --network mainnet --set mainnet --force-new --abandon-live-set mainnet …` (about 1.9 DASH). That writes a new record, and the old one moves to `*Superseded`. Then release clients that read the new ids, and say which ids were abandoned. Documents under the old ids stay on chain and are no longer read. A defect that clients can enforce is fixed instead by a client release, and an additive schema fix by `--update`, gated by `tools/contract-validate --expect-update`.

| # | Situation | Action | Time | What users see |
|---|---|---|---|---|
| R1 | The mainnet site misbehaves after the flip, contracts fine | `gh variable set PAGES_NETWORK -b testnet`, `gh variable set PAGES_GATEWAY_URL -b https://git-forge.dashhq.org`, then `gh workflow run pages.yml --ref master -f confirm_network=testnet` | about 10 min (build) + up to 10 min (CDN) | forge.dashhq.org is the testnet app again, and testnet-forge.dashhq.org keeps working too. Mainnet data written meanwhile stays on chain. It reappears when the site flips back. |
| R2 | Writes must stop, reads can stay | `gh variable set PAGES_NOTICE -b paused`, `PAGES_NOTICE_TEXT`, `PAGES_NOTICE_URL`, then dispatch `pages.yml` (with `confirm_network=mainnet`) | about 10 min | a banner that can't be dismissed. Every write is refused before anything is signed. |
| R3 | C1 fails or a consensus defect is found **before the announcement** | Don't flip (or R1). Fix the JSON on `master`, rehearse on testnet, then `--force-new --abandon-live-set mainnet` (about 1.9 DASH). The registration PR records the superseded set. | about 1 h | nothing: the site never showed mainnet, or R1 hid it |
| R4 | A consensus hole **after** the announcement | R2, then R3, then a client release and an advisory. Code survives in users' own storage. Collaboration data under the old ids is lost unless exported. | hours | the paused banner, then an advisory and a re-push |
| R5 | The CLI release is bad | Pull the release assets (`gh release delete-asset` or edit it as a pre-release), and point `install.sh` users at v0.2.0 for testnet | minutes | `install.sh` installs the previous version |
| R6 | The deployer's CRITICAL key leaks | Replace the key from the escrowed master, audit the contract history, publish an advisory | hours | none, unless the group was changed |

The fastest full rollback to "testnet-only" is **R1**, one variable plus a dispatch. Nothing on testnet depends on mainnet, so testnet keeps working throughout.

## 7. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **DashPay App Connect v2 on mainnet.** Verified end to end only on testnet with Android 11.9.2. iOS is unverified, and the iOS wallet's mainnet build may not ship App Connect v2 or may pin a different contract. | medium | Wallet sign-in fails on mainnet. The identity-file and recovery-phrase sign-in, and the in-app identity creation, still work. | P9 tests Android on mainnet before the announcement. The announcement names Android as the verified wallet. If v2 can't read the chain clock, the tile says "DashConnect works on testnet only", which misleads (follow-up: say "can't reach the wallet sign-in service right now"). |
| **Quorum and DAPI endpoints.** Mainnet DAPI nodes vary. Of 220 nodes on the quorum list, 189 passed the protocol-14 probe at 06:09Z. The rest timed out or failed to answer. | medium | Slow or failed reads and writes, and a "quorum not found" hit on some writes (about 1 in 30 writes on an earlier devnet). | Clients use SDK discovery on mainnet. `refresh-dapi --write` in the registration PR keeps the recorded seeds (web identity creation and quorum cross-check) to protocol-14 nodes at the tip. deploy-v2 resumes after a failed write. |
| **Cost** | low | About 1.9 DASH for the registration, about 1.9 again for a re-registration (R3), and about 0.02 DASH per smoke run. User costs are as on testnet: about 0.004 DASH for a small push, about 0.31 DASH per MiB on Platform storage. | Fund 3 DASH. A dry run costs nothing. |
| **The registration is permanent.** A schema defect found later can't be rolled back. | low (same JSON as testnet since 10-26, plus forge-meta v3) | R3/R4 | C1 before anything else, and an announcement only after the smoke tests |
| **Testnet users are disrupted** by the move to a new origin (signed out, BYO-storage CORS, passkeys) | certain, small group | Testnet users must sign in again and add a CORS origin. | The testnet site is up before the flip. The banner and announcement say what to redo. Clones and the gateway are unaffected. |
| **v0.2.0 binaries on mainnet** say "not deployed" until v0.3.0 | certain, until step 11 | The CLI can't reach mainnet for a few hours. | Release the same day. The web `/mirror` wizard pins the Action to the deployed commit with a source install, so mirrors set up from the mainnet site work without the release. |
| **DNS / certificate delay** on testnet-forge.dashhq.org | low | Testnet users have no site for a while. | Do P1 now, and step 8 checks it before the flip. |
| **Platform reset on mainnet** | very low | Contracts are gone. | The escrowed deployer (mnemonic + asset-lock txid + height) restores the same ids: `mint.mjs restore` (testnet-only today, so a mainnet restore needs that tool extended first) and `deploy-v2 --replay`. |
| **A merge cancels the flip run** (`cancel-in-progress`), or the guard reads a stale manifest | low | The flip run fails or is cancelled, and the site stays on testnet. | The merge freeze (step 7). Re-run the dispatch. |

## 8. Testnet rehearsal

On 2026-11-24, overnight, the steps of [§4](#4-the-steps-in-order) were run on testnet with a throwaway scratch deployer (`SCRATCH_DEPLOYER`, `CCFcNqhK…`) and the same committed JSON, through the scratch path of the same command (`--record <file> --scratch-on testnet --out <dir>`). The scratch contracts are permanent on testnet, but no client reads them.

_Results are filled in by the rehearsal (ids, per-contract cost, sizes, idempotent re-run, C1, `dg doctor`, CLI and web smoke)._
