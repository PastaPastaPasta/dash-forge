/**
 * THE PARITY PROOF — for the pure rules.
 *
 * Loads every `forge-contracts/vectors/*.json` and asserts this TypeScript port produces the
 * vector's `expected` — the exact same suite the Rust reference runs at the bottom of
 * `crates/forge-core/src/rules.rs`. A vector's `rules` field picks the rule set: absent or
 * `"v1"` is FORGE_RULES_V1, `"v2"` is FORGE_RULES_V2 (`./v2`). If this is green, the two
 * clients agree on ref resolution, protected-pattern matching, issue/PR folds (v1 and v2),
 * token holdings, ref naming, flatIndex staleness overlay, and the v2 numbering, pack-copy,
 * approval, well-formedness and repo-name rules.
 *
 * SCOPE, stated precisely because it has been over-read: every vector hands the pure
 * functions a ready-made input array, so this suite proves the two ports FOLD identically
 * given identical input. It says nothing about whether each client FETCHES identical input.
 * A divergence in the read layer — one client paging a history to exhaustion while the other
 * stops at Platform's 100-row page — produces two different answers from two green
 * conformance runs. That class of bug is covered by the read-path tests next to each reader
 * (`lib/repo/pagination.test.ts` here), not by these vectors.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  AuthzResolver,
  ancestryFromPairs,
  displayRefName,
  foldIssueState,
  foldPrState,
  holdingsAsOf,
  matchesProtected,
  overlayTree,
  resolveRef,
  v2,
} from './index'
import { VERDICT_LABEL, verdictFromCode } from '../repo'
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
  readonly rules?: 'v1' | 'v2'
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

interface DisplayRefNameInput {
  readonly updates: readonly RefUpdate[]
  readonly refNameHash: string
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
    case 'verdict_label': {
      const inp = v.input as { readonly code: number }
      const r = verdictFromCode(inp.code)
      expect({ label: VERDICT_LABEL[r.verdict], code: r.code }).toEqual(v.expected)
      break
    }
    case 'display_ref_name': {
      const inp = v.input as DisplayRefNameInput
      expect(displayRefName(inp.updates, inp.refNameHash) ?? null).toEqual(v.expected)
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

/**
 * The keys each v2 input record may carry. The harness refuses any other key, at any depth,
 * as the Rust harness does, so a vector cannot carry a field (v1's `tokenRecords`, a misspelt
 * `supersedes`) that the rules silently ignore.
 */
const EVENT_KEYS = ['id', 'targetId', 'kind', 'actor', 'value', 'oid', 'createdAt']
const MEMBERSHIP_KEYS = ['identity', 'role', 'createdAt']
const NESTED_KEYS: Readonly<Record<string, readonly string[]>> = {
  events: EVENT_KEYS,
  authorEvents: EVENT_KEYS,
  copies: ['id', 'packHash', 'ownerRole', 'createdAt', 'verified', 'supersedes'],
  reviews: ['id', 'reviewer', 'verdict', 'commitOid', 'createdAt'],
  memberships: MEMBERSHIP_KEYS,
  queries: ['identity', 'at'],
  doc: [
    'kind', 'title', 'body', 'refName', 'baseRefName', 'sourceRefName',
    'defaultBranch', 'protectedPatterns', 'enc', 'epoch',
  ],
}

/** `v2_pack_list` rows carry manifest metadata `pack_copies` rows do not. */
const PACK_LIST_KEYS: Readonly<Record<string, readonly string[]>> = {
  ...NESTED_KEYS,
  copies: [
    'id', 'packHash', 'kind', 'createdAt', 'ownerRole', 'sizeBytes', 'objectCount',
    'chunkCount', 'supersedes', 'verified',
  ],
  asOf: ['createdAt', 'id'],
}

function onlyKeys(
  v: Vector,
  allowed: readonly string[],
  nested: Readonly<Record<string, readonly string[]>> = NESTED_KEYS,
): void {
  const input = v.input as Record<string, unknown>
  const extra = Object.keys(input).filter((k) => !allowed.includes(k))
  expect(extra, `vector ${v.name}: unknown input keys`).toEqual([])
  for (const [key, nestedAllowed] of Object.entries(nested)) {
    const value = input[key]
    if (value === undefined || value === null) continue
    for (const [i, rec] of (Array.isArray(value) ? value : [value]).entries()) {
      const bad = Object.keys(rec as object).filter((k) => !nestedAllowed.includes(k))
      expect(bad, `vector ${v.name}: unknown keys in ${key}[${i}]`).toEqual([])
    }
  }
}

