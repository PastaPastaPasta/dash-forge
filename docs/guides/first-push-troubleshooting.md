# My first push failed

The push stops before it stores or pays for anything in almost every case below, so a failed push usually cost nothing. Every message ends in an error code; [Error codes](../errors.md) has the full text of each. Run `dg doctor` first: it shows the network in use, whether Forge is deployed there, your identity and key, and your storage.

1. [Forge is not deployed here (E702)](#forge-is-not-deployed-here-e702)
2. [The push needs credits (E401, E402)](#the-push-needs-credits-e401-e402)
3. [The cost guard stopped it (E801)](#the-cost-guard-stopped-it-e801)
4. [No storage chosen (E508), or storage that fails (E501 to E506)](#no-storage-chosen-e508-or-storage-that-fails-e501-to-e506)
5. [The name now points somewhere else (E504)](#the-name-now-points-somewhere-else-e504)
6. [Not a member (E601), or your key can't sign (E302, E305)](#not-a-member-e601-or-your-key-cant-sign-e302-e305)
7. [The key is locked, or there is no keychain](#the-key-is-locked-or-there-is-no-keychain)
8. [It timed out (E704)](#it-timed-out-e704)
9. [A clone is shallow, or the history is refused (E205, E511)](#a-clone-is-shallow-or-the-history-is-refused-e205-e511)
10. [Large files and LFS](#large-files-and-lfs)
11. [Packs that can't be read (E503, E507)](#packs-that-cant-be-read-e503-e507)

## Forge is not deployed here (E702)

`dg` and `git push` default to testnet, and an install only works on a network where Forge's contracts are registered. If you see [E702](../errors.md#e702), the build you run knows of no deployment on that network, or the network no longer has the contracts (a reset removes them). Pick a network that has them: `dg doctor` shows which one is in use and what chose it, and [Networks](../networks.md) lists where Forge runs. Set it once with `dg auth login --network <network>` (`--devnet-name <name>` for a devnet), or for git alone `git config --global dash.network <network>`. If you are on the right network and the contracts are missing, wait for the announcement that Forge is back, or update `dg`: a reset can need a new release.

## The push needs credits (E401, E402)

- **[E401](../errors.md#e401) not enough credits.** `dg auth balance` shows your balance. Top the identity up from a Dash wallet through the bridge. On a test network the faucet linked from [Costs](costs.md#credits) is free. A push checks its estimate against your balance before it uploads anything.
- **[E402](../errors.md#e402) this key's budget is used up.** Your balance is untouched; the limited key you sign with has spent its budget. Register a fresh one: `dg auth login <identity file>` or `dg auth login --mnemonic`, with a larger `--budget` if you need one.

## The cost guard stopped it (E801)

[E801](../errors.md#e801) means the helper would have asked "continue?" and had no terminal to ask on (CI, a GUI git client). There are two causes:

1. **The price.** The push costs more than `dash.costWarnThreshold` (0.05 DASH unless you set it). The whole push counts: every pack and every ref update, so `git push --tags` of many tags at commits already stored can be stopped too. Accept it for this push with `git -c dash.confirm=never push`, or raise the threshold (`git config --global dash.costWarnThreshold 0.1`, or `off`).
2. **The 1 MiB rule.** The repository has no `dash.storage`, and the push would store more than 1 MiB of packs **permanently on Platform**. Raising the threshold does not help. Choose storage: `dg storage add`, then `dg storage use <profile>`, and push again; only the manifest and refs are then paid on Platform. If Platform really is what you want, say so with `git config dash.storage platform`.

Run `dg cost estimate` in the repository to see the price before you push. Platform storage is about 0.33 DASH per MiB; your own bucket is a few thousandths of a DASH per push ([Costs](costs.md#platform-or-your-own-bucket)).

## No storage chosen (E508), or storage that fails (E501 to E506)

- **[E508](../errors.md#e508)**: `dg init` or `dg repo create` found no storage profile and stopped before creating anything. Add one with `dg storage add`, or pass `--storage platform` to accept the Platform price.
- **[E501](../errors.md#e501)**: the profile named in `dash.storage` does not exist in `~/.config/dash-forge/storage.toml`, or its public read address is not a public `https` URL (loopback, a LAN address, `.local` and plain `http` are refused).
- **[E505](../errors.md#e505)**: a credential reference does not resolve: the `env:` variable is unset in the environment git runs in, or the keychain entry is missing. `dg storage list` shows which references resolve.
- **[E506](../errors.md#e506), [E502](../errors.md#e502)**: run `dg storage test <profile>`. It uploads a probe, reads it back and names the problem (credentials, region, bucket policy, CORS). The push works without CORS, but the web app cannot read the repository until CORS passes.

[Bring your own storage](bring-your-own-storage.md) sets up each provider.

## The name now points somewhere else (E504)

`git fetch` or `git push` stops with [E504](../errors.md#e504) when `dash://<owner>/<repo>` now names a **different repository** than the clone was made from, or the owner identity changed. A DPNS name can change hands, and a network reset also looks like this. Forge refuses rather than mix in someone else's history or push your commits to them. The message names both repositories.

1. Switch the remote to the repository you cloned, by its id, which no name can take over: `git remote set-url origin dash://<pinned repo id>`. This is the recommended fix.
2. Only if you know why the owner changed (a network reset you were told about, say), run the same git command once with `git -c dash.allowRepin=true`, which warns and re-pins.

`dg` commands in that clone stop the same way until you name the repository by its id (`-R <pinned repo id>`).

## Not a member (E601), or your key can't sign (E302, E305)

- **[E601](../errors.md#e601)**: your identity is not a writer of that repository (if you are one already, see the protected-branch note below). Run `dg collab accept <owner>/<repo>` once, then ask the owner to run `dg collab add <owner>/<repo> <your identity id> --role writer`. Or push to a repository of your own, or a fork.
- **[E302](../errors.md#e302)**: that action needs your master key (adding keys, a username), which a limited key can't stand in for. Pass `--master <file>` or type the recovery phrase.
- **[E305](../errors.md#e305)**: your limited key expired or was disabled. Register a fresh one with `dg auth login`.
- A protected branch (a new repository protects its default branch and every tag) takes pushes from maintainers only. A writer's push to it is refused with [E601](../errors.md#e601), and adding writer access does not change that: ask for Maintain access, or push to an unprotected branch and open a pull request.

## The key is locked, or there is no keychain

- A key sealed with a passphrase is asked for on the terminal. Without a terminal, set `DASH_FORGE_PASSPHRASE` or sign in again with a key that needs none ([E303](../errors.md#e303)).
- **Over a remote login or in a container there is no keychain dialog to answer.** Use a sealed key file there: `DASH_FORGE_NO_KEYCHAIN=1 dg auth login …`. `--insecure-plaintext` stores a key unencrypted where there is no keychain and no way to type a passphrase; every later use warns. See [Identity and keys](identity-and-keys.md).
- `git-remote-dash` finds the key the way `dg` does: `DASH_FORGE_KEY` first, then the key `dg auth login` stored. If `git push` cannot find your identity, check `dg auth status` in the same shell ([E301](../errors.md#e301)).

## It timed out (E704)

[E704](../errors.md#e704): the write was sent but not confirmed in time, and **may still land**. For `git push`, first check whether the refs landed (`git ls-remote origin`). If they did, there is nothing to repeat. If not, run the push again: chunks are journaled, so they are not paid twice, and a pack already recorded is reused. A ref update that landed but is not visible yet can be sent again and cost another ref-update charge, so give it a minute before you retry. For other writes (an issue, a comment), check whether it landed before you run the command again. Two writers signing as one identity at once (two terminals, or `dg` and the web app) can pick the same nonce; one write is dropped, which also shows as a timeout. Write from one place at a time.

## A clone is shallow, or the history is refused (E205, E511)

- **[E205](../errors.md#e205)**: `dash://` cannot serve shallow clones (`--depth`, `--shallow-since`). Use a partial clone for a light checkout: `git clone --filter=blob:none dash://…`.
- **[E511](../errors.md#e511)**: an object in the history failed git's own checks (a path that looks like `.git`, a hostile `.gitmodules`). The push stops before anything is stored or paid for. The `cause:` line names each object and the check. If every refused check is an author or committer line check, upgrade git: **git 2.44 or newer** ignores those, and an older git refuses every old history that has one.

## Large files and LFS

Forge does not support Git LFS. A repository's LFS pointer files are ordinary git content and are stored, but the large objects they point to are not, so a clone from Forge has pointers only. Keep large binaries out of git, or attach them to releases, which go to your own storage (`dg release create --asset`). The Mirror Action warns when it mirrors a repository with `filter=lfs` ([Mirror a GitHub repository](mirror-a-github-repo.md)). A big monorepo is fine on your own storage; on Platform it costs about 0.33 DASH per MiB, so check `dg cost estimate` first. Limits in numbers: [Limits](../limits.md).

## Packs that can't be read (E503, E507)

- **[E507](../errors.md#e507)**: an earlier push recorded this pack, and none of its copies can be read now. The push stops before paying. Restore that storage, or upload the pack again from this clone: `dg reseed <owner>/<repo> --from-local`.
- **[E503](../errors.md#e503)** on a clone: every recorded copy of a pack needed by the clone failed. Anyone whose clone has the objects can restore the copies with `dg reseed <owner>/<repo> --from-local`. Add a gateway that has the pack to `[read] ipfs_gateways` in `storage.toml`.

Still stuck? `RUST_LOG=debug dg …` prints more detail; then [open an issue](https://github.com/PastaPastaPasta/dash-forge/issues) with the output, after checking it for anything private.
