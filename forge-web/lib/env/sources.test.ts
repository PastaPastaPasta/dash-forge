/**
 * The loader's SDK reads: who counts as a maintainer comes from the repo's `maintainer`
 * documents alone (forge-core `MemberReader::maintainers`), never from a `writer` document.
 */
import type { EvoSDK } from '@dashevo/evo-sdk'
import { describe, expect, it, vi } from 'vitest'

const asked: string[] = []
vi.mock('../sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sdk')>()),
  queryAllDocuments: vi.fn(async (_sdk: unknown, q: { documentTypeName: string }) => {
    asked.push(q.documentTypeName)
    return q.documentTypeName === 'maintainer'
      ? [{ $id: 'd1', $createdAt: 1, memberId: 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr' }]
      : [{ $id: 'd2', $createdAt: 1, memberId: 'CJao2MVHL4x3f2Ko2xTUibnZ8G1t9exTPtvJnCbHAgDH', role: 0 }]
  }),
}))

import type { RepoRef } from '../repo/contract'
import { sdkEnvSources } from './sources'

const REPO: RepoRef = {
  forge: {
    core: 'A2KL77ngVM1ft1t1em2XKt1rWCBZANdAJMyfWrDGCcd1',
    collab: 'C1zHeeG7EUudXdB5ZyDQnXVU35hrCfvd1fRCybXEqaPS',
    community: 'E24SPCssqYzFQmjcQ1hNmiLXrzz1o9AqTv54tuWNkgHz',
    group: '6dV3kMBWHGR7pLKrHToMBQgbTpjqeE2VAyCEWmLbrkWC',
  },
  repoId: '8H5JaQm8Z765UunuttoUuVsVMCmDoy2EBKgmGKYpdB2z',
  ownerId: 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr',
  name: 'demo',
  visibility: 'public',
}

describe('sdkEnvSources', () => {
  it('reads the maintainers from maintainer documents only', async () => {
    const got = await sdkEnvSources({} as unknown as EvoSDK, REPO).maintainers()
    expect(got).toEqual(['HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'])
    expect(asked).toEqual(['maintainer'])
  })
})
