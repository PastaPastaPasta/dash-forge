import { describe, expect, it } from 'vitest'

import type { NetworkConfig } from './constants'
import { FORGE_HOME, devnetNoticeCopy, devnetNoticeDismissKey, devnetNoticeFor, parseDevnetNotice, parseMoveTo, writesPausedReason } from './devnet-notice'
import { parsePagesNotice } from './pages-notice'

const BONSIA: NetworkConfig = {
  network: 'devnet',
  devnetName: 'bonsia',
  key: 'devnet-bonsia',
  dapiAddresses: [],
  quorumBaseUrl: null,
  dpnsContractId: 'dpns',
  v2: null,
  retired: true,
}
const SAKURA: NetworkConfig = { ...BONSIA, devnetName: 'sakura', key: 'devnet-sakura', retired: false }

describe('parseDevnetNotice', () => {
  it('is off when unset or empty (the Pages variable passes an empty string when it is not set)', () => {
    expect(parseDevnetNotice(undefined)).toBeNull()
    expect(parseDevnetNotice('')).toBeNull()
    expect(parseDevnetNotice('  ')).toBeNull()
  })

  it('accepts the two modes, ignoring case and spaces', () => {
    expect(parseDevnetNotice('upcoming')).toBe('upcoming')
    expect(parseDevnetNotice(' Moving ')).toBe('moving')
  })

  it('fails the build on anything else, so a typo cannot leave the notice off', () => {
    expect(() => parseDevnetNotice('soon')).toThrow(/NEXT_PUBLIC_DEVNET_NOTICE "soon"/)
  })
})

describe('devnetNoticeFor', () => {
  it('applies to a devnet build only', () => {
    expect(devnetNoticeFor(BONSIA, 'upcoming')).toBe('upcoming')
    expect(devnetNoticeFor({ ...BONSIA, network: 'testnet', devnetName: null, key: 'testnet' }, 'moving')).toBeNull()
    expect(devnetNoticeFor({ ...BONSIA, network: 'mainnet', devnetName: null, key: 'mainnet' }, 'upcoming')).toBeNull()
    expect(devnetNoticeFor(BONSIA, null)).toBeNull()
  })

  it('honours `moving` only on a retired devnet, so a stale variable never freezes the devnet Forge moved to', () => {
    expect(devnetNoticeFor(BONSIA, 'moving')).toBe('moving')
    expect(devnetNoticeFor(SAKURA, 'moving')).toBeNull()
    expect(devnetNoticeFor({ ...SAKURA, retired: undefined }, 'moving')).toBeNull()
    expect(devnetNoticeFor(SAKURA, 'upcoming')).toBe('upcoming')
  })
})

describe('writesPausedReason', () => {
  it('pauses writes only while moving, and says why', () => {
    expect(writesPausedReason(null)).toBeNull()
    expect(writesPausedReason('upcoming')).toBeNull()
    expect(writesPausedReason('moving')).toBe('Writing is paused: this devnet was retired and Dash Forge moved to testnet.')
  })
})

describe('writesPausedReason with the operator pause', () => {
  const paused = parsePagesNotice({ mode: 'paused', text: 'Fixing a signing bug.', url: undefined })
  const advisory = parsePagesNotice({ mode: 'advisory', text: undefined, url: undefined })

  it('the operator pause turns writes off on any network, with its reason', () => {
    expect(writesPausedReason(null, paused)).toBe('Writing is paused: Fixing a signing bug.')
    expect(writesPausedReason('upcoming', paused)).toBe('Writing is paused: Fixing a signing bug.')
  })

  it('an advisory alone pauses nothing, and the devnet notice still applies beside it', () => {
    expect(writesPausedReason(null, advisory)).toBeNull()
    expect(writesPausedReason('moving', advisory)).toMatch(/^Writing is paused: this devnet was retired/)
  })

  it('the operator pause wins over the devnet move wording', () => {
    expect(writesPausedReason('moving', paused)).toBe('Writing is paused: Fixing a signing bug.')
  })
})

describe('parseMoveTo (WEB-16)', () => {
  it('is none when unset or empty', () => {
    expect(parseMoveTo(undefined)).toBeNull()
    expect(parseMoveTo('')).toBeNull()
  })

  it('names testnet, mainnet or another devnet', () => {
    expect(parseMoveTo('testnet')?.label).toBe('testnet')
    expect(parseMoveTo(' Mainnet ')?.label).toBe('mainnet')
    expect(parseMoveTo('devnet-sakura')?.label).toBe('devnet sakura')
  })

  it('a typo fails the build', () => {
    expect(() => parseMoveTo('test-net')).toThrow(/NEXT_PUBLIC_DEVNET_MOVE_TO "test-net"/)
    expect(() => parseMoveTo('devnet-')).toThrow(/NEXT_PUBLIC_DEVNET_MOVE_TO/)
  })
})

describe('copy and dismissal', () => {
  it('upcoming names a testnet destination when the build has one', () => {
    expect(devnetNoticeCopy('upcoming', 'sakura', parseMoveTo('testnet')).lead).toBe('sakura is moving to testnet soon.')
    expect(devnetNoticeCopy('upcoming', 'sakura', null).lead).toBe('sakura is moving to a new devnet soon.')
  })

  it('moving names where Forge is, devnet or not', () => {
    const c = devnetNoticeCopy('moving', 'sakura', null, { label: 'testnet', platform: null })
    expect(c.lead).toBe('Dash Forge moved to testnet; sakura was retired.')
    expect(c.body).toContain('Once the testnet build is live')
    expect(FORGE_HOME.label).toBe('testnet')
  })

  it('upcoming says what is wiped and what to do', () => {
    const c = devnetNoticeCopy('upcoming', 'bonsia')
    expect(c.lead).toBe('bonsia is moving to a new devnet soon.')
    expect(c.body).toBe(
      'Repos, issues, stars and keys on this devnet will be wiped. Mirrors need setting up again with the /mirror wizard, and your own repos will need a re-push from your clone.',
    )
  })

  it('moving says where Forge went and what is gone', () => {
    const c = devnetNoticeCopy('moving', 'bonsia')
    expect(c.lead).toBe('Dash Forge moved to testnet (Platform v5); bonsia was retired.')
    expect(c.body).toContain('Writing is paused here')
    expect(c.body).toContain('re-push your own repos from your clones')
  })

  it('keeps a dismissal per mode', () => {
    expect(devnetNoticeDismissKey('upcoming')).not.toBe(devnetNoticeDismissKey('moving'))
  })
})
