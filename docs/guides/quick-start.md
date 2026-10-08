# Quick start

This guide takes you from nothing to a repository on Dash Forge that you can clone, push to and browse on the web. It uses **devnet sakura**, where Dash is free, so you can try everything without spending real money.

You will:

1. [Install `dg` and `git-remote-dash`](#1-install)
2. [Get a Dash identity](#2-get-an-identity)
3. [Sign in](#3-sign-in)
4. [Choose where your code is stored](#4-choose-where-your-code-is-stored)
5. [Publish a repository with `dg init`](#5-publish-a-repository)
6. [Push](#6-push)
7. [View it on the web](#7-view-it-on-the-web)

Replace every `<…>` placeholder in the commands with your own value before running them; the shell reads a bare `<` or `>` as a redirection.

Allow about 15 minutes. Most of it is waiting for the network to confirm your identity (or, if you build from source, the first build).

> **Which network?** The commands target devnet **sakura**, a test network, which forge.dashhq.org also uses. The fees below were measured on sakura where they say so (2026-10-01), else on the retired devnet bonsia; [Costs](costs.md) has both. Testnet and mainnet have no Forge deployment yet, and on a network without one the tools stop with a "not deployed" error ([E702](../errors.md#e702)). [Networks](../networks.md) has the details.

---

## 1. Install

You need two programs on your `PATH`:

- `dg`: the command-line tool, shaped like GitHub's `gh`;
- `git-remote-dash`: the git remote helper. Git runs it whenever a URL starts with `dash://`.

### Prebuilt binaries (Linux and macOS)

This one line installs the latest release's checksum-verified binaries into `~/.local/bin`:

```sh
curl -fsSL https://raw.githubusercontent.com/PastaPastaPasta/dash-forge/master/install.sh | sh
```

[INSTALL.md](../INSTALL.md) covers what the script checks (the SHA-256, and the build attestation when `gh` is installed), manual downloads (Windows included), `cargo binstall`, and pinning a version.

### Or build from source

You need Rust (the repository pins the version; rustup installs it for you) and `protoc` 25 or newer. [BUILDING.md](../BUILDING.md) explains both.

```sh
git clone https://github.com/PastaPastaPasta/dash-forge && cd dash-forge
cargo install --locked --path crates/dg
cargo install --locked --path crates/git-remote-dash
```

`cargo install` puts both binaries in `~/.cargo/bin`, which rustup already added to your `PATH`.

### Check the install

```sh
dg --version
dg doctor
```

`dg doctor` checks the toolchain, your identity, the network, the contracts, your storage profiles and your git config. On a fresh install it warns (`!`) that no identity is configured and no network is chosen yet, and exits 0: nothing is broken. `dg auth new` in the next step fixes both.

---

## 2. Get an identity

A Dash Platform **identity** is your account on Forge. It holds your keys and your credit balance. Nobody issues it to you: you create it yourself by locking some Dash. [Identity and keys](identity-and-keys.md) explains what it is.

**Forge never funds or creates identities for you.** Create one from the terminal:

```sh
dg auth new --network devnet --devnet-name sakura
```

1. `dg` shows a **12-word recovery phrase**. Write the words down, in order, and keep them offline: they are the identity, and nobody can recover it without them. It asks you to type three of them back. The words are shown only in a terminal. Scripted, piped or in CI, `dg auth new` never prints them: pass `--backup-file <new file>` and they go only to that file (0600, sealed under a passphrase, `DASH_FORGE_PASSPHRASE` without a terminal or with `--json`). Without that flag it refuses before it creates anything.
2. It shows a deposit address as a QR code and as text. Send 0.05 DASH to it from any Dash wallet; on devnet sakura use the faucet at <https://faucet.sakura.networks.dash.org>, which sends 10 test DASH, far more than you need. A repository costs about 0.0016 DASH. `dg` locks **everything** the address receives into the identity's credits, so send only what you want to spend on Forge: the faucet's 10 test DASH all become credits (a balance of about 9.998 DASH), where the sample below sent 0.05.
3. `dg` waits for the deposit, locks it, registers the identity, and stores a **limited key** for this computer in your OS keychain: it can spend at most 0.25 DASH, only on Forge, for 180 days. The master key is not stored anywhere.

```
✓ identity 8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB created on devnet-sakura
  key #5: limited, 0.25 DASH budget, only on Dash Forge, expires in 180 day(s)
  stored in macOS Keychain (dash-forge/devnet-sakura/8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB)
  balance 0.0499 DASH
```

On a devnet the deposit is proven with a chain lock, which takes a few minutes. If `dg` is interrupted, `dg auth new --resume` continues with the same deposit address.

> **Mainnet.** Fund the deposit from any Dash wallet. There is no faucet on mainnet. Forge itself is not on mainnet yet.

**Other ways in.** All of these derive the same keys from the same 12 words, so an identity made in one opens in the others:

- **In the web app**: on [forge.dashhq.org](https://forge.dashhq.org), **Sign in → Create a new identity**. It shows 12 words, checks three of them, protects this browser's key with a passkey or a passphrase, and shows a deposit QR code. One registration creates the identity and a limited key for this browser.
- **With the Dash bridge**: <https://bridge.thepasta.org/?network=devnet-sakura>, then **Download Key Backup**, once the bridge offers devnet sakura (it lists moutai today).

To sign the *browser* in with an identity you already have, the web app also offers **Use my Dash wallet** (scan a QR code with Dash Wallet and approve). With today's wallets that works only in Dash Wallet iOS on devnet; [Identity and keys](identity-and-keys.md#signing-in-with-the-dash-wallet-app-what-works-today) says which wallets and networks work, and the caveats.

---

## 3. Sign in

`dg auth new` signs you in. With an identity you already have (a bridge `dash-identity-<id>.json`, or the 12 words), sign in once per computer:

```sh
dg auth login --network devnet --devnet-name sakura ~/Downloads/dash-identity-<id>.json
# or: dg auth login --network devnet --devnet-name sakura --mnemonic
```

```
Registering a limited key for this computer on 8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB (devnet-sakura):
  it can spend at most 0.25 DASH, only on Dash Forge, until it expires in 180 day(s)
  one identity update, ~0.0005 DASH; the master key signs once and is not stored
Register the key? [y/N] y
✓ signed in as 8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB on devnet-sakura
  key #6: limited, 0.25 DASH budget, expires in 180 day(s)
  with encryption key #4: private repositories you are a member of open with it
  stored in macOS Keychain (dash-forge/devnet-sakura/8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB)
  balance 0.0494 DASH
  the identity file is no longer needed here; keep it (or the words) offline
```

The prompt defaults to no, so pressing Enter alone declines: type `y`. The quote is an upper bound: on devnet sakura the update was charged about 0.00047 DASH. Without a terminal (a script), `dg` stops with [E802](../errors.md#e802) and writes nothing; add `--yes` once you have checked the estimate.

The identity file's master key signs one update that registers a limited key for this computer, and `dg` stores only that key, with your identity's encryption key beside it for private repositories (never the master key). Afterwards put the identity file somewhere offline. `dg` records the identity and the network as defaults, and `git push` reads the same stored key, so neither needs flags or `DASH_FORGE_KEY`. Where there is no OS keychain (a container, Linux without Secret Service), the key goes to a passphrase-sealed file instead; over SSH, set `DASH_FORGE_NO_KEYCHAIN=1` to get the same.

With a sealed key file, each command that signs asks for the passphrase once:

- `dg init` and the other `dg` commands that push ask once, then hand the unlocked key to the `git push` they run. The key goes through a private pipe, never an environment variable or the command line.
- A plain `git push` asks on the terminal, once per push.
- Without a terminal (a GUI git client, a cron job) the push stops with [`E303`](../errors.md#e303) before anything is written. Its message names the ways out: run it in a terminal, keep the key in the OS keychain, or set `DASH_FORGE_PASSPHRASE` (or a [`dfk1:` key](identity-and-keys.md)) for scripts.

`git push` and `git clone` use the same network: `git-remote-dash` reads the one `dg` recorded, so plain git commands need no flags or environment either. A repository's own git config (`dash.network`, which `dg init` and `dg repo clone` write) wins over it, and `DASH_FORGE_NETWORK` wins over both. Inside such a clone, `dg` uses the repository's network too, and commands that leave out the repository use the clone's (`dg issue list`, `dg pr view 3`, `dg issue label 3 add bug`, `dg release download v1.0`), as `gh` does; `-R <owner>/<name>` names another one. In a clone of a fork, `dg pr create` opens the PR in the fork's parent.

Then check everything:

```sh
dg auth status      # identity, key, budget left, expiry, balance, where the key is stored
dg doctor --fix     # free, local fixes only: file modes, and a cost guard for git push
```

`dg doctor --fix` sets `git config --global dash.costWarnThreshold 0.05` if you have no threshold yet, so that a push asks before spending more than 0.05 DASH: a small push goes through (one with its packs on Platform is quoted about 0.012 DASH on bonsia), a megabyte of packs on Platform asks. It never spends anything.

Your identity id is the long base58 string, such as `8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB`. You will use it in repository addresses. A DPNS username is optional: `dg auth name register <label>`. It needs your identity's master key once, so pass the identity file with `--master <file>` or type the 12-word recovery phrase when asked; the limited key `dg auth login` stored cannot sign it. A name with a digit other than 0 or 1 cost about 0.0007 DASH on bonsia (`dg` quotes an upper bound of 0.001). Names work everywhere a repository address does: `forge.dashhq.org/alice/project`, `git clone dash://alice/project` and `dg … alice/project`.

---

## 4. Choose where your code is stored

Forge hosts nothing, so you decide where the pack bytes (the git objects) live. Platform always keeps the small signed pieces: the manifest with each pack's SHA-256, and the ref updates. [Costs](costs.md) has the measured figures.

| Option | Cost | |
|---|---|---|
| Your S3-compatible bucket (Cloudflare R2, Backblaze B2, AWS S3, Storj, or a store on [your own NAS](home-nas-storage.md)) | about 0.004–0.0055 DASH per push on Platform (measured on bonsia), plus your provider's bill | recommended; R2 has no egress fees |
| Your IPFS node (kubo) or a pinning service | the same on Platform | |
| Dash Platform | about **0.004–0.011 DASH** for a small push (the top of the range when it moves the default branch), plus about **0.33 DASH per MiB** (the tools quote up to 0.39), permanently | no account needed; fine for tiny repositories |

**From the terminal**, `dg storage add` with no arguments asks for each value and tests the storage as it goes, printing the fix for anything that fails (usually CORS). For the secret access key it offers to paste it, hidden, into your OS keychain. Where there is no keychain (`DASH_FORGE_NO_KEYCHAIN=1`, which is what you want over SSH, or a container) it says so and leaves two choices: an environment variable that holds the secret (`env:R2_SECRET_ACCESS_KEY`; export it where `dg` and `git push` run), or a keychain entry that already exists. A scripted `--secret-access-key` takes one of those two references, never the secret itself ([E501](../errors.md#e501)):

```sh
dg storage add            # e.g. a profile named r2-main; offers to make it your default
dg storage test r2-main   # re-run the checks at any time
```

**In the browser**, open **Settings → Storage** (`/settings/storage`) on forge.dashhq.org. The wizard has the same providers, tests them from the page (so it checks what the browser will actually do), and keeps the credentials encrypted in this browser's vault. Browser storage settings are used for everything the web app uploads: a merge's pack, a commit the browser makes to a pull request's branch (applying suggestions, "Update branch"), and release assets. `git push` uses `dg`'s profiles.

[Bring your own storage](bring-your-own-storage.md) has the provider-by-provider setup and the flags for scripts.

---

## 5. Publish a repository

Inside the git repository you want to publish:

```sh
cd my-project
dg init                   # = dg repo create --push, for this directory
```

```
Creating 8hJm…/my-project on devnet-sakura
  repo + maintainer + config     ~0.002 DASH
  packs → r2-main (1 of 1 must confirm); Platform: manifest + refs only
  (storage: git config dash.storage; recorded in the repository's public config, which readers and the web follow; `--storage <profile|platform>` records another)
Proceed? [Y/n] y
✓ created  https://forge.dashhq.org/repo?owner=8hJm…&name=my-project
✓ remote 'origin' → dash://8hJm…/my-project
✓ git config dash.storage=r2-main, dash.network=devnet, dash.devnetName=sakura
dash: 8hJm…/my-project ← main (8f3e2a1, 312 objects, 1.2 MiB)
dash: storage      → r2-main · Platform stores manifest + refs only, est 0.0066 DASH
dash: r2-main      ████████████████ 1.2 MiB  verified   0.4 s
dash: platform     manifest 4 · refUpdate 1     est 0.0066 DASH
dash: stored pack 6ce98e05facd (1.2 MiB, 312 objects)
dash: pack 6ce98e05facd (1.2 MiB) stored on r2-main (1 verified)
dash: updated main → 8f3e2a1
dash: history index published (full, 42 paths, 1 commits)
dash: done · Platform charged ≈0.0052 DASH · remaining 0.0426 DASH · https://forge.dashhq.org/repo?owner=8hJm…&name=my-project
To dash://8hJm…/my-project
 * [new branch]      main -> main
branch 'main' set up to track 'origin/main'.
✓ main → 8f3e2a1   this push ~0.0052 DASH
  total ~0.0068 DASH (create ~0.0016 DASH + push ~0.0052 DASH) · balance 0.0426 DASH
Open it: https://forge.dashhq.org/repo?owner=8hJm…&name=my-project
```

(The charges are the ones measured on devnet sakura on 2026-10-01 for a first push to your own bucket; the size and paths are illustrative. On a testnet or devnet, DASH is test money and `dg` prints no dollar figures; only on mainnet does it add `≈ $…`. See [Costs](costs.md).)

A repository is three small documents in Forge's shared contracts: the `repo` itself, your `maintainer` membership, and the first `config`. The quote before you confirm is an upper bound; the measured cost, about **0.0016 DASH** on sakura, is printed afterwards. Turning on members-only content (below) adds about 0.0011 DASH, shown on its own line before you confirm. See [Costs](costs.md).

What it does, in order:

- **Picks the storage before spending anything**: `--storage <profiles>` (comma-separated; `platform` is built in), else `dash.storage` from git config (this repository's, then your global one), else your only storage profile. With none, a terminal offers a picker; otherwise it stops with [E508](../errors.md#e508), prices what Platform storage would cost for this repository, and tells you to run `dg storage add` first or pass `--storage platform` to accept that price. Nothing is written.
- **Checks everything else that could refuse**: the identity loads, this is a git repository ([E206](../errors.md#e206) otherwise), the remote name is free, HEAD is on a branch, and every storage secret resolves. Nothing is created when any of these fails.
- **Creates the repository**, named after the directory unless you pass `--name` (`dg repo create <name>`). Its first config records where the packs live, so readers and the web app know where to look. It also protects the default branch and every tag: only maintainers can push to the default branch or create and move tags, and writers propose changes with pull requests. Pass `--no-protect` to leave both open, or change it later with `dg repo protect`.
- **Turns on members-only content**, so members can post comments, reviews and issues only members can read, while everyone can still see that something was posted, by whom and when. It sets up your key for the repository (about 0.0011 DASH). Pass `--no-members-only` to skip it; a maintainer can turn it on later with `dg repo members enable` ([Members-only content](../security/audiences.md#turn-on-members-only-content)). If your identity file has no encryption key, the plan says it stays off and how to add one. If turning it on fails, the repository is still created and `dg` says how to turn it on. Imports, mirrors and forks don't turn it on.
- **Adds the remote** `origin` (`--remote <name>` for another). If `origin` already points somewhere else it stops ([E206](../errors.md#e206)) rather than changing it.
- **Writes this repository's git config**: `dash.storage` (and `dash.replicas` with `--replicas`), plus `dash.network` / `dash.devnetName` when `git push` would otherwise pick a different network than `dg`. From now on a plain `git push` goes to the same place.
- **Pushes the current branch** with `-u`, unless the branch already tracks another remote: an existing GitHub `origin` stays the upstream when the Forge remote is `--remote forge`. A repository with no commits yet is created and configured, and the push is skipped.

It is safe to run again: an existing repository is reused (nothing written), a matching remote is left alone, and an up-to-date branch pushes nothing. `--yes` skips the question (and the push's cost guard); `--json` prints one object with `repoId`, `remoteUrl`, `webUrl`, `storage`, the pushed branch and commit, and the costs.

`dg repo create <name>` without `--push` only creates the repository and prints the `dg init` line that would finish the job (`--remote` needs `--push`). A re-run of `dg init` without `--name` takes the name from an existing `dash://` remote of yours, so it finds the same repository.

Names are 1–63 characters: lowercase letters, digits, `.`, `_` and `-`, starting with a letter or digit. A directory name is folded to that form (`My Project` → `my-project`).

You can also create a repository in the web app (**New → Repository**, about 0.0016 DASH, with a cost preview). Under **Public**, **Turn on members-only content now** is ticked, which adds about 0.0011 DASH; untick it to skip. It needs your encryption key in the browser. The empty repository page then shows the commands to push to it.

---

## 6. Push

After `dg init`, pushing is plain git:

```sh
git push
```

With a passphrase-sealed key (no keychain), `git push` asks for the passphrase on the terminal ([§3](#3-sign-in)).

To push to a repository someone created without `dg init` (or from another clone), add the remote yourself:

```sh
git remote add origin dash://<owner identity id>/my-project
dg storage use r2-main                 # this repository's packs go to r2-main
git push -u origin main
```

Anyone can clone a public repository without an identity: `git clone dash://<owner>/<repo>` reads refs and packs anonymously (`<owner>` is the identity id or DPNS name). Pushing needs your key. On a computer where `dg` has recorded no network, name it in the clone, which keeps it in the clone's git config:

```sh
git clone -c dash.network=devnet -c dash.devnetName=sakura dash://<owner>/<repo>
```

The repository page's **Clone** box shows this command, with the network filled in.

Or start from an empty clone. `dg repo clone` runs `git clone` and records the network in the clone:

```sh
dg repo clone <your identity id>/my-project
cd my-project
git switch -c main                  # an empty clone has no branch yet
echo "# my-project" > README.md
git add README.md && git commit -m "first commit"
git push -u origin main
```

The helper prints what it will store, and where, before it pays for anything. It ends with what Platform charged:

```
dash: 8hJm…/my-project ← main (8f3e2a1, 3 objects, 245 B)
dash: storage      → r2-main · Platform stores manifest + refs only, est 0.0058 DASH
dash: r2-main      ████████████████ 245 B  verified   0.2 s
dash: platform     manifest 4 · refUpdate 1     est 0.0058 DASH
dash: history index published (full, 3 paths, 2 commits)
dash: done · Platform charged ≈0.0040 DASH · remaining 0.0390 DASH · https://forge.dashhq.org/repo?owner=8hJm…&name=my-project
```

(The numbers are illustrative. Yours depend on the size of the push; a later push costs a little less than the first, and the estimate is an upper bound. See [Costs](costs.md).)

A repository without `dash.storage` stores its pack bytes on Dash Platform, which costs about **0.33 DASH per MiB** measured (`git push` quotes up to 0.39, an upper bound; [Costs](costs.md)). If you set a cost guard (`dg doctor --fix` does), a push asks before it spends more than 0.05 DASH. To choose another threshold:

```sh
git config --global dash.costWarnThreshold 0.1
```

Everything else is plain git: branches, tags, force-push, `git fetch`, `git clone --filter=blob:none`. jj works too. Shallow clones (`--depth`) are not supported and fail with [E205](../errors.md#e205).

### Secrets in a push

Anything pushed to a public repository stays public, even after you delete it. So before it signs or stores anything, `git push` checks the files the push publishes for the first time, in every new commit and not only the last one.

It **refuses** a branch or tag that adds one of these, with [E807](../errors.md#e807):

- a `.env` file that sets a value: `.env`, `.env.local`, `.env.production` and the like, in any folder and in any letter case, even in a test folder. Names ending in `.example`, `.sample` or `.template` are fine.
- a PEM private key (`-----BEGIN … PRIVATE KEY-----` with a key inside)
- an AWS access key ID together with its secret
- a GitHub or GitLab token whose built-in checksum is valid

It **warns** and pushes anyway for:

- a direnv `.envrc` that sets a variable
- a value that looks random, assigned to a name like `API_TOKEN` or `password`
- a Dash or Bitcoin private key in WIF form (the test vectors many wallets ship)
- a GitHub or GitLab token it cannot verify
- a private key, AWS key or token that would be refused, when it is in a `test`, `tests`, `testdata` or `fixtures` folder (test keys are common there; a `.env` is not)
- anything that would be refused, when it is only in history older than the repository on Forge: commits made more than a day before you created the repo, or anything `forge-import` mirrors

```
$ git push origin main
dash: warning: .envrc is a direnv file that sets variables [46511bb6536b]
dash: warning: test/key.pem line 1 holds a private key (test folder) [b43e53f5c2b3]
dash: these are warnings only. To silence one, add its fingerprint to .forge/secret-scan-allow.
dash: possible secret: .env looks like a secret file (added in 7ecba60) [fd503e94fe13]
dash: error: refs/heads/main adds .env, which looks like a secret file        [E807]
dash:   cause: nothing pushed to a public branch can be taken back
dash:   fix:   keep .env out of git: `git rm --cached .env`, add it to .gitignore, then amend or rebase the commits that added it
dash:   or:    push with -o allow-secret=fd503e94fe13 if you're sure
dash:   or:    add the fingerprint to .forge/secret-scan-allow and commit it
dash:   note:  checked before anything was signed or stored: these refs were not pushed
 ! [remote rejected] main -> main (possible secret in new files)
```

Only the refused branch or tag is held back. The rest of the push goes ahead.

The code in brackets is the finding's **fingerprint**. It names that secret in that file. It is a short hash, so treat it as public, but for a tiny file or a short value someone could guess the content from it. To push a finding you've checked, pass its fingerprint for this push:

```sh
git push -o allow-secret=fd503e94fe13 origin main
```

To allow it for good, commit a `.forge/secret-scan-allow` file. Each line is a fingerprint or a path, and `#` starts a comment:

```
fd503e94fe13      # the demo .env, holds no real keys
# revoked example keys: still shown, never refused
docs/examples/**/*.pem
```

- A **fingerprint** allows that one finding: it is neither refused nor shown again.
- A **path** only turns a refusal into a warning. Every finding under it is still printed on each push, so a broad path can't hide a secret nobody has looked at.

Paths match from the repository's root: `.env` is the root `.env` only, and `config/*.env` is a file in `config`. Start with `**/` to match at any depth (`**/*.pem`). `*` stays within a folder, `**` crosses folders, and a folder's path covers everything in it. Each branch or tag is checked against the allow file at its own tip.

The check is a safety net, not a guarantee: it knows a handful of formats, and it never runs on a private repository, whose content is encrypted. Keep secrets out of git altogether: an [environment](environments.md) keeps a `.env`'s values encrypted for your maintainers or members, outside git (`dg env import .env --env dev`, then `dg env run --env dev -- <command>`).

---

## 7. View it on the web

Open the link from the push's last line. Short links work too: `https://forge.dashhq.org/<owner id>/my-project`.

The web app has no server behind it. Your browser reads the repository straight from Dash Platform, checks the Platform proofs, and re-hashes every file it shows. The **Verification** card in the right-hand rail says what was checked, including whether the quorum keys the proofs rest on agreed with a second source. [Verify Forge](verify-forge.md) explains it.

Browsing, cloning and downloading a branch as a zip (up to 100 MB, built in your browser) are free and need no sign-in. So is [code search](#search-the-code).

### Search the code

Every repository page has a **Search code** box (press `/` inside a repository). It searches the content and paths of the files on the branch or tag you are viewing, with GitHub's code search syntax: `word other` (every word), `"exact phrase"`, `/regular expression/`, `NOT word` or `-word`, `path:src/net` or `path:*.cpp`, `language:cpp`, `content:word` (content only) and `case:yes`. Qualifiers that need more than one repository (`repo:`, `org:`) and `OR` are reported as not applied.

There is no search server. The first search of a branch reads each of its text files once from the repository's storage, checks each against its id, and keeps them in your browser (IndexedDB). After that, every search runs in your browser and sends no request; a later commit re-reads only the files that changed. A small repository is indexed at once. A larger one shows how much it will read and asks first. The page lists what the index leaves out:

- binary files, symlinks and submodules;
- files over 384 KiB;
- anything past 100 MiB of text (clone the repository and use `git grep` instead).

A **large repository** (over 2,000 files, or 16 MiB stored) is indexed on its default branch only, and one index is kept. For `dashpay/dash`, indexing `develop` reads about 25 MiB (4,398 files, 45 MiB of text) and takes about 35 seconds. A private repository's index is kept in memory for the tab only, never on disk. Your browser keeps up to 256 MiB of indexes across repositories and drops the least recently used first.

To file an issue, review a pull request or star a repository from the browser, choose **Sign in**. The web app registers a limited key for this browser (0.05 DASH budget, 90 days, usable only on Forge) and keeps it encrypted; your master key is used once and not stored. [Identity and keys](identity-and-keys.md#limited-keys) explains the options.

---

## Next steps

- [Move a project from GitHub or GitLab](moving-from-github.md), or [mirror a GitHub repository](mirror-a-github-repo.md) so it can't be taken down.
- [Collaborate](collaborating.md): members, issues, pull requests, merges, releases.
- [Identity and keys](identity-and-keys.md): backups, recovery, and keeping keys out of web pages.
- [Costs](costs.md): what each action costs, and what comes back.
- [FAQ](../FAQ.md).

If something fails, the error names a code such as `[E301]`. [docs/errors.md](../errors.md) explains each code and its fix.
