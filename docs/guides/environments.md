# Environments

Keep configuration and secrets for each environment (`dev`, `staging`, `production`, any name) next to the repository, encrypted for the people who should read them, and out of git. Run your code with them injected (`dg env run`), or write a `.env` file that git ignores (`dg env export -o .env`).

1. [Who can read an environment](#who-can-read-an-environment)
2. [Commands](#commands)
3. [Changing an environment](#changing-an-environment)
4. [When two people change it at once](#when-two-people-change-it-at-once)
5. [Removing a member](#removing-a-member)
6. [What is public](#what-is-public)
7. [Limits](#limits)

---

## Who can read an environment

Each environment has one of two audiences.

| Audience | Who reads it | Default for |
|---|---|---|
| **Maintainers** | The repository's maintainers when each change is saved. A maintainer added later reads the environment from the next change on. | `production`, names starting with `prod`, `staging`, and names starting with `release` |
| **Members** | Every member who holds the repository's members key: maintainers, writers, triage members and readers, now and in the future. | every other name |

Readers, CI runners made members, and future members can read every value stored in a Members environment, including past values. Keep production credentials in a Maintainers environment.

Access is granted, not logged. Nobody can tell who read a value.

A Members environment needs members-only content turned on for the repository (`dg repo members enable <owner>/<repo>`, by a maintainer). A private repository always has it. A Maintainers environment works in any repository, but each maintainer needs an encryption key on their identity ([Identity and keys](identity-and-keys.md)). A maintainer without one is left out, and the command says so before it saves.

Choose the audience with `--audience maintainers` or `--audience members` when you first save an environment. A later change keeps it unless you pass `--audience` again.

## Commands

Inside a clone of the repository you can leave out `<owner>/<repo>`.

```sh
dg env ls      <owner>/<repo>                         # the environments: audience, entries, last change
dg env ls      <owner>/<repo> --env production        # one environment's entries; values are never shown
dg env get     <owner>/<repo> DB_URL --env production # one value, to stdout
dg env set     <owner>/<repo> LOG_LEVEL=info --env dev
dg env set     <owner>/<repo> STRIPE_KEY DB_URL --env production --secret   # asks for each value, hidden
dg env unset   <owner>/<repo> OLD_FLAG --env dev
dg env edit    <owner>/<repo> --env dev               # the whole environment in your editor
dg env import  <owner>/<repo> .env --env dev          # a .env file, as one change
dg env run     <owner>/<repo> --env dev -- npm test   # the values go to the command only
dg env export  <owner>/<repo> --env dev -o .env       # a file only you can read, ignored by git
dg env export  <owner>/<repo> --env dev | ./deploy    # .env text on stdout, for piping
dg env history <owner>/<repo> --env production        # who changed what, and when
```

- `set` takes several names at once and saves them as one change. A value on the command line can be seen by other users of your computer, so give the name alone to be asked for the value, or pipe it in: `printf %s "$TOKEN" | dg env set API_TOKEN --env dev`.
- `--secret` marks entries as secrets. Every value is encrypted either way. The type tells Forge what to mask by default.
- `run` adds the values to the command's environment variables and writes nothing to disk. Its exit code is the command's. An environment that sets `PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_*`, `BASH_ENV`, `ENV` or `NODE_OPTIONS` changes which program runs or what it loads, so `run` refuses it unless you pass `--allow-env-override`.
- `export -o` first adds the file to `.git/info/exclude` and checks with `git check-ignore` that git ignores it, then creates it with mode 0600. It refuses a file git already tracks, a path a `.gitignore` rule un-ignores, and an existing file unless you pass `--force` (which replaces a symlink rather than writing through it). The text quotes values so that `source .env` in a shell never runs anything inside them.
- `edit` opens `$VISUAL` or `$EDITOR` on a temporary file only you can read, and removes it afterwards, also when the terminal closes. Your editor may keep its own swap or backup copies elsewhere. Ctrl-C goes to the editor. Delete a line to remove an entry.
- Every command takes `--json`.

## Changing an environment

Only maintainers change environments. Anyone else, writers included, is refused before anything is signed:

```
error: change production: only maintainers can change environments      [E601]
```

Each change saves the whole environment again, encrypted for its audience, and records which change it replaces. Before it saves, `dg` shows who will be able to read it and the cost, about 0.0025 DASH (one chunk and one record on Dash Platform, measured on devnet sakura), and asks you to confirm.

Forge counts a change only when its author is a current maintainer. A change by anyone else is ignored by every reader, `dg env run` included, even though Platform lets a writer store it. That includes a former maintainer's changes, from the moment they stop being one. When such a change claims to replace an environment's latest version, `dg env ls`, `get`, `run` and `export` keep using the latest version by a maintainer and say so in one line:

```
warning: production has a newer change by someone who isn't a maintainer now; it was ignored. Ask a maintainer to check production's values.
```

`dg env ls` shows who saved the version in use and when.

## When two people change it at once

Two maintainers who change the same environment at the same time leave two versions. Forge never merges them. Until a maintainer keeps one, `dg env run`, `get` and `export` refuse and name both versions:

```
error: 2 people changed production at the same time, so its values can't be used until one version is kept [E608]
  cause: production in alice/shop has 2 latest versions, never merged automatically: 8V2UnsMbU1 by <maintainer> at 2026-10-05 08:36 UTC, and ByFFj1bXro by <maintainer> at 2026-10-05 08:36 UTC
  fix:   a maintainer keeps one: `dg env edit --env production --keep 8V2UnsMbU1` (or `dg env set … --keep <id>`)
  or:    `dg env history --env production` shows what each changed
```

`dg env history --env production` shows what each version changed. Keep one with `--keep <id>` on `edit`, `set`, `unset` or `import`: the new change starts from that version and replaces both.

## Removing a member

`dg collab remove` lists the environments the member could read and the names of the current values they could see, so you know what to rotate at its source (the database password at the database, the API key at its provider):

```
Removed <identity> (writer) from alice/shop.
<identity> could read 2 dev values (and every past value of it). Rotate them at the source: API_TOKEN, API_URL
```

Removing someone stops them reading changes saved afterwards. It cannot take back what they could already read.

When you remove a maintainer, their changes stop counting, so an environment whose latest version they saved would go back to the version before it. `dg collab remove` shows, for each such environment, what their latest change did (entry names only, values hidden) and the cost, and asks you to confirm. After the removal it saves those values again as you, one change each, unless someone changed the environment in the meantime. If you can't read one of them, it says so: ask a maintainer who can to save it again. A maintainer removed some other way (an older Forge build, for example) leaves their environments at the version before their last change, and readers see the warning above.

The list also notes how many environments you can't read yourself: the removed member may have been able to read values there.

## What is public

Anyone can see that a repository has environments, how many, and for each change its author, its time and its size (rounded up to 512 bytes). For a Maintainers environment they can also see how many people it was sent to.

Nobody outside the audience can see an environment's name, its entries' names, types or notes, or any value.

## Limits

- An environment holds up to about 12 KB of names, values and notes.
- A Maintainers environment goes to at most 16 maintainers. Use Members for a larger team.
- Names: an environment is 1 to 64 letters, digits, `.`, `_` or `-`. An entry is letters, digits and `_`, not starting with a digit.
- Using environments in CI workflows is **Coming soon**. Until then, `dg env run` on a machine whose identity can read the environment covers a deploy script.
