# Dash Forge — Mainnet Deployment Runbook

**Status: NOT EXECUTED.** Per the project decision, Dash Forge is *testnet-complete*: everything is built and end-to-end verified on testnet. This runbook is the rehearsed procedure to bring it to mainnet when you choose to fund it. Every step has a testnet analog that already passed.

## 0. Prerequisites

- A funded **mainnet** Dash identity to act as the **registry deployer / DCG identity**. Cost budget below.
- The `dg` CLI and `git-remote-dash` helper built from a release tag (`cargo build --release`).
- `tools/mint-identity` works against mainnet (it already supports `--network`/mainnet config in the bridge flow; note the **faucet does not exist on mainnet** — you fund the identity's asset-lock deposit address with real DASH manually, then `mint`/`topup`).
- Decide the registry owner custody model: for an org, the deployer identity should be **jointly held** (multiple high-security keys across principals) — this is the *only* succession mechanism (contract owners are immutable; see PRD 01 open questions).

## 1. Cost budget (mainnet DASH — real money)

Measured on testnet (identical fee schedule, protocol-versioned):

| Item | Cost | Refundable? |
|---|---|---|
| Registry contract deploy (one-time) | ~0.68 DASH | No |
| Per-repo instantiation (repo-v1) | ~1.18 DASH | No |
| Push (tiny) | ~0.003 DASH | storage portion yes |
| Issue/comment | ~0.0001–0.0005 DASH | on delete |
| Smoke-suite run (create+push+issue+delete) | ≤ 0.05 DASH net | mostly refunded |

Minimum to launch: **~0.7 DASH** (registry) + **~1.2 DASH** per canonical repo + a smoke buffer. Budget ~3 DASH for a comfortable launch + smoke.

## 2. Deploy the registry

```bash
# Fund the deployer mainnet identity first (real DASH to its asset-lock deposit address, then):
node tools/mint-identity/mint.mjs balance --identity <deployer-mainnet.json>   # confirm funds

# Deploy the registry (uses the reconciled source with single-property count indices):
cd forge-contracts
node scripts/deploy.mjs --contract registry --identity <deployer-mainnet.json> --network mainnet
# → writes forge-contracts/deployments/mainnet.json with the registry contract id
```

**Use the reconciled `contracts/registry.json`** (post-Stage-5: it has the single-property `recent`/`star`/`follow` count indices the testnet-deployed registry lacks). Verify with the post-deploy canary (fetch + per-type doc create/delete) before proceeding.

## 3. Wire the mainnet registry id into clients

- `forge-core` reads deployments from `forge-contracts/deployments/<network>.json`; confirm `mainnet.json` is present and bundled (dg embeds it; forge-web `lib/constants.ts` picks it up).
- forge-web: build with `NEXT_PUBLIC_NETWORK=mainnet` (or the network switcher) — the SDK uses `EvoSDK.mainnetTrusted()`.

## 4. Contract-update rehearsal (before any template change)

The repo-v1 template is instantiated per-repo by clients (not deployed once), so a template fix only affects *new* repos. If you ever change it: validate with `fullValidation` + the state-level create path on **testnet first** (a real create), then ship the new template in a client release. Existing repos keep their (immutable) schema — clients already handle this via runtime compat shims + name-addressing.

## 5. Deploy forge-web to production

- The static export already deploys to GitHub Pages (`.github/workflows/pages.yml`). For mainnet, either flip `NEXT_PUBLIC_NETWORK` in the Pages build or host a second mainnet instance.
- Optional: publish an IPFS snapshot of `out/` for a censorship-resistant mirror (`ipfs add -r out/` via a pinning service) — the app is fully static and self-verifying.

## 6. Production smoke suite (post-deploy + weekly)

Adapt `e2e/cli/run.sh` to mainnet with a small-balance PROD identity (budget ≤ 0.05 DASH/run, mostly refunded):

1. Create `forge-smoke-<date>` (or reuse a canonical dogfood repo), tiny push, fresh clone verify (fsck + byte-identical), issue create/close, **repo teardown** (reclaim refund).
2. forge-web smoke: `pnpm exec playwright test` (the web e2e suite) pointed at the production URL on mainnet — landing + repo home + zero-backend + a11y.
3. Relay heartbeat: a smoke webhook delivered from a mainnet push (if running a relay).
4. Alerting: on failure, open a repo issue + notify; balance watchdog warns when the PROD identity < 2× run cost.

## 7. Dogfood (the credibility step)

Host the Dash Forge repo itself on mainnet Forge: `dg repo create dash-forge` (owner = a jointly-held org identity), push the codebase, keep GitHub as a `gitmirror://` read-only mirror during transition. `dash://<org>/dash-forge` becomes the canonical mirror-of-record.

## 8. Rollback / incident

- Contracts are immutable + non-deletable — there is no "undo deploy." A bad registry deploy means deploying a *new* registry and re-pointing clients (existing listings are orphaned). So **rehearse on testnet and run the canary before mainnet**.
- A client bug ships via a normal client release (Pages redeploy / new `dg` binary) — no on-chain action.
- External-backend outage: `dg reseed` from any clone restores availability; refs/manifests on Platform are unaffected.

## Pre-flight checklist

- [ ] Deployer mainnet identity funded (~3 DASH), custody model decided (jointly-held for orgs)
- [ ] `contracts/registry.json` is the reconciled source (has count indices)
- [ ] `dg`/helper built from a tagged release; `dg doctor --network mainnet` green
- [ ] Registry deployed + canary passed; `deployments/mainnet.json` committed
- [ ] forge-web built for mainnet, deployed, Playwright smoke green
- [ ] Smoke suite scheduled; balance watchdog + alerting wired
- [ ] Dogfood repo created and pushed
