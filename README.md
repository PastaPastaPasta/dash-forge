# Dash Forge

**Git hosting that nobody can take down.** Your refs, issues, pull requests and access control live on Dash Platform, signed by your own keys. Your code lives in storage you choose. No Forge server exists or is needed, and data is checked rather than trusted.

- **We host nothing.** No Forge server, account or database. You bring an identity and, if you like, a bucket. The chain proves the rest.
- **Nothing to trust.** Every read is checked against a Platform proof, and every byte against its hash. The [verification guide](docs/guides/verify-forge.md) says exactly what is checked, and the one input that is still trusted.
- **No takedowns.** The contracts have no moderation. Nobody can delete your history or ban your identity.
- **Plain git.** `git clone dash://…` and `git push` work unchanged, and so does jj. `dg` feels like `gh`.

## Try it (devnet moutai)

Forge runs on devnet **moutai** today (Platform protocol 14). Build the two binaries (Rust and `protoc` 25 or newer; see [BUILDING.md](docs/BUILDING.md)). Create an identity in the [Dash bridge](https://bridge.thepasta.org/?network=devnet-moutai), fund it from the [moutai faucet](https://faucet.moutai.networks.dash.org) (a repository costs about 0.001 DASH), and download its key backup. Then, from any git repository, replacing `<id>` with your identity id:

```sh
cargo install --locked --path crates/dg && cargo install --locked --path crates/git-remote-dash
dg auth login --network devnet --devnet-name moutai --identity ~/Downloads/dash-identity-<id>.json
export DASH_FORGE_KEY=~/.config/dash-forge/identities/devnet-moutai/<id>.identity.json
export DASH_FORGE_NETWORK=devnet DASH_FORGE_DEVNET_NAME=moutai   # git-remote-dash reads these
dg repo create hello                    # ~0.001 DASH: three documents in the shared contracts
git remote add forge dash://<id>/hello && git push -u forge main
```

Open `https://forge.dashhq.org/repo?owner=<id>&name=hello` to see it. The [quick start](docs/guides/quick-start.md) walks through each step.

Prebuilt binaries and a one-line `install.sh` will come with the first tagged release ([INSTALL.md](docs/INSTALL.md)). None has been published yet.

## Guides

| Guide | |
|---|---|
| [Quick start](docs/guides/quick-start.md) | install → identity → repository → push → web |
| [Mirror a GitHub repository](docs/guides/mirror-a-github-repo.md) | a copy of a GitHub repository that nobody can take down |
| [Bring your own storage](docs/guides/bring-your-own-storage.md) | keep packs in R2, B2, S3, MinIO or IPFS |
| [Collaborating](docs/guides/collaborating.md) | collaborators, issues, pull requests, releases |
| [Identity and keys](docs/guides/identity-and-keys.md) | backups, recovery, key safety |
| [What things cost](docs/guides/costs.md) | fees, deposits, refunds |
| [Check that Forge isn't lying to you](docs/guides/verify-forge.md) | proofs, hashes, running your own web app |
| [FAQ](docs/FAQ.md) · [Error codes](docs/errors.md) | |

## Status

| Network | Platform protocol | Forge |
|---|---|---|
| **Devnet moutai** | 14 | **forge-v2** registered: two shared contracts (forge-core, forge-collab) in one contract group, membership access control. `dg`, `git-remote-dash` and the web app at forge.dashhq.org use it. A repository costs about 0.001 DASH. |
| **Testnet** | 13 | Not deployed. forge-v2 is registered once Platform protocol 14 reaches testnet. |
| **Mainnet** | 13 | Not deployed. forge-v2 is registered once Platform protocol 14 activates on mainnet. |

On a network with no forge-v2 deployment, `dg`, `git-remote-dash` and the web app stop with a "not deployed" error. The first version of Forge (forge-v1: one contract per repository, token access control) ran on testnet until 2026-09-26. It was removed with no backwards compatibility, so v1 repositories can no longer be read.

Specified but not built yet, and marked **coming soon** in the guides: prebuilt releases, identity creation and limited-budget keys in `dg` (the web app has both), DPNS usernames, opening PRs and merging code from the browser, and private repositories.

---

## For developers

Original design brief: `../INIT.md`; reconciliation notes: [docs/init-reconciliation.md](docs/init-reconciliation.md).

### The product suite

| Component | What it is |
|---|---|
| **forge protocol** | Data contracts. forge-v2 (Platform protocol 14): two shared contracts, forge-core and forge-collab, in one contract group. Access control is membership documents checked at consensus ([forge-v2.md](docs/contracts/forge-v2.md)). |
| **git-remote-dash** | Git remote helper (Rust). `git clone dash://<owner>/project` and `git push` just work. jj-compatible. |
| **dg** | `gh`-replacement CLI (Rust, same workspace): repos, issues, PRs, releases, collaborator management, storage profiles, cost audit, repack, doctor. |
| **forge web** | Static SPA (TypeScript, wasm SDK, in-browser repo materialization) deployable to IPFS. Browsing, commit and PR diffs, issues, and PR timelines (including review verdicts) are built; opening a PR and recording a verdict are not — see [PRD 03](docs/prd/03-web-app.md). |
| **forge relay** | Stateless, interchangeable Rust daemon bridging Platform events to GitHub-shaped webhooks (CI/notifications). Trust = availability only. |
| **forge import** | One-command GitHub migration (code, issues, PRs, releases) with cost gating and author claim flow. |

### Building

A fresh clone builds with no out-of-tree setup — `cargo build --workspace` for the Rust
binaries, `pnpm install && pnpm build` in `forge-web/` for the web app. The Dash Platform
SDK is a git dependency pinned to an immutable tag, so there is no sibling checkout to
arrange. **`protoc` must be on PATH** (a transitive dependency compiles `.proto` files in
its build script). See [docs/BUILDING.md](docs/BUILDING.md) for prerequisites, how to bump
the pinned Platform tag, and how to develop against a local Platform checkout.
[docs/INSTALL.md](docs/INSTALL.md) covers the release pipeline, `install.sh`, checksums and
attestations, `cargo binstall` and shell completions (`dg completions <shell>`).

**Networks.** Testnet is the default network, but only devnet moutai has a forge-v2
deployment today, so pass `--network devnet --devnet-name moutai` (`dg auth login` records
it as your default; `--dapi-addresses` sets the devnet's nodes). The helper reads the same
settings from `DASH_FORGE_NETWORK` / `DASH_FORGE_DEVNET_NAME` or git config
(`dash.network`, `dash.devnetName`, `dash.dapiAddresses`), and the web build reads them from
`NEXT_PUBLIC_NETWORK` and `NEXT_PUBLIC_DEVNET_NAME`. Contract ids come only from
`forge-contracts/deployments/<network>.json`. A network with no deployment (testnet and
mainnet today) fails with a clear "not deployed" error and never falls back to another
network's ids. See [BUILDING.md § Networks](docs/BUILDING.md#networks).

### Document index

1. [Platform constraints & research findings](docs/research/platform-constraints.md) — verified limits/fees that shape the design.
2. [INIT.md reconciliation](docs/init-reconciliation.md) — what was adopted from the original brief; constraint-forced deviations, flagged for review.
3. [System architecture](docs/architecture.md) — components, contract topology, membership access control, storage backends, data flows, economics.
4. [forge-v2 contracts](docs/contracts/forge-v2.md) — the protocol-14 shared contracts: types, gates, client rules, costs, deployment. [Data contracts design](docs/contracts/data-contracts.md) is the historical forge-v1 design (registry + per-repo contracts), no longer implemented.
5. PRDs:
   - [01 Product overview & personas](docs/prd/01-product-overview.md)
   - [02 git-remote-dash & dg](docs/prd/02-git-remote-helper-cli.md)
   - [03 forge web](docs/prd/03-web-app.md)
   - [04 Storage backends](docs/prd/04-storage-adapters.md)
   - [05 forge relay](docs/prd/05-forge-relay.md)
   - [06 forge import](docs/prd/06-forge-import.md)
6. [Economics & fee minimization](docs/economics.md) — compression pipeline, deposit-vs-burn cost model, repack/refund GC.
7. [Style guide](docs/design/style-guide.md) — visual system + engineering conventions.
8. [Implementation plan](docs/implementation-plan.md) — Phase 0 de-risk gate → mainnet protocol → CLI+relay → web+import → hardening.
9. [E2E & production test plan](docs/testing/e2e-test-plan.md) — devnet moutai identities and funds, the nightly suites, mainnet smoke.
10. [Spike results & Design Freeze #1](docs/research/spike-results.md) — the 9 de-risking spikes (GO verdict), run for forge-v1.
11. [Building from source](docs/BUILDING.md) — prerequisites, the pinned Platform SDK tag, local overrides. [Installing prebuilt binaries](docs/INSTALL.md) — install.sh, checksums + attestations, cargo binstall, cutting a release.
12. [Design Freeze #2 (as-built)](docs/design-freeze-2.md) — what the forge-v1 implementation established (historical).
13. [Mainnet runbook](docs/mainnet-runbook.md) — the rehearsed (not-yet-executed) mainnet deployment procedure.
14. [Error codes](docs/errors.md) — every `dg` / `git-remote-dash` error code, its exit code and fix.
15. [Product roadmap](docs/roadmap.md) — verified state, owner decisions, phased plan and execution tracker.
16. [UX/DX specification](docs/design/ux-dx-spec.md) — launch journeys, identity, storage onboarding, cost, trust, CLI conventions; its §11 P0 backlog is the launch checklist.

### Verification

The web app is live at **https://forge.dashhq.org** (GitHub Pages), built for devnet moutai; its header badge says "devnet". The CLI end-to-end suite (`e2e/cli/`) and the Playwright specs (`forge-web/e2e/`) run nightly against moutai ("Devnet Nightly"); see [e2e/README.md](e2e/README.md).

Proven end-to-end on moutai: `git clone dash://…` / `git push` byte-identical round-trip; a revoked writer's push and a non-member's push rejected at consensus; third-party "no trust in any server" verification; issue and PR lifecycles, including a PR from a fork with a real merge; the browser app rendering proof-verified data with the trust panel; CLI↔web parity via the shared conformance vectors. See [forge-v2.md](docs/contracts/forge-v2.md) for the contract design and [mainnet-runbook.md](docs/mainnet-runbook.md) for the (not-yet-executed) mainnet deployment.

Components (all under this repo): `forge-contracts` · `forge-core` (Rust lib) · `git-remote-dash` · `dg` (CLI) · `forge-relay` · `forge-import` · `forge-web`.

### Reference material (local workspace)

- `../INIT.md` — original design path & PRDs (authoritative product intent).
- `../platform` — Dash Platform monorepo (source of all cited limits/fees).
- `../yappr` — reference zero-backend Platform app (SDK/auth/write patterns to reuse).
- `../mainnet-bridge` / `../platform-identity-faucet` — bridge.thepasta.org and faucet.thepasta.org sources (identity/funding for users and e2e tests).
