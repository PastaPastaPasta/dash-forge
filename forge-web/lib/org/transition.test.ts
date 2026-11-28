import { beforeAll, describe, expect, it } from 'vitest'

import { base58Encode, decodeIdentifier } from '../auth/base58'
import { DEPLOYMENTS, forgeV2Ids, type ForgeIds } from '../deployments'
import { firstConfigData, membershipData, repoCreateData } from '../repo/writes'
import type { RepoRef } from '../repo/contract'
import { contractOf } from '../repo/source'
import { describeTransition, type DescribeNames } from './describe'
import { buildUnsigned, decodeUnsigned, intentFor, nonceProblem, reviewDecoded, signedTransition, type WriteSpec } from './transition'
import { hex } from './util'

const forge = forgeV2Ids(DEPLOYMENTS['testnet']) as ForgeIds
const ORG = base58Encode(new Uint8Array(32).fill(3))
const ALICE = base58Encode(new Uint8Array(32).fill(5))
const REPO_ID = base58Encode(new Uint8Array(32).fill(9))
const repo: RepoRef = { forge, repoId: REPO_ID, ownerId: ORG, name: 'widgets', visibility: 'public' }
let latest = 0
const ctx = (nonce: bigint) => ({ ownerId: ORG, keyId: 2, nonce, platformVersion: latest })
const review = { orgId: ORG, keyId: 2, forge, currentNonce: () => 4n }
const names: DescribeNames = { org: 'acme', orgId: ORG, person: (id) => (id === ALICE ? 'alice.dash' : id), repo: (id) => (id === REPO_ID ? 'acme/widgets' : null) }

beforeAll(async () => {
  const evo = await import('@dashevo/evo-sdk')
  latest = await evo.EvoSDK.getLatestVersionNumber()
})

