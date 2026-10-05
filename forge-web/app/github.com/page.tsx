import { QueryPage } from '@/components/route-loading'
import { UpstreamAliasClient } from './client'

/**
 * `/github.com/<owner>/<repo>` (and `/gh/…`), which the short-URL shim turns into
 * `/github.com/?owner=&name=[&rest=]`: the Forge mirror of a GitHub repo, or how to make one (CJ-3).
 */
export default function UpstreamAliasPage(): JSX.Element {
  return (
    <QueryPage>
      <UpstreamAliasClient />
    </QueryPage>
  )
}
