import { Suspense } from 'react'
import { RouteLoading } from '@/components/route-loading'
import { RepoHomeClient } from './client'

/** `/repo?owner=&name=` — repo home (code tab). Static shell; hydrates to live browse reads. */
export default function RepoPage(): JSX.Element {
  return (
    <Suspense fallback={<RouteLoading wide />}>
      <RepoHomeClient />
    </Suspense>
  )
}
