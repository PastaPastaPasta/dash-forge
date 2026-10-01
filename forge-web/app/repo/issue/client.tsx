'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { IssueContent } from '@/components/repo/issue-content'
import { UpstreamRedirect } from '@/components/repo/upstream-redirect'
import { useParam, useRepoAddress } from '@/hooks/use-query-param'

export function IssueClient(): JSX.Element {
  const addr = useRepoAddress()
  const number = Number.parseInt(useParam('number'), 10)
  // `?upstream=N`: a mirrored body's `#N` (the source's number), resolved to this repo's item.
  const upstream = Number.parseInt(useParam('upstream'), 10)
  return (
    <RepoScaffold addr={addr} rail={false} refs="default">
      {(home) => (Number.isFinite(upstream) ? <UpstreamRedirect home={home} addr={addr} upstream={upstream} /> : <IssueContent key={number} home={home} addr={addr} number={number} />)}
    </RepoScaffold>
  )
}
