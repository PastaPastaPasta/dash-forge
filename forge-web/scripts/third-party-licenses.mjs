#!/usr/bin/env node
/**
 * Write `third-party-licenses.txt` into a static export: the license notice of every package in
 * the app's production npm dependency tree, with the license text each package ships, a written
 * source offer for OpenPGP.js (LGPL-3.0-or-later), and the notice for the Dash Platform SDK
 * (MIT; its npm packages declare no license), and the polyfills Next.js vendors. The site serves it at its root, and links it from
 * the footer and from `/licenses/` (app/licenses/page.tsx), which also serves the full GPL-3.0
 * and LGPL-3.0 texts (public/licenses/).
 *
 * The package list comes from `pnpm licenses list --prod --json` over the installed, locked tree
 * (pnpm-lock.yaml), so it follows the lockfile. Deterministic like the rest of the build (the
 * IPFS CID depends on every byte, docs/guides/verify-the-app.md): sorted, with no time, host or
 * absolute path in it.
 *
 * Fails, rather than shipping a gap, when a package's license is not on {@link ALLOWED}, or a
 * package ships no license text and is not clarified in {@link CLARIFIED}. A new dependency with
 * an unfamiliar license is therefore a build error, to be read and added here on purpose.
 *
 * Usage: node scripts/third-party-licenses.mjs [out-dir]
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const OUTPUT_NAME = 'third-party-licenses.txt'
export const WASM_OUTPUT_NAME = 'wasm-sdk-licenses.txt'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_URL = 'https://github.com/PastaPastaPasta/dash-forge'

/**
 * The license expressions the production tree may use (as the packages' package.json declares
 * them). `LGPL-3.0+` is OpenPGP.js, handled by {@link openpgpNotice}; `CC-BY-4.0` is
 * caniuse-lite's browser-support data, read at build time only and not part of the bundle.
 */
export const ALLOWED = new Set([
  '0BSD',
  '(MIT AND Zlib)',
  '(MIT OR Apache-2.0)',
  'Apache-2.0',
  'BSD-3-Clause',
  'CC-BY-4.0',
  'ISC',
  'LGPL-3.0+',
  'MIT',
  'Python-2.0',
])

const platformText = (v) => `https://github.com/dashpay/platform/blob/v${v}/LICENSE.md`

/**
 * Packages that declare no license, or a license without shipping its text, and the upstream
 * repository's real LICENSE they carry. Each text is kept in scripts/third-party/ and checked
 * against `checksum` (SHA-256), so a changed file fails the build rather than going stale.
 * `versions` is the release line the license was read for: another line fails the build until
 * the LICENSE at its tag has been read again.
 *
 *   - @dashevo/evo-sdk, @dashevo/wasm-sdk: built from github.com/dashpay/platform, whose
 *     LICENSE.md is MIT ("Copyright (c) 2017-2021 Dash Core Group, Inc."). The npm packages
 *     declare no license.
 *   - @next/env: part of vercel/next.js, tag v14.2.25 (license.md: MIT, Vercel, Inc.).
 *   - @swc/counter: swc-project/pkgs, packages/counter/LICENSE.txt (Apache-2.0).
 *   - client-only: a marker package with no repository of its own; its package.json says MIT and
 *     points at facebook/react, whose LICENSE (tag v18.3.1) is reproduced.
 */
