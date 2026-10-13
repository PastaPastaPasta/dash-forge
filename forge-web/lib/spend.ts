/**
 * The local spend ledger (`ux-dx-spec.md` §4 rule 3): one row per broadcast write — estimate,
 * actual balance change, repo and kind — kept in IndexedDB on this device only.
 *
 * Settings → Spend reads it back as month / all-time totals by repo, flags estimates that
 * missed by more than 25 % (how estimate drift gets noticed), and reconciles the ledger
 * against the identity's balance change since the ledger's first row.
 */

import { NETWORKS, type Network } from './constants'
import { idbBatch, idbEntries, idbGet, idbPut } from './idb'
import type { SpendEvent } from './sdk/write'

/** A ledger row. */
export interface SpendRow extends Omit<SpendEvent, 'balanceBefore'> {
  readonly at: number
  /**
   * The balance the write started from (credits, decimal), when it was read: a balance still
   * equal to it after the write was charged is a node that has not seen the write yet. Absent on
   * rows recorded before it was kept.
   */
  readonly balanceBefore?: string
}

/** A ledger's starting point: the balance before its first recorded write. */
interface Baseline {
  readonly at: number
  readonly balanceCredits: string
}

function prefix(network: Network, identityId: string): string {
  return `spend:${network}:${identityId}:`
}

function baselineKey(network: Network, identityId: string): string {
  return `baseline:${network}:${identityId}`
}

/**
 * Delete this browser's spend ledger for `identityId` (its rows and baseline): "Sign out &
 * forget key" leaves no record of what the identity spent here (QW2-028).
 */
export async function clearLedger(network: Network, identityId: string): Promise<void> {
  await Promise.allSettled([...storingNow])
  const rows = await idbEntries('spend', prefix(network, identityId))
  await idbBatch('spend', [...rows.map(([k]) => [k, undefined] as const), [baselineKey(network, identityId), undefined] as const])
}

/** Rows being stored now: a clear waits for them, so none lands after it (QW2-028). */
const storingNow = new Set<Promise<void>>()

/** Told of every write this tab records (whether or not its ledger row could be stored). */
const recorded = new Set<(event: SpendEvent) => void>()

/** Listen for this tab's writes (the inbox, to watch a thread the moment one joins it); returns the unsubscribe. */
export function onSpendRecorded(listener: (event: SpendEvent) => void): () => void {
  recorded.add(listener)
  return () => {
    recorded.delete(listener)
  }
}

/**
 * Record a write. The first write of an identity's ledger seeds the reconciliation baseline
 * with the balance read right before that write (writes of one identity are serialized, so
 * no other write of this browser can sit between that read and this row).
 */
export async function recordSpend(event: SpendEvent): Promise<void> {
  const storing = storeSpend(event)
  storingNow.add(storing)
  try {
    await storing
  } finally {
    storingNow.delete(storing)
    // The write happened even if the ledger could not keep it (no IndexedDB, quota).
    for (const listener of recorded) {
      try {
        listener(event)
      } catch {
        /* a listener's failure is its own */
      }
    }
  }
}

async function storeSpend(event: SpendEvent): Promise<void> {
  const at = Date.now()
  const { balanceBefore, ...rest } = event
  const row: SpendRow = { ...rest, at, ...(balanceBefore !== null ? { balanceBefore: balanceBefore.toString() } : {}) }
  // The kind is part of the key: two spends on one document in the same millisecond (a key's
  // registration, then its top-up) are two rows, never one overwriting the other.
  const key = `${prefix(event.network, event.identityId)}${String(at).padStart(15, '0')}:${event.documentId}:${event.kind}`
  await idbPut('spend', key, row)
  const bk = baselineKey(event.network, event.identityId)
  if (balanceBefore !== null && (await idbGet<Baseline>('spend', bk)) === undefined) {
    await idbPut<Baseline>('spend', bk, { at, balanceCredits: balanceBefore.toString() })
  }
}

