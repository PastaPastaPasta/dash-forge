# History index v2: per-path version lists for blame and History (proposal)

Status: proposed. It follows v1 (`docs/design/history-index.md`, branch `feat/last-change-index`) once v1 merges. Until then, blame and a file's History page walk first-parent history in the browser, behind one function, `pathVersions(reader, tip, path)` (`forge-web/lib/view/path-history.ts`). An index can then replace the walk without touching the views.

## Problem

v1 names, for every path in the tip's tree, the **newest** first-parent commit that changed it. That gives the file list its column, and a file's History page its first entry.

Blame needs more. Blame needs every version of the file, newest first, until each line has an owner. Today it walks first-parent history, reading one commit and the trees along the path per step, and diffs each version it finds. On dashpay/dash, `src/validation.cpp` took 59.9 s and 272 requests (the QA sweep, L-23), most of it spent finding the versions rather than comparing them.

## Proposal

For each path, the index lists the **newest K first-parent commits that changed its `mode:oid`** (K = 32 proposed), newest first. Each entry records:
- the commit, as an index into v1's commit table (subject and author time are already there);
- the path's blob oid **after** that commit. This is the version's content: blame reads it by oid through the locator, one ranged read per version, with no commit or tree reads.

Format: a v2 section after v1's paths, or a sibling kind 4 artifact, whichever the v1 author prefers. With front-coded paths already in v1, the section is per path: `count varint`, then `count × (commit varint, blob oid 20 B)`.

## Readers

- **Blame** gets its first K versions with no walk. Beyond K, it continues with the existing walk from the oldest listed commit (with progress, and Cancel keeping the partial result, as FG-4 ships).
- **History** gets its first page of a path's commits with no walk.
- **Commit column**: unchanged, since v1 already answers it.

## Size

dashpay/dash has 5,117 paths, and most change rarely: the median path has a handful of first-parent changes. The estimate is about 25 KB gzip extra per full index at K = 32, next to v1's 67 KB. Deltas stay small: only the paths changed since the base carry new entries, and those entries are the new commits prepended.

## Trust

The same as v1: the pusher's claim, counted only from a current member's index. Blame's lines are still diffed in the browser from blobs the reader hash-checks. Only *which* versions to compare comes from the index, and a wrong list can only misattribute lines, which git blame's own caveat banner already covers.

## Not proposed

- **Line-level blame precomputed at push:** it grows with every line of every file, a per-file artifact for each tip, and it can't be verified without the walk it replaces.
- **Unbounded version lists:** a hot file (a changelog) would dominate the artifact. K bounds it, and the walk covers the tail.
