'use client'

/**
 * Settings → Security: "Stay signed in for public repos (up to 12 h)", on by default. On: after an
 * unlock, reloads and new tabs keep only the spend-capped signing key, for up to 12 hours (4 h
 * idle); private repos, storage credentials and wallet grants still ask to unlock in each tab.
 * Off: every page load starts locked, and nothing is kept between them.
 */

import { useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { BROWSER_KEY_DEFAULTS } from '@/lib/auth'
import { askToUnlockEveryVisit } from '@/lib/auth/vault'
import { KEPT_IDLE_MS, KEPT_TTL_MS } from '@/lib/auth/session-resume'
import { errorMessage } from '@/lib/utils'

const HOUR_MS = 60 * 60 * 1000

export function SecurityPanel(): JSX.Element {
  const { controller, storage } = useAuth()
  const [stay, setStay] = useState(() => !askToUnlockEveryVisit())
  // A pasted key is held in this tab only and never kept (QW2-026): the preference does not
  // apply to it, so it is shown off and disabled, saying why (it still applies to stored keys).
  const pasted = storage === 'session'
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
        <input
          type="checkbox"
          className="mt-0.5"
          checked={stay && !pasted}
          disabled={pasted}
          aria-describedby="stay-signed-in-note"
          onChange={(e) => toggle(e.target.checked)}
          data-testid="stay-signed-in"
        />
        <span className={pasted ? 'opacity-75' : undefined}>
          <span className="font-medium">Stay signed in for public repos (up to {KEPT_TTL_MS / HOUR_MS} h)</span>
          <span id="stay-signed-in-note" className="block text-[12px] text-anvil-500 dark:text-anvil-400">
            {pasted
              ? 'Not for a pasted key: it is held in this tab only and is gone after a reload. Import your identity file or recovery phrase to get a key this browser can keep.'
              : stay
              ? `Keeps a spend-capped signing key in this browser (a browser key: ${BROWSER_KEY_DEFAULTS.budgetDash} DASH and ${BROWSER_KEY_DEFAULTS.days} days by default; never a key without a budget, an expiry or Forge-only bounds), so reloads and new tabs stay signed in for public repos: for up to ${KEPT_TTL_MS / HOUR_MS} hours after you unlock, and until ${KEPT_IDLE_MS / HOUR_MS} hours pass without using Forge in this browser. Private repos, storage credentials and wallet grants still ask you to unlock.`
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
