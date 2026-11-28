import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildUnsigned, decodeUnsigned, intentFor, reviewDecoded, signedTransition, type BuiltTransition } from '../../../forge-web/lib/org/transition'
import { FIXTURE, KEY_ID, ORG, PLATFORM_VERSIONS, SIGNER, VECTORS, forge, hexOf, readFixture, type FixtureVector } from './vectors'

const pkg = process.env['EVO_SDK_PACKAGE'] as string
const pinsOld = pkg === 'evo-sdk-503'
const sdkVersion = (JSON.parse(readFileSync(fileURLToPath(new URL(`../node_modules/${pkg}/package.json`, import.meta.url)), 'utf8')) as { version: string }).version
const update = process.env['UPDATE_VECTORS'] === '1' && !pinsOld
const fixture = update ? null : readFixture()
const written: FixtureVector[] = []

const build = (i: number, platformVersion: number): Promise<BuiltTransition> => {
  const v = VECTORS[i]!
  return buildUnsigned(v.spec, { ownerId: ORG, keyId: KEY_ID, nonce: v.nonce, platformVersion, ...(v.entropy ? { entropy: v.entropy } : {}) })
}

let known: number[] = []

beforeAll(async () => {
  const m = await import('@dashevo/evo-sdk')
  const latest = await m.EvoSDK.getLatestVersionNumber()
  known = PLATFORM_VERSIONS.filter((pv) => pv <= latest)
})

describe(`forge-web's organization builder on evo-sdk ${sdkVersion}`, () => {
  it('loads the SDK this project names, which knows the protocols it should', async () => {
    expect(sdkVersion === '5.0.3').toBe(pinsOld)
    expect(known).toEqual(pinsOld ? [14] : PLATFORM_VERSIONS)
  })

  VECTORS.forEach((v, i) => {
    it(`${v.label}: the same bytes at every protocol the SDK knows, and they pass review`, async () => {
      const [first, ...rest] = await Promise.all(known.map((pv) => build(i, pv)))
      for (const other of rest) expect(other).toEqual(first)
      const built = first!
      if (pinsOld) {
        const at15 = build(i, 15)
        if (v.spec.action === 'create') await expect(at15).rejects.toThrow(/unknown platform version: 15/)
        else expect(await at15).toEqual(built)
      }
      const intent = intentFor(v.spec, built, { ownerId: ORG, nonce: v.nonce, signer: SIGNER })
      const got: FixtureVector = { label: v.label, intent, derived: { documentId: built.documentId }, unsigned: built.unsigned, signable: built.signable }
      if (update) {
        written[i] = got
      } else {
        const want = fixture!.vectors[i]!
        expect(want.label).toBe(v.label)
        expect(got.unsigned).toBe(want.unsigned)
        expect(got.signable).toBe(want.signable)
        expect(got.derived).toEqual(want.derived)
        expect(JSON.parse(JSON.stringify(got.intent))).toEqual(want.intent)
      }
      const d = await decodeUnsigned(built.unsigned)
      expect(d.canonical).toBe(true)
      expect(reviewDecoded(d, built, { orgId: ORG, keyId: KEY_ID, forge, currentNonce: () => v.nonce - 1n })).toEqual([])
      const signed = await signedTransition(built.unsigned, 'ab'.repeat(96))
      expect(hexOf(signed.getSignableBytes())).toBe(built.signable)
    })
  })

  afterAll(() => {
    if (!update || written.filter(Boolean).length !== VECTORS.length) return
    const previous = (() => {
      try {
        return readFixture()
      } catch {
        return null
      }
    })()
    const vectors = written.map((v, i) => {
      const was = previous?.vectors[i]
      const dtiReview = was?.label === v.label && was.unsigned === v.unsigned && was.signable === v.signable ? was.dtiReview : undefined
      return dtiReview ? { ...v, dtiReview } : v
    })
    const out = {
      about:
        "Organization transitions for every request type Forge makes (docs/design/organizations.md §9). tools/org-vectors builds them with forge-web's builder under evo-sdk 5.0.3 and under Forge's pin, and both must give these bytes; forge-core's org tests rebuild them byte for byte; dtiReview records what dash-threshold-identity's `dti review` rebuild from the intent says (tools/org-vectors/cross-sdk/dti-review.mjs).",
      platformVersions: PLATFORM_VERSIONS,
      sdks: ['5.0.3', sdkVersion],
      dtiReview: previous?.dtiReview ?? {},
      vectors,
    }
    writeFileSync(FIXTURE, `${JSON.stringify(out, null, 2)}\n`)
  })
})
