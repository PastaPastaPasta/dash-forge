/**
 * Live forge-v2 read smoke — SKIPPED by default (needs network + WASM).
 *
 * Run with:
 *   FORGE_LIVE=1 NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=moutai \
 *     pnpm exec vitest run lib/repo/v2.live.test.ts
 *
 * Reads the forge-v2 fixture `forge-contracts/scripts/seed-v2-fixture.mjs` seeds on moutai
 * end to end through the same functions the pages use: resolution by `(owner, name)` and by
 * DPNS-less id, refs, config, membership, the issue/PR folds over `event` + `authorEvent`,
 * approvals, and the browse plane (locator + Platform chunks, hash-checked objects).
 * Never gates CI.
 */

import { describe, expect, it } from 'vitest'

import { DEFAULT_NETWORK } from '../constants'
import { evoSdkService } from '../sdk'
import { commitRootTree, loadBrowseContext, loadIssueThread, loadPullThread, loadRepoHome, readTree } from '../view'
import { listRecentRepos, listReposByOwner } from '../view/discovery'
import { listIssues, listPulls, readMemberships } from './index'

const LIVE = process.env['FORGE_LIVE'] === '1' && DEFAULT_NETWORK === 'devnet'

const OWNER = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
const MAINTAINER = 'GKBTXUdo3MpRYAUqgZvTZGTav9mXGqfJfR5822K2tp79'
const COLLAB = '6jAyDGGcc6fgA7bsraQPriTAZ73Lkq5QgnenaRhqteHd'
const MAIN_TIP = 'b35c50122cd51b2cc0345760721e6398fa0c31f5'

describe.skipIf(!LIVE)('live forge-v2 reads (moutai fixture)', () => {
  it(
    'resolves, folds and browses the fixture repo',
    async () => {
      await evoSdkService.initialize({ network: 'devnet', contractIds: [], timeoutMs: 20000 })
      const sdk = evoSdkService.getSdk()

      const home = await loadRepoHome(sdk, { network: 'devnet', owner: OWNER, name: 'forge-v2-demo' })
      expect(home?.repo.kind).toBe('v2')
      if (home === null || home.repo.kind !== 'v2') throw new Error('unreachable')
      expect(home.defaultBranch).toBe('main')
      expect(home.starCount).toBe(1)
      const main = home.branches.find((b) => b.refName === 'refs/heads/main')
      expect(main?.state).toMatchObject({ state: 'resolved', oid: MAIN_TIP })
      expect(home.tags.map((t) => t.refName)).toEqual(['refs/tags/v0.1.0'])

      // `?repo=` pin resolves the same repo; a wrong owner does not.
      const pinned = await loadRepoHome(sdk, {
        network: 'devnet',
        owner: OWNER,
        name: 'ignored',
        repoId: home.repo.repoId,
      })
      expect(pinned?.repo.kind).toBe('v2')
      expect(
        await loadRepoHome(sdk, { network: 'devnet', owner: MAINTAINER, name: 'x', repoId: home.repo.repoId }),
      ).toBeNull()

      const members = await readMemberships(sdk, home.repo)
      expect(members.map((m) => `${m.role}:${m.identity}`).sort()).toEqual(
        [`maintainer:${OWNER}`, `maintainer:${MAINTAINER}`, `writer:${COLLAB}`].sort(),
      )

      const issues = await listIssues(sdk, home.repo)
      const byNumber = new Map(issues.map((i) => [i.number, i]))
      expect(byNumber.get(1)?.state).toMatchObject({ open: true, labels: ['question'] })
      expect(byNumber.get(2)?.state.open).toBe(false) // the author's own authorEvent close
      expect(byNumber.get(3)?.state).toMatchObject({ open: false, labels: ['docs'] })

      const pulls = await listPulls(sdk, home.repo)
      const pr = new Map(pulls.map((p) => [p.number, p]))
      expect(pr.get(1)?.state).toMatchObject({ open: true, merged: false })
      expect(pr.get(2)?.state.merged).toBe(true)
      expect(pr.get(1)?.sourceId).toBe(home.repo.repoId)

      const thread = await loadPullThread(sdk, home.repo, 1)
      expect(thread?.approvals?.approvers).toEqual([MAINTAINER])
      const issue2 = await loadIssueThread(sdk, home.repo, 2)
      expect(issue2?.timeline.some((t) => t.kind === 'event' && t.byAuthor === true)).toBe(true)

      const browse = await loadBrowseContext(sdk, home.repo)
      expect(browse.kind).toBe('ready')
      if (browse.kind !== 'ready') throw new Error('unreachable')
      const { tree } = await commitRootTree(browse.context.reader, MAIN_TIP)
      const names = (await readTree(browse.context.reader, tree)).map((e) => e.name).sort()
      expect(names).toEqual(['README.md', 'docs', 'lib', 'src'])

      const feed = await listRecentRepos(sdk, { network: 'devnet' })
      const repoId = home.repo.repoId
      const demo = feed.v2.find((r) => r.repoId === repoId)
      expect(demo).toMatchObject({ stars: 1, issues: 3 })

      const profile = await listReposByOwner(sdk, MAINTAINER, { network: 'devnet' })
      expect(profile.owned.map((r) => r.slug)).toContain('forge-v2-empty')
      expect(profile.member.map((r) => r.slug)).toContain('forge-v2-demo')
    },
    180000,
  )
})
