# Platform parity: gap matrix, CI, performance and the final contract revision

Status: proposal, 2026-09-27. Companion to `review-parity-spec.md` (PR review is specified there and is not repeated here), `ux-dx-spec.md`, `contracts/forge-v2.md` and `security/private-repos.md`. Where this document and the review spec disagree on an index, this document wins, because it fixes the **final** index set for the one forge-core/forge-collab revision that ships before mainnet.

Baseline: `origin/master` @ `e546f82` (PRs #47, #48, #50, #52, #53 merged; #51, #54, #55 open), forge-collab `BMfPmaEiMqDp64NDa4Am79VoRpZ9MPVNnCUy6i3UiyWi` on moutai. Every Platform claim below was checked against `dashpay/platform` `v4.2.0-beta.4` (the commit `Cargo.lock` pins, `~/.cargo/git/checkouts/platform-*/6c95cd8`) and the workspace book at `/Users/pasta/workspace/platform/book/src`. Anything not found in source is marked **UNVERIFIED**. QA evidence is cited by defect id (`/Users/pasta/workspace/dash-forge-qa/evidence/*/REPORT.md`).

Constraints (all verified): one document operation per state transition (`SystemLimits.max_transitions_in_documents_batch = 1`, `rs-platform-version/.../system_limits/v4.rs`); 5 KiB per field, 20 KiB per signed transition; 100 documents per page and at most 100 values in an `in` (`rs-drive/src/config.rs:18`, `query/conditions.rs:361`); no document push subscriptions (`platform.proto` has no Platform stream RPC); **150 requests per minute per IP** at the DAPI gateway (`dashmate/configs/defaults/getBaseConfigFactory.js:242-257`, `unit: 'minute', requestsPerUnit: 150`), and the SDK bans a rate-limited node for the `ratelimit-reset` period instead of waiting (`rs-dapi-client/src/dapi_client.rs:205-235`). Indexes and every countable/ranked/indexOnly flag are frozen at registration (`validate_index_definitions_unchanged`, `document_type/methods/validate_update/v1/mod.rs:465-510`); new document types and new optional properties may be added by an in-place update.

---

## 0. Decisions in one screen

| # | Decision |
|---|---|
| S-1 | **Rate limit is a page budget.** Every page ≤ 25 DAPI requests cold and ≤ 8 warm; every CLI command ≤ 15 + O(pages of new data); the inbox poller ≤ 12/min. A shared client-side token bucket (120/min) gates every request, and a `ResourceExhausted` waits for `ratelimit-reset` instead of banning the node. |
| S-2 | **Composite queries carry every list page and the repo chrome.** One `documents.composite` per page: the page documents plus counts, member docs, DPNS names and profiles under one proof (§3.3). This removes every DPNS, count and member N+1. |
| S-3 | **Append-only delta caches.** `refUpdate`, `protectedRefUpdate`, `config`, `packManifest`, `event`, `authorEvent`, locator fragments and chunks are immutable and non-deletable, so a client caches them (IndexedDB; `~/.cache/dash-forge` for the CLI) and reads only `$createdAt > cursor`. Ref resolution, the state fold and pack lists become O(new rows), not O(history). |
| S-4 | **Open/closed counts stay a client fold** (§5.2). Consensus cannot count them; a summary document would be an unverified second copy. The fold runs over the cached feed, so it is exact and cheap; the header shows the countable total and the folded open count. |
| S-5 | **CI = plug-in trust model + a user-run `forge-runner` built on nektos/act** (§2). Any runner posts `checkRun` documents under a `runner` membership with a key bound to `(forge-collab, checkRun)`; the first runner we ship is a GitHub Action, the second is a Docker image users run. |
| S-6 | **Trending is a separate, optional `starBeat`** (decided in C-1 from moutai measurements, §4.4). Fusing the window index into `star` would make `$createdAt` required, and an indexOnly delete must then carry the exact `$createdAt`, which only a permanent `$createdAt` index could give back: measured +86 % per star, far over the 15 % gate. So `star` stays permanent and unstar-safe (plus a ranked axis for all-time "most starred", +2 %), and a star optionally writes a `starBeat` (≈ 15 M credits) whose weekly window index expires through its index-level `ttl`. On by default; a preference and `--no-trending` turn it off. |
| S-7 | **One final revision**: forge-core gets an in-place update (new `runner`, `topic` types; ids unchanged) and forge-collab gets one new registration (§6). Nothing else touches the schema before mainnet. |
| S-8 | Out for launch, said so in the UI: packages, Projects, Discussions, wiki, GitHub Pages equivalent, email, auto-merge, global code search, repo transfer, reactions, LFS. |

---

## 1. Gap matrix

Priority: **P0** launch (mainnet public beta), **P1** next, **P2** later, **out** deliberately. "Contract" = needs a schema change (all batched into §6). File citations are `forge-web/`, `crates/` on `origin/master` unless stated.

### 1.1 Code browsing

| Feature | Today | Pri | Contract | Data model / notes |
|---|---|---|---|---|
| Tree, blob, README, syntax highlighting, branch/tag switcher | Done: `components/repo/{tree,blob,repo-home}-content.tsx`, `ref-switcher.tsx`, lazy Shiki (`lib/view/highlight.ts`). Blob view lacks `#L` anchors and image preview (D-304), no virtualisation (D-315), README relative links broken (D-303) | P0 polish | no | Browse plane (`packManifest` kind 1/2 artifacts). Fix D-303/304/315. |
| Raw / download | "Raw" is a download of the verified blob (`blob-content.tsx:118-155`) | P0 | no | Add a `/raw` short URL that streams the verified bytes with `Content-Disposition`; no server, so it is the same in-browser blob URL. |
| Permalinks (`/blob/<oid>/path#L10-L20`) | Missing (`lib/short-url.ts` has no oid form) | P0 | no | Short-URL shim accepts `/alice/p/blob/<40-hex>/path`; a `y` keypress rewrites the ref to the commit oid, as GitHub. |
| History per path | Done (F-5): `logPage` with a path (`lib/view/path-history.ts`), first-parent, a session memo per reader | P1 | no | Client walk comparing the path's entry per commit (cap 2,000 commits a page, resumable), memoized for the session. |
| Blame | Done (F-5): `lib/view/blame.ts`, matches `git blame --first-parent` (git's xdiff compaction ported) | P1 | no | Client-side over the path history above; ≤ 2 MiB files, ≤ 200 versions, yields between versions (no worker needed), Cancel. |
| Commits list beyond 40 | Done (F-5): "Older" pages through one read-ahead walker (`commits-content.tsx`) | P0 | no | "Older" pages the walk 40 at a time; commit objects cached in the ObjectLru/IDB. |
| Compare view (`/compare/base...head`) | Only inside the PR flow (c1 `pull-diff.tsx`) | P1 | no | Reuse `loadPullComparison` with two refs of one repo or a fork. |
| Search in repo (filenames, content) | Filenames only via `flatIndex`; content search not built (`ux-dx-spec` §5.11) | P0 filenames, P1 content | no | Content: materialise ≤ 100 MB in a worker, MiniSearch, IDB-persisted. |
| Search across repos (code) | Missing | out | — | Needs an indexer nobody runs. Cross-repo *issue* search: P1 via `issue.author`/`patch.author` for "mine" plus client MiniSearch over watched repos. |
| LICENSE detection | Missing | P1 | no | Client: read `LICENSE*` from the root tree, match against the SPDX list bundled in the app (≈ 60 KB). Shown in the About card. |
| Language stats | Missing (`lib/view/highlight.ts` maps extensions) | P1 | no | From `flatIndex` sizes by extension (linguist mapping bundled); no on-chain field. Per-language trending is client-side over the trending page (§4.3). |
| Submodules | Rendered as gitlink rows (`file-list.tsx`) | P1 | no | Link to `dash://` targets when `.gitmodules` names one. |
| Large files / LFS | Packs to user storage; no pointer scheme | out (launch) | no | Later: pointer files to the owner's bucket (roadmap "Later"). |

### 1.2 Issues

| Feature | Today | Pri | Contract | Data model / notes |
|---|---|---|---|---|
| Create / comment / close / reopen | Done (web `issue-content.tsx`, `dg issue`) | done | — | `issue`, `comment`, `event`/`authorEvent`. |
| Edit title/body, edit/delete own comment | Missing (D-216) | P0 | no (#48 made `$updatedAt` required) | `issue` replace by author; `comment` replace/delete by owner; "edited" when `$updatedAt > $createdAt`. |
| Labels: definitions, picker, colours | `dg label create` exists; web label input is free text (D-215) | P0 | no | `label` docs (newest per name); picker from `readLabels`; apply = `event` kind label. |
| Assignees | Not settable anywhere (D-201, D-503 family) | P0 | no | `event` kind assign/unassign with `value` = identity and **`refId` = assignee identity**, so the existing sparse `addressee (refId)` index answers "assigned to me" in one query. |
| Milestones | Missing | P1 | **yes**: `milestone` type | `milestone {repoId, title, description, dueOn, closed}` M/W-gated, newest per `(repoId, title)`; set/clear = `event` kinds 17/18 with `value` = title. |
| Templates | Missing | P1 | no | `.forge/ISSUE_TEMPLATE/*.md` (fallback `.github/`) read from the default branch at compose time; YAML forms P2. |
| Mentions (`@name`) | Not autolinked (D-223) | P1 | no | Render `@name` (DPNS) and `#n`; notification = the inbox scanning comments of watched repos for `@me` (already `scanAssignedAndMentions`, `lib/view/mine.ts:362`). |
| Cross-references and linking (`#12`, `alice/p#3`, "Fixes #12") | Missing (D-223, D-229) | P0 autolink, P1 backlinks/auto-close | no | `linked_issues` rule from the review spec §5.7; backlinks computed over the cached feed + comments of the repo. |
| Pin / lock / transfer | Missing (D-230) | P1 pin+lock; transfer out | no | `event` kinds 19 pin, 20 unpin, 21 lock, 22 unlock (members). Locked = clients hide the composer for non-members (fees remain the only floor; say so). Transfer = fork-and-archive. |
| Close via commit message | Missing | P1 | no | Merge dialog / `dg pr merge` offer "also close #n" (review spec P8); a plain push cannot close (no server): the helper prints the `dg issue close` line. |
| Search / filter / sort | Open/Closed/All only (D-217); state not in URL (D-913) | P0 | no | Client-side over the cached list + fold: author, label, assignee, milestone, text (MiniSearch); sort newest/oldest/most-commented (comment counts from the composite `counts`, §3.3)/recently-active (feed). Filters in the URL. |
| List beyond 100 | Capped (D-904) | P0 | no | Keyset paging on `(repoId, $createdAt)` with `$createdAt < last`, 50 per page, plus the countable total. |
| Reactions | — | out | — | Paid documents for an emoji; FAQ says so. |

### 1.3 Repository settings

| Feature | Today | Pri | Contract | Notes |
|---|---|---|---|---|
| Default branch | `config.defaultBranch`; no product path writes config after creation (`settings-content.tsx:9-10`) | P0 | no | Settings → General writes a new `config` (append-only, maintainer). |
| Branch protection (patterns) | Only the seed script writes `protectedPatterns` (D-503) | P0 | no | Same `config` write; `dg repo edit --protect 'refs/heads/main'`. |
| Rulesets (required reviews, checks, merge methods) | `policy` type registered (#48), nothing writes it | P0 | no | Settings → Branches (review spec §4.8); `dg repo policy set`. Client-enforced; labelled. |
| Visibility | Immutable at creation | done | — | By design (private-repos §1). |
| Archive | `config.archived` display-only; no writer | P0 | no | Config write; archived = every write button disabled client-side and the helper refuses pushes with E-code unless `--force`. Consensus cannot enforce it; say so. |
| Rename | `repo.name` immutable | P1 | no | Rename = new `repo` + `config` pointing `forkOf` at the old one, plus a `config.redirectTo` — **rejected**: it needs a new optional `repo.renamedTo` field (in-place update allowed). Decision: add `repo.renamedTo` (optional identifier) in the forge-core update (§6.1); old URLs redirect client-side. |
| Transfer | — | out (launch) | — | Fork-and-archive; `renamedTo` also serves "moved to". |
| Delete | v2 repos cannot be deleted | done | — | Archive instead. |
| Webhooks | `dg webhook add/list/remove` (relay) | P1 web UI | no | Settings → Webhooks reuses `webhooks.rs` shapes; relay-encrypted secret. |

### 1.4 Members, teams, organisations

| Feature | Today | Pri | Contract | Notes |
|---|---|---|---|---|
| Members (writer/maintainer) | Done (web + `dg collab`) | done | — | `maintainer`/`writer` (repo owner only). |
| Runner (CI) members | Missing | P0 | **yes**: `runner` type (forge-core) | §2.2. |
| Teams | Missing | P2 | no | A team = a DPNS-named identity that owns nothing; membership by convention. Real teams need consensus lookups through a `team` doc (anyOf operand) — deferred to "organisations". |
| Organisations | Missing | P2 (guide P1) | no | An org is an identity whose master key is held by a multisig-like ceremony (guide). Org-owned repos work today. |
| Audit log | Missing | P1 | no | Every write is on chain: Settings → Audit = the repo feed (`event`, `authorEvent`, `config`, `maintainer`/`writer` history via `documentsKeepHistory`? no — membership docs are deletable without history). Show config + events + `refUpdate` reflog; membership changes only as current state (say so). |
| CODEOWNERS | Missing | P2 | no | `.forge/CODEOWNERS`, reviewer suggestions only (review spec R10). |

### 1.5 Releases, tags, forks, stars

| Feature | Today | Pri | Contract | Notes |
|---|---|---|---|---|
| Releases list/view/create, assets in user storage | Done (`dg release`, web `new-release.tsx`); ordering bug D-305/D-909; yanked drops assets (D-504); imported sha256 "" (D-517) | P0 fixes | no | Newest per tag by `($createdAt,$id)`; sort by tag creation time, not import order. |
| Tags page | Done (`ref-list-content.tsx`) | done | — | |
| Protected tags | Missing | P1 | no | `protectedPatterns` already glob-match `refs/tags/*`; UI exposes it. |
| Signed commits / verification badges | Missing | P1 | no | Client-side GPG/SSH signature verification (openpgp.js, sshsig) against keys published in the author's `profile.links` (`gpg:<fingerprint>`) or `.forge/keys/<name>.pub` in the repo; badge states Verified/Unverified/No key. Never on chain. |
| Forks and network | Fork button + `dg repo fork` (c1/c2, #22); fork count via `repo.forkOf` countable | done; network page P1 | no | "Forks" page lists `forkOf == repo` (index exists); network = forks of forks by walking. |
| Stars | indexOnly `star`, O(1) count (#48) | done; trending §4 | **yes** (§4) | |
| Watch | Local subscriptions only (`lib/view/inbox.ts`) | P1 | **yes**: `watch` indexOnly type | Cross-device "watched repos"; the inbox seeds its subscriptions from it. |

### 1.6 Profiles, Explore, notifications

| Feature | Today | Pri | Contract | Notes |
|---|---|---|---|---|
| Profile (name, bio, avatar, links) | `profile` type exists; nothing writes it (D-908) | P0 | no | Settings → Profile; `dg profile set`. |
| Contribution graph | Missing | P1 | no | From `refUpdate.pusher (repoId, $ownerId, $createdAt)` across the identity's repos plus `issue.author`/`patch.author`/`comment.author`. Computed client-side, cached daily. |
| `/u?id=` | Only `?name=` (D-222) | P0 | no | |
| Explore: recent, my repos, my issues/PRs, stars | Done; capped 24 (D-903), 24 release queries (N+1) | P0 | no | Page recent repos with a `$createdAt <` cursor; releases via one composite sub-query. |
| Explore: trending, most starred | Missing | P0 (§4) | **yes** | |
| Topics | `repo.topics` stored; not shown, not indexable | P1 | **yes**: `topic` type | §6.1. |
| Notifications inbox | Done, local (`lib/view/inbox.ts`) | done | — | Poll budget: ≤ 12 requests/min (already `ROUND_BUDGET`). |

### 1.7 Wiki, Pages, packages, projects

| Feature | Pri | Notes |
|---|---|---|
| Wiki | out (launch); P2 | Git-backed at `refs/wiki/main` of the same repo (no second repo, no second contract cost); the web renders it like docs. Until then: `docs/`. |
| GitHub Pages equivalent | out | Would mean serving user HTML from user storage through forge.dashhq.org: a hosted origin for arbitrary content, which we do not run. A user can point their own domain at their bucket. |
| Packages | out | |
| Projects / boards | out (launch); P2 | Boards = saved filters over labels/milestones, local. |
| Discussions | out | Issues with a `discussion` label. |

### 1.8 Integration surface

| Feature | Today | Pri | Contract | Notes |
|---|---|---|---|---|
| Webhooks | Relay (`crates/forge-relay`), payloads not GitHub-parseable (D-605) | P1 fix | no | ids as strings, `repository.id` as string. |
| API / SDK for third parties | `dg api query` planned; the contracts are the API | P1 | no | `@dash-forge/sdk` = `forge-web/lib/{rules,repo}` published as a package; `dg api query <type> --where`. |
| CLI parity | `dg` covers auth/repo/issue/pr/release/label/collab/storage/webhook/import (`crates/dg/src/main.rs:101-190`) | P0 gaps: `issue edit/assign`, `repo edit/policy/archive`, `profile`, `ci`, `pr` items from the review spec | no | |
| Clone ergonomics | `dash://<id-or-name>/<repo>` (#50 DPNS, anonymous clone) | done | — | No https clone (no server). |
| Signed commits | see 1.5 | P1 | no | |
| Import from GitHub | `forge-import` (code, issues, PRs, comments, reviews, releases, labels) | done; fixes D-602/603/605/606 P0 | no | |
| Import from GitLab | Missing | P1 | no | Same `model.rs` source-neutral model (`crates/forge-import/src/model.rs`); a `source_gitlab.rs` over the REST API (issues, MRs, notes, releases, labels, milestones). Wiki import: out. |
| Export | Missing | P1 | no | `dg repo export`: a tarball of the clone + JSON of every document of the repo (proof-verified), the inverse of the import model. |

---

## 2. CI / Actions design

### 2.1 Recommendation

**(a) plus (b), in that order, and (b) is a wrapper around nektos/act, not a fork of actions/runner.**

- actions/runner is a client of GitHub's orchestration service (job acquisition, log streaming, the results API); forking it means re-hosting that service, which we will not run. nektos/act executes `.github/workflows/*.yml` locally in Docker from a synthesised event payload and is what a self-hosted "run my GitHub workflows here" needs.
- The protocol is the plug-in model: **any** CI (GitHub Actions, GitLab CI, Woodpecker, Jenkins, a shell script) reports a `checkRun` signed by an identity the repo authorises. `forge-runner` is just the first-party runner speaking that protocol.
- MVP = the plug-in path, because the beachhead persona (a GitHub mirror) already has CI on GitHub and only needs the results on Forge. The user-run runner comes second.

### 2.2 Trust model (contract change, §6)

- **`runner` membership** (forge-core, new type via in-place update): `{repoId, memberId}` unique `(repoId, memberId)`, index `byMember (memberId)`, created by the repo owner only (`propertyAgreement {"$ownerId": "$ownerId"}` against `repo`, exactly like `maintainer`), deletable = revoke. A runner can write `checkRun` and nothing else.
- **`checkRun` gate** becomes `ownerRefersTo anyOf [maintainer, writer, runner]` (three operands; up to four are allowed, meta-schema v3 `refersTo` expressions). `anyOf` operands are frozen, so this is part of the forge-collab re-registration.
- **Limited keys.** A runner identity is a dedicated identity (the owner mints it: `dg ci runner new`) whose working key is AUTHENTICATION/HIGH with `ContractBounds::SingleContractDocumentType {forge-collab, checkRun}` (`rs-dpp/.../contract_bounds/mod.rs:51`, variant 1), a budget (default 0.5 DASH) and an expiry (365 d) (`IdentityPublicKeyV1.total_budget/expires_at`, book `data-model/key-limits.md`). Two fences: the membership says *which repos*, the key bound says *which document type*. A leaked key can only post check runs, only to repos where the identity is a runner, only until the budget or expiry ends. `dg ci runner new` writes it as a `dfk1:` value to a 0600 file before registering it (`crates/dg/src/ci.rs`), with the runner identity's master key signing the one identity update; protocol 14 admits the bound on AUTHENTICATION keys (`validate_identity_public_key_contract_bounds` v2) and refuses anything else it signs with `ContractBoundedKeyOutOfBoundsError` (20014).
- A maintainer or writer identity may post checks too (gate operands 1–2), for a single-developer setup with no separate identity.
- Readers: `checkRun` rows are trusted only when the writer is a *current* runner/writer/maintainer (`RoleOracle`, same rule as approvals). Revocation deletes the membership; a replace of an existing run re-checks the gate (forge-v2.md §2), so a revoked runner cannot advance its runs.

### 2.3 `checkRun` document (final shape)

Existing fields stay (`repoId, headOid, name, status, conclusion, detailsUrl, summary`; `immutable [repoId, headOid, name]`). Additions (optional): `externalId` (string ≤ 120: the CI's own run id, for idempotent re-posting), `startedAt`/`completedAt` (dates), `artifacts` (string ≤ 4096: JSON `[{name, url, sha256, size}]`, the same shape as `release.assets`), `logUrl` (≤ 300) and `logSha256` (32 bytes). `$updatedAt` required (progress edits are replaces). `conclusion` enum `success|failure|neutral|cancelled|skipped|timed_out|action_required` (GitHub's set). Indexes: `head (repoId, headOid, $createdAt)` (exists), plus `recent (repoId, $createdAt)` for the repo's Checks tab. Newest per `(headOid, name)` wins; `status` progression `queued → in_progress → completed` by replace.

### 2.4 Discovering work without push subscriptions

A runner polls. The cost is bounded and predictable because the feeds are append-only:

| What | Query | Requests per poll |
|---|---|---|
| New pushes | `refUpdate` and `protectedRefUpdate` `(repoId, $createdAt > cursor)` (the `reflog` index) | 2 per repo |
| New PR heads | `patch` `(repoId, $createdAt > cursor)` + `event`/`authorEvent` feed (kind 16 `headUpdate`) | 3 per repo (the feed is read anyway) |
| Already reported? | `checkRun (repoId, headOid)` before running | 1 per candidate head |

Budget: with the 150/min gateway limit and a local token bucket of 100/min for the runner, `interval = max(30 s, repos × 5 / 100 min)`: 10 repos poll every 30 s, 100 repos every 5 min. The runner persists cursors (`$createdAt`) per repo in its state dir, so a restart re-reads nothing. A `webhook` (the relay) can *wake* the runner (an HTTP hook that just triggers a poll), which is how GitHub's < 30 s latency is matched for users who run the relay; without it the floor is the poll interval. Nothing in the trust path depends on the relay.

### 2.5 Logs and artefacts

Logs and artefacts go to the **runner's storage profile** (S3/IPFS, `crates/forge-core/src/storage/*`), content-addressed like release assets and packs (`<prefix>/packs/<sha256>.pack` in an S3 profile, a CID in IPFS; `dg ci report --log` uses the release-asset uploader) with `logUrl` and `logSha256` in the document, so the web streams the log from the bucket and verifies it. Size cap per log 32 MiB; the summary (≤ 2000 bytes) is on chain. No log bytes on Platform (0.28 DASH/MiB). Artefacts = `artifacts` JSON, same download path as release assets (`lib/view/release-download.ts`).

### 2.6 Required checks and the merge policy

`policy.requireChecks: true` (registered in #48) makes the merge box read the newest run per `name` on the folded head; a `policy.requiredChecks` list would need a new field: **add `requiredChecks` (typed string array ≤ 10 × 100 chars) to `policy`** in the final revision (typed scalar arrays are PV14, changelog beta.4 #4922). Rules: required names missing → "waiting for `build`"; any required run `completed` with conclusion ∉ {success, neutral, skipped} → blocked; client rule with a maintainer override, exactly as approvals (review spec §4.8). `FORGE_RULES_V2` gains `checks_state(runs, oracle, policy) → {required: [{name, status, conclusion, byTrustedWriter}], met}` with vectors `checks__*`.

### 2.7 UX

- **PR page**: Checks tab (review spec P1/P3) listing newest per name with icon, duration (`completedAt − startedAt`), a "Details" link (`detailsUrl`) and a "Log" link (verified from the bucket). Merge box row "3 checks passed / 1 failing / no checks reported for `def5678`".
- **Commit page and commits list**: a status dot per commit from `checkRun (repoId, headOid)` — read through a composite sub-query bound `$oid → headOid`? The page source for a commit list is not a document, so commits get their status from one `checkRun (repoId, $createdAt desc, limit 100)` read cached 60 s and matched by oid.
- **Repo → Checks tab** (the "Actions" tab): recent runs from the `recent` index, filter by name/conclusion.
- Badge: `/alice/p/badge/<name>.svg` rendered client-side (an `<img>` cannot run our JS, so this is a copyable Markdown snippet that links to the Checks tab — say so; a real SVG endpoint needs a server).

### 2.8 DX

```
dg ci runner new <owner/repo>… --budget 0.5 --expires 365d     # mints a runner identity, enrols it, prints DASH_FORGE_KEY (dfk1, checkRun-bound)
dg ci report <owner/repo> --head <oid> --name build --status completed --conclusion success \
     [--summary-file s.md] [--details-url …] [--log ./build.log] [--artifact ./dist/x.tgz]  # uploads to the storage profile, writes/updates the checkRun
dg ci status <owner/repo> [<oid>|pr <n>]                       # reads checks for a head
dg ci watch <owner/repo>… --exec './ci.sh'                     # the polling loop; exports FORGE_HEAD, FORGE_REF, FORGE_PR to the command
```

One-command runner: `docker run -e DASH_FORGE_KEY -v /var/run/docker.sock:/var/run/docker.sock ghcr.io/dashpay/forge-runner alice/project` = `dg ci watch` + act (`act push -e event.json -W .forge/workflows,.github/workflows`), posting `queued/in_progress/completed` and the log per job. `forge-check-action` (`uses: dashpay/forge-check-action@v1`) posts a `checkRun` from a GitHub workflow for mirrors (the mirror Action already carries the runner key model, `action/action.yml`).

### 2.9 What exists

`checkRun` type (schema only); writers: only `crates/forge-relay/examples/ci_consumer.rs:187-213`; readers: only the relay's `poll_check_runs` (`daemon.rs:1167-1214`, misses in-place updates because it keys on `$createdAt`); nothing in `dg`, `forge-core::collab` or `forge-web` (D-604). The relay delivers GitHub-shaped `check_run` payloads. The Mirror Action is an importer, not CI.

### 2.10 MVP vs later

MVP (P0): `runner` type + gate, `dg ci report/status/runner new`, `forge-check-action`, Checks tab + merge box row, `requiredChecks` policy, relay fix for in-place updates (poll `$updatedAt`? no index — poll `(repoId, headOid)` for watched heads, as today, and compare `$updatedAt`). Later (P1): `forge-runner` Docker image on act, `.forge/workflows` support, commit status dots, badges snippet, Checks tab filters. P2: matrix/artefact retention policies, GitLab CI reporter.

---

## 3. Performance and database-design audit

### 3.1 What the pages cost today

Measured by QA on moutai (`perf-scale/measure/table-pages.txt`, candidate = c2 build): cold DAPI requests per page — home 61, tree 39, blob 39, commits 42, issues 24, issue 28, pulls 28 (baseline master: **221**), pull 33, explore 52, profile 10. Warm is the same (nothing is cached across loads except in memory). Breakdown of `cand-home-cold` (65 requests incl. quorum keys): 28 `chunk` (locator fragments on Platform storage), 7 `refUpdate` + 1 `protectedRefUpdate` (keyset scan), 5 `release`, 5 `event`, 3 `getDataContract`, 2 `issue`, then one each of `repo`, `config`, `star`, `domain`, `patch`, `packManifest`.

Per page, from the code (audit of `origin/master`, line numbers stable on c2):

| Page | Queries today (R refs, U ref updates, Cfg configs, P packs, M members, I issues, E events, C comments, Rv reviews) | N+1 |
|---|---|---|
| Repo chrome (every `/repo/*`) | `repo` ×1 (`resolveRepo.ts:114-135`); `config` all pages `⌈Cfg/100⌉` (`config.ts:76-81`); `refUpdate` + `protectedRefUpdate` keyset scans `2⌈U/100⌉` (`refs.ts:134-187`); star count 1; issue + patch counts 2 (`use-repo-chrome.ts:58-66`); members `2⌈M/100⌉` signed-in (`members.ts:43-57`); own star 1 (`star-button.tsx:31-35`); DPNS 1 (`author.tsx:29-40`); 3 `getDataContract` per load (`service.ts:112-142`) | refs O(U) not O(R); everything re-read after 30 s (`use-repo.ts:40-80`) |
| Rail pages (home, tree, blob, commits, commit, branches, tags, stargazers) | + `release` all (`releases.ts:126-132`), members + **one DPNS per member** (`repo-rail.tsx:124-147`), quorum cross-check (2 HTTPS + up to 3 gRPC), and the **full browse context** because `CloneBox` mounts `useBrowseReader` (`clone-box.tsx:73`): `packManifest` all `⌈P/100⌉` (`packs.ts:124-130`) + every locator fragment (`browse-source.ts:1044`, Platform: `⌈bytes/1.47 MB⌉` chunk queries each) | fragments re-downloaded on every 30 s revalidation; branches/tags pay for a browse context they never use |
| Home | + root tree, README, `lastCommitsForDir` up to 60 sequential commit reads + `countCommits` up to 100 (`commit-log.ts:135-230`) | object reads are HTTP ranges or chunk queries; sequential |
| Commits | `logPage(tip, 40)` through a read-ahead walker (`path-history.ts`): a page of commits is one or two block reads | |
| Commit | commit + parent + tree diff ≤ 2000 nodes, 6 in flight + 2 blobs per file | |
| Issues list | `issue` desc limit 100 (+≤5 fill pages) (`issues.ts:364-405`); feed `event` + `authorEvent` ≤ 5 pages each, 30 s cache (`issues.ts:261-290`); **fallback to per-row `readTargetLog` (2 queries per issue) once the feed passes ~500 rows/type** (`issues.ts:275, 421-434`); DPNS per author | per-row logs on busy repos; open/closed from the ≤ 100 rows shown (`issues-content.tsx:49-53`), so the badge is wrong past 100 |
| Issue page | `issue` by number 1; `event` + `authorEvent` by target 2; `comment` by target `⌈C/100⌉`; permissions (cached); DPNS per timeline author | DPNS |
| PR list | as issues + full `config` timeline (`issues.ts:604-605`) + **`readRefUpdates(base)` = 2 full reads per PR row with no dedupe** (`issues.ts:555-561`) | worst web N+1 (was 221 requests on master; c2 dedupes per base ref) |
| PR page (c2) | `patch` 1; event/authorEvent/comment 3+; `review` 1+; base ref 2 full; config timeline again; members; `repo` of the source (uncached, twice with the merge panel, `pull-diff.tsx:42-52`, `pull-merge.tsx:50`); source browse context cold; merge-base walk ≤ 2000 commits | |
| Explore | 1 composite (repos + star/issue counts, `discovery.ts:75-115`); **24 `release` queries** (`mine.ts:297-311`); 24 DPNS; signed in: owned/member repos 3, `listMyTargets` ×2 (≤ 5 pages each), stars 2, **assigned/mentions scan ≤ 60** (`mine.ts:362-398`) | releases, DPNS, scan |
| Profile | DPNS ×2, owned repos 1, member repos 2–3, follow counts 2, own follow 1 | fine |
| Notifications | 0 on the page; the poller: ≤ 12 feeds/min (`inbox.ts:57-59`), subscriptions 10–20 every 15 min | fine |
| Stargazers | `star` limit 100 not paged + **DPNS per stargazer** (`social.ts:27-42`) | DPNS |

CLI (audit of `origin/master`; every read proof-verified; `fetch_contract` is **never memoised**: `platform/mod.rs:456-467`, called again by `RepoService::readable`, `members::core`, `Collab::collab_contract`):

| Command | Queries | N+1 |
|---|---|---|
| `git clone` / `git fetch` | identity 1; resolve 2; `read_refs` = contract + `⌈Cfg/100⌉` + `2⌈U/100⌉` (`repo.rs:454-472`, `refs.rs:156-190`); default branch 2; manifests `1+⌈P/100⌉` (+ tie probes); members `2⌈M/100⌉`; per pack (8 in flight) copies in reader order, Platform fallback `⌈chunks/100⌉` | **fetch re-downloads every kind-0 pack whenever anything is new** (`helper.rs:242-316`); partial-clone promisor fetches start a new helper (each pays the whole prologue) |
| `git push` (N refs, C chunks) | `read_refs` ×3 (list, push, converge ×1–6, `helper.rs:368, 501-537`); precheck roles 4 + protected patterns 2; `read_pack_copies` 2; **C sequential chunk writes each awaiting a proof** (`repo.rs:695-715`; only `PlatformBackend::put` pipelines 8, `backends/platform.rs:260-273`); manifest 2; browse index: manifests again + members + locator (pipelined) + manifest; **per ref: contract + full config history + write** (`repo.rs:392-432`) | 0.5–0.7 chunks/s (D-910) is the sequential proof wait; config re-read per ref |
| `dg pr list` | session 3; one page `patch` (cap 100); members 3; **per PR: `patch_view` (target log 2, base ref tips 2 + config, contract ×3) + reviews 2 ≈ 9** (`pr.rs:286-300`, `collab/v2.rs:1028-1046`) | 915 requests / 117 s for 100 PRs (D-500) |
| `dg pr view` | ≈ 20 round trips, 7 of them `getDataContract` | |
| `dg issue list` | 5 + 3 per issue (`target_log` per row) | per row |
| `dg repo view` | 3 + 2 + `read_refs` + manifests + members | |
| `dg repo fork` | manifests ×3, members, refs ×2, **P sequential manifest writes each after a contract fetch, R sequential ref writes each re-reading config** (`fork.rs:165-258`) | |
| `dg collab add` | 7 reads + 1 write | fine |

Two more facts shape the plan: the evo-sdk chunk is 11.4 MB (8.25 MB gz), which breaks the "bundle < 1.5 MiB before WASM" budget; and the three `getDataContract` per page are avoidable since wasm-sdk 4.2 persists fetched contracts and can be seeded (`changelog 4.2.0-dev.11 #4744/#4746`).

### 3.2 The rate-limit budget

150 requests/min/IP is shared by every tab, the inbox poller, a running `dg` command and a runner on the same NAT. Budget per client:

| Consumer | Steady budget | Mechanism |
|---|---|---|
| Web page load | ≤ 25 cold, ≤ 8 warm, ≤ 5 tab switch | composite + delta caches (§3.3–3.4) |
| Inbox poller | ≤ 12/min (exists) | `ROUND_BUDGET` |
| Token bucket, shared | 120/min per browser profile (`BroadcastChannel` across tabs), 100/min per CLI process, 100/min per runner | `lib/sdk/budget.ts`; `forge-core::platform::Budget` |
| `ResourceExhausted` | wait `ratelimit-reset` (+ jitter) and retry on the same node; **do not ban** | evo-sdk `ban_failed_address=false` + our retry; rs-sdk `AppliedRequestSettings { ban_failed_address: false }` for reads, then sleep on `rate_limit_ban_duration()` (`dapi_client.rs:319`) |
| Imports / pushes | ≤ 60 writes/min per identity (each write is 1 broadcast + 1 wait + occasional nonce read) | pipelining is bounded by this, not by proof latency |

### 3.3 Composite and chained queries: the new read plans

`documents.composite` (evo-sdk `documents/facade.ts:64`; wire `GetDocumentsRequestV1.sub_queries`, `platform.proto:1763-1841`; `MAX_SUB_QUERIES = 10`, `MAX_BOUND_VALUES = 100`, page `limit` ≤ 100 required, no cursor — paginate with a range clause; `composite_document_query/mod.rs:119-124`) proves a page plus up to ten derived sub-queries under one root. Sub-queries may target **any contract** ("profiles keyed by owner, names by identity", `wasm-sdk/src/queries/composite_document.rs:85`): a `documents` lookup bound `$ownerId → <indexed field>` or a `counts` sub-query bound `$id → <field>` on a countable index. `documents.chained` proves a semi-join whose inner side is an indexOnly type with a `permanentDocument` join property (`chained_document.rs:34-96`).

Read plans after this spec (requests are DAPI round trips; `Δ` = rows since the cached cursor):

| Page | Plan | Cold | Warm |
|---|---|---|---|
| Repo chrome | **1 composite**: page `repo` (`$ownerId, name`, limit 1) + sub-queries: `counts` star (`$id→repoId`), `counts` issue, `counts` patch, `documents` maintainer (`$id→repoId`, limit 100), `documents` writer, `documents` DPNS `domain` (`$ownerId→records.identity`, DPNS contract; **verify** that a dotted index property is accepted as the bound `field` — the proto says "an indexed property"; fallback = 1 plain DPNS query), `documents` `profile` (`$ownerId→$ownerId`, collab). Then refs delta 2, config delta 1, own star 1 (signed in; IDB-cached per identity, invalidated on toggle). | 5 | 3 (refs + config delta) |
| Rail | latest release: `release (repoId, $createdAt desc, limit 5)` 1; members' names: **inside the chrome composite** (a second-level `documents` DPNS lookup bound to the maintainer sub-query, `bind.source = n`); quorum cross-check once per session; **no browse context on branches/tags/stargazers** (`CloneBox` reads the manifest count from the chrome and loads the reader on click) | +1 | 0 |
| Home / tree / blob / commits | manifests delta 1 (`packManifest (repoId, $createdAt > cursor)`; immutable, so the cache is exact); locator fragments **cached in IDB by `packHash`** (immutable) → 0 warm; objects via HTTP Range (external) or chunk queries (Platform, ≤ 1 per 1.47 MB window, cached by `(packHash, seq)`) | 1 + fragments | 1 |
| Issues list | **1 composite**: page `issue (repoId, $createdAt desc)` limit 50 (keyset `$createdAt <` for older pages) + `counts` comment (`$id→targetId`), `documents` DPNS, `documents` profile; feed delta 2 (`event`/`authorEvent (repoId, $createdAt > cursor)`); fold over the cached feed. Labels 1 (cached 5 min). | 4 | 3 |
| Issue page | **1 composite**: page `issue (repoId, number)` limit 1 + `documents` comment (`$id→targetId`, limit 100, ordered `$createdAt`), `documents` event (`$id→targetId`), `documents` authorEvent, then a **second composite** for names/profiles of the comment authors (`bind.source = 1`, `$ownerId→records.identity`) — or the same request if the first stays ≤ 10 sub-queries: 4 documents + 2 DPNS/profile bound to page and to the comment sub-query = 6. Comments > 100: page with `$createdAt >`. | 1–2 | 1–2 |
| PR list | as issues + `counts` review (`$id→patchId`) + `counts` comment; base tips from the **cached ref history** (0 queries); `policy` newest 1 (cached) | 5 | 3 |
| PR page | issue-page composite with `review` added (`$id→patchId`), `checkRun (repoId, headOid)` 1 per folded head, source `repo` 1 (cached per session), source refs delta 2; base tips from cache | 6 | 4 |
| Explore | recent: composite as today (+ `documents` release bound `$id→repoId` limit 100 ordered desc — **that is one sub-query for all 24 repos**, replacing 24 queries) + DPNS bound; trending/most starred: 2 ranked (§4) + 1 `repo $id in`; signed in: mine ×4 | 4 / 8 | same |
| Profile | 1 composite: page `profile` (`$ownerId`) + `counts` follow (`$ownerId→identityId`), `documents` repo (`$ownerId→$ownerId`, limit 50), DPNS; member repos 2 | 3 | 1 |
| Stargazers | `star (repoId)` keyset on the terminal (`$ownerId > last`, indexOnly keyset paging, book `index-only-document-types.md` "keyset pagination") + DPNS via one `domain (records.identity in [...100])` | 2 | 2 |

CLI: `dg pr list` = one `DocumentQuery::with_sub_queries` (rs-sdk; changelog dev.9 "CompositeDocumentQuery … replaced by DocumentQuery::with_sub_query") for patches + reviews + events per PR (three `documents` sub-queries bound `$id`), plus the cached ref history: **4 requests for 100 PRs** (from 915). `dg issue list`: 2. `git fetch`: refs delta 2 + manifests delta 1 + only the packs whose hash is not in `.git/dash/packs` (incremental by design: manifests are append-only). `git push`: pipeline chunk creates with a window of 8 (`buffered(8)`, same as `PlatformBackend::put`), read config once per push, converge with one `read_refs` delta.

### 3.4 Caches (the delta-cache invariant)

A type is delta-cacheable iff it is immutable **and** non-deletable (then a `$createdAt > cursor` read on a `(repoId, $createdAt)` index is exact): `refUpdate`, `protectedRefUpdate`, `config`, `packManifest`, `manifestPart`, `chunk`, `event`, `authorEvent`, `issue`/`patch` creation rows (the documents are mutable — cache by `$updatedAt`, re-read the page you show), `policy`, `repoKey`. Not cacheable without a TTL: `comment`, `review`, `release`, `label`, `checkRun`, `webhook`, `star`/`follow` (deletable). IDB stores: `refs`, `config`, `feed`, `manifests`, `fragments`, `objects` (LRU 64 MB), keyed by network + repoId, with the cursor = the last row's `$createdAt` (ties are re-read, `$createdAt >=` then dedupe by `$id`; the `$createdAt` tie probe already exists in `query.ts:253-263`). The CLI mirrors this in `~/.cache/dash-forge/<network>/<repoId>/*.jsonl` and in `.git/dash/`. Storage objects: HTTP `Cache-Control: immutable` on content-addressed keys is a bucket setting we document in the storage guide; the browser cache then serves fragments and ranges for free.

Contracts: seed evo-sdk from the deployment file's contracts (`wasm-sdk` "let apps seed the contracts they already hold", #4746) so no page fetches `getDataContract`; forge-core memoises `fetch_contract` per process and persists it under `~/.cache/dash-forge/contracts/<id>.bin`, validated by `getDataContractsLatestVersions` (one request for all ids, #4739) once per hour.

Proof-verification cost: one GroveDB proof and one BLS signature check per query whatever the page size (`rs-drive-proof-verifier/src/proof.rs:1875-1921`), so fewer, fuller requests are strictly cheaper; composite returns one merged proof. Maximum proof size is **UNVERIFIED** (tonic default decode limit applies on the SDK side, `rs-sdk/src/sdk.rs:94`); a composite with 10 sub-queries × 100 rows stays well under a megabyte.

### 3.5 Index audit (every index, its consumer, verdict)

forge-core (unchanged except additions): `repo.ownerName` (resolve, profile) ✔; `repo.name` (jump box) ✔; `repo.forkOf` countable (forks list/count) ✔; `repo.recent` (Explore) ✔ — add doctype `documentsCountable` for the repo total; `maintainer/writer.byRepoMember` (viewer role point lookup — **use it**, today the web reads all members) ✔; `byMember` (my repos) ✔; `refUpdate.refState` (per-ref history; keyset scan) ✔; `reflog` (delta cache, relay, runner) ✔; `pusher` (contribution graph) ✔; `config.created` ✔; `packManifest.packHash` unique, `byHash`, `created` rangeCountable, `kind` ✔ (`kind` is unused by readers — keep, the locator fold filters by kind client-side; removing an index needs a new registration which forge-core avoids); `manifestPart.part`, `chunk.chunk` ✔; `release.tag`, `created` ✔; `label.name` ✔; `repoKey.memberEpoch`, `byMember` ✔.

forge-collab (registered #48): `issue/patch.number` unique rangeCountable (count, allocation) ✔; `created` (lists, delta) ✔; `author` unique (mine, `authorEvent` lookup) ✔; `patch.sourceRef` ✔; `comment.target` rangeCountable, `author`, `reply` sparse ✔; `review.patch` rangeCountable ✔; `event/authorEvent.target`, `feed`, `addressee` sparse ✔; `checkRun.head` ✔ + add `recent`; `policy.created` ✔; `webhook.hook/list/relay` ✔; `profile.owner` unique ✔; `star.byRepo` countable, `byOwner` terminal repoId ✔ + trending (§6); `follow.byTarget` countable, `byOwner` countable ✔ + `rankedCountable` on `byTarget` (most followed).

Missing indexes that the final revision must add (all in §6): `checkRun.recent`, `star.byWindowRepo` (timeRange), `milestone.*`, `topic.*`, `watch.*`, `runner.*`, the `rangeCountable`+`rankedCountable` upgrade of `star.byRepo` and `follow.byTarget`. Nothing else: every other "sort by X" is a client fold over cached rows.

### 3.6 Top five wins

1. Composite reads for chrome, lists and detail pages (§3.3): −60 % requests on every page, DPNS/count/member N+1 gone.
2. Delta caches for the immutable types (§3.4): repo chrome warm = 3 requests; `dg pr list` 915 → 4; `git fetch` incremental.
3. Rate-limit discipline: shared token bucket, honour `ratelimit-reset`, no node bans, contracts seeded (−3/page).
4. Push pipelining (window 8) in the helper and forge-import: 0.6 → ≈ 4–5 chunks/s (bounded by the 60 writes/min budget, not by proofs); config read once per push.
5. Rail decoupled from the browse context; fragments and chunks cached by content hash; evo-sdk split so the WASM loads after first paint.

---

## 4. Trending and counts (v4.2 primitives)

### 4.1 What is verified

- **Count trees**: `countable` / `rangeCountable` / `documentsCountable` (book `drive/document-count-trees.md`; `Index.countable: IndexCountability`). A `COUNT` needs an index whose properties the `==`/`in` clauses cover exactly, or all but the last property of a `rangeCountable` index (`find_countable_index_for_where_clauses`; #48 uses this for comments per target). Group-by: one entry per `in` value (absent values omitted), or per distinct value of a range field.
- **Ranked indexes** (`drive/document-ranked-trees.md`, `ranked-index-examples.md`): `rankedCountable: true | {at: …}` requires `rangeCountable`; query = `documents.ranked({groupBy, aggregate:{type:'count'}, limit 1..100, direction, offset, where: prefix pins, timeRange})` (`wasm-sdk/src/queries/document_ranked.rs:54-230`); proof O(log n + k); ties by group key; non-unique indexes only; per-write cost = one secondary rewrite per ranked level.
- **timeRange** (`meta_schemas/document/v3/document-meta.json:1551-1600`): `{on: $createdAt, range, step, phase?, ttl?}` on the index's **first** property; a document is indexed under `range/step` bucket starts (overlap ≤ 24, `SYSTEM_LIMITS_V4.max_time_range_overlap_factor`); `ttl ≥ range`, `ttl ≤ 604 800` (one week); TTL'd bytes bill as processing at 270 credits/byte, no storage flags, no refund, drained lazily on write (`drive/time-range-ttl.md`). Selection: `IN_TIME_RANGE` with `newest` (window started most recently: "today so far"), `oldest` (oldest still-active window: "the trailing ~range"), `byStart` (`platform.proto:1167-1214`). Ranked below a bucket = "ranked windowed top-K" (changelog dev.8).
- **indexOnly** (`drive/index-only-document-types.md`): no primary row; every index carries `$ownerId`; `terminal`; keyset paging on the terminal; delete-by-values; `skipIfAbsent`; `preallocated`; composes with `timeRange` and ranked (the yappr-likes fixture `beat.byHourHashtag` is exactly `[$createdAt, hashtag]` + `timeRange {3600, 900}` + countable + rangeCountable).
- **Sum/average** trees exist (`summable`, `averageable`, ranked variants); Forge has no integer to sum today (tips are out of scope).
- **Fees**: storage 27 000 credits/byte, processing per byte 400, seek 2 000; registration 0.1 base + 0.02/type + 0.01/index (`fee/data_contract_registration/v2.rs`); countable/ranked flags add no registration fee.

### 4.2 Counts: countable indexes, not summary documents

Every count the UI shows comes from a count tree or a fold over cached rows; **no summary documents**. A summary doc (per-repo `{open, closed}` written by a maintainer) is a second copy that any maintainer can leave stale or wrong, cannot be checked without doing the fold anyway, and violates "the UI shows only what was verified". The provable counts: issues/PRs total (`number`), comments per target, reviews per PR, stars, followers/following, forks, repos per owner (`ownerName` rangeCountable), packs (`packManifest.created`). Not provable: open/closed, requested reviewers, labels/assignees per issue — folds (§5.2).

### 4.3 The star / watch / fork model

As registered in C-1 (`forge-contracts/contracts/forge-collab.json`; decided by the measurements in §4.4):

```jsonc
"star": {                                   // indexOnly, immutable, deletable by values (as #48)
  "properties": { "repoId": {… "refersTo": {"type":"permanentDocument","contractId": FORGE_CORE, "documentType":"repo"} } },
  "required": ["repoId"],                   // $createdAt NOT required: unstar must work forever, from any device
  "indices": [
    { "name": "byRepo",  "properties": [{"repoId":"asc"}], "countable": "countable",
      "rangeCountable": true, "rankedCountable": true },                       // count O(1); all-time top-K ("most starred")
    { "name": "byOwner", "properties": [{"$ownerId":"asc"}], "terminal": "repoId" }   // my stars; "did I star" = terminal equality
  ]
},
"starBeat": {                               // indexOnly, NOT deletable: its window entries expire on their own
  "properties": { "repoId": { … same reference as star … } },
  "required": ["$createdAt", "repoId"],
  "indices": [
    { "name": "byOwner", "properties": [{"$ownerId":"asc"}], "terminal": "repoId" },  // the proof index: one beat per (identity, repo), ever
    { "name": "byWeek",  "properties": [{"$createdAt":"asc"}, {"repoId":"asc"}],
      "timeRange": { "on": "$createdAt", "range": 604800, "step": 86400, "ttl": 604800 },
      "countable": "countable", "rangeCountable": true, "rankedCountable": true }     // trending: top-K by new stargazers in a window
  ]
}
```

- **Why not fused.** A `timeRange` index needs `$createdAt` in `required` (rs-dpp refuses the index otherwise), and an indexOnly delete carries the full value tuple, `$createdAt` included, checked against the row commitment (book `index-only-document-types.md`, "Delete"; the live probe got *"an indexOnly document of type … requires $createdAt, but the document being deleted does not carry one"*). The bucketed index cannot give the timestamp back (bucket-start granularity, and it expires), so an unstar would need a permanent `$createdAt` level such as `byOwner [$ownerId, $createdAt]`: +49 % per star on its own, +86 % with the window index (§4.4). The owner's rule: correctness beats trending, and unstar must always work.
- **The beat's window expires through the index's own `ttl`** (`timeRange.ttl`, protocol 14, at most one week; entries bill as processing at 270 credits/byte and are drained lazily on later writes, book `time-range-ttl.md`). It is **not** a document `ttl` (beta.5's doctype keyword, which indexOnly types refuse and which C-1 does not use). The `byOwner` proof index is permanent: a beat is never deleted and never re-written.
- **Semantics.** Trending counts **new stargazers in the window**: strictly, `starBeat` documents, which consensus does not tie to a `star` (a beat without a star is possible, and costs the writer the same as one with). An unstar does not remove a beat, and starring again later adds none (the second beat is a duplicate of the first under `byOwner`).
- **Default ON, visible and reversible.** After a successful star the client writes the beat when "Count my stars toward Trending" is on (the default, one constant: `forge-web/lib/repo/trending.ts` `TRENDING_DEFAULT`, `forge-core::collab` `TRENDING_DEFAULT`). The star button's cost preview includes the beat (≈ 0.00015 DASH) with "Counts toward Trending"; Settings has the toggle; `dg repo star --no-trending` and the `trending = false` config key opt out.
- **Trending this week** = `ranked({documentTypeName:'starBeat', groupBy:'repoId', aggregate:{type:'count'}, limit:25, timeRange:[{field:'$createdAt', selector:'oldest'}]})`: the oldest still-active 7-day window (a near-full trailing week). **Trending today** = the same with `selector:'newest'` (the window that started at today's grid line: stars since 00:00 UTC — set `phase` to align the grid; the 7-day range means "today" is the partial current window). One grid serves both because `range = 7 × step`. A second grid for "this hour" would be a fourth index with overlap 24 — not worth 24 entries per star.
- **Most starred (all time)** = `ranked({documentTypeName:'star', groupBy:'repoId', …})` with no timeRange, on `star.byRepo` (single-property ranked index, no pins). Equal counts come back by repo id descending (the descending walk of the ranked secondary; measured).
- **Star count** and **"did I star"** unchanged (`countDocuments`, `findOwnIndexOnly`).
- **Watch**: new indexOnly `watch {repoId}` with `byRepo (repoId) countable` and `byOwner ($ownerId) terminal repoId`; the inbox seeds subscriptions from `byOwner` (cross-device), `readViewerRelations` reads star and watch in one composite. No ranked axis.
- **Forks**: `repo.forkOf` (countable) is already the fork count and the fork list; the network page walks it. A ranked "most forked" needs `rangeCountable + rankedCountable` on `forkOf` — forge-core index changes need a new registration, so **not** in the final revision; "most forked" is computed client-side over the top-100 most-starred (P2).
- **Most followed**: `follow.byTarget` gains `rangeCountable + rankedCountable` (the same shape as `star.byRepo`, so the same +2 %).
- **Per-topic / per-language trending**: no index can bind a star to its repo's topic (the agreement would cross contracts and `topics` is an array), so: fetch top-100 trending, join with the `repo` docs (`$id in`, 1 request), filter by topic/language client-side. Good enough for Explore; a `topic`-scoped ranked index would cost a third entry chain per star and is not justified.

### 4.4 Fee arithmetic per star (measured in C-1)

Measured on devnet moutai (drive 4.2.0-beta.5, evo-sdk 4.2.0-beta.5) on 2026-09-28 against two scratch contracts (`BEcG2LrGcNhxYyQAEAiNNU3g2QuQomfoL93HMAFxrbkF`, `EMD8icGMDDr4mvA43NWPhaSPbHqJ3nEjSzBSPiqmdsFG`, test-only, left on the devnet) that carry each candidate shape as its own type. Credits are balance deltas of two identities minted for the probe; 1 M credits = 0.00001 DASH. "Steady" = the repo already has stars and the starrer already holds stars of that type.

| Shape of `star` | Repo's first star | Steady star | Unstar refund (not last / repo's last) |
|---|---|---|---|
| as registered before C-1: `byRepo` countable, `byOwner` | 27.6 M | **17.40 M** | 12.6 M / 23.1 M |
| + `rangeCountable` + `rankedCountable` on `byRepo` (**C-1**) | 36.0 M | **17.74 M (+2.0 %)** | 12.3 M / 23.3 M |
| + a permanent `$createdAt` level (`byOwner [$ownerId, $createdAt]`, needed for unstar once `$createdAt` is required) | 44.3 M | 26.0 M (+49 %) | 20.4 M / 31.4 M |
| fused: ranked `byRepo` + `$createdAt` level + the weekly `byWeek` window | 51.1 M | **32.3 M (+86 %)** | 14.2 M / 25.1 M |
| `[repoId, $createdAt]` ranked at `repoId` (stargazers by time) | 46.1 M | 27.3 M (+57 %) | 21.7 M / 33.1 M |

| A separate beat (second transition) | Identity's first | Steady |
|---|---|---|
| `starBeat`, weekly sliding window (range 7 d, step 1 d, ttl 7 d: 7 buckets) (**C-1**) | 20.7–21.7 M | **14.4–15.3 M** |
| daily window (range = step = 1 d, ttl 7 d: 1 bucket) | 25.4 M | 9.4–9.6 M |
| weekly window with a flat `(repoId, $ownerId)` proof index | 18.6 M | 14.7–17.6 M |

**Decision.** The fused star fails the ≤ 15 % gate by a factor of six, and the reason is structural (the permanent `$createdAt` level an unstar needs), not the window index. So `star` keeps its permanent shape plus the ranked axis (+2 %, the "most starred" read), and trending is the separate optional `starBeat` on the weekly grid: ≈ 15 M credits (≈ 0.00015 DASH) when the preference is on. The daily grid is cheaper per beat but can only answer "this week" as an approximate client merge of seven daily top-100 lists; the weekly grid answers it exactly, proved, with `oldest`. Ranked `newest` / `oldest` reads on the live beat indexes returned the seeded counts.
### 4.5 Where the counts come from, page by page

| Number | Source | Exact? |
|---|---|---|
| Issues / PRs tab total | `number` count tree (composite `counts`) | yes |
| Open / closed | fold over the cached feed (§5.2) | yes, after the delta read |
| Comments per issue, reviews per PR | `comment.target` / `review.patch` count trees | yes |
| Stars, forks, followers, following, watchers | count trees | yes |
| Trending, most starred, most followed | ranked queries | yes, proved |
| Commits on a branch | client walk (cap 100, "100+") | bounded |
| Contributors | distinct `pusher` (`refUpdate.pusher`) + authors, client | yes over cached rows |

---

## 5. Two questions the owner asked

### 5.1 The 150/min limit as a design constraint

Applied above (§3.2). Three consequences worth stating: the inbox poller's 12/min is a fixed tax, so page budgets are net of it; an import or push must share the same bucket when it runs beside a browser on one IP (`dg` prints "rate-limited, waiting 23 s" rather than banning nodes, D-902/D-511); and forge-web should stop opening three DAPI nodes per page (address rotation is fine, but each node counts the IP separately only if the gateway limit is per node — **UNVERIFIED** whether the 150/min is per gateway node or shared; the safe assumption is per node, which makes node rotation a 10× multiplier on moutai's 10 nodes and a reason to keep sticky rotation, `changelog dev.9 #4545`).

### 5.2 Proven open/closed counts

Consensus cannot count open issues: open is `fold(event, authorEvent)` and a merge counts only if its oid is on the base branch (a rule no index sees). The three options: (a) a maintained state field on `issue`/`patch` — impossible, only the author may replace their document (Platform ownership rule) while members close; (b) a per-state summary document — rejected (§4.2); (c) client counting — chosen, made exact and cheap by the feed delta cache: cold = `⌈E/100⌉ + ⌈AE/100⌉` requests once (dips: ≈ 8), warm = 2 per visit, fold in a worker, counts in the header and the list tabs from the same fold, invalidated by the app's own writes (`invalidateRepoFeed` exists, `issues.ts:262`). The CLI keeps the same cache under `~/.cache/dash-forge`. The badge shows "· 4 open" only after the fold; before it, the countable total ("12 issues"). This is what the review spec already concluded (§3.10) and #48 documented in forge-v2.md §6.1; this document makes it the final answer.

---

## 6. The final contract revision

Ships as **one** batch before mainnet (moutai first, testnet when PV14 arrives): a forge-core **in-place update** and a forge-collab **re-registration** (new id, same group). Both validated by `tools/contract-validate` in CI (`.github/workflows/contracts.yml`): forge-core with `--expect-update forge-contracts/contracts/registered/forge-core.v1.json`, so a change the update rules refuse fails the build; forge-collab is a new registration and carries protocol-14 beta.5 `propertyConstraints` (web clients are on evo-sdk / wasm-sdk 4.2.0-beta.5 since #125, so they load them). forge-core's in-place update was chosen over a re-registration (owner decision 2026-09-28): a new forge-core id would orphan every repo, ref, pack and membership and re-push the showcase (≈ 135 DASH, 10 h); mainnet registers fresh from the same JSON either way. D-D (who owns the mainnet contracts) applies unchanged; PR #54's trust root (group owner, not member list) is what lets a new forge-collab join the group without breaking shipped binaries.

### 6.1 forge-core (in-place `DataContractUpdate`; ids and group unchanged)

Allowed by `validate_update` v1: new document types and new optional properties; no index of an existing type changes. **Checked against rs-dpp v4.2.0-beta.5 with `contract-validate --previous`:** two changes this section first listed are refused as updates and are dropped (below, and "accepted gaps").

| Change | Why |
|---|---|
| New type `runner {repoId, memberId}`: unique `byRepoMember (repoId, memberId)`, `byMember (memberId)`; `propertyAgreement {"$ownerId":"$ownerId"}` on `repoId → repo` (owner-only grant); immutable, deletable | CI trust (§2.2) |
| New type `topic {repoId, name}`: **owner-granted** (`repoId → repo` with `propertyAgreement {"$ownerId":"$ownerId"}`, like `runner`; the C-1 design review found a maintainer gate lets a removed maintainer's tag outlive them, undeletable by anyone else and blocking a re-tag under the unique index); unique `byRepo (repoId, name)`; `byName (name, $createdAt)` rangeCountable + ranked at `name` (repos per topic, and a proved "popular topics" list); deletable (untag) | Explore by topic; `repo.topics` stays for display. A private repo's topics are as public as its `repo.topics`, so Explore lists only public repos under a topic |
| `repo.renamedTo` (optional identifier, `refersTo permanentDocument repo`) | Rename/move with client-side redirect |
| ~~`repo` doctype `documentsCountable: true`~~ **dropped**: refused as an update ("document type can not change whether its documents are countable", `validate_config` v1). Explore shows "Recent repositories" with paging and no total | — |
| `repo.language` (optional string ≤ 30) written by the pusher's helper from the flatIndex | Explore language filter without a client join (**cheap; optional**) |
| `enc`/`epoch` on `release` and `label`: optional `enc` (`schemaDefs.enc`) and `epoch`. **No `dependentRequired`**: adding it to an existing type is refused ("Incompatible change 'add' of property '/dependentRequired'"), so "`enc` needs `epoch`" stays a client rule on these two types (`is_well_formed`). A sealed release, label or milestone keeps its required, indexed `tagName` / `name` / `title` as the **keyed name key**: `base64url(HMAC-SHA256(K_ref,e, name))` without padding, cut to 30 characters (label's cap; 180 bits, collision-free for a repo's names), so newest-per-name folds and event values meet without revealing the name | Private repos: a release's tag name, title, notes and asset list, and a label definition's name, colour and description, sealed like every other content type (private-repos.md §7, §13 item 6). Until this lands `dg release create` refuses a private repo ([E207](../errors.md#e207)) and `dg label create` warns that the definition is plaintext; the labels put on issues (`event.value`) are already sealed |

`topic` needs no rule (its `name` pattern covers it); nor does `runner`. The update's cost and size are in §6.4.

**Closed by the fresh registration after the beta.6 reset (2026-09-28).** moutai was wiped again and restarted on drive 4.2.0-beta.6, so forge-core was registered fresh (§6.4). That registration carries the first four gaps below:
- `repo` `documentsCountable`;
- the sealed-presence rules: `noPlain` on `refUpdate`, `protectedRefUpdate`, `config`, `release` and `label`, and `hasName` on the ref types; `config.backend` stays plaintext, as private configs need it;
- `dependentRequired {enc: [epoch]}` on `release` and `label`;
- ranked `forkOf` (`rangeCountable` + `rankedCountable`, without `nullSearchable: false`, which a ranked index refuses). Every repo that is not a fork is then indexed under the null `forkOf`, a real group that ranks first by far, so a "most forked" reader must drop the null key from the ranking.

`packManifest.kind` stays: forge-web's `readNewestManifestOfKind` (`lib/repo/packs.ts`, the browse flat index) queries it, so the "no reader" below was wrong. The paragraph below is the record of what the in-place update had to accept.

**Accepted gaps for mainnet v1** (each needs a forge-core re-registration, which the owner declined on 2026-09-28): no provable repository total (`documentsCountable`); no consensus sealed-presence rules on `refUpdate`, `protectedRefUpdate`, `config`, `release` and `label` (clients enforce them, `is_well_formed`; consensus cannot see `visibility` anyway); no `dependentRequired {enc: [epoch]}` on `release` / `label`; no ranked `forkOf` ("most forked" stays a client ranking over the top most-starred, P2); `packManifest.kind` kept although no reader queries it (≈ 3 M credits a manifest). (BETA5-ANALYSIS §4.4's `storage = 1 ⇒ chunkCount > 0` rule would have been wrong anyway: a fork's manifest is `storage = 1, chunkCount = 0`, §4 of forge-v2.md.)

### 6.2 forge-collab (re-registration)

| Type | Change |
|---|---|
| `checkRun` | gate `anyOf [runner, maintainer, writer]` (runner first: `anyOf` stops at the first operand that holds, and a runner posts most runs, each re-checked on every replace); fields `externalId`, `startedAt`, `completedAt`, `artifacts`, `logUrl`, `logSha256` (`dependentRequired` both ways); `conclusion` enum (GitHub's, `stale` included);  `$updatedAt` required; index `recent (repoId, $createdAt)`; rules `conclusionIfDone` / `doneIfConclusion` (a conclusion exactly when `status` is `completed`) |
| `policy` | `requiredChecks` typed string array (≤ 10 × ≤ 100) |
| `star` | `byRepo` + `rangeCountable` + `rankedCountable` (measured +2 %); `$createdAt` stays unrequired so unstar always works (§4.3, §4.4) |
| new `starBeat {repoId}` indexOnly, non-deletable | `byOwner ($ownerId) terminal repoId` (proof index); `byWeek ($createdAt, repoId)` timeRange 7 d / 1 d with index `ttl` 7 d, countable + rangeCountable + rankedCountable (§4.3) |
| `follow` | `byTarget` + `rangeCountable` + `rankedCountable` |
| new `watch {repoId}` indexOnly | `byRepo (repoId) countable`, `byOwner ($ownerId) terminal repoId` |
| new `milestone {repoId, title, description, dueOn, closed, enc, epoch}` | M/W gated; `byRepo (repoId, title, $createdAt)`; newest per title wins; deletable; a sealed milestone puts the keyed name key of its title (above) in `title` and the rest in `enc` (rule `noPlain`) |
| `event` / `authorEvent` | kinds 17/18 milestone, 19–22 pin/unpin/lock/unlock; `kind` stays the open range 1..255 on `event` (extensible) and the author enum on `authorEvent`; the sparse `addressee` index is `(refId, $createdAt)` on both, so "assigned to me" / "review requested" read newest first past 100; `authorEvent` rules `needRefId` (11–14) and `needOid` (16). beta.5 rules on `event`: `noPlain` (a sealed event has no plaintext `value`), `needValue` (4, 5, 8, 17 name a value, plaintext or sealed), `needAssignee` (6, 7 carry `refId` and a value), `needRefId` (11–15), `needOid` (3, 16); `value` gets `minLength 1` |
| `issue`, `patch`, `comment`, `review` | beta.5 sealed-presence rules: `noPlain` (a document with `enc` carries none of its plaintext fields, `imported.author` and `imported.url` included: TLV 13/14) and `hasTitle` / `hasBody` (a document without `enc` carries its required plaintext); `body` and `comment.path` get `minLength 1`, so an empty string can no longer stand for "absent" |
| `profile` | `location`, `company` (optional ≤ 60); `pubkeys` typed string array (≤ 4 × ≤ 300: `gpg:<fpr>` / `ssh-ed25519 …`) for signature badges |

**Size is a lifetime budget.** A `DataContractUpdate` carries the whole contract, so every later in-place update of forge-collab (a new optional property, a widened enum) must fit under the same 20,480 B; C-1 leaves ≈ 1 KB. Redundant `countable` next to `rangeCountable` (which implies it) is omitted for that reason.

Everything the review spec registered in #48 stays. The measured size, fee and ids are in §6.4 (the signed create transition is ≈ 19.1 KB of the 20,480 B limit; beta.5 rule names are kept short for that reason, and `authorEvent` carries no rules: its kind is already an enum and the folds treat a payload-less author kind as inert).

### 6.3 Not changed, and why

No `$updatedAt` sort index on issues (activity sort is a fold); no `assignee` index (`addressee` serves it); no `label` index (labels are events); no forge-core index changes (a forge-core re-registration changes the group id and every membership doc); no `stateHint` fields; no wiki/pages types. `readonly` stays off on both contracts (the owner decides at mainnet registration; it cannot be turned on later).


### 6.4 As registered on devnet moutai (2026-09-28)

| | forge-core | forge-collab |
|---|---|---|
| Id | `6DJ3px1ZDGpx9kvLEMDuLdLtHo4WYirWzyJ2GVWegGux` (unchanged, now version 2) | **`8QRpVzGbGaGTxUKp2Z7eRDfyWxs9HRGXWX9N8KREZgsJ`** (supersedes `6BbENuf3…`) |
| Transition | `DataContractUpdate`, identity-contract nonce 2 | `DataContractCreate` v1, nonce 4, enrols in the same group |
| Signed size | 13,716 B | 19,461 B of 20,480 B |
| Cost | 0.680826 DASH | 0.738030 DASH |
| Group `FtHLFE1xLqn7s6FzS56GbY6Hh6KgLjCezNJ8HLUNJ3mc` | still a whole-contract member (proved read after the update; a group-bound key registered before the update pushed after it) | enrolled |

The live acceptance checks of §7 C-1 (`forge-contracts/scripts/verify-c1.mjs`, two identities minted for the run) passed 8 / 8: forge-core is version 2 with `runner` and `topic`; a runner's `checkRun` is accepted and, once the runner membership is deleted, the same identity's next one is refused at consensus (40120); a `completed` run without a conclusion is refused by `conclusionIfDone`; a `policy` with `requiredChecks` is accepted; a `watch` is created and deleted by values; `count` on `topic.byName` counts the tagged repo; `ranked(starBeat, oldest)` returns the seeded order.

**Re-registered fresh after the beta.6 reset (2026-09-28).** That chain was wiped, and with it the ids above. Both contracts were registered fresh on drive 4.2.0-beta.6:

| | forge-core | forge-collab |
|---|---|---|
| Id | `A2KL77ngVM1ft1t1em2XKt1rWCBZANdAJMyfWrDGCcd1` (version 1) | `C1zHeeG7EUudXdB5ZyDQnXVU35hrCfvd1fRCybXEqaPS` |
| Transition | `DataContractCreate` v1, nonce 1, registers the group | `DataContractCreate` v1, nonce 2, enrols in the same group |
| Signed size | 14,515 B (the closed gaps above) | 19,461 B of 20,480 B (schema unchanged) |
| Cost | 0.686679 DASH | 0.738022 DASH |
| Group | `6dV3kMBWHGR7pLKrHToMBQgbTpjqeE2VAyCEWmLbrkWC` | enrolled |

`verify-c1.mjs` then passed 7 of its 8 checks:
- **Passed:** `runner` and `topic` are present; the runner check-run passes and is refused after revocation (40120); `requiredChecks`; `watch`; the topic count; the ranked starBeat order.
- **Failed on the client side only: the `conclusionIfDone` check.** The node refused the run as it should, but the beta.5 JS SDK decoded the reason as a `maxBytes` error ("over its maxBytes"), because platform#5053 moved the basic consensus errors one place. The check matches the rule name, so it failed. It passes once the SDK is on beta.6.

How the clients carry the C-1 types (PR (b)):

- **Topics**: the owner writes both `repo.topics` (what repo pages show) and the `topic` documents (what Explore counts per topic). `repo.topics` is authoritative in every client: `dg repo topic --add/--remove`, `dg repo edit --topics` and the web Settings save replace it, then reconcile the documents to it (`Collab::set_topics` / `reconcile_topic_docs`, `syncTopicDocs`), which also back-fills a repo tagged before C-1. The web prices the save against the documents it holds.
- **Watch**: the inbox reads `watch.byOwner` as a subscription source (reason `watched`, whatever the star preference), so a watch follows the viewer to every device.
- **Pin**: the Issues tab shows the repo's pinned issues above the list (folded from the feed it already reads, `pinnedTargets`); `dg issue list` lists them first.
- **Lock**: a client rule, like archiving. The web composer and `dg issue comment` refuse a non-member's comment on a locked thread before signing; consensus still admits one, and the web marks it "posted while locked".
- **Most forked**: Explore ranks `repo.forkOf` in one proved read (the fresh core's ranked index). Repos that are not forks form the index's null group (empty key, null value), which the reader drops, asking for one more row (`readMostForked`).
- **Milestones**: `dg issue milestone` accepts only an open milestone the repo defines (the web picker offers the same list); the web reads milestones for members only.

**forge-collab's size is a lifetime budget:** every future additive change to forge-collab must fit the ≈ 1 KB left (an update carries the whole contract), or go in a new contract.

---

## 7. Implementation plan

Groups A–F are independent and can run as parallel agents; each item is one PR with acceptance tests on moutai (`E2E_DEVNET=moutai`, Playwright `forge-web/e2e/*.spec.ts`; CLI `e2e/cli/run.sh`). Items marked **[contract]** wait for C-1. Every web PR asserts its request budget with the existing request interception (`perf-scale/measure`), and every CLI PR asserts request counts through `RUST_LOG=rs_dapi_client=debug` counting.

### Group C — the final contract revision (serial, first)

- **C-1 contracts: final forge-core update + forge-collab registration [contract]** — §6 schemas; `contract-validate --previous` proves forge-core is an update; deploy `--only collab --force-new`; fixture re-seed; `cost.ts`/`forge-core::cost` calibrated; **the star fee gate measured** (steady-state star with/without axes, unstar refund) and the `star`/`starBeat` decision recorded in forge-v2.md. Tests: live negative tests (a writer's `checkRun` under a revoked runner refused 40120; `policy.requiredChecks` accepted; a `watch` delete by values); `documents.ranked` on `star` with `oldest` returns the seeded order; `count` on `topic.byName`.
- **C-2 rules + vectors** — `checks_state`, `milestone` fold, pin/lock/assign kinds, trending decode; Rust + TS parity harness; `FORGE_RULES_V2` doc table.

### Group P — performance (no contract dependency; start immediately)

- **P-1 web: shared token bucket + rate-limit handling** — `lib/sdk/budget.ts`, `BroadcastChannel`, `ratelimit-reset` wait, contracts seeded from `deployments`, sticky node. Test: Playwright with a mocked `ResourceExhausted` shows "waiting" and completes; zero `getDataContract` per page.
- **P-2 web: delta caches** — IDB stores for refs/config/feed/manifests/fragments/chunks; `readRefs`/`readConfigBundle`/`readRepoFeed`/`loadBrowseContext` read `> cursor`. Test: second load of `forge-v2-demo` home ≤ 5 DAPI requests; a push from the CLI appears after one delta read; fixture with 300 ref updates resolves identically to the full read (parity test against `queryAllDocuments`).
- **P-3 web: composite chrome and list pages** — §3.3 plans; `lib/sdk/composite.ts` wrapper with the plain-query fallback; DPNS/profile bound lookups. Test: issues list cold ≤ 6 requests, PR list ≤ 7, issue page ≤ 3, Explore ≤ 8; names and counts equal the per-query results (parity test).
- **P-4 web: rail and bundle** — `CloneBox` lazy reader; evo-sdk chunk split after first paint; blob virtualisation (D-315). Test: branches page ≤ 4 requests; Lighthouse bundle budget; Slow 3G smoke.
- **P-5 CLI: contract memo + delta caches + composite `dg pr list` / `issue list`** — `~/.cache/dash-forge`, `.git/dash/refs.jsonl`. Test: `dg pr list` on `gh-bvs-mirror` ≤ 6 requests; `git fetch` with nothing new ≤ 4 requests and downloads nothing; incremental fetch downloads only the new pack.
- **P-6 CLI: push pipelining + cost previews** — window-8 chunk creates, config read once, browse-index chunks in the estimate (D-311/D-514/D-610), first-write surcharge shown. Test: `make storage-e2e` push of 100 chunks ≥ 3 chunks/s; estimate within 25 % of the charge on three fixtures.

### Group F — feature gaps, web + CLI (parallel; those marked [contract] rebase on C-1)

- **F-1 issues: edit, labels picker, assignees, filters/sort/search, paging, URL state** — D-216/215/201/217/904/913. Test: Playwright edits a title ("edited"), assigns COLLAB (`addressee` query finds it), filters by label, pages past 100 on `dips`.
- **F-2 repo settings: default branch, protection, archive, policy UI; `dg repo edit/policy/archive`** — D-503. Test: web sets `refs/heads/main` protected → a writer's CLI push is refused E601; archive disables composers.
- **F-3 profiles, `/u?id`, topics, watch, contribution graph [contract for topic/watch]** — D-908/D-222. Test: profile written from Settings shows on `/u`; `topic` count on Explore.
- **F-4 Explore: paging, trending/most-starred/most-followed, releases via composite, topic/language filters [contract]** — D-903. Test: trending order equals a client recount of the seeded stars within the window; page 2 of recent repos.
- **F-5 code browsing: permalinks, `#L` anchors, images, README links, commits paging, path history, blame, LICENSE, languages** — D-303/304/307. Test: Playwright deep links, blame on a 3-commit file matches `git blame`.
- **F-6 releases fixes + protected tags + signed-commit badges** — D-305/D-504/D-517/D-909. Test: release order on ripgrep; a signed fixture commit shows "Verified" with the key in `profile.pubkeys`.
- **F-7 milestones, pin/lock, cross-references, auto-close on merge [contract for milestone]** — Test: "Fixes #1" in a merged PR offers and closes #1; a locked issue hides the composer for CONTRIB.
- **F-8 import: GitLab source, `--since`, D-602/603/605/606 fixes; `dg repo export`** — Test: import a small GitLab project on moutai; export → re-import round trip is a no-op at cost 0.

### Group I — CI

- **I-1 `dg ci` + `runner` membership + `checkRun` writer/reader in forge-core [contract]** — Test (CLI e2e): `dg ci runner new` mints and enrols; a checkRun-bound `dfk1` key posts a run; the same key's `refUpdate` is refused (`ContractBoundedKeyOutOfBoundsError`); revoke → next replace refused.
- **I-2 web: Checks tab, merge-box row, required checks policy** — Test: seeded failing run blocks a writer's merge, maintainer override works, passing run enables.
- **I-3 `forge-check-action`** (GitHub) — Test: the repo's own CI posts a run for `mirror-ci-dash-faucet` and the web shows it.
- **I-4 `forge-runner` (act wrapper, Docker)** — Test: a devnet e2e runs `.forge/workflows/ci.yml` on a push, uploads the log to RustFS, the web streams and verifies it.
- **I-5 relay: in-place `checkRun` updates, GitHub-parseable ids, web-base-url** — D-604/605/606.

### Group R — review parity (unchanged; review spec §7 PRs 2–7, rebased on C-1 and P-3)

Order of merges: P-1 → P-2 → P-3 (web) and P-5 → P-6 (CLI) first, C-1 in parallel, then everything else. The mainnet registration (roadmap D-J/D-D) happens after C-1 has run on moutai for the whole of Group F and I with the nightly green for 14 days.

---

## 8. Verification notes and unverified items

- Composite bound `field` as a dotted DPNS index property (`records.identity`): to verify in P-3; fallback stated.
- Whether the gateway's 150/min is per node or per network: assume per node; measure on moutai in P-1.
- Maximum proof size for a 10-sub-query composite: not found in source; measured in P-3.
- `ownerRefersTo` on an indexOnly type (for a cheaper `topic`): not verified; `topic` is specified as a stored type.
- Per-star fee figures in §4.4 are estimates from the fee tables; C-1 measures them.
- `IN_TIME_RANGE` on the ranked surface with `oldest` = "trailing ~range" is per the proto comment (`platform.proto:1167-1180`); the exact window boundaries are re-derived by the verifier from the quorum-signed time, so "trending this week" is proved, not trusted.
