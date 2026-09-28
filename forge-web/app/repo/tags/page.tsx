import { QueryPage } from '@/components/route-loading'
import { TagsClient } from './client'

/** `/repo/tags?owner=&name=` — the tag list with tip oids. */
export default function TagsPage(): JSX.Element {
  return (
    <QueryPage wide>
      <TagsClient />
    </QueryPage>
  )
}
