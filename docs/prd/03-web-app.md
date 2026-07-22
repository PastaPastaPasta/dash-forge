# PRD 03 — Forge Web (zero backend)

Static SPA deployable to IPFS or any static host, fully replacing github.com browsing and collaboration. Stack: Next.js static export (query-param routing, yappr rules), **wasm/evo-sdk for all Platform reads/writes**, and the zero-backend trick: **in-browser repo materialization** — isomorphic-git + lightning-fs in a web worker, cloning from chunk/CID fetches, never from a git server.

## Stack (reuse-first, per INIT.md)

| Concern | Choice |
|---|---|
| Platform I/O | wasm/evo-sdk (proof vs trusted mode per S0.3 benchmark) |
| Repo materialization | isomorphic-git + lightning-fs in a web worker; manifest offset-index-driven **lazy fetch** (only tree/blobs for current view); IndexedDB caching keyed by content hash |
| Highlighting | Shiki (lazy per-language) |
| Diffs | diffs.com embedding if licensing allows, else diff2html/Monaco diff — decision after reading Pierre's "On Rendering Diffs" |
| In-browser edits | CodeMirror 6: edit → commit → push via wasm identity signing |
| Markdown | unified/remark GitHub-flavored pipeline (sanitized) |
| Code search | Per-repo client-side index (MiniSearch or tantivy-wasm) built from materialized clone, cached in IndexedDB |
| Auth | platform-auth engine (key login, password vault, passkey PRF, wallet QR) |

## Routes (all static, query-param addressed)

`/` landing+discovery · `/repo` home (README, clone box, backend badge) · `/repo/tree` · `/repo/blob` (+ blame) · `/repo/commits` · `/repo/commit` (diff) · `/repo/branches` · `/repo/tags` · `/repo/issues` + `/repo/issue` · `/repo/pulls` + `/repo/pull` (diff, review) · `/repo/releases` · `/repo/settings` (backend, collaborator token UI, danger zone) · `/repo/search` · `/new` · `/u` (profile, repos, stars, follows) · `/login`, `/settings`.

## User stories (v1)

1. **Browse**: code/tree/blame/history, README rendering, file raw download — all verification-badged (proofs + hashes + source: platform/ipfs/s3).
2. **Issues**: list/filter (state, labels)/create/comment/close/reopen; label management (MAINTAIN); event timeline fold.
3. **PRs**: diff view, **inline review comments**, approve/request-changes, **merge from browser for fast-forward and clean merges** via isomorphic-git (conflicted merges → dgit); patch checkout instructions.
4. **Releases** with asset manifests (hash-verified downloads).
5. **Repo lifecycle**: create (contract instantiation + cost preview), settings, backend switch, delete (refund estimate).
6. **Collaborators**: token UI — grant (mint), suspend (freeze), revoke (freeze+destroy), balances-as-collaborator-list.
7. **Social**: stars, follows, profiles (DPNS + dicebear avatars).
8. **Edits in browser**: single-file edit → commit → push (WRITE-gated at consensus).
9. **CI status**: render `checkRun` docs per commit/PR (written by runner identities via relay-triggered CI).
10. **Search**: per-repo code search, client-side.

**v1 exclusions**: global cross-repo search, notifications inbox (poll-based new-activity badge only), Actions-equivalent, wikis, private repos.

## Performance honesty (INIT.md)

Cold-viewing a large repo requires materializing it in the browser. Mitigations: manifest-driven lazy fetch via per-object offset index; aggressive IndexedDB caching (immutable content, cache forever); size warning interstitial. **This will never match GitHub's server-rendered speed on 1 GB monorepos; target excellent UX ≤ 100 MB.**

Budgets: static bundle < 1.5 MiB gz pre-WASM; WASM lazy post-paint; warm-cache repo home < 1.5 s; cold 10 MiB repo < 8 s; COOP/COEP `credentialless` + CSP meta (yappr config).

## Cost & trust UX

- Every write shows DASH (primary) + USD (secondary) estimate pre-signing; running spend in settings.
- Verification chip row on every repo view (refs ✓ proof · packs ✓ sha256 · source); trust panel explains the chain.
- Insufficient credits → bridge.thepasta.org deep link.

## Acceptance (v1)

- **Lighthouse-decent SPA served from IPFS with no origin server**; request-interception test proves zero non-DAPI/non-backend origins.
- **Full review flow — comment on a line, request changes, re-review, merge — completes against mainnet.**
- Logged-out browse of a 100 MB repo acceptable (lazy fetch working); warm reload < 1.5 s.
- Collaborator granted via web token UI immediately pushes via CLI (cross-client conformance).
- axe-core: 0 serious violations; a11y ≥ 95.
