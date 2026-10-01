/**
 * The user action a write belongs to (QW3-039). One action (a fork, a Settings save, a merge) may
 * sign many writes; each write's charge is reported later, once it is measured. A write reported
 * while an action is open carries the action's id, so its toast folds into that action's one
 * toast however late the measurement lands.
 *
 * The UI opens one action at a time (a dialog's confirm), and an identity's writes are
 * serialized, so "the action open when the write was reported" is the action that made it.
 */

let open: string | null = null

/** The id of the action open now, if any. */
export function currentSpendAction(): string | null {
  return open
}

/**
 * Run `run` as action `id`: writes reported while it runs carry `id`. An action started inside
 * another keeps the outer one (a fork that also writes a config is one action).
 */
export async function inSpendScope<T>(id: string, run: () => Promise<T>): Promise<T> {
  if (open !== null) return run()
  open = id
  try {
    return await run()
  } finally {
    open = null
  }
}
