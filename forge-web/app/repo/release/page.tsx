import { QueryPage } from '@/components/route-loading'
import { ReleaseClient } from './client'

/** `/repo/release?owner=&name=&tag=` — one release, its assets and previous revisions. */
export default function ReleasePage(): JSX.Element {
  return (
    <QueryPage wide>
      <ReleaseClient />
    </QueryPage>
  )
}
