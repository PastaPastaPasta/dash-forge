'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { RefActivityContent } from '@/components/repo/ref-activity-content'
import { useParam, useRepoAddress } from '@/hooks/use-query-param'

export function RefActivityClient(): JSX.Element {
  const addr = useRepoAddress()
  const branch = useParam('branch')
  const tag = useParam('tag')
  // A full `refs/heads/…` or `refs/tags/…` name works too; no name at all reads as none.
  const refName = tag !== '' ? `refs/tags/${tag.replace(/^refs\/tags\//, '')}` : branch !== '' ? `refs/heads/${branch.replace(/^refs\/heads\//, '')}` : ''
  return <RepoScaffold addr={addr}>{(home) => <RefActivityContent home={home} addr={addr} refName={refName} />}</RepoScaffold>
}
