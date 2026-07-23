import { Suspense } from 'react'
import { RouteLoading } from '@/components/route-loading'
import { BlobClient } from './client'

/** `/repo/blob?owner=&name=&path=` — a single file view (browse-plane blob reconstruction). */
export default function BlobPage(): JSX.Element {
  return (
    <Suspense fallback={<RouteLoading wide />}>
      <BlobClient />
    </Suspense>
  )
}
