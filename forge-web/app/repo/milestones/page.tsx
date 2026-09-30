import { QueryPage } from '@/components/route-loading'
import { MilestonesClient } from './client'

/** `/repo/milestones?owner=&name=` — the repo's milestones: open / closed, progress, create, edit, close, delete (QW-019). */
export default function MilestonesPage(): JSX.Element {
  return (
    <QueryPage wide>
      <MilestonesClient />
    </QueryPage>
  )
}
