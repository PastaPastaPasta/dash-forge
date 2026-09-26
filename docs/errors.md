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

Codes never change meaning once shipped, so scripts can match on them. The code's first digit is the process exit code:

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

Fix: check the owner id and the name (`dg repo list --owner <identity id>`). Also check the network, because a repo created on testnet does not exist on mainnet: `dg doctor` shows which network and registry are in use.

## E103

**Not implemented yet.** The command exists but is not wired yet. The output describes the manual workaround.

## E104

**Checks failed.** `dg doctor` found at least one failing check. Each `✗` row carries its own fix, and `dg doctor --fix` applies the safe ones.

## E105

**Merge has conflicts.** `dg pr merge` tried a three-way merge of the pull request's head into its base locally and the two change the same lines. Nothing was pushed and no merge event was posted.

Fix: resolve it by hand: `dg pr checkout <owner>/<repo> <n>`, merge the base into `pr/<n>` and fix the conflicts, push the result to the base branch (a member can), then run `dg pr merge` again: it finds the PR head already in the base and only records the merge. A PR names a fixed head commit, so pushing the resolution to the PR's source branch does not change the PR: open a new one from it instead.

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

## E205

**Unsupported git operation.** `dash://` cannot serve shallow clones (`--depth`, `--shallow-since`, `--shallow-exclude`). It fails instead of quietly making a full clone.

Fix: use a partial clone for a lightweight checkout: `git clone --filter=blob:none dash://…`.

## E301

**No identity configured.** The command needs to sign, and no identity file was found.

Fix: `dg auth login --identity <file>` records a default identity (use the bridge identity export). Alternatively, pass `--identity <file>` for one command, or set `DASH_FORGE_KEY=<file>` (this is also how `git-remote-dash` finds the key; its fallback is `~/.config/dash-forge/identities/<owner>.identity.json`).

## E302

**This key can't sign that.** The identity file has no key at the security level the operation needs. Document writes need a HIGH or CRITICAL AUTHENTICATION key. Token administration (`dg collab add/suspend/remove`, `dg repo create`) needs a CRITICAL one.

Fix: use the identity export that includes that key.

## E303

**Identity file unreadable.** The identity file is missing, unreadable or not a bridge-format identity export.

Fix: check the path (`dg auth status` shows which file is in use), or export the identity again from the bridge.

## E304

**Identity not found on this network.** Platform has no identity with the id in your identity file, usually because the identity was created on a different network.

Fix: select the network the identity was created on: `--network testnet|mainnet`, or `--network devnet --devnet-name <name>`.

## E401

**Not enough credits.** The identity's balance cannot pay for the write. The `cause:` line starts with `insufficient credits:` and shows the amount needed and the current balance in DASH.

Fix: top up the identity from any Dash wallet at <https://bridge.thepasta.org>. `dg auth balance` shows the balance. Reading, cloning and browsing are free and still work.

## E501

**Storage not configured correctly.** `dash.storage` names a profile that `~/.config/dash-forge/storage.toml` does not define, `dash.replicas` is out of range, or `storage.toml` does not parse.

Fix: `dg storage list` shows your profiles and `dg storage use <profiles>` sets `dash.storage`. See [bring your own storage](guides/bring-your-own-storage.md).

## E502

**Storage policy not met.** Fewer targets confirmed the pack than `dash.replicas` requires, so the push stopped **before** the `packManifest` and the refs were written. No ref points at history that is not stored where you asked.

Copies that did confirm are content-addressed. The next push finds them and does not upload them again. The `note:` line says whether anything was written to Platform. If `dash.platformFallback` was armed and Platform chunks were stored, they are journaled and the next push reuses them.

Fix, in order:
1. Run `dg storage test <failing profile>`. It uploads a probe, reads it back and names the problem (credentials, region, bucket policy, CORS). Then push again.
2. Or lower `dash.replicas` to the number of targets that work.
3. Or `git config dash.platformFallback true` to store on Platform (costed, and confirmed by the cost guard) when your storage fails.

## E503

**Packs unreadable.** A clone or fetch needed a pack whose recorded copies all failed: storage down, object deleted, or a gateway that does not have the CID.

Fix: anyone whose clone still has the objects can restore the copies with `dg reseed <owner>/<repo> --from-local`, run inside that clone. If you know another IPFS gateway that has the pack, add it to `[read] ipfs_gateways` in `storage.toml` and try again.

## E504

**Integrity check failed.** Downloaded bytes did not hash to the SHA-256 that the on-chain manifest records. A storage host, or a cache in front of it, served different content. The bytes were discarded, and a tampered copy is never handed to git.

Fix: run the command again; other copies are tried. `dg storage status <owner>/<repo>` shows which copies verify.

## E505

**Storage credentials unavailable.** A profile's secret reference does not resolve: the `env:` variable is unset in the environment that git or `dg` runs in, or the `keychain:` entry does not exist.

