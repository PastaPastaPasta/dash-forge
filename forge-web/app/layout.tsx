import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import { Providers } from '@/components/providers'
import { prehydrationScript } from '@/lib/prehydration'
import './globals.css'

const DESCRIPTION =
  'Repositories, issues and pull requests on Dash Platform, checked by your own browser. No company server to go down, no account to ban.'

/**
 * Where this build is served, for the absolute URLs a link preview needs (og:image must be
 * absolute). forge.dashhq.org unless a self-hosted deploy sets `NEXT_PUBLIC_SITE_URL`.
 */
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://forge.dashhq.org'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'Dash Forge',
  description: DESCRIPTION,
  applicationName: 'Dash Forge',
  openGraph: {
    type: 'website',
    siteName: 'Dash Forge',
    title: 'Dash Forge: a git forge with no server to trust',
    description: DESCRIPTION,
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Dash Forge: a git forge with no server to trust.' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Dash Forge: a git forge with no server to trust',
    description: DESCRIPTION,
    images: ['/og.png'],
  },
}

// The browser chrome follows the page: the light and dark page backgrounds (anvil-50, anvil-950).
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fafaf9' },
    { media: '(prefers-color-scheme: dark)', color: '#0f0d0c' },
  ],
}

/**
 * Where the manifest and icons in `public/` are linked from. The IPFS variant runs under a base
 * path only known at run time, so its links are relative to the <base> it sets
 * (scripts/ipfs-postbuild.mjs refuses a root-relative one); elsewhere they sit under the base path.
 */
const ASSETS = process.env.FORGE_IPFS_BUILD === '1' ? '' : `${process.env.NEXT_PUBLIC_BASE_PATH || ''}/`

// CSP is delivered via <meta> so it survives static export (yappr pattern).
// - script 'wasm-unsafe-eval': the evo-sdk WASM runtime. JS 'unsafe-eval' is not granted
//   (verified: reads, writes and sign-in run without it). 'unsafe-inline' stays for Next's
//   inline bootstrap scripts.
// - frame-ancestors is not here: browsers ignore it in a <meta> CSP (and log an error on every
//   page). The host must send it as a header; GitHub Pages cannot (docs/guides/identity-and-keys.md).
//   A framed page never restores a kept session (lib/auth/session-resume.ts `framed`).
// - connect-src https:/wss:: DAPI endpoints + IPFS/S3/HTTPS pack backends. Plain http to this
//   machine is allowed so the storage settings can reach the user's OWN local node (a kubo
//   RPC API, a MinIO endpoint), which is how kubo ships. It cannot be narrowed to one page: a
//   static export has one <meta> CSP, and several combine as an intersection. It is not a read
//   path: readers fetch only public https URLs (`lib/net.ts` `externalFetchUrls`), and nothing
//   loopback or private is ever recorded on chain (`fitManifestUris`, `publishProblem`).
// - worker-src blob:: materialization / search / pack workers run off-main-thread.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https: blob:",
  "font-src 'self'",
  "connect-src 'self' https: wss: http://127.0.0.1:* http://localhost:*",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "base-uri 'self'",
].join('; ')

export default function RootLayout({
  children,
}: {
  children: ReactNode
}): JSX.Element {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta httpEquiv="Content-Security-Policy" content={CSP} />
        <link rel="manifest" href={`${ASSETS}manifest.webmanifest`} />
        <link rel="apple-touch-icon" href={`${ASSETS}icons/apple-touch-icon.png`} />
        {/* Before the body: a tap on a button before the app hydrates is kept and replayed. */}
        <script dangerouslySetInnerHTML={{ __html: prehydrationScript() }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
