/**
 * The contract facts private-repos.md §8.1 step 7 relies on to exempt a member `event` from the
 * late-content rule: it is immutable, non-deletable and gated (`ownerRefersTo`) to the repo's
 * current maintainers and writers, so a removed member cannot write one under an old key. A
 * contract change that relaxed any of them would need the rule back (§15).
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

type Schema = {
  documentsMutable?: boolean
  canBeDeleted?: boolean
  ownerRefersTo?: { anyOf?: { documentType?: string; type?: string }[] }
  properties: Record<string, unknown>
}

const contract = JSON.parse(readFileSync(resolve(process.cwd(), '..', 'forge-contracts', 'contracts', 'forge-community.json'), 'utf8')) as {
  documentSchemas?: Record<string, Schema>
} & Record<string, Schema>
const schemas = contract.documentSchemas ?? contract

describe('forge-community event (RC1 O-01): what the late-rule exemption needs', () => {
  const event = schemas['event'] as Schema

  it('is immutable and cannot be deleted', () => {
    expect(event.documentsMutable).toBe(false)
    expect(event.canBeDeleted).toBe(false)
  })

  it('is written only by a current maintainer or writer', () => {
    const gates = (event.ownerRefersTo?.anyOf ?? []).map((g) => g.documentType).sort()
    expect(gates).toEqual(['maintainer', 'writer'])
  })

  it('carries enc and epoch for the sealed value', () => {
    expect(Object.keys(event.properties)).toEqual(expect.arrayContaining(['value', 'enc', 'epoch']))
  })
})
