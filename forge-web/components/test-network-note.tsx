/**
 * The "this is a test network" note of /start (WEB-05): on any build that is not mainnet, say
 * that the DASH is free test money with no value, where to get it (`lib/faucets.ts`), and that
 * the network can be reset. Renders nothing on mainnet.
 */

import { ExternalLink } from 'lucide-react'
import { ACTIVE_NETWORK, networkName, type NetworkConfig } from '@/lib/constants'
import { faucetHost, faucetUrls } from '@/lib/faucets'

const LINK = 'hit-area inline-flex items-center gap-1 text-forge-700 underline dark:text-forge-400'

export function TestNetworkNote({ config = ACTIVE_NETWORK }: { config?: NetworkConfig }): JSX.Element | null {
  if (config.network === 'mainnet') return null
  const faucets = faucetUrls(config)
  return (
    <p className="rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-caution-800 dark:text-caution-300" data-testid="start-test-network">
      This site runs on <strong>{networkName(config)}</strong>, a test network. Its DASH is free test money with no value
      {faucets.length > 0 ? (
        <>
          , from {faucets.length === 1 ? 'the faucet' : 'the faucets'}:{' '}
          {faucets.map((url, i) => (
            <span key={url}>
              {i > 0 ? ' or ' : null}
              <a href={url} target="_blank" rel="noreferrer noopener" className={LINK}>
                {faucetHost(url)}
                <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            </span>
          ))}
        </>
      ) : null}
      , and the network can be reset.
    </p>
  )
}
