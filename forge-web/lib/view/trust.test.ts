/**
 * Trust-state derivation: the Verification card may only claim what a check established.
 *
 * Pins roadmap invariant 4 at the unit level: no row reads Verified unless its check ran and
 * passed, a failed check wins the headline, the chain row is only green when two independent
 * quorum-key sources agreed, and the copy names the active network and its endpoints.
 */

import { describe, expect, it } from 'vitest'

import { IPFS_GATEWAYS, NETWORKS, QUORUM_KEY_ENDPOINT } from '../constants'
import type { RefState } from '../rules'
import { NO_CONTENT_CHECKS, type ContentChecks } from './content-checks'
import type { QuorumCrossCheck } from './quorum-check'
import { connectionTrust, deriveConnectionTrust, deriveTrust, failedRows, TRUST_LABEL, worstOf, type TrustInputs } from './trust'

const NOW = Date.now()
const RESOLVED: RefState = { state: 'resolved', oid: '8f3e2a1'.padEnd(40, '0'), author: 'alice'.padEnd(44, 'x'), createdAt: NOW - 2 * 3600_000 }
const DIVERGED: RefState = {
  state: 'diverged',
  heads: [
    { id: 'a', oid: 'aa'.repeat(20), author: 'p1', createdAt: 1 },
    { id: 'b', oid: 'bb'.repeat(20), author: 'p2', createdAt: 2 },
  ],
}
const AGREED: QuorumCrossCheck = { state: 'agreed', primary: 'quorums.testnet.networks.dash.org', secondary: '1.2.3.4:1443', overlap: 4 }

function checks(over: Partial<ContentChecks> = {}): ContentChecks {
  return { ...NO_CONTENT_CHECKS, ...over }
}

function inputs(over: Partial<TrustInputs> = {}): TrustInputs {
  return {
    network: 'testnet',
    connection: 'trusted',
    quorum: AGREED,
    refName: 'main',
    tip: RESOLVED,
    checks: NO_CONTENT_CHECKS,
    configuredBackend: 'platform',
    ...over,
  }
}

describe('connectionTrust', () => {
  it('is connecting until ready, then follows the trusted flag', () => {
    expect(connectionTrust(false, true)).toBe('connecting')
    expect(connectionTrust(true, true)).toBe('trusted')
    expect(connectionTrust(true, false)).toBe('untrusted')
  })
})

describe('plain-language states', () => {
  it('uses the five words of the spec', () => {
    expect(Object.values(TRUST_LABEL)).toEqual(['Verified', 'Partly verified', "Couldn't verify", 'Not checked yet', 'Failed'])
  })
})

describe('chain data row (quorum-key cross-check)', () => {
  it('reads Checking… and is never green before the proof and the comparison arrive', () => {
    const connecting = deriveTrust(inputs({ connection: 'connecting' }))
    expect(connecting.chain.state).toBe('pending')
    expect(connecting.overall).toBe('pending')
    expect(connecting.summary).toBe('Checking…')
    const comparing = deriveTrust(inputs({ quorum: undefined }))
    expect(comparing.chain.checking).toBe(true)
    expect(comparing.summary).toBe('Checking…')
  })

  it('is Verified only when both key sources agreed, and says it re-fetched', () => {
    const r = deriveTrust(inputs())
    expect(r.chain.state).toBe('verified')
    expect(r.chain.detail).toBe('Refs, issues and members were proven against Dash testnet.')
    expect(r.chain.note).toMatch(/quorums\.testnet\.networks\.dash\.org and 1\.2\.3\.4:1443 .*both agreed/)
    expect(r.chain.note).toMatch(/fetched the key list again/)
  })

  it('is Partly verified with one key source', () => {
    const none = deriveTrust(inputs({ quorum: { state: 'single', primary: 'q', reason: 'no-second-source' } }))
    expect(none.chain.state).toBe('partial')
    expect(none.chain.detail).toMatch(/Only one key source answered/)
    expect(none.chain.note).toMatch(/No second source is configured/)
    expect(none.overall).toBe('partial')
    const down = deriveTrust(inputs({ quorum: { state: 'single', primary: 'q', reason: 'second-unreachable' } }))
    expect(down.chain.note).toMatch(/None of the DAPI nodes/)
  })

  it('Fails, loudly, on a key mismatch', () => {
    const r = deriveTrust(inputs({ quorum: { state: 'mismatch', primary: 'q', secondary: 'd', quorums: ['ab'.repeat(32)] } }))
    expect(r.chain.state).toBe('failed')
    expect(r.overall).toBe('failed')
    expect(r.summary.startsWith('Failed')).toBe(true)
  })

  it("is Couldn't verify on a connection that does not check proofs", () => {
    const r = deriveTrust(inputs({ connection: 'untrusted' }))
    expect(r.chain.state).toBe('unverified')
    expect(r.tip.state).toBe('unverified')
    expect(r.overall).toBe('unverified')
  })
})

