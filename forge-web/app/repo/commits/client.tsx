'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { CommitsContent } from '@/components/repo/commits-content'
import { useRepoAddress } from '@/hooks/use-query-param'

export function CommitsClient(): JSX.Element {
  const addr = useRepoAddress()
  return (
    <RepoScaffold addr={addr}>
      {(home) => <CommitsContent home={home} addr={addr} />}
    </RepoScaffold>
  )
}
