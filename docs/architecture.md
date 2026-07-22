# Dash Forge — System Architecture

## 1. Goals and non-goals

**Goals**
- Zero backend: every component is either a static asset, a local tool, or the Dash Platform network itself. Nothing Forge-specific runs on a server we operate.
- Trustless reads: any client can verify everything it displays — refs and metadata via Platform proofs, git content via content addressing (object hashes verify against signed refs/manifests).
- Real git: standard `git` works via a remote helper; no bespoke VCS.
- Cost-tiered storage: full on-platform storage for maximum decentralization; external bundle hosting (IPFS/S3/HTTPS/mirror git remotes) for reduced fees, verified by hash.
- GitHub-class collaboration: issues, pull requests, reviews, releases — all as Platform documents.

**Non-goals (v1)**
- Private repositories (requires an encryption layer; design leaves room, ships later).
- Server-side CI/webhooks (nothing to run them on; later: watcher daemons run by users).
- Git wire-protocol compatibility for third-party clients (we own the remote helper).
- SHA-256 git repos (schema supports 32-byte OIDs; tooling targets SHA-1 first).

## 2. Component map

```
                        ┌────────────────────────────────────────────┐
                        │              Dash Platform                 │
                        │  forge-core-contract   forge-collab-contract│
                        │  (repos, refs, packs,  (issues, PRs, comments,
                        │   bundles, collaborators)  events, stars, releases)
                        └──────▲──────────────▲──────────────────────┘
                               │ DAPI (gRPC-web / WASM SDK, proofs)
        ┌──────────────────────┴──────┐   ┌───┴────────────────────────┐
        │        forge-core (TS lib)  │   │   External bundle storage  │
        │  contract services · codec  │◄──┤  IPFS │ S3 │ HTTPS │ git   │
        │  chunker · storage adapters │   │  (content-hash verified)   │
        │  authz resolver · signing   │   └────────────────────────────┘
        └───▲──────────▲──────────▲───┘
            │          │          │
   ┌────────┴───┐ ┌────┴─────┐ ┌──┴─────────┐
   │ forge-web  │ │ forge-cli│ │ git-remote-│
   │ (static    │ │ (dforge) │ │ dash       │
   │  Next.js)  │ │          │ │ (helper)   │
   └────────────┘ └──────────┘ └────────────┘
```

- **forge-core** is the single shared implementation. Browser and Node both consume it; `git-remote-dash` and `dforge` are thin shells over it. This mirrors yappr's `lib/services/` layer but packaged as a standalone library.
- **Two data contracts** (split to stay under the 16 KiB contract-size estimate and to let collaboration evolve independently of the storage-critical core): see [data-contracts.md](contracts/data-contracts.md).

## 3. Naming & identity

- Users/orgs are **Dash Platform identities**; human names via **DPNS** (`alice.dash`).
- Repo URL scheme: `dash://<name-or-identity-id>/<repo-name>` (e.g. `dash://alice/myrepo`, `dash://H7…base58…/myrepo`). Resolution: DPNS name → identity ID → `repository` document by unique index `(ownerId, normalizedName)`.
- `normalizedName`: lowercased, `[a-z0-9._-]{1,63}` (indexable-string bound), unique per owner.
- Web routes use query params (static export, no dynamic segments — yappr rule): `/repo?owner=alice&name=myrepo&path=src/main.rs`.

## 4. Storage model

### 4.1 The two tiers

Git object data is transported and stored as **packfiles** in both tiers. A push produces a thin pack; the pack is the unit of storage. Tier choice is per-repository (`repository.storageMode`), changeable over time, and mixable (platform for refs/metadata always; packs wherever configured).

**Tier P — Platform-native ("full decentralization", premium price)**
- Each pack is split into `packChunk` documents: 3 × 5,120-byte data fields ≈ 15 KiB payload per document, one document per state transition.
- A `pack` manifest document records: packHash (sha256), chunk count, byte size, object count, the pack's `.idx` bytes (chunked alongside if > inline capacity), and prerequisite commit OIDs (thin-pack bases).
- Cost: ~0.283 DASH/MiB (refundable). A 5 MiB repo ≈ 1.4 DASH prepaid, ~350 documents.
- Reads: query chunks by `(repoId, packHash, chunkIdx)`, reassemble, verify sha256, index locally.

**Tier X — External bundles ("reduced fees", default)**
- The same packs (or full `git bundle`s) are uploaded to one or more external providers; the on-platform `pack` document stores the sha256 plus a list of URIs (`ipfs://CID`, `https://…`, `s3://…`, `gitmirror://<remote-url>` for packs fetchable from a mirror git host).
- Platform stores only manifests (~hundreds of bytes per pack). Cost per push: ~0.0001–0.001 DASH.
- Reads: download from any listed URI (or any gateway/mirror), verify sha256 against the signed manifest → trustless even from untrusted hosts. Multiple URIs give redundancy; anyone can re-seed and (if a collaborator) append additional URIs via a new manifest revision or `packMirror` doc.

