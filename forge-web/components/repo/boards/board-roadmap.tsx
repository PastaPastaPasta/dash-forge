'use client'

/** The roadmap layout of a board (design `docs/design/boards.md` §4.3). Skeleton: fleshed out next. */

import type { BoardLayoutProps } from './layout-props'

export function BoardRoadmap(props: BoardLayoutProps): JSX.Element {
  return <div data-testid="board-roadmap">{props.items.length} items</div>
}
