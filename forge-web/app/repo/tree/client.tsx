'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { TreeContent } from '@/components/repo/tree-content'
import { useParam, useRepoAddress } from '@/hooks/use-query-param'

export function TreeClient(): JSX.Element {
  const addr = useRepoAddress()
  const path = useParam('path')
  const refParam = useParam('ref')
  return (
    <RepoScaffold addr={addr} refParam={refParam}>
      {(home) => <TreeContent home={home} addr={addr} path={path} refParam={refParam} />}
    </RepoScaffold>
  )
}
