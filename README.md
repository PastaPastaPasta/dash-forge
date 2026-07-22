# Dash Forge

**Fully decentralized, zero-backend git hosting and collaboration, built directly on Dash Platform.**

Dash Forge is a suite of tools that together provide a GitHub-class experience — repositories, pushes/clones, branches, issues, pull requests, code browsing — with **no servers anywhere**. All state lives on Dash Platform (a decentralized, proof-verifiable document store secured by the Dash masternode network) or in content-addressed external bundle storage (IPFS / S3 / HTTPS / mirror git hosts) whose integrity is verified client-side against on-platform hashes.

## The product suite

| Product | What it is |
|---|---|
| **forge-contracts** | Dash Platform data contracts (core git contract + collaboration contract) and deployment tooling. The on-chain schema of the whole system. |
| **forge-core** | Shared TypeScript library (browser + Node): git object codec, pack chunking, storage adapters, contract services, authorization resolution, identity/signing. |
| **git-remote-dash** | A git remote helper. `git clone dash://alice/myrepo` and `git push` just work against Dash Platform. |
| **forge-cli** (`dforge`) | Repo management CLI: create repos, manage collaborators, configure storage tiers, estimate/inspect fees, manage identities. |
| **forge-web** | Static-export web app (GitHub-like UI): browse code, view commits/diffs, manage issues and pull requests, all directly from the browser against DAPI. Hosted on GitHub Pages / IPFS — the app itself is decentralizable. |

## Why this is possible

Dash Platform gives us: identities with cryptographic keys, schema-validated documents with indices and queries, client-side Merkle-proof verification, and permanent (refundable) paid storage — all reachable from a browser via WASM SDK with no intermediary server. Git's content-addressed object model composes perfectly with this: every object self-verifies by its hash, so bulk data can live anywhere untrusted while Platform holds the authoritative, signed refs and manifests.

## Document index

Start here, in order:

1. [Platform constraints & research findings](docs/research/platform-constraints.md) — the hard numbers that shape every design decision.
2. [System architecture](docs/architecture.md) — components, storage tiers, trust & authorization model, push/fetch protocols, economics.
3. [Data contracts design](docs/contracts/data-contracts.md) — full document schemas, indices, and mutation rules.
4. PRDs:
   - [Product overview & personas](docs/prd/01-product-overview.md)
   - [git-remote-dash + forge-cli](docs/prd/02-git-remote-helper-cli.md)
   - [forge-web](docs/prd/03-web-app.md)
   - [Storage adapters (IPFS / S3 / HTTPS / git mirrors)](docs/prd/04-storage-adapters.md)
5. [Style guide](docs/design/style-guide.md) — visual design system and code conventions.
6. [Implementation plan](docs/implementation-plan.md) — phased milestones and workstreams.
7. [E2E & production test plan](docs/testing/e2e-test-plan.md) — including programmatic testnet identity/funding via bridge.thepasta.org and faucet.thepasta.org.

## Status

Planning phase. Nothing here is final; these documents are the first full-depth pass over everything needed to implement the project.

## Reference material (local workspace)

- `../platform` — Dash Platform monorepo (v4.0.0-beta.3, protocol v12 era). Source of all limits/fees cited in docs.
- `../yappr` — reference zero-backend social app on Dash Platform (Next.js static export + `@dashevo/evo-sdk`); we reuse its service architecture, auth engine (`platform-auth`), and write-retry patterns.
- `../mainnet-bridge` — bridge.thepasta.org source (identity creation / credit funding).
- `../platform-identity-faucet` — faucet.thepasta.org source (testnet L1 coin dispenser).
