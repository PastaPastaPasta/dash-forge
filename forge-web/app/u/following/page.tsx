import { Suspense } from 'react'
import { RouteLoading } from '@/components/route-loading'
import { FollowingClient } from './client'

/** `/u/following?name=` — whom an identity follows (an identity id or DPNS name). */
export default function FollowingPage(): JSX.Element {
  return (
    <Suspense fallback={<RouteLoading />}>
      <FollowingClient />
    </Suspense>
  )
}
