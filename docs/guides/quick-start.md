# Quick start

This guide takes you from nothing to a repository on Dash Forge that you can clone, push to and browse on the web. It uses **testnet**, where Dash is free, so you can try everything without spending real money.

You will:

1. [Install `dg` and `git-remote-dash`](#1-install)
2. [Get a Dash identity](#2-get-an-identity)
3. [Sign in with `dg auth login`](#3-sign-in)
4. [Create a repository](#4-create-a-repository)
5. [Push to it](#5-push)
6. [View it on the web](#6-view-it-on-the-web)

Allow about 15 minutes. Most of it is the first build, or waiting for testnet to confirm your identity.

> **Which network?** Testnet runs the first version of Forge ("v1": one Platform contract per repository). **forge-v2**, which makes repositories about 1,000× cheaper, has its contracts registered on **devnet moutai**. The tools cannot use them yet: client support is being built now. It comes to mainnet after Platform protocol 14 activates there. Mainnet has no Forge deployment yet. See [the network status table](../../README.md#status).

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

**Forge never funds or creates identities for you.** On testnet, free test Dash is available for trying things out:

1. Open the **Dash bridge** in testnet mode: <https://bridge.thepasta.org/?network=testnet>.
2. Choose **Create New Identity**. On testnet the deposit step has a **Request Testnet Funds** button that sends you 1 free tDASH, so you do not need a wallet.
3. **Write down the 12 words it shows you.** They are the only way to recover the identity.
4. When the identity is registered, choose **Download Key Backup**. You get a file named `dash-identity-<id>.json`. `dg` reads your keys from it.
5. **Top up once more.** A testnet repository costs about 1.18 tDASH, which is more than one faucet request. Choose **Top Up Existing Identity**, enter your identity id, and use **Request Testnet Funds** again. The faucet allows 3 requests an hour.

Keep the file private. It holds every private key of the identity. Move it somewhere safe, for example:

```sh
mkdir -p -m 700 ~/.config/dash-forge
mv ~/Downloads/dash-identity-*.json ~/.config/dash-forge/
chmod 600 ~/.config/dash-forge/dash-identity-*.json
```

> **Devnet moutai.** Use `https://bridge.thepasta.org/?network=devnet-moutai`. Fund it from the moutai faucet at <https://faucet.moutai.networks.dash.org>.
>
> **Mainnet.** Use <https://bridge.thepasta.org/?network=mainnet> (the bridge defaults to testnet) and fund the deposit address from any Dash wallet. There is no faucet on mainnet. Forge itself is not on mainnet yet.

**Coming soon:** `dg auth new`, which creates and funds an identity from the terminal (it shows a QR code for the deposit) and stores the keys in your OS keychain. Creating an identity in the web app is coming too.

---

## 3. Sign in

Point `dg` at the identity file once:

```sh
dg auth login --identity ~/.config/dash-forge/dash-identity-<id>.json
```

```
Logged in as 8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB on testnet.
Stored default identity at /home/you/.config/dash-forge/identities/testnet/8hJm….identity.json.
Balance: 199980000000 credits (~1.999800 DASH).
```

`dg` copies the file into `~/.config/dash-forge/identities/<network>/` and uses it by default from now on. The copy is created with your default file mode, so make it private:

```sh
dg doctor --fix      # chmod 700 the directory and 600 the copied key file
```

`dg doctor --fix` also sets `git config --global dash.costWarnThreshold 0.01` if you have no threshold yet, so that pushes ask before spending more than 0.01 DASH. Inside a git repository it can also pin `dash.network` in that repository's config to match `dg`. It never spends anything.

**git needs to find the key too.** `git-remote-dash` does not read `dg`'s settings. It reads the `DASH_FORGE_KEY` environment variable. It needs an identity even to **clone**, although cloning spends nothing. Add this line to your shell profile (`~/.zshrc`, `~/.bashrc`):

```sh
export DASH_FORGE_KEY="$HOME/.config/dash-forge/identities/testnet/<your identity id>.identity.json"
```

Then check everything. `dg doctor` should now show no warnings for your identity:

```sh
dg auth status
dg auth balance
dg doctor
```

Your identity id is the long base58 string, such as `8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB`. You will use it in repository addresses.

**Coming soon:** DPNS usernames, so you can write `dash://alice/project` instead of the identity id, keychain storage for keys, and `dg auth keys` for limited-budget keys.

---

## 4. Create a repository

```sh
dg repo create my-project --description "My first Forge repo"
```

```
Creating repo "my-project" (platform storage) — estimated cost ~1.18 DASH ≈ $35.40
Create repo "my-project"? This instantiates a contract (~1.18 DASH ≈ $35.40) [y/N] y
Created 8hJm…/my-project
  contract: 5rrw…
  remote:   dash://8hJm…/my-project
  cost:     ~1.18 DASH ≈ $35.40
```

On testnet this costs about **1.18 tDASH**, which is free test money. It is that expensive because a v1 repository is a whole Platform contract. `dg repo create` makes v1 repositories only. On forge-v2 a repository will be three small documents, about **0.001 DASH**. See [Costs](costs.md).

Names are 1–63 characters: lowercase letters, digits, `.`, `_` and `-`, starting with a letter or digit.

---

## 5. Push

From an existing git repository:

```sh
cd my-project
git remote add origin dash://<your identity id>/my-project
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

By default the pack bytes go on Dash Platform, which costs about **0.28 DASH per MiB**. For anything bigger than a toy, keep the packs in your own bucket or IPFS node instead. Then Platform stores only the small manifest and the ref update. [Bring your own storage](bring-your-own-storage.md) has the setup for R2, B2, S3, MinIO and IPFS:

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

Browsing and cloning are free and need no sign-in. To file an issue from the browser, choose **Sign in** and load your identity file. The browser keeps the signing key in local storage.

---

## Next steps

- [Mirror a GitHub repository](mirror-a-github-repo.md) so it can't be taken down.
- [Collaborate](collaborating.md): collaborators, issues, pull requests, releases.
- [Identity and keys](identity-and-keys.md): backups, recovery, and keeping keys out of web pages.
- [Costs](costs.md): what each action costs, and what comes back.
- [FAQ](../FAQ.md).

If something fails, the error names a code such as `[E301]`. [docs/errors.md](../errors.md) explains each code and its fix.
