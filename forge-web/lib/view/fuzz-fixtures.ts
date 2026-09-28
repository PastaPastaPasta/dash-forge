/**
 * TEST FIXTURES ONLY — hang and ReDoS fuzzing for the renderers (imported by `*.test.ts`;
 * never by app code, so never bundled).
 *
 * {@link runWithDeadline} calls an export of a TS module in a worker thread with a hard
 * deadline. A synchronous infinite loop blocks the test's own thread, so vitest's timeout can
 * never fire and CI just hangs; in a worker, a hang regression fails fast instead. Plain Node
 * loads the module (type stripping, Node >= 22.18), so it must not use `@/` path aliases.
 */

import { Worker } from 'node:worker_threads'

const WORKER = `
const { parentPort, workerData } = require('node:worker_threads')
import(workerData.url).then(
  (m) => {
    const f = m[workerData.fn]
    const results = []
    let slowest = 0
    let slowestIndex = -1
    // One unmeasured warm-up call, so JIT tiering does not land on whichever case runs first.
    if (workerData.calls.length > 0) f(...workerData.calls[0])
    workerData.calls.forEach((args, i) => {
      const t = performance.now()
      const value = f(...args)
      const ms = performance.now() - t
      if (ms > slowest) { slowest = ms; slowestIndex = i }
      if (workerData.keep) results.push(value)
    })
    parentPort.postMessage({ ok: true, results, slowest, slowestIndex })
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
      /** The slowest single call, in ms, and its index in `calls`. */
      readonly slowest: number
      readonly slowestIndex: number
    }

/**
 * Run `module[fn](...args)` for each entry of `calls` in one worker. `timedOut` if the whole
 * batch has not finished within `ms` (the worker is then terminated). `heapMb` caps the
 * worker's heap: a call that needs more crashes the worker, which rejects.
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
      const timer = setTimeout(() => resolve({ timedOut: true }), ms)
      worker.once('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      // A worker that dies without answering (OOM, native crash) is a failure, not a hang.
      worker.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`fuzz worker exited with code ${code} before answering`))
      })
      worker.once(
        'message',
        (msg: { ok: boolean; error?: string; results: unknown[]; slowest: number; slowestIndex: number }) => {
          clearTimeout(timer)
          if (msg.ok) resolve({ timedOut: false, results: msg.results, slowest: msg.slowest, slowestIndex: msg.slowestIndex })
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
