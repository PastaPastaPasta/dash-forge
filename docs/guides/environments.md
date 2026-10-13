# Environments

Keep configuration and secrets for each environment (`dev`, `staging`, `production`, any name) next to the repository, encrypted for the people who should read them, and out of git. Run your code with them injected (`dg env run`), or write a `.env` file that git ignores (`dg env export -o .env`).

1. [Who can read an environment](#who-can-read-an-environment)
2. [Commands](#commands)
3. [In the web app](#in-the-web-app)
4. [Changing an environment](#changing-an-environment)
5. [When two people change it at once](#when-two-people-change-it-at-once)
6. [Changing members](#changing-members)
7. [Removing a member](#removing-a-member)
8. [What is public](#what-is-public)
9. [Limits](#limits)

---

## Who can read an environment

Every environment has one audience, which you choose when you first save it. There is no default.

| Audience | `--audience` | Who reads it |
|---|---|---|
| **Maintainers** | `maintainers` | The repository's owner and maintainers. |
| **Writers and maintainers** | `writers` | Plus the members with Write access. |
| **All members** | `members` | Every member: maintainers, writers, triage members and readers. Never bots. |
| **Specific people** | `people --to @alice,@bob` | Only the people you list, members or not. You're always included. |

Add people beside a group with `--also`, for example a CI bot: `--audience writers --also @ci-bot`. An environment can be shared with at most 64 people.

Each change is encrypted for the people the audience covers **when it is saved**, each with their own encryption key. People who join a group later get the current values when the environment is saved again, never earlier ones. Forge saves the environments a role change affects for you (see [Changing members](#changing-members)). People removed keep what they could read; you get a list of values to change.

Access is granted, not logged. Nobody can tell who read a value.

Every reader needs an encryption key on their identity ([Identity and keys](identity-and-keys.md)). Someone without one is left out, and the command says so before it saves.

A first save without an audience is refused before anything is signed:

```
error: choose who can read environment production                      [E611]
  fix:   dg env set … --env production --audience maintainers   # or writers, members, people --to @a,@b
```

Later changes keep the audience. Change it with `dg env audience --env production --set writers`, which saves the environment again for the new people. Earlier versions stay readable by whoever could read them.

### Environments saved in the old format

Before October 2026, Forge saved Members environments under the repository's members key. Anyone who joins later can read the values saved that way, past values included. Such an environment shows:

```
Saved in the old format: anyone who joins later can read the values saved this way. Save it again, then change those values where they're used.
```

`dg env resave --all` saves every such environment again for All members, in the new format. That doesn't take back what joiners could already read, so change those values where they're used (and in the environment), then record it with `dg env mark-changed --env <name>`. Until every old value is marked, the environment keeps a shorter note listing the names.

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
dg env audience <owner>/<repo> --env ci --set writers --also @ci-bot   # change who can read it
dg env share   <owner>/<repo> --env ci @ci-bot        # give one more person access
dg env unshare <owner>/<repo> --env ci @ci-bot        # take it away, and list what to change
dg env resave  <owner>/<repo> --all                   # save again for everyone the audience covers now
dg env mark-changed <owner>/<repo> --env dev          # old-format values were changed where they're used
```

- `set` takes several names at once and saves them as one change. A value on the command line can be seen by other users of your computer, so give the name alone to be asked for the value, or pipe it in: `printf %s "$TOKEN" | dg env set API_TOKEN --env dev`.
- `--secret` marks entries as secrets. Every value is encrypted either way. The type tells Forge what to mask by default.
- `run` adds the values to the command's environment variables and writes nothing to disk. Its exit code is the command's. It refuses, unless you pass `--allow-env-override`, an entry that replaces a variable already set in your shell, and any entry that changes which program runs or what it loads: `PATH`, `HOME`, `XDG_CONFIG_HOME`, `BASH_ENV`, `ENV`, `ZDOTDIR`, `SHELLOPTS`, `PS4`, `NODE_OPTIONS`, `NODE_PATH`, `PYTHONPATH`, `PYTHONHOME`, `PERL5OPT`, `PERL5LIB`, `RUBYOPT`, `RUBYLIB`, `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`, `JDK_JAVA_OPTIONS`, `RUSTC_WRAPPER`, `SHELL`, and names starting with `LD_`, `DYLD_`, `GIT_` or `npm_config_` (on Windows, in any letter case).
- `export -o` first adds the file to `.git/info/exclude` and checks with `git check-ignore` that git ignores it, then creates it with mode 0600. It refuses a file git already tracks (also one whose name differs only in letter case), a path a `.gitignore` rule un-ignores, a folder inside a git work tree where git can't run, and an existing file unless you pass `--force` (which replaces a symlink rather than writing through it). The text quotes values so that `source .env` in a shell never runs anything inside them.
- `edit` opens `$VISUAL` or `$EDITOR` on a temporary file only you can read, and removes it afterwards, also when the terminal closes. Your editor may keep its own swap or backup copies elsewhere. Ctrl-C goes to the editor while it is open. Delete a line to remove an entry. Closing the editor without a change saves nothing.
- Every command takes `--json`.

## In the web app

The repository's **Settings → Environments** page shows the environments you can read. A maintainer whose tab holds their encryption key also changes them there, as `dg env` does; anyone else reads only.

- **New environment** asks for a name, who can read it and its values. Nothing is selected and **Save** stays disabled until you choose one: Maintainers, Writers and maintainers, All members (each with how many people it is now), or Specific people… (you are always included). **Also give access to…** adds people beside a group, such as a CI bot. A group over 64 people is refused: "All members is 80 people. An environment can be shared with at most 64. Choose a smaller group or specific people."
- **Edit values** adds, changes and removes entries. A saved value never appears in a field: leave it empty to keep it, type to replace it. **Import a .env file** reads the file in your browser only (the same format `dg env import` reads) and fills in the entries; nothing is saved until you save.
- **Change who can read this** saves it again for the people you choose. Earlier versions stay readable by whoever could read them.
- **Save it again** appears where an environment misses someone or is in the old format, and **Mark changed** where values from old-format versions are still to be changed. On a conflict, **Keep this version** keeps one.
- Every change shows what it saves, for whom ("Save production for Maintainers, sent to 3 people (~ DB_URL)?") and its cost before anything is signed.

- Each environment shows its audience, the people it was sent to, its entries and who saved the version in use, and when. An environment saved in the old format shows the note above. Values are hidden. The eye button shows one value at a time (showing another hides it), on this page only: it isn't stored or logged, and it's hidden again when you leave the page or switch to another tab.
- Environments you can't read are only counted: "2 environments", or "1 more environment you can't read" below the ones you can, with "An environment in this repo hasn't been shared with you. If you should have access, ask a maintainer to save it again." Maintainers see exactly who is missing: "dana is a writer, but staging hasn't been saved since."
- Environments open with your encryption key (old-format ones with the repository's members key), which your tab holds once it's unlocked. After a reload, unlock the tab to read them.
- An ignored change and two versions saved at once show the same warning and versions as `dg`, with the commands to keep one. The page also says how many changes by people who aren't maintainers now were ignored.

## Changing an environment

Only maintainers change environments. Anyone else, writers included, is refused before anything is signed:

```
error: change production: only maintainers can change environments      [E601]
```

Each change saves the whole environment again, encrypted for the people its audience covers then, and records which change it replaces. Before it saves, `dg` shows who will be able to read it and the cost, about 0.0025 DASH (one chunk and one record on Dash Platform, measured on devnet sakura), and asks you to confirm.

Forge counts a change only when its author is a current maintainer. A change by anyone else is ignored by every reader, `dg env run` included, even though Platform lets a writer store it. That includes a former maintainer's changes, from the moment they stop being one. When such a change claims to replace an environment's latest version, `dg env ls`, `get`, `run` and `export` keep using the latest version by a maintainer and say so in one line, naming the ignored change:

```
warning: production has a newer change by <identity> at 2026-10-05 08:41 UTC (3kQx7pWm2v), who isn't a maintainer now; it was ignored. Ask a maintainer to check production's values.
```

`dg env ls` shows who saved the version in use and when. `dg env history` lists ignored changes too, marked `ignored: not a maintainer now, never used`.

## When two people change it at once

Two maintainers who change the same environment at the same time leave two versions. Forge never merges them. Until a maintainer keeps one, `dg env run`, `get` and `export` refuse and name every version:

```
error: 2 people changed production at the same time, so its values can't be used until a maintainer keeps one [E608]
  cause: production in alice/shop has 2 latest versions (they were made from the same version, and versions are never merged automatically): 8V2UnsMbU1 by <maintainer> at 2026-10-05 08:36 UTC, ByFFj1bXro by <maintainer> at 2026-10-05 08:36 UTC
  fix:   compare them with `dg env history --env production`, then a maintainer keeps one: `dg env edit --env production --keep <id>`
```

`dg env history --env production` shows what each version changed. Keep one with `--keep <id>` on `edit`, `set`, `unset` or `import`: the new change starts from that version and replaces every latest version. Versions that share no earlier version (two first versions saved at once, for example) are reported as separate histories, and are kept the same way.

## Changing members

A role change can change who an environment's group covers: adding a reader widens All members, adding a writer widens Writers and maintainers and All members, making someone a maintainer widens Maintainers, and removing someone narrows every group they were in. `dg collab add` and `dg collab remove` work out which environments change, show them with the people added or removed and the cost (about 0.002 DASH each), and save them again as you, in the same command, after the role change lands:

```
  staging: Writers and maintainers, +<dana>
  ci: Writers and maintainers + 1 more, +<dana>
Add <dana> as a writer of alice/shop? (one membership document, …) Then 2 environments are saved again for the people their audiences cover (…).
```

An environment you can't read is listed as "not updated: ask <who saved it>". A maintainer who can read it saves it with `dg env resave --env <name>`. `dg env ls` shows maintainers every environment that needs saving again, and why: someone joined its group, left it, or changed their encryption key since. `dg env resave --all` saves them all.

## Removing a member

`dg collab remove` saves the environments the member could read again without them (their group's, and any that names them in `--also` or Specific people), and lists the current values they could see, so you know what to change where it's used (the database password at the database, the API key at its provider):

```
Removed <identity>'s Write access to alice/shop.
<identity> could read 2 dev values. Change them where they're used: API_TOKEN, API_URL
```

Removing someone stops them reading changes saved afterwards. It cannot take back what they could already read. Environments you can't open may name them too: the command says so and who to ask. `dg env unshare` does the same for one environment and one person.

When you remove a maintainer, their changes stop counting. Before it asks you to confirm, `dg collab remove` works out what each environment would look like without them and lists every environment that would change: one whose latest version they saved would go back to the version before it, and one with versions saved at the same time would lose theirs. For each it shows what their change did (entry names only, values hidden) and the cost. After the removal it saves those environments again as you, one change each, so they stay as they were. `dg env history` shows such a change as `saved again for <identity>`.

The saves have their own confirmation, so you can remove the member and decline them. `--no-resave` skips them without asking. The removed member can then still read those environments' current values until someone saves them again (`dg env resave --all`).

A save is skipped when someone changed that environment in the meantime. A maintainer removed some other way (an older Forge build, for example) leaves their environments at the version before their last change, and readers see the warning above.

### Making someone a maintainer

Changes saved by someone who wasn't a maintainer are ignored, but they stay on Platform. If that person becomes a maintainer, those changes start counting and could replace the values in use. `dg collab add --role maintainer` checks for this first. For every environment that would change it saves the current values again as you, naming their earlier changes as replaced, before it grants the role. Before its question, the confirmation lists those environments and the cost of saving them. An environment that only they saved, which nobody could use before, is listed as one that appears once they are a maintainer.

### On the web

**Settings → Members** takes the same steps. Adding, removing, promoting or demoting someone shows, in the confirmation and before anything is signed, which environments are saved again, for whom, and the cost: "Adding dana as a writer gives them access to 2 environments: staging, ci. Saving them again costs about 0.004 DASH." The button then reads **Save and add** (or change, or remove). Environments you can't open are listed with who to ask. A removal lists the values the member could read; afterwards each environment has **Mark changed**, which opens it with those values to replace, and drops off the list once they're changed.

The web needs your encryption key, unlocked in the tab, to make a member change in a repository with environments; without it the change is refused before anything is signed. If a change fails part way (the membership saved, the key share refused), the environments it planned are saved for the members as they are, and Settings → Environments lists anything still to save.

## What is public

Anyone can see that a repository has environments, how many, and for each change its author, its time, its size (rounded up to 512 bytes) and how many people it was sent to.

Nobody outside the audience can see an environment's name, who it is for, its entries' names, types or notes, or any value.

## Limits

- An environment holds up to about 12 KB of names, values and notes. Shared with more than about 50 people, somewhat less: a save that doesn't fit is refused before anything is signed.
- An environment can be shared with at most 64 people. "All members is 80 people" is refused: choose a smaller group or specific people.
- Names: an environment is 1 to 64 letters, digits, `.`, `_` or `-`. An entry is letters, digits and `_`, not starting with a digit.
- Using environments in CI workflows is **Coming soon**. Until then, `dg env run` on a machine whose identity can read the environment covers a deploy script.
