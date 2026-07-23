'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { RepoHomeContent } from '@/components/repo/repo-home-content'
import { useParam, useRepoAddress } from '@/hooks/use-query-param'

export function RepoHomeClient(): JSX.Element {
  const addr = useRepoAddress()
  const refParam = useParam('ref')
  return (
    <RepoScaffold addr={addr} refParam={refParam}>
      {(home) => <RepoHomeContent home={home} addr={addr} refParam={refParam} />}
    </RepoScaffold>
  )
}
