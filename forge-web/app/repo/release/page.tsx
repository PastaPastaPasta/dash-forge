import { Suspense } from 'react'
import { RouteLoading } from '@/components/route-loading'
import { ReleaseClient } from './client'

/** `/repo/release?owner=&name=&tag=` — one release, its assets and previous revisions. */
export default function ReleasePage(): JSX.Element {
  return (
    <Suspense fallback={<RouteLoading wide />}>
      <ReleaseClient />
    </Suspense>
  )
}
