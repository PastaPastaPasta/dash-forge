# History index: last-change column, exact commit count, and path versions

Status: v1 (the column and the count) shipped in #146. v2 (per-path version lists for Blame and History) is implemented on branch `feat/history-index-v2-path-versions`; see [v2: per-path version lists](#v2-per-path-version-lists).

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
- `offsetIndexParts` = the index's format version: 2 for an index with per-path version lists, 0 from a v1 writer. A kind-3 artifact locates itself, so the field is otherwise unused, and no reader validates it for kind 3. The writer reads it to tell a v1 index from a v2 one without downloading either, and the web prefers a v2 index at a tip. The contract rework at the next wipe (beta.7) drops `offsetIndexParts` and `manifestPart`, so the format moves to whatever field replaces them; one place reads it on each side (forge-core `HistoryEntry::format`, forge-web `PackManifest.historyFormat`);
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

### v2: per-path version lists

v1 gives each path its newest change. Blame needs every version of a file, and a path's History needs a page of its changes. Both walked first-parent history in the browser: Blame of dashpay/dash's `src/clientversion.h` took 121 s and 427 DAPI requests. v2 adds the lists to the same artifact, as the extension section with **tag 1**, and writes `version` = 2:

```text
limit v | oidLen u8
nAuthors v | (len v | name)*                   distinct author names
(author v)*                                     one per commit of the table, in its order
per path row, in row order:
  (count << 1 | complete) v | (commit v | mode v | oid prefix (oidLen))*
```

- **The list.** For each path, its newest first-parent changes, newest first, at most `limit` (**256**): the commit (an index into the commit table, which now holds every listed commit), the path's mode after it, and for a blob mode (a file or a symlink) the first `oidLen` (**6**) bytes of its blob oid. A directory's or a gitlink's entry has no oid.
- **`complete`** says the list reaches the commit that added the path, so nothing older changed it. A deleted and re-added path's list ends at the newest add, as the History walk does. A count of 0 without `complete` means "unknown".
- **Authors.** Each commit's author name, as the web's `parseIdent` reads it, so History and Blame rows render without reading commits.
- **Semantics.** The same rule as the column, so the list's head is the column's commit. The one log pass collects each path's changes until its list is full or complete, then git is stopped. A tree-to-blob type change is two raw lines (a delete and an add) and counts as one change, as the web's `mode:oid` comparison sees it.

