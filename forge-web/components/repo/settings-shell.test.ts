import { describe, expect, it } from 'vitest'
import { sectionOfHash } from './settings-shell'

describe('sectionOfHash', () => {
  it('maps every section hash links have used to its section', () => {
    for (const id of ['general', 'branches', 'collaborators', 'storage', 'webhooks', 'bans', 'danger'] as const) {
      expect(sectionOfHash(`#${id}`)).toBe(id)
    }
  })

  it('maps anchors inside a section to it', () => {
    expect(sectionOfHash('#members-unlock')).toBe('collaborators')
    expect(sectionOfHash('#members')).toBe('collaborators')
    expect(sectionOfHash('#platform-details')).toBe('general')
  })

  it('names none for an empty or unknown hash', () => {
    expect(sectionOfHash('')).toBeNull()
    expect(sectionOfHash('#nope')).toBeNull()
    expect(sectionOfHash('#%')).toBeNull()
  })
})
