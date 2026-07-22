# PRD 05 — Forge Relay

## Goal
Bridge Platform's pull-only world to webhook-driven CI and notifications **without becoming a trusted party**. Trust is only availability, never integrity: consumers re-fetch and verify everything from Platform.

## Design

Stateless Rust daemon (workspace member alongside dg/helper):

1. **Ingest**: subscribes to blocks/state transitions via DAPI (Core gRPC streams + platform polling where needed — Platform has no document push subscriptions, reconciliation D6), filters for registered repo contracts.
2. **Translate**: emits **GitHub-compatible webhook payloads** — `push`, `pull_request`, `issue_comment`, `check_run` schemas — so Blacksmith/Depot/Jenkins/existing tooling integrates with near-zero work. Payload fields that GitHub derives server-side (compare URLs etc.) map to forge-web URLs.
3. **Deliver**: HMAC-SHA256 signatures (`X-Hub-Signature-256`), exponential retry with dead-letter log.
4. **Subscriptions live on Platform**: `webhook` docs in each repo contract (MAINTAIN-gated) carry url, event list, and the secret **encrypted to the relay's identity key** → relay instances are interchangeable; killing one and pointing at another requires **no repo-side changes** (re-encrypt secret to new relay identity = one doc update).
5. **Optional add-ons** (same daemon, feature-flagged): email/web-push notification fan-out; global search indexer host (explicitly *optional* — the core product never depends on it).

## Deployment
- Docker one-liner; config = relay identity key + network. DCG/community run public instances; anyone can run their own (per-repo choice via `webhook.relayIdentityId`).
- Horizontal scale: stateless; at-least-once delivery semantics documented (consumers dedupe on delivery ID).

## CI integration story
- Runner receives webhook → fetches repo via `git clone dash://…` (helper) → runs → writes `checkRun` docs back through its own identity holding WRITE tokens. forge-web renders check status from those docs. No Actions-equivalent in v1 (explicit non-goal — CI is external by design). Only GitHub's modern check-runs shape is modeled; the legacy commit-status API is an explicit non-goal (integrations emitting it need a translating consumer).

## Security
- Relay never holds repo write authority (its identity holds no tokens unless it's also a CI runner).
- Webhook secrets: encrypted-at-rest on Platform, decrypted only in relay memory; rotation = new webhook doc revision.
- SSRF guards on delivery URLs (no private-range targets by default); per-target rate limits.

## Acceptance
- Push → Blacksmith build triggered **< 30 s**.
- Kill relay instance A, point repo at instance B (one doc update) → deliveries resume, no other repo-side changes.
- Tampered relay (fixture) altering payloads is detected by a verifying consumer (sample CI script re-fetches from Platform and compares OIDs) — documented as the reference consumer pattern.
