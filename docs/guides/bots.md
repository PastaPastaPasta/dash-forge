# Bots and agents (beta)

A **bot** is an automated account: a CI helper, a triage assistant, an AI agent. A maintainer gives it access to a repository, and **everyone can read what it may do**. Beyond that, a bot gets only what a person hands it for one job. It never receives the members key.

This page covers adding a bot, its access notice, asking it to work on an issue or pull request (agents mode), its members-only replies, and its push access. It is the guide to the features the web app marks **Beta**: Bots and runners, Access notices and read letters, Agents, and Bot push access ([Known limitations](collaborating.md#known-limitations)). They work, but expect rough edges. Try them on a throwaway repository before you rely on them.

1. [What a bot is](#what-a-bot-is)
2. [Where it works](#where-it-works)
3. [Add a bot](#add-a-bot)
4. [Give it access](#give-it-access)
5. [Ask it to work on something](#ask-it-to-work-on-something)
6. [Members-only replies](#members-only-replies)
7. [Let it push](#let-it-push)
8. [What the AI service sees](#what-the-ai-service-sees)
9. [Errors](#errors)

## What a bot is

| | Member (Read to Maintain) | Bot | CI runner |
|---|---|---|---|
| Reads members-only content | yes, with the members key | **no**, except the one thread it is asked about, as it was when asked | no, unless you give its identity the Read role |
| Posts comments and reviews | yes | yes, if its access allows it. It can't approve or merge. | no, only reports check runs |
| Pushes | by role | only to branches a maintainer allows, for a limited time | no |
| Gets the members key | yes | **never** | never |
| Who sets it up | the owner adds members | the owner adds it, a maintainer gives it access | the owner, `dg ci runner add` |

A bot can be the same identity as a CI runner: a runner that reports checks needs `dg ci runner add` as well ([CI and check runs](ci.md)).

## Where it works

A bot is a member with the **Bot** role, and its push access is a contract document of its own. Both exist only where the network's contracts have them: the four-contract production set, which is the set to be registered on testnet and mainnet ([Deploying Forge to a network](../deploying-to-a-network.md)); Forge is registered on devnet sakura only today. On a network registered with the three-contract devnet set (devnet sakura today), `--role bot` is refused before anything is signed. A bot there is an identity outside the members, it cannot push, and it cannot post members-only. The web app's **Settings → Bots and runners** says "Bots can't push to this repo yet." there. That page tells you what your network supports.

| Part | `dg` | Web app |
|---|---|---|
| See what each bot may do | `dg bot list` | **Settings → Bots and runners** |
| Give, change or take away access | `dg bot allow`, `dg bot revoke` | the same page, maintainers |
| Ask a bot to work on a thread | `dg bot ask` | **Agents** in the sidebar of an issue or pull request |
| Share code with the bot for a request | `dg bot ask` in a clone of the repository | no, use `dg` |
| Push access | `dg bot allow --push`, `renew`, `suspend`, `resume` | the same page, maintainers |
| The bot's side: its requests and what it was given | `dg bot jobs`, `dg bot read` | no |

## Add a bot

A bot is added like any member, with the Bot role. It accepts first, then the owner adds it:

```sh
dg collab accept <owner>/<repo>                                # as the bot's identity
dg collab add    <owner>/<repo> @ci-bot --role bot             # as the owner
dg ci runner add <owner>/<repo> @ci-bot                        # as the owner, only if it reports check runs
```

The bot needs an **encryption key** on its identity (`dg auth keys add --encryption`) to receive anything members-only: a post key, a read letter or a shared branch. Without one it still works on everything public.

Adding or removing a bot rotates nothing, because it never holds the members key. Once you remove a bot, its members-only posts stop being readable, because they are read only while the bot has a row in the repository.

## Give it access

A member row says a bot exists. Its **access notice** says what it may do. Only maintainers and the owner write one, **everyone can read it**, and a bot with no notice gets nothing.

```sh
dg bot allow <owner>/<repo> @ci-bot --read --members-only-replies \
   --askers writers --threads 42,57 --processor "Example AI" --until 2026-12-31 \
   --note "Triage helper"
dg bot list  <owner>/<repo>                    # each bot's access, as everyone reads it
dg bot revoke <owner>/<repo> @ci-bot           # take it away
```

| Flag (web: the checkbox or field) | What it lets the bot do |
|---|---|
| (on by default; `--no-post` turns it off) | post comments and reviews |
| `--read` | read the issues and pull requests it is asked about, **members-only posts included**, one request at a time |
| `--members-only-replies` | post members-only replies on threads it is asked about |
| `--members-branches` | run checks on members-only branches |
| `--askers writers` or `maintainers` | who may ask it: Write access and up, or maintainers and the owner |
| `--threads 42,57` | only these issue and pull request numbers (default: all) |
| `--processor <service>` | the AI service that processes what it is given. Everyone reads it. |
| `--until YYYY-MM-DD` | when its access ends, through that day, UTC (default: it doesn't) |
| `--note <text>` | a note everyone can read, up to 500 characters |

Each save writes a new notice that replaces the bot's current one, and shows its price first. What everyone then reads is one line, for example: "@ci-bot can post here and read pull requests and issues it's asked about. Asked by writers and maintainers. Processed by Example AI. Until 31 Dec 2026."

You can't give access to the owner or a human member: they read members-only content themselves, and `dg` refuses before signing. **Taking access away is not retroactive:** the bot gets nothing new, but what it was already given stays with it. Change a secret that was in a thread you shared. The notice's rules are in [private-repos.md §22](../security/private-repos.md#22-bot-access-notices-requests-and-read-letters).

## Ask it to work on something

Asking is a request on the thread and, when the bot may read, a **read letter**: a sealed copy of the thread's members-only posts as they are now, which only you and the bot can open.

```sh
dg bot ask <owner>/<repo> @ci-bot "fix the flaky test" --pr 42
dg bot ask <owner>/<repo> @ci-bot "summarise the discussion" --issue 12
```

In the web app, an issue or pull request lists the bots whose access covers it under **Agents**. **Ask @ci-bot** opens a dialog that says what the bot will get and who processes it, then takes the task (1 to 120 characters). The web app shares a thread's posts; **sharing code with the bot needs a clone**, so use `dg bot ask` inside one.

What to know:

- **Everyone sees that you asked**, and which bot. Only members, and the bot, read the task on a members-only thread.
- **A snapshot.** The letter holds each members-only post at the revision you asked on. A comment written, or a post edited, afterwards is not in it.
- **Not everything is shared.** Messages to specific people, and posts saved by older Forge builds that can't be shared one at a time, are never included. A pull request from a fork, or from someone outside the members, never has its members-only content handed to a bot; the bot works on its public side.
- **Who can ask.** Your role must be among the bot's askers, the thread must be covered, and the bot's access must be live. Otherwise `dg` refuses with [E813](../errors.md#e813) before signing, and nothing is sent to the bot.
- **The bot's side.** `dg bot jobs <owner>/<repo>` lists the requests addressed to it, and `dg bot read <owner>/<repo> <job>` shows one thread as it was given (`--public` leaves anything members-only out; `--code <dir>` writes the members-only code it was given).

To run an agent, set up a runner in agents mode: [Self-host a CI runner, Agents](self-host-runner.md#agents). It works only on requests the bot's access allows, runs the agent in a container with no route out except to the AI service the access names, and posts a members-only reply when it read anything members-only.

## Members-only replies

A bot never holds the members key, so it posts members-only issues, comments and reviews under a **post key** that a maintainer sends it. Members read these posts as they read any members-only post; everyone else sees a members-only placeholder.

- A maintainer sends the post key when adding a bot, on every key rotation and on `dg repo keys repair`, but only to a bot whose current access allows members-only replies (`--members-only-replies`). A bot whose access stops allowing it gets no new key at the next rotation, and its members-only posting stops there.
- A bot replies on a members-only thread only through its read letter for that thread. With none, it is refused before anything is signed ([E311](../errors.md#e311)).
- A rotation by an old client that sends no post keys silently stops a bot's members-only posts until a maintainer runs `dg repo keys repair`. Rotate members with an up-to-date Forge.

## Let it push

Push access is given **per branch, for a limited time, and visibly**. A bot with no push access can still push to its own fork and open a pull request.

```sh
dg bot allow  <owner>/<repo> @ci-bot --push                 # prefix bot/ci-bot/ (default)
dg bot allow  <owner>/<repo> @ci-bot --push gh-pages --push-until 2026-11-30
dg bot renew  <owner>/<repo> @ci-bot                        # a new end date, up to 90 days ahead
dg bot suspend <owner>/<repo> @ci-bot                       # stop it pushing at once (any maintainer)
dg bot resume  <owner>/<repo> @ci-bot
dg bot revoke  <owner>/<repo> @ci-bot --push                # only the push access you gave it
```

- **What a grant covers.** Every branch whose name starts with a prefix (`bot/ci-bot/` by default), one branch and any longer name that starts with it (`--push gh-pages` also covers `gh-pages-old`), or one members-only branch that is shared with the bot. A bot **never** pushes to a protected branch. A new repository protects its default branch and every tag; protect any other branch that must not move ([Repository settings](collaborating.md#repository-settings)).
- **How long.** 30 days by default, or at the access's own `--until` when that is sooner, and at most 90 days. `--push-until` sets another date. `dg bot renew` is offered from 14 days before the end.
- **Its rules.** Fast-forward only, and it deletes only branches it pushed itself. `--allow-force` lifts both; `--open-pr-only` lets it push new branches and open pull requests but never update an existing branch.
- **What stays visible.** `dg branch` shows "pushed by @ci-bot (bot)", and `dg repo activity` marks each push. A push that went outside its access is marked as such.
- **Limits.** A private repository has no bot push grants, and a members-key branch ("All members") can never be granted, because a bot never holds the members key. A grant stops working if the maintainer who gave it stops being a maintainer, or if the bot is removed and added again.
- **A refused push** is [E814](../errors.md#e814) before anything is stored or signed.

## What the AI service sees

If a bot is an AI agent, whatever it is **given** is sent to the service its notice names. That is the real exposure, not Forge's encryption: a read letter hands plaintext to the bot, and the agent hands it on. Check these before you give `--read`:

- Name the service in `--processor`; everyone, and whoever asks, reads it.
- A job that read anything members-only posts only members-only replies. A public reply it asks for is refused.
- The runner's agent container reaches only the endpoints you list for that service. The service itself still sees what the agent sends it, and an agent steered by the thread could use other credentials it holds at the same service. Choose the service as you would for any data you send it.
- Don't share a thread that holds a secret. Change one afterwards.

## Errors

| Code | When | What to do |
|---|---|---|
| [E813](../errors.md#e813) | You asked a bot outside its access: no access, ended, your role isn't among its askers, the thread isn't covered, or the thread is members-only and the bot may not read | Ask someone with Write access, or a maintainer to change who can ask it |
| [E814](../errors.md#e814) | A bot's push went outside its push access, or the network has no bot push | `dg bot list` shows where it may push; a maintainer gives or renews it |
| [E311](../errors.md#e311) | A bot has no read letter or post key for what it tried to reply to | Ask again (`dg bot ask`), or a maintainer runs `dg repo keys repair` |

Who can read members-only content, and what a bot's access changes about that: [Who can read what](../security/audiences.md). The design: [private-repos.md §22 to §24](../security/private-repos.md#22-bot-access-notices-requests-and-read-letters).
