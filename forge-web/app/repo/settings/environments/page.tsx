import { QueryPage } from '@/components/route-loading'
import { EnvironmentsClient } from './client'

/** `/repo/settings/environments?owner=&name=`: Settings → Environments (read-only; `dg env` changes them). */
export default function EnvironmentsPage(): JSX.Element {
  return (
    <QueryPage wide>
      <EnvironmentsClient />
    </QueryPage>
  )
}
