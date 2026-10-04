import { QueryPage } from '@/components/route-loading'
import { FollowersClient } from './client'

/** `/u/followers?id=` (or `?name=`, a DPNS name) — who follows an identity. */
export default function FollowersPage(): JSX.Element {
  return (
    <QueryPage>
      <FollowersClient />
    </QueryPage>
  )
}
