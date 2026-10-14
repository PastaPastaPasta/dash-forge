# Who can read what: the audiences

Everything in a Dash Forge repository has an **audience**: Public, All members, Maintainers, Writers and maintainers, or Specific people. You can always choose a narrower audience for something new. You widen it only by publishing it or making it public, and that can't be undone.

This page explains what each audience means, what a public repository can keep **members-only** today, who can read it, what everyone can still see, and what members-only content does not protect against. For a wholly private repository, where everything is encrypted, see [Private repositories](../guides/collaborating.md#private-repositories).

1. [The audiences](#the-audiences)
2. [What can be members-only today](#what-can-be-members-only-today)
3. [Who can read members-only content](#who-can-read-members-only-content)
4. [Turn on members-only content](#turn-on-members-only-content)
5. [Post and read members-only content](#post-and-read-members-only-content)
6. [Send a message to specific people](#send-a-message-to-specific-people)
7. [What it costs](#what-it-costs)
8. [What everyone can still see](#what-everyone-can-still-see)
9. [Who can learn what](#who-can-learn-what)
10. [What can still leak](#what-can-still-leak)
11. [What this does not protect against](#what-this-does-not-protect-against)
12. [Older Forge builds](#older-forge-builds)
13. [Errors](#errors)
14. [Words used on this page](#words-used-on-this-page)

---

## The audiences

| Audience | Who reads it | Changes when members change | Available |
|---|---|---|---|
| **Public** | Everyone. | n/a | today |
| **All members** (short: **Members**) | Everyone with a role in the repository, including people with Read access, now and in future. Bots aren't included. People added later read it too, including what was posted before they joined. People removed later keep what they could already read. | yes | today, for issues, comments, reviews and environments |
| **Maintainers** | The owner and maintainers when it was posted or saved. Someone made a maintainer later reads an environment once it is saved again (Forge does that in the same step), never what was saved before; a message, only from a later reply that includes them. | no | today, for issues, comments, reviews and environments |
| **Writers and maintainers** | The people with Write access or more when it was posted or saved. | no | today, for issues, comments, reviews and environments |
| **Specific people** | A list the writer picks, up to 16 people (64 for an environment), members or not. The writer is always on it. Replying with someone added lets them read from that reply on, not earlier ones. | no | today, for issues, comments, reviews and environments |

"Members-only" is the adjective for anything that isn't public. It can be any of the four audiences below Public.

Members-only content is encrypted on your computer or in your browser before anything is sent. Dash Platform stores the encrypted text. Nobody without a key it was encrypted to can read it: not Platform nodes, not storage providers, not Forge's developers.

A **private** repository is different: everything in it is encrypted, code included, and it has no public side. This page is about members-only content inside a **public** repository.

## What can be members-only today

| Content | Members-only today? |
|---|---|
| Issues | yes, for All members or as a [message to specific people](#send-a-message-to-specific-people) |
| Comments on issues and pull requests | yes, the same |
| Reviews of a pull request (the review's text; its verdict stays public, [below](#what-everyone-can-still-see)) | yes, the same |
| [Environments](../guides/environments.md): configuration and secrets kept outside git | yes: always for a chosen audience, **Maintainers**, **Writers and maintainers**, **All members** or **Specific people**, encrypted for those people when it is saved |
| Branches, the commits on them, and pull requests from them | yes, for All members: [members-only branches](#members-only-branches-and-pull-requests). Everything you push to a public branch is public. |
| Releases | **coming later** |
| Label and milestone definitions | no, they stay public. Which label or milestone a members-only issue has is encrypted. |

A reply follows what it answers: a comment on a members-only issue, or a reply to a members-only comment, is members-only too. A members-only comment on a public issue or pull request is fine. A public reply inside a members-only conversation is refused before anything is signed.

Who something is for is fixed when it is posted. Editing a members-only comment or issue keeps it members-only, and Forge refuses to edit a public one into a members-only one. The one exception: the author of a members-only issue, comment or review can **make it public** (`dg make-public`, or **Make public** in the web app). Everyone can read it from then on, as it reads at that moment; earlier versions of an issue stay members-only, and it can't be undone. A review stays as it was written: its text is added as a public comment on it, which every reader shows in its place. A **maintainer** can make anyone's members-only post public, or a whole conversation, and earlier versions of an issue too: Forge lists whose words become public before anything is signed, and tells those people. Only a maintainer can: Forge ignores anyone else's attempt. A message for specific people can be made public by a maintainer only if it was sent to them. After a post is made public, its author's edits to it are public too. Nothing becomes members-only again. See [Collaborating](../guides/collaborating.md).

## Who can read members-only content

| Who | Reads members-only content? |
|---|---|
| **Owner** and people with **Maintain** access | yes |
| People with **Write** or **Triage** access | yes |
| People with **Read** access | yes. On a public repository the Read role exists for exactly this: someone who should read the members-only discussion and comment, without pushing, approving or merging. |
| A **Bot** | **no**, by default. A bot is an automated account. It can post comments and reviews, can't push, approve or merge, and reads members-only content only when someone asks it to. Bots arrive later. |
| A CI runner | **no**, by default. A runner's key reports check runs and is not a membership. If you give the runner's identity the Read role, it reads everything members-only, like anyone else with Read access. |
| Someone added later | in an All members audience, yes: everything, including what was posted before they joined. In an environment, its current values once it is saved again for them (Forge does that when it adds them), never earlier ones. |
| Someone removed | what was posted **before** the removal, for good. Nothing posted afterwards. Encryption can't take back what was already shared. |
| Anyone else | no. They see that something was posted, by whom and when ([below](#what-everyone-can-still-see)). |

What each role can do:

- **Read:** can read members-only content and comment. Can't push. Their approvals don't count.
- **Triage:** can also close, label and assign.
- **Write:** can also push, approve and merge.
- **Maintain:** can also change settings, protected branches, releases and environments.
- **Owner:** everything above, and adds and removes members.

Removing a member changes the key, so what is posted afterwards is unreadable to them. Adding a member shares the key with them. Both happen in `dg collab add` and `dg collab remove`, which show the cost first ([Collaborating](../guides/collaborating.md#members-only-content-in-a-public-repository)).

Every member needs an **encryption key** on their identity to receive the members key. Identities made with `dg auth new`, the web app or the bridge have one. If yours does not, set up your encryption key with `dg auth keys add --encryption` ([Identity and keys](../guides/identity-and-keys.md#encryption-key-private-repositories)). A member without one can still do everything public, and gets the key once they add one and a maintainer runs `dg repo keys repair`.

## Turn on members-only content

A new public repository has it on from the start: `dg repo create`, `dg init` and the web app's **New repository** form turn it on right after creating the repository (about 0.0011 DASH, shown before you confirm), unless you opt out with `--no-members-only` or untick **Turn on members-only content now**. It needs an encryption key: without one, the repository is created with it off and you are told how to add a key. If setting it up fails, the repository still exists: `dg` exits successfully with a warning whose fix is `dg repo members enable <owner>/<repo>`, and the web app's repository page says "Your repo is created. Members-only content isn't set up yet." with **Finish setting up**. Both finish a half-done setup, reusing your key share if it was already written. Imports (`dg import`), mirrors and forks start with it off, since they copy a public repository.

For any other repository, a maintainer turns it on once:

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

## Send a message to specific people

An issue, a comment or a review can go to **Maintainers**, to **Writers and maintainers**, or to **specific people** instead of all members. Only the people it goes to can read it. It needs no members-only content turned on, and the people need not be members: anyone with an encryption key can receive one, and anyone with an encryption key can send one.

From `dg`, add `--to`:

```sh
dg issue create  <owner>/<repo> --to maintainers --title "Security report triage" --body "…"
dg issue comment <owner>/<repo> 12 --to @alice,@bob --body "Can you two check the logs?"
dg pr comment    <owner>/<repo> 7 --to writers --body "Who can take the migration?"
dg pr review     <owner>/<repo> 7 --comment --to @carol --body "Details of the bug, for you only."
```

- `--to maintainers` goes to the owner and the maintainers **as they are now**; `--to writers` adds everyone with Write access. Triage members and people with Read access are not in either group. You are always included, in the group or not.
- `--to @alice,@bob` goes to the people you name (DPNS names or identity ids), members or not. You can add people to a group: `--to maintainers,@frank`.
- At most **16 people**, you included. A group that is bigger is refused before anything is signed: "Writers and maintainers is 23 people. A message can go to at most 16." Post it to all members (`--members`) or name people instead.
- Each person needs an **encryption key**. Someone you name without one is refused ("can't receive members-only messages yet"); someone in a group without one is left out, and `dg` says so after posting.
- Who it goes to is fixed when it is posted. Someone made a maintainer later does not read a message sent to Maintainers before.
- **Replies.** A reply in such a conversation (`dg issue comment … --reply-to <comment id>`, `dg pr comment … --reply-to <comment id>`, or any comment on an issue sent to specific people) goes to the same people without asking: a list is repeated, and a group is listed again **as it is now**, so a maintainer added since reads from that reply on, not earlier ones. `--to` on a reply adds people (they read from that reply on); a reply can never leave someone out, except people who have since left a group the conversation was sent to. A public or all-members reply inside such a conversation is refused.
- Inside a members-only conversation, a message to specific people can go to members only.
- Its text lives only in the message itself: a text too long for it is refused ("shorten it, or send it to fewer people"); each person takes about 100 bytes. A review for specific people is submitted in one command: it is never kept as a pending review on your computer.
- Labels, milestones and assignees can't be set on an issue sent to specific people yet. Closing and reopening it works as usual.
- A pull request can go to specific people too (`dg pr create --to …`) when its branch is public: its title, description and branch names are then theirs only, and its commits are public like any public branch's.

Before anything is signed, `dg` names who it goes to, including the people a reply re-lists without being asked: "Post a comment on issue #12 to the maintainers now (@alice and @bob)?". What you see after posting, and in `dg issue view` / `dg pr view --comments`: who it went to, "as listed by" its writer.

```text
$ dg issue comment alice/shop 12 --to maintainers --body "…"
✓ commented on issue #12 (to specific people) · …
  sent to @alice and @bob (maintainers when sent; 3 people, you included; only they can read it)

$ dg issue view alice/shop 12
...
— carol (7XyQ…Pd2) · to @alice and you (maintainers when sent):
```

Everyone else sees that a message was posted, by whom, when, and **to how many people**, never who they are or what it says: "#14 · issue to 3 people by @carol · open", or a placeholder "comment to 3 people". A message from someone who is not a member is shown to its people and only counted for everyone else. With `--json`, a message carries `"audience": "specificPeople"` and, for its people, `"letter": {"to": [...], "group": ...}`; a placeholder carries `"recipients"`.

**In the web app**, the audience chip beside every composer offers Public, All members, Maintainers, Writers and maintainers and Specific people… ("Who can read this?"). The people picker greys out anyone who can't receive one yet. After posting, the message says "Visible to alice, bob and you" or "Visible to alice, bob, carol (maintainers when sent)". **Forward to…** on a message you can read starts a reply that quotes it, with the same people and anyone you add. A message's text is never kept as a draft.

## Members-only branches and pull requests

A branch can be members-only: only members see its name and its commits. Start one with `dg branch new --members`, push it as usual, and open a pull request from it; when the work is ready, **publish** it onto a public branch.

```sh
dg branch new --members sec/fix             # records that sec/fix is members-only, and switches to it
git push origin sec/fix                      # pushed members-only
dg pr create --head sec/fix --title "Fix the bounds check"   # a members-only pull request
dg branch                                    # Public and Members only groups
dg pr list <owner>/<repo> --audience members
dg pr checkout <owner>/<repo> 42            # members check out its real commit
dg publish --pr 42                           # one new public commit on its base; the PR is recorded merged
```

- `dg branch new --members <name>` needs your encryption key and members-only content turned on ([E312](#e312) otherwise). A name that is already public is refused (E809: "nothing already pushed can be hidden"): start a new members-only branch from it instead.
- A pull request from a members-only branch, or into one, is members-only without `--members`. Everyone sees its number, who opened it, its state, its reviews' verdicts and its checks' outcomes; only members read its title, description, branch names and commits. After a push to its branch, `dg pr sync <owner>/<repo> <n>` moves its head when the push did not.
- `dg branch` lists the branches in two groups, Public and Members only. Anyone else sees the public ones and "This repo also has members-only branches.", never how many.
- **Publishing** (`dg publish <branch> --onto main`, or `dg publish --pr N`) is the only way a members-only branch's work reaches a public branch, and it can't be undone. Before anything is pushed it lists what becomes public ("3 commits by alice and bob · 14 files"), checks the files for secrets, and asks. By default it **squashes** the branch into one new commit whose author is you: the members-only commits stay members-only, and `--co-authors` adds a `Co-authored-by` line for each other author (their emails become public). `--history` publishes the commits as they are instead; the last one then becomes visibly linked to the branch's members-only activity, so it needs the word `publish` typed. After publishing, `dg branch cleanup` deletes your local branches whose content is published. `dg publish --pr N --make-public` also makes the pull request public, its title, description, comments and reviews (a maintainer's choice); the members-only branch's name stays members-only.
- `dg pr merge` refuses a pull request from a members-only branch and names `dg publish --pr N`, which checks the same branch rules (approvals, checks, merge methods) before anything is published: a merge commit with members-only parents is never made. Merging one into another members-only branch from `dg`, and `dg pr update-branch` or `dg pr suggestion apply` on one, are coming later.
- A pull request for specific people (`--to`) is refused in a private repository.
- `dg repack` consolidates the public packs only; members-only packs are never combined, so publishing one branch never exposes another.

Everyone can still see, for a members-only branch: that a members-only push happened, by whom and when, whether it was forced, that a branch was created or deleted, and which pushes within one key period share a branch; a blinded commit id that links the push to the pull request, its reviews and its checks. For a members-only pull request: as above, and which public branch it targets.

## What it costs

Measured on devnet sakura:

| Action | Cost |
|---|---|
| Turn on members-only content | about 0.0004 DASH, plus about 0.0007 DASH for each member who gets the key (about 0.004 DASH for 5 members) |
| Add a member to a repository with members-only content | the usual membership write, plus about 0.0007 DASH to share the key |
| Remove a member | the usual delete, plus a key change: about 0.0007 DASH per remaining member and about 0.0006 DASH more |
| Post a members-only issue, comment or review | 0 to 8 % more than the same thing in public |
| Post one to specific people | about 8 % more than a members-only one for 2 people, and a little more for each extra person |
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
| A message to specific people (an issue, comment or review) | as a members-only one, and **how many people** it went to | who they are, the group it was sent to, and the text |
| An environment | that the repository has environments and how many; for each change, who made it, when, and its size rounded up to 512 bytes; how many people it was sent to | its name, who it is for, the names, types and notes of its entries, and every value |
| The repository | that members-only content is on; when the members key changed; who shared the key with whom; the member list and roles (public on every repository) | the key |

A review's verdict is public on purpose: everyone agrees on whether a pull request has its approvals, so a member and a non-member see the same merge button. A pull request's author who is not a member sees "Changes requested by @bob" and cannot read why. Add one public line saying what to fix.

## Who can learn what

| Who | Reads members-only content | Learns anyway |
|---|---|---|
| The public, any Dash Platform node, explorers and indexers | no | everything in [What everyone can still see](#what-everyone-can-still-see) |
| Your storage provider (for long members-only text and environments) | no | file sizes, and when files are read |
| A notification service or relay that is not a member, including the hosted one | no | that something happened, by whom, when, and on which issue or pull request; for a message to specific people, how many people it went to, never who |
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
- **Values saved in the old format.** An environment saved by Forge before October 2026 for All members can be read by anyone who becomes a member later, past values included. Save it again (`dg env resave --all`) and change those values where they're used. Environments saved since go only to the people their audience covers at that moment. Change a secret where it's used when someone leaves ([Environments](../guides/environments.md#removing-a-member)).
- **Code.** Everything pushed to a public repository is public, forever, even if you delete it later. The push helper refuses some files that look like secrets and warns about others ([Secrets in a push](../guides/quick-start.md#secrets-in-a-push)), but it cannot know everything. Keep secrets in an environment instead.
- **Your encryption key.** It reads every private repository and every members-only conversation you belong to. Keep it like your signing keys, and replace it after a lost device ([Identity and keys](../guides/identity-and-keys.md#replacing-it-after-a-lost-device)).
- **Mentions.** Mentioning someone who is not a member in a members-only comment tells them nothing they can read, but they may learn that something was posted.

## What this does not protect against

Forge stops accidents, not intent. A member who copies members-only text by hand into a public issue, a commit, an email or anywhere else has published it, and no check can stop that.

The same holds for code: the checks before a push stop a member from publishing members-only commits by accident. A member who copies files by hand into a public branch, or who pushes with `git push --no-verify`, is out of scope. So is a members-only commit made again with a new id (a cherry-pick or a rebase onto a public branch); to be warned about those, turn on `git config dash.patchIdCheck true` in your clone: a push then names each public commit that has the same changes as a members-only one (it still goes ahead). A submodule entry pointing at a members-only commit is allowed, since it shows only the commit's id; the push says so.

## Older Forge builds

People using older Forge builds see fewer things until they update. Nothing leaks and nothing breaks:

- members-only items are left out without saying why, and counts that include them are not labelled;
- a members-only issue opened by its number reads as "not found" (an older `dg` says E102);
- an older web app may describe members-only items as "encrypted by someone who is not a member". That is wrong. Update;
- a message to specific people is a placeholder in builds older than this one, even for the people it was sent to;
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

For an issue sent to specific people the message says so ("issue #14 of alice/shop is for 3 people"): only they can read it, and being a member does not help.

**What to do:** ask the repository's owner to make you a member (run `dg collab accept <owner>/<repo>` first: that is your consent). If you are a member already, see [E311](#e311). If your key is locked (a key protected by a passphrase, with no terminal to ask for it), set `DASH_FORGE_PASSPHRASE` or run the command in a terminal.

A members-only write by someone who is not a member stops with [E601](../errors.md#e601) before anything is signed. A member whose identity has no encryption key gets [E306](../errors.md#e306): set up your encryption key first. Every code is also in [Error codes](../errors.md).

## Words used on this page

Forge uses the same words in `dg`, the web app and these pages.

**Audiences**

| Word | Means |
|---|---|
| **Public** | Everyone can read it. |
| **All members** (short: **Members**) | Everyone with a role in the repository, now and in future. Bots aren't included. |
| **Maintainers** | The owner and the maintainers when it was posted or saved. |
| **Writers and maintainers** | The people with Write access or more when it was posted or saved. |
| **Specific people** | A list the writer picks, up to 16 people for a message. |
| **members-only** | Anything that isn't public. "A members-only comment." |

**Roles:** **Read**, **Triage**, **Write**, **Maintain**, **Owner** and **Bot** (an automated account; coming later). What each can do is [above](#who-can-read-members-only-content).

**Verbs**

| Word | Means |
|---|---|
| **Publish** | Widen code to everyone: `dg publish`. It can't be undone. |
| **Make public** | Widen a post, such as a comment, to everyone. The author does it for their own posts; a maintainer for anyone's. It can't be undone. |
| **Make this repo public** | Widen a whole private repository. It can't be undone: it can never be private again (coming later). |

**Repository kinds:** **Public** and **Private**. "Private" means only a private repository, where everything in it is encrypted. A public repository can hold members-only content, but it is never called private.

**Access** is what a bot or a CI runner is given: what it may post or read, and until when.

**Setting up:** **Turn on members-only content** is what a maintainer does once per repository (`dg repo members enable`). **Set up your encryption key** is what each person does once per identity (`dg auth keys add --encryption`).

**Words Forge doesn't use.** Forge is moving its apps and pages off sealed, lane, named, restricted, reveal, epoch, key letter and disclosure, and off "grant" as a noun. Say "encrypted", "the key changed", "access" or "who can read it" instead.

How it is built: [Private repositories §17](private-repos.md#17-mixed-repositories-members-only-content-in-a-public-repository) and [forge-v2.md §5](../contracts/forge-v2.md#5-private-repositories).
