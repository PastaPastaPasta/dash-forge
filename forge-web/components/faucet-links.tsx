/**
 * The "get test DASH" links of a funding screen (`lib/faucets.ts`): the first faucet as the main
 * link, any others as "or from <host>". Nothing on mainnet (no links given).
 */

import { ACTIVE_NETWORK } from '@/lib/constants'
import { faucetHost } from '@/lib/faucets'

const LINK = 'text-forge-700 underline dark:text-forge-400'

export function FaucetLinks({ urls, suffix = '' }: { urls: readonly string[]; suffix?: string }): JSX.Element | null {
  const [first, ...others] = urls
  if (first === undefined) return null
  return (
    <p className="text-center text-dense" data-testid="faucet-links">
      <a href={first} target="_blank" rel="noreferrer noopener" className={LINK}>
        Get test DASH from the {ACTIVE_NETWORK.key} faucet
      </a>
      {suffix}
      {others.map((url) => (
        <span key={url}>
          {' '}
          or{' '}
          <a href={url} target="_blank" rel="noreferrer noopener" className={LINK}>
            {faucetHost(url)}
          </a>
        </span>
      ))}
    </p>
  )
}
