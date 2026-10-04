'use client'

/**
 * `/networks` — which Dash Platform network this site uses, and where Forge stands on the others
 * (R9: one place for what README and guide headers used to repeat). The table comes from the
 * bundled deployment files (`lib/networks.ts`); the history behind it is in docs/networks.md.
 */

import { ExternalLink } from 'lucide-react'
import { AppShell } from '@/components/app-shell'
import { faucetUrl } from '@/components/top-up-sheet'
import { ACTIVE_NETWORK } from '@/lib/constants'
import { DOCS } from '@/lib/docs-links'
import { networkRows, type NetworkRow } from '@/lib/networks'
import { cn } from '@/lib/utils'

const STANDING: Readonly<Record<NetworkRow['standing'], string>> = {
  live: 'Live',
  'not-yet': 'Not yet',
  retired: 'Retired',
}

function detailOf(row: NetworkRow): string {
  if (row.standing === 'retired') return 'Forge has left this network. Its repositories, issues and identities are gone.'
  if (row.standing === 'not-yet') return 'Forge isn’t deployed here yet.'
  return row.test ? 'A test network: DASH is free and has no value, and the network can be reset.' : 'Real DASH: writes cost real money.'
}

/** `Devnet sakura` mid-sentence: `devnet sakura` (Testnet and Mainnet stay as they are). */
const inSentence = (label: string): string => (label.startsWith('Devnet ') ? `d${label.slice(1)}` : label)

function External({ href, children }: { href: string; children: string }): JSX.Element {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="hit-area inline-flex items-center gap-1 text-forge-700 underline dark:text-forge-400">
      {children} <ExternalLink className="h-3 w-3" aria-hidden />
    </a>
  )
}

export default function NetworksPage(): JSX.Element {
  const rows = networkRows()
  const here = rows.find((r) => r.key === ACTIVE_NETWORK.key)
  const faucet = faucetUrl()
  return (
    <AppShell>
      <div className="mx-auto max-w-3xl space-y-4" data-testid="networks">
        <div>
          <h1 className="text-2xl">Networks</h1>
          <p className="mt-2 text-prose text-anvil-600 dark:text-anvil-300">
            Dash Forge runs on Dash Platform. Each network has its own identities, repositories and DASH, and nothing moves between them.
          </p>
        </div>

        <section aria-labelledby="networks-here" className="rounded-lg border border-anvil-200 bg-white p-4 dark:border-anvil-800 dark:bg-anvil-900">
          <h2 id="networks-here" className="text-prose font-semibold">
            This site
          </h2>
          <p className="mt-2 text-dense text-anvil-700 dark:text-anvil-300" data-testid="networks-active">
            This site uses <strong>{here ? inSentence(here.label) : ACTIVE_NETWORK.key}</strong>.{' '}
            {ACTIVE_NETWORK.network === 'mainnet' ? (
              'Writes are paid in real DASH.'
            ) : (
              <>
                Its DASH is free test money{faucet ? (
                  <>
                    {' '}from the <External href={faucet}>faucet</External>
                  </>
                ) : null}
                . If the network is reset, its repositories and identities go with it; your git clones and your own storage are not
                affected.
              </>
            )}
          </p>
        </section>

        <section aria-labelledby="networks-all" className="rounded-lg border border-anvil-200 bg-white dark:border-anvil-800 dark:bg-anvil-900">
          <h2 id="networks-all" className="px-4 pt-4 text-prose font-semibold">
            All networks
          </h2>
          <table className="mt-2 w-full text-left text-dense">
            <thead className="sr-only">
              <tr>
                <th scope="col">Network</th>
                <th scope="col">Status</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-t border-anvil-200 align-top dark:border-anvil-800" data-testid={`network-${row.key}`}>
                  <th scope="row" className="px-4 py-2 font-semibold text-anvil-900 dark:text-anvil-50">
                    {row.label}
                    {row.key === ACTIVE_NETWORK.key ? <span className="ml-2 font-normal text-anvil-500 dark:text-anvil-400">this site</span> : null}
                    <span className="mt-1 block whitespace-normal font-normal text-anvil-600 dark:text-anvil-400 sm:hidden">{detailOf(row)}</span>
                  </th>
                  <td className="whitespace-nowrap py-2 pr-4">
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[12px]',
                        row.standing === 'live' ? 'bg-dash/10 text-dash-600 dark:text-dash-400' : 'bg-anvil-100 text-anvil-600 dark:bg-anvil-800 dark:text-anvil-300',
                      )}
                    >
                      {STANDING[row.standing]}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-anvil-600 max-sm:hidden dark:text-anvil-400">{detailOf(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <p className="text-dense text-anvil-600 dark:text-anvil-400">
          Moved from an earlier devnet? <External href={DOCS.devnetMove}>What a move keeps and how to push again</External>. The full history is
          in <External href={DOCS.networks}>the networks record</External>.
        </p>
      </div>
    </AppShell>
  )
}
