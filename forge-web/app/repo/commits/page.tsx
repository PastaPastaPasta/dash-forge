import { QueryPage } from '@/components/route-loading'
import { CommitsClient } from './client'

/** `/repo/commits?owner=&name=` — the first-parent commit log. */
export default function CommitsPage(): JSX.Element {
  return (
    <QueryPage wide>
      <CommitsClient />
    </QueryPage>
  )
}
