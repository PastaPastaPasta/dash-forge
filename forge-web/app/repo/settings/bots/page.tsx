import { QueryPage } from '@/components/route-loading'
import { BotsClient } from './client'

/** `/repo/settings/bots?owner=&name=`: Settings → Bots and runners (what each bot may do here, and the runners). */
export default function BotsPage(): JSX.Element {
  return (
    <QueryPage wide>
      <BotsClient />
    </QueryPage>
  )
}