export const CLARIFIED = {
  '@dashevo/evo-sdk': { license: 'MIT', versions: /^5\.0\.0(?:-|$)/, textFile: 'dash-platform-LICENSE.md', checksum: 'e504a118186ed7e3a0b319d4d72cc8f8107e6d854a95c8b1ba2aff5fb4563ff3', source: platformText },
  '@dashevo/wasm-sdk': { license: 'MIT', versions: /^5\.0\.0(?:-|$)/, textFile: 'dash-platform-LICENSE.md', checksum: 'e504a118186ed7e3a0b319d4d72cc8f8107e6d854a95c8b1ba2aff5fb4563ff3', source: platformText },
  '@next/env': { license: 'MIT', versions: /^14\.2\./, textFile: 'next-LICENSE.md', checksum: 'e4f76a7a19ef2989dd79339bd3abf8afcf1d6f065e5a10c76c19415ffd727eb3', source: () => 'https://github.com/vercel/next.js/blob/v14.2.25/license.md' },
  '@swc/counter': { license: 'Apache-2.0', versions: /^0\.1\./, textFile: 'swc-counter-LICENSE.txt', checksum: 'd96eba1f1881334d50ffc144276dfa98e147a415e7c591ecdfcb81680361dc91', source: () => 'https://github.com/swc-project/pkgs/blob/main/packages/counter/LICENSE.txt' },
  'client-only': { license: 'MIT', versions: /^0\.0\./, textFile: 'react-LICENSE', checksum: '52412d7bc7ce4157ea628bbaacb8829e0a9cb3c58f57f99176126bc8cf2bfc85', source: () => 'https://github.com/facebook/react/blob/v18.3.1/LICENSE' },
}

/**
 * Code Next.js vendors into the client bundle without a package of its own, so `pnpm licenses`
 * does not list it: core-js (the polyfills chunk; the MIT text is kept here for the version the
 * chunk names) and the buffer polyfill (feross's, compiled into next/dist, with its LICENSE).
 * Read from the installed `next` package, and refused when Next moves to a core-js whose license
 * has not been read.
 */
export const BUNDLED_IN_NEXT = [
  {
    name: 'core-js',
    license: 'MIT',
    source: 'https://github.com/zloirock/core-js',
    // The polyfills chunk's own banner links the license of the version it holds.
    version: (nextDir) => /core-js\/blob\/v(\d+\.\d+\.\d+)\/LICENSE/.exec(readFileSync(join(nextDir, 'dist/build/polyfills/polyfill-nomodule.js'), 'utf8'))?.[1] ?? null,
    pinned: { versions: /^3\.38\.1$/, textFile: 'core-js-LICENSE', checksum: '51aff0fa92ac49e01ce6ba0fed992b0a34f8afe15203dd5f38c43f9e88b0167b', tag: 'v3.38.1' },
  },
  {
    name: 'buffer',
    license: 'MIT',
    source: 'https://github.com/feross/buffer',
    version: () => null,
    textIn: 'dist/compiled/buffer/LICENSE',
  },
]

/** License files a package ships at its top level. */
const LICENSE_FILE = /^(?:licen[cs]e|copying|notice|unlicense)(?:[-._].*)?$/i

const normalize = (text) => text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '')

/**
 * The packages in `pnpm licenses list --prod --json` output, one entry per name and version,
 * sorted. `list` maps a license expression to its packages, each with parallel `versions` and
 * `paths` arrays.
 */
export function packagesOf(list) {
  const out = []
  for (const [license, pkgs] of Object.entries(list)) {
    for (const p of pkgs) {
      if (p.versions.length !== p.paths.length) throw new Error(`${p.name}: ${p.versions.length} versions but ${p.paths.length} paths`)
      p.versions.forEach((version, i) => out.push({ name: p.name, version, license, homepage: p.homepage ?? null, dir: p.paths[i] }))
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0))
}

/**
 * `packages` without the platform-specific prebuilt binaries: packages whose package.json limits
 * them to an OS, CPU or libc (`os`, `cpu`, `libc`), such as Next's SWC compiler or fsevents.
 * They run only at build time, are never in the site, and differ by machine, so listing them
 * would make an x86_64 and an arm64 build write different notices (and different IPFS CIDs).
 */
export function withoutPlatformBinaries(packages, readManifest = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))) {
  return packages.filter((p) => {
    let manifest
    try {
      manifest = readManifest(p.dir)
    } catch {
      return true
    }
    return !['os', 'cpu', 'libc'].some((field) => manifest?.[field] !== undefined)
  })
}

