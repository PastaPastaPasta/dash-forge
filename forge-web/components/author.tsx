'use client'

/**
 * Author — an identity pill that lazily reverse-resolves the DPNS name and links to the
 * identity's profile. Wraps the {@link IdentityPill} signature element; the name resolution is
 * cache-backed (see lib/view/dpns) so repeated authors on a page resolve once.
 */

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { IdentityPill, type TokenRole } from '@/components/ui/identity-pill'
import { useSdk } from '@/hooks/use-sdk'
import { resolveDpnsName } from '@/lib/view'

export function Author({
  identityId,
  role,
  link = true,
  className,
}: {
  identityId: string
  role?: TokenRole
  link?: boolean
  className?: string
}): JSX.Element {
  const { sdk, ready, network } = useSdk()
  const [name, setName] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!ready || !sdk || !identityId) return
    let cancelled = false
    resolveDpnsName(sdk, identityId, network)
      .then((n) => {
        if (!cancelled && n) setName(n)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [sdk, ready, identityId, network])

  const pill = <IdentityPill identityId={identityId} name={name} role={role} className={className} />
  if (!link) return pill
  return (
    <Link href={`/u?name=${encodeURIComponent(identityId)}`} className="rounded-full">
      {pill}
    </Link>
  )
}
