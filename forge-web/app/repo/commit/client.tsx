'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { CommitContent } from '@/components/repo/commit-content'
import { useParam, useRepoAddress } from '@/hooks/use-query-param'

export function CommitClient(): JSX.Element {
  const addr = useRepoAddress()
  const oid = useParam('oid')
  return (
    <RepoScaffold addr={addr}>
      {(home) => <CommitContent home={home} addr={addr} oid={oid} />}
    </RepoScaffold>
  )
}
