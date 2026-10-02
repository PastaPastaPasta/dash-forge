'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { CodeSearchContent } from '@/components/repo/code-search-content'
import { useParam, useRepoAddress } from '@/hooks/use-query-param'

export function SearchClient(): JSX.Element {
  const addr = useRepoAddress()
  const refParam = useParam('ref')
  const query = useParam('query')
  return (
    // No `browse`: a kept index is searched with no read; the reader starts only to build one.
    <RepoScaffold addr={addr} rail={false} refParam={refParam}>
      {(home) => <CodeSearchContent home={home} addr={addr} refParam={refParam} initialQuery={query} />}
    </RepoScaffold>
  )
}