/** Every row of an identity's ledger, oldest first. */
export async function readLedger(network: Network, identityId: string): Promise<SpendRow[]> {
  const rows = await idbEntries<SpendRow>('spend', prefix(network, identityId))
  const v2 = NETWORKS[network].v2
  const contracts = new Set(v2 === null ? [] : [v2.core, v2.collab, v2.community])
  return rows.map(([, v]) => repairRepo(v, contracts)).sort((a, b) => a.at - b.at)
}

/**
 * Rows recorded before QW-054 named a contract's id as the repo of a write to a document without
 * a `repoId`: a repo's creation (or its refused attempt), whose own document id is the repo, and
 * repo-less writes such as follows, which belong to no repo. Read them as that.
 */
export function repairRepo(row: SpendRow, contracts: ReadonlySet<string> = new Set()): SpendRow {
  if (/^(create|refused):repo$/.test(row.kind) && row.repo !== row.documentId) return { ...row, repo: row.documentId }
  if (row.repo !== null && contracts.has(row.repo)) return { ...row, repo: null }
  return row
}

/** The ledger's baseline balance (credits), or null before the first write. */
export async function readBaseline(network: Network, identityId: string): Promise<{ at: number; credits: bigint } | null> {
  const b = await idbGet<Baseline>('spend', baselineKey(network, identityId))
  return b === undefined ? null : { at: b.at, credits: BigInt(b.balanceCredits) }
}

/**
 * An estimate its actual missed by more than a quarter (`ux-dx-spec.md` §4 rule 2). A write's
 * preview is a range: the upper bound shown before signing (`estimateCredits`, every first-write
 * surcharge counted until its reads answer) down to the same write with none of them
 * (`estimateMinCredits`). The actual misses when it lands more than 25 % outside that range
 * (QW-043: a range whose actual sat at its steady end was flagged against the bound). A refund
 * (negative) is a promise of at least that much back: it misses only when a quarter less came
 * back. A row without a range (older rows, fixed-price writes) is judged against its estimate.
 */
export function estimateMissed(row: Pick<SpendRow, 'estimateCredits' | 'estimateMinCredits' | 'actualCredits'>): boolean {
  const { actualCredits: actual, estimateCredits: max } = row
  if (actual === null || max === 0) return false
  if (max < 0) return actual > max * 0.75
  const min = Math.min(row.estimateMinCredits ?? max, max)
  return actual > max * 1.25 || actual < min * 0.75
}

/** A ledger row that credited the identity (a top-up from this browser), not a spend. */
export function isCredit(row: Pick<SpendRow, 'kind'>): boolean {
  return row.kind === TOP_UP_KIND
}

/** The ledger kind of a top-up this browser made: its actual is the credits added, negative. */
export const TOP_UP_KIND = 'identity:topup'


/** Totals by repo (credits; the credits a row took, refunds negative). Top-ups are not spends. */
export interface SpendSummary {
  readonly allTime: number
  readonly thisMonth: number
  readonly byRepo: ReadonlyArray<{ readonly repo: string; readonly credits: number; readonly writes: number }>
  readonly missed: number
  /** Writes counted (every row but top-ups). */
  readonly writes: number
  /** Credits this browser's top-ups added (positive). */
  readonly credited: number
}

/** The `byRepo` key of rows with no repo: identity actions (key register, top-up, …) and the like. */
export const NO_REPO = '(no repo)'

/** Summarize a ledger. A row with no measured actual counts at its estimate. */
export function summarize(rows: readonly SpendRow[], now = Date.now()): SpendSummary {
  const month = new Date(now)
  const monthStart = new Date(month.getFullYear(), month.getMonth(), 1).getTime()
  const byRepo = new Map<string, { credits: number; writes: number }>()
  let allTime = 0
  let thisMonth = 0
  let missed = 0
  let writes = 0
  let credited = 0
  for (const r of rows) {
    if (isCredit(r)) {
      credited -= r.actualCredits ?? 0
      continue
    }
    writes += 1
    const credits = r.actualCredits ?? r.estimateCredits
    allTime += credits
    if (r.at >= monthStart) thisMonth += credits
    if (estimateMissed(r)) missed += 1
    const key = r.repo ?? NO_REPO
    const e = byRepo.get(key) ?? { credits: 0, writes: 0 }
    byRepo.set(key, { credits: e.credits + credits, writes: e.writes + 1 })
  }
  return {
    allTime,
    thisMonth,
    missed,
    writes,
    credited,
    byRepo: [...byRepo.entries()]
      .map(([repo, v]) => ({ repo, ...v }))
      .sort((a, b) => b.credits - a.credits),
  }
}

