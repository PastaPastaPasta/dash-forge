# Moving from GitHub or GitLab

This guide is one path from a project on GitHub (or GitLab) to the same project on Dash Forge, with its code, issues, pull requests, releases and labels, and your collaborators. It links the other guides in the order you need them, and says plainly what Forge doesn't do yet.

You don't have to move everything at once. Most projects start as a **mirror**, where GitHub stays the home and Forge follows it, and **cut over** later, or never. Both are covered.

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

Replace every `<…>` placeholder with your own value. Forge runs on **devnet moutai** today, where Dash is free ([Which network](README.md#which-network)).

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

**Public by default.** Everything you import is published on Dash Platform, permanently, and can't be deleted: issues and PRs by design, packs because others depend on them. Import only what you are happy to publish forever. GitLab's members-only content is refused unless you pass `--include-members-only`, and internal comments and confidential issues are never imported ([GitLab guide](mirror-a-gitlab-project.md#1-first-import)). The importer creates public repositories. To import into a private one, create it first with `dg repo create --private <name>` and pass `--repo <name>`. Releases are then left out (their notes and assets would not be encrypted), and so are label definitions unless you pass `--include-label-definitions` ([Private repositories](collaborating.md#private-repositories)).

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
dg auth new --network devnet --devnet-name moutai
```

`dg` shows 12 recovery words (write them down), then a deposit address. Fund it from any Dash wallet; on moutai, use the [faucet](https://faucet.moutai.networks.dash.org). How much you need depends on the repository: `forge-import --dry-run` in the next step tells you. [Quick start §2–3](quick-start.md#2-get-an-identity) has the details, and [Identity and keys](identity-and-keys.md) covers backups and top-ups.

## 4. Import the repository

Build the importer ([quick start §1](quick-start.md#1-install) builds `dg` and `git-remote-dash`), and sign in to GitHub so it can read issues, PRs and releases:

```sh
cargo install --locked --path crates/forge-import
gh auth login
```

The standalone `forge-import` does not read `dg`'s saved identity or network, so give it both. `dg import <owner>/<repo>` is the same engine with `dg`'s defaults, if you prefer.

```sh
export DASH_FORGE_KEY=keychain:dash-forge/devnet-moutai/<your identity id>   # the key dg auth stored
```

(If `dg auth status` says the key is in a passphrase-encrypted file, use that file's path instead, with `DASH_FORGE_PASSPHRASE` set or a terminal to ask on.)

**Price it first.** A dry run reads everything and writes nothing:

```sh
forge-import alice/project --network devnet --devnet-name moutai --dry-run
```

```
github.com/alice/project → dash://5NGj…/project (devnet-moutai)
  would write: 26 ref updates · 2 packs (794.4 KiB) · 1 issues · 36 PRs · 205 comments · 81 reviews · 32 events · 0 releases · 9 labels
  estimate: 0.436514 DASH (dry run: nothing written)
```

**Try a few items**, then look at the result on the web:

```sh
forge-import alice/project --network devnet --devnet-name moutai --limit 5 --max-spend 0.1 --yes
```

**Then import everything**, with a cap a little above the estimate and a state file for later runs:

```sh
forge-import alice/project --network devnet --devnet-name moutai \
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

While GitHub is still where work happens, let Forge follow it with the **Forge Mirror Action**: the same importer, run from GitHub Actions on every push, issue, PR and release and on a daily schedule, under a per-run cost cap. Set it up from [Mirror a GitHub repository §2](mirror-a-github-repo.md#2-the-forge-mirror-action). Its CI secret is a limited key, never your identity file:

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
dg repo protect add <your id>/project main                        # only maintainers move main (Platform enforces it)
dg repo policy set <your id>/project --required-approvals 1       # Forge clients hold the merge until approved
```

## 8. CI

What exists today, and what doesn't:

- **Webhooks: yes.** GitHub-shaped webhooks, delivered by a relay you run, so a CI system that takes GitHub webhooks can build from Forge ([Webhooks and CI](collaborating.md#webhooks-and-ci)).
- **Showing check results: yes.** A `checkRun` document records a named check on a commit (queued, in progress, completed; success or failure). `dg pr checks` and the web's PR page show them, the relay delivers them as `check_run` webhooks, and a branch policy can require them (`dg repo policy set … --require-checks true`).
- **Writing check results: a reference example, not a shipped tool.** `dg`, the relay daemon and the web app write no `checkRun`. The relay's example consumer, [`ci_consumer`](../../crates/forge-relay/examples/ci_consumer.rs), shows the loop. It verifies a webhook against Platform and posts a `checkRun` signed by a runner identity that is a writer or maintainer of the repository: `CI_IDENTITY=<runner identity file> cargo run -p forge-relay --example ci_consumer`. The file's header lists the other variables it needs. Your CI system would do the same with its own Platform client.
- **A runner: no.** Forge runs no CI and has no equivalent of GitHub Actions. `.github/workflows` files in your repository do nothing on Forge. A `dg ci` command, runner identities with keys that can only post check runs, and a first-party runner are designed ([platform-parity spec §2](../design/platform-parity-spec.md#2-ci--actions-design)) but not built.

What people do today:

- **Keep CI on GitHub while dual-homed** ([§6](#stay-on-both-dual-home)). Nothing changes.
- **After a cut-over**, point a CI system that takes webhooks (Jenkins, Buildkite, Woodpecker, your own) at a relay, and have it clone with `git clone dash://…`. Results stay in that CI system for now.

## 9. What it costs

Forge takes nothing. You pay Platform fees from your identity's credits, and your storage provider's bill. [What things cost](costs.md#what-each-action-costs) has every measured figure, including a first mirror run, a push to your own storage and a push to Platform. For a migration:

- **The import** costs what `forge-import --dry-run` says. Most of it is one document per issue, PR, comment and review.
- **Later pushes** cost the per-push figure in [Costs](costs.md#what-each-action-costs) for where your packs live.
- **A Mirror Action re-run** with nothing new costs nothing.

For example, the dry run of a repository with about 800 KiB of packs, 36 PRs, 205 comments and 81 reviews, with packs on the owner's own storage, was priced at 0.44 DASH. Almost all of that was the discussion history; the git part was 0.02 DASH. The same packs on Platform would have added about 0.22 DASH.

## 10. GitHub features with no Forge equivalent

| GitHub | On Forge | What to do instead |
|---|---|---|
| **Actions** (CI/CD runners) | No runner | See [§8](#8-ci) |
| **Discussions** | None | Issues with a `discussion` label |
| **Wiki** | None | A `docs/` folder in the repository; the web app renders Markdown |
| **GitHub Pages** | None: Forge serves no user content | Serve the site from your own bucket and domain (R2 and S3 host static sites) |
| **Packages** (npm, containers) | None | Publish to the usual registries, or attach build outputs to a release (`dg release create --asset`) |
| **Projects / boards** | None | Labels, and `dg issue list --label … --assignee …` filters |
| **Milestones** | Not imported | Labels such as `v1.2` |
| **Reactions** | None: each one would be a paid document | A comment, or a review approval |
| **Assignees** | Not imported; you can assign on Forge (`dg issue assign`) | Re-assign open items after the import |
| **Organizations and teams** | Repositories belong to one identity; members are per repository | A shared maintainer identity, or add each person to each repository |
| **Transferring a repository** | Not possible: the owner is fixed | Create a repository under the new owner and push to it (history is unchanged) |
| **Deleting a repository, issue or PR** | Not possible: they are permanent | Archive the repository (`dg repo archive`), close issues and PRs |
| **Git LFS** | Not supported | Keep large binaries out of git; attach them to releases, which go to your storage |
| **`https://` clone URLs, shallow clones** | `dash://` only (needs `git-remote-dash`); no `--depth` ([E205](../errors.md#e205)) | `git clone --filter=blob:none` for a light clone; the web app offers a zip of any branch |
| **Email notifications** | None: there is no server to send them | The web app's **Notifications**, or a webhook to your own notifier |
| **Secret scanning, Dependabot, code search** | None | Run those tools locally or in your own CI |
| **Private repositories in the web app** | The web app reads private repositories and writes their issues, PRs and reviews, but can't merge PRs or commit to branches in them yet | Use `dg` for those |

The [FAQ](../FAQ.md) has more on what Forge is and isn't.
