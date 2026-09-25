# Dash Forge

**Fully decentralized, zero-backend git hosting and collaboration, built directly on Dash Platform.**

Dash Forge is a suite of tools that together provide a GitHub-class experience — repositories, pushes/clones, branches, issues, pull requests, releases, CI hooks — with **no servers anywhere**. Dash Platform is the sole source of truth (refs, manifests, collaboration docs, token-based access control); pack data lives on Platform by default, or on cheaper hash-verified backends (IPFS / S3 / HTTPS / mirror git hosts) for fee reduction. Original design brief: `../INIT.md`; reconciliation notes: [docs/init-reconciliation.md](docs/init-reconciliation.md).

## The product suite

| Component | What it is |
|---|---|
| **forge protocol** | Data contracts: one global registry + a per-repo contract template with WRITE/MAINTAIN token ACLs enforced at consensus. |
| **git-remote-dash** | Git remote helper (Rust). `git clone dash://alice/project` and `git push` just work. jj-compatible. |
| **dg** | `gh`-replacement CLI (Rust, same workspace): repos, issues, PRs, releases, collaborator token management, cost audit, repack. |
| **forge web** | Static SPA (TypeScript, wasm SDK, in-browser repo materialization) deployable to IPFS. Browsing, issues, and PR timelines (including review verdicts) are built; opening a PR, recording a verdict, and PR diffs are not — see [PRD 03](docs/prd/03-web-app.md). |
| **forge relay** | Stateless, interchangeable Rust daemon bridging Platform events to GitHub-shaped webhooks (CI/notifications). Trust = availability only. |
| **forge import** | One-command GitHub migration (code, issues, PRs, releases) with cost gating and author claim flow. |

## Install

Prebuilt `dg` and `git-remote-dash` binaries for Linux (x86_64 and aarch64 glibc builds, a
static x86_64 musl build), macOS (Intel and Apple silicon) and Windows are published with
every [release](https://github.com/PastaPastaPasta/dash-forge/releases):

```sh
curl -fsSL https://raw.githubusercontent.com/PastaPastaPasta/dash-forge/master/install.sh | sh
dg doctor
```

The script verifies the archive against the release's `SHA256SUMS`. If the GitHub CLI is
available, it also checks the archive's build provenance attestation. It installs into
`~/.local/bin` and never uses sudo. The macOS binaries are not signed by Apple yet. See
[docs/INSTALL.md](docs/INSTALL.md) for manual download and verification,
`cargo binstall`, shell completions (`dg completions <shell>`) and Gatekeeper.

## Building

A fresh clone builds with no out-of-tree setup — `cargo build --workspace` for the Rust
binaries, `pnpm install && pnpm build` in `forge-web/` for the web app. The Dash Platform
SDK is a git dependency pinned to an immutable tag, so there is no sibling checkout to
arrange. **`protoc` must be on PATH** (a transitive dependency compiles `.proto` files in
its build script). See [docs/BUILDING.md](docs/BUILDING.md) for prerequisites, how to bump
the pinned Platform tag, and how to develop against a local Platform checkout.

**Networks.** Testnet is the default. Pick another network with `--network mainnet`, or
`--network devnet --devnet-name moutai` for a named devnet (`--dapi-addresses` sets its
nodes). The helper reads the same settings from git config (`dash.network`,
`dash.devnetName`, `dash.dapiAddresses`), and the web build reads them from
`NEXT_PUBLIC_NETWORK` and `NEXT_PUBLIC_DEVNET_NAME`. Contract ids come only from
`forge-contracts/deployments/<network>.json`. A network with no deployment (mainnet, until
the runbook is executed) fails with a clear "not deployed" error and never falls back to
testnet ids. See [BUILDING.md § Networks](docs/BUILDING.md#networks).

## Document index

1. [Platform constraints & research findings](docs/research/platform-constraints.md) — verified limits/fees that shape the design.
2. [INIT.md reconciliation](docs/init-reconciliation.md) — what was adopted from the original brief; constraint-forced deviations, flagged for review.
3. [System architecture](docs/architecture.md) — components, contract topology, token ACL, storage backends, data flows, economics.
4. [Data contracts design](docs/contracts/data-contracts.md) — registry + repo-template schemas, token costs, indices.
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
9. [E2E & production test plan](docs/testing/e2e-test-plan.md) — testnet identities/funds via bridge.thepasta.org + faucet.thepasta.org; mainnet smoke.
10. [Spike results & Design Freeze #1](docs/research/spike-results.md) — the 9 de-risking spikes (GO verdict).
11. [Building from source](docs/BUILDING.md) — prerequisites, the pinned Platform SDK tag, local overrides. [Installing prebuilt binaries](docs/INSTALL.md) — install.sh, checksums + attestations, cargo binstall, cutting a release.
12. [Design Freeze #2 (as-built)](docs/design-freeze-2.md) — what implementation established: deviations, discoveries, final decisions.
13. [Mainnet runbook](docs/mainnet-runbook.md) — the rehearsed (not-yet-executed) mainnet deployment procedure.
14. [Product roadmap](docs/roadmap.md) — verified current state, owner decisions, and the phased plan from testnet proof-of-concept to a product real users adopt.

## Status

**Testnet proof-of-concept; not yet ready for real users.** All components exist and the core protocol is proven live on testnet, but mainnet is not deployed, `git push` does not yet honor external storage backends, and several web surfaces overstate what they do — see the [roadmap](docs/roadmap.md) for the verified gap list and plan. The web app is live at **https://forge.dashhq.org/** (testnet). See [EXECUTION.md](EXECUTION.md) for the build log, [design-freeze-2.md](docs/design-freeze-2.md) for as-built decisions, and [mainnet-runbook.md](docs/mainnet-runbook.md) for the (rehearsed, not-yet-executed) mainnet deployment.

Proven end-to-end on testnet: `git clone dash://…` / `git push` byte-identical round-trip; frozen-collaborator push rejected at consensus; third-party "no trust in any server" verification; browser app rendering live proof-verified data with the trust panel; CLI↔web parity via 70 shared conformance vectors.

Components (all under this repo): `forge-contracts` · `forge-core` (Rust lib) · `git-remote-dash` · `dg` (CLI) · `forge-relay` · `forge-import` · `forge-web`. Verification: `e2e/cli/` (CLI suite) + `forge-web/e2e/` (Playwright).

## Reference material (local workspace)

- `../INIT.md` — original design path & PRDs (authoritative product intent).
- `../platform` — Dash Platform monorepo (source of all cited limits/fees).
- `../yappr` — reference zero-backend Platform app (SDK/auth/write patterns to reuse).
- `../mainnet-bridge` / `../platform-identity-faucet` — bridge.thepasta.org and faucet.thepasta.org sources (identity/funding for users and e2e tests).
