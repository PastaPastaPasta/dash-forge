'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { PullsContent } from '@/components/repo/pulls-content'
import { useRepoAddress } from '@/hooks/use-query-param'

export function PullsClient(): JSX.Element {
  const addr = useRepoAddress()
  return (
    <RepoScaffold addr={addr} rail={false}>
      {(home) => <PullsContent home={home} addr={addr} />}
    </RepoScaffold>
  )
}
