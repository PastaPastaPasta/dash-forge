# Collaborating

Everything a team does on Forge is a signed document on Dash Platform: who may push, issues, comments, pull requests, reviews, merges and releases. There is no server in the middle to ask. Consensus decides who may write, and every client computes the same state from the same documents.

1. [Collaborators](#collaborators)
2. [Issues](#issues)
3. [Pull requests](#pull-requests)
4. [Releases](#releases)
5. [From the web app](#from-the-web-app)

The commands below take a repository as `<owner>/<name>`, where `<owner>` is the owner's **identity id** (base58). A bare `<name>` means one of your own repositories. DPNS usernames are not resolved yet.

> **Two access models.** Today's **testnet** repositories are **v1**: access is a pair of tokens on each repository's own contract. **forge-v2** uses membership documents in one shared contract instead. Its contracts are registered on devnet moutai, but `dg`, `git-remote-dash` and the web app cannot use them yet; it comes to mainnet after Platform protocol 14 activates. The commands below work on v1 today. The differences on forge-v2 are called out where they matter.

---

## Collaborators

There are two roles:

| Role | `--role` | Can |
|---|---|---|
| Writer | `write` | Push to unprotected branches; label, close and reopen any issue or PR; record merges. |
| Maintainer | `maintain` | Protected branches, releases, labels, webhooks and repository settings, plus the issue and PR actions a writer has. On forge-v2 a maintainer can also push anywhere a writer can. |

**On v1, give a maintainer both roles.** Pushing needs the WRITE token, even to a protected branch (the pack and manifest are WRITE-gated). A collaborator with only `maintain` cannot push:

```sh
dg collab add <owner>/<repo> <identity id> --role write
dg collab add <owner>/<repo> <identity id> --role maintain
```

Anyone, member or not, can open issues and PRs, comment and review.

```sh
dg collab list   <owner>/<repo>
dg collab add    <owner>/<repo> <identity id> --role write
dg collab remove <owner>/<repo> <identity id> --role write
```

Adding or removing a collaborator is a write by the repository owner. On v1 it needs the owner's CRITICAL key.

### v1 (testnet today): token ACL

Each v1 repository has two tokens, WRITE and MAINTAIN. `dg collab add` mints one to the collaborator. Every push spends one WRITE token and pays it back to the owner, so consensus rejects a push from anyone who holds none. Only the repository owner can mint, freeze or destroy tokens.

v1 also has **suspend**, which freezes the tokens without taking them away:

```sh
dg collab suspend   <owner>/<repo> <identity id> --role write
dg collab unsuspend <owner>/<repo> <identity id> --role write
```

A suspended writer's next push is rejected at consensus ([`E602`](../errors.md#e602)). `dg collab remove` freezes the tokens and then destroys them.

### forge-v2: membership documents

*Contracts registered on devnet moutai, client support in progress; mainnet after Platform protocol 14 activates.*

On forge-v2, a collaborator is a `writer` or `maintainer` document keyed by (repository, member). Only the repository owner can create one, and consensus enforces that. Every write-path document type (ref updates, packs, releases, config, events) names its gate, and consensus refuses a write whose author has no current membership document ([`E601`](../errors.md#e601), Platform code 40120).

- **Add** creates the membership document. **Remove** deletes it. The member's next write is refused.
- **There is no suspend.** Remove the member, and add them again later.
- **Past work stays valid.** A document's existence proves its writer was a member at the time it was written. Removing a maintainer later does not undo their past merges or ref updates.
- The owner is enrolled as a maintainer when the repository is created.

---

## Issues

Anyone with an identity and some credits can file an issue. Fees are the spam floor.

```sh
dg issue list   <owner>/<repo> [--state open|closed|all] [--limit 50]
dg issue view   <owner>/<repo> 12
dg issue create <owner>/<repo> --title "Crash on empty input" --body "Steps: …"
dg issue comment <owner>/<repo> 12 --body "Fixed in 8f3e2a1"
dg issue close  <owner>/<repo> 12
dg issue reopen <owner>/<repo> 12
dg issue label  <owner>/<repo> 12 --add bug        # or --remove bug
```

**Who can change state.** The issue's author can close and reopen it (an `authorEvent`). Writers and maintainers can close, reopen and label any issue (an `event`). `dg` picks the right one for you. Consensus refuses both from anyone else, and `dg` says so before anything is signed ([`E601`](../errors.md#e601)).

**Numbers.** Issue numbers are claimed by the client, by a rule every client shares: the count of issues bounds how far ahead a number can be, so someone squatting #4294967295 does not move numbering. If two people take the same number at once, consensus rejects the second one, and `dg` retries with the next free number. An interrupted `dg issue create` resumes when run again rather than opening a second issue.

**No deletes on v2.** Issues, PRs and their state events cannot be deleted on forge-v2, so nobody can rewrite a thread's history. Comments can be deleted by their author.

---

## Pull requests

A pull request is a `patch` document in the **base** repository. It points at the commit you want merged and at the repository that holds that commit (`sourceRepoId`): the base itself, or a fork. The code itself lives in that repository, not in the PR.

### The flow

**1. Have a repository you can push to.** If you are a writer on the base repository, push a branch to it directly and skip to step 3. Otherwise, fork it:

```sh
dg repo fork <owner>/project            # or --name <another name>
```

```text
✓ forked <owner>/project → <you>/project
  packs:   36 recorded (36 by reference to the parent's Platform chunks), nothing re-uploaded
  refs:    1 copied
  cost:    ~0.03 DASH ≈ $0.90
```

A fork is a new forge-v2 repository with `forkOf` set to the parent. It records the parent's packs **by reference**, so nothing is uploaded again. Packs on external storage keep their URLs, and packs on Platform are read from the parent's chunks, which are permanent. The fork's cost is its own documents: the repo, one small manifest per pack, and the refs. Re-running an interrupted fork finishes it without paying twice. It never moves a branch you have already pushed to the fork.

**2. Push your branch to it.**

```sh
git clone dash://<you>/project && cd project
git switch -c fix-empty-input
# … commit …
git push dash://<you>/project fix-empty-input
```

**3. Open the PR.** From the branch, with no other flags:

```sh
dg pr create <owner>/project --body "Fixes #12"
```

```text
Open PR "Handle empty input" in <owner>/project: <you>/project refs/heads/fix-empty-input (8f3e2a1c9d0b) → refs/heads/main
✓ opened PR #7 in <owner>/project · ~0.001 DASH ≈ $0.03
```

`dg` fills in the rest:

- **Branch:** the current branch (`--head` to name another).
- **Source repository:** your fork of the base, found through `forkOf`, else the base itself (`--head-repo` to name one).
- **Commit:** where that branch points in the source repository, so the PR always names a commit reviewers can fetch (`--head-oid` to name one).
- **Base:** the base repository's default branch (`--base`).
- **Title:** the head commit's subject (`--title`).

PR numbers follow the same rule as issue numbers.

**4. Review.** Reviewers fetch your commit straight from your repository:

```sh
dg pr list     <owner>/project [--state open|closed|all]
dg pr view     <owner>/project 7          # state, source fork, approvals, reviews, comments
dg pr diff     <owner>/project 7          # fetches head and base, then git diff base...head
dg pr checkout <owner>/project 7          # creates local branch pr/7 at the PR head
dg pr review   <owner>/project 7 --approve --body "LGTM"
dg pr review   <owner>/project 7 --request-changes --body "Needs a test"
dg pr review   <owner>/project 7 --comment --body "Why this approach?"
```

A review records the commit it was made on, which is the PR's head at the time. **Approvals follow the forge-v2 rule:**

- Only reviews from current writers and maintainers count.
- Only reviews on the PR's **current** head count. A new push makes older ones stale, and `dg pr view` marks them so.
- A reviewer's newest approve or request-changes review is the one that stands.

Anyone can post a review, but `dg` tells a non-member that theirs does not count.

**5. Merge.** A writer or maintainer runs:

```sh
dg pr merge <owner>/project 7
```

```text
Merging PR #7 of <owner>/project into refs/heads/main
  ✓ fetch     base 61ebee5956a8 · head e5d18e7f96e9
  ✓ merge     merge commit 3b1f0c2d4e5a
  ✓ push      refs/heads/main → 3b1f0c2d4e5a
  ✓ event     merge event 9FhT…
✓ merged PR #7 (3b1f0c2d4e5a)
```

`dg` does the merge on your machine, in a scratch repository, in four steps:

1. Fetch the base branch and the PR head, each from its own repository.
2. Fast-forward if it can. Otherwise build a merge commit, authored with your git `user.name` and `user.email`.
3. Push the result to the base branch. The push uses your `dash.storage` settings when you run `dg pr merge` inside a clone of the repository.
4. Post the `merge` event naming the commit that landed.

Each step is reported. If one fails, the output says what already happened. If the push landed but the event did not, `dg pr merge --event-only` records the event.

- **Conflicts:** nothing is pushed ([`E105`](../errors.md#e105)). Check the PR out, merge the base into it, resolve, push the result to the base branch, and run `dg pr merge --event-only`. A PR names a fixed head commit, so pushing the resolution to your source branch does not update the PR; open a new PR from it instead.
- **Protected base branch:** only a maintainer can push to it. A writer's merge stops at the push step with [`E601`](../errors.md#e601).
- **Merged elsewhere:** if the merge was pushed some other way, `dg pr merge --event-only [--merge-oid <commit>]` only posts the event. The commit must already have been a tip of the base branch: a merge event is permanent, so `dg` refuses to post one that would not count.

A PR shows as merged only when **both** are true: the `merge` event exists (consensus admits it only from a writer or maintainer), and its commit has been **a tip of the base branch**. `dg pr merge` reads the PR back and reports what readers will see.

**Close without merging:** `dg pr close` / `dg pr reopen`. The author can close and reopen their own PR, as with issues.

---

## Releases

A release names a tag, a title, notes and optionally files. Only maintainers can publish one. On forge-v2 consensus enforces this, and `dg` checks it before uploading anything.

```sh
git tag v1.0.0 && git push dash://<owner>/<repo> v1.0.0
dg release create <owner>/<repo> --tag v1.0.0 --name "1.0.0" --notes "First stable release" \
  --asset ./dist/app-linux.tar.gz --asset ./dist/app-macos.tar.gz [--storage <profiles>]
dg release list   <owner>/<repo>
dg release download <owner>/<repo> v1.0.0 [--asset <name>] [--output <path>]
```

`--asset` uploads each file to your own storage and records its SHA-256, size and URLs in the release. The storage is the repository's `dash.storage` profiles, or `--storage`, and each copy is read back and verified. Platform stores packs, not arbitrary files, so publishing an asset needs an S3 or IPFS profile ([bring your own storage](bring-your-own-storage.md)). `dg release download` accepts only bytes that hash to the recorded SHA-256, and it needs no credentials when the storage has a public URL.

`dg release list` always names who published each release. A maintainer who is later removed can still delete, but not edit, the releases they published.

To withdraw a release, publish it again with `--yanked`. The newest release for a tag wins.

### Labels

Members define a repository's labels and apply them to issues:

```sh
dg label create <owner>/<repo> bug --color "#d73a4a" --description "Something is broken"
dg label list   <owner>/<repo> [--all]
dg label retire <owner>/<repo> bug
dg issue label  <owner>/<repo> 12 --add bug
```

### Stars

```sh
dg repo star   <owner>/<repo>
dg repo unstar <owner>/<repo>
```

---

## From the web app

On forge.dashhq.org, signed in with your identity file:

| You can | Not yet |
|---|---|
| Browse code, commits, branches, tags and PR diffs | Open a PR, or record a review verdict |
| File issues, comment, close and reopen | Merge code (see below) |
| Create a repository (v1, with a cost preview) | Web editing, private repositories |
| Grant, suspend and revoke collaborators (owner) | |
| Star repositories | |

The web app has a **Mark as merged** button, shown only to writers and maintainers. It posts the `merge` event (step 2 above). It does not merge code. The PR counts as merged only once the head is already on the base branch.

**Coming soon:** open a PR from a branch or fork, inline review comments, approve / request changes, and real merges from the browser (fast-forward and clean merges, uploaded to your own storage).
