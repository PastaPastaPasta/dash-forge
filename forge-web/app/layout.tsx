import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Providers } from '@/components/providers'
import { prehydrationScript } from '@/lib/prehydration'
import './globals.css'

export const metadata: Metadata = {
  title: 'Dash Forge',
  description:
    'Zero-backend git forge on Dash Platform. Browse code and collaborate on issues, with proof-checked reads.',
}

// CSP is delivered via <meta> so it survives static export (yappr pattern).
// - script 'wasm-unsafe-eval': the evo-sdk WASM runtime. JS 'unsafe-eval' is not granted
//   (verified: reads, writes and sign-in run without it). 'unsafe-inline' stays for Next's
//   inline bootstrap scripts.
// - frame-ancestors is not here: browsers ignore it in a <meta> CSP (and log an error on every
//   page). The host must send it as a header; on Pages, Cloudflare adds it (docs/hosting.md §7).
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
        {/* Before the body: a tap on a button before the app hydrates is kept and replayed. */}
        <script dangerouslySetInnerHTML={{ __html: prehydrationScript() }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
