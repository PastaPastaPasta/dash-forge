/** App footer — quiet provenance strip. States the honest trust posture and zero-backend fact. */

import Link from 'next/link'

import { BuildInfo } from '@/components/build-info'
import { DOCS } from '@/lib/docs-links'
import { otherNetworkSite } from '@/lib/network-sites'

export function AppFooter(): JSX.Element {
  const testnet = otherNetworkSite()
  return (
    <footer className="mt-16 border-t border-anvil-200 dark:border-anvil-800">
      <div className="mx-auto flex max-w-[1280px] flex-col gap-2 px-4 py-5 text-[12px] text-anvil-500 dark:text-anvil-400 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>Dash Forge · Your browser verifies what it shows.</span>
          <span aria-hidden="true">·</span>
          <BuildInfo />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Link href="/start/" className="hit-area hover:text-anvil-800 dark:hover:text-anvil-100">
            Getting started
          </Link>
          <Link href={DOCS.guides} className="hit-area hover:text-anvil-800 dark:hover:text-anvil-100">
            User guides
          </Link>
          <Link href="/private/" className="hit-area hover:text-anvil-800 dark:hover:text-anvil-100">
            Private repos
          </Link>
          <Link href="/networks/" className="hit-area hover:text-anvil-800 dark:hover:text-anvil-100">
            Networks
          </Link>
          <Link href="/licenses/" className="hit-area hover:text-anvil-800 dark:hover:text-anvil-100">
            Licenses
          </Link>
          {testnet?.key === 'testnet' ? (
            <a href={testnet.url} data-testid="testnet-site-link" className="hit-area hover:text-anvil-800 dark:hover:text-anvil-100">
              Testnet
            </a>
          ) : null}
        </div>
      </div>
    </footer>
  )
}
