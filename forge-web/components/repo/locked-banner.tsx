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
import { Lock, LockOpen } from 'lucide-react'

import type { Holdings } from '@/lib/rules'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/** Who is looking, as the lock sees them. */
export type LockViewer = 'member' | 'outsider' | 'signedOut' | 'checking' | 'unknown'

/** The viewer's standing from the page's membership read (`readViewerPermissions`). */
export function lockViewerOf(identity: string | null, holdings: { readonly settled: boolean; readonly data: Holdings | null }): LockViewer {
  if (identity === null) return 'signedOut'
  if (!holdings.settled) return 'checking'
  if (holdings.data === null) return 'unknown'
  return holdings.data.write || holdings.data.maintain ? 'member' : 'outsider'
}

/** What the banner tells each viewer; `acts` is what the thread takes ("comment", or "comment or review" on a PR). */
function noteFor(viewer: LockViewer, acts: string): string {
  switch (viewer) {
    case 'member':
      return "You can still comment because you're a maintainer or writer of this repo."
    case 'outsider':
      return `Only maintainers and writers can ${acts}; the network refuses anyone else's.`
    case 'signedOut':
      return 'Sign in as a maintainer or writer of this repo to comment.'
    case 'checking':
      return 'Checking whether you are a maintainer or writer of this repo…'
    case 'unknown':
      return "Couldn't check whether you are a maintainer or writer of this repo, so commenting is off."
  }
}

export function LockedBanner({
  locked,
  viewer,
  target,
  children,
}: {
  locked: boolean
  viewer: LockViewer
  /** A PR also takes reviews (the note names them). */
  target: 'issue' | 'pull'
  children: ReactNode
}): JSX.Element {
  if (!locked) return <>{children}</>
  const member = viewer === 'member'
  return (
    <>
      <div
        className={cn('flex items-start gap-2.5 rounded-md bg-anvil-50 px-3 py-2.5 text-dense text-anvil-700 dark:bg-anvil-900 dark:text-anvil-200', member && 'mb-3')}
        role="status"
        data-testid="locked-banner"
        data-viewer={viewer}
      >
        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-anvil-500 dark:text-anvil-400" aria-hidden />
        <div className="min-w-0">
          <p className="font-medium">This conversation has been locked and limited to collaborators.</p>
          <p className="text-[12px] text-anvil-500 dark:text-anvil-400">{noteFor(viewer, target === 'pull' ? 'comment or review' : 'comment')}</p>
        </div>
      </div>
      {member ? children : null}
    </>
  )
}

/** The rail's lock state line (GitHub: "Locked to members" under the conversation heading). */
export function lockStateText(locked: boolean): string {
  return locked ? 'Locked to members' : 'Open to everyone'
}

/** The Lock / Unlock conversation button a maintainer or writer gets in the rail; `onToggle(lock)` asks to confirm. */
export function LockToggle({ locked, onToggle }: { locked: boolean; onToggle: (lock: boolean) => void }): JSX.Element {
  const Icon = locked ? LockOpen : Lock
  return (
    <Button size="sm" variant="outline" onClick={() => onToggle(!locked)} data-testid="lock-toggle">
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {locked ? 'Unlock conversation' : 'Lock conversation'}
    </Button>
  )
}

/** The confirm dialog's text for locking (`lock`) or unlocking the conversation on `what` ("issue #3", "PR #5"). */
export function lockConfirm(lock: boolean, what: string, target: 'issue' | 'pull'): { title: string; description: string; label: string } {
  const acts = target === 'pull' ? 'comments and reviews' : 'comments'
  const again = target === 'pull' ? 'comment and review' : 'comment'
  return lock
    ? {
        title: `Lock conversation on ${what}`,
        description: `Records a lock: from then on the network refuses ${acts} from anyone who is not a maintainer or writer. Any maintainer or writer can unlock it.`,
        label: 'Sign & lock',
      }
    : { title: `Unlock conversation on ${what}`, description: `Records an unlock: everyone can ${again} again.`, label: 'Sign & unlock' }
}
