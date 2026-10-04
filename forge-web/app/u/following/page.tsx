import { QueryPage } from '@/components/route-loading'
import { FollowingClient } from './client'

/** `/u/following?id=` (or `?name=`, a DPNS name) — whom an identity follows. */
export default function FollowingPage(): JSX.Element {
  return (
    <QueryPage>
      <FollowingClient />
    </QueryPage>
  )
}
