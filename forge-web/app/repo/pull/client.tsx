'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { PullContent } from '@/components/repo/pull-content'
import { useParam, useRepoAddress } from '@/hooks/use-query-param'

export function PullClient(): JSX.Element {
  const addr = useRepoAddress()
  const number = Number.parseInt(useParam('number'), 10)
  return (
    <RepoScaffold addr={addr} rail={false}>
      {(home) => <PullContent home={home} addr={addr} number={number} />}
    </RepoScaffold>
  )
}
