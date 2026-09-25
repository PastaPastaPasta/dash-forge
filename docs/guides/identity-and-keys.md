# Identity and keys

On Dash Forge, your account is a **Dash Platform identity**. No company holds it for you. There is no password reset and no support desk. This page explains what an identity is, which keys it has, how to back it up, and how to keep its keys out of places they don't belong.

1. [What an identity is](#what-an-identity-is)
2. [The keys in an identity](#the-keys-in-an-identity)
3. [Backup and recovery](#backup-and-recovery)
4. [Where keys live today](#where-keys-live-today)
5. [Never paste a master key into a web page](#never-paste-a-master-key-into-a-web-page)
6. [Rotating and disabling keys](#rotating-and-disabling-keys)
7. [Limited keys (coming with protocol 14)](#limited-keys-coming-with-protocol-14)

---

## What an identity is

An identity is a record on Dash Platform with:

- an **id**: a 44-character base58 string such as `8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB`. It appears in your repository addresses (`dash://<id>/<repo>`);
- a set of **public keys**. Anything you write on Forge is signed by one of them, and Platform checks the signature;
- a **credit balance** that pays Platform fees. 1 DASH = 100,000,000,000 credits.

You create an identity by locking some Dash in an *asset lock* transaction. The locked amount becomes the identity's credits. Forge does not create or fund identities for you; see [Costs](costs.md).

Today you create one with the Dash bridge (<https://bridge.thepasta.org>). The [quick start](quick-start.md#2-get-an-identity) walks through it. The bridge also does top-ups, usernames and key changes.

**Usernames.** Platform has a name service, DPNS. You can register a username for your identity in the bridge (**Register Username**). Forge does not resolve usernames yet: `dash://alice/project` and `dg … alice/project` need the identity id in place of `alice` for now. **Coming soon:** DPNS names everywhere, and `dg auth name register`.

---

## The keys in an identity

An identity file from the bridge has five keys, all ECDSA secp256k1:

| Id | Purpose | Security level | Used for |
|---|---|---|---|
| 0 | AUTHENTICATION | **MASTER** | Changing the identity's own keys (add, disable). Nothing on Forge needs it. |
| 1 | AUTHENTICATION | HIGH | Signing documents: pushes, issues, comments, reviews, releases. |
| 2 | AUTHENTICATION | CRITICAL | What HIGH does, plus v1 token administration: `dg repo create`, `dg collab …`. |
| 3 | TRANSFER | CRITICAL | Moving credits to another identity, or withdrawing them. |
| 4 | ENCRYPTION | MEDIUM | Reserved for private repositories (coming soon). |

What each tool signs with:

- `git push` (`git-remote-dash`) and most `dg` commands sign with the **HIGH** key, falling back to CRITICAL.
- `dg repo create` and `dg collab add/suspend/unsuspend/remove` need the **CRITICAL** key, because on v1 they mint and freeze tokens. Without it they fail with [`E302`](../errors.md#e302). On forge-v2 these become ordinary documents that the HIGH key can sign.
- No Forge tool ever needs the MASTER key.

---

## Backup and recovery

**The 12 words are the identity.** Every key above is derived from the 12-word mnemonic the bridge showed you when it created the identity. Anyone who has those words controls the identity and its credits. If you lose them, and every copy of the identity file, **nobody can recover the identity**. Not the Forge project, not Dash Core Group, not anyone.

Do this once:

1. Write the 12 words on paper, in order. Keep two copies in separate places.
2. Keep the words offline. Do not put them in a password manager that syncs, in a note-taking app, or in a screenshot.
3. Treat the identity file (`dash-identity-<id>.json`) like the words. It contains them, plus every private key. Keep it `chmod 600`. `dg doctor` warns when it is readable by other users, and `dg doctor --fix` tightens it.

If you lose a laptop but still have the words or a backup of the file, nothing is lost. Your repositories, issues and history are on Platform, not on your laptop:

1. Restore the identity file from your backup, or recreate it from the 12 words in a wallet that supports Platform identities.
2. Run `dg auth login --identity <file>` again.
3. If the lost machine might be in someone else's hands, [disable its keys](#rotating-and-disabling-keys).

Your **repository data** needs no backup of its own. Refs, issues and PRs are on Platform. Pack bytes are on Platform or in the storage you chose. Any clone also holds a full copy of the history, and [`dg reseed --from-local`](bring-your-own-storage.md#restoring-a-lost-copy) can restore a lost pack copy from it.

---

## Where keys live today

| Tool | Where the key is | How it finds it |
|---|---|---|
| `dg` | A copy of the identity file in `~/.config/dash-forge/identities/<network>/<id>.identity.json` | `--identity <file>` > `DASH_FORGE_KEY` > the default recorded by `dg auth login` |
| `git-remote-dash` | The same file | `DASH_FORGE_KEY`, else `~/.config/dash-forge/identities/<owner>.identity.json` |
| `forge-import` | The same file | `--identity <file>` > `DASH_FORGE_KEY` |
| Web app | The CRITICAL (or HIGH) key's private key, **unencrypted** in the browser's `localStorage` | Loaded from an identity file or pasted in the **Sign in** dialog |

Things to know:

- `DASH_FORGE_KEY` holds a **path** to an identity file today, not the key itself.
- The identity file on disk is plaintext JSON. Protect it with file permissions and full-disk encryption.
- In the web app, the key stays in that browser (it is never sent anywhere), but any script running on the page could read it. Sign out on shared machines. That removes it.

**Coming soon:** keys in the OS keychain (macOS Keychain, Secret Service, Windows Credential Manager) with a passphrase-encrypted fallback file; `dg auth new` to create an identity from the terminal; a browser key vault encrypted with a passkey or passphrase; `dg auth export` to write a backup file.

---

## Never paste a master key into a web page

A web page is whoever served it. If the page, or a script it loads, is compromised, anything you paste into it is gone.

- **Never paste your MASTER key, your 12 words, or your main identity file into a website.** That includes forge.dashhq.org. Nothing on Forge needs them.
- The web app's sign-in picks the CRITICAL key (or HIGH) from the file you load. It does not store the MASTER key or the mnemonic, but it does read the whole file you choose. If you want to be careful, give it a copy that contains only the HIGH or CRITICAL key (the `jq` recipe in the [mirror guide](mirror-a-github-repo.md#the-ci-secret) makes one).
- The same goes for CI: give a pipeline a stripped copy or, better, a separate identity with a small balance.
- Prefer a copy of the web app that you [serve yourself](verify-forge.md#run-your-own-copy-of-the-web-app) if you do not want to trust the one on forge.dashhq.org.

When limited keys arrive (below), the web app will never see anything but a limited key. The master key will be used only in one-time steps, such as registering a limited key.

---

## Rotating and disabling keys

Platform lets the MASTER key add new keys to an identity and disable old ones. A disabled key can never sign again. Your identity id, balance and data stay the same.

Today you do this in the Dash bridge, not in `dg`:

1. Open <https://bridge.thepasta.org> (add `?network=testnet` for testnet) and choose **Manage Identity Keys**.
2. Sign in with the identity id and the **MASTER** key's private key. This is the one place where the master key is used. Do it on a machine you trust, and check the page address first.
3. Add a new key (for example a new HIGH authentication key), or disable a key you think is exposed.
4. Save the new private key into your identity file, in the matching `identityKeys` entry.

When to rotate:

- a laptop or CI secret that held a signing key was lost or leaked: **disable that key**;
- you gave a CI job the HIGH key and are retiring the job.

If the **MASTER** key or the 12 words leak, rotating does not help: whoever has them can re-enable or add keys. Move your credits out with the TRANSFER key to a new identity, and start over there. On forge-v2 you can then add the new identity to your repositories as a maintainer. On v1 (testnet today), the old identity owns its repository contracts forever, and there is no ownership transfer.

**Coming soon:** `dg auth keys list | add | disable`.

---

## Limited keys (coming with protocol 14)

*Available on devnet moutai once client support lands; mainnet after Platform protocol 14 activates.*

Protocol 14 adds keys with a **spending budget and an expiry**, bound to the Forge contracts. A limited key can spend at most its budget, only on Forge documents, and only until it expires. It cannot touch your other keys or move credits.

The planned defaults:

| Where | Budget | Expires |
|---|---|---|
| Browser | 0.05 DASH | 90 days |
| CLI | 0.25 DASH | 180 days |
| CI runner (Mirror Action) | 0.5 DASH | 365 days |

With limited keys:

- the **master key never lives in the browser, on disk unencrypted, or in CI**. It signs only one-time ceremonies: registering a limited key, a username, or an encryption key;
- losing a device costs nothing beyond that key's remaining budget. Register a new limited key and disable the old one;
- the web app will show the key's remaining budget and expiry, and warn when either runs low;
- CI gets one pasteable value, `DASH_FORGE_KEY=dfk1:<network>:<identity id>:<key id>:<wif>`, in place of a file.

The planned commands (**not available yet**):

```sh
dg auth new [--amount 0.05] [--name alice]      # create + fund an identity from the terminal
dg auth login [<file> | --mnemonic]             # registers a limited key by default
dg auth keys add --budget 0.25 --expires 180d --bound dash-forge
dg auth keys disable <id>
dg auth name register <label>
```
