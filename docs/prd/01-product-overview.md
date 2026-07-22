# PRD 01 — Dash Forge Product Overview

## Vision

Git hosting that cannot be taken down, censored, or rug-pulled — because there is no host. Repositories, refs, issues, and pull requests live on Dash Platform under users' own cryptographic identities; bulk content lives wherever is cheap, verified by hash. GitHub's *workflow*, Bitcoin's *trust model*.

## Problem

- Centralized forges are single points of failure, censorship, and policy risk; "decentralized" alternatives (Radicle, etc.) require running seed nodes or peers — still infrastructure someone must operate.
- Dash Platform uniquely offers a consensus-backed, proof-verifiable *document database reachable from a browser* — the missing piece for a genuinely serverless forge.
- Cost is the obstacle (≈0.28 DASH/MiB on-platform); Forge solves it with hash-verified external bulk storage, keeping only signed manifests/refs on-chain.

## Users & personas

| Persona | Needs | Primary surface |
|---|---|---|
| **OSS maintainer ("Alice")** | Censorship-resistant home for her project; low fees; collaborators can push | forge-cli + git-remote-dash + web |
| **Contributor ("Bob")** | Clone, fork, open PRs without accounts or servers — just an identity | git-remote-dash + web |
| **Casual visitor** | Browse code, read README, file an issue from a browser | forge-web only |
| **Dash-ecosystem dev** | Store contracts/app code where the app itself lives; deploy keys for CI | forge-cli |
| **Archivist / seeder** | Mirror & re-seed repo bundles; strengthen availability | forge-cli (`reseed`) |

## Product principles

1. **Zero backend, forever.** If a feature needs a Forge-operated server, redesign it or cut it.
2. **Standard git.** `git clone dash://alice/repo` — no custom VCS commands for core flows.
3. **Trustless by default.** Every displayed byte is proof-verified or content-hash-verified.
4. **Cost transparency.** Every write shows its credit cost up front; storage tier is a user choice.
5. **Own your identity.** Dash identities + DPNS names; keys never leave the client (platform-auth vault patterns).

## Scope

### v1 (MVP)
- Create/browse repos; push/clone/fetch via remote helper (both storage tiers).
- Collaborators (grant/revoke, WRITE/MAINTAIN); multi-maintainer ref resolution.
- Issues + comments + state events; stars.
- Web: repo browsing (tree/blob/README/commits/branches/diffs), issue UI, repo creation, auth (key/password-vault/passkey), DPNS display.
- Storage adapters: IPFS (Storacha + Pinata + self-host gateway read), HTTPS (read), S3-compatible (write/read).
- forge-cli: repo CRUD, collaborator mgmt, storage config, cost estimates, reseed, identity import.
- Contracts deployed to testnet + mainnet; full e2e suite on testnet; production smoke on mainnet.

### v1.1
- Pull requests + reviews end-to-end (schema ships in v1; UI/merge tooling in 1.1).
- Releases with asset hosting; fork inheritance chains; repack/gc tooling.

### v2+ (explicitly deferred)
- Private repos (encryption via identity ENCRYPTION keys); org identities (multi-sig/groups); token-gated anti-spam; CI/webhook watcher daemons (user-run); LFS-style per-file pointers; git SHA-256 repos; mobile.

## Success metrics (testnet launch)
- Clone→push→clone round-trip fidelity: 100% (byte-identical objects) across both tiers.
- Push of a 1 MiB delta in < 60 s (Tier X), < 10 min (Tier P, pipelined).
- Web cold-load of a 10 MiB repo tree view < 8 s on broadband.
- Full e2e suite green in CI against testnet using faucet-funded identities.

## Competitive landscape (context)
- **Radicle**: peer-to-peer, needs seed nodes, own social layer, no browser-only reads.
- **git on IPFS/ENS/Arweave**: storage-only, no refs authority, no collaboration.
- **Forgejo/Gitea**: federated but server-full.
- Forge's differentiator: *consensus-authoritative refs + browser-native trustless reads + no infrastructure*.

## Open product questions (tracked; decided by testnet dogfooding)
1. Default storage tier for new repos: external-IPFS vs hybrid (refs+latest pack on platform). Leaning: external-IPFS with one-click "pin to platform".
2. Whether issue/PR numbering collisions warrant a per-repo counter doc (owner-serialized) instead of optimistic retry.
3. Trusted vs proof-verifying SDK mode default in web (perf benchmark decides).
4. Spam posture for open issues on popular repos (mute lists vs token cost).
