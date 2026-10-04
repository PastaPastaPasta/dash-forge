/**
 * Page side of the merge worker: start it, answer its object reads from a reader (the
 * base and head repos' browse readers), and resolve with its result. One worker per call,
 * terminated when the call settles.
 */

import { ObjectTooLargeError } from '../browse'
import type { ObjectReader } from '../view/tree-nav'
import type { MergeCheckResult, MergeInput } from './engine'
import type { FromWorker, MergeResult, ToWorker } from './protocol'

type Phase = Extract<FromWorker, { type: 'progress' }>

function withWorker<T>(
  reader: ObjectReader,
  message: ToWorker,
  settle: (m: FromWorker) => { value: T } | null,
  onProgress?: (p: Phase) => void,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('cancelled'))
      return
    }
    const worker = new Worker(new URL('./merge.worker.ts', import.meta.url))
    const send = (m: ToWorker): void => worker.postMessage(m)
    const onAbort = (): void => {
      stop()
      reject(new Error('cancelled'))
    }
    // Settling in any way ends the worker and drops the abort listener.
    const stop = (): void => {
      worker.terminate()
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort)
    worker.onerror = (e) => {
      stop()
      reject(new Error(e.message || 'the merge worker failed'))
    }
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data
      if (m.type === 'read') {
        if (signal?.aborted) return
        reader.readObject(m.oid, m.maxBytes !== undefined ? { maxBytes: m.maxBytes } : undefined).then(
          (object) => send({ type: 'object', req: m.req, object }),
          (err: unknown) =>
            send({
              type: 'object',
              req: m.req,
              error: err instanceof Error ? err.message : String(err),
              ...(err instanceof ObjectTooLargeError ? { tooLarge: { size: err.size, max: err.maxBytes } } : {}),
            }),
        )
        return
      }
      if (m.type === 'progress') {
        onProgress?.(m)
        return
      }
      if (m.type === 'error') {
        stop()
        reject(new Error(m.message))
        return
      }
      const done = settle(m)
      if (done !== null) {
        stop()
        resolve(done.value)
      }
    }
    send(message)
  })
}

/** How long the automatic merge check may run before it gives up. */
export const CHECK_TIMEOUT_MS = 60_000

/** Whether (and how) the PR merges, without building anything; gives up after {@link CHECK_TIMEOUT_MS}. */
export function checkMergeInWorker(reader: ObjectReader, input: MergeInput, signal?: AbortSignal): Promise<MergeCheckResult> {
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), CHECK_TIMEOUT_MS)
  signal?.addEventListener('abort', () => timeout.abort())
  return withWorker(reader, { type: 'check', input }, (m) => (m.type === 'checked' ? { value: m.check } : null), undefined, timeout.signal)
    .catch((e: unknown) => {
      if (timeout.signal.aborted && !signal?.aborted) throw new Error(`the merge check took longer than ${CHECK_TIMEOUT_MS / 1000} s; merge with \`dg pr merge\``)
      throw e
    })
    .finally(() => clearTimeout(timer))
}

/** Merge and build the pack. */
export function runMergeInWorker(reader: ObjectReader, input: MergeInput, onProgress?: (p: Phase) => void): Promise<MergeResult> {
  return withWorker(reader, { type: 'run', input }, (m) => (m.type === 'done' ? { value: m.result } : null), onProgress)
}
