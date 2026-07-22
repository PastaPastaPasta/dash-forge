# Dash Forge — System Architecture

Follows `../INIT.md` (design path & PRDs); deviations forced by verified platform constraints are listed in [init-reconciliation.md](init-reconciliation.md).

## 1. Goals and non-goals

**Goals**
- Zero backend: Platform is the sole source of truth; every other component is a static asset, a local tool, or an *interchangeable, integrity-irrelevant* daemon anyone can run (relay).
- Trustless reads: refs/manifests proof-verified from Platform; content verified by SHA-256 + git OIDs. A third party can verify a full clone from Platform data alone.
- Real git: standard `git` (and jj's git backend) via a remote helper; `gh`-shaped CLI.
- Cost as first-class UX: estimates before every write batch, DASH primary / USD secondary, repack-with-refund keeps steady-state cost ≈ current repo size.
- Migration path: one-command GitHub import.

**Non-goals (v1)**: private repos (v2 encryption design in Phase 4), on-chain fast-forward/merge validation (reflog auditability instead — explicit INIT.md limit), Actions-equivalent (CI is external by design, bridged via relay), global cross-repo search, notifications inbox (poll badge only), wikis (`docs/` convention).

## 2. Components

```
                 ┌───────────────────────────────────────────────────────┐
                 │                    Dash Platform                      │
                 │  registry contract     repo contract (per repo,       │
                 │  (repoListing, profile, │ from versioned template):   │
                 │   star, follow)         │ refUpdate, protectedRefUpdate,
                 │                         │ packManifest, manifestPart, │
                 │                         │ chunk, issue, comment, patch,
                 │                         │ review, release, label,     │
                 │                         │ checkRun, webhook, event    │
                 │                         │ + WRITE / MAINTAIN tokens   │
                 └────────▲───────────────▲───────────────▲──────────────┘
                          │ DAPI (proofs) │               │ block/ST stream
      ┌───────────────────┴───┐   ┌───────┴────────┐  ┌───┴───────────────┐
      │  forge-core (Rust lib)│   │  forge-web (TS)│  │ forge-relay (Rust │
      │  rs-sdk · chunker ·   │   │  wasm/evo-sdk  │  │ daemon, anyone    │
      │  manifests · backends │   │  isomorphic-git│  │ runs) → webhooks, │
      │  cost engine · authz  │   │  in worker     │  │ notifications, CI │
      └───▲────────▲──────▲───┘   └────────────────┘  └───────────────────┘
          │        │      │                                    ▲
   ┌──────┴───┐ ┌──┴───┐ ┌┴────────────┐                       │
   │git-remote│ │ dg │ │forge-import │            external backends
   │  -dash   │ │ (gh  │ │(GitHub      │        IPFS │ S3 │ HTTPS (fee
   │ (helper) │ │ repl)│ │ migrator)   │        reduction / archival;
   └──────────┘ └──────┘ └─────────────┘        hash-verified caches)
```

- **One Rust workspace** (`forge-core` lib + `git-remote-dash`, `dg`, `forge-relay`, `forge-import` binaries), sharing rs-sdk/rs-dpp with Platform itself. Radicle's remote helper is the reference implementation for the helper protocol.
- **forge-web** is TypeScript (wasm/evo-sdk) — the one place logic is duplicated; parity held by shared conformance vectors (§7).

## 3. Naming & resolution

`dash://alice/project` → DPNS name → identity → registry `repoListing` by unique `(ownerId, normalizedName)` → repo contract ID → repo-contract `config` (defaultBranch, backend descriptor, protected patterns). Direct identity-ID form supported. Web routes use query params (static export).

## 4. On-chain model (summary — full schemas in [data-contracts.md](contracts/data-contracts.md))

### 4.1 Registry contract (deployed once; DCG/DAO-owned identity)
Discovery + social graph only: `repoListing` (name, repoContractId, description, topics, forkOf; indexed owner+name and name; count-trees for repo/fork counts), `profile`, `star`, `follow` (count-trees for stars/followers). Operational settings live in the repo contract so MAINTAIN collaborators can change them.

### 4.2 Repo contract (per repository, from canonical template)
- **Settings**: `config` — append-only, non-deletable, MAINTAIN-gated (defaultBranch, protected-ref patterns, backend descriptor). Append-only history makes protection evaluable *as-of any past update*.
- **Git data**: append-only, **non-deletable** `refUpdate` (ref name-hash, old/new OID, force flag — ref state *and* reflog; reconciliation D2) and `protectedRefUpdate` (MAINTAIN-gated); `packManifest` (pack SHA-256, size, chunk count, external URIs, supersedes list, per-object offset index with `manifestPart` continuation docs), `chunk` (seq + 3 × ~4.9 KiB byte fields; count-tree gives O(1) availability audits).
- **Collaboration**: `issue`, `comment`, `patch` (PR), `review`, `release`, `label`, `event` (close/reopen/merge/label/assign audit log — non-deletable), `checkRun` (CI results written by runner identities), `webhook` (relay subscription, secret encrypted to relay identity). Count-trees on issue/patch totals and per-target comment counts; open/closed splits are event folds (see data-contracts §3).

### 4.3 Token ACL (the authorization system)
- Tokens at position 0 (`WRITE`) and 1 (`MAINTAIN`), mintable/freezable by the contract owner, with **control-rule groups** so org admin powers can be held by multiple identities.
- `tokenCost` on write-path types: `refUpdate`, `chunk`, `packManifest`/`manifestPart`, `checkRun` → 1 WRITE; `protectedRefUpdate`, `release`, `label`, `webhook`, `config` → 1 MAINTAIN. Social types (`issue`, `comment`, `review`, `patch`) are un-gated — platform fees are the spam floor (patch gating: open question D3). Contract updates (template migrations) are **owner/control-group only** — Platform does not token-gate `DataContractUpdate`.
- Tokens carry `baseSupply: 10⁹` credited to the owner atomically at contract creation — no self-mint bootstrap step exists to forget.
- Grant = mint 10⁹ units (spend is a meter, not the control); suspend = freeze; revoke = freeze + destroy frozen funds. Balances publicly queryable → **the collaborator list is on-chain for free**.
- **Delete-gating**: `tokenCost` also applies to `delete` on chunks/manifests/releases — a frozen identity cannot yank the availability of what it previously uploaded. Ref/event/config docs are non-deletable outright (rewind-proof audit trail).
- Because creation is consensus-gated, clients resolve refs by *newest refUpdate per name* — no client-side authorization judgment needed (a frozen identity's push fails at consensus; INIT.md acceptance test). Protected refs add one client rule: updates to a pattern-matched ref only count if they are MAINTAIN-gated `protectedRefUpdate` docs, evaluated as-of each update's consensus time against the append-only config history (normative algorithm in data-contracts §4).

## 5. Storage model

**Platform is primary storage** and always holds refs + manifests. The backend descriptor (in the repo contract's `config`) selects where **pack bytes** live:

| Backend | Pack bytes | Cost profile | Trust |
|---|---|---|---|
| `platform` (default) | `chunk` docs, ~14.4 KiB payload each (3 × 4.8 KiB fields), one ST per chunk | ~0.283 DASH/MiB (~$9/MiB @ $34), **refundable**; repack+delete reclaims superseded storage | Fully on-chain |
| `ipfs` | CID in manifest; pin via Storacha/Pinata/self-host Kubo | Pinning costs only | Hash-verified cache |
| `s3` / `https` | URL in manifest | Hosting costs only | Hash-verified cache |
| **mixed** | Recent packs on Platform, archival packs external | Best of both | — |

- Pack = unit of storage. Pushes are thin *on the wire*, but the pipeline runs `index-pack --fix-thin` locally before storing — **stored packs are always self-contained** (what every real git server does on receive; raw thin packs have cross-pack delta bases and cannot serve random access). O(bytes/14 KiB) STs, not O(objects).
- Partial/shallow clone & single-object reads: the merged `objectLocator` (§6.3) → ranged `chunk` fetch by seq (or HTTP Range on external backends); per-pack offset indexes only bridge packs pushed since the last repack.
- **Repack/GC** (`dg repack`): rewrite history into one optimized pack, upload, delete superseded chunk/manifest docs → storage refund. Long-lived repo cost ≈ current size, not cumulative pushes.
- Availability for external backends: multiple URIs per manifest + anyone-can-reseed (`packMirror`-style additional-URI docs, `dg reseed`); loss is availability-only, never integrity, and any clone can restore.

## 6. Data flow

### Push (`git push dash://alice/project main`)
1. Helper resolves listing → repo contract; reads refs (proof-verified); computes thin pack, then **completes it locally via `index-pack --fix-thin`** so the stored pack is self-contained.
2. **Cost estimate displayed; prompt above configurable threshold** (`dash.costWarnThreshold`).
3. Upload pack per backend (chunk STs pipelined with sequential nonces — batch=1 constraint, see D1); journal file records uploaded chunk IDs → **interrupted push resumes without re-paying**.
4. Write `packManifest` (+ mandatory per-pack offset index), then `refUpdate` per ref (prevOid for force detection; non-FF refused without `+`).
5. All STs via idempotent write engine (sign → persist bytes → broadcast → wait → rebroadcast same bytes on timeout).
6. **Post-push verification**: re-read ref state — Platform has no CAS, so a concurrent same-prevOid push by another maintainer also lands; the helper reports a lost race as a late non-fast-forward instead of silently orphaning commits (divergence rules: data-contracts §2.3).

### Clone/fetch
Resolve listing → refs → collect non-superseded manifests covering want-set → fetch chunks (DAPI) or CID/URL (external) → SHA-256-verify reassembled pack → `git index-pack`. Shallow/partial via the `objectLocator`. Local git odb is the cache (helper never re-fetches objects git has).

### Web browse (no clone) — the browse plane
Browsing never materializes the repo. Two auxiliary **browse artifacts** (stored/transported exactly like packs — content-addressed, chunked or external, supersedable with refunds; `packManifest.kind` distinguishes them) make every view a handful of small ranged reads:

- **`objectLocator`** — a merged multi-pack index (git MIDX analog): fanout header + oid-sorted entries of `(oid → pack, offset, length, deltaChainSpan)`. ~26 B/object; the fanout means a lookup fetches the header plus one ~1/256 slice by HTTP Range / chunk seq. `deltaChainSpan` covers the object's whole delta window so one contiguous ranged read yields the blob and its bases. Published at repack; between repacks, readers consult the newest locator plus the (few) per-pack offset indexes of packs pushed since.
- **`flatIndex`** — the tip's complete recursive file listing (`path → oid, mode, size`, path-sorted, compressed), i.e. GitHub's tree API as one static artifact. Tens-to-hundreds of KB even for large repos. Gives instant tree navigation at any depth *and* client-side filename search with zero object fetches. Published on default-branch pushes, batched for hyperactive repos (every 20 pushes / 24 h); readers overlay the ≤ 20 commits since the indexed tip via locator tree-diffs, so views are always current without a full walk. Other refs fall back to object walking.

Resulting cold-load path for a repo of *any* size: refs + config (KB) → flatIndex (tens of KB) → README blob via locator ranged read (KB) — **3–5 requests, O(view) bytes, independent of repo size**. Blob view = one locator lookup + one ranged read; directory = zero extra fetches (flatIndex); commit log = commit objects via locator (tiny), optional commit-graph artifact later; historical/other-ref trees = locator-driven object walk (commit → trees → blobs, ~KB per hop). Full materialization (isomorphic-git in a worker, IndexedDB pack store) remains, but only for the features that genuinely need it: content search, blame, in-browser merge/edit. Excellent-UX target ≤ 100 MB now applies to *those* features, not to browsing.

### Liveness
No document subscriptions → web/CLI poll indexed queries with cursors; **relay** subscribes to the block/ST firehose and translates to push-style webhooks for CI/notifications (PRD 05).

## 7. Cross-client parity

Ref-resolution, event-folding, and cost-estimation rules are versioned (`FORGE_RULES_V1`) with **shared conformance vectors** (JSON fixtures) consumed by the Rust workspace tests and forge-web tests alike — the only defense against Rust/TS divergence.

## 8. Economics (full model: [economics.md](economics.md))

- 27,000 credits/byte permanent storage (refundable, 50-era amortization); 1 DASH = 10¹¹ credits.
- On-Platform data ≈ **$9/MiB @ $34/DASH** (DASH-primary display; USD secondary; fee-multiplier governance lever flagged).
- Social artifacts are noise (2 KiB issue ≈ 2¢). Ref update ≈ 0.00008 DASH. Contract instantiation per repo < 0.01 DASH.
- Cost engine (forge-core) quotes every write batch pre-broadcast and tracks running spend (`dg cost`, web settings).

## 9. Security & trust

- Writes need AUTHENTICATION keys at HIGH; identity keys via keychain/agent (SSH-key UX shape). CI runners get their own identity holding WRITE tokens (optionally ContractBounds-scoped).
- Proof verification default-on in helper/CLI; web benchmarks trusted vs proof mode (S0.3).
- Relay is availability-only: payload consumers (CI) re-fetch and verify from Platform; webhook secrets encrypted to relay identity; instances interchangeable.
- Markdown/filename rendering sanitized (XSS), CSP per yappr static-export pattern.
- Top risks + open questions: see implementation plan risk register and init-reconciliation open questions (frozen-identity refunds, template migration, ST throughput).

## 10. Technology choices

| Layer | Choice | Rationale |
|---|---|---|
| Helper/CLI/relay/import | **Rust** workspace on rs-sdk/rs-dpp | Shares code with Platform; Radicle helper reference; single-binary distribution |
| Web | Next.js static export + wasm/evo-sdk + isomorphic-git/lightning-fs in worker | yappr-proven zero-backend stack; in-browser materialization is the zero-backend trick |
| Highlighting/diff/edit | Shiki · diff2html-or-Monaco (pending research, D-open) · CodeMirror 6 | INIT.md stack |
| Search | MiniSearch (or tantivy-wasm) per-repo index in IndexedDB | Client-side, no server |
| Auth (web) | platform-auth engine (yappr vendored) | Key/password-vault/passkey/QR for free |
| Import | Forgejo migration-layer semantics over GitHub REST/GraphQL | Most battle-hardened importer |
