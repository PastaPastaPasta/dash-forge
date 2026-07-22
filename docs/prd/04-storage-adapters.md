# PRD 04 — Storage Adapters (bulk hosting: IPFS / S3 / HTTPS / git mirrors)

The fee-reduction layer. Packs are immutable, content-addressed blobs; adapters move bytes, never trust. Platform manifests (`pack.uris`, `packMirror`) are the source of truth for *where*; sha256 is the source of truth for *what*.

## Adapter interface (forge-core)

```ts
interface StorageAdapter {
  scheme: string;                       // 'ipfs' | 's3' | 'https' | 'gitmirror'
  capabilities: { read: boolean; write: boolean; browserRead: boolean; browserWrite: boolean };
  put?(bytes: Uint8Array, meta: PackMeta): Promise<string[]>;  // → URIs for manifest
  get(uri: string, opts: { onProgress }): Promise<Uint8Array>; // caller verifies sha256
  probe(uri: string): Promise<{ ok: boolean; sizeBytes?: number; latencyMs: number }>;
}
```
- Registry + credential storage per provider (yappr `lib/upload/provider-registry.ts` + `credential-storage.ts` pattern; browser: encrypted local storage; CLI: OS keychain).
- **Reader failover policy**: try URIs ordered by (scheme preference, historical latency), 2 parallel attempts max, verify hash, fall back through `packMirror` URIs, then Tier P chunks if `chunked`.
- All verification (sha256, pack integrity) lives in PackPipeline, *outside* adapters — an adapter can be malicious and only cause a retry.

## v1 providers

### 1. IPFS (default for Tier X)
- **Write**: Storacha (`@storacha/client`) and Pinata (`pinata`) — both proven in yappr; user brings credentials. URI form `ipfs://<CID>` (CIDv1, raw-leaves; CID must be derivable from bytes → double verification: CID *and* manifest sha256).
- **Read (browser)**: gateway race across configurable list (user gateways + `w3s.link`, `ipfs.io`, self-host from yappr `ipfs/` docker setup). Read (CLI): local kubo if present (`/api/v0/cat`), else gateways.
- Pinning is the availability story: pusher pins via their provider; `dforge reseed` lets anyone re-pin + announce `packMirror`.

### 2. S3-compatible
- Write/read via presigned-capable credentials (AWS S3, R2, MinIO, B2). URI form `s3://bucket/key` in manifest **plus** an `https://` public URL when the bucket is public (so browsers read without creds).
- Browser write: supported when CORS-configured; otherwise CLI-push-only (browser still reads via https URI).

### 3. HTTPS (read-only)
- Any static file host. `get` = fetch + hash-verify. Enables "host your packs on your own website" and mirrors. CORS required for browser reads; CLI unaffected. `dforge storage status` reports CORS health per URI.

### 4. Git mirror (`gitmirror://`)
- Wraps an existing git hoster (GitHub/GitLab/Codeberg/self-hosted) as a bundle source: URI `gitmirror://https://github.com/alice/repo.git`. CLI `get` runs `git fetch` from the mirror and rebuilds the needed pack locally (objects verify by OID — the pack hash may differ, so manifests using gitmirror URIs carry `tips` for coverage checking rather than byte-equality; integrity still absolute via OIDs chaining to signed refs).
- Write = `git push --mirror` to the hoster (credentialed, CLI only). Browser read: unsupported v1 (no CORS on git protocol) — UI shows "CLI-only source" badge.
- This is the "alternative git hosters" requirement: Platform stays authoritative for refs; the hoster is a dumb byte mirror that can vanish without data loss (any clone can reseed).

## Provider selection UX
- Repo setting: ordered preferred-write providers; push uploads to first available, `--all` for multi-upload.
- `dforge storage status <repo>`: probes every URI of every manifest, prints availability matrix + "at risk" packs (single-URI, failing) + suggested `reseed`.

## Acceptance criteria
- Same pack pushed via IPFS and S3 adapters clones identically; corrupting one URI's bytes (test fixture) is detected, logged, and transparently failed-over.
- gitmirror round-trip: push to Platform+GitHub mirror, delete GitHub repo, `dforge reseed --to ipfs` from any clone restores availability.
- Browser reads succeed with zero adapter credentials for public https/ipfs URIs.