/** The license texts a package ships: `[{ file, text }]`, sorted by file name. */
export function licenseTexts(dir) {
  return readdirSync(dir)
    .filter((name) => LICENSE_FILE.test(name) && statSync(join(dir, name)).isFile())
    .sort()
    .map((file) => ({ file, text: normalize(readFileSync(join(dir, file), 'utf8')) }))
    .filter((t) => t.text !== '')
}

/** The text of a file kept in scripts/third-party/, refused if it is not the one that was read. */
export function pinnedText(dir, file, checksum) {
  const raw = readFileSync(join(dir, file))
  const actual = createHash('sha256').update(raw).digest('hex')
  if (actual !== checksum) throw new Error(`scripts/third-party/${file} is ${actual}, not the checksum ${checksum} it was read at; read the upstream license again and update third-party-licenses.mjs`)
  return normalize(raw.toString('utf8'))
}

/** The package's own `repository` as an https URL, for the source pointer; null when it has none. */
function repositoryOf(dir) {
  const { repository } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const url = typeof repository === 'string' ? repository : repository?.url
  if (!url) return null
  return url.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '').replace(/^github:/, 'https://github.com/')
}

/** The OpenPGP.js section: what it is, its license, and where its exact source is. */
export function openpgpNotice(version, repository) {
  const repo = repository ?? 'https://github.com/openpgpjs/openpgpjs'
  return `OpenPGP.js ${version} (LGPL-3.0-or-later)

This application uses OpenPGP.js to read OpenPGP keys and check OpenPGP signatures. OpenPGP.js
is free software under the GNU Lesser General Public License, version 3 or (at your option) any
later version. The application's build (webpack and the Next.js minifier) bundles the published
release into a JavaScript chunk of its own that the application loads on demand. The minifier
does not keep the release's license banner; this notice and the files it names stand in for it.

  License texts   licenses/LGPL-3.0.txt and licenses/GPL-3.0.txt (the LGPL is the GPL plus extra
                  permissions, so both accompany this application), served beside this file.
  Source code     ${repo}/tree/v${version}
                  (git tag v${version}); the release the application contains is the npm
                  package https://registry.npmjs.org/openpgp/-/openpgp-${version}.tgz
  Copyright       the OpenPGP.js authors. The package's own LICENSE file is reproduced below.

OpenPGP.js's published build embeds noble-ciphers, noble-curves and noble-hashes by Paul Miller,
under the MIT license. The minifier drops their banners too, so their notice is here:

  Copyright (c) Paul Miller (https://paulmillr.com)

  Permission is hereby granted, free of charge, to any person obtaining a copy of this software
  and associated documentation files (the "Software"), to deal in the Software without
  restriction, including without limitation the rights to use, copy, modify, merge, publish,
  distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
  Software is furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all copies or
  substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
  BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
  NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
  DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

You may modify OpenPGP.js and use the modified version with this application. The application
is open source (${REPO_URL}, under the MIT and
Apache-2.0 licenses) and its web build is reproducible (docs/guides/verify-the-app.md): replace
OpenPGP.js in the lockfile or with a pnpm patch, and rebuild.`
}

/** The Dash Platform SDK section: the wasm module and its JavaScript are built from Platform. */
export function platformNotice() {
  return `Dash Platform SDK (@dashevo/evo-sdk, @dashevo/wasm-sdk) (MIT)

The Dash Platform SDK is included as JavaScript and as a WebAssembly module
(wasm_sdk_bg.*.wasm), compiled from the Rust sources of github.com/dashpay/platform, which
are licensed under the MIT license (the text is given with each package below). The Rust crates
compiled into the module carry their own licenses, listed in wasm-sdk-licenses.txt.`
}

/**
 * The notice for the build in `root` (a forge-web checkout with its dependencies installed),
 * from `list` (`pnpm licenses list --prod --json`). Throws on a license outside the allow list or
 * a package that ships no license text.
 *
 * @param {Record<string, any[]>} list
 * @param {{ thirdPartyDir?: string, readManifest?: (dir: string) => any }} [opts]
 */
