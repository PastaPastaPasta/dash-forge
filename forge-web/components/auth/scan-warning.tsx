'use client'

/**
 * The anti-phishing note on the wallet QR step (SECU-08). The request a wallet answers names
 * Forge's contract and the label "Dash Forge" and nothing about who displays it, so any page can
 * show a code that looks like this one. The wallet's approval screen cannot tell them apart; the
 * address bar can. Says where to scan, what a scan grants and the only way to undo it. Copy only:
 * how the login derives and delivers the encryption key is unchanged (DESIGN D27).
 */

import Link from 'next/link'
import { ShieldAlert } from 'lucide-react'
import { useUiStore } from '@/hooks/use-ui-store'
import { servedCid } from '@/lib/build-info'
import { SITE_HOST } from '@/lib/site'
import { DOCS } from '@/lib/docs-links'

/**
 * The address to check: this build's site, or, on a copy served by CID from an IPFS gateway (the
 * release build, which cannot know its own address), the gateway host the page is on, with a
 * pointer to checking the CID against the release.
 */
function hostToCheck(): { host: string; ipfs: boolean } {
  if (typeof window !== 'undefined' && (process.env.FORGE_IPFS_BUILD === '1' || servedCid(window.location) !== null)) {
    return { host: window.location.host, ipfs: true }
  }
  return { host: SITE_HOST, ipfs: false }
}

export function ScanOnlyHere({ host: given }: { host?: string }): JSX.Element {
  const closeLogin = useUiStore((s) => s.closeLogin)
  const here = hostToCheck()
  const host = given ?? here.host
  return (
    <div role="note" data-testid="scan-warning" className="space-y-1 rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense">
      <p className="flex gap-2 font-medium">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-caution-700 dark:text-caution-400" aria-hidden />
        <span>
          Scan only a code shown on <span className="font-mono" data-testid="scan-host">{host}</span>.
        </span>
      </p>
      <ul className="list-disc space-y-0.5 pl-10 text-[12px] text-anvil-700 dark:text-anvil-300">
        <li>
          Forge never asks you to scan a code it didn’t show you here. A lookalike site can show a code that looks the same, so
          check the address bar first
          {here.ipfs && given === undefined ? ', and check this copy’s CID against the release (see “Verify the app” in the guides)' : ''}.
        </li>
        <li>
          An approval gives a key that can sign as you on Forge (an Android wallet’s key works on any Platform app), with no spending
          limit or expiry unless your wallet sets one; today’s wallets don’t.
        </li>
        <li>It also gives the encryption key that opens your private and members-only content.</li>
        <li>
          If you scanned a code you didn’t trust:{' '}
          <Link href="/settings/keys/" onClick={closeLogin} className="text-forge-700 underline dark:text-forge-400" data-testid="scan-warning-keys">
            Settings → Devices &amp; keys → Disable all other keys
          </Link>{' '}
          (needs your recovery phrase or identity file), then replace your encryption key.{' '}
          <a href={DOCS.revokeKeys} target="_blank" rel="noreferrer noopener" className="text-forge-700 underline dark:text-forge-400">
            How
          </a>
        </li>
      </ul>
    </div>
  )
}