Fix: export the variable (git runs the helper in your shell's environment), or store the secret in the keychain and re-add the profile with `--secret-access-key keychain:dash-forge/<name>`. `dg storage list` shows which references resolve.

## E506

**Storage profile failed its checks.** `dg storage test` found a failing step: signed PUT/GET, anonymous public read, or browser CORS. The output shows each step and, for CORS, the exact configuration to paste for your provider.

Fix: apply the printed fix, then run `dg storage test <name>` again. `git push` works without CORS, but the web app cannot read the repo until CORS passes.

## E507

**Recorded pack copy unreachable.** An earlier push recorded this exact pack, and none of the copies it recorded can be read now. The push was refused **before** paying for anything.

Fix: restore that storage, or re-upload the pack from this clone with `dg reseed <owner>/<repo> --from-local` (run inside the repository). Then push again.

## E601

**Not a writer of this repository.** Platform refused the write at consensus. On a v1 repository your identity holds no WRITE (or MAINTAIN) token (consensus 40700/40701). On a forge-v2 repository there is no current `writer` or `maintainer` document for your identity (40120 on path `$ownerId`, the `ownerRefersTo` gate).

Outside a push (collaborator admin, releases, repo config) the headline says your identity "is not authorized for this action", because those need a different role.

The helper checks this before building or paying for anything and refuses early with the same advice.

Fix: ask the owner to add you (`dg collab add <owner>/<repo> <your identity id> --role writer`), or push to a repository of your own.

## E602

**Write access suspended.** Your WRITE or MAINTAIN token on a v1 repository is frozen (consensus 40702). v1 repositories are read only now, so this only appears for a write attempted against one. forge-v2 has no suspend: removing a member revokes access at once (E601).

Fix: push to a forge-v2 repository instead.

## E603

**Already exists.** Platform refused a document that collides with a unique index, for example a repository name you already use.

Fix: pick another name. Issue and PR numbers are retried automatically, so this only surfaces for names.

## E604

**Rejected by Platform.** Consensus refused the state transition for a reason not listed above. This includes 40120 on any path other than `$ownerId`: a document, contract or identity the write refers to does not exist (the headline names the path). The `cause:` line carries Platform's message, which names the rule.

Fix: if the message does not explain it, [open an issue](https://github.com/PastaPastaPasta/dash-forge/issues) with it.

## E605

**v1 repository is read only.** The repository is a forge-v1 repository (one data contract per repo). v1 repositories can still be cloned, fetched and viewed, but nothing writes to them any more. The refusal happens before anything is signed.

Fix: copy it to forge-v2 with `dg migrate <owner>/<name> --from-network testnet` (refs, packs, issues, PRs, labels, releases and members; `--dry-run` prices it first), or create a forge-v2 repository (`dg repo create <name>`, about 0.001 DASH) and push there.

## E701

**Dash Platform unreachable.** No DAPI node answered, or the quorum service could not be reached. Nodes that fail are skipped for about a minute, so an immediate retry often reaches the same dead nodes.

Fix: check your connection and run the command again after a minute. `dg doctor` tests reachability. On a devnet, check `--dapi-addresses` / `git config dash.dapiAddresses`.

## E702

**Dash Forge not deployed on this network.** The embedded `forge-contracts/deployments/<network>.json` records no registry contract, so there is nothing to read or write. The tools never fall back to another network's contract.

Fix: use a network with a deployment (`--network testnet`), or point `FORGE_REGISTRY_CONTRACT_ID` (`dg`: `registry_contract_id` in `config.toml`; helper: `git config dash.registryContractId`) at a registry you deployed. See [the mainnet runbook](mainnet-runbook.md).

## E703

**Incomplete read.** A read that has to be complete (every ref update, every event) could not be proven complete. The data was refused rather than folded partially, because a partial history can resolve refs differently from a complete one.

Fix: run it again. A different node is asked.

## E704

**Timed out; may still land.** A signed state transition was broadcast but not confirmed in time. It may still be included.

Fix: for `git push`, run the push again. Chunks are journaled and ref updates are idempotent, so nothing is paid for twice. For other writes (an issue, a comment), check whether it landed before running the command again.

## E801

**Stopped by the cost guard.** This push costs more than `dash.costWarnThreshold`, or `dash.confirm = always`, and there is no terminal to confirm on (CI, a GUI client). The helper never assumes yes.

Fix: add your own storage (`dg storage add`, then `dg storage use`) so packs go to your bucket and only the manifest and refs are paid on Platform. Or accept the price for this push with `git -c dash.confirm=never push`, or raise `dash.costWarnThreshold`.

## E802

**Confirmation required.** A cost-bearing or destructive `dg` command needs confirmation, and it cannot prompt: `--json` mode, or stdin is not a terminal.

Fix: pass `--yes` after checking the estimate (`dg cost estimate`).

## E803

**Cancelled.** You answered no at the confirmation prompt (or the terminal closed). Nothing was written.
