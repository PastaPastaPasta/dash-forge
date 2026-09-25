# PRD 04 — Storage Backends (Platform primary; IPFS / S3 / HTTPS / mirrors for fee reduction)

**Platform is primary storage and always the source of truth**: refs and pack manifests live on Platform in every mode. Backends control only where **pack bytes** rest. External backends are verifiable caches — integrity comes from manifest SHA-256 + git OIDs, never from the host. This is the "reduced fees on certain projects" layer; GA in Phase 4 (platform + basic ipfs read earlier for import/dogfood needs).

## Backend descriptor

Stored in the repo contract's `config` document (`backend: { mode: platform | ipfs | s3 | https | mixed, uris }`, MAINTAIN-gated, newest config wins). Per-remote override in git config. **Mixed mode** (the expected steady state for big repos): recent packs on Platform (fast, fully on-chain), archival packs external; `dg repack` migrates cold history outward and reclaims Platform storage refunds.

## Backend trait (forge-core, Rust; mirrored in forge-web TS for reads)

```rust
trait PackBackend {
    fn scheme(&self) -> &str;                       // platform | ipfs | s3 | https
    fn caps(&self) -> Caps;                         // read/write × cli/browser
    fn put(&self, bytes, meta) -> Result<Vec<Uri>>; // → manifest uris
    fn get(&self, uri, range: Option<Range>) -> Result<Bytes>; // ranged for partial clone
    fn probe(&self, uri) -> Result<Health>;
}
```
Hash verification lives in PackPipeline, outside backends — a malicious backend can only cause a retry/failover. Reader policy: order URIs by (scheme preference, historical latency), ≤2 parallel attempts, fall through mirror URIs, then Platform chunks if present.

## v1 backends

### 1. Platform (default)
`chunk` docs (3 × 4.9 KiB fields), pipelined STs, ranged reads by chunk seq via the `objectLocator`. ~$9/MiB @ $34/DASH, refundable; repack-with-refund keeps steady-state ≈ current size.

### 2. IPFS
- Write: local Kubo or pinning-service API (Storacha/Pinata — yappr-proven clients); URI `ipfs://CID` (CIDv1 raw-leaves; CID must re-derive from bytes → double verification with manifest sha256).
- Read: CLI via local Kubo else gateways; browser via gateway race (configurable list + self-host option from yappr `ipfs/` docker).
- Availability = pinning; `dg reseed` re-pins + appends mirror URIs; any clone can restore a dead repo's availability.

### 3. S3-compatible (AWS/R2/MinIO/B2)
Write with credentials (CLI; browser when CORS allows); manifest stores `s3://` **plus** public `https://` URL when available so browsers read credential-free. Ranged GET supported → partial clone friendly.

### 4. HTTPS (read-only)
Any static host/mirror. CORS required for browser reads (CLI unaffected); `dg storage status` reports per-URI CORS/health.

### 5. Git mirror (`gitmirror://<remote-url>`) — Phase 4
Wraps an existing git hoster (GitHub/GitLab/Codeberg) as a byte source: CLI fetches from the mirror and rebuilds needed packs locally (integrity via OIDs chaining to Platform-signed refs; manifests carry `tips` for coverage rather than byte-equality). Write = `git push --mirror` (CLI, credentialed). Browser: unsupported (badge "CLI-only source"). Also the mechanism for import's transition mirror mode.

## Operational UX

- `dg repo backend set <mode>`; `dg storage status` (availability matrix, at-risk packs, suggested reseed); `dg reseed [--to …]`; cost comparison in `dg cost estimate --backend …`.
- forge-web settings: backend switch with cost/tradeoff explainer; verification chips always show actual byte source.

## As built: bring-your-own storage on `git push` (2026-09-25)

User guide: [`docs/guides/bring-your-own-storage.md`](../guides/bring-your-own-storage.md). Roadmap: Phase 1, decisions D-B and D-K.

**Where things live.** The backend descriptor above assumed that the on-chain `config.backend` chooses where a push writes. As built, it does not, because the chain cannot hold the credentials a write needs:
- **Profiles** (`forge_core::storage::profiles`) live in `~/.config/dash-forge/storage.toml` (or `$DASH_FORGE_STORAGE_CONFIG`). Kinds are `s3 | ipfs-kubo | ipfs-pinning-service | platform`. Secret fields hold only `env:VAR` or `keychain:<service>/<account>` references (macOS `security`, freedesktop `secret-tool`). They resolve into the redacting `keystore::Secret`, and loading a file that contains a literal secret fails without echoing it. Field names are chosen so the web app's encrypted vault can store the same shape.
- **Policy** (`forge_core::storage::policy`) is in git config: `dash.storage` (profile names), `dash.replicas` (N, defaulting to every target) and `dash.platformFallback`, with `remote.<name>.dash*` overrides. **No policy means Platform only**, byte-for-byte the old behaviour, including the resumable chunk journal.
- The on-chain `config.backend { mode, uris }` only **advertises** the policy's mode and public read bases (`dg storage advertise`, via `RepoService::set_backend`). The contract schemas are unchanged (repo-v1, nested `backend`).

**Push path** (`git-remote-dash/src/helper.rs`):
1. Build the pack.
2. Resolve the policy. A bad policy fails before any network I/O.
3. Print the plan and the estimate.
4. Run the cost guard: `dash.costWarnThreshold` / `dash.confirm`, confirmed on `/dev/tty`, and fail with a fix when there is no terminal.
5. Call `storage::replicate`. External targets run in parallel. The Platform target runs afterwards, and only if N is still reachable, so chunks are never paid for and then discarded.
6. Write the `packManifest`.
7. Write the refs.

