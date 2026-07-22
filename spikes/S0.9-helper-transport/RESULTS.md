# S0.9 — git remote-helper transport & jj delegation (empirical spike)

**Date:** 2026-07-22  **git:** 2.52.0  **jj:** 0.43.0  **node:** 26.4.0 (helper impl language)

De-risks two design assertions in PRD 02 §A / architecture §5–6:

- **(A)** how a **connect-less** remote helper (`fetch`/`push`/`option`/`list`, *not* `connect`) must handle shallow/partial-clone bookkeeping.
- **(B)** whether **jj's git backend actually delegates a custom `dash://` scheme** to a `git-remote-dash` helper on PATH.

Everything below was produced by a real minimal helper (`./git-remote-dash`, ~230 LOC Node) that serves git objects out of a plain bare git repo standing in for the Dash backend — no Platform involved. Raw transcripts in `transcripts/`; the helper mirrors every stdin/stdout line to `$DASH_TRACE`.

---

## TL;DR verdicts

| Question | Verdict |
|---|---|
| Full clone / fetch / push via `fetch`+`push` caps | ✅ Works, `git fsck` clean, round-trips. |
| **Partial clone** (`--filter=blob:none`) via `fetch` cap | ✅ **Works** — git delivers `option filter` + `option from-promisor` to a connect-less helper; helper filters the pack and writes the `.promisor` marker; **lazy single-object fetch by bare OID works**. This is exactly the `objectLocator` ranged-read path. |
| **Shallow clone** (`--depth`, `--unshallow`) via `fetch` cap | ❌ **Not possible.** git sends `option depth` but there is **no output channel** for the helper to report shallow boundaries. Result is a **silent full clone** — no `.git/shallow`, no warning, no error, whether the helper answers `ok` or `unsupported`. Native shallow requires advertising `connect`/`stateless-connect` and speaking upload-pack. |
| ⭐ **jj works unmodified against `dash://`** | ✅ **Confirmed, stronger than assumed.** `jj git clone/fetch/push dash://…` all spawn `git-remote-dash` from PATH via jj's **gitoxide** transport — **colocation is *not* required** (it also works colocated). |

**Net impact:** PRD 02 §A's "**shallow via objectLocator**" phrasing conflates two different git features. **Partial clone is achievable through the `fetch` capability** as written. **Shallow (depth-limited history) is not** — drop it, or add `stateless-connect` (protocol-v2 upload-pack emulation) in a later phase. The ⭐ jj claim is safe to keep and can be strengthened.

---

## Part A — connect-less helper shallow/partial mechanics

### A.0 Capability set under test

The helper advertises exactly what PRD 02 §A specifies (the git-remote-ipfs/s3 family):

```
capabilities  ->  fetch \n push \n option \n list \n <blank>
```

No `connect`, no `stateless-connect`. That single choice determines everything below: with this set git **never** hands the helper a live packfile-protocol socket, so the helper never sees `want`/`have`/`shallow`/`unshallow`/`deepen` wire lines. It only ever sees the line-oriented helper commands.

### A.1 Full clone — the baseline dialog (`transcripts/A1-full-clone.trace`)

```
IN  capabilities
OUT fetch / push / option / list / <blank>
IN  option progress false          -> OUT ok
IN  option verbosity 1             -> OUT ok
IN  list
OUT 34dfa99… refs/heads/main
OUT 34dfa99… refs/tags/v1.0
OUT @refs/heads/main HEAD          (symref for HEAD)
OUT <blank>
IN  option cloning true            -> OUT ok
IN  fetch 34dfa99… refs/heads/main   (batch: one `fetch <sha> <name>` per want)
IN  fetch 34dfa99… refs/tags/v1.0
IN  <blank>
    [helper builds a pack of everything reachable from the wants and
     `git index-pack --stdin`s it into $GIT_DIR/objects/pack]
OUT <blank>                        (end-of-batch)
IN  <blank>                        (git closes the stream -> helper exits)
```

Result: 6 commits, `git fsck` clean. The `fetch` command carries **only wants** — there is no `have` negotiation in this capability. The helper is responsible for figuring out what to send (git's local odb is the cache; git simply won't re-request objects it already has, and `index-pack` dedupes).

### A.2 `git clone --depth 1` — depth is sent but SILENTLY IGNORED (`transcripts/A2-…`)

