import { Suspense } from 'react'
import { RouteLoading } from '@/components/route-loading'
import { BranchesClient } from './client'

/** `/repo/branches?owner=&name=` — the branch list with tip oids. */
export default function BranchesPage(): JSX.Element {
  return (
    <Suspense fallback={<RouteLoading wide />}>
      <BranchesClient />
    </Suspense>
  )
}
