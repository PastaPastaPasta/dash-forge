# Quick start

This guide takes you from nothing to a repository on Dash Forge that you can clone, push to and browse on the web. It uses **devnet moutai**, where Dash is free, so you can try everything without spending real money.

You will:

1. [Install `dg` and `git-remote-dash`](#1-install)
2. [Get a Dash identity](#2-get-an-identity)
3. [Sign in](#3-sign-in)
4. [Choose where your code is stored](#4-choose-where-your-code-is-stored)
5. [Publish a repository with `dg init`](#5-publish-a-repository)
6. [Push](#6-push)
7. [View it on the web](#7-view-it-on-the-web)

Replace every `<…>` placeholder in the commands with your own value before running them; the shell reads a bare `<` or `>` as a redirection.

Allow about 15 minutes. Most of it is the first build, or waiting for the network to confirm your identity.

> **Which network?** Forge (forge-v2) needs Platform protocol 14, which only devnet **moutai** runs today. Testnet gets a deployment when protocol 14 reaches it, and mainnet after protocol 14 activates there and the contracts are registered. On a network without a deployment the tools stop with a "not deployed" error ([E702](../errors.md#e702)). See [the network status table](../../README.md#status).

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

**Coming soon:** the release pipeline and `install.sh` are merged, but no release has been tagged yet, so there is nothing to download. After the first release, this one line installs checksum-verified binaries into `~/.local/bin`:

```sh
curl -fsSL https://raw.githubusercontent.com/PastaPastaPasta/dash-forge/master/install.sh | sh
```

[INSTALL.md](../INSTALL.md) covers what the script checks (the SHA-256, and the build attestation when `gh` is installed), manual downloads, `cargo binstall`, and Windows.

### Check the install

```sh
dg --version
dg doctor
```

`dg doctor` checks the toolchain, your identity, the network, the contracts, your storage profiles and your git config. At this point it reports that no identity is configured. That is the next step.

---

## 2. Get an identity

A Dash Platform **identity** is your account on Forge. It holds your keys and your credit balance. Nobody issues it to you: you create it yourself by locking some Dash. [Identity and keys](identity-and-keys.md) explains what it is.

**Forge never funds or creates identities for you.** Create one from the terminal:

```sh
dg auth new --network devnet --devnet-name moutai
```

1. `dg` shows **12 recovery words**. Write them down, in order, and keep them offline: they are the identity, and nobody can recover it without them. It asks you to type three of them back.
2. It shows a deposit address as a QR code and as text. Send 0.05 DASH to it from any Dash wallet; on devnet moutai use the faucet at <https://faucet.moutai.networks.dash.org>. A repository costs about 0.0013 DASH.
3. `dg` waits for the deposit, locks it, registers the identity, and stores a **limited key** for this computer in your OS keychain: it can spend at most 0.25 DASH, only on Forge, for 180 days. The master key is not stored anywhere.

```
✓ identity 8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB created on devnet-moutai
  key #5: limited, 0.25 DASH budget, only on Dash Forge, expires in 180 day(s)
  stored in macOS Keychain (dash-forge/devnet-moutai/8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB)
  balance 0.0499 DASH
```

On a devnet the deposit is proven with a chain lock, which takes a few minutes. If `dg` is interrupted, `dg auth new --resume` continues with the same deposit address.

> **Mainnet.** Fund the deposit from any Dash wallet. There is no faucet on mainnet. Forge itself is not on mainnet yet.

**Other ways in.** All of these derive the same keys from the same 12 words, so an identity made in one opens in the others:

- **In the web app**: on [forge.dashhq.org](https://forge.dashhq.org), **Sign in → Create a new identity**. It shows 12 words, checks three of them, protects this browser's key with a passkey or a passphrase, and shows a deposit QR code. One registration creates the identity and a limited key for this browser.
- **With the Dash bridge**: <https://bridge.thepasta.org/?network=devnet-moutai>, then **Download Key Backup**.

To sign the *browser* in with an identity you already have, the web app also offers **Use my Dash wallet** (scan a QR code with Dash Wallet and approve). With today's wallets that works only in Dash Wallet iOS on devnet; [Identity and keys](identity-and-keys.md#signing-in-with-the-dash-wallet-app-what-works-today) says which wallets and networks work, and the caveats.

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

The identity file's master key signs one update that registers a limited key for this computer, and `dg` stores only that key. Afterwards put the identity file somewhere offline. `dg` records the identity and the network as defaults, and `git push` reads the same stored key, so neither needs flags or `DASH_FORGE_KEY`. Where there is no OS keychain (a container, Linux without Secret Service), the key goes to a passphrase-sealed file instead; over SSH, set `DASH_FORGE_NO_KEYCHAIN=1` to get the same.

`git-remote-dash` still needs the network for a repository `dg` did not set up (`dg init` and `dg repo create --push` write it into the repository's git config). Add it to your shell profile if you clone by hand, or the helper uses testnet and stops with "not deployed":

```sh
export DASH_FORGE_NETWORK=devnet
export DASH_FORGE_DEVNET_NAME=moutai
```

Then check everything:

```sh
dg auth status      # identity, key, budget left, expiry, balance, where the key is stored
dg doctor --fix     # free, local fixes only: file modes, and a cost guard for git push
```

`dg doctor --fix` sets `git config --global dash.costWarnThreshold 0.01` if you have no threshold yet, so that a push asks before spending more than 0.01 DASH. It never spends anything.

Your identity id is the long base58 string, such as `8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB`. You will use it in repository addresses. A DPNS username is optional: `dg auth name register <label>`. The web app resolves names (`forge.dashhq.org/alice/project`); `dash://` addresses and `dg` do not yet (**coming soon**).

---

## 4. Choose where your code is stored

Forge hosts nothing, so you decide where the pack bytes (the git objects) live. Platform always keeps the small signed pieces: the manifest with each pack's SHA-256, and the ref updates.

| Option | Cost | |
|---|---|---|
| Your S3-compatible bucket (Cloudflare R2, Backblaze B2, AWS S3, MinIO) | about 0.0003–0.004 DASH per push on Platform, plus your provider's bill | recommended; R2 has no egress fees |
| Your IPFS node (kubo) or a pinning service | the same on Platform | |
| Dash Platform | about **0.28 DASH per MiB**, permanently | no account needed; fine for tiny repositories |

**From the terminal**, `dg storage add` with no arguments asks for each value, stores a pasted secret in your OS keychain, and tests the storage as it goes, printing the fix for anything that fails (usually CORS):

```sh
dg storage add            # e.g. a profile named r2-main; offers to make it your default
dg storage test r2-main   # re-run the checks at any time
```

**In the browser**, open **Settings → Storage** (`/settings/storage`) on forge.dashhq.org. The wizard has the same providers, tests them from the page (so it checks what the browser will actually do), and keeps the credentials encrypted in this browser's vault. Browser storage settings are used for what the web app uploads, such as release assets; `git push` uses `dg`'s profiles.

[Bring your own storage](bring-your-own-storage.md) has the provider-by-provider setup and the flags for scripts.

---

## 5. Publish a repository

Inside the git repository you want to publish:

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
dash: storage      → r2-main · Platform stores manifest + refs only, est 0.000275 DASH
dash: r2-main      ████████████████ 1.2 MiB  verified   0.4 s
dash: platform     manifest 2 · refUpdate 1     est 0.000275 DASH
dash: done · Platform charged ≈0.00028 DASH · remaining 0.4812 DASH · https://forge.dashhq.org/repo?owner=8hJm…&name=my-project
✓ main → 8f3e2a1   this push ~0.00028 DASH ≈ $0.01
  total ~0.0016 DASH ≈ $0.05 (create ~0.0013 DASH ≈ $0.04 + push ~0.00028 DASH ≈ $0.01) · balance 0.4812 DASH
Open it: https://forge.dashhq.org/repo?owner=8hJm…&name=my-project
```

(The numbers are illustrative. A first push of a real project usually costs more than this: `dg init`'s live test measured 0.0028 DASH for its push; see [Costs](costs.md).)

A repository is three small documents in Forge's shared contracts: the `repo` itself, your `maintainer` membership, and the first `config`. The quote before you confirm is an upper bound; the measured cost, about **0.0013 DASH**, is printed afterwards. See [Costs](costs.md).

What it does, in order:

- **Picks the storage before spending anything**: `--storage <profiles>` (comma-separated; `platform` is built in), else `dash.storage` from git config (this repository's, then your global one), else your only storage profile. With none, a terminal offers a picker; otherwise it stops with [E508](../errors.md#e508), prices what Platform storage would cost for this repository, and tells you to run `dg storage add` first or pass `--storage platform` to accept that price. Nothing is written.
- **Checks everything else that could refuse**: the identity loads, this is a git repository ([E206](../errors.md#e206) otherwise), the remote name is free, HEAD is on a branch, and every storage secret resolves. Nothing is created when any of these fails.
- **Creates the repository**, named after the directory unless you pass `--name` (`dg repo create <name>`). Its first config records where the packs live, so readers and the web app know where to look.
- **Adds the remote** `origin` (`--remote <name>` for another). If `origin` already points somewhere else it stops ([E206](../errors.md#e206)) rather than changing it.
- **Writes this repository's git config**: `dash.storage` (and `dash.replicas` with `--replicas`), plus `dash.network` / `dash.devnetName` when `git push` would otherwise pick a different network than `dg`. From now on a plain `git push` goes to the same place.
- **Pushes the current branch** with `-u`, unless the branch already tracks another remote: an existing GitHub `origin` stays the upstream when the Forge remote is `--remote forge`. A repository with no commits yet is created and configured, and the push is skipped.

It is safe to run again: an existing repository is reused (nothing written), a matching remote is left alone, and an up-to-date branch pushes nothing. `--yes` skips the question (and the push's cost guard); `--json` prints one object with `repoId`, `remoteUrl`, `webUrl`, `storage`, the pushed branch and commit, and the costs.

`dg repo create <name>` without `--push` only creates the repository and prints the `dg init` line that would finish the job (`--remote` needs `--push`). A re-run of `dg init` without `--name` takes the name from an existing `dash://` remote of yours, so it finds the same repository.

Names are 1–63 characters: lowercase letters, digits, `.`, `_` and `-`, starting with a letter or digit. A directory name is folded to that form (`My Project` → `my-project`).

You can also create a repository in the web app (**New → Repository**, about 0.0013 DASH, with a cost preview). The empty repository page then shows the commands to push to it.

---

## 6. Push

After `dg init`, pushing is plain git:

```sh
git push
```

To push to a repository someone created without `dg init` (or from another clone), add the remote yourself:

```sh
git remote add origin dash://<owner identity id>/my-project
dg storage use r2-main                 # this repository's packs go to r2-main
git push -u origin main
```

Or start from an empty clone:

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
dash: storage      → r2-main · Platform stores manifest + refs only, est 0.000275 DASH
dash: r2-main      ████████████████ 245 B  verified   0.2 s
dash: platform     manifest 2 · refUpdate 1     est 0.000275 DASH
dash: done · Platform charged ≈0.00028 DASH · remaining 0.4809 DASH · https://forge.dashhq.org/repo?owner=8hJm…&name=my-project
```

(The numbers are illustrative. Yours depend on the size of the push.)

A repository without `dash.storage` stores its pack bytes on Dash Platform, which costs about **0.28 DASH per MiB**. If you set a cost guard (`dg doctor --fix` does), a push asks before it spends more than 0.01 DASH. To choose another threshold:

```sh
git config --global dash.costWarnThreshold 0.05
```

Everything else is plain git: branches, tags, force-push, `git fetch`, `git clone --filter=blob:none`. jj works too. Shallow clones (`--depth`) are not supported and fail with [E205](../errors.md#e205).

---

## 7. View it on the web

Open the link from the push's last line. Short links work too: `https://forge.dashhq.org/<owner id>/my-project`.

The web app has no server behind it. Your browser reads the repository straight from Dash Platform, checks the Platform proofs, and re-hashes every file it shows. The **Verification** card in the right-hand rail says what was checked, including whether the quorum keys the proofs rest on agreed with a second source. [Verify Forge](verify-forge.md) explains it.

Browsing, cloning and downloading a branch as a zip (up to 100 MB, built in your browser) are free and need no sign-in. To file an issue, review a pull request or star a repository from the browser, choose **Sign in**. The web app registers a limited key for this browser (0.05 DASH budget, 90 days, usable only on Forge) and keeps it encrypted; your master key is used once and not stored. [Identity and keys](identity-and-keys.md#limited-keys) explains the options.

---

## Next steps

- [Mirror a GitHub repository](mirror-a-github-repo.md) so it can't be taken down.
- [Collaborate](collaborating.md): members, issues, pull requests, merges, releases.
- [Identity and keys](identity-and-keys.md): backups, recovery, and keeping keys out of web pages.
- [Costs](costs.md): what each action costs, and what comes back.
- [FAQ](../FAQ.md).

If something fails, the error names a code such as `[E301]`. [docs/errors.md](../errors.md) explains each code and its fix.
