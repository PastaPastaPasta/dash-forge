import { describe, expect, it } from 'vitest'

import { outline } from './outline'

describe('outline', () => {
  it('lists ## and ### headings with the ids MarkdownView gives them', () => {
    expect(outline('## One\n\n### Two\n\n#### Deep\n\n## One')).toEqual([
      { id: 'user-content-one', text: 'One', level: 2 },
      { id: 'user-content-two', text: 'Two', level: 3 },
      { id: 'user-content-one-1', text: 'One', level: 2 },
    ])
  })

  it('counts a heading inside a quote or a list before numbering a repeat', () => {
    expect(outline('> ## Repeat\n\n## Repeat\n\n- item\n\n  ## Other\n\n## Other').map((h) => h.id)).toEqual(['user-content-repeat-1', 'user-content-other-1'])
  })
})
