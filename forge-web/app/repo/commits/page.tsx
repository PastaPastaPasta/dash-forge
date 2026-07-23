import { Suspense } from 'react'
import { RouteLoading } from '@/components/route-loading'
import { CommitsClient } from './client'

/** `/repo/commits?owner=&name=` — the first-parent commit log. */
export default function CommitsPage(): JSX.Element {
  return (
    <Suspense fallback={<RouteLoading wide />}>
      <CommitsClient />
    </Suspense>
  )
}
