/**
 * The decisions "Make this repo public" shares with `dg repo make-public` (mixed-visibility DESIGN
 * §4.10; `crates/dg/src/repo_make_public.rs`): Code only's refs, what is still to publish, the gate
 * before anything is signed, the estimate, and the run's local record.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { resetMemoryStores } from '../idb'
import { estimateChunkCredits } from '../sdk/cost'
import {
  CONFIG_ESTIMATE_CREDITS,
  FLIP_ESTIMATE_CREDITS,
  HISTORY_FIRST_EXTRA_CREDITS,
  MAKE_PUBLIC_WORDS,
  MANIFEST_FIRST_CREDITS,
  MakePublicError,
  cutoffOf,
  REF_FIRST_CREDITS,
  defaultCodeRefs,
  deleteMakePublicRecord,
  estimateMakePublic,
  gateMakePublic,
  leftOutRefs,
  loadMakePublicRecord,
  locatorBytes,
  namedCodeRefs,
  refCandidates,
  sameRefs,
  saveMakePublicRecord,
  secretsOf,
  shortRef,
  unpublishedRefs,
  type MakePublicSecret,
} from './make-public'
import { confirms } from './make-public-run'
import { idbPut } from '../idb'

const oid = (c: string): string => c.repeat(40)
const MAIN = { name: 'refs/heads/main', oid: oid('a') }
const DEV = { name: 'refs/heads/dev', oid: oid('b') }
const V1 = { name: 'refs/tags/v1', oid: oid('c') }
const V2 = { name: 'refs/tags/v2', oid: oid('d') }
const ALL = [DEV, MAIN, V1, V2]

describe('Code only refs', () => {
  it('default to the default branch and the tags on it (dg default_code_refs)', async () => {
    const onMain = new Set([oid('c')])
    const picked = await defaultCodeRefs(ALL, 'refs/heads/main', async (tag, tip) => tip === MAIN.oid && onMain.has(tag))
    expect(picked).toEqual([MAIN, V1])
    // no default branch with commits: nothing (the check then blocks Code only)
    expect(await defaultCodeRefs(ALL, 'refs/heads/trunk', async () => true)).toEqual([])
  })

  it('take a name as the branch, then the tag; a full name as itself; anything else is E102', () => {
    expect(refCandidates('v1')).toEqual(['refs/heads/v1', 'refs/tags/v1'])
    expect(refCandidates('refs/tags/v1')).toEqual(['refs/tags/v1'])
    expect(namedCodeRefs(ALL, ['dev', 'v2', 'refs/heads/main'])).toEqual([DEV, V2, MAIN])
    // a branch and a tag of one name: the branch
    const both = [...ALL, { name: 'refs/tags/dev', oid: oid('e') }]
    expect(namedCodeRefs(both, ['dev'])).toEqual([DEV])
    expect(() => namedCodeRefs(ALL, ['nope'])).toThrow(MakePublicError)
    try {
      namedCodeRefs(ALL, ['nope'])
    } catch (e) {
      expect((e as MakePublicError).code).toBe('E102')
    }
    expect(shortRef('refs/heads/a/b')).toBe('a/b')
    expect(shortRef('refs/tags/v1')).toBe('v1')
  })
})

describe('what is still to publish (dg unpublished_refs)', () => {
  it('leaves out refs public already and refs members pushed to after the flip', () => {
    const publicRefs = new Map([[MAIN.name, MAIN.oid]])
    const membersOnly = new Set([DEV.name, V1.name])
    expect(unpublishedRefs(ALL, publicRefs, membersOnly)).toEqual([V2])
    // members-only and not public: never published, and said so
    expect(leftOutRefs(ALL, publicRefs, membersOnly)).toEqual([DEV.name, V1.name])
    // a public name wins over a members-only one: published, not left out
    expect(leftOutRefs(ALL, new Map([[DEV.name, DEV.oid]]), new Set([DEV.name]))).toEqual([])
    expect(unpublishedRefs(ALL, new Map(), new Set())).toEqual(ALL)
  })
})

const secret = (place: string, fingerprint: string, refuses = true): MakePublicSecret => ({ place, rule: 'env_file', fingerprint, refuses })
const CLEAN = { codeSecrets: [], everythingSecrets: [], oldFormat: [], oldFormatUnreadable: false, unfetched: 0, missingObjects: { codeOnly: 0, everything: 0 } }

describe('the gate before anything is signed (dg gate)', () => {
  it('passes a clean check in both modes', () => {
    expect(gateMakePublic(CLEAN, 'codeOnly', [])).toBeNull()
    expect(gateMakePublic(CLEAN, 'everything', [])).toBeNull()
  })

  it('stops Everything for old-format environments (E812), one it cannot read (E812), unfetched code (E503), in that order; Code only goes on', () => {
    const all = { ...CLEAN, oldFormat: ['production'], oldFormatUnreadable: true, unfetched: 2 }
    expect(gateMakePublic(all, 'everything', [])?.code).toBe('E812')
    expect(gateMakePublic(all, 'everything', [])?.message).toContain('production')
    expect(gateMakePublic({ ...all, oldFormat: [] }, 'everything', [])?.message).toContain("can't read")
    const unfetched = gateMakePublic({ ...CLEAN, unfetched: 2 }, 'everything', [])
    expect(unfetched?.code).toBe('E503')
    expect(unfetched?.message).toContain('2 stored copies')
    expect(gateMakePublic(all, 'codeOnly', [])).toBeNull()
  })

  it("stops a mode whose branches and tags reach code this member can't read (E503), and only that mode", () => {
    const partial = { ...CLEAN, missingObjects: { codeOnly: 0, everything: 3 } }
    expect(gateMakePublic(partial, 'codeOnly', [])).toBeNull()
    expect(gateMakePublic(partial, 'everything', [])?.code).toBe('E503')
    expect(gateMakePublic({ ...CLEAN, missingObjects: { codeOnly: 1, everything: 1 } }, 'codeOnly', [])?.code).toBe('E503')
  })

  it('needs an explicit allow for each refusing secret (E807), any case; a warning never stops it', () => {
    const check = { ...CLEAN, codeSecrets: [secret('.env', 'abc123def456'), secret('notes.txt', '000000000000', false)], everythingSecrets: [secret('issue #3 body', 'feedfeedfeed')] }
    const code = gateMakePublic(check, 'codeOnly', [])
    expect(code?.code).toBe('E807')
    expect(code?.secrets?.map((s) => s.fingerprint)).toEqual(['abc123def456'])
    expect(gateMakePublic(check, 'codeOnly', ['ABC123DEF456'])).toBeNull()
    // Everything also covers the posts and every old object
    expect(gateMakePublic(check, 'everything', ['abc123def456'])?.secrets?.map((s) => s.place)).toEqual(['issue #3 body'])
    expect(gateMakePublic(check, 'everything', ['abc123def456', 'feedfeedfeed'])).toBeNull()
  })

  it('lists each (place, fingerprint) once', () => {
    const s = secret('.env', 'abc')
    expect(secretsOf({ codeSecrets: [s], everythingSecrets: [s, secret('.env', 'def')] }, 'everything')).toHaveLength(2)
    expect(secretsOf({ codeSecrets: [s], everythingSecrets: [secret('x', 'y')] }, 'codeOnly')).toEqual([s])
  })
})

describe('the estimate (dg estimate)', () => {
  const size = { bytes: 50_000, objects: 120 }
  const push = MANIFEST_FIRST_CREDITS * 2 + REF_FIRST_CREDITS * 3
  const storage = estimateChunkCredits(50_000) + estimateChunkCredits(locatorBytes(120))

  it('counts the rotation and the flip while private, the settings until they exist, and the history with Everything', () => {
    const fresh = { size, refs: 3, private: true, marked: false, rotationCredits: 300_000_000, readableEpochs: 4 }
    expect(estimateMakePublic({ ...fresh, mode: 'codeOnly' })).toEqual({ credits: push + 300_000_000 + FLIP_ESTIMATE_CREDITS + CONFIG_ESTIMATE_CREDITS, storageCredits: storage })
    const history = estimateChunkCredits(7 + 69 * 4 + 64) + MANIFEST_FIRST_CREDITS + HISTORY_FIRST_EXTRA_CREDITS
    expect(estimateMakePublic({ ...fresh, mode: 'everything' }).credits).toBe(push + 300_000_000 + FLIP_ESTIMATE_CREDITS + CONFIG_ESTIMATE_CREDITS + history)
    // made public already, settings written: the push alone (and the history)
    expect(estimateMakePublic({ ...fresh, private: false, marked: true, mode: 'codeOnly' }).credits).toBe(push)
  })
})

describe('the typed confirmation', () => {
  it('is the words as the dialog names the repo, or any owner/name of this repo', () => {
    expect(MAKE_PUBLIC_WORDS('carol/ledger')).toBe('make carol/ledger public')
    expect(confirms('make carol/ledger public', 'ledger', 'carol/ledger')).toBe(true)
    expect(confirms('make carol/ledger public ', 'ledger', 'carol/ledger')).toBe(false)
    expect(confirms('make carol/ledger public', 'ledger')).toBe(true)
    expect(confirms('make ledger public', 'ledger')).toBe(false)
    expect(confirms('make carol/other public', 'ledger')).toBe(false)
  })
})

describe("the run's local record", () => {
  beforeEach(() => resetMemoryStores())

  it('round-trips, is per network, signer and repo, and one that cannot be read is an error, never "none"', async () => {
    expect(await loadMakePublicRecord('devnet', 'S', 'R')).toBeNull()
    await saveMakePublicRecord('devnet', 'S', 'R', { mode: 'codeOnly', refs: [[MAIN.name, MAIN.oid]], sealOff: 3, startedAt: 5 })
    expect(await loadMakePublicRecord('devnet', 'S', 'R')).toEqual({ mode: 'codeOnly', refs: [[MAIN.name, MAIN.oid]], sealOff: 3, startedAt: 5 })
    expect(await loadMakePublicRecord('devnet', 'S', 'X')).toBeNull()
    expect(await loadMakePublicRecord('testnet', 'S', 'R')).toBeNull()
    // another identity signed in on this browser never continues it
    expect(await loadMakePublicRecord('devnet', 'T', 'R')).toBeNull()
    await deleteMakePublicRecord('devnet', 'S', 'R')
    expect(await loadMakePublicRecord('devnet', 'S', 'R')).toBeNull()
    // a record from before the signer was part of the key is ignored
    await idbPut('journal', 'make-public:devnet:R', { mode: 'codeOnly', refs: [], sealOff: 3, startedAt: 5 })
    expect(await loadMakePublicRecord('devnet', 'S', 'R')).toBeNull()
    await idbPut('journal', 'make-public:devnet:S:R', { mode: 'all', refs: 'x' })
    await expect(loadMakePublicRecord('devnet', 'S', 'R')).rejects.toThrow(MakePublicError)
  })
})

describe('one cutoff, and the same refs', () => {
  it('cutoffOf is the lowest seal-off epoch known, or none', () => {
    expect(cutoffOf(5, 3)).toBe(3)
    expect(cutoffOf(null, 4)).toBe(4)
    expect(cutoffOf(2, undefined)).toBe(2)
    expect(cutoffOf(null, null)).toBeUndefined()
    expect(cutoffOf(0, 2)).toBe(0)
  })

  it('sameRefs compares names and tips, in any order', () => {
    const DEV = { name: 'refs/heads/dev', oid: 'b'.repeat(40) }
    expect(sameRefs([MAIN, DEV], [DEV, { ...MAIN, oid: MAIN.oid.toUpperCase() }])).toBe(true)
    expect(sameRefs([MAIN], [MAIN, DEV])).toBe(false)
    expect(sameRefs([MAIN], [{ ...MAIN, oid: 'c'.repeat(40) }])).toBe(false)
    expect(sameRefs([MAIN], [DEV])).toBe(false)
  })
})

