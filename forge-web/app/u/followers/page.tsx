import { QueryPage } from '@/components/route-loading'
import { FollowersClient } from './client'

/** `/u/followers?name=` — who follows an identity (an identity id or DPNS name). */
export default function FollowersPage(): JSX.Element {
  return (
    <QueryPage>
      <FollowersClient />
    </QueryPage>
  )
}
