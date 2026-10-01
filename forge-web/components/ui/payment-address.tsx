'use client'

/**
 * A Dash deposit address the way wallet and exchange deposit screens show one (QW3-008): a QR
 * code carrying the payment URI, the address with a Copy button, and a link that opens a Dash
 * wallet on the same device with the address and amount filled in. On a phone the QR is no use
 * (the camera is the screen showing it), so Copy and the link are the way to pay.
 *
 * The URI is the BIP21-style `dash:<address>?amount=<DASH>` that Dash wallets register for
 * (Dash Core's `dash:` URI handler, the Dash Wallet apps).
 */

import { Wallet } from 'lucide-react'
import { CopyRow } from '@/components/ui/copy-row'
import { Qr } from '@/components/ui/qr'

/** `dash:<address>?amount=<DASH>` (amount in DASH, at most 8 decimals, no trailing zeros). */
export function dashPaymentUri(address: string, amountDash?: number): string {
  if (amountDash === undefined || !(amountDash > 0)) return `dash:${address}`
  const amount = amountDash.toFixed(8).replace(/\.?0+$/, '')
  return `dash:${address}?amount=${amount}`
}

export function PaymentAddress({ address, amountDash, label }: { address: string; amountDash?: number; label: string }): JSX.Element {
  const uri = dashPaymentUri(address, amountDash)
  return (
    <div className="space-y-2" data-testid="payment-address">
      <div className="flex justify-center">
        <Qr value={uri} caption={address} label={`${label} ${address}`} />
      </div>
      <CopyRow text={address} label={`Copy the ${label.toLowerCase()}`} />
      <a
        href={uri}
        data-testid="payment-uri"
        className="flex min-h-9 items-center justify-center gap-1.5 rounded-md border border-anvil-300 px-3 text-dense font-medium text-anvil-800 hover:bg-anvil-100 coarse:min-h-11 dark:border-anvil-700 dark:text-anvil-100 dark:hover:bg-anvil-850"
      >
        <Wallet className="h-3.5 w-3.5" aria-hidden /> Open in a Dash wallet
      </a>
    </div>
  )
}
