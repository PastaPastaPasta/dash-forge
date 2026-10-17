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

/**
 * Keeps the minifier's output from depending on webpack's provisional chunk hashes.
 *
 * The runtime chunk (`webpack-<hash>.js`) lists every lazy chunk's file name, so it contains
 * their `[contenthash]`es, as 16 hex digits each. At minify time those are provisional: webpack
 * names a chunk by a hash of its module graph state, which differs between two builds of one
 * commit (the same chunk, byte for byte, gets `2595-12ca…` in one and `2595-2db5…` in the next),
 * and only afterwards (`realContentHash`) renames each chunk by its final bytes and rewrites the
 * references. Terser (and SWC) order the names they mangle to by how often each letter occurs in
 * the file, and the hashes add `a`-`f`; when two letters tie, a different hash picks the other,
 * so one `a`/`f` swap renamed the runtime chunk and every page loading it, and the CID. Seen in
 * CI as the only difference between the x86_64 and arm64 builds, and reproduced here as two
 * different CIDs from the same commit on one machine.
 *
 * Fix: before the minifier, each provisional hash is replaced by a placeholder of the same
 * length that depends only on the chunk's name without its hash (stable from build to build);
 * after it, the hash is put back, so `realContentHash` finds what it expects.
 */
class StableMinifierInput {
  constructor(webpack) {
    this.webpack = webpack;
  }
  apply(compiler) {
    const { Compilation, sources } = this.webpack;
    const { createHash } = require('node:crypto');
    const pluginName = 'StableMinifierInput';
    const HEX16 = /(?<![0-9a-f])[0-9a-f]{16}(?![0-9a-f])/g;
    compiler.hooks.thisCompilation.tap(pluginName, (compilation) => {
      // placeholder -> provisional hash, and the assets that were rewritten
      const restore = new Map();
      const touched = new Set();
      const isJs = (name) => /\.[cm]?js(\?.*)?$/i.test(name);
      // Next's Terser plugin minifies at PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE: this runs just before
      // it, and the restore just after. (No `before: 'TerserPlugin'`: tapable puts a tap whose
      // `before` is not registered yet at the very front, ahead of its stage.)
      compilation.hooks.processAssets.tap(
        { name: pluginName, stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE - 1 },
        () => {
          const placeholders = new Map();
          for (const { name, info } of compilation.getAssets()) {
            [info.contenthash].flat().forEach((hash, i) => {
              if (typeof hash !== 'string' || !/^[0-9a-f]{16}$/.test(hash) || placeholders.has(hash)) return;
              const id = createHash('sha256').update(`${name.split(hash).join('[contenthash]')}#${i}`).digest('hex');
              // Hash-shaped, as every other 16-digit hash in the file; it only has to be the same
              // from build to build.
              placeholders.set(hash, id.slice(0, 16));
            });
          }
          for (const [hash, placeholder] of placeholders) {
            // Two assets whose names differ only by their hash (e.g. hash-only names) would share a
            // placeholder, and the restore would point both at one of them: refuse the build instead.
            const other = restore.get(placeholder);
            if (other !== undefined && other !== hash) {
              compilation.errors.push(new this.webpack.WebpackError(`${pluginName}: assets with hashes ${other} and ${hash} would share a placeholder; give them names that differ beyond the hash`));
              continue;
            }
            restore.set(placeholder, hash);
          }
          for (const { name, source, info } of compilation.getAssets()) {
            if (info.minimized || !isJs(name)) continue;
            const code = source.source().toString();
            let found = false;
            const replaced = code.replace(HEX16, (m) => {
              const p = placeholders.get(m);
              if (p === undefined) return m;
              found = true;
              return p;
            });
            if (!found) continue;
            touched.add(name);
            compilation.updateAsset(name, new sources.RawSource(replaced));
          }
        },
      );
      compilation.hooks.processAssets.tap(
        { name: `${pluginName}:restore`, stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE + 1 },
        () => {
          for (const name of touched) {
            const asset = compilation.getAsset(name);
            if (!asset) continue;
            const code = asset.source.source().toString();
            const restored = code.replace(HEX16, (m) => restore.get(m) ?? m);
            for (const placeholder of restore.keys()) {
              if (restored.includes(placeholder)) {
                compilation.errors.push(new this.webpack.WebpackError(`${pluginName}: placeholder ${placeholder} left in ${name}`));
              }
            }
            compilation.updateAsset(name, new sources.RawSource(restored));
          }
        },
      );
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

// The OpenPGP.js release in the lockfile's tree, for the /licenses page (its LGPL source pointer).
const openpgpVersion = wasmVersion(pkgDir('openpgp'));

const nextConfig = {
  trailingSlash: true,
  reactStrictMode: true,
  output: 'export',
  basePath,
  assetPrefix: basePath || undefined,
  // Next's default build id is random, and it lands in every page and in chunk hashes.
  generateBuildId: () => commit || 'unversioned',
  // Minify with Terser, not SWC. This came from an earlier reading of the "runtime chunk differs
  // between two builds of one commit" failure (958d73398) as SWC being non-deterministic. That was
  // not the cause: the minifier's input differed (StableMinifierInput above), and it still would
  // with Terser, whose mangler orders names by letter frequency the same way. Terser stays because
  // it is single-threaded JavaScript that mangles in a fixed order, so one input gives one output
  // on any machine, and it costs about 1% more JavaScript (0.8% gzipped). Next 15 drops the
  // option, so the guard below fails the build rather than letting an upgrade quietly bring SWC
  // back unexamined.
  swcMinify: false,
  images: {
    // Static export cannot use the Next.js image optimizer.
    unoptimized: true,
  },
  env: {
    // The wasm's size, so the download can show a percentage whatever the host's encoding.
    FORGE_WASM_SDK_BYTES: String(fs.statSync(WASM_FILE).size),
    // The OpenPGP.js version the app contains (app/licenses/page.tsx).
    FORGE_OPENPGP_VERSION: openpgpVersion,
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
      config.plugins.push(new StableMinifierInput(webpack));
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

// swcMinify: false (reproducibility, below) exists only in Next 14.
{
  const nextMajor = Number(require('next/package.json').version.split('.')[0]);
  if (nextMajor !== 14) throw new Error(`next ${nextMajor}: swcMinify: false is gone; keep the IPFS build reproducible another way (forge-web/next.config.js)`);
}

module.exports = nextConfig
