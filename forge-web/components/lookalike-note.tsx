'use client'

/**
 * A note on a repo or profile whose owner name or repo name looks like one this browser already
 * knows for someone else (TS-24; `lib/view/known-names.ts`, `lib/view/confusable.ts`):
 *
 * - like one the viewer stars or follows: "Not to be confused with dashpay, which you starred."
 * - like one only visited: "Looks like dash-pay, another identity you've visited." A visit says
 *   nothing about which one is real (the impostor's may have been first), so it only says both
 *   exist.
 *
 * The page's names are then recorded as visited, after the comparison, so a page never warns
 * about itself. The viewer's own names are never compared.
 */

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { repoHref } from '@/hooks/use-query-param'
import { useSdk } from '@/hooks/use-sdk'
import { identityHref } from '@/lib/view/profile-links'
import { lookalikeOf, readKnown, rememberNames, type KnownName, type Subject } from '@/lib/view/known-names'
import { cn } from '@/lib/utils'

function keyOf(n: Subject): string {
  return `${n.kind}:${n.identity}:${n.repoId ?? ''}:${n.name}`
}

function entry(s: Subject, how: KnownName['how'], at: number): KnownName {
  const { kind, name, identity, repoId, label } = s
  return { kind, name, identity, ...(repoId === undefined ? {} : { repoId }), ...(label === undefined ? {} : { label }), how, at }
}

/** The first of `subjects` (the owner, then the repo) that looks like a known name, as a note. */
export function LookalikeNote({ subjects, className }: { subjects: readonly (Subject | null)[]; className?: string }): JSX.Element | null {
  const { network } = useSdk()
  const { identity } = useAuth()
  const present = subjects.filter((s): s is Subject => s !== null && s.name !== '' && s.identity !== identity)
  const key = `${network}|${present.map(keyOf).join('|')}`
  const [match, setMatch] = useState<KnownName | null>(null)

  useEffect(() => {
    const known = readKnown(network)
    let found: KnownName | null = null
    for (const s of present) {
      found = lookalikeOf(known, s)
      if (found !== null) break
    }
    setMatch(found)
    const at = Date.now()
    rememberNames(network, present.map((s) => entry(s, 'visited', at)))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` names the network and every subject
  }, [key])

  if (match === null) return null
  const shown = match.kind === 'repo' ? match.label ?? match.name : match.name
  const href = match.kind === 'repo' ? repoHref('/repo', { owner: match.identity, name: match.name, ...(match.repoId ? { repoId: match.repoId } : {}) }) : identityHref(match.identity)
  const link = (
    <Link href={href} className="font-semibold underline">
      {shown}
    </Link>
  )
  return (
    <p role="note" className={cn('flex items-start gap-1.5 text-dense text-caution-700 dark:text-caution-400', className)} data-testid="lookalike-note">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      {match.how === 'visited' ? (
        <span>
          Looks like {link}, {match.kind === 'repo' ? "another owner's repository" : 'another identity'} you&apos;ve visited. Compare the identity ids.
        </span>
      ) : (
        <span>
          Not to be confused with {link}, which you {match.how === 'starred' ? 'starred' : 'follow'}. Compare the identity id before you trust this page.
        </span>
      )}
    </p>
  )
}

/**
 * Keep the viewer's star or follow of `subject` for the note: recorded once the relation reads
 * on, and made a visit again once it reads off (`null`: not known yet, nothing changes).
 */
export function useRememberAcquaintance(subjects: readonly (Subject | null)[], how: 'starred' | 'followed', on: boolean | null): void {
  const { network } = useSdk()
  const present = subjects.filter((s): s is Subject => s !== null && s.name !== '')
  const key = present.map(keyOf).join('|')
  useEffect(() => {
    if (on === null) return
    rememberNames(network, present.map((s) => entry(s, how, Date.now())), !on)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` names every subject
  }, [network, key, how, on])
}
