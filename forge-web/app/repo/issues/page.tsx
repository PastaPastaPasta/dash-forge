import { QueryPage } from '@/components/route-loading'
import { IssuesClient } from './client'

/** `/repo/issues?owner=&name=` — issue list, filter, and compose. */
export default function IssuesPage(): JSX.Element {
  return (
    <QueryPage wide>
      <IssuesClient />
    </QueryPage>
  )
}