```
IN  option depth 1                 -> OUT ok          <-- git DOES deliver it
IN  option followtags true         -> OUT ok
IN  list …
IN  option cloning true            -> OUT ok
IN  fetch 34dfa99… refs/heads/main
IN  <blank>
OUT <blank>
```

Outcome measured:

```
.git/shallow           -> does not exist
git rev-list --count HEAD -> 5      (FULL history — depth ignored)
```

- git delivers `option depth 1` (the man page lists it), the helper says `ok`, **and git then does nothing with it** because the `fetch` command has **no way to output shallow boundaries**. The man page's `fetch` grammar allows only an optional `lock <file>` line and the terminating blank — there is **no `shallow <oid>` reply**, so git can never learn where to graft `.git/shallow`.
- **Replying `unsupported` to `option depth` changes nothing** (`transcripts` show identical full-clone outcome): git neither errors nor warns — it just produces a full clone.
- `git fetch --depth 1` into an existing repo: same — `option depth 1` sent, no `.git/shallow`, **no warning, no error**. `git fetch --unshallow` then fails with `fatal: --unshallow on a complete repository does not make sense` (because it was never shallow).

**Conclusion A.2:** a connect-less helper **cannot** serve a shallow clone. Depth requests are accepted and silently discarded by git itself. The only paths that carry real shallow/deepen negotiation are `connect` (git's native packfile protocol → the helper proxies a socket to an upload-pack-speaking server) and `stateless-connect` (protocol v2). Both require the helper to **be** or **emulate** an upload-pack server, i.e. speak `want`/`have`/`shallow`/`deepen`/`unshallow` pkt-lines — a fundamentally different implementation from `fetch`.

### A.3 `git clone --filter=blob:none` — partial clone DOES work (`transcripts/A3-…`)

Unlike depth, git delivers the filter **and** wires up promisor bookkeeping, and the connect-less `fetch` helper can satisfy it:

```
IN  option filter blob:none        -> OUT ok     <-- NOT documented in `man gitremote-helpers`,
IN  option from-promisor 1         -> OUT ok         but git sends it to the fetch capability
IN  list …
IN  option cloning true            -> OUT ok
IN  option filter blob:none        -> OUT ok     (re-sent per batch)
IN  fetch 34dfa99… refs/heads/main
IN  <blank>
    [helper runs `pack-objects --revs --filter=blob:none`, index-packs it,
     then WRITES pack-<sha>.promisor next to the .idx]
OUT <blank>
```

Two things the helper **must** do itself (git does *not* do them for a connect-less helper):

1. **Honor the filter** when building the pack (`git pack-objects … --filter=blob:none`). git trusts the helper; if the helper ignores the filter and sends all blobs, you just get a fat "partial" clone.
2. **Write the `.promisor` marker** (`$GIT_DIR/objects/pack/pack-<sha>.promisor`) for the pack it indexed. Without it, the very first checkout dies with `fatal: remote did not send all necessary objects` — git's connectivity check won't tolerate the filtered-out blobs unless the pack is marked as coming from a promisor remote. (git configures `remote.origin.promisor=true` / `partialclonefilter=blob:none` on its own; the per-pack marker is on us.)

Measured outcome after fix: clone succeeds, `git log --oneline` traverses **all 6 commits** (commits+trees present, blobs absent), and blobs materialize only on demand.

### A.4 Lazy single-object fetch — the `objectLocator` path, VALIDATED (`transcripts/A4-…`)

Touching a filtered-out blob triggers a fresh helper invocation:

```
IN  option filter blob:none
IN  option from-promisor 1
IN  list
IN  fetch f1f36270…  f1f36270…      <-- want is a BARE BLOB OID (name == oid, not a ref)
IN  <blank>
    [helper packs exactly that object, 51-byte pack, index-packs it]
OUT <blank>
```

- This **contradicts the man page**, which says "*Only objects which were reported in the output of `list` with a sha1 may be fetched this way.*" For a promisor repo git **does** request arbitrary object OIDs through the `fetch` capability. So single-object / ranged reads are reachable through exactly the capability set PRD 02 already specifies.
- Implementation note that fell out of the spike: **do not branch on `from-promisor`** to decide "walk history vs. exact object." git sets `option from-promisor 1` on *both* the initial partial fetch (want = commit) and every lazy fetch (want = blob). One code path handles both: `pack-objects --revs --filter=<f>` — a commit tip walks history and drops blobs; an explicitly-named blob tip **survives the filter** and is returned alone. (git also sends the option **value as `1`, not `true`** — parse accordingly.)

### A.5 Push round-trips (`transcripts/A5-…`)

```
IN  list for-push
IN  push 2b4f0fc…:refs/heads/main
IN  <blank>
OUT ok refs/heads/main
OUT <blank>
```

Standard `push +<src>:<dst>` batch; helper transfers objects local→backend and updates the backend ref, replies `ok <dst>`. Nothing surprising — confirms the push half of the capability set is straightforward.

### A.6 Recommendation for `git-remote-dash`

**Advertise `fetch push option list` (as PRD 02 already says). Then:**

- **Full clone/fetch/push:** implement as-is. Helper owns want-set → manifest selection → chunk fetch → pack reassembly → `index-pack`. git owns ref updates and odb dedup.
- **Partial clone (`--filter=…`): SUPPORTED, and it is the mechanism behind "browse plane" single-object reads.** The helper must (a) parse `option filter <spec>` and `option from-promisor 1`, (b) produce a filtered pack, and (c) **write the `.promisor` marker** for every pack it indexes during a filtered/promisor fetch. Lazy fetches arrive as `fetch <oid> <oid>` with bare OIDs → resolve each OID against the `objectLocator` and do the ranged `chunk`/HTTP-Range read. **This validates architecture §5's "Partial/shallow clone & single-object reads via the merged `objectLocator`" for the *partial* and *single-object* cases.**
- **Shallow (`--depth`, `--deepen-*`, `--unshallow`): NOT SUPPORTED through this capability set, and cannot be made to work by the helper.** Recommended handling:
  - **v1:** detect `option depth` / `option deepen-*` and **fail loudly** — reply `error depth is not supported by dash:// (use --filter=blob:none for a lightweight clone)` rather than let git silently produce a full clone that the user *thinks* is shallow. (git ignores `unsupported` silently, so surface it as an `error`/stderr message from the fetch step instead.)
  - **If shallow is ever a hard requirement:** it requires advertising `stateless-connect` and implementing a **protocol-v2 upload-pack emulator** inside the helper (respond to `command=fetch` with `shallow-info`/`want`/`have`/`deepen`/`unshallow` pkt-lines, driving the same manifest/chunk backend). This is a materially larger surface (pkt-line codec + v2 command dispatch + shallow grafting) and should be its own scoped item, not folded into the `fetch` helper.

**Design-doc correction:** PRD 02 §A currently says partial/shallow clone is achieved "via the merged `objectLocator`" and adds a note that `option depth`, `.git/shallow` grafting and `--unshallow` "must be implemented in the helper itself." The spike shows the second half is **infeasible for a `fetch`-capability helper** — the helper is never given the channel to report shallow boundaries, so it *cannot* implement depth no matter how much code it writes. `objectLocator` powers **partial clone + single-object reads** (✅), not **shallow/depth** (❌ without connect/stateless-connect).

---

## Part B — jj delegation to `git-remote-dash`

**jj version:** `jj 0.43.0` (Homebrew). jj 0.43 performs git remote operations through **gitoxide (`gix`)**, not libgit2.

### B.1 Non-colocated `jj git fetch dash://…` → helper fires (`transcripts/B1-…`)

```
$ jj git init            # NOT colocated: no real .git working tree, jj-native store
$ jj git remote add origin dash://alice/project
$ jj git fetch --remote origin
  bookmark: main@origin [new] untracked
  tag: v1.0@git [new]
```

Helper trace confirms jj drove the **identical protocol** as git (capabilities → option → list → `fetch <sha> <name>` batch → blank). jj even sends the same trailing `option depth 0` / `option deepen-relative false` resets. **jj's gitoxide transport spawns `git-remote-dash` from PATH for the unknown `dash://` scheme.**

### B.2 Non-colocated `jj git push dash://…` → helper fires (`transcripts/B2-…`)

```
$ jj new main -m "jj push via dash"; echo … > jjfile.txt; jj bookmark set main -r @
$ jj git push --remote origin --bookmark main
  bookmark: main [move forward from 2b4f0fc66a17 to 1e2db989315c]
```

Helper saw `list for-push` → `push 1e2db989…:refs/heads/main` → replied `ok refs/heads/main`; backend `main` advanced to the jj-authored commit. **Push works end-to-end.**

### B.3 `jj git clone dash://…` → helper fires (`transcripts/B3-…`)

```
$ jj git clone dash://alice/project jjclone
  Fetching into new repo …
  bookmark: main@origin [new] tracked
  tag: v1.0@git [new]
  Added 8 files … working copy now at a7aa7597
```

Full clone + working-copy materialization straight from the helper.

### B.4 Colocated mode also works, both ways (`transcripts/B4-…`)

```
$ jj git init --colocate         # maintains a real .git alongside jj store
$ jj git fetch --remote origin   # -> helper fires (jj path)
$ git  fetch origin              # system git in the same repo -> helper ALSO fires
```

Both jj's own gitoxide path **and** plain `git` inside the colocated repo delegate to the helper. So the colocated route is a redundant safety net, not a requirement.

### B.5 jj verdict

**The ⭐ "jj works unmodified against `dash://`" claim is CONFIRMED — and is stronger than the design assumed.** It does **not** depend on colocation or on borrowing the system git binary: jj's native gitoxide transport itself execs `git-remote-<scheme>` helpers on PATH. Clone, fetch, and push all work against a stock `git-remote-dash`.

Caveats to record:
- Verified on **jj 0.43.0 / gix**. gitoxide's remote-helper support has evolved fast; **pin a `jj` floor version in docs and add a CI smoke test** (`jj git clone dash://… && jj git push`) so a future gix change can't silently break the claim.
- jj inherits Part A's limits verbatim: **no shallow** (jj sends `option depth 0` = full anyway), and partial-clone behavior would ride the same `filter`/`from-promisor` path.

---

## Impact on PRD 02 / implementation plan

1. **PRD 02 §A — split "shallow/partial" into two claims.** Keep **partial clone (`--filter`) + single-object reads via `objectLocator`** as a supported v1 feature over the `fetch` capability. **Remove or defer "shallow/depth."** Replace the current parenthetical ("*`option depth`, `.git/shallow` grafting, and `--unshallow` deepening must be implemented in the helper itself*") with: *depth/shallow is not expressible through the `fetch` capability (no shallow-boundary reply channel); it requires a `stateless-connect` protocol-v2 upload-pack emulator, scoped separately if ever needed.*
2. **PRD 02 §A helper protocol — add two must-dos discovered here:** (a) honor `option filter` in pack construction; (b) **write the `.promisor` marker** on every pack indexed during a filtered/promisor fetch (without it, checkout of a partial clone fails). Note that lazy fetches arrive as `fetch <oid> <oid>` with bare OIDs and that `from-promisor`'s value is `1`, not `true`.
3. **PRD 02 §A — v1 UX for depth:** make `git clone --depth N dash://…` **fail with a clear error** instead of silently cloning full history. (Reference: `forge-core` `PackPipeline`/helper fetch step.)
4. **jj claim — strengthen and protect it.** Document it as "works via jj's gitoxide transport (no colocation required), verified on jj ≥ 0.43." Add the `jj git clone/push` smoke test to CI (architecture §7 conformance harness is the natural home).
5. **forge-core `PackPipeline` (PRD 02 §C.3)** must expose a filtered-pack build and an OID-addressed single-object fetch — both are now proven necessary and sufficient for browse-plane reads without any shallow machinery.

---

## Artifacts in this directory

- `git-remote-dash` — the minimal working helper (Node, executable). Env: `DASH_BACKEND_ROOT` (dir of bare "backend" repos), `DASH_TRACE` (protocol log), optional `DASH_UNSUPPORTED` (comma-list of options to force-reply `unsupported`, used to test depth rejection).
- `transcripts/` — trimmed real protocol logs A1–A5 (git) and B1–B4 (jj).

### Reproduce

```bash
export PATH="$PWD:$PATH"                 # put git-remote-dash on PATH
export DASH_BACKEND_ROOT=/tmp/backends
mkdir -p $DASH_BACKEND_ROOT
git init --bare -b main $DASH_BACKEND_ROOT/alice__project
# … push some history into that bare repo …
export DASH_TRACE=/tmp/dash.trace
git clone dash://alice/project            # full clone
git clone --filter=blob:none dash://alice/project   # partial clone (works)
git clone --depth 1 dash://alice/project  # depth silently ignored (full clone)
jj  git clone dash://alice/project        # jj delegates to the helper
cat $DASH_TRACE                           # inspect the dialog
```
