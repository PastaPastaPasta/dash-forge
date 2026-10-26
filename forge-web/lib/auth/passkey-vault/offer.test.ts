// @vitest-environment jsdom
/** The one-time passkey offer never nags: twice at most, never after "Not now", and never without a record. */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { dismissOffer, MAX_OFFERS, noteOffered, shouldOffer } from './offer'

const ID = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
const OTHER = 'BTJPjCLCnRaJQkqakpcdLYFsaHgFf5XSEBNxFCyYBteH'

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('the passkey offer', () => {
  it('is made to a new identity, at most twice, and then never again', () => {
    expect(shouldOffer('devnet', ID)).toBe(true)
    for (let i = 0; i < MAX_OFFERS; i++) {
      expect(shouldOffer('devnet', ID)).toBe(true)
      expect(noteOffered('devnet', ID)).toBe(true)
    }
    expect(shouldOffer('devnet', ID)).toBe(false)
  })

  it('stops for good after "Not now", for that identity and network only', () => {
    noteOffered('devnet', ID)
    dismissOffer('devnet', ID)
    expect(shouldOffer('devnet', ID)).toBe(false)
    expect(shouldOffer('devnet', OTHER)).toBe(true)
    expect(shouldOffer('testnet', ID)).toBe(true)
    // Dismissing before it was ever shown also sticks (a passkey already exists here).
    dismissOffer('devnet', OTHER)
    expect(shouldOffer('devnet', OTHER)).toBe(false)
  })

  it('is never made when the browser will not keep the record (it could repeat forever)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(shouldOffer('devnet', ID)).toBe(false)
    expect(noteOffered('devnet', ID)).toBe(false)
  })

  it('is not made when the record can be read but not written', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(noteOffered('devnet', ID)).toBe(false)
  })

  it('ignores a corrupt record', () => {
    localStorage.setItem(`forge.passkey-offer:devnet:${ID}`, '{"shown":"many","done":1}')
    expect(shouldOffer('devnet', ID)).toBe(true)
    localStorage.setItem(`forge.passkey-offer:devnet:${ID}`, 'not json')
    expect(shouldOffer('devnet', ID)).toBe(false)
  })
})
