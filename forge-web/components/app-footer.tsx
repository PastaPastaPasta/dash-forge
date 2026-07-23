/** App footer — quiet provenance strip. States the honest trust posture and zero-backend fact. */

import Link from 'next/link'

export function AppFooter(): JSX.Element {
  return (
    <footer className="mt-16 border-t border-anvil-200 dark:border-anvil-800">
      <div className="mx-auto flex max-w-[1280px] flex-col gap-2 px-4 py-6 text-[12px] text-anvil-500 dark:text-anvil-400 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>
          Dash Forge — a git forge with no server to trust. Zero backend; every read
          proof-verified against Platform.
        </p>
        <div className="flex items-center gap-4">
          <span className="font-mono">trust-minimized</span>
          <Link href="/" className="hover:text-anvil-800 dark:hover:text-anvil-100">
            Discover
          </Link>
          <Link href="/new" className="hover:text-anvil-800 dark:hover:text-anvil-100">
            New repo
          </Link>
        </div>
      </div>
    </footer>
  )
}
