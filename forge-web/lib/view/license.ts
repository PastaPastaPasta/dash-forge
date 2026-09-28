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

interface Fingerprint {
  readonly id: string
  /** Every phrase must appear (normalised text). */
  readonly all: readonly string[]
  /** None of these may (tells a license from its relatives: LGPL from GPL, BSD-2 from BSD-3). */
  readonly none?: readonly string[]
}

/** Checked in order: the more specific relatives first. */
const FINGERPRINTS: readonly Fingerprint[] = [
  { id: 'AGPL-3.0', all: ['gnu affero general public license', 'version 3'] },
  { id: 'LGPL-3.0', all: ['gnu lesser general public license', 'version 3'] },
  { id: 'LGPL-2.1', all: ['gnu lesser general public license', 'version 2.1'] },
  { id: 'GPL-3.0', all: ['gnu general public license', 'version 3'], none: ['gnu lesser general public license', 'gnu affero'] },
  { id: 'GPL-2.0', all: ['gnu general public license', 'version 2'], none: ['gnu lesser general public license', 'gnu library general public license', 'gnu affero'] },
  { id: 'Apache-2.0', all: ['apache license', 'version 2.0'] },
  { id: 'MPL-2.0', all: ['mozilla public license', '2.0'] },
  { id: 'EPL-2.0', all: ['eclipse public license - v 2.0'] },
  { id: 'BSL-1.0', all: ['boost software license - version 1.0'] },
  { id: 'Unlicense', all: ['this is free and unencumbered software released into the public domain'] },
  { id: 'CC0-1.0', all: ['cc0 1.0 universal'] },
  { id: 'Zlib', all: ['altered source versions must be plainly marked as such', 'this notice may not be removed or altered from any source distribution'] },
  { id: 'ISC', all: ['permission to use, copy, modify, and', 'distribute this software for any purpose with or without fee is hereby granted'] },
  {
    id: 'BSD-3-Clause',
    all: ['redistribution and use in source and binary forms', 'neither the name of'],
  },
  {
    id: 'BSD-2-Clause',
    all: ['redistribution and use in source and binary forms', 'redistributions in binary form must reproduce the above copyright notice'],
    none: ['neither the name of', 'endorse or promote'],
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
  const t = normaliseLicense(text)
  const hits = FINGERPRINTS.filter((f) => f.all.every((p) => t.includes(p)) && !(f.none ?? []).some((p) => t.includes(p)))
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
