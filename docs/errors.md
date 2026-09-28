# Error codes

Every error `dg` and `git-remote-dash` print carries a stable code:

```
error: push rejected: you are not a writer of alice/project            [E601]
  cause: Platform refused the write at consensus (40120: no writer/maintainer document for your identity)
  fix:   ask the owner to run `dg collab add alice/project <your identity id> --role write`
  or:    push to a repo of your own and open a pull request: `dg pr create …`
  more:  https://github.com/PastaPastaPasta/dash-forge/blob/master/docs/errors.md#e601
```

The helper prints the same block with each line prefixed `dash: `, because git shows the helper's stderr verbatim. With `--json`, `dg` prints the error on **stdout** instead:

```json
{ "error": { "code": "E601", "message": "…", "cause": "…", "fix": ["…"], "note": null, "docs": "…#e601", "exitCode": 6 } }
```

Codes never change meaning once shipped, so scripts can match on them. A code that no longer occurs is marked **retired** below and its number is never reused. The code's first digit is the process exit code:

| Class | Exit code | Meaning |
|---|---|---|
| `E1xx` | 1 | generic or unexpected |
| `E2xx` | 2 | usage: bad arguments, names or configuration values |
| `E3xx` | 3 | auth or key |
| `E4xx` | 4 | funds or budget |
| `E5xx` | 5 | storage |
| `E6xx` | 6 | rejected at consensus |
| `E7xx` | 7 | network |
| `E8xx` | 8 | policy: the cost guard or a confirmation |

`dg` exits 0 on success. The helper always exits non-zero on failure, so `git push`, `git fetch` and `git clone` report the failure. A push whose individual refs were rejected (for example non-fast-forward) still ends with git's own `! [rejected]` lines and a non-zero exit from git.

Messages never include secrets. Storage credentials are referenced by `env:` or `keychain:` name only, and a final redaction pass removes URL userinfo, credential query parameters, bearer tokens and private keys from any text before it is printed.

---

## E101

**Unexpected error.** No rule recognized the failure. The `cause:` line carries the full chain of what was being done.

