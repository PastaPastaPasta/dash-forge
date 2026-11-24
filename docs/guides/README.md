# User guides

Task-oriented guides for using Dash Forge. For how it is built, see the [architecture](../architecture.md).

| Guide | Read it when you want to… |
|---|---|
| [Quick start](quick-start.md) | install, get an identity, choose storage, publish with `dg init`, push, and see it on the web |
| [Mirror a GitHub repository](mirror-a-github-repo.md) | keep a copy of a GitHub repository that nobody can take down: set it up from the browser with the `/mirror` wizard, or by hand with the Mirror Action or `forge-import` |
| [Mirror a GitLab project](mirror-a-gitlab-project.md) | the same for a project on gitlab.com or your own GitLab, with a GitLab CI template |
| [Moving from GitHub or GitLab](moving-from-github.md) | move a project over end to end: storage, identity, import, the Mirror Action, cut-over, collaborators, CI and costs |
| [Bring your own storage](bring-your-own-storage.md) | keep pack bytes in your own S3-compatible bucket or IPFS node instead of on Platform, from the CLI or the browser |
| [Storage on your home NAS](home-nas-storage.md) | run RustFS or Garage in Docker on a NAS or Linux box, give it a public https address, and keep a second copy |
| [Run your own IPFS node](run-your-own-ipfs-node.md) | set up a node with one command (`dg ipfs up`), connect it to the web app, push to it, and keep a copy of someone else's repository with `dg ipfs pin` |
| [Run your own backend](self-host-backend.md) | turn a Linux server, PC or NAS with Docker into storage your repositories push to, with one command (`backend.sh`) |
| [Pin or fork a repository](pin-and-fork.md) | keep a copy of someone else's repository on your own storage: fork it to push your own work, or pin it to help host it (`dg repo pin`) |
| [Collaborating](collaborating.md) | add members, work with issues, pull requests, reviews, merges, releases and webhooks |
| [Organizations](organizations.md) | own repositories with an N-of-M multisig identity from multisig.dashhq.org: connect it, make requests and sign them with `dg org` (testnet) |
| [Boards](boards.md) | plan issues and pull requests on a board: columns, fields, iterations and views, from `dg board` |
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

Wallet sign-in works on mainnet with DashPay for Android 11.9.2+ or Dash Wallet for iOS 9.1.4+, and on testnet with DashPay for Android's testnet build: see [Identity and keys](identity-and-keys.md#signing-in-with-the-dash-wallet-app-what-works-today).

## Which network

The guides use **testnet**, the tools' default, where DASH is free test money and the network can be reset; its web app is [testnet-forge.dashhq.org](https://testnet-forge.dashhq.org). Forge is also live on **mainnet** at [forge.dashhq.org](https://forge.dashhq.org): pass `--network mainnet` to `dg auth new` or `dg auth login` to make it your default. The v0.2.0 binaries work on testnet only and have no `--wallet`; for mainnet or wallet sign-in, build from source. [Networks](../networks.md) has the details.

The product specification the planned features come from is [`docs/design/ux-dx-spec.md`](../design/ux-dx-spec.md) and [`docs/roadmap.md`](../roadmap.md).
