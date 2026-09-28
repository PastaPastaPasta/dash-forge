import { QueryPage } from '@/components/route-loading'
import { BlameClient } from './client'

/** `/repo/blame?owner=&name=&path=[&ref=]` — each line of a file with the commit that last changed it. */
export default function BlamePage(): JSX.Element {
  return (
    <QueryPage wide>
      <BlameClient />
    </QueryPage>
  )
}