describe('organization transitions', () => {
  const specs: [string, WriteSpec, RegExp][] = [
    ['repo create', { action: 'create', contractId: forge.core, documentType: 'repo', data: repoCreateData('widgets', { name: 'widgets', description: 'd' }, 'public') }, /^Create the repository acme\/widgets$/],
    ['owner maintainer', { action: 'create', contractId: forge.core, documentType: 'maintainer', data: membershipData(repo, ORG) }, /Make the organization the maintainer of acme\/widgets/],
    ['config', { action: 'create', contractId: forge.core, documentType: 'config', data: firstConfigData(decodeIdentifier(REPO_ID), 'public', { name: 'widgets', protect: true }) }, /Set up acme\/widgets with default branch main, protected/],
    ['grant', { action: 'create', contractId: forge.core, documentType: 'writer', data: membershipData(repo, ALICE, { role: 2 }) }, /Give alice\.dash Triage access to acme\/widgets/],
    ['revoke', { action: 'delete', contractId: forge.core, documentType: 'maintainer', documentId: base58Encode(new Uint8Array(32).fill(1)) }, /Remove alice\.dash's Maintain access to acme\/widgets/],
    ['listing', { action: 'replace', contractId: forge.core, documentType: 'repo', documentId: REPO_ID, revision: 2n, data: { name: 'widgets', visibility: 'public', description: 'new words' } }, /Edit the listing of acme\/widgets: set the description to “new words”, set the visibility to “public”$/],
    ['topic', { action: 'create', contractId: contractOf(forge, 'topic'), documentType: 'topic', data: { repoId: decodeIdentifier(REPO_ID), name: 'rust' } }, /Add the topic “rust” to acme\/widgets/],
  ]

  for (const [label, spec, sentence] of specs) {
    it(`${label}: builds, round-trips, passes review and is described from the bytes`, async () => {
      const built = await buildUnsigned(spec, ctx(5n))
      const d = await decodeUnsigned(built.unsigned)
      expect(d.canonical).toBe(true)
      expect(d.ownerId).toBe(ORG)
      expect(d.signaturePublicKeyId).toBe(2)
      expect(d.nonce).toBe(5n)
      expect(d.action).toBe(spec.action)
      expect(d.documentType).toBe(spec.documentType)
      expect(d.contractId).toBe(spec.contractId)
      expect(d.documentId).toBe(built.documentId)
      expect(d.signable).toBe(built.signable)
      expect(reviewDecoded(d, built, review)).toEqual([])
      const stored = spec.action === 'delete' ? { repoId: decodeIdentifier(REPO_ID), memberId: decodeIdentifier(ALICE) } : spec.action === 'replace' ? { name: 'widgets', visibility: 'private', description: 'old' } : null
      expect(describeTransition(d, { ...names, stored })).toMatch(sentence)
      if (spec.action === 'create') {
        const plain = (v: unknown): string => JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? hex(x) : typeof x === 'bigint' ? Number(x) : x))
        for (const [k, v] of Object.entries(spec.data)) expect(plain(d.data[k])).toBe(plain(v))
      }
      if (spec.action === 'replace') expect(d.revision).toBe(3n)
      const intent = intentFor(spec, built, { ownerId: ORG, nonce: 5n, signer: { keyId: 2, cid: 'c'.repeat(64), slot: 'high' } })
      expect(JSON.stringify(intent)).not.toContain('Uint8Array')

      const signed = await signedTransition(built.unsigned, 'ab'.repeat(96))
      expect(hex(signed.getSignableBytes())).toBe(built.signable)
      expect(hex(signed.signature as Uint8Array)).toBe('ab'.repeat(96))
    })
  }

  it('creates derive their id from entropy and nonce', async () => {
    const spec = specs[0]![1]
    const entropy = new Uint8Array(32).fill(4)
    const a = await buildUnsigned(spec, { ...ctx(5n), entropy })
    const b = await buildUnsigned(spec, { ...ctx(5n), entropy })
    const c = await buildUnsigned(spec, { ...ctx(6n), entropy })
    expect(a.unsigned).toBe(b.unsigned)
    expect(c.documentId).not.toBe(a.documentId)
  })

  it('review refuses another owner, contract, key, nonce, type or signable', async () => {
    const grant = specs[3]![1]
    const built = await buildUnsigned(grant, ctx(5n))
    const d = await decodeUnsigned(built.unsigned)
    expect(reviewDecoded(d, built, { ...review, orgId: ALICE }).join()).toMatch(/writes as another identity, not the organization/)
    expect(reviewDecoded(d, built, { ...review, keyId: 1 }).join()).toMatch(/group key/)
    expect(reviewDecoded(d, built, { ...review, currentNonce: () => 5n })).toEqual([])
    expect(nonceProblem(d, 5n)).toMatch(/overtaken: its nonce is already used/)
    expect(nonceProblem(d, 6n | (1n << 40n))).toBeNull()
    expect(nonceProblem(d, 6n)).toMatch(/overtaken: its nonce is already used/)
    expect(nonceProblem(d, 0n)).toBeNull()
    const far = await decodeUnsigned((await buildUnsigned(grant, ctx(26n))).unsigned)
    expect(nonceProblem(far, 2n)).toBeNull()
    expect(nonceProblem(far, 1n)).toMatch(/further ahead than Platform accepts/)
    expect(reviewDecoded(d, { signable: '00' }, review).join()).toMatch(/bytes to sign/)

    const foreign = await buildUnsigned({ ...grant, contractId: base58Encode(new Uint8Array(32).fill(8)) } as WriteSpec, ctx(5n))
    expect(reviewDecoded(await decodeUnsigned(foreign.unsigned), foreign, review).join()).toMatch(/not this network's Forge/)

    const issue = await buildUnsigned({ action: 'create', contractId: forge.collab, documentType: 'issue', data: { repoId: decodeIdentifier(REPO_ID), title: 'x' } }, ctx(5n))
    const di = await decodeUnsigned(issue.unsigned)
    expect(reviewDecoded(di, issue, review).join()).toMatch(/does not sign this kind of write/)
    expect(describeTransition(di, names)).toMatch(/Unrecognised action/)

    const del = await buildUnsigned({ action: 'delete', contractId: forge.core, documentType: 'repo', documentId: REPO_ID }, ctx(5n))
    expect(reviewDecoded(await decodeUnsigned(del.unsigned), del, review).join()).toMatch(/does not sign this kind of write/)
  })

  it('review refuses a fee increase, a padded transition and a non-document transition', async () => {
    const m = await import('@dashevo/evo-sdk')
    const built = await buildUnsigned(specs[3]![1], ctx(5n))
    const st = m.StateTransition.fromBytes(Uint8Array.from(Buffer.from(built.unsigned, 'hex')))
    st.userFeeIncrease = 7
    const feeHex = hex(st.toBytes())
    const fee = await decodeUnsigned(feeHex)
    expect(reviewDecoded(fee, { signable: fee.signable }, review).join()).toMatch(/raises the fee/)

    const padded = await decodeUnsigned(`${built.unsigned}00`)
    expect(reviewDecoded(padded, built, review).join()).toMatch(/re-encode/)

    const transfer = m.IdentityCreditTransfer.fromObject({ $formatVersion: '0', identityId: ORG, recipientId: ALICE, amount: 5n, nonce: 1n, userFeeIncrease: 0, signaturePublicKeyId: 2, signature: new Uint8Array() } as never).toStateTransition()
    const t = await decodeUnsigned(hex(transfer.toBytes()))
    expect(reviewDecoded(t, { signable: '' }, review)).toEqual(['it is not exactly one document write'])
  })
})
