import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Providers } from '@/components/providers'
import './globals.css'

export const metadata: Metadata = {
  title: 'Dash Forge',
  description:
    'Zero-backend git forge on Dash Platform. Browse, review, and collaborate — proof-verified, served from IPFS.',
}

// CSP is delivered via <meta> so it survives static export (yappr pattern).
// - script 'unsafe-eval' + 'wasm-unsafe-eval': required by the evo-sdk WASM runtime.
// - connect-src https:/wss:: DAPI endpoints + IPFS/S3/HTTPS pack backends.
// - worker-src blob:: materialization / search / pack workers run off-main-thread.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https: blob:",
  "font-src 'self'",
  "connect-src 'self' https: wss:",
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
