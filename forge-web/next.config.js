/** @type {import('next').NextConfig} */
// Adapted from yappr's proven static-export + WASM config.
// Key requirements for @dashevo/evo-sdk (WASM):
//   - output: 'export' (static SPA, deployable to IPFS / any static host — zero backend)
//   - the SDK built unbundled, its wasm a separately fetched asset (see evoSdkDist below)
//   - @dashevo chunk splitting to keep the SDK's JS in its own lazily-loaded chunk
//   - COOP/COEP 'credentialless' headers (dev only; static hosts set these themselves)
// CSP is delivered via <meta> in app/layout.tsx so it survives static export.
//
// Deviations from yappr: no build-time git-info injection (kept the config pure and
// dependency-free so the scaffold builds without a git checkout), and no basePath yet.

// For project-site GitHub Pages the app is served under /<repo>. Set
// NEXT_PUBLIC_BASE_PATH=/dash-forge in that deploy; unset for root/IPFS/custom-domain.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

// The Platform SDK, built from its unbundled modules (D-025). The published
// `@dashevo/evo-sdk` entry is one file with the 23 MB wasm inlined as base64 gzip (an ~8 MB
// chunk that webpack's chunk timeout killed on a slow link, with no progress and no retry).
// Instead: evo-sdk's own ES modules, with its wasm loader (`dist/wasm.js`, which imports that
// inlined build) replaced by lib/sdk/wasm-shim.ts over wasm-sdk's plain wasm-bindgen glue. The
// `.wasm` becomes a separate hashed static asset that lib/sdk/wasm-fetch.ts downloads with
// progress, compiles while streaming, and retries. Both paths bypass the package `exports`
// map, which only exposes the bundled entry.
const path = require('node:path');
const fs = require('node:fs');
// Both are direct dependencies; neither exports its package.json, so resolve the directories.
const pkgDir = (name) => fs.realpathSync(path.join(__dirname, 'node_modules', name));
const evoSdkDist = path.join(pkgDir('@dashevo/evo-sdk'), 'dist');
const WASM_FILE = path.join(pkgDir('@dashevo/wasm-sdk'), 'dist', 'raw', 'wasm_sdk_bg.wasm');

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
  env: {
    // The wasm's size, so the download can show a percentage whatever the host's encoding.
    FORGE_WASM_SDK_BYTES: String(fs.statSync(WASM_FILE).size),
  },
  webpack: (config, { isServer, webpack }) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      '@dashevo/evo-sdk$': path.join(evoSdkDist, 'sdk.js'),
    };
    // evo-sdk's modules import their loader relatively (`./wasm.js`, `../wasm.js`).
    const evoWasmLoader = path.join(evoSdkDist, 'wasm.js');
    const shim = path.resolve(__dirname, 'lib/sdk/wasm-shim.ts');
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(/wasm\.js$/, (resource) => {
        if (resource.context && path.resolve(resource.context, resource.request) === evoWasmLoader) {
          resource.request = shim;
        }
      }),
    );
    // The wasm is a file to fetch (`new URL(…, import.meta.url)`), never a webpack wasm module.
    config.module.rules.push({
      test: /[\\/]wasm_sdk_bg\.wasm$/,
      type: 'asset/resource',
      generator: { filename: 'static/wasm/[name].[contenthash:16][ext]', emit: !isServer },
    });
    // Keep the evo-sdk in its own chunk so it loads lazily, post-paint.
    if (!isServer) {
      // The SDK's JS chunk is now ~580 kB (63 kB gzipped), but a slow link can still take a
      // while over it next to the wasm download: give chunks 10 minutes, not 120 s.
      config.output.chunkLoadTimeout = 600_000;
      config.optimization = {
        ...config.optimization,
        splitChunks: {
          chunks: 'all',
          cacheGroups: {
            dashevo: {
              // JS only: the wasm asset's URL module is referenced from first-paint code
              // (lib/sdk/wasm-fetch.ts) and would drag this whole chunk into it.
              test: (module) => /[\\/]node_modules[\\/]@dashevo[\\/].*\.js$/.test(module.resource ?? ''),
              name: 'evo-sdk',
              priority: 10,
              reuseExistingChunk: true,
            },
          },
        },
      }
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
