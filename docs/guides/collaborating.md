# Collaborating

Everything a team does on Forge is a signed document on Dash Platform: who may push, issues, comments, pull requests, reviews, merges and releases. There is no server in the middle to ask. Consensus decides who may write, and every client computes the same state from the same documents.

1. [Collaborators](#collaborators)
2. [Issues](#issues)
3. [Pull requests](#pull-requests)
4. [Releases](#releases)
5. [From the web app](#from-the-web-app)
6. [Webhooks and CI](#webhooks-and-ci)

The commands below take a repository as `<owner>/<name>`, where `<owner>` is the owner's **identity id** (base58) or **DPNS username** (`alice` or `alice.dash`, resolved with a proof-verified DPNS read). A bare `<name>` means one of your own repositories.

---

## Collaborators

There are two roles:

| Role | `--role` | Can |
|---|---|---|
| Writer | `writer` (default) | Push to unprotected branches; label, close and reopen any issue or PR; record merges. |
| Maintainer | `maintainer` | Everything a writer can, plus protected branches, releases, repository settings (`config`) and webhooks. |

`--role write` and `--role maintain` are accepted as aliases.

Anyone, member or not, can open issues and PRs, comment and review.

```sh
dg collab list   <owner>/<repo>
dg collab add    <owner>/<repo> <identity id> --role writer
dg collab remove <owner>/<repo> <identity id> --role writer
```

Adding or removing a collaborator is a write by the repository owner, signed with the owner's HIGH key.

### Repository settings

Maintainers change a repository's settings from the CLI or from **Settings** in the web app. Each change is a small paid write, shown with its cost before you confirm; repeating a change that already holds writes nothing.

```sh
dg repo protect add    <owner>/<repo> main              # or a glob: 'release/*', 'refs/tags/v*'
dg repo protect remove <owner>/<repo> main
dg repo protect list   <owner>/<repo>
dg repo edit <owner>/<repo> --default-branch trunk       # maintainers
dg repo edit <owner>/<repo> --description "…" --topics rust,cli   # the owner
dg repo policy set  <owner>/<repo> --required-approvals 2 --maintainers-only true --merge-methods ff,squash
dg repo policy show <owner>/<repo>
dg repo archive   <owner>/<repo>
dg repo unarchive <owner>/<repo>
```

What each one enforces:

- **Protected branches** are enforced by Platform. A ref matching a pattern moves only through a maintainer-only document; a writer's push is refused ([`E601`](../errors.md#e601)), and a plain update of a protected ref is ignored by every reader. A bare name means `refs/heads/<name>`; `*` stays within one path segment and `**` crosses segments. Up to 8 patterns.
- **The default branch** is what a clone checks out and what the web opens on.
- **The branch policy** is a client rule. Every Forge client applies it: the web disables a writer's merge until it is met, and `dg pr merge` refuses it ([`E804`](../errors.md#e804)). A maintainer can override it (`--override-policy`). Nothing on Platform requires approvals.
- **Archiving** is a client rule too. Forge clients refuse writes to an archived repository: the web disables issues, PRs, merges and releases; `dg` refuses issue, PR, comment, review, merge and release writes; and the push helper refuses pushes. All of these use [`E606`](../errors.md#e606). Override with `dg --allow-archived …` or `git push -o allow-archived`. Platform still accepts a member's writes.

The description and topics live on the repository document, which only its owner can edit. They are public even for a private repository. A private repository's other settings are encrypted: the CLI writes them sealed, and the web app does not write them yet.

### How access works

A collaborator is a `writer` or `maintainer` document in Forge's shared forge-core contract, keyed by (repository, member). Only the repository owner can create one, and consensus enforces that. Every write-path document type (ref updates, packs, releases, config, events) names its gate, and consensus refuses a write whose author has no current membership document ([`E601`](../errors.md#e601), Platform code 40120).

- **Add** creates the membership document. **Remove** deletes it. The member's next write is refused.
- **There is no suspend.** Remove the member, and add them again later.
- **Past work stays valid.** A document's existence proves its writer was a member at the time it was written. Removing a maintainer later does not undo their past merges or ref updates.
- The owner is enrolled as a maintainer when the repository is created.

[forge-v2.md](../contracts/forge-v2.md) §2 lists which role each document type needs.

---

## Private repositories

A private repository's content is encrypted on your machine before it leaves it, to a key only its members hold. Platform nodes, storage providers and anyone else see ciphertext. The design is [docs/security/private-repos.md](../security/private-repos.md).

```sh
dg auth keys add --encryption                   # once per identity (see Identity and keys)
dg repo create secret --private                 # or `dg init --private`
git push dash://<you>/secret main               # packs are sealed, ref names encrypted
dg collab add    <you>/secret <identity id>     # membership + the key, wrapped to them
dg collab remove <you>/secret <identity id>     # delete + key rotation
dg repo keys status <you>/secret                # epochs, who holds a key, pending repairs
```

**What is hidden and what is not.** The encryption covers the content. What the network needs to enforce access stays visible:

| Encrypted (members only) | Visible to everyone |
|---|---|
| Code: every pack, index and browse artifact | That the repository exists; its name, owner, description, display name and topics |
| Branch and tag names | Members and their roles; when each joined; key epochs and who rotated them |
| Default branch and protected-branch patterns | When pushes, issues, PRs, comments and reviews happen, and who wrote each |
| Issue and PR titles and bodies, comment and review text, an inline comment's file path | Commit ids (`newOid`, PR heads): anyone who already knows a commit id can confirm the repo contains it |
| | Sizes: pack sizes, object counts, the approximate length of every encrypted field |
| | **Not encrypted in this release:** release names, notes and assets; labels; label names and other event values; check runs; webhook URLs |

Leave the description empty if the project's purpose is itself sensitive.

**Every member needs an encryption key.** Private repositories wrap the key to each member's identity `ENCRYPTION` key. `dg collab add` checks the member has one and stops before writing anything if not ([`E306`](../errors.md#e306)); they add one with `dg auth keys add --encryption`, or Settings → Keys → **Enable private repos** in the web app.

**Removing a member rotates the key.** New pushes, issues and comments will be unreadable to the removed member. Everything they could already read stays readable to them: encryption can't take back what was shared. The rotation is one key wrap per remaining member plus one anchor document, so `dg collab remove` shows the cost first. You are wrapped first, so an interruption never locks you out; running `dg repo keys repair` finishes an interrupted rotation (the key is recovered from your own wrap on chain, never from a local file).

**Repairs.** A maintainer's `dg` and `git push` check the key on every visit: if a non-member still holds the current key (two maintainers removed members at the same time), or a member has no wrap to their current encryption key (they replaced it, or an add was interrupted), `dg repo keys repair` fixes it. The key is re-read before every write, so nothing is ever written under a key that was rotated away.

**Cloning.** `git clone dash://<owner>/<repo>` works as for a public repository when your key source holds your encryption key: the identity file (`DASH_FORGE_KEY`) or `dg auth login --full-key`, not the limited key a plain `dg auth login` stores ([identity and keys](identity-and-keys.md#encryption-key-private-repositories)). A non-member gets [`E307`](../errors.md#e307); an identity without an encryption key gets [`E306`](../errors.md#e306).

**No recovery.** If every member loses their encryption key (every copy of every identity file and mnemonic), the contents cannot be decrypted by anyone.

Not supported for private repositories yet: forks (`dg repo fork`, refused with a clear error), and `dg issue`, `dg pr`, `dg release` and `dg label` on them (refused until their sealed forms land).

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

**No deletes.** Issues, PRs and their state events cannot be deleted, so nobody can rewrite a thread's history. Comments can be deleted by their author.

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

A fork is a new repository with `forkOf` set to the parent. It records the parent's packs **by reference**, so nothing is uploaded again. Packs on external storage keep their URLs, and packs on Platform are read from the parent's chunks, which are permanent. The fork's cost is its own documents: the repo, one small manifest per pack, and the refs. Re-running an interrupted fork finishes it without paying twice. It never moves a branch you have already pushed to the fork.

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
dg pr view     <owner>/project 7          # state, reviewers, approvals, reviews
dg pr view     <owner>/project 7 --comments   # + threads under their file and line
dg pr diff     <owner>/project 7          # fetches head and base, then git diff base...head
dg pr commits  <owner>/project 7          # the commits the PR adds
dg pr checks   <owner>/project 7          # check runs reported on the head
dg pr checkout <owner>/project 7          # creates local branch pr/7 at the PR head
dg pr review   <owner>/project 7 --approve --body "LGTM"
dg pr review   <owner>/project 7 --request-changes --body "Needs a test" \
  --file src/a.rs --line 12 --body "off by one?" \
  --file src/b.rs --start-line 3 --line 5 --side old --body "why remove these?" \
  --file src/c.rs --line 9 --suggest 'let x = 1;' --body "simpler"
dg pr comment  <owner>/project 7 --body "Why this approach?"          # one comment now
dg pr comment  <owner>/project 7 --reply-to <comment id> --body "Done"
```

**Inline comments.** Every flag after a `--file` belongs to that file's comment, until the next `--file`. `--line` alone is one line; `--start-line` makes a range. `--side old` is the removed side of the diff. With no `--line`, the comment is about the whole file. `--suggest` adds a ```` ```suggestion ```` block that the PR's author can apply. The review and its comments are 1 + N documents, written one after another. If the submit is interrupted, running the same command again finishes it without writing anything twice.

**Pending review.** `dg pr review … --pending --file … --line … --body …` adds comments to a review kept on your machine and writes nothing. A later `dg pr review … --request-changes` (or `--approve`, `--comment`) submits all of them with the verdict. `--discard` throws the pending review away.

**Conversations.** `dg pr resolve <owner>/project 7 <comment id>` resolves a thread, and `unresolve` reopens it. The PR's author and its members can do this. `dg pr request-review <owner>/project 7 @alice` asks for a review, and `unrequest-review` withdraws the request. A member can `dg pr dismiss-review <owner>/project 7 <review id> --reason "…"`: the review then counts neither for nor against. The reason is public.

**Suggestions.** The PR's author (anyone who can push to its branch) runs `dg pr suggestion apply <owner>/project 7 --all`, or names comment ids. This commits the suggestions to the PR branch as one commit, with a `Forge-Suggestion:` trailer per comment, and moves the PR head to it. Overlapping suggestions, or ones made on an older head, are refused with [`E107`](../errors.md#e107).

**Drafts and edits.** `dg pr create --draft` opens a draft. `dg pr ready` and `dg pr draft` switch between the two. The author can change the title and description with `dg pr edit <owner>/project 7 --title … --body …`.

A review records the commit it was made on, which is the PR's head at the time. **Which approvals count:**

- Only reviews from current writers and maintainers count.
- Only reviews on the PR's **current** head count. When the head moves, older reviews go stale: `dg pr view` marks them, and tells a reviewer "new commits since your review".
- A reviewer's newest approve or request-changes review is the one that stands.

Anyone can post a review, but `dg` tells a non-member that theirs does not count.

**The PR follows its branch.** When you `git push` the PR's branch, the helper moves the PR's head to the new commit (a `headUpdate`, about 0.0007 DASH) and says so. It does this for your own PRs only. `git config dash.prAutoSync false` turns it off, and `dg pr sync <owner>/project 7` then does it by hand. `dg pr update-branch <owner>/project 7` merges the base branch into the PR branch and moves the head.

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
2. Fast-forward if it can. Otherwise build a merge commit, authored with your git `user.name` and `user.email`. `--squash` instead makes one commit on the base with the PR's changes, with a `Co-authored-by` line for each other author (`--message` sets its message).
3. Push the result to the base branch. The push uses your `dash.storage` settings when you run `dg pr merge` inside a clone of the repository.
4. Post the `merge` event naming the commit that landed.

Each step is reported. If one fails, the output says what already happened. If the push landed but the event did not, `dg pr merge --event-only` records the event. `--delete-branch` deletes the PR's branch afterwards. This needs write access to the repository it lives in.

- **Conflicts:** nothing is pushed ([`E105`](../errors.md#e105)). Check the PR out, merge the base into it, resolve, push the result to the PR's branch (the PR follows it), and run `dg pr merge` again. `dg pr update-branch` does this for you when the merge is clean.
- **Protected base branch:** only a maintainer can push to it. A writer's merge is refused with [`E601`](../errors.md#e601) before any git work.
- **Merged elsewhere:** if the merge was pushed some other way, `dg pr merge --event-only [--merge-oid <commit>]` only posts the event. The commit must already have been a tip of the base branch: a merge event is permanent, so `dg` refuses to post one that would not count.

A PR shows as merged only when **both** are true: the `merge` event exists (consensus admits it only from a writer or maintainer), and its commit has been **a tip of the base branch**. `dg pr merge` reads the PR back and reports what readers will see.

**Close without merging:** `dg pr close` / `dg pr reopen`. The author can close and reopen their own PR, as with issues.

---

## Releases

A release names a tag, a title, notes and optionally files. Only maintainers can publish one. Consensus enforces this, and `dg` checks it before uploading anything.

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

On forge.dashhq.org, signed in with a limited key ([Identity and keys](identity-and-keys.md#limited-keys)):

| You can | Not yet (coming soon) |
|---|---|
| Browse code, commits, branches, tags and PR diffs; download a branch as a zip | Open a PR |
| File issues, comment, close and reopen; label them (members) | Merge code (see below) |
| Review a PR: approve, request changes or comment | Inline review comments |
| Create a repository, with a cost preview | Fork a repository |
| Add and remove members (owner) | Web editing |
| Publish a release with assets (maintainers) | Private repositories (use `dg`; web views follow) |
| Star repositories and follow people | |
| See your repositories, issues, PRs and stars in **Explore**, and new activity in **Notifications** | |

Every write shows its price before you sign, and a toast shows what it actually cost. **Settings → Spend** keeps a local ledger of what this browser spent, by repository and month.

**Releases from the browser.** On a repository's **Releases** tab, a maintainer sees **New release**. It works like `dg release create --asset`: the maintainer role is checked before anything uploads, each file (up to 256 MiB) goes to *your* storage from **Settings → Storage** (never to Platform), is verified by reading it back, and is recorded with its SHA-256. Anyone who downloads an asset from the release page gets it only if it hashes to the recorded value.

**Merging.** The web app has a **Mark as merged** button, shown only to writers and maintainers. It posts the `merge` event (step 4 of `dg pr merge` above). It does not merge code. The PR counts as merged only once the head is already on the base branch. Use `dg pr merge` to merge code.

**Notifications** are computed in your browser from the chain: new issues and PRs in your repositories, state changes, comments and reviews on your threads, and optionally pushes and starred repositories. There is no email, no push notification and no sync across devices, because there is no server to send them.

**Coming soon:** open a PR from a branch or fork, inline review comments, forks, and real merges from the browser (fast-forward and clean merges, uploaded to your own storage).

---

## Webhooks and CI

A maintainer can have on-chain activity delivered as GitHub-shaped webhooks (`push`, `issues`, `pull_request`, `issue_comment`, `pull_request_review`, `release`, `check_run`), signed with `X-Hub-Signature-256`. Forge runs no webhook service: deliveries come from a **relay** that you, or someone you choose, runs.

```sh
dg webhook add <owner>/<repo> --url https://ci.example/hook \
  --relay <relay identity id> --events push,pull_request --name ci
dg webhook list   <owner>/<repo>
dg webhook remove <owner>/<repo> ci      # by the name it was added with, or its hook id
```

The URL and event list are public on chain. The HMAC secret is encrypted to the relay identity's encryption key, so only that relay can read it; without `--secret-env <VAR>`, `dg` generates one and prints it once. The relay (`forge-relay run`, or its Docker image) needs only that encryption key, never signs and never spends. A delivery that fails is kept in a durable retry queue on the relay's disk and retried for up to 48 hours, across restarts (given a writable state dir; without one the relay warns and keeps the queue in memory); `forge-relay deliveries` lists the queue. Every delivery carries a stable `X-GitHub-Delivery` id, so receivers can drop duplicates.

A relay is trusted for availability only: a receiver that must not be fooled checks what a webhook says against Platform. [`crates/forge-relay/README.md`](../../crates/forge-relay/README.md) covers running one, the delivery guarantees, and a CI consumer that verifies the pushed ref.
