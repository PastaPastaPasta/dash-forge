# Collaborating

Everything a team does on Forge is a signed document on Dash Platform: who may push, issues, comments, pull requests, reviews, merges and releases. There is no server in the middle to ask. Consensus decides who may write, and every client computes the same state from the same documents.

1. [Collaborators](#collaborators)
2. [Issues](#issues)
3. [Pull requests](#pull-requests)
4. [Releases](#releases)
5. [From the web app](#from-the-web-app)
6. [Webhooks and CI](#webhooks-and-ci)

The commands below take a repository as `<owner>/<name>`, where `<owner>` is the owner's **identity id** (base58) or **DPNS username** (`alice` or `alice.dash`, resolved with a proof-verified DPNS read). A bare `<name>` means one of your own repositories. Every argument naming an identity — `dg repo list --owner`, `dg collab add`/`remove`, `dg issue --author`/`--assignee`, `dg pr request-review`, `dg ci runner add`/`revoke` — accepts either form; a name is resolved once per process and cached.

Reading a public repository needs no identity: `dg repo view`, `dg repo list --owner`, `dg issue list` / `view`, `dg pr list` / `view` / `diff` / `checkout` / `checks` / `commits`, `dg label list`, `dg collab list`, `dg release list` / `download`, `dg repo protect list` and `dg repo policy show` work signed out, and never open a key you have configured, so a passphrase-sealed key file is not unlocked just to read. A private repository's content is encrypted to its members, so reading one uses your identity, and without one it stops with [`E301`](../errors.md#e301).

---

## Collaborators

There are four roles. Consensus enforces what each role can write: a write the role does not allow is refused by Platform, and Forge's apps refuse it before you pay for it. Counting approvals and offering readers only on private repositories are rules Forge apps enforce: every app applies them alike ([Who enforces what](#who-enforces-what)).

| Role | `--role` | Can | Closest GitHub role |
|---|---|---|---|
| Reader | `reader` (alias `read`); **private repositories only** | Read the repository (it receives the key). Otherwise what anyone can do: open issues and PRs, comment and review, and as an author close or reopen their own issues and PRs, mark their own PRs draft or ready, request reviews on them and resolve their threads. | Read |
| Triage | `triage` | Close, reopen and lock any issue or PR; label, assign, set milestones, request reviews and resolve review threads; create labels and milestones. **Not**: push, merge, mark a PR draft or ready, change a PR's base, dismiss reviews, pin, post check runs, or re-run checks. | Triage |
| Writer | `writer` (default) | Everything triage can, plus push to unprotected branches, merge, mark draft or ready, change a PR's base, dismiss reviews, pin, post check runs, and re-run checks. | Write |
| Maintainer | `maintainer` | Everything a writer can, plus protected branches, releases, repository settings (`config`, branch policy), webhooks and hiding comments. | Maintain, and most of Admin |

The repository owner alone adds and removes members, and edits the description and topics (GitHub's Admin). `--role write` and `--role maintain` are accepted as aliases.

Anyone, member or not, can open issues and PRs, comment and review. Approvals count toward a branch policy only from maintainers and writers: a triage member's or reader's approval is shown as **not counted**, and their request for changes does not block. Imported issues and comments (a mirror's provenance and upstream numbers) are trusted from the same people.

A public repository has no readers: everyone can read it already. A member holds one writer document, so changing between writer, triage and reader replaces it: `dg collab add` with the new `--role` deletes the old document and writes the new one (their acceptance stands, so they need not accept again), and the web app's Settings → Members has **Change role** on public repositories. On a private repository `dg collab add` changes the role the same way without rotating the key, since the member stays a member; in the web app, remove the member and add them again, which rotates it as every removal does.

Adding a collaborator is two steps: the owner adds them, and the collaborator accepts. Consensus admits a `writer`/`maintainer` document only when it names the member's own `consent` document for the repo (`member_consent`), so nobody can be made a member, or spammed with an invitation, without agreeing first.

```sh
dg collab accept <owner>/<repo>              # the collaborator, first: records their consent
dg collab list   <owner>/<repo>
dg collab add    <owner>/<repo> <identity id or DPNS name> --role writer   # or triage, reader, maintainer
dg collab remove <owner>/<repo> <identity id or DPNS name> --role writer
```

`dg collab list` shows each member's role. `dg collab remove --role writer` (or `triage`, `reader`) removes the member's writer document, whichever of the three it grants.

If the owner runs `dg collab add` before the invitee has accepted, it is refused before anything is signed: *"`<identity>` has not accepted membership of `<repo>` yet"*, with the fix to ask them to run `dg collab accept`, then add them again. `dg collab add <owner>/<repo> <identity id> --wait 300` instead waits (printing that it is waiting) up to that many seconds for the acceptance to land, then adds them; with no `--wait` it checks once. `dg collab accept --withdraw` withdraws an earlier acceptance (a membership already granted stands until the owner removes it).

From the web app, the invitee opens the repository's **invite link** (Settings → Members, on public and private repos alike) and clicks **Accept invitation**; the owner's Settings → Members lists **Pending invitations** (accepted, not added yet) with a role picker (writer, triage, maintainer, and on a private repository reader) and an **Add** button for each, and shows who is still waiting to accept after a refused add.

Adding or removing a collaborator is a write by the repository owner, signed with the owner's HIGH key.

### Repository settings

Maintainers change a repository's settings from the CLI or from **Settings** in the web app. Each change is a small paid write, shown with its cost before you confirm; repeating a change that already holds writes nothing.

```sh
dg repo protect add    <owner>/<repo> main              # or a glob: 'release/*', 'refs/tags/v*'
dg repo protect defaults <owner>/<repo>                  # the default branch and every tag
dg repo protect remove <owner>/<repo> main
dg repo protect list   <owner>/<repo>
dg repo edit <owner>/<repo> --default-branch trunk       # maintainers
dg repo edit <owner>/<repo> --description "…" --topics rust,cli   # the owner
dg repo edit <owner>/<repo> --moved-to <owner>/<new-repo>          # maintainers; "" clears it
dg repo policy set  <owner>/<repo> --required-approvals 2 --maintainers-only true --merge-methods ff,squash
dg repo policy show <owner>/<repo>
dg repo archive   <owner>/<repo>
dg repo unarchive <owner>/<repo>
```

What each one enforces:

- **Protected branches** are enforced by Platform. A ref matching a pattern moves only through a maintainer-only document; a writer's push is refused ([`E601`](../errors.md#e601)), and a plain update of a protected ref is ignored by every reader. A bare name means `refs/heads/<name>`; `*` stays within one path segment and `**` crosses segments. `refs/tags/**` covers every tag. Up to 8 patterns. A new repository protects its default branch and every tag (`refs/tags/**`) unless its creator opts out (`dg repo create --no-protect`, or the checkbox on the web's **New repository** form), so a release tag cannot be moved by a writer. Forks and mirrors start unprotected. For an older repository, **Settings → Branches** offers the same protection in one click, and `dg repo protect defaults` adds it from the CLI.
- **The default branch** is what a clone checks out and what the web opens on.
- **The branch policy** is enforced by Forge apps. The web disables the merge until it is met, and `dg pr merge` refuses it ([`E804`](../errors.md#e804)). The PR author's own approval never counts. When the policy requires approvals, a request for changes from a maintainer or writer whose approval would count blocks the merge, as on GitHub, until they approve or the review is dismissed. A maintainer can bypass it, as on GitHub: tick "bypass rules" in the merge box and confirm, or pass `dg pr merge --override-policy`. The code is really merged, and an event on the PR records which rules were bypassed. Unlike a comment, the event cannot be edited or deleted, by the maintainer who bypassed or anyone else. Nothing on Platform requires approvals.
- **Mark as merged (done elsewhere)** records a merge that already happened some other way (a push). It moves no code, so the web offers it only once the PR's head is on the base branch (`dg pr merge --event-only`).
- **Moving** a public repository marks it with the repository that replaces it. Its pages then show "This repository moved to …" with a link, `dg` commands on it print a one-line note, and `git clone` or `git fetch` prints a hint with the `git remote set-url` to run. Nothing is redirected: the old repository stays readable and writable, so archive it as well if work should stop there. A private repository cannot be marked.
- **Archiving** is enforced by Forge apps too. They refuse writes to an archived repository: the web disables issues, PRs, merges and releases; `dg` refuses issue, PR, comment, review, merge and release writes; and the push helper refuses pushes. All of these use [`E606`](../errors.md#e606). Override with `dg --allow-archived …` or `git push -o allow-archived`. Platform still accepts a member's writes.

### Who enforces what

The web app labels each rule with who enforces it:

- **Enforced by Dash Platform.** Platform refuses a write that breaks the rule, whichever app sends it. Member roles, protected branches, and a limited key's budget and expiry work this way.
- **Forge apps enforce this.** The web app, `dg` and the push helper apply the rule and won't send a write that breaks it. Platform doesn't check it, so a write made outside Forge's apps can ignore it. The branch policy and archiving work this way. A maintainer's override of the branch policy is recorded on the PR, where everyone can see it.

The description and topics live on the repository document, which only its owner can edit. They are public even for a private repository. A private repository's other settings are encrypted: the CLI writes them sealed, and the web app does not write them yet.

**Topics.** Up to 20 per repository, each 1–30 characters of lowercase letters, digits and single hyphens (`^[a-z0-9]+(-[a-z0-9]+)*$`, the same pattern GitHub topics use). `--topics` replaces the whole list; deletes and creates happen together, so a topic removed from the list stops counting toward Explore's per-topic browsing at once. A private repository's topics stay set on its repo document (still visible, since topics are public even for a private repo), but Forge writes no per-topic index document for a private repo, so its topics don't show up when someone browses Explore by topic.

### How access works

A collaborator is a `writer` or `maintainer` document in Forge's shared forge-core contract, keyed by (repository, member). A `writer` document carries the role (writer, triage or reader), and every role-gated write claims a role that consensus checks against it. Only the repository owner can create one, and consensus enforces that. Every write-path document type (ref updates, packs, releases, config, events) names its gate, and consensus refuses a write whose author has no current membership document ([`E601`](../errors.md#e601), Platform code 40120).

- **Add** creates the membership document, naming the member's `consent`. **Remove** deletes it. The member's next write is refused.
- **Consent stands on its own.** A `consent` document is not deleted when the owner removes the member, so adding them again later needs no new acceptance.
- **There is no suspend.** Remove the member, and add them again later.
- **Past work stays valid.** A document's existence proves its writer was a member at the time it was written. Removing a maintainer later does not undo their past merges or ref updates.
- The owner is enrolled as a maintainer when the repository is created.

[forge-v2.md](../contracts/forge-v2.md) §2 lists which role each document type needs, and §2.1 how roles are proved.

### Organizations

Forge has no organization accounts, and membership is never delegated: only a repository's owner can add or remove its members. A team that wants one shared owner uses an **organization identity**:

1. Create an identity for the organization (`dg auth new`, or the web app's sign-up) and keep its identity file or recovery phrase offline. It owns the organization's repositories (`dg repo create`), so their URLs are `<org>/<repo>`; register a DPNS name for it.
2. Add each admin's **personal** identity as a maintainer of each repository (`dg collab add <org>/<repo> <admin> --role maintainer`). Pushes, merges, reviews and releases stay signed by the person who made them.
3. Give each admin a **limited key of the organization identity** for the owner-only writes: adding and removing members, the description and topics. The key can do everything the organization can on Forge (it is the owner and a maintainer of every organization repository: protected pushes, settings, policy, webhooks, new repositories), but never spend more than its budget, never outlive its expiry, and never touch another contract. The organization's master key registers it:

   ```sh
   # as the organization (its identity file); one key per admin
   dg auth export --new-key --budget 0.5 --expires 90d --format dfk1 --reveal-secrets -o alice-admin.dfk1
   ```

   Hand the file to the admin over a private channel; they use it as `DASH_FORGE_KEY` (or `dg --identity`) for the organization's commands. `dg auth keys list` (as the organization) shows every admin's key, and `dg auth keys disable <id>`, run with the organization's identity file, revokes one at once.

What this does not give you: the key does not say which admin used it (Platform records the organization as the writer of membership changes), and a limited key holds no encryption key, so on a **private** repository adding a member (which wraps the key to them) and removing one (which rotates it) is done by whoever keeps the organization's identity file, on that machine. Don't copy the identity file to admins' machines: that gives them the master key, which the limited keys exist to avoid.

---

## Private repositories

A private repository's content is encrypted on your machine before it leaves it, to a key only its members hold. Platform nodes, storage providers and anyone else see ciphertext. The design is [docs/security/private-repos.md](../security/private-repos.md).

```sh
dg auth keys add --encryption                   # once per identity (see Identity and keys)
dg repo create secret --private                 # or `dg init --private`
git push dash://<you>/secret main               # packs are sealed, ref names encrypted
dg collab add    <you>/secret <identity id>     # membership + the key, wrapped to them
dg collab add    <you>/secret <identity id> --role reader   # read-only: the key, and no member writes
dg collab remove <you>/secret <identity id>     # delete + key rotation
dg repo keys status <you>/secret                # epochs, who holds a key, pending repairs
```

**What is hidden and what is not.** The encryption covers the content. What the network needs to enforce access stays visible:

| Encrypted (members only) | Visible to everyone |
|---|---|
| Code: every pack, index and browse artifact | That the repository exists; its name, owner, description, display name and topics |
| Branch and tag names | Members and their roles (writer, triage or reader included); when each joined; key epochs and who rotated them |
| Default branch and protected-branch patterns | When pushes, issues, PRs, comments and reviews happen, and who wrote each |
| Issue and PR titles and bodies, comment and review text, an inline comment's file path; the labels and milestones set on them, and a dismissal's reason | Commit ids (`newOid`, PR heads): anyone who already knows a commit id can confirm the repo contains it |
| A release's tag, name, notes, draft, pre-release, yanked and unpublished flags, and its asset list; each asset file | That a release revision was written, when and by whom; revisions of one tag within a key epoch share a keyed tag name; each asset file's size |
| | Sizes: pack sizes, object counts, the approximate length of every encrypted field |
| | That a label was added, a milestone set or a review dismissed (the kind of each event), and when; who is assigned (the assignee identity is indexed for "assigned to me") |
| | **Not encrypted in this release:** label definitions (`dg label create`: name, colour, description); check runs; webhook URLs |

Leave the description empty if the project's purpose is itself sensitive.

**Every member needs an encryption key.** Private repositories wrap the key to each member's identity `ENCRYPTION` key. `dg collab add` checks the member has one and stops before writing anything if not ([`E306`](../errors.md#e306)); they add one with `dg auth keys add --encryption`, or Settings → Keys → **Enable private repos** in the web app.

**Readers.** A reader (`--role reader`) holds the key like any member and can read everything, and can write only what anyone can (issues, PRs, comments and reviews, all sealed). Their approvals do not count. Like any member, a reader could copy what they read.

**Removing a member rotates the key.** New pushes, issues and comments will be unreadable to the removed member. Everything they could already read stays readable to them: encryption can't take back what was shared. The rotation is one key wrap per remaining member plus one anchor document, so `dg collab remove` shows the cost first. You are wrapped first, so an interruption never locks you out; running `dg repo keys repair` finishes an interrupted rotation (the key is recovered from your own wrap on chain, never from a local file).

**Repairs.** A maintainer's `dg` and `git push` check the key on every visit: if a non-member still holds the current key (two maintainers removed members at the same time), or a member has no wrap to their current encryption key (they replaced it, or an add was interrupted), `dg repo keys repair` fixes it. The key is re-read before every write, so nothing is ever written under a key that was rotated away.

**Cloning.** `git clone dash://<owner>/<repo>` works as for a public repository when your key source holds your encryption key: what `dg auth login` and `dg auth new` store (the limited key with your encryption key beside it), or the identity file (`DASH_FORGE_KEY`); not a key stored with `--signing-only` or by an older `dg` ([identity and keys](identity-and-keys.md#encryption-key-private-repositories)). A non-member gets [`E307`](../errors.md#e307); an identity without an encryption key gets [`E306`](../errors.md#e306).

**No recovery.** If every member loses their encryption key (every copy of every identity file and mnemonic), the contents cannot be decrypted by anyone.

Not supported for private repositories yet ([`E207`](../errors.md#e207)): forks (`dg repo fork`) and webhooks. Issues, PRs, comments and reviews are sealed; label definitions (`dg label create`) are allowed but stay public.

**Releases** of a private repository are sealed ([private repositories §16](../security/private-repos.md#16-sealed-releases)). The web app publishes, edits, yanks and unpublishes them (a maintainer's **Edit** on each release), and members download their files verified in the browser; `dg release create`, `dg release unpublish` and `dg release download` do the same from the command line. Each file you publish is encrypted in the tab before it goes to your own storage (an imported asset that could not be fetched and sealed stays an external link: its URL is hidden, but the file is not encrypted), named by the hash of the encrypted copy, and the asset list is an encrypted file too. A private release holds 1507 bytes of tag, name, notes preview and provenance: longer notes continue in the encrypted asset list, so they need storage of your own even without files. Draft and pre-release are labels every member sees, not access control. Every change is a new revision that carries the rest forward; two maintainers editing the same release at once both land, and the one written second is warned that it may have dropped the other's change.

**Content a removed member wrote late.** A member removed from the repository who keeps writing under the old key, more than 240 blocks after the rotation, is hidden from every reader (the late-content rule). A clone that needs such a pack stops with [`E510`](../errors.md#e510) (`clone incomplete: N packs hidden by the late-content rule`).

---

## Issues

Anyone with an identity and some credits can file an issue. Fees are the spam floor.

```sh
dg issue list   <owner>/<repo> [--state open|closed|all] [--label bug]... [--author me|<id|name>]
                [--assignee me|<id|name>|none] [--search "crash #12"] [--limit 30] [--page 2]
                [--include-hidden]
dg issue view   <owner>/<repo> 12
dg issue create <owner>/<repo> --title "Crash on empty input" --body "Steps: …"
dg issue edit   <owner>/<repo> 12 --title "Crash on empty config" [--body … | --body-file notes.md]
dg issue edit   <owner>/<repo> 12 --add-label bug,docs --remove-label triage \
                --add-assignee @me --remove-assignee alice --milestone v1   # or --remove-milestone
dg issue comment <owner>/<repo> 12 --body "Fixed in 8f3e2a1"
dg issue edit-comment <owner>/<repo> <comment id> --body "Fixed in 8f3e2a1 (and 91c0d4e)"
dg issue delete-comment <owner>/<repo> <comment id>
dg issue close  <owner>/<repo> 12
dg issue reopen <owner>/<repo> 12
dg issue label  <owner>/<repo> 12 add bug docs     # or: remove bug (the older --add/--remove still work)
dg issue assign <owner>/<repo> 12 me alice         # or: unassign; ids or DPNS names
dg issue status <owner>/<repo>                     # assigned to you, mentioning you, opened by you
```

`dg issue edit` takes gh's flags: every change is confirmed once and written as one event each, and labels, assignees and milestone can go with a title or body change in the same run. A label must be one the repository defines and a milestone an open one; both are checked, with your role, before anything is signed.

A label the issue already has, or an assignee already assigned, is left alone: `dg` says so and writes (and charges) nothing for it, so the timeline never shows the same change twice. Removing one the issue does not have is skipped the same way.

**Who can change state.** The issue's author can close and reopen it (an `authorEvent`). Maintainers, writers and triage members can close, reopen, label and assign any issue (an `event`). `dg` picks the right one for you. Consensus refuses both from anyone else, and `dg` says so before anything is signed ([`E601`](../errors.md#e601)).

**Edits.** Only the author can edit an issue's title or body, or a comment's body (`dg issue edit-comment` takes the comment's id from `dg issue view --json` or `dg pr view --comments --json`, and works for PR comments too): an edit replaces their document, so consensus admits it from them alone, members included. The earlier text stays readable on Platform to anyone who could read it, and the web shows "edited". Re-running an edit that already landed writes nothing. In a private repository the whole text is re-sealed (a PR's under the key epoch it was opened with, the others under the current one) and nothing is written in plaintext. An edit made against text someone else replaced in the meantime is refused before signing ([`E607`](../errors.md#e607)).

**Long text.** A body, comment or set of release notes holds 5,120 bytes on Platform (less in a private repository, where the title and other sealed text share the space). A maintainer or writer can post a longer one, up to 256 KiB: `dg` and the web store the full text as a repository artifact and the field keeps its first part and a hidden line naming it ([forge-v2.md §6.3](../contracts/forge-v2.md#63-long-bodies-a-text-longer-than-its-field-client-convention-p1-9)). Readers show the whole text; if the artifact cannot be read they show the first part and say the rest is missing. `dg` stores it on the repository's storage policy (`dash.storage`), else on Platform, and the confirmation says where and adds its cost (about 0.010 DASH for 20 KB on Platform; only one small manifest on your own storage). Triage members, readers and non-members cannot record artifacts, so their text stays within 5,120 bytes: split it into comments. Where it works: issue and PR descriptions, comments and release notes in `dg` (`dg pr comment` too, inline ones included) and on the web, where the composer says the text is stored whole and adds its cost (always on Platform); a review's summary on the web. Not yet: `dg pr review` drafts and the web's inline review comments, and a private repository's release notes on the web (use `dg release create`, which stores them on the repository's own storage).

**Assignees** are events naming the identity twice: as the value the state fold reads, and as the event's `refId`, so "assigned to me" is one indexed query (Explore and `--assignee me`).

**Listing.** `dg issue list` reads every issue and the repository's event feed once, then filters, so a filter sees the whole repository rather than the newest page. The web issue list has the same filters, keeps them in the URL, and pages 50 at a time.

**Numbers.** Issues and PRs share one dense number sequence: consensus requires a new issue or PR's number to equal the exact count of the repository's issues and PRs, counted with the new one (the `dense` rule), so a repository's first issue and first PR are never both #1 — whichever is opened second gets #2, and nobody can squat a high number to jump the line. If two people race for the same number at once, the second create is refused (consensus code 10422, rule "dense"), and `dg` retries with the next free number. An interrupted `dg issue create` resumes when run again rather than opening a second issue.

A mirrored item's own number still follows this repo's dense sequence; mirroring never skips ahead to match the source. What a mirror (`forge-import`) can carry instead is the source's number in a separate `upstreamNumber` field, trusted only when it was written by the repo's owner or a current maintainer or writer. The web app shows it beside the local number, "#12 · upstream #7761", and a bare `#7761` in an imported body resolves to whichever local item recorded that upstream number ([Mirror a GitHub repo](mirror-a-github-repo.md) has the details). `dg` does not read `upstreamNumber` back today; the display is web-only.

**No deletes.** Issues, PRs and their state events cannot be deleted, so nobody can rewrite a thread's history. Comments can be deleted by their author: the comment's **Delete** on the web, or `dg issue delete-comment` (for PR comments too). Consensus lets nobody else delete it, maintainers included, so a comment posted by mistake is for its author to remove. Replies to it stay, and read as replies to a deleted comment. A delete removes the comment from Platform state, but the write that posted it stays in the chain's block history: treat a secret posted in a comment as leaked and rotate it.

**Locking.** A maintainer, writer or triage member locks a conversation to stop non-members from posting to it:

```sh
dg issue lock   <owner>/<repo> 12          # or: dg pr lock <owner>/<repo> 7
dg issue lock   <owner>/<repo> 12 --off    # unlock
```

Locking and unlocking are transitions maintainers, writers and triage members write, folded the same way for issues and PRs. `dg issue view --json` shows the fold as `"locked": true|false`; `dg pr view` does not print it today. On the web, an issue's sidebar shows "Locked to members" or "Open to everyone" and has a **Lock** / **Unlock** button for maintainers, writers and triage members; a PR enforces the same lock (a non-member sees the compose box disabled, "This conversation is locked: only the repo's members can comment") but shows no status label and no button yet — it locks and unlocks from `dg pr lock` only. Once locked, a non-member's comment or review is refused at the CLI before anything is signed (*"comment not posted: issue #12 is locked to members"*); a member's still goes through. Locking does not require re-running a close or reopen — it is independent of the issue or PR's open/closed state.

### Issue and PR templates

The web app reads templates from the repository's **default branch** when you open an issue or a PR, as GitHub and GitLab do. They are files in the repository, so a mirrored or imported repository brings its own.

**Issue templates** come from the first of `.forge/ISSUE_TEMPLATE/`, `.github/ISSUE_TEMPLATE/` and `.gitlab/issue_templates/` that holds any. **Open an issue** offers them as buttons above the title:

- **Markdown templates** (`*.md`) work as on GitHub: optional front matter (`name`, `about`, `title`, `labels`) followed by the body. GitLab's plain Markdown files are named after the file.
- **YAML issue forms** (`*.yml`) use GitHub's schema: `markdown`, `input`, `textarea` (with `render`), `dropdown` (with `multiple` and `default`) and `checkboxes`. Required fields block **Submit** until they are answered. The issue body is the one GitHub writes: each field's label as a `###` heading, then the answer (`_No response_` when empty). A file that is not a valid form is not offered.
- **`config.yml`** works as on GitHub. `blank_issues_enabled: false` removes **Blank issue**, so a template must be picked, unless no template is usable. `contact_links` (`https` links only) are listed under the templates.
- **Labels** a template names are applied with the issue when you are a maintainer, writer or triage member. Only labels the repository defines are applied, as on GitHub. Each label is one more document, included in the cost shown. Anyone else sees the suggested labels for a member to apply. A form's `assignees` are not applied.

**PR templates.** **Open a pull request** fills an empty description with the default template. That is the first `pull_request_template.md` (any case) found in `.forge/`, `.github/`, the root or `docs/`; failing that, GitLab's `.gitlab/merge_request_templates/Default.md`. The `*.md` files of a `PULL_REQUEST_TEMPLATE/` folder and GitLab's other merge request templates are offered as buttons. A link can name one, as on GitHub: `…/repo/pulls/new?owner=…&name=…&template=bug.md`. A description you already typed, or one kept from an earlier visit, is never replaced. Picking another template swaps the text only while you have not edited it.

`dg issue create` and `dg pr create` take `--body` as given; they do not read templates.

### Moderation: lock and hide

A repository's maintainers moderate its conversations with two tools. Neither deletes anything: on Dash Platform nobody but a comment's author can delete it, and the network's own moderation applies to every repository at once, so it cannot be scoped to yours.

| | Lock | Hide |
|---|---|---|
| Who | maintainers, writers and triage members | **maintainers** only |
| What it does | from then on only members can comment or review | readers see a comment, a review or a whole issue or PR collapsed, and can expand it |
| Enforced by | Dash Platform (it refuses a non-member's post) | Forge apps; Dash Platform checks that the hider is a maintainer |
| Use it for | a thread under attack, or a finished discussion | spam, abuse, off-topic or outdated posts that are already there |

```sh
dg issue hide <owner>/<repo> 12 --comment <comment id> --reason spam   # hide one comment
dg issue hide <owner>/<repo> 12 --reason off-topic                       # hide the whole issue
dg issue hide <owner>/<repo> 12 --comment <comment id> --off             # unhide
dg pr hide    <owner>/<repo> 7 --review <review id> --reason outdated    # or --comment <id>
dg issue view <owner>/<repo> 12 --show-hidden                            # read what was hidden
```

Reasons are GitHub's: `spam`, `abuse`, `off-topic`, `outdated`, `resolved`, `duplicate`, or none. The ids come from `dg issue view --json` and `dg pr view --comments --json`. `dg` refuses a hide from someone who is not a maintainer before anything is signed.

**What readers see.** On the web a hidden comment or review is one line, "A comment by bob was hidden by alice as spam · Show", in the timeline and in Files changed. A hidden issue or PR keeps its number; the web's Issues and Pull requests lists leave it out behind "N on this page hidden by maintainers · Show" (the Open and Closed counts do not change), and its page opens behind a banner with "Show it anyway". `dg issue list` and `dg pr list` leave it out the same way, after paging (a page may show fewer rows than `--limit`), and say "(2 hidden by maintainers on this page; --include-hidden shows them)"; `--include-hidden` lists it with "[hidden by alice as spam]" at the end of its row, and `--json` gives each row a `hiddenBy` field (`null`, or `by`, `reason`, `at`, `eventId`) and the page's `hiddenOmitted` count. In `--json`, `count` is the rows shown and `count + hiddenOmitted` the page's size, so use `truncated`, not `count < --limit`, to tell the last page (the top-level `hidden` still counts malformed documents). The flag is meant for maintainers checking what was hidden, but anyone can use it: the hides are public. `dg issue view` and `dg pr view` print the same one line unless you pass `--show-hidden`. Notifications leave out a hidden issue or PR, and a hidden comment or review, once the inbox has read the hide (within a few minutes). The timeline records every hide and unhide that counts ("alice hid a comment by bob · spam"): they cannot be edited or deleted, so they are the record of who hid what.

**Who wins.** Any maintainer can hide or unhide. If the repository's owner hid or unhid something, the owner's latest decision stands whatever a maintainer does later, and only the owner can hide what the owner wrote; `dg` and the web refuse such a write before signing rather than spend credits on it. An inline comment hidden with its review shows again when the review is unhidden. A hide stays after its maintainer is removed (the network proved them a maintainer when they wrote it); unhide it to undo it.

**A hidden review still counts.** Hiding is display only: an approval or a request for changes still counts toward the merge until a member dismisses it (`dg pr dismiss-review`, or **Dismiss** on the Reviewers card). Hiding an issue or PR does not close it either; the web's **Hide issue…** offers "Also close and lock it", which writes the close and the lock after the hide.

**Limits.** A hidden post is still on Platform: anyone can read it with **Show**, `--show-hidden`, `--include-hidden`, or any client that predates hiding. In a private repository the reason is encrypted like other event values; which item was hidden is not. Each hide is one event: a whole thread costs about as much as a label, and hiding one comment or review costs about 0.0002 DASH more, because the event also names it. To stop a flood, lock the thread first, then hide what was already posted.

---

### Searching, and what concerns you

`dg issue status` and `dg pr status` are gh's summaries for one repository:
- **Issues:** the open ones assigned to you, those that mention you (`@yourname` or your identity id in the body, the web's mention rule), and those you opened.
- **PRs:** the PR from the branch checked out here, your open PRs, and the open PRs that request your review. Each shows whether it is a draft, approved, has changes requested, or still needs review.

Inside a clone, leave out the repository: `dg pr status`.

`dg search issues` and `dg search prs` take the web search box's qualifiers. The grammar is shared with the web and pinned by the `search_*` conformance vectors:

```sh
dg search issues <owner>/<repo> is:open label:bug -label:wontfix author:@me "exact phrase"
dg search issues <owner>/<repo> no:assignee milestone:"v1.0" in:title crash reason:"not planned"
dg search prs    <owner>/<repo> is:merged review-requested:@me draft:false
dg search repos  forge                       # name prefix; or topic:rust, owner:alice (--topic, --owner)
```

**How a search reads:**
- It looks in one repository. Platform has no text index, so it reads the repository's items (every issue; the newest 100 PRs) with their state and filters them.
- Every state is searched unless the query names one, as `gh search` does.
- `is:closed` on PRs means closed without merging (the web's Closed tab); `is:merged` and `is:unmerged` pick the rest.
- `author:` and `assignee:` take a DPNS name, an identity id or `@me`.
- A qualifier dg cannot apply is named on stderr ("not applied: …") and in `--json`'s `notApplied`, never searched for as text: `comments:` and `sort:comments-desc` need a count read per item.

`dg search repos` finds repositories:
- by name prefix (the `repo.name` index);
- by topic (public repositories only);
- by owner; with an owner or a topic, the remaining words must appear in the name or description.

**Raw queries.** `dg api query <core|collab|community|dpns|contract id> <type> '[["field","==",value]]' [--order '[["field","asc"]]'] [--limit N] [--start-after ID] [--all] [--count]` runs one document query, proof-checked like every other read, and prints the documents as JSON:
- Identifiers are base58 and byte arrays hex.
- The clauses must fit one of the type's indexes, as Drive requires.
- `--count` needs a countable index.

## Pull requests

A pull request is a `patch` document in the **base** repository. It points at the commit you want merged and at the repository that holds that commit (`sourceRepoId`): the base itself, or a fork. The code itself lives in that repository, not in the PR.

### Pushing branches

`git push` to `dash://` works as it does with any git server, with three differences worth knowing:

- **Rewriting a branch.** After a rebase or an amend, push with `git push --force-with-lease`. It overwrites the branch only if it still points where you last fetched it when the push starts, so you don't drop commits someone pushed since. If the branch has moved, the push is rejected as `stale info`: fetch, look, then push again. If someone else's push lands while yours is being written, neither replaces the other: git reports yours as rejected and the branch shows both until one of you pushes again. `git push --force` overwrites without that check.
- **No atomic pushes.** Each branch and tag is a separate Platform write, so `git push --atomic` is refused: some refs could land while another fails. Push without it. git reports each ref, and you can push a failed one again.
- **Names git cannot hold side by side.** A new branch or tag is refused when a ref already uses its name as a folder or as a file (`feature` and `feature/x`), or differs from it only in letter case (`Fix` and `fix`, which are the same file on macOS and Windows). The web's **New branch** refuses the same names.

### The flow

**1. Have a repository you can push to.** If you are a writer on the base repository, push a branch to it directly and skip to step 3. Otherwise, fork it:

```sh
dg repo fork <owner>/project            # or --name <another name>; --default-branch-only
```

```text
✓ forked <owner>/project → <you>/project
  packs:   36 recorded (36 by reference to the parent's Platform chunks), nothing re-uploaded
  refs:    1 copied
  remote:  dash://<you>/project
  cost:    ~0.03 DASH
  next:    push a branch to dash://<you>/project, then `dg pr create <owner>/project`
```

A fork is a new repository with `forkOf` set to the parent. It records the parent's packs **by reference**, so nothing is uploaded again. Packs on external storage keep their URLs, and packs on Platform are read from the parent's chunks, which are permanent. The fork's cost is its own documents: the repo, one small manifest per pack, and the refs. It copies the parent's branches and tags; `--default-branch-only` copies the default branch alone (GitHub's "Copy the main branch only", also a checkbox in the web's fork dialog), one ref update instead of one per branch and tag. Re-running an interrupted fork finishes it without paying twice. It never moves a branch you have already pushed to the fork. In the web, the fork browses through the parent's published browse and history index, so no visitor rebuilds it in the browser; your own pushes to the fork index just the packs they add.

**Keeping a fork up to date.** When the parent moves on, sync the fork, as GitHub's **Sync fork** does:

```sh
dg repo sync <you>/project              # the default branch; --branch <name> for another
```

```text
Sync <you>/project:main with <owner>/project:main: fast-forward 8f3e2a1c9d0b → 41c07b5e2a9f (3 commit(s))
  2 pack manifest(s) by reference, nothing re-uploaded, + 1 ref update   ~0.0027 DASH
✓ synced <you>/project:main with <owner>/project:main: now at 41c07b5e2a9f (3 new commit(s))
```

The fork's default branch follows the parent's default branch; another branch (`--branch`) follows the parent's branch of the same name. A sync only fast-forwards: it records the parent's new packs by reference (nothing is uploaded) and moves the branch with one ref update. When your branch already has the parent's commits and some of its own, there is nothing to sync. When both moved, nothing is written and `dg` stops with [E105](../errors.md#e105), naming the pull request that merges the parent's branch into your fork (`dg pr create <you>/project --base main --head main --head-repo <owner>/project --title "Merge <owner>/project:main"`), or `git pull` and a push. Your own commits are never dropped. Syncing is for the fork's maintainers and writers; a protected branch, for its maintainers. `dg` compares the histories in the current repository when it already holds both tips, else it fetches the parent's branch (and yours, when it is not in the parent's history) into a scratch repository first.

In the web, a fork's **Code** tab says whether its default branch is up to date with the parent's. **Sync fork** (maintainers and writers; **Compare** for everyone else) compares the histories in the browser, then offers **Update branch** for a fast-forward, or the pull request into the fork when both sides moved.

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
✓ opened PR #7 in <owner>/project · ~0.0014 DASH
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
dg pr status   <owner>/project            # your current branch's PR, yours, and those awaiting your review
dg pr list     <owner>/project [--state open|closed|all] [--include-hidden]
dg pr view     <owner>/project 7          # state, reviewers, approvals, reviews
dg pr view     <owner>/project 7 --comments   # + threads under their file and line
dg pr diff     <owner>/project 7          # fetches head and base, then git diff base...head
dg pr commits  <owner>/project 7          # the commits the PR adds
dg pr checks   <owner>/project 7          # check runs reported on the head
dg pr checkout <owner>/project 7          # branch pr/7 at the PR head, switched to if the tree is clean
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

**Drafts and edits.** `dg pr create --draft` opens a draft. `dg pr ready` and `dg pr draft` switch between the two. The author can change the title and description with `dg pr edit <owner>/project 7 --title … --body …`. Maintainers, writers and triage members change a PR's labels, assignees and milestone with the same flags as `dg issue edit` (`--add-label`, `--remove-label`, `--add-assignee`, `--remove-assignee`, `--milestone`, `--remove-milestone`), confirmed once.

**Changing the base (retarget).** `dg pr edit <owner>/project 7 --base release/1.x` moves an open PR to another branch of the repository, as GitHub's "Edit" does: one event (kind 8, about 0.0007 DASH) that maintainers and writers may write (triage members may not; consensus refuses theirs). The new base must be a branch now, and is refused before signing when it is not, when it is the PR's own source branch, or when the PR is closed or merged. From then on the PR merges into the new base: its diff, `dg pr merge`, `dg pr update-branch` and the web's merge box all use it, and a merge counts when it lands there (the base had to be a branch when the PR was retargeted to it). `dg pr view` shows "retargeted from …", and `--json` keeps `baseRef` (the base it was opened against) beside `baseRefName` (the one it merges into now) and `retargetedTo`. The timeline shows who retargeted it and when; a PR merged into its base stays merged there, whatever is written later.

A review records the commit it was made on, which is the PR's head at the time. **Which approvals count:**

- Only reviews from current writers and maintainers count.
- Only reviews on the PR's **current** head count. When the head moves, older reviews go stale: `dg pr view` marks them, and tells a reviewer "new commits since your review".
- A reviewer's newest approve or request-changes review is the one that stands.

Anyone can post a review. A non-member's approve or request-changes is written, shown on the PR, and labelled "approved (not a member)" or "changes requested (not a member)" — it never counts toward the branch policy's required approvals, and `dg` says so.

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
2. Fast-forward if it can. Otherwise build a merge commit, authored with your git `user.name` and `user.email`, with the message `Merge pull request #7 from <branch>` and the PR title (`--message` sets your own; `--no-ff` writes a merge commit even where the base could fast-forward). `--squash` instead makes one commit on the base with the PR's changes, authored by the PR's author (the author of its oldest commit) and committed by you, with a `Co-authored-by` line for each other author (`--message` sets its message). `--rebase` instead replays the PR's commits on the base with `git rebase`: each keeps its author and message and you commit it, a commit whose change the base already has is skipped, and a head already on the base tip is fast-forwarded unchanged. A commit that does not apply cleanly stops it, naming the commit and files.
3. Push the result to the base branch. The push uses your `dash.storage` settings when you run `dg pr merge` inside a clone of the repository.
4. Post the `merge` event naming the commit that landed.
5. Close the open issues the description closes (`Fixes #12`, `closes #3`, `resolves #7`; at most 10), as GitHub and the web's merge box do. `--keep-linked-open` leaves them open, and each close is quoted with the merge. On a public repository each close names the pull request, and the issue reads "closed this as completed in #7" once readers confirm that the pull request was merged before the close and its description closes the issue. A close that names a pull request that fails that check reads as a plain close.

Each step is reported. If one fails, the output says what already happened. If the push landed but the event did not, `dg pr merge --event-only` records the event. `--delete-branch` deletes the PR's branch afterwards. This needs write access to the repository it lives in. Before merging, it checks the repository's newest 100 pull requests: when another open PR is based on that branch (a stack) or uses it as its head, the merge is refused with [`E808`](../errors.md#e808), naming them. When there are older pull requests, or some can't be read, the output says they were not checked (`branchCheckNote` in `--json`). Retarget them first (`dg pr edit <repo> <n> --base <branch>`), merge without `--delete-branch`, or pass `--force-delete-branch` to delete it anyway.

- **Conflicts:** nothing is pushed ([`E105`](../errors.md#e105)). Check the PR out, merge the base into it, resolve, push the result to the PR's branch (the PR follows it), and run `dg pr merge` again. `dg pr update-branch` does this for you when the merge is clean.
- **Protected base branch:** only a maintainer can push to it. A writer's merge is refused with [`E601`](../errors.md#e601) before any git work.
- **Merged elsewhere:** if the merge was pushed some other way, `dg pr merge --event-only [--merge-oid <commit>]` only posts the event. A merge event is permanent, so `dg` checks the commit first: it must already have been a tip of the base branch, and it must contain the PR (the PR head is that commit or one of its ancestors, or the commit is a squash or a rebase of the PR on the base). On a protected base only a maintainer can record a merge, as only a maintainer can push one.
- **Reverting a merge:** `dg pr revert <repo> <n>` does what GitHub's Revert button does. It fetches the base branch into a throwaway repository (your clone is never touched), checks that the recorded merge contains the PR, and builds one commit on the base's tip that undoes what the merge brought in: a merge commit against its first parent (`git revert -m 1`), a squash commit, or the commits a rebase or a fast-forward added. It pushes that commit to a new branch, `revert-<n>-<head branch>` (`--branch` names another), and opens a pull request `Revert "<title>"` into the same base, with `Reverts #<n>` in its description. The cost is shown before you confirm, and `--json` reports the new PR. It is refused for a PR that is not merged, a merge that does not contain the PR, a merge commit the base branch no longer holds, or a revert that conflicts with later changes on the base; nothing is pushed then, and the error gives the `git revert` command to run in a clone for the way the PR was merged. It is also refused when its revert would reach more people than the pull request did: a members-only pull request in a public repository, or one for specific people. The revert's title repeats the original title. It needs write access to the repository.

A PR shows as merged only when **both** are true: the `merge` event exists (consensus admits it only from a writer or maintainer), and its commit has been **a tip of the base branch**. `dg pr merge` reads the PR back and reports what readers will see.

**Checking a merge.** Platform cannot read git, so a member could record a merge that does not contain the PR. Readers check it: the web labels a merged PR's merge commit as containing the PR, as a squash or a rebase of it, or, in red, as not containing its commits. `dg pr verify <repo> <n>` fetches the base and the PR head and says the same; `dg pr view` says it when the current repository already has the commits.

**Close without merging:** `dg pr close` / `dg pr reopen`. The author can close and reopen their own PR, as with issues.

### Code owners

A `CODEOWNERS` file names who owns which paths, in GitHub's format or GitLab's. Forge reads the first of these that exists on the PR's **base** branch: `.forge/CODEOWNERS`, `.github/CODEOWNERS`, `CODEOWNERS`, `docs/CODEOWNERS`, `.gitlab/CODEOWNERS`. A file over 3 MB is ignored, as on GitHub.

```text
# The last matching line wins.
*            @alice
/docs/       @bob 8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB
*.rs         @carol.dash
```

**Owners** are DPNS names (`@alice`, `@alice.dash`) or identity ids (bare, or after `@`). Teams (`@org/team`), e-mail addresses and GitLab roles (`@@maintainer`) are shown but never asked: Forge has no teams, and identities have no e-mail. In a repository mirrored from GitHub, `@login` is looked up as a DPNS name, which may belong to someone else; only members are ever asked (below), so a stranger with that name is not.

**Patterns** follow GitHub: gitignore patterns, with the last matching line winning, except that `docs/*` owns only the files directly in `docs/`, and `[` `]` are plain characters (so `app/[slug]/` means that folder). A line starting with `!` or holding `***` is skipped. GitLab sections work too (`[Docs]`, `^[Optional]`, `[Backend][2] @default-owner`): in each section the last matching line counts, and the owners of all sections are combined. A section's approval count is read but not enforced.

**When you open a PR,** on the web or with `dg pr create`, the owners of the files it changes (a renamed file counts under its old and new path) are asked for review, as GitHub does:

- only current maintainers and writers are asked, never triage members, readers, non-members or you (GitHub likewise ignores a code owner without write access);
- at most 15 reviewers;
- each request is one more document, included in the cost shown before you sign. A member writes them as `event`s; anyone else, as the PR's author, as `authorEvent`s (both kind 13).

The web form lists them under **Reviewers from code owners**, each with a box to leave them out, and "Show n not asked" says why the rest are not asked. `dg pr create` prints the same list before its confirm prompt, and `--json` reports it under `codeOwners`. `dg pr create --no-code-owners` skips it. `dg` reads the base and the head from the clone you run it in, or fetches them into a scratch repository when the clone lacks them.

**The Files tab** marks each owned file with a shield (filled when you own it). Select it for the owners and the `CODEOWNERS` line that decided them.

**Not supported:** "require review from code owners" as a branch rule. The `policy` document has no field for it, and adding one is a contract update (an optional `policy` property), so it is left for that update. A code owner's approval counts like any other member's.

---

## Releases

A release names a tag, a title, notes and optionally files. Only maintainers can publish one. Consensus enforces this, and `dg` checks it before uploading anything.

```sh
git tag v1.0.0 && git push dash://<owner>/<repo> v1.0.0
dg release create <owner>/<repo> --tag v1.0.0 --name "1.0.0" --notes "First stable release" \
  --asset ./dist/app-linux.tar.gz --asset ./dist/app-macos.tar.gz [--storage <profiles>]
dg release list   <owner>/<repo>
dg release download <owner>/<repo> v1.0.0 [--asset <name>] [-O/--output <dir | file>]
dg release unpublish <owner>/<repo> v1.0.0
dg release verify <owner>/<repo> v1.0.0     # has the tag or any asset changed since it was published?
```

The tag must exist in the repository first (push it, as above, or publish from the web, which can create it): a release cannot be deleted, only unpublished, so `dg release create` refuses a tag the repository does not have ([E102](../errors.md#e102)) before anything is uploaded or signed. A new revision of an existing release (to yank it or change its notes) is allowed even if its tag was deleted since.

`--asset` uploads each file to your own storage and records its SHA-256, size and URLs in the release. The storage is the repository's `dash.storage` profiles, or `--storage`, and each copy is read back and verified. Platform stores packs, not arbitrary files, so publishing an asset needs an S3 or IPFS profile ([bring your own storage](bring-your-own-storage.md)).

`dg release download` fetches every asset of the release, or only `--asset <name>`, and saves each under its own name in the current directory or in the `--output` directory (`-O`, `-o`, and `gh`'s `-D`/`--dir` work too). `--output <file>` names the file for a single asset. It never replaces a file of the same name that is already there. It accepts only bytes that hash to the recorded SHA-256. It needs no identity, and no credentials when the storage has a public URL.

`dg release list` always names who published each release. Every publish, edit or unpublish is a fresh revision that needs a *current* maintainer to sign it, so a maintainer who is later removed can no longer touch the releases they published — not edit them, and not unpublish them either. Only a maintainer still on the repo can do that.

**Yanking keeps the release, flagged; unpublishing takes it down.** To flag a release as withdrawn while keeping it listed, publish it again with `--yanked`. The newest release for a tag wins, so a new revision keeps what you leave out: its assets, name and notes carry over (an `--asset` of the same file name replaces that one asset), and `--yanked` alone marks the release without dropping its files. Publishing again without `--yanked` un-yanks it.

`dg release unpublish <owner>/<repo> <tag>` goes further: it takes the tag off the release list entirely (it no longer shows in `dg release list` or counts toward the repo's release total), and only works while the tag currently has a live release — a tag that was never published, or is already unpublished, is refused. Publishing the same tag again afterwards starts a fresh release.

**Releases are never deleted.** Releases are listed by version (highest first), and the latest is the highest that is neither a pre-release nor yanked. Every revision a release ever had — including an unpublish — stays on chain, so a tag's publication history can always be reconstructed.

**Branch and tag activity.** The **Activity** link beside each branch and tag (on the Branches and Tags pages) lists everything that ever happened to it, newest first: who created it, each push with the commits before and after, deletions, and every change to its protection. A push that replaced the branch's history instead of adding to it carries a red **force-pushed** badge; a moved tag carries **moved**; two pushes that raced from the same starting point, leaving two tips until a later push settles them, carry **diverged**. **Protection lifted** and **protection restored** mark when a settings change stopped and resumed protecting it, so a force-push in between is easy to spot. From the CLI:

```sh
dg repo activity <owner>/<repo> main          # a branch
dg repo activity <owner>/<repo> v1.0 --tag    # a tag
```

Run it inside a clone to tell force-pushes from ordinary pushes with your local git; elsewhere a push whose commits it cannot compare reads "updated". The web's Activity page covers public repositories only for now; `dg repo activity` works for private ones too.

**Provenance: is this still what was published?** A tag can be moved after its release is published, by a maintainer, or by any writer when tags are not protected (new repositories protect them). Every move stays on chain, so each release's page has a **Provenance** card:

- what the tag pointed at when the release was first published, and who pushed it;
- every later move or deletion, with who did it and when;
- whether the assets changed since the first publish (replaced, added or removed);
- the tag's signature, for an annotated tag signed with a key on a member's profile (`git tag -s`, SSH or OpenPGP, checked as `git verify-tag` checks it);
- whether tags are protected now.

The card turns red, and the release list marks the release **changed since publish**, when the tag points somewhere else, was deleted, or two pushes race on it, or when the assets changed. A tag that was moved and then moved back is shown in amber.

A public release also records the commit its tag pointed at when you published it (the web's release form and `dg release create` both write it). The card shows it under **Release records** and turns red if the tag's history says the tag pointed somewhere else at that moment. If the tag moved while you had the release form open, publishing stops and asks you to reload, so the record is always what you saw. A release whose tag named nothing when it was published (it was deleted then, or pushed only later) is checked against its record instead of the tag's history.

`dg release verify <owner>/<repo> <tag>` prints the same checks and exits with [E504](../errors.md#e504) when the release changed, so a script can stop before installing from the tag. Run it inside a clone that has fetched the tag (`git fetch --tags`) to check the tag's signature as well. A private repository's sealed release may record its commit; it is checked against that when its tag named nothing at the moment of publish (the tag's own history wins otherwise).

### Labels

Members define a repository's labels and apply them to issues:

```sh
dg label create <owner>/<repo> bug --color "#d73a4a" --description "Something is broken"
dg label list   <owner>/<repo> [--all]
dg label retire <owner>/<repo> bug
dg label delete <owner>/<repo> bug                 # deletes your definitions; retires it if others defined it too
dg issue label  <owner>/<repo> 12 add bug
```

On the web, **Issues → Labels** lists them and lets members create one, change its colour or description, and delete it (with the same retire-if-others-defined-it rule). A label keeps its name once defined: issues carry a label by its name, so a rename would leave them under the old one.

### Milestones

Maintainers, writers and triage members define milestones and put issues in them:

```sh
dg milestone create <owner>/<repo> v1.0 --description "First release" --due 2026-12-01
dg milestone list   <owner>/<repo>
dg milestone close  <owner>/<repo> v1.0             # --reopen to reopen
dg issue milestone  <owner>/<repo> 12 v1.0
```

On the web, **Issues → Milestones** lists them open and closed, with due dates and progress, and lets members create, edit, close, reopen and delete them. Like a label, a milestone keeps its title once defined. A milestone definition can be deleted only by the member who wrote it, so one another member also defined can be closed but not deleted. Milestones in a private repository are sealed, which this release does not do yet (web or `dg`).

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
| Browse code, commits, branches, tags and PR diffs; download a branch as a zip | Web editing of files |
| Create and delete branches on the **Branches** page (maintainers and writers) | Deleting tags (use `git push <remote> :refs/tags/<tag>`) |
| File issues, comment, close and reopen; label them and put them in milestones, and manage the repo's labels and milestones (members) | Merging a private repository's PRs, or committing to its branches (use `dg`) |
| Open a PR from a branch you have already pushed, in the repository or your fork | Merging when both sides changed the same lines, or renamed or moved what the other changed (use `dg pr merge`) |
| Review a PR: approve, request changes or comment, with inline comments, suggestions and a pending review | |
| Merge a PR (see below) | |
| Create a repository (public or private), or fork one, with a cost preview; sync a fork with its parent (fast-forward) | Syncing a fork whose branch has commits of its own (open the pull request it offers) |
| Add and remove members (owner) | |
| Publish a release with assets, creating its tag when it does not exist (maintainers) | |
| Star repositories and follow people | |
| See your repositories, issues, PRs and stars in **Explore**, and new activity in **Notifications** | |

Every write shows its price before you sign, and a toast shows what it actually cost. **Settings → Spend** keeps a local ledger of what this browser spent, by repository and month.

**Releases from the browser.** On a repository's **Releases** tab, a maintainer sees **New release**. It works like `dg release create --asset`: the maintainer role is checked before anything uploads, each file (up to 256 MiB) goes to *your* storage from **Settings → Storage** (never to Platform), is verified by reading it back, and is recorded with its SHA-256. Anyone who downloads an asset from the release page gets it only if it hashes to the recorded value. The tag can be an existing one, or a new one: the form then says the tag is new and asks for the **Target** branch (the default branch first), and publishing first writes the tag as a lightweight tag at that branch's tip (one ref update, about 0.0007 DASH, nothing uploaded), as GitHub's "Create new tag on publish" does. A tag that was pushed meanwhile at another commit stops the publish before anything uploads. To make an annotated or signed tag, push it with git first.

**Branches from the browser.** On the **Branches** page, maintainers and writers see **New branch** (a name and the branch to start from) and a delete button on each branch. Each is one ref update, about 0.0007 DASH, and nothing is uploaded: a new branch points at a commit the repository already stores. A branch matching a protected pattern is a maintainer's to create. The default branch and protected branches cannot be deleted from the web, as on GitHub: the button is disabled and says why (change the default, or a maintainer removes the protection in **Settings → Branches**, first). A branch is deleted only from the commit the page showed, so commits pushed since are never dropped unseen, and a branch deleted from the page can be **Restore**d there until you leave it. Its commits stay stored either way: deleting a branch deletes no pack. Triage members and readers see a line saying their role cannot create or delete branches.

**Merging.** Writers and maintainers get a merge box on a public repository's PR. It checks the merge in the browser first, then offers what it can do: **Merge (fast-forward)**, **Create merge commit and merge**, **Squash and merge** (authored by the PR's author, committed by you, as on GitHub) or **Rebase and merge** (the PR's commits replayed on the base exactly as `git rebase` replays them, each keeping its author, committed by you), limited to the methods the branch policy allows. A rebase is checked on its own, since it can stop where a merge would not: when a commit would not apply cleanly the box names it and its files (git's rebase stops there too, so pick another method or rebase the branch yourself), and when the PR holds a merge commit or a commit's change may already be on the base it sends you to `dg pr merge --rebase`. A merge commit's and a squash's message can be edited in the box before merging. The browser merges a file both sides changed line by line, exactly as `git merge` does: the same merged file, byte for byte. When the two sides changed the same lines, or lines next to each other, git would stop with a conflict, and so does the browser: it lists the files and sends you to `dg pr merge`. A merge needs a commit name and email; the merge box asks for them in place when they are not set yet. It builds the pack, uploads it to your storage from **Settings → Storage** (it asks before storing on Platform), moves the branch and posts the `merge` event: the same steps as `dg pr merge`. These cases go to `dg pr merge`: lines both sides changed (a conflict, which `dg pr merge` reports too until you resolve it on the PR's branch), shapes only git merges (a file one side renamed or deleted and the other changed, a directory one side moved or removed, a file added on both sides, binary files, files over 2 MiB, files under a `.gitattributes`, whose merge rules the browser does not read), a private repository, a merge too large to build in the browser, and a history that changes `.gitmodules` or `.gitattributes` or holds an object git would reject. On a protected base branch only a maintainer can merge, in the browser or with `dg`; a writer sees **Protected branch — maintainers only**. **Mark as merged (done elsewhere)** only records a merge done some other way, and is offered once the head is on the base branch. While the branch policy is not met the merge is disabled; a maintainer can tick **bypass rules**, confirm the rules named, and merge: an event on the PR records the bypass, and nobody can delete it.

**Notifications** are computed in your browser from the chain: new issues and PRs in your repositories, state changes, comments and reviews on your threads, and optionally pushes and starred repositories. There is no email, no push notification and no sync across devices, because there is no server to send them.

**Coming soon:** editing files in the browser, and browser merges and branch commits for private repositories.

---

## Webhooks and CI

A maintainer can have on-chain activity delivered as GitHub-shaped webhooks (`push`, `issues`, `pull_request`, `issue_comment`, `pull_request_review`, `release`, `check_run`), signed with `X-Hub-Signature-256`. Forge runs no webhook service: deliveries come from a **relay** that you, or someone you choose, runs.

```sh
dg webhook add <owner>/<repo> --url https://ci.example/hook \
  --relay <relay identity id> --events push,pull_request --name ci
dg webhook list   <owner>/<repo>
dg webhook remove <owner>/<repo> ci      # by the name it was added with, or its hook id
```

The URL and event list are public on chain. **The URL must be `https://` to a DNS hostname** — stricter than a check run's URL: no IP literal, no `localhost`, no userinfo. `dg webhook add` refuses one that doesn't parse that way before it signs anything. The HMAC secret is encrypted to the relay identity's encryption key, so only that relay can read it; without `--secret-env <VAR>`, `dg` generates one and shows it once, in a terminal only. Scripted, piped, in CI or with `--json`, pass `--secret-file <new file>` (0600; only the path is printed) or `--secret-env`. Without either, `dg` refuses before it writes anything. The relay (`forge-relay run`, or its Docker image) needs only that encryption key, never signs and never spends. A delivery that fails is kept in a durable retry queue on the relay's disk and retried for up to 48 hours, across restarts (given a writable state dir; without one the relay warns and keeps the queue in memory); `forge-relay deliveries` lists the queue. Every delivery carries a stable `X-GitHub-Delivery` id, so receivers can drop duplicates.

Check results go the other way: CI reports them with `dg ci report` under a runner key that can sign nothing else. See [CI and check runs](ci.md).

A relay is trusted for availability only: a receiver that must not be fooled checks what a webhook says against Platform. [`crates/forge-relay/README.md`](../../crates/forge-relay/README.md) covers running one, the delivery guarantees, and a CI consumer that verifies the pushed ref.
