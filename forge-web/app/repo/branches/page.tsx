import { QueryPage } from '@/components/route-loading'
import { BranchesClient } from './client'

/** `/repo/branches?owner=&name=` — the branch list with tip oids. */
export default function BranchesPage(): JSX.Element {
  return (
    <QueryPage wide>
      <BranchesClient />
    </QueryPage>
  )
}
