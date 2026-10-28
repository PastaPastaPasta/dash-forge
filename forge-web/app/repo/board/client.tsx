'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { BoardPage } from '@/components/repo/boards/board-page'
import { useRepoAddress } from '@/hooks/use-query-param'

export function BoardClient(): JSX.Element {
  const addr = useRepoAddress()
  return (
    <RepoScaffold addr={addr} rail={false} refs="default">
      {(home) => <BoardPage home={home} addr={addr} />}
    </RepoScaffold>
  )
}
