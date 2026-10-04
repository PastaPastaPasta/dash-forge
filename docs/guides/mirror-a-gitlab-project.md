# Mirror a GitLab project

A Forge mirror of a GitLab project (on gitlab.com or your own instance) is a copy nobody can take down. It works like the [GitHub mirror](mirror-a-github-repo.md):

- **Refs and history metadata** live on Dash Platform, signed by your identity.
- **Pack bytes** live in your own storage, on Platform, or both.
- **Readers** clone with `git clone dash://…` or browse the static web app.

You keep working on GitLab and let the mirror follow.

This guide covers:

1. [Before you start](#before-you-start)
2. [First import: code, issues, merge requests, labels and releases](#1-first-import)
3. [Keep it in sync from GitLab CI](#2-keep-it-in-sync-from-gitlab-ci)
4. [What is mirrored, and what is not](#3-what-is-mirrored)

---

## Before you start

You need:

- `dg`, `git-remote-dash` and `forge-import`. The [quick start's](quick-start.md#1-install) install script adds the importer when you ask for it:
  ```sh
  curl -fsSL https://raw.githubusercontent.com/PastaPastaPasta/dash-forge/v0.1.0/install.sh | DASH_FORGE_VERSION=0.1.0 DASH_FORGE_BINARIES="dg git-remote-dash forge-import" sh
  ```
  From a source clone, `cargo install --locked --path crates/forge-import` builds it instead.
- A funded identity, exported as `DASH_FORGE_KEY` ([quick start, steps 2–3](quick-start.md#2-get-an-identity)).
- A GitLab access token with the **`read_api`** scope, in `GITLAB_TOKEN`. For a private project, give it **`read_repository`** too. A project access token scoped to the one project is enough (Settings > Access tokens).
  - Without a token, the importer reads what GitLab shows anonymously: the project, its issues and merge requests, releases and the code. On gitlab.com, anonymous reads of comments, discussions and labels are refused (`401`), so a run without a token imports items without their threads and says so.
  - GitLab.com plans to limit anonymous API use to 60 requests an hour. Use a token for anything but a quick look.
- Optional but recommended: a storage profile for your own bucket ([Bring your own storage](bring-your-own-storage.md)), set with `dg storage use <profile> --global`, so pack bytes do not go on Platform.

> **Network.** Forge runs on devnet sakura (`--network devnet --devnet-name sakura`; RC2 registered on Platform v5.0.0-beta.1). See [Which network](README.md#which-network).

---

## 1. First import

Name the project as `gitlab.com/<group>/<project>` or by its URL. A project on your own GitLab instance is named by its path, with `--gitlab-url`:

```sh
export GITLAB_TOKEN=glpat-…        # read_api
export DASH_FORGE_NETWORK=devnet DASH_FORGE_DEVNET_NAME=sakura   # forge-import does not read dg's saved network
forge-import gitlab.com/acme/widget --dry-run
forge-import team/app --gitlab-url https://git.example.org --dry-run
forge-import team/app --gitlab-url https://example.org/gitlab --dry-run   # a relative URL root
```

A GitLab installed under a relative URL root (`https://example.org/gitlab`) needs `--gitlab-url` with that root. A bare project URL such as `https://example.org/gitlab/team/app` cannot tell the root from the group path.

The token is sent as `Authorization: Bearer`, only to that instance: the importer follows no redirect. A project that moved answers with a redirect, and the importer reports the new path instead of following it. An `http://` instance is refused unless you pass `--allow-http`, because the token would travel unencrypted.

**Members-only content is refused by default.** When a project's issues or merge requests are visible only to its members on GitLab, the importer stops and names the flag `--include-members-only`. A Forge mirror is public and permanent, so members-only discussions must never be published by accident. Pass the flag only if you mean to publish them, or leave that class out with `--sync`. Internal comments and confidential issues are never mirrored, flag or not.

Start with a dry run. It reads everything, compares it with what the destination already holds, and prints what it would write and the estimate. Then run it with a cap:

```sh
forge-import gitlab.com/acme/widget --max-spend 0.5 --state ./widget.sync.json
```

The flags are the same as for GitHub: `--repo`, `--sync`, `--max-spend`, `--state`, `--dry-run`, `--limit`, `--concurrency`, `--yes`, `--summary-json`, and the network flags. See the [GitHub guide's table](mirror-a-github-repo.md#1-first-import). In `--sync`, `prs` means merge requests (`mrs` works too). `dg import gitlab.com/acme/widget` is the same engine.

**Re-running is safe and cheap.** What is already mirrored is decided on chain, by the GitLab URL each document records (`https://gitlab.com/acme/widget/-/issues/12`, `…/-/merge_requests/3`, and `…#note_<id>` for a comment). A re-run writes only what is new and costs nothing when nothing changed. It is the same scheme as the GitHub importer.

The exit codes and the summary's `status` are the same as for GitHub: `ok`, `partial`, `cap_exceeded` or `error`.

**When GitLab refuses part of the project,** the run carries on with the rest. Examples: comments or labels without a token (`401`), or releases that are disabled or members-only (`403`). Each refusal is a warning that names the cause, and the run ends `partial` (exit 4). A partial run does not advance `--state`, so the next run with more access reads those items again. Only a refused project read fails the run.

**Rate limits.** The importer makes at most 100 API requests a minute, which is GitLab.com's planned limit for the Free tier. On a `429` it waits for as long as GitLab's `Retry-After` says.

---

## 2. Keep it in sync from GitLab CI

GitLab's own push mirroring cannot target Forge: it accepts only `http://`, `https://`, `ssh://` and `git://` URLs ([GitLab docs](https://docs.gitlab.com/user/project/repository/mirror/)). Use the CI template in [`integrations/gitlab/`](../../integrations/gitlab/README.md) instead. It has two jobs:

- **`forge-mirror-code`** runs on every push to a protected branch or tag, on schedules, and on manual runs. It pushes `refs/heads/*` and `refs/tags/*` with explicit refspecs, capped at `FORGE_PUSH_CAP`.
- **`forge-import`** runs on schedules and manual runs when `FORGE_IMPORT` is `"true"`. It runs `forge-import` for issues, merge requests, labels and releases, under `FORGE_COST_CAP`. A partial run (exit 4) shows as a warning, or as a failure with `FORGE_FAIL_ON_PARTIAL: "true"`.

Both jobs run only on protected refs. That is where the protected key is available, and an unprotected branch's pipeline must never reach it.

Add to the project's `.gitlab-ci.yml`, pinning a Dash Forge release (the tag in the URL and `FORGE_VERSION` must agree):

```yaml
include:
  - remote: https://raw.githubusercontent.com/PastaPastaPasta/dash-forge/v0.1.0/integrations/gitlab/dash-forge-mirror.yml

variables:
  FORGE_REPO: dash://<owner identity id>/<repo name>
  FORGE_VERSION: "0.1.0"
  FORGE_IMPORT: "true"
  FORGE_COST_CAP: "0.05"
```

Then, in **Settings > CI/CD > Variables**:

| Variable | Type | Flags | Value |
|---|---|---|---|
| `DASH_FORGE_KEY` | **File** | Protected | The CI identity file ([The CI secret](mirror-a-github-repo.md#the-ci-secret)), or a file holding a `dfk1:` runner key. |
| `GITLAB_TOKEN` | Variable | Masked, Protected | A project access token with `read_api`. The job token cannot read issues, notes, discussions or labels ([GitLab docs](https://docs.gitlab.com/ci/jobs/ci_job_token/)). |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Variable | Masked, Protected | Only with `FORGE_STORAGE_KIND: s3`. |

Why these settings:

- **A File variable for the key.** A masked variable must be a single line of a limited character set, which an identity JSON is not. A File variable is written to a temporary file, and the job reads its path from `DASH_FORGE_KEY`. The jobs refuse any other type without printing the value. The tools refuse identity contents passed where a path belongs, and never echo them.
- **Protected.** Protected variables reach only pipelines on protected branches and tags. The default branch is protected by default. Protect tags (`*`) too if they should mirror. A merge request from a fork never sees the key.

For the scheduled import, add a schedule in **Build > Pipeline schedules > New schedule**, for example daily. It runs with the schedule owner's permissions.

What the template does:

- `resource_group: dash-forge-mirror`, so two mirror jobs never run at once. A second job waits for the first.
- `GIT_DEPTH: "0"`, the whole history. New projects clone 20 commits deep, and a shallow push is refused.
- **Installing the tools.** One of `FORGE_VERSION` (a release) or `FORGE_SOURCE_REF` (a reviewed commit) is required, so nothing is installed from a moving branch.
  - With `FORGE_VERSION`, it runs that release tag's `install.sh`, the same installer the GitHub Mirror Action uses, which checks the archive against its `SHA256SUMS`.
  - Otherwise it runs `cargo install --git … --rev $FORGE_SOURCE_REF`, with a checksummed protoc: for code that is not in a release, pin a commit you have reviewed in the `include` URL and set `FORGE_SOURCE_REF` to the same commit instead of `FORGE_VERSION`. The first build takes several minutes, and the CI cache keeps the binaries after that.
  - Installers run with the key and tokens removed from their environment.
- **The code push** fetches every branch into a private namespace, then runs `git push --prune dash://… '+refs/forge/heads/*:refs/heads/*' '+refs/tags/*:refs/tags/*'`. It never uses `--mirror`. GitLab also advertises `refs/merge-requests/*`, `refs/pipelines/*` and `refs/environments/*`, and `--mirror` would publish each of them as a paid ref update.
- **The import** keeps its `--state` file in the CI cache, so a scheduled run asks GitLab only for what changed. The run summary is kept as an artifact (`.forge/summary.json`).
- **Storage.** `FORGE_STORAGE_KIND: s3` with the `FORGE_S3_*` variables adds your bucket for the job only, as the GitHub Action's inputs do. `FORGE_S3_VIRTUAL_HOSTED: "true"` selects virtual-hosted addressing (AWS), and `FORGE_REPLICAS` sets the storage confirmations a push needs.
- **Members-only content.** `FORGE_INCLUDE_MEMBERS_ONLY: "true"` passes `--include-members-only`. An `http://` GitLab needs `FORGE_GITLAB_ALLOW_HTTP: "true"`.

**The CI key can spend.** An import spends at most `FORGE_COST_CAP`. A code push the helper prices above `FORGE_PUSH_CAP` (default 0.05 DASH) is refused before anything is stored. Give CI a separate identity with a small balance, or a limited `dfk1:` key, as described for [GitHub](mirror-a-github-repo.md#the-ci-secret).

---

## 3. What is mirrored

| GitLab | Forge |
|---|---|
| Branches and tags | Branches and tags (force-pushes and deletions too). |
| Issues `#n` | Issues, at the same number. The body opens with *"Mirrored from gitlab.com/acme/widget#12 by @bob"*. |
| Merge requests `!n` | Pull requests at the same number: title, description, target branch, head commit, state (open, closed, merged, draft; a merge is recorded against the mirrored tip of the target branch that contains the merge commit, or as closed when that branch is not mirrored), and labels. GitLab numbers issues and merge requests separately, and so does Forge. |
| The head of an open merge request | `refs/mirror/pull/<n>/head`, so it can be checked out. This includes fork merge requests: GitLab keeps a fork MR's head in the project too. |
| Comments on issues, discussions on merge requests | Comments, oldest first. A diff comment keeps its file, line and commit as the comment's anchor. |
| Labels | Label definitions, and each item's labels. |
| Releases | Tag, title, notes, and each asset link, recorded by URL. GitLab reports no digest or size for links. |

**Merge requests whose commits are gone.** GitLab deletes `refs/merge-requests/<n>/head` 14 days after a merge request closes or merges ([GitLab docs](https://docs.gitlab.com/user/project/merge_requests/merge_request_troubleshooting/)). Such a merge request is still imported: its metadata, state (closed or merged), comments and the head commit id. Its body says that its commits are not available. A merged one's changes are in its target branch anyway.

**Not mirrored:**

- Comments marked internal, and confidential issues. The mirror is public, and those are members-only on GitLab.
- System notes ("changed the description", "added 1 commit"). State is replayed as events instead.
- Later edits to a title or description, reactions, milestones, assignees, approvals, epics, the wiki, snippets, and CI pipelines.
- GitLab's generated source archives of a release.
