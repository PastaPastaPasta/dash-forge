import { QueryPage } from '@/components/route-loading'
import { BoardSettingsClient } from './client'

/** `/repo/board/settings?owner=&name=&b=` — a board's settings: columns, fields, sources, views, close and delete (`docs/design/boards.md`). */
export default function BoardSettingsPage(): JSX.Element {
  return (
    <QueryPage wide>
      <BoardSettingsClient />
    </QueryPage>
  )
}
