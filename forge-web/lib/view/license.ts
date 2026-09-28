/**
 * LICENSE detection (F-5): which licenses a repo's root license files carry, by SPDX id, the way
 * GitHub's licensee does it: find the license files by name, then recognise each text by phrases
 * only that license has (after normalising case, whitespace and quotes). A file it cannot place
 * reads as "Other" (a link to the file is still shown). No network: the fingerprints ship here.
 */

/** Root entries that are license files: LICENSE, LICENCE, COPYING, UNLICENSE, with any suffix (`LICENSE-MIT`, `LICENSE.md`). */
export function isLicenseFile(name: string): boolean {
  return /^(un)?licen[cs]e([-._].*)?$|^copying([-._].*)?$/i.test(name)
}

/** Largest license file read (a license is a few KiB; this only stops a huge file named LICENSE). */
export const LICENSE_MAX_BYTES = 128 * 1024

/** Case, whitespace, quotes and dashes folded, so wrapped or re-typeset copies match. */
export function normaliseLicense(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’“”`"']/g, '')
    .replace(/[–—-]+/g, '-')
    .replace(/\s+/g, ' ')
}

/**
 * Licenses that open with their title: identified by it alone. Their bodies name their relatives
 * (GPL-3 says "use the GNU Lesser General Public License instead", MPL-2.0 names GPL, LGPL and AGPL
 * as Secondary Licenses), so a phrase search anywhere in the text would find several; the title at
 * the start finds one. Checked in order, the longer titles first.
 */
const TITLES: readonly (readonly [title: string, id: string])[] = [
  ['gnu affero general public license version 3', 'AGPL-3.0'],
  ['gnu lesser general public license version 3', 'LGPL-3.0'],
  ['gnu lesser general public license version 2.1', 'LGPL-2.1'],
  ['gnu general public license version 3', 'GPL-3.0'],
  ['gnu general public license version 2', 'GPL-2.0'],
  ['apache license version 2.0', 'Apache-2.0'],
  ['mozilla public license version 2.0', 'MPL-2.0'],
  ['eclipse public license - v 2.0', 'EPL-2.0'],
  ['boost software license - version 1.0', 'BSL-1.0'],
]

interface Fingerprint {
  readonly id: string
  /** Every phrase must appear (normalised text). */
  readonly all: readonly string[]
  /** None of these may (tells a license from its relatives: BSD-2 from BSD-3 from BSD-4). */
  readonly none?: readonly string[]
}

/** Licenses with no title line of their own, recognised by phrases only they have. */
const FINGERPRINTS: readonly Fingerprint[] = [
  { id: 'Unlicense', all: ['this is free and unencumbered software released into the public domain'] },
  { id: 'CC0-1.0', all: ['cc0 1.0 universal'] },
  { id: 'Zlib', all: ['altered source versions must be plainly marked as such', 'this notice may not be removed or altered from any source distribution'] },
  {
    // 0BSD has the same grant without the notice condition: that condition is ISC's.
    id: 'ISC',
    all: [
      'permission to use, copy, modify, and',
      'distribute this software for any purpose with or without fee is hereby granted',
      'provided that the above copyright notice and this permission notice appear in all copies',
    ],
  },
  {
    id: 'BSD-3-Clause',
    all: ['redistribution and use in source and binary forms', 'neither the name of'],
    none: ['all advertising materials mentioning'],
  },
  {
    id: 'BSD-2-Clause',
    all: ['redistribution and use in source and binary forms', 'redistributions in binary form must reproduce the above copyright notice'],
    none: ['neither the name of', 'endorse or promote', 'all advertising materials mentioning'],
  },
  {
    id: 'MIT',
    all: ['permission is hereby granted, free of charge, to any person obtaining a copy', 'the above copyright notice and this permission notice shall be included'],
  },
]

/**
 * The SPDX id of a license text, or null when it is none of the known ones — or several: a file
 * bundling many licenses (jq's COPYING: MIT, BSD-2-Clause and more) is not one license, and GitHub
 * says NOASSERTION for it too.
 */
export function identifyLicense(text: string): string | null {
  const t = normaliseLicense(text).trimStart()
  const hits = FINGERPRINTS.filter((f) => f.all.every((p) => t.includes(p)) && !(f.none ?? []).some((p) => t.includes(p)))
  const titled = TITLES.find(([title]) => t.startsWith(title))
  // A titled license with another whole license after it (GPL-3 then MIT) is a bundle, as a
  // file with two untitled ones is. The titled texts contain none of the untitled fingerprints.
  if (titled !== undefined) return hits.length === 0 ? titled[1] : null
  return hits.length === 1 ? (hits[0] as Fingerprint).id : null
}

/** What the About card shows. */
export interface RepoLicense {
  /**
   * SPDX ids found, in file order, each once (`['MIT', 'Unlicense']` for a dual-licensed repo).
   * Empty: license files exist but none names a known license ("Other").
   */
  readonly ids: readonly string[]
  /** The license file to link to: the first that names a known license, else the first. */
  readonly file: string
}

/**
 * The repo's license from its root license files (`files`: name → text, in listing order), or null
 * when there are none. A COPYING that only says "dual-licensed under MIT or Unlicense" beside the
 * real texts adds nothing; "Other" only when no file names a known license.
 */
export function detectLicense(files: readonly (readonly [name: string, text: string | null])[]): RepoLicense | null {
  const first = files[0]
  if (first === undefined) return null
  const ids: string[] = []
  let file: string | null = null
  for (const [name, text] of files) {
    const id = text === null ? null : identifyLicense(text)
    if (id === null) continue
    file ??= name
    if (!ids.includes(id)) ids.push(id)
  }
  return { ids, file: file ?? first[0] }
}
