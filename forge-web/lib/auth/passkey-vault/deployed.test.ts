/**
 * The passkey vault is inert until forge-meta declares `vaultEntry`: the check reads the contract
 * Platform serves, tells "no vault yet" from "could not read", and never takes a stale snapshot's
 * word for it.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { describe, expect, it, vi } from 'vitest'

import { vaultEntryDeployed } from './deployed'
import { PASSKEYS_NOT_DEPLOYED } from './policy'

const sdkWith = (fetch: (id: string) => Promise<unknown>): EvoSDK => ({ contracts: { fetch } }) as unknown as EvoSDK

describe('whether forge-meta has the passkey vault', () => {
  it('is deployed when the contract declares vaultEntry (wasm contract or its JSON)', async () => {
    expect(await vaultEntryDeployed(sdkWith(async () => ({ schemas: { profile: {}, vaultEntry: {} } })), 'META')).toBe(true)
    expect(await vaultEntryDeployed(sdkWith(async () => ({ toJSON: () => ({ documentSchemas: { vaultEntry: {} } }) })), 'META')).toBe(true)
  })

  it('is not deployed when the contract lacks the type, is empty, or is not there', async () => {
    expect(await vaultEntryDeployed(sdkWith(async () => ({ schemas: { profile: {}, follow: {} } })), 'META')).toBe(false)
    expect(await vaultEntryDeployed(sdkWith(async () => ({ toJSON: () => ({}) })), 'META')).toBe(false)
    expect(await vaultEntryDeployed(sdkWith(async () => undefined), 'META')).toBe(false)
    expect(
      await vaultEntryDeployed(
        sdkWith(async () => {
          throw new Error('contract not found error: contract not found when querying from value with contract info')
        }),
        'META',
      ),
    ).toBe(false)
  })

  it('asks for forge-meta itself, and fails on a read it could not make', async () => {
    const fetch = vi.fn(async () => ({ schemas: {} }))
    await vaultEntryDeployed(sdkWith(fetch), 'META-ID')
    expect(fetch).toHaveBeenCalledWith('META-ID')
    await expect(
      vaultEntryDeployed(
        sdkWith(async () => {
          throw new Error('request timed out')
        }),
        'META',
      ),
    ).rejects.toThrow(/timed out/)
  })

  it('says why in a sentence', () => {
    expect(PASSKEYS_NOT_DEPLOYED).toMatch(/aren't available on this network yet/)
  })
})
