/// <reference lib="webworker" />

/**
 * The zip worker: compress `{ path: bytes }` with fflate off the main thread. Every file is
 * placed under one top-level directory by the caller's paths, as `git archive` would.
 */

import { zipSync } from 'fflate'

const scope = self as unknown as DedicatedWorkerGlobalScope

scope.onmessage = (ev: MessageEvent<Record<string, Uint8Array>>): void => {
  try {
    const zip = zipSync(ev.data, { level: 6 })
    scope.postMessage({ ok: true, zip }, [zip.buffer])
  } catch (e) {
    scope.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}
