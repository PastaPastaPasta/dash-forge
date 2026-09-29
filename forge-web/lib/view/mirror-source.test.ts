import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it } from 'vitest'

import { invalidateMembers, type RepoRef } from '../repo'
import type { DocumentQuery } from '../sdk'
import { mirrorSourceOf, mirrorSourceOfDescription, readMirrorSource } from './mirror-source'

describe('mirrorSourceOf', () => {
  it('names a GitHub issue or PR source and links its full list', () => {
    expect(mirrorSourceOf('https://github.com/dashpay/dash/issues/7761', 'issue')).toEqual({
      host: 'github.com',
      label: 'github.com/dashpay/dash',
      listUrl: 'https://github.com/dashpay/dash/issues',
    })
    expect(mirrorSourceOf('https://github.com/dashpay/dash/pull/7760', 'pull')?.listUrl).toBe('https://github.com/dashpay/dash/pulls')
  })

  it('names a gitlab.com source (nested groups too); a self-hosted GitLab only when asked', () => {
    expect(mirrorSourceOf('https://gitlab.com/gitlab-org/ci/runner/-/merge_requests/3', 'pull')).toEqual({
      host: 'gitlab.com',
      label: 'gitlab.com/gitlab-org/ci/runner',
      listUrl: 'https://gitlab.com/gitlab-org/ci/runner/-/merge_requests',
    })
    expect(mirrorSourceOf('https://git.example.org/g/p/-/issues/2', 'issue')).toBeNull()
    expect(mirrorSourceOf('https://git.example.org/g/p/-/issues/2', 'issue', true)?.listUrl).toBe('https://git.example.org/g/p/-/issues')
  })

  it('refuses lookalike hosts, credentials and anything that is not an https item URL', () => {
    expect(mirrorSourceOf('https://github.com.evil.io/o/r/issues/1', 'issue')).toBeNull()
    expect(mirrorSourceOf('https://github.com.evil.io/o/r/issues/1', 'issue', true)).toBeNull()
    expect(mirrorSourceOf('https://evil.io/o/r/issues/1', 'issue')).toBeNull()
    expect(mirrorSourceOf('https://x@github.com/o/r/issues/1', 'issue')).toBeNull()
    expect(mirrorSourceOf('', 'issue')).toBeNull()
    expect(mirrorSourceOf('javascript:alert(1)', 'issue')).toBeNull()
    expect(mirrorSourceOf('http://github.com/o/r/issues/1', 'issue')).toBeNull()
    expect(mirrorSourceOf('https://github.com/o/r', 'issue')).toBeNull()
  })
})

describe('mirrorSourceOfDescription (what forge-import writes on the repo)', () => {
  it('reads both of the importer’s forms', () => {
    expect(mirrorSourceOfDescription('Mirror of github.com/dashpay/dash', 'issue')?.label).toBe('github.com/dashpay/dash')
    expect(mirrorSourceOfDescription('Dash - Reinventing Cryptocurrency (mirror of github.com/dashpay/dash)', 'pull')?.listUrl).toBe(
      'https://github.com/dashpay/dash/pulls',
    )
    expect(mirrorSourceOfDescription('Tools (mirror of gitlab.example.org/g/sub/p)', 'issue')?.listUrl).toBe('https://gitlab.example.org/g/sub/p/-/issues')
  })

  it('ignores a description that only mentions a mirror', () => {
    expect(mirrorSourceOfDescription('', 'issue')).toBeNull()
    expect(mirrorSourceOfDescription('A mirror of good ideas', 'issue')).toBeNull()
    expect(mirrorSourceOfDescription('Mirror of github.com/o', 'issue')).toBeNull()
  })
})

describe('readMirrorSource: only the owner’s and maintainers’ rows count', () => {
  const OWNER = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
  const MAINT = 'Ehyw8VygZh5LjjYHUbKqgyJamgetiVPLFnJewrfmgQUs'
  const STRANGER = 'BTJPjCLCnRaJQkqakpcdLYFsaHgFf5XSEBNxFCyYBteH'
  const REPO: RepoRef = { forge: { core: 'CORE', collab: 'COLLAB', group: 'GROUP' }, repoId: 'R', ownerId: OWNER, name: 'r', visibility: 'public' }
  type Doc = Record<string, unknown>
  const row = (author: string, number: number, url?: string): Doc => ({
    $id: `${author}-${number}`,
    $ownerId: author,
    repoId: 'R',
    number,
    ...(url ? { imported: { url } } : {}),
  })
  const sdkOf = (issues: Doc[], maintainers: string[] = []): EvoSDK => {
    const query = async (q: DocumentQuery): Promise<Map<string, Doc>> => {
      const rows =
        q.documentTypeName === 'maintainer'
          ? maintainers.map((id) => ({ $id: `m-${id}`, $ownerId: OWNER, repoId: 'R', memberId: id, $createdAt: 1 }))
          : q.documentTypeName === 'writer'
            ? []
            : issues
                .filter((d) => (q.where ?? []).every(([f, , v]) => d[f as string] === v))
                .sort((a, b) => (b['number'] as number) - (a['number'] as number))
                .slice(0, q.limit ?? 100)
      return new Map(rows.map((d) => [String(d['$id']), d]))
    }
    return { documents: { query } } as unknown as EvoSDK
  }
  beforeEach(() => invalidateMembers(REPO))

  it('shows no note for a stranger’s imported row, even on github.com', async () => {
    const sdk = sdkOf([row(STRANGER, 9000, 'https://github.com/phish/x/issues/1'), row(STRANGER, 9001, 'https://evil.example/g/p/-/issues/1')])
    expect(await readMirrorSource(sdk, REPO, '', 'issue')).toBeNull()
  })

  it('names the source from the owner’s newest imported row, past a native issue', async () => {
    const sdk = sdkOf([row(OWNER, 7761, 'https://github.com/dashpay/dash/issues/7761'), row(OWNER, 7762), row(STRANGER, 9000, 'https://github.com/phish/x/issues/1')])
    expect((await readMirrorSource(sdk, REPO, '', 'issue'))?.label).toBe('github.com/dashpay/dash')
  })

  it('still names the source when another trusted author’s read fails', async () => {
    const sdk = sdkOf([row(MAINT, 5, 'https://github.com/o/r/issues/5')], [MAINT])
    const query = sdk.documents.query.bind(sdk.documents)
    ;(sdk.documents as { query: typeof query }).query = (q) =>
      (q.where ?? []).some(([f, , v]) => f === '$ownerId' && v === OWNER) ? Promise.reject(new Error('DAPI unavailable')) : query(q)
    expect((await readMirrorSource(sdk, REPO, '', 'issue'))?.label).toBe('github.com/o/r')
  })

  it('trusts a maintainer’s row, self-hosted GitLab included', async () => {
    const sdk = sdkOf([row(MAINT, 5, 'https://git.example.org/g/p/-/issues/5')], [MAINT])
    expect((await readMirrorSource(sdk, REPO, '', 'issue'))?.label).toBe('git.example.org/g/p')
  })

  it('takes the owner-written description without reading rows', async () => {
    const sdk = { documents: { query: () => Promise.reject(new Error('no reads expected')) } } as unknown as EvoSDK
    expect((await readMirrorSource(sdk, REPO, 'Dash (mirror of github.com/dashpay/dash)', 'pull'))?.listUrl).toBe('https://github.com/dashpay/dash/pulls')
  })
})
