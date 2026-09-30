# User guides

Task-oriented guides for using Dash Forge. For how it is built, see the [document index](../../README.md#document-index).

| Guide | Read it when you want to… |
|---|---|
| [Quick start](quick-start.md) | install, get an identity, choose storage, publish with `dg init`, push, and see it on the web |
| [Mirror a GitHub repository](mirror-a-github-repo.md) | keep a copy of a GitHub repository that nobody can take down, with the Mirror Action or `forge-import` |
| [Mirror a GitLab project](mirror-a-gitlab-project.md) | the same for a project on gitlab.com or your own GitLab, with a GitLab CI template |
| [Moving from GitHub or GitLab](moving-from-github.md) | move a project over end to end: storage, identity, import, the Mirror Action, cut-over, collaborators, CI and costs |
| [Bring your own storage](bring-your-own-storage.md) | keep pack bytes in your own R2, B2, S3, Storj, self-hosted S3 or IPFS instead of on Platform, from the CLI or the browser |
| [Storage on your home NAS](home-nas-storage.md) | run RustFS or Garage (or kubo) on a Synology, TrueNAS or Linux box, publish it safely with a Cloudflare Tunnel, and keep a second copy |
| [Collaborating](collaborating.md) | add members, work with issues, pull requests, reviews, merges, releases and webhooks |
| [CI and check runs](ci.md) | enrol a CI runner with a key that can only report check runs, report results with `dg ci report`, and see them on commits and PRs |
| [Self-host a CI runner](self-host-runner.md) | run a repository's `.forge/workflows` on your own machine with `forge-runner` (nektos/act in Docker), safely |
| [Identity and keys](identity-and-keys.md) | understand your identity and limited keys, back it up, recover it, and keep keys safe |
| [What things cost](costs.md) | know what each action costs (measured), what comes back, and how to see it before you pay |
| [Check that Forge isn't lying to you](verify-forge.md) | read the Verification card, verify proofs and hashes yourself, and run your own copy of the web app |

Also:

- [FAQ](../FAQ.md): who hosts it, takedowns, moderation, mainnet timing, private repositories.
- [Error codes](../errors.md): what every `[Exxx]` means and how to fix it.
- [Installing](../INSTALL.md) and [building from source](../BUILDING.md).
- [The Mirror Action's reference](../../action/README.md), [the check action's](../../check-action/README.md) and [running a relay](../../crates/forge-relay/README.md).

## What "coming soon" means

These guides describe what is on `master` today. Features that are specified but not built yet are marked **Coming soon**, and nothing marked that way works yet. The main ones:

- prebuilt release binaries and `install.sh` (the pipeline is merged; no release is tagged yet);
- editing files in the browser, and browser merges for private repositories (the CLI has them);
- the `forge.dashhq.org/mirror` setup wizard.

Dash Wallet sign-in is built. With today's wallets it works only in the iOS app pointed at moutai's key-exchange contract (not yet tried on a real device), and on testnet once Forge is deployed there: see [Identity and keys](identity-and-keys.md#signing-in-with-the-dash-wallet-app-what-works-today).

## Which network

The guides use **devnet moutai** (Platform protocol 14) throughout, but **the public devnet is moving to devnet bonsia**: moutai was upgraded in place to Platform v4.2.0-beta.7, which retired its forge-v2 contracts, and forge-v2 is being re-registered on bonsia, the new public devnet, before the guides and [forge.dashhq.org](https://forge.dashhq.org) cut over. Until that happens, neither devnet has a working forge-v2 deployment — don't point at bonsia expecting Forge to work there yet, and expect moutai commands to stop with a "not deployed" error too. Testnet and mainnet run protocol 13 and have no Forge deployment: forge-v2 is registered on testnet when protocol 14 reaches it, and on mainnet after protocol 14 activates there and the owner registers the contracts. See [the network status table](../../README.md#status).

The product specification the planned features come from is [`docs/design/ux-dx-spec.md`](../design/ux-dx-spec.md) and [`docs/roadmap.md`](../roadmap.md).
