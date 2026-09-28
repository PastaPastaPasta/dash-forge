import { QueryPage } from '@/components/route-loading'
import { TreeClient } from './client'

/** `/repo/tree?owner=&name=&path=` — a directory listing at any path. */
export default function TreePage(): JSX.Element {
  return (
    <QueryPage wide>
      <TreeClient />
    </QueryPage>
  )
}
