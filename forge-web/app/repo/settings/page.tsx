import { QueryPage } from '@/components/route-loading'
import { SettingsClient } from './client'

/** `/repo/settings?owner=&name=` — backend, members, Platform details. */
export default function SettingsPage(): JSX.Element {
  return (
    <QueryPage wide>
      <SettingsClient />
    </QueryPage>
  )
}
