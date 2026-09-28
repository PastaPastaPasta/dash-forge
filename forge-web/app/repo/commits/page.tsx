import { QueryPage } from '@/components/route-loading'
import { CommitsClient } from './client'

/** `/repo/commits?owner=&name=[&ref=][&path=]` — the first-parent commit log, or a path's History. */
export default function CommitsPage(): JSX.Element {
  return (
    <QueryPage wide>
      <CommitsClient />
    </QueryPage>
  )
}
