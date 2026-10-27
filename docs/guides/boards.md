# Boards

A board lays a repository's issues and pull requests out in columns (Todo, In progress, Done…), with fields such as priority, estimate and iteration, and saved views. It is Forge's GitHub project, Trello board or Jira board. How boards work, and why, is in the [boards design](../design/boards.md).

- **Who can do what.** Anyone can look at a public repository's boards. Maintainers, writers and triage members move items, set their fields, and add, archive or remove them. Maintainers and writers create, edit, close and delete boards.
- **What shows on a board.** A board's *sources* bring in items by themselves (the new-board templates take every issue and pull request of the repository, or every issue labelled `bug`); members add others by hand, from any repository. Closed and merged items go to the Done column, and leave the board once they have been closed for longer than its auto-archive time (14 days in the templates).
- **What it costs.** Each change is one document. Your first card for an item (an item a source shows on the board has no card until someone moves it) costs about 0.0007 DASH, 0.0009 for the board's first card, and 0.0004 when another member already has a card for it; every later move, field change or archive of it about 0.00005 DASH. A new board costs about 0.0006 DASH, and an edit, close or delete about 0.00005 (measured on a testnet scratch set). Every command shows its price and asks before it spends (`--yes` skips the question).
- **Private repositories.** A private repository's boards and cards are encrypted for its members. The items a card names are not: a card on a private board that names another repository's issue tells everyone that the private repository tracks it, so `dg` asks first.
- **Networks.** Boards need the boards update of the Forge contracts. Until a network has it, every `dg board` command stops with E702.

## From the command line

Name a board by its number (from `dg board list`) or its name. Name an item `#12` (or `12`) in the board's repository, `owner/name#12` in another, and `pr#12` when an issue and a pull request share the number. Inside a clone, the repository can be left out, as with every `dg` command.

```sh
dg board list   <owner>/<repo>                       # --deleted to include deleted boards
dg board create <owner>/<repo> --name Roadmap        # Todo, In progress, Done
dg board create <owner>/<repo> --name Sprints --template sprint
dg board create <owner>/<repo> --name Release --columns "Backlog,Doing,Review,Done"
dg board view   <owner>/<repo> Roadmap               # every column, its items and totals
dg board view   <owner>/<repo> Roadmap --view Table  # as a saved view filters and sorts it
```

`--template` is one of the web's: `kanban` (the default: Todo, In progress and Done, every issue and pull request, Priority, Estimate and a two-week Iteration), `sprint` (Backlog to In review and Done, two-week sprints and estimates), `triage` (issues labelled `bug`, from Needs triage to Fixed, with a Priority) and `empty` (one column, nothing added for you). `--columns` replaces the template's columns; a column named Done takes closed and merged items. Running the same `create` again (the same name and columns) finds the board the first run made instead of making a second one.

`dg board view` prints each column with its items, their fields, the item count, the sum of the first number field (an estimate) and the work-in-progress limit, marked when a column is over it. With an iteration field it ends with the current iteration's progress. `--archived` shows archived items too. With `--json` it prints the board, each column, each item with its column, rank and fields, and `fold`, the placement every Forge client computes ([schema](../schemas/dg/board-view.schema.json)).

Moving and planning:

```sh
dg board move <owner>/<repo> Roadmap #12 "In progress"           # to the bottom
dg board move <owner>/<repo> Roadmap #12 "In progress" --top
dg board move <owner>/<repo> Roadmap #12 Done --before #9        # or --after #9
dg board set  <owner>/<repo> Roadmap #12 priority=P1 estimate=3 iteration=@next
dg board set  <owner>/<repo> Roadmap #12 estimate=               # clear a field
dg board next-iteration <owner>/<repo> Sprints                    # carry unfinished work over
```

`dg board set` takes fields by the names the board gives them: an option's name for a select field, a number, a date (`YYYY-MM-DD` or `@today`), an iteration (`@current`, `@next`, `@previous`, or its number), or text; `status=<column>` moves the item. `dg board next-iteration` moves every open item of the current iteration that is not in the Done column into the next one, one write each, priced together first.

Adding and removing:

```sh
dg board add     <owner>/<repo> Roadmap #12 #15 alice/lib#3 --column Todo
dg board add     <owner>/<repo> Roadmap --title "Login page is slow"   # opens a new issue there
dg board archive <owner>/<repo> Roadmap #4 #7                          # --restore brings them back
dg board remove  <owner>/<repo> Roadmap #9                             # even if a source includes it
dg board close   <owner>/<repo> Roadmap                                # read-only; --reopen
dg board delete  <owner>/<repo> Roadmap
```

A command that changes several items writes them one by one; when one fails, the ones before it have landed, and it stops with E106 saying which. Run it again: items that already have the change cost nothing more.

A card is yours: each member has their own card for an item on a board, and everyone sees the newest. `dg` reads the item's newest card just before it signs and changes only what you asked for, so two members editing different fields of one item both land.
