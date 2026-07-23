'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { IssuesContent } from '@/components/repo/issues-content'
import { useRepoAddress } from '@/hooks/use-query-param'

export function IssuesClient(): JSX.Element {
  const addr = useRepoAddress()
  return (
    <RepoScaffold addr={addr} rail={false}>
      {(home) => <IssuesContent home={home} addr={addr} />}
    </RepoScaffold>
  )
}
