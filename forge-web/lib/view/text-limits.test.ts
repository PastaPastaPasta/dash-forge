import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { BODY_LIMIT, TITLE_LIMIT, overLimitMessage, textUse } from './text-limits'

describe('text limits match the contract (D-049)', () => {
  it('are the forge-collab schemaDefs', () => {
    const contract = JSON.parse(readFileSync(join(__dirname, '../../../forge-contracts/contracts/forge-collab.json'), 'utf8'))
    expect(BODY_LIMIT).toEqual({ chars: contract.schemaDefs.body.maxLength, bytes: contract.schemaDefs.body.maxBytes })
    expect(TITLE_LIMIT).toEqual({ chars: contract.schemaDefs.title.maxLength, bytes: contract.schemaDefs.title.maxBytes })
  })
  it('a 5,120-byte body fits; 5,121 does not', () => {
    expect(textUse('a'.repeat(5120), BODY_LIMIT).over).toBe(false)
    expect(textUse('a'.repeat(5121), BODY_LIMIT).over).toBe(true)
  })
  it('counts UTF-8 bytes: 2,000 three-byte characters are over', () => {
    const use = textUse('€'.repeat(2000), BODY_LIMIT)
    expect(use).toMatchObject({ chars: 2000, bytes: 6000, over: true })
    expect(overLimitMessage('comment', use, BODY_LIMIT)).toMatch(/6,000 bytes.*at most 5,120.*880 bytes/)
  })
  it('counts characters as code points for the title', () => {
    expect(textUse('😀'.repeat(256), TITLE_LIMIT).over).toBe(false)
    expect(textUse('x'.repeat(257), TITLE_LIMIT).over).toBe(true)
  })
  it('turns amber within 10 %', () => {
    expect(textUse('a'.repeat(4700), BODY_LIMIT).near).toBe(true)
    expect(textUse('a'.repeat(100), BODY_LIMIT).near).toBe(false)
  })
})
