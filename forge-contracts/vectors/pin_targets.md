# Pin target vectors

Each `pin_targets__*.json` is a v2 conformance vector with `case: "pin_targets"`,
`input` and `expected`. The Rust rules harness runs every matching JSON file.

`input` contains `owner`, `roles` (identity to role), `manifests`, and `releases`.
Each manifest has `id`, `owner`, `sha256` (packHash), `kind`, `size`, `uris`,
`createdAt`, `readable`, and `sensitive`. Optional `unreadable` defaults to false:
it means no header or verified bytes could be read for the visibility check.
An empty manifest owner represents mirror addresses, which have no swarm authority.
Release rows have `owner`, `tag`, and `assets`; each asset has `name`, `sha256`,
`size`, `uris`, and optional paired `sealedSha256` / `sealedSizeBytes`.

`expected.targets` contains one object per accepted packHash, with `sha256`,
`size`, `what`, and `candidates: [{cid, swarmAllowed}]`. `what` is either
`{type: "pack", kind}` or `{type: "releaseAsset", tag, name}`. Release assets
with the same stored hash and size merge into the existing target. Size is
charged once, irrespective of the number of candidates.

Candidates normalize to base32 CIDv1; CIDv0 retains its `Qm…` spelling. They
sort by `swarmAllowed` true first, then CID lexically, with duplicates removed
and authorized provenance winning. Only owner, maintainer, writer and bot
records allow swarm pinning. Stranger and mirror candidates must equal the
CID derived from verified bytes before any pin, including a remote service pin.
Metadata comes from the preferred authorized copy (owner/maintainer first,
then oldest `createdAt`, then `id`). Copies with conflicting size are discarded.
Across hashes, an authorized CID claim wins over an untrusted claim; otherwise
the first target's metadata wins. Conflicts skip candidates, never fail planning.

The remaining expected fields are integer counters `notOnIpfs`,
`membersOnlySkipped`, `unreadableSkipped`, `invalidCidsSkipped`,
`conflictingCidsSkipped`, and `strangerCopiesIgnored`, plus boolean `needsConsent`.
Invalid CID counters count rejected candidate URI occurrences, before deduplication.
Conflicts count candidate occurrences rejected for copy size, then deduplicated
candidates rejected for cross-target metadata conflicts. A pack with no usable
candidate counts as `notOnIpfs`; this check precedes visibility checks. A
stranger-only hash counts its manifests in `strangerCopiesIgnored`.
