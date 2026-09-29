import { QueryPage } from '@/components/route-loading'
import { CompareClient } from './client'

/** `/repo/compare?owner=&name=&base=&head=` — what `head` has that `base` does not (branches, tags or commits). */
export default function ComparePage(): JSX.Element {
  return (
    <QueryPage wide>
      <CompareClient />
    </QueryPage>
  )
}
