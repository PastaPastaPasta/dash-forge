/**
 * LockedBanner — the top of an issue's or PR's comment composer while its conversation is locked
 * (RC1: the thread's transition sum is 16 or more, and consensus refuses a comment or review that
 * does not prove membership). As GitHub's: a lock and "This conversation has been locked and
 * limited to collaborators." A maintainer or writer is told they can still comment and keeps the
 * composer (`children`); anyone else gets the banner in its place, since a post from them would
 * be refused (`lockedOut`): so does a viewer whose membership is still being read or could not
 * be read (their post could not carry the proof).
 *
 * The lock bit is the page's own composite read (`PullThread.locked`, issue `meta.locked`), and
 * the membership comes from the members that read seeded: the banner costs no request.
 */

import type { ReactNode } from 'react'
import { Lock } from 'lucide-react'

import type { Holdings } from '@/lib/rules'
import { cn } from '@/lib/utils'

/** Who is looking, as the lock sees them. */
export type LockViewer = 'member' | 'outsider' | 'signedOut' | 'checking' | 'unknown'

/** The viewer's standing from the page's membership read (`readViewerPermissions`). */
export function lockViewerOf(identity: string | null, holdings: { readonly settled: boolean; readonly data: Holdings | null }): LockViewer {
  if (identity === null) return 'signedOut'
  if (!holdings.settled) return 'checking'
  if (holdings.data === null) return 'unknown'
  return holdings.data.write || holdings.data.maintain ? 'member' : 'outsider'
}

const NOTE: Readonly<Record<LockViewer, string>> = {
  member: "You can still comment because you're a maintainer or writer of this repo.",
  outsider: 'Only maintainers and writers can comment or review; the network refuses anyone else’s.',
  signedOut: 'Sign in as a maintainer or writer of this repo to comment.',
  checking: 'Checking whether you are a maintainer or writer of this repo…',
  unknown: "Couldn't check whether you are a maintainer or writer of this repo, so commenting is off.",
}

export function LockedBanner({ locked, viewer, children }: { locked: boolean; viewer: LockViewer; children?: ReactNode }): JSX.Element {
  if (!locked) return <>{children}</>
  const member = viewer === 'member'
  return (
    <>
      <div
        className={cn('flex items-start gap-2.5 rounded-md bg-anvil-50 px-3 py-2.5 text-dense text-anvil-700 dark:bg-anvil-900 dark:text-anvil-200', member && 'mb-3')}
        data-testid="locked-banner"
        data-viewer={viewer}
      >
        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-anvil-500 dark:text-anvil-400" aria-hidden />
        <div className="min-w-0">
          <p className="font-medium">This conversation has been locked and limited to collaborators.</p>
          <p className="text-[12px] text-anvil-500 dark:text-anvil-400">{NOTE[viewer]}</p>
        </div>
      </div>
      {member ? children : null}
    </>
  )
}
