/**
 * THE PARITY PROOF — for the pure rules.
 *
 * Loads every `forge-contracts/vectors/*.json` and asserts this TypeScript port produces the
 * vector's `expected` — the exact same suite the Rust reference runs at the bottom of
 * `crates/forge-core/src/rules.rs`. A vector's `rules` field picks the rule set: absent is
 * the base rules forge-v2 shares (ref resolution, protected-pattern matching, ref naming,
 * flatIndex staleness overlay, verdict labels), `"v2"` is FORGE_RULES_V2 (`./v2`); any other
 * value fails as unknown. If this is green, the two clients agree on all of those and on the
 * v2 issue/PR folds, numbering, pack-copy, approval, well-formedness and repo-name rules.
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
  ancestryFromPairs,
  displayRefName,
  matchesProtected,
  mergeBaseTips,
  overlayTree,
  prBaseTips,
  resolveRef,
  v2,
} from './index'
import { VERDICT_LABEL, verdictFromCode } from '../repo'
import type {
  ConfigDoc,
  Event,
  FlatIndex,
  IsAncestor,
  MergeBaseTips,
  RefUpdate,
  TreeDiff,
} from './types'

interface Vector {
  readonly name: string
  readonly description: string
  readonly case: string
  readonly rules?: string
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

/**
 * A PR base ref's raw history: the fold's base tip and predicate come from `mergeBaseTips`,
 * or with `openedAt` (the PR's `$createdAt`) from `prBaseTips`.
 */
interface BaseHistory {
  readonly updates: readonly RefUpdate[]
  readonly configHistory?: readonly ConfigDoc[]
  readonly refNameHash: string
  readonly openedAt?: number
}

function baseTipsOf(h: BaseHistory): MergeBaseTips {
  return h.openedAt === undefined
    ? mergeBaseTips(h.updates, h.configHistory ?? [], h.refNameHash)
    : prBaseTips(h.updates, h.configHistory ?? [], h.refNameHash, h.openedAt)
}

/** The fold's base tip and merge predicate: from `baseHistory` when given, else as supplied. */
function foldBase(
  v: Vector,
  inp: { readonly baseHistory?: BaseHistory; readonly baseTip?: string | null; readonly ancestry?: Pairs },
): [string | undefined, IsAncestor] {
  if (inp.baseHistory === undefined) {
    return [inp.baseTip ?? undefined, ancestryFromPairs(inp.ancestry ?? [])]
  }
  expect(inp.baseTip ?? null, `vector ${v.name}: baseHistory replaces baseTip`).toBeNull()
  expect(inp.ancestry ?? [], `vector ${v.name}: baseHistory replaces ancestry`).toEqual([])
  const h = inp.baseHistory
  expect(Object.keys(h).filter((k) => !['updates', 'configHistory', 'refNameHash', 'openedAt'].includes(k))).toEqual([])
  const tips = baseTipsOf(h)
  return [tips.tip ?? undefined, (oid) => tips.historical.includes(oid)]
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

function runCaseBase(v: Vector): void {
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
    case 'overlay': {
      const inp = v.input as OverlayInput
      expect(overlayTree(inp.base, inp.diffs ?? [])).toEqual(v.expected)
      break
    }
    default:
      throw new Error(`unknown base vector case: ${v.case}`)
  }
}

/**
 * The keys each v2 input record may carry. The harness refuses any other key, at any depth,
 * as the Rust harness does, so a vector cannot carry a field (a retired `tokenRecords`, a misspelt
 * `supersedes`) that the rules silently ignore.
 */
