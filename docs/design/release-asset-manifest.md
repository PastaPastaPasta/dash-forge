# Release asset manifests: unlimited assets per release (proposal for the fresh registration)

**Status:** proposal, for the forge-core registration after the moutai wipe (and mainnet's first registration). Nothing here changes the contracts registered on moutai today. Those stay as they are until the chain goes away.

**Why.** A `release` lists its assets in `assets`, one JSON string of at most 4,096 bytes. An imported asset entry (name, SHA-256, size, one URI) is about 255 bytes, so a release holds about 16. The showcase rebuild on moutai beta.6 (2026-09-28) hit the limit on 7 of its 15 mirrors:

| mirror | releases | releases over the limit | assets left out |
|---|---|---|---|
| dashpay/dash | 137 | 107 | 621 |
| charmbracelet/glow | 24 | 24 | 445 |
| junegunn/fzf | 85 | 57 | 106 |
| BurntSushi/ripgrep | 75 | 9 | 101 |
| jqlang/jq | 16 | 7 | 53 |
| sharkdp/fd | 45 | 8 | 37 |
| sharkdp/hyperfine | 26 | 10 | 21 |

What ships now, with no contract change (PR "fix(import): prove merges without code, keep the assets that matter", 2026-09-28):

- The importer keeps checksum files, signatures and the common platform builds first (`model::fit_assets`).
- It ends the notes with a footer saying how many assets were left out, linking the source release (`model::notes_with_footer`).
- The web shows that footer as "N more assets not mirrored" with the link.

That is a pointer to the rest, not a mirror of it. If the source disappears, the omitted assets go with it.

## 1. Design: the list moves into a stored artifact

A release names its full asset list by hash. The list itself is an artifact stored like any other forge artifact: a `packManifest` of a new `kind`, its bytes in the repository's storage (BYO storage and/or Platform chunks). Readers fetch it, check the hash, and list every asset.

This reuses what already exists:
- **Storage.** `packManifest` already stores content-addressed artifacts of several kinds: kind 0 git packs, kind 1 `objectLocator`, kind 2 `flatIndex`. Their bytes go to the repository's storage policy (Platform chunks, BYO URIs, or both), and readers verify them against `packHash`.
- **Access.** The maintainer/writer gates, the per-uploader unique index, the reader rule for copies (`order_pack_copies`) and `dg repack`/`reseed` all apply unchanged.
- **No new document type.** Nothing new to count, gate or index, and no new query.

### 1.1 forge-core `release`: one new property

```json
"assetManifest": {
  "$ref": "#/$defs/h32",
  "position": 8
}
```

- `assetManifest`: the `packHash` (SHA-256) of the release's asset manifest, a `packManifest` of kind 4 in the same repository.
- Optional. A release with only a handful of assets keeps listing them inline in `assets` and has no manifest.
- A release may carry both. `assets` is then the **preview**: the checksum files, signatures and common platform builds, as `fit_assets` picks them today. A reader that cannot fetch the manifest still has the downloads that matter, and a reader that can shows the rest.
- **The `noPlain` constraint gains `assetManifest`.** A private repo's release (`enc` present) must not name a plaintext list:

```json
"propertyConstraints": {
  "noPlain": {
    "anyOf": [
      { "absent": "enc" },
      { "allOf": [
        { "absent": "name" },
        { "absent": "notes" },
        { "absent": "assets" },
        { "absent": "assetManifest" }
      ] }
    ]
  }
}
```

Sealed releases carry the hash inside `enc` (TLV 21), and the manifest's bytes are sealed like a private pack (`docs/security/private-repos.md` §16.5, which also adds the sealed-only keys `notes`, `sealedSha256` and `sealedSizeBytes`). A sealed release always lists its assets in the manifest, never in `enc`.

Cost: 32 bytes and one position. forge-core's per-write contract-load fee grows by ~0.7 kB × 20 credits/B, which is negligible (BETA6-ANALYSIS.md, "Fees and registration").

### 1.2 `packManifest.kind = 4`: `releaseAssets`

No schema change: `kind` is already `integer 0..255`. The new constant is `KIND_RELEASE_ASSETS = 4` in `forge_core::pack::manifest` and its web mirror. Kind 3 is taken by the history index (`KIND_HISTORY_INDEX`); RC1's `kindShape` rule (R-11) requires a kind-3 manifest's `tips` to be 20, 32, 40 or 64 bytes and asks nothing extra of kind 4. Kind 4 manifests are excluded from the git pack space: `packRef` numbering is per kind (forge-v2.md §4, step 4), so this is automatic. The browse index never covers them.

The artifact's bytes are UTF-8 JSON, canonical: keys sorted, no insignificant whitespace, entries in the source's order. For example:

```json
{
  "v": 1,
  "tag": "v23.1.8",
  "total": 21,
  "source": "https://github.com/dashpay/dash/releases/tag/v23.1.8",
  "assets": [
    {
      "name": "SHA256SUMS.asc",
      "sha256": "0f5e…64 hex…",
      "sizeBytes": 2048,
      "uris": ["https://github.com/dashpay/dash/releases/download/v23.1.8/SHA256SUMS.asc"]
    }
  ]
}
```

- `v`: format version, 1.
- `tag`: the release's `tagName`. A reader rejects a manifest whose tag differs, so one manifest cannot be replayed onto another release.
- `total`: the count of `assets`, redundant but cheap to cross-check.
- `source`: the source release's page, for imports. Absent for a native release.
- `assets`: the same entry shape as `release.assets`, `{name, sha256, sizeBytes, uris[≤8]}`, with the same rules: `sha256` is 64 hex, or `""` for an import that could not hash the file yet (D-517).

Size: about 255 B per imported entry, so dashpay/dash's largest release (21 assets) is ~5.4 kB, one chunk on Platform (~0.0055 DASH) or a BYO object.

### 1.3 Writers

- **`forge-import`** writes the manifest when a release's list does not fit: kind-4 `packManifest` plus its chunks/URIs, under the run's storage policy and priced like any artifact. Then the `release` carries the preview in `assets` and the hash in `assetManifest`. The notes footer is no longer needed, and a later run drops it from the notes.
  - An import whose storage refuses the manifest falls back to today's footer, so the release is still published.
- **`dg release create`** and the web's new-release dialog write a manifest past ~12 assets, with the same preview rule.
- **Idempotency:** the manifest is content-addressed, so a re-run that finds `(repoId, $ownerId, packHash)` already recorded writes nothing.

### 1.4 Readers

- **forge-web** (`lib/repo/releases.ts`) shows `assets` at once. When `assetManifest` is set, it:
  1. fetches the kind-4 artifact through the existing verified-artifact reader;
  2. checks the SHA-256 and the `tag`;
  3. lists every asset, each with the existing verified-download row.
  - If the fetch fails, it keeps the preview and says "N more assets: list unavailable (retry)".
- **`dg release list/download`**: the same. `download --all` walks the full list.
- **The trust model is unchanged.** Every asset with a recorded SHA-256 is checked against it, and the list itself against `assetManifest`, which the maintainer signed. An imported asset recorded with `sha256: ""` (not hashed yet) is never verified: readers show it as "not verified yet" and link its original, as they do today.

## 2. Alternatives considered

| Option | Why not |
|---|---|
| A `releaseAssets` document type, one per 16 entries (`releaseId`, `seq`, `assets` 4096 B) | A new type: gates, indexes and a new query. It costs one Platform write per 16 assets, forever. The manifest keeps assets as bytes in the storage the owner picked, and Platform stores only one hash. |
| Raise `release.assets` `maxBytes` (e.g. 16 KB) | A document is at most ~20 KB on Platform (constraints doc), and the ~5 KB of notes share it. It only moves the ceiling (~60 assets), and every release pays for the bytes on Platform. |
| Shorter entries (drop `uris`, derive from a base URL) | It saves ~40%, still has a ceiling, and makes every reader reconstruct URLs per source. |
| Keep the notes footer only | What ships now: it is a link to the source, which is exactly what a mirror exists to not depend on. |

## 3. Also proposed for the fresh registration: `assetsOmitted`

If the manifest slips, a single small field keeps the omitted count machine-readable instead of in the notes' footer:

```json
"assetsOmitted": {
  "type": "integer",
  "minimum": 0,
  "maximum": 65535,
  "position": 9
}
```

Readers prefer it to the footer when present. With `assetManifest` it is redundant. Register one or the other, not both.

## 4. Release published dates (FG-6, L-04)

An imported release shows the import time (`$createdAt`) as its date. `imported` provenance (`{author, createdAt, url}`) exists on forge-collab's issue and patch, not on forge-core's release. The fresh registration should give `release` the same optional object:

```json
"imported": {
  "type": "object",
  "properties": {
    "author": { "type": "string", "maxLength": 120, "maxBytes": 480, "position": 0 },
    "createdAt": { "type": "integer", "minimum": 0, "position": 1 },
    "url": { "type": "string", "maxLength": 300, "maxBytes": 300, "position": 2 }
  },
  "additionalProperties": false,
  "position": 10
}
```

This is the same shape as forge-collab's `$defs/imported`, so one reader serves both. The `noPlain` constraint gains `imported` too: a sealed release's provenance goes inside `enc`.

**Until then (FG-6).** forge-import opens an imported release's notes with a provenance line, and forge-web shows it as the release's date and publisher (`lib/repo/provenance.ts` `releasePublishedOf`):

```
> Published on github.com by @UdjinM6 on 2026-08-03
```

Only a maintainer can write a release, so the line is the repo's own account, and needs no trust check beyond that. Once `release.imported` exists, the importer writes the field instead. Readers then prefer the field and keep parsing the line for releases written before.

The same applies to two things a mirrored PR records in its body today:

- its base commit;
- a fork's head branch.

It uses the line `> Base <oid> · head <owner:branch>`. The fresh `patch` type could carry these as `imported.baseOid` (`$defs/oid`) and `imported.headLabel` (string, 200). The field is the better home: readers could then diff and label without parsing the body.

## 5. Also for the fresh registration: a chunk count for the push estimate

Each `chunk` insert rewrites its ancestors in forge-core's network-wide `chunk` primary-key tree. The cost therefore grows with log₂ of the network's chunk count, about 7M credits per level (`forge_core::cost::push_fees::CHUNK_PER_LEVEL`, fitted on the beta.6 showcase imports).

The estimator now prices a fixed 16 levels (65,536 chunks). A `documentsCountable: true` on `chunk` would let it read the real count in one proved O(1) query (document-count-trees.md, "Unfiltered total") and price the real depth. Cost: `chunk`'s primary-key tree becomes a `CountTree`, which adds a count to each node on the insert path (small next to a 15 kB chunk). This needs a measurement on the fresh devnet before it is adopted.

## 6. Checklist for the registration PR

- [ ] `release.assetManifest` (h32, position 8) and `noPlain` gains it.
- [ ] `KIND_RELEASE_ASSETS = 4` in forge-core and forge-web, excluded from the git pack space.
- [ ] `release.imported` (§4).
- [ ] Decide `chunk.documentsCountable` (§5) after a cost measurement.
- [ ] Contract size stays under the limit. forge-core is 14,515 B signed on beta.6; these add well under 1 kB.
- [ ] Vectors: a manifest whose `tag` differs is rejected, and a manifest hash mismatch shows the preview only.
