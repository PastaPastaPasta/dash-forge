/**
 * The allow list: `.forge/secret-scan-allow` and the `allow-secret=<fingerprint>` push option
 * (twin of `allow.rs`). One entry per line: a fingerprint (exactly {@link FINGERPRINT_HEX} hex
 * digits, case-insensitive) or a path glob ({@link pathMatches}), `#` comments (a whole line, or
 * after whitespace). A fingerprint silences its finding; a path glob only turns a refusal into a
 * printed warning, so a broad path entry cannot hide a secret nobody has looked at.
 */

import { pathMatches } from './glob'
import { FINGERPRINT_HEX, type Finding } from './types'
import { lines, trim, trimStart } from './util'

/** Whether `s` is a fingerprint: exactly {@link FINGERPRINT_HEX} hex digits. */
export function isFingerprint(s: string): boolean {
  return s.length === FINGERPRINT_HEX && /^[0-9a-fA-F]+$/.test(s)
}

/** `line` without a comment: everything when it starts with `#`, else from the first `#` that follows whitespace. */
function stripComment(line: string): string {
  const t = trimStart(line)
  if (t.startsWith('#')) return ''
  for (let i = 1; i < t.length; i++) {
    if (t.charAt(i) === '#' && /[ \t\n\f\r]/.test(t.charAt(i - 1))) return t.slice(0, i)
  }
  return t
}

/** Fingerprints and path globs whose findings are allowed. */
export class AllowList {
  private readonly fingerprints = new Set<string>()
  private readonly globs: string[] = []

  /** Parse an allow file. Never fails: every line is an entry or a comment. */
  static parse(text: string): AllowList {
    const list = new AllowList()
    for (const line of lines(text)) {
      const entry = trim(stripComment(line))
      if (entry === '') continue
      if (!list.addFingerprint(entry)) list.globs.push(entry)
    }
    return list
  }

  /** Add `fp` when it is a fingerprint; `false` (nothing added) when not. */
  addFingerprint(fp: string): boolean {
    const ok = isFingerprint(fp)
    if (ok) this.fingerprints.add(fp.toLowerCase())
    return ok
  }

  /** Add every entry of `other`. */
  extend(other: AllowList): void {
    for (const fp of other.fingerprints) this.fingerprints.add(fp)
    for (const g of other.globs) if (!this.globs.includes(g)) this.globs.push(g)
  }

  /** Whether `finding`'s fingerprint is listed (it is silenced). */
  allowsFingerprint(finding: Finding): boolean {
    return this.fingerprints.has(finding.fingerprint)
  }

  /** Whether a path glob covers `finding`'s path (a refusal becomes a warning). */
  allowsPath(finding: Finding): boolean {
    return this.globs.some((g) => pathMatches(g, finding.path))
  }

  /** Only the fingerprints of this list (what another ref's allow file may contribute). */
  fingerprintsOnly(): AllowList {
    const out = new AllowList()
    for (const fp of this.fingerprints) out.fingerprints.add(fp)
    return out
  }

  /** Whether the list has no entries. */
  isEmpty(): boolean {
    return this.fingerprints.size === 0 && this.globs.length === 0
  }
}
