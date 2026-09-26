'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { ReleasesContent } from '@/components/repo/releases-content'
import { useRepoAddress } from '@/hooks/use-query-param'

export function ReleasesClient(): JSX.Element {
  const addr = useRepoAddress()
  return (
    <RepoScaffold addr={addr} rail={false}>
      {(home) => <ReleasesContent home={home} addr={addr} />}
    </RepoScaffold>
  )
}
