/// <reference lib="webworker" />

/**
 * The zip worker: compress `{ path: bytes }` with fflate off the main thread. Every file is
 * placed under one top-level directory by the caller's paths, as `git archive --prefix` would.
 * With `meta`, each entry is recorded as git archive records it ({@link zipEntries}).
 */

import { zipSync } from 'fflate'

import { withArchiveComment, zipEntries, type ZipMessage } from './zip-entries'

const scope = self as unknown as DedicatedWorkerGlobalScope

scope.onmessage = (ev: MessageEvent<ZipMessage>): void => {
  try {
    const { entries, meta } = ev.data
    const zip = withArchiveComment(zipSync(meta === null ? entries : zipEntries(entries, meta), { level: 6 }), meta?.comment ?? null)
    scope.postMessage({ ok: true, zip }, [zip.buffer])
  } catch (e) {
    scope.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}
