# Moving from GitHub or GitLab

This guide is one path from a project on GitHub (or GitLab) to the same project on Dash Forge, with its code, issues, pull requests, releases and labels, and your collaborators. It links the other guides in the order you need them, and says plainly what Forge doesn't do yet.

You don't have to move everything at once. Most projects start as a **mirror**, where GitHub stays the home and Forge follows it, and **cut over** later, or never. Both are covered.

## Start here: the mirror wizard

For a public GitHub repository, the quickest path needs no install. Open **[forge.dashhq.org/mirror](https://forge.dashhq.org/mirror/)** (or **New → Mirror a GitHub repo**). It works through six steps in your browser. The hosted site moves to sakura when its contracts are registered and the web app cuts over ([Which network](README.md#which-network)); until then, use `/mirror` on a build of `forge-web` for sakura that records them.

1. **The GitHub repository.** Type `owner/name` or paste its URL. Your browser asks GitHub's public API, without signing in, whether the repository exists and is public. There is no GitHub OAuth app, because Forge runs no server.
2. **The Forge repository.** The name comes from GitHub and the price is shown before you sign. Creating it writes three documents, for about 0.002 DASH. If you already own a Forge repository with that name, the mirror writes into it at no cost.
3. **Storage.** Pick a bucket you have already saved, or add one with the [storage wizard](bring-your-own-storage.md). Cloudflare R2 or S3 is recommended. The step shows the CORS policy to paste. Dash Platform is also offered, priced per MiB.
4. **A runner key.** This is a limited key on your identity, bound to Forge's contracts, with its own budget and expiry (default 0.5 DASH and 365 days). Your master key signs once, from your identity file or recovery phrase. The key is shown **once**, as the `DASH_FORGE_KEY` value to paste into GitHub, and is not stored in the browser. Because it belongs to the repository's owner, the Action needs no other membership.
5. **The workflow.** The wizard lists the secrets to add first: `DASH_FORGE_KEY`, plus `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` for a bucket. It then builds `.github/workflows/forge-mirror.yml` with the repository, network, devnet name and storage filled in, and both the build and the Action pinned to one commit. **Create this file on GitHub** opens GitHub's new-file page with the file filled in, and committing it starts the first run.
6. **The first run.** The page checks Platform until the mirror's branches appear, then links to the repository.

The wizard saves your progress in the browser and picks up where you stopped. It never saves a key. Until a Dash Forge release is published, the workflow builds `dg`, `git-remote-dash` and `forge-import` on the runner. That makes the first run take several extra minutes, and later runs use the cache ([measured timing](mirror-a-github-repo.md#the-setup-wizard)).

The rest of this guide covers the command-line path: private repositories, GitLab, a one-off import with no Action, and cutting over.

1. [What moves and what doesn't](#1-what-moves-and-what-doesnt)
2. [Pick where the code is stored](#2-pick-where-the-code-is-stored)
3. [Get and fund an identity](#3-get-and-fund-an-identity)
4. [Import the repository](#4-import-the-repository)
5. [Keep it in sync](#5-keep-it-in-sync)
6. [Cut over, or stay on both](#6-cut-over-or-stay-on-both)
7. [Invite collaborators](#7-invite-collaborators)
8. [CI](#8-ci)
9. [What it costs](#9-what-it-costs)
10. [GitHub features with no Forge equivalent](#10-github-features-with-no-forge-equivalent)

Replace every `<…>` placeholder with your own value. Forge runs on **devnet sakura**, where Dash is free ([Which network](README.md#which-network)).

---

## 1. What moves and what doesn't

| On GitHub | On Forge | How |
|---|---|---|
| Branches, tags, full history | Branches, tags, full history (commit ids unchanged) | `forge-import`, or plain `git push` |
| Issues and their comments | Issues at the **same numbers**, with comments, labels and open/closed state | `forge-import` |
| Pull requests | PRs at the same numbers: title, body, base, head commit, state (open, closed, merged, draft), labels, comments, reviews. The head of each open PR as `refs/mirror/pull/<n>/head` | `forge-import` |
| Releases | Tag, title and notes. Each asset is recorded by its GitHub URL and SHA-256; the file is not copied | `forge-import` |
| Labels | Label definitions, and each item's labels | `forge-import` |
| Collaborators | Writers and maintainers, by Dash identity | `dg collab add` ([§7](#7-invite-collaborators)) |
| Branch protection, required reviews | Protected branches (enforced by Platform) and a branch policy (enforced by Forge clients) | `dg repo protect`, `dg repo policy` |
| Webhooks | GitHub-shaped webhooks, delivered by a relay you run | `dg webhook add` ([§8](#8-ci)) |

Imported items are written by **your** identity and name their GitHub author ([how](mirror-a-github-repo.md#1-first-import)). Some things are not imported: see [Not mirrored](mirror-a-github-repo.md#1-first-import) and [§10](#10-github-features-with-no-forge-equivalent).

**Public by default.** Everything you import is published on Dash Platform, permanently, and can't be deleted: issues and PRs by design, packs because others depend on them. Import only what you are happy to publish forever. GitLab's members-only content is refused unless you pass `--include-members-only`, and internal comments and confidential issues are never imported ([GitLab guide](mirror-a-gitlab-project.md#1-first-import)). The importer creates public repositories. To import into a private one, create it first with `dg repo create --private <name>` and pass `--repo <name>`. Its releases are then sealed: their tags, names, notes, source links and asset lists are encrypted, and each asset the importer can download is encrypted and stored on your own storage (the storage policy you set for the packs), so a private import with releases needs storage of your own. Storage still shows each asset's exact size, which can identify the public release it mirrors. Label definitions are left out unless you pass `--include-label-definitions` ([Private repositories](collaborating.md#private-repositories)).

## 2. Pick where the code is stored

Forge hosts nothing. Pack bytes (the git objects) go to storage you choose, and only small signed records go on Platform. Decide this **before** you import: the import pushes the whole history, and storing it on Platform is priced per byte and permanent ([Platform or your own bucket](costs.md#platform-or-your-own-bucket)).

| Option | Good for | Guide |
|---|---|---|
| Cloudflare R2 | most projects: no egress fees, a free tier | [R2](bring-your-own-storage.md#cloudflare-r2) |
| Backblaze B2, AWS S3, Storj | an account you already have | [B2](bring-your-own-storage.md#backblaze-b2), [S3](bring-your-own-storage.md#aws-s3), [Storj](bring-your-own-storage.md#storj) |
| A NAS at home | no storage bill; needs a second copy for when it's off | [Home NAS](home-nas-storage.md) |
| IPFS (kubo, a pinning service) | content addressing, many readers | [IPFS](bring-your-own-storage.md#ipfs-your-own-kubo-node) |
| Dash Platform | tiny repositories; no account needed | nothing to set up |

Set it up and make it your global default:

```sh
dg storage add                          # asks for each value, stores the secret in your keychain, tests it
dg storage test <profile>               # every row OK, including "browser CORS"
dg storage use <profile> --global       # two places for anything you care about: dg storage use r2-main,nas --global
```

`--global` matters: `forge-import` pushes through `git-remote-dash`, which reads the global `dash.storage`. A repository can override it later with its own `dg storage use` (without `--global`), run inside that clone.

## 3. Get and fund an identity

A Dash identity is your account. You create it yourself by locking some Dash. Nobody issues it, and Forge never creates or funds one for you.

```sh
dg auth new --network devnet --devnet-name sakura
```

`dg` shows a 12-word recovery phrase (write it down), then a deposit address. Fund it from any Dash wallet; on sakura, use the [faucet](https://faucet.sakura.networks.dash.org). How much you need depends on the repository: `forge-import --dry-run` in the next step tells you. [Quick start §2–3](quick-start.md#2-get-an-identity) has the details, and [Identity and keys](identity-and-keys.md) covers backups and top-ups.

## 4. Import the repository

Install the importer ([quick start §1](quick-start.md#1-install) installs `dg` and `git-remote-dash`; from a source clone, `cargo install --locked --path crates/forge-import` builds it instead), and sign in to GitHub so it can read issues, PRs and releases:

```sh
curl -fsSL https://raw.githubusercontent.com/PastaPastaPasta/dash-forge/v0.1.0/install.sh | DASH_FORGE_VERSION=0.1.0 DASH_FORGE_BINARIES="dg git-remote-dash forge-import" sh
gh auth login
```

The standalone `forge-import` does not read `dg`'s saved identity or network, so give it both. `dg import <owner>/<repo>` is the same engine with `dg`'s defaults, if you prefer.

```sh
export DASH_FORGE_KEY=keychain:dash-forge/devnet-sakura/<your identity id>   # the key dg auth stored
```

(If `dg auth status` says the key is in a passphrase-encrypted file, use that file's path instead, and set `DASH_FORGE_PASSPHRASE`. `forge-import` is built to run unattended, so it never asks for the passphrase, even in a terminal.)

**Price it first.** A dry run reads everything and writes nothing:

```sh
forge-import alice/project --network devnet --devnet-name sakura --dry-run
```

```
github.com/alice/project → dash://5NGj…/project (devnet-sakura)
  would write: 26 ref updates · 2 packs (794.4 KiB) · 1 issues · 36 PRs · 205 comments · 81 reviews · 32 events · 0 releases · 9 labels
  estimate: 0.436514 DASH (dry run: nothing written)
```

**Try a few items**, then look at the result on the web:

```sh
forge-import alice/project --network devnet --devnet-name sakura --limit 5 --max-spend 0.1 --yes
```

**Then import everything**, with a cap a little above the estimate and a state file for later runs:

```sh
forge-import alice/project --network devnet --devnet-name sakura \
  --max-spend 0.5 --state ./project.sync.json --yes --summary-json ./import.json
```

`--max-spend` is a hard cap: the importer refuses to start above it and stops before the write that would cross it; a re-run with a higher cap finishes the job without writing anything twice. The [GitHub mirror guide](mirror-a-github-repo.md#1-first-import) lists every flag and how a run ends. For GitLab, name the project as `gitlab.com/<group>/<project>` with a `GITLAB_TOKEN` ([GitLab guide](mirror-a-gitlab-project.md)).

**Check it.** A commit id is a hash of the commit and all its history, so equal tips mean identical history:

```sh
git ls-remote dash://<your id>/project refs/heads/main
git ls-remote https://github.com/alice/project refs/heads/main     # the same id
dg pr list <your id>/project --state all
dg storage status <your id>/project                                 # every copy of every pack answers
```

Then open `https://forge.dashhq.org/<your id>/project`. Run `dg storage advertise <your id>/project` once, so readers and the web app know where the packs live.

## 5. Keep it in sync

While GitHub is still where work happens, let Forge follow it with the **Forge Mirror Action**: the same importer, run from GitHub Actions on every push, issue, PR and release and on a daily schedule, under a per-run cost cap. The [mirror wizard](#start-here-the-mirror-wizard) sets it up from the browser. To set it up by hand, see [Mirror a GitHub repository §2](mirror-a-github-repo.md#2-the-forge-mirror-action). Its CI secret is a limited key, never your identity file:

```sh
dg auth export --new-key --master dash-identity-<id>.json \
  --budget 0.5 --expires 365d --format dfk1 --reveal-secrets -o runner.dfk1
```

For GitLab, use the [CI template](mirror-a-gitlab-project.md#2-keep-it-in-sync-from-gitlab-ci).

## 6. Cut over, or stay on both

### Stay on both (dual-home)

Keep GitHub as the place people push and file issues, and keep the Mirror Action running. Forge then holds a copy nobody can take down, and readers can use either. This is the right choice while contributors, CI and integrations still live on GitHub.

In your own checkout, add Forge as a second remote so you can read from it:

```sh
git remote add forge dash://<your id>/project
git fetch forge
```

Only one side should take writes. If people push to both, the mirror will overwrite Forge's branches with GitHub's on its next run.

### Cut over

When Forge becomes the home:

1. **Stop the mirror.** Delete the workflow file (or disable it in the Actions tab), then run one last `forge-import` so the final issues and comments are there.
2. **Freeze GitHub.** Archive the GitHub repository (Settings → Archive this repository), or at least protect every branch, so nothing lands there that Forge won't see. Put the new address at the top of the README:
   ```markdown
   > This project moved to Dash Forge: https://forge.dashhq.org/<your id>/project
   > Clone: `git clone dash://<your id>/project` (needs [git-remote-dash](https://github.com/PastaPastaPasta/dash-forge/blob/master/docs/INSTALL.md))
   ```
3. **Point your checkout at Forge:**
   ```sh
   git remote rename origin github
   git remote add origin dash://<your id>/project
   git fetch origin
   git branch -u origin/main main
   git push                                # plain git from now on
   ```
4. **Tell contributors** how to get set up: install `dg` and `git-remote-dash`, `dg auth new`, then `dg repo clone <your id>/project`. Reading and cloning need no identity; pushing, issues and reviews do.

A DPNS username makes addresses readable: `dg auth name register <label>`, then `dash://<label>/project` and `forge.dashhq.org/<label>/project` work everywhere. Names of 3–19 characters made only of `a`–`z`, `0`, `1` and `-` are contested and refused, so pick one with another digit or longer than 19 characters (for example `alice-project2`); see [Identity and keys](identity-and-keys.md#what-an-identity-is).

## 7. Invite collaborators

Each collaborator needs their own Dash identity (`dg auth new`) and sends you its id (`dg auth status` shows it). Then:

```sh
dg collab add <your id>/project <their identity id> --role writer       # or --role maintainer
dg collab list <your id>/project
```

| GitHub role | Forge role |
|---|---|
| Write | `writer` |
| Maintain / Admin | `maintainer` |
| Triage, Read | none needed: anyone can open issues and PRs, comment and review |

[Collaborating](collaborating.md#collaborators) says what each role can do. Only the repository's owner can add or remove members, and consensus enforces it.

A collaborator then clones and pushes with plain git. If your storage is a bucket, they need write access to it too: give them their own key for the same bucket, which they add with `dg storage add` and `dg storage use`. Or they can push to a bucket of their own. Readers find every pack through its on-chain manifest, wherever it is stored.

```sh
dg repo clone <your id>/project && cd project
git switch -c fix-typo && git commit -am "Fix a typo"
git push -u origin fix-typo
dg pr create <your id>/project --body "Fixes the README"
```

To replace GitHub's branch protection:

```sh
dg repo protect defaults <your id>/project                        # only maintainers move main and tags (Platform enforces it; new repositories start this way)
dg repo policy set <your id>/project --required-approvals 1       # Forge clients hold the merge until approved
```

## 8. CI

What exists today, and what doesn't:

- **Webhooks: yes.** GitHub-shaped webhooks, delivered by a relay you run, so a CI system that takes GitHub webhooks can build from Forge ([Webhooks and CI](collaborating.md#webhooks-and-ci)).
- **Showing check results: yes.** A `checkRun` document records a named check on a commit (queued, in progress, completed; success or failure). `dg pr checks` and the web's PR page show them, the relay delivers them as `check_run` webhooks, and a branch policy can require them (`dg repo policy set … --require-checks true`).
- **Writing check results: yes, with `dg ci`.** `dg ci runner new` gives a runner identity a key that can only post check runs and enrols it in the repository. `dg ci report <owner>/<repo> --sha <commit> --name build --status completed --conclusion success` writes a check run from any CI, with an optional log and artifacts stored in your own storage. See [CI and check runs](ci.md).
- **A runner: one you run yourself.** Forge hosts no CI. [`forge-runner`](self-host-runner.md) runs a repository's `.forge/workflows/*.yml` (GitHub Actions syntax) with nektos/act in Docker, on `push` and `pull_request`, and reports each job as a check run. Your `.github/workflows` files do nothing on Forge until you copy them to `.forge/workflows`. It has no `schedule` or `workflow_dispatch` triggers ([what it does not do](self-host-runner.md#what-it-does-not-do-yet)).

What people do today:

- **Keep CI on GitHub while dual-homed** ([§6](#stay-on-both-dual-home)). The [check action](ci.md#report-from-github-actions) reports each GitHub Actions job as a Forge check run on the same commit.
- **After a cut-over**, run [`forge-runner`](self-host-runner.md), or point a CI system that takes webhooks (Jenkins, Buildkite, Woodpecker, your own) at a relay, have it clone with `git clone dash://…`, and report back with `dg ci report`.

## 9. What it costs

Forge takes nothing. You pay Platform fees from your identity's credits, and your storage provider's bill. [What things cost](costs.md#what-each-action-costs) has every measured figure, including a first mirror run, a push to your own storage and a push to Platform. For a migration:

- **The import** costs what `forge-import --dry-run` says. Most of it is one document per issue, PR, comment and review.
- **Later pushes** cost the per-push figure in [Costs](costs.md#what-each-action-costs) for where your packs live.
- **A Mirror Action re-run** with nothing new costs nothing.

For example, the dry run of a repository with about 800 KiB of packs, 36 PRs, 205 comments and 81 reviews, with packs on the owner's own storage, was priced at 0.44 DASH. Almost all of that was the discussion history; the git part was 0.02 DASH. The same packs on Platform would have added about 0.27 DASH (see [Costs](costs.md)).

## 10. GitHub features with no Forge equivalent

| GitHub | On Forge | What to do instead |
|---|---|---|
| **Actions** (CI/CD runners) | No hosted runners; a runner you host yourself (`forge-runner`) | See [§8](#8-ci) |
| **Discussions** | None | Issues with a `discussion` label |
| **Wiki** | None | A `docs/` folder in the repository; the web app renders Markdown |
| **GitHub Pages** | None: Forge serves no user content | Serve the site from your own bucket and domain (R2 and S3 host static sites) |
| **Packages** (npm, containers) | None | Publish to the usual registries, or attach build outputs to a release (`dg release create --asset`) |
| **Projects / boards** | None | Labels, and `dg issue list --label … --assignee …` filters |
| **Milestones** | Supported (`dg milestone`, and **Issues → Milestones** on the web), but the importer does not bring them over | Re-create the ones you need ([Milestones](collaborating.md#milestones)) and set them with `dg issue milestone` |
| **Issue and PR templates** | Supported on the web: Markdown templates, YAML issue forms and `config.yml` from `.github/ISSUE_TEMPLATE/` (or `.gitlab/issue_templates/`), and `pull_request_template.md` / `PULL_REQUEST_TEMPLATE/` (or GitLab's merge request templates). A form's `assignees` are not applied, and `dg` does not read templates | Nothing: they are read from the repository ([Issue and PR templates](collaborating.md#issue-and-pr-templates)) |
| **Reactions** | None: each one would be a paid document | A comment, or a review approval |
| **Verified commits** | Supported for Ed25519 SSH and Ed25519/ECDSA OpenPGP keys you publish on your profile; RSA keys don't fit | `dg profile key add` ([Signed commits](identity-and-keys.md#signed-commits-and-verified-badges)) |
| **Assignees** | Not imported; you can assign on Forge (`dg issue assign`) | Re-assign open items after the import |
| **CODEOWNERS** | Read from the base branch; new PRs ask the owners for review ([Code owners](collaborating.md#code-owners)). Teams and e-mail owners are not asked, `@login` is read as a DPNS name, and "require review from code owners" is not a branch rule | Name people by DPNS name or identity id; ask for the approvals with the branch policy's required approvals |
| **Organizations and teams** | Repositories belong to one identity; members are per repository | A shared maintainer identity, or add each person to each repository |
| **Transferring a repository** | Not possible: the owner is fixed | Create a repository under the new owner and push to it (history is unchanged) |
| **Deleting a repository, issue or PR** | Not possible: they are permanent | Archive the repository (`dg repo archive`), close issues and PRs |
| **Git LFS** | Not supported | Keep large binaries out of git; attach them to releases, which go to your storage |
| **`https://` clone URLs, shallow clones** | `dash://` only (needs `git-remote-dash`); no `--depth` ([E205](../errors.md#e205)) | `git clone --filter=blob:none` for a light clone; the web app offers a zip of any branch |
| **Email notifications** | None: there is no server to send them | The web app's **Notifications**, or a webhook to your own notifier |
| **Code search** | Within one repository, in the web app: built in your browser from the repository's files, the default branch only for a large repository ([Search the code](quick-start.md#search-the-code)). No search across repositories: that needs an indexer, and Forge runs none | `git grep` in a clone |
| **Secret scanning, Dependabot** | None | Run those tools locally or in your own CI |
| **Private repositories in the web app** | The web app reads private repositories and writes their issues, PRs and reviews, but can't merge PRs or commit to branches in them yet | Use `dg` for those |

The [FAQ](../FAQ.md) has more on what Forge is and isn't.