describe('branch tip row', () => {
  it('names the ref, the short oid, the signer and when', () => {
    const r = deriveTrust(inputs())
    expect(r.tip.state).toBe('verified')
    expect(r.tip.detail).toMatch(/^`main` = `8f3e2a1`, the latest signed update by alicexxx, 2h ago\.$/)
    expect(r.tip.heads).toHaveLength(1)
  })

  it('names the rules that folded the refs', () => {
    expect(deriveTrust(inputs()).tip.note).toMatch(/FORGE_RULES_V2/)
  })

  it('is amber for a diverged ref and carries both candidates', () => {
    const r = deriveTrust(inputs({ tip: DIVERGED }))
    expect(r.tip.state).toBe('partial')
    expect(r.tip.detail).toMatch(/2 concurrent pushes/)
    expect(r.tip.heads).toHaveLength(2)
    expect(r.overall).toBe('partial')
  })

  it('verifies the absence of a ref from the proof-checked log', () => {
    expect(deriveTrust(inputs({ tip: 'missing' })).tip.state).toBe('verified')
    expect(deriveTrust(inputs({ tip: { state: 'unborn' } })).tip.state).toBe('verified')
  })
})

describe('file contents row', () => {
  it('is Not checked yet, not Verified, before any object has been read', () => {
    const r = deriveTrust(inputs())
    expect(r.content.state).toBe('pending')
    expect(r.source.state).toBe('pending')
    // A page that only read refs is verified for what it showed.
    expect(r.overall).toBe('verified')
    expect(r.summary).toBe('Verified · refs by proof')
  })

  it('counts the objects that matched their git hash', () => {
    const r = deriveTrust(inputs({ checks: checks({ objectsVerified: 214, sources: ['pub-9a1.r2.dev'], packSources: { aa: ['pub-9a1.r2.dev'] }, viewPacks: ['aa'] }) }))
    expect(r.content.state).toBe('verified')
    expect(r.content.detail).toBe('214 of 214 objects read this session matched their git hash.')
    expect(r.summary).toBe('Verified · refs by proof · 214 objects checked this session · from pub-9a1.r2.dev')
  })

  it("names the places that served THIS view's objects, not the session's first (L-18)", () => {
    const session = { objectsVerified: 9, sources: ['platform', 'files.example'], packSources: { aa: ['platform'], bb: ['files.example'] } }
    // A file from the S3-stored pack, after the README came from Platform.
    expect(deriveTrust(inputs({ checks: checks({ ...session, viewPacks: ['bb'] }) })).summary).toBe('Verified · refs by proof · 9 objects checked this session · from files.example')
    expect(deriveTrust(inputs({ checks: checks({ ...session, viewPacks: ['aa', 'bb'] }) })).summary).toBe('Verified · refs by proof · 9 objects checked this session · from Platform, files.example')
    // A view that read no object (issues, settings) names no place.
    expect(deriveTrust(inputs({ checks: checks({ ...session, viewPacks: [] }) })).summary).toBe('Verified · refs by proof · 9 objects checked this session')
    // The row below still lists every place this session read from.
    expect(deriveTrust(inputs({ checks: checks({ ...session, viewPacks: ['bb'] }) })).source.detail).toBe('Dash Platform (permanent), files.example.')
  })

  it('counts whole-pack sha256 checks from the fallback clone', () => {
    const r = deriveTrust(inputs({ checks: checks({ packsVerified: 2, objectsVerified: 1 }) }))
    expect(r.content.state).toBe('verified')
    expect(r.content.note).toMatch(/2 packs/)
  })

  it('is Partly verified when some objects were shown without a hash check', () => {
    expect(deriveTrust(inputs({ checks: checks({ objectsVerified: 4, objectsUnchecked: 1 }) })).content.state).toBe('partial')
    expect(deriveTrust(inputs({ checks: checks({ objectsUnchecked: 2 }) })).content.state).toBe('unverified')
  })

  it('Fails, and wins the headline, when any object or pack mismatched', () => {
    const obj = deriveTrust(inputs({ checks: checks({ objectsVerified: 9, objectsFailed: 1, sources: ['ipfs.io'] }) }))
    expect(obj.content.state).toBe('failed')
    expect(obj.content.detail).toMatch(/1 of 10 objects did not match/)
    expect(obj.source.state).toBe('failed') // a source is only as good as what it served
    expect(obj.overall).toBe('failed')
    const pack = deriveTrust(inputs({ checks: checks({ packsFailed: 1 }) }))
    expect(pack.content.detail).toMatch(/1 pack did not match its manifest/)
  })

  it('is Partly verified, never Verified, when a live pack could not be fetched', () => {
    const read = deriveTrust(inputs({ checks: checks({ objectsVerified: 5, packsVerified: 3, unavailablePacks: ['ab'.repeat(32)] }) }))
    expect(read.content.state).toBe('partial')
    expect(read.content.detail).toMatch(/1 pack could not be fetched from its storage, so some files may be missing/)
    const none = deriveTrust(inputs({ checks: checks({ unavailablePacks: ['ab'.repeat(32), 'cd'.repeat(32)] }) }))
    expect(none.content.state).toBe('partial')
    const bad = deriveTrust(inputs({ checks: checks({ objectsFailed: 1, unavailablePacks: ['ab'.repeat(32)] }) }))
    expect(bad.content.state).toBe('failed')
  })
})

