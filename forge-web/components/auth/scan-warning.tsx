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
import { SITE_HOST } from '@/lib/site'

export function ScanOnlyHere({ host = SITE_HOST }: { host?: string }): JSX.Element {
  const closeLogin = useUiStore((s) => s.closeLogin)
  return (
    <div role="note" data-testid="scan-warning" className="space-y-1 rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense">
      <p className="flex gap-2 font-medium">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-caution-700 dark:text-caution-400" aria-hidden />
        <span>
          Scan only a code shown on <span className="font-mono" data-testid="scan-host">{host}</span>.
        </span>
      </p>
      <ul className="list-disc space-y-0.5 pl-10 text-[12px] text-anvil-700 dark:text-anvil-300">
        <li>A lookalike site can show a code that looks the same. Check the address bar first.</li>
        <li>An approval gives a key that signs Forge writes as you, up to the budget your wallet sets.</li>
        <li>It also gives the encryption key that opens your private and members-only content.</li>
        <li>
          Only disabling the key undoes an approval:{' '}
          <Link href="/settings/keys/" onClick={closeLogin} className="text-forge-700 underline dark:text-forge-400" data-testid="scan-warning-keys">
            Settings → Devices &amp; keys → Disable
          </Link>
          .
        </li>
      </ul>
    </div>
  )
}
