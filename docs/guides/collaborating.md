# Collaborating

Everything a team does on Forge is a signed document on Dash Platform: who may push, issues, comments, pull requests, reviews, merges and releases. There is no server in the middle to ask. Consensus decides who may write, and every client computes the same state from the same documents.

1. [Collaborators](#collaborators)
2. [Issues](#issues)
3. [Pull requests](#pull-requests)
4. [Releases](#releases)
5. [From the web app](#from-the-web-app)

The commands below take a repository as `<owner>/<name>`, where `<owner>` is the owner's **identity id** (base58). A bare `<name>` means one of your own repositories. DPNS usernames are not resolved yet.

> **Two access models.** Today's **testnet** repositories are **v1**: access is a pair of tokens on each repository's own contract. **forge-v2**, on devnet moutai now and on mainnet after Platform protocol 14 activates, uses membership documents in one shared contract instead. The commands stay the same. What changes underneath is called out where it matters.

---

## Collaborators

There are two roles:

| Role | `--role` | Can |
|---|---|---|
| Writer | `write` | Push to unprotected branches; label, assign, close and reopen any issue or PR; merge PRs. |
| Maintainer | `maintain` | Everything a writer can, plus protected branches, releases, labels, webhooks and repository settings. |

Anyone, member or not, can open issues and PRs, comment and review. Only members' approvals count toward a PR's review state.

```sh
dg collab list <owner>/<repo>
dg collab add <owner>/<repo> <identity id> --role write
dg collab add <owner>/<repo> <identity id> --role maintain
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

*Available on devnet moutai; mainnet after Platform protocol 14 activates.*

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

**Who can change state.** The issue's author can close and reopen it. Writers and maintainers can close, reopen and label any issue. An event from anyone else is ignored when the state is computed.

**Numbers.** Issue numbers are claimed by the client. If two people take the same number at once, consensus rejects the second one, and `dg` retries with the next free number.

**No deletes on v2.** Issues, PRs and their state events cannot be deleted on forge-v2, so nobody can rewrite a thread's history. Comments can be deleted by their author.

---

## Pull requests

A pull request is a `patch` document in the **base** repository. It points at the commit you want merged and at the repository that holds that commit. The code itself lives in your repository, not in the PR.

### The flow

**1. Have a repository you can push to.** If you are a writer on the base repository, push a branch to it directly and skip to step 3.

Otherwise, use a repository of your own. **`dg repo fork` is not implemented yet** (it fails with [`E103`](../errors.md#e103)). Create a repository yourself instead:

```sh
dg repo create project-fork       # v1: ~1.18 DASH; forge-v2: ~0.001 DASH
```

**2. Push your branch to it.**

```sh
git clone dash://<owner>/project && cd project
git switch -c fix-empty-input
# … commit …
git push dash://<your identity id>/project-fork fix-empty-input
```

**3. Open the PR.** On v1, `dg pr create` needs the **contract id** of the repository that holds your commit, and the commit id:

```sh
dg repo view <your identity id>/project-fork       # prints "contract: <id>"
dg pr create <owner>/project \
  --title "Handle empty input" --body "Fixes #12" \
  --base refs/heads/main \
  --source-contract <contract id from repo view> \
  --source-ref refs/heads/fix-empty-input \
  --head-oid "$(git rev-parse HEAD)"
```

```
Opened PR #7: Handle empty input
```

**Coming soon:** `dg pr create` that works out `--head` from your current branch and fork, so you don't have to pass contract ids.

**4. Review.** Reviewers fetch your commit straight from your repository:

```sh
dg pr list     <owner>/project
dg pr view     <owner>/project 7
dg pr diff     <owner>/project 7          # fetches the head, then git diff base...head
dg pr checkout <owner>/project 7          # creates local branch pr/7 at the PR head
dg pr review   <owner>/project 7 --verdict approve --body "LGTM"
dg pr review   <owner>/project 7 --verdict request-changes --body "Needs a test"
```

A review is counted for the commit it was made on (`--commit`, which defaults to the PR head). Only approvals from current writers and maintainers count. A new push to the PR makes older approvals stale.

**5. Merge.** In Forge, merging is two separate steps:

1. **Push the merged code to the base branch.** This is plain git, and you need write access to the base branch. Consensus enforces that.
2. **Record the merge.** `dg pr merge` posts a `merge` event naming the commit that landed.

A PR shows as merged only when **both** are true: the event comes from a writer or maintainer, and its commit is reachable from the base branch's tip. A `merge` event on its own merges nothing, and clients ignore it.

Fast-forward (the PR head goes onto `main` as it is):

```sh
dg pr checkout <owner>/project 7
git push dash://<owner>/project pr/7:main
dg pr merge <owner>/project 7
```

Merge commit:

```sh
git switch main && git pull
dg pr checkout <owner>/project 7
git switch main && git merge --no-ff pr/7
git push dash://<owner>/project main
dg pr merge <owner>/project 7 --merge-oid "$(git rev-parse HEAD)"
```

`dg pr merge` reads the result back and says whether the PR now reads as merged. If it does not, it prints the `git push` you still need.

**Coming soon:** `dg pr merge` doing the git merge and push for you (with `--event-only` for today's behavior), and merging from the browser.

---

## Releases

A release names a tag, a title and notes. Maintainers publish them. On v1 that means holding the MAINTAIN token.

```sh
git tag v1.0.0 && git push dash://<owner>/<repo> v1.0.0
dg release create <owner>/<repo> --tag v1.0.0 --name "1.0.0" --notes "First stable release"
dg release list   <owner>/<repo>
dg release download <owner>/<repo> v1.0.0 [--asset <name>] [--output <path>]
```

`dg release download` checks each asset against the SHA-256 recorded in the release and refuses a mismatch. `dg release create` has no way to attach assets yet, and `forge-import` copies a GitHub release's tag, title and notes but not its assets.

To withdraw a release, publish it again with `--yanked`. The newest release for a tag wins.

**Coming soon:** `dg release create --asset ./dist/x.tar.gz`, which uploads assets to your storage and records their SHA-256.

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
