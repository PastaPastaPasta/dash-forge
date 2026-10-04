'use client'

/**
 * "Not to be confused with dashpay, which you starred." (TS-24): shown on a repo or profile
 * whose owner name or repo name looks like one this browser already knows for someone else
 * (`lib/view/known-names.ts`, `lib/view/confusable.ts`). The page is then recorded as visited,
 * after the comparison, so a page never warns about itself.
 */

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { repoHref } from '@/hooks/use-query-param'
import { identityHref } from '@/lib/view/profile-links'
import { lookalikeOf, readKnown, rememberName, type KnownName } from '@/lib/view/known-names'
import { cn } from '@/lib/utils'

/** Something on the page that has a name: an owner (its DPNS name) or a repository. */
export type Named = Pick<KnownName, 'kind' | 'name' | 'identity' | 'repoId' | 'label'>

const HOW: Readonly<Record<KnownName['how'], string>> = {
  visited: "which you've visited",
  starred: 'which you starred',
  followed: 'which you follow',
}

function keyOf(n: Named): string {
  return `${n.kind}:${n.identity}:${n.repoId ?? ''}:${n.name}`
}

/**
 * The first of `subjects` (most telling first: the owner, then the repo) that looks like a
 * known name, as a note; nothing otherwise. Each subject is then remembered as visited.
 */
export function LookalikeNote({ subjects, className }: { subjects: readonly (Named | null)[]; className?: string }): JSX.Element | null {
  const present = subjects.filter((s): s is Named => s !== null && s.name !== '')
  const key = present.map(keyOf).join('|')
  const [match, setMatch] = useState<KnownName | null>(null)

  useEffect(() => {
    const known = readKnown()
    let found: KnownName | null = null
    for (const s of present) {
      found = lookalikeOf(known, s)
      if (found !== null) break
    }
    setMatch(found)
    const at = Date.now()
    for (const s of present) rememberName({ ...s, how: 'visited', at })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` names every subject
  }, [key])

  if (match === null) return null
  const shown = match.kind === 'repo' ? match.label ?? match.name : match.name
  const href = match.kind === 'repo' ? repoHref('/repo', { owner: match.identity, name: match.name, ...(match.repoId ? { repoId: match.repoId } : {}) }) : identityHref(match.identity)
  return (
    <p
      role="note"
      className={cn('flex items-start gap-1.5 text-dense text-caution-700 dark:text-caution-400', className)}
      data-testid="lookalike-note"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        Not to be confused with{' '}
        <Link href={href} className="font-semibold underline">
          {shown}
        </Link>
        , {HOW[match.how]}. Compare the identity id before you trust it.
      </span>
    </p>
  )
}

/** Remember that the viewer stars or follows `subject` (once the relation is read as on). */
export function useRememberAcquaintance(subject: Named | null, how: 'starred' | 'followed', on: boolean): void {
  const key = subject === null ? '' : keyOf(subject)
  useEffect(() => {
    if (!on || subject === null || subject.name === '') return
    rememberName({ ...subject, how, at: Date.now() })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` names the subject
  }, [key, how, on])
}
