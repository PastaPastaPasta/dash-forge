/**
 * "Commits on Sep 30, 2026" (QW-061c; GitHub's commits list): a log's rows cut into runs of the
 * same local calendar day of their author time, in the log's own order. A day that comes back
 * later in the log (a merge brings in older work) starts a new run, as GitHub shows it.
 */

/** The local calendar day of `ms` (a stable key); `''` for an unknown time. */
export function dayKey(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

export interface DayRun<T> {
  /** The run's day key ({@link dayKey}); `''` for rows of unknown time. */
  readonly day: string
  /** The first row's time: what the run's header shows. */
  readonly at: number
  readonly rows: readonly T[]
}

/** `rows` cut into runs of consecutive rows on the same day of `when(row)`. */
export function dayRuns<T>(rows: readonly T[], when: (row: T) => number): DayRun<T>[] {
  const out: { day: string; at: number; rows: T[] }[] = []
  for (const row of rows) {
    const at = when(row)
    const day = dayKey(at)
    const last = out[out.length - 1]
    if (last !== undefined && last.day === day) last.rows.push(row)
    else out.push({ day, at, rows: [row] })
  }
  return out
}
