# Who can read what: Public, Members and Specific people

Everything in a Dash Forge repository has an **audience**: Public, All members, Maintainers, Writers and maintainers, or Specific people. You can always choose a narrower audience for something new. You widen it only by publishing it or making it public, and that can't be undone.

This page explains what each audience means, what a public repository can keep **members-only** today, who can read it, what everyone can still see, and what members-only content does not protect against. For a wholly private repository, where everything is encrypted, see [Private repositories](../guides/collaborating.md#private-repositories).

1. [The audiences](#the-audiences)
2. [What can be members-only today](#what-can-be-members-only-today)
3. [Who can read members-only content](#who-can-read-members-only-content)
4. [Turn on members-only content](#turn-on-members-only-content)
5. [Post and read members-only content](#post-and-read-members-only-content)
6. [What it costs](#what-it-costs)
7. [What everyone can still see](#what-everyone-can-still-see)
8. [Who can learn what](#who-can-learn-what)
9. [What can still leak](#what-can-still-leak)
10. [What this does not protect against](#what-this-does-not-protect-against)
11. [Older Forge builds](#older-forge-builds)
12. [Errors](#errors)
13. [Words used on this page](#words-used-on-this-page)

---

## The audiences

| Audience | Who reads it | Changes when members change | Available |
|---|---|---|---|
| **Public** | Everyone. | n/a | today |
| **All members** (short: **Members**) | Everyone with a role in the repository, including people with Read access, now and in future. Bots aren't included. People added later read it too, including what was posted before they joined. People removed later keep what they could already read. | yes | today, for issues, comments, reviews and environments |
| **Maintainers** | The current maintainers when it was saved. People who become maintainers later see it only if someone adds them. | no | today, for environments |
| **Writers and maintainers** | The people with Write access or more right now. | no | **coming later** |
| **Specific people** | A list the writer picks, up to 16 people, members or not. The writer is always on it. Replying with someone added lets them read from that reply on, not earlier ones. | no | **coming later** |

"Members-only" is the adjective for anything that isn't public. It can be any of the four audiences below Public.

Members-only content is encrypted on your computer or in your browser before anything is sent. Dash Platform stores the encrypted text. Nobody without the repository's key can read it: not Platform nodes, not storage providers, not Forge's developers.

A **private** repository is different: everything in it is encrypted, code included, and it has no public side. This page is about members-only content inside a **public** repository.

## What can be members-only today

| Content | Members-only today? |
|---|---|
| Issues | yes |
| Comments on issues and pull requests | yes |
| Reviews of a pull request (the review's text; its verdict stays public, [below](#what-everyone-can-still-see)) | yes |
| [Environments](../guides/environments.md): configuration and secrets kept outside git | yes: **All members** or **Maintainers** |
| Pull requests themselves, branches, commits and code | **coming later**. Everything you push to a public repository is public. |
| Releases | **coming later** |
| Label and milestone definitions | no, they stay public. Which label or milestone a members-only issue has is encrypted. |

A reply follows what it answers: a comment on a members-only issue, or a reply to a members-only comment, is members-only too. A members-only comment on a public issue or pull request is fine. A public reply inside a members-only conversation is refused before anything is signed.

Who something is for is fixed when it is posted. Editing a members-only comment or issue keeps it members-only, and Forge refuses to edit a public one into a members-only one. Making members-only discussion public later is **coming later**. Until then, post a new public comment.

## Who can read members-only content

| Who | Reads members-only content? |
|---|---|
| **Owner** and people with **Maintain** access | yes |
| People with **Write** or **Triage** access | yes |
| People with **Read** access | yes. On a public repository the Read role exists for exactly this: someone who should read the members-only discussion and comment, without pushing, approving or merging. |
| A **Bot** | **no**, by default. A bot is an automated account. It can post comments and reviews, can't push, approve or merge, and reads members-only content only when someone asks it to. Bots arrive later. |
| A CI runner | **no**, by default. A runner's key reports check runs and is not a membership. If you give the runner's identity the Read role, it reads everything members-only, like anyone else with Read access. |
| Someone added later | yes, everything, including what was posted before they joined |
| Someone removed | what was posted **before** the removal, for good. Nothing posted afterwards. Encryption can't take back what was already shared. |
| Anyone else | no. They see that something was posted, by whom and when ([below](#what-everyone-can-still-see)). |

What each role can do:

- **Read:** can read members-only content and comment. Can't push or approve.
- **Triage:** can also close, label and assign.
- **Write:** can also push, approve and merge.
- **Maintain:** can also change settings, protected branches, releases and environments.
- **Owner:** everything above, and adds and removes members.

Removing a member changes the key, so what is posted afterwards is unreadable to them. Adding a member shares the key with them. Both happen in `dg collab add` and `dg collab remove`, which show the cost first ([Collaborating](../guides/collaborating.md#members-only-content-in-a-public-repository)).

Every member needs an **encryption key** on their identity to receive the members key. Identities made with `dg auth new`, the web app or the bridge have one. If yours does not, set up your encryption key with `dg auth keys add --encryption` ([Identity and keys](../guides/identity-and-keys.md#encryption-key-private-repositories)). A member without one can still do everything public, and gets the key once they add one and a maintainer runs `dg repo keys repair`.

## Turn on members-only content

A maintainer turns it on once per repository:

```sh
dg repo members enable <owner>/<repo>
```

Before anything is signed it asks "Turn on members-only content?", says what members will be able to do and that everyone can still see that something was posted, by whom and when, and shows the cost of setting up keys for the current members (each later removal costs about the same again). It also warns that people using older Forge builds will see fewer things until they update ([below](#older-forge-builds)).

It shares the members key with every current member who has an encryption key, and lists those who don't have one yet. `dg repo members status <owner>/<repo>` says whether it is on, whether you can read it, and who is still waiting for the key. A member who asks for members-only content in a repository where it is off is told to ask a maintainer ([E312](#e312)).

Turning it on cannot be undone, and it changes nothing that is already public.

In the web app, a maintainer chooses **Turn on members-only content** (in the audience picker or under Settings → Members); the sheet shows the cost for the current members first.

## Post and read members-only content

From `dg`, add `--members`:

```sh
dg issue create <owner>/<repo> --members --title "Spam wave from new accounts" --body "…"
dg issue comment <owner>/<repo> 12 --members --body "The reporter is the same person as in #9."
dg pr comment    <owner>/<repo> 7 --members --body "This touches the fraud rules."
dg pr review     <owner>/<repo> 7 --approve --members --body "LGTM, see the fraud-rule note."
```

Without `--members` the context decides: inside a members-only conversation a reply is members-only. Members read members-only items in `dg issue view`, `dg issue list`, `dg pr view` and `dg pr list` like any other, marked "members-only". With `--json`, every item carries `"audience"` (`"public"` or `"members"`) and `"readable"`.

Anyone else sees a row and a count, never the text:

```text
$ dg issue view alice/shop 3
#3 · members-only issue by @alice · open

$ dg pr view alice/shop 7
...
3 members-only comments hidden, shown as placeholders (you're not a member of alice/shop)
```

`dg issue view` adds a line saying only members can read it, and `dg pr view --comments` shows each members-only comment as a placeholder with its author and time. Lists say how many rows you can't read: "Issues 3 (1 members-only; only members of alice/shop can read them)".

**In the web app**, members read members-only issues, comments and reviews after unlocking once in the tab, and a reply in a members-only conversation stays members-only. Every composer has an audience chip (**Public** or **Members**); a reply inside a members-only conversation can only be members-only. Everyone else sees members-only rows and placeholders and a "#N · members-only" page instead of the content, and members can check what the public sees with **View as public**. Before a public post that quotes members-only text, the web asks you to confirm.

**Search** looks only at what you can read. `dg search` tells you how many members-only issues it could not search.

**Notifications.** The web app's notifications and the webhooks `forge-relay` delivers say that something happened, never what was said. Encrypted comments and reviews from people who are not members are not shown and notify nobody. An issue anyone opens as members-only still gets its numbered row and a notice, since its number is public. Whoever runs a notification service gets the same rules ([members-only notifications](../hosting/members-only-notifications.md)).

## What it costs

Measured on devnet sakura:

| Action | Cost |
|---|---|
| Turn on members-only content | about 0.0004 DASH, plus about 0.0007 DASH for each member who gets the key (about 0.004 DASH for 5 members) |
| Add a member to a repository with members-only content | the usual membership write, plus about 0.0007 DASH to share the key |
| Remove a member | the usual delete, plus a key change: about 0.0007 DASH per remaining member and about 0.0006 DASH more |
| Post a members-only issue, comment or review | 0 to 8 % more than the same thing in public |
| Save an environment change | about 0.0025 DASH |

Reading costs nothing.

## What everyone can still see

Encryption hides **what was said**. It does not hide **that something was said**. For every members-only item, everyone can see:

- that it exists, who posted it, and when (and when it was edited);
- its size, rounded up to 64 bytes;
- that it is members-only;
- that its author was a member when they posted it.

And per kind of item:

| Item | Everyone can see | Only members can read |
|---|---|---|
| A members-only comment or review on a public issue or pull request | which issue or pull request it is on, and which comment it replies to; an inline comment's line numbers and commit; **a review's verdict** (approved, changes requested, commented), which counts toward the branch policy for everyone | the text, an inline comment's file path, the review's text |
| A members-only issue | its number ("#12 · members-only"); when it was opened, closed, reopened or locked, and by whom; that a label or milestone was set or someone assigned, and **who** was assigned; the counts that include it | the title, the body, the names of its labels and milestone |
| An environment | that the repository has environments and how many; for each change, who made it, when, and its size rounded up to 512 bytes; for a Maintainers environment, how many people it was sent to | its name, the names, types and notes of its entries, and every value |
| The repository | that members-only content is on; when the members key changed; who shared the key with whom; the member list and roles (public on every repository) | the key |

A review's verdict is public on purpose: everyone agrees on whether a pull request has its approvals, so a member and a non-member see the same merge button. A pull request's author who is not a member sees "Changes requested by @bob" and cannot read why. Add one public line saying what to fix.

## Who can learn what

| Who | Reads members-only content | Learns anyway |
|---|---|---|
| The public, any Dash Platform node, explorers and indexers | no | everything in [What everyone can still see](#what-everyone-can-still-see) |
| Your storage provider (for long members-only text and environments) | no | file sizes, and when files are read |
| A notification service or relay that is not a member, including the hosted one | no | that something happened, by whom, when, and on which issue or pull request |
| A hosted read-only mirror of the code | no | the public repository only |
| A current member | yes | |
| A removed member | everything posted before the removal, forever | sizes and timing afterwards |
| A CI runner | no, unless you give its identity the Read role | |
| Someone who builds a modified Forge | no | they can post encrypted text, as anyone may. No member's Forge app shows a comment or review from someone who was not a member. An issue gets its numbered row, like any members-only issue. |
| A tampered copy of the web app that you unlock | everything you can read | [Verify the app you loaded](../guides/verify-the-app.md), or run your own copy |

## What can still leak

- **Everything in [What everyone can still see](#what-everyone-can-still-see).** Who talks, when, how much, and on which issue can say a lot. Leave out what the timing alone would give away.
- **What members copy.** Any member can copy, quote or screenshot what they read. Quoting a members-only comment into a public reply publishes the quoted text.
- **What removed members kept.** They keep everything posted before the removal. Removing someone protects only what comes after.
- **Past values in an All members environment.** Everyone who becomes a member later can read every value ever stored there, including past values. Keep production credentials in a **Maintainers** environment, and rotate a secret at its source when someone leaves ([Environments](../guides/environments.md#removing-a-member)).
- **Code.** Everything pushed to a public repository is public, forever, even if you delete it later. The push helper refuses some files that look like secrets and warns about others ([Secrets in a push](../guides/quick-start.md#secrets-in-a-push)), but it cannot know everything. Keep secrets in an environment instead.
- **Your encryption key.** It reads every private repository and every members-only conversation you belong to. Keep it like your signing keys, and replace it after a lost device ([Identity and keys](../guides/identity-and-keys.md#replacing-it-after-a-lost-device)).
- **Mentions.** Mentioning someone who is not a member in a members-only comment tells them nothing they can read, but they may learn that something was posted.

## What this does not protect against

Forge stops accidents, not intent. A member who copies members-only text by hand into a public issue, a commit, an email or anywhere else has published it, and no check can stop that.

When members-only branches arrive (coming later), the same holds for code: the checks before a push stop a member from publishing members-only commits by accident. A member who copies files by hand into a public branch, or who pushes with `git push --no-verify`, is out of scope.

## Older Forge builds

People using older Forge builds see fewer things until they update. Nothing leaks and nothing breaks:

- members-only items are left out without saying why, and counts that include them are not labelled;
- a members-only issue opened by its number reads as "not found" (an older `dg` says E102);
- an older web app may describe members-only items as "encrypted by someone who is not a member". That is wrong. Update;
- an older build does not count a members-only review's approval, so it may refuse a merge an up-to-date build allows ([E804](../errors.md#e804)). Never the reverse. **Update to see and count members-only reviews.**

Change members only with an up-to-date Forge (`dg` or the web app), so the key follows every change:

- a member added by an older build has no key yet, and sees [E311](#e311). Nothing shares it automatically: a maintainer chooses **Repair** on the repository page or runs `dg repo keys repair`;
- a member removed by an older build can still read new members-only content until the key changes. `dg repo keys status` flags it, and `dg repo keys repair` changes the key.

## Errors

### E311

**No key has been shared with you yet.** You're a member, but no maintainer has shared the members key with your encryption key. This happens when an older Forge build added you. You can still read and do everything public. The members-only items show as placeholders.

Forge says: "You're a member, but no key has been shared with you yet. Ask a maintainer to share it: Repair on the repo page, or `dg repo keys repair`."

**What to do:** ask a maintainer to share it. They choose **Repair** on the repository page (it shows the cost first), or run `dg repo keys repair <owner>/<repo>`. If your identity has no encryption key yet, set one up first: `dg auth keys add --encryption`.

### E312

**Members-only content is not turned on.** You asked for a members-only issue, comment or review in a public repository where no maintainer has turned it on.

**What to do:** a maintainer runs `dg repo members enable <owner>/<repo>` (it shows the cost first). Otherwise, post it publicly, or ask a maintainer to turn it on.

### E313

**Members-only.** That issue or pull request is members-only, and you can't read it. Everyone can see that it exists, its number, who opened it and when. `dg issue view` and `dg pr view` show that as a row and exit normally. E313 comes from commands that need the content, such as commenting on it or checking it out.

**What to do:** ask the repository's owner to make you a member (run `dg collab accept <owner>/<repo>` first: that is your consent). If you are a member already, see [E311](#e311). If your key is locked (a key protected by a passphrase, with no terminal to ask for it), set `DASH_FORGE_PASSPHRASE` or run the command in a terminal.

A members-only write by someone who is not a member stops with [E601](../errors.md#e601) before anything is signed. A member whose identity has no encryption key gets [E306](../errors.md#e306): set up your encryption key first. Every code is also in [Error codes](../errors.md).

## Words used on this page

Forge uses the same words in `dg`, the web app and these pages.

**Audiences**

| Word | Means |
|---|---|
| **Public** | Everyone can read it. |
| **All members** (short: **Members**) | Everyone with a role in the repository, now and in future. Bots aren't included. |
| **Maintainers** | The maintainers when it was saved. |
| **Writers and maintainers** | The people with Write access or more right now (coming later). |
| **Specific people** | A list the writer picks (coming later). |
| **members-only** | Anything that isn't public. "A members-only comment." |

**Roles:** **Read**, **Triage**, **Write**, **Maintain**, **Owner** and **Bot** (an automated account; coming later). What each can do is [above](#who-can-read-members-only-content).

**Verbs**

| Word | Means |
|---|---|
| **Publish** | Widen code to everyone (coming later). It can't be undone. |
| **Make public** | Widen a post, such as a comment, to everyone (coming later). It can't be undone. |
| **Make this repo public** | Widen a whole private repository. It can't be undone: it can never be private again (coming later). |

**Repository kinds:** **Public** and **Private**. "Private" means only a private repository, where everything in it is encrypted. A public repository can hold members-only content, but it is never called private.

**Access** is what a bot or a CI runner is given: what it may post or read, and until when.

**Setting up:** **Turn on members-only content** is what a maintainer does once per repository (`dg repo members enable`). **Set up your encryption key** is what each person does once per identity (`dg auth keys add --encryption`).

**Words Forge doesn't use.** Forge's apps and pages never say sealed, lane, named, restricted, reveal, epoch, key letter or disclosure, and never use "grant" as a noun. Say "encrypted", "the key changed", "access" or "who can read it" instead.

How it is built: [Private repositories §17](private-repos.md#17-mixed-repositories-members-only-content-in-a-public-repository) and [forge-v2.md §5](../contracts/forge-v2.md#5-private-repositories).
