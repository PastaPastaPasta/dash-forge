'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { LabelsContent } from '@/components/repo/labels-content'
import { useRepoAddress } from '@/hooks/use-query-param'

export function LabelsClient(): JSX.Element {
  const addr = useRepoAddress()
  return (
    <RepoScaffold addr={addr} rail={false} refs="default">
      {(home) => <LabelsContent home={home} addr={addr} />}
    </RepoScaffold>
  )
}
