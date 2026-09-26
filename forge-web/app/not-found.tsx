import Link from 'next/link'
import { shortUrlShimScript } from '@/lib/short-url'

/**
 * The static export's `404.html`. A static host (GitHub Pages, an IPFS gateway, the e2e
 * server) answers every unknown path with it, so it carries the short-URL shim
 * (`ux-dx-spec.md` §5.2): an inline script that rewrites `/owner/name/…` to the canonical
 * query-param route before anything else loads. Real 404s fall through to the message.
 */
export default function NotFound(): JSX.Element {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: shortUrlShimScript() }} />
      <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-6 text-center">
        <h1 className="text-xl">Nothing here</h1>
        <p className="mt-2 text-dense text-anvil-600 dark:text-anvil-300">
          This address is not a page of Dash Forge. Repo links look like <span className="font-mono">/owner/name</span>.
        </p>
        <Link href="/" className="mt-4 text-dense text-forge-700 underline dark:text-forge-400">
          Discover repos
        </Link>
      </main>
    </>
  )
}
