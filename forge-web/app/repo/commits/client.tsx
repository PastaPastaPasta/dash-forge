'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { CommitsContent } from '@/components/repo/commits-content'
import { useParam, useRepoAddress } from '@/hooks/use-query-param'

export function CommitsClient(): JSX.Element {
  const addr = useRepoAddress()
  const refParam = useParam('ref')
  return (
    <RepoScaffold addr={addr} refParam={refParam}>
      {(home) => <CommitsContent home={home} addr={addr} refParam={refParam} />}
    </RepoScaffold>
  )
}
