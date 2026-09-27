import { Suspense } from 'react'
import { RouteLoading } from '@/components/route-loading'
import { SettingsClient } from './client'

/** `/repo/settings?owner=&name=` — backend, members, Platform details. */
export default function SettingsPage(): JSX.Element {
  return (
    <Suspense fallback={<RouteLoading wide />}>
      <SettingsClient />
    </Suspense>
  )
}
