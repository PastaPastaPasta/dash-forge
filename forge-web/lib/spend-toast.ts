/**
 * The toast each charged write shows (`ux-dx-spec.md` §4 rule 2): its title, and the one toast
 * an action of several writes shows for all of them (`hooks/use-toasts`).
 */

import { toast, useToasts } from '../hooks/use-toasts'
import { inSpendScope } from './sdk/spend-scope'
import { measurementsSettled, type SpendEvent, type WriteAuth } from './sdk/write'

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
  'key:revoke': 'Key disabled on Platform',
  'key:encryption': 'Encryption key registered',
  'key:runner': 'Runner key registered',
  'identity:create': 'Identity created',
  'identity:name': 'Username registered',
}

/** A kind never named above still says what it did, by its verb. */
const VERB_TITLES: Readonly<Record<string, string>> = { create: 'Saved', replace: 'Updated', delete: 'Deleted' }

/** A write kind's toast title. */
export function spendTitle(kind: string): string {
  return SPEND_TITLES[kind] ?? VERB_TITLES[kind.split(':')[0] ?? ''] ?? 'Write confirmed'
}

/** What one action's toast says while its writes land, and once it ended. */
export interface SpendActionLabels {
  /** While its writes land ("Forking dips…"); absent, the latest write's own title. */
  readonly running?: string
  /** Once every write landed ("Forked dips"); an action of one write keeps that write's title. */
  readonly done: string
  /** When it failed after some of its writes landed; "Stopped part-way" when absent. */
  readonly failed?: string
  /**
   * What the action is, in place of `done` and of every write's own title, one write's
   * included: for a write whose document type alone does not say what it did (QW4-033: a
   * `writer` document granting the triage role is "Triage member added", not "Writer added").
   */
  readonly title?: string
}

interface ActionState {
  readonly labels: SpendActionLabels
  /** The writes reported so far, and their charges together (null once one was unreadable). */
  writes: number
  credits: number | null
  /** The latest write's own title. */
  last: string | null
  ended: 'ok' | 'failed' | null
}

const actions = new Map<string, ActionState>()
let actionSeq = 0
/** How long an ended action still takes a straggling report (a measurement past its wait). */
const STRAGGLER_MS = 60_000

/** Make a signer's writes belong to an action: `tag(signer)` is the signer to write with. */
export type TagSigner = <A extends WriteAuth>(auth: A) => A

/** The labels of an action that one `title` names throughout ({@link SpendActionLabels.title}). */
export function namedAction(title: string): SpendActionLabels {
  return { done: title, title }
}

/** An action's title for now. */
function actionTitle(s: ActionState): string {
  if (s.ended === null) return s.labels.running ?? s.labels.title ?? s.last ?? s.labels.done
  if (s.ended === 'failed') return s.labels.failed ?? 'Stopped part-way'
  if (s.labels.title !== undefined) return s.labels.title
  return s.writes === 1 ? (s.last ?? s.labels.done) : s.labels.done
}

/** The toast of an action, with every write's charge so far. */
function showAction(id: string, s: ActionState): void {
  useToasts.getState().show({
    group: id,
    title: actionTitle(s),
    credits: s.credits,
    writes: s.writes,
    pending: s.ended === null,
    ...(s.ended === 'failed' ? { tone: 'warn' as const, detail: 'Not every write landed; the ones that did are charged.' } : {}),
  })
}

/**
 * Run one user action that may sign several writes (a fork, a Settings save, a merge) so its
 * writes show one toast with their total (QW3-039: a 32-write fork toasted only its last write,
 * "Write confirmed · 0.000671 DASH"). The writes that belong to it are those signed with
 * `tag(signer)`, or, with `scope` (a modal dialog, where nothing else on the page writes
 * meanwhile), every write reported while it runs. The total is kept here, not in the toast, so a
 * toast dismissed or timed out mid-way still ends with the whole sum. Once the action returned
 * and its last charge was measured, the toast reads `labels.done` (or `labels.failed`).
 */
export async function spendAction<T>(labels: SpendActionLabels, run: (tag: TagSigner) => Promise<T>, opts: { scope?: boolean } = {}): Promise<T> {
  const id = `action:${++actionSeq}`
  const state: ActionState = { labels, writes: 0, credits: 0, last: null, ended: null }
  actions.set(id, state)
  const tag: TagSigner = (auth) => ({ ...auth, spendAction: id })
  let ok = false
  try {
    const result = opts.scope ? await inSpendScope(id, () => run(tag)) : await run(tag)
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
  if (state.writes > 0) showAction(id, state)
  setTimeout(() => actions.delete(id), STRAGGLER_MS)
}

/**
 * Toast a charged write (`ux-dx-spec.md` §4 rule 2): one of an action's writes joins its toast
 * and total; any other is its own toast. A refused write is always its own warning.
 */
export function toastSpend(event: Pick<SpendEvent, 'kind' | 'action'>, credits: number | null): void {
  if (event.kind.startsWith('refused:')) {
    toast({ title: 'Platform refused that write', credits, tone: 'warn', detail: 'A refused write still pays its processing fee.' })
    return
  }
  const id = event.action
  const state = id === undefined ? undefined : actions.get(id)
  if (id === undefined || state === undefined) {
    toast({ title: spendTitle(event.kind), credits })
    return
  }
  state.writes += 1
  state.credits = state.credits === null || credits === null ? null : state.credits + credits
  state.last = spendTitle(event.kind)
  showAction(id, state)
}