export function renderNotices(list, opts = {}) {
  const thirdPartyDir = opts.thirdPartyDir ?? join(HERE, 'third-party')
  const packages = withoutPlatformBinaries(packagesOf(list), opts.readManifest)
  const openpgp = packages.find((p) => p.name === 'openpgp')
  if (!openpgp) throw new Error('openpgp is not in the production tree; update third-party-licenses.mjs (the LGPL notice)')

  const sections = []
  for (const p of packages) {
    const clarified = CLARIFIED[p.name]
    let license = p.license
    let texts
    let source = p.homepage ?? repositoryOf(p.dir)
    if (clarified) {
      if (!clarified.versions.test(p.version)) {
        throw new Error(`${p.name}@${p.version}: its license was read for another release line; read the upstream LICENSE for this version and update CLARIFIED`)
      }
      license = clarified.license
      texts = [{ file: `LICENSE of ${clarified.source(p.version)}`, text: pinnedText(thirdPartyDir, clarified.textFile, clarified.checksum) }]
      source = clarified.source(p.version)
    } else {
      if (!ALLOWED.has(p.license)) throw new Error(`${p.name}@${p.version}: license "${p.license}" is not allowed; read it and add it to ALLOWED in third-party-licenses.mjs if it is acceptable`)
      texts = licenseTexts(p.dir)
      if (texts.length === 0) throw new Error(`${p.name}@${p.version}: ships no license file; read its repository's LICENSE and add it to CLARIFIED, pinned by checksum`)
    }
    const head = `${p.name} ${p.version} (${license})${source ? `\n${source}` : ''}`
    sections.push(`${head}\n\n${texts.map((t) => (texts.length > 1 ? `[${t.file}]\n\n${t.text}` : t.text)).join('\n\n')}`)
  }

  // Next.js's vendored core-js and buffer polyfills.
  const next = packages.find((p) => p.name === 'next')
  if (!next) throw new Error('next is not in the production tree; update third-party-licenses.mjs (its vendored polyfills)')
  for (const b of BUNDLED_IN_NEXT) {
    let version = b.version(next.dir)
    let text
    if (b.pinned) {
      if (version === null || !b.pinned.versions.test(version)) {
        throw new Error(`next@${next.version} bundles ${b.name} ${version ?? '(unknown version)'}, whose license was not read; read it at its tag and update BUNDLED_IN_NEXT`)
      }
      text = pinnedText(thirdPartyDir, b.pinned.textFile, b.pinned.checksum)
    } else {
      const file = join(next.dir, b.textIn)
      if (!existsSync(file)) throw new Error(`next@${next.version} no longer ships ${b.textIn}; read where its ${b.name} polyfill comes from and update BUNDLED_IN_NEXT`)
      text = normalize(readFileSync(file, 'utf8'))
    }
    sections.push(`${b.name}${version ? ` ${version}` : ''} (${b.license}), compiled into Next.js's client code\n${b.source}\n\n${text}`)
  }

  const rule = '='.repeat(80)
  const dash = '-'.repeat(80)
  const licenses = [...new Set([...packages.map((p) => CLARIFIED[p.name]?.license ?? p.license), ...BUNDLED_IN_NEXT.map((b) => b.license)])].sort()
  const header = `Dash Forge web app: third-party software licenses
${rule}

This file is the license notice for the open-source software in the Dash Forge web app. Dash
Forge itself is licensed under either the MIT license or the Apache License 2.0, at your option
(${REPO_URL}).

It is generated at build time from the application's production dependency tree
(forge-web/pnpm-lock.yaml), so it lists ${packages.length + BUNDLED_IN_NEXT.length} packages, under these licenses:
${licenses.map((l) => `  ${l}`).join('\n')}
It errs on the side of listing: it can name a package the bundle does not contain, such as an
optional peer dependency of the framework.

The full GNU license texts are in licenses/ (served beside this file), and the Rust crates inside
the Dash Platform SDK's WebAssembly module are listed in wasm-sdk-licenses.txt.`
  return `${[header, openpgpNotice(openpgp.version, repositoryOf(openpgp.dir)), platformNotice(), `Packages\n\n${sections.join(`\n\n${dash}\n\n`)}`].join(`\n\n${rule}\n\n`)}\n`
}

