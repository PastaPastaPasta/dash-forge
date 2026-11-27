'use client'

/**
 * The anti-phishing note on the wallet QR step (SECU-08). The request a wallet answers names
 * Forge's contract and the label "Dash Forge" and nothing about who displays it, so any page can
 * show a code that looks like this one. The wallet's approval screen cannot tell them apart; the
 * address bar can. Says where to scan, what a scan grants and the only way to undo it.
 */

import Link from 'next/link'
import { ShieldAlert } from 'lucide-react'
import { useUiStore } from '@/hooks/use-ui-store'
import { isImmutableCopy } from '@/lib/new-build'
import { SITE_HOST } from '@/lib/site'
import { DOCS } from '@/lib/docs-links'
import { ACTIVE_NETWORK } from '@/lib/constants'

/**
 * The address to check: this build's site, or, on a copy served by CID from an IPFS gateway (the
 * release build, which cannot know its own address), the gateway host the page is on, with a
 * pointer to checking the CID against the release.
 */
function hostToCheck(): { host: string; ipfs: boolean } {
  if (typeof window !== 'undefined' && isImmutableCopy(window.location)) {
    return { host: window.location.host, ipfs: true }
  }
  return { host: SITE_HOST, ipfs: false }
}

/** One line under the QR: where to scan. The rest is in {@link ScanSafety}, under Details. */
export function ScanOnlyHere({ host: given }: { host?: string }): JSX.Element {
  const host = given ?? hostToCheck().host
  return (
    <p role="note" data-testid="scan-warning" className="flex items-center justify-center gap-1.5 text-[12px] text-anvil-500 dark:text-anvil-400">
      <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        Only scan codes shown on <span className="font-mono" data-testid="scan-host">{host}</span>
      </span>
    </p>
  )
}

/** Why: what a lookalike can do, what an approval gives (within the limits above it), and the undo. */
export function ScanSafety({ syncs = ACTIVE_NETWORK.v2?.user !== undefined }: { syncs?: boolean }): JSX.Element {
  const closeLogin = useUiStore((s) => s.closeLogin)
  const here = hostToCheck()
  return (
    <ul className="list-disc space-y-1 pl-4" data-testid="scan-safety">
      <li>
        A lookalike site can show a code that looks the same, so check the address bar
        {here.ipfs ? ', and check this copy’s CID against the release (see “Verify the app” in the guides)' : ''}.
      </li>
      <li data-testid="scan-warning-limits">An approval gives this browser a key that signs as you on Forge, within the limits above.</li>
      <li>
        Scanned a code you didn’t trust?{' '}
        <Link href="/settings/keys/#disable" onClick={closeLogin} className="text-forge-700 underline dark:text-forge-400" data-testid="scan-warning-keys">
          Disable its key
        </Link>{' '}
        (
        <Link prefetch={false} href={DOCS.revokeKeys} target="_blank" rel="noreferrer noopener" className="text-forge-700 underline dark:text-forge-400">
          how
        </Link>
        ).
      </li>
      {syncs && (
        <li data-testid="scan-warning-sync">
          An approval can also give the key that reads the storage settings you sync, credentials included. Disabling keys
          doesn’t take that back:{' '}
          <Link prefetch={false} href={DOCS.moveSyncKey} target="_blank" rel="noreferrer noopener" className="text-forge-700 underline dark:text-forge-400" data-testid="scan-warning-rotate">
            move sync to a new key
          </Link>
          .
        </li>
      )}
    </ul>
  )
}
