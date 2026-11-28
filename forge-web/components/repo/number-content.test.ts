import { describe, expect, it } from 'vitest'

import { numberMissing } from './number-content'

const gh = { host: 'github.com', path: 'PastaPastaPasta/dash-forge' }

describe('numberMissing', () => {
  it('a mirror sends a #N it does not hold to the source forge', () => {
    expect(numberMissing(779, gh, false)).toEqual({
      body: 'No issue or PR has number 779 here. This repo mirrors github.com/PastaPastaPasta/dash-forge.',
      url: 'https://github.com/PastaPastaPasta/dash-forge/issues/779',
      link: 'Open #779 on github.com',
    })
  })

  it("imported content's #N names the import that did not copy it", () => {
    expect(numberMissing(5, gh, true)).toEqual({ body: 'Its import did not copy #5.', url: 'https://github.com/PastaPastaPasta/dash-forge/issues/5', link: 'Open #5 on github.com' })
  })

  it('a repo that mirrors nothing has no link', () => {
    expect(numberMissing(3, null, false)).toEqual({ body: 'No issue or PR has number 3 here.', url: null, link: '' })
    expect(numberMissing(3, null, true)).toEqual({ body: 'No issue or PR has number 3 here.', url: null, link: '' })
  })
})
