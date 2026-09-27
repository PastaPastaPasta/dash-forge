'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { ReleaseContent } from '@/components/repo/releases-content'
import { useParam, useRepoAddress } from '@/hooks/use-query-param'

export function ReleaseClient(): JSX.Element {
  const addr = useRepoAddress()
  const tag = useParam('tag')
  return (
    <RepoScaffold addr={addr} rail={false}>
      {(home) => <ReleaseContent home={home} addr={addr} tag={tag} />}
    </RepoScaffold>
  )
}
