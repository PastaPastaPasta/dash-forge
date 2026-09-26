import { Suspense } from 'react'
import { RouteLoading } from '@/components/route-loading'
import { ReleasesClient } from './client'

/** `/repo/releases?owner=&name=` — the newest release per tag, with previous revisions. */
export default function ReleasesPage(): JSX.Element {
  return (
    <Suspense fallback={<RouteLoading wide />}>
      <ReleasesClient />
    </Suspense>
  )
}
