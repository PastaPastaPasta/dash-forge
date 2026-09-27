# Identity and keys

On Dash Forge, your account is a **Dash Platform identity**. No company holds it for you. There is no password reset and no support desk. This page explains what an identity is, which keys it has, how to back it up, and how to keep its keys out of places they don't belong.

1. [What an identity is](#what-an-identity-is)
2. [The keys in an identity](#the-keys-in-an-identity)
3. [Backup and recovery](#backup-and-recovery)
4. [Where keys live today](#where-keys-live-today)
5. [Never paste a master key into a web page](#never-paste-a-master-key-into-a-web-page)
6. [Rotating and disabling keys](#rotating-and-disabling-keys)
7. [Encryption key (private repositories)](#encryption-key-private-repositories)
8. [Limited keys and the web app](#limited-keys-and-the-web-app)
9. [The browser vault and its limits](#the-browser-vault-and-its-limits)
10. [Trust roots](#trust-roots)

---

## What an identity is

An identity is a record on Dash Platform with:

- an **id**: a 42–44 character base58 string such as `8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB`. It appears in your repository addresses (`dash://<id>/<repo>`);
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
| 2 | AUTHENTICATION | CRITICAL | What HIGH does. Forge uses it only when the file has no HIGH key. |
| 3 | TRANSFER | CRITICAL | Moving credits to another identity, or withdrawing them. |
| 4 | ENCRYPTION | MEDIUM | Private repositories: see [Encryption key](#encryption-key-private-repositories). |

What each tool signs with:

- `git push` (`git-remote-dash`) and every `dg` command that writes, including `dg repo create` and `dg collab add/remove`, sign with the **HIGH** key, falling back to CRITICAL. They are all ordinary documents. Without either key they fail with [`E302`](../errors.md#e302).
- No Forge tool ever needs the MASTER key.

---

## Backup and recovery

**The 12 words are the identity.** Every key above is derived from the 12-word mnemonic the bridge showed you when it created the identity. Anyone who has those words controls the identity and its credits. If you lose them, and every copy of the identity file, **nobody can recover the identity**. Not the Forge project, not Dash Core Group, not anyone.

Do this once:

1. Write the 12 words on paper, in order. Keep two copies in separate places.
2. Keep the words offline. Do not put them in a password manager that syncs, in a note-taking app, or in a screenshot.
3. Treat the identity file (`dash-identity-<id>.json`) like the words. It contains them, plus every private key. Keep it `chmod 600`, and the same for the copy `dg auth login` makes in `~/.config/dash-forge/identities/`. `dg doctor` warns when the identity file it uses is readable by other users, and `dg doctor --fix` tightens it.

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
| Web app | A **limited key** only, encrypted in the browser's IndexedDB (passkey or passphrase), unlocked for the session | Registered once from your identity file, recovery phrase, a new identity, or your wallet; see [below](#limited-keys-and-the-web-app) |

Things to know:

- `DASH_FORGE_KEY` holds a **path** to an identity file today, not the key itself.
- The identity file on disk is plaintext JSON. Protect it with file permissions and full-disk encryption.
- In the web app, the key never leaves that browser, but any script running on the page can use it while it is unlocked ([details](#the-browser-vault-and-its-limits)). Lock or sign out on shared machines.

**Coming soon:** keys in the OS keychain (macOS Keychain, Secret Service, Windows Credential Manager) with a passphrase-encrypted fallback file; `dg auth new` to create an identity from the terminal; `dg auth export` to write a backup file.

---

## Never paste a master key into a web page

A web page is whoever served it. If the page, or a script it loads, is compromised, anything you paste into it is gone.

- **Never paste your MASTER key, your 12 words, or your main identity file into a website.** That includes forge.dashhq.org. Nothing on Forge needs them.
- The web app's **Import** reads your identity file (or recovery phrase) once: its master key signs one update that registers a [limited key](#limited-keys-and-the-web-app) for this browser, and is not retained. If you would rather not load the master key into a web page at all, use **Use my Dash wallet** instead (the wallet registers the key), or register a limited key with `dg` once that lands.
- For CI, give a pipeline a copy of the identity file stripped to its HIGH key (the `jq` recipe in the [mirror guide](mirror-a-github-repo.md#the-ci-secret) makes one) or, better, a separate identity with a small balance.
- Prefer a copy of the web app that you [serve yourself](verify-forge.md#run-your-own-copy-of-the-web-app) if you do not want to trust the one on forge.dashhq.org.

With limited keys (below) the web app keeps nothing but a limited key. The master key is used only in one-time steps: registering, renewing or revoking a limited key.

---

## Rotating and disabling keys

Platform lets the MASTER key add new keys to an identity and disable old ones. A disabled key can never sign again. Your identity id, balance and data stay the same.

Today you do this in the Dash bridge, not in `dg`:

1. Open <https://bridge.thepasta.org> (it defaults to testnet; add `?network=devnet-moutai` for moutai or `?network=mainnet` for mainnet) and choose **Manage Identity Keys**.
2. Sign in with the identity id and the **MASTER** key's private key. This is the one place where the master key is used. Do it on a machine you trust, and check the page address first.
3. Add a new key (for example a new HIGH authentication key), or disable a key you think is exposed.
4. Update your identity file: add an `identityKeys` entry for the new key, and **delete the entry for the key you disabled**. The bridge gives you the new key's private key (WIF). Signing uses only `id`, `purpose`, `securityLevel` and `privateKeyWif`, but every field of an entry must be present for the file to load, so set the ones you don't have (`privateKeyHex`, `publicKeyHex`, `derivationPath`, `name`) to `""` and `keyType` to `"ECDSA_SECP256K1"`. `dg` and `git-remote-dash` sign with the first HIGH authentication key in the file, so a disabled key left in it makes every write fail. Then run `dg auth login --identity <file>` again to refresh the copy `dg` uses.

When to rotate:

- a laptop or CI secret that held a signing key was lost or leaked: **disable that key**;
- you gave a CI job the HIGH key and are retiring the job.

If the **MASTER** key or the 12 words leak, rotating does not help: whoever has them can add keys and disable yours. The identity is lost. Move your credits out with the TRANSFER key to a new identity, and start over there with new repositories: push your clones to them. Repository ownership cannot be transferred, and the attacker now controls everything only the owner can do, such as adding and removing members.

`dg auth keys list` shows the identity's keys on chain: id, purpose, security level, type, enabled or disabled, the contract a key is bound to, and whether your identity file holds its private key. It prints no secrets.

**Coming soon:** `dg auth keys disable`.

---

## Encryption key (private repositories)

A private repository encrypts its content under a repository key, and each member gets that key wrapped (encrypted) to their identity's **ENCRYPTION** key. Without one, nobody can add you to a private repository and you cannot create one. Identities from the bridge carry key 4 for this; many other identities have none.

Add one with:

```sh
dg auth keys add --encryption
```

- It is one identity update, signed by your **MASTER** key, so it needs your full identity file. A `dfk1:` limited key cannot do it.
- It shows the estimate (under 0.0005 DASH) and asks before signing; `--yes` skips the question. It prints the new key's id, and the measured cost once the update lands.
- If the identity already has a usable encryption key whose private key is in your identity file, it does nothing. `--force` adds another one. Every tool uses the highest-id usable one.
- `dg auth keys list` shows the result.

**What it can read.** This key can read every private repo you're a member of, and every key you've handed out as a maintainer. Keep it as carefully as your signing keys.

**Backup.** `dg` writes the new key into your identity file before it sends anything. When the file has your 12 words and its keys follow the bridge's key paths, the key is derived from the words at the next key path (`m/9'/1'/5'/0'/0'/0'/<id>'` on testnet), so the words can recreate it. Otherwise `dg` draws a random key and says so: then the identity file is its **only** copy. Back the file up again after adding the key. If a run is interrupted, running the command again reuses the key already written to the file.

**In the web app** this will be **Settings → Keys → Enable private repos**, with the web release of private repositories.

---

## Limited keys and the web app

*Live in the web app. CLI support (`dg auth …`) is coming.*

A limited key is an identity key with four restrictions:

- AUTHENTICATION purpose, HIGH security level;
- bound to the `dash-forge` **contract group**: it can sign batches on forge-core and forge-collab only. Identity updates, credit transfers and writes to any other contract are refused at consensus;
- a **budget**: the most its transitions can ever take from your identity;
- an **expiry**.

| Where | Budget | Expires |
|---|---|---|
| Browser | 0.05 DASH | 90 days |
| CLI (planned) | 0.25 DASH | 180 days |
| CI runner (Mirror Action, planned) | 0.5 DASH | 365 days |

Ways to get one in the web app (**Sign in**):

| Route | What happens |
|---|---|
| Import an identity file or recovery phrase | Your master key signs one IdentityUpdate that adds the limited key. It is used once and not retained. |
| Create a new identity | 12 words, a short backup check, then a deposit from any Dash wallet (the faucet on devnets). One IdentityCreate registers the standard key set plus this browser's limited key, so no second signature is needed. |
| Use my Dash wallet (App Connect) | Your wallet registers the limited key and hands it over encrypted. **Check that the identity shown is yours**: a response does not prove who answered, and anyone who saw the QR code could answer. The app refuses if more than one identity answers. |
| Advanced: paste a key | A HIGH or CRITICAL key, for this tab only. It has no limits Forge set. Never paste a master key. |

The header shows your balance and the key's remaining budget. It turns amber when the budget drops under 20 % or expiry is less than 7 days away, and red when the key is spent or expired. **Settings → This browser's key** shows the budget and expiry and has these actions:

- **Renew key** registers a fresh key and disables the previous one in the same update.
- **Revoke on chain** disables this browser's key. It needs your identity file once.
- **Sign out & forget key** deletes the key from this device. Forgetting is **not** revoking: a forgotten key stays valid on chain until it expires.

Losing a device costs nothing beyond that key's remaining budget. Register a new key and disable the old one.

The planned CLI (**not available yet**):

```sh
dg auth new [--amount 0.05] [--name alice]      # create + fund an identity from the terminal
dg auth login [<file> | --mnemonic]             # registers a limited key by default
dg auth keys add --budget 0.25 --expires 180d --bound dash-forge
dg auth keys disable <id>
dg auth name register <label>
```

CI will get one pasteable value, `DASH_FORGE_KEY=dfk1:<network>:<identity id>:<key id>:<wif>`, in place of a file.

---

## The browser vault and its limits

The limited key is stored in IndexedDB, encrypted with AES-256-GCM. The data key is wrapped by a passkey's PRF output (stretched with HKDF), by Argon2id of your passphrase (64 MiB, 3 passes, 16-byte salt), or by both. Each ciphertext is bound to its network and identity. Unlocked, the key lives only in page memory. It locks after 12 hours, and is cleared when you lock or sign out.

What the vault does **not** protect against:

- **Script running in the page.** The vault protects the key at rest. While it is unlocked, any script running on the page (an XSS) can use it. The page's CSP allows inline scripts, which Next's static bootstrap needs. It does not allow JavaScript `eval`, only `wasm-unsafe-eval` for the SDK's WebAssembly.
- **Clickjacking where the host cannot send headers.** `frame-ancestors` only works as an HTTP header, and GitHub Pages cannot send one, so the Pages deployment can be framed. Serve the app from a host that sends `Content-Security-Policy: frame-ancestors 'none'` if that matters to you.
- **A shared origin.** On a GitHub Pages project site (`*.github.io/<repo>`) or an IPFS path gateway (`ipfs.io/ipfs/…`), other sites share the origin and could read the vault or ask the browser for the passkey's PRF output. So the app refuses to create or unlock a vault there. Browsing still works. Use <https://forge.dashhq.org> (the Pages deployment's custom domain, set in the repository's Pages settings) or an IPFS subdomain gateway (`<cid>.ipfs.dweb.link`).

---

## Trust roots

- **The contract group id** comes from `forge-contracts/deployments/<network>.json`, which is built into the app. Before binding a key to the group, the app checks on chain that the group holds forge-core and forge-collab. The group's owner (and any admins) can **add** contracts to it later, and every group-bound key can then sign for those contracts too. Binding a key to the group means trusting its owner. On devnet moutai that is the deployer `8HGxMu4atPn4jThH5h9X1MajzhoD3PRnzCRGrAsFcLcV`.
- **The block explorer** (Insight, changeable in Settings) is used only while creating an identity. Its amounts are not trusted: each deposit output is proven from its raw funding transaction, fetched and hashed against its txid, before the asset lock is signed. A lying explorer can delay you or hide funds, but it cannot redirect or burn them. The asset lock is broadcast through the explorer, because the SDK has no Core broadcast. If the explorer drops it, the signed bytes are kept and sent again.
- **The quorum keys** every proof is checked against come from `quorums.<network>.networks.dash.org`, as for every read.
