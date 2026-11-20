/**
 * Which step of a repo home read is under way, keyed by the home cache key: the loading view
 * names the step ("Finding the repo on Dash Platform…") instead of one opaque spinner.
 *
 * `owner`: the owner's DPNS name or identity is looked up. `repo`: the repo document is read.
 * `refs`: the repo is found; its branches and settings are read.
 */

export type HomeStage = 'owner' | 'repo' | 'refs'

export const HOME_STAGES: readonly HomeStage[] = ['owner', 'repo', 'refs']

const stages = new Map<string, HomeStage>()
/** The latest read started under each key: only it reports (a superseded read is still awaited). */
const latest = new Map<string, object>()
const listeners = new Set<() => void>()

function note(key: string, stage: HomeStage): void {
  if (stages.get(key) === stage) return
  stages.set(key, stage)
  for (const l of listeners) l()
}

/**
 * A home read starts under `key`: it is on its first step, and the returned function reports the
 * next ones while no later read under the key has started. The last step stays after the read
 * settles, so the loading view never steps back while the page swaps in the content.
 */
export function startHomeStages(key: string): (stage: HomeStage) => void {
  const token = {}
  latest.set(key, token)
  note(key, HOME_STAGES[0]!)
  // Forward only: a read retried (to show a ref this tab just moved) does not start over.
  let at = 0
  return (stage) => {
    const i = HOME_STAGES.indexOf(stage)
    if (latest.get(key) !== token || i < at) return
    at = i
    note(key, stage)
  }
}

/** The step the latest home read under `key` reached; undefined before any started. */
export function homeStage(key: string): HomeStage | undefined {
  return stages.get(key)
}

export function subscribeHomeStage(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
