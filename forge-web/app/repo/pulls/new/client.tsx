'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { NewPullContent } from '@/components/repo/new-pull-content'
import { useRepoAddress } from '@/hooks/use-query-param'

export function NewPullClient(): JSX.Element {
  const addr = useRepoAddress()
  return (
    <RepoScaffold addr={addr} rail={false}>
      {(home) => <NewPullContent home={home} addr={addr} />}
    </RepoScaffold>
  )
}
