import { QueryPage } from '@/components/route-loading'
import { RefActivityClient } from './client'

/** `/repo/activity?owner=&name=&branch=` (or `&tag=`) — one branch's or tag's activity. */
export default function RefActivityPage(): JSX.Element {
  return (
    <QueryPage wide>
      <RefActivityClient />
    </QueryPage>
  )
}
