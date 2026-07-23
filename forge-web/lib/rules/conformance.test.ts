/**
 * THE PARITY PROOF.
 *
 * Loads every `forge-contracts/vectors/*.json` and asserts this TypeScript port of
 * FORGE_RULES_V1 produces the vector's `expected` — the exact same suite the Rust
 * reference runs at the bottom of `crates/forge-core/src/rules.rs`. If this is green,
 * the two clients agree on ref resolution, protected-pattern matching, issue/PR folds,
 * token holdings, and flatIndex staleness overlay.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  AuthzResolver,
  ancestryFromPairs,
  foldIssueState,
  foldPrState,
  holdingsAsOf,
  matchesProtected,
  overlayTree,
  resolveRef,
} from './index'
import type {
  ConfigDoc,
  Event,
  FlatIndex,
  RefUpdate,
  TokenRecord,
  TreeDiff,
} from './types'

interface Vector {
  readonly name: string
  readonly description: string
  readonly case: string
  readonly input: unknown
  readonly expected: unknown
}

type Pairs = ReadonlyArray<readonly [string, string]>

interface ResolveRefInput {
  readonly updates: readonly RefUpdate[]
  readonly configHistory?: readonly ConfigDoc[]
  readonly refNameHash: string
  readonly ancestry?: Pairs
}

interface MatchesProtectedInput {
  readonly refName: string
  readonly patterns: readonly string[]
}

interface HoldingsInput {
  readonly records: readonly TokenRecord[]
  readonly identity: string
  readonly at: number
}

interface FoldIssueInput {
  readonly events: readonly Event[]
  readonly targetAuthor: string
  readonly tokenRecords?: readonly TokenRecord[]
}

interface FoldPrInput {
  readonly events: readonly Event[]
  readonly targetAuthor: string
  readonly tokenRecords?: readonly TokenRecord[]
  readonly baseTip?: string | null
  readonly ancestry?: Pairs
}

interface OverlayInput {
  readonly base: FlatIndex
  readonly diffs?: readonly TreeDiff[]
}

const VECTORS_DIR = resolve(process.cwd(), '..', 'forge-contracts', 'vectors')

function loadVectors(): Vector[] {
  const files = readdirSync(VECTORS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
  return files.map((f) => {
    const parsed: Vector = JSON.parse(readFileSync(resolve(VECTORS_DIR, f), 'utf8'))
    return parsed
  })
}

function runCase(v: Vector): void {
  switch (v.case) {
    case 'resolve_ref': {
      const inp = v.input as ResolveRefInput
      const got = resolveRef(
        inp.updates,
        inp.configHistory ?? [],
        inp.refNameHash,
        ancestryFromPairs(inp.ancestry ?? []),
      )
      expect(got).toEqual(v.expected)
      break
    }
    case 'matches_protected': {
      const inp = v.input as MatchesProtectedInput
      expect(matchesProtected(inp.refName, inp.patterns)).toEqual(v.expected)
      break
    }
    case 'holdings': {
      const inp = v.input as HoldingsInput
      expect(holdingsAsOf(inp.records, inp.identity, inp.at)).toEqual(v.expected)
      break
    }
    case 'fold_issue': {
      const inp = v.input as FoldIssueInput
      const authz = new AuthzResolver(inp.tokenRecords ?? [])
      expect(foldIssueState(inp.events, inp.targetAuthor, authz)).toEqual(v.expected)
      break
    }
    case 'fold_pr': {
      const inp = v.input as FoldPrInput
      const authz = new AuthzResolver(inp.tokenRecords ?? [])
      const got = foldPrState(
        inp.events,
        inp.targetAuthor,
        authz,
        inp.baseTip ?? undefined,
        ancestryFromPairs(inp.ancestry ?? []),
      )
      expect(got).toEqual(v.expected)
      break
    }
    case 'overlay': {
      const inp = v.input as OverlayInput
      expect(overlayTree(inp.base, inp.diffs ?? [])).toEqual(v.expected)
      break
    }
    default:
      throw new Error(`unknown vector case: ${v.case}`)
  }
}

describe('FORGE_RULES_V1 conformance vectors', () => {
  const vectors = loadVectors()

  it('loads the full vector corpus', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(20)
  })

  for (const v of vectors) {
    it(`${v.case} :: ${v.name}`, () => {
      runCase(v)
    })
  }
})