/** `pnpm licenses list --prod --json` in `cwd`: through the pnpm that runs this script, if any. */
export function pnpmLicenses(cwd) {
  const exec = process.env.npm_execpath
  // npm_execpath is pnpm's script (run it with node) or, for a standalone pnpm, its executable.
  const [cmd, args] = exec && /pnpm/i.test(exec) ? (/\.[cm]?js$/.test(exec) ? [process.execPath, [exec]] : [exec, []]) : ['pnpm', []]
  const out = execFileSync(cmd, [...args, 'licenses', 'list', '--prod', '--json'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] })
  return JSON.parse(out)
}

/**
 * The Rust crates inside the wasm module (`third-party/wasm-sdk-licenses.txt`, made by
 * build-support/licenses/generate-wasm.sh), if they were listed for the Platform release the
 * installed @dashevo/wasm-sdk is built from. Throws when they were listed for another.
 */
export function wasmNoticeFor(raw, wasmSdkVersion) {
  const text = `${normalize(raw)}\n`
  if (!text.split('\n').includes(`Platform tag: v${wasmSdkVersion}`)) {
    throw new Error(
      `scripts/third-party/wasm-sdk-licenses.txt is not for platform v${wasmSdkVersion}; regenerate it with build-support/licenses/generate-wasm.sh after moving the Platform tag`,
    )
  }
  return text
}

/** What a finished export must hold for the notices to be served: relative path, and text it must contain. */
export const EXPECTED_FILES = [
  [OUTPUT_NAME, 'GNU Lesser General Public License'],
  [WASM_OUTPUT_NAME, 'Platform tag: v'],
  ['licenses/LGPL-3.0.txt', 'GNU LESSER GENERAL PUBLIC LICENSE'],
  ['licenses/GPL-3.0.txt', 'GNU GENERAL PUBLIC LICENSE'],
  // The page (app/licenses/page.tsx), which names OpenPGP.js's license and source.
  ['licenses/index.html', 'OpenPGP.js'],
]

/** The problems with the notices in the export `dir` (empty when it is complete). */
export function exportProblems(dir) {
  const problems = []
  for (const [rel, needle] of EXPECTED_FILES) {
    const file = join(dir, rel)
    if (!existsSync(file)) problems.push(`${rel} is missing`)
    else if (!readFileSync(file, 'utf8').includes(needle)) problems.push(`${rel} does not contain "${needle}"`)
  }
  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? 'out'
  if (!existsSync(dir)) throw new Error(`${dir}: no such directory (build the app first)`)
  const list = pnpmLicenses(join(HERE, '..'))
  const text = renderNotices(list)
  const wasm = packagesOf(list).find((p) => p.name === '@dashevo/wasm-sdk')
  if (!wasm) throw new Error('@dashevo/wasm-sdk is not in the production tree; update third-party-licenses.mjs')
  const wasmText = wasmNoticeFor(readFileSync(join(HERE, 'third-party', WASM_OUTPUT_NAME), 'utf8'), wasm.version)
  writeFileSync(join(dir, OUTPUT_NAME), text)
  writeFileSync(join(dir, WASM_OUTPUT_NAME), wasmText)
  const problems = exportProblems(dir)
  if (problems.length > 0) throw new Error(`${dir}: the license notices are incomplete: ${problems.join('; ')}`)
  process.stderr.write(`${OUTPUT_NAME}: ${text.length} bytes; ${WASM_OUTPUT_NAME}: ${wasmText.length} bytes\n`)
}
