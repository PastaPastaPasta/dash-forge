# Dash Forge — Mainnet Deployment Runbook

**Status: NOT EXECUTED.** forge-v2 needs Platform protocol 14 (contract groups, `ownerRefersTo`). Mainnet runs protocol 13 today; the owner registers forge-v2 on mainnet after protocol 14 activates there (roadmap D-J, expected about a month after 2026-09-24). Everything below is rehearsed on **devnet bonsia**, where the RC1 contracts are registered and the CLI and web suites run (devnet moutai until 2026-09-29); testnet gets the same rehearsal once protocol 14 reaches it (~1–2 weeks after 2026-09-24).

Deploying Dash Forge to a network means registering one pair of shared contracts, **forge-core** and **forge-collab**, joined by one contract group. There is no per-repository contract and no registry: a repository is three documents in those contracts, created by its owner. See [contracts/forge-v2.md](contracts/forge-v2.md) for the schemas and §8 there for the deploy script's behaviour.

## 0. Prerequisites

- **Mainnet runs protocol 14.** The deploy script checks this and refuses to broadcast on an older protocol.
- **Decide who owns the contracts (roadmap D-D).** The deployer identity owns forge-core, forge-collab and the contract group, and only the owner can update the contracts. Contract owners are immutable, so custody of that identity is the only succession mechanism. For an org, hold it jointly (multiple high-security keys across principals).
- **Decide `config.readonly` before registering** ([forge-v2.md §4](contracts/forge-v2.md#4-non-deletable-audit-types), §8). The contracts are registered not readonly, so the owner can later add optional properties and new document types. Readonly can only be set at registration: a later update to `readonly: true` is refused. If the mainnet contracts should be final, set `config.readonly` for all three (`forge-core`, `forge-collab` and `forge-community`) before running the script: in `forge-contracts/schema/build.py`, which generates the files under `forge-contracts/contracts/` (CI's `build.py --check` refuses a hand edit).
- **Land the schema changes that must precede mainnet**, e.g. the private-repository changes in [security/private-repos.md §13](security/private-repos.md), and register them on devnet bonsia first (`--force-new` if the update rules refuse them). Whatever is registered on mainnet is what every mainnet repository lives in.
- A funded **mainnet** deployer identity, as a bridge-format identity JSON with its CRITICAL authentication key (the script signs with it and refuses a key that is missing, different from the file, or disabled on chain). Create and fund it through the bridge (`bridge.thepasta.org`). `tools/mint-identity` supports only testnet and devnets, and there is **no faucet on mainnet**.
- `dg` and `git-remote-dash` built from a release tag (`cargo build --release`), and Node for the deploy script.

## 1. Cost budget (mainnet DASH — real money)

The fee schedule is the same on every network. Measured on devnet moutai:

| Item | Cost | Refundable? |
|---|---|---|
| forge-core registration (once per network, deployer) | 0.60 DASH fee + storage; 0.605711 DASH measured | No |
| forge-collab registration (once per network, deployer) | 0.55 DASH fee + storage; 0.555523 DASH measured | No |
| Create a repository (`repo` + `maintainer` + `config`) | ~0.0013 DASH | No (the documents are permanent) |
| Push (tiny) | ~0.002–0.003 DASH to your own bucket, ~0.004–0.005 DASH with packs on Platform | No for Platform-stored packs |
| Issue / comment | ~0.0005–0.0017 DASH | issues no; comments on delete |
| Smoke-suite run (create + push + issue) | ≤ 0.05 DASH | mostly not: repos, issues and Platform packs are permanent |

Minimum to register: **~1.17 DASH** (1.161234 DASH measured on moutai). Budget ~2 DASH for registration plus a smoke run and a buffer. If you run the script with `--dry-run` first, it costs nothing.

## 2. Register forge-v2

```bash
# Once: the pinned protocol-14 SDK the script uses.
(cd forge-contracts/sdk-v2 && npm ci)

# Offline check of the id derivation (no network).
node forge-contracts/scripts/deploy-v2.mjs --self-test

# Build, validate and size both transitions against mainnet without broadcasting.
node forge-contracts/scripts/deploy-v2.mjs --identity <deployer-mainnet.identity.json> \
     --network mainnet --dry-run

# Register: forge-core (creating the contract group), then forge-collab enrolled in it.
node forge-contracts/scripts/deploy-v2.mjs --identity <deployer-mainnet.identity.json> \
     --network mainnet
# → writes the v2 section of forge-contracts/deployments/mainnet.json
```

- Before broadcasting, the script checks the network's protocol version, rebuilds both contracts with full validation locally, and prints the transition sizes.
- Each step's nonce, contract id, group id and pre-broadcast balance are recorded in `deployments/mainnet.json` before it broadcasts. If the run is interrupted, **run the same command again**: it completes what landed and never registers a second copy. Do not pass `--force-new` on mainnet unless you mean to supersede the registered pair with a new one.
- Afterwards the record shows both contracts as `registered`, with their cost, and the script has checked on chain that the group exists, the deployer owns it, and both contracts are enrolled.

## 3. Wire the mainnet deployment into clients

- Until `mainnet.json` has a registered `v2` pair, every client reports "not deployed" on mainnet. That is the expected pre-deploy state; clients never fall back to another network's ids.
- `forge-core` embeds every `forge-contracts/deployments/*.json` at build time (`crates/forge-core/build.rs`), so committing `mainnet.json` is the whole Rust change. Rebuild and confirm with `dg doctor --network mainnet`: the `contracts` check names forge-core and forge-collab and `forge-contracts/deployments/mainnet.json` as the source, and verifies both are enrolled in the group.
- forge-web: add `mainnet` to `forge-web/lib/deployments.ts` (the `deployments bundle` unit test fails until you do), then build with `NEXT_PUBLIC_NETWORK=mainnet`; the SDK uses `EvoSDK.mainnetTrusted()`. See [BUILDING.md § Networks](BUILDING.md#networks).
- Once mainnet is live, consider making it the CLI's default network (today the default is testnet, which has no forge-v2 deployment yet).

## 4. Schema changes after registration

Protocol 14 lets the owner update the contracts only within its update rules: new optional properties and new document types are accepted; indexes, `refersTo`/`ownerRefersTo`, `immutable`, `encryptedFor` and new required fields are frozen. Check a proposed change against the registered schema with `tools/contract-validate --previous` ([forge-v2.md §8](contracts/forge-v2.md#8-deploying)) and rehearse it on bonsia. A change the rules refuse ships as a new registration (`--force-new`, or `--only collab --force-new` for forge-collab alone); documents written under the old contracts stay under their ids and are no longer read, so on mainnet that is effectively a fresh start and needs a deliberate decision.

## 5. Deploy forge-web to production

- The static export deploys to GitHub Pages (`.github/workflows/pages.yml`, from master), built for devnet bonsia from the cut-over (`NEXT_PUBLIC_NETWORK=devnet`, `NEXT_PUBLIC_DEVNET_NAME=bonsia`). For mainnet, either switch the Pages build to `NEXT_PUBLIC_NETWORK=mainnet` or host a second mainnet instance.
- Optional: publish an IPFS snapshot of `out/` for a censorship-resistant mirror (`ipfs add -r out/` via a pinning service) — the app is fully static and self-verifying.

## 6. Production smoke suite (post-deploy + weekly)

Adapt `e2e/cli/run.sh` to mainnet with a small-balance PROD identity (budget ≤ 0.05 DASH/run). forge-v2 repositories, issues and Platform-stored packs cannot be deleted, so reuse one smoke repository with fresh branches per run rather than creating a repository each time:

1. Tiny push to `forge-smoke` on a fresh `smoke/<date>` branch, fresh clone verify (fsck + byte-identical), issue create/close, delete the branch.
2. forge-web smoke: `pnpm exec playwright test` (the web e2e suite) pointed at the production URL on mainnet — landing + repo home + zero-backend + a11y.
3. Relay heartbeat: a smoke webhook delivered from a mainnet push (if running a relay).
4. Alerting: on failure, open a repo issue + notify; balance watchdog warns when the PROD identity < 2× run cost.

## 7. Dogfood (the credibility step)

Host the Dash Forge repo itself on mainnet Forge: `dg repo create dash-forge` (owner = a jointly-held org identity), push the codebase, keep GitHub as a `gitmirror://` read-only mirror during transition. `dash://<org>/dash-forge` becomes the canonical mirror-of-record.

## 8. Rollback / incident

- Contracts are immutable in their gates and cannot be deleted — there is no "undo register." A bad registration means registering a *new* pair (`--force-new`) and shipping clients that read it; repositories created under the old pair stay there, unread. So **rehearse on bonsia (and testnet once it runs protocol 14) and dry-run on mainnet first**.
- A client bug ships via a normal client release (Pages redeploy / new `dg` binary) — no on-chain action.
- External-backend outage: `dg reseed` from any clone restores availability; refs/manifests on Platform are unaffected.

## Pre-flight checklist

- [ ] Mainnet runs protocol 14
- [ ] Contract owner and custody decided (D-D; jointly held for an org), deployer identity funded (~2 DASH)
- [ ] `config.readonly` decided and set in the schemas if wanted; pre-mainnet schema changes landed and rehearsed on bonsia
- [ ] `node forge-contracts/scripts/deploy-v2.mjs --identity <deployer-mainnet.identity.json> --network mainnet --dry-run` clean
- [ ] forge-v2 registered; `deployments/mainnet.json` (`v2`) committed; `dg doctor --network mainnet` green
- [ ] forge-web built for mainnet, deployed, Playwright smoke green
- [ ] Smoke suite scheduled; balance watchdog + alerting wired
- [ ] Dogfood repo created and pushed
