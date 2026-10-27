/**
 * What the board page hands each layout (design `docs/design/boards.md` §4): the board shell
 * (`board-page.tsx`) owns loading, the view, the query and the item panel; a layout
 * (`board-kanban.tsx`, `board-table.tsx`, `board-roadmap.tsx`) renders the shown items and asks
 * the shell to write.
 */

import type { BoardHookState } from '@/hooks/use-board'
import type { RepoAddress } from '@/hooks/use-query-param'
import type { LabelDef, RepoRef } from '@/lib/repo'
import type { BoardItem, BoardRow, BoardSpec, BoardView as SavedView, Placement } from '@/lib/rules/boards'

export interface BoardLayoutProps {
  /** The board hook: fold, cards, role (`can`), pending writes and every mutation. */
  readonly state: BoardHookState
  /** The parsed definition the layout renders (never null here: the shell shows errors itself). */
  readonly spec: BoardSpec
  /** The view in force: a saved view, or the URL's unsaved changes over one. */
  readonly view: SavedView
  /** The items the view's query matches, archived ones only when the query asks for them. */
  readonly items: readonly BoardItem[]
  /** The same items with their placements, in the same order (what the view rules take). */
  readonly rows: readonly BoardRow[]
  /** Each shown item's placement, by item id. */
  readonly placements: ReadonlyMap<string, Placement>
  /** Open the item panel (§5.5) on an item. */
  onOpenItem(itemId: string): void
  /**
   * Change the view in force (§4: unsaved changes live in the URL): a layout asks for a sort, a
   * grouping or a roadmap zoom it offers; the shell writes it into the URL. Absent: the layout's
   * controls that would change the view are read-only.
   */
  onViewChange?(change: Partial<SavedView>): void
  /**
   * The board's home repository (as the page holds it, with its session when private): quick add
   * creates issues and resolves `#12` here. Absent: the layout offers no quick add.
   */
  readonly home?: RepoRef
  /** The page's repo address, for links to an item's own page (`repoHref`). */
  readonly addr?: RepoAddress
  /** The home repository's label definitions by name (chip colours); absent or unknown: the neutral chip. */
  readonly labels?: ReadonlyMap<string, LabelDef>
}
