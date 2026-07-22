# PRD 04 — Storage Backends (Platform primary; IPFS / S3 / HTTPS / mirrors for fee reduction)

**Platform is primary storage and always the source of truth**: refs and pack manifests live on Platform in every mode. Backends control only where **pack bytes** rest. External backends are verifiable caches — integrity comes from manifest SHA-256 + git OIDs, never from the host. This is the "reduced fees on certain projects" layer; GA in Phase 4 (platform + basic ipfs read earlier for import/dogfood needs).

## Backend descriptor

Stored in `repoListing.backend`: `{ mode: platform | ipfs | s3 | https | mixed, uris }`. Per-remote override in git config. **Mixed mode** (the expected steady state for big repos): recent packs on Platform (fast, fully on-chain), archival packs external; `dg repack` migrates cold history outward and reclaims Platform storage refunds.

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
`chunk` docs (3 × 4.9 KiB fields), pipelined STs, ranged reads by chunk seq via offset index. ~$9/MiB @ $34/DASH, refundable; repack-with-refund keeps steady-state ≈ current size.

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

## Acceptance

- Same pack via IPFS and S3 clones identically; tampered primary URI detected + failed over + logged.
- Mixed-mode repo: recent history clones from Platform offline from IPFS; full history pulls archival packs from IPFS.
- Backend switch + repack migrates a live repo Platform→mixed with observed storage refund and no clone breakage.
- Kill external host entirely → `dg reseed` from any clone restores availability with no history loss.
