# INIT.md Reconciliation

`../INIT.md` (the original design path & PRDs) was located after the first planning pass. The docs have been updated to follow it. This file records **where INIT.md's design is adopted verbatim, and the few places where verified platform constraints (see [research](research/platform-constraints.md)) force a deviation** — each deviation is flagged for review.

## Adopted from INIT.md (now reflected throughout)

1. **Component set & names**: forge protocol (contracts), `git-remote-dash`, **`dg`** CLI (gh-mirroring surface), forge web, **forge relay**, **forge import**. (Previously: no relay/import, CLI named `dforge`.) New PRDs 05/06 added. Note: INIT.md's CLI name `dgit` was dropped — it collides with Debian's existing `dgit` tool — in favor of `dg` (two keystrokes, mirrors `gh`; distributed as package `dash-forge`, binary `dg`).
2. **Contract topology**: one global **registry contract** (`repoListing`, `profile`, `star`, `follow`) + **one repo contract per repository**, instantiated client-side from a canonical, versioned template. (Previously: two shared global contracts.)
3. **Token-cost ACL**: per-repo `WRITE`/`MAINTAIN` tokens; large mints as grants, freeze = suspend, freeze+destroy = revoke; write-path document types carry `tokenCost`. Authorization is **enforced at consensus**, not client-side — a major improvement over the first pass's client-resolved collaborator model, and proven viable by yappr's `tokenCost` usage.
4. **Storage default**: **Platform is primary storage and always source of truth**; IPFS/S3/HTTPS are fee-reduction/archival backends ("mixed mode": recent packs on Platform, archival external). (Previously: external-default.) Manifests/refs always on Platform in every mode.
5. **Rust core**: helper + CLI + relay as one Rust workspace (rs-sdk / rs-dpp), Radicle's helper as reference implementation; web remains TypeScript on wasm/evo-sdk. (Previously: all-TS.)
6. **Pack manifests with per-object offset index** → ranged chunk fetch, partial/shallow clone.
7. **Resumable pushes** via journal file; **cost-as-first-class UX** (estimate + prompt above threshold; DASH primary, USD secondary); repack-with-refund as the steady-state cost story.
8. **Phasing**: 0 de-risk (5/25/100 MB pushes, token-ACL prototype) → 1 protocol+helper on **mainnet** → 2 CLI+relay (dogfood) → 3 web+import → 4 hardening/backends GA/repack.
9. **Web specifics**: isomorphic-git + lightning-fs in a web worker, Shiki, CodeMirror 6 browser edits, MiniSearch per-repo code search, `checkRun` CI status docs, diff-rendering research note, ≤100 MB excellent-UX target with honesty about larger repos.

## Deviations from INIT.md (constraint-forced — review these)

| # | INIT.md says | Verified constraint | Resolution in docs |
|---|---|---|---|
| D1 | "validate **batch ST packing**… thousands of sequential STs" | `max_transitions_in_documents_batch = 1` (platform `system_limits/v1.rs`; intentional, issue #2867) — **one document op per state transition**, no batch packing today | Phase 0 measures **pipelined sequential-nonce single-transition throughput** instead; mixed-backend escape hatch unchanged. If upstream lifts the cap, we inherit the win. |
| D2 | Mutable `ref` docs ("revision-tracked") + separate `reflog` type | Documents are **replaceable only by their creator** — maintainer B can never update a `ref` doc maintainer A created, tokens notwithstanding | Merged into one **append-only `refUpdate`** type (= ref state *and* reflog). Current ref = newest refUpdate for the name; consensus token-gating means existence ⇒ authorized. `protectedRefUpdate` (MAINTAIN-gated) covers protected refs. |
| D3 | `patch` creation costs 1 WRITE | Token-gating patches **blocks drive-by outside contributions** (the fork-and-PR flow) | Flagged as open question in PRD 01/03: options are un-gated patch docs (platform fees as spam floor), or fork-side patches + WRITE-gated acceptance. Docs currently spec **un-gated patch creation**, MAINTAIN-gated merge events. |
| D4 | Repo contract template "<50KB total" | `estimated_contract_max_serialized_size = 16 KiB` per contract | Template validated against 16 KiB in Phase 0 (S0.6); fallback is two contracts per repo (core + collab), still cheap. |
| D5 | Indexes "by (labels), (author)" etc. | Indexed strings ≤ 63 chars; index key ≤ 255 bytes; array-membership indexing constrained; **100 docs/query max** | Index designs in data-contracts.md conform (hashes for long names, bounded label strings, cursor pagination everywhere). |
| D6 | — (not addressed) | No document push subscriptions on Platform | Relay subscribes to **blocks/ST stream and polls document queries**; web polls with cursors. |

## v3 contract-design refinements (consistency pass; see data-contracts.md)

- **Protected refs made enforceable**: `protectedPatterns` moved from the registry listing into an append-only, non-deletable, MAINTAIN-gated `config` doc type in the repo contract — protection is now evaluable as-of any past update's consensus time, and MAINTAIN collaborators (not just the listing owner) can manage settings. Consensus enforces the MAINTAIN spend on `protectedRefUpdate`; a normative client rule makes plain refUpdates against protected names inert.
- **Rewind attack closed**: `refUpdate`/`protectedRefUpdate`/`event`/`config` are **non-deletable** (a deletable ref tip let its author silently rewind a branch with nothing to audit). Refunds stay on the big-byte types (`chunk`/`packManifest`), whose **deletes are token-gated** — a frozen ex-collaborator can no longer delete their uploads (platform verifies `tokenCost` supports create/replace/delete/transfer).
- **Count trees assigned per user story** (platform `countable` index flag / `documentsCountable`): stars, followers, repos-per-owner, forks, issue/PR totals, per-target comment counts, chunk-presence audits. **Open/closed counts are deliberately not count-tree-backed**: state is an event fold because mutation ownership forbids an authoritative indexed state field; list pages fold per-page with an `in` query + IndexedDB cache.
- Discovery via repo-contract `keywords` (≤ 50, auto-mirrored to the system keyword-search contract); listing `topics` display-only (array fields are never indexed/queried — platform constraint).
- `imported {author, createdAt, url}` provenance fields on issue/patch/comment/review (consensus `$createdAt` can't carry original dates — needed by forge-import).
- PR object bytes always live in the contributor's fork contract (`patch.sourceContractId` + `patchManifestHash` point there); base repo never needs contributor uploads.

## Open questions inherited from INIT.md (kept, unresolved)

- Frozen-identity semantics: can a frozen collaborator still delete-for-refund their own docs? Should they? → Phase 0 token-ACL prototype answers empirically; needs Platform-core review.
- Repo-contract template ownership under DCG identity + cross-version migration path → Phase 1 design review agenda item (per INIT.md).
- diffs.com embedding vs diff2html/Monaco → read Pierre's "On Rendering Diffs" before web diff implementation.
