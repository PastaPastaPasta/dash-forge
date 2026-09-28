import { describe, expect, it } from 'vitest'

import { mirrorSourceOf, mirrorSourceOfRows } from './mirror-source'

describe('mirrorSourceOf', () => {
  it('names a GitHub issue or PR source and links its full list', () => {
    expect(mirrorSourceOf('https://github.com/dashpay/dash/issues/7761', 'issue')).toEqual({
      host: 'github.com',
      label: 'github.com/dashpay/dash',
      listUrl: 'https://github.com/dashpay/dash/issues',
    })
    expect(mirrorSourceOf('https://github.com/dashpay/dash/pull/7760', 'pull')).toEqual({
      host: 'github.com',
      label: 'github.com/dashpay/dash',
      listUrl: 'https://github.com/dashpay/dash/pulls',
    })
  })

  it('names a GitLab source, nested groups included', () => {
    expect(mirrorSourceOf('https://gitlab.com/gitlab-org/ci/runner/-/merge_requests/3', 'pull')).toEqual({
      host: 'gitlab.com',
      label: 'gitlab.com/gitlab-org/ci/runner',
      listUrl: 'https://gitlab.com/gitlab-org/ci/runner/-/merge_requests',
    })
    expect(mirrorSourceOf('https://gitlab.com/g/p/-/issues/2', 'issue')?.listUrl).toBe('https://gitlab.com/g/p/-/issues')
  })

  it('refuses anything that is not an https item URL', () => {
    expect(mirrorSourceOf('', 'issue')).toBeNull()
    expect(mirrorSourceOf('javascript:alert(1)', 'issue')).toBeNull()
    expect(mirrorSourceOf('http://github.com/o/r/issues/1', 'issue')).toBeNull()
    expect(mirrorSourceOf('https://github.com/o/r', 'issue')).toBeNull()
    expect(mirrorSourceOf('https://github.com/o/r/issues/1#issuecomment-2', 'issue')?.label).toBe('github.com/o/r')
  })

  it('takes the first row that names a source', () => {
    expect(mirrorSourceOfRows(['', 'https://github.com/o/r/issues/3'], 'issue')?.label).toBe('github.com/o/r')
    expect(mirrorSourceOfRows(['', ''], 'issue')).toBeNull()
  })
})
