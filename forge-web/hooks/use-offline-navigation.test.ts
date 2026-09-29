import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }) }))

import { offlineTarget } from './use-offline-navigation'

describe('offline navigation target (M5)', () => {
  const here = 'https://forge.example/dash-forge/repo/?owner=a&name=b'
  it('holds a link to another page, without the base path (router.push adds it)', () => {
    expect(offlineTarget('https://forge.example/dash-forge/repo/pulls/?owner=a&name=b', here, '/dash-forge')).toBe('/repo/pulls/?owner=a&name=b')
    expect(offlineTarget('https://forge.example/dash-forge', here, '/dash-forge')).toBe('/')
    expect(offlineTarget('https://forge.example/explore/', 'https://forge.example/', '')).toBe('/explore/')
  })

  it('lets same-page anchors and other origins through', () => {
    expect(offlineTarget(`${here}#readme`, here, '/dash-forge')).toBeNull()
    expect(offlineTarget(here, here, '/dash-forge')).toBeNull()
    expect(offlineTarget('https://github.com/x', here, '/dash-forge')).toBeNull()
  })
})
