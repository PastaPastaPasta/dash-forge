/**
 * One typed view of the evo-sdk facades the auth layer uses. The wasm-bindgen `.d.ts` types
 * resolve loosely across builds; narrowing through these shapes in one place keeps every call
 * site free of `as unknown as` casts.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

/** An identity public key, as the auth layer reads it. */
export interface WasmKey {
  readonly keyId: number
  readonly purposeNumber: number
  readonly securityLevelNumber: number
  readonly disabledAt?: bigint
  readonly totalBudget?: bigint
  readonly expiresAt?: bigint
  readonly contractBounds?: { toJSON(): { $type: string; id: string } }
  validatePrivateKey(bytes: Uint8Array, network: string): boolean
}

export interface WasmIdentity {
  readonly publicKeys: WasmKey[]
  readonly balance: bigint
  getPublicKeyById(keyId: number): unknown
}

export interface AuthSdk {
  identities: {
    fetch(id: string): Promise<WasmIdentity | undefined>
    balance(id: string): Promise<bigint | undefined>
    update(options: unknown): Promise<void>
    create(options: unknown): Promise<void>
    keysRemainingBudgets(id: string, keyIds: number[]): Promise<Map<number, bigint | null>>
  }
  documents: { query(q: unknown): Promise<Map<string, unknown>> }
  contracts: { fetch(id: string): Promise<unknown> }
  system: { status(): Promise<{ toJSON(): { chain?: { coreChainLockedHeight?: number } } }> }
}

/** The typed facades of a connected SDK. */
export function authSdk(sdk: EvoSDK): AuthSdk {
  return sdk as unknown as AuthSdk
}

/** A sleep that ends early (rejecting with AbortError) when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('cancelled', 'AbortError'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(t)
      reject(new DOMException('cancelled', 'AbortError'))
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Whether `e` is the rejection of an aborted operation. */
export function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError'
}