const EVENT_KEYS = ['id', 'targetId', 'kind', 'actor', 'value', 'oid', 'refId', 'createdAt']
const MEMBERSHIP_KEYS = ['identity', 'role', 'createdAt']
const NESTED_KEYS: Readonly<Record<string, readonly string[]>> = {
  events: EVENT_KEYS,
  authorEvents: EVENT_KEYS,
  copies: ['id', 'packHash', 'ownerRole', 'createdAt', 'verified', 'supersedes'],
  reviews: ['id', 'reviewer', 'verdict', 'commitOid', 'createdAt'],
  memberships: MEMBERSHIP_KEYS,
  queries: ['identity', 'at'],
  policy: ['requiredApprovals', 'approverRole', 'requireChecks', 'mergeMethods'],
  comments: ['id', 'owner', 'reviewId', 'createdAt'],
  doc: [
    'kind', 'title', 'body', 'refName', 'baseRefName', 'sourceRefName',
    'refNameHash', 'baseRefNameHash', 'sourceRefNameHash',
    'defaultBranch', 'protectedPatterns', 'path', 'enc', 'epoch',
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
      onlyKeys(v, ['transitions', 'sum', 'events'], TRANSITION_NESTED)
      const inp = v.input as StateInput
      const [code] = stateOf(v, inp)
      expect(v2.issueStateV2(code, inp.events ?? [])).toEqual(v.expected)
      break
    }
    case 'fold_pr': {
      onlyKeys(v, ['transitions', 'sum', 'mergeOid', 'events', 'baseTip', 'ancestry', 'baseHistory'], TRANSITION_NESTED)
      const inp = v.input as StateInput & {
        readonly baseTip?: string | null
        readonly ancestry?: Pairs
        readonly baseHistory?: BaseHistory
      }
      const [baseTip, isAncestor] = foldBase(v, inp)
      const [code, mergeOid] = stateOf(v, inp)
      expect(v2.prStateV2(code, mergeOid, inp.events ?? [], baseTip, isAncestor)).toEqual(v.expected)
      break
    }
    case 'transition_moves': {
      onlyKeys(v, ['cases'], { cases: ['target', 'code', 'action', 'actor', 'targetNumber'] })
      const { cases } = v.input as {
        readonly cases: readonly {
          readonly target: v2.TransitionTarget
          readonly code: number
          readonly action: v2.MoveAction
          readonly actor: v2.Actor
          readonly targetNumber: number
        }[]
      }
      expect(cases.map((c) => v2.nextTransition(c.target, c.code, c.action, c.actor, c.targetNumber))).toEqual(v.expected)
      break
    }
    case 'transition_fold': {
      onlyKeys(v, ['sums'])
      expect((v.input as { readonly sums: readonly number[] }).sums.map(v2.threadStateOf)).toEqual(v.expected)
      break
    }
    case 'transition_status': {
      onlyKeys(v, ['codes'])
      expect((v.input as { readonly codes: readonly number[] }).codes.map(v2.statusOfCode)).toEqual(v.expected)
      break
    }
    case 'close_reason': {
      onlyKeys(v, ['targetNumber', 'transitions'], TRANSITION_NESTED)
      const inp = v.input as { readonly targetNumber: number; readonly transitions: readonly v2.Transition[] }
      expect(v2.currentCloseReason(inp.transitions, inp.targetNumber)).toEqual(v.expected)
      break
    }
    case 'transition_sum': {
      onlyKeys(v, ['transitions'], TRANSITION_NESTED)
      const { transitions } = v.input as { readonly transitions: readonly v2.Transition[] }
      expect({ code: v2.stateCode(transitions), mergeId: v2.mergeTransition(transitions)?.id ?? null }).toEqual(v.expected)
      break
    }
    case 'repo_counts': {
      onlyKeys(v, ['issues', 'patches', 'kinds'])
      const inp = v.input as { readonly issues: number; readonly patches: number; readonly kinds: Readonly<Record<string, number>> }
      const kinds = new Map(Object.entries(inp.kinds).map(([k, n]) => [Number(k), n] as const))
      expect(v2.repoCounts(inp.issues, inp.patches, kinds)).toEqual(v.expected)
      break
    }
    case 'dense_number': {
      onlyKeys(v, ['issues', 'patches'])
      const inp = v.input as { readonly issues: number; readonly patches: number }
      expect(v2.denseNumber(inp.issues, inp.patches)).toEqual(v.expected)
      break
    }
    case 'dense_refusal': {
      onlyKeys(v, ['messages'])
      expect((v.input as { readonly messages: readonly string[] }).messages.map(v2.namesDenseRule)).toEqual(v.expected)
      break
    }
    case 'check_run_write': {
      const run = ['status', 'startedAt', 'completedAt', 'conclusion', 'externalId']
      onlyKeys(v, ['stored', 'report', 'now'], { stored: run, report: run })
      const inp = v.input as { readonly stored: v2.StoredRun | null; readonly report: v2.RunReport; readonly now: number }
      expect(v2.checkRunWrite(inp.stored, inp.report, inp.now)).toEqual(v.expected)
      break
    }
    case 'upstream_number': {
      onlyKeys(v, ['upstreamNumber', 'author', 'repoOwner', 'memberships'])
      const inp = v.input as {
        readonly upstreamNumber: number | null
        readonly author: string
        readonly repoOwner: string
        readonly memberships: readonly v2.Membership[]
      }
      expect(v2.trustedUpstreamNumber(inp.upstreamNumber, inp.author, inp.repoOwner, new v2.RoleOracle(inp.memberships))).toEqual(v.expected)
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
      onlyKeys(v, ['reviews', 'memberships', 'headOid', 'dismissed', 'prAuthor'])
      const inp = v.input as {
        readonly reviews: readonly v2.Review[]
        readonly memberships: readonly v2.Membership[]
        readonly headOid: string
        readonly dismissed?: readonly string[]
        readonly prAuthor?: string
      }
      const oracle = new v2.RoleOracle(inp.memberships)
      expect(v2.countApprovals(inp.reviews, oracle, inp.headOid, new Set(inp.dismissed ?? []), inp.prAuthor ?? '')).toEqual(v.expected)
      break
    }
    case 'fold_review': {
      onlyKeys(v, ['events', 'authorEvents', 'targetAuthor', 'initialHead', 'knownRoots'])
      const inp = v.input as V2FoldInput & { readonly initialHead: string; readonly knownRoots?: readonly string[] }
      const got = v2.foldPrReviewV2(inp.events ?? [], inp.authorEvents ?? [], inp.targetAuthor, inp.initialHead, new Set(inp.knownRoots ?? []))
      expect(got).toEqual(v.expected)
      break
    }
    case 'policy': {
      onlyKeys(v, ['reviews', 'memberships', 'headOid', 'dismissed', 'prAuthor', 'policy'])
      const inp = v.input as {
        readonly reviews: readonly v2.Review[]
        readonly memberships: readonly v2.Membership[]
        readonly headOid: string
        readonly dismissed?: readonly string[]
        readonly prAuthor?: string
        readonly policy: v2.Policy
      }
      const oracle = new v2.RoleOracle(inp.memberships)
      const approvals = v2.countApprovals(inp.reviews, oracle, inp.headOid, new Set(inp.dismissed ?? []), inp.prAuthor ?? '')
      expect(v2.meetsPolicy(approvals, oracle, inp.policy)).toEqual(v.expected)
      break
    }
    case 'anchor': {
      onlyKeys(v, ['path', 'line', 'startLine', 'side', 'commitOid'])
      expect(v2.anchorOf(v.input as v2.AnchorFields)).toEqual(v.expected)
      break
    }
    case 'review_group': {
      onlyKeys(v, ['reviewId', 'reviewer', 'commentCount', 'comments'])
      const inp = v.input as {
        readonly reviewId: string
        readonly reviewer: string
        readonly commentCount?: number
        readonly comments: readonly v2.ReviewComment[]
      }
      expect(v2.groupReviewComments(inp.reviewId, inp.reviewer, inp.commentCount, inp.comments)).toEqual(v.expected)
      break
    }
    case 'suggestion': {
      onlyKeys(v, ['body', 'file', 'startLine', 'endLine', 'text'])
      const inp = v.input as { readonly body?: string; readonly file?: string; readonly startLine?: number; readonly endLine?: number; readonly text?: string }
      if (inp.body !== undefined) expect(v2.parseSuggestions(inp.body)).toEqual(v.expected)
      else expect(v2.applySuggestion(inp.file as string, inp.startLine as number, inp.endLine as number, inp.text ?? '')).toEqual(v.expected)
      break
    }
    case 'linked_issues': {
      onlyKeys(v, ['text'])
      expect(v2.linkedIssues((v.input as { readonly text: string }).text)).toEqual(v.expected)
      break
    }
    case 'checks': {
      onlyKeys(v, ['runs', 'headOid', 'memberships', 'runners', 'policy'], {
        runs: ['id', 'headOid', 'name', 'status', 'conclusion', 'reporter', 'createdAt'],
        memberships: MEMBERSHIP_KEYS,
        policy: ['requireChecks', 'requiredChecks', 'requiredCheckSources'],
      })
      const inp = v.input as {
        readonly runs: readonly v2.CheckRunRow[]
        readonly headOid: string
        readonly memberships: readonly v2.Membership[]
        readonly runners?: readonly string[]
        readonly policy: v2.ChecksPolicy
      }
      expect(v2.checksState(inp.runs, inp.headOid, new v2.RoleOracle(inp.memberships), new Set(inp.runners ?? []), inp.policy)).toEqual(v.expected)
      break
    }
    case 'thread_meta':
    case 'pinned': {
      onlyKeys(v, ['events'])
      const { events } = v.input as { readonly events: readonly Event[] }
      expect(v.case === 'pinned' ? v2.pinnedTargets(events) : v2.foldThreadMetaV2(events)).toEqual(v.expected)
      break
    }
    case 'hidden_items': {
      onlyKeys(v, ['threadId', 'threadAuthor', 'owner', 'maintainers', 'proved', 'events', 'comments', 'reviews'], {
        events: EVENT_KEYS,
        comments: ['id', 'author', 'reviewId'],
        reviews: ['id', 'author'],
      })
      const inp = v.input as v2.HideScope & {
        readonly events: readonly Event[]
        readonly comments?: readonly v2.ThreadItem[]
        readonly reviews?: readonly v2.ThreadItem[]
      }
      expect(v2.hiddenItems(inp.events, inp, inp.comments ?? [], inp.reviews ?? [])).toEqual(v.expected)
      break
    }
    case 'milestones': {
      onlyKeys(v, ['docs', 'items'], {
        docs: ['id', 'title', 'description', 'dueOn', 'closed', 'createdAt'],
        items: ['open', 'milestone'],
      })
      const inp = v.input as { readonly docs: readonly v2.MilestoneDoc[]; readonly items?: readonly v2.MilestoneItem[] }
      expect(v2.foldMilestonesV2(inp.docs, inp.items ?? [])).toEqual(v.expected)
      break
    }
    case 'trending': {
      onlyKeys(v, ['beats', 'grid', 'now', 'selector', 'limit'], { beats: ['repo', 'createdAt'], grid: ['range', 'step', 'phase'] })
      const inp = v.input as {
        readonly beats: readonly v2.StarBeat[]
        readonly grid: v2.TimeGrid
        readonly now: number
        readonly selector: v2.TrendingSelector
        readonly limit: number
      }
      expect({
        window: v2.trendingWindow(inp.grid, inp.now, inp.selector),
        ranking: v2.trendingRecount(inp.beats, inp.grid, inp.now, inp.selector, inp.limit),
      }).toEqual(v.expected)
      break
    }
    case 'well_formed': {
      onlyKeys(v, ['doc', 'visibility'])
      const inp = v.input as { readonly doc: v2.ContentDoc; readonly visibility: v2.Visibility }
      expect(v2.isWellFormed(inp.doc, inp.visibility)).toEqual(v.expected)
      break
    }
    case 'merge_base_tips':
    case 'pr_base_tips': {
      onlyKeys(v, ['updates', 'configHistory', 'refNameHash', 'openedAt'])
      const inp = v.input as BaseHistory
      expect(inp.openedAt !== undefined, `vector ${v.name}: openedAt is given exactly for pr_base_tips`).toBe(v.case === 'pr_base_tips')
      expect(baseTipsOf(inp)).toEqual(v.expected)
      break
    }
    case 'ref_name_hashes': {
      onlyKeys(v, ['doc', 'refKey'])
      const inp = v.input as { readonly doc: v2.ContentDoc; readonly refKey?: string }
      expect(v2.refNameHashesAgree(inp.doc, inp.refKey ?? null)).toEqual(v.expected)
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
        approverAt: oracle.approverAt(q.identity, q.at),
      }))
      expect(got).toEqual(v.expected)
      break
    }
    default:
      throw new Error(`unknown v2 vector case: ${v.case}`)
  }
}

