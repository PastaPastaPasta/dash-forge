/// <reference lib="webworker" />

/**
 * The code search worker (P1-3): keeps a repo's files and searches them off the main thread
 * ({@link CodeIndexHost}). Requests carry an `id`; each reply names it, with the result or the
 * error's message.
 */

import { CodeIndexHost, type CodeIndexRequest } from './code-index-host'

const scope = self as unknown as DedicatedWorkerGlobalScope
const host = new CodeIndexHost()

scope.onmessage = (ev: MessageEvent<{ readonly id: number; readonly req: CodeIndexRequest }>): void => {
  const { id, req } = ev.data
  host.handle(req).then(
    (result) => scope.postMessage({ id, ok: true, result }),
    (e: unknown) => scope.postMessage({ id, ok: false, error: e instanceof Error ? e.message : String(e) }),
  )
}
