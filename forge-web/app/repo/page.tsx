import { QueryPage } from '@/components/route-loading'
import { RepoHomeClient } from './client'

/** `/repo?owner=&name=` — repo home (code tab). Static shell; hydrates to live browse reads. */
export default function RepoPage(): JSX.Element {
  return (
    <QueryPage wide>
      <RepoHomeClient />
    </QueryPage>
  )
}
