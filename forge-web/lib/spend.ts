/**
 * The local spend ledger (`ux-dx-spec.md` §4 rule 3): one row per broadcast write — estimate,
 * actual balance change, repo and kind — kept in IndexedDB on this device only.
 *
 * Settings → Spend reads it back as month / all-time totals by repo, flags estimates that
 * missed by more than 25 % (how estimate drift gets noticed), and reconciles the ledger
 * against the identity's balance change since the ledger's first row.
 */

import type { Network } from './constants'
import { idbEntries, idbGet, idbPut } from './idb'
import type { SpendEvent } from './sdk/write'

/** A ledger row (the balance before the write is not stored: only the baseline keeps one). */
export interface SpendRow extends Omit<SpendEvent, 'balanceBefore'> {
  readonly at: number
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
 * Record a write. The first write of an identity's ledger seeds the reconciliation baseline
 * with the balance read right before that write (writes of one identity are serialized, so
 * no other write of this browser can sit between that read and this row).
 */
export async function recordSpend(event: SpendEvent): Promise<void> {
  const at = Date.now()
  const { balanceBefore, ...rest } = event
  const row: SpendRow = { ...rest, at }
  const key = `${prefix(event.network, event.identityId)}${String(at).padStart(15, '0')}:${event.documentId}`
  await idbPut('spend', key, row)
  const bk = baselineKey(event.network, event.identityId)
  if (balanceBefore !== null && (await idbGet<Baseline>('spend', bk)) === undefined) {
    await idbPut<Baseline>('spend', bk, { at, balanceCredits: balanceBefore.toString() })
  }
}

/** Every row of an identity's ledger, oldest first. */
export async function readLedger(network: Network, identityId: string): Promise<SpendRow[]> {
  const rows = await idbEntries<SpendRow>('spend', prefix(network, identityId))
  return rows.map(([, v]) => v).sort((a, b) => a.at - b.at)
}

/** The ledger's baseline balance (credits), or null before the first write. */
export async function readBaseline(network: Network, identityId: string): Promise<{ at: number; credits: bigint } | null> {
  const b = await idbGet<Baseline>('spend', baselineKey(network, identityId))
  return b === undefined ? null : { at: b.at, credits: BigInt(b.balanceCredits) }
}

/** An estimate that missed its actual by more than a quarter (`ux-dx-spec.md` §4 rule 2). */
export function estimateMissed(row: Pick<SpendRow, 'estimateCredits' | 'actualCredits'>): boolean {
  if (row.actualCredits === null || row.estimateCredits === 0) return false
  return Math.abs(row.actualCredits - row.estimateCredits) > Math.abs(row.estimateCredits) * 0.25
}

/** Totals by repo (credits; the credits a row took, refunds negative). */
export interface SpendSummary {
  readonly allTime: number
  readonly thisMonth: number
  readonly byRepo: ReadonlyArray<{ readonly repo: string; readonly credits: number; readonly writes: number }>
  readonly missed: number
}

/** Summarize a ledger. A row with no measured actual counts at its estimate. */
export function summarize(rows: readonly SpendRow[], now = Date.now()): SpendSummary {
  const month = new Date(now)
  const monthStart = new Date(month.getFullYear(), month.getMonth(), 1).getTime()
  const byRepo = new Map<string, { credits: number; writes: number }>()
  let allTime = 0
  let thisMonth = 0
  let missed = 0
  for (const r of rows) {
    const credits = r.actualCredits ?? r.estimateCredits
    allTime += credits
    if (r.at >= monthStart) thisMonth += credits
    if (estimateMissed(r)) missed += 1
    const key = r.repo ?? '(no repo)'
    const e = byRepo.get(key) ?? { credits: 0, writes: 0 }
    byRepo.set(key, { credits: e.credits + credits, writes: e.writes + 1 })
  }
  return {
    allTime,
    thisMonth,
    missed,
    byRepo: [...byRepo.entries()]
      .map(([repo, v]) => ({ repo, ...v }))
      .sort((a, b) => b.credits - a.credits),
  }
}

/**
 * The reconciliation line: what the ledger explains vs what the balance actually moved since
 * the ledger began. Positive `unexplained` = spent elsewhere (another app or key); negative =
 * credited (a top-up).
 */
export function reconcile(
  ledgerCredits: number,
  baseline: bigint | null,
  currentBalance: bigint | null,
): { balanceChange: number; unexplained: number } | null {
  if (baseline === null || currentBalance === null) return null
  const balanceChange = Number(baseline - currentBalance)
  return { balanceChange, unexplained: balanceChange - ledgerCredits }
}
