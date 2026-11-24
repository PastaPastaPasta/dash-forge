import { QueryPage } from '@/components/route-loading'
import { OrgClient } from './client'

/** `/org` — connected organizations and connect flow; `/org?id=` one organization's requests, repos and members. */
export default function OrgPage(): JSX.Element {
  return (
    <QueryPage>
      <OrgClient />
    </QueryPage>
  )
}
