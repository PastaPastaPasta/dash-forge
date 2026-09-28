import { QueryPage } from '@/components/route-loading'
import { PullClient } from './client'

/** `/repo/pull?owner=&name=&number=` — PR detail, review, merge/close/reopen. */
export default function PullPage(): JSX.Element {
  return (
    <QueryPage wide>
      <PullClient />
    </QueryPage>
  )
}
