import { Suspense } from 'react'
import { RouteLoading } from '@/components/route-loading'
import { CommitClient } from './client'

/** `/repo/commit?owner=&name=&oid=` — a single commit + file change set. */
export default function CommitPage(): JSX.Element {
  return (
    <Suspense fallback={<RouteLoading wide />}>
      <CommitClient />
    </Suspense>
  )
}
