'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { CompareContent } from '@/components/repo/compare-content'
import { useRepoAddress } from '@/hooks/use-query-param'

export function CompareClient(): JSX.Element {
  const addr = useRepoAddress()
  return (
    <RepoScaffold addr={addr} browse rail={false}>
      {(home) => <CompareContent home={home} addr={addr} />}
    </RepoScaffold>
  )
}
