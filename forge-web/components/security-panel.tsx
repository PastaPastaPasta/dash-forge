'use client'

/**
 * Settings → Security: "Stay signed in for public repos (12 h)", on by default. On: after an
 * unlock, reloads and new tabs keep only the spend-capped signing key, for up to 12 hours (4 h
 * idle); private repos, storage credentials and wallet grants still ask to unlock in each tab.
 * Off: every page load starts locked, and nothing is kept between them.
 */

import { useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { BROWSER_KEY_DEFAULTS } from '@/lib/auth'
import { askToUnlockEveryVisit } from '@/lib/auth/vault'
import { errorMessage } from '@/lib/utils'

export function SecurityPanel(): JSX.Element {
  const { controller } = useAuth()
  const [stay, setStay] = useState(() => !askToUnlockEveryVisit())
  const [error, setError] = useState<string | null>(null)
  const toggle = (on: boolean): void => {
    setError(null)
    setStay(on)
    controller.setAskToUnlockEveryVisit(!on).catch((e: unknown) => setError(errorMessage(e)))
  }
  return (
    <section aria-labelledby="security-title" className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
      <h2 id="security-title" className="mb-3 text-dense font-medium text-anvil-500 dark:text-anvil-400">
        Security
      </h2>
      <label className="flex items-start gap-2 text-dense">
        <input type="checkbox" className="mt-0.5" checked={stay} onChange={(e) => toggle(e.target.checked)} data-testid="stay-signed-in" />
        <span>
          <span className="font-medium">Stay signed in for public repos (12 h)</span>
          <span className="block text-[12px] text-anvil-500 dark:text-anvil-400">
            {stay
              ? `Keeps a spend-capped signing key in this browser (a browser key: ${BROWSER_KEY_DEFAULTS.budgetDash} DASH and ${BROWSER_KEY_DEFAULTS.days} days by default; never a key without a budget, an expiry or Forge-only bounds), so reloads and new tabs stay signed in for public repos. Private repos, storage credentials and wallet grants still ask you to unlock.`
              : 'Off: each reload or new tab starts locked; unlock with your passkey or passphrase to write.'}
          </span>
        </span>
      </label>
      {error ? (
        <p role="alert" className="mt-2 text-[12px] text-danger-700 dark:text-danger-400">
          {error}
        </p>
      ) : null}
    </section>
  )
}
