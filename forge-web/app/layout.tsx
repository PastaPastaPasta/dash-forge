import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Providers } from '@/components/providers'
import { LOCAL_HTTP_ALLOWED } from '@/lib/net'
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
// - frame-ancestors is ignored in a <meta> CSP; the host must send it as a header (GitHub
//   Pages cannot; see docs/guides/identity-and-keys.md).
// - connect-src https:/wss:: DAPI endpoints + IPFS/S3/HTTPS pack backends. Plain http to this
//   machine is allowed ONLY in devnet and dev builds (`LOCAL_HTTP_ALLOWED`: a local MinIO or
//   kubo while developing); production builds never open it, for any page. Readers never
//   fetch loopback or private hosts anyway (`lib/net.ts`), and nothing loopback is ever
//   recorded on chain.
// - worker-src blob:: materialization / search / pack workers run off-main-thread.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https: blob:",
  "font-src 'self'",
  `connect-src 'self' https: wss:${LOCAL_HTTP_ALLOWED ? ' http://127.0.0.1:* http://localhost:*' : ''}`,
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "frame-ancestors 'none'",
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
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
