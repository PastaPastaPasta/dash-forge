import { QueryPage } from '@/components/route-loading'
import { CommitClient } from './client'

/** `/repo/commit?owner=&name=&oid=` — a single commit + file change set. */
export default function CommitPage(): JSX.Element {
  return (
    <QueryPage wide>
      <CommitClient />
    </QueryPage>
  )
}
