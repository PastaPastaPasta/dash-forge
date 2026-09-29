'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { NumberContent } from '@/components/repo/number-content'
import { useParam, useRepoAddress } from '@/hooks/use-query-param'

export function NumberClient(): JSX.Element {
  const addr = useRepoAddress()
  const number = Number.parseInt(useParam('number'), 10)
  const upstream = useParam('upstream') === '1'
  return (
    <RepoScaffold addr={addr} rail={false}>
      {(home) => <NumberContent home={home} addr={addr} number={number} upstream={upstream} />}
    </RepoScaffold>
  )
}
