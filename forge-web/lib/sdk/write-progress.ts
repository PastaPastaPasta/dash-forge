/**
 * What the write in flight is doing, for the UI to say while the user waits: sending it,
 * waiting for Platform's verdict, or (that wait ran out) checking whether it landed. Document
 * writes are serialized per identity, so one write at a time is reported; a write that starts
 * while another is reported takes over (the older one is done by then or still settling).
 */

export type WritePhase = 'sending' | 'confirming' | 'rechecking'

export interface WriteProgress {
  readonly phase: WritePhase
  /** When the write began (ms since the epoch). */
  readonly startedAt: number
}

type Listener = () => void

let current: WriteProgress | null = null
let token = 0
const listeners = new Set<Listener>()

function emit(next: WriteProgress | null): void {
  current = next
  for (const l of listeners) l()
}

/** Subscribe to changes ({@link writeProgress} reads the latest). */
export function subscribeWriteProgress(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The write in flight, or null. */
export function writeProgress(): WriteProgress | null {
  return current
}

/** Move the write in flight to `phase` (nothing when no write is reported). */
export function setWritePhase(phase: WritePhase): void {
  if (current !== null && current.phase !== phase) emit({ phase, startedAt: current.startedAt })
}

/** Report one write while `run` runs, starting at `sending`; the report ends when it settles. */
export async function trackWrite<T>(run: () => Promise<T>): Promise<T> {
  const mine = ++token
  emit({ phase: 'sending', startedAt: Date.now() })
  try {
    return await run()
  } finally {
    if (token === mine) emit(null)
  }
}
