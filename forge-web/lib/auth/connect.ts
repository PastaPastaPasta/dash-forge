/**
 * Bounded Platform access for the sign-in flows: each wait ends in content or in an error that
 * names the step, so the sheet can offer "Try again" instead of spinning forever.
 *
 * Two phases, each with its own deadline:
 *   - downloading: the evo-sdk chunk (~8 MB gzipped, WASM inside) and its one-time init. Slow 3G
 *     needs minutes for it, so the cap is generous (webpack itself gives up on a chunk that has
 *     not arrived after 120 s);
 *   - connecting: the trusted quorum keys, a DAPI node and the contract preload.
 *
 * A timeout does not cancel the work: "Try again" joins the connect still in flight (the SDK
 * service shares one), so a connect that was only slow (a DAPI rate limit can hold one for up
 * to ~70 s) still completes and is reused.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import type { Network } from '../constants'
import { ensureSdk } from '../sdk/service'
import { StepTimeoutError, withTimeout } from '../timeout'
import { errorMessage } from '../utils'

/** The evo-sdk download plus WASM init. */
export const LIBRARY_LOAD_MS = 300_000
/** The connect after the library is loaded (quorum keys, DAPI, contracts). */
export const CONNECT_MS = 20_000
/** A local step: this browser's storage, a key derivation. */
export const STEP_MS = 20_000
/** A few Platform reads after the connect (a node may fail over once). */
export const PLATFORM_READ_MS = 30_000

export type ConnectPhase = 'downloading' | 'connecting'

/** What each phase is called in the sheet (and in its errors). */
export const PHASE_TEXT: Readonly<Record<ConnectPhase, string>> = {
  downloading: 'Downloading the Dash Platform library',
  connecting: 'Connecting to Dash Platform',
}

let loaded = false

/** Load the evo-sdk chunk and init its WASM, within {@link LIBRARY_LOAD_MS}. */
export async function loadSdkLibrary(onPhase?: (p: ConnectPhase) => void): Promise<void> {
  if (loaded) return
  onPhase?.('downloading')
  try {
    await withTimeout(
      import('@dashevo/evo-sdk').then((evo) => evo.EvoSDK.getLatestVersionNumber()),
      LIBRARY_LOAD_MS,
      PHASE_TEXT.downloading,
    )
    loaded = true
  } catch (e) {
    // A chunk-load error reads "Loading chunk 7138 failed. (error: …/evo-sdk.….js)".
    const why = e instanceof StepTimeoutError ? `not finished after ${LIBRARY_LOAD_MS / 60_000} minutes` : errorMessage(e)
    throw new Error(`Could not download the Dash Platform library (${why}). Check your connection and try again.`)
  }
}

/** The connected SDK: the library first, then the connect, each within its deadline. */
export async function connectPlatform(network: Network, onPhase?: (p: ConnectPhase) => void): Promise<EvoSDK> {
  await loadSdkLibrary(onPhase)
  onPhase?.('connecting')
  try {
    return await withTimeout(ensureSdk(network), CONNECT_MS, PHASE_TEXT.connecting)
  } catch (e) {
    const why = e instanceof StepTimeoutError ? `no answer within ${CONNECT_MS / 1000} s` : errorMessage(e)
    throw new Error(`Could not connect to Dash Platform (${why}). Its nodes may be busy or unreachable; try again in a moment.`)
  }
}
