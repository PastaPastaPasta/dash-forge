import { QueryPage } from '@/components/route-loading'
import { IssueClient } from './client'

/** `/repo/issue?owner=&name=&number=` — issue detail, timeline, comment, close/reopen. */
export default function IssuePage(): JSX.Element {
  return (
    <QueryPage wide>
      <IssueClient />
    </QueryPage>
  )
}
