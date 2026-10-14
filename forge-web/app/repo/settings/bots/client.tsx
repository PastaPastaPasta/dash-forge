'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { BotsContent } from '@/components/repo/bots-content'
import { useRepoAddress } from '@/hooks/use-query-param'

export function BotsClient(): JSX.Element {
  const addr = useRepoAddress()
  return (
    <RepoScaffold addr={addr} rail={false} sealedOk>
      {(home) => <BotsContent home={home} addr={addr} />}
    </RepoScaffold>
  )
}
