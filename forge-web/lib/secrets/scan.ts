/**
 * Scanning, verdicts and fingerprints (twin of `crates/forge-secrets/src/lib.rs`).
 *
 * Pure: no I/O, no clock, no randomness. Give it a path and the file's bytes ({@link scanFile}),
 * or a path and the git blob id of a file that was not read ({@link scanUnread}), and it returns
 * the same findings every Forge client does. See `./index` for the rules and the verdict.
 */

import { sha1 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

import type { AllowList } from './allow'
import { scanText, setsAValue } from './content'
import {
  BINARY_SNIFF_BYTES,
  ENV_TEMPLATE_SUFFIXES,
  FINGERPRINT_HEX,
  MAX_SCAN_BYTES,
  RULES,
  TEST_DIRS,
  ruleRefuses,
  type Finding,
  type Rule,
  type Verdict,
} from './types'
import { asciiLower, lineAt, lineStarts } from './util'

const ENCODER = new TextEncoder()
/** UTF-8 with invalid bytes replaced (U+FFFD); a leading BOM is kept, as Rust's `from_utf8_lossy` keeps it. */
const DECODER = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })

/** The verdict on `finding`: a refusing rule warns instead under a test folder or in history. */
export function verdict(finding: Finding, history: boolean): Verdict {
  if (!ruleRefuses(finding.rule)) return { severity: 'warn', reason: 'rule' }
  if (finding.rule !== 'env_file' && isTestPath(finding.path)) return { severity: 'warn', reason: 'test_path' }
  if (history) return { severity: 'warn', reason: 'history' }
  return { severity: 'refuse', reason: null }
}

/**
 * {@link verdict} with an allow list applied: `null` when a listed fingerprint silences the
 * finding; a refusal whose path a glob covers becomes a warning (reason `allowed_path`).
 */
export function decide(finding: Finding, history: boolean, allow: AllowList): Verdict | null {
  if (allow.allowsFingerprint(finding)) return null
  const v = verdict(finding, history)
  if (v.severity === 'refuse' && allow.allowsPath(finding)) return { severity: 'warn', reason: 'allowed_path' }
  return v
}

/** Whether any folder of `path` is one of {@link TEST_DIRS}. */
export function isTestPath(path: string): boolean {
  const slash = path.lastIndexOf('/')
  if (slash < 0) return false
  return path
    .slice(0, slash)
    .split('/')
    .some((d) => TEST_DIRS.includes(d))
}

/** The file name of `path` (its last `/`-separated part). */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** Whether `path` names an env file the `env_file` rule covers (case-insensitive). */
export function isEnvFileName(path: string): boolean {
  const name = asciiLower(baseName(path))
  return name === '.env' || (name.startsWith('.env.') && !ENV_TEMPLATE_SUFFIXES.some((s) => name.endsWith(s)))
}

/** The git blob id of `bytes` (SHA-1 of `blob <len>` 0x00 bytes, lower-case hex), as `git hash-object` prints it. */
export function gitBlobId(bytes: Uint8Array): string {
  const header = ENCODER.encode(`blob ${bytes.length}\0`)
  const all = new Uint8Array(header.length + bytes.length)
  all.set(header, 0)
  all.set(bytes, header.length)
  return bytesToHex(sha1(all))
}

/** Whether `content` is text worth matching: within {@link MAX_SCAN_BYTES} and no NUL in its first {@link BINARY_SNIFF_BYTES} bytes. */
export function isScannable(content: Uint8Array): boolean {
  return content.length <= MAX_SCAN_BYTES && !content.subarray(0, BINARY_SNIFF_BYTES).includes(0)
}

/**
 * Every finding in the file at `path` (`/`-separated, relative to the tree's root), from its
 * bytes. Content that is not {@link isScannable} is matched by name only. Findings come in a
 * fixed order: whole-file rules first, then by line, then by rule, then by fingerprint.
 */
export function scanFile(path: string, bytes: Uint8Array): Finding[] {
  return scan(path, isScannable(bytes) ? DECODER.decode(bytes) : null, gitBlobId(bytes))
}

/**
 * The findings of a file that was not read (too large, or over a budget), by its name and its
 * git blob id (which goes into an `env_file` or `envrc` fingerprint).
 */
export function scanUnread(path: string, blobId: string): Finding[] {
  return scan(path, null, asciiLower(blobId))
}

function scan(path: string, text: string | null, blobId: string): Finding[] {
  const out: Finding[] = []
  const name = asciiLower(baseName(path))
  const setsValues = text === null || setsAValue(text)
  if (isEnvFileName(path) && setsValues) {
    out.push(finding('env_file', path, null, blobId))
  } else if (name === '.envrc' && setsValues) {
    out.push(finding('envrc', path, null, blobId))
  }
  if (text !== null) {
    const matches = scanText(text)
    const starts = lineStarts(text)
    const linesWithFindings = new Set<number>()
    for (const m of matches) {
      if (m.rule !== 'secret_assignment') {
        linesWithFindings.add(lineAt(starts, m.offset))
        if (m.also !== null) linesWithFindings.add(lineAt(starts, m.also))
      }
    }
    for (const m of matches) {
      const line = lineAt(starts, m.offset)
      if (m.rule === 'secret_assignment' && linesWithFindings.has(line)) continue
      out.push(finding(m.rule, path, line, m.material))
    }
  }
  out.sort(
    (a, b) =>
      (a.line ?? 0) - (b.line ?? 0) ||
      RULES.indexOf(a.rule) - RULES.indexOf(b.rule) ||
      (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0),
  )
  return out.filter((f, i) => {
    const p = out[i - 1]
    return !(p && p.rule === f.rule && p.line === f.line && p.fingerprint === f.fingerprint && p.path === f.path)
  })
}

function finding(rule: Rule, path: string, line: number | null, material: string): Finding {
  return { rule, path, line, fingerprint: fingerprint(rule, path, material) }
}

/**
 * The fingerprint of `material` found by `rule` in `path`: the first {@link FINGERPRINT_HEX} hex
 * digits of `SHA-256("forge-secrets/v1" 0x00 rule-id 0x00 path 0x00 material)`.
 */
export function fingerprint(rule: Rule, path: string, material: string | Uint8Array): string {
  const head = ENCODER.encode(`forge-secrets/v1\0${rule}\0${path}\0`)
  const body = typeof material === 'string' ? ENCODER.encode(material) : material
  const all = new Uint8Array(head.length + body.length)
  all.set(head, 0)
  all.set(body, head.length)
  return bytesToHex(sha256(all)).slice(0, FINGERPRINT_HEX)
}