describe('where the bytes came from row', () => {
  it('names each source, and recorded places not tried', () => {
    const r = deriveTrust(
      inputs({
        checks: checks({ objectsVerified: 1, sources: ['pub-9a1.r2.dev'] }),
        configuredUris: ['https://pub-9a1.r2.dev/forge', 'ipfs://bafy'],
      }),
    )
    expect(r.source.detail).toBe('pub-9a1.r2.dev. Also recorded: ipfs (not tried).')
    expect(deriveTrust(inputs({ checks: checks({ objectsVerified: 1, sources: ['platform'] }) })).source.detail).toBe(
      'Dash Platform (permanent).',
    )
  })

  it('counts bytes from an IPFS gateway as ipfs tried', () => {
    const gw = new URL(IPFS_GATEWAYS[0] as string).host
    const r = deriveTrust(inputs({ checks: checks({ objectsVerified: 1, sources: [gw] }), configuredUris: ['ipfs://bafy'] }))
    expect(r.source.detail).toBe(`${gw}.`)
  })

  it('reads Failed with the list of places when no storage answered', () => {
    const r = deriveTrust(inputs({ checks: checks({ unreachable: ['pub-9a1.r2.dev (timed out)', 'ipfs (not found on 3 gateways)'] }) }))
    expect(r.source.state).toBe('failed')
    expect(r.source.detail).toBe("No storage answered. Didn't answer: pub-9a1.r2.dev (timed out), ipfs (not found on 3 gateways).")
  })
})

describe('trust-anchor disclosure', () => {
  it('names the active network and its quorum endpoint', () => {
    for (const network of ['testnet', 'mainnet'] as const) {
      const r = deriveTrust(inputs({ network, quorum: undefined }))
      expect(r.quorumEndpoint).toBe(QUORUM_KEY_ENDPOINT[network])
      expect(r.chain.detail).toContain(network)
      expect(r.chain.note).toContain(new URL(QUORUM_KEY_ENDPOINT[network]).host)
    }
    expect(deriveTrust(inputs({ network: 'mainnet', quorum: undefined })).chain.detail).not.toContain('testnet')
  })

  it('names the network by its key in copy', () => {
    expect(deriveTrust(inputs({ network: 'testnet' })).networkLabel).toBe('testnet')
    expect(deriveConnectionTrust('devnet', 'connecting').detail).toContain(NETWORKS.devnet.key)
  })

  it('the landing-page connection row follows the same rules', () => {
    expect(deriveConnectionTrust('mainnet', 'trusted', AGREED).state).toBe('verified')
    expect(deriveConnectionTrust('mainnet', 'trusted').state).toBe('pending')
    expect(deriveConnectionTrust('testnet', 'untrusted').state).toBe('unverified')
  })
})

describe('worstOf', () => {
  it('ranks failed > unverified > partial > verified > pending', () => {
    expect(worstOf(['verified', 'failed', 'partial'])).toBe('failed')
    expect(worstOf(['verified', 'unverified', 'partial'])).toBe('unverified')
    expect(worstOf(['pending', 'verified'])).toBe('verified')
    expect(worstOf([])).toBe('pending')
  })
})

describe('Platform unreachable after a connect (M4)', () => {
  it('the SDK flags map to offline while the service reports an error', () => {
    expect(connectionTrust(true, true, true)).toBe('offline')
    expect(connectionTrust(false, true, true)).toBe('connecting')
    expect(connectionTrust(true, true, false)).toBe('trusted')
  })

  it('the card never says Verified next to content that is not being re-checked', () => {
    const r = deriveTrust(inputs({ connection: 'offline', quorum: AGREED }))
    expect(r.chain.state).toBe('partial')
    expect(r.tip.state).not.toBe('verified')
    expect(r.overall).not.toBe('verified')
    expect(r.summary).not.toMatch(/^Verified/)
    expect(r.summary).toContain('Not re-checked')
    expect(r.chain.detail).toMatch(/not being re-checked/)
  })

  it('the landing chip is degraded, not verified', () => {
    expect(deriveConnectionTrust('devnet', 'offline', AGREED).state).toBe('partial')
  })
})

