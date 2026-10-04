/// <reference lib="webworker" />
/**
 * The merge worker: runs `lib/merge/engine` off the main thread. Object reads are requested
 * from the page (see `protocol.ts`), so the worker needs no SDK and no network access.
 */

import { ObjectTooLargeError, type GitObject } from '../browse'
import type { ObjectReader } from '../view/tree-nav'
import { checkMergeDetailed, runMerge } from './engine'
import type { FromWorker, ToWorker } from './protocol'

const scope = self as unknown as DedicatedWorkerGlobalScope
const pending = new Map<number, { resolve: (o: GitObject) => void; reject: (e: Error) => void }>()
let nextReq = 0

const post = (m: FromWorker, transfer: Transferable[] = []): void => scope.postMessage(m, transfer)

const reader: ObjectReader = {
  readObject: (oid, options) =>
    new Promise<GitObject>((resolve, reject) => {
      const req = nextReq++
      pending.set(req, { resolve, reject })
      post({ type: 'read', req, oid, ...(options?.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}) })
    }),
}

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data
  if (m.type === 'object') {
    const p = pending.get(m.req)
    pending.delete(m.req)
    if (p === undefined) return
    if (m.object) p.resolve(m.object)
    // A read the page refused as over its size bound comes back as that refusal.
    else if (m.tooLarge !== undefined) p.reject(new ObjectTooLargeError(m.tooLarge.size, m.tooLarge.max))
    else p.reject(new Error(m.error ?? 'object read failed'))
    return
  }
  const run = async (): Promise<void> => {
    try {
      if (m.type === 'check') {
        post({ type: 'checked', check: await checkMergeDetailed(reader, m.input) })
      } else {
        const result = await runMerge(reader, m.input, (phase, detail) => post({ type: 'progress', phase, ...(detail ? { detail } : {}) }))
        post({ type: 'done', result }, 'pack' in result ? [result.pack.buffer] : [])
      }
    } catch (err) {
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }
  void run()
}
