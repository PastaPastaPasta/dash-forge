# Error codes

Every error `dg` and `git-remote-dash` print carries a stable code:

```
error: push rejected: you are not a writer of alice/project            [E601]
  cause: Platform refused the write at consensus (40120: no writer/maintainer document for your identity)
  fix:   not a member yet? run `dg collab accept alice/project` first (your consent, as the web's Accept; the add is refused without it), then ask the owner to run `dg collab add alice/project <your identity id> --role writer`
  or:    push to a repo of your own: `dg repo create <name>`, then `git push dash://<you>/<name> <branch>`
  more:  https://github.com/PastaPastaPasta/dash-forge/blob/master/docs/errors.md#e601
```

The helper prints the same block with each line prefixed `dash: `, because git shows the helper's stderr verbatim. With `--json`, `dg` prints the error on **stdout** instead:

```json
{ "error": { "code": "E601", "message": "…", "cause": "…", "fix": ["…"], "note": null, "docs": "…#e601", "exitCode": 6 }, "schemaVersion": 1 }
```

A command that finished part of its work adds that part's fields beside `error` (for example `steps`). The shape is [`docs/schemas/dg/error.schema.json`](schemas/dg/error.schema.json).

Codes never change meaning once shipped, so scripts can match on them. A code that no longer occurs is marked **retired** below and its number is never reused. The code's first digit is the process exit code:

| Class | Exit code | Meaning |
|---|---|---|
| `E1xx` | 1 | generic or unexpected |
| `E2xx` | 2 | usage: bad arguments, names or configuration values |
| `E3xx` | 3 | auth or key |
| `E4xx` | 4 | funds or budget |
| `E5xx` | 5 | storage |
| `E6xx` | 6 | write refused: permissions, conflicts or Platform rules |
| `E7xx` | 7 | network |
| `E8xx` | 8 | policy: the cost guard or a confirmation |

`dg` exits 0 on success. The helper always exits non-zero on failure, so `git push`, `git fetch` and `git clone` report the failure. A push whose individual refs were rejected (for example non-fast-forward) still ends with git's own `! [rejected]` lines and a non-zero exit from git.

Each entry below starts with what happened, then **What to do**. Other paragraphs add cases and other commands that report the same code. A *Protocol detail* line, where there is one, gives the Platform error or Forge rule behind it, for anyone checking the code or filing an issue.

Messages never include secrets. Storage credentials are referenced by `env:` or `keychain:` name only, and a final redaction pass removes URL userinfo, credential query parameters, bearer tokens and private keys from any text before it is printed.

---

## E101

**Unexpected error.** No rule recognized the failure. The `cause:` line carries the full chain of what was being done.

**What to do:** run the command again with `RUST_LOG=debug` for more detail. If it keeps happening, [open an issue](https://github.com/PastaPastaPasta/dash-forge/issues) and include that output after checking it for anything private.

## E102

**Not found.** The repository, issue, pull request, release or document does not exist on the network in use. Platform returned a proof that it is absent.

**What to do:** check the owner id and the name (`dg repo list --owner <identity id>`). Also check the network, because a repo created on testnet does not exist on mainnet: `dg doctor` shows which network and contracts are in use.

`dg` also reports E102 before anything is written when a command names a ref the repository does not have: a pull request's base branch (`dg pr create --base`), or a release's tag (`dg release create --tag`; push the tag first). The message lists the branches or tags it does have. `dg issue label … add` does the same for a label the repository does not define (define it first with `dg label create`), and a DPNS name that is not registered names the network it was looked up on.

## E103

**Not implemented yet.** The command isn't available in this release yet.

**What to do:** follow the manual workaround the output describes.

## E104

**Checks failed.** `dg doctor` found at least one failing check.

**What to do:** each `✗` row says how to fix it, and `dg doctor --fix` applies the safe fixes.

`dg pr checks` reports E104 (exit 1, as `gh pr checks` does) when a counted check run on the pull request's head failed, or a check the branch policy requires failed. The runs are listed above the error; each run's details link (`dg ci status`) says why it failed. A new run your CI reports replaces the one shown.

## E105

**Merge has conflicts.** `dg pr merge` tried a three-way merge of the pull request's head into its base locally and the two change the same lines. Nothing was pushed and no merge event was posted.

The message lists the conflicting files.

**What to do:** `dg pr update-branch <owner>/<repo> <n>` merges the base into the PR's branch when that merge is clean. Otherwise resolve it by hand: `dg pr checkout <owner>/<repo> <n>`, merge the base into `pr/<n>`, fix the conflicts, and push the result to the PR's branch. The push moves the PR head, or run `dg pr sync` if it did not. Then run `dg pr merge` again.

`dg repo sync` reports E105 when the fork's branch and its parent's have both moved: a sync only fast-forwards, and never drops the fork's own commits. The message says how many commits each side has. Nothing was written. What to do: merge the parent's branch into the fork with a pull request, `dg pr create <fork> --base <branch> --head <parent's branch> --head-repo <parent> --title "…"` (the web's fork bar offers the same), or pull it locally and push.

## E106

**Partially completed.** `dg import` finished, but some items were not mirrored: an issue or PR whose number is held by someone else, a document the destination refused, or the optional push of open pull request heads. The warnings name each one, and `counts.skipped` / `counts.gitSkipped` in the `--json` summary count them. Everything else was written.

**What to do:** run the same command again later: skipped items are retried and nothing already written is written twice. The standalone `forge-import` binary (and the GitHub Mirror Action) reports this as status `partial` with exit code 4.

## E107

