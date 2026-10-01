# Devnet bonsia is moving to a new devnet

Devnet bonsia is a development network, and its operators re-cut it from time to time. Bonsia is about to be re-cut onto Platform v5, which **wipes everything on it**. Dash Forge is then registered again on the new bonsia, with new contracts. This page says what that costs you, what you keep, and what to do afterwards.

It only concerns **devnet bonsia**, which forge.dashhq.org and the guides use today. Nothing on testnet or mainnet is affected, because Forge is not deployed on either yet ([network status](../../README.md#status)).

## When

- **Before the move**: forge.dashhq.org shows a notice on every page ("bonsia is moving to a new devnet soon"). Everything still works, but anything you write now will be wiped.
- **During the move**: from the wipe until the web app is rebuilt for the new devnet, forge.dashhq.org says so. While the notice says writing is paused, buttons that write are off and say why, and once the chain is wiped the app reports that Forge is not deployed there yet. This lasts until a new build is published; reload the page to pick it up.
- **After the move**: the web app and `dg` target the new devnet. The notice is gone.

## What is lost

Everything that lived on the old devnet's chain:

- **Repositories**: refs, branches, tags, commits' metadata, releases and members.
- **Issues, pull requests, reviews and comments.**
- **Stars, watches and follows.**
- **Your identity and its keys**, and its balance. The test Dash on it was never worth anything, but the identity itself is gone, and so is the limited key `dg` or your browser stored for it.
- **Usernames** (DPNS names) registered on the old chain.

Nothing on the old devnet can be recovered afterwards: the new chain starts empty. If a pull request or issue discussion matters to you, copy it somewhere else now.

## What is kept

- **Your git clone.** A repository you pushed is still complete on your computer: every commit, branch and tag. This is why the move costs you a re-push, not your history.
- **The contents of your storage bucket** (R2, B2, S3, Storj, a NAS, an IPFS node). Forge never held those bytes, and the wipe does not touch them. They stay where they are, but nothing on the new chain points at them until you push again.
- **Your recovery words and identity file**, as files. They describe an identity on the old chain, so they are no use on the new one for anything but keeping a record.
- **Your `dg` storage profiles** (`~/.config/dash-forge/storage.toml`).

## What happens to mirrors

Mirrors of public GitHub and GitLab repositories do not depend on your clone. They are re-imported on the new devnet, by their owners or by the Mirror Action on its next run ([Mirror a GitHub repository](mirror-a-github-repo.md)). A mirror's Action workflow signs with an identity's key (`DASH_FORGE_KEY` in the repository's secrets, [the Action's reference](../../action/README.md)), so after the move it needs the key of an identity created on the new devnet.

## After the move: re-push your repository

Wait until forge.dashhq.org no longer shows the notice, and make sure `dg` is current. A `dg` built for the old devnet (Platform 4.2.0-beta.7) stops working on the new one, so reinstall it from the current source ([Quick start](quick-start.md#1-install); the `dg` and `git-remote-dash` you build must be the ones from the current `master`).

1. **Create a new identity on the new devnet.** It is a different account: its id is different, so repository addresses (`dash://<identity id>/<name>`) change with it. Follow [Get an identity](quick-start.md#2-get-an-identity), from the terminal (`dg auth new --network devnet --devnet-name bonsia`) or from the web app (**Sign in → Create a new identity**). Fund it from the faucet, as before. The old identity cannot be brought over.
2. **Sign in and set up storage** ([Sign in](quick-start.md#3-sign-in)). Your storage profiles are kept; run `dg storage test <profile>` to check that the bucket still answers.
3. **Point your clone at the new repository.** Its `origin` still names the old address, and `dg init` stops rather than change a remote that points somewhere else. Remove it first:
   ```sh
   cd my-project
   git remote remove origin    # the old dash://<old identity>/my-project
   dg init                     # creates the repository on the new devnet and pushes the current branch
   ```
   A different remote name works too (`dg init --remote forge`), which leaves `origin` alone. `dg init` writes the new remote and the storage setting into the clone's git config, and a plain `git push` goes there afterwards.
4. **Push the rest.** `dg init` pushes the current branch. Push other branches and tags as usual:
   ```sh
   git push origin --all
   git push origin --tags
   ```
5. **Recreate what lived only on Forge**: members, issues, releases and settings. Your own issues and pull requests are not copied over, so copy anything you still need from your notes.

The push uploads the packs to your bucket again, under the new repository, and costs what any first push costs ([What things cost](costs.md)). The bucket's old contents stay put and can be deleted once you no longer need them.

Anyone who cloned a repository of yours keeps their clone. Tell them the new address.

## Still questions?

- [Quick start](quick-start.md), [Identity and keys](identity-and-keys.md), [Bring your own storage](bring-your-own-storage.md), [FAQ](../FAQ.md).
- Why a devnet can be wiped: [the network status table](../../README.md#status).
