'use client'

/**
 * Approvals — the forge-v2 approval fold, shown exactly (`countApprovals`, `forge-v2.md` §6,
 * ux-dx-spec §5.7): who approved and who requested changes on the PR's current head, counting
 * only reviewers who were a maintainer or writer when they reviewed and still are. A member's
 * approval of their own PR counts and is labelled as such. Reviews that do not count (stale
 * heads, non-members, comments) stay visible in the timeline but not here.
 */

import { Check, X } from 'lucide-react'
import type { PullApprovals } from '@/lib/view'
import { Author } from '@/components/author'
import { Oid } from '@/components/ui/oid'

export function Approvals({
  approvals,
  author,
  headOid,
}: {
  approvals: PullApprovals
  author: string
  headOid: string
}): JSX.Element {
  const { approvers, changesRequested, roles } = approvals
  const none = approvers.length === 0 && changesRequested.length === 0
  return (
    <section
      aria-label="Approvals"
      className="rounded-lg border border-anvil-200 px-4 py-3 text-dense dark:border-anvil-800"
    >
      <div className="flex flex-wrap items-center gap-2 text-anvil-600 dark:text-anvil-300">
        <span className="font-medium text-anvil-800 dark:text-anvil-100">Reviews on</span>
        {headOid ? <Oid value={headOid} chars={7} copyable={false} /> : <span>(no head)</span>}
      </div>
      {none ? (
        <p className="mt-1.5 text-anvil-500 dark:text-anvil-400">
          No maintainer or writer has approved or requested changes on this head yet.
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {approvers.map((id) => (
            <Row key={`a-${id}`} id={id} role={roles.get(id) ?? null} self={id === author} approve />
          ))}
          {changesRequested.map((id) => (
            <Row key={`c-${id}`} id={id} role={roles.get(id) ?? null} self={id === author} approve={false} />
          ))}
        </ul>
      )}
      <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">
        Counted by the client rule every Forge client applies: reviews on this head by current
        maintainers and writers, newest verdict per reviewer. Nothing at consensus requires them.
      </p>
    </section>
  )
}

function Row({
  id,
  role,
  self,
  approve,
}: {
  id: string
  role: string | null
  self: boolean
  approve: boolean
}): JSX.Element {
  return (
    <li className="flex flex-wrap items-center gap-2">
      {approve ? (
        <Check className="h-3.5 w-3.5 text-verify" aria-hidden />
      ) : (
        <X className="h-3.5 w-3.5 text-danger" aria-hidden />
      )}
      <Author identityId={id} link={false} />
      <span className="text-anvil-500 dark:text-anvil-400">
        {approve ? 'approved' : 'requested changes'}
        {role ? ` · ${role}` : ''}
      </span>
      {self && approve ? (
        <span className="rounded-full bg-anvil-100 px-2 py-0.5 text-[11px] text-anvil-600 dark:bg-anvil-800 dark:text-anvil-300">
          author approval (counted)
        </span>
      ) : null}
    </li>
  )
}