Every failure before step 6 returns an error. **No manifest and no ref is written unless N copies are confirmed.** The push seam is the `storage::StorageTarget` trait. `ExternalTarget` wraps a `PackBackend` and verifies uploads by re-reading them (full GET + SHA-256 up to 16 MiB; above that, size plus byte-exact head and tail ranges). `repo::PlatformChunkTarget` is the only piece that knows chunks are repo-v1 documents, so the PV14 forge-v2 contract replaces that one type. Browse-index fragments (kind-1 `objectLocator` artifacts from PR #4) are stored through the same targets that confirmed the pack (`RepackTarget::Replicated`).

**Manifest encoding.** With an on-chain copy: `storage = 0`, `chunkCount = n`, and `uris` lists every external copy as well. Today's web app treats `storage === 0` as "read chunks", so it keeps working. Without one: `storage = 1`, `chunkCount = 0`, `uris` = public URLs first, then `s3://bucket/key` locators, then `ipfs://<cid>`. `s3://` locators are dropped first if the 2600-byte `uris` field would overflow. Object keys are content-addressed (`[prefix/]packs/<sha256>.pack`), so a re-push is idempotent: the S3 backend skips the PUT when `HEAD` already shows the same size.

**S3** (`backends/s3.rs`, `backends/sigv4.rs`): SigV4 is hand-rolled on the `sha2`/`hmac` crates already in the tree. `aws-sigv4` pulls the smithy HTTP stack, and `rusty-s3` pulls a second RustCrypto major version. It is pinned by the AWS SigV4 test-suite vectors (vanilla, unnormalized space, UTF-8 path and query, unreserved, query ordering, header sort, session token) and by the S3 API reference examples (ranged GET, PUT with a `$` key, presigned GET). It supports PUT/GET/HEAD/DELETE, path-style and virtual-hosted addressing, STS session tokens, `x-amz-content-sha256` = the real body hash, presigned URLs (for the future browser upload), and unsigned public reads through `public_url`. Keys are percent-encoded once per segment, and prefixes with empty, `.` or `..` segments are rejected, because an HTTP stack would normalize them after signing.

**IPFS** (`backends/ipfs.rs`, `backends/cid.rs`): kubo `add` runs with the import parameters pinned (`cid-version=1&raw-leaves=true&chunker=size-262144&hash=sha2-256&trickle=false&max-file-links=174&pin=true`). The returned CID must equal a local re-derivation (raw leaf for ≤ 256 KiB; otherwise a balanced dag-pb/UnixFS tree) and must show as pinned in `pin/ls`. A `ipfs-pinning-service` profile then pins remotely through the Pinning Service API (`GET /pins?cid=`, reused if already pinned or queued; `POST /pins` with the node's `origins`; poll `GET /pins/{requestid}` until `pinned`, `failed`, or timeout).

**Reads** (`storage::read::PackReader`, `RepoService::fetch_artifact`): the reader races the manifest's https URLs, then signed GETs for `s3://` locators matching a local profile, then every `ipfs://` CID on every configured gateway, two at a time, each hash-verified. Platform chunks come last. The single default gateway list is `forge-contracts/config/storage-defaults.json`, embedded by forge-core and therefore used by dg and git-remote-dash. The hard-coded `https://ipfs.io` in repo.rs, `dg storage status` and `dg release download` is gone. `dg repack`/`dg reseed` take `--profile <name>`; the old env-var-configured `--backend`/`--to` remain for existing scripts.

**`dg storage`**: `add | list | remove | test | use | advertise | status`. `test` runs a signed put, get and delete on a probe object, an anonymous read of the public URL, and a CORS check (GET `Access-Control-Allow-Origin`, a Range preflight, `Content-Range` exposure). On failure it prints the exact CORS document for R2, B2, AWS or MinIO.

**Verified live (local only, per D-K):** SigV4 PUT/HEAD/ranged GET/DELETE against MinIO's `forge-byo` bucket, which refuses anonymous writes, using a key full of reserved characters; a wrong secret gets a 403. kubo 0.42 CIDs match the local derivation for single-chunk and 3-chunk files. N-of-M replication to MinIO + kubo with gateway read-back. `make storage-e2e`: a real `git push` on testnet with packs on MinIO + kubo (manifest `storage=1, chunkCount=0`), a clone by a reader with no S3 profile that was byte-identical and passed `fsck --strict`, a dead second target with N=2 that refused the push and left the remote ref unmoved, and N=1 tolerating the dead target.
**Not verified against real services:** AWS S3, R2 and B2 (D-K: no external accounts); a real pinning service, whose client is tested only against a scripted local HTTP server; virtual-hosted addressing on a live endpoint, which is tested offline only.
**Deferred:** browser uploads and the web app's settings UI (Phase 1, web workstream); `packMirror` announcements from push (reseed has them already); multipart upload for packs above S3's 5 GiB single-PUT limit; streaming verification for very large packs.

## Acceptance

- Same pack via IPFS and S3 clones identically; tampered primary URI detected + failed over + logged.
- Mixed-mode repo: recent history clones from Platform offline from IPFS; full history pulls archival packs from IPFS.
- Backend switch + repack migrates a live repo Platform→mixed with observed storage refund and no clone breakage.
- Kill external host entirely → `dg reseed` from any clone restores availability with no history loss.
