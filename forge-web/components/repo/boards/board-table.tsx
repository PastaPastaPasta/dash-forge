'use client'

/** The table layout of a board (design `docs/design/boards.md` §4.2). Skeleton: fleshed out next. */

import type { BoardLayoutProps } from './layout-props'

export function BoardTable(props: BoardLayoutProps): JSX.Element {
  return <div data-testid="board-table">{props.items.length} items</div>
}
