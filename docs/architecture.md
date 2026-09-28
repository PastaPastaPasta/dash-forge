# Dash Forge — System Architecture

Follows `../INIT.md` (design path & PRDs); deviations forced by verified platform constraints are listed in [init-reconciliation.md](init-reconciliation.md).

The on-chain model is **forge-v2**: two shared contracts, forge-core and forge-collab, in one Platform protocol 14 contract group. The full specification is [contracts/forge-v2.md](contracts/forge-v2.md). (forge-v1, a global registry contract plus one contract per repository with token access control, was removed on 2026-09-26 with no backwards compatibility.)

## 1. Goals and non-goals

**Goals**
- Zero backend: Platform is the sole source of truth; every other component is a static asset, a local tool, or an *interchangeable, integrity-irrelevant* daemon anyone can run (relay).
- Trustless reads: refs/manifests proof-verified from Platform; content verified by SHA-256 + git OIDs. A third party can verify a full clone from Platform data alone.
- Real git: standard `git` (and jj's git backend) via a remote helper; `gh`-shaped CLI.
- Cost as first-class UX: estimates before every write batch, DASH primary / USD secondary; a repository costs ~0.001 DASH to create, and bulky pack bytes can live in storage the user brings.
- Migration path: one-command GitHub import.

**Non-goals (first release)**: private repos (Phase 3 design: [security/private-repos.md](security/private-repos.md)), on-chain fast-forward/merge validation (reflog auditability instead — explicit INIT.md limit), Actions-equivalent (CI is external by design, bridged via relay), global cross-repo search, notifications inbox (poll badge only), wikis (`docs/` convention).

## 2. Components

```
                 ┌───────────────────────────────────────────────────────┐
                 │          Dash Platform (contract group dash-forge)    │
                 │  forge-core contract     │ forge-collab contract      │
                 │  repo, maintainer,       │ issue, patch, comment,     │
                 │  writer, config,         │ review, event, authorEvent,│
                 │  refUpdate,              │ checkRun, webhook,         │
                 │  protectedRefUpdate,     │ profile, star, follow      │
                 │  packManifest,           │                            │
                 │  manifestPart, chunk,    │ all keyed by repoId;       │
                 │  release, label, repoKey │ writes gated by membership │
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

`dash://<owner>/<name>` → owner identity (base58 id; DPNS names are a later addition) → forge-core `repo` by unique `($ownerId, name)` → `repoId` → newest `config` for that `repoId` (defaultBranch, backend descriptor, protected patterns). `dash://<repoId>` names a `repo` document directly. Contract ids come only from `forge-contracts/deployments/<network>.json` (`v2` section); a network without a forge-v2 deployment fails with "not deployed" and never falls back to another network. Web routes use query params (static export).

## 4. On-chain model (summary — full schemas and rules in [contracts/forge-v2.md](contracts/forge-v2.md))

### 4.1 Contract topology
Two shared contracts, registered once per network by one deployer identity and joined by a protocol 14 **contract group** (`dash-forge`). Every repository is a set of documents in them, keyed by the `repo` document's id (`repoId`). Creating a repository writes three documents: `repo`, the owner's `maintainer` membership, and the first `config`.

- **forge-core**: `repo` (the listing; `name` immutable, unique per owner), membership (`maintainer`, `writer`), **settings** (`config`: append-only, non-deletable, maintainer-gated; append-only history makes protection evaluable *as-of any past update*), **git data** (`refUpdate`, `protectedRefUpdate`, `packManifest`, `manifestPart`, `chunk`: all non-deletable), `release`, `label`, and `repoKey` (private repositories).
- **forge-collab**: `issue`, `patch` (PR), `comment`, `review`, `event` (member actions: close, reopen, merge, label, assign, ...), `authorEvent` (the target's author: close and reopen only), `checkRun` (CI results written by runner identities), `webhook` (relay subscription, secret encrypted to the relay identity), and the social graph (`profile`, `star`, `follow`). Open/closed state is a fold over `event` + `authorEvent`.

### 4.2 Membership gates (the authorization system)
- Access is **membership documents** in forge-core: `maintainer` and `writer`, unique per `(repoId, memberId)`, created only by the repo owner (`dg collab add <owner/name> <member> --role writer|maintainer`, `dg collab remove`, `dg collab list`). The membership list is on-chain and publicly queryable.
- Each gated type declares an `ownerRefersTo` rule that consensus checks on create: `refUpdate`, `packManifest`, `manifestPart`, `chunk`, `label`, `event`, `checkRun` need a maintainer or writer document; `protectedRefUpdate`, `config`, `release`, `webhook`, `repoKey` need a maintainer document. `issue`, `patch`, `comment`, `review` are un-gated; platform fees are the spam floor.
- **Revoke = delete the membership document.** The member's next gated write is refused at consensus (Platform error 40120). Past documents stay valid: a document's existence proves its writer was authorized at its block time.
- **Non-deletable audit types** (`refUpdate`, `protectedRefUpdate`, `config`, `packManifest`, `manifestPart`, `chunk`, `event`, `authorEvent`, `issue`, `patch`, `repo`, `repoKey`): Platform never reference-checks a delete, so these types forbid deletion outright, which makes branch rewinds and yanking packs others depend on impossible.
- Because creation is consensus-gated, clients resolve refs by *newest refUpdate per name*, with no client-side authorization judgment (a revoked or never-member identity's push fails at consensus; INIT.md acceptance test). Protected refs add one client rule: updates to a pattern-matched ref only count if they are maintainer-gated `protectedRefUpdate` docs, evaluated as-of each update's consensus time against the append-only config history.
- Contract updates are owner-only and cannot loosen an existing gate (protocol 14 freezes indexes and `ownerRefersTo` on update).

## 5. Storage model

**Platform is primary storage** and always holds refs + manifests. The backend descriptor (in the repo's `config`) selects where **pack bytes** live:

| Backend | Pack bytes | Cost profile | Trust |
|---|---|---|---|
| `platform` (default) | `chunk` docs, ~14.4 KiB payload each (3 × 4.8 KiB fields), one ST per chunk | ~0.33 DASH/MiB (~$10/MiB @ $30; [costs.md](guides/costs.md)), **permanent**: `chunk` and `packManifest` are non-deletable, so the deposit is never refunded | Fully on-chain |
| `ipfs` | CID in manifest; pin via Storacha/Pinata/self-host Kubo | Pinning costs only | Hash-verified cache |
| `s3` / `https` | URL in manifest | Hosting costs only | Hash-verified cache |
| **mixed** | Recent packs on Platform, archival packs external | Best of both | — |

- Pack = unit of storage. **Stored packs are always self-contained and locator-quality**: every delta base is inside the pack, ahead of the deltas that use it, and the producer refuses anything else. Storing the `index-pack --fix-thin` pack directly does not qualify — completion appends the bases after the deltas — so a push builds two candidates (the delta packed non-thin; the completed pack re-emitted bases-first) and stores the smaller; neither dominates (`economics.md`). O(bytes/14 KiB) STs, not O(objects).
- Partial clone & single-object reads: the merged `objectLocator` (§6.3) → ranged `chunk` fetch by seq (or HTTP Range on external backends); packs pushed since the last repack are covered by their own index fragments. The one-contiguous-span read is sound for **blobs** (OFS_DELTA bases sit earlier in the same pack after repack); **trees need the per-base delta-chain fallback** (a single span over-fetches them catastrophically — §6.3). **Shallow clone (`--depth`) is out of scope** — a fetch/push helper gives git no reply channel to serve depth negotiation (S0.9); partial clone (`--filter=blob:none` + `.promisor` markers) is the supported subsetting path, and `--depth` fails loudly.
- **Repack** (`dg repack`): rewrite history into one optimized pack and upload it as a superseding pack. On the Platform tier this only consolidates (fewer packs to read); it deletes nothing, because the old chunks and manifests are non-deletable. Garbage collection applies only to external storage the user controls.
- Availability for external backends: multiple URIs per manifest + anyone-can-reseed (`packMirror`-style additional-URI docs, `dg reseed`); loss is availability-only, never integrity, and any clone can restore.

## 6. Data flow

### Push (`git push dash://alice/project main`)
1. Helper resolves `repo` → `repoId`; reads refs (proof-verified); builds **one self-contained, locator-quality pack** over the push delta.
2. **Cost estimate displayed; prompt above configurable threshold** (`dash.costWarnThreshold`).
3. Upload pack per backend (chunk STs pipelined with sequential nonces — batch=1 constraint, see D1); journal file records uploaded chunk IDs → **interrupted push resumes without re-paying**.
4. Write `packManifest`, then the pack's **browse-index fragment** (§6.3) — best-effort, since the pack is already stored and paid for, and a repo whose index is behind still clones, fetches and pushes. Then `refUpdate` per ref (prevOid for force detection; non-FF refused without `+`).
5. All STs via idempotent write engine (sign → persist bytes → broadcast → wait → rebroadcast same bytes on timeout).
6. **Post-push verification**: re-read ref state — Platform has no CAS, so a concurrent same-prevOid push by another maintainer also lands; the helper reports a lost race as a late non-fast-forward instead of silently orphaning commits (divergence rules: data-contracts §2.3).

### Clone/fetch
Resolve `repo` → refs → collect non-superseded manifests covering want-set → fetch chunks (DAPI) or CID/URL (external) → SHA-256-verify reassembled pack → `git index-pack`. **Partial clone** via the `objectLocator` (bare-OID fetches + `.promisor` markers); **shallow clone is unsupported** — the helper has no reply channel for git's depth negotiation (S0.9), so `--depth` fails loudly. Local git odb is the cache (helper never re-fetches objects git has).

### Web browse (no clone) — the browse plane
Browsing never materializes the repo. Two auxiliary **browse artifacts** (stored/transported exactly like packs — content-addressed, chunked or external, supersedable; `packManifest.kind` distinguishes them) make every view a handful of small ranged reads:

- **`objectLocator`** — a merged multi-pack index (git MIDX analog): fanout header + oid-sorted entries of `(oid → pack, offset, length, deltaChainSpan, deltaHint)`. ~34–36 B/object (S0.5-corrected widths: `deltaChainSpan` 4-byte varint, `length` 4 B — see data-contracts §2.3); the fanout means a lookup fetches the header plus one ~1/256 slice by HTTP Range / chunk seq. **Single-span read works for blobs** — after `repack -adf` all bases are OFS_DELTA earlier in the same pack, so `deltaChainSpan` yields one contiguous ranged read returning the blob and its bases (median 1.21× over-fetch). **Trees are the exception** — a contiguous span over-fetches catastrophically (root tree measured 212×), so above a span threshold readers use the `deltaHint` to walk each delta base individually instead. **Published in fragments, one per stored pack** (`RepoService::publish_push_locator`): a push publishes a locator over just the pack it stored, so the write costs 36 B per object the push actually ADDED rather than republishing the whole index — on a 40k-object repo that is the difference between a few KB and ~1.4 MB of `chunk` deposits to record a one-file change. A reader merges the live fragments (`ObjectLocator::merge`, mirrored in forge-web). Fan-out is bounded the other way by folding: once the live fragment count would exceed 16, the push merges them into one locator and supersedes the parts, and a repack rebuilds the whole index as a single artifact. A reader that finds the live fragments do NOT cover every live pack reports the index as behind and falls back to the in-browser clone — it never serves reads through an index that would miss recent objects.
- **`flatIndex`** — the tip's complete recursive file listing (`path → oid, mode, size`, path-sorted, compressed), i.e. GitHub's tree API as one static artifact. **It is O(files), not "tens of KB": S0.5 measured ~471 KB @ 10k files and ~4.5 MB @ 100k files.** Gives instant tree navigation at any depth *and* client-side filename search with zero object fetches — but because it scales with the tree, **cold repo-home must NOT eagerly fetch it**. Published on default-branch pushes, batched for hyperactive repos (every 20 pushes / 24 h); readers overlay the ≤ 20 commits since the indexed tip via locator tree-diffs, so views are always current without a full walk. Other refs fall back to object walking.

Resulting cold-load path for a repo of *any* size: refs + config (KB) → **root tree via locator** (~101 KB, size-independent) → README blob via locator ranged read (KB) — **3–5 requests, O(view) bytes, independent of repo size, comfortably inside the <500 KB / <3 s budget**. flatIndex is **deferred** to the views that actually need the full listing (deep tree-browse, filename search), never loaded on the home view. Blob view = one locator lookup + one ranged read (**single contiguous span** — sound for blobs, whose OFS_DELTA bases sit earlier in the same pack after repack); directory = root tree via locator (home) or flatIndex (deep browse); commit log = commit objects via locator (tiny), optional commit-graph artifact later; historical/other-ref trees = locator-driven object walk (commit → trees → blobs, ~KB per hop) using the **per-base fallback for trees** (§5). Full materialization (isomorphic-git in a worker, IndexedDB pack store) remains, but only for the features that genuinely need it: content search, blame, in-browser merge/edit. Excellent-UX target ≤ 100 MB now applies to *those* features, not to browsing.

### Liveness
No document subscriptions → web/CLI poll indexed queries with cursors; **relay** subscribes to the block/ST firehose and translates to push-style webhooks for CI/notifications (PRD 05).

## 7. Cross-client parity

Client-side rules are versioned (`FORGE_RULES_V2`: `forge-core::rules::v2`, `forge-web/lib/rules/v2.ts`) with **shared conformance vectors** (JSON fixtures in `forge-contracts/vectors/`) consumed by the Rust workspace tests and forge-web tests alike — the only defense against Rust/TS divergence. Consensus enforces who may write each type; what remains client-side is listed in [`contracts/forge-v2.md`](contracts/forge-v2.md) §6: ref resolution, protected-pattern globs and the as-of config overlay, event kinds by role (§3 there), issue/PR numbering, PR approvals, the pack and repoKey reader rules, and the plaintext-or-`enc` rule.

## 8. Economics (full model: [economics.md](economics.md))

- 27,000 credits/byte storage deposit (refundable on delete, 50-era amortization; the non-deletable types never refund); 1 DASH = 10¹¹ credits.
- On-Platform data ≈ **$9/MiB @ $34/DASH** (DASH-primary display; USD secondary; fee-multiplier governance lever flagged).
- Social artifacts are noise (2 KiB issue ≈ 2¢). Ref update ≈ 0.0006–0.0009 DASH (its index entries, not its bytes, dominate). Creating a repository ≈ **0.001 DASH** (three documents; the v1 per-repo contract was ~1.18 DASH).
- forge-v2 registration: forge-core 0.60 + forge-collab 0.55 DASH in fees (1.161234 DASH measured on devnet moutai), paid once per network by the deployer ([forge-v2.md §7](contracts/forge-v2.md#7-measured-size-and-cost)).
- Cost engine (forge-core) quotes every write batch pre-broadcast and tracks running spend (`dg cost`, web settings).

## 9. Security & trust

- Writes need AUTHENTICATION keys at HIGH; identity keys via keychain/agent (SSH-key UX shape). CI runners get their own identity with a `writer` membership (optionally a ContractBounds-scoped key).
- Proof verification default-on in helper/CLI; web benchmarks trusted vs proof mode (S0.3).
- Relay is availability-only: payload consumers (CI) re-fetch and verify from Platform; webhook secrets encrypted to relay identity; instances interchangeable.
- Markdown/filename rendering sanitized (XSS), CSP per yappr static-export pattern.
- Top risks + open questions: see implementation plan risk register and init-reconciliation open questions (ST throughput), and roadmap decisions D-D/D-J (mainnet contract ownership and `config.readonly`).

## 10. Technology choices

| Layer | Choice | Rationale |
|---|---|---|
| Helper/CLI/relay/import | **Rust** workspace on rs-sdk/rs-dpp | Shares code with Platform; Radicle helper reference; single-binary distribution |
| Web | Next.js static export + wasm/evo-sdk + isomorphic-git/lightning-fs in worker | yappr-proven zero-backend stack; in-browser materialization is the zero-backend trick |
| Highlighting/diff/edit | Shiki · diff2html-or-Monaco (pending research, D-open) · CodeMirror 6 | INIT.md stack |
| Search | MiniSearch (or tantivy-wasm) per-repo index in IndexedDB | Client-side, no server |
| Auth (web) | platform-auth engine (yappr vendored) | Key/password-vault/passkey/QR for free |
| Import | Forgejo migration-layer semantics over GitHub REST/GraphQL | Most battle-hardened importer |
