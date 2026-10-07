'use client'

/**
 * Author — an identity pill that lazily reverse-resolves the DPNS name and links to the
 * identity's profile. Wraps the {@link IdentityPill} signature element; the name resolution is
 * cache-backed (see lib/view/dpns) so repeated authors on a page resolve once.
 */

import Link from 'next/link'
import { IdentityPill } from '@/components/ui/identity-pill'
import { useDpnsName } from '@/hooks/use-dpns-name'
import { identityHref } from '@/lib/view/profile-links'
import { BotBadge, useBotOperator } from '@/components/bot-badge'

export function Author({
  identityId,
  link = true,
  className,
}: {
  identityId: string
  link?: boolean
  className?: string
}): JSX.Element {
  const name = useDpnsName(identityId)
  // Inside a thread's bot scope only: a verified bot carries a badge.
  const operator = useBotOperator(identityId)

  const pill = <IdentityPill identityId={identityId} name={name} className={className} />
  const shown = !link ? (
    pill
  ) : (
    <Link href={identityHref(identityId)} className="hit-area inline-flex min-w-0 max-w-full rounded-full">
      {pill}
    </Link>
  )
  if (operator === undefined) return shown
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1">
      {shown}
      <BotBadge operator={operator} />
    </span>
  )
}
