#!/usr/bin/env node
/**
 * Write `third-party-licenses.txt` into a static export: the license notice of every package in
 * the app's production npm dependency tree, with the license text each package ships, a written
 * source offer for OpenPGP.js (LGPL-3.0-or-later), and the notice for the Dash Platform SDK
 * (MIT; its npm packages declare no license). The site serves it at its root, and links it from
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

/**
 * Packages that declare no license, and the Platform repository's license they carry. The
 * @dashevo SDK packages are built from github.com/dashpay/platform, whose LICENSE.md is the MIT
 * license ("Copyright (c) 2017-2021 Dash Core Group, Inc."); a copy is kept in
 * scripts/third-party/. `versions` is the release line the license was read for: another line
 * fails the build until LICENSE.md at its tag has been read again.
 */
export const CLARIFIED = {
  '@dashevo/evo-sdk': { license: 'MIT', versions: /^5\.0\.0(?:-|$)/, textFile: 'dash-platform-LICENSE.md', source: (v) => `https://github.com/dashpay/platform/blob/v${v}/LICENSE.md` },
  '@dashevo/wasm-sdk': { license: 'MIT', versions: /^5\.0\.0(?:-|$)/, textFile: 'dash-platform-LICENSE.md', source: (v) => `https://github.com/dashpay/platform/blob/v${v}/LICENSE.md` },
}

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

/** The license texts a package ships: `[{ file, text }]`, sorted by file name. */
export function licenseTexts(dir) {
  return readdirSync(dir)
    .filter((name) => LICENSE_FILE.test(name) && statSync(join(dir, name)).isFile())
    .sort()
    .map((file) => ({ file, text: normalize(readFileSync(join(dir, file), 'utf8')) }))
    .filter((t) => t.text !== '')
}

const MIT_TEXT = (holder) => `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

/**
 * For a package that declares MIT or Apache-2.0 in its package.json and ships no license file:
 * the standard text of that license, with the copyright holder its package.json names (else "the
 * package's authors"), and a line saying so. Null for any other license: those need a human to
 * read them.
 */
export function declaredLicense(license, dir, thirdPartyDir) {
  const { author } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const holder = (typeof author === 'string' ? author : author?.name) ?? null
  const note = `(The package ships no license file. This is its declared license, ${license}${holder ? `, with the copyright holder its package.json names` : ''}.)`
  if (license === 'MIT') return `${note}\n\n${MIT_TEXT(holder ? holder.replace(/\s*<[^>]*>/, '') : "the package's authors")}`
  if (license === 'Apache-2.0') return `${note}\n\nCopyright ${holder ? holder.replace(/\s*<[^>]*>/, '') : "the package's authors"}\n\n${normalize(readFileSync(join(thirdPartyDir, 'Apache-2.0.txt'), 'utf8'))}`
  return null
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
later version. It is included here unmodified, as the file it is published as, in a JavaScript
chunk of its own that the application loads on demand.

  License texts   licenses/LGPL-3.0.txt and licenses/GPL-3.0.txt (the LGPL is the GPL plus extra
                  permissions, so both accompany this application), served beside this file.
  Source code     ${repo}/tree/v${version}
                  (git tag v${version}); the release the application contains is the npm
                  package https://registry.npmjs.org/openpgp/-/openpgp-${version}.tgz
  Copyright       the OpenPGP.js authors. The package's own LICENSE file is reproduced below.

OpenPGP.js's build embeds noble-ciphers, noble-curves and noble-hashes (MIT, Copyright (c) Paul
Miller); their notices stay in its file headers.

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
 * @param {{ thirdPartyDir?: string }} [opts]
 */
export function renderNotices(list, opts = {}) {
  const thirdPartyDir = opts.thirdPartyDir ?? join(HERE, 'third-party')
  const packages = packagesOf(list)
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
        throw new Error(`${p.name}@${p.version}: its license was read for another release line; read LICENSE.md at v${p.version} of github.com/dashpay/platform and update CLARIFIED`)
      }
      license = clarified.license
      texts = [{ file: `LICENSE.md of ${clarified.source(p.version)}`, text: normalize(readFileSync(join(thirdPartyDir, clarified.textFile), 'utf8')) }]
      source = clarified.source(p.version)
    } else {
      if (!ALLOWED.has(p.license)) throw new Error(`${p.name}@${p.version}: license "${p.license}" is not allowed; read it and add it to ALLOWED in third-party-licenses.mjs if it is acceptable`)
      texts = licenseTexts(p.dir)
      if (texts.length === 0) {
        const text = declaredLicense(p.license, p.dir, thirdPartyDir)
        if (text === null) throw new Error(`${p.name}@${p.version}: ships no license file; read its repository's license and add it to CLARIFIED`)
        texts = [{ file: 'declared license', text }]
      }
    }
    const head = `${p.name} ${p.version} (${license})${source ? `\n${source}` : ''}`
    sections.push(`${head}\n\n${texts.map((t) => (texts.length > 1 ? `[${t.file}]\n\n${t.text}` : t.text)).join('\n\n')}`)
  }

  const rule = '='.repeat(80)
  const dash = '-'.repeat(80)
  const licenses = [...new Set(packages.map((p) => CLARIFIED[p.name]?.license ?? p.license))].sort()
  const header = `Dash Forge web app: third-party software licenses
${rule}

This file is the license notice for the open-source software in the Dash Forge web app. Dash
Forge itself is licensed under either the MIT license or the Apache License 2.0, at your option
(${REPO_URL}).

It is generated at build time from the application's production dependency tree
(forge-web/pnpm-lock.yaml), so it lists ${packages.length} packages, under these licenses:
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