/** Whether a row is Forge acting on the identity itself (keys, creation), not a repo write. */
export function isIdentityAction(kind: string): boolean {
  return kind.startsWith('key:') || kind.startsWith('identity:')
}

const KIND_LABELS: Readonly<Record<string, string>> = {
  'key:register': 'Register this browser’s key',
  'key:renew': 'Renew this browser’s key',
  'key:topup': 'Top up key budget',
  'key:revoke': 'Revoke key on Platform',
  'key:encryption': 'Register encryption key',
  'key:runner': 'Register a CI runner key',
  'identity:create': 'Create identity',
  'identity:name': 'Register a username',
  [TOP_UP_KIND]: 'Top up identity',
  'create:repo': 'Create repo',
}

/**
 * What a ledger row's kind reads as in Settings → Spend (the raw kind is `create:issue`,
 * `key:topup`, …).
 */
export function spendKindLabel(kind: string): string {
  const known = KIND_LABELS[kind]
  if (known) return known
  const [verb, type] = kind.split(':')
  if (!type) return kind
  const what = type.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
  return verb === 'create' ? what : `${verb} ${what}`
}

/**
 * Whether the balance can be reconciled with the ledger yet, i.e. it has every recorded write in
 * it. Until then the gap would be the writes the balance misses, read as "top-ups":
 *  - it was read from Platform in this tab (`readAt`; null while a reload shows the kept
 *    session's balance, which dates from when the session was kept), no earlier than the
 *    ledger's last row;
 *  - no write of this identity is still measuring its charge (`measuring`: its row is not out);
 *  - it is not the balance a charged write started from (a node that has not seen that write
 *    answers it, in this tab or after a reload alike).
 */
export function balanceSettled(
  balance: { readonly credits: bigint | null; readonly readAt: number | null; readonly measuring?: boolean },
  rows: readonly Pick<SpendRow, 'at' | 'balanceBefore' | 'actualCredits'>[],
): boolean {
  if (balance.readAt === null || balance.credits === null || balance.measuring === true) return false
  const last = rows.reduce((m, r) => Math.max(m, r.at), -Infinity)
  if (balance.readAt < last) return false
  // The latest few charged writes only (as the write engine's own trail): an old row's starting
  // balance a top-up happened to restore says nothing about lag.
  const now = balance.credits.toString()
  const recent = [...rows].sort((a, b) => a.at - b.at).slice(-RECENT_ROWS)
  return !recent.some((r) => r.balanceBefore === now && r.actualCredits !== null && r.actualCredits !== 0)
}

/** How many of the latest rows `balanceSettled` checks a balance against. */
const RECENT_ROWS = 8

/**
 * The reconciliation line: how the balance moved since the ledger began (`balanceChange`, signed:
 * positive when it grew, QW2-019: a top-up read as a loss), and how much of that the ledger does
 * not explain (`unexplained`, signed the same way: positive = credited from elsewhere, a top-up
 * this browser did not make; negative = spent elsewhere, another app or key). `ledgerNet` is what
 * the ledger's rows took since the baseline: spends less refunds less this browser's top-ups.
 */
export function reconcile(
  ledgerNet: number,
  baseline: bigint | null,
  currentBalance: bigint | null,
): { balanceChange: number; unexplained: number } | null {
  if (baseline === null || currentBalance === null) return null
  const balanceChange = Number(currentBalance - baseline)
  return { balanceChange, unexplained: balanceChange + ledgerNet }
}