Fix: run the command again with `RUST_LOG=debug` for more detail. If it keeps happening, [open an issue](https://github.com/PastaPastaPasta/dash-forge/issues) and include that output after checking it for anything private.

## E102

**Not found.** The repository, issue, pull request, release or document does not exist on the network in use. Platform returned a proof that it is absent.

Fix: check the owner id and the name (`dg repo list --owner <identity id>`). Also check the network, because a repo created on testnet does not exist on mainnet: `dg doctor` shows which network and contracts are in use.

## E103

**Not implemented yet.** The command exists but is not wired yet. The output describes the manual workaround.

## E104

**Checks failed.** `dg doctor` found at least one failing check. Each `✗` row carries its own fix, and `dg doctor --fix` applies the safe ones.

## E105

**Merge has conflicts.** `dg pr merge` tried a three-way merge of the pull request's head into its base locally and the two change the same lines. Nothing was pushed and no merge event was posted.

The message lists the conflicting files.

Fix: `dg pr update-branch <owner>/<repo> <n>` merges the base into the PR's branch when that merge is clean. Otherwise resolve it by hand: `dg pr checkout <owner>/<repo> <n>`, merge the base into `pr/<n>`, fix the conflicts, and push the result to the PR's branch. The push moves the PR head, or run `dg pr sync` if it did not. Then run `dg pr merge` again.

## E106

**Partially completed.** `dg import` finished, but some items were not mirrored: an issue or PR whose number is held by someone else, a document the destination refused, or the optional push of open pull request heads. The warnings name each one, and `counts.skipped` / `counts.gitSkipped` in the `--json` summary count them. Everything else was written.

Fix: run the same command again later: skipped items are retried and nothing already written is written twice. The standalone `forge-import` binary (and the GitHub Mirror Action) reports this as status `partial` with exit code 4.

## E107

**Suggestion not applicable.** `dg pr suggestion apply` could not apply a review suggestion (a ```` ```suggestion ```` block) to the PR's branch. The message says which. The comment may be on an older head, or on the old side of the diff. It may name lines the file no longer has. Two suggestions may touch the same lines. Or the comment may have no suggestion block at all. Nothing was committed or pushed.

Fix: apply the suggestions that still fit, one by one or with `--all`, and edit the rest by hand. Push, then `dg pr sync` moves the PR head. When two suggestions overlap, apply one, then ask the reviewer to re-suggest against the new head.

## E201

**Invalid arguments.** The flags or arguments do not make sense together, for example `dg issue label` without exactly one of `--add` or `--remove`.

Fix: see `dg <command> --help`.

## E202

**Invalid repository name.** Repository names are 1–63 characters, lowercase letters, digits, `.`, `_` and `-`, starting with a letter or digit. The name is lowercased before it is checked.

Fix: pick a name like `my-project`.

## E203

**Invalid repository reference or `dash://` URL.** `dg` takes `owner/name`, where `owner` is the owner's base58 identity id, or a bare `name` for your own repositories. The helper takes `dash://<owner>/<repo>` or `dash://<contract id>`. DPNS usernames are not resolved yet.

Fix: use the owner's identity id, e.g. `dg repo view 8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB/project`.

## E204

**Invalid configuration.** A value in `~/.config/dash-forge/config.toml`, in git config `dash.*`, a devnet name or a DAPI address could not be used. The `cause:` line names the value.

Fix: correct the value (`git config --show-origin --get-regexp '^dash\.'` shows where each git setting comes from). `dg doctor` checks the rest.

A `config.toml` that does not parse is E204 too, from every `dg` command and from `git push` when it needs the default identity recorded there. The cause names the file, the line and the column, never the text there. `dg` does not fall back to the defaults, which would mean testnet and no identity. `dg doctor` still runs: it shows the error as a failing `config.toml` row and runs its other checks on the defaults. Fix the line, or move the file aside and sign in again with `dg auth login`, which writes a new one.

`refusing to bind a key to the forge contract group` is also E204: the contract group on chain failed the trust check made before a limited key is bound to it ([forge-v2 § Contract group trust](contracts/forge-v2.md#contract-group-trust)). Its owner differs from the one `dg` pins, or it has admins. Or a member contract has another owner (proof-verified), or the group lacks forge-core and forge-collab. Do not bind a key to it. With `--strict-group` (or `DASH_FORGE_STRICT_GROUP=1`), any member `dg` does not know causes it too: update `dg`, or drop strict mode to accept members the Forge deployer owns.

## E205

**Unsupported git operation.** `dash://` cannot serve shallow clones (`--depth`, `--shallow-since`, `--shallow-exclude`). It fails instead of quietly making a full clone.

Fix: use a partial clone for a lightweight checkout: `git clone --filter=blob:none dash://…`.

## E206

**Git repository not usable.** `dg init` or `dg repo create --push` needs the local git repository, and could not use it: the current directory is not inside a git work tree, or the remote it would add (`origin` by default) already points somewhere else. Nothing was written to Platform when this is reported before the create; after a create, the repository exists and only the local setup is missing.

Fix: run `git init` first (or `cd` into the repository), or pass `--remote <name>` to add the Forge remote under another name and leave the existing one alone.

## E207

**Not supported for a private repository.** The operation would publish a private repository's content unencrypted, or needs keys that only its members hold, so `dg` refuses it before writing anything. In this release that covers releases (`dg release create`: the tag, title, notes and assets are not encrypted), forks of a private repository, webhooks, and verifying ref tips without the repository's keys.

Fix: none within the private repository in this release. Publish releases from a public repository (a public mirror, for example), and keep sensitive text out of what is published there. The label definitions (`dg label create`) and the other plaintext items in [private-repos §7](security/private-repos.md#7-metadata-that-stays-visible) are allowed but visible to everyone; `dg` says so before it writes them.

## E301

**No identity configured.** The command needs to sign (a push, a `dg` write) or to open a private repository, and no identity or key was found. Cloning and fetching a public repository never need one: `git clone dash://<owner>/<repo>` works anonymously.

Fix: `dg auth new` creates an identity and stores a limited key for this computer; `dg auth login <file>` (or `dg auth login --mnemonic`) signs in with an existing one. For a single command pass `--identity <file>`, or set `DASH_FORGE_KEY` to a file, a `keychain:dash-forge/<network>/<id>` entry, or a `dfk1:` key (this is also how `git-remote-dash` finds the key; without it the helper uses the default `dg auth` recorded, then `~/.config/dash-forge/identities/<owner>.identity.json`).

## E302

**This key can't sign that.** The key in use cannot sign this kind of operation. Document writes (every `dg` and `git push` write) need a HIGH or CRITICAL AUTHENTICATION key. Registering or disabling keys needs the MASTER key, and a DPNS name needs an unbound CRITICAL or HIGH key: a Forge limited key is bound to the forge contracts and cannot sign either.

Fix: pass the identity file with `--master <file>`, or type the recovery words when asked. The master key is used for that one signature and not stored.

## E303

**Identity unreadable.** The identity file or stored key is missing, unreadable, not a bridge-format identity export or `dfk1:` key, or a sealed key file could not be opened (wrong passphrase).

Fix: `dg auth status` shows which key source is in use. Sign in again with `dg auth login <file>` or `dg auth login --mnemonic`. For a sealed file, set `DASH_FORGE_PASSPHRASE` or type the passphrase when asked.

Two cases have their own message:

- **A sealed key, and no terminal to ask for the passphrase on.** For example, a `git push` from a GUI client or a cron job, or `GIT_TERMINAL_PROMPT=0`. Any of these works:
  - run the same command in a terminal;
  - keep the key in the OS keychain (`dg auth login` without `DASH_FORGE_NO_KEYCHAIN`);
  - push through `dg init`, which asks once and hands the key to git;
  - in scripts, set `DASH_FORGE_PASSPHRASE`, or set `DASH_FORGE_KEY` to a `dfk1:` key.

  Nothing was written.
- **`dg init` / `dg repo create --push`: "`git push` could not use your key".** Before it pays for the repository, `dg` checks that the `git-remote-dash` on `PATH` accepts the key it unlocked. An older helper, or none on `PATH`, fails this check. Install `dg` and `git-remote-dash` from the same release; `dg doctor` compares their versions. Nothing was paid for.

## E304

**Identity not found on this network.** Platform has no identity with the id in your identity file, usually because the identity was created on a different network.

Fix: select the network the identity was created on: `--network testnet|mainnet`, or `--network devnet --devnet-name <name>`.

## E305

**This key expired or was disabled.** The limited key signing for you is past its expiry or has been disabled on chain. Limited keys are disposable: nothing is lost.

Fix: register a fresh one with your master key (used once): `dg auth login <identity file>` or `dg auth login --mnemonic`. `dg auth keys list` shows which keys are live.

## E306

**No encryption key for private repositories.** Private repositories encrypt their content to each member's identity `ENCRYPTION` key, and the identity file in use holds none that matches an enabled key on the identity (or, for `dg collab add`, the member you named has none).

Fix: if the identity has an ENCRYPTION key (`dg auth keys list`; identities from `dg auth new`, the bridge and the web app have key 4), use a key source that holds its private half: the limited key `dg auth login` stores holds only a signing key, so point `DASH_FORGE_KEY` at the identity file, or sign in with `dg auth login --full-key <identity file>` (a passphrase-sealed file). If it has none, `dg auth keys add --encryption` adds one, derived from the recovery words (one identity update signed by the master key). A member you are adding does this themselves, or uses Settings → Keys → Enable private repos in the web app. See [identity and keys](guides/identity-and-keys.md#encryption-key-private-repositories).

## E307

**No key for this private repository.** No `repoKey` wrap from a current maintainer opens this repository for your identity: you are not a member, you were removed, or a maintainer added you and has not wrapped the key to you yet.

Fix: ask a maintainer to add you (`dg collab add <owner>/<repo> <your identity id>`). If you are a member already, ask a maintainer to run `dg repo keys repair <owner>/<repo>`, which wraps the key to every member that has none.

## E308

**A maintainer gave you the wrong key.** A current maintainer's `repoKey` for you holds a key that is not the one the epoch's anchor commits to (a split view, or the leftover wrap of a maintainer who lost a concurrent rotation). The client never falls back to another key; the alert names the wrap's author.

Fix: ask a maintainer to run `dg repo keys status <owner>/<repo>` and `dg repo keys repair`; the wrap's author is named in the cause.

## E309

**The repository's key chain is broken.** The anchor of an epoch does not carry a previous-epoch key that opens the epoch before it, so older content cannot be reached from the keys you hold.

Fix: ask the maintainer named in the cause to re-wrap the older epoch to you; `dg repo keys status` lists the epochs you can read.

## E310

**Key rotation or repair pending.** The repository's current key epoch is one your identity cannot write under yet (a rotation landed and no current maintainer has wrapped its key to you), or a repair is needed before new content is written.

Fix: a maintainer runs `dg repo keys repair <owner>/<repo>`; then try again. Nothing was written.

## E401

**Not enough credits.** The identity's balance cannot pay for the write. The `cause:` line starts with `insufficient credits:` and shows the amount needed and the current balance in DASH.

Fix: top up the identity from any Dash wallet at <https://bridge.thepasta.org>. `dg auth balance` shows the balance. Reading, cloning and browsing are free and still work.

## E402

**This key's budget is used up.** The limited key signing for you has spent its whole budget (the identity's balance is untouched). Budgets bound what a leaked key could spend.

Fix: register a fresh limited key (uses the master key once): `dg auth login <identity file>` or `dg auth login --mnemonic`, with a larger `--budget` if you need one.

## E501

**Storage not configured correctly.** `dash.storage` names a profile that `~/.config/dash-forge/storage.toml` does not define, `dash.replicas` is out of range, or `storage.toml` does not parse.

It is also what `git push`, `dg init`, `dg repo create`, `dg storage advertise`, `dg repack --profile`, `dg reseed --profile` and `dg release create` stop with, **before** anything is built, uploaded or paid for, when a target profile's public read address is not a public https URL: loopback, a LAN or other private address, `.local`, plain http, or a temporary tunnel name (`*.trycloudflare.com`, `*.ts.net`). That address would be recorded on chain forever, and nobody else could read it for long, or at all.

Fix: `dg storage list` shows your profiles and `dg storage use <profiles>` sets `dash.storage`. For an address problem, re-add the profile with a public https `--public-url` / `--public-gateway` (a bucket domain, a CDN, a named tunnel or a reverse proxy on your own domain), or record it anyway with `git push -o allow-private-uri`, `git config dash.allowPrivateUri true`, `dg storage add … --allow-private-uri`, or `--allow-private-uri` on `dg init` / `dg repo create`. See [bring your own storage](guides/bring-your-own-storage.md#public-addresses).

## E502

**Storage policy not met.** Fewer targets confirmed the pack than `dash.replicas` requires, so the push stopped **before** the `packManifest` and the refs were written. No ref points at history that is not stored where you asked.

Copies that did confirm are content-addressed. The next push finds them and does not upload them again. The `note:` line says whether anything was written to Platform. If `dash.platformFallback` was armed and Platform chunks were stored, they are journaled and the next push reuses them.

Fix, in order:
1. Run `dg storage test <failing profile>`. It uploads a probe, reads it back and names the problem (credentials, region, bucket policy, CORS). Then push again.
2. Or lower `dash.replicas` to the number of targets that work.
3. Or `git config dash.platformFallback true` to store on Platform (costed, and confirmed by the cost guard) when your storage fails.

## E503

**Packs unreadable.** A clone or fetch needed a pack whose recorded copies all failed: storage down, object deleted, or a gateway that does not have the CID. The helper reads every other pack first and reports this only when the wanted history really is incomplete, so a dead copy of a pack nothing needs (a deleted branch, or one a repack superseded) does not fail the clone. The `cause:` line names each unreadable pack and why each of its copies failed. A host that refuses the connection gives up its place in the race at once, so it never waits on a slow gateway tried alongside it. Copies are tried two at a time. If neither sends a single byte within 20 seconds, both are dropped and the next two are tried, again with 20 seconds. A gateway that cannot find a CID holds the request open for about a minute before it answers 504, so this saves most of that wait. Every copy is still tried before the clone fails. Once any copy starts sending, the slow-but-healthy transfer keeps its full deadline.

Fix: anyone whose clone still has the objects can restore the copies with `dg reseed <owner>/<repo> --from-local`, run inside that clone. If you know another IPFS gateway that has the pack, add it to `[read] ipfs_gateways` in `storage.toml` and try again.

`dg release download` stops with E503 before downloading anything when none of the asset's recorded copies is one this computer reads from. A copy recorded on chain is followed only if it is a public https URL, an IPFS CID with a gateway to ask, or a bucket or host named in one of your own storage profiles. Plain http, loopback and private-network addresses are never followed just because a publisher recorded them. If the host is your own storage, add a profile whose `public_url` is it, and retry.

## E504

**Integrity check failed.** Downloaded bytes did not hash to the SHA-256 that the on-chain manifest records. A storage host, or a cache in front of it, served different content. The bytes were discarded, and a tampered copy is never handed to git.

Fix: run the command again; other copies are tried. `dg storage status <owner>/<repo>` shows which copies verify.

`dg release download` also stops with E504, before downloading anything, when the release asset records **no SHA-256** (releases mirrored by a `forge-import` older than the D-517 fix recorded `""` for assets their source gave no digest for). There is nothing to check the bytes against, and nothing is downloaded unverified. Fix: a maintainer re-runs the import with a current `forge-import`, which hashes each such asset and republishes the release, or publishes it again with the file (`dg release create <repo> --tag <tag> --asset <file>`).

## E505

**Storage credentials unavailable.** A profile's secret reference does not resolve: the `env:` variable is unset in the environment that git or `dg` runs in, or the `keychain:` entry does not exist.

Fix: export the variable (git runs the helper in your shell's environment), or store the secret in the keychain and re-add the profile with `--secret-access-key keychain:dash-forge/<name>`. `dg storage list` shows which references resolve.

## E506

**Storage profile failed its checks.** `dg storage test` found a failing step: signed PUT/GET, anonymous public read, or browser CORS. The output shows each step and, for CORS, the exact configuration to paste for your provider.

Fix: apply the printed fix, then run `dg storage test <name>` again. `git push` works without CORS, but the web app cannot read the repo until CORS passes.

## E507

**Recorded pack copy unreachable.** An earlier push recorded this exact pack, and none of the copies it recorded can be read now. The push was refused **before** paying for anything.

Fix: restore that storage, or re-upload the pack from this clone with `dg reseed <owner>/<repo> --from-local` (run inside the repository). Then push again.

## E508

**No storage configured.** `dg repo create` or `dg init` found no storage profile for the new repository: no `--storage`, no `dash.storage` in git config (this repository's or your global one), and not exactly one profile in `storage.toml` to default to. Without one, every push would store its packs on Platform at about 0.28 DASH per MiB, so the command stops **before** creating anything. The cause line prices this repository's current size.

Fix: add your own storage with `dg storage add` (a prompt flow when run with no arguments), or pass `--storage platform` to accept the Platform price. `git config --global dash.storage <profile>` sets a default for every new repository.

## E509

**Sealed pack corrupt.** A private repository's sealed artifact hash-verified against its manifest but failed decryption: a segment tag, the header, or the length does not check out. The uploader stored bytes no honest client writes, so every copy of that pack is the same bad bytes.

Fix: ask the member who pushed it to push again (`git push` re-stores it under a new hash). `dg repo keys status` shows which epochs you can read.

## E510

**Written after the key was rotated.** The content is under a superseded key epoch and was written more than 240 blocks after the next epoch's anchor by someone who is no longer a member (the late-content rule). It is hidden, not deleted.

Fix: none needed; if the writer is still meant to be a member, re-add them and have them write it again.

A clone or fetch reports E510 as `clone incomplete: N packs hidden by the late-content rule` when a branch you asked for needs objects that only such hidden packs hold. Restoring a copy would not help, because the rule hides that content from every reader.
- **A removed member's late upload:** it becomes readable again as soon as its uploader is a member (`dg collab add`).
- **A pack sealed under an earlier use of an epoch number:** nobody can open it again. A member whose clone has the commits can push the branch again.

In either case, a maintainer can instead move the ref back to history every member can read.

## E511

**git refused an object in the history.** A clone or fetch downloaded a pack holding an object that git's own checks refuse. It stopped before any ref could point at that object. The `cause:` line names each object, the git check that refused it (its `fsck` msg-id, for example `hasDotgit` or `gitmodulesUrl`) and git's message.

These are the checks git runs with `transfer.fsckObjects`, which a plain `git clone` skips. Each stays fatal because it can change what a checkout writes, or lets two readers disagree on what an object names:
- a path git treats as the repository (`.git`, `.GIT`, `git~1`);
- a `.gitmodules` whose URL or path is an option or escapes the work tree;
- a `.gitmodules` or `.gitattributes` that is a symbolic link;
- a corrupt tree or commit header.

The author and committer line checks (`badTimezone`, `missingSpaceBeforeDate`, `badEmail`, `badDate` and similar) are only warnings, so real histories with old malformed commits still clone.

Fix: the history itself has to change. Ask a maintainer to push history without that object. Nothing needs cleaning up on your side.

## E601

**Not a writer of this repository.** Platform refused the write at consensus: there is no current `writer` or `maintainer` document for your identity (40120 on path `$ownerId`, the `ownerRefersTo` gate).

Outside a push (collaborator admin, releases, repo config) the headline says your identity "is not authorized for this action", because those need a different role.

The helper checks this before building or paying for anything and refuses early with the same advice.

Fix: ask the owner to add you (`dg collab add <owner>/<repo> <your identity id> --role writer`), or push to a repository of your own.

## E602 (retired)

**Write access suspended.** Retired with forge-v1 (2026-09-26): it reported a frozen WRITE or MAINTAIN token on a per-repository contract. forge-v2 has no suspend; removing a member revokes access at once (E601). The number stays reserved.

## E603

**Already exists.** Platform refused a document that collides with a unique index, for example a repository name you already use.

Fix: pick another name. Issue and PR numbers are retried automatically, so this only surfaces for names.

## E604

**Rejected by Platform.** Consensus refused the state transition for a reason not listed above. This includes 40120 on any path other than `$ownerId`: a document, contract or identity the write refers to does not exist (the headline names the path). The `cause:` line carries Platform's message, which names the rule.

Fix: if the message does not explain it, [open an issue](https://github.com/PastaPastaPasta/dash-forge/issues) with it.

## E605 (retired)

**v1 repository is read only.** Retired with forge-v1 (2026-09-26), which the tools no longer read or write. The number stays reserved.

## E606

**Repository archived.** A maintainer marked the repository archived (`config.archived`, set with `dg repo archive` or Settings → Danger zone). Archiving is a client rule, not access control: consensus still admits a member's writes, so the tools refuse them instead. That covers `dg` issue, PR, comment, review, merge and release writes, and the push helper, each before signing or paying for anything.

Fix: ask a maintainer to unarchive it (`dg repo unarchive <owner>/<repo>`). If you are sure, write anyway with `dg --allow-archived …` or push with `-o allow-archived`.

## E607

**Edited meanwhile.** The issue, PR or comment you are editing was replaced again after `dg` read it, so your edit was made against text that is no longer there. `dg` refuses the replace before signing: writing it would silently drop the other edit. In a private repository this matters most, because an edit re-seals the whole text it read.

Fix: read it again (`dg issue view`, `dg pr view --comments`) and redo the edit on the current text.

## E701

**Dash Platform unreachable.** No DAPI node answered, or the quorum service could not be reached. Nodes that fail are skipped for about a minute, so an immediate retry often reaches the same dead nodes.

Fix: check your connection and run the command again after a minute. `dg doctor` tests reachability. On a devnet, check `--dapi-addresses` / `git config dash.dapiAddresses`.

## E702

**Dash Forge not deployed on this network.** The embedded `forge-contracts/deployments/<network>.json` records no registered forge-v2 contracts (forge-core, forge-collab and their contract group), so there is nothing to read or write. The tools never fall back to another network's contracts. Today forge-v2 is deployed on devnet moutai only; testnet and mainnet follow once they run Platform protocol 14.

Fix: use a network with a deployment. For `dg`, pass `--network devnet --devnet-name moutai` (`dg auth new` and `dg auth login` record it as the default). For `git clone` / `git push`, the helper takes the network from `DASH_FORGE_NETWORK`, then git config `dash.network` / `dash.devnetName`, then the network `dg` recorded, so set one of those: `git config --global dash.network devnet && git config --global dash.devnetName moutai`, or `git clone -c dash.network=devnet -c dash.devnetName=moutai dash://…` for one clone. See [the mainnet runbook](mainnet-runbook.md).

## E703

**Incomplete read.** A read that has to be complete (every ref update, every event) could not be proven complete. The data was refused rather than folded partially, because a partial history can resolve refs differently from a complete one.

Fix: run it again. A different node is asked.

## E704

**Timed out; may still land.** A signed state transition was broadcast but not confirmed in time. It may still be included.

Fix: for `git push`, run the push again. Chunks are journaled and ref updates are idempotent, so nothing is paid for twice. For other writes (an issue, a comment), check whether it landed before running the command again.

**Concurrent writes from the same identity.** Two writers signing as one identity at the same moment (two terminals, `dg` and a `git push`, or the CLI and the web app) can pick the same contract nonce. Platform accepts both, the block takes one, and the node quietly drops the other: no result for it ever arrives. The CLI and the web app notice this without waiting minutes. After one bounded wait (20 s), they read the identity's nonce. If it is spent, they check whether the write landed and re-sign it with the next nonce if it did not. Expect such a write to finish in about 20–60 s instead of the usual few seconds. You only see E704 when that check itself cannot reach Platform. Writers that take turns never hit this.

## E801

**Stopped by the cost guard.** This push costs more than `dash.costWarnThreshold`, or `dash.confirm = always`, and there is no terminal to confirm on (CI, a GUI client). The helper never assumes yes.

Fix: add your own storage (`dg storage add`, then `dg storage use`) so packs go to your bucket and only the manifest and refs are paid on Platform. Or accept the price for this push with `git -c dash.confirm=never push`, or raise `dash.costWarnThreshold`.

## E802

**Confirmation required.** A cost-bearing or destructive `dg` command needs confirmation, and it cannot prompt: `--json` mode, or stdin is not a terminal.

Fix: pass `--yes` after checking the estimate (`dg cost estimate`).

## E803

**Cancelled.** You answered no at the confirmation prompt (or the terminal closed). Nothing was written.

## E804

**Branch policy not met.** `dg pr merge` checked the repository's branch `policy` (`dg repo policy show`) and it is not satisfied: fewer counted approvals than it requires (from maintainers only, when it says so), or a merge method it does not allow, or the policy could not be read. The policy is a client rule every Forge client applies, not a consensus rule. Nothing was pushed and no merge event was posted.

Fix: get the missing approvals (`dg pr review --approve` by a member), or use an allowed method. A maintainer can merge anyway with `--override-policy`.
