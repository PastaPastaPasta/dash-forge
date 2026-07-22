# PRD 01 — Dash Forge Product Overview

## Vision

Git hosting that cannot be taken down, censored, or rug-pulled — because there is no host. Repositories, refs, issues, and pull requests live on Dash Platform under users' own cryptographic identities, with **consensus-enforced access control** (token ACLs); bulk content lives on Platform or on cheaper hash-verified backends. GitHub's *workflow*, Bitcoin's *trust model*.

## Problem

- Centralized forges are single points of failure, censorship, and policy risk; "decentralized" alternatives (Radicle, etc.) still require someone to operate seed nodes/peers, and embed social objects in git rather than queryable indexes.
- Dash Platform uniquely offers a consensus-backed, proof-verifiable *document database with indexes, reachable from a browser* — those indexes are what make a zero-backend GitHub-class UI possible.
- Cost is the obstacle (~$9/MiB on-Platform at $34/DASH); Forge answers with repack-with-refund (steady-state cost ≈ current repo size, not cumulative pushes) and mixed/external backends for bulk.

## Users & personas

| Persona | Needs | Primary surface |
|---|---|---|
| **Sovereignty-minded OSS maintainer ("Alice")** | Censorship-resistant home; collaborators push; runs project without a browser | dg + git-remote-dash (+ web) |
| **Contributor ("Bob")** | Clone, fork, patch, review — just an identity, no account | git-remote-dash + web |
| **Casual visitor** | Browse code, read README, file an issue from a browser | forge web |
| **Migrating org** | Move a real GitHub project with issues/PRs intact; keep CI working | forge import + relay |
| **CI operator** | Webhook triggers; write check results back | forge relay + runner identity with WRITE tokens |
| **Archivist / seeder** | Mirror & reseed pack data | dg reseed |

## Product principles

1. **Platform is the sole source of truth**; all other storage is verifiable cache.
2. **Zero workflow change**: standard git (and jj); `dg` mirrors `gh`'s surface deliberately.
3. **Trustless by default**: proofs for Platform reads; SHA-256 + OIDs for content; relay/CI re-verify.
4. **Cost is first-class UX**: estimate before every write batch, DASH primary / USD secondary, running spend audit, refunds surfaced.
5. **Documented honesty**: explicit non-goals (no on-chain FF/merge validation — reflog auditability instead; no Actions-equivalent; performance limits on giant repos).

## Scope by phase (see implementation plan)

- **Phase 1 ships a usable product**: contracts + remote helper on mainnet, on-Platform storage. No UI.
- **Phase 2**: dg (full terminal workflow: triage, review, land, release) + relay (CI works). Dogfood: forge hosts its own repos.
- **Phase 3**: forge web (full GitHub-replacement UX) + importer (launch adoption).
- **Phase 4**: backends GA (IPFS/S3/HTTPS/mixed), repack/GC, private-repo encryption *design* (v2).

### v1 exclusions (explicit)
Global cross-repo search; notifications inbox (poll badge only); Actions-equivalent (CI external by design); wikis (`docs/` convention); private repos.

Two of these are **structural consequences of per-repo contracts, not scoping choices** — stated honestly: (a) cross-repo aggregation (activity feed over watched repos, org-wide search, trending) has no platform-side path — Platform cannot query across contracts — so anything beyond client-side fan-out over a handful of repos needs an optional community-run indexer following forge-relay's trust-is-availability-only pattern (future component, not v1); (b) **repo transfer/ownership succession is unsupported** — no state transition changes a contract's owner and documents can't move between contracts, so "transfer" = fork-and-abandon. Orgs must mitigate at creation time by making the owner identity itself jointly held (multiple high-security keys across principals).

## Success metrics

- Phase 1: round-trip clone/push of the Dash Platform monorepo; frozen identity's push fails at consensus; third-party verifies a full clone from Platform data alone.
- Phase 2: maintainer runs a real project entirely from terminal; push → CI build < 30 s via relay.
- Phase 3: full review flow (line comment → request changes → re-review → merge) against mainnet from an IPFS-served SPA; dashpay/platform imports within 10% of cost estimate.
- Phase 4: interrupted 100 MB push resumes without re-paying; repack refund reduces steady-state cost to ≈ current repo size.

## Open product questions

1. **Patch token-gating** (reconciliation D3): INIT.md gates PR creation on WRITE tokens (blocks drive-by contributions); docs currently spec un-gated patches + MAINTAIN-gated merges. Decide after dogfooding spam levels.
2. Frozen-identity delete-for-refund semantics (S0.7 + Platform-core review).
3. Repo-template versioning/migration under DCG identity (Phase 1 design review).
4. Web proof-verifying vs trusted SDK mode default (S0.3 benchmark).
5. Diff renderer: diffs.com embed vs diff2html/Monaco (read Pierre's "On Rendering Diffs" first).
6. Owner-identity key custody pattern for orgs (the only succession mechanism) — needs a documented setup guide before mainnet.
7. Audit-log compaction for ancient reflog (unbounded locked deposit on hyperactive repos — economics §3): accepted for v1, revisit if dogfooding shows it matters.
