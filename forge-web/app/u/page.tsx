import { Suspense } from 'react'
import { RouteLoading } from '@/components/route-loading'
import { ProfileClient } from './client'

/** `/u?name=` — identity profile (repos, followers, follow). `name` is an identity id. */
export default function ProfilePage(): JSX.Element {
  return (
    <Suspense fallback={<RouteLoading />}>
      <ProfileClient />
    </Suspense>
  )
}
