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
| [Collaborating](collaborating.md) | add members, work with issues, pull requests, reviews, merges, releases and webhooks |
| [Who can read what](../security/audiences.md) | keep issues, comments and reviews of a public repository members-only, and know who can read them, what everyone still sees and what can still leak |
| [Environments](environments.md) | keep configuration and secrets outside git, encrypted for your maintainers or members, and inject them with `dg env run` |
| [CI and check runs](ci.md) | enrol a CI runner with a key that can only report check runs, report results with `dg ci report`, and see them on commits and PRs |
| [Self-host a CI runner](self-host-runner.md) | run a repository's `.forge/workflows` on your own machine with `forge-runner` (nektos/act in Docker), safely |
| [Identity and keys](identity-and-keys.md) | understand your identity and limited keys, back it up, recover it, and keep keys safe |
| [What things cost](costs.md) | know what each action costs (measured), what comes back, and how to see it before you pay |
| [Check that Forge isn't lying to you](verify-forge.md) | read the Verification card, verify proofs and hashes yourself, and run your own copy of the web app |
| [Dash Forge moved to devnet sakura](devnet-move.md) | know what the move from bonsia lost (repos, issues, stars, identities, keys) and kept (your clone, your bucket), and how to re-push on sakura with `dg` |
| [Verify the app you loaded](verify-the-app.md) | pin a release's IPFS build of the web app, rebuild its CID from the tag, and compare it with the GitHub release and the Forge release on chain |

Also:

- [FAQ](../FAQ.md): who hosts it, takedowns, moderation, mainnet timing, private repositories.
- [Error codes](../errors.md): what every `[Exxx]` means and how to fix it.
- [Installing](../INSTALL.md) and [building from source](../BUILDING.md).
- [The Mirror Action's reference](../../action/README.md), [the check action's](../../check-action/README.md) and [running a relay](../../crates/forge-relay/README.md).

## What "coming soon" means

These guides describe what is on `master` today. Features that are specified but not built yet are marked **Coming soon**, and nothing marked that way works yet. The main ones:

- editing files in the browser, and browser merges for private repositories (the CLI has them);
- in the web app: choosing Members for a new issue or comment, turning members-only content on, the members-only rows non-members see, **View as public**, and Settings → Environments (`dg` has the rest);
- members-only pull requests, branches and releases, Specific people, and making other people's posts public.

Dash Wallet sign-in is built. With today's wallets it works only in the iOS app pointed at Forge's key-exchange contract on sakura (not yet tried on a real device), and on testnet once Forge is deployed there: see [Identity and keys](identity-and-keys.md#signing-in-with-the-dash-wallet-app-what-works-today).

## Which network

The guides use **devnet sakura**, a test network, throughout; [forge.dashhq.org](https://forge.dashhq.org) runs on it too. Fees quoted as measured on bonsia or moutai are from those retired devnets. Testnet and mainnet have no Forge deployment yet. [Networks](../networks.md) has the details and the history.

The product specification the planned features come from is [`docs/design/ux-dx-spec.md`](../design/ux-dx-spec.md) and [`docs/roadmap.md`](../roadmap.md).
