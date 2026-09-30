/** @type {import('next').NextConfig} */
// Adapted from yappr's proven static-export + WASM config.
// Key requirements for @dashevo/evo-sdk (WASM):
//   - output: 'export' (static SPA, deployable to IPFS / any static host — zero backend)
//   - the SDK built unbundled, its wasm a separately fetched asset (see evoSdkDist below)
//   - @dashevo chunk splitting to keep the SDK's JS in its own lazily-loaded chunk
//   - COOP/COEP 'credentialless' headers (dev only; static hosts set these themselves)
// CSP is delivered via <meta> in app/layout.tsx so it survives static export.
//
// Reproducible (docs/guides/verify-the-app.md): one commit gives byte-identical output. The
// build id is the commit (Next's default is random), and nothing reads the clock. The
// canonical build is scripts/ipfs-release.sh, which also pins the toolchain.

// The commit this build is from, when the build is told (a full commit id in FORGE_BUILD_COMMIT):
// the Pages deploy of master (pages.yml) and the IPFS release build (scripts/ipfs-release.sh).
// Any other build leaves it empty. No git call: a local or PR build's HEAD may not be on master,
// and the /mirror wizard pins the Mirror Action to this commit. The footer shows it too.
const commit = /^[0-9a-f]{40}$/.test(process.env.FORGE_BUILD_COMMIT || '') ? process.env.FORGE_BUILD_COMMIT : '';

// The IPFS variant (FORGE_IPFS_BUILD=1, scripts/ipfs-release.sh): one build that runs from any
// path, `/ipfs/<cid>/` on a path gateway as well as the root of a subdomain gateway or a host.
// The CID is only known after the build, so the base path is read from the URL at run time:
// the client's router base path and webpack public path below, and a <base> that
// scripts/ipfs-postbuild.mjs puts first in every page (whose asset URLs it makes relative).
const ipfsBuild = process.env.FORGE_IPFS_BUILD === '1';

// For project-site GitHub Pages the app is served under /<repo>. Set
// NEXT_PUBLIC_BASE_PATH=/dash-forge in that deploy; unset for root/IPFS/custom-domain.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
if (ipfsBuild && basePath) {
  throw new Error('FORGE_IPFS_BUILD finds its base path at run time; unset NEXT_PUBLIC_BASE_PATH');
}
// The IPFS variant's run-time base path (scripts/ipfs-base.cjs). From `self.location`, so it also
// holds in a worker (served from `<base>/_next/static/…`).
const { IPFS_BASE_PATH } = require('./scripts/ipfs-base.cjs');
const RUNTIME_BASE_PATH = `((/${IPFS_BASE_PATH}/.exec(self.location.pathname) || [""])[0])`;

/** Webpack's `__webpack_require__.p` (where chunks, workers and the wasm load from), at run time. */
class RuntimeBasePublicPath {
  constructor(webpack) {
    this.publicPath = webpack.RuntimeGlobals.publicPath;
  }
  apply(compiler) {
    compiler.hooks.thisCompilation.tap('RuntimeBasePublicPath', (compilation) => {
      compilation.hooks.runtimeModule.tap('RuntimeBasePublicPath', (module) => {
        if (module.name !== 'publicPath') return;
        module.generate = () => `${this.publicPath} = ${RUNTIME_BASE_PATH} + "/_next/";`;
      });
    });
  }
}

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
// The shim runs evo-sdk's JS over wasm-sdk's glue and wasm, taken from forge-web's own
// @dashevo/wasm-sdk. That must be the copy evo-sdk itself resolves (whatever range or peer
// dependency it declares): a mismatch compiles and then fails at runtime, so fail the build.
const evoOwnWasm = fs.realpathSync(path.join(pkgDir('@dashevo/evo-sdk'), '..', 'wasm-sdk'));
const wasmVersion = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
if (wasmVersion(evoOwnWasm) !== wasmVersion(pkgDir('@dashevo/wasm-sdk'))) {
  throw new Error(
    `@dashevo/evo-sdk runs on @dashevo/wasm-sdk ${wasmVersion(evoOwnWasm)}, but forge-web ships ` +
      `${wasmVersion(pkgDir('@dashevo/wasm-sdk'))} (lib/sdk/wasm-shim.ts); pin them to the same version`,
  );
}

const nextConfig = {
  trailingSlash: true,
  reactStrictMode: true,
  output: 'export',
  basePath,
  assetPrefix: basePath || undefined,
  // Next's default build id is random, and it lands in every page and in chunk hashes.
  generateBuildId: () => commit || 'unversioned',
  images: {
    // Static export cannot use the Next.js image optimizer.
    unoptimized: true,
  },
  env: {
    // The wasm's size, so the download can show a percentage whatever the host's encoding.
    FORGE_WASM_SDK_BYTES: String(fs.statSync(WASM_FILE).size),
    // The build's commit ('' unless the build was told): the /mirror wizard pins the Mirror Action
    // and its binaries to it (else it asks GitHub for master's latest), and "About this build"
    // in the footer shows it (lib/build-info.ts).
    FORGE_BUILD_COMMIT: commit,
    // The IPFS variant copies canonical links, not short ones (lib/short-url.ts).
    FORGE_IPFS_BUILD: ipfsBuild ? '1' : '',
  },
  webpack: (config, { dev, isServer, webpack }) => {
    if (!dev && !isServer) {
      // Reproducible output (docs/guides/verify-the-app.md). Two sources of run-to-run
      // variation, both seen between identical builds on one machine:
      // - Module ids. Webpack hashes each module's path into a range only ~20x the module count,
      //   so a few collide, and it settles collisions in module-graph order, which varies with
      //   timing: one module's id changed, and every chunk referring to it. A range this large
      //   has no collision in practice (~1 in 2,000 at a thousand modules); failOnConflict makes
      //   one a build error, not a random id. The fix for that commit is a `salt` here.
      // - Entry chunk names. Next names them by [chunkhash], which hashes webpack's module-graph
      //   state, and that varies under CPU load even when the chunk's bytes do not. [contenthash]
      //   names each file by its final bytes (webpack's realContentHash, on in production), and
      //   rewrites every reference (pages, manifests, the runtime) to match, as it already does
      //   for the lazy chunks.
      config.optimization.moduleIds = false;
      config.plugins.push(new webpack.ids.DeterministicModuleIdsPlugin({ maxLength: 9, failOnConflict: true }));
      config.output.filename = config.output.filename.replace('[chunkhash]', '[contenthash]');
      if (!config.output.filename.includes('[contenthash]') || config.optimization.realContentHash === false) {
        throw new Error(`reproducible chunk names: unexpected output.filename ${config.output.filename} (Next.js upgrade?)`);
      }
    }
    if (ipfsBuild && !isServer) {
      // Next writes the public path (`/_next/`) into the pages and the RSC payloads, which
      // ipfs-postbuild.mjs makes base-relative; the running client computes it instead.
      config.plugins.push(new RuntimeBasePublicPath(webpack));
      // The router's base path, and lib/short-url.ts' BASE_PATH. The prerendered pages keep ''
      // (the server compilation is untouched).
      const define = config.plugins.find(
        (p) => p instanceof webpack.DefinePlugin && 'process.env.__NEXT_ROUTER_BASEPATH' in p.definitions,
      );
      if (!define) throw new Error("FORGE_IPFS_BUILD: Next's DefinePlugin not found (Next.js upgrade?)");
      define.definitions['process.env.__NEXT_ROUTER_BASEPATH'] = RUNTIME_BASE_PATH;
      define.definitions['process.env.NEXT_PUBLIC_BASE_PATH'] = RUNTIME_BASE_PATH;
    }
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
