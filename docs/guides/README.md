# User guides

Task-oriented guides for using Dash Forge. For how it is built, see the [document index](../../README.md#document-index).

| Guide | Read it when you want to… |
|---|---|
| [Quick start](quick-start.md) | install, get an identity, choose storage, publish with `dg init`, push, and see it on the web |
| [Mirror a GitHub repository](mirror-a-github-repo.md) | keep a copy of a GitHub repository that nobody can take down: set it up from the browser with the `/mirror` wizard, or by hand with the Mirror Action or `forge-import` |
| [Mirror a GitLab project](mirror-a-gitlab-project.md) | the same for a project on gitlab.com or your own GitLab, with a GitLab CI template |
| [Moving from GitHub or GitLab](moving-from-github.md) | move a project over end to end: storage, identity, import, the Mirror Action, cut-over, collaborators, CI and costs |
| [Bring your own storage](bring-your-own-storage.md) | keep pack bytes in your own R2, B2, S3, Storj, self-hosted S3 or IPFS instead of on Platform, from the CLI or the browser |
| [Storage on your home NAS](home-nas-storage.md) | run RustFS or Garage (or kubo) on a Synology, TrueNAS or Linux box, publish it safely with a Cloudflare Tunnel, and keep a second copy |
| [Run your own IPFS node](run-your-own-ipfs-node.md) | set up a node with one command (`dg ipfs up`), connect it to the web app, push to it, and keep a copy of someone else's repository with `dg ipfs pin` |
| [Collaborating](collaborating.md) | add members, work with issues, pull requests, reviews, merges, releases and webhooks |
| [Bots and agents](bots.md) | add a bot, say what it may do, ask an agent to work on an issue or pull request, and give it push access to chosen branches (beta) |
| [Who can read what](../security/audiences.md) | keep issues, comments and reviews of a public repository members-only, and know who can read them, what everyone still sees and what can still leak |
| [Environments](environments.md) | keep configuration and secrets outside git, encrypted for your maintainers or members, and inject them with `dg env run` |
| [CI and check runs](ci.md) | enrol a CI runner with a key that can only report check runs, report results with `dg ci report`, and see them on commits and PRs |
| [Self-host a CI runner](self-host-runner.md) | run a repository's `.forge/workflows` on your own machine with `forge-runner` (nektos/act in Docker), safely |
| [Identity and keys](identity-and-keys.md) | understand your identity and limited keys, back it up, recover it, and keep keys safe |
| [If Forge tells you to revoke keys](revoke-keys.md) | disable every signing key of your identity but the one in use at once, from the terminal (`dg auth keys disable --all-limited`) or the web app (Devices & keys), and sign in again |
| [My first push failed](first-push-troubleshooting.md) | find the fix for the errors a first push usually hits: no network, no credits, the cost guard, no storage, a moved name, a locked key, shallow clones and LFS |
| [What things cost](costs.md) | know what each action costs (measured), what comes back, and how to see it before you pay |
| [Check that Forge isn't lying to you](verify-forge.md) | read the Verification card, verify proofs and hashes yourself, and run your own copy of the web app |
| [Verify the app you loaded](verify-the-app.md) | pin a release's IPFS build of the web app, rebuild its CID from the tag, and compare it with the GitHub release and the Forge release on chain |

Also:

- [FAQ](../FAQ.md): who hosts it, takedowns, moderation, mainnet timing, private repositories, and [what Forge doesn't do (yet)](../FAQ.md#what-doesnt-forge-do-yet).
- [Hosted curation](../hosted-curation.md): what dashhq's own site leaves out of its lists, and what that does not change.
- [Limits](../limits.md): sizes, counts and caps, with where each comes from.
- [Error codes](../errors.md): what every `[Exxx]` means and how to fix it.
- [Installing](../INSTALL.md) and [building from source](../BUILDING.md).
- [The Mirror Action's reference](../../action/README.md), [the check action's](../../check-action/README.md) and [running a relay](../../crates/forge-relay/README.md).

## What "coming soon" means

These guides describe what is on `master` today. Features that are specified but not built yet are marked **Coming soon**, and nothing marked that way works yet. The main ones:

- editing files in the browser, and, for private repositories, merges, branch commits, Update branch and applying suggestions in the browser (the CLI has them);
- members-only releases in a public repository (a private repository's releases are encrypted and work);
- in the web app, starting or pushing a members-only branch, publishing a branch for fewer people than all members, and sharing a members-only branch outside the members (`dg` has them).

Members-only issues, comments and reviews, messages to specific people, making posts public, members-only branches and pull requests, environments, and bots are built, in `dg` and the web app. What can be members-only, and who reads it, is in [Who can read what](../security/audiences.md), the single place to check. The features still marked **Beta** (narrower branches, branch sharing, bots and agents, bot push access, making a repository public, publication dates) work but have rough edges: [Known limitations](collaborating.md#known-limitations).

Dash Wallet sign-in is built. With today's wallets it works only in the iOS app pointed at Forge's key-exchange contract on sakura (not yet tried on a real device), and on testnet once Forge is deployed there: see [Identity and keys](identity-and-keys.md#signing-in-with-the-dash-wallet-app-what-works-today).

## Which network

The guides use **devnet sakura**, a test network, throughout; [forge.dashhq.org](https://forge.dashhq.org) runs on it too. Fees quoted as measured on bonsia or moutai are from those retired devnets. Testnet and mainnet have no Forge deployment yet. [Networks](../networks.md) has the details and the history.

The product specification the planned features come from is [`docs/design/ux-dx-spec.md`](../design/ux-dx-spec.md) and [`docs/roadmap.md`](../roadmap.md).
