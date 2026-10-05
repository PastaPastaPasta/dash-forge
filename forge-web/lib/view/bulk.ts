/**
 * Bulk actions on the issue and pull request lists, as GitHub's list offers them: close, reopen,
 * and add or remove a label on the selected rows. Platform takes one transition per write, so a
 * batch is one write per item, signed one after another. Pure: no SDK, no React.
 *
 * - {@link planBulk}: which selected items an action changes (an issue already closed is not
 *   closed again; a label is added only where it is missing).
 * - {@link runBatch}: the writes in order, reporting each item's outcome as it lands. An item's
 *   intent is the batch's plus the item, so "Retry failed" finishes an attempt that may have
 *   landed instead of signing a second write.
 */

/** A row the bulk bar can act on (an issue or a pull request of the list page). */
export interface BulkRow {
  readonly id: string
  readonly number: number
  readonly title: string
  readonly author: string
  readonly open: boolean
  /** A merged pull request: never closed or reopened. */
  readonly merged: boolean
  readonly labels: readonly string[]
}

/** Why an issue is closed (pull requests close without one). */
export type BulkCloseReason = 'completed' | 'not_planned'

export type BulkAction =
  | { readonly kind: 'close'; readonly reason?: BulkCloseReason }
  | { readonly kind: 'reopen' }
  | { readonly kind: 'label'; readonly label: string; readonly add: boolean }

/** The items an action writes to, and how many selected ones it leaves as they are. */
export interface BulkPlan<R extends BulkRow = BulkRow> {
  readonly apply: readonly R[]
  readonly unchanged: number
}

/** Whether `action` changes `row`. */
export function changes(action: BulkAction, row: BulkRow): boolean {
  switch (action.kind) {
    case 'close':
      return row.open
    case 'reopen':
      return !row.open && !row.merged
    case 'label':
      return row.labels.includes(action.label) !== action.add
  }
}

export function planBulk<R extends BulkRow>(action: BulkAction, rows: readonly R[]): BulkPlan<R> {
  const apply = rows.filter((r) => changes(action, r))
  return { apply, unchanged: rows.length - apply.length }
}

/** Whether every selected row is closed (and none merged): the bar offers Reopen, not Close. */
export function allReopenable(rows: readonly BulkRow[]): boolean {
  return rows.length > 0 && rows.every((r) => !r.open && !r.merged)
}

/** How many of `rows` carry `label`: `all`, `some` or `none` (the label menu's tick). */
export function labelCoverage(rows: readonly BulkRow[], label: string): 'all' | 'some' | 'none' {
  const n = rows.filter((r) => r.labels.includes(label)).length
  return n === 0 ? 'none' : n === rows.length ? 'all' : 'some'
}

/**
 * One item's outcome:
 * - `waiting`: not reached yet; `running`: its write is being signed and sent;
 * - `done`: written and shown on Platform;
 * - `unchanged`: nothing was written (it was already in that state when its write was made);
 * - `unconfirmed`: sent, not yet shown: it may still land (a retry finishes it, never repeats it);
 * - `failed`: refused or not sent, with why;
 * - `stopped`: not tried, because the batch stopped first (out of funds, or asked to stop).
 */
export type BulkStatus = 'waiting' | 'running' | 'done' | 'unchanged' | 'unconfirmed' | 'failed' | 'stopped'

export interface BulkOutcome {
  readonly status: BulkStatus
  /** Why it failed or is unconfirmed. */
  readonly message?: string
}

/** What a write's error means for its item and for the rest of the batch. */
export interface BulkFailure {
  readonly message: string
  /** Sent, not yet shown: it may still land. */
  readonly unconfirmed: boolean
  /** No later write can succeed either (balance or key budget spent, key expired): stop here. */
  readonly stop: boolean
}

/** Whether an item is left for "Retry failed". */
export function retryable(o: BulkOutcome | undefined): boolean {
  return o !== undefined && (o.status === 'failed' || o.status === 'unconfirmed' || o.status === 'stopped')
}

/** The intent of one item's write in a batch: the same on every retry of that batch. */
export function itemIntent(batchIntent: string, itemId: string): string {
  return `${batchIntent}:${itemId}`
}

/**
 * Write `items` in order, one at a time (each is its own transition, and one identity's writes
 * take nonces in order). `write` returns whether it wrote anything (false: the item was already
 * in that state). `onOutcome` hears each item as it starts and as it ends. A failure that `stop`s
 * marks every later item `stopped`; so does `shouldStop()` turning true between items.
 * Resolves with every item's final outcome.
 */
export async function runBatch<R extends { readonly id: string }>(
  items: readonly R[],
  opts: {
    readonly intent: string
    readonly write: (item: R, intent: string) => Promise<{ readonly changed: boolean }>
    readonly classify: (e: unknown) => BulkFailure
    readonly onOutcome?: (id: string, outcome: BulkOutcome) => void
    readonly shouldStop?: () => boolean
  },
): Promise<ReadonlyMap<string, BulkOutcome>> {
  const out = new Map<string, BulkOutcome>()
  const set = (id: string, o: BulkOutcome): void => {
    out.set(id, o)
    opts.onOutcome?.(id, o)
  }
  let halted = false
  for (const item of items) {
    if (halted || opts.shouldStop?.() === true) {
      halted = true
      set(item.id, { status: 'stopped' })
      continue
    }
    set(item.id, { status: 'running' })
    try {
      const { changed } = await opts.write(item, itemIntent(opts.intent, item.id))
      set(item.id, { status: changed ? 'done' : 'unchanged' })
    } catch (e) {
      const f = opts.classify(e)
      set(item.id, { status: f.unconfirmed ? 'unconfirmed' : 'failed', message: f.message })
      if (f.stop) halted = true
    }
  }
  return out
}

/** Counts of a batch's outcomes, for its summary line. */
export function tally(outcomes: ReadonlyMap<string, BulkOutcome>): Readonly<Record<BulkStatus, number>> {
  const t: Record<BulkStatus, number> = { waiting: 0, running: 0, done: 0, unchanged: 0, unconfirmed: 0, failed: 0, stopped: 0 }
  for (const o of outcomes.values()) t[o.status]++
  return t
}

/** "issue" / "issues", "pull request" / "pull requests". */
export function nounFor(kind: 'issue' | 'pull', n: number): string {
  const one = kind === 'issue' ? 'issue' : 'pull request'
  return n === 1 ? one : `${one}s`
}

/** What a batch does, in words: "Close 3 issues as not planned", "Add bug to 2 pull requests". */
export function actionTitle(action: BulkAction, kind: 'issue' | 'pull', n: number): string {
  const what = `${n} ${nounFor(kind, n)}`
  switch (action.kind) {
    case 'close':
      return `Close ${what}${action.reason === 'not_planned' ? ' as not planned' : ''}`
    case 'reopen':
      return `Reopen ${what}`
    case 'label':
      return action.add ? `Add ${action.label} to ${what}` : `Remove ${action.label} from ${what}`
  }
}

/** The past tense of an item's success, for its row in the progress list. */
export function doneWord(action: BulkAction): string {
  switch (action.kind) {
    case 'close':
      return 'Closed'
    case 'reopen':
      return 'Reopened'
    case 'label':
      return action.add ? 'Label added' : 'Label removed'
  }
}
