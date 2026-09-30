'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { CommitsContent, FIRST_PARENT_PARAM } from '@/components/repo/commits-content'
import { useParam, useRepoAddress } from '@/hooks/use-query-param'

export function CommitsClient(): JSX.Element {
  const addr = useRepoAddress()
  const refParam = useParam('ref')
  const path = useParam('path')
  const firstParent = useParam(FIRST_PARENT_PARAM) === '1'
  return (
    <RepoScaffold addr={addr} browse refParam={refParam}>
      {(home) => <CommitsContent home={home} addr={addr} refParam={refParam} path={path} firstParent={firstParent} />}
    </RepoScaffold>
  )
}
