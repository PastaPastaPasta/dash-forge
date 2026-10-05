'use client'

/**
 * The new-key alert (TS-07): a key was added to the signed-in identity since this device last
 * looked, and this device did not add it. Whoever holds the master key or the recovery phrase
 * can add keys, so a key nobody here expected is the first sign of a leak. "It was me" stops the
 * alert for these keys; Review opens Devices & keys, where any of them can be disabled.
 */

import Link from 'next/link'
import { ShieldAlert } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { Button, buttonClass } from '@/components/ui/button'
import { keyKind } from '@/lib/auth/key-watch'

export function NewKeyAlert(): JSX.Element | null {
  const { newKeys, controller } = useAuth()
  if (newKeys.length === 0) return null
  const one = newKeys.length === 1
  const list = newKeys.map((k) => `#${k.keyId} (${keyKind(k)})`).join(', ')
  const master = newKeys.some((k) => k.level === 0)
  return (
    <div role="alert" data-testid="new-key-alert" className="border-b border-danger/40 bg-danger/10">
      <div className="mx-auto flex max-w-[1280px] flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 text-dense sm:px-6">
        <ShieldAlert className="h-4 w-4 shrink-0 text-danger-700 dark:text-danger-400" aria-hidden />
        <p className="min-w-0 flex-1 text-anvil-800 dark:text-anvil-100">
          {one ? 'A key was' : `${newKeys.length} keys were`} added to your identity since this device last checked: {list}.{' '}
          {master
            ? 'A new master key means someone else may control your identity.'
            : `If you didn't add ${one ? 'it' : 'them'} yourself, with dg or in another browser, disable ${one ? 'it' : 'them'} now.`}
        </p>
        <div className="flex items-center gap-1">
          <Link href="/settings/keys/" className={buttonClass({ size: 'sm', variant: 'danger' })} data-testid="new-key-review">
            Review keys
          </Link>
          <Button size="sm" variant="ghost" onClick={() => controller.acknowledgeNewKeys()} data-testid="new-key-mine">
            It was me
          </Button>
        </div>
      </div>
    </div>
  )
}
