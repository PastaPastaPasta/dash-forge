'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { EnvironmentsContent } from '@/components/repo/environments-content'
import { useRepoAddress } from '@/hooks/use-query-param'

export function EnvironmentsClient(): JSX.Element {
  const addr = useRepoAddress()
  return (
    <RepoScaffold addr={addr} rail={false} sealedOk>
      {(home) => <EnvironmentsContent home={home} addr={addr} />}
    </RepoScaffold>
  )
}
