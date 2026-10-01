/**
 * The toast each charged write shows (`ux-dx-spec.md` §4 rule 2): its title, and the group that
 * folds one action's several writes into one toast (`hooks/use-toasts`).
 */

import { useToasts } from '../hooks/use-toasts'
import { currentSpendAction, inSpendScope } from './sdk/spend-scope'
import { measurementsSettled, type SpendEvent } from './sdk/write'

/** A write kind (`create:issue`) → the toast title. */
const SPEND_TITLES: Readonly<Record<string, string>> = {
  'create:repo': 'Repository created',
  'replace:repo': 'Repository details saved',
  'create:maintainer': 'Maintainer added',
  'create:writer': 'Writer added',
  'create:consent': 'Invitation accepted',
  'create:config': 'Repository config written',
  'create:repoKey': 'Repo key handed out',
  'create:policy': 'Branch policy saved',
  'create:topic': 'Topic added',
  'delete:topic': 'Topic removed',
  'create:packManifest': 'Pack recorded',
  'create:chunk': 'Pack data stored',
  'create:refUpdate': 'Branch updated',
  'create:protectedRefUpdate': 'Protected branch updated',
  'create:issue': 'Issue created',
  'replace:issue': 'Issue edited',
  'create:patch': 'Pull request opened',
  'replace:patch': 'Pull request edited',
  'create:comment': 'Comment posted',
  'replace:comment': 'Comment edited',
  'delete:comment': 'Comment deleted',
  'create:event': 'State event recorded',
  'create:authorEvent': 'State event recorded',
  'create:transition': 'State changed',
  'create:review': 'Review submitted',
  'create:label': 'Label saved',
  'delete:label': 'Label deleted',
  'create:milestone': 'Milestone saved',
  'delete:milestone': 'Milestone deleted',
  'create:checkRun': 'Check result recorded',
  // Every release revision (publish, edit, yank, unpublish) is this kind: the dialog says which (QW-077).
  'create:release': 'Release saved',
  'delete:release': 'Release revision deleted',
  'create:webhook': 'Webhook saved',
  'replace:webhook': 'Webhook saved',
  'delete:webhook': 'Webhook revision deleted',
  'create:star': 'Starred',
  'create:starBeat': 'Trending beat recorded',
  'create:watch': 'Watching',
  'create:follow': 'Following',
  'delete:star': 'Unstarred',
  'delete:watch': 'Unwatched',
  'delete:follow': 'Unfollowed',
  'delete:maintainer': 'Maintainer removed',
  'delete:writer': 'Writer removed',
  'create:profile': 'Profile saved',
  'replace:profile': 'Profile saved',
  'key:register': "This browser's key registered",
  'key:renew': "This browser's key renewed",
  'key:topup': 'Key budget topped up',
  'key:revoke': 'Key disabled on chain',
  'key:encryption': 'Encryption key registered',
  'key:runner': 'Runner key registered',
  'identity:create': 'Identity created',
}

/** A kind never named above still says what it did, by its verb. */
const VERB_TITLES: Readonly<Record<string, string>> = { create: 'Saved', replace: 'Updated', delete: 'Deleted' }

/** A write kind's toast title. */
export function spendTitle(kind: string): string {
  return SPEND_TITLES[kind] ?? VERB_TITLES[kind.split(':')[0] ?? ''] ?? 'Write confirmed'
}

/** What one action's toast says: while it runs (two writes on), and once it ended. */
export interface SpendActionLabels {
  /** While its writes land: "Forking dips…". */
  readonly running: string
  /** Once every write landed: "Forked dips". */
  readonly done: string
}

interface ActionState {
  readonly labels: SpendActionLabels
  /** The writes reported so far. */
  writes: number
  /** The first write's own title: an action of one write keeps it. */
  first: string | null
  ended: 'ok' | 'failed' | null
}

const actions = new Map<string, ActionState>()
let actionSeq = 0
/** How long an ended action still takes a straggling report (a measurement past its wait). */
const STRAGGLER_MS = 60_000

/** The title (and tone) of an ended action's toast. */
function endedToast(s: ActionState): { title: string; tone?: 'warn'; detail?: string } {
  if (s.writes <= 1) return { title: s.first ?? s.labels.done }
  if (s.ended === 'failed') {
    return { title: `${s.labels.running.replace(/…$/, '')} stopped part-way`, tone: 'warn', detail: 'Not every write landed; the ones that did are charged.' }
  }
  return { title: s.labels.done }
}

/**
 * Run one user action that may sign several writes (a fork, a Settings save, a merge) so its
 * writes show one toast with their total (QW3-039: a 32-write fork toasted only its last write,
 * "Write confirmed · 0.000671 DASH"). While it runs the toast reads `labels.running`; once the
 * action returned and its last charge was measured, `labels.done`, or the write's own title when
 * there was only one ("Comment edited"). An action inside another is part of it.
 */
export async function spendAction<T>(labels: SpendActionLabels, run: () => Promise<T>): Promise<T> {
  if (currentSpendAction() !== null) return run()
  const id = `action:${++actionSeq}`
  const state: ActionState = { labels, writes: 0, first: null, ended: null }
  actions.set(id, state)
  let ok = false
  try {
    const result = await inSpendScope(id, run)
    ok = true
    return result
  } finally {
    void endAction(id, state, ok)
  }
}

async function endAction(id: string, state: ActionState, ok: boolean): Promise<void> {
  // The action's last write is reported once its charge is measured, after it returned.
  await measurementsSettled()
  state.ended = ok ? 'ok' : 'failed'
  if (state.writes > 0) useToasts.getState().settle(id, endedToast(state))
  setTimeout(() => actions.delete(id), STRAGGLER_MS)
}

/**
 * A write's toast title, and the group that folds an action's writes into one toast: a write
 * made inside {@link spendAction} joins that action's toast (a repo's creation, QW2-034; a fork,
 * a Settings save, QW3-039). Any other write is its own toast.
 */
export function spendToast(event: Pick<SpendEvent, 'kind' | 'action'>): {
  title: string
  group?: string
  pending?: boolean
  tone?: 'warn'
  detail?: string
} {
  const action = event.action === undefined ? undefined : actions.get(event.action)
  if (event.action !== undefined && action !== undefined) {
    action.writes += 1
    if (action.first === null) action.first = spendTitle(event.kind)
    if (action.ended !== null) return { ...endedToast(action), group: event.action, pending: false }
    return { title: action.labels.running, group: event.action, pending: true }
  }
  return { title: spendTitle(event.kind) }
}