**Why 256, and why prefixes.** Measured on dashpay/dash `develop` @ 3ba0805c (5,117 paths, 8,363 first-parent commits):
- `src/clientversion.h` has 136 versions and `src/validation.cpp` 490. At the K = 32 first proposed, Blame of `clientversion.h` would still walk 1,947 commits.
- Blame compares at most 200 versions (201 entries), so 256 covers every Blame the web finishes and six History pages. Only 22 of 4,711 files have more than 201 versions.
- Whole 20-byte oids do not compress: the full index would be ~1.3 MB, or 91 chunks. A 6-byte prefix (git's own abbreviation length in large repositories) halves that.
- The web resolves a prefix through the object locator it already holds (`findByPrefix`). Only an unambiguous match is used; otherwise that version's trees are read as before. Whatever it then reads is hash-checked like every object.

**Delta merge rule.** A delta's list for a path holds only the changes since its base's tip. The reader overlays it on the base (`overlayVersions` in forge-web, `overlay_versions` in forge-core; both are tested on the same git-built fixtures, `forge-contracts/fixtures/history-index-v2-{base,delta,tip}.hex`):
1. A path the delta does not list is unchanged: the base's list stands.
2. A path whose delta list is complete was added since the base: the delta's list is its whole history.
3. Otherwise the delta's changes come first, then the base's list, deduplicated by commit and cut to `limit`. The result is complete when the base's list was and nothing was cut.
4. A path the delta lists without a list of its own (a v1 writer's delta) is unknown, and falls back to the walk.

A v1 base under a v2 delta leaves only the delta's lists; two v1 indexes leave none.

**Writer rules (the format marker).** A v1 index neither covers a tip nor serves as a delta base, because a delta over it would leave every unchanged path without a list. So the next push, or `dg repo reindex`, publishes a full v2 index that supersedes it. `dg repo reindex` says so: "replaces the tip's v1 index, which has no per-path version lists". A delta also supersedes any v1 index of its own tip. The web ranks a tip's indexes by format first (v2 over v1), then full over delta, then newer. That way a v1 full index left live beside a v2 delta cannot hide the lists.

**Writer bounds.** Both decoders refuse, whole, an index with over 4M rows (commits, paths or version entries) or a body inflating past 64 MiB. That would lose the column and the count too. So the writer checks both before publishing. When the lists push it over, it halves the per-path limit and rebuilds from the same log pass until the index fits. The result is still v2: a reader accepts any limit, and a v1 index would not cover the tip. If it does not fit even at one version per path, the push notes the skip.

**Decoders.** forge-core's decoder is the reference. forge-web's refuses the same bytes: a non-UTF-8 subject or author, a mode past 32 bits, every bound. It also refuses a varint past 2^53, which a JS number cannot hold and no honest writer writes. It decodes the versions section only when Blame or History first reads it, so a cold home that only needs the column skips that work. A malformed section then costs the lists, not the column.

**Reader.** `pathVersions(reader, start, path)` (forge-web `lib/view/path-history.ts`) serves Blame and a path's History:
1. When an index covers `start`, its list answers with no walk. The list is used only when the path's entry at `start` is what the list's newest version claims: its mode and blob oid prefix for a file. For a directory or a gitlink the index stores no oid, so only the mode can be checked. This is one read of the trees along the path, which the view has already read.
2. Later pages go on inside the list, since a start that is a listed commit resumes there, but only where the path's entry at that start is again what the list claims. A list's commits are keys for every view of the repository, so a wrong list must not answer another branch. Past the end of a list that is not complete, the walk goes on from the oldest listed commit's parent. A list naming a commit that cannot be read is dropped, and the walk takes over from the last position the trees checked.
3. With no index at `start`, it walks, and stops at the first commit an index covers (an index a few pushes behind) to go on from its list.
4. An index that is missing, fails to load, has no list for the path or does not match leaves the walk as the answer.

Blame then reads each version's blob by oid (one object read), with four read ahead, and reads no commit or tree. The exception is the commit that added the file, which is checked for a rename as before. It keeps only the texts it is about to compare, and reads nothing ahead once every line has its commit. A blob the index names that cannot be read as the file's text sends that one version back to the trees. Only a version the trees name can make Blame refuse.

### Semantics: the same as the web walk

For every path in the tip's tree (files, symlinks, gitlinks **and directories**, keyed by full path), the index names the newest first-parent commit whose tree entry at that path differs in `mode:oid` from its first parent's. A root commit adds everything. This is what `lastCommitsForDir` computed. It is also what one pass of `git log --first-parent --diff-merges=first-parent --no-renames --root -t --raw -z` reports: `-t` lists changed trees, `--no-renames` turns a rename into a delete plus an add, and first-parent diffs show a merge as what it brought into the branch. The pass streams, and it stops as soon as every path has a commit.

### Incremental updates: one full index plus one cumulative delta

- **Full** (`tips = [tip]`): every path.
- **Delta** (`tips = [tip, baseTip]`): only the paths that some first-parent commit in `(baseTip, tip]` changed, together with its tip's counts. A delta is cumulative against its full base, not chained. It supersedes the earlier deltas of the same base, and a reader never needs more than two artifacts.

The writer's choice, from its local repository and the manifest list (it never downloads an index):

1. **Base.** The newest live full index from a current member whose tip is on the new tip's first-parent chain, tried newest first. The log pass stops when it reaches that tip.
2. **Delta.** If a base exists, publish the delta while it pays. When a full index is due but the delta is still at most half the base, the delta is kept as a fallback. If the push's cost guard declines the full index, the push asks again with the delta, and publishes it if accepted; the full index waits for a later push or `dg repo reindex`. Without this, a declined full index would refuse a push that stores a pack, and leave a push without one with no index at all. That means it is at most half the base's size, and the deltas already published over that base plus this one have cost no more than the base's size. The deltas counted are every v2 delta a current member published over the base's tip, superseded ones included, since each was paid for. This is a rent-or-buy rule. Deltas are cumulative, so their total cost grows with the square of the pushes. Stopping once they have cost one full index spends at most twice the best schedule, and with deltas that grow about linearly it lands near the best point. The earlier rule (under half the base) cost little with v1's 67 KB index. With v2's 753 KB it would have let one-commit pushes climb to ~0.14 DASH each.
3. **Full.** Otherwise publish a full index, superseding every live history index. So a small repository, whose index fits in one chunk, simply republishes in full.

**Cost.** The cumulative delta grows until the deltas have cost one full index, then the next push publishes a full one. A push therefore pays at most one index of half the full size plus a manifest, and usually one small chunk plus a manifest. On dashpay/dash that means about 80 one-commit pushes per full index, ~0.009 DASH a push on average ([costs](../guides/costs.md#history-index)).

**Which pushes publish.** Only pushes that move the **default branch** publish an index; other branches fall back to the walk. It is published after the refs are read back: only when the default branch reads at the tip the index describes, so a rejected or raced default branch gets none. A config that cannot be read skips it rather than guess the branch. A push that reuses a recorded pack still publishes it, and its price is added to the guard. A shallow clone publishes none, because its history is cut off. The index reads the real object graph, ignoring replace refs and grafts, and the log streams: git is stopped as soon as every path is settled. Other branches are not indexed because their listings are rare, and each index is a manifest (about 0.001 DASH) that a push to any branch would otherwise pay.

### Reader (forge-web)

The browse resolve already reads the repository's whole manifest list, so the kind-3 manifests cost no extra query.

**Candidates.** A candidate is a kind-3 pack whose representative copy is from a **current member**. A delta counts only while a live full index of its base tip stands behind it. If two indexes cover one tip, a full index wins over a delta, and the newer wins between two of the same kind. An index that fails to load (a missing artifact, bad bytes) counts as none: the column walks and the count walks on. Artifacts inflate to at most 64 MB. `packManifest` can only be written by a maintainer or writer (`ownerRefersTo`), and a revoked writer's claims no longer count.

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
- **forge-import** gets the index from its code push, through the helper, which it tells the default branch (`DASH_FORGE_DEFAULT_BRANCH`, honoured only in a push forge-import spawned). After the push, it checks that an index covers the default branch's tip. If none does (for example, a freshly created repository whose config the helper's first read did not see yet), it publishes one from its work mirror. The cost stays inside `--max-spend`, and a Platform fallback's budget includes the index's chunks (the `platform` event's `historyBytes`).

## Measured size and cost

**v2** (dashpay/dash `develop` @ 3ba0805c, computed from a full clone with `measure_a_real_repository`):

| | index (gz) | chunks | quoted fee, Platform | your own storage |
|---|---|---|---|---|
| full, 5,117 paths, 5,450 commits referenced, 54,128 versions | 752,738 B | 52 | ~0.285 DASH (first index of a repository; ~0.2843 after) | ~0.0016 DASH |
| delta, 1 commit | 236 B | 1 | ~0.0026 DASH | ~0.0016 DASH |
| delta, 10 commits | 1,926 B | 1 | ~0.0031 DASH | ~0.0016 DASH |
| delta, 50 commits | 12,301 B | 1 | ~0.0060 DASH | ~0.0016 DASH |

Computing it takes about 1.5 s. Deltas grow by ~240 B per first-parent commit (47,685 B at 200 commits, 101,682 B at 500, 288,406 B at 1,500), so the rent-or-buy rule publishes a full index about every 80 one-commit pushes. A browse home loads the index for its column in one chunk query either way (52 chunks fit in one 100-row query), but it now downloads ~750 KB where v1 downloaded 67 KB. It is cached in IndexedDB after the first load.

**Offline replay** (`forge-web/lib/view/history-replay.test.ts`: the real `BrowseReader` over the pack a push of that tip builds, reading chunk documents as the browser does, at 280 ms per query):

| | walk | with the v2 index |
|---|---|---|
| Blame `src/clientversion.h` (135 versions compared, 10 commits) | 357 chunk queries, ~102 s | **16 queries, ~3.9 s**, the same hunks |
| History `src/validation.cpp`, first page (40 commits) | 22 queries, ~6.3 s (276 commits walked) | **3 queries, ~0.9 s**, the same commits |

The live baseline for that Blame on devnet moutai was 121 s and 427 requests; the showcase mirror holds many packs, not one. The live measurement after the change waits for the dash mirror's re-import on bonsia.

**Correction to v1's row below:** 33,553 / 7,979 were counted in a shallow clone. The full history has 34,001 commits, 8,363 of them first-parent. The shallow check (review M5) now refuses such a clone, and the next index published for the mirror carries the right counts.

**v1:**

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
