import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { refreshSpecKeys } from '../e2e/global-setup'

describe('fresh browser keys for a run', () => {
  it("moves aside the saved vaults of the spec's own identities only, keeping them", () => {
    const root = mkdtempSync(join(tmpdir(), 'e2e-keys-'))
    const ids = join(root, 'ids')
    const auth = join(root, 'auth')
    mkdirSync(ids)
    mkdirSync(auth)
    writeFileSync(join(ids, 'OWNER.identity.json'), JSON.stringify({ identityId: '2QAEbMtEUQJGra1Fv3XKH72VHSfhpME3vEBFS8sHNTwj' }))
    writeFileSync(join(ids, 'CONTRIB.identity.json'), JSON.stringify({ identityId: '5CohEnpoSWodj8h6u33hBeF2HjAGANFwSa1bjX1NUACM' }))
    for (const f of ['devnet-moutai-OWNER-2QAEbMtE.json', 'devnet-moutai-CONTRIB-5CohEnpo.json', 'devnet-moutai-OWNER.json', 'devnet-moutai-OWNER-38gnpSrk.json']) writeFileSync(join(auth, f), '{}')
    const moved = refreshSpecKeys(auth, ids, 'moutai', 42)
    expect(moved.sort()).toEqual(['devnet-moutai-CONTRIB-5CohEnpo.json', 'devnet-moutai-OWNER-2QAEbMtE.json'])
    // A fixture identity's vault, and another identity set's, stay.
    expect(readdirSync(auth).filter((f) => f.endsWith('.json')).sort()).toEqual(['devnet-moutai-OWNER-38gnpSrk.json', 'devnet-moutai-OWNER.json'])
    expect(readdirSync(join(auth, 'retired', '42')).sort()).toEqual(moved.sort())
  })

  it('does nothing without a spec identity dir (read-only runs, fixture identities)', () => {
    const auth = mkdtempSync(join(tmpdir(), 'e2e-keys-'))
    writeFileSync(join(auth, 'devnet-moutai-OWNER.json'), '{}')
    expect(refreshSpecKeys(auth, '', 'moutai')).toEqual([])
    expect(readdirSync(auth)).toEqual(['devnet-moutai-OWNER.json'])
  })
})
