# Boards: planning issues and pull requests

Status: design, 2026-10-27 (UPDATE-3). Owner request: "build out a full, properly designed implementation of issue tracking boards, Jira / Trello ish. Make your own decisions; solve the same user stories as a GitHub project board, Trello and Jira."

Constraints that shape every decision (`docs/research/platform-constraints.md`): one document operation per state transition; 5 KiB per field and 20 KiB per signed transition; 100 documents per query page; indexed strings ≤ 63 characters; no subscriptions (liveness is polling); **we host nothing** (no server runs automations, sends notifications or keeps a board's state); every write costs the writer credits.

---

## 1. User stories

The stories GitHub Projects, Trello and Jira all serve, and how Forge answers each. "Board" below is Forge's name for a GitHub *project*, a Trello *board* and a Jira *board*.

| # | Story | Forge |
|---|---|---|
| U1 | Lay work out in stages (columns) and see at a glance what is where | Board view: one column per status, cards for issues and PRs (§4.1) |
| U2 | Move work between stages and prioritise within a stage by dragging | Drag and drop, and keyboard moves; one cheap write per move (§3.2, §5.2) |
| U3 | New work shows up on the board without anyone adding it | **Sources**: a board includes every issue / PR of the repos and filters it names (§2.3) |
| U4 | Finished work moves to Done by itself; old done work goes away | Closed and merged items show in the Done column; auto-archive after N days (§2.4) |
| U5 | Track more than status: priority, estimate, sprint, dates, free text | Custom fields: single select, number, date, iteration, text (§2.2) |
| U6 | Different people need different cuts of the same work | Saved views: board, table and roadmap layouts, each with a filter, a grouping, swimlanes, a sort (§4) |
| U7 | Filter to "mine", a label, a sprint, a priority | One query language shared with the Issues tab, plus board qualifiers (§4.4) |
| U8 | Plan in sprints; see the current one; carry over unfinished work | Iteration field with a cadence; `iteration:@current`; "move open items to the next iteration" (§2.2, §5.4) |
| U9 | Limit work in progress | Per-column WIP limits, shown and warned on, never blocking (§2.1) |
| U10 | Capture a card quickly | Quick add at the foot of a column: a title makes a real issue, `#12` or a URL adds an existing one (§5.3) |
| U11 | Work on a card without leaving the board | Side panel: body, labels, assignees, fields, state, comments link (§5.5) |
| U12 | From an issue, see which boards it is on and change its status there | Issue and PR sidebar "Boards" section (§5.6) |
| U13 | One board across several repositories | A board lives in a **home repository** and may source and hold items from any repository (§2.5) |
| U14 | Everyone can look; only the team can change it | Public boards in public repos; sealed boards in private repos; writes gated on the home repo's membership at consensus (§3) |
| U15 | See progress: counts, points, sprint burn | Column totals (count and a number field's sum) and an iteration progress bar (§4.5) |
| U16 | Script it | `dg board` (list, view, create, move, set, add, archive, remove) with `--json` (§6) |

**Deliberately different.**

- *No draft cards.* Trello cards and GitHub draft issues are a second kind of item that later has to be converted. On Forge an issue costs about as much as a card (0.0007–0.0012 vs 0.0004–0.0009 DASH) and already has comments, labels, assignees, a number, a URL and history, so quick add makes a real issue. One item model; nothing to convert.
- *No automation engine.* GitHub's workflows and Jira's automation run on a server when something happens. Forge hosts nothing, so automation is **derived**: rules in the board's definition that every reader applies when it renders (sources, the Done column, auto-archive). They are free (no writes), instant, consistent between the web and the CLI (shared vectors), and can never "fail to run".
- *No configurable workflow transitions* (Jira's "In review may only go to Done"). Statuses are columns; any member may move any card. Transition rules suit a ticketing desk, not a forge, and would be client-only anyway.
- *Board history is not kept.* A card's placement is one mutable document per member (§3.2): a move costs about 0.00005 DASH instead of 0.0004 or more, at the price of no per-move audit trail. Issue state history stays in the issue timeline, which is what matters.

---

## 2. The model

### 2.1 Board

A board is a definition: name, description, columns, fields, sources, views and rules. Its **key** is a random u32 chosen at creation (URLs: `/repo/board?owner=&name=&b=<key>`); every revision of the board carries the same key.

**Columns** (1–20): `{id, name, color?, wip?}`. `id` is 1–255, stable across renames; order is the array order. One column may be the **Done** column (`done`), and one the **default** column (`def`: where an item with no placement shows; 0 = a "No status" column shown only while it holds something).

### 2.2 Fields

Up to 12 custom fields `{id, name, type, …}`, `id` 1–255 stable:

| type | value | notes |
|---|---|---|
| `sel` single select | option id (1–255) | options `{id, name, color?}`, ≤ 30 |
| `num` number | finite number | e.g. Estimate / story points; summed in column totals |
| `date` | `YYYY-MM-DD` | e.g. Start, Target; the roadmap layout plots them |
| `iter` iteration | iteration index ≥ 0 | `start` (`YYYY-MM-DD`) + `days` (1–90); iteration *k* runs from `start + k·days` for `days` days, named "<field> k+1" |
| `text` | string ≤ 200 chars | |

Built-in fields come from the item itself and are never stored on the board: Title, Number, Repository, State, Author, Assignees, Labels, Milestone, Created, plus Status (the column).

### 2.3 Sources (auto-include)

Up to 5 sources `{r, k, q}`: a repository id (`r`, default the home repo), a kind (`i` issues, `p` pull requests, `a` both) and a filter in the board query language (§4.4, default empty = all). Every item a source matches is on the board, open or closed, unless a member removed it (§2.4). A board with no sources holds only the items members added. The new-board template sources the home repository's issues and pull requests.

### 2.4 Placement: where an item shows

For each item the reader takes the **newest card** (§3.2) over every member's, by (`$updatedAt`, `$id`). An item is **on the board** when a source matches it or it has a card, and that card is not *removed*.

Its column:

1. A **closed or merged** item shows in the Done column, unless its card puts it in a column at or after the Done column in the column order (a "Verified" or "Released" stage after Done keeps its items).
2. Otherwise the card's column, if the board still has that column.
3. Otherwise the default column (or "No status").

An open item may sit in Done (a team that marks work done before closing). A board without a Done column applies rule 2 and 3 only.

**Which closed items a reader reads.** A source's open items are read whole; its closed and merged ones from the repository's state changes newest first, until the auto-archive window ends (older ones are archived unless a card keeps them, and the items cards name are read by id anyway), or, with `arch` 0, until the 200 most recently closed of that source **repository** (all its sources together) are found; "Show older" (and a view asking for `is:archived`) reads on.

**Auto-archive** (`arch`, days, 0 = off): let `closedAt` be the `$createdAt` of the item's latest transition into closed or merged (the transition that made its `sum mod 16` closed or merged). A closed or merged item whose newest card is older than `closedAt` (or which has none) is archived once `now ≥ closedAt + arch` days. `now` is an explicit input of the fold (the vectors pin it). Reopening never clears a card's archived state (as on GitHub). **Archived** items (auto or by a card's state) are hidden unless the view asks for them (`is:archived`). A **removed** item is off the board even if a source matches it; adding it again writes an active card.

**Order within a column** is by rank (§2.6), ascending; a view may sort by a field instead (§4).

### 2.5 Home repository and cross-repository boards

A board's documents carry its home repo's id, and consensus admits them only from that repo's maintainers and members (§3). Its items may be any repository's issues and pull requests: a source may name another repository, and a card may name any item. An "organisation board" is a board in a planning repository (Forge has no organisations; an owner identity's repos are its organisation).

What a reader may see of a cross-repo item is what that repository shows it: a private repository's issue on a public board shows as "a private item" unless the reader holds that repo's key (on the web, a member of that repository whose tab already holds its session, having opened it; in `dg`, a signer who is one of its members). Neither client reads anything to find out: the web looks only in the sessions this tab holds, and `dg` loads the signer's key for it as it would to read it. A private source repository whose key the reader does not hold is not read at all.

### 2.6 Rank

A card's `rank` is a string over the 62 digits `0-9A-Za-z` (ASCII order, so byte order is numeric order), read as a base-62 fraction; an explicit rank never ends in `0` and is at most 63 characters. Items sort by `(rank, item $id)`.

- **Implicit rank.** An item with no card, or whose newest card has no rank, ranks `V` + the **item's** `$createdAt` in 8 zero-padded base-62 digits + the first 3 bytes of the item's `$id` (big-endian, mod 62⁴) in 4 digits. Sourced items therefore form a pool (`V…`) in creation order, oldest first, almost never two equal (two items of one block whose id prefixes collide mod 62⁴ tie, and sort by `$id`), and a card can be dropped between two of them without ranking either. An implicit rank may end in `0`; only the midpoint arithmetic treats trailing `0`s as absent.
- **Moves.** Dropping between two neighbours writes `rankBetween(a, b)`, a string strictly between them (digit-wise midpoint; vectors `board_rank__*`). **Top** of a column: `rankBetween("", min(first, "V"))`. **Bottom**: `rankBetween(max(last, "W"), "")`. So explicit top and bottom groups bracket the sourced pool, and later sourced items (which join the pool) never pass a card dropped at the bottom. A card dropped between two sourced items gets a `V…` rank, which later sourced items may pass; that is intended (they are newer).
- **Overflow.** A rank that would exceed 63 characters (about 350 drops into one gap) is refused before signing with "Re-rank this column", which rewrites the column's ranks evenly: one write per item, a create (≈ 0.0004–0.0009 DASH) for each item the signer has no card for, priced before signing. `rerank(n)` spreads them between `0` and `V` (k/(n+1) of the way, in the fewest digits that leave 62 ranks between neighbours), so items sourced later still join below them, in the pool. The pairs with no rank between are equal ranks (two members dropping into one gap at once write the same rank) and `b` = `a` + `0…0` (an explicit rank against an implicit one ending in `0`); both are `re-rank` too.

### 2.7 Encoding and the rules both clients apply

Pinned by `forge-web/lib/rules/boards.ts` and forge-core `rules::boards` (vectors `board_spec__*`, `board_query__*`, `board_view__*`).

- **Spec JSON** (`v: 1`): `{v, desc?, columns, def?, done?, sources?, fields?, views?, arch?}`; a column `{id, name, color?, wip?}`; a field `{id, name, type, options?, start?, days?}` (`options` exactly on `sel`, `start` / `days` exactly on `iter`), an option `{id, name, color?}`; a source `{r?, k, q?}`; a view `{id, name, layout, q?, group?, lane?, sort?, cols?, date?}`. Written canonically: that key order, compact, defaults (0, `""`, `[]`) omitted (an empty `desc` is none), so equal specs are equal bytes. JSON that forge-core's reader (serde_json) refuses is refused by both clients: an unpaired surrogate escape, a number out of range (`1e400`), nesting past 127 levels; forge-core reads numbers exactly (`float_roundtrip`), as `JSON.parse` does. Unknown keys are tolerated on read and dropped on write (a change older editors must keep bumps `v`); a known key of the wrong type refuses the spec, naming the first problem in key order. Colors are `#rrggbb` (the label schema's); `wip` 1–9999; `desc` ≤ 1024 characters; queries ≤ 512 characters; `arch` ≤ 3650.
- **Names** (columns, fields, options, views): 1–63 characters, no control character or `"`, no leading or trailing white space, unique in any letter case. A field name may not contain `:`, start with `-`, or be a query key or built-in field (`is`, `state`, `label(s)`, `assignee(s)`, `author`, `milestone`, `no`, `status`, `repo(sitory)`, `title`, `number`, `created`), so `<field>:<value>` is never ambiguous.
- **View keys**: built-ins by name (`status`, `assignee`, `label`, `milestone`, `repo`, `title`, `number`, `created`, `author`, `state`, `assignees`, `labels`), a custom field as `f<id>`; `sort` takes `-` for descending. The board layout groups by `status` or a `sel` / `iter` field; lanes never by `status` or the grouping; `date` is one `iter` field or two different `date` fields. Every reference must resolve.
- **Field values** (`card.f`): `sel` an option id, `num` finite with |x| ≤ 1e15 and 0 or |x| ≥ 1e-6 (so both clients print it alike, without an exponent: JavaScript's shortest digits, an exact tie to even), `date` a calendar `YYYY-MM-DD`, `iter` 0–65535, `text` 1–200 characters. Anything else is dropped on read. Written ids ascending.
- **Sources** read only the item: a source query's `status:`, field, `is:archived` and `@me` qualifiers are reported, not applied (a source includes the same items for every reader, before any card); its `repo:` takes a repository id only.
- **Query** additions to §4.4: `is:unmerged` (open or closed, as on the Pull requests tab), `state:` as `is:` for states, a leading `-` on any qualifier (a missing value never matches, so `-priority:P0` matches items with no priority), number and date ranges `a..b` / `*..b` / `a..*`, `@today`, `iteration:N` (iteration N) or by name, `iteration:<@current`, text fields matched as contains. Names and values with spaces are quoted (`"story points":>3`). Before an iteration field's first iteration `@next` is iteration 1 and `@current` / `@previous` match nothing. A token naming nothing on the board is reported, as is a known key with nothing after its colon (`label:`); an unknown key with nothing after it (`note:`) and a URL stay text. Free text matches titles and numbers as the Issues tab's does (no bodies on a board). **`repo:`** matches by repository id, never by how a client labels a repository: a value that is an id is taken as is; `owner/name` (the owner an identity id or a DPNS name) or a bare `name` (a repository of the home repository's owner) is resolved to its id by the client before the query is parsed (`repoNamesOf` / `repo_names_of` list the names, both clients resolve them alike), and a name that resolves to nothing is reported (vectors `board_query__parse_repo`, `board_query__repo_names`).
- **Groups** (§4.1, §4.2): "No <key>" first, only while it holds an item; then every column, every option, the iterations items name plus the current one, or the distinct assignees / labels / milestones / repositories by code point (repositories by id; an item with two assignees or labels is in both). **Sorts**: items without a value last in both directions; ties by (rank, item id); `repo` by repository id (vector `board_view__sort_repo`). A repository's label (`owner/name`) is display only.

---

## 3. Contract: two new forge-meta types (UPDATE-3)

New document types only, added to forge-meta by `deploy-v2.mjs --update meta` on a registered network (forge-meta v3 on testnet since 2026-10-27, rehearsed on its scratch set first) and part of the registration set elsewhere. Flag `boards` (UPDATE3), four-contract set only, as `passkey_vault`.

Both types are **mutable and never deleted, one document per (member, board[, item])** (`canBeDeleted: false`: deleting the newest document would silently bring back an older member's, which no poll of `$updatedAt` sees, and a removed member could still delete theirs; `state` 2 is the delete). Every index key and both timestamps are `required` (an unrequired `$updatedAt` is never recorded, and a unique index does not hold a document missing a key part). A member's later write replaces their own document (a replace costs a fraction of a create: on testnet a card's move 4.2M–4.9M credits against its create's 43M–89M), and readers take the newest across members. Both are member-gated like `label`: `ownerRefersTo` a forge-core `maintainer` or a `writer` whose `role` equals the claimed `r`, re-validated on every replace, so a removed member cannot touch their old documents and a role change takes effect on the next write.

### 3.1 `board`

| property | type | notes |
|---|---|---|
| `repoId` | id, immutable | the home repository |
| `key` | u32 1–4294967295, immutable | the board |
| `name` | string 1–63 chars, ≤ 252 B, visible character | plaintext boards only |
| `spec` | string ≤ 4096 B | the definition (§2), JSON, `v: 1`; plaintext boards only |
| `state` | integer 0–2 | 0 open, 1 closed (read-only, listed under Closed), 2 deleted |
| `enc`, `epoch` | bytes 29–5120, u32 | a private repo's board: `name` and `spec` sealed together |
| `r` | integer 1–1 (rule `rClaim`: `r = 1`) | maintainers and role-1 writers define boards (a writer may close or delete a maintainer's board, as with labels) |

Unique index `byKey (repoId, key, $ownerId)`; its `repoId` prefix lists a repo's boards. Rules: `noPlain` (with `enc`, no `name` / `spec`), `hasName` (without `enc`, `name` and `spec`), `dependentRequired enc → epoch`.

### 3.2 `card`

A member's placement and field values for one item on one board.

| property | type | notes |
|---|---|---|
| `repoId` | id, immutable | the board's home repository (the gate) |
| `board` | u32, immutable | the board's key |
| `item` | identifier, immutable, `refersTo` forge-collab `issue` or `patch` (any repository) | |
| `col` | integer 0–255 | column id; 0 = none |
| `rank` | string 1–63 chars, `^[0-9A-Za-z]*[1-9A-Za-z]$` | |
| `f` | string ≤ 2048 B | field values, JSON `{"<fieldId>": value}` |
| `state` | integer 0–2 | 0 active, 1 archived, 2 removed |
| `enc`, `epoch` | bytes 29–2560, u32 | a private repo's card: `col`, `rank`, `f` sealed |
| `r` | integer 1–2 | maintainers, writers and triage place cards |

Indexes: unique `onItem (item, repoId, board, $ownerId)` (one card per member per item per board; its `item` prefix answers "which boards is this issue on") and `recent (repoId, board, $updatedAt)` (load a board, and poll for what changed since). Rules: `noPlain` (with `enc`, no `col` / `rank` / `f`).

`state` stays plaintext in a private repo: it tells only that an item was archived or removed.

**Why one document per member and not one per item.** Platform documents are replaced only by their owner. One document per item would need every member to create a new immutable document per move (0.0004 DASH or more, forever growing). Per-member mutable documents make every move after a member's first a replace.

**Concurrent edits.** A card carries all of a member's view of the item (column, rank, fields), and the newest wins whole. A client reads the item's newest card immediately before signing and applies only its own change to it, so two members editing different fields of one card both land unless the second read happens before the first write is visible (the read-to-sign latency, a few seconds); then the last writer wins whole.

A member's **own** back-to-back edits never undo each other within one client: it keeps the card each write of an item landed (with the `$revision` the write made) and, while a fresh read lags behind it (lacks the document or holds an older revision), applies the next change over that card instead of the read; once the read caught up, the read is the base again (another member's later card included). The web keeps them 60 s per page, for single and bulk writes alike (`overIfAhead`); `dg` keeps them for the process. Two `dg` processes run one after the other share nothing: if the second reads a node that has not seen the first's write yet, it builds on the older card, so a script that makes two writes to one item should check the first landed (`dg board view`) or wait a few seconds between them. A create that meets the signer's card made meanwhile (another tab or device) re-reads and applies its change over the newest card then.

**Gates fixed by this registration** (an update can never add an `ownerRefersTo` operand): only the **home** repository's members place cards (a member of the item's repository who is not one of the home repo's cannot); a card always names an issue or PR (`item` required, with `refersTo`), so there are no item-less notes; writers (role 1) define boards, triage does not.

### 3.3 Private repositories

A private repository's boards and cards are sealed with the repository key under the current epoch, with the private-repos per-document framing (`docs/security/private-repos.md` §4.4): new `docType`s `board` and `card`, bound to `u32(key)` and `u32(board) ‖ item (32 B)` respectively, so a sealed payload cannot be moved to another board or item. Readers of a private repo see nothing; the keys, `state` and the item ids are all that is plaintext.

The payload encoding (TLV tags 32–36, padding, the read order) is `private-repos.md` §4.6, pinned by the `sealed_board__*` vectors. A version other than `0x01` reads as unreadable, not malformed, so a later client's members-only boards stay listed.

**What a private board still shows.** `item` is plaintext, immutable and indexed, so a card in a private planning repository that names a *public* repository's issue publishes "private repository R tracks owner/name#12" (and which member wrote it). Clients confirm before writing such a cross-repository card from a private home repo (the web refuses the write until the caller passes the confirmation: `crossRepoCardNeedsConfirm`, `BoardWriteError` `cross-repo`). A public repository's members-only boards (the members key, `enc` v0x03) are possible with this schema and left to a later client.

---

## 4. Views

A view is `{id, name, layout, q, group, lane, sort, cols?, date?}`, at most 8 per board, saved in the board definition. Unsaved changes live in the URL (`?b=&view=&q=&group=&lane=&sort=`, and `&layout=`, `&cols=`, `&date=` for a layout switched or columns picked), so any cut can be shared as a link; a member saves it into the definition. An open item panel is `&item=<id>`.

### 4.1 Board layout

Columns are the values of the grouping field: Status by default, or any single-select or iteration field (dragging then sets that field). **Swimlanes** (`lane`) split the board horizontally by assignee, label, milestone, repository, a single-select or an iteration field. Cards show the repo (when the board spans several), number, title, state icon, labels, assignees, and the view's chosen fields (`cols`).

### 4.2 Table layout

One row per item; columns are the built-in and custom fields the view lists (`cols`); click a header to sort; grouping makes sections with counts and sums; cells of custom fields and Status are edited in place by members.

### 4.3 Roadmap layout

A timeline: each item is a bar from its start date to its target date (`date: [startFieldId, endFieldId]`) or across its iteration (`date: [iterFieldId]`); items with no dates are listed beside it. Zoom: weeks, months, quarters. Today and the iterations are marked.

### 4.4 Query language

The Issues tab's qualifiers (`is:open|closed|merged`, `is:issue|pr`, `label:`, `-label:`, `no:label`, `assignee:@me`, `no:assignee`, `author:`, `milestone:`, `no:milestone`, free text and `#12`) plus:

- `status:"In progress"` / `-status:Done` / `no:status`
- `<field>:<value>` for a custom field by name: `priority:P0`, `estimate:>3`, `target:<2026-11-01`, `iteration:@current`, `iteration:@next`, `iteration:@previous`, `no:priority`
- `repo:owner/name` (or a repository id; §2.7)
- `is:archived` (otherwise archived items are hidden)

Names match case-insensitively; values with spaces are quoted. An unknown field or value is reported under the box, never searched as text.

### 4.5 Totals and progress

Each column (and each swimlane and table group) shows its item count, its WIP limit when set (red when over), and the sum of the view's first number field. With an iteration field, the board header shows the current iteration's dates and done / total (count and points).

---

## 5. Interaction

### 5.1 Who can do what

| | stranger / reader | triage | writer | maintainer |
|---|---|---|---|---|
| view a public board | yes | yes | yes | yes |
| move, rank, set fields, add, archive, remove items | | yes | yes | yes |
| create, edit, close, delete a board; save views | | | yes | yes |

The UI offers only what the viewer's role allows and the contract's gate refuses the rest.

### 5.2 Moving

Drag a card (pointer or touch; on a touch screen by its grip, so a swipe elsewhere still scrolls the board); keyboard: focus a card, `Space` to pick it up, arrows to move, `Space` to drop, `Esc` to cancel (with live-region announcements). The board moves the card at once (optimistic), signs one write (`card` create, or replace of the signer's own), and puts it back with the reason if the write is refused. Dropping into a column over its WIP limit warns and still moves.

### 5.3 Adding

Quick add at the foot of each column: a title makes an issue in the home repo (or a source repo chosen from a menu) and places it there; `#12`, `owner/name#12` or an issue / PR URL adds that item. "Add items" opens a search over the source repos' issues and PRs not on the board.

### 5.4 Iterations

"Move open items to the next iteration" sets the iteration field of every open item of the current iteration that is not in the Done column (one write per item, priced first).

### 5.5 Item panel

Clicking a card opens a side panel: title, state, body (markdown), labels, assignees, milestone, the board's fields and status (editable by members), archive / remove, and a link to the issue or PR. Labels and assignees edits are the issue's own events.

### 5.6 On an issue or pull request

The sidebar's "Boards" section lists the boards it is on whose home is the item's repository or another repository of the same owner, with its status and fields (editable), and "Add to board" for that repository's other boards. It reads the owner's repositories first (up to 300), then `card.onItem` with `item ==` the item and `repoId in` those repositories (100 a query, up to 3 pages each), so a stranger's cards naming the issue are never read and cost the page nothing. Another repository of the owner that is private is left out: its boards are sealed with a key the item's page does not hold. The section reads once it is in view and the page's own load is past (the reader scrolls, points at or focuses it, or the browser has been idle 8 s after it mounted), so a cold issue or PR page spends no request on it even where the sidebar starts in view (`page-budget.spec.ts` pb-6).

### 5.7 Liveness

An open board polls `card.recent` for cards with `$updatedAt >=` its last read (deduplicated by `$id`: several cards can share a block time) every 20 s while the tab is visible, and re-reads the definition on focus. A refresh control forces both.

---

## 6. CLI

`dg board list [<repo>]`, `dg board view <repo> <key|name> [--view <name>] [--json]`, `dg board create <repo> --name <n> [--columns "Todo,In progress,Done"]`, `dg board move <repo> <board> <#n> <column> [--top|--bottom|--before <#m>|--after <#m>]`, `dg board set <repo> <board> <#n> <field>=<value>…`, `dg board add|archive|remove <repo> <board> <#n|owner/name#n>…` (`add --title <t>` is quick add, §5.3; `archive --restore` unarchives), `dg board next-iteration <repo> <board> [--field <name>]` (§5.4), `dg board close <repo> <board> [--reopen]` and `dg board delete <repo> <board>`. `create --template kanban|sprint|triage|empty` writes the web's create-dialog templates (`forge-web/components/repo/boards/board-templates.ts`). An item is `#n` in the home repository, `owner/name#n` elsewhere, and `pr#n` / `issue#n` where an issue and a pull request share the number. The CLI reads a source repository's issues whole and its pull requests page after page (newest first, up to 3,000, as far as the web reads open ones), then keeps the closed ones as the web's walk does (the auto-archive window, or the 200 most recently closed); `view --archived` (or a view asking for `is:archived`) keeps the next 200 closed ones too, as the web's "Show older" reads them. The data layer is forge-core `collab::boards` (sealing: `private::board`, vectors `sealed_board__*`). The fold, rank and query rules are shared with the web (`forge-core::rules::boards`, `forge-web/lib/rules/boards.ts`, vectors `forge-contracts/vectors/board_*__*.json`).

---

## 7. Costs

Measured on testnet (2026-10-27, `forge-web/lib/repo/boards.live.test.ts`: three runs on the scratch set's forge-meta v3, then one on the live set's, whose fees fell within these ranges; the model is `forge-web/lib/sdk/cost.ts`, `board` and `card` in `BASE_CREDITS`, `FIRST_WRITE_CREDITS` and `REPLACE_BASE_BY_TYPE`):

| Write | Credits | ≈ DASH |
|---|---|---|
| A board (the Kanban template, 738 bytes of name and definition): a repository's first | 62.8M–63.8M | 0.00064 |
| A repository's later board | 53.7M–54.7M | 0.00055 |
| A board's rename, close, reopen or delete (a replace) | 3.4M–4.6M | 0.00004–0.00005 |
| A card for an item another member already has a card for | 42.8M–43.2M | 0.00043 |
| An item's first card on the board | 70.5M–70.9M | 0.00071 |
| A board's first card (also the item's first) | 88.3M–89.1M | 0.00089 |
| A card's move (column and rank), field change or archive (a replace) | 4.2M–5.2M | 0.00005 |
| A write consensus refuses (a non-member's card or board, a removed member's replace, a card naming no issue or PR) | 1.6M–2.1M (once 10.3M) | 0.00002–0.0001 |

A board's text is priced per byte (27,500 credits), so a longer definition costs more. Sources, Done, auto-archive and views cost nothing. `priceBoardWrites(creates, replaces)` prices a multi-write action (a re-rank, "move to the next iteration", a bulk archive) before it is signed.

## 8. Limits

| | |
|---|---|
| columns | 20 |
| fields | 12, ≤ 30 options each |
| sources | 5 |
| views | 8 |
| definition | 4096 B of JSON |
| field values per card | 2048 B of JSON |
| items | no cap; a board reads 100 cards per page, so very large boards load progressively |
