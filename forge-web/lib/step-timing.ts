/**
 * How long each step of a sign-in or identity creation took (L-20: one "Enabling private
 * repos…" wait took ~30 s and never reproduced, so the next one should say where the time went).
 *
 * Each finished step becomes a User Timing measure named `forge:<flow>:<step>`: DevTools →
 * Performance shows them, and `performance.getEntriesByType('measure')` lists them. With
 * `localStorage['forge.debug'] = 'timing'` each one is also logged to the console.
 * Timing only: nothing here changes what a step does, and a failure to record is ignored.
 */

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

function logging(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('forge.debug') === 'timing'
  } catch {
    return false
  }
}

function record(flow: string, step: string, start: number, end: number): void {
  try {
    performance.measure(`forge:${flow}:${step}`, { start, end })
  } catch {
    // No User Timing (an old engine): the console line below still works.
  }
  if (logging()) {
    // eslint-disable-next-line no-console
    console.debug(`[forge timing] ${flow}: ${step} took ${Math.round(end - start)} ms`)
  }
}

/**
 * A clock for one flow's steps: each call ends the step that is running (recording it) and
 * starts `step`; `null` ends the running step without starting another.
 */
export function stepClock(flow: string): (step: string | null) => void {
  let running: { step: string; start: number } | null = null
  return (step) => {
    const t = now()
    if (running !== null) record(flow, running.step, running.start, t)
    running = step === null ? null : { step, start: t }
  }
}

/** Time one piece of work as step `step` of `flow` (recorded whether it succeeds or fails). */
export async function timed<T>(flow: string, step: string, work: () => Promise<T>): Promise<T> {
  const start = now()
  try {
    return await work()
  } finally {
    record(flow, step, start, now())
  }
}
