/**
 * TEST FIXTURES ONLY — hang and ReDoS fuzzing for the renderers (imported by `*.test.ts`;
 * never by app code, so never bundled).
 *
 * {@link runWithDeadline} calls an export of a TS module in a worker thread with a hard
 * deadline. A synchronous infinite loop blocks the test's own thread, so vitest's timeout can
 * never fire and CI just hangs; in a worker, a hang regression fails fast instead. Plain Node
 * loads the module (type stripping, Node >= 22.18), so it must not use `@/` path aliases.
 *
 * Timing tolerates a loaded runner: each call is measured in the worker thread's own CPU time,
 * which a runner busy with other test files does not inflate, and the deadline is on progress
 * (no call finishing for that long), so the delays of a loaded runner do not add up across a
 * batch. A whole batch still has a generous ceiling ({@link BATCH_CEILING_MS}).
 */

import { Worker } from 'node:worker_threads'

/**
 * Wall time for the worker to start and load the module (type stripping included) before the
 * first call. Not what is under test, and a loaded runner can take seconds over it.
 */
const LOAD_DEADLINE_MS = 60_000
/**
 * Wall time for a whole batch, whatever its progress: a regression that makes every call slow
 * (each under the stall deadline) still fails here, under vitest's 120 s test timeout, rather
 * than as a vitest timeout that leaves the worker running.
 */
const BATCH_CEILING_MS = 100_000

const WORKER = `
const { parentPort, workerData } = require('node:worker_threads')
// This thread's CPU time, in ms: a runner that is busy elsewhere (other test files, other jobs)
// deschedules the worker, which stretches wall time but not this. Wall time only on a Node
// without threadCpuUsage.
const cpuMs = typeof process.threadCpuUsage === 'function'
  ? () => { const u = process.threadCpuUsage(); return (u.user + u.system) / 1000 }
  : () => performance.now()
import(workerData.url).then(
  (m) => {
    const f = m[workerData.fn]
    const results = []
    let slowest = 0
    let slowestIndex = -1
    // Loaded: from here on the parent's deadline is per call.
    parentPort.postMessage({ progress: true })
    // One unmeasured warm-up call, so JIT tiering does not land on whichever case runs first.
    if (workerData.calls.length > 0) f(...workerData.calls[0])
    workerData.calls.forEach((args, i) => {
      const t = cpuMs()
      const value = f(...args)
      const ms = cpuMs() - t
      if (ms > slowest) { slowest = ms; slowestIndex = i }
      if (workerData.keep) results.push(value)
      // Progress, for the parent's stall deadline.
      parentPort.postMessage({ progress: true })
    })
    parentPort.postMessage({ ok: true, results, slowest, slowestIndex, cpu: typeof process.threadCpuUsage === 'function' })
  },
  (e) => parentPort.postMessage({ ok: false, error: String(e && e.stack || e) }),
)
`

export type DeadlineResult =
  | { readonly timedOut: true }
  | {
      readonly timedOut: false
      /** Each call's return value (structured-cloned), when `keep` was set. */
      readonly results: unknown[]
      /**
       * The slowest single call, in ms of the worker thread's CPU time (so a loaded runner does
       * not inflate it; see `WORKER`), and its index in `calls`.
       */
      readonly slowest: number
      readonly slowestIndex: number
      /** Whether `slowest` is CPU time; wall time on a Node without `process.threadCpuUsage`. */
      readonly cpu: boolean
    }

/**
 * Run `module[fn](...args)` for each entry of `calls` in one worker. `timedOut` if `ms` of wall
 * time pass with no call finishing (the worker is then terminated): a call that never returns
 * is caught within `ms`, and a batch that is only slow because the runner is loaded is not.
 * Starting the worker and loading the module have their own deadline ({@link LOAD_DEADLINE_MS}),
 * and the whole batch a ceiling ({@link BATCH_CEILING_MS}).
 * `heapMb` caps the worker's heap: a call that needs more crashes the worker, which rejects.
 */
