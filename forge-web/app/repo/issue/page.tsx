import { Suspense } from 'react'
import { RouteLoading } from '@/components/route-loading'
import { IssueClient } from './client'

/** `/repo/issue?owner=&name=&number=` — issue detail, timeline, comment, close/reopen. */
export default function IssuePage(): JSX.Element {
  return (
    <Suspense fallback={<RouteLoading wide />}>
      <IssueClient />
    </Suspense>
  )
}
