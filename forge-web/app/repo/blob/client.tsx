'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { BlobContent } from '@/components/repo/blob-content'
import { useParam, useRepoAddress } from '@/hooks/use-query-param'

export function BlobClient(): JSX.Element {
  const addr = useRepoAddress()
  const path = useParam('path')
  return (
    <RepoScaffold addr={addr}>
      {(home) => <BlobContent home={home} addr={addr} path={path} />}
    </RepoScaffold>
  )
}
