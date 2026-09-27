import { Suspense } from 'react'
import { RouteLoading } from '@/components/route-loading'
import { NewPullClient } from './client'

/** `/repo/pulls/new?owner=&name=[&base=&head=]` — open a pull request. */
export default function NewPullPage(): JSX.Element {
  return (
    <Suspense fallback={<RouteLoading wide />}>
      <NewPullClient />
    </Suspense>
  )
}
