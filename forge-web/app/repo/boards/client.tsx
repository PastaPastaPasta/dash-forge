'use client'

import { RepoScaffold } from '@/components/repo/repo-scaffold'
import { BoardsList } from '@/components/repo/boards/boards-list'
import { useRepoAddress } from '@/hooks/use-query-param'

export function BoardsClient(): JSX.Element {
  const addr = useRepoAddress()
  return (
    <RepoScaffold addr={addr} rail={false} refs="default">
      {(home) => <BoardsList home={home} addr={addr} />}
    </RepoScaffold>
  )
}
