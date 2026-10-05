'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { RefActivityContent } from '@/components/repo/ref-activity-content'
import { useParam, useRepoAddress } from '@/hooks/use-query-param'

export function RefActivityClient(): JSX.Element {
  const addr = useRepoAddress()
  const branch = useParam('branch')
  const tag = useParam('tag')
  const refName = tag !== '' ? `refs/tags/${tag}` : `refs/heads/${branch}`
  return <RepoScaffold addr={addr}>{(home) => <RefActivityContent home={home} addr={addr} refName={refName} />}</RepoScaffold>
}
