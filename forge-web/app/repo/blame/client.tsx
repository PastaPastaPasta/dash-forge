'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { BlameContent } from '@/components/repo/blame-content'
import { useParam, useRepoAddress } from '@/hooks/use-query-param'

export function BlameClient(): JSX.Element {
  const addr = useRepoAddress()
  const path = useParam('path')
  const refParam = useParam('ref')
  return (
    <RepoScaffold addr={addr} browse refParam={refParam} rail={false}>
      {(home) => <BlameContent home={home} addr={addr} path={path} refParam={refParam} />}
    </RepoScaffold>
  )
}
