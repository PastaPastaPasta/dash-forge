/**
 * A reader of one members-only pull request's blinded commits (`private-repos.md` §19.4): its
 * documents fold and anchor on blinds, and a member's git reads (an inline comment's code, written
 * on an older head) take the real commit behind each blind this PR's own documents verified. Only
 * those: a blind from anywhere else (a public document copying a members-only blind) is read as
 * it is, which finds nothing.
 */

import type { ObjectReader } from './tree-nav'

/** `reader`, with each of `blinds` (lowercase hex) read as the real commit it maps to. */
export function aliasedReader(reader: ObjectReader, blinds: ReadonlyMap<string, string>): ObjectReader {
  if (blinds.size === 0) return reader
  const real = (oid: string): string => blinds.get(oid.toLowerCase()) ?? oid
  return {
    readObject: (oid, options) => reader.readObject(real(oid), options),
    ...(reader.locate !== undefined ? { locate: (oid: string) => reader.locate!(real(oid)) } : {}),
    ...(reader.objectType !== undefined ? { objectType: (oid: string) => reader.objectType!(real(oid)) } : {}),
    ...(reader.memoScope !== undefined ? { memoScope: reader.memoScope } : {}),
  }
}
