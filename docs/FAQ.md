# FAQ

## Who hosts Dash Forge?

Nobody. There is no Forge server, company account or database.

- **Refs, issues, PRs, reviews and access control** are documents on **Dash Platform**, a network run by Dash masternodes. Each document is signed by its author's identity.
- **Pack bytes** (the git objects) are stored wherever the repository's owner puts them: their own S3-compatible bucket, an IPFS node, or Platform itself.
- **The web app** is a static site. It is served from GitHub Pages at forge.dashhq.org, and anyone can build it and serve it elsewhere.
- **The CLI** (`dg`, `git-remote-dash`) talks to Platform nodes and storage directly.

The Forge project publishes code and nothing else. Anything that looks hosted is either a static file or something you run yourself.

## Can my repository be taken down?

Not at the protocol level. The Forge contracts are registered **without Platform's contract moderation**, so nobody can delete your documents or ban your identity. That includes the Forge project, Dash Core Group, and the masternode operators. Ref history can't be deleted even by you, so nobody can rewind a branch.

What someone *can* do:

- **Your storage provider** can delete your bucket. Refs and history metadata survive on Platform, but the bytes in that bucket go. Protect against this with a second copy (`dg storage use r2-main,kubo`), with Platform storage for packs that must outlive every bucket, and with `dg reseed --from-local`, which restores a lost copy from any clone. See [Bring your own storage](guides/bring-your-own-storage.md).
- **GitHub, a domain registrar or Cloudflare** can take down forge.dashhq.org. The repositories are not there, so they are unaffected. See the next question.
- **A government** can block access to Platform nodes or gateways in a country. That is a network problem, not a takedown. The data is still there, and reachable from anywhere else.

## Is there any moderation?

Not at the protocol level. Spam and abuse cost the sender fees, which is the only floor. Clients can still choose what to show: an issue's or PR's state counts only changes made by its author or by the repository's members, and anyone can build a client that filters more. No one can delete another person's documents.

## What if forge.dashhq.org disappears?

Nothing is lost. Your repositories live on Platform and in your storage, not on the website.

