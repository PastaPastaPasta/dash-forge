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
  // Keyed by repo and number, as the PR page: the same number in another repo is a fresh page.
  const key = `${addr.repoId ?? `${addr.owner}/${addr.name}`}#${number}`
  return (
    <RepoScaffold addr={addr} rail={false} refs="default">
      {(home) => (Number.isFinite(upstream) ? <UpstreamRedirect home={home} addr={addr} upstream={upstream} /> : <IssueContent key={key} home={home} addr={addr} number={number} />)}
    </RepoScaffold>
  )
}
