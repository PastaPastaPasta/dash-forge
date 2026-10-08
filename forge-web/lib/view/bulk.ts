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
  /** Of {@link unchanged}, the merged pull requests a close or reopen leaves alone. */
  readonly merged: number
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
  const merged = action.kind === 'label' ? 0 : rows.filter((r) => r.merged && !changes(action, r)).length
  return { apply, unchanged: rows.length - apply.length, merged }
}

/**
 * What the dialog says of the selected items a batch leaves alone: "2 selected are already that
 * way and are left as they are.", and a merged pull request as "already merged". Null: none.
 */
export function unchangedNote(plan: BulkPlan): string | null {
  const one = (n: number, what: string): string => `${n} selected ${n === 1 ? 'is' : 'are'} ${what} and ${n === 1 ? 'is' : 'are'} left as ${n === 1 ? 'it is' : 'they are'}.`
  const others = plan.unchanged - plan.merged
  const parts = [others > 0 ? one(others, 'already that way') : '', plan.merged > 0 ? one(plan.merged, 'already merged') : ''].filter((x) => x !== '')
  return parts.length === 0 ? null : parts.join(' ')
}

/**
 * Why the bar's Close is disabled, or null when some selected item is open: a merged pull
 * request is never closed, and a closed item is closed already.
 */
export function closeBlocked(rows: readonly BulkRow[]): string | null {
  if (rows.some((r) => changes({ kind: 'close' }, r))) return null
  return rows.every((r) => r.merged) ? "Merged pull requests can't be closed." : 'Nothing selected is open.'
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
 * - `unchanged`: nothing was written (it was already in that state when its write was made; its
 *   `message` says how, e.g. "Already merged.");
 * - `unconfirmed`: sent, not yet shown: it may still land (a retry finishes it, never repeats it);
 * - `failed`: refused or not sent, with why;
 * - `stopped`: not tried, because the batch stopped first (out of funds, or asked to stop).
 */
export type BulkStatus = 'waiting' | 'running' | 'done' | 'unchanged' | 'unconfirmed' | 'failed' | 'stopped'

export interface BulkOutcome {
  readonly status: BulkStatus
  /** Why it failed or is unconfirmed, or what an unchanged item already was. */
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
 * in that state; `note` says how, when the generic "already" line is not it). `onOutcome` hears
 * each item as it starts and as it ends. A failure that `stop`s marks every later item `stopped`;
 * so does `shouldStop()` turning true between items. Resolves with every item's final outcome.
 */
export async function runBatch<R extends { readonly id: string }>(
  items: readonly R[],
  opts: {
    readonly intent: string
    readonly write: (item: R, intent: string) => Promise<{ readonly changed: boolean; readonly note?: string }>
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
      const { changed, note } = await opts.write(item, itemIntent(opts.intent, item.id))
      set(item.id, changed ? { status: 'done' } : note !== undefined ? { status: 'unchanged', message: note } : { status: 'unchanged' })
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

/** What an item that needed no write says: someone else made the change first. */
export function unchangedWord(action: BulkAction): string {
  switch (action.kind) {
    case 'close':
      return 'Already closed.'
    case 'reopen':
      return 'Already open.'
    case 'label':
      return action.add ? 'Already has the label.' : "Doesn't have the label."
  }
}

/** What a merged pull request says when a close or reopen finds it merged since the list was read. */
export const ALREADY_MERGED = 'Already merged.'

/** How many items a batch left as they were, for its summary line: "2 were already that way." */
export function unchangedSummary(n: number): string {
  return `${n} ${n === 1 ? 'was' : 'were'} already that way.`
}

/** Where a menu panel sits, in viewport pixels: `top` below its button, or `bottom` above it. */
export interface MenuPlacement {
  readonly left: number
  readonly width: number
  readonly maxHeight: number
  readonly top?: number
  readonly bottom?: number
}

const MENU_MARGIN = 8
const MENU_GAP = 4

/**
 * Place a menu panel (`want` size at most) by its button `anchor` so it stays inside the viewport
 * `view`: shifted left and narrowed on a phone, and above the button when there is more room
 * there than below. Pure, so the list's clipping box never decides where a menu may be.
 */
export function menuPlacement(
  anchor: { readonly left: number; readonly top: number; readonly bottom: number },
  view: { readonly width: number; readonly height: number },
  want: { readonly width: number; readonly height: number } = { width: 240, height: 288 },
): MenuPlacement {
  const width = Math.max(0, Math.min(want.width, view.width - 2 * MENU_MARGIN))
  const left = Math.max(MENU_MARGIN, Math.min(anchor.left, view.width - width - MENU_MARGIN))
  const below = view.height - anchor.bottom - MENU_GAP - MENU_MARGIN
  const above = anchor.top - MENU_GAP - MENU_MARGIN
  if (below >= Math.min(want.height, 160) || below >= above) {
    return { left, width, top: anchor.bottom + MENU_GAP, maxHeight: Math.max(0, Math.min(want.height, below)) }
  }
  return { left, width, bottom: view.height - anchor.top + MENU_GAP, maxHeight: Math.max(0, Math.min(want.height, above)) }
}
