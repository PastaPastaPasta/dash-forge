import { QueryPage } from '@/components/route-loading'
import { ReleasesClient } from './client'

/** `/repo/releases?owner=&name=` — the newest release per tag, with previous revisions. */
export default function ReleasesPage(): JSX.Element {
  return (
    <QueryPage wide>
      <ReleasesClient />
    </QueryPage>
  )
}
