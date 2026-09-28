/**
 * LICENSE detection (F-5) on the real license files of the showcase repos, with GitHub's own
 * answer (its licenses API, 2026-09-28) as the expectation, plus the relatives it must tell apart.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { detectLicense, identifyLicense, isLicenseFile } from './license'

const text = (name: string): string => readFileSync(join(__dirname, 'fixtures/licenses', name), 'utf8')

describe('isLicenseFile', () => {
  it('matches the names GitHub looks for, with suffixes', () => {
    for (const n of ['LICENSE', 'LICENCE', 'license.md', 'LICENSE-MIT', 'LICENSE.APACHE', 'COPYING', 'COPYING.LESSER', 'UNLICENSE', 'Unlicense.txt']) {
      expect(isLicenseFile(n), n).toBe(true)
    }
    for (const n of ['README.md', 'licenses', 'LICENSES', 'my-license', 'COPYINGS', 'src']) expect(isLicenseFile(n), n).toBe(false)
  })
})

describe('identifyLicense on the showcase repos', () => {
  it('fzf: MIT (GitHub: MIT)', () => {
    expect(identifyLicense(text('fzf-LICENSE'))).toBe('MIT')
  })

  it('ripgrep: MIT and the Unlicense, with a COPYING that only points at them', () => {
    expect(identifyLicense(text('ripgrep-LICENSE-MIT'))).toBe('MIT')
    expect(identifyLicense(text('ripgrep-UNLICENSE'))).toBe('Unlicense')
    expect(identifyLicense(text('ripgrep-COPYING'))).toBeNull()
    const got = detectLicense([
      ['COPYING', text('ripgrep-COPYING')],
      ['LICENSE-MIT', text('ripgrep-LICENSE-MIT')],
      ['UNLICENSE', text('ripgrep-UNLICENSE')],
    ])
    expect(got).toEqual({ ids: ['MIT', 'Unlicense'], file: 'LICENSE-MIT' })
  })

  it('jq: a COPYING bundling several licenses is Other (GitHub: NOASSERTION)', () => {
    expect(identifyLicense(text('jq-COPYING'))).toBeNull()
    expect(detectLicense([['COPYING', text('jq-COPYING')]])).toEqual({ ids: [], file: 'COPYING' })
  })

  it('no license file: nothing to show', () => {
    expect(detectLicense([])).toBeNull()
  })
})

describe('identifyLicense tells relatives apart', () => {
  const bsd2 = `Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.`
  it('BSD-2-Clause vs BSD-3-Clause', () => {
    expect(identifyLicense(bsd2)).toBe('BSD-2-Clause')
    expect(identifyLicense(`${bsd2}\n3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products`)).toBe('BSD-3-Clause')
  })

  it('the GPL family by name and version', () => {
    expect(identifyLicense('GNU GENERAL PUBLIC LICENSE\n Version 3, 29 June 2007')).toBe('GPL-3.0')
    expect(identifyLicense('GNU GENERAL PUBLIC LICENSE\n Version 2, June 1991')).toBe('GPL-2.0')
    expect(identifyLicense('GNU LESSER GENERAL PUBLIC LICENSE\n Version 3, 29 June 2007\n ... the GNU General Public License')).toBe('LGPL-3.0')
    expect(identifyLicense('GNU AFFERO GENERAL PUBLIC LICENSE\n Version 3, 19 November 2007')).toBe('AGPL-3.0')
  })

  it('Apache-2.0, MPL-2.0, ISC; re-wrapped and with typographic quotes', () => {
    expect(identifyLicense('Apache License\n                           Version 2.0, January 2004')).toBe('Apache-2.0')
    expect(identifyLicense('Mozilla Public License Version 2.0')).toBe('MPL-2.0')
    expect(identifyLicense('Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted')).toBe('ISC')
    expect(identifyLicense(text('fzf-LICENSE').replace(/\n/g, '\n   ').replace(/"/g, '“'))).toBe('MIT')
  })

  it('unknown text is null', () => {
    expect(identifyLicense('All rights reserved. Do not copy.')).toBeNull()
  })
})
