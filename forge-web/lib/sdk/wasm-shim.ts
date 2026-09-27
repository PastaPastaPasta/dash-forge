/**
 * Browser stand-in for `@dashevo/evo-sdk/dist/wasm.js` (wired in `next.config.js`).
 *
 * The original imports `@dashevo/wasm-sdk/compressed`, which inlines the wasm in the JS, and
 * caches its init promise even when it rejects, so one failed download broke the SDK until a
 * reload. This one re-exports the unbundled wasm-bindgen glue and initializes it from the
 * separately fetched module (`wasm-fetch.ts`), keeping only a successful init.
 */

import initRaw from '@dashevo/wasm-sdk/raw'
import * as wasm from '@dashevo/wasm-sdk/raw'

import { compileWasm } from './wasm-fetch'

export * from '@dashevo/wasm-sdk/raw'

let ready: Promise<typeof wasm> | null = null

/** Download, compile and instantiate the SDK wasm once; a failure is retried on the next call. */
export function ensureInitialized(): Promise<typeof wasm> {
  if (ready === null) {
    const run = compileWasm()
      .then((module) => initRaw({ module_or_path: module }))
      .then(() => wasm)
    ready = run
    run.catch(() => {
      if (ready === run) ready = null
    })
  }
  return ready
}

export default ensureInitialized
