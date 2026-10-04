import { QueryPage } from '@/components/route-loading'
import { SearchClient } from './client'

/** `/repo/search?owner=&name=[&query=][&ref=]` — search the code of a ref, in this browser. */
export default function SearchPage(): JSX.Element {
  return (
    <QueryPage wide>
      <SearchClient />
    </QueryPage>
  )
}
