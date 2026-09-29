# History index: last-change column and exact commit count

Status: implemented on branch `feat/last-change-index`.

## Problem

The file list's last-commit column was computed in the browser. The web walked first-parent history from the tip, at most 400 commits (`LAST_COMMIT_WALK`, L-41), and labelled everything else "older than 400 commits". dashpay/dash's `develop` is almost all merge commits, so 400 first-parent steps cover only a few months, and most rows showed the cap. The walk was also a large share of the home's cold DAPI requests. The ref bar's commit count had the same shape: it counted at most 100 first-parent commits, then showed `100+`.

GitHub precomputes both on its servers. Forge has no server. The pusher has the whole history locally, so the push precomputes them.

## Design

### The artifact: `packManifest.kind = 3`, a history index

A push that moves the default branch publishes a **history index** for the new tip. It is stored and transported exactly like the objectLocator and the flatIndex: through the push's replication targets (your own storage honoured, Platform `chunk` documents when the policy includes Platform), sealed for a private repository, and recorded by a `packManifest` whose `kind` is `3`.

**No contract change.** `packManifest.kind` is `{"type": "integer", "minimum": 0, "maximum": 255}` in forge-core, both in the source and in the registered `forge-core.v1.json` (A2KL77ng…). Every existing reader filters by kind: git packs are kind 0, index fragments kind 1, and `v2PackList` is kind-agnostic. So a kind-3 manifest is invisible to older clients. It does not shift any `packRef`, because the locator space is kind-0 packs only.

**Why not a section inside the objectLocator artifact.** The owner preferred riding on the locator. Both shipped locator parsers refuse any other length: `ObjectLocator::parse` in forge-core and `ObjectLocator.parse` in forge-web accept only `bytes.length == fanout + n × 36`. A locator carrying an extra section would be refused by every deployed CLI and web build, so those repos would read as `index-behind` and fall back to the in-browser clone. It would also tie the history to the locator's fragment/fold cycle: a fold rewrites 36 bytes per object, 9.6 MB on dash. A sibling artifact reuses all the locator's machinery (storage, sealing, copies, the reader rule) without either problem.

**The manifest's fields for kind 3:**
- `tips` = `[tip]` for a full index, or `[tip, baseTip]` for a delta, so a reader chooses one before downloading anything;
- `objectCount` = the number of path rows;
- `offsetIndexParts` = 0;
- `supersedes` = the history indexes it makes redundant.

### Format (v1)

The body is gzip-compressed as a whole, like the flatIndex. Integers are LEB128 varints and paths are raw git path bytes.

```text
"DFHI" | version u8 = 1
tip oid (20)
base packHash (32)            all zero for a full index; the full index a delta extends
commitCount varint            git rev-list --count <tip>            (every reachable commit)
firstParentCount varint       git rev-list --first-parent --count <tip>
rootTime varint               author time (s) of the first-parent root
tipTime varint                author time (s) of the tip
nCommits varint
  oid (20) | authorTime varint (s) | subjectLen varint | subject (≤ 200 B, UTF-8 boundary)
nPaths varint                 byte-sorted, front-coded
  shared varint | suffixLen varint | suffix | commit varint (index into the commit table)
(tag varint | len varint | bytes)*   extension sections (v1 writes none)
```

**Versioning.** Everything up to the paths is fixed for every version. A later version adds data in tagged sections after them, and a reader skips any tag it does not know. So a v1 reader reads a v2 index's last-change column and counts, and ignores the rest: no flag day. `version` names the newest layout the writer used, and readers accept any version from 1 on. One candidate for v2 is per-path version lists for Blame and History (FG-4, `last-change-index-v2.md`).

Each commit is stored once, with its subject and author time, so the column needs no commit reads. The subject is the first line of the message, trimmed, exactly as the web's `commitSubject` computes it.

### Semantics: the same as the web walk

For every path in the tip's tree (files, symlinks, gitlinks **and directories**, keyed by full path), the index names the newest first-parent commit whose tree entry at that path differs in `mode:oid` from its first parent's. A root commit adds everything. This is what `lastCommitsForDir` computed. It is also what one pass of `git log --first-parent --diff-merges=first-parent --no-renames --root -t --raw -z` reports: `-t` lists changed trees, `--no-renames` turns a rename into a delete plus an add, and first-parent diffs show a merge as what it brought into the branch. The pass streams, and it stops as soon as every path has a commit.

### Incremental updates: one full index plus one cumulative delta

- **Full** (`tips = [tip]`): every path.
- **Delta** (`tips = [tip, baseTip]`): only the paths that some first-parent commit in `(baseTip, tip]` changed, together with its tip's counts. A delta is cumulative against its full base, not chained. It supersedes the earlier deltas of the same base, and a reader never needs more than two artifacts.