/** Run one vector under the rule set its `rules` field names (absent = base). */
function runVector(v: Vector): void {
  if (v.rules === undefined) runCaseBase(v)
  else if (v.rules === 'v2') runCaseV2(v)
  else throw new Error(`unknown vector rule set "${v.rules}" in ${v.name}`)
}

interface V2FoldInput {
  readonly events?: readonly Event[]
  readonly authorEvents?: readonly Event[]
  readonly targetAuthor: string
}

/** A target's state: its transitions, or (a list row) only their proved `delta` sum. */
interface StateInput {
  readonly transitions?: readonly v2.Transition[]
  readonly sum?: number
  readonly mergeOid?: string
  readonly events?: readonly Event[]
}

const TRANSITION_NESTED: Readonly<Record<string, readonly string[]>> = {
  ...NESTED_KEYS,
  transitions: ['id', 'kind', 'actor', 'oid', 'asAuthor', 'createdAt', 'reason', 'dupNumber'],
}

/** The state code and merge oid, from exactly one of `transitions` and `sum` (parity: Rust `state_of`). */
function stateOf(v: Vector, inp: StateInput): [number, string | null] {
  expect(inp.sum !== null, `vector ${v.name}: sum is a number or absent`).toBe(true)
  expect((inp.transitions === undefined) !== (inp.sum === undefined), `vector ${v.name}: exactly one of transitions and sum`).toBe(true)
  if (inp.transitions !== undefined) {
    expect(inp.mergeOid, `vector ${v.name}: mergeOid goes with sum`).toBeUndefined()
    return [v2.stateCode(inp.transitions), v2.mergeTransition(inp.transitions)?.oid ?? null]
  }
  return [inp.sum as number, inp.mergeOid ?? null]
}

