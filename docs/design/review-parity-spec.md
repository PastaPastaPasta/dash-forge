# Pull-request review: GitHub parity gap analysis and spec

Status: contract registered on moutai 2026-09-27 (§3.9); proposal otherwise, 2026-09-26. Owner goal: the PR review experience is "perfect", with parity to GitHub's review flow. This document lists every gap between what Dash Forge will have once `feat/web-launch-ux-c1` and `-c2` land and what GitHub offers, decides for each whether it needs a contract change, gives the data model, the client rules (FORGE_RULES_V2 additions with conformance vectors), the cost, and the UX, and ends with an implementation plan split into PRs with acceptance tests.

Baseline read from `origin/master` and the two in-flight branches on 2026-09-26: `forge-contracts/contracts/forge-collab.json`, `docs/contracts/forge-v2.md`, `forge-web/lib/rules/v2.ts`, `lib/repo/{issues,writes,anchors}.ts`, `lib/view/{pull-actions,review-fold,inline-threads,issues-view}.ts`, `components/repo/{pull-content,pull-diff,diff-view,inline-comments,merge-panel,approvals,timeline}.tsx`, `lib/merge/*`, `crates/dg/src/pr.rs`, `crates/forge-core/src/collab/v2.rs`, `docs/design/ux-dx-spec.md` §5.7.

Constraints that shape every decision below (`docs/research/platform-constraints.md`): one document operation per state transition (a "batch" of N documents is N sequential, nonce-ordered transitions), 5 KiB per field, 20 KiB per signed transition, indexed strings ≤ 63 chars (so ids and hashes are indexed, never names), 100 documents per query page, no push subscriptions (liveness is client polling), and we host nothing: no server holds drafts, sends notifications or merges on anyone's behalf.

---

## 1. What exists after C1 + C2 land

