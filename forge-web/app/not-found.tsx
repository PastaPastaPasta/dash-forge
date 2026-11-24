import Link from 'next/link'
import { AppShell } from '@/components/app-shell'
import { buttonClass } from '@/components/ui/button'
import { shortUrlShimScript } from '@/lib/short-url'

export default function NotFound(): JSX.Element {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: shortUrlShimScript() }} />
      <AppShell>
        <div data-testid="not-found" className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center text-center">
          <h1 className="text-xl">Nothing here</h1>
          <p className="mt-2 text-dense text-anvil-600 dark:text-anvil-300">
            This page doesn&apos;t exist.
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
            <Link href="/" className={buttonClass({ variant: 'primary' })}>
              Go home
            </Link>
            <Link href="/explore/" className={buttonClass({ variant: 'outline' })}>
              Explore repos
            </Link>
          </div>
        </div>
      </AppShell>
    </>
  )
}
