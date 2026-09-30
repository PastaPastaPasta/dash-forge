# Identity and keys

On Dash Forge, your account is a **Dash Platform identity**. No company holds it for you. There is no password reset and no support desk. This page explains what an identity is, which keys it has, how to back it up, and how to keep its keys out of places they don't belong.

1. [What an identity is](#what-an-identity-is)
2. [The keys in an identity](#the-keys-in-an-identity)
3. [Backup and recovery](#backup-and-recovery)
4. [Where keys live today](#where-keys-live-today)
5. [Never paste a master key into a web page](#never-paste-a-master-key-into-a-web-page)
6. [Rotating and disabling keys](#rotating-and-disabling-keys)
7. [Limited keys and the web app](#limited-keys)
8. [Encryption key (private repositories)](#encryption-key-private-repositories)
9. [The browser vault and its limits](#the-browser-vault-and-its-limits)
10. [Trust roots](#trust-roots)

---

## What an identity is

An identity is a record on Dash Platform with:

- an **id**: a 42–44 character base58 string such as `8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB`. It appears in your repository addresses (`dash://<id>/<repo>`);
- a set of **public keys**. Anything you write on Forge is signed by one of them, and Platform checks the signature;
- a **credit balance** that pays Platform fees. 1 DASH = 100,000,000,000 credits.

You create an identity by locking some Dash in an *asset lock* transaction. The locked amount becomes the identity's credits. Forge does not create or fund identities for you; see [Costs](costs.md).

Create one from the terminal with `dg auth new`, in the web app (**Sign in → Create a new identity**), or with the Dash bridge (<https://bridge.thepasta.org>). All three derive the same keys from the same 12 words, so an identity made in one opens in the others. The [quick start](quick-start.md#2-get-an-identity) walks through `dg auth new`.

**Usernames.** Platform has a name service, DPNS. Register a username with `dg auth name register <label>` (it needs your identity file or the 12 words once) or in the bridge. Names of 3–19 characters made only of `a`–`z`, `0`, `1` and `-` are *contested*: they go to a masternode vote, and `dg` refuses them. The web app resolves usernames: `forge.dashhq.org/alice/project`, `@alice` in the header's jump box, and names on profiles and in the wallet sign-in confirmation. So does the CLI: `git clone dash://alice/project` and `dg … alice/project` resolve `alice` (or `alice.dash`) through DPNS, proof-verified. The identity id still works everywhere.

---

## The keys in an identity

An identity file from the bridge, the web app or `dg auth new` has five keys, all ECDSA secp256k1, plus the limited keys you add ([below](#limited-keys)):

| Id | Purpose | Security level | Used for |
|---|---|---|---|
| 0 | AUTHENTICATION | **MASTER** | Changing the identity's own keys (add, disable). Nothing on Forge needs it. |
| 1 | AUTHENTICATION | HIGH | Signing documents: pushes, issues, comments, reviews, releases. |
| 2 | AUTHENTICATION | CRITICAL | What HIGH does. Forge uses it only when the file has no HIGH key. |
| 3 | TRANSFER | CRITICAL | Moving credits to another identity, or withdrawing them. |
| 4 | ENCRYPTION | MEDIUM | Private repositories (see [Encryption key](#encryption-key-private-repositories)), and decrypting webhook secrets addressed to a relay you run. |
| 5+ | AUTHENTICATION | HIGH | [Limited keys](#limited-keys): what `dg`, `git push` and the web app sign with day to day. |

What each tool signs with:

- `git push` (`git-remote-dash`) and every `dg` command that writes, including `dg repo create` and `dg collab add/remove`, sign with the key `dg auth` stored: a **limited key**. Given a full identity file instead they use its **HIGH** key, falling back to CRITICAL. Without one they fail with [`E302`](../errors.md#e302).
- The web app signs with this browser's [limited key](#limited-keys).
- The MASTER key signs only one-time steps: registering, topping up or disabling a limited key (`dg auth login`, `dg auth keys add|disable`, `dg auth logout --disable`, and the web app's Import, Renew, Top up and Revoke). It is used for that one signature and not stored.

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
3. In a browser, **Sign in → Import an identity file or recovery phrase** registers a fresh limited key for that browser; the words alone are enough.

Your **repository data** needs no backup of its own. Refs, issues and PRs are on Platform. Pack bytes are on Platform or in the storage you chose. Any clone also holds a full copy of the history, and [`dg reseed --from-local`](bring-your-own-storage.md#restoring-a-lost-copy) can restore a lost pack copy from it.

---

## Where keys live today

| Tool | Where the key is | How it finds it |
|---|---|---|
| `dg` | A **limited key** in the OS keychain: macOS Keychain, Secret Service (Linux) or Windows Credential Manager, service `dash-forge`, account `<network>/<identity id>`. Without a keychain: `~/.config/dash-forge/identities/<network>-<id>.key`, sealed under a passphrase (Argon2id + XChaCha20-Poly1305, 0600) | `--identity <source>` > `DASH_FORGE_KEY` > the default `dg auth` recorded in `config.toml` |
| `git-remote-dash` | The same | `DASH_FORGE_KEY`, else `~/.config/dash-forge/identities/<owner>.identity.json` if that file exists, else the default `dg auth` recorded |
| `forge-import` | The same | `--identity <source>` > `DASH_FORGE_KEY` |
| Mirror Action | A CI secret: an inline runner key, or a CI-only identity file | the `DASH_FORGE_KEY` secret ([mirror guide](mirror-a-github-repo.md#the-ci-secret)) |
| Web app | A **limited key** (or a wallet-granted key with no limits, see below), encrypted in the browser's IndexedDB (passkey or passphrase), unlocked for the session | Registered once from your identity file, recovery phrase, a new identity, or your wallet; see [below](#limited-keys) |

A key *source* (`--identity`, `DASH_FORGE_KEY`, the recorded default) is any of:

- a path to an identity file (bridge JSON), or to a file `dg auth` sealed under a passphrase. The passphrase comes from `DASH_FORGE_PASSPHRASE`, or from a prompt on the terminal; `git-remote-dash` asks on `/dev/tty`. A `git push` that `dg` runs (`dg init`, `dg pr merge`) doesn't ask again: `dg` hands the unlocked key to the helper through a pipe only that `git` inherits, never through the environment;
- `keychain:dash-forge/<network>/<identity id>`, an OS keychain entry;
- `dfk1:<network>:<identity id>:<key id>:<wif>`, one limited key in one value, for CI secrets. Pass it in the environment, not as `--identity` (arguments are visible to other users). `dg`, `git-remote-dash`, `forge-import` and the Mirror Action all accept it.

Things to know:

- On macOS `dg` reads and writes the keychain through Apple's `/usr/bin/security`, so `dg`, `git-remote-dash` and upgraded copies of either read the entry without an access dialog. Any program running as you can ask `security` for it without a prompt: the keychain protects entries at rest and from other users. What `dg` keeps there is limited identity keys (a budget, an expiry, Forge contracts only) and the storage credentials `dg storage add` is given, so scope those to the one bucket. A full identity (`dg auth login --full-key`: master key and recovery words) never goes there; it is always a passphrase-sealed file. The GitHub CLI stores its token the same way.
- Over SSH there is no keychain dialog to answer; use a sealed key file there (`DASH_FORGE_NO_KEYCHAIN=1 dg auth login …`).
- `--insecure-plaintext` stores the key unencrypted (0600) where there is no keychain and no way to type a passphrase. Every later use warns.
- In the web app, the key never leaves that browser, but any script running on the page can use it while it is unlocked ([details](#the-browser-vault-and-its-limits)). Lock or sign out on shared machines.

---

## Never paste a master key into a web page

A web page is whoever served it. If the page, or a script it loads, is compromised, anything you paste into it is gone.

- **Never paste your MASTER key, your 12 words, or your main identity file into a website.** That includes forge.dashhq.org. Nothing on Forge needs them.
- The web app's **Import** reads your identity file (or recovery phrase) once: its master key signs one update that registers a [limited key](#limited-keys) for this browser, and is not retained. If you would rather not load the master key into a web page at all, use **Use my Dash wallet** instead (the wallet registers the key), or register a key for the browser from the terminal: `dg auth export --new-key --reveal-secrets --format dfk1 -o key.dfk1`, then under **Advanced** enter the identity id and the key's WIF (the last `:`-separated field of the `dfk1` value). It signs for that tab only.
- For CI, give a pipeline its own limited key: `dg auth export --new-key --budget 0.5 --expires 365d --format dfk1 --reveal-secrets -o runner.dfk1` makes one, and the file's one line is the `DASH_FORGE_KEY` secret.
- Prefer a copy of the web app that you [serve yourself](verify-forge.md#run-your-own-copy-of-the-web-app) if you do not want to trust the one on forge.dashhq.org.

With limited keys (below) the web app keeps nothing but a limited key (or, after a wallet sign-in, the key the wallet granted). The master key is used only in one-time steps: registering, topping up, renewing or revoking a limited key.

---

## Rotating and disabling keys

Platform lets the MASTER key add new keys to an identity and disable old ones. A disabled key can never sign again. Your identity id, balance and data stay the same.

```sh
dg auth keys list                        # every key: purpose, level, budget left, expiry, this computer's
dg auth keys add [--budget 0.25 --expires 180d] [--replace <id> | --keep-current]   # a new key for this computer; disables the one it replaces
dg auth keys disable <id>                # disable one (limited keys; --force for others)
dg auth logout [--disable]               # forget the key here (and disable it on chain)
```

`add`, `disable`, `logout --disable` and `export --new-key` need the master key once: pass `--master <identity file>`, or type the 12 words when asked. `dg` never disables the MASTER key, and refuses keys that are not Forge limited keys unless you pass `--force`.

When to rotate:

- a laptop or CI secret that held a key was lost or leaked: **disable that key**;
- a limited key's budget is nearly spent or it is about to expire: `dg auth keys add` registers a fresh one and disables this computer's current key in the same update (`--replace <id>` names another key to disable, `--keep-current` keeps the current one live on chain, though this computer no longer stores it; `dg auth login … --replace <old id>` does the same at sign-in).

A browser's own key is managed in the web app: **Settings → This browser's key** can top it up, renew it or revoke it ([below](#limited-keys)).

If the **MASTER** key or the 12 words leak, rotating does not help: whoever has them can add keys and disable yours. The identity is lost. Move your credits out with the TRANSFER key to a new identity, and start over there with new repositories: push your clones to them. Repository ownership cannot be transferred, and the attacker now controls everything only the owner can do, such as adding and removing members.

---

## Encryption key (private repositories)

A private repository encrypts its content under a repository key, and each member gets that key wrapped (encrypted) to their identity's **ENCRYPTION** key. Without one, nobody can add you to a private repository and you cannot create one. Identities from `dg auth new`, the bridge and the web app carry key 4 for this.

**Using it from the CLI.** Reading or writing a private repository needs the ENCRYPTION key's private half, and the limited key `dg auth login` stores is a signing key only. For private repositories, point `DASH_FORGE_KEY` at your identity file, or sign in with `dg auth login --full-key <identity file>` (kept in a passphrase-sealed file, never the keychain). Without it, private-repo commands stop with [`E306`](../errors.md#e306).

**An identity without one** can add it:

```sh
dg auth keys add --encryption
```

- One identity update, signed by your **MASTER** key (your identity file, or your recovery words typed when asked). The key is derived from the recovery words at the identity's key path with the next key id (`m/9'/<coin>'/5'/0'/0'/0'/<id>'`), so the words alone recover it; nothing is stored by `dg`.
- If the identity already has an ENCRYPTION key, it says so and does nothing.
- `dg auth keys list` shows the result.

**What it can read.** This key can read every private repo you're a member of, and every key you've handed out as a maintainer. Keep it as carefully as your signing keys.

**In the web app** this will be **Settings → Keys → Enable private repos**, with the web release of private repositories.

---

## Limited keys

A limited key is an identity key with four restrictions:

- AUTHENTICATION purpose, HIGH security level;
- bound to the `dash-forge` **contract group**: it can sign batches on the group's members only. These are forge-core, forge-collab, and any later Forge contract the Forge deployer adds to the group. Identity updates, credit transfers and writes to any other contract are refused at consensus;
- a **budget**: the most its transitions can ever take from your identity;
- an **expiry**.

| Where | Budget | Expires |
|---|---|---|
| Browser | 0.05 DASH | 90 days |
| CLI (`dg auth new` / `login` / `keys add`) | 0.25 DASH | 180 days |
| CI runner (`dg auth export --new-key`, Mirror Action) | 0.5 DASH | 365 days |

All are editable at creation (`--budget`, `--expires`).

**What else the key can sign for.** Only the group's owner can add members to the group. That owner is the Forge deployer, and nobody else can take the role: the owner and admins are fixed when the group is created. Before binding a key, `dg` and the web app check on chain, with proofs, that:

- the group's owner is the deployer recorded in the app, and the group has no admins;
- the group holds forge-core and forge-collab;
- every other member belongs to a contract the deployer owns.

If any check fails, they refuse. A member the app does not know yet, such as a newer Forge contract revision, is accepted and listed before you confirm the key: `dg` adds a `note:` line to its explanation, and the web app shows it on the key-creation screen. A member contract the app cannot read is accepted too, because only the pinned owner could have added it, and the note says so. With `dg` only, pass `--strict-group` (or set `DASH_FORGE_STRICT_GROUP=1`, for CI) to refuse anything beyond the contracts your `dg` knows. See [trust roots](#trust-roots) and [forge-v2 § Contract group trust](../contracts/forge-v2.md#contract-group-trust).

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
| Create a new identity | 12 words, a check on three of them, a choice of passkey or passphrase, then a deposit from any Dash wallet (the faucet on devnets). One IdentityCreate registers the standard key set plus this browser's limited key, so no second signature is needed. The key is stored in the vault *before* it is registered, and an interrupted creation resumes when you type the same words again. |
| Use my Dash wallet | **Not a limited key**, and **testnet only**: Dash Wallet's sign-in feature (DashConnect, More → Tools → Connections in the DashPay app) answers on testnet, is not in a released version yet, and Forge is not on testnet yet. On bonsia only an internal iOS build with the login contract entered by hand can answer ([below](#signing-in-with-the-dash-wallet-app-what-works-today)). Scan the QR code with the wallet (or tap **Open in DashPay (Dash Wallet)** on the phone) and approve; the first time, scan (or open) a second code, and the wallet adds Forge's key to your identity (iOS asks for your PIN). Your wallet hands the key over encrypted. **Check that the username and identity shown match what your wallet showed**: a response does not prove who answered, and anyone who saw the QR code could answer. On the App Connect contract the app refuses if more than one identity answers; on the key-exchange contract today's wallets use, the first answer wins. Today's Dash Wallet grants a key with **no spending limit or expiry** (on iOS, for one contract per approval, so issues and pull requests take one more approval), and Settings offers to replace the key with a limited one or disable it. See [wallet-login](../design/wallet-login.md). |
| Advanced: paste a key | A HIGH or CRITICAL key, for this tab only, lost on reload. It has no limits Forge set. Never paste a master key. |

The header shows your balance and the key's remaining budget. It turns amber when the budget drops under 20 % or expiry is less than 7 days away, and red when the key is spent or expired. A write that would overrun either is refused before it is signed, and the sheet that opens says which one blocks. **Settings → This browser's key** shows the budget and expiry and has these actions:

- **Top up key budget** adds budget to the same key (0.05 DASH by default) and can push its expiry out, up to 365 days. It is a protocol-14 `IdentityKeyLimitsUpdate`, signed once by your master key from the identity file or recovery phrase, and costs about 0.00002 DASH.
- **Renew key** registers a fresh key and disables the previous one in the same update.
- **Lock** drops the unlocked key in every open tab and ends the kept session; unlock again with the passkey or passphrase.
- **Settings → Security → Stay signed in for public repos (12 h)** (on by default): reloads and new tabs keep only the spend-capped signing key. Private repos, storage credentials and wallet grants still ask you to unlock, once per tab. Turn it off and every reload or new tab starts locked.
- **Revoke on chain** disables this browser's key. It needs your identity file once.
- **Sign out & forget key** deletes the key from this device. Forgetting is **not** revoking: a forgotten key stays valid on chain until it expires.

For a key a wallet granted without limits, **Renew key** reads **Replace with a limited key**, **Revoke on chain** reads **Disable key on chain**, and **Top up key budget** is not offered (Platform cannot add limits to such a key).

Losing a device costs nothing beyond that key's remaining budget. Register a new key and disable the old one.

### Signing in with the Dash Wallet app: what works today

The **Use my Dash wallet** tile speaks the key exchange (DashConnect) that Dash Wallet for Android and iOS implement on their development branches: it is not in a released version yet (dash-wallet v11.9.0, dashwallet-ios v9.0.2). Forge reads answers both from their key-exchange contract and from the protocol-14 App Connect contract. What they grant is limited too: neither wallet registers a spending limit or an expiry, and Android also drops the contract bound ([wallet-login.md](../design/wallet-login.md) has the full analysis). Where it works:

| Wallet | Network | Works today |
|---|---|---|
| Dash Wallet iOS, internal build | devnet bonsia | **Only with a manual override**: devnets exist only in internal builds; point the wallet at Forge's key-exchange contract (Settings → Devnet Settings → DashConnect Contract ID `4avwgxyfhPjtiTTNwkz9ei7bYTHG5NUUtwNx9mA8Uzwh`) with a DashPay identity on bonsia. Not yet run on a real device. |
| Dash Wallet iOS and Android (testnet builds) | testnet | Once forge-v2 is on testnet (protocol 14), in a wallet built with DashConnect. |
| Dash Wallet Android | devnets | No: it refuses every request off testnet, and pins the testnet contract. |
| Dash Wallet iOS | mainnet | No: Connections is off on mainnet. |
| Dash Wallet Android | mainnet | No: the feature is off on mainnet builds. |
| A wallet that grants group-bound, limited keys through App Connect | bonsia, and every network at protocol 14 | Yes: one approval, and no warning. None ships yet; unit-tested. |

What to expect with today's wallets:

- **Two approvals (iOS).** The iOS wallet grants a key for one contract per approval. The first covers repositories and pushes (forge-core); the first sign-in also asks you to approve a second code that adds that key to your identity. The first issue, PR, review or star asks for one more approval (**Approve issues and pull requests**), for forge-collab, plus, the first time, a second code that registers that key. Android's key is not bound to any contract, so it covers both at once (see the next point).
- **No spending limit or expiry.** The wallets register the key without a budget or an expiry (Android's is not even bound to a contract), and Platform cannot add limits to such a key later. The app warns about it on the confirmation step and in Settings, and prefers a passkey to protect it. **Replace with a limited key** (your identity file or 12 words, once) swaps it for a normal budgeted key and disables the wallet's keys in the same update.
- **A disabled wallet key cannot be replaced by the wallet.** The wallet derives the same key every time, so after you disable it the wallet cannot give Forge a fresh one. Forge refuses that sign-in; use Import instead.
- **Check the identity yourself.** The answer does not prove who sent it: on the wallets' contract, whoever answers the QR code first is the identity Forge shows. Compare the username and identity id with the wallet's approval screen, which shows the username and the first 7 and last 5 characters of the id. Forge warns when the identity has no username, a username less than a day old, or is not the one this browser already knows. A request expires after 5 minutes; keep the QR code private.

Drafts of the wallet-side fixes (group-scoped, limited grants; a signature that proves which identity answered) are in [`docs/upstream/`](../upstream/app-connect-responder-auth.md), for the owner to file with dashpay.

CI gets one pasteable value, `DASH_FORGE_KEY=dfk1:<network>:<identity id>:<key id>:<wif>`, in place of a file. `dg auth export --format dfk1` writes only limited keys.

---

## The browser vault and its limits

The limited key is stored in IndexedDB, encrypted with AES-256-GCM. The data key is wrapped by a passkey's PRF output (stretched with HKDF), by Argon2id of your passphrase (64 MiB, 3 passes, 16-byte salt), or by both. Each ciphertext is bound to its network and identity.

Once unlocked, a session lasts across reloads, typed URLs and new tabs for **public repos**: up to 12 hours after the unlock, and not after 4 hours without use. It ends at once when you lock or sign out in any tab (every tab locks), or when the key turns out to be disabled or expired on chain. A resumed session holds only a signing key bound to Forge's contracts, with a budget and an on-chain expiry (a browser key: 0.05 DASH and 90 days by default; a wallet's key only when the wallet gave it a budget and an expiry). Anyone with JavaScript running on this site, or a copy of your browser profile taken within the window, could use that key. Your encryption key, storage credentials and wallet grants are never stored unlocked: a reloaded tab asks you to unlock (one passkey gesture, or your passphrase) the first time it needs them, and keeps them in that tab's memory only. Turn this off with **Stay signed in for public repos**.

What the vault does **not** protect against:

- **Script running in the page.** The vault protects the key at rest. While it is unlocked, any script running on the page (an XSS) can use it. During the stay-signed-in window a script on any page load of this site can also read the kept signing key and send it off, bounded by that key's budget and on-chain expiry (not the encryption key, storage credentials or wallet grants, which are never kept). The page's CSP allows inline scripts, which Next's static bootstrap needs. It does not allow JavaScript `eval`, only `wasm-unsafe-eval` for the SDK's WebAssembly.
- **Someone with a copy of your browser profile, taken within the window.** The kept record is deleted when the app next runs after it expires, not the moment it does, and the browser may keep the key that seals it in the profile. So a copy taken before your next visit can use the signing key without your passphrase or passkey, until its budget or on-chain expiry runs out, or you revoke it. Nothing else of the vault is in that record. **Stay signed in for public repos** off closes this.
- **Clickjacking where the host cannot send headers.** `frame-ancestors` only works as an HTTP header, and GitHub Pages cannot send one, so the Pages deployment can be framed (a framed page never picks up a kept session, so it opens locked). Serve the app from a host that sends `Content-Security-Policy: frame-ancestors 'none'` if that matters to you.
- **A shared origin.** On a GitHub Pages project site (`*.github.io/<repo>`) or an IPFS path gateway (`ipfs.io/ipfs/…`), other sites share the origin and could read the vault or ask the browser for the passkey's PRF output. So the app refuses to create or unlock a vault there. Browsing still works. Use <https://forge.dashhq.org> (the Pages deployment's custom domain, set in the repository's Pages settings) or an IPFS subdomain gateway (`<cid>.ipfs.<gateway>`).

---

## Trust roots

- **The contract group id** comes from `forge-contracts/deployments/<network>.json`, which is built into the app and `dg`. So is **the group's owner**, which the same file pins. The owner (and any admins, of which Forge's group has none) is the only identity that can **add** contracts to the group. Every group-bound key can then sign for those contracts too, including keys registered earlier. Binding a key to the group therefore means trusting its owner. On devnet bonsia that is the deployer `A5JcvLwu8kuwYtxQ4yxb1RBxH8JbnpNG3F67dEjDiqgo`. Before binding a key, the app and `dg` check on chain, with proofs, that the group's owner is the pinned one and that it has no admins. They also cross-check that every member belongs to a contract that owner owns. Members they do not know are listed, not refused. `dg --strict-group` refuses them ([forge-v2 § Contract group trust](../contracts/forge-v2.md#contract-group-trust)). The owner cannot change, so this pin holds for the life of the group.
- **Watching the deposit** goes through DAPI, the Dash network's own evonodes: a bloom-filtered `subscribeToTransactionsWithProofs` feed of the deposit address from the block the creation started at, `broadcastTransaction` for the asset lock and `getTransaction` for its height. The block explorer (Insight, changeable in Settings, `dg auth new --explorer <url>`) is only a fallback, asked when DAPI cannot answer or the feed is idle. Neither is trusted with amounts: each deposit output is read from a raw transaction whose txid is computed locally (an explorer's is fetched and hashed against the txid it named) before the asset lock is signed. A lying node or explorer can delay you or hide funds, but it cannot redirect or burn them. If a broadcast is dropped, the signed bytes are kept and sent again.
- **The quorum keys** every proof is checked against come from `quorums.<network>.networks.dash.org`, as for every read. The web app compares them with a second source on each repository page ([Verify Forge](verify-forge.md#the-web-app-cross-checks-the-keys-with-a-second-source)).
- **The code doing the checking**: the web app you loaded, or the `dg` you built. If you do not trust forge.dashhq.org, [serve the app yourself](verify-forge.md#run-your-own-copy-of-the-web-app).
