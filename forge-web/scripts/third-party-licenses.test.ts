/**
 * The third-party license notice: built from `pnpm licenses list`-shaped data, deterministic,
 * fails on a license it has not been told about, and names OpenPGP.js's source.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { exportProblems, EXPECTED_FILES, packagesOf, renderNotices, wasmNoticeFor } from './third-party-licenses.mjs'

const WEB = join(__dirname, '..')

/** A package directory under `root` with a package.json and the given files. */
function pkg(root: string, name: string, version: string, files: Record<string, string>, extra: Record<string, unknown> = {}): string {
  const dir = join(root, 'node_modules', '.pnpm', `${name.replace('/', '+')}@${version}`, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, ...extra }))
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text)
  return dir
}

/** The shape of `pnpm licenses list --prod --json`. */
const entry = (name: string, version: string, dir: string, extra: Record<string, unknown> = {}) => ({ name, versions: [version], paths: [dir], ...extra })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'licenses-'))
  const list: Record<string, ReturnType<typeof entry>[]> = {
    MIT: [entry('left-pad', '1.3.0', pkg(root, 'left-pad', '1.3.0', { LICENSE: 'MIT text for left-pad\r\n\r\n' }), { homepage: 'https://example.com/left-pad' })],
    'LGPL-3.0+': [entry('openpgp', '6.3.2', pkg(root, 'openpgp', '6.3.2', { LICENSE: 'LGPL text' }, { repository: { url: 'git+https://github.com/openpgpjs/openpgpjs.git' } }))],
    Unknown: [
      entry('@dashevo/evo-sdk', '5.0.0-rc.3', pkg(root, '@dashevo/evo-sdk', '5.0.0-rc.3', {})),
      entry('@dashevo/wasm-sdk', '5.0.0-rc.3', pkg(root, '@dashevo/wasm-sdk', '5.0.0-rc.3', {})),
    ],
  }
  return { root, list }
}

describe('renderNotices', () => {
  it('names every package once with its license text, and states where OpenPGP.js comes from', () => {
    const { list } = fixture()
    const text = renderNotices(list)
    expect(text).toContain('left-pad 1.3.0 (MIT)')
    expect(text).toContain('MIT text for left-pad')
    expect(text).not.toContain('\r')
    // OpenPGP.js: its license, the exact version, the tag and the npm tarball.
    expect(text).toContain('OpenPGP.js 6.3.2 (LGPL-3.0-or-later)')
    expect(text).toContain('https://github.com/openpgpjs/openpgpjs/tree/v6.3.2')
    expect(text).toContain('https://registry.npmjs.org/openpgp/-/openpgp-6.3.2.tgz')
    expect(text).toContain('licenses/LGPL-3.0.txt')
    // The Platform SDK packages declare no license; the repository's MIT text stands in for it.
    expect(text).toContain('@dashevo/wasm-sdk 5.0.0-rc.3 (MIT)')
    expect(text).toContain('https://github.com/dashpay/platform/blob/v5.0.0-rc.3/LICENSE.md')
    expect(text).toContain('Copyright (c) 2017-2021 Dash Core Group, Inc.')
  })

  it('is deterministic and holds no path or time of the machine that built it', () => {
    const a = fixture()
    const b = fixture()
    expect(renderNotices(a.list)).toBe(renderNotices(b.list))
    expect(renderNotices(a.list)).not.toContain(a.root)
    expect(renderNotices(a.list)).not.toMatch(/\b20\d\d-\d\d-\d\d\b/)
  })

  it('lists the packages in name order whatever order pnpm gave them', () => {
    const { root, list } = fixture()
    list.MIT!.push(entry('a-first', '0.1.0', pkg(root, 'a-first', '0.1.0', { LICENSE: 'A text' })))
    expect(packagesOf(list).map((p) => p.name)).toEqual(['@dashevo/evo-sdk', '@dashevo/wasm-sdk', 'a-first', 'left-pad', 'openpgp'])
  })

  it('refuses a license that has not been read', () => {
    const { root, list } = fixture()
    list['GPL-3.0'] = [entry('copyleft-thing', '1.0.0', pkg(root, 'copyleft-thing', '1.0.0', { LICENSE: 'GPL' }))]
    expect(() => renderNotices(list)).toThrow(/copyleft-thing@1\.0\.0: license "GPL-3\.0" is not allowed/)
  })

  it('refuses a package with no license text unless its declared MIT or Apache-2.0 can stand in', () => {
    const { root, list } = fixture()
    list.MIT!.push(entry('no-file', '1.0.0', pkg(root, 'no-file', '1.0.0', {}, { author: 'Jane Doe <jane@example.com>' })))
    const text = renderNotices(list)
    expect(text).toContain('no-file 1.0.0 (MIT)')
    expect(text).toContain('Copyright (c) Jane Doe\n')
    expect(text).not.toContain('jane@example.com')

    list.ISC = [entry('isc-no-file', '1.0.0', pkg(root, 'isc-no-file', '1.0.0', {}))]
    expect(() => renderNotices(list)).toThrow(/isc-no-file@1\.0\.0: ships no license file/)
  })

  it('fails when the Platform SDK moves to a release line whose license was not read', () => {
    const { root, list } = fixture()
    list.Unknown = [entry('@dashevo/evo-sdk', '5.1.0', pkg(root, '@dashevo/evo-sdk', '5.1.0', {}))]
    expect(() => renderNotices(list)).toThrow(/read for another release line/)
  })

  it('needs OpenPGP.js in the tree, since its notice is the LGPL one', () => {
    const { list } = fixture()
    delete list['LGPL-3.0+']
    expect(() => renderNotices(list)).toThrow(/openpgp is not in the production tree/)
  })
})

describe('the real tree', () => {
  it('has a wasm license list for the Platform release forge-web depends on', () => {
    const { dependencies } = JSON.parse(readFileSync(join(WEB, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    const text = readFileSync(join(WEB, 'scripts/third-party/wasm-sdk-licenses.txt'), 'utf8')
    // Regenerate with build-support/licenses/generate-wasm.sh when this fails after an SDK bump.
    expect(() => wasmNoticeFor(text, dependencies['@dashevo/wasm-sdk']!)).not.toThrow()
    expect(() => wasmNoticeFor(text, '0.0.0')).toThrow(/regenerate/)
  })

  it('ships the GNU texts the notice points to', () => {
    expect(readFileSync(join(WEB, 'public/licenses/LGPL-3.0.txt'), 'utf8')).toContain('GNU LESSER GENERAL PUBLIC LICENSE')
    expect(readFileSync(join(WEB, 'public/licenses/GPL-3.0.txt'), 'utf8')).toContain('GNU GENERAL PUBLIC LICENSE')
  })
})

describe('exportProblems', () => {
  it('passes a complete export and names what a broken one lacks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'export-'))
    for (const [rel, needle] of EXPECTED_FILES as [string, string][]) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true })
      writeFileSync(join(dir, rel), `x ${needle} x`)
    }
    expect(exportProblems(dir)).toEqual([])

    writeFileSync(join(dir, 'licenses/index.html'), '<html></html>')
    expect(exportProblems(dir)).toEqual(['licenses/index.html does not contain "OpenPGP.js"'])

    const empty = mkdtempSync(join(tmpdir(), 'export-'))
    expect(exportProblems(empty)).toEqual((EXPECTED_FILES as [string, string][]).map(([rel]) => `${rel} is missing`))
  })
})
