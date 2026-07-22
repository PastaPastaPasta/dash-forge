# Dash Forge — Execution Tracker

Session-continuity anchor. Docs in `docs/` are the spec; this file tracks build state. Update every session.

**Locked decisions**: testnet-complete (mainnet = runbook only) · GitHub `PastaPastaPasta/dash-forge` (private until Stage 4) · storage e2e docker-only (MinIO/kubo/static-http; Storacha+Pinata mock-tested) · import acceptance on medium repo (dashpay/dips-scale).

## Stage 0 — Repo, toolchain, scaffold
- [x] .gitignore, tracker
- [ ] GitHub repo created + pushed
- [ ] Cargo workspace scaffold (`crates/*`, no rs-sdk dep yet — added Stage 2)
- [ ] forge-web scaffold (Next.js 14 static export + evo-sdk 4.0.0 + style-guide tokens)
- [ ] infra/ (docker-compose: kubo, MinIO, static-http) + CI workflows + Makefile
- [ ] `tools/mint-identity` (S0.4) — validated by minting 1 live testnet identity
- [ ] Fixture identity pool minted (9 roles, e2e plan §1.1)
- [ ] `brew install jj` (deferred to S0.9)

## Stage 1 — Spikes S0.1–S0.9 → Design Freeze #1
- [ ] S0.6 contract JSONs draft + fullValidation + size/flags
- [ ] S0.2 chunk geometry · [ ] S0.1 throughput go/no-go · [ ] S0.7 token ACL
- [ ] S0.8 query cursors · [ ] S0.5 browse plane · [ ] S0.9 helper transport/jj · [ ] S0.3 proof-mode perf
- [ ] `docs/research/spike-results.md` + Design Freeze #1 doc updates

## Stage 2 — Protocol + helper → M1
- [ ] Contracts deployed testnet (`deployments/testnet.json`) · [ ] forge-core modules · [ ] git-remote-dash · [ ] M1 gate

## Stage 3 — dg + relay → M2
- [ ] dg full surface · [ ] forge-relay + CI consumer · [ ] M2 gate + dogfood

## Stage 4 — Web + import → M3
- [ ] forge-web (browse plane → auth → issues → PR review → extras) · [ ] Pages deploy (repo → public) · [ ] forge-import · [ ] M3 gate

## Stage 5 — Backends GA + hardening → M4
- [ ] ipfs/s3/https/gitmirror live · [ ] repack/GC e2e · [ ] security/a11y/perf · [ ] Design Freeze #2 + mainnet runbook

## Stage 6 — E2E certification
- [ ] CLI suite (13) · [ ] token-ACL suite (10) · [ ] Playwright (12) · [ ] relay/import/chaos · [ ] Codex CU verification passes · [ ] 7-day green nightly

## Next action
Stage 0: push repo, launch scaffold agents, build mint-identity.
