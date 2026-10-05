# Members-only content and the notification service

A note for whoever runs the hosted notification service (forge-notify, run by dashhq) or any
other service that turns Forge activity into email, push or chat notices, including a
self-hosted `forge-relay` with sinks.

A **public** repository can hold members-only issues, pull requests, comments and reviews. Their
text is encrypted on chain for the repository's members, with the scheme private repositories
use (`docs/security/private-repos.md`). Anyone can still see that such a document exists, who
wrote it, when, and which issue or pull request it belongs to. The service is not a member and
holds no repository key.

## What the service sees

- **Members-only content:** only that something happened. For each document: the repository, the
  kind (issue, pull request, comment, review, label or assignment), the issue or pull request
  number, the author and the time. A review's verdict (approved, changes requested, commented)
  is public too. Titles, bodies, label names and branch names are not readable.
- **Messages to specific people** (a later phase): the same, plus how many people a message is
  addressed to. Who they are is inside the encrypted part. The service therefore **cannot route**
  such a message to its recipients and must not try. Telling someone "you were sent a message" is
  done by the recipient's own inbox in the web app, which opens the message locally.

## The rule to apply

The same rule as the web app's inbox and thread pages:

1. **An issue or pull request** that is members-only always produces a notice to the people who
   follow the repository, whoever opened it: "@alice opened members-only issue #12". Its number is
   public anyway.
2. **A comment or review** that is members-only produces a notice only when the document carries
   `asMember` naming its author (consensus admits that only from a current member). Without it,
   it is encrypted text that anyone may post and no member's client shows: send nothing, and do
   not count its author as a participant in the thread.
3. **A notice never contains members-only text.** Say what happened, not what was said:
   "@alice posted a members-only comment on #12", "@bob approved #7 in a members-only review".
   Never quote an empty body, and never write "sealed" or "encrypted by" in a notice.
4. **A members-only release or branch update** produces no notice.

`forge-relay` already applies rules 1, 2 and 4 to the events it hands to sinks and to forge-notify.
It marks members-only events with `"dash_members_only": true`: at the top level when the event's
own document is members-only, and on the embedded `issue` or `pull_request` when that thread is
(see "Members-only content" under Payloads in `crates/forge-relay/README.md`). A notice renderer
uses the key to choose the wording in rule 3. A service that reads the chain directly instead
must apply the same rules itself.
