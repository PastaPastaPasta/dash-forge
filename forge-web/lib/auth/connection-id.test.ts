// @vitest-environment jsdom
/**
 * The App Connect state kept in localStorage: one connection id per network that outlives a
 * sign-out, and a renewal marker that names one key and lapses.
 */

import { bytesToHex } from '@noble/hashes/utils.js'
import { beforeEach, describe, expect, it } from 'vitest'

import { clearWalletRenewal, connectionId, markWalletRenewal, walletRenewalInFlight } from './connection-id'

const ID = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'

beforeEach(() => localStorage.clear())

describe('connection id', () => {
  it('is 16 random bytes per network, made once and kept', () => {
    const a = connectionId('devnet-sakura')
    expect(a.length).toBe(16)
    expect(bytesToHex(connectionId('devnet-sakura'))).toBe(bytesToHex(a))
    expect(bytesToHex(connectionId('testnet'))).not.toBe(bytesToHex(a))
    expect(localStorage.getItem('forge:app-connect:connection-id:devnet-sakura')).toBe(bytesToHex(a))
  })

  it('replaces a malformed stored value', () => {
    localStorage.setItem('forge:app-connect:connection-id:testnet', 'nope')
    const id = connectionId('testnet')
    expect(localStorage.getItem('forge:app-connect:connection-id:testnet')).toBe(bytesToHex(id))
  })
})

describe('renewal marker', () => {
  it('names one key of one identity and lapses', () => {
    markWalletRenewal('testnet', ID, 7, 2_000)
    expect(walletRenewalInFlight('testnet', ID, 7, 1_000)).toBe(true)
    expect(walletRenewalInFlight('testnet', ID, 8, 1_000)).toBe(false)
    expect(walletRenewalInFlight('devnet-sakura', ID, 7, 1_000)).toBe(false)
    expect(walletRenewalInFlight('testnet', ID, 7, 2_000)).toBe(false)
    clearWalletRenewal('testnet', ID)
    expect(walletRenewalInFlight('testnet', ID, 7, 1_000)).toBe(false)
  })

  it('does not honour a mark that ends further out than a renewal can take (a clock set back)', () => {
    markWalletRenewal('testnet', ID, 7, 1_000 + 21 * 60 * 1000)
    expect(walletRenewalInFlight('testnet', ID, 7, 1_000)).toBe(false)
    expect(walletRenewalInFlight('testnet', ID, 7, 1_000 + 2 * 60 * 1000)).toBe(true)
  })

  it('clears only the mark of the key named', () => {
    markWalletRenewal('testnet', ID, 7, 2_000)
    clearWalletRenewal('testnet', ID, 8)
    expect(walletRenewalInFlight('testnet', ID, 7, 1_000)).toBe(true)
    clearWalletRenewal('testnet', ID, 7)
    expect(walletRenewalInFlight('testnet', ID, 7, 1_000)).toBe(false)
  })

  it('reads a garbled marker as none', () => {
    localStorage.setItem(`forge:app-connect:renewing:testnet:${ID}`, '{')
    expect(walletRenewalInFlight('testnet', ID, 7, 0)).toBe(false)
  })
})
