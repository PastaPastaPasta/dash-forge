'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { MilestonesContent } from '@/components/repo/milestones-content'
import { useRepoAddress } from '@/hooks/use-query-param'

export function MilestonesClient(): JSX.Element {
  const addr = useRepoAddress()
  return (
    <RepoScaffold addr={addr} rail={false}>
      {(home) => <MilestonesContent home={home} addr={addr} />}
    </RepoScaffold>
  )
}
