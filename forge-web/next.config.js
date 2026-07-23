/** @type {import('next').NextConfig} */
// Adapted from yappr's proven static-export + WASM config.
// Key requirements for @dashevo/evo-sdk (WASM):
//   - output: 'export' (static SPA, deployable to IPFS / any static host — zero backend)
//   - asyncWebAssembly webpack experiment
//   - @dashevo chunk splitting to keep the SDK in its own lazily-loaded chunk
//   - COOP/COEP 'credentialless' headers (dev only; static hosts set these themselves)
// CSP is delivered via <meta> in app/layout.tsx so it survives static export.
//
// Deviations from yappr: no build-time git-info injection (kept the config pure and
// dependency-free so the scaffold builds without a git checkout), and no basePath yet.

// For project-site GitHub Pages the app is served under /<repo>. Set
// NEXT_PUBLIC_BASE_PATH=/dash-forge in that deploy; unset for root/IPFS/custom-domain.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

const nextConfig = {
  trailingSlash: true,
  reactStrictMode: true,
  output: 'export',
  basePath,
  assetPrefix: basePath || undefined,
  images: {
    // Static export cannot use the Next.js image optimizer.
    unoptimized: true,
  },
  webpack: (config, { isServer }) => {
    // Keep the evo-sdk in its own chunk so it loads lazily, post-paint.
    if (!isServer) {
      config.optimization = {
        ...config.optimization,
        splitChunks: {
          chunks: 'all',
          cacheGroups: {
            dashevo: {
              test: /[\\/]node_modules[\\/]@dashevo[\\/]/,
              name: 'evo-sdk',
              priority: 10,
              reuseExistingChunk: true,
            },
          },
        },
      }
    }

    // Required for @dashevo/evo-sdk WASM modules.
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    }

    return config
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // CRITICAL for WASM threads: 'credentialless' (not 'require-corp') so
          // cross-origin images/gateways still load. Static hosts must replicate these.
          { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        ],
      },
    ]
  },
}

module.exports = nextConfig
