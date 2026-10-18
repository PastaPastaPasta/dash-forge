'use client'

/** Members read conversion-start information directly from the confirmed owner marker. */
import { useAsync } from '@/hooks/use-async'
import { decodeIdentifier } from '@/lib/auth/base58'
import { readSessionSealOff } from '@/lib/repo/private-session'
import type { RepoHome } from '@/lib/view'

export function SealOffBanner({ home }: { home: RepoHome }): JSX.Element | null {
  const session = home.repo.visibility === 'private' && home.private?.access === 'member' ? home.private.session : null
  const { data } = useAsync(
    () => session === null ? Promise.resolve(null) : readSessionSealOff(session, decodeIdentifier(home.repo.ownerId)),
    [home.repo.repoId, home.repo.ownerId, session?.id],
    { enabled: session !== null },
  )
  if (session === null || data?.kind !== 'active') return null
  return (
    <div className="mt-3 rounded-md border border-caution/40 bg-caution/5 px-3 py-1.5 text-dense text-caution-700 dark:text-caution-400" role="status" data-testid="repo-seal-off">
      This repo is being made public. What you write from now on stays members-only unless the owner starts the conversion over.
      {data.marker?.replacesEpoch !== undefined ? ' A new conversion replaced the earlier publication boundary. Earlier writing may now be published.' : null}
    </div>
  )
}