export async function runWithDeadline(
  moduleUrl: URL,
  fn: string,
  calls: readonly (readonly unknown[])[],
  ms: number,
  keep = false,
  heapMb?: number,
): Promise<DeadlineResult> {
  const worker = new Worker(WORKER, {
    eval: true,
    workerData: { url: moduleUrl.href, fn, calls, keep },
    ...(heapMb !== undefined ? { resourceLimits: { maxOldGenerationSizeMb: heapMb } } : {}),
    // The .ts modules have no package "type"; silence Node's MODULE_TYPELESS_PACKAGE_JSON
    // and type-stripping warnings, which are noise here.
    execArgv: [...process.execArgv, '--no-warnings'],
  })
  try {
    return await new Promise<DeadlineResult>((resolve, reject) => {
      const ceiling = setTimeout(() => resolve({ timedOut: true }), Math.max(ms, BATCH_CEILING_MS))
      let timer = setTimeout(() => resolve({ timedOut: true }), Math.max(ms, LOAD_DEADLINE_MS))
      const stop = (): void => {
        clearTimeout(ceiling)
        clearTimeout(timer)
      }
      worker.once('error', (e) => {
        stop()
        reject(e)
      })
      // A worker that dies without answering (OOM, native crash) is a failure, not a hang.
      worker.once('exit', (code) => {
        stop()
        reject(new Error(`fuzz worker exited with code ${code} before answering`))
      })
      worker.on(
        'message',
        (msg: { progress?: true; ok: boolean; error?: string; results: unknown[]; slowest: number; slowestIndex: number; cpu: boolean }) => {
          clearTimeout(timer)
          if (msg.progress) {
            timer = setTimeout(() => resolve({ timedOut: true }), ms)
            return
          }
          stop()
          if (msg.ok) resolve({ timedOut: false, results: msg.results, slowest: msg.slowest, slowestIndex: msg.slowestIndex, cpu: msg.cpu })
          else reject(new Error(msg.error))
        },
      )
    })
  } finally {
    await worker.terminate()
  }
}

/** Deterministic PRNG (mulberry32) so a failing fuzz case reproduces from its seed. */
export function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Characters that have broken line/regex-driven renderers: every line terminator JS and
 * Markdown disagree about, NUL, markdown and table punctuation, a surrogate-pair emoji,
 * combining marks, and bidi controls.
 */
export const NASTY_ALPHABET: readonly string[] = [
  '\u2028', '\u2029', '\u0085', '\u000b', '\u000c', '\r', '\n', '\r\n', '\t', '\0', ' ',
  '#', '*', '_', '`', '~', '[', ']', '(', ')', '!', '>', '-', '+', '|', ':', '\\', '<', '@', '.', '1',
  'a', 'h', 'http://', 'https://x', '```', '---', '# ', '> ', '- ', '1. ', '](', '![',
  '\u{1F600}', '\u{1F468}\u200d\u{1F469}', '\u0301', '\u0336', '\u200f', '\u202e', '\u200b', '\ufeff',
]

/** A random string of about `maxLen` UTF-16 units or fewer, drawn from `alphabet`. */
export function nastyString(rand: () => number, maxLen: number, alphabet = NASTY_ALPHABET): string {
  // Bias towards short inputs but keep plenty near the cap.
  const target = rand() < 0.3 ? Math.floor(rand() * 200) : Math.floor(rand() * maxLen)
  let s = ''
  while (s.length < target) {
    // Runs of one token (e.g. 5000 `[`) are where backtracking and recursion blow up.
    const token = alphabet[Math.floor(rand() * alphabet.length)] as string
    const run = rand() < 0.1 ? 1 + Math.floor(rand() * 2000) : 1
    s += token.repeat(Math.min(run, Math.ceil((target - s.length) / token.length)))
  }
  return s.slice(0, maxLen)
}
