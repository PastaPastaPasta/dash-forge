# Hosted curation: what dashhq's site hides, and what that means

The web app dashhq hosts at forge.dashhq.org can leave repositories and identities out of what they list and show. This page says how, and what it does not do. It describes mechanics. It is not a legal policy.

## What it is, and what it is not

It is a list that **one operator's builds** read. Hidden items do not appear in that build's discovery pages, and their repository pages show "Not shown on this site".

It is **not protocol moderation**:

- The repository, its refs, issues and pull requests stay on Dash Platform. Nothing is deleted, and no identity is banned. The Forge contracts are registered without Platform's contract moderation ([FAQ](FAQ.md#is-there-any-moderation)).
- `git clone dash://<repo id>` and every `dg` command still work.
- Any other build of the web app, other clients and other gateways show the repository as before. The web app is a static bundle that anyone can build and host ([run your own copy](guides/verify-forge.md#run-your-own-copy-of-the-web-app)), and their lists are their own.

## What hiding does in the web app

For a hidden repository id, or any repository owned by a hidden identity id, the dashhq web build:

- leaves it out of the landing page (featured, recent), Explore (recent, search, topics, Trending, Most starred, Most forked and Recently updated), the jump box, and the `/github.com/<owner>/<repo>` mirror lookup;
- shows "Not shown on this site" instead of any page of the repository. The notice gives a clone line that addresses the repository by its id (`dash://<repo id>`, with this build's network set) and says the repository still exists on Dash Platform. To know the owner, the build reads the repository like any other page (its name lookup and one request that includes its counts and ref list), then renders none of it. It does not open its code, issues or other content;
- on a hidden identity's profile page, shows the same notice in place of its repository list and does not read or show its profile details (bio, links, bot info). Its name, follow counts and id still show.

What it does not touch: a signed-in person's own "My repos", "Repos I maintain or write to" and "Starred" lists, and the notification inbox. Those are the person's own data, not discovery. Links from visible pages are not rewritten either: a visible fork still names its hidden parent, and stargazer and follower lists can include hidden identities.

Rankings are unweighted counts (see Explore): Most forked ignores forks made by hidden identities, but stars from hidden identities still count toward a visible repository's stars, because telling them apart would take a read per stargazer.

## The file

The list is [`forge-contracts/config/curation.json`](../forge-contracts/config/curation.json). The web build imports it at build time, the same way it imports the shared storage defaults. There is no runtime service and no server state: a change ships with a deploy.

```json
{
  "networks": {
    "testnet": {
      "hiddenRepos": [{ "id": "<repo document id>", "added": "2026-10-16", "note": "short public reason or ticket" }],
      "hiddenIdentities": []
    }
  }
}
```

- The keys under `networks` are the build's network key: `testnet`, `devnet-sakura` or `mainnet`. A build reads only its own network's entry.
- `id` is a base58 Platform identifier: a `repo` document id for `hiddenRepos`, an identity id for `hiddenIdentities`.
- `added` is a `YYYY-MM-DD` date. `note` is a short public reason or a ticket reference, up to 200 characters. The file is public in the repository and in its history, so do not put personal data in it.
- A malformed entry fails the build and the unit tests (`forge-web/lib/view/curation.test.ts`), so a typo cannot reach the site.

## How an entry is added

1. A request reaches the contact in [SECURITY.md](../SECURITY.md). Use GitHub's private reporting there. Give the repository or identity id and what the problem is.
2. A maintainer decides. If the request is accepted, they open a pull request that adds the entry to `curation.json` on the right network.
3. The merge deploys the web app: `.github/workflows/pages.yml` runs on changes under `forge-contracts/config/`. The entry takes effect when that deploy finishes. A tab opened before the deploy keeps running the old build until it is reloaded.
4. Removing an entry is the same pull request in reverse.

Every entry carries its date and reason.

## The gateway

dashhq's gateway ([`git-forge.dashhq.org`](hosting/forge-gateway.md)) reads the same file, compiled into its image. Hiding changes only its link previews: a hidden repository's (or hidden identity's) share link and card are the site's own, naming nothing of it. Its clones, badges and feeds are still served. A different, operator-only list, `GATEWAY_DENY`, makes the gateway refuse a repository or owner outright with `451 Unavailable For Legal Reasons`, delete its cached mirror, and point at `git clone dash://…`. Both are the gateway operator's choice, not protocol moderation. The file format, reload behaviour and runbook are in [Takedowns and hidden repositories](hosting/forge-gateway.md#takedowns-and-hidden-repositories).

## Verifying what a build hides

The list is public: read `forge-contracts/config/curation.json` at the commit a build was made from ([verify the app you loaded](guides/verify-the-app.md)). A build with an empty list hides nothing.