function runCaseV2(v: Vector): void {
  switch (v.case) {
    case 'fold_issue': {
      onlyKeys(v, ['events', 'authorEvents', 'targetAuthor'])
      const inp = v.input as V2FoldInput
      expect(v2.foldIssueStateV2(inp.events ?? [], inp.authorEvents ?? [], inp.targetAuthor)).toEqual(
        v.expected,
      )
      break
    }
    case 'fold_pr': {
      onlyKeys(v, ['events', 'authorEvents', 'targetAuthor', 'baseTip', 'ancestry'])
      const inp = v.input as V2FoldInput & { readonly baseTip?: string | null; readonly ancestry?: Pairs }
      const got = v2.foldPrStateV2(
        inp.events ?? [],
        inp.authorEvents ?? [],
        inp.targetAuthor,
        inp.baseTip ?? undefined,
        ancestryFromPairs(inp.ancestry ?? []),
      )
      expect(got).toEqual(v.expected)
      break
    }
    case 'allocate_number': {
      onlyKeys(v, ['count', 'takenNumbersDesc'])
      const inp = v.input as { readonly count: number; readonly takenNumbersDesc: readonly number[] }
      expect(v2.allocateNumber(inp.count, inp.takenNumbersDesc)).toEqual(v.expected)
      break
    }
    case 'pack_copies': {
      onlyKeys(v, ['copies'])
      const { copies } = v.input as { readonly copies: readonly v2.PackCopy[] }
      const want = v.expected as {
        readonly order?: readonly string[]
        readonly selected?: string | null
        readonly readOrder?: readonly v2.PackPick[]
      }
      expect(Object.keys(want).filter((k) => !['order', 'selected', 'readOrder'].includes(k))).toEqual([])
      expect(Object.keys(want).length).toBeGreaterThan(0)
      if (want.order !== undefined) {
        expect(v2.orderPackCopies(copies).map((c) => c.id)).toEqual(want.order)
      }
      if (want.selected !== undefined) {
        expect(v2.selectPackCopy(copies)?.id ?? null).toEqual(want.selected)
      }
      if (want.readOrder !== undefined) {
        expect(v2.packReadOrder(copies)).toEqual(want.readOrder)
      }
      break
    }
    case 'v2_pack_list': {
      onlyKeys(v, ['copies', 'asOf'], PACK_LIST_KEYS)
      const inp = v.input as {
        readonly copies: readonly v2.PackCopyRow[]
        readonly asOf?: v2.CopyKey | null
      }
      expect(v2.v2PackList(inp.copies, inp.asOf)).toEqual(v.expected)
      break
    }
    case 'approvals': {
      onlyKeys(v, ['reviews', 'memberships', 'headOid'])
      const inp = v.input as {
        readonly reviews: readonly v2.Review[]
        readonly memberships: readonly v2.Membership[]
        readonly headOid: string
      }
      const oracle = new v2.RoleOracle(inp.memberships)
      expect(v2.countApprovals(inp.reviews, oracle, inp.headOid)).toEqual(v.expected)
      break
    }
    case 'well_formed': {
      onlyKeys(v, ['doc', 'visibility'])
      const inp = v.input as { readonly doc: v2.ContentDoc; readonly visibility: v2.Visibility }
      expect(v2.isWellFormed(inp.doc, inp.visibility)).toEqual(v.expected)
      break
    }
    case 'repo_name': {
      onlyKeys(v, ['name'])
      const { name } = v.input as { readonly name: string }
      expect({ valid: v2.isValidRepoName(name), normalized: v2.normalizeRepoName(name) }).toEqual(
        v.expected,
      )
      break
    }
    case 'role_oracle': {
      onlyKeys(v, ['memberships', 'queries'])
      const inp = v.input as {
        readonly memberships: readonly v2.Membership[]
        readonly queries: readonly { readonly identity: string; readonly at: number }[]
      }
      const oracle = new v2.RoleOracle(inp.memberships)
      const got = inp.queries.map((q) => ({
        roleAt: oracle.roleAt(q.identity, q.at),
        memberAt: oracle.memberAt(q.identity, q.at),
        currentRole: oracle.currentRole(q.identity),
      }))
      expect(got).toEqual(v.expected)
      break
    }
    default:
      throw new Error(`unknown v2 vector case: ${v.case}`)
  }
}

interface V2FoldInput {
  readonly events?: readonly Event[]
  readonly authorEvents?: readonly Event[]
  readonly targetAuthor: string
}

describe('FORGE_RULES conformance vectors', () => {
  const vectors = loadVectors()
  const v1 = vectors.filter((v) => (v.rules ?? 'v1') === 'v1')
  const v2Vectors = vectors.filter((v) => v.rules === 'v2')

  it('loads the full vector corpus', () => {
    expect(v1.length).toBeGreaterThanOrEqual(70)
    expect(v2Vectors.length).toBeGreaterThanOrEqual(110)
    expect(v1.length + v2Vectors.length).toBe(vectors.length)
  })

  for (const v of v1) {
    it(`v1 ${v.case} :: ${v.name}`, () => {
      runCase(v)
    })
  }
  for (const v of v2Vectors) {
    it(`v2 ${v.case} :: ${v.name}`, () => {
      runCaseV2(v)
    })
  }
})