**Why packs, not loose objects, on-platform:** one document write per state transition makes per-object storage O(objects) transitions (a 1,000-object push = 1,000+ sequential fee-bearing round-trips). Packs make it O(bytes/15 KiB), preserve git's delta compression (typically 3–10× smaller), and match git's native transport. The trade-off — no random single-object reads — is absorbed by client-side pack indexing and IndexedDB/disk caching (§6).

### 4.2 Repacking & garbage collection

- Packs accumulate per push (like git's own `.pack` files). Any collaborator may periodically **repack**: build one consolidated pack of all reachable objects, store it (either tier), then delete their own superseded `pack`/`packChunk` docs (owner-delete only → each maintainer prunes what they wrote; storage refunds make this profitable).
- A `pack` manifest carries `supersedes: [packHash…]` so readers prefer consolidated packs and can ignore (not require) superseded ones.
- Force-push/branch deletion never deletes objects immediately; unreachable objects disappear at the next repack. (Matches git semantics.)

### 4.3 Large files

No LFS special-casing in v1: Tier X bundles already externalize bulk. A later `forge-lfs` extension can store per-file external pointers using the same manifest+hash pattern.

## 5. Authorization model (the crux)

Platform enforces only *document ownership* — no per-document ACLs. Forge therefore uses **owner-anchored, client-resolved authorization**:

1. The `repository` document's owner is the **repo owner** (root of trust for that repo).
2. The owner maintains `collaborator` documents (owned by the repo owner, hence only the owner can grant/revoke): `(repoId, memberId, role, active)`. Roles: `WRITE` (push, manage PRs/issues), `MAINTAIN` (+ manage collaborators is owner-only in v1), future `TRIAGE`.
3. **All multi-writer state is append-only**:
   - Refs: `refUpdate` documents (create-only). The current value of a ref = the newest `refUpdate` for `(repoId, refNameHash)` **whose author was authorized at that time** (owner or active collaborator). Clients evaluate this rule identically → deterministic view. Unauthorized writes are simply ignored (and cost the spammer money).
   - PR/issue state: `event` documents (close/reopen/merge/label) filtered the same way.
4. Verification chain for a clone: Platform proof → `repository` doc (owner-signed) → `collaborator` docs (owner-signed) → newest authorized `refUpdate` (collaborator-signed) → commit OID → pack manifests (hash) → objects (git hashes). Every link is either a Platform proof or a content hash.

Notes:
- Revocation: a collaborator's `refUpdate`s made *before* revocation remain valid (timestamps are consensus `$createdAt`). After revocation their new updates are ignored.
- Spam in open-creation contracts (anyone can write an `issue` doc against any repo): platform fees are the base deterrent; clients additionally filter by simple policies (hide non-collaborator events that mutate state; issues/comments from arbitrary identities are the *point* of open collaboration and are shown, with block/mute lists as a later feature).
- v2 option: per-repo derived contracts with `creationRestrictionMode` for stricter control, or embedded-token write-gating (yappr's `tokenCost` pattern) for spam pricing.

## 6. Client data flow

### 6.1 Push (`git push dash://alice/myrepo main`)

1. Remote helper resolves repo, fetches current refs (proof-verified), runs `git pack-objects --thin` for the delta between remote refs and local.
2. Upload pack per repo's tier: Tier X → storage adapter upload (returns URIs) → write `pack` manifest doc. Tier P → write `packChunk` docs then `pack` manifest.
3. Write one `refUpdate` doc per updated ref (new OID, old OID for CAS-style conflict detection by readers).
4. All writes: yappr idempotent pattern (sign → persist ST bytes → broadcast → wait → retry same bytes). Sequential nonces; **pipelining** (broadcast n, n+1… before awaiting) is the throughput lever for Tier P — validated in Phase 0 spikes.
5. Non-fast-forward detection: helper compares fetched ref OID with `refUpdate.prevOid`; refuses without `--force` (client-enforced, like git itself over dumb transports).

### 6.2 Clone/fetch

1. Resolve repo → refs (newest authorized `refUpdate` per ref).
2. Collect `pack` manifests (newest-first, skipping superseded); determine which packs are needed to cover want-set (manifests list `tips`/object counts; naive v1: fetch all non-superseded packs — correct, then optimize with commit-frontier metadata).
3. Fetch pack bytes (adapter per URI, failover across URIs), verify sha256, hand to git (`git index-pack`/`unpack-objects`) or isomorphic-git in browser.
4. Cache: CLI relies on the local git object store; web caches packs + indices in IndexedDB keyed by packHash (immutable → cache forever).

### 6.3 Browsing (web, no clone)

forge-web reads refs, loads the minimal set of packs, and serves tree/blob/commit views from its IndexedDB pack store via isomorphic-git. For big repos, "shallow browse" fetches only the newest consolidated pack; deeper history loads packs on demand.

### 6.4 Liveness

No push subscriptions on Platform → polling with `$updatedAt`/`$createdAt` cursors (15–60 s in web UI, on-demand in CLI). All polls are cheap indexed queries with ≤100-doc pages.

## 7. Collaboration model

- **Issues**: `issue` docs (anyone), `comment` docs, append-only `event` docs for state/labels. Issue numbers: optimistic sequential `number` with unique index `(repoId, number)` — on conflict, retry with next number; display falls back to short doc-id if ever needed.
- **Pull requests**: cross-repo by construction (fork = separate repo sharing history). A `pullRequest` doc names base repo/ref and source repo/ref + head OID. The PR's objects come from the *source* repo's packs (fork inherits base objects via `forkOf` chain — clients read parent packs for shared history, fork packs for new commits). Merge: a maintainer merges locally (helper fetches source), pushes the merge commit to base, emits a `merged` event. Review comments anchor to `(commitOid, path, line)`.
- **Forks**: `repository.forkOf` → parent repoId. Fork stores only packs for objects not in the parent chain. (Client walks the chain for reads; depth-capped.)
- **Releases**: `release` doc (tag, notes, asset manifests with URIs + sha256 — same external-storage pattern).
- **Stars/watches**: one doc per (user, repo), unique index; counts via count-tree queries.

## 8. Economics summary

| Action | Tier X (default) | Tier P |
|---|---|---|
| Create repo (repo doc + first refs) | < 0.001 DASH | < 0.001 DASH |
| Push (manifest + 1–2 refUpdates) | ~0.0002 DASH + external hosting | + 0.283 DASH/MiB of pack (refundable) |
| Issue / comment / event | ~0.0001–0.0005 DASH each | same |
| Delete repo | refunds storage of all owned docs | refunds ~all pack storage |

Contract registration (one-time, deployer): < 0.01 DASH each. Users pay their own writes from identity credits (topped up via bridge). Reads are free.

## 9. Security & trust considerations

- **Key model**: writes require AUTHENTICATION keys at HIGH (routine) — CRITICAL reserved for identity ops; ContractBounds-scoped keys recommended for CI/automation ("deploy keys").
- **Proof verification**: web/CLI default to proof-verifying SDK mode (`EvoSDK.testnet()`/`mainnet()`); trusted mode only as an explicit perf opt-in (yappr uses trusted; Forge's integrity claims argue for proofs — benchmark in Phase 0, config flag either way).
- **External storage is untrusted by design** — availability risk only, never integrity risk. Mitigation: multi-URI manifests, anyone-can-reseed, Tier P fallback for the paranoid.
- **Deletion/censorship**: manifests and refs are on Platform (censorship-resistant). A Tier X host dropping data = availability loss until re-seeded from any clone (`dforge reseed` re-uploads local packs and posts new URIs).
- **Name squatting**: repo names are per-identity, so no global squat surface; DPNS handles identity naming with its own auction rules.
- **Client-side auth resolution risks**: all clients must implement the same resolution rules → the rules live in forge-core with a versioned spec + shared test vectors (see e2e plan).

## 10. Technology choices

| Layer | Choice | Rationale |
|---|---|---|
| Platform SDK | `@dashevo/evo-sdk` (^4.x) | Modern, proof-capable, browser+Node, proven in yappr |
| Language | TypeScript everywhere (strict, no `any`) | One shared core; yappr conventions |
| Git internals (browser) | isomorphic-git + custom thin layer for pack assembly | Pure-JS pack read/index in browser |
| Git internals (CLI) | Real `git` via remote-helper protocol; helper in Node ≥18 | Zero reimplementation of porcelain |
| Web | Next.js 14 App Router, static export, Tailwind, Zustand, Radix | yappr-proven zero-backend stack |
| Auth | `platform-auth` (vendored/published engine from yappr) | Key login, password vault, passkey PRF, wallet QR — for free |
| External storage | Adapter interface; v1 providers: IPFS (Storacha, Pinata, self-host), S3-compatible, plain HTTPS (read-only), git mirror | Matches yappr `lib/upload/` provider registry pattern |
| Packaging | pnpm/yarn monorepo: `packages/{forge-core,forge-contracts,git-remote-dash,forge-cli,forge-web}` | Shared types, atomic changes |
| Hosting (web) | GitHub Pages + IPFS snapshot | Static, decentralizable |
