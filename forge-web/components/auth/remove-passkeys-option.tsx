'use client'

/**
 * "Also remove the passkeys that hold this key": offered in the dialogs that disable a key (revoke
 * this browser's key, disable one in Devices & keys) when at least one passkey's entry on Platform
 * names it. The controller deletes those entries first, signed by the key while it is still live
 * (`revokeStored` and `disableIdentityKey`, `removePasskeys`). A passkey left behind would only
 * fail its sign-in, but its entry would stay public with a dead key in it.
 *
 * Removing a passkey does not lock anyone out of an encryption key it held: that needs a new
 * encryption key, which the note says when it applies.
 */

import { useEffect, useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { DOCS } from '@/lib/docs-links'

/** The identity's passkeys that hold one of `keyIds`, once read; null while reading, none, or hidden. */
export function usePasskeysHolding(keyIds: readonly number[]): { readonly count: number; readonly encryption: boolean } | null {
  const { identity, storage, platformPasskeyProblem, listPlatformPasskeys } = useAuth()
  const [found, setFound] = useState<{ count: number; encryption: boolean } | null>(null)
  const wanted = keyIds.join(',')
  useEffect(() => {
    if (identity === null || storage !== 'vault' || platformPasskeyProblem !== null) return
    const ids = wanted === '' ? [] : wanted.split(',').map(Number)
    let live = true
    // A read that fails offers nothing: the key is still disabled, and its passkeys can be removed in Settings.
    listPlatformPasskeys().then(
      (rows) => {
        const holding = rows.filter((r) => ids.includes(r.keyId))
        if (live) setFound(holding.length === 0 ? null : { count: holding.length, encryption: holding.some((r) => r.encryptionKey) })
      },
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [identity, storage, platformPasskeyProblem, listPlatformPasskeys, wanted])
  return found
}

export function RemovePasskeysOption({
  holding,
  checked,
  onChange,
}: {
  holding: { readonly count: number; readonly encryption: boolean }
  checked: boolean
  onChange: (checked: boolean) => void
}): JSX.Element {
  return (
    <div className="rounded-md border border-anvil-200 p-3 dark:border-anvil-800" data-testid="remove-passkeys-option">
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-0.5" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid="remove-passkeys" />
        <span>
          <span className="font-medium">
            Also remove {holding.count === 1 ? 'the passkey' : `the ${holding.count} passkeys`} that {holding.count === 1 ? 'holds' : 'hold'} this key
          </span>
          <span className="block text-[12px] text-anvil-500 dark:text-anvil-400">
            Deletes {holding.count === 1 ? 'its' : 'their'} entries from Platform before the key is disabled. The deposit comes back.
          </span>
        </span>
      </label>
      {holding.encryption ? (
        <p className="mt-2 text-[12px] text-caution-700 dark:text-caution-400" data-testid="remove-passkeys-encryption">
          A passkey that holds your encryption key still opens it for anyone who has the passkey. Removing it doesn&apos;t change that: replace the{' '}
          <a href={`${DOCS.identity}#replacing-it-after-a-lost-device`} target="_blank" rel="noreferrer noopener" className="underline">
            encryption key
          </a>{' '}
          too.
        </p>
      ) : null}
    </div>
  )
}
