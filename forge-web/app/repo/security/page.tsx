import { QueryPage } from '@/components/route-loading'
import { SecurityClient } from './client'

/** `/repo/security?owner=&name=` — the repo's security policy, its default branch's SECURITY.md (D37). */
export default function SecurityPage(): JSX.Element {
  return (
    <QueryPage wide>
      <SecurityClient />
    </QueryPage>
  )
}
