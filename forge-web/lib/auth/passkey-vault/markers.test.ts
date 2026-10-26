/** This device's passkey records: one marker per credential, a pending enrolment, both forgotten together. */

import { afterEach, describe, expect, it } from 'vitest'

import { idbPut, resetMemoryStores } from '../../idb'
import { clearPending, dropMarker, forgetPasskeyRecords, markerFor, putMarker, readMarkers, readPending, writePending, type PasskeyMarker } from './markers'

const ID = 'JCuebezAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const marker = (n: number, keyIds = [5]): PasskeyMarker => ({ credentialId: new Uint8Array(16).fill(n), recipientKey: new Uint8Array(32).fill(n), keyIds, addedAt: n })

afterEach(() => resetMemoryStores())

describe("this device's passkey markers", () => {
  it('keep one marker per credential, per network and identity', async () => {
    await putMarker('devnet', ID, marker(1))
    await putMarker('devnet', ID, marker(2))
    await putMarker('devnet', ID, marker(1, [6, 7]))
    const got = await readMarkers('devnet', ID)
    expect(got.map((m) => [m.addedAt, m.keyIds])).toEqual([
      [2, [5]],
      [1, [6, 7]],
    ])
    expect(markerFor(got, new Uint8Array(16).fill(2))?.addedAt).toBe(2)
    expect(await readMarkers('testnet', ID)).toEqual([])
    await dropMarker('devnet', ID, new Uint8Array(16).fill(2))
    expect((await readMarkers('devnet', ID)).map((m) => m.addedAt)).toEqual([1])
  })

  it('ignore a malformed record: it trusts nothing', async () => {
    await idbPut('vault', `pv-own:devnet:${ID}`, [{ credentialId: 'x', recipientKey: new Uint8Array(31), keyIds: [], addedAt: 1 }, marker(3)])
    expect((await readMarkers('devnet', ID)).map((m) => m.addedAt)).toEqual([3])
  })

  it('keep a pending enrolment as public ids only, cleared by its own credential', async () => {
    const pending = { ownerId: new Uint8Array(32).fill(7), credentialId: new Uint8Array(20).fill(8), createPrf: new Uint8Array(32).fill(9) }
    await writePending('devnet', ID, pending)
    expect(await readPending('devnet', ID)).toEqual({ ownerId: pending.ownerId, credentialId: pending.credentialId })
    await clearPending('devnet', ID, new Uint8Array(20).fill(1))
    expect(await readPending('devnet', ID)).not.toBeNull()
    await clearPending('devnet', ID, pending.credentialId)
    expect(await readPending('devnet', ID)).toBeNull()
  })

  it('are all forgotten with the identity', async () => {
    await putMarker('devnet', ID, marker(1))
    await writePending('devnet', ID, { ownerId: new Uint8Array(32), credentialId: new Uint8Array(16) })
    await forgetPasskeyRecords('devnet', ID)
    expect(await readMarkers('devnet', ID)).toEqual([])
    expect(await readPending('devnet', ID)).toBeNull()
  })
})
