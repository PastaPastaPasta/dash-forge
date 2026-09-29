/**
 * The pinned SDK parses contracts with the propertyConstraints forms added in 4.2.0-beta.6 (`countOf`,
 * `sumOf`, `ifThen`, `notIn`, `$ownerId`, `$createdAtBlockHeight`, ...), and judges a document
 * against them locally. The fixture is the forge-collab draft for the next moutai registration
 * (dash-forge-qa design/state-counts, with per-repo counts and dense issue numbering); wasm-sdk
 * 4.2.0-beta.5 refuses it ("names "notIn", which is not a comparison ..."), so this fails on any
 * SDK older than beta.6.
 *
 * The fixture's references still use the pre-beta.7 `refersTo.lookup` / `propertyAgreement`
 * keywords, which 4.2.0-beta.7 refuses on every parse (platform#5197: now `findBy` / `where`).
 * This test is about the rules, not references, so every `refersTo` and `ownerRefersTo` is dropped
 * before parsing (the rules read properties, never a reference's target).
 *
 * TODO(contract rework): once forge-collab is registered fresh from these rules (with findBy),
 * read forge-contracts/contracts/forge-collab.json instead of the fixture, keep its references,
 * and delete the fixture.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

type Evo = typeof import('@dashevo/evo-sdk')

// Any valid identifiers: the parse checks shapes, not that they exist on a network.
const FORGE_CORE = 'A2KL77ngVM1ft1t1em2XKt1rWCBZANdAJMyfWrDGCcd1'
const CONTRACT_ID = 'C1zHeeG7EUudXdB5ZyDQnXVU35hrCfvd1fRCybXEqaPS'
const OWNER = 'E24SPCssqYzFQmjcQ1hNmiLXrzz1o9AqTv54tuWNkgHz'
const REPO = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'

/** `value` with every `refersTo` and `ownerRefersTo` declaration removed (see the header). */
function withoutReferences(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutReferences)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'refersTo' && k !== 'ownerRefersTo').map(([k, v]) => [k, withoutReferences(v)]))
}

function fixture(): Record<string, unknown> {
  const text = readFileSync(resolve(__dirname, 'fixtures', 'forge-collab-state-counts.json'), 'utf8')
  const json = withoutReferences(JSON.parse(text.split('FORGE_CORE_CONTRACT_ID').join(FORGE_CORE))) as Record<string, unknown>
  return { ...json, id: CONTRACT_ID, ownerId: OWNER }
}

describe('wasm-sdk 4.2.0-beta.6 contract rules', () => {
  let evo: Evo
  let contract: InstanceType<Evo['DataContract']>
  beforeAll(async () => {
    evo = await import('@dashevo/evo-sdk')
    await evo.EvoSDK.getLatestVersionNumber()
    contract = evo.DataContract.fromJSON(fixture() as Parameters<Evo['DataContract']['fromJSON']>[0], true, 14)
  })

  it('the fixture uses the beta.6-only keywords', () => {
    const text = JSON.stringify(fixture())
    for (const keyword of ['"countOf"', '"sumOf"', '"ifThen"', '"notIn"', '"$ownerId"', '"$createdAtBlockHeight"']) expect(text).toContain(keyword)
  })

  it('parses a contract whose rules read totals, conditionals and system heights', () => {
    const dense = contract.documentTypePropertyConstraints('issue').find((r) => r.name === 'dense')
    expect(dense?.readsTotals.map((t) => t.kind)).toEqual(['countOf', 'countOf'])
    expect(dense?.readsSystem).toContain('$createdAtBlockHeight')
    const transition = contract.documentTypePropertyConstraints('transition')
    expect(transition.flatMap((r) => r.readsTotals.map((t) => t.kind))).toContain('sumOf')
    expect(JSON.stringify(contract.documentTypePropertyConstraints('event').map((r) => r.rule))).toContain('notIn')
  })

  it('judges a document against a beta.6 rule locally (checkDocumentPropertyConstraints)', () => {
    const event = (kind: number) =>
      new evo.Document({
        documentTypeName: 'event',
        dataContractId: CONTRACT_ID,
        ownerId: OWNER,
        properties: { repoId: REPO, targetId: REPO, targetNumber: 1, kind, value: 'triaged' },
      })
    // `noState`: { notIn: ['kind', [9, 10]] } (draft and ready are author events, never member ones).
    const broken = contract.checkDocumentPropertyConstraints(event(9))
    expect(broken?.rule).toBe('noState')
    expect(broken?.violation).toBe('NotMet')
    expect(contract.checkDocumentPropertyConstraints(event(4))).toBeUndefined()
  })
})
