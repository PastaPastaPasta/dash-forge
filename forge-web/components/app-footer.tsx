/** App footer — quiet provenance strip. States the honest trust posture and zero-backend fact. */

import Link from 'next/link'

import { BuildInfo } from '@/components/build-info'
import { DOCS } from '@/lib/docs-links'

export function AppFooter(): JSX.Element {
  return (
    <footer className="mt-16 border-t border-anvil-200 dark:border-anvil-800">
      <div className="mx-auto flex max-w-[1280px] flex-col gap-2 px-4 py-6 text-[12px] text-anvil-500 dark:text-anvil-400 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex flex-col gap-1">
          <p>Dash Forge: git hosting with no server. Your browser verifies what it shows.</p>
          <BuildInfo />
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <Link href="/start/" className="hit-area hover:text-anvil-800 dark:hover:text-anvil-100">
            Getting started
          </Link>
          <a href={DOCS.guides} target="_blank" rel="noreferrer noopener" className="hit-area hover:text-anvil-800 dark:hover:text-anvil-100">
            User guides
          </a>
          <Link href="/private/" className="hit-area hover:text-anvil-800 dark:hover:text-anvil-100">
            Private repositories
          </Link>
          <Link href="/networks/" className="hit-area hover:text-anvil-800 dark:hover:text-anvil-100">
            Networks
          </Link>
        </div>
      </div>
    </footer>
  )
}
