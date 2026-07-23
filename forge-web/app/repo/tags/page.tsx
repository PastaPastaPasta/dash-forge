import { Suspense } from 'react'
import { RouteLoading } from '@/components/route-loading'
import { TagsClient } from './client'

/** `/repo/tags?owner=&name=` — the tag list with tip oids. */
export default function TagsPage(): JSX.Element {
  return (
    <Suspense fallback={<RouteLoading wide />}>
      <TagsClient />
    </Suspense>
  )
}
