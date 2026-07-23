'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { RepoHomeContent } from '@/components/repo/repo-home-content'
import { useRepoAddress } from '@/hooks/use-query-param'

export function RepoHomeClient(): JSX.Element {
  const addr = useRepoAddress()
  return (
    <RepoScaffold addr={addr}>
      {(home) => <RepoHomeContent home={home} addr={addr} />}
    </RepoScaffold>
  )
}
