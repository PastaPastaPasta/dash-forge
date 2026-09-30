/**
 * The toast each charged write shows (`ux-dx-spec.md` §4 rule 2): its title, and the group that
 * folds one action's several writes into one toast (`hooks/use-toasts`).
 */

import { liveToast } from '../hooks/use-toasts'
import type { SpendEvent } from './sdk/write'

/** A write kind (`create:issue`) → the toast title. */
const SPEND_TITLES: Readonly<Record<string, string>> = {
  'create:repo': 'Repository created',
  'create:maintainer': 'Maintainer added',
  'create:writer': 'Writer added',
  'create:config': 'Repository config written',
  'create:repoKey': 'Repo key handed out',
  'create:issue': 'Issue created',
  'create:comment': 'Comment posted',
  'create:event': 'State event recorded',
  'create:authorEvent': 'State event recorded',
  'create:review': 'Review submitted',
  // Every release revision (publish, edit, yank, unpublish) is this kind: the dialog says which (QW-077).
  'create:release': 'Release saved',
  'create:webhook': 'Webhook saved',
  'delete:webhook': 'Webhook revision deleted',
  'create:star': 'Starred',
  'create:follow': 'Following',
  'delete:star': 'Unstarred',
  'delete:follow': 'Unfollowed',
  'delete:maintainer': 'Maintainer removed',
  'delete:writer': 'Writer removed',
  'key:register': "This browser's key registered",
  'key:renew': "This browser's key renewed",
  'key:topup': 'Key budget topped up',
  'key:revoke': 'Key disabled on chain',
  'key:encryption': 'Encryption key registered',
  'key:runner': 'Runner key registered',
  'identity:create': 'Identity created',
}

/** The writes a repo's creation signs after its `repo` document, the last one ending it. */
const REPO_CREATE_STEPS = new Set(['create:maintainer', 'create:repoKey', 'create:config'])

/**
 * A write's toast title, and the group that folds a repo creation's writes into one toast
 * (QW2-034): its `repo` write opens "Creating the repository", its maintainer, key and config
 * writes add to it while it shows, and the config write, the last, closes it as created.
 */
export function spendToast(event: Pick<SpendEvent, 'kind' | 'repo'>): { title: string; group?: string; pending?: boolean } {
  const group = event.repo === null ? undefined : `create-repo:${event.repo}`
  if (event.kind === 'create:repo' && group) return { title: 'Creating the repository', group, pending: true }
  const live = group === undefined ? undefined : liveToast(group)
  if (live && REPO_CREATE_STEPS.has(event.kind)) {
    const done = event.kind === 'create:config'
    return { title: done ? 'Repository created' : live.title, group, pending: !done }
  }
  return { title: SPEND_TITLES[event.kind] ?? 'Write confirmed' }
}
