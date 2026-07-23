'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { IssueContent } from '@/components/repo/issue-content'
import { useParam, useRepoAddress } from '@/hooks/use-query-param'

export function IssueClient(): JSX.Element {
  const addr = useRepoAddress()
  const number = Number.parseInt(useParam('number'), 10)
  return (
    <RepoScaffold addr={addr} rail={false}>
      {(home) => <IssueContent home={home} number={number} />}
    </RepoScaffold>
  )
}
