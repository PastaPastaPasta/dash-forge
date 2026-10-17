# Dash Forge

**Git hosting that nobody can take down.** Your refs, issues, pull requests and access control live on Dash Platform, signed by your own keys. Your code lives in storage you choose. No Forge server exists or is needed, and data is checked rather than trusted.

- **We host nothing.** No Forge server, account or database. You bring an identity and, if you like, a bucket. The chain proves the rest.
- **Nothing to trust.** Every read is checked against a Platform proof, and every byte against its hash. The [verification guide](docs/guides/verify-forge.md) says exactly what is checked, and what is still trusted.
- **No takedowns.** The contracts have no moderation. Nobody can delete your history or ban your identity.
- **Plain git.** `git clone dash://…` and `git push` work unchanged. `dg` feels like `gh`. jj push and fetch work too (tested on testnet in October 2026, jj 0.46), with one catch for identity-id owners: see the [quick start](docs/guides/quick-start.md#jj).

## Status

**Live on Dash testnet**, a test network, at [forge.dashhq.org](https://forge.dashhq.org). Mainnet: not yet. See [Networks](docs/networks.md).

<!-- TODO(owner-approved-text): the testnet durability statement goes here. -->

## Quick start (testnet)

1. **Install** `dg` and `git-remote-dash`. `curl -fsSL https://raw.githubusercontent.com/PastaPastaPasta/dash-forge/master/install.sh | sh` installs the latest release's checksum-verified binaries into `~/.local/bin`; Windows, manual downloads, checksums and attestations are in [INSTALL.md](docs/INSTALL.md). Or build from source (Rust and `protoc` 25 or newer, [BUILDING.md](docs/BUILDING.md)):
   ```sh
   git clone https://github.com/PastaPastaPasta/dash-forge && cd dash-forge
   cargo install --locked --path crates/dg && cargo install --locked --path crates/git-remote-dash
   ```
2. **Get an identity:**
   ```sh
   dg auth new
   ```
   Testnet is the default network, so no flags are needed. It shows 12 words to write down and a deposit QR code; fund it from the [testnet faucet](https://faucet.testnet.networks.dash.org) (a second one: [faucet.thepasta.org](https://faucet.thepasta.org)). It then registers the identity and keeps a **limited key** (0.25 DASH budget, 180 days, Forge only) in your OS keychain, which `dg` and `git push` both use. Already have an identity (a bridge key backup, or the 12 words)? `dg auth login <file>` or `dg auth login --mnemonic` instead.
3. **Publish** any git repository:
   ```sh
   dg storage add                          # optional: your own bucket or IPFS node, tested as you go
   dg init                                 # ~0.007 DASH: creates the repository, adds `origin`, pushes this branch
   ```
   Without a storage profile, `dg init` stops before spending and prices the alternative; pass `--storage platform` to keep packs on Platform (~0.33 DASH/MiB; see [What things cost](docs/guides/costs.md)).

`dg init` prints the repository's web address. Prefer the browser? On [forge.dashhq.org](https://forge.dashhq.org), **Sign in** creates an identity for you (or connects your Dash wallet; that needs a Dash Wallet build with DashConnect, with limits: see [Identity and keys](docs/guides/identity-and-keys.md#signing-in-with-the-dash-wallet-app-what-works-today)), **Settings → Storage** sets up your bucket, and **New → Repository** creates the repository. The [quick start guide](docs/guides/quick-start.md) walks through each step.

## What you can do

- **Host and clone.** `git clone dash://<owner>/<name>`, `git push`, branches, tags, force-push, partial clones (`--filter=blob:none`). Every push prints its cost before it pays, and a cost guard can make it ask.
- **Bring your own storage.** Packs go to your S3-compatible bucket (R2, B2, AWS S3, MinIO), your IPFS node or pinning service, or Platform, with N-of-M replication. Set it up with `dg storage add` or the web app's storage wizard.
- **Collaborate.** Writers and maintainers enforced at consensus, issues, labels, pull requests from a branch or a fork, reviews that count only from members on the current head, real merges (`dg pr merge`), releases with hash-checked assets, forks and stars.
- **Mirror GitHub.** `forge-import` (or `dg import`) copies code, issues, PRs, releases and labels, and the [Mirror Action](action/README.md) keeps the copy in sync from GitHub Actions, idempotently and under a cost cap.
- **Keep it private.** `dg repo create --private`: code, branch names, issues, PRs and releases are encrypted to members' identity encryption keys, removing a member rotates the key, and the [collaborating guide](docs/guides/collaborating.md#private-repositories) lists exactly what stays visible (existence, name, members, sizes, timing, commit ids; label definitions, check runs and webhook URLs are not encrypted in this release). The web app's private views follow.
- **Keep keys contained.** `dg auth` and the web app sign with *limited keys*: a budget, an expiry, and usable only on Forge's contracts, enforced by Platform. The master key signs only one-time steps and is not stored (unless you ask for `dg auth login --full-key`). CLI keys live in the OS keychain; browser keys in an encrypted vault (passkey or passphrase). CI gets one pasteable `dfk1:` runner key.
- **Use the web app.** Browse code, commits and diffs; file and triage issues; review PRs; publish releases; manage members and storage; Explore and a local notifications inbox ([supported browsers](docs/FAQ.md#which-browsers-does-the-web-app-support)). Sign in by creating an identity in the browser, importing one, or scanning a QR code with Dash Wallet (that needs a Dash Wallet build with DashConnect, with limits; see [Identity and keys](docs/guides/identity-and-keys.md#signing-in-with-the-dash-wallet-app-what-works-today)).
- **Check everything.** A Verification card on every repository page says what was proven and how, including a cross-check of the quorum keys against a second source.
- **Wire up CI.** `dg webhook add` plus a relay you run yourself (`forge-relay`) turn on-chain activity into GitHub-shaped webhooks, with a durable retry queue.

**Coming soon:** editing files in the browser, and browser merges for private repositories (`dg` has them). The [release notes](docs/releases/v0.2.0.md#known-limitations) list what else is not there yet.

## Start here

- **[Quick start](docs/guides/quick-start.md):** install, identity, storage, `dg init`, push, web.
- **[Moving from GitHub or GitLab](docs/guides/moving-from-github.md)** or **[mirror a GitHub repository](docs/guides/mirror-a-github-repo.md):** bring a project over, or keep a copy that nobody can take down.
- **[Bring your own storage](docs/guides/bring-your-own-storage.md):** keep packs in R2, B2, S3, MinIO or IPFS.
- **[FAQ](docs/FAQ.md)** and **[error codes](docs/errors.md)**.

Every guide (collaborating, identity and keys, costs, CI, verification and more) is listed in the **[guides index](docs/guides/README.md)**.

---

## For developers

### The product suite

| Component | What it is |
|---|---|
| **forge protocol** | Data contracts. forge-v2 (Dash Platform v5): shared contracts (forge-core, forge-collab, forge-community, and forge-meta where the network has it) in one contract group. Access control is membership documents checked at consensus ([forge-v2.md](docs/contracts/forge-v2.md)). |
| **git-remote-dash** | Git remote helper (Rust). `git clone dash://<owner>/project` and `git push` just work. jj: push and fetch work (tested on testnet in October 2026, jj 0.46); add the remote with git, not jj, when the owner is an identity id ([quick start](docs/guides/quick-start.md#jj)). |
| **dg** | `gh`-replacement CLI (Rust, same workspace): `auth` (identities, limited keys on the OS keychain, DPNS names), `init`, repos, forks, stars, issues, labels, PRs with real merges, releases with assets, members, storage profiles, webhooks, `import`, cost estimates, repack, reseed, doctor. |
| **forge web** | Static SPA (TypeScript, wasm SDK, in-browser repo materialization) deployable to IPFS. Built: browsing, commit and PR diffs, issues, opening PRs, inline review comments and verdicts, forks, merges from the browser (fast-forward, squash, and merge commits when the two sides changed different paths; the merge's pack goes to your storage, or to Platform if you allow it), releases, members, the storage wizard, limited-key sign-in with an encrypted vault, in-browser identity creation, Dash Wallet sign-in, Explore and notifications. Not yet: rebase merges, a browser merge when both sides changed the same file (use `dg pr merge`), editing files in the browser, and searching file contents. |
| **forge relay** | Interchangeable Rust daemon, run by users, bridging Platform events to GitHub-shaped webhooks (CI/notifications), with chain-encrypted secrets and a durable retry queue. Trust = availability only. |
| **forge import** | One-command GitHub migration and incremental mirror (code, issues, PRs, releases, labels) with a spending cap; the engine behind `dg import` and the [Mirror Action](action/README.md). |

### Building

A fresh clone builds with no out-of-tree setup — `cargo build --workspace` for the Rust
binaries, `pnpm install && pnpm build` in `forge-web/` for the web app. The Dash Platform
SDK is a git dependency pinned to an immutable tag, so there is no sibling checkout to
arrange. **`protoc` must be on PATH** (a transitive dependency compiles `.proto` files in
its build script). See [docs/BUILDING.md](docs/BUILDING.md) for prerequisites, how to bump
the pinned Platform tag, and how to develop against a local Platform checkout.
[docs/INSTALL.md](docs/INSTALL.md) covers the release pipeline, `install.sh`, checksums and
attestations, `cargo binstall` and shell completions (`dg completions <shell>`).

**Networks.** Testnet is the default network and the one Forge runs on (its forge-v2
contracts are registered there), so no flag is needed; for a development devnet pass
`--network devnet --devnet-name <name>` (`dg auth new` / `dg auth login` record the network
as your default; `--dapi-addresses` sets a devnet's nodes). The helper reads the same
settings from `DASH_FORGE_NETWORK` / `DASH_FORGE_DEVNET_NAME`, git config
(`dash.network`, `dash.devnetName`, `dash.dapiAddresses`), or else the default `dg` recorded, and the web build reads them from
`NEXT_PUBLIC_NETWORK` and `NEXT_PUBLIC_DEVNET_NAME`. Contract ids come only from
`forge-contracts/deployments/<network>.json`. A network with no deployment (mainnet
today) fails with a clear "not deployed" error and never falls back to another
network's ids. See [BUILDING.md § Networks](docs/BUILDING.md#networks).

### Document index

1. [Platform constraints & research findings](docs/research/platform-constraints.md) — verified limits/fees that shape the design.
2. [Design brief reconciliation](docs/init-reconciliation.md) — what was adopted from the original design brief; constraint-forced deviations, flagged for review.
3. [System architecture](docs/architecture.md) — components, contract topology, membership access control, storage backends, data flows, economics.
4. [forge-v2 contracts](docs/contracts/forge-v2.md) — the shared contracts on Dash Platform v5: types, gates, client rules, costs, deployment.
5. PRDs still describing the shipped design:
   - [04 Storage backends](docs/prd/04-storage-adapters.md)
   - [05 forge relay](docs/prd/05-forge-relay.md)
6. [Economics & fee minimization](docs/economics.md) — compression pipeline, deposit-vs-burn cost model, repack/refund GC.
7. [Style guide](docs/design/style-guide.md) — visual system + engineering conventions.
8. [Archive](docs/archive/README.md) — the forge-v1 design, plans, spike results and build log, and the earlier devnet notes. Historical; nothing there describes the current system.
9. [E2E & production test plan](docs/testing/e2e-test-plan.md) — devnet identities and funds, the nightly suites, mainnet smoke.
10. [Building from source](docs/BUILDING.md) — prerequisites, the pinned Platform SDK tag, local overrides. [Installing prebuilt binaries](docs/INSTALL.md) — install.sh, checksums + attestations, cargo binstall, cutting a release.
11. [Deploying Forge to a network](docs/deploying-to-a-network.md) — registering the four contracts on testnet and then mainnet: set, order, costs, custody, update rules (not yet executed on either).
12. [Error codes](docs/errors.md) — every `dg` / `git-remote-dash` error code, its exit code and fix.
13. [Product roadmap](docs/roadmap.md) — verified state, owner decisions, phased plan and execution tracker.
14. [UX/DX specification](docs/design/ux-dx-spec.md) — launch journeys, identity, storage onboarding, cost, trust, CLI conventions; its §11 P0 backlog is the launch checklist.
15. [Limits](docs/limits.md) — sizes, counts and caps, with where each comes from. [Bots and agents](docs/guides/bots.md) (beta) is in the [user guides](docs/guides/README.md).

### Verification

The web app at **https://forge.dashhq.org** (GitHub Pages) runs on Dash testnet (Dash Platform v5); [Networks](docs/networks.md) has the devnets Forge ran on before. The CLI end-to-end suite (`e2e/cli/`) and the Playwright specs (`forge-web/e2e/`) run nightly, from master's workflow file. See [e2e/README.md](e2e/README.md).

Proven end-to-end on a devnet before the testnet launch: `git clone dash://…` / `git push` byte-identical round-trip; a revoked writer's push and a non-member's push rejected at consensus; third-party "no trust in any server" verification; issue and PR lifecycles, including a PR from a fork with a real merge; the browser app rendering proof-verified data with the Verification card; `dg init` publishing to a bucket; an import re-run costing 0; relay deliveries surviving a restart; CLI↔web parity via the shared conformance vectors. See [forge-v2.md](docs/contracts/forge-v2.md) for the contract design and [deploying-to-a-network.md](docs/deploying-to-a-network.md) for the (not-yet-executed) testnet and mainnet registration.

Components (all under this repo): `forge-contracts` · `forge-core` (Rust lib) · `git-remote-dash` · `dg` (CLI) · `forge-relay` · `forge-import` · `forge-web`.

## Contributing, security and license

- **Contributing:** how to build, test and send a change is in [CONTRIBUTING.md](CONTRIBUTING.md).
- **Security:** report a vulnerability privately, as [SECURITY.md](SECURITY.md) describes. Don't open a public issue.
- **Announcements and security:** new releases are announced in [GitHub Releases](https://github.com/PastaPastaPasta/dash-forge/releases), and security fixes in this repository's [security advisories](https://github.com/PastaPastaPasta/dash-forge/security/advisories); those are the record. A forum thread to follow them: TODO(owner): name the Dash forum thread.
- **License:** Dash Forge is licensed under either of [Apache License 2.0](LICENSE-APACHE) or [MIT](LICENSE-MIT), at your option.
