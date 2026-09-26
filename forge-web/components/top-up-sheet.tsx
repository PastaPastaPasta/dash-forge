'use client'

/**
 * Top-up sheet (`ux-dx-spec.md` §4): shown when a write does not fit the balance or this
 * browser's key budget. It says which budget blocks and by how much, how to add credits to the
 * identity (an asset-lock top-up from any Dash wallet, or a credit transfer from another
 * identity), and on dev networks links the faucet. A spent or expired key needs a renewal,
 * not credits.
 */

import { ExternalLink } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { Dialog } from '@/components/ui/dialog'
import { CopyRow } from '@/components/ui/copy-row'
import { ACTIVE_NETWORK } from '@/lib/constants'
import { creditsAsDash } from '@/lib/view/format'

/** Where dev networks get test DASH (mainnet and testnet show no faucet, spec §2.1). */
export function faucetUrl(): string | null {
  if (process.env.NEXT_PUBLIC_FORGE_DEV !== '1' && ACTIVE_NETWORK.network !== 'devnet') return null
  if (ACTIVE_NETWORK.network === 'devnet') return `https://faucet.${ACTIVE_NETWORK.devnetName}.networks.dash.org`
  if (ACTIVE_NETWORK.network === 'testnet') return 'https://faucet.thepasta.org'
  return null
}

export function TopUpSheet(): JSX.Element | null {
  const reason = useUiStore((s) => s.topUp)
  const close = useUiStore((s) => s.closeTopUp)
  const { identity } = useAuth()
  if (reason === null || identity === null) return null
  const faucet = faucetUrl()
  const keyProblem = reason.blocker !== 'balance'

  return (
    <Dialog
      open
      onClose={close}
      title={keyProblem ? "Renew this browser's key" : 'Top up credits'}
      description={
        reason.blocker === 'key-expiry'
          ? "This browser's key has expired. Reading still works."
          : reason.blocker === 'key-budget'
            ? `This browser's key has spent its budget${reason.shortfall ? ` (short by ${creditsAsDash(Number(reason.shortfall))} DASH)` : ''}. Reading still works.`
            : `Your identity's balance is too low${reason.shortfall ? ` (short by ${creditsAsDash(Number(reason.shortfall))} DASH)` : ''}. Reading still works; drafts stay here.`
      }
    >
      <div className="space-y-3 text-dense">
        {keyProblem ? (
          <p>
            Sign in again with your identity file or mnemonic to register a fresh limited key for this browser.
            Your master key is used once and not stored.
          </p>
        ) : (
          <>
            <p>
              Send DASH from any Dash wallet as an identity top-up (asset lock) to this identity, or ask anyone to
              transfer credits to it:
            </p>
            <CopyRow text={identity} label="Copy identity id" />
            <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
              ~0.0006 DASH covers an issue; 0.05 DASH covers about a hundred writes.
            </p>
          </>
        )}
        {faucet ? (
          <a href={faucet} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-forge-600 underline dark:text-forge-400">
            {ACTIVE_NETWORK.key} faucet <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        ) : null}
      </div>
    </Dialog>
  )
}
