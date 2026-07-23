'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { RefListContent } from '@/components/repo/ref-list-content'
import { useRepoAddress } from '@/hooks/use-query-param'

export function BranchesClient(): JSX.Element {
  const addr = useRepoAddress()
  return (
    <RepoScaffold addr={addr}>
      {(home) => <RefListContent home={home} addr={addr} kind="branches" />}
    </RepoScaffold>
  )
}
