# FAQ

### Who hosts Dash Forge?

Nobody. There is no Forge server, company account or database.

- **Refs, issues, PRs, reviews and access control** are documents on **Dash Platform**, a network run by Dash masternodes. Each document is signed by its author's identity.
- **Pack bytes** (the git objects) are stored wherever the repository's owner puts them: their own S3-compatible bucket, an IPFS node, or Platform itself.
- **The web app** is a static site. It is served from GitHub Pages at forge.dashhq.org, and anyone can build it and serve it elsewhere.
- **The CLI** (`dg`, `git-remote-dash`) talks to Platform nodes and storage directly.

The Forge project publishes code and nothing else. Anything that looks hosted is either a static file or something you run yourself.

### Can my repository be taken down?

Not at the protocol level. The Forge contracts are registered **without Platform's contract moderation**, so nobody can delete your documents or ban your identity. That includes the Forge project, Dash Core Group, and the masternode operators. Refs and ref history can't be deleted even by you (forge-v2 keeps them permanently), so nobody can rewind a branch.

What someone *can* do:

- **Your storage provider** can delete your bucket. Refs and history metadata survive on Platform, but the bytes in that bucket go. Protect against this with a second copy (`dg storage use r2-main,kubo`), with Platform storage for packs that must outlive every bucket, and with `dg reseed --from-local`, which restores a lost copy from any clone. See [Bring your own storage](guides/bring-your-own-storage.md).
- **GitHub, a domain registrar or Cloudflare** can take down forge.dashhq.org. The repositories are not there, so they are unaffected. See the next question.
- **A government** can block access to Platform nodes or gateways in a country. That is a network problem, not a takedown. The data is still there, and reachable from anywhere else.

### Is there any moderation?

Not at the protocol level. Spam and abuse cost the sender fees, which is the only floor. Clients can still choose what to show: a repository's view counts only its members' approvals and state changes, and anyone can build a client that filters more. No one can delete another person's documents.

### What if forge.dashhq.org disappears?

Nothing is lost. Your repositories live on Platform and in your storage, not on the website.

- `git clone dash://…`, `git push` and every `dg` command keep working. They never touch the website.
- The web app is a static build of [`forge-web/`](../forge-web). Build it and serve it from anywhere, including IPFS: see [Run your own copy of the web app](guides/verify-forge.md#run-your-own-copy-of-the-web-app).

### Do I have to trust the website, or Platform nodes?

No, with one exception. Every Platform read is checked against a proof, and every byte is checked against its hash. What you still trust is the HTTPS endpoint that supplies the validator quorum keys proofs are checked against. [Verify Forge](guides/verify-forge.md) explains it, and shows how to cross-check those keys against your own Dash node.

### Who pays for it?

You, directly, and only for what you write. Platform fees come from your identity's credits. Storage bills come from your own provider, if you use one. Reading and cloning are free. Nobody sponsors identities. See [Costs](guides/costs.md).

### How much does it cost?

On forge-v2, creating a repository costs about **0.001 DASH**, and a push to your own bucket about **0.0003 DASH**. On today's testnet (v1) a repository costs about 1.18 tDASH, which is free test money. Storing packs on Platform costs about 0.28 DASH per MiB. The full table is in [Costs](guides/costs.md).

### When is it on mainnet?

After **Dash Platform protocol 14** activates on mainnet. forge-v2 depends on protocol 14 for its shared contracts, membership checks and limited keys. Until then:

| Network | Status |
|---|---|
| **Testnet** | v1 is live: one contract per repository, token-based access. Protocol 14 is expected on testnet shortly before mainnet. |
| **Devnet moutai** | forge-v2 contracts are registered, and client support is landing now. |
| **Mainnet** | Not deployed. The forge-v2 contracts will be registered once protocol 14 is active. |

`dg doctor` shows which network you are on, its protocol version, and whether forge-v2 is deployed there.

### Can I have private repositories?

**Coming soon, in the first mainnet release.** Contents will be encrypted in the client with a per-repository key that only members hold. File, branch, issue and comment names will be encrypted too. Anyone will still be able to see that the repository exists, its size, when it changes, and how many members it has. Removing a member rotates the key for future content, but cannot take back what they could already read. The design is in [forge-v2.md §5](contracts/forge-v2.md#5-private-repositories), and it will ship only after a separate security review.

Today every repository is public.

### How does this relate to GitHub?

Forge is not a GitHub clone, and it does not need you to leave GitHub.

- **The commands are familiar.** `dg` is shaped like `gh`, and git itself is unchanged: `git clone dash://…`, `git push`, branches, tags. jj works too.
- **You can mirror.** Keep working on GitHub, and keep an [unkillable mirror](guides/mirror-a-github-repo.md) on Forge. `forge-import` copies code, issues, PRs and releases.
- **It is not at feature parity.** No CI runner, wiki, discussions, organizations or global search. No `https://` clone URLs (that would need a server). No shallow clones: use `git clone --filter=blob:none` instead. Some PR steps are still CLI-only: see [Collaborating](guides/collaborating.md).

### Can I use a username instead of the long identity id?

Not yet. You can register a DPNS username for your identity today in the Dash bridge, but Forge does not resolve usernames yet. **Coming soon:** `dash://alice/project`, `forge.dashhq.org/alice/project`, and granting access by name.

### I lost my laptop. Is my code gone?

No. Your repositories are on Platform and in your storage. Your identity survives as long as you have its 12 words or a backup of the identity file. See [Backup and recovery](guides/identity-and-keys.md#backup-and-recovery).

### I lost my 12 words and my identity file.

Then that identity is gone. Nobody can recover it, and nobody can sign as it again. On forge-v2, anything it published stays readable and clonable forever, but only that identity could have pushed to its repositories, and it can no longer do so. Create a new identity and fork. [Keep the words safe.](guides/identity-and-keys.md#backup-and-recovery)

### Where do I report a bug?

[GitHub Issues](https://github.com/PastaPastaPasta/dash-forge/issues) for now. Every error `dg` prints has a code; [errors.md](errors.md) explains each one.
