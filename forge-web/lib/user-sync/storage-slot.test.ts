import { describe, expect, it } from 'vitest'

import type { StorageConfig } from '../storage/store'
import { LOCAL_PROFILE_CAP, LocalProfileCapError, collisionName, localAfterSave, storageDeletions, storageView } from './storage-slot'

type Profile = StorageConfig['profiles'][number]
const s3 = (name: string, bucket = 'b'): Profile =>
  ({ name, settings: { kind: 's3', provider: 'r2', endpoint: 'https://a.example', region: 'auto', bucket, pathStyle: true, publicUrl: 'https://p.example', prefix: '' }, secrets: {} }) as Profile
const config = (profiles: Profile[]): StorageConfig => ({ version: 1, profiles, defaultPolicy: null, repoPolicies: {}, lastTests: {} })

describe('a Settings save over the merged view', () => {
  it('refuses a save past the cap instead of dropping hidden local profiles (M1)', () => {
    const hidden = Array.from({ length: LOCAL_PROFILE_CAP }, (_, i) => s3(`h${String(i).padStart(2, '0')}`))
    expect(() => localAfterSave(config(hidden), config([]), config([s3('new')]), 'dddd')).toThrow(LocalProfileCapError)
  })

  it('keeps a local profile shown under its collision name local, under its own name: never uploaded as a copy', () => {
    const local = config([s3('r2', 'mine')])
    const shown = storageView({ 'profile:r2': { settings: s3('r2', 'theirs').settings, secrets: {} } }, ['profile:r2'], local, 'dddd')
    expect(shown.profiles.map((p) => p.name)).toEqual(['r2', collisionName('r2', 'dddd')])
    const next = { ...shown, profiles: [...shown.profiles, s3('other')] }
    const saved = localAfterSave(local, shown, next, 'dddd')
    expect(saved.profiles).toEqual([s3('other'), s3('r2', 'mine')])
  })

  it('records only what the user deleted', () => {
    expect(storageDeletions(config([s3('a'), s3('b')]), config([s3('b')]))).toEqual(['profile:a'])
  })

  it('keeps the local default, repo policies and test results the page did not edit', () => {
    const local: StorageConfig = { ...config([s3('a')]), defaultPolicy: { targets: ['a'], replicas: 1, platformFallback: false }, repoPolicies: { r1: { targets: ['a'], replicas: 1, platformFallback: false } }, lastTests: { a: { at: 1, ok: true } } }
    const shown: StorageConfig = { ...config([s3('a'), s3('b')]), defaultPolicy: { targets: ['b'], replicas: 1, platformFallback: false }, repoPolicies: { r1: { targets: ['b'], replicas: 1, platformFallback: true }, r2: { targets: ['b'], replicas: 1, platformFallback: false } }, lastTests: { a: { at: 9, ok: false } } }
    const next: StorageConfig = { ...shown, repoPolicies: { ...shown.repoPolicies, r2: { targets: ['a'], replicas: 1, platformFallback: false } } }
    const saved = localAfterSave(local, shown, next, 'dddd')
    expect(saved.defaultPolicy).toEqual(local.defaultPolicy)
    expect(saved.repoPolicies).toEqual({ r1: local.repoPolicies['r1'], r2: { targets: ['a'], replicas: 1, platformFallback: false } })
    expect(saved.lastTests).toEqual(local.lastTests)
  })

  it('an edit of the synced namesake keeps the local profile, under the name it was shown with', () => {
    const local = config([s3('r2', 'mine')])
    const shown = storageView({ 'profile:r2': { settings: s3('r2', 'theirs').settings, secrets: {} } }, ['profile:r2'], local, 'dddd')
    const next = { ...shown, profiles: shown.profiles.map((p) => (p.name === 'r2' ? s3('r2', 'edited') : p)) }
    const saved = localAfterSave(local, shown, next, 'dddd')
    expect(saved.profiles).toEqual([s3('r2', 'edited'), s3(collisionName('r2', 'dddd'), 'mine')])
  })

  it('shows the local profile under a free name when the plain collision name is synced too, and keeps it on save', () => {
    const local = config([s3('r2', 'mine')])
    const synced = { 'profile:r2': { settings: s3('r2', 'theirs').settings, secrets: {} }, [`profile:${collisionName('r2', 'dddd')}`]: { settings: s3('x', 'other').settings, secrets: {} } }
    const shown = storageView(synced, ['profile:r2'], local, 'dddd')
    expect(shown.profiles.find((p) => p.settings.kind === 's3' && (p.settings as { bucket: string }).bucket === 'mine')?.name).toBe(collisionName('r2', 'dddd-2'))
    const saved = localAfterSave(local, shown, { ...shown, profiles: [...shown.profiles, s3('other')] }, 'dddd')
    expect(saved.profiles.find((p) => p.name === 'r2')).toEqual(s3('r2', 'mine'))
  })

  it('keeps a collision name a saved policy names, so the policy resolves in the local blob', () => {
    const local = config([s3('r2', 'mine')])
    const shown = storageView({ 'profile:r2': { settings: s3('r2', 'theirs').settings, secrets: {} } }, ['profile:r2'], local, 'dddd')
    const alias = collisionName('r2', 'dddd')
    const saved = localAfterSave(local, shown, { ...shown, defaultPolicy: { targets: [alias], replicas: 1, platformFallback: false } }, 'dddd')
    expect(saved.defaultPolicy?.targets).toEqual([alias])
    expect(saved.profiles.map((p) => p.name)).toContain(alias)
  })
})
