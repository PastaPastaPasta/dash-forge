/**
 * Page side of the merge worker: start it, answer its object reads from a reader (the
 * base and head repos' browse readers), and resolve with its result. One worker per call,
 * terminated when the call settles.
 */

import type { ObjectReader } from '../view/tree-nav'
import type { MergeCheck, MergeInput } from './engine'
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
    const worker = new Worker(new URL('./merge.worker.ts', import.meta.url))
    const send = (m: ToWorker): void => worker.postMessage(m)
    const stop = (): void => worker.terminate()
    signal?.addEventListener('abort', () => {
      stop()
      reject(new Error('cancelled'))
    })
    worker.onerror = (e) => {
      stop()
      reject(new Error(e.message || 'the merge worker failed'))
    }
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data
      if (m.type === 'read') {
        reader.readObject(m.oid).then(
          (object) => send({ type: 'object', req: m.req, object }),
          (err: unknown) => send({ type: 'object', req: m.req, error: err instanceof Error ? err.message : String(err) }),
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

/** Whether (and how) the PR merges, without building anything. */
export function checkMergeInWorker(reader: ObjectReader, input: MergeInput, signal?: AbortSignal): Promise<MergeCheck> {
  return withWorker(reader, { type: 'check', input }, (m) => (m.type === 'checked' ? { value: m.check } : null), undefined, signal)
}

/** Merge and build the pack. */
export function runMergeInWorker(reader: ObjectReader, input: MergeInput, onProgress?: (p: Phase) => void): Promise<MergeResult> {
  return withWorker(reader, { type: 'run', input }, (m) => (m.type === 'done' ? { value: m.result } : null), onProgress)
}
