import { Suspense } from 'react'
import { RouteLoading } from '@/components/route-loading'
import { PullsClient } from './client'

/** `/repo/pulls?owner=&name=` — the patch (PR) list. */
export default function PullsPage(): JSX.Element {
  return (
    <Suspense fallback={<RouteLoading wide />}>
      <PullsClient />
    </Suspense>
  )
}
