/**
 * The asset lock's InstantSend proof, live on testnet: the deposit seen on DAPI feeds, the lock
 * broadcast, and its islock taken off the feeds opened before the broadcast (no block explorer,
 * no `getislocks` RPC). SKIPPED by default (real spend: the deposit is locked into credits no
 * identity claims):
 *
 *   FORGE_LIVE=1 FORGE_ISLOCK_WIF=<testnet WIF> FORGE_ISLOCK_FROM=<Core height before funding> \
 *     pnpm exec vitest run lib/auth/islock.live.test.ts
 *
 * Fund the WIF's P2PKH address first (the testnet faucet sends 1 DASH).
 */

import * as secp from '@noble/secp256k1'
import { bytesToHex } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'

import { NETWORKS } from '../constants'
import { buildAssetLock, hash160, islockTxid, sendAndProveLock, waitForDeposit, wifBytes } from './asset-lock'
import { base58CheckEncode } from './base58'

const WIF = process.env['FORGE_ISLOCK_WIF'] ?? ''
const FROM = Number(process.env['FORGE_ISLOCK_FROM'] ?? 0)

describe.skipIf(process.env['FORGE_LIVE'] !== '1' || WIF === '' || FROM <= 0)('InstantSend proof on testnet (live)', () => {
  it('proves the asset lock with the islock DAPI streams', async () => {
    const ep = { dapi: NETWORKS.testnet.dapiAddresses }
    const priv = wifBytes(WIF)
    const address = base58CheckEncode(new Uint8Array([140, ...hash160(secp.getPublicKey(priv, true))]))
    // eslint-disable-next-line no-console
    console.log('deposit address', address)
    const utxos = await waitForDeposit(ep, address, 100_000, { from: FROM, signal: AbortSignal.timeout(300_000) })
    // eslint-disable-next-line no-console
    console.log('deposit', utxos.map((u) => `${u.txid}:${u.vout} ${u.satoshis}`).join(', '))
    const lock = buildAssetLock(utxos, priv)
    // eslint-disable-next-line no-console
    console.log('asset lock', lock.txid)
    const started = Date.now()
    const status: string[] = []
    const proof = await sendAndProveLock(ep, lock, async () => null, { onStatus: (s) => status.push(s), timeoutMs: 120_000 })
    // eslint-disable-next-line no-console
    console.log('proof', proof.type, `after ${Date.now() - started} ms`, status)
    expect(proof.type).toBe('instant')
    if (proof.type === 'instant') {
      expect(islockTxid(proof.islock)).toBe(lock.txid)
      // eslint-disable-next-line no-console
      console.log('islock', bytesToHex(proof.islock))
    }
  }, 600_000)
})
