# PRD 03 — forge-web

The GitHub-class browser surface. **Pure static export** (Next.js 14 App Router, `output: 'export'`), hosted on GitHub Pages + IPFS snapshot; talks only to DAPI (WASM SDK) and external bundle URIs. yappr's architecture rules apply verbatim: no API routes, no SSR, no dynamic route segments — query-param routing.

## Routes (all static)

| Route | Purpose |
|---|---|
| `/` | Landing + global activity/discovery (recent repos via `byName` index, topics) |
| `/repo?owner=&name=` | Repo home: README render, tree, clone box (`dash://` + tier badge), stars |
| `/repo/tree?…&ref=&path=` | Directory listing |
| `/repo/blob?…&ref=&path=` | File view: syntax highlight, markdown render, images, raw download |
| `/repo/commits?…&ref=` | Commit log (paginated walk) |
| `/repo/commit?…&oid=` | Commit detail + diff |
| `/repo/branches`, `/repo/tags` | Ref lists w/ authorized-writer badges |
| `/repo/issues`, `/repo/issue?…&number=` | Issue list/detail/compose |
| `/repo/pulls`, `/repo/pull?…&number=` | PR list/detail (v1.1: diff/review/merge UI) |
| `/repo/settings` | Description/topics, storage tier, collaborators, danger zone (delete+refund) |
| `/new` | Create repository (cost preview per tier) |
| `/u?name=` | User/org profile: repos, stars, DPNS names |
| `/login`, `/settings` | Auth + app settings |

## Core capabilities

### Repo browsing pipeline (the hard part)
1. RefService (forge-core) resolves refs with proofs.
2. PackLoader fetches minimal pack set: newest consolidated pack first; verify sha256; store **immutable pack + built index in IndexedDB keyed by packHash** (cache forever; eviction LRU by repo).
3. isomorphic-git reads trees/blobs/commits from the IndexedDB pack store (custom backend implementing its fs/odb interface).
4. Progressive UX: refs and README (from newest pack) render first; deeper history hydrates on demand. Repos > 50 MiB show a "large repo" interstitial with size/cost of full browse.
- Diffs computed client-side (isomorphic-git walk + `diff` lib); syntax highlighting via Shiki (WASM, lazy-loaded per language).

### Collaboration
- Issues: list (state filter, ≤100-page cursors), detail with folded event timeline (EventFold), compose/edit/close/reopen/label — each action shows credit cost before signing.
- PRs v1: view metadata + cross-repo compare; v1.1: review threads anchored `(commitOid, path, line)`, approve/request-changes, maintainer merge flow (delegates actual merge to CLI in v1.1 web-only merge for FF cases).
- Stars, watch-poll refresh (30 s cursors), relative-time UI.

### Identity & auth
- platform-auth engine (vendored like yappr): private-key login, password vault, passkey PRF, wallet-QR. Session keys in platform-auth secure storage; signing prompts show operation + fee.
- Balance widget (credits + ≈DASH); "get credits" → bridge.thepasta.org deep link.
- Read-only mode with zero auth — everything browsable logged out.

### Trust UX
- Per-page verification indicator: refs proof-verified ✓, packs hash-verified ✓, availability source (platform / ipfs / https / s3 / mirror).
- Collaborator-list provenance visible ("granted by owner alice on <date>").

## Non-functional requirements
- Static bundle < 1.5 MiB gz before WASM; SDK WASM lazy-loaded post-paint; COOP/COEP `credentialless` + CSP meta (yappr `next.config.js`).
- Cold repo-home render (10 MiB repo, warm IPFS gateway) < 8 s; warm (IndexedDB hit) < 1.5 s.
- Works fully in Chromium/Firefox/Safari current−1; mobile-responsive.
- Accessibility: WCAG 2.1 AA on core flows; full keyboard nav (see style guide).
- Graceful DAPI degradation: retry/rotate nodes (evo-sdk built-in) + yappr reconnect pattern; offline shows cached repos read-only.

## Acceptance criteria (v1)
- Logged-out user browses a Tier X repo (tree, file, commit log, diff, README) with all verification badges green.
- Logged-in user creates a repo, uploads nothing (empty repo state renders), receives a push from CLI, sees new commits within one poll interval.
- Issue lifecycle end-to-end from web only (create→comment→label→close→reopen) between two identities.
- Collaborator granted in web settings can immediately push via CLI (shared authz vectors prove parity).
- Lighthouse: perf ≥ 80, a11y ≥ 95 on repo home.
