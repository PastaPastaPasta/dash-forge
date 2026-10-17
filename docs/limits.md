# Limits

What Forge cannot hold or do, in numbers, with where each number comes from. Some are Dash Platform's and some are Forge's own rules. The ones marked **frozen** are fixed once a network's contracts are registered ([Deploying Forge to a network](deploying-to-a-network.md#7-after-registration-what-can-still-change)). If a push or a command fails, start with [My first push failed](guides/first-push-troubleshooting.md).

1. [Sizes](#sizes)
2. [Text and counts](#text-and-counts)
3. [What the apps read](#what-the-apps-read)
4. [Pushes and the cost guard](#pushes-and-the-cost-guard)
5. [Not supported](#not-supported)

## Sizes

| What | Limit | Source |
|---|---|---|
| One state transition (a signed write) | **20,480 bytes** (20 KiB) | Platform's `max_state_transition_size`; `ST_SIZE_LIMIT` in `crates/forge-core/src/pack.rs` |
| One byte-array field | 4,900 bytes (Platform's hard cap is 5,120; the rest is document overhead) | `FIELD_MAX` in `pack.rs` |
| One `chunk` document (git pack bytes on Platform) | 3 fields, **14,700 bytes** of pack per chunk (about 14.4 KiB); a full chunk leaves at least 5 KiB for headers | `DOC_PAYLOAD_MAX` in `pack.rs` |
| A pack | **1 TiB**: the cap on the size a manifest records (**frozen**). Forge's tools add no smaller cap; on Platform a pack is split over as many chunks as it needs, each costing about 0.005 DASH | [forge-v2.md §9](contracts/forge-v2.md#9-frozen-at-mainnet); [Costs](guides/costs.md) |
| A contract (registration) | 20,480 bytes, and at least 2,000 bytes of headroom under that for the create transition | `deploy-v2.mjs` |
| Pack download time | each copy gets `max(120 s, size ÷ 1 MiB/s)`; a manifest with no size allows 256 MiB | [Bring your own storage](guides/bring-your-own-storage.md) |
| Read-back check after an upload | a full download and SHA-256 up to 16 MiB; larger packs get a size check and byte-exact head and tail ranges | same |
| A history or flat index, inflated | 64 MiB | `MAX_INFLATED` in `crates/forge-core/src/pack/historyindex.rs` and `flatindex.rs` |
| One repack names at most | 32 older packs it supersedes; run it again for the next ones | [Bring your own storage](guides/bring-your-own-storage.md) |
| A release asset uploaded from the browser | 256 MiB per file | [Collaborating](guides/collaborating.md#from-the-web-app) |
| A branch downloaded as a zip | 100 MB, built in your browser | [Quick start](guides/quick-start.md#7-view-it-on-the-web) |

## Text and counts

| What | Limit | Source |
|---|---|---|
| An issue, comment or release-notes body | **5,120 bytes** on Platform (less in a private repository, where the title and other encrypted text share the space) | [Collaborating](guides/collaborating.md#issues) |
| A longer text | up to **256 KiB**, posted by a maintainer or writer; the field keeps its first part and names an artifact. Triage, Read and non-members stay within 5,120 bytes | [forge-v2.md §6.3](contracts/forge-v2.md#63-long-bodies-a-text-longer-than-its-field-client-convention-p1-9) |
| A members-only post | 5,120 bytes less 61 bytes of envelope; a bot's reply is cut to at most 4,800 | [private-repos.md §23](security/private-repos.md#23-bots-members-only-posts-enc-v0x05) |
| An inline comment's diff hunk | 1,024 bytes (it can be raised by an update, never lowered) | [forge-v2.md §9](contracts/forge-v2.md#9-frozen-at-mainnet) |
| A repository name | 1 to 63 characters: lowercase letters, digits, `.`, `_` and `-`, starting with a letter or digit ([E202](errors.md#e202)) | `docs/errors.md` |
| Topics on a repository | 20, each 1 to 30 characters (**frozen**) | [Collaborating](guides/collaborating.md#repository-settings) |
| Protected-branch patterns | 8 | same |
| Required checks and their sources | 10 (**frozen**) | [forge-v2.md §9](contracts/forge-v2.md#9-frozen-at-mainnet) |
| Reviewers asked from CODEOWNERS | 15 | [Collaborating](guides/collaborating.md#code-owners) |
| People a message can go to | 16, you included (an environment: 64) | [Who can read what](security/audiences.md#send-a-message-to-specific-people) |
| A bot's access note | 500 characters; the AI service's name 100; a task for a bot 120 | [Bots and agents](guides/bots.md) |
| A bot's push access | at most 90 days (30 by default) | [Bots and agents](guides/bots.md#let-it-push) |
| Names that differ only in case, or one the other as a folder (`feature` and `feature/x`) | refused for branches and tags | [Collaborating](guides/collaborating.md#pushing-branches) |

## What the apps read

The apps read documents in pages and stop at a limit rather than guess. A result past a limit is marked, never silently wrong.

| What | Limit | Effect |
|---|---|---|
| A repository's member-event feed | **30 pages of 100: 3,000 events** (`FEED_MAX_PAGES` in `forge-web/lib/repo/issues.ts`) | Past it, label and assignee filters, pinned issues and milestone progress are shown as unverified. Hides, bans, labels, assignments and pins are events, so a very busy repository, or one that moderates a flood one post at a time, reaches it. Events cannot be deleted |
| Pull requests in a search | the newest 100 | [Collaborating](guides/collaborating.md#searching-and-what-concerns-you) |
| Code search | files over 384 KiB are skipped; at most 100 MiB of text; a repository over 2,000 files or 16 MiB stored is indexed on its default branch only | [Quick start](guides/quick-start.md#search-the-code) |
| The history index | each path's newest 256 first-parent versions | [Costs](guides/costs.md#history-index) |

## Pushes and the cost guard

| What | Limit | Source |
|---|---|---|
| A push that costs more than | `dash.costWarnThreshold`, **0.05 DASH** by default, asks first; with no terminal it stops with [E801](errors.md#e801) | [Costs](guides/costs.md#seeing-costs-before-you-pay) |
| Storing packs on Platform | a push that would store **more than 1 MiB** while `dash.storage` is unset asks first (they are permanent); raising the threshold does not lift this, choosing storage does | [E801](errors.md#e801) |
| The key's budget | a limited key spends at most its budget (0.25 DASH for `dg auth new`'s key, 0.05 for a browser key by default) ([E402](errors.md#e402)) | [Identity and keys](guides/identity-and-keys.md#limited-keys) |
| Memory while indexing a fetched pack | none unless you set `dash.maxPackInput` (the gateway sets one) | [Gateway](hosting/forge-gateway.md) |
| One identity writing from two places at once | two writers can pick the same nonce; one write is dropped ([E704](errors.md#e704)) | `docs/errors.md` |

## Not supported

- **Shallow clones** (`--depth`, `--shallow-since`, `--shallow-exclude`) fail with [E205](errors.md#e205). Use `git clone --filter=blob:none`.
- **Atomic pushes** (`git push --atomic`): each branch and tag is its own write.
- **Git LFS objects.** A repository can hold LFS pointer files, but the large files are not stored: keep large binaries out of git, or attach them to releases.
- **A git older than 2.44** cannot clone histories with malformed author lines ([E511](errors.md#e511)).
- **Forks and webhooks of private repositories** ([E207](errors.md#e207)).

What Forge leaves out by design or for later is in the [FAQ](FAQ.md#what-doesnt-forge-do-yet).
