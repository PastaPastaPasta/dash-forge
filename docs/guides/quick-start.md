# Quick start

This guide takes you from nothing to a repository on Dash Forge that you can clone, push to and browse on the web. It uses **devnet moutai**, where Dash is free, so you can try everything without spending real money.

You will:

1. [Install `dg` and `git-remote-dash`](#1-install)
2. [Get a Dash identity](#2-get-an-identity)
3. [Sign in with `dg auth login`](#3-sign-in)
4. [Create a repository](#4-create-a-repository)
5. [Push to it](#5-push)
6. [View it on the web](#6-view-it-on-the-web)

Replace every `<…>` placeholder in the commands with your own value before running them; the shell reads a bare `<` or `>` as a redirection.

Allow about 15 minutes. Most of it is the first build, or waiting for the network to confirm your identity.

> **Which network?** Forge (forge-v2) needs Platform protocol 14, which only devnet **moutai** runs today. Testnet gets a deployment when protocol 14 reaches it, and mainnet after protocol 14 activates there. On a network without a deployment the tools stop with a "not deployed" error. See [the network status table](../../README.md#status).

---

## 1. Install

You need two programs on your `PATH`:

- `dg`: the command-line tool, shaped like GitHub's `gh`;
- `git-remote-dash`: the git remote helper. Git runs it whenever a URL starts with `dash://`.

### Build from source (works today)

You need Rust (the repository pins the version; rustup installs it for you) and `protoc` 25 or newer. [BUILDING.md](../BUILDING.md) explains both.

```sh
git clone https://github.com/PastaPastaPasta/dash-forge && cd dash-forge
cargo install --locked --path crates/dg
cargo install --locked --path crates/git-remote-dash
```

`cargo install` puts both binaries in `~/.cargo/bin`, which rustup already added to your `PATH`.

### Prebuilt binaries

**Coming soon:** the release pipeline is merged, but no release has been tagged yet. After the first release, this one line will install checksum-verified binaries into `~/.local/bin`:

```sh
curl -fsSL https://raw.githubusercontent.com/PastaPastaPasta/dash-forge/master/install.sh | sh
```

[INSTALL.md](../INSTALL.md) covers manual downloads, attestations and Windows.

### Check the install

```sh
dg --version
dg doctor
```

`dg doctor` checks git, the helper, the network and your identity. At this point it warns that no identity is configured. That is the next step.

---

## 2. Get an identity

A Dash Platform **identity** is your account on Forge. It holds your keys and your credit balance. Nobody issues it to you: you create it yourself by locking some Dash. [Identity and keys](identity-and-keys.md) explains what it is.

**Forge never funds or creates identities for you.** Create one from the terminal:

```sh
dg auth new --network devnet --devnet-name moutai
```

1. `dg` shows **12 recovery words**. Write them down, in order, and keep them offline: they are the identity, and nobody can recover it without them. It asks you to type three of them back.
2. It shows a deposit address as a QR code and as text. Send 0.05 DASH to it from any Dash wallet; on devnet moutai use the faucet at <https://faucet.moutai.networks.dash.org>. A repository costs about 0.001 DASH.
3. `dg` waits for the deposit, locks it, registers the identity, and stores a **limited key** for this computer in your OS keychain: it can spend at most 0.25 DASH, only on Forge, for 180 days. The master key is not stored anywhere.

```
✓ identity 8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB created on devnet-moutai
  key #5: limited, 0.25 DASH budget, only on Dash Forge, expires in 180 day(s)
  stored in macOS Keychain (dash-forge/devnet-moutai/8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB)
  balance 0.0499 DASH
```

On a devnet the deposit is proven with a chain lock, which takes a few minutes. If `dg` is interrupted, `dg auth new --resume` continues with the same deposit address.

> **Mainnet.** Fund the deposit from any Dash wallet. There is no faucet on mainnet. Forge itself is not on mainnet yet.

You can also create an identity in the web app (**Sign in → Create a new identity**) or with the Dash bridge (<https://bridge.thepasta.org/?network=devnet-moutai>). All three derive the same keys from the same words.

---

## 3. Sign in

`dg auth new` signs you in. With an identity you already have (a bridge `dash-identity-<id>.json`, or the 12 words), sign in once per computer:

```sh
dg auth login --network devnet --devnet-name moutai ~/Downloads/dash-identity-<id>.json
# or: dg auth login --network devnet --devnet-name moutai --mnemonic
```

```
✓ signed in as 8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB on devnet-moutai
  key #6: limited, 0.25 DASH budget, expires in 180 day(s)
  stored in macOS Keychain (dash-forge/devnet-moutai/8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB)
```

The identity file's master key signs one update that registers a limited key for this computer, and `dg` stores only that key. Afterwards put the identity file somewhere offline. `dg` records the identity and the network as defaults, and `git push` reads the same stored key, so neither needs flags or environment variables.

`git-remote-dash` still needs the network for a repository `dg` did not set up (`dg init` and `dg repo create --push` write it into the repository's git config). Add it to your shell profile if you clone by hand:

```sh
export DASH_FORGE_NETWORK=devnet
export DASH_FORGE_DEVNET_NAME=moutai
```

Then check everything:

```sh
dg auth status      # identity, key, budget left, expiry, balance, where the key is stored
dg doctor
```

`dg doctor --fix` also sets `git config --global dash.costWarnThreshold 0.01` if you have no threshold yet, so that pushes ask before spending more than 0.01 DASH. It never spends anything.

Your identity id is the long base58 string, such as `8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB`. You will use it in repository addresses. A DPNS username is optional: `dg auth name register <label>`.

---

## 4. Create a repository

`dg` creates **forge-v2** repositories: three small documents, about **0.001–0.002 DASH**. forge-v2 runs on devnet moutai today (`--network devnet --devnet-name moutai`); on a network without it, `dg repo create` stops with [E702](../errors.md#e702) before spending anything.

First decide where your pushes store their packs. Your own bucket or IPFS node is cheap; Dash Platform costs about **0.28 DASH per MiB**, permanently. `dg storage add` with no arguments asks for each value and tests the storage (see [Bring your own storage](bring-your-own-storage.md#the-quick-way-dg-storage-add-asks)):

```sh
dg storage add            # e.g. a profile named r2-main; offers to make it your default
```

Then, inside the repository you want to publish:

```sh
cd my-project
dg init                   # = dg repo create --push, for this directory
```

```
Creating 8hJm…/my-project on devnet-moutai
  repo + maintainer + config     ~0.002 DASH ≈ $0.06
  packs → r2-main (1 of 1 must confirm); Platform: manifest + refs only
  (storage: git config dash.storage)
Proceed? [Y/n] y
✓ created  https://forge.dashhq.org/repo?owner=8hJm…&name=my-project
✓ remote 'origin' → dash://8hJm…/my-project
✓ git config dash.storage=r2-main
dash: 8hJm…/my-project ← main (8f3e2a1, 312 objects, 1.2 MiB)
dash: r2-main      ████████████████ 1.2 MiB  verified   0.4 s
dash: platform     manifest 2 · refUpdate 1     est 0.000275 DASH
dash: done · Platform charged ≈0.00028 DASH · remaining 0.4812 DASH · https://forge.dashhq.org/repo?owner=8hJm…&name=my-project
✓ main → 8f3e2a1   this push ~0.00028 DASH ≈ $0.01
  total ~0.0016 DASH ≈ $0.05 (create ~0.0013 DASH ≈ $0.04 + push ~0.00028 DASH ≈ $0.01) · balance 0.4812 DASH
Open it: https://forge.dashhq.org/repo?owner=8hJm…&name=my-project
```

A repository is three small documents in Forge's shared contracts: the `repo` itself, your `maintainer` membership, and the first `config`. The estimate is an upper bound; the measured cost, about **0.001 DASH**, is printed after the create lands. See [Costs](costs.md).

What it does, in order:

- **Picks the storage before spending anything**: `--storage <profiles>` (comma-separated; `platform` is built in), else `dash.storage` from git config (this repository's, then your global one), else your only storage profile. With none, it stops and prices the alternative: *"No storage profile. Packs would go to Platform at ~0.28 DASH/MiB (1.2 MiB ≈ 0.34 DASH). Run `dg storage add` first, or pass `--storage platform` to accept that price."* ([E508](../errors.md#e508)). In a terminal it offers a picker instead.
- **Creates the repository**, named after the directory unless you pass `--name` (`dg repo create <name>`). Its first config records where the packs live, so readers and the web app know where to look.
- **Adds the remote** `origin` (`--remote <name>` for another). If `origin` already points somewhere else it stops ([E206](../errors.md#e206)) rather than changing it.
- **Writes this repository's git config**: `dash.storage` (and `dash.replicas` with `--replicas`), plus `dash.network` / `dash.devnetName` when `git push` would otherwise pick a different network than `dg`. From now on a plain `git push` goes to the same place.
- **Checks the storage secrets resolve**, before anything is created, so a push that could not sign never follows a paid create.
- **Pushes the current branch** with `-u`, unless the branch already tracks another remote: an existing GitHub `origin` stays the upstream when the Forge remote is `--remote forge`. A repository with no commits yet is created and configured, and the push is skipped.

It is safe to run again: an existing repository is reused (nothing written), a matching remote is left alone, and an up-to-date branch pushes nothing. `--yes` skips the question (and the push's cost guard); `--json` prints one object with `repoId`, `remoteUrl`, `webUrl`, `storage`, the pushed branch and commit, and the costs.

`dg repo create <name>` without `--push` only creates the repository and prints the `dg init` line that would finish the job (`--remote` needs `--push`). A re-run of `dg init` without `--name` takes the name from an existing `dash://` remote of yours, so it finds the same repository.

Names are 1–63 characters: lowercase letters, digits, `.`, `_` and `-`, starting with a letter or digit. A directory name is folded to that form (`My Project` → `my-project`).

---

## 5. Push

After `dg init`, pushing is plain git:

```sh
git push
```

To push to a repository someone created without `dg init` (or from another clone), add the remote yourself:

```sh
git remote add origin dash://<owner identity id>/my-project
git push -u origin main
```

Or start from an empty directory:

```sh
git clone dash://<your identity id>/my-project
cd my-project
git switch -c main                  # an empty clone has no branch yet
echo "# my-project" > README.md
git add README.md && git commit -m "first commit"
git push -u origin main
```

The helper prints what it will store, and where, before it pays for anything. It ends with what Platform charged:

```
dash: 8hJm…/my-project ← main (8f3e2a1, 3 objects, 245 B)
dash: storage      → Platform chunks · Platform stores pack + manifest + refs, est 0.0006 DASH
dash: platform     chunk 1 · manifest 2 · refUpdate 1 est 0.0006 DASH
dash: done · Platform charged ≈0.0006 DASH · remaining 0.8192 DASH · https://forge.dashhq.org/repo?owner=8hJm…&name=my-project
```

(The numbers are illustrative. Yours depend on the size of the push.)

A repository without `dash.storage` stores its pack bytes on Dash Platform, which costs about **0.28 DASH per MiB**. For anything bigger than a toy, keep the packs in your own bucket or IPFS node instead. Then Platform stores only the small manifest and the ref update. [Bring your own storage](bring-your-own-storage.md) has the setup for R2, B2, S3, MinIO and IPFS:

```sh
dg storage add r2-main --kind s3 …     # once
dg storage test r2-main
dg storage use r2-main                 # in this repo: packs go to r2-main
```

If you ran `dg doctor --fix`, a push already asks before it spends more than 0.01 DASH. To choose another threshold:

```sh
git config --global dash.costWarnThreshold 0.05
```

Everything else is plain git: branches, tags, force-push, `git fetch`, `git clone --filter=blob:none`. jj works too. Shallow clones (`--depth`) are not supported and fail with a clear error.

---

## 6. View it on the web

Open the link from the push's last line, or build it yourself:

```
https://forge.dashhq.org/repo?owner=<your identity id>&name=my-project
```

The web app has no server behind it. Your browser reads the repository straight from Dash Platform, checks the Platform proofs, and re-hashes every file it shows. The **Assay** panel on the right says what was checked. [Verify Forge](verify-forge.md) explains it.

Browsing and cloning are free and need no sign-in. To file an issue from the browser, choose **Sign in**. The web app registers a limited key for this browser (a small budget, an expiry, usable only on Forge) and keeps it encrypted; your master key is used once and not stored. [Identity and keys](identity-and-keys.md#limited-keys) explains the options.

---

## Next steps

- [Mirror a GitHub repository](mirror-a-github-repo.md) so it can't be taken down.
- [Collaborate](collaborating.md): collaborators, issues, pull requests, releases.
- [Identity and keys](identity-and-keys.md): backups, recovery, and keeping keys out of web pages.
- [Costs](costs.md): what each action costs, and what comes back.
- [FAQ](../FAQ.md).

If something fails, the error names a code such as `[E301]`. [docs/errors.md](../errors.md) explains each code and its fix.
