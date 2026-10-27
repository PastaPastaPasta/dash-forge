import { QueryPage } from '@/components/route-loading'
import { BoardsClient } from './client'

/** `/repo/boards?owner=&name=` — the repo's boards: open / closed, and New board for maintainers and writers (`docs/design/boards.md`). */
export default function BoardsPage(): JSX.Element {
  return (
    <QueryPage wide>
      <BoardsClient />
    </QueryPage>
  )
}
