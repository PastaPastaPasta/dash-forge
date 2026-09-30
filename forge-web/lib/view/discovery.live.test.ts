/**
 * Live, read-only: every landing and Explore read against the registered RC1 contracts on the
 * active devnet (bonsia): each is one a registered index answers (RC1 forge-core refuses a
 * query no index matches, e.g. `$createdAt` ordered without the `recent` index's
 * `visibility ==` prefix), and the seeded repos come back. Nothing is written.
 *
 *   FORGE_LIVE=1 NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=bonsia pnpm vitest run lib/view/discovery.live.test.ts
 */

import { describe, expect, it } from 'vitest'

import { NETWORKS } from '../constants'
import { readMostFollowed, readMostForked, readMostStarred, readTrending } from '../repo/trending'
import { ensureSdk } from '../sdk/service'
import { listReposByOwner, rankedRepos, recentReposPage, reposNamed, searchRepos } from './discovery'

const forge = NETWORKS.devnet.v2
const live = process.env['FORGE_LIVE'] === '1' && NETWORKS.devnet.devnetName === 'bonsia' && forge !== null
/** The seeded read fixture's owner (forge-v2-demo). */
const DEMO_OWNER = process.env['FORGE_DEMO_OWNER'] ?? '2X2XM6kF5DK9Vx8Mfot4wetvppBKLE1W3tC87NA36jXP'

describe.skipIf(!live)('landing and Explore reads on devnet bonsia (live, read-only)', () => {
  it('recent public repos page to the end, newest first, public only', async () => {
    const sdk = await ensureSdk('devnet')
    let page = await recentReposPage(sdk, { network: 'devnet', limit: 10 })
    expect(page.repos.length).toBeGreaterThan(0)
    // The composite (counts, names, pushes) was answered, not refused into the plain fallback.
    expect(page.fallback).toBe(false)
    const all = [...page.repos]
    for (let i = 0; page.next !== null && i < 10; i++) {
      page = await recentReposPage(sdk, { network: 'devnet', limit: 10, after: page.next })
      all.push(...page.repos)
    }
    expect(all.every((r) => r.visibility === 'public')).toBe(true)
    const times = all.map((r) => r.createdAt)
    expect([...times].sort((a, b) => b - a)).toEqual(times)
    expect(all.some((r) => r.slug === 'forge-v2-demo')).toBe(true)
  }, 180_000)

  it('search by name prefix, repos named exactly, an owner\'s repos', async () => {
    const sdk = await ensureSdk('devnet')
    const search = await searchRepos(sdk, 'forge-v2', { network: 'devnet' })
    expect(search.fallback).toBe(false)
    expect(search.repos.map((r) => r.slug)).toContain('forge-v2-demo')
    expect((await reposNamed(sdk, 'forge-v2-demo', { network: 'devnet' })).repos.length).toBeGreaterThan(0)
    const owned = await listReposByOwner(sdk, DEMO_OWNER, { network: 'devnet', counts: true })
    expect(JSON.stringify(owned)).toContain('forge-v2-demo')
  }, 180_000)

  it('the ranked reads: trending (week, today), most starred, most forked, most followed', async () => {
    const sdk = await ensureSdk('devnet')
    const f = forge as NonNullable<typeof forge>
    for (const read of [
      () => readTrending(sdk, f, 'week'),
      () => readTrending(sdk, f, 'today'),
      () => readMostStarred(sdk, f),
      () => readMostForked(sdk, f),
      () => readMostFollowed(sdk, f),
    ]) {
      await expect(read()).resolves.toHaveProperty('entries')
    }
    for (const kind of ['week', 'today', 'most-starred', 'most-forked'] as const) {
      await expect(rankedRepos(sdk, kind, { network: 'devnet' })).resolves.toHaveProperty('repos')
    }
  }, 180_000)
})
