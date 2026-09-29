import { QueryPage } from '@/components/route-loading'
import { NumberClient } from './client'

/** `/repo/number?owner=&name=&number=` — a `#n` autolink: opens issue n or PR n, whichever exists. */
export default function NumberPage(): JSX.Element {
  return (
    <QueryPage wide>
      <NumberClient />
    </QueryPage>
  )
}
