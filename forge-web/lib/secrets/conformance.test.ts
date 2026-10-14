/**
 * Parity proof for the secret scan: runs every `forge-contracts/vectors/secret_scan/*.json`
 * through this port and asserts the findings, severities, reasons and fingerprints equal the
 * vector's `expected`, the same suite the Rust crate runs in `crates/forge-secrets/tests/vectors.rs`.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { AllowList, decide, scanFile, scanUnread } from './index'

interface VectorInput {
  readonly path: string
  readonly content: readonly string[] | null
  readonly blobId?: string
  readonly history: boolean
  readonly allowFile?: string
  readonly allowSecrets?: readonly string[]
}

interface ExpectedFinding {
  readonly rule: string
  readonly line: number | null
  readonly fingerprint: string
  readonly severity: string
  readonly reason: string | null
}

interface Vector {
  readonly name: string
  readonly case: string
  readonly input: VectorInput
  readonly expected: readonly ExpectedFinding[]
}

const VECTORS_DIR = resolve(process.cwd(), '..', 'forge-contracts', 'vectors', 'secret_scan')

function loadVectors(): Vector[] {
  return readdirSync(VECTORS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(resolve(VECTORS_DIR, f), 'utf8')) as Vector)
}

/** What the scan reports for `input`, in the vectors' shape. */
function run(input: VectorInput): ExpectedFinding[] {
  const allow = input.allowFile === undefined ? new AllowList() : AllowList.parse(input.allowFile)
  for (const fp of input.allowSecrets ?? []) expect(allow.addFingerprint(fp), `allowSecrets entry ${fp}`).toBe(true)
  const findings =
    input.content === null
      ? scanUnread(input.path, input.blobId ?? '')
      : scanFile(input.path, new TextEncoder().encode(input.content.join('')))
  return findings.map((f) => {
    const v = decide(f, input.history, allow)
    return {
      rule: f.rule,
      line: f.line,
      fingerprint: f.fingerprint,
      severity: v === null ? 'silent' : v.severity,
      reason: v?.reason ?? null,
    }
  })
}

describe('secret_scan conformance vectors', () => {
  const vectors = loadVectors()

  it('loads the vectors', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(30)
    for (const v of vectors) expect(v.case, v.name).toBe('secret_scan')
  })

  for (const v of vectors) {
    it(v.name, () => {
      if (v.input.content === null) expect(v.input.blobId, 'blobId for an unread file').toBeTypeOf('string')
      expect(run(v.input)).toEqual(v.expected)
    })
  }
})
