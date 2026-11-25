/**
 * The vault's forge-user key slot (docs/design/identity-synced-state.md §5): sealed beside the
 * record under the unlock, never plaintext, never in `vault-enc` (an older build reads every key
 * there as a private-repo key), gone with the lock, carried across a renewal, held in tab memory
 * when the session has no blob keys.
 */

import { bytesToHex } from '@noble/hashes/utils.js'
import { beforeEach, describe, expect, it } from 'vitest'

import { idbEntries, idbGet, resetMemoryStores } from '../idb'
import {
  forgetVault,
  heldSyncKeyId,
  holdForSession,
  lockVault,
  storeInVault,
  storeSyncKey,
  storedEncryptionKeyIds,
  unlockWithPassphrase,
  withSyncKey,
} from './vault'
import { encodeWif } from './wif'

const ID = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const SECRET = { identityId: ID, keyId: 5, wif: encodeWif(new Uint8Array(32).fill(7), 'devnet') }
const E = new Uint8Array(32).fill(0x51)
const PASS = 'correct horse battery'

describe('the vault forge-user key slot', () => {
  beforeEach(() => {
    resetMemoryStores()
    lockVault()
  })

  it('seals it in its own entry, never plaintext and never as a private-repo key', async () => {
    await storeInVault('devnet', SECRET, { passphrase: PASS })
    await storeSyncKey('devnet', ID, 9, new Uint8Array(E))
    const dump = JSON.stringify(await idbEntries('vault'), (_k, v: unknown) => (v instanceof Uint8Array ? bytesToHex(v) : v))
    expect(dump).not.toContain(bytesToHex(E))
    expect(await idbGet('vault', `vault-sync:devnet:${ID}`)).toBeDefined()
    expect(await idbGet('vault', `vault-enc:devnet:${ID}`)).toBeUndefined()
    expect(await storedEncryptionKeyIds('devnet', ID)).toEqual([])
    expect(await withSyncKey('devnet', ID, async (keyId, s) => [keyId, bytesToHex(s)])).toEqual([9, bytesToHex(E)])
  }, 30_000)

  it('is unusable once locked, and opens again with the unlock', async () => {
    await storeInVault('devnet', SECRET, { passphrase: PASS })
    await storeSyncKey('devnet', ID, 9, new Uint8Array(E))
    lockVault()
    expect(await heldSyncKeyId('devnet', ID)).toBeNull()
    await unlockWithPassphrase('devnet', ID, PASS)
    expect(await heldSyncKeyId('devnet', ID)).toBe(9)
  }, 60_000)

  it('is carried across a renewal and deleted with the vault', async () => {
    await storeInVault('devnet', SECRET, { passphrase: PASS })
    await storeSyncKey('devnet', ID, 9, new Uint8Array(E))
    await storeInVault('devnet', { ...SECRET, keyId: 6 }, { passphrase: 'another passphrase!' })
    expect(await withSyncKey('devnet', ID, async (_k, s) => bytesToHex(s))).toBe(bytesToHex(E))
    await forgetVault('devnet', ID)
    expect(await idbGet('vault', `vault-sync:devnet:${ID}`)).toBeUndefined()
  }, 60_000)

  it('stays in this tab only for a session without a vault record', async () => {
    holdForSession('devnet', SECRET)
    await storeSyncKey('devnet', ID, 9, new Uint8Array(E))
    expect(await heldSyncKeyId('devnet', ID)).toBe(9)
    expect(await idbGet('vault', `vault-sync:devnet:${ID}`)).toBeUndefined()
    lockVault()
    expect(await heldSyncKeyId('devnet', ID)).toBeNull()
  })

  it('hands the callback a copy that is wiped afterwards', async () => {
    await storeInVault('devnet', SECRET, { passphrase: PASS })
    await storeSyncKey('devnet', ID, 9, new Uint8Array(E))
    let held: Uint8Array | null = null
    await withSyncKey('devnet', ID, async (_k, s) => {
      held = s
    })
    expect((held as Uint8Array | null)?.every((b) => b === 0)).toBe(true)
  }, 30_000)
})