describe('offline never hides a known failure', () => {
  it('a quorum-key mismatch stays Failed while Platform is unreachable', () => {
    const mismatch: QuorumCrossCheck = { state: 'mismatch', primary: 'q', secondary: 'd', quorums: ['00ab'] }
    const r = deriveTrust(inputs({ connection: 'offline', quorum: mismatch }))
    expect(r.chain.state).toBe('failed')
    expect(r.overall).toBe('failed')
    expect(r.summary).toMatch(/^Failed · Not re-checked/)
  })
})

describe('the offline summary names the overall state', () => {
  it('keeps "Couldn\'t verify" for unverified content', () => {
    const r = deriveTrust(inputs({ connection: 'offline', quorum: AGREED, checks: { ...NO_CONTENT_CHECKS, objectsUnchecked: 3 } }))
    expect(r.overall).toBe('unverified')
    expect(r.summary).toBe(`${TRUST_LABEL[r.overall]} · Not re-checked · Platform unreachable`)
    const clean = deriveTrust(inputs({ connection: 'offline', quorum: AGREED }))
    expect(clean.summary).toBe('Partly verified · Not re-checked · Platform unreachable')
  })
})

describe('a quorum-key mismatch leaves nothing verified that relied on it (QW-009)', () => {
  const MISMATCH: QuorumCrossCheck = { state: 'mismatch', primary: 'q', secondary: 'd', quorums: ['5e5397c17bb1'.padEnd(64, '0')] }

  it("the branch tip reads Couldn't verify, not Verified, under a Failed chain row", () => {
    const r = deriveTrust(inputs({ quorum: MISMATCH }))
    expect(r.chain.state).toBe('failed')
    expect(r.tip.state).toBe('unverified')
    expect(r.tip.note).toMatch(/quorum keys that a second source disputes/)
    // The facts stay on the card; only the claim about them changes.
    expect(r.tip.heads).toHaveLength(1)
  })

  it('a diverged tip is not Partly verified on disputed keys either, nor while offline', () => {
    expect(deriveTrust(inputs({ quorum: MISMATCH, tip: DIVERGED })).tip.state).toBe('unverified')
    expect(deriveTrust(inputs({ quorum: MISMATCH, connection: 'offline' })).tip.state).toBe('unverified')
  })

  it('file hashes still stand: an object matched its git id whatever the keys', () => {
    const r = deriveTrust(inputs({ quorum: MISMATCH, checks: checks({ objectsVerified: 3 }) }))
    expect(r.content.state).toBe('verified')
    expect(r.overall).toBe('failed')
  })

  it('a commit pinned by id relies on no ref, so its row is unchanged', () => {
    const r = deriveTrust(inputs({ quorum: MISMATCH, tip: { pinned: 'ab'.repeat(20) } }))
    expect(r.tip.state).toBe('partial')
  })

  it('agreed keys leave the tip Verified', () => {
    expect(deriveTrust(inputs()).tip.state).toBe('verified')
  })
})

describe('failedRows: what the failure banner lists (QW-004)', () => {
  it('lists each Failed row in card order, with its title and sentence', () => {
    const r = deriveTrust(
      inputs({
        quorum: { state: 'mismatch', primary: 'q', secondary: 'd', quorums: ['00ab'] },
        checks: checks({ objectsFailed: 1, objectsVerified: 2 }),
      }),
    )
    const rows = failedRows(r)
    expect(rows.map((f) => f.row)).toEqual(['chain', 'content'])
    expect(rows[0]).toMatchObject({ title: 'Chain data', detail: r.chain.detail, note: r.chain.note })
    expect(rows[1]).toMatchObject({ title: 'File contents', detail: r.content.detail })
    expect(rows[1]).not.toHaveProperty('note')
  })

  it('limits to the rows a surface owns', () => {
    const r = deriveTrust(inputs({ quorum: { state: 'mismatch', primary: 'q', secondary: 'd', quorums: ['00ab'] } }))
    expect(failedRows(r).map((f) => f.row)).toEqual(['chain'])
    expect(failedRows(r, ['tip', 'content', 'source'])).toEqual([])
  })

  it('is empty when nothing failed: a partial or unverified row is not a failure banner', () => {
    expect(failedRows(deriveTrust(inputs()))).toEqual([])
    expect(failedRows(deriveTrust(inputs({ connection: 'untrusted' })))).toEqual([])
    expect(failedRows(deriveTrust(inputs({ quorum: { state: 'single', primary: 'q', reason: 'no-second-source' } })))).toEqual([])
  })
})
