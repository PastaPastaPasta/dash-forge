import { Suspense } from 'react'
import { RouteLoading } from '@/components/route-loading'
import { StargazersClient } from './client'

/** `/repo/stargazers?owner=&name=` — who starred this repo. */
export default function StargazersPage(): JSX.Element {
  return (
    <Suspense fallback={<RouteLoading wide />}>
      <StargazersClient />
    </Suspense>
  )
}