| Area | State |
|---|---|
| PR page | Title, status pill (Open / Draft / Closed / Merged), "wants to merge into", head oid, "Objects live in repo …" box with `dg pr checkout` copy line, description card, Approvals card (the §6 fold shown exactly: counted approvals by role, changes requested, stale, not-member, author approval), merge panel, Files changed, a single conversation timeline (comments, events, review verdicts), one "Review" textarea with Comment / Approve / Request changes / Comment only, Close/Reopen, Mark as merged |
| Diff | Merge-base comparison across two repos (base + fork), unified and side-by-side (≥ 1024 px), hide-whitespace toggle, colour-blind palette, file list with jump, per-file collapse, paged files and rows, placeholders for binary/large |
| Inline comments | Click a line number → composer; `comment` doc with `path`, `line`, `side`, `commitOid` (contract fields; a `<!-- forge-anchor -->` body block is still accepted on read); replies via `replyTo`; threads on the current head shown under their line; others collapsed under "n comments on an older version"; "n threads on lines not shown below" |
| Verdicts | One immutable `review` doc per click (verdict 1/2/3, `commitOid` = head, optional body). Only current maintainers/writers count (`countApprovals`) |
| Merge | Browser merge for a maintainer/writer: fast-forward or clean 3-way merge commit via isomorphic-git in a worker, resumable step list (fetch → merge → pack → upload → packManifest → index → refUpdate → merge event), storage to the merger's bucket or costed Platform chunks; conflicts → disabled button with the checkout line; writers blocked on protected branches; narrow screens blocked |
| Open a PR | `/repo/pulls/new`: base and compare pickers (own forks listed), diff before submit, title from head commit, draft kept across sign-in |
| Fork | Fork button (repo + manifests referencing the parent's packs + refs) |
| CLI | `dg pr create/list/view/checkout/review/merge/close/reopen/diff`; `review` posts one verdict on the current head, body only, no inline comments |

Key structural facts: `patch.headOid` is written once at creation and nothing on `master`, C1 or C2 updates it afterwards (no PR "follows" its branch, so "stale — new commits since" can never trigger from a push); there is no document replace primitive in `forge-web/lib/sdk` (so no edit title/body/comment); `event` (M/W) and `authorEvent` (author, kinds 1–2 only) are the only state channels; the `checkRun` type exists but nothing reads it.

---

## 2. Gap list

Priority: **P0** = required for "perfect review" parity at launch; **P1** = next; **P2** = later or deliberately different. "Contract" says whether the forge-collab schema must change (all such changes ship in the single revision of §3). Costs use the measured model in `forge-web/lib/sdk/cost.ts` (1 DASH = 10^11 credits; comment 47.3M + 27.5k/byte, review 34.9M + 27.5k/byte, event 50M, authorEvent 56.6M, refUpdate 45M, packManifest 60M + bytes, patch 112M). Rounded: comment ≈ 0.0005 DASH, event ≈ 0.0005, review ≈ 0.00035, packManifest ≈ 0.0006, refUpdate ≈ 0.00045.

### 2.1 Review workflow

| # | Gap | Pri | Contract | Notes |
|---|---|---|---|---|
| R1 | **Pending review**: add several inline comments, then submit once as Comment / Approve / Request changes with a summary. Today every inline comment is posted immediately and the verdict is separate. | P0 | yes: `comment.reviewId`, `review.commentCount` | Drafts are local (IndexedDB) until submit; nothing on chain until then, which matches GitHub's "pending" privacy. Submit = 1 review + N comments, sequential transitions. §4.1 |
| R2 | **Single comment vs start a review** on a line (GitHub's two buttons) | P0 | no | Single = a `comment` without `reviewId` (today's behaviour). Start review = R1 draft |
| R3 | **Multi-line comments** (drag-select a range) | P0 | yes: `comment.startLine` | §4.2 |
| R4 | **File-level comments** (no line) | P1 | no (`line` already optional) | Anchor with `path`, no `line`; rendered at the file header. Reader rule change only |
| R5 | **Suggestion blocks** (```` ```suggestion ````) rendered as a diff; **Apply suggestion** and **batch apply** as one commit to the head branch | P0 | no | Markdown convention + a browser commit to the source repo's branch (§4.5). Needs writer/maintainer on the *source* repo (the fork), so usually the PR author. Applied state is derived from a commit trailer, no extra document |
| R6 | **Reply threads** on inline comments | done (C1) | — | `replyTo`; keep |
| R7 | **Resolve / unresolve conversation** | P0 | yes: event kinds 11/12 + `refId` on `event` and `authorEvent` | §4.3. Members and the PR author (GitHub rule). ≈ 0.0005 DASH per toggle; the button shows the price |
| R8 | **Outdated comment detection** + show outdated | done (C1); polish P1 | no | Add "View on commit abc1234" link to the commit diff where the comment was made; P2: render the old hunk inline |
| R9 | **Re-request review; requested reviewers list** | P0 | yes: event kinds 13/14 + `refId` | §4.4. Sidebar "Reviewers": approved / changes / commented / awaiting. Author and members may request |
| R10 | **CODEOWNERS-like reviewer suggestions** | P2 | no | Client reads `.forge/CODEOWNERS` (and `.github/CODEOWNERS` for mirrors) from the base tree, matches changed paths, suggests members. Never enforced |
| R11 | **Dismiss a review** (maintainer, with reason) | P0 | yes: event kind 15 + `refId` (+ `value` reason) | §4.4. `countApprovals` gets a dismissed set; a dismissed review is treated as "commented" |
| R12 | **Reviewer status sidebar** (approved / changes requested / commented / pending) | P0 | no | Rework `Approvals` into a right-rail "Reviewers" card fed by `summarizeReviews` + requested reviewers |
| R13 | **Re-review on new head; "new commits since your review" banner** | P0 | depends on R14 | Reviewer sees "You reviewed abc1234; 3 commits since. Re-review" |
| R14 | **PR head follows the branch** (pushes update the PR; "added 3 commits" timeline items) | **P0, blocking** | yes: event/authorEvent kind 16 `headUpdate` with `oid`; `patch.headOid` becomes immutable (initial head) | §4.6. Explicit, cheap (one event), auditable; `git push` / `dg pr sync` post it; the web shows "Your branch is ahead of this PR — Update PR head" |
| R15 | Edit / delete your own comment ("edited" marker) | P0 | no | `comment` is owner-mutable and deletable already. Needs a `replaceDocumentIdempotent` primitive in `lib/sdk/write.ts` (also used by R21). "edited" when `$updatedAt > $createdAt`. Reviews are immutable: "Reviews can't be edited; dismiss or post a new one" |
| R16 | Review comments on a **specific commit** (Commits tab → diff → comment) | P2 | no | `commitOid` already carries it; placement rule: shown on that commit's diff and in Conversation; "outdated" in Files changed unless it is the head |
| R17 | Reactions | out | — | Each reaction is a paid document (≈ 0.0003 DASH) and a delete for un-react; not worth it. Say so in FAQ |

### 2.2 PR page and information architecture

| # | Gap | Pri | Contract | Notes |
|---|---|---|---|---|
| P1 | **Tabs: Conversation · Commits (n) · Checks (n) · Files changed (n)** | P0 | no | `?tab=commits|checks|files`; short URLs `/alice/project/pull/7/files`. Counts: comments+reviews, commits between merge base and head, latest `checkRun` per name on the head, files in the comparison |
| P2 | **Commits tab**: list with author, time, subject, oid; click → commit diff (`commit-content` exists) | P0 | no | Walk from the effective head to the compared base oid with `lib/view/commit-log.ts`; cap 250 with "show more" |
| P3 | **Checks tab / merge box checks row** from `checkRun` docs | P1 | no | Read index `head (repoId, headOid, $createdAt)`; newest per `name`; status/conclusion/detailsUrl/summary. Written by a user-run relay or CI action (roadmap). Informational unless policy (M4) says required |
| P4 | Right rail: Reviewers · Labels · Assignees · Milestone · Linked issues · "Objects live in" · checkout line | P0 (milestone P2) | milestone: kinds 17/18 reserved | Labels/assignees reuse the issue pickers (events exist). Milestone as `value`-carrying events; no milestone document type |
| P5 | **Edit title / description** (author) | P0 | no | Replace the `patch` document (owner-only, history kept). Members cannot edit an author's PR: say so ("Ask @author to edit; you can retarget, label or close") |
| P6 | **Draft PRs**: open as draft, "Mark ready", author-driven | P0 | yes: `patch.draft`; `authorEvent` accepts kinds 9/10 | §4.7 |
| P7 | Close / reopen | done | — | keep |
| P8 | **Link issues** ("Fixes #12" in body or commits) with backlinks and **auto-close on merge** | P1 | no | Parse `(close[sd]?\|fix(e[sd])?\|resolve[sd]?)\s+#(\d+)`; merge dialog offers a checklist "Also close #12, #13 (2 events, ≈ 0.001 DASH)"; issue page shows "may be fixed by #7" by scanning open PRs |
| P9 | PR list: filters (author, label, reviewer, draft, "review requested for me"), counts, search | P1 | no | Client-side over the fetched page; MiniSearch |
| P10 | **PR templates** | P1 | no | `.forge/PULL_REQUEST_TEMPLATE.md`, fallback `.github/PULL_REQUEST_TEMPLATE.md`, read from the base default branch at compose time |
| P11 | Compare view before opening | done (C1) | — | Add the commit list to the compare page (P1) |
| P12 | Notifications for review comments, review requests, replies, assignments | P1 | yes: indices `event.addressee (refId, $createdAt)`, `authorEvent.addressee`, `comment.reply (replyTo, $createdAt)` | Inbox feeds: "addressed to me" (requests, dismissals of my review), "replies to my comments". Mentions: P2, scan comments of watched repos for `@myname` |
| P13 | @mentions autocomplete (members + participants, DPNS names) | P1 | no | Renders `@name` as a link. No notification guarantee (client polling only), stated in the composer help |
| P14 | Markdown Write / Preview tabs, toolbar, drag-drop images | P1 (images P2) | no | Preview via `MarkdownView`. Images: upload to the user's own storage profile, insert the URL; no Forge-hosted images |
| P15 | Keyboard shortcuts (`j/k` files, `c` comment, `r` reply, `n/p` threads, `?` help) | P2 | no | |
| P16 | Mobile review: composer usable at 390 px, unified diff, sticky file header, merge blocked with "use a desktop browser" (exists) | P1 | no | Playwright at 390×844 with axe |
| P17 | Comment and line permalinks (`#c-<id>`, `#L<path-hash>-R12`) | P1 | no | |

### 2.3 Files changed

| # | Gap | Pri | Contract | Notes |
|---|---|---|---|---|
| F1 | Side-by-side / unified, hide whitespace, palette | done (C1) | — | |
| F2 | **File tree** panel with filter (path, extension, "with comments", "not viewed") | P1 | no | ≥ 1280 px: left tree; below: dropdown |
| F3 | **Viewed** checkboxes with progress bar; auto-uncheck when the file's head blob changes | P1 | no | Local (IndexedDB) keyed `(prId, path, headBlobOid)` |
| F4 | **Expand context** ("⋯ 12 unchanged lines" → expand up/down/all) | P1 | no | Both blobs are already loaded for the patch |
| F5 | Syntax highlighting in diffs; intraline (word) highlight | P1 | no | Shiki is already lazy-loaded for blobs |
| F6 | Rich diff for Markdown; image diffs | P2 | no | |
| F7 | Conflict display: list of conflicting files (engine reports paths) | P0 | no | Under the disabled merge button: "Conflicts in src/a.rs, README.md" + checkout line. Inline markers: P2 |
| F8 | Jump to file, collapse all / expand all | P0 (exists partly) | no | |

### 2.4 Merge box

| # | Gap | Pri | Contract | Notes |
|---|---|---|---|---|
| M1 | Merge methods: fast-forward, merge commit (C2), **squash** | P1 | no | Squash = one commit whose tree is the merged tree and whose parent is the base tip; message = title + body + `Co-authored-by` for each PR commit author. Rebase: P2 (per-commit replay) |
| M2 | Merge message editor (title/body) before the click | P1 | no | |
| M3 | **Merge box states**: mergeable / conflicts / protected / checks failing / approvals vs policy / head stale vs branch / base moved since the check | P0 | no (M4 for policy) | One card, GitHub-style rows with icons; button label says the action (C2) |
| M4 | **Branch protection policy display** (required approvals, maintainer-only approvals, required checks, allowed methods) | P1 | yes: new `policy` doc type | §4.8. Client-enforced in the merge box, labelled "policy (client rule), a maintainer can override"; never consensus |
| M5 | Auto-merge | out | — | Needs a party online to merge; we host nothing. Instead: inbox item "PR #7 is now mergeable" (P2) |
| M6 | **Update branch** (merge base into head) | P1 | no | A merge commit pushed to the source branch in the source repo (needs source-repo write access) followed by `headUpdate`; same engine as R5 |
| M7 | Delete source branch after merge | P1 | no | `refUpdate` with `newOid` = null on the source repo (needs write access there); offered when the merger has it |
| M8 | Revert PR (open a revert PR) | P2 | no | Revert commit on a new branch + `patch`; browser commit engine |

### 2.5 CLI parity (`dg`)

| # | Gap | Pri | Notes |
|---|---|---|---|
| C1 | `dg pr review` with inline comments: `--file <path> --line N [--start-line M] [--side old\|new] --body "…"` repeatable, `--body-file`, one review + N comments (R1) | P0 | Prints "7 documents, ≈ 0.0035 DASH" before confirming; resumable journal like `create_patch` |
| C2 | `dg pr comment <n> --body [--file --line --side] [--reply-to <id>]` | P0 | single comment |
| C3 | `dg pr view --comments` shows threads with `path:line`, resolved state, suggestions; `--json` stable shape | P0 | |
| C4 | `dg pr checks <n>` | P1 | reads `checkRun` |
| C5 | `dg pr commits <n>` | P1 | |
| C6 | `dg pr edit <n> --title --body`; `dg pr sync <n> [--head <oid>]` (R14); `git push` hint / `dash.prAutoSync` | P0 | |
| C7 | `dg pr ready <n>` / `dg pr draft <n>`; `dg pr create --draft` | P0 | |
| C8 | `dg pr resolve <n> <comment-id>` / `unresolve` | P0 | |
| C9 | `dg pr request-review <n> <identity\|@name>` / `--remove` | P0 | |
| C10 | `dg pr dismiss-review <n> <review-id> --reason` | P1 | |
| C11 | `dg pr merge --squash`, `--message`, `--delete-branch` | P1 | |
| C12 | `dg pr update-branch <n>` | P1 | |
| C13 | `dg pr suggestion apply <n> <comment-id>… [--all]` | P1 | Shares the suggestion parser with the web (vectors) |
| C14 | `dg pr diff`, `dg pr checkout` | exist | keep |

---

## 3. The contract revision (one re-registration)

All schema changes below ship together as one forge-collab re-registration on moutai (`deploy-v2.mjs --only collab --force-new`), with `seed-v2-fixture.mjs` re-run and `deployments/devnet-moutai.json` updated. forge-core is untouched, so the group and forge-core ids stay. No backward compatibility: readers of the old contract id are removed, the `<!-- forge-anchor -->` body-block fallback is deleted, and the fixture is re-seeded under the new id. Mainnet is not deployed, so nothing is migrated.

### 3.1 `comment` — additions

| Field | Type | Position | Purpose |
|---|---|---|---|
| `startLine` | integer 0..2^32−1, optional | 11 | First line of a multi-line anchor; `line` is the last. Client rule: present only with `line`, and `startLine ≤ line`, else the anchor is malformed (shown as a general comment) |
| `reviewId` | 32-byte identifier, optional | 12 | The `review` this comment belongs to (R1). `refersTo: { type: "deletableDocument", documentType: "review", propertyAgreement: { "repoId": "repoId", "patchId": "targetId", "$ownerId": "$ownerId" } }` |

The `$ownerId` agreement makes "only the reviewer can attach comments to their review" and "the review is on this PR" consensus rules. `tools/contract-validate` must confirm that `$ownerId` is accepted in a plain `refersTo` agreement (forge-v2.md §1 documents it for the maintainer gate); if it is not, drop that key and rely on the reader rule (§5.3), which filters by owner anyway. `deletableDocument` is required because `review` is deletable; a deleted review orphans its comments, and readers show them as ordinary inline comments.

New index: `reply` on `(replyTo asc, $createdAt asc)` for the inbox ("replies to my comments").

Removed: nothing. Kept: `path`, `line`, `side`, `commitOid`, `replyTo`.

### 3.2 `review` — additions

| Field | Type | Position | Purpose |
|---|---|---|---|
| `commentCount` | integer 0..65535, optional | 8 | How many `reviewId` comments the submit intends to write. Readers show "2 of 5 comments have landed" while a submit is in flight and detect a review whose comments never all arrived |

Stays immutable and deletable. Verdict 1/2/3 unchanged.

### 3.3 `patch` — additions

| Change | Purpose |
|---|---|
| `draft` boolean, optional (position 14) | Opened as a draft (P6). The fold seeds `draft` from it; `draft`/`ready` events override in time order |
| `headOid` added to `immutable` | The document records the *initial* head; later heads are `headUpdate` events (R14). One source of truth for "what changed" |
| Index `sourceRef` on `(sourceRepoId asc, sourceRefNameHash asc)` | "PRs from this branch": the push helper and `dg pr sync` find the PR a pushed branch belongs to without paging the repo's PRs |

Title and body stay author-mutable (P5).

### 3.4 `event` (M/W) — additions

| Change | Purpose |
|---|---|
| `refId` 32-byte identifier, optional (position 6) | The thread root comment (11/12), reviewer identity (13/14), review id (15) |
| Index `addressee` on `(refId asc, $createdAt asc)` | Inbox: events about me (review requests) or my documents (dismissals of my review) |
| Kinds (documented, `kind` stays 1..255) | 11 `threadResolve`, 12 `threadUnresolve`, 13 `reviewRequest`, 14 `reviewRequestRemove`, 15 `reviewDismiss` (`value` = reason ≤ 120 chars, plaintext even in private repos, so the UI keeps it optional and short), 16 `headUpdate` (`oid` = new head), 17 `milestoneSet` (`value`), 18 `milestoneClear` |

### 3.5 `authorEvent` (the PR/issue author) — widened

| Change | Purpose |
|---|---|
| `kind` becomes `enum: [1, 2, 9, 10, 11, 12, 13, 14, 16]` | Author may close/reopen (as today), mark draft/ready, resolve/unresolve threads, request/remove reviewers, and move the head. Never merge, label, assign, retarget or dismiss — consensus refuses those kinds |
| `refId` (position 4), `oid` (position 5), both optional | As on `event` |
| Index `addressee` on `(refId asc, $createdAt asc)` | As on `event` |

`ownerRefersTo` is unchanged (the author lookup through the `author` unique index with `targetId = $id` agreement).

### 3.6 New type `policy` (maintainers)

```json
"policy": {
  "type": "object",
  "documentsMutable": false,
  "canBeDeleted": false,
  "ownerRefersTo": { "type": "deletableDocument", "contractId": "FORGE_CORE_CONTRACT_ID", "documentType": "maintainer",
                     "lookup": { "index": "byRepoMember", "keys": { "repoId": "repoId", "memberId": "." } } },
  "properties": {
    "repoId":            { "$ref": "#/$defs/id", "position": 0 },
    "requiredApprovals": { "type": "integer", "minimum": 0, "maximum": 10, "position": 1 },
    "approverRole":      { "type": "integer", "minimum": 0, "maximum": 1, "position": 2 },
    "requireChecks":     { "type": "boolean", "position": 3 },
    "mergeMethods":      { "type": "integer", "minimum": 0, "maximum": 15, "position": 4 }
  },
  "indices": [ { "name": "created", "properties": [ { "repoId": "asc" }, { "$createdAt": "asc" } ] } ],
  "required": [ "$createdAt", "repoId", "requiredApprovals" ],
  "additionalProperties": false
}
```

Newest by `($createdAt, $id)` wins; non-deletable so a revoked maintainer cannot revert it by deletion (same reasoning as `config`). `approverRole` 0 = any member, 1 = maintainers only. `mergeMethods` bitmask: 1 fast-forward, 2 merge commit, 4 squash, 8 rebase; 0 means "any". No text fields, so nothing to encrypt for private repos. It lives in forge-collab rather than forge-core's `config` so forge-core (security-reviewed for private repos) is not re-registered.

### 3.7 Size and fee check

forge-collab is 12,241 B signed today against the 20,480 B limit and 11 types / 23 indexes. This revision adds one type, four indexes and ten optional properties: roughly +1.3 KB and +0.06 DASH registration (0.02/type + 0.01/index), so about 0.61 DASH plus storage. Run `tools/contract-validate` and the deploy dry run before broadcasting; record `schemaHash`.

### 3.8 Write gating summary after the revision

| Write | Who (consensus) | Client precheck |
|---|---|---|
| `patch` create; replace title/body | anyone; owner only | — |
| `comment` create / replace / delete | anyone; owner | `reviewId` → same owner and PR (consensus) |
| `review` create / delete | anyone; owner | only members' verdicts count (§6 rule) |
| `event` kinds 1–18 | maintainer or writer of `repoId` | `readViewerPermissions` |
| `authorEvent` kinds 1,2,9,10,11,12,13,14,16 | the target's author | `viewer === pull.author` |
| `checkRun` | maintainer or writer | — |
| `policy` | maintainer | `holdings.maintain` |
| Commit to the PR branch (R5, M6, M7) | writer/maintainer of **`sourceRepoId`** (forge-core `refUpdate` gate on that repo) | `readViewerPermissions(sourceRepo)` |

### 3.9 As registered (2026-09-27), and what protocol 14 changed

Registered on moutai as forge-collab `BMfPmaEiMqDp64NDa4Am79VoRpZ9MPVNnCUy6i3UiyWi` (nonce 10, same contract group, forge-core unchanged; that chain was wiped on 2026-09-27, and the same schema is now `6BbENuf3uZhkntw9DSsxQcTu9a5fATxQoSe6Ph1JxHkS`, `docs/contracts/forge-v2.md` §8): 14,287 B signed, 12 types, 27 indexes, 0.616306 DASH. Every keyword was checked against rs-dpp / rs-drive `v4.2.0-beta.4` (the tag moutai runs and `Cargo.lock` pins), the document meta-schema v3 and the Platform book, and the schema passes `tools/contract-validate` (full PV14 parse, registration reference checks, sample documents) and `negative.sh`. Where the text above and the registered schema differ, the schema wins:

| Spec (§3.1–§3.6) | Registered | Why |
|---|---|---|
| `comment.reviewId` agreement `{repoId, patchId → targetId, $ownerId}` | `propertyAgreement {"repoId": "repoId", "targetId": "patchId", "$ownerId": "$ownerId"}` on a `deletableDocument` → `review` | The keys are the *referring* properties (book `data-model/documents.md` "Document References"; `$ownerId` is the only system name allowed on the referring side, `REFERRING_SYSTEM_AGREEMENT_PROPERTIES`). The live test proves the refusal: another reviewer attaching to a review gets 40127. |
| New indexes `comment.reply (replyTo, $createdAt)`, `event.addressee` / `authorEvent.addressee (refId, $createdAt)` | single-property `reply (replyTo)` and `addressee (refId)` with `nullSearchable: false` | Book `drive/indexes.md` "null_searchable": a document whose indexed properties are all null is not inserted. With `$createdAt` in the index it is never all-null, so every event and comment would pay for an index entry it does not use. Readers sort the (small) result by `$createdAt`. |
| `patch.headOid` immutable | `immutable: [repoId, number, sourceRepoId, baseRefNameHash, baseRefName, sourceRefNameHash, sourceRefName, headOid, draft]` | Book "Immutable Properties on Mutable Document Types". `draft` is the opening state (events override it). The four ref-name fields are frozen too: `sourceRef` finds a PR by its branch, a retarget is an event, and a private patch's hashes are checked against `enc` on read. A replace that moves `headOid` gets 40128 (live test). |
| (implicit) edit markers | `$updatedAt` and `$updatedAtBlockHeight` required on `issue`, `patch`, `comment` | A replace sets them only when the type requires them (rs-drive `document_replace_transition_action` v0 transformer); "edited" = `$updatedAt > $createdAt`. The block height lets the private late-content rule judge an edit by the network's clock (private-repos.md §8.2). |
| — | `comment.immutable` gains `replyTo`, `commitOid`, `path`, `line`, `side`, `startLine`, `reviewId` | An edit changes the body; the anchor, thread and review membership stay what reviewers saw. In a private repo `path` is inside `enc`, so consensus freezes only the plaintext part of the anchor there. Once a review is deleted, its comments' `reviewId` no longer resolves, and every replace re-validates it: an edit must drop `reviewId` (the one change consensus allows on a dead immutable reference). |
| — | `review.patch (patchId, $createdAt)` becomes `rangeCountable` | A provable review count per PR, and per PR on a list page through one composite `counts` sub-query (§3.10). |
| `event` `enc`/`epoch` (private-repos.md §13 item 6) | added, `dependentRequired {enc: [epoch]}` (meta-schema v3 `dependentRequired`, the pattern every content type uses) | A private repo's member event seals its `value` (label or milestone name, dismiss reason, assignee, retarget base) here: TLV 15 bound to `targetId` (private-repos.md §4.3, §4.4). An event without a value carries no `enc`. |
| `authorEvent.kind` `enum` | `{minimum 1, maximum 255, enum [1, 2, 9, 10, 11, 12, 13, 14, 16]}` | The enum is what refuses; `minimum`/`maximum` keep the stored width a `u8`, like `event.kind` (widths are fixed at registration). A refused kind fails the document schema, which the node checks first; the evo-sdk runs the same check and refuses to broadcast, so the live test sees the schema error, not a consensus code. |
| `policy.mergeMethods` 0..15 | 0..255 | Still a `u8`; room for methods after rebase without a new registration. |
| `patch` index `sourceRef` added | the `source (sourceRepoId)` index is replaced by `sourceRef (sourceRepoId, sourceRefNameHash)` | A query on `sourceRepoId` alone still matches it (a trailing unused property is allowed; PV14 refuses only *gaps*, rs-dpp `Index::matches_contiguous`), so one index serves both "PRs from this fork" and "PRs from this branch" (the 10-per-type limit and the per-index write cost). |

### 3.10 Counts and composite reads (what the indexes serve)

- **Proven counts** (book `drive/document-count-trees.md`): comments per issue/PR (`comment.target`, rangeCountable), reviews per PR (`review.patch`, rangeCountable), issues/PRs ever opened (`number`). A `rangeCountable` index also answers `COUNT WHERE <all but its last property>` (rs-drive `find_countable_index_for_where_clauses`, the prefix-to-last form), which is why `(targetId, $createdAt)` counts per target.
- **Open/closed counts cannot be count trees.** State is a fold over `event` + `authorEvent` (merge validity depends on the base branch history, which no index sees). A stored state field would have to be on the `patch`/`issue` document, which only its author can replace, while members close and merge. A summary document would be an unverified second copy of the fold that any member could write. So the counts stay client-side folds (master's `listIssuesCached` / `listPullsCached`, forge-v2.md §6.1).
- **Requested reviewers** are a fold (newest request/remove per identity), not countable; `addressee` finds them per identity.
- **Composite (one merged proof)**: the PR page can be the `patch` (by `number`) as the page, with `comment`, `review`, `event`, `authorEvent` documents bound from its `$id` to `targetId` / `patchId` (each type has a `(targetId|patchId, $createdAt)` index), plus `counts` sub-queries for comments and reviews. A PR list page can add per-PR comment and review counts the same way (`kind: 'counts'`, bind `$id` → `targetId` / `patchId`), at most 100 bound values and 10 sub-queries (`MAX_BOUND_VALUES`, `MAX_SUB_QUERIES`). Per-target event pages have no count (nothing needs one).

### 3.12 Rules and writers as implemented (PR 2)

The functions of §5 exist in both ports with the signatures below; the vectors (`fold_pr_v2__*`, `fold_issue_v2__issue_state_kind_on_event_inert`, `transition__*`, `fold_review_v2__*`, `approvals__dismiss*`, `policy__*`, `anchor__*`, `review_group__*`, `suggestion__*`, `linked_issues__*`) run in both harnesses.

| Rust (`forge_core::rules::v2`, re-exported from `rules::review`) | TypeScript (`forge-web/lib/rules/v2`) |
|---|---|
| `fold_pr_state_v2(events, author_events, target_author, base_tip, is_ancestor, initial_draft) -> PrState` | `foldPrStateV2(events, authorEvents, targetAuthor, baseTip, isAncestor, initialDraft = false)` |
| `fold_pr_review_v2(events, author_events, target_author, initial_head, &known_roots) -> PrReviewState { head, head_updates, requested_reviewers, resolved_threads, dismissed_reviews, milestone }` | `foldPrReviewV2(events, authorEvents, targetAuthor, initialHead, knownRoots: Set)` |
| `count_approvals(reviews, oracle, head_oid, &dismissed: BTreeSet<review_id>) -> Approvals` | `countApprovals(reviews, oracle, headOid, dismissed = new Set())` |
| `meets_policy(&approvals, oracle, &Policy) -> PolicyStatus { met, have, need }` | `meetsPolicy(approvals, oracle, policy)` |
| `anchor_of(&AnchorFields) -> Option<Anchor { path, line, start_line, side, commit_oid }>` | `anchorOf(fields) -> Anchor \| null` |
| `group_review_comments(review_id, reviewer, comment_count, comments) -> ReviewGroup { comments, landed, expected }` | `groupReviewComments(reviewId, reviewer, commentCount, comments)` |
| `parse_suggestions(body) -> Vec<Suggestion { text }>`; `apply_suggestion(file, start, end, text) -> Result<String, SuggestionError::{BadRange, OutOfRange}>` | `parseSuggestions(body)`; `applySuggestion(...) -> { ok } \| { error: 'badRange' \| 'outOfRange' }` |
| `linked_issues(text) -> Vec<u32>` | `linkedIssues(text) -> number[]` |
| `is_author_kind(EventKind) -> bool` | `isAuthorKind(kind)` |

`Event` gains `ref_id` / `refId`; `EventKind` gains the eight review kinds (`threadResolve`, `threadUnresolve`, `reviewRequest`, `reviewRequestRemove`, `reviewDismiss`, `headUpdate`, `milestoneSet`, `milestoneClear`).

**Writers and readers.**

- forge-core `collab::v2::Collab`:
  - `post_target_event(repo, &Target, EventKind, &EventPayload { value, oid, ref_id }) -> (StateRoute, id)` routes through `kind_route` (member `event`, else the author's `authorEvent` for an author kind) and refuses missing payloads (`event_payload_props`).
  - `review(repo, patch_id, verdict, commit_oid, body, comment_count: Option<u16>, imported)`.
  - `comment(..)` with `CommentAnchor { start_line, review_id, .. }`.
  - `set_policy(repo, &Policy)` and `policy(repo) -> Option<Policy>` (newest wins).
  - `patches_from_branch(forge, source_repo_id, source_ref_name)` uses the `sourceRef` index.
  - `patch_view` returns `PatchView { head, review, log, .. }`; `head` is the folded head, which `approvals`, `head_on_base`, `dg pr view/review/merge/checkout/diff` now use.
  - `PatchView::review_with_threads(&comments)` adds thread resolution; `PatchView::dismissed()` lists the dismissed reviews.
  - `approvals(repo, &PatchView)` takes the view, so dismissals and the folded head are applied.
- forge-web `lib/repo/review-writes.ts`:
  - Events: `postTargetEvent(sdk, auth, repo, { target, kind, author, isMember, payload: { value, oidHex, refId } })`, with `eventRoute` and `targetEventData`.
  - Comments and reviews: `postComment(..., { targetId, body, replyTo, anchor: { path, line, startLine, side, commitOid }, reviewId })`, plus `commentData`, `anchorData` and `reviewData`.
  - Pending review:
    - `ReviewDraft` is stored in the IndexedDB journal under `review:<network>:<identity>:<prId>` (`saveReviewDraft` / `loadReviewDraft` / `discardReviewDraft`).
    - `submitReviewDraft(sdk, auth, repo, draft, onProgress)` writes the review with `commentCount`, then each comment with `reviewId`. Each write's intent is `review:<draftId>:<step>`. The draft is saved after every landed document, so a retry resumes.
  - `setPolicy(sdk, auth, repo, policy)`.
  - Edits: `updateTarget(..., { type, id, title, body, expectedRevision })` and `updateComment(..., { id, body, dropReviewId, expectedRevision })`, both over `replaceDocumentIdempotent`.
- forge-web `lib/sdk/write.ts` `replaceDocumentIdempotent(sdk, auth, { contractId, documentType, documentId, changes, expectedRevision })`:
  - reads the stored document, refuses a non-owner before signing, and signs nothing when the changes already hold (idempotent by content);
  - writes revision + 1 through the SDK's replace builder, and settles an unanswered wait by reading back.
  - The cost preview is `previewReplace` (17M + 27.5k per changed byte).
- forge-web `readPull` returns `headOid` (folded), `initialHeadOid` and `review: PrReviewState` (without thread roots), and seeds `draft` from the document. `readReviews` returns `commentCount`. `loadPullThread`'s approvals skip dismissed reviews. `toEvent` maps kinds 11–18 and `refId`.

**Private repos.** These writers are plaintext. `writeRepoDoc` and `replace` refuse an issue, PR, comment or review in a private repo (`refusePlaintextInPrivate`), and so do a review submit and every edit. The sealed versions (`lib/private` `sealDoc`, forge-core `private::open_content`) are wired by private-repo PR 2 (CLI sealing) and web PR #51. A private PR edit re-seals under the patch's own epoch (private-repos.md §4.5).

**forge-relay** follows the head too:
- `TargetInfo::apply_head_update` applies an update only when it is newer by `($createdAt, $id)`, so reading the `event` and `authorEvent` streams one after the other still gives the fold's head.
- The webhook's `head.sha` and the check-run watch use the current head.
- A head move is a `pull_request` `synchronize`.

**Timeline.** The web timeline has labels for the review kinds: "pushed new commits", "resolved a conversation", "requested a review from …", "dismissed a review: …", "set the milestone to …", and draft/ready.

**Not in PR 2** (the web and CLI PRs):

- The `readAnchor` → `anchorOf` swap in C1's `lib/repo/anchors.ts` and `inline-threads.ts`. Those files land with C1; `anchorOf` is ready for them.
- The C1/C2 `createPatch` gaining `draft`.
- `review-fold.ts` rows for requested and dismissed reviewers.

### 3.11 Measured costs (moutai, 2026-09-27, under the registered contract)

Two figures matter: a **steady-state** write into index subtrees that already exist, and a **first write** that also creates them (a PR's first comment creates the comment subtree for that `targetId`, a repo's first issue the `repoId` subtrees). Measured on fresh repos:

| Write | first write | steady state | ≈ DASH (steady) |
|---|---|---|---|
| `issue`, 10-byte title | 82.5M (the repo's first) | 58.4M | 0.00058 |
| `issue`, 10 + 1,000-byte body | — | 86.1M | 0.00086 |
| `comment`, 10-byte body | 58.2M–64.4M (the target's first) | 48.2M | 0.00048 |
| `comment`, 4,000-byte body | — | 157.8M | 0.0016 |
| `comment`, range + `reviewId` + 11-byte path, 10-byte body | 76.9M | ≈ 60M | 0.0006 |
| `patch` (draft, 10-byte title, both ref names) | 114.9M (the repo's first) | — | ≈ 0.0011 |
| `review`, verdict only, `commentCount` | 37.6M (the PR's first) | — | ≈ 0.00035 |
| `event` with `refId` (request / resolve / dismiss + 20-byte reason) | 64.6M–80.7M | — | ≈ 0.0006 |
| `authorEvent` `ready` / `headUpdate` (with `oid`) | 55.2M / 71.9M | — | ≈ 0.0006 |
| `policy` | 33.9M | — | 0.00034 |
| `patch` replace (title, same length) | — | 17.0M | 0.00017 |
| `comment` replace (body 10 → 20 bytes) | — | 3.9M | 0.00004 |

Steady-state `issue` and `comment` match the pre-revision model within 2% (`$updatedAt` and the sparse indexes add almost nothing), so forge-web `lib/sdk/cost.ts` keeps its calibration and adds `policy`. §2/§6's per-type numbers stand as steady-state estimates; a confirm dialog for a PR's first comment, review or event should allow for 10–25M more. The §4.1 example (300-byte summary + 6 × 150-byte comments) stays ≈ 0.0035 DASH steady-state, ≈ 0.004 when the review and first comment create their subtrees. An edit is cheap: a replace pays for the changed bytes, not a new document.

---

## 4. Feature specs

### 4.1 Pending review and batched submit (R1, R2)

**Model.** A draft review is a local record `{ draftId, network, identity, repoId, prId, headOid, verdict?, summary, comments: [{ localId, anchor, body, landedId? }], reviewId?, startedAt }` in the IndexedDB `journal` store, keyed `review:<network>:<identity>:<prId>`. It exists only in this browser; the page says so once: "Pending comments stay in this browser until you submit."

**Submit order.** 1) `review` `{ patchId, verdict, commitOid: headOid, body: summary, commentCount: N }`; 2) each comment `{ targetId, body, path, line, startLine?, side, commitOid: headOid, reviewId }` in draft order. Review first because the comment's `reviewId` must name an existing document, and because a review whose comments trickle in for a few seconds is a better failure mode than N orphan comments with no verdict. Every write uses an intent `review:<draftId>:<step>` so a retry re-broadcasts the same bytes (the existing `createDocumentIdempotent` engine). Progress: "Submitting review · 3 of 7 documents". On failure: "Your Request changes is recorded with 2 of 6 comments; 4 are still pending in this browser. Retry" — the draft keeps `landedId` per comment and resumes.

**Head changes during a draft.** If the PR head moves (R14) before submit, the drawer warns: "The PR moved to def5678 since you started. Your comments are anchored to abc1234 and will show as outdated. Submit anyway · Re-anchor (lines that still exist)". Re-anchoring re-maps by (path, side, line) presence in the new diff; unmappable comments stay on the old head.

**UI.** A "Review changes" button (top right of Files changed) opens a drawer: summary textarea (Write/Preview), radio Comment / Approve / Request changes, list of pending comments (path:line, first line, edit, delete), the total: "7 documents · ≈ 0.0035 DASH", and "Submit review". Every line composer has two buttons: "Add single comment" (posts now) and "Start a review" / "Add review comment" (adds to the draft). A badge on the button shows the pending count. The Approvals card is unchanged; a reviewer's own pending draft renders in place on the diff with a "Pending" tag.

**Cost.** Review 34.9M + 27.5k × summary bytes; each comment 47.3M + 27.5k × (body + path bytes). Example: 300-byte summary + 6 comments of 150 bytes = 43M + 6 × 51.4M ≈ 351M credits ≈ 0.0035 DASH (about $0.11 at $30). Shown before signing; actuals go to the spend ledger.

**CLI.** `dg pr review <repo> <n> --request-changes --body-file summary.md --file src/a.rs --line 12 --body "…" --file src/b.rs --start-line 3 --line 5 --side old --body "…"`. Flags after each `--file` apply to it. Prints the document count and estimate, confirms, journals, writes review then comments, prints per-document results, exit code and `--json` `{reviewId, comments: [{id, path, line}], landed, failed}`.

### 4.2 Multi-line anchors (R3)

`startLine ≤ line`, same `side`. Diff UI: press-and-drag on line numbers (or shift-click) selects a range, highlighted; the composer header reads "Lines 3–5 (new)". Placement rule (`placeThreads`): the thread sits under `line`; the range is tinted. A range whose `startLine` is not in the diff but `line` is, is still current (GitHub behaves the same). Reader rule in `anchorOf` (§5.4).

### 4.3 Thread resolution (R7)

Events `threadResolve` (11) / `threadUnresolve` (12) with `refId` = the thread's root comment id, on `event` (members) or `authorEvent` (PR author). Fold: per root id, newest by `($createdAt, $id)` wins; a resolve on a root that is not a comment on this PR is inert (readers only look up known roots). UI: "Resolve conversation" button on each thread (members and the author only; others see nothing), collapsing the thread to "alice marked this as resolved · Show"; a "n resolved" counter in Files changed with a "Show resolved" toggle. Cost shown in the button's tooltip: "≈ 0.0005 DASH (one event)". Resolved state does not affect approvals or the merge box unless `policy` later says so (not in this spec).

### 4.4 Requested reviewers and dismissals (R9, R11, R12)

`reviewRequest` (13) / `reviewRequestRemove` (14), `refId` = reviewer identity; `event` (members) or `authorEvent` (author). Fold → `requestedReviewers: { identity, requestedAt }[]`, newest per identity wins, remove clears. Presentation: a reviewer is *awaiting* when no review by them has `createdAt > requestedAt`; otherwise their standing from `summarizeReviews`. Re-request = a new `reviewRequest` (moves `requestedAt`, so the earlier verdict shows as "re-requested"; approvals are unaffected — the fold is per head).

`reviewDismiss` (15), `event` only (maintainer or writer), `refId` = review id, `value` = short reason. `countApprovals(reviews, oracle, headOid, dismissed)`: a dismissed review is treated as verdict 3 (neither counts nor clears), matching GitHub's "dismissed → commented". Timeline: "bob dismissed alice's review: stale after the rebase". The Reviewers card shows "dismissed" with the reason.

"Reviewers" card (right rail): rows `avatar · name · icon · state · role`, states: Approved (green check), Changes requested (red x), Commented (grey bubble), Awaiting (clock), Stale (clock, "reviewed abc1234"), Dismissed (grey), Doesn't count (not a member). Author-approval tag as today. "Request a reviewer" picker lists members first (their approvals count), then anyone by identity or `@name`, with the note "Only maintainers' and writers' approvals count."

### 4.5 Suggestions and applying them (R5)

**Format.** GitHub's: a fenced block with info string `suggestion`, whose body replaces the anchored lines (`startLine..line` on the new side; a suggestion on the old side or on a deleted line is rendered but not applicable). Rendered as a mini-diff (removed lines, added lines) under the comment.

**Apply.** Button "Apply suggestion" shown when the viewer holds write on the source repo and the thread is on the current head; otherwise a tooltip "Only the PR author (or writers of `<fork>`) can apply this. Copy suggestion". "Add to batch" collects several; a sticky bar "Apply 3 suggestions in one commit". The commit: for each file, take the head blob, apply the replacements bottom-up (non-overlapping; overlapping selections are refused with "these suggestions overlap"), build the tree and a commit with parent = head, author = the applier's merge identity from Settings, committer the same, message:

```
Apply suggestions from code review

Co-authored-by: <reviewer name> <reviewer@forge>   (one per distinct reviewer; name from DPNS/profile, email `<identity>@users.forge.invalid`)
Forge-Suggestion: <comment id>                     (one per applied comment)
```

Then the C2 runner in "commit to branch" form: pack → upload (the applier's storage or costed Platform) → `packManifest` on the source repo → `refUpdate` of `sourceRefName` in the source repo (`prevOid` = head) → `headUpdate` (16) on the PR (`authorEvent` when the applier is the author, else `event`). Steps and partial-failure wording as the merge panel. Cost line: "packManifest + ref update + head update ≈ 0.0016 DASH, plus storage (a one-file pack is 1–3 KiB: free in your bucket, ≈ 0.0007 DASH on Platform)".

**Applied state.** Derived, no write: the PR's commits (Commits tab walk) are scanned for `Forge-Suggestion:` trailers; a matching comment shows "Applied in abc1234". `dg pr suggestion apply` writes the same trailers so the web and the CLI agree. The parser and the text replacement are a shared rule with vectors (`suggestion__*`, §5.6).

### 4.6 The PR head follows its branch (R13, R14)

`headUpdate` (16) carries `oid`; accepted from the author (`authorEvent`) and from base-repo members (`event`, the equivalent of GitHub's "allow edits from maintainers" — who can merge anything anyway). Fold: `head = newest headUpdate.oid by ($createdAt, $id) ?? patch.headOid`. Everything that said "head" now means the folded head: the diff, approvals (`countApprovals(…, head)`), stale detection, `headOnBase`, merge input, check runs. Timeline: "alice pushed 3 commits (abc1234 → def5678)" — the count from the commit walk when both commits are readable, else "moved the head to def5678"; a head that does not descend from the previous one reads "force-pushed".

Who posts it: `git push` via `git-remote-dash` when the pushed ref matches an open PR's `(sourceRepoId, sourceRefNameHash)` (the new `sourceRef` index) whose author is the signer: prints "PR #7 follows this branch: updating its head (≈ 0.0006 DASH)" and posts unless `dash.prAutoSync = false`; otherwise "run `dg pr sync 7`". The web: an author banner "Your branch `feature/x` is at def5678 but this PR is at abc1234 — Update PR head (≈ 0.0006 DASH)". Reviewers who reviewed an older head see "New commits since your review · Re-review".

### 4.7 Drafts (P6)

`patch.draft = true` at creation ("Create draft pull request" split button); `ready` (10) / `draft` (9) by the author (`authorEvent`) or members. Fold seeds `draft` from the document, events override in order. Draft PRs: grey pill "Draft", merge box replaced by "This PR is a draft — Mark ready for review", still reviewable. PR list filter.

### 4.8 Merge box and policy (M1–M4, F7, P3, P8)

Rows, top to bottom, each with an icon and a sentence:

1. **Approvals** — "Approved by 2 maintainers on def5678" / "Changes requested by bob" / "No approvals yet"; with a policy: "1 of 2 required approvals (maintainers)".
2. **Checks** — "3 checks passed" / "1 failing: build (details)" / "No checks reported for def5678". Required by policy → red row "Required checks are failing".
3. **Conflicts / mergeability** — "No conflicts with `main`" / "Conflicts in src/a.rs, README.md" + `dg pr checkout` copy row / "Base branch moved since this check — Re-check".
4. **Branch state** — "PR head abc1234 is behind `feature/x` (def5678)" for authors; "Protected branch — maintainers only" for writers.
5. **Button** — label = the action (C2 rules) with a method menu: Merge (fast-forward) · Create merge commit · Squash and merge (P1) · greyed Rebase (P2). Below: "Delete `feature/x` after merging" (when the merger has write on the source repo), "Also close #12" checklist (P8), and the cost line.

Policy comes from the newest `policy` document (a maintainer sets it in Settings → Branches: "Required approvals [0–10] · Only maintainers' approvals count [ ] · Require passing checks [ ] · Allowed merge methods [x][x][ ][ ]"). Unmet policy disables the button for writers and shows a maintainer "Merge anyway (policy override)" with a confirm — the override is recorded nowhere but the merge event's author, and the card says "Policy is a client rule; a maintainer can override it. Nothing at consensus requires approvals."

---

## 5. Client rules (FORGE_RULES_V2 additions)

All in `crates/forge-core/src/rules/v2.rs` and `forge-web/lib/rules/v2.ts`, held in parity by `forge-contracts/vectors/*.json` with `"rules": "v2"` and a new `case` each; the TS harness `lib/rules/conformance.test.ts` and the Rust harness gain one arm per case. Existing cases keep their shapes, extended with optional inputs (absent = today's behaviour) so existing vectors pass unchanged.

### 5.1 `fold_pr_state_v2` — extended

Inputs: `events`, `authorEvents`, `targetAuthor`, `baseTip`, `isAncestor`, **new** `initialDraft: bool` (from `patch.draft`, default false). `authorEventApplies` accepts kinds close, reopen, draft, ready, threadResolve, threadUnresolve, reviewRequest, reviewRequestRemove, headUpdate (an `authorEvent` of any other kind, which cannot exist on chain, stays inert). `applyPrEvent` unchanged for 1–10; kinds 11–18 are no-ops for `PrState`. Vectors: `fold_pr_v2__draft_from_sum`, `fold_pr_v2__author_marks_ready`, `fold_pr_v2__member_draft_after_author_ready`, `fold_pr_v2__closed_draft_reopens_as_draft`. **Fresh registration (wipe/beta7):** `patch.draft` and the state kinds of `event`/`authorEvent` are gone; draft, ready, close, reopen and merge are `transition` documents whose per-target `delta` sum is the state (`prStateV2(code, mergeOid, events, …)`), and `authorEvent` carries the review kinds only.

### 5.2 `fold_pr_review_v2` — new

```
fold_pr_review_v2(events, author_events, target_author, initial_head, known_roots) -> PrReviewState {
  head: Oid,                                   // newest headUpdate.oid by (createdAt, id), else initial_head
  head_updates: [{ oid, actor, created_at, id }],   // for the "pushed n commits" timeline
  requested_reviewers: [{ identity, requested_at }], // newest request/remove per identity
  resolved_threads: [root_comment_id],         // newest resolve/unresolve per root; only roots in known_roots
  dismissed_reviews: [{ review_id, actor, reason, created_at }],
  milestone: string | null,
}
```

Ordering and author filtering as `mergedLog`. A `headUpdate` without `oid`, a request without `refId`, a resolve on an unknown root: inert. Vectors `fold_review_v2__head_update_newest_wins`, `__head_update_by_stranger_ignored` (authorEvent by non-author), `__member_head_update_counts`, `__resolve_then_unresolve`, `__resolve_unknown_root_inert`, `__request_remove_request`, `__request_by_author`, `__dismiss_records_reason`, `__milestone_set_clear`.

### 5.3 `count_approvals` — extended

`count_approvals(reviews, oracle, head_oid, dismissed: Set<review_id>)`: a dismissed review is skipped exactly like verdict 3. Vectors `approvals__dismissed_review_does_not_count`, `approvals__dismissed_review_does_not_clear_earlier_verdict`, `approvals__dismissal_of_unknown_review_is_noop`. `meets_policy(approvals, oracle, policy) -> { met: bool, have: u32, need: u32 }`: counts approvers whose current role satisfies `approverRole`. Vectors `policy__maintainers_only_excludes_writer`, `policy__zero_required_always_met`.

### 5.4 `anchor_of(comment_fields) -> Anchor | None` — new (replaces `readAnchor`)

Rules: `path` non-empty required; `line` present ⇒ `side ∈ {0,1}` required; `startLine` present ⇒ `line` present and `startLine ≤ line`; `commitOid` hex 40/64 or empty. No body-block parsing. Vectors `anchor__file_level`, `anchor__range_ok`, `anchor__start_after_end_malformed`, `anchor__line_without_side_malformed`.

### 5.5 `group_review_comments(review, comments) -> [comment]` — new

Comments whose `reviewId == review.id` **and** `owner == review.reviewer` (defence in depth over the consensus agreement), in `($createdAt, $id)` order; `landed = len, expected = review.commentCount`. Vectors `review_group__other_owner_excluded`, `review_group__count_progress`.

### 5.6 `suggestion` — new

`parse_suggestions(body) -> [{ text }]` (fenced blocks with info string `suggestion`, CRLF normalised, fence length ≥ 3, nested fences respected) and `apply_suggestion(file_text, start_line, end_line, text) -> file_text` (1-based, inclusive, preserves the file's newline style and trailing-newline state; `end_line` beyond EOF → error). Vectors `suggestion__parse_single`, `__parse_two_blocks_ignores_code_fence`, `__apply_middle`, `__apply_last_line_keeps_trailing_newline`, `__apply_crlf`, `__apply_out_of_range_error`.

### 5.7 Linked issues — new (small)

`linked_issues(text) -> [number]` for `close[sd]? | fix(e[sd])? | resolve[sd]?` followed by `#n` (case-insensitive, word-bounded), deduped ascending. Vectors `linked_issues__*`. Used by the merge dialog and the issue backlink scan.

---

## 6. Costs at a glance (moutai model, 1 DASH = 10^11 credits)

| Action | Documents | ≈ credits | ≈ DASH |
|---|---|---|---|
| Single inline comment (150 B) | 1 comment | 51M | 0.0005 |
| Review, verdict only | 1 review | 35M | 0.00035 |
| Review with 300 B summary + 6 inline comments | 1 + 6 | 351M | 0.0035 |
| Resolve / unresolve, request reviewer, dismiss, draft/ready, head update | 1 event (50M) or authorEvent (57M) | 50–57M | 0.0005–0.0006 |
| Edit title/body | 1 patch replace | ≤ 112M (measure) | ≤ 0.0011 |
| Apply suggestions (one commit, own bucket) | packManifest + refUpdate + headUpdate | 162M | 0.0016 |
| Apply suggestions (Platform storage, 2 KiB pack) | + 1 chunk | + ~75M | ≈ 0.0024 |
| Merge (C2) | packManifest + refUpdate + event (+ storage) | 155M + storage | 0.0016 + |
| Merge + close 2 linked issues | + 2 events | + 100M | + 0.001 |
| Set a policy | 1 policy | 33.9M (measured) | 0.00034 |

Every confirm dialog shows the document count and the estimate; actuals land in the spend ledger (ux-dx-spec §4).

---

## 7. Implementation plan

Order: contract → rules + vectors → web (five PRs) → CLI. Each PR lists acceptance tests: unit/vector tests, live Playwright on moutai (`E2E_DEVNET=moutai E2E_WRITE=1`, extending `forge-web/e2e/v2-pulls.spec.ts` with new serial specs), and CLI end-to-end on moutai (the `dg` e2e suite in `docs/testing/e2e-test-plan.md`).

### PR 1 — `contracts: forge-collab revision for review parity`

- Schema changes of §3 in `forge-collab.json`; `docs/contracts/forge-v2.md` §2 table, §3 kinds table (11–18, author kinds), §6 rules table; `forge-web/lib/repo/contract.ts` DOC map (`policy`); cost model entries (`policy`, measured after the first write).
- `tools/contract-validate` passes; `deploy-v2.mjs --dry-run` reports size < 20,480 B; `--only collab --force-new` on moutai; `seed-v2-fixture.mjs` re-seeded (fixture PR gets a draft flag, a `headUpdate`, a multi-line comment, a resolved thread, a requested reviewer, a `policy`); `deployments/devnet-moutai.json` updated with `schemaHash`.
- Acceptance: validator green; live `dg pr view` on the fixture reads under the new id; a `comment` with `reviewId` by a different owner is refused at consensus (scripted negative test in `forge-web/lib/repo/v2.live.test.ts`); an `authorEvent` kind 3 is refused; a `policy` by a writer is refused.

### PR 2 — `core: review fold rules and vectors`

- Rust + TS: §5.1–§5.7; new vector files; both harnesses; `forge-core::collab::v2` writers (`post_event`/`post_author_event` for kinds 11–18 with `ref_id`/`oid`, `review` with `comment_count`, `comment` with `start_line`/`review_id`, `policy`), readers (`patch_view` uses the folded head; `review_state`), and `PatchView.head`.
- TS `lib/repo`: `replaceDocumentIdempotent` in `lib/sdk/write.ts`; `writes.ts` new events, `createReviewBatch` journal, `updatePatch`, `setPolicy`; `issues.ts` `readPull` folds the head; `anchors.ts` reduced to `anchorOf`; `inline-threads.ts` ranges, file-level, resolved; `review-fold.ts` requested/dismissed rows.
- Acceptance: `cargo test -p forge-core` and `pnpm test` green with every new vector run by both; `v2.live.test.ts` writes one of each new document on moutai and reads it back through the fold.

### PR 3 — `web: PR page IA, drafts, head sync, edit`

- Tabs with counts (P1), Commits tab (P2), Checks tab (P3, read-only), right rail (P4 without milestone), edit title/body (P5), draft/ready (P6), head-sync banner and timeline "pushed n commits" (R14), reviewer status card (R12) with request/re-request (R9) and dismiss (R11), conflict file list (F7), short-URL shim for `/pull/<n>/{commits,checks,files}`.
- Playwright (serial, moutai): author opens a draft PR from a fork → "Draft" pill and no merge box → marks ready → pushes a second commit with the CLI helper → banner → "Update PR head" → Commits tab shows 2 → owner requests COLLAB as reviewer → Reviewers card "Awaiting" → COLLAB approves → "Approved" → owner dismisses with reason → fold no longer counts it → author edits the title → heading updates. axe clean on every step; screenshots.

### PR 4 — `web: pending reviews, ranges, resolution`

- Drawer and local drafts (R1, R2), batched submit with progress and resume, multi-line select (R3), file-level comments (R4), resolve/unresolve (R7), edit/delete comment (R15), comment permalinks (P17), Write/Preview (P14), `@` autocomplete (P13).
- Unit: draft journal round-trip, submit resume after a simulated failure at comment 3 of 5, re-anchoring.
- Playwright: COLLAB starts a review, adds a single-line, a 3-line range and a file-level comment, submits "Request changes" → dialog shows "4 documents · DASH" → all four render (range tinted, file-level at the header) → the review card lists them → author replies and resolves the range thread → "1 resolved" toggle → COLLAB edits a comment → "edited" marker → deletes it → gone. Failure path: block the network after the second document (route abort) → message names "recorded with 1 of 3 comments" → unblock → Retry lands the rest.

### PR 5 — `web: suggestions, apply, update branch`

- Suggestion rendering (R5), apply single/batch → commit-to-branch runner (a generalisation of `lib/merge/runner.ts` with `target: { repo, refName, prevOid }`), applied markers, Update branch (M6), delete branch after merge (M7).
- Unit: `apply_suggestion` vectors; overlapping selection refusal; trailer parsing.
- Playwright: OWNER comments with two suggestions on `src/main.rs` → CONTRIB (fork owner) sees "Apply", batches both → step list completes → PR head moves (timeline "pushed 1 commit") → both threads read "Applied in <oid>" → blob view on the fork shows the text → OWNER sees "Apply" disabled with the tooltip.

### PR 6 — `web: merge box, policy, checks, squash, linked issues`

- Merge box card (M3), `policy` settings and enforcement (M4), checks row from `checkRun` (P3), squash (M1) and message editor (M2), auto-close linked issues (P8), PR list filters (P9), PR template (P10), file tree/filter/viewed/expand context/highlighting (F2–F5), inbox feeds for review requests and replies (P12).
- Playwright: OWNER sets policy "2 approvals, maintainers only, checks required" → merge box "0 of 2", button disabled for a writer, "Merge anyway (policy override)" for the owner → a relay-written `checkRun` (seeded by `forge-relay` test fixture or a direct document write) shows "1 failing" → after a passing run and two maintainer approvals the button enables → squash merge on the merge-seed PR → PR "Merged", `main` has one new commit whose message carries `Co-authored-by` → linked issue "#1" closed → inbox shows "review requested" for COLLAB.

### PR 7 — `dg: review parity`

- §2.5 C1–C13; `git-remote-dash` push hint / `dash.prAutoSync`; `--json` schemas; error codes for "not a writer of the source repo" and "suggestion overlaps".
- Acceptance (moutai, scripted): `dg pr create --draft` → `dg pr ready` → `git push` to the branch prints the sync line and moves the head → `dg pr review --request-changes` with two `--file/--line` comments prints "3 documents", writes them, `dg pr view --comments --json` lists both with anchors and `reviewId` → `dg pr resolve` → `dg pr request-review` → `dg pr dismiss-review` → `dg pr suggestion apply --all` moves the head and the web shows "Applied" → `dg pr merge --squash --delete-branch` → `dg pr checks` prints the seeded run. Web and CLI must agree on every fold (a cross-check step reads the same PR in both and diffs the JSON).

Rollout note: PRs 3–6 can be developed in parallel branches off PR 2; PR 7 depends on PR 2 only. Nothing here touches forge-core, private-repo cryptography, or the merge engine's object model; the commit-to-branch runner is the one new piece of git machinery and reuses C2's pack writer and verifier.
