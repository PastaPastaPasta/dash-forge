# Dash Forge moved to testnet

Until October 2026, Dash Forge ran on development networks (devnets), which their operators replace from time to time. Its contracts were registered on **testnet** on 2026-10-26, and forge.dashhq.org, `dg` and the guides use testnet from then on. Nothing moved with it from the last devnet, which is down and is not coming back. This page says what that costs you, what you keep, and what to do. [Networks](../networks.md) has the history.

## What is lost

Everything that lived on the devnet's chain: repositories (refs, releases, members), issues, pull requests, reviews and comments, stars, watches and follows, usernames, and your identity with its keys and balance. The test Dash on it was never worth anything. None of it can be recovered: testnet started empty.

## What is kept

- **Your git clone**, with every commit, branch and tag. The move costs you a re-push, not your history.
- **The contents of your storage bucket or IPFS node.** Forge never held those bytes. Nothing on testnet points at them until you push again.
- **Your `dg` storage profiles** (`~/.config/dash-forge/storage.toml`).
- **Your recovery phrase and identity file**, as files. They describe an identity on the devnet, so they open nothing on testnet.

## Re-push your repository

Install the current `dg` and `git-remote-dash` first ([Quick start](quick-start.md#1-install)): tools built for a devnet do not know Forge's testnet contracts.

1. **Create an identity on testnet**: `dg auth new --network testnet`, which also records testnet as your default in place of the devnet, or **Sign in → Create a new identity** in the web app ([Get an identity](quick-start.md#2-get-an-identity)). Fund it from the [Dash testnet faucet](https://faucet.testnet.networks.dash.org) or [faucet.thepasta.org](https://faucet.thepasta.org). It is a new account with a new id, so your repository addresses (`dash://<identity id>/<name>`) change.
2. **Clear the devnet from your git config.** `dg init` wrote `dash.network` and `dash.devnetName` into a clone when the devnet was not the default, and you may have set them globally. Remove them so git uses testnet, the default:
   ```sh
   cd my-project
   git config --unset dash.network; git config --unset dash.devnetName
   git config --global --unset dash.network; git config --global --unset dash.devnetName
   ```
   An unset key that was never set prints nothing and does no harm.
3. **Keep every branch, then point the clone at the new repository.** Make a local branch for each remote-tracking branch that has none, then remove the old remote and publish:
   ```sh
   for ref in $(git for-each-ref --format='%(refname)' refs/remotes/origin/); do
     b=${ref#refs/remotes/origin/}
     [ "$b" = HEAD ] || git show-ref --verify --quiet "refs/heads/$b" || git branch "$b" "$ref"
   done
   git remote remove origin    # the old dash://<old identity>/my-project
   dg init                     # creates the repository on testnet and pushes the current branch
   git push origin --all && git push origin --tags
   ```
   **A repository that was private needs `dg init --private`.** A plain `dg init` creates a public repository, and visibility cannot be changed afterwards.
4. **Recreate what lived only on Forge**: members (by the ids of the identities they create on testnet), issues, releases and settings.

The push uploads your packs to your bucket again, under the new repository, and costs what any first push costs ([What things cost](costs.md)). The bucket's old contents can be deleted once you no longer need them.

## Mirrors

A mirror's workflow still names the old repository, the devnet and the old identity's key, so its next run fails. Run the **/mirror wizard** again with your testnet identity ([Mirror a GitHub repository](mirror-a-github-repo.md#the-setup-wizard)), replace the workflow file with the one it writes, and put the new key in `DASH_FORGE_KEY`. A GitLab mirror: set its CI job up again from [Mirror a GitLab project](mirror-a-gitlab-project.md#2-keep-it-in-sync-from-gitlab-ci). The first run imports everything again.

An earlier move between two devnets is described in the [archive](../archive/devnet-move.md).