describe('FORGE_RULES conformance vectors', () => {
  const vectors = loadVectors()
  const base = vectors.filter((v) => v.rules === undefined)
  // `private_*` cases (private-repos.md §11) run in `lib/private/conformance.test.ts`.
  const isPrivate = (v: Vector) => v.case.startsWith('private_')
  const v2Vectors = vectors.filter((v) => v.rules === 'v2' && !isPrivate(v))
  const privateVectors = vectors.filter(isPrivate)

  it('loads the full vector corpus', () => {
    expect(base.length).toBeGreaterThanOrEqual(45)
    expect(v2Vectors.length).toBeGreaterThanOrEqual(110)
    expect(privateVectors.length).toBeGreaterThanOrEqual(138)
    expect(base.length + v2Vectors.length + privateVectors.length).toBe(vectors.length)
  })

  it('knows every vector rule set', () => {
    const unknown = vectors.filter((v) => v.rules !== undefined && v.rules !== 'v2')
    expect(unknown.map((v) => `${v.name} (rules: ${v.rules})`)).toEqual([])
  })

  it('rejects a vector with an unknown rule set', () => {
    expect(() => runVector({ name: 'x', description: '', case: 'resolve_ref', rules: 'v1', input: {}, expected: null })).toThrow(
      /unknown vector rule set/,
    )
  })

  for (const v of base) {
    it(`base ${v.case} :: ${v.name}`, () => {
      runVector(v)
    })
  }
  for (const v of v2Vectors) {
    it(`v2 ${v.case} :: ${v.name}`, () => {
      runVector(v)
    })
  }
})
