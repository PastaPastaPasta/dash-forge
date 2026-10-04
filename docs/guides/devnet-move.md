# Dash Forge moved from devnet bonsia to devnet sakura

Devnets are development networks, and their operators replace them from time to time. Devnet bonsia (Platform 4.2.0-beta.7) was retired, and **everything on it is gone**. Dash Forge moved to a new devnet, **sakura** (Platform v5.0.0-beta.1), where it is registered with new contracts (RC2, registered 2026-10-01). This page says what that costs you, what you keep, and what to do.

It only concerns **devnet bonsia**, which forge.dashhq.org and the guides used until the move. Nothing on testnet or mainnet is affected, because Forge is not deployed on either yet ([network status](../networks.md)).

## When

- **Before the move**: forge.dashhq.org showed a notice on every page ("bonsia is moving to a new devnet soon").
- **During the move**: until the web app is rebuilt for sakura, a bonsia build says "Dash Forge moved to devnet sakura (Platform v5); bonsia was retired", and writing is paused: buttons that write, including creating or importing an identity, are off and say why. Once bonsia's contracts are gone, the app shows "Dash Forge moved to a new devnet" instead of the repository pages. This lasts until the sakura build is published; reload the page to pick it up. A tab that was opened before keeps running the old page until it is reloaded.
- **After the move**: the web app and `dg` target sakura, and the notice is gone. A build for sakura never shows the "moved" notice or pauses writes, even if the notice variable is still set: that mode only applies to a devnet Forge has left (marked `retired` in its deployment file).

## What is lost

Everything that lived on bonsia's chain:

- **Repositories**: refs, branches, tags, commits' metadata, releases and members.
- **Issues, pull requests, reviews and comments.**
- **Stars, watches and follows.**
- **Your identity and its keys**, and its balance. The test Dash on it was never worth anything, but the identity itself is gone, and so is the limited key `dg` or your browser stored for it.
- **Usernames** (DPNS names) registered on the old chain.

Nothing on bonsia can be recovered: sakura starts empty. If a pull request or issue discussion matters to you, copy it somewhere else now.

## What is kept

- **Your git clone.** A repository you pushed is still complete on your computer: every commit, branch and tag. This is why the move costs you a re-push, not your history.
- **The contents of your storage bucket** (R2, B2, S3, Storj, a NAS, an IPFS node). Forge never held those bytes, and the wipe does not touch them. They stay where they are, but nothing on the new chain points at them until you push again.
- **Your recovery phrase and identity file**, as files. They describe an identity on the old chain, so they are no use on the new one for anything but keeping a record.
- **Your `dg` storage profiles** (`~/.config/dash-forge/storage.toml`).

## What happens to mirrors

Mirrors of public GitHub and GitLab repositories are wiped with everything else, and they do not come back by themselves. A mirror's workflow is pinned to the old repository (`dash://<old identity id>/<name>`), to devnet bonsia and to a build made for Platform 4.2.0-beta.7, and signs with the old identity's key (`DASH_FORGE_KEY`), so its next run fails after the move. To mirror again, create a new identity on sakura and run the **/mirror wizard** once more ([Mirror a GitHub repository](mirror-a-github-repo.md#the-setup-wizard)). Replace the old workflow file with the one it produces and put the new identity's key in `DASH_FORGE_KEY`. A GitLab mirror has no wizard: set its CI job up again from [Mirror a GitLab project](mirror-a-gitlab-project.md#2-keep-it-in-sync-from-gitlab-ci) with the new identity. The first run imports the project again from scratch.

## After the move: re-push your repository

Wait until Forge's contracts are registered on sakura ([network status](../networks.md)) and forge.dashhq.org no longer shows the notice, and make sure `dg` is current. A `dg` built for bonsia (Platform 4.2.0-beta.7) does not work on sakura, so reinstall it from the current source ([Quick start](quick-start.md#1-install); the `dg` and `git-remote-dash` you build must be the ones from the current `master`).

1. **Create a new identity on sakura.** It is a different account: its id is different, so repository addresses (`dash://<identity id>/<name>`) change with it. Follow [Get an identity](quick-start.md#2-get-an-identity), from the terminal (`dg auth new --network devnet --devnet-name sakura`) or from the web app (**Sign in → Create a new identity**). Fund it from the [sakura faucet](https://faucet.sakura.networks.dash.org). The old identity cannot be brought over.
2. **Sign in and set up storage** ([Sign in](quick-start.md#3-sign-in)). Your storage profiles are kept; run `dg storage test <profile>` to check that the bucket still answers.
3. **Keep every branch, then point your clone at the new repository.** A clone often holds some branches only as remote-tracking refs (`origin/feature`), and removing `origin` deletes those. Make a local branch for each one that has none (this never overwrites a local branch):
   ```sh
   cd my-project
   for ref in $(git for-each-ref --format='%(refname)' refs/remotes/origin/); do
     b=${ref#refs/remotes/origin/}
     [ "$b" = HEAD ] || git show-ref --verify --quiet "refs/heads/$b" || git branch "$b" "$ref"
   done
   ```
   The clone's `origin` still names the old address, and `dg init` stops rather than change a remote that points somewhere else. Remove it, then publish:
   ```sh
   git remote remove origin    # the old dash://<old identity>/my-project
   dg init                     # creates the repository on sakura and pushes the current branch
   ```
   **A repository that was private needs `dg init --private`.** `dg init` creates a *public* repository unless you pass `--private`, and visibility cannot be changed afterwards, so a plain `dg init` would publish your private code in the clear. The new identity from `dg auth new` already carries the encryption key a private repository needs ([Private repositories](collaborating.md#private-repositories)). Its members were wiped too: invite each of them again, by the id of the identity they create on sakura.

   A different remote name works too (`dg init --remote forge`), which leaves `origin` alone; use that name instead of `origin` in the next step. `dg init` writes the new remote and the storage setting into the clone's git config, and a plain `git push` goes there afterwards.
4. **Push the rest.** `dg init` pushes the current branch. Push the other branches and the tags to the new remote (`origin` if you removed the old one, or the name you gave `--remote`):
   ```sh
   git push origin --all
   git push origin --tags
   ```
5. **Recreate what lived only on Forge**: members, issues, releases and settings. Your own issues and pull requests are not copied over, so copy anything you still need from your notes.

The push uploads the packs to your bucket again, under the new repository, and costs what any first push costs ([What things cost](costs.md)). The bucket's old contents stay put and can be deleted once you no longer need them.

Anyone who cloned a repository of yours keeps their clone. Tell them the new address.

## Still questions?

- [Quick start](quick-start.md), [Identity and keys](identity-and-keys.md), [Bring your own storage](bring-your-own-storage.md), [FAQ](../FAQ.md).
- Why a devnet can be wiped: [Networks](../networks.md).
