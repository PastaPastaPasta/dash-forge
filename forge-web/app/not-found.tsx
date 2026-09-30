import Link from 'next/link'
import { AppShell } from '@/components/app-shell'
import { shortUrlShimScript } from '@/lib/short-url'

/**
 * The static export's `404.html`. A static host (GitHub Pages, an IPFS gateway, the e2e
 * server) answers every unknown path with it, so it carries the short-URL shim
 * (`ux-dx-spec.md` §5.2): an inline script that rewrites `/owner/name/…` to the canonical
 * query-param route before anything else loads. Real 404s fall through to the message, inside
 * the app's chrome (header, search, sign-in, footer), as GitHub's 404 keeps its own (QW2-074).
 */
export default function NotFound(): JSX.Element {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: shortUrlShimScript() }} />
      <AppShell>
        <div data-testid="not-found" className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center text-center">
          <h1 className="text-xl">Nothing here</h1>
          <p className="mt-2 text-dense text-anvil-600 dark:text-anvil-300">
            This address is not a page of Dash Forge. Repo links look like <span className="font-mono">/owner/name</span>.
          </p>
          <Link href="/" className="hit-area mt-4 text-dense text-forge-700 underline dark:text-forge-400">
            Discover repos
          </Link>
        </div>
      </AppShell>
    </>
  )
}