The writer's choice, from its local repository and the manifest list (it never downloads an index):

1. **Base.** The newest full index from a current member whose tip is on the new tip's first-parent chain. The log pass stops when it reaches that tip.
2. **Delta.** If a base exists and the delta is smaller than half the base's size, publish the delta.
3. **Full.** Otherwise publish a full index, superseding every live history index. So a small repository, whose index fits in one chunk, simply republishes in full.

**Cost.** The cumulative delta grows until it reaches half the full index, then the next push publishes a full one. A push therefore pays at most one index of about half the full size plus a manifest, and usually one small chunk plus a manifest.

**Which pushes publish.** Only pushes that move the **default branch** publish an index; other branches fall back to the walk. Other branches are not indexed because their listings are rare, and each index is a manifest (about 0.001 DASH) that a push to any branch would otherwise pay.

### Reader (forge-web)

The browse resolve already reads the repository's whole manifest list, so the kind-3 manifests cost no extra query.

**Candidates.** A candidate is a kind-3 pack whose representative copy is from a **current member**. `packManifest` can only be written by a maintainer or writer (`ownerRefersTo`), and a revoked writer's claims no longer count.

**For a listing at tip `T`:**
1. **Index for `T`.** When a candidate indexes `T`, load it: one ranged artifact read, plus its base for a delta. Both are content-addressed and cached in IndexedDB. The column then fills with **no history walk**.
2. **Index for an older tip.** Walk first-parent from `T` as before, and stop at the first commit some candidate indexes. The walk settles the names changed on the way, and the index answers every other name. Only the commits between the index tip and `T` are read.
3. **No index reached.** The walk is the fallback. When it stops at its window, a name no walked commit changed reads **"not changed since \<date of the oldest commit walked\>"**, and a **Search older history** control continues the walk 400 commits at a time.

**Every directory listing** gets the column, including subdirectories. The index costs them nothing more. Without an index they walk, like the home.

### Commit count

The ref bar reads the count from the same index:
- **Exact** when the index covers `T`, for example "33,553 commits".
- **Behind:** the index count plus the commits walked from `T` down to the index tip. That sum is exact when none of the walked commits is a merge. Otherwise it is a lower bound shown as `N+`, because a merge brings in commits the first-parent walk does not see.
- **No index reached** within 100 commits: `100+`, as before.

### Trust model

The column and the count are the **pusher's claim**, like the rest of the browse index. The reader cannot check them without the walk the index replaces. Two things limit that:
- only a current member's index counts;
- each row links to its commit, whose own page shows what it changed.

The UI says where the numbers come from: the cell's and the count's tooltips name the push-time history index.

## Backfill and import

- **`dg repo reindex <repo>`** also publishes the history index when the default branch's tip has none. It computes the index in the local clone: the current directory's repository, or `--git-dir`, which must hold the tip. It prices the index with the locator part before asking, and reports what it spent.
- **forge-import** gets the index from its code push, through the helper. After the push, it checks that an index covers the default branch's tip. If none does (for example, a freshly created repository whose config the helper's first read did not see yet), it publishes one from its work mirror, with the cost inside `--max-spend`.

## Measured size and cost

| repository | paths | commits (all / first-parent) | referenced commits | index (gz) | chunks | quoted fee, Platform |
|---|---|---|---|---|---|---|
| dashpay/dash `develop` @ 3ba0805c | 5,117 | 33,553 / 7,979 | 613 | 66,965 B | 5 | ~0.0249 DASH (measured 0.02479) |
| junegunn/fzf `master` | 178 | 3,746 / 3,488 | 106 | 6,925 B | 1 | ~0.0044 DASH |
| dtolnay/anyhow `master` | 62 | 931 / 668 | 43 | 2,490 B | 1 | ~0.0032 DASH |

A delta on dash: 202 B at 1 commit, 1.4 KB at 10 and 6.5 KB at 50, all one chunk. With your own storage only the manifest is on chain (~0.0016 DASH quoted). More in [`docs/guides/costs.md`](../guides/costs.md#history-index).

## Contract proposal for the fresh registration

None is needed: kind 3 works on today's contracts, and nothing in the schema would make it cheaper.

- **An inline `data` byteArray on `packManifest`** would save the one chunk document a small index costs, about 0.001 DASH per push. But every browse resolve reads the whole manifest list, and superseded manifests stay in it forever. Every page load would then download every index ever published. Rejected.
- **A `kind` enum** (`[0, 1, 2, 3]`) would document the kinds but forbid any future one without a contract update. Not proposed.