- `git clone dash://…`, `git push` and every `dg` command keep working. They never touch the website.
- The web app is a static build of [`forge-web/`](../forge-web). Build it and serve it from anywhere, including IPFS: see [Run your own copy of the web app](guides/verify-forge.md#run-your-own-copy-of-the-web-app).

## Do I have to trust the website, or Platform nodes?

Mostly not. Every Platform read is checked against a proof, and every byte is checked against its hash. Two things are still trusted. First, the HTTPS endpoint that supplies the validator quorum keys proofs are checked against; the web app compares those keys with a second source (Platform nodes themselves) on every repository page and says **Failed** if they disagree. Second, the code doing the checking: the web app's checks protect you only if the JavaScript you loaded is the real app, so if you don't trust forge.dashhq.org (GitHub Pages), build the app yourself from source you have read and serve it, or use the CLI, which needs no website. [Verify Forge](guides/verify-forge.md) explains the Verification card, and shows how to cross-check the keys against your own Dash node.

## Who pays for it?

You, directly, and only for what you write. Platform fees come from your identity's credits. Storage bills come from your own provider, if you use one. Reading and cloning are free. Nobody sponsors identities. See [Costs](guides/costs.md).

## How much does it cost?

Measured on devnet bonsia: creating a repository costs about **0.0016 DASH**. A push to your own bucket costs about **0.004–0.0055 DASH**. An issue costs about 0.0008–0.0012 DASH. Storing packs on Platform costs about 0.33 DASH per MiB. On devnet moutai, a fork of a small repository cost about 0.01 DASH, and a first GitHub mirror of a small repository about 0.08 DASH. On a devnet all of it is paid in free test Dash. The full table is in [Costs](guides/costs.md).

## What happened to devnet bonsia?

It was retired, and everything on it is gone. Forge moved to devnet sakura (Dash Platform v5), where its contracts were registered again on 2026-10-01. An installed `dg` built for 4.2.0-beta.7 does not work on sakura. Your git clone and your storage bucket are untouched. See [Dash Forge moved to devnet sakura](guides/devnet-move.md) for what is lost and kept and how to re-push.

## When is it on mainnet?

After **Dash Platform v5** activates on mainnet and the project owner registers Forge's contracts there. Forge needs Platform v5 for its shared contracts, membership checks and limited keys. Until then:

| Network | Status |
|---|---|
| **Devnet sakura** | **Live.** forge.dashhq.org runs here. The CLI defaults to testnet, so select sakura with `--network devnet --devnet-name sakura`. |
| **Testnet** | Not deployed yet. Forge is registered there once testnet runs Dash Platform v5. |
| **Mainnet** | Not deployed yet. After Dash Platform v5 activates, the owner registers Forge's contracts ([runbook](mainnet-runbook.md)). |

Forge has left the earlier devnets: bonsia was retired, and moutai was upgraded in place. [Networks](networks.md) has their history.

An earlier version of Forge (forge-v1, one contract per repository) ran on testnet. It was removed on 2026-09-26 with no backwards compatibility, so its repositories cannot be read or migrated.

`dg doctor` shows which network you are on, its protocol version, and whether forge-v2 is deployed there.

## Can I have private repositories?

Yes, on devnet sakura: `dg repo create --private` (or `dg init --private`), and **New → Repository → Private** in the web app. Contents are encrypted in the client with a per-repository key that only members hold, and branch names, issues, PRs, comments and reviews are encrypted too. Anyone can still see that the repository exists, its name, its members, its size and when it changes. Forks and webhooks are refused on private repositories, because they would publish content unencrypted ([E207](errors.md#e207)). Releases are supported and sealed: a private repository's release notes and asset list are encrypted, and so is every asset file Forge seals, in the web app and in `dg release create`, `unpublish` and `download`. The one exception is an imported asset that could not be fetched and sealed: it stays an external link, whose URL is hidden but whose file is not encrypted, so anyone who can reach its source can read it. Label definitions are allowed but stay public. Removing a member rotates the key for future content, but cannot take back what they could already read. [Collaborating](guides/collaborating.md#private-repositories) lists exactly what is hidden and what is not; the design is in [private-repos.md](security/private-repos.md) and [forge-v2.md §5](contracts/forge-v2.md#5-private-repositories).

## How does this relate to GitHub?

Forge is not a GitHub clone, and it does not need you to leave GitHub.

- **The commands are familiar.** `dg` is shaped like `gh`, and git itself is unchanged: `git clone dash://…`, `git push`, branches, tags. jj works too.
- **You can mirror.** Keep working on GitHub, and keep an [unkillable mirror](guides/mirror-a-github-repo.md) on Forge. The Mirror Action keeps code, issues, PRs, releases and labels in sync on every GitHub event.
- **CI can listen.** `dg webhook add` and a relay you run deliver GitHub-shaped webhooks, so existing CI receivers work ([Collaborating](guides/collaborating.md#webhooks-and-ci)).
- **It is not at feature parity.** No hosted CI (bring your own: [forge-runner](guides/self-host-runner.md) runs GitHub Actions workflows on your machine and reports checks with a runner key), and no wiki, discussions, organizations or global search. No `https://` clone URLs (that would need a server); the web app offers a zip download instead. No shallow clones: use `git clone --filter=blob:none` instead. The web app opens, reviews and merges PRs and forks repositories, but some merges still need `dg`: changes both sides made to the same files, a private repository, a merge too large to build in the browser, and a history that changes `.gitmodules` or `.gitattributes` or holds an object git would reject. See [Collaborating](guides/collaborating.md#from-the-web-app). [Moving from GitHub or GitLab](guides/moving-from-github.md#10-github-features-with-no-forge-equivalent) lists what has no equivalent, and the workarounds.

## Can I use a username instead of the long identity id?

Yes: register a DPNS username with `dg auth name register <label>` (or in the Dash bridge). Then `forge.dashhq.org/alice/project`, `@alice` in the web header's jump box, `git clone dash://alice/project` and `dg … alice/project` all resolve it, with a proof-verified DPNS read. `dg repo list --owner` and granting access (`dg collab add`) still take the identity id.

## I lost my laptop. Is my code gone?

No. Your repositories are on Platform and in your storage. Your identity survives as long as you have its 12 words or a backup of the identity file. A browser key on the lost laptop can spend at most its remaining budget, only on Forge, until it expires; revoke it from another device to stop it sooner. See [Backup and recovery](guides/identity-and-keys.md#backup-and-recovery).

## I lost my 12 words and my identity file.

Then that identity is gone. Nobody can recover it, and nobody can sign as it again. Everything it published stays readable and clonable. Its repositories can no longer gain or lose members, because only the owner can change membership. Members it already added can keep pushing. To carry on under a new identity, create a new repository and push your clone to it. [Keep the words safe.](guides/identity-and-keys.md#backup-and-recovery)

## Which browsers does the web app support?

Chrome and Edge 103 or newer, Firefox 104 or newer, and Safari 16 or newer (macOS and iOS). That floor comes from what the app needs to run at all: WebAssembly under a strict content policy (`wasm-unsafe-eval`), IndexedDB, WebCrypto, `AbortSignal.timeout` and `Array.prototype.findLast`. It is declared as the `browserslist` in `forge-web/package.json`, which the build compiles for.

Protecting the browser vault with a **passkey** also needs WebAuthn's PRF extension, which depends on the browser (Chrome and Edge 116, Safari 18, recent Firefox), the operating system and the passkey provider (iCloud Keychain and Google Password Manager support it; some third-party managers and security keys do not). Where it is missing, use a passphrase instead; everything else works the same.

## Where do I report a bug?

[GitHub Issues](https://github.com/PastaPastaPasta/dash-forge/issues) for now. Every error `dg` prints has a code; [errors.md](errors.md) explains each one.
