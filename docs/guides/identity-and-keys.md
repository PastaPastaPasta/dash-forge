# Identity and keys

On Dash Forge, your account is a **Dash Platform identity**. No company holds it for you. There is no password reset and no support desk. This page explains what an identity is, which keys it has, how to back it up, and how to keep its keys out of places they don't belong.

1. [What an identity is](#what-an-identity-is)
2. [The keys in an identity](#the-keys-in-an-identity)
3. [Backup and recovery](#backup-and-recovery)
4. [Where keys live today](#where-keys-live-today)
5. [Never paste a master key into a web page](#never-paste-a-master-key-into-a-web-page)
6. [Rotating and disabling keys](#rotating-and-disabling-keys)
7. [Limited keys and the web app](#limited-keys)
8. [The browser vault and its limits](#the-browser-vault-and-its-limits)
9. [Trust roots](#trust-roots)

---

## What an identity is

An identity is a record on Dash Platform with:

- an **id**: a 42–44 character base58 string such as `8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB`. It appears in your repository addresses (`dash://<id>/<repo>`);
- a set of **public keys**. Anything you write on Forge is signed by one of them, and Platform checks the signature;
- a **credit balance** that pays Platform fees. 1 DASH = 100,000,000,000 credits.

You create an identity by locking some Dash in an *asset lock* transaction. The locked amount becomes the identity's credits. Forge does not create or fund identities for you; see [Costs](costs.md).

Create one from the terminal with `dg auth new`, in the web app (**Sign in → Create a new identity**), or with the Dash bridge (<https://bridge.thepasta.org>). All three derive the same keys from the same 12 words, so an identity made in one opens in the others. The [quick start](quick-start.md#2-get-an-identity) walks through `dg auth new`.

**Usernames.** Platform has a name service, DPNS. Register a username with `dg auth name register <label>` (it needs your identity file or the 12 words once) or in the bridge. Names of 3–19 characters made only of `a`–`z`, `0`, `1` and `-` are *contested*: they go to a masternode vote, and `dg` refuses them. Forge does not resolve usernames in addresses yet: `dash://alice/project` and `dg … alice/project` need the identity id in place of `alice` for now.

---

## The keys in an identity

An identity file from the bridge, the web app or `dg auth new` has five keys, all ECDSA secp256k1, plus the limited keys you add ([below](#limited-keys)):

| Id | Purpose | Security level | Used for |
|---|---|---|---|
| 0 | AUTHENTICATION | **MASTER** | Changing the identity's own keys (add, disable). Nothing on Forge needs it. |
| 1 | AUTHENTICATION | HIGH | Signing documents: pushes, issues, comments, reviews, releases. |
| 2 | AUTHENTICATION | CRITICAL | What HIGH does. Forge uses it only when the file has no HIGH key. |
| 3 | TRANSFER | CRITICAL | Moving credits to another identity, or withdrawing them. |
| 4 | ENCRYPTION | MEDIUM | Reserved for private repositories (coming soon). |
| 5+ | AUTHENTICATION | HIGH | [Limited keys](#limited-keys): what `dg`, `git push` and the web app sign with day to day. |

What each tool signs with:

- `git push` (`git-remote-dash`) and every `dg` command that writes, including `dg repo create` and `dg collab add/remove`, sign with the key `dg auth` stored: a **limited key**. Given a full identity file instead they use its **HIGH** key, falling back to CRITICAL. Without one they fail with [`E302`](../errors.md#e302).
- The MASTER key signs only one-time steps: registering or disabling a limited key (`dg auth login`, `dg auth keys add|disable`, `dg auth logout --disable`). `dg` uses it for that one signature and does not store it.

---

## Backup and recovery

**The 12 words are the identity.** Every key above is derived from the 12-word mnemonic the bridge showed you when it created the identity. Anyone who has those words controls the identity and its credits. If you lose them, and every copy of the identity file, **nobody can recover the identity**. Not the Forge project, not Dash Core Group, not anyone.

Do this once:

1. Write the 12 words on paper, in order. Keep two copies in separate places.
2. Keep the words offline. Do not put them in a password manager that syncs, in a note-taking app, or in a screenshot.
3. Treat the identity file (`dash-identity-<id>.json`) like the words. It contains them, plus every private key. Keep it offline once you have signed in: `dg auth login` stores only a limited key. If you keep it on disk, keep it `chmod 600`; `dg doctor` warns when an identity file it uses is readable by other users, and `dg doctor --fix` tightens it.

If you lose a laptop but still have the words or a backup of the file, nothing is lost. Your repositories, issues and history are on Platform, not on your laptop:

1. On the new machine run `dg auth login --mnemonic` (type the 12 words) or `dg auth login <file>` with your backup. It registers a new limited key and stores only that.
2. Disable the lost machine's key: `dg auth keys list` shows it, `dg auth keys disable <id>` disables it (or pass `--replace <id>` to the login above to do both in one update). A limited key can only spend its remaining budget, and only on Forge, until then.

Your **repository data** needs no backup of its own. Refs, issues and PRs are on Platform. Pack bytes are on Platform or in the storage you chose. Any clone also holds a full copy of the history, and [`dg reseed --from-local`](bring-your-own-storage.md#restoring-a-lost-copy) can restore a lost pack copy from it.

---

## Where keys live today

| Tool | Where the key is | How it finds it |
|---|---|---|
| `dg` | A **limited key** in the OS keychain: macOS Keychain, Secret Service (Linux) or Windows Credential Manager, service `dash-forge`, account `<network>/<identity id>`. Without a keychain: `~/.config/dash-forge/identities/<network>-<id>.key`, sealed under a passphrase (Argon2id + XChaCha20-Poly1305, 0600) | `--identity <source>` > `DASH_FORGE_KEY` > the default `dg auth` recorded in `config.toml` |
| `git-remote-dash` | The same | `DASH_FORGE_KEY`, else the default `dg auth` recorded, else `~/.config/dash-forge/identities/<owner>.identity.json` |
| `forge-import` | The same | `--identity <source>` > `DASH_FORGE_KEY` |
| Web app | A **limited key** only, encrypted in the browser's IndexedDB (passkey or passphrase), unlocked for the session | Registered once from your identity file, recovery phrase, a new identity, or your wallet; see [below](#limited-keys) |

A key *source* (`--identity`, `DASH_FORGE_KEY`, the recorded default) is any of:

- a path to an identity file (bridge JSON), or to a file `dg auth` sealed under a passphrase (the passphrase comes from `DASH_FORGE_PASSPHRASE`, or a prompt);
- `keychain:dash-forge/<network>/<identity id>`, an OS keychain entry;
- `dfk1:<network>:<identity id>:<key id>:<wif>`, one limited key in one value, for CI secrets. Pass it in the environment, not as `--identity` (arguments are visible to other users).

Things to know:

- On macOS `dg` reads and writes the keychain through Apple's `/usr/bin/security`, so `dg`, `git-remote-dash` and upgraded copies of either read the entry without an access dialog. Any program running as you can ask `security` for it without a prompt: the keychain protects entries at rest and from other users. What `dg` keeps there is limited identity keys (a budget, an expiry, Forge contracts only) and the storage credentials `dg storage add` is given, so scope those to the one bucket. A full identity (`dg auth login --full-key`: master key and recovery words) never goes there; it is always a passphrase-sealed file. The GitHub CLI stores its token the same way.
- Over SSH there is no keychain dialog to answer; use a sealed key file there (`DASH_FORGE_NO_KEYCHAIN=1 dg auth login …`).
- `--insecure-plaintext` stores the key unencrypted (0600) where there is no keychain and no way to type a passphrase. Every later use warns.
- In the web app, the key never leaves that browser, but any script running on the page can use it while it is unlocked ([details](#the-browser-vault-and-its-limits)). Lock or sign out on shared machines.

---

## Never paste a master key into a web page

A web page is whoever served it. If the page, or a script it loads, is compromised, anything you paste into it is gone.

- **Never paste your MASTER key, your 12 words, or your main identity file into a website.** That includes forge.dashhq.org. Nothing on Forge needs them.
- The web app's **Import** reads your identity file (or recovery phrase) once: its master key signs one update that registers a [limited key](#limited-keys) for this browser, and is not retained. If you would rather not load the master key into a web page at all, use **Use my Dash wallet** instead (the wallet registers the key), or register a key for the browser from the terminal: `dg auth export --new-key --reveal-secrets --format dfk1 -o key.dfk1` and paste that key under **Advanced**.
- For CI, give a pipeline its own limited key: `dg auth export --new-key --budget 0.5 --expires 365d --format dfk1 --reveal-secrets -o runner.dfk1` makes one, and the file's one line is the `DASH_FORGE_KEY` secret.
- Prefer a copy of the web app that you [serve yourself](verify-forge.md#run-your-own-copy-of-the-web-app) if you do not want to trust the one on forge.dashhq.org.

With limited keys (below) the web app keeps nothing but a limited key. The master key is used only in one-time steps: registering, renewing or revoking a limited key.

---

## Rotating and disabling keys

Platform lets the MASTER key add new keys to an identity and disable old ones. A disabled key can never sign again. Your identity id, balance and data stay the same.

```sh
dg auth keys list                        # every key: purpose, level, budget left, expiry, this computer's
dg auth keys add [--budget 0.25 --expires 180d] [--replace <id>]   # a new limited key for this computer
dg auth keys disable <id>                # disable one (limited keys; --force for others)
dg auth logout [--disable]               # forget the key here (and disable it on chain)
```

`add`, `disable` and `logout --disable` need the master key once: pass `--master <identity file>`, or type the 12 words when asked. `dg` never disables the MASTER key, and refuses keys that are not Forge limited keys unless you pass `--force`.

When to rotate:

- a laptop or CI secret that held a key was lost or leaked: **disable that key**;
- a limited key's budget is nearly spent or it is about to expire: `dg auth keys add --replace <old id>` (or `dg auth login … --replace <old id>`) registers a fresh one and disables the old in the same update.

If the **MASTER** key or the 12 words leak, rotating does not help: whoever has them can add keys and disable yours. The identity is lost. Move your credits out with the TRANSFER key to a new identity, and start over there with new repositories: push your clones to them. Repository ownership cannot be transferred, and the attacker now controls everything only the owner can do, such as adding and removing members.

---

## Limited keys

A limited key is an identity key with four restrictions:

- AUTHENTICATION purpose, HIGH security level;
- bound to the `dash-forge` **contract group**: it can sign batches on forge-core and forge-collab only. Identity updates, credit transfers and writes to any other contract are refused at consensus;
- a **budget**: the most its transitions can ever take from your identity;
- an **expiry**.

| Where | Budget | Expires |
|---|---|---|
| Browser | 0.05 DASH | 90 days |
| CLI (`dg auth new` / `login` / `keys add`) | 0.25 DASH | 180 days |
| CI runner (`dg auth export --new-key`, Mirror Action) | 0.5 DASH | 365 days |

All are editable at creation (`--budget`, `--expires`). Before binding a key, `dg` checks on chain that the contract group holds exactly forge-core and forge-collab, and nothing else.

From the terminal:

```sh
dg auth new [--amount 0.05] [--name alice]      # 12 words → deposit QR → identity + a limited key in the keychain
dg auth login <file> | --mnemonic               # import once; registers a limited key and stores only that
dg auth status                                  # identity, name, key, budget left, expiry, balance, where it is stored
dg auth export --new-key --format dfk1 --reveal-secrets -o runner.dfk1   # a key for CI
dg auth name register <label>                   # a DPNS username
```

`dg auth new` shows the 12 words once and asks you to type three of them back. It then shows the deposit address as a QR code and as text. Fund it from any Dash wallet (the faucet on devnets), and `dg` does the rest: the asset lock, its proof (InstantSend where the network offers one, else a chain lock), and one IdentityCreate that registers the standard keys plus this computer's limited key. The limited key is stored in the keychain *before* the identity exists, so an interruption never leaves a key nobody holds. An interrupted run resumes with `dg auth new --resume` (type the words again); the deposit address stays the same. For automation, `--skip-backup-check --backup-file <file>` writes the words and keys to a passphrase-sealed file instead of showing them.

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

CI gets one pasteable value, `DASH_FORGE_KEY=dfk1:<network>:<identity id>:<key id>:<wif>`, in place of a file. `dg auth export --format dfk1` writes only limited keys.

---

## The browser vault and its limits

The limited key is stored in IndexedDB, encrypted with AES-256-GCM. The data key is wrapped by a passkey's PRF output (stretched with HKDF), by Argon2id of your passphrase (64 MiB, 3 passes, 16-byte salt), or by both. Each ciphertext is bound to its network and identity. Unlocked, the key lives only in page memory. It locks after 12 hours, and is cleared when you lock or sign out.

What the vault does **not** protect against:

- **Script running in the page.** The vault protects the key at rest. While it is unlocked, any script running on the page (an XSS) can use it. The page's CSP allows inline scripts, which Next's static bootstrap needs. It does not allow JavaScript `eval`, only `wasm-unsafe-eval` for the SDK's WebAssembly.
- **Clickjacking where the host cannot send headers.** `frame-ancestors` only works as an HTTP header, and GitHub Pages cannot send one, so the Pages deployment can be framed. Serve the app from a host that sends `Content-Security-Policy: frame-ancestors 'none'` if that matters to you.
- **A shared origin.** On a GitHub Pages project site (`*.github.io/<repo>`) or an IPFS path gateway (`ipfs.io/ipfs/…`), other sites share the origin and could read the vault or ask the browser for the passkey's PRF output. So the app refuses to create or unlock a vault there. Browsing still works. Use <https://forge.dashhq.org> (the Pages deployment's custom domain, set in the repository's Pages settings) or an IPFS subdomain gateway (`<cid>.ipfs.dweb.link`).

---

## Trust roots

- **The contract group id** comes from `forge-contracts/deployments/<network>.json`, which is built into the app and `dg`. Before binding a key to the group, the app checks on chain that the group holds forge-core and forge-collab; `dg` checks that it holds those two and nothing but Forge's own contracts (earlier versions `forge-contracts/deployments/<network>.json` lists as superseded in the same group). Both checks happen when a key is bound: **the group's owner is a trust root**. The group's owner (and any admins) can **add** contracts to it later, and every group-bound key can then sign for those contracts too. Binding a key to the group means trusting its owner. On devnet moutai that is the deployer `8HGxMu4atPn4jThH5h9X1MajzhoD3PRnzCRGrAsFcLcV`.
- **The block explorer** (Insight, changeable in Settings, `dg auth new --explorer <url>`) is used only while creating an identity. Its amounts are not trusted: each deposit output is proven from its raw funding transaction, fetched and hashed against its txid, before the asset lock is signed. A lying explorer can delay you or hide funds, but it cannot redirect or burn them. `dg` broadcasts the asset lock through DAPI first and uses the explorer as the fallback; the web app broadcasts through the explorer, because the JS SDK has no Core broadcast. If either drops it, the signed bytes are kept and sent again.
- **The quorum keys** every proof is checked against come from `quorums.<network>.networks.dash.org`, as for every read.
