import { Suspense } from 'react'
import { RouteLoading } from '@/components/route-loading'
import { ExploreClient } from './client'

/** `/explore[?q=]` — search repos by name, most starred, recently updated, recent, and "mine". */
export default function ExplorePage(): JSX.Element {
  return (
    <Suspense fallback={<RouteLoading wide />}>
      <ExploreClient />
    </Suspense>
  )
}