**Suggestion not applicable.** `dg pr suggestion apply` could not apply a review suggestion (a ```` ```suggestion ```` block) to the PR's branch. The message says which. The comment may be on an older head, or on the old side of the diff. It may name lines the file no longer has. Two suggestions may touch the same lines. Or the comment may have no suggestion block at all. Nothing was committed or pushed.

**What to do:** apply the suggestions that still fit, one by one or with `--all`, and edit the rest by hand. Push, then `dg pr sync` moves the PR head. When two suggestions overlap, apply one, then ask the reviewer to re-suggest against the new head.

## E201

**Invalid arguments.** The flags or arguments do not make sense together, for example `dg issue label` that names neither `add <label>…` nor `remove <label>…` (or both of the older `--add` and `--remove` flags), or a value is not of the form the flag takes: a `--color` that is not a hex color, an empty `--title`, a text over its length limit, or a comment, review or thread id that is not a document id (`dg issue delete-comment <repo> 2`; the ids are in `dg issue view --json` and `dg pr view --comments --json`). A command line `dg` cannot parse at all (a missing argument, an unknown flag) is E201 too: the cause quotes what is wrong, and the command's usage line follows the error block. Inside a `dash://` clone, a command that leaves out the repository uses the clone's, so `dg issue list`, `dg issue label 3 add bug` or `dg release download v1.0` there is not an error. What you typed where the repository goes is kept when it names one: the clone's own repository (`dg label create project` in a clone of `alice/project` is a label name left out), or an `owner/name` whose owner is an identity id, `@name` or `name.dash`. `-R <repo>` (`--repo`) names the repository anywhere on the line, as with `gh`. In a clone of a fork, `dg pr create` with no repository opens the PR in the fork's parent. A release asset whose name `dg release download` will not save under (a path, a dotfile, a Windows device name: see [releases](guides/collaborating.md#releases)) is E201 too: `dg release create` refuses to publish it, and `dg release download --asset <name> --output <file>` saves an existing one to a file you choose.

**What to do:** see `dg <command> --help`.

`dg storage mirror add` reports E201, before anything is signed, for addresses a mirror can't hold (more than 4, a mix of https and IPFS, a user name or password in a URL, an `ipfs://` address with a path) and for an address on this machine or a private network (`localhost`, `127.0.0.1`, `192.168.…`): other readers never fetch from those. Record a public https address or an `ipfs://` CID.

## E202

**Invalid repository name.** Repository names are 1–63 characters, lowercase letters, digits, `.`, `_` and `-`, starting with a letter or digit. The name is lowercased before it is checked.

**What to do:** pick a name like `my-project`.

## E203

**Invalid repository reference or `dash://` URL.** `dg` takes `owner/name`, where `owner` is the owner's base58 identity id or DPNS username (`alice`, `@alice`, `alice.dash`), a bare `name` for your own repositories, or the repository's id. The helper takes `dash://<owner>/<repo>` (identity id or DPNS username) or `dash://<repo id>`. A reference with more than one `/` (`alice/b/c`) is E203 too.

**What to do:** use `owner/name`, e.g. `dg repo view alice/project` or `dg repo view 8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB/project`.

## E204

**Invalid configuration.** A value in `~/.config/dash-forge/config.toml`, in git config `dash.*`, in `DASH_FORGE_NETWORK` and friends, a devnet name or a DAPI address could not be used. The `cause:` line names the value. A bad command-line argument is E201, not E204.

**What to do:** correct the value (`git config --show-origin --get-regexp '^dash\.'` shows where each git setting comes from). `dg doctor` checks the rest.

A `config.toml` that does not parse is E204 too, from every `dg` command and from `git push` when it needs the default identity recorded there. The cause names the file, the line and the column, never the text there. `dg` does not fall back to the defaults, which would mean testnet and no identity. `dg doctor` still runs: it shows the error as a failing `config.toml` row and runs its other checks on the defaults. What to do: fix the line, or move the file aside and sign in again with `dg auth login`, which writes a new one.

`refusing to bind a key to the forge contract group` is also E204: the contract group on chain failed the trust check made before a limited key is bound to it ([forge-v2 § Contract group trust](contracts/forge-v2.md#contract-group-trust)). Its owner differs from the one `dg` pins, or it has admins. Or a member contract has another owner (proof-verified), or the group lacks forge-core and forge-collab. Do not bind a key to it. With `--strict-group` (or `DASH_FORGE_STRICT_GROUP=1`), any member `dg` does not know causes it too: update `dg`, or drop strict mode to accept members the Forge deployer owns.

## E205

**Unsupported git operation.** `dash://` cannot serve shallow clones (`--depth`, `--shallow-since`, `--shallow-exclude`). It fails instead of quietly making a full clone.

**What to do:** use a partial clone for a lightweight checkout: `git clone --filter=blob:none dash://…`.

## E206

**Git repository not usable.** `dg init` or `dg repo create --push` needs the local git repository, and could not use it: the current directory is not inside a git work tree, or the remote it would add (`origin` by default) already points somewhere else. Nothing was written to Platform when this is reported before the create; after a create, the repository exists and only the local setup is missing.

`dg pr checkout` reports it too when the local branch `pr/<n>` has commits the PR head does not (the PR was force-pushed, or you committed on the branch). Moving the branch would drop them, so nothing is changed.

**What to do:** run `git init` first (or `cd` into the repository), or pass `--remote <name>` to add the Forge remote under another name and leave the existing one alone. For `dg pr checkout`, rename the branch to keep its commits (`git branch -m pr/<n> pr/<n>-old`) or delete it (`git branch -D pr/<n>`), then run it again.

## E207

**Not supported for a private repository.** The operation would publish a private repository's content unencrypted, or needs keys that only its members hold, so `dg` refuses it before writing anything. In this release that covers forks of a private repository, webhooks, and verifying ref tips without the repository's keys. Releases are supported: a private repository's releases are sealed ([private repositories §16](security/private-repos.md#16-sealed-releases)), and `dg release create`, `dg release unpublish` and `dg release download` handle them.

**What to do:** none within the private repository in this release. The label definitions (`dg label create`) and the other plaintext items in [private-repos §7](security/private-repos.md#7-metadata-that-stays-visible) are allowed but visible to everyone; `dg` says so before it writes them.

## E301

**No identity configured.** The command needs to sign (a push, a `dg` write) or to open a private repository, and no identity or key was found. Reading a public repository never needs one: `git clone dash://<owner>/<repo>` works anonymously, and so do `dg repo view`, `dg issue list` / `view`, `dg pr list` / `view` and `dg release list` / `download`.

**What to do:** `dg auth new` creates an identity and stores a limited key for this computer; `dg auth login <file>` (or `dg auth login --mnemonic`) signs in with an existing one. For a single command pass `--identity <file>`, or set `DASH_FORGE_KEY` to a file, a `keychain:dash-forge/<network>/<id>` entry, or a `dfk1:` key (this is also how `git-remote-dash` finds the key; without it the helper uses the default `dg auth` recorded, then `~/.config/dash-forge/identities/<owner>.identity.json`).

A private repository needs more than a signing key: its content is encrypted to each member's `ENCRYPTION` key. `dg auth login <file>`, `dg auth login --mnemonic` and `dg auth new` store it beside the limited signing key (never the master key), unless `--signing-only`; a key stored by an older `dg` lacks it (that would be [E306](#e306) next): sign in again with `--replace <key id>`.

## E302

**This key can't sign that.** Forge writes (every `dg` and `git push` write) need a HIGH or CRITICAL authentication key. Adding or disabling keys, or registering a username, needs your master key, which a Forge limited key can't stand in for. A CI runner key (`dg ci runner new`) can only report check runs: anything else it signs is refused before it is sent.

**What to do:** pass the identity file with `--master <file>`, or type the recovery phrase when asked. The master key is used for that one signature and not stored.

*Protocol detail:* a limited key is bound to the forge contracts, and a runner key to the `checkRun` document type; a DPNS name needs an unbound CRITICAL or HIGH key. A write outside a key's bounds is refused with "Batch member is outside the contract bounds of key N" (consensus error 20014).

## E303

**Identity unreadable.** The identity file or stored key is missing, unreadable, not a bridge-format identity export or `dfk1:` key, or a sealed file could not be opened (wrong passphrase).

**What to do:** sign in again with `dg auth login <file>` or `dg auth login --mnemonic`. When the error says `DASH_FORGE_KEY`, the variable is what failed: it overrides every stored key, so correct it (a `dg auth export --format dfk1` key, a runner key from `dg ci runner new`, or an identity file's path) or `unset DASH_FORGE_KEY` to use the stored key. For a sealed file, set `DASH_FORGE_PASSPHRASE` or type the passphrase when asked. A wrong passphrase names the file and where the passphrase came from. Each sealed file keeps its own passphrase: `dg ci runner new --runner <file>` reads the runner file's from `DASH_FORGE_RUNNER_PASSPHRASE` (else `DASH_FORGE_PASSPHRASE`), so a script can open your key and the runner's when they differ.

Reads do not open the key: `dg auth status`, `dg auth balance`, and `dg storage status` / `dg cost audit` of a public repository work with a sealed key and no terminal (the status says the key itself was not checked).

Two cases have their own message:

- **A sealed key, and no terminal to ask for the passphrase on.** For example, a `git push` from a GUI client or a cron job, `GIT_TERMINAL_PROMPT=0`, or a `dg` write under `--json` or without a terminal. Any of these works:
  - run the same command in a terminal;
  - keep the key in the OS keychain (`dg auth login` without `DASH_FORGE_NO_KEYCHAIN`);
  - push through `dg init`, which asks once and hands the key to git;
  - in scripts, set `DASH_FORGE_PASSPHRASE`, or set `DASH_FORGE_KEY` to a `dfk1:` key.

  Nothing was written.
- **`dg init` / `dg repo create --push`: "`git push` could not use your key".** Before it pays for the repository, `dg` checks that the `git-remote-dash` on `PATH` accepts the key it unlocked. An older helper, or none on `PATH`, fails this check. Install `dg` and `git-remote-dash` from the same release; `dg doctor` compares their versions. Nothing was paid for.

## E304

**Identity not found on this network.** Platform has no identity with the id in your key, usually because the identity was created on a different network. The headline names the network searched. When the key records its own network (a `dfk1:` key, an identity file's `network`) and it is another one, the cause says so and the fix selects it.

**What to do:** select the network the identity was created on: `--network testnet|mainnet`, or `--network devnet --devnet-name <name>` (for `git`, git config `dash.network` / `dash.devnetName` or `DASH_FORGE_NETWORK`). `dg doctor` shows the network in use and what chose it. `dg` also takes the network from the repository in the current directory (the one `dg init` / `dg repo clone` pinned), and when nothing else names one, from the key itself, so a CI runner's `dfk1:` key needs no network setting.

## E305

**This key expired or was disabled.** The limited key signing for you is past its expiry or has been disabled. Limited keys are disposable: nothing is lost.

**What to do:** register a fresh one with your master key (used once): `dg auth login <identity file>` or `dg auth login --mnemonic`. `dg auth keys list` shows which keys are live.

## E306

**No encryption key for private repositories.** Private repositories encrypt their content to each member's identity `ENCRYPTION` key. Two cases:

- "the key stored on this computer holds no encryption key": your identity usually has one (`dg auth keys list`; identities from `dg auth new`, the bridge and the web app have key 4), but the key source in use does not hold its private half: a limited key stored by an older `dg`, or with `--signing-only`, is a signing key only.
- "`<member>` has no encryption key" (`dg collab add` to a private repository): the member you named has no enabled `ENCRYPTION` key on their identity.

**What to do:** for the first, sign in again, replacing the key in use (`dg auth status` shows its id, and its `Private:` line prints the command): `dg auth login <identity file> --replace <key id>`, or `dg auth login --mnemonic --replace <key id>` with the 12-word recovery phrase if you have no identity file (a `dg auth new` identity). It registers a new limited key, stores your encryption key beside it and disables the old key; the master key is used once and not stored. For one command, point `DASH_FORGE_KEY` at the identity file. If the identity has no ENCRYPTION key at all, `dg auth keys add --encryption` adds one, derived from the recovery phrase (one identity update signed by the master key). A member you are adding does this themselves, or uses Settings → Private repos → Enable private repos in the web app. See [identity and keys](guides/identity-and-keys.md#encryption-key-private-repositories).

## E307

**No key for this private repository.** No current maintainer has shared this repository's key with you: you are not a member, you were removed, or a maintainer added you and has not shared the key yet.

**What to do:** not a member yet? Run `dg collab accept <owner>/<repo>` first (your consent, as the web app's **Accept**; the add is refused without it), then ask the owner to add you: `dg collab add <owner>/<repo> <your identity id> --role <role>`. `dg` prints both commands with the repository and your identity id filled in. If you are a member already, ask a maintainer to run `dg repo keys repair <owner>/<repo>`, which shares the key with every member who lacks it. Removed? What was written after your removal is sealed to keys you are not given.

`git fetch`, `git pull`, `git ls-remote` (and any push or `dg` command that reads the refs) also stop with E307 when the repository's newest ref updates are encrypted with a newer key you don't hold, typically after you were removed and the key was rotated. The refs you can still read are from before the rotation, so they are not reported as current ("Already up to date" would be wrong). As on GitHub, a removed collaborator's clone stops getting updates; what it already has stays.

*Protocol detail:* no `repoKey` wrap from a current maintainer opens the repository for your identity.

## E308

**A maintainer gave you the wrong key.** The key a maintainer shared with you is not the one the repository recorded for this key rotation. Forge never falls back to another key.

**What to do:** ask a maintainer to run `dg repo keys status <owner>/<repo>`, then `dg repo keys repair`. The cause names the maintainer who shared the key.

*Protocol detail:* the `repoKey` wrap holds a key other than the one the epoch's anchor commits to: a split view, or the leftover wrap of a maintainer who lost a concurrent rotation.

## E309

**The repository's key chain is broken.** You can't read content from before one of this repository's key changes. Each change records the previous key, and one of those records is missing or doesn't open it. The message calls each key period an *epoch*.

**What to do:** ask the maintainer named in the cause to re-wrap the older epoch to you; `dg repo keys status` lists the epochs you can read.

*Protocol detail:* an epoch's anchor carries no previous-epoch key that opens the epoch before it.

## E310

**Key rotation or repair pending.** The repository's key changed and no maintainer has shared the new one with you yet, or its keys need a repair before anything new is written.

**What to do:** a maintainer runs `dg repo keys repair <owner>/<repo>`, then you try again. Nothing was written.

*Protocol detail:* the current key epoch is one your identity can't write under yet: a rotation landed and no current maintainer has wrapped its key to you.

## E311

**You're a member, but no key has been shared with you yet.** This public repository has members-only content, and no maintainer has shared its key with your encryption key. This happens when you were added by an older Forge build that did not share the key. You can still read everything public, and the members-only items show as placeholders.

**What to do:** ask a maintainer to share it: **Repair** on the repo page, or `dg repo keys repair <owner>/<repo>`. Nothing shares it automatically. If your identity has no encryption key yet, add one first: `dg auth keys add --encryption`.

## E312

**Members-only content is not turned on.** You asked for members-only content (an issue, comment or review only members can read) in a public repository where no maintainer has turned it on.

**What to do:** a maintainer runs `dg repo members enable <owner>/<repo>`, which sets up a key for the current members (the command shows the cost first). Until then, post it publicly or ask a maintainer. See [Turn on members-only content](security/audiences.md#turn-on-members-only-content).

## E313

**Members-only.** This issue or pull request is members-only: only members of the repository can read it. Everyone can see that it exists, its number, who opened it and when; nothing else.

**What to do:** ask the repository's owner to add you as a member (`dg collab accept <owner>/<repo>` first, your consent). If you are a member already, see [E311](#e311). If your key is protected by a passphrase and there is no terminal to ask for it, set `DASH_FORGE_PASSPHRASE` and try again. [Who can read what](security/audiences.md) explains members-only content.

`dg issue view` and `dg pr view` don't stop with E313: they show such an item as a row (`#3 · members-only issue by @alice · open`) and exit 0. E313 comes from commands that need its content, such as commenting on it or checking it out.

## E401

**Not enough credits.** The identity's balance cannot pay for the write. The `cause:` line starts with `insufficient credits:` and shows the amount needed and the current balance in DASH.

**What to do:** top up the identity from any Dash wallet at <https://bridge.thepasta.org>. `dg auth balance` shows the balance. Reading, cloning and browsing are free and still work.

## E402

**This key's budget is used up.** The limited key signing for you has spent its whole budget (the identity's balance is untouched). Budgets bound what a leaked key could spend.

**What to do:** register a fresh limited key (uses the master key once): `dg auth login <identity file>` or `dg auth login --mnemonic`, with a larger `--budget` if you need one.

## E501

**Storage not configured correctly.** `dash.storage` names a profile that `~/.config/dash-forge/storage.toml` does not define, `dash.replicas` is out of range, or `storage.toml` does not parse.

`dg release create` with assets, and `dg ci report` with `--log` or `--artifact`, stop with it before anything is uploaded when there is no storage of your own to put the files on: `dash.storage` is Platform only (or unset) and no `--storage` names a profile. Release assets, check-run logs and artifacts never go to Platform. `dg ci report` also stops when the storage records no https or IPFS address, because a check run can name only such a URL.

It is also what `git push`, `dg init`, `dg repo create`, `dg storage advertise`, `dg repack --profile`, `dg reseed --profile` and `dg release create` stop with, **before** anything is built, uploaded or paid for, when a target profile's public read address is not a public https URL: loopback, a LAN or other private address, `.local`, plain http, or a temporary tunnel name (`*.trycloudflare.com`, `*.ts.net`). That address would be recorded on chain forever, and nobody else could read it for long, or at all.

**What to do:** `dg storage list` shows your profiles and `dg storage use <profiles>` sets `dash.storage`. For an address problem, re-add the profile with a public https `--public-url` / `--public-gateway` (a bucket domain, a CDN, a named tunnel or a reverse proxy on your own domain), or record it anyway with `git push -o allow-private-uri`, `git config dash.allowPrivateUri true`, `dg storage add … --allow-private-uri`, or `--allow-private-uri` on `dg init` / `dg repo create`. See [bring your own storage](guides/bring-your-own-storage.md#public-addresses).

A secret given as its literal value is E501 too (`dg storage add … --secret-access-key <the secret>`): `cause: a secret must be a reference — env:VAR_NAME or keychain:<service>/<account> — never the literal value`. Nothing was saved, and the value is never echoed. What to do here is different: export the secret in an environment variable and pass `env:VAR_NAME`, or store it in the OS keychain and pass `keychain:dash-forge/<profile>`. `dg storage add` with no arguments asks instead: it offers to paste the secret into the keychain where there is one, and says so when there is none (`DASH_FORGE_NO_KEYCHAIN` is set, or the system has no keychain), leaving an environment variable or an existing keychain entry.

## E502

**Storage policy not met.** Fewer targets confirmed the pack than `dash.replicas` requires, so the push stopped **before** it recorded the pack or moved any branch or tag. No branch or tag points at history that is not stored where you asked.

Copies that did confirm are content-addressed. The next push finds them and does not upload them again. The `note:` line says whether anything was written to Platform. If `dash.platformFallback` was armed and Platform chunks were stored, they are journaled and the next push reuses them.

**What to do**, in order:
1. Run `dg storage test <failing profile>`. It uploads a probe, reads it back and names the problem (credentials, region, bucket policy, CORS). Then push again.
2. Or lower `dash.replicas` to the number of targets that work.
3. Or `git config dash.platformFallback true` to store on Platform (costed, and confirmed by the cost guard) when your storage fails.

## E503

**Packs unreadable.** A clone or fetch needed a pack whose recorded copies all failed: storage down, object deleted, or a gateway that does not have the CID. The helper reads every other pack first and reports this only when the wanted history really is incomplete, so a dead copy of a pack nothing needs (a deleted branch, or one a repack superseded) does not fail the clone. The `cause:` line names each unreadable pack and why each of its copies failed. A host that refuses the connection gives up its place in the race at once, so it never waits on a slow gateway tried alongside it. Copies are tried two at a time. If neither sends a single byte within 20 seconds, both are dropped and the next two are tried, again with 20 seconds. A gateway that cannot find a CID holds the request open for about a minute before it answers 504, so this saves most of that wait. Every copy is still tried before the clone fails. Once any copy starts sending, the slow-but-healthy transfer keeps its full deadline.

**What to do:** anyone whose clone still has the objects can restore the copies with `dg reseed <owner>/<repo> --from-local`, run inside that clone. If you know another IPFS gateway that has the pack, add it to `[read] ipfs_gateways` in `storage.toml` and try again.

When every copy a pack's manifest records is one no reader follows (the pusher's storage had a plain-http, loopback or private-network public address, recorded with `allow-private-uri`, or an S3 bucket with no public address), the cause says so for each copy, and neither a gateway nor a retry helps. A member can record the packs again at a public https address: `dg repack <owner>/<repo> --profile <profile>` stores one consolidated pack there and records it on chain (`dg reseed --from-local` only re-uploads to addresses already recorded, so it cannot help here). If that host or bucket is your own, add a storage profile for it and retry.

A fork records its parent's packs where the parent's pusher stored them. When those are copies no reader follows, `dg repo fork` warns before it writes anything, and the fork's E503 says the packs are its parent's. A fork keeps the copies its parent had when it was made: the parent's maintainers record the packs at a public https address (`dg repack <parent> --profile <profile>`), and then the parent can be cloned, or forked again. Running `dg repo fork <parent> --name <fork name>` again on the same fork records the repack's new pack in it.

`dg storage mirror add` stops with E503, before anything is written or paid, when **none of the addresses answers with the pack**: not found, refused, timed out, or an `ipfs://` address with no read gateway configured. What to do: check that the file is uploaded and public, or pass `--no-verify` to record the addresses anyway.

`dg release download` stops with E503 before downloading anything when none of the asset's recorded copies is one this computer reads from. A copy recorded on chain is followed only if it is a public https URL, an IPFS CID with a gateway to ask, or a bucket or host named in one of your own storage profiles. Plain http, loopback and private-network addresses are never followed just because a publisher recorded them. If the host is your own storage, add a profile whose `public_url` is it, and retry.

## E504

**Integrity check failed.** Downloaded bytes did not hash to the SHA-256 recorded on Platform. A storage host, or a cache in front of it, served different content. The bytes were discarded, and a tampered copy is never handed to git.

**What to do:** run the command again; other copies are tried. `dg storage status <owner>/<repo>` shows which copies verify.

`git fetch` and `git push` also stop with E504 when a `dash://<owner>/<repo>` URL **now names a different repository** than the one the clone was made from. The first time git-remote-dash resolves a named URL in a repository (at clone, or the first fetch of an older clone), it records the repository id and owner id in that repository's git config, per network (`[dash "devnet-sakura:dash://alice/project"]` `repoId`, `ownerId`). A DPNS name can change hands, so a later resolution to another repository is refused rather than mixing in someone else's history or pushing your commits to them. The message names both repositories. What to do: keep using the repository you cloned with `git remote set-url origin dash://<pinned repo id>`, or, if you trust the change (for example after a devnet reset), run the same git command once with `git -c dash.allowRepin=true`, which warns and re-pins. `dg` commands run in the clone check the same pin before they read from or write to a pinned name (`dg issue list`, `dg issue create`, `dg pr create`, …): a moved name stops them with E504 too, before anything is read or signed. To keep working with the pinned repository, name it by id (`-R <pinned repo id>`). `dg` never re-pins: `git -c dash.allowRepin=true fetch` does, and with `dash.allowRepin` set `dg` goes on with a warning.

`dg storage mirror add` stops with E504, before anything is written or paid, when an address serves **other bytes** than the pack's: a different file, or one larger than the pack. What to do: check the addresses, or pass `--no-verify` to record them anyway.

`dg release verify` exits with E504 when a release **changed since it was first published**: its tag points at another commit, was deleted, or two pushes race on it, or its assets were replaced, added or removed, or the commit the release records is not where its tag pointed when it was published. It also exits with E504 when no tag of that name was ever pushed, since there is nothing to check the release against (the web release list marks only real changes). The output names every move (who, when, from and to) and every asset change. What to do: ask the repository's maintainers which commit and files the release should name before installing from it.

`dg release download` also stops with E504, before downloading anything, when the release asset records **no SHA-256** (older `forge-import` releases recorded an empty digest for an asset its source gave none for). There is nothing to check the bytes against, and nothing is downloaded unverified. What to do: a maintainer re-runs the import with a current `forge-import`, which hashes each such asset and republishes the release, or publishes it again with the file (`dg release create <repo> --tag <tag> --asset <file>`).

`dg verify-mirror <url>` stops with E504 when a plain-git mirror (a [forge-gateway](hosting/forge-gateway.md)) **does not match Platform**: it serves a tip a ref never had, a ref Platform does not have, or leaves one out, or its `forge-manifest.json` claims something Platform's proved refs do not back. With `--strict`, a mirror that is only behind (a ref still at an earlier tip) stops with E504 too. What to do: clone from Platform instead (`git clone dash://<owner>/<repo>`), and tell the gateway's operator. If it is only behind, wait for its next refresh.

`dg verify-app <url>` stops with E504 when the site **does not match a published build**: it serves no `forge-manifest.json`, GitHub holds no attestation of the one it serves from this repository's CI, or a file the manifest lists is missing or has other bytes (each is named). What to do: don't unlock a private repository on that copy. Use a release's IPFS build, or check the copy against a manifest you trust with `--manifest <file>` ([Verify the app you loaded](guides/verify-the-app.md#check-a-deployed-copy-dg-verify-app)).

## E505

**Storage credentials unavailable.** A profile's secret reference does not resolve: the `env:` variable is unset in the environment that git or `dg` runs in, or the `keychain:` entry does not exist.

**What to do:** export the variable (git runs the helper in your shell's environment), or store the secret in the keychain and re-add the profile with `--secret-access-key keychain:dash-forge/<name>`. `dg storage list` shows which references resolve.

## E506

**Storage profile failed its checks.** `dg storage test` found a failing step: signed PUT/GET, anonymous public read, or browser CORS. The output shows each step and, for CORS, the exact configuration to paste for your provider.

**What to do:** apply the printed fix, then run `dg storage test <name>` again. `git push` works without CORS, but the web app cannot read the repo until CORS passes.

## E507

**Recorded pack copy unreachable.** An earlier push recorded this exact pack, and none of the copies it recorded can be read now. The push was refused **before** paying for anything.

**What to do:** restore that storage, or re-upload the pack from this clone with `dg reseed <owner>/<repo> --from-local` (run inside the repository). Then push again.

## E508

**No storage configured.** `dg repo create` or `dg init` found no storage profile for the new repository: no `--storage`, no `dash.storage` in git config (this repository's or your global one), and not exactly one profile in `storage.toml` to default to. Without one, every push would store its packs on Platform at about 0.33 DASH per MiB ([Costs](guides/costs.md)), so the command stops **before** creating anything. The cause line prices this repository's current size.

**What to do:** add your own storage with `dg storage add` (a prompt flow when run with no arguments), or pass `--storage platform` to accept the Platform price. `git config --global dash.storage <profile>` sets a default for every new repository.

## E509

**Encrypted pack corrupt.** A private repository's pack downloaded intact but doesn't decrypt. Whoever pushed it stored bytes no Forge app writes, so every copy is the same.

**What to do:** ask the member who pushed it to push again (`git push` re-stores it under a new hash). `dg repo keys status` shows which epochs you can read.

*Protocol detail:* the sealed artifact hash-verified against its manifest, but a segment tag, the header or the length does not check out.

## E510

**Written after the key was rotated.** Someone who is no longer a member wrote this with the repository's old key, after the short grace period that follows a key change. Forge apps hide it from every reader, but it isn't deleted.

**What to do:** none needed; if the writer is still meant to be a member, re-add them and have them write it again.

A clone or fetch reports E510 as `clone incomplete: N packs hidden by the late-content rule` when a branch you asked for needs objects that only such hidden packs hold. Restoring a copy would not help, because the rule hides that content from every reader.
- **A removed member's late upload:** it becomes readable again as soon as its uploader is a member (`dg collab add`).
- **A pack sealed under an earlier use of an epoch number:** nobody can open it again. A member whose clone has the commits can push the branch again.

In either case, a maintainer can instead move the ref back to history every member can read.

*Protocol detail:* the late-content rule. The content is under a superseded key epoch and was written more than 240 blocks after the next epoch's key was first announced on chain (re-announcing the same key later does not move this), or at any time under an epoch that was given up, by someone who is no longer a member.

## E511

**git refused an object in the history.** An object failed git's own checks. The `cause:` line names each object, the git check that refused it (its `fsck` msg-id, for example `hasDotgit` or `gitmodulesUrl`) and git's message. It happens in two places:
- **Clone or fetch:** a downloaded pack holds the object. The clone stops before any ref can point at it. A `.gitmodules` whose tree and blob arrive in different packs is checked once every pack is in.
- **Push, including `forge-import`, which pushes through the helper:** the pushed history holds the object. The push stops before anything is stored or paid for.

These are the checks git runs with `transfer.fsckObjects`, which a plain `git clone` skips. Each stays fatal because it can change what a checkout writes, or lets two readers disagree on what an object names:
- a path git treats as the repository (`.git`, `.GIT`, `git~1`);
- a `.gitmodules` whose URL or path is an option or escapes the work tree;
- a `.gitmodules` or `.gitattributes` that is a symbolic link;
- a corrupt tree or commit header.

The author and committer line checks (`badTimezone`, `missingSpaceBeforeDate`, `badEmail`, `badDate` and similar) are ignored, so real histories with old malformed commits still clone, push and merge. That needs git 2.44 or newer. An older git can only run every check at once, so it refuses those histories on clone; in that case the error says to upgrade git.

**What to do:**
- On a clone or fetch, the history itself has to change: ask a maintainer to push history without that object. Nothing needs cleaning up on your side.
- On a push or import, rewrite the history so no commit holds that object, then push again.
- If every refused check is an author or committer line check, upgrade git to 2.44 or newer.

## E601

**Not a writer of this repository.** Your identity doesn't have the role this write needs: you aren't a member with write access, or your role can't make this kind of change. Dash Platform refuses the write, and `dg` and the push helper usually refuse it before signing, so you aren't charged.

**What to do:** give your consent first, once: `dg collab accept <owner>/<repo>` (or **Accept** in the web app). Then ask the owner to add you: `dg collab add <owner>/<repo> <your identity id> --role writer`. A membership names the member's own consent, so an add before the accept is refused ([E604](#e604): "has not accepted membership"). Or push to a repository of your own.

Already a member, but your role can't make this write (a writer hiding a comment, a triage member pinning, a reader labelling)? `dg` refuses before signing and says so: *"you are a writer of `<repo>`; this needs a maintainer"*. You have already accepted, so all you need is the role the write needs: ask the owner to run `dg collab add <owner>/<repo> <your identity id> --role maintainer` (or `writer`, `triage`).

Outside a push (collaborator admin, releases, repo settings) the headline says your identity "is not authorized for this action", because those need a different role. Editing or deleting someone else's comment is E601 too: only its author can, maintainers included.

*Protocol detail:* consensus error 40120 on `$ownerId` (the `ownerRefersTo` gate) or on the `asMember` / `asMaintainer` membership proofs: no current `writer` or `maintainer` document names your identity. 40127, or the schema maximum on `r`: the role the write claims doesn't match your `writer` document's role.

## E602 (retired)

**Write access suspended.** Retired on 2026-09-26 with Forge's first contracts, which could suspend a member. Forge has no suspend now: removing a member revokes access at once ([E601](#e601)). The number stays reserved.

## E603

**Already exists.** That name is already taken, for example a repository name you already use.

**What to do:** pick another name. Issue and PR numbers are retried automatically, so Platform raises this only for names.

`dg storage mirror add` reports E603, before anything is signed, when you already recorded a mirror of that pack: each person holds one record per pack. To change its addresses, remove it (`dg storage mirror remove <record id>`, the id is in the message) and add the new one.

`dg pr create` also reports E603, before anything is signed, when you already have an open pull request from the same head branch into the same base (as GitHub refuses a second one): a pull request cannot be deleted, so a duplicate would stay. The message names the open one. Push to the branch to update it, or pick another base. Pull requests other people opened from your branch do not count.

## E604

**Rejected by Platform.** Dash Platform refused the write, or would have, for a reason not listed above. `dg` and the push helper check the rules they can before signing, and stop a write that is certain to be refused with this code and the note "checked before anything was signed; nothing was written or paid". It covers a write that refers to an issue, repository or identity that does not exist (the headline names the field that points to it, and the cause names what is missing), and an edit of something that can't change (the headline names the field and says "can't change once set").

Two common ones:

- `dg collab add` for someone who has not given their consent: "has not accepted membership". They run `dg collab accept <owner>/<repo>` (or **Accept** in the web app), then you add them again, or pass `--wait` to wait for it.
- A state change the issue or PR's current state does not allow (reopening a merged PR). Closing a closed issue, or reopening an open one, is not an error: `dg` says so and writes nothing.

**What to do:** if the message does not explain it, [open an issue](https://github.com/PastaPastaPasta/dash-forge/issues) with it.

`dg ci report` refuses before signing a report that names a run by `--external-id` but would change it once it completed ("a completed run can't change") or re-queue it once it started ("a started run can't go back to queued"). What to do: report a re-run with a new `--external-id`.

*Protocol detail:* any consensus refusal without its own code, including 40120 on a path other than `$ownerId`, `asMember` and `asMaintainer` (a referenced document, contract or identity is missing), 40128 (an immutable field changed) and 10422 (a contract rule, which the headline names: "consensus refused it by the rule …"). The `cause:` line carries Platform's message, or the rule, when it has one.

## E605 (retired)

**Old repository is read only.** Retired on 2026-09-26 with Forge's first contracts, which the tools no longer read or write. The number stays reserved.

## E606

**Repository archived.** A maintainer archived the repository (`dg repo archive`, or Settings → Danger zone). Forge apps enforce archiving, not Platform: Platform still accepts a member's writes, so the tools refuse them instead. That covers `dg` issue, PR, comment, review, merge and release writes, and the push helper, each before signing or paying for anything.

**What to do:** ask a maintainer to unarchive it (`dg repo unarchive <owner>/<repo>`). If you are sure, write anyway with `dg --allow-archived …` or push with `-o allow-archived`.

## E607

**Edited meanwhile.** The issue, PR or comment you are editing was replaced again after `dg` read it, so your edit was made against text that is no longer there. `dg` refuses the replace before signing: writing it would silently drop the other edit. In a private repository this matters most, because an edit re-seals the whole text it read.

**What to do:** read it again (`dg issue view`, `dg pr view --comments`) and redo the edit on the current text.

## E608

**Environment changed at the same time.** Two changes to one environment were saved at once (two maintainers, or one maintainer from two places), so it has two or more latest versions. Versions that share no earlier version are reported as separate histories. Forge never merges them: `dg env run`, `get` and `export` refuse until a maintainer keeps one. The `cause:` line names every version, with its author and time.

**What to do:** `dg env history --env <name>` shows what each changed; a maintainer keeps one with `dg env edit --env <name> --keep <id>` (or `set`, `unset`, `import` with `--keep`). See [Environments](guides/environments.md#when-two-people-change-it-at-once).

## E610

**Banned from this repository.** A maintainer of the repository banned your identity. Forge apps hide a banned identity's issues, pull requests, comments and reviews in that repository (each with a way to show it), and refuse its new issues, pull requests, comments and reviews there before signing. The `cause:` line names who banned you and the reason they gave.

**What to do:** ask a maintainer of the repository to lift the ban. Only the maintainer who wrote a ban can lift it, and a ban stops counting once its writer is no longer a maintainer.

*Protocol detail:* a ban is a forge-collab `ban` document that only a maintainer can write. Platform does not stop a banned identity from writing; Forge apps do.

## E701

**Dash Platform unreachable.** No DAPI node answered, or the quorum service could not be reached. Nodes that fail are skipped for about a minute, so an immediate retry often reaches the same dead nodes.

**What to do:** check your connection and run the command again after a minute. `dg doctor` tests reachability. On a devnet, check `--dapi-addresses` / `git config dash.dapiAddresses`.

A devnet name that does not exist is reported here too, because a lookup failure cannot tell a typo from being offline: the quorum service host is derived from the name (`quorums.<name>.networks.dash.org`), and `cause:` shows `Failed to resolve domain 'quorums.<name>.networks.dash.org'`. When it does, the fix names the `--devnet-name` that failed. A devnet name is checked for its shape only ([E204](#e204), for example a leading `-`), never for existing.

## E702

**Dash Forge not deployed on this network.** This build knows of no Forge deployment on the network you chose, so there is nothing to read or write. The tools never fall back to another network's deployment. Forge runs on devnet sakura; testnet and mainnet follow once they run Dash Platform v5 ([Networks](networks.md)).

**What to do:** use a network with a deployment. For `dg`, pass `--network devnet --devnet-name sakura` (`dg auth new` and `dg auth login` record it as the default). For `git clone` / `git push`, the helper takes the network from `DASH_FORGE_NETWORK`, then git config `dash.network` / `dash.devnetName`, then the network `dg` recorded, so set one of those: `git config --global dash.network devnet && git config --global dash.devnetName sakura`, or `git clone -c dash.network=devnet -c dash.devnetName=sakura dash://…` for one clone. See [the mainnet runbook](mainnet-runbook.md).

`forge contracts not found on <network>` is also E702. This build knows of a Forge deployment on the network, but the network does not have it. On a devnet this means it was reset, which removes every contract on it, and Forge has not been deployed on it again yet. On testnet or mainnet it means the build's deployment record is wrong. Running the command again cannot help.

**What to do:** update `dg` and `git-remote-dash` to a release made after Forge was deployed on the network again. `dg doctor` shows the network and the contract ids in use. Check that the network is the one you meant: `--network` for `dg`; git config `dash.network` / `dash.devnetName` or `DASH_FORGE_NETWORK` for the helper.

*Protocol detail:* in the first case the build's embedded `forge-contracts/deployments/<network>.json` records no forge-v2 contracts (forge-core, forge-collab, forge-community and their contract group); the CLI says "forge-v2 isn't deployed". The second is Platform proving one of those contracts absent, or refusing a read with `contract not found`.

## E703

**Incomplete read.** A read that has to be complete (every ref update, every event) could not be proven complete. The data was refused rather than used in part, because a partial history can show a branch, or an issue or PR's state, wrongly.

**What to do:** run it again. A different node is asked.

## E704

**Timed out; may still land.** Your signed write was sent to Dash Platform but not confirmed in time. It may still land.

**What to do:** for `git push`, run the push again. Chunks are journaled and ref updates are idempotent, so nothing is paid for twice. For other writes (an issue, a comment), check whether it landed before running the command again.

**Concurrent writes from the same identity.** Two writers signing as one identity at the same moment (two terminals, `dg` and a `git push`, or the CLI and the web app) can pick the same contract nonce. Platform accepts both, the block takes one, and the node quietly drops the other: no result for it ever arrives. The CLI and the web app notice this without waiting minutes. After one bounded wait (20 s), they read the identity's nonce. If it is spent, they check whether the write landed and re-sign it with the next nonce if it did not. Expect such a write to finish in about 20–60 s instead of the usual few seconds. You only see E704 when that check itself cannot reach Platform. Writers that take turns never hit this.

## E801

**Stopped by the cost guard.** This push costs more than `dash.costWarnThreshold`, or `dash.confirm = always`, and there is no terminal to confirm on (CI, a GUI client). The helper never assumes yes.

**What to do:** add your own storage (`dg storage add`, then `dg storage use`) so packs go to your bucket and only the manifest and refs are paid on Platform. Or accept the price for this push with `git -c dash.confirm=never push`, or raise `dash.costWarnThreshold`.

## E802

**Confirmation required.** A cost-bearing or destructive `dg` command needs confirmation, and it cannot prompt: `--json` mode, or stdin is not a terminal.

**What to do:** pass `--yes` once you have checked what the command will do. The `cause:` line quotes the prompt, with its DASH estimate when the command prints one; `dg cost estimate` and `dg cost prices` give the rest.

## E803

**Cancelled.** You answered no at a confirmation prompt, or the input ended (Ctrl-D, a closed terminal) before an answer at one of `dg`'s own prompts, including the hidden ones: the recovery phrase, a word of `dg auth new`'s backup check, a secret pasted into `dg storage add`. Nothing was written. (A passphrase prompt that cannot be asked is [E303](#e303).)

**What to do:** nothing, if you meant to stop. Otherwise run the command again in a terminal and finish the prompt or the editor.

## E804

**Branch policy not met.** `dg pr merge` checked the repository's branch `policy` (`dg repo policy show`) and it is not satisfied: fewer counted approvals than it requires (from maintainers only, when it says so), required checks that are not passing (`cause: required checks not passing: lint failing`), a merge method it does not allow, or the policy could not be read. The cause names every unmet rule (`required approvals: 0 of 1; required check `build`: missing`). Forge apps enforce the policy; Dash Platform doesn't check it. Nothing was pushed and no merge event was posted.

`dg pr checks` reports E804 (exit 8, as `gh pr checks` does for a pending check) while a check the branch policy requires is missing or still running. A run from a source the policy does not pin for that check is listed but not counted.

**What to do:** get the missing approvals (`dg pr review --approve` by a member other than the PR author, whose own approval never counts), get the failing checks to pass (`dg pr checks <owner>/<repo> <n>` shows the runs), or use an allowed method. A maintainer can bypass the approvals and checks with `--override-policy`; the merge then records the bypassed rules on the PR as a policy-bypass event, which nobody can delete. The allowed merge methods still apply.

## E807

**Possible secret in a public push.** The push adds a file that looks like a secret to a public repository, and nothing pushed to a public branch can be taken back. Before it signs or stores anything, the push helper checks every file the push publishes for the first time. It refuses a branch or tag whose new commits add a `.env` file that sets a value (`.env`, `.env.local`, `.env.<name>`, but not names ending in `.example`, `.sample` or `.template`), a PEM private key, an AWS access key ID together with its secret, or a GitHub or GitLab token whose checksum is valid. Git shows `! [remote rejected] main -> main (possible secret in new files)`. Only the refused refs are held back. The rest of the push goes ahead, and you weren't charged for the refused ones.

A private key, AWS key or token only warns when its file is in a `test`, `tests`, `testdata` or `fixtures` folder. A `.env` file is refused there too. Any finding only warns when it is only in history older than the repository on Forge (commits made more than a day before the repository was created, and everything `forge-import` mirrors). [Secrets in a push](guides/quick-start.md#secrets-in-a-push) lists what is checked.

**What to do:** take the file out of the commits that added it (`git rm --cached <file>`, add it to `.gitignore`, then amend or rebase), and replace any real secret it held. If you have checked it and it is safe to publish, push with `-o allow-secret=<fingerprint>` (the code printed in brackets beside each finding), or add the fingerprint to `.forge/secret-scan-allow` at the tip of the branch or tag and commit that. A path in that file turns the refusal into a warning that is printed on every push.

## E808

**Branch other pull requests use.** `dg pr merge --delete-branch` would delete the PR's source branch, but other open pull requests use it: as their base (a PR stacked on this one) or as their head. A pull request whose base branch is deleted can't be merged until its base is changed, and one whose head branch is deleted stops following new pushes. The cause names each pull request and how it uses the branch. Nothing was pushed or written.

**What to do:** retarget the pull requests based on it (`dg pr edit <owner>/<repo> <n> --base <branch>`), or merge without `--delete-branch` and delete the branch once nothing needs it, or pass `--force-delete-branch` to delete it anyway.

Only the repository's newest 100 pull requests are checked. When there are older ones, or some can't be read, the error (or, when none was found, the merge's output) says they were not checked.

## E805

**Would publish members-only commits.** *Reserved: this version doesn't report it yet. It arrives with members-only branches.* A push to a public branch would publish commits that belong to a members-only branch. Anything pushed to a public branch can't be taken back, so the push helper refuses the whole push before it signs or stores anything. The message names the first commits (`a1b2c3d Fix bounds check`) and how many there are, and git shows `! [remote rejected] main -> main (would publish members-only commits)`.

```
error: E805 pushing refs/heads/main would publish 3 commits from members-only branch sec/cve-77
       a1b2c3d Fix bounds check
       ...
  fix: dg publish sec/cve-77 --onto main                 # one new public commit; the members-only history stays members-only
       git push -o publish-private=<oid> origin main      # publish these 3 commits as they are
```

**What to do:** `dg publish <branch> --onto <public branch>` makes one new public commit, and the members-only history stays members-only. If you mean to publish the commits as they are, push with `-o publish-private=<oid>`. That is a publication and can't be undone.

## E806

**Can't check for members-only commits.** *Reserved: this version doesn't report it yet. It arrives with members-only branches.* This clone has fetched members-only branches, and your encryption key isn't available, so a public push can't be checked, and a fetch would quietly show only the public view. Forge refuses rather than guess.

```
error: E806 can't check for members-only commits: your encryption key isn't available
       this clone has fetched members-only branches, so a public push can't be checked without it
  fix: dg auth unlock, then push again
```

**What to do:** unlock your encryption key with `dg auth unlock`, then run the command again. A key protected by a passphrase needs a terminal, or `DASH_FORGE_PASSPHRASE`.

## E809

**Branch is already public.** *Reserved: this version doesn't report it yet. It arrives with members-only branches.* You asked for a members-only branch with a name that is already public. Nothing already pushed can be hidden, so Forge doesn't offer to hide it.

```
error: E809 fix-auth is already public; nothing already pushed can be hidden
  fix: dg branch new --members fix-auth-2     # start a members-only branch from here
```

**What to do:** start a members-only branch from where you are with a new name (`dg branch new --members <new name>`), and carry on there.

## E810

**Members-only commits not pushed to another remote.** *Reserved: this version doesn't report it yet. It arrives with members-only branches.* Your `pre-push` hook found members-only commits from a Dash Forge repository in what you are pushing to a remote that is not that repository (GitHub, for example), or to a public branch of it, and stopped the push.

```
pre-push: E810 refs/heads/main contains members-only commits from dash://o/r; not pushing to github
          git push --no-verify publishes them
```

**What to do:** push only branches that don't hold members-only commits, or publish them first with `dg publish`. `git push --no-verify` skips the hook and publishes the commits to that remote. That is a publication, and no check can stop it.

## E811

**New branch: choose who can see it.** *Reserved: this version doesn't report it yet. It arrives with members-only branches.* You pushed a branch Forge hasn't seen before, in a public repository that has members-only content on, and nothing says who should see it: not `dg branch new --members`, not a push option, and not the clone's `dash.newBranches` setting. Forge asks once per clone and signs nothing.

```
error: E811 new branch fix-auth: choose who can see it
  fix: git config dash.newBranches public     # or members; then push again
       dg branch new --members fix-auth        # for one branch
```

**What to do:** set `git config dash.newBranches public` (or `members`) for this clone and push again, or make the one branch members-only with `dg branch new --members <branch>`. A branch that is public stays public: nothing already pushed can be hidden ([E809](#e809)).

This is not [E808](#e808), which is the refusal to delete a branch other pull requests use.

## E812

**Can't make everything public.** *Reserved: this version doesn't report it yet. It arrives with making a whole repository public.* Making a repository public with everything in it would publish something that isn't safe to publish yet. The message names it. An environment with values saved in the old format is one case: anyone who joined later could read those values, and they would become public.

```
error: E812 can't make everything public: environment production has values saved in the old format, which would become public
  fix: dg env resave --env production, change every listed value where it's used, then dg env mark-changed --env production
```

**What to do:** do what the fix line says for each item listed, then run the command again. Or choose **Code only**, which publishes the code and leaves everything else members-only.

## E813

**Bot can't be asked.** *Reserved: this version doesn't report it yet. It arrives with bot access.* You asked a bot to work on something outside the access its maintainers gave it. For example, the bot can only be asked by people with Write access or more, and you have Triage access. Nothing was signed, and nothing was sent to the bot.

```
error: E813 @ci-bot can't be asked by people with Triage access in o/r
  fix: ask a maintainer to change @ci-bot's access, or ask someone with Write access
```

**What to do:** ask someone with Write access to ask the bot, or ask a maintainer to change who can ask it (Settings → Bots and runners).
