# Dash Forge

**Git hosting that nobody can take down.** Your refs, issues, pull requests and access control live on Dash Platform, signed by your own keys. Your code lives in storage you choose. No server is trusted, and no server is needed.

- **We host nothing.** No Forge server, account or database. You bring an identity and, if you like, a bucket. The chain proves the rest.
- **Nothing to trust.** Every read is checked against a Platform proof, and every byte against its hash. The [verification guide](docs/guides/verify-forge.md) says exactly what is checked, and the one input that is still trusted.
- **No takedowns.** The contracts have no moderation. Nobody can delete your history or ban your identity.
- **Plain git.** `git clone dash://…` and `git push` work unchanged, and so does jj. `dg` feels like `gh`.

## Try it (testnet)

Build the two binaries (Rust and `protoc` 25 or newer; see [BUILDING.md](docs/BUILDING.md)). Create an identity in the [Dash bridge](https://bridge.thepasta.org/?network=testnet), fund it from the bridge's testnet faucet twice (a repository costs ~1.18 tDASH; each request gives 1), and download its key backup. Then, from any git repository:

```sh
cargo install --locked --path crates/dg && cargo install --locked --path crates/git-remote-dash
dg auth login --identity ~/Downloads/dash-identity-<id>.json
export DASH_FORGE_KEY=~/.config/dash-forge/identities/testnet/<id>.identity.json
dg repo create hello                    # a v1 repository: ~1.18 tDASH (forge-v2 will be ~0.001 DASH)
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

| Network | Forge version | State |
|---|---|---|
| **Testnet** | **v1** (legacy): one contract per repository, token access control | Live. Everything in the guides works here. A repository costs ~1.18 tDASH. |
| **Devnet moutai** | **forge-v2**: two shared contracts, membership access control, Platform protocol 14 | Contracts registered. The CLI and web app cannot use them yet; support is landing now. A repository will cost ~0.001 DASH. |
| **Mainnet** | — | Not deployed. forge-v2 will be registered once Platform protocol 14 activates on mainnet. |

Specified but not built yet, and marked **coming soon** in the guides: prebuilt releases, identity creation in `dg` and in the browser, limited-budget keys, DPNS usernames, forks, opening and merging PRs from the browser, the GitHub Mirror Action, and private repositories.

---

## For developers

Original design brief: `../INIT.md`; reconciliation notes: [docs/init-reconciliation.md](docs/init-reconciliation.md).

### The product suite

| Component | What it is |
|---|---|
| **forge protocol** | Data contracts. v1 (testnet): one global registry + a per-repo contract template with WRITE/MAINTAIN token ACLs enforced at consensus. forge-v2 (protocol 14): two shared contracts with membership gates ([forge-v2.md](docs/contracts/forge-v2.md)). |
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

**Networks.** Testnet is the default. Pick another network with `--network mainnet`, or
`--network devnet --devnet-name moutai` for a named devnet (`--dapi-addresses` sets its
nodes). The helper reads the same settings from git config (`dash.network`,
`dash.devnetName`, `dash.dapiAddresses`), and the web build reads them from
`NEXT_PUBLIC_NETWORK` and `NEXT_PUBLIC_DEVNET_NAME`. Contract ids come only from
`forge-contracts/deployments/<network>.json`. A network with no deployment (mainnet, until
the runbook is executed) fails with a clear "not deployed" error and never falls back to
testnet ids. See [BUILDING.md § Networks](docs/BUILDING.md#networks).

### Document index

1. [Platform constraints & research findings](docs/research/platform-constraints.md) — verified limits/fees that shape the design.
2. [INIT.md reconciliation](docs/init-reconciliation.md) — what was adopted from the original brief; constraint-forced deviations, flagged for review.
3. [System architecture](docs/architecture.md) — components, contract topology, token ACL, storage backends, data flows, economics.
4. [Data contracts design](docs/contracts/data-contracts.md) — registry + repo-template schemas, token costs, indices. [forge-v2 contracts](docs/contracts/forge-v2.md) — the protocol-14 shared contracts.
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
14. [Error codes](docs/errors.md) — every `dg` / `git-remote-dash` error code, its exit code and fix.

### Verification

The web app is live at **https://forge.dashhq.org** (GitHub Pages). The CLI end-to-end suite (`e2e/cli/`, 7 scenarios) and the Playwright specs (`forge-web/e2e/`) run nightly against live testnet; see [e2e/README.md](e2e/README.md).

Proven end-to-end on testnet: `git clone dash://…` / `git push` byte-identical round-trip; frozen-collaborator push rejected at consensus; third-party "no trust in any server" verification; browser app rendering live proof-verified data with the trust panel; CLI↔web parity via the shared conformance vectors. See [design-freeze-2.md](docs/design-freeze-2.md) for as-built decisions and [mainnet-runbook.md](docs/mainnet-runbook.md) for the (rehearsed, not-yet-executed) mainnet deployment.

Components (all under this repo): `forge-contracts` · `forge-core` (Rust lib) · `git-remote-dash` · `dg` (CLI) · `forge-relay` · `forge-import` · `forge-web`.

### Reference material (local workspace)

- `../INIT.md` — original design path & PRDs (authoritative product intent).
- `../platform` — Dash Platform monorepo (source of all cited limits/fees).
- `../yappr` — reference zero-backend Platform app (SDK/auth/write patterns to reuse).
- `../mainnet-bridge` / `../platform-identity-faucet` — bridge.thepasta.org and faucet.thepasta.org sources (identity/funding for users and e2e tests).
