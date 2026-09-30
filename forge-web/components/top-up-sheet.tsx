'use client'

/**
 * Top-up sheet (`ux-dx-spec.md` §4): shown when a write does not fit the balance or this
 * browser's key budget, or when Platform refused one for that reason (D-007), and ahead of any
 * write from the low-funds banner, the funds pill or Settings (`proactive`: it then describes
 * the funds as they stand, QW-047). It says which budget blocks and by how much, and offers the
 * fix for that budget:
 * - the identity's balance: a top-up from this browser (a deposit address any Dash wallet or a
 *   devnet faucet can pay, QW-012), or a credit transfer from another identity;
 * - this key's budget: top up the same key (one master-key signature), or renew it;
 * - an expired or disabled key: renew it (a new key; the old one is disabled).
 */

import { useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore, type TopUpReason } from '@/hooks/use-ui-store'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { CopyRow } from '@/components/ui/copy-row'
import { KeyTopUpDialog } from '@/components/key-top-up-dialog'
import { IdentityTopUpFlow } from '@/components/identity-top-up-flow'
import { KeyFundsLine } from '@/components/funds-summary'
import { ACTIVE_NETWORK } from '@/lib/constants'
import { typicalIssueCredits } from '@/lib/sdk'
import { issueCoverage, type KeyLimits } from '@/lib/view/funds'
import { creditsAsDash, formatDate } from '@/lib/view/format'

/** Where dev networks get test DASH (mainnet and testnet show no faucet, spec §2.1). */
export function faucetUrl(): string | null {
  if (process.env.NEXT_PUBLIC_FORGE_DEV !== '1' && ACTIVE_NETWORK.network !== 'devnet') return null
  if (ACTIVE_NETWORK.network === 'devnet') return `https://faucet.${ACTIVE_NETWORK.devnetName}.networks.dash.org`
  if (ACTIVE_NETWORK.network === 'testnet') return 'https://faucet.thepasta.org'
  return null
}

/**
 * What "an issue" costs in copy: the same figure the sign-in chooser and the New issue form quote
 * (`typicalIssueCredits`, QW-043).
 */
const ISSUE_CREDITS = typicalIssueCredits()

function short(shortfall: bigint | undefined): string {
  return shortfall && shortfall > 0n ? ` (short by ${creditsAsDash(Number(shortfall))} DASH)` : ''
}

/** What the sheet says blocks the write, or (opened ahead of any write) how the funds stand. */
export function describeBlocker(reason: TopUpReason, balance: string | null, keyLimits: KeyLimits | null = null, now = Date.now()): string {
  if (reason.proactive) {
    const left = keyLimits?.remaining != null && keyLimits.total != null ? `${creditsAsDash(Number(keyLimits.remaining))} of ${creditsAsDash(Number(keyLimits.total))} DASH` : null
    switch (reason.blocker) {
      case 'balance':
        return `Your identity's balance is ${balance !== null ? `${creditsAsDash(Number(balance))} DASH` : 'being read'}. Every write is paid from it; reading is free.`
      case 'key-budget':
        return `This browser's key has ${left ?? 'little'}${left ? ' of budget' : ' budget'} left. Top it up or renew it before your next write.`
      case 'key-expiry':
        if (keyLimits?.expiresAt != null && keyLimits.expiresAt > now) return `This browser's key expires on ${formatDate(keyLimits.expiresAt)}. Renew it to keep writing from this browser.`
        return "This browser's key has expired. Reading still works."
      default:
        break
    }
  }
  switch (reason.blocker) {
    case 'key-expiry':
      return "This browser's key has expired. Reading still works."
    case 'key-disabled':
      return "This browser's key was disabled on Platform. Reading still works."
    case 'key-missing':
      return "This browser's key is not on this identity. Reading still works."
    case 'key-level':
      return "This browser's key cannot sign Forge writes. Reading still works."
    case 'key-budget':
      return `This browser's key does not have enough budget left for this write${short(reason.shortfall)}. Reading still works.`
    case 'balance':
      return `Your identity's balance${balance !== null ? ` (${creditsAsDash(Number(balance))} DASH)` : ''} does not cover this write${short(reason.shortfall)}. Reading still works; drafts stay here.`
  }
}

export function TopUpSheet(): JSX.Element | null {
  const reason = useUiStore((s) => s.topUp)
  const close = useUiStore((s) => s.closeTopUp)
  const openLogin = useUiStore((s) => s.openLogin)
  const { identity, storage, keyLimits, balance, funds } = useAuth()
  const [other, setOther] = useState(false)
  const [topUpKey, setTopUpKey] = useState(false)
  if (identity === null) return null
  if (topUpKey) return <KeyTopUpDialog onClose={() => setTopUpKey(false)} />
  if (reason === null) return null
  const faucet = faucetUrl()
  const keyProblem = reason.blocker !== 'balance'
  // A stored Forge browser key with a budget can take more budget in place.
  const canTopUpKey = reason.blocker === 'key-budget' && storage === 'vault' && keyLimits?.total != null
  const renew = (): void => {
    close()
    openLogin('import')
  }
  let title = 'Top up credits'
  if (canTopUpKey) title = "Add budget to this browser's key"
  else if (keyProblem) title = "Renew this browser's key"

  return (
    <Dialog
      open
      onClose={close}
      title={title}
      description={describeBlocker(reason, balance, keyLimits)}
    >
      <div className="space-y-3 text-dense" data-testid="top-up-sheet" data-blocker={reason.blocker}>
        {reason.proactive ? <KeyFundsLine /> : null}
        {keyProblem ? (
          <>
            {canTopUpKey ? (
              <p>
                Top it up to keep this key and add budget, or renew it to get a new key and disable this one. Either way
                your identity file or recovery phrase signs once and is not stored.
              </p>
            ) : (
              <p>
                Renew it with your identity file or recovery phrase: the master key registers a fresh limited key for this
                browser, disables the old one, and is not stored.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {canTopUpKey ? (
                <Button
                  variant="primary"
                  onClick={() => {
                    close()
                    setTopUpKey(true)
                  }}
                >
                  Top up key
                </Button>
              ) : null}
              <Button variant={canTopUpKey ? 'outline' : 'primary'} onClick={renew}>
                Renew key
              </Button>
            </div>
          </>
        ) : (
          <>
            {/* From this browser: a deposit address any wallet (or the faucet) can pay (QW-012). */}
            <IdentityTopUpFlow faucet={faucet} />
            <p className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="top-up-coverage">
              {issueCoverage(funds?.spendable ?? null, ISSUE_CREDITS, creditsAsDash)}
            </p>
            <div>
              <button type="button" aria-expanded={other} onClick={() => setOther((o) => !o)} className="hit-area text-[12px] text-anvil-500 underline hover:text-anvil-800 dark:text-anvil-400 dark:hover:text-anvil-100">
                Other ways to add credits
              </button>
              {other ? (
                <div className="mt-2 space-y-2" data-testid="top-up-other-ways">
                  <p className="text-[12px] text-anvil-600 dark:text-anvil-300">
                    A wallet with identity support (Dash Wallet&apos;s DashPay, the Dash bridge) can top up this identity directly, and anyone
                    with credits can transfer some to it. Either way they need its ID:
                  </p>
                  <CopyRow text={identity} label="Copy identity id" />
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>
    </Dialog>
  )
}
