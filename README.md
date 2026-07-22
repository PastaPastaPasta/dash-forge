# Dash Forge

**Fully decentralized, zero-backend git hosting and collaboration, built directly on Dash Platform.**

Dash Forge is a suite of tools that together provide a GitHub-class experience — repositories, pushes/clones, branches, issues, pull requests, releases, CI hooks — with **no servers anywhere**. Dash Platform is the sole source of truth (refs, manifests, collaboration docs, token-based access control); pack data lives on Platform by default, or on cheaper hash-verified backends (IPFS / S3 / HTTPS / mirror git hosts) for fee reduction. Original design brief: `../INIT.md`; reconciliation notes: [docs/init-reconciliation.md](docs/init-reconciliation.md).

## The product suite

| Component | What it is |
|---|---|
| **forge protocol** | Data contracts: one global registry + a per-repo contract template with WRITE/MAINTAIN token ACLs enforced at consensus. |
| **git-remote-dash** | Git remote helper (Rust). `git clone dash://alice/project` and `git push` just work. jj-compatible. |
| **dg** | `gh`-replacement CLI (Rust, same workspace): repos, issues, PRs, releases, collaborator token management, cost audit, repack. |
| **forge web** | Static SPA (TypeScript, wasm SDK, in-browser repo materialization) deployable to IPFS — full GitHub-replacement browsing and review UX. |
| **forge relay** | Stateless, interchangeable Rust daemon bridging Platform events to GitHub-shaped webhooks (CI/notifications). Trust = availability only. |
| **forge import** | One-command GitHub migration (code, issues, PRs, releases) with cost gating and author claim flow. |

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

## Status

Planning phase; nothing final. These documents are the first full-depth pass over everything needed to implement the project.

## Reference material (local workspace)

- `../INIT.md` — original design path & PRDs (authoritative product intent).
- `../platform` — Dash Platform monorepo (source of all cited limits/fees).
- `../yappr` — reference zero-backend Platform app (SDK/auth/write patterns to reuse).
- `../mainnet-bridge` / `../platform-identity-faucet` — bridge.thepasta.org and faucet.thepasta.org sources (identity/funding for users and e2e tests).
