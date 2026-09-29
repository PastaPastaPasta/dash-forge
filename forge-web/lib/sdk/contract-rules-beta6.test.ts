/**
 * The pinned SDK parses contracts with the propertyConstraints forms of 4.2.0-beta.6 (`countOf`,
 * `sumOf`, `ifThen`, `notIn`, `$ownerId`, `$createdAtBlockHeight`, ...). The fixture is the
 * forge-collab draft for the next moutai registration (dash-forge-qa design/state-counts, with
 * per-repo counts and dense issue numbering); wasm-sdk 4.2.0-beta.5 refuses it ("names
 * "notIn", which is not a comparison ..."), so this fails on any SDK older than beta.6.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

type Evo = typeof import('@dashevo/evo-sdk')

// Any valid identifiers: the parse checks shapes, not that they exist on a network.
const FORGE_CORE = 'A2KL77ngVM1ft1t1em2XKt1rWCBZANdAJMyfWrDGCcd1'
const CONTRACT_ID = 'C1zHeeG7EUudXdB5ZyDQnXVU35hrCfvd1fRCybXEqaPS'
const OWNER = 'E24SPCssqYzFQmjcQ1hNmiLXrzz1o9AqTv54tuWNkgHz'

function fixture(): Record<string, unknown> {
  const text = readFileSync(resolve(__dirname, 'fixtures', 'forge-collab-state-counts.json'), 'utf8')
  const json = JSON.parse(text.split('FORGE_CORE_CONTRACT_ID').join(FORGE_CORE)) as Record<string, unknown>
  return { ...json, id: CONTRACT_ID, ownerId: OWNER }
}

describe('wasm-sdk 4.2.0-beta.6 contract rules', () => {
  let evo: Evo
  beforeAll(async () => {
    evo = await import('@dashevo/evo-sdk')
    await evo.EvoSDK.getLatestVersionNumber()
  })

  it('the fixture uses the beta.6-only keywords', () => {
    const text = JSON.stringify(fixture())
    for (const keyword of ['"countOf"', '"sumOf"', '"ifThen"', '"notIn"', '"$ownerId"', '"$createdAtBlockHeight"']) expect(text).toContain(keyword)
  })

  it('parses a contract whose rules read totals, conditionals and system heights', () => {
    const contract = evo.DataContract.fromJSON(fixture() as Parameters<Evo['DataContract']['fromJSON']>[0], true, 14)
    const issue = contract.documentTypePropertyConstraints('issue')
    const dense = issue.find((r) => r.name === 'dense')
    expect(dense?.readsTotals.map((t) => t.kind)).toEqual(['countOf', 'countOf'])
    expect(dense?.readsSystem).toContain('$createdAtBlockHeight')
    const transition = contract.documentTypePropertyConstraints('transition')
    expect(transition.flatMap((r) => r.readsTotals.map((t) => t.kind))).toContain('sumOf')
    expect(JSON.stringify(contract.documentTypePropertyConstraints('event').map((r) => r.rule))).toContain('notIn')
  })
})
