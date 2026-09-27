'use client'

/**
 * Top-up sheet (`ux-dx-spec.md` §4): shown when a write does not fit the balance or this
 * browser's key budget, or when Platform refused one for that reason (D-007). It says which
 * budget blocks and by how much, and offers the fix for that budget:
 * - the identity's balance: an asset-lock top-up from any Dash wallet, or a credit transfer
 *   from another identity (dev networks link the faucet);
 * - this key's budget: top up the same key (one master-key signature), or renew it;
 * - an expired or disabled key: renew it (a new key; the old one is disabled).
 */

import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore, type TopUpReason } from '@/hooks/use-ui-store'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { CopyRow } from '@/components/ui/copy-row'
import { KeyTopUpDialog } from '@/components/key-top-up-dialog'
import { ACTIVE_NETWORK } from '@/lib/constants'
import { STEADY, previewCreate } from '@/lib/sdk'
import { creditsAsDash } from '@/lib/view/format'

/** Where dev networks get test DASH (mainnet and testnet show no faucet, spec §2.1). */
export function faucetUrl(): string | null {
  if (process.env.NEXT_PUBLIC_FORGE_DEV !== '1' && ACTIVE_NETWORK.network !== 'devnet') return null
  if (ACTIVE_NETWORK.network === 'devnet') return `https://faucet.${ACTIVE_NETWORK.devnetName}.networks.dash.org`
  if (ACTIVE_NETWORK.network === 'testnet') return 'https://faucet.thepasta.org'
  return null
}

/** A typical issue (steady state) and how many fit in 0.05 DASH: the copy follows cost.ts. */
const ISSUE_DASH = previewCreate('issue', { title: 'A typical issue title' }, STEADY).dash
const WRITES_PER_005 = Math.floor(0.05 / ISSUE_DASH / 10) * 10

function short(shortfall: bigint | undefined): string {
  return shortfall && shortfall > 0n ? ` (short by ${creditsAsDash(Number(shortfall))} DASH)` : ''
}

/** What the sheet says blocks the write. */
function describeBlocker(reason: TopUpReason, balance: string | null): string {
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
  const { identity, storage, keyLimits, balance } = useAuth()
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
      description={describeBlocker(reason, balance)}
    >
      <div className="space-y-3 text-dense" data-testid="top-up-sheet" data-blocker={reason.blocker}>
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
            <p>
              Send DASH from any Dash wallet as an identity top-up (asset lock) to this identity, or ask anyone to
              transfer credits to it:
            </p>
            <CopyRow text={identity} label="Copy identity id" />
            <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
              About {ISSUE_DASH.toFixed(4)} DASH covers an issue; 0.05 DASH covers about {WRITES_PER_005} writes.
            </p>
          </>
        )}
        {faucet && !keyProblem ? (
          <a href={faucet} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-forge-700 underline dark:text-forge-400">
            {ACTIVE_NETWORK.key} faucet <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        ) : null}
      </div>
    </Dialog>
  )
}
