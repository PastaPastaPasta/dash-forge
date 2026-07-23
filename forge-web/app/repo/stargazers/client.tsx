'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { StargazersContent } from '@/components/repo/stargazers-content'
import { useRepoAddress } from '@/hooks/use-query-param'

export function StargazersClient(): JSX.Element {
  const addr = useRepoAddress()
  return (
    <RepoScaffold addr={addr}>
      {(home) => <StargazersContent home={home} />}
    </RepoScaffold>
  )
}
