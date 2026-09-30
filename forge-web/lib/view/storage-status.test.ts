/**
 * Gateway bookkeeping: which gateways a repo's reads prefer, when a gateway counts as down,
 * and how failed places are described.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  describePack,
  gatewayDownReason,
  gatewayHealth,
  gatewaysIn,
  MAX_REPO_GATEWAYS,
  noteRepoGateways,
  onlyGatewaysFailed,
  onlyUnfollowed,
  readGatewaysFor,
  resetGatewayHealth,
  resetRepoGateways,
  UNFOLLOWED,
} from './storage-status'

afterEach(() => {
  vi.unstubAllGlobals()
  resetGatewayHealth()
  resetRepoGateways()
})

describe('a repo\'s own gateways', () => {
  it('are public https bases without query or fragment, capped', () => {
    expect(
      gatewaysIn([
        'https://gw.example?x=/ipfs/bafy',
        'https://nas.local./ipfs/bafy',
        'http://pub.example/ipfs/bafy',
        'https://ok.example/ipfs/bafy',
      ]),
    ).toEqual(['https://gw.example', 'https://ok.example'])
    noteRepoGateways('r', 'manifests', Array.from({ length: 6 }, (_, i) => `https://g${i}.example/ipfs/`))
    expect(readGatewaysFor('r').slice(0, MAX_REPO_GATEWAYS + 1)).toEqual([
      'https://g0.example',
      'https://g1.example',
      'https://g2.example',
      expect.not.stringMatching(/g3\.example/),
    ])
  })
})

describe('repo gateway sources', () => {
  it('puts the config first whatever order the sources arrive in, and replaces stale snapshots', () => {
    noteRepoGateways('r', 'manifests', ['https://m1.example/ipfs/a', 'https://m2.example/ipfs/b', 'https://m3.example/ipfs/c'])
    noteRepoGateways('r', 'config', ['https://cfg.example/ipfs/'])
    expect(readGatewaysFor('r').slice(0, 3)).toEqual(['https://cfg.example', 'https://m1.example', 'https://m2.example'])
    // A newer manifest snapshot without m1 drops it; an empty config snapshot drops cfg.
    noteRepoGateways('r', 'manifests', ['https://m2.example/ipfs/b'])
    noteRepoGateways('r', 'config', [])
    expect(readGatewaysFor('r')[0]).toBe('https://m2.example')
    expect(readGatewaysFor('r')).not.toContain('https://m1.example')
    expect(readGatewaysFor('r')).not.toContain('https://cfg.example')
  })
})

describe('gatewayHealth', () => {
  it('is down only on a readable 429/410/5xx; a thrown fetch is not a verdict', async () => {
    const status: Record<string, number | 'throw'> = {
      'https://retired.example': 429,
      'https://gone.example': 410,
      'https://broken.example': 502,
      'https://dedicated.example': 'throw',
      'https://up.example': 200,
    }
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      expect(init?.cache).toBe('no-store')
      const s = status[url.replace('/ipfs/bafkqaaa', '')]
      return s === 'throw' ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(new Response('', { status: s }))
    })
    expect(await gatewayHealth('https://retired.example')).toBe('HTTP 429')
    expect(await gatewayHealth('https://gone.example')).toBe('HTTP 410')
    expect(await gatewayHealth('https://broken.example')).toBe('HTTP 502')
    expect(await gatewayHealth('https://dedicated.example')).toBeNull()
    expect(await gatewayHealth('https://up.example')).toBeNull()
  })

  it('probes a down gateway again after the verdict expires', async () => {
    let calls = 0
    vi.stubGlobal('fetch', () => {
      calls += 1
      return Promise.resolve(new Response('', { status: calls === 1 ? 429 : 200 }))
    })
    expect(await gatewayHealth('https://flaky.example', 1_000)).toBe('HTTP 429')
    expect(await gatewayHealth('https://flaky.example', 30_000)).toBe('HTTP 429')
    expect(calls).toBe(1)
    expect(await gatewayHealth('https://flaky.example', 70_000)).toBeNull()
    expect(calls).toBe(2)
  })
})

describe('describePack', () => {
  it('names each failed gateway, and never calls an R2 mirror a gateway', () => {
    const places = describePack(
      {
        packHash: 'aa',
        hosts: ['pub-1.r2.dev', 'ipfs.io', 'gw.example'],
        corrupt: false,
        reason: [
          'pub-1.r2.dev: HTTP 403',
          gatewayDownReason('ipfs.io', "HTTP 429 (retired) (really)"),
          'gw.example: no data for 15s',
        ].join('; '),
      },
      ['https://gw.example'],
    )
    expect(places).toEqual([
      'pub-1.r2.dev (access denied)',
      'ipfs gateway ipfs.io (down: HTTP 429 (retired) (really))',
      'ipfs gateway gw.example (timed out)',
    ])
    expect(onlyGatewaysFailed(places)).toBe(false)
    expect(onlyGatewaysFailed(places.slice(1))).toBe(true)
    // A mirror's own message that merely mentions "gateway down" is not a gateway verdict.
    expect(
      describePack({ packHash: 'bb', hosts: ['pub-1.r2.dev'], corrupt: false, reason: 'pub-1.r2.dev: upstream said gateway down (x)' }, []),
    ).toEqual(['pub-1.r2.dev (didn\'t answer)'])
  })

  it('names a recorded private or plain-http copy as not followed, not as nothing recorded (QW2-006)', () => {
    const pack = { packHash: 'cc', hosts: [], corrupt: false, reason: 'nothing to try', unfollowed: ['127.0.0.1:9000'] }
    expect(describePack(pack, [])).toEqual([`127.0.0.1:9000 (${UNFOLLOWED})`])
    expect(onlyUnfollowed(describePack(pack, []))).toBe(true)
    expect(describePack({ ...pack, unfollowed: [] }, [])).toEqual(['no place a browser can fetch from is recorded'])
    expect(onlyUnfollowed(describePack({ ...pack, hosts: ['pub-1.r2.dev'], reason: 'pub-1.r2.dev: HTTP 403' }, []))).toBe(false)
  })
})
