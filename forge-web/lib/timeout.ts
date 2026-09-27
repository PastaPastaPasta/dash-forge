/**
 * Bounded waits for the UI: a step that never settles must end in an error the user can act on,
 * never in a spinner that turns forever.
 *
 * `withTimeout` does not cancel the underlying work: a retry after a timeout awaits the same
 * in-flight connect or download, so work that was only slow still completes and is reused.
 */

/** A step that did not settle in time. `what` names the step ("connecting to Dash Platform"). */
export class StepTimeoutError extends Error {
  constructor(
    readonly what: string,
    readonly ms: number,
  ) {
    super(`${what} did not finish within ${Math.round(ms / 1000)} s`)
    this.name = 'StepTimeoutError'
  }
}

/** `promise`, or a {@link StepTimeoutError} naming `what` once `ms` pass. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepTimeoutError(what, ms)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}
