import { QueryPage } from '@/components/route-loading'
import { BoardClient } from './client'

/** `/repo/board?owner=&name=&b=<key>` — one board: its views, filter, cards and item panel (`docs/design/boards.md` §4, §5). */
export default function BoardRoute(): JSX.Element {
  return (
    <QueryPage wide>
      <BoardClient />
    </QueryPage>
  )
}
