import { QueryPage } from '@/components/route-loading'
import { StargazersClient } from './client'

/** `/repo/stargazers?owner=&name=` — who starred this repo. */
export default function StargazersPage(): JSX.Element {
  return (
    <QueryPage wide>
      <StargazersClient />
    </QueryPage>
  )
}
