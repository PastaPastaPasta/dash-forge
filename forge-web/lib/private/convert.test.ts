/**
 * A repository made public's readers (`private-repos.md` §18) beyond the `converted_repo_*`
 * vectors: the bundle codec's refusals, and the published keys added to a reader's resolution
 * with the chains they reach (forge-core `EpochResolution::add_published`).
 */

import { describe, expect, it } from 'vitest'

import { BUNDLE_ENTRY_LEN, BUNDLE_HEADER_LEN, ENTRY_EPOCH_KEY, MAX_BUNDLE_NOTE, encodeBundle, parseBundle, type BundleEntry } from './bundle'
import { conversionOf, maybeSealed, publishedKeys, type ConfigStamp } from './convert'
import { sealDoc } from './doc'
import { addPublished, resolveEpochs, type ConfigRow } from './epoch'
import { EpochKeys } from './keys'
import { MalformedError } from './tlv'

const REPO_ID = new Uint8Array(32).fill(0x11)
const OWNER = new Uint8Array(32).fill(0xa1)
const OTHER = new Uint8Array(32).fill(0xb2)
const key = (b: number) => new Uint8Array(32).fill(b)
const entry = (revision: number, k = key(revision + 1), kind = ENTRY_EPOCH_KEY): BundleEntry => ({ kind, target: REPO_ID, revision, key: k })

describe('make-public bundles', () => {
  it('round-trip, and refuse what does not fit', () => {
    const entries = [entry(0), entry(1)]
    const bytes = encodeBundle(entries, 'made public')
    expect(bytes.length).toBe(BUNDLE_HEADER_LEN + 2 * BUNDLE_ENTRY_LEN + 11)
    expect(parseBundle(bytes)).toEqual({ entries, note: 'made public' })
    // a count past the bytes, another version, a note that is not UTF-8, a bare magic
    const short = bytes.slice(0, BUNDLE_HEADER_LEN + 2 * BUNDLE_ENTRY_LEN)
    short[6] = 3
    expect(() => parseBundle(short)).toThrow(MalformedError)
    const v2 = bytes.slice()
    v2[4] = 2
    expect(() => parseBundle(v2)).toThrow(MalformedError)
    expect(() => parseBundle(new Uint8Array([...bytes, 0xff]))).toThrow(MalformedError)
    expect(() => parseBundle(new TextEncoder().encode('DFRV'))).toThrow(MalformedError)
    expect(() => encodeBundle([], 'x'.repeat(MAX_BUNDLE_NOTE + 1))).toThrow(MalformedError)
  })
})

describe('conversion facts', () => {
  const stamp = (id: number, epoch: number | null, priv: boolean, height: number): ConfigStamp => ({ id: key(id), epoch, private: priv, height })

  it('come from the config timeline', () => {
    const configs = [stamp(1, 0, true, 10), stamp(2, 1, true, 20), stamp(3, 2, true, 30), stamp(4, null, false, 40), stamp(5, 3, false, 50), stamp(6, 9, true, 25)]
    const c = conversionOf(true, configs, (e) => e <= 3)
    expect(c).toEqual({ sealOffEpoch: 2, markerHeight: 40 })
    expect([40, 0, 41].map((h) => maybeSealed(c!, h))).toEqual([true, true, false])
    expect(conversionOf(false, configs, () => true)).toBeNull()
    expect(conversionOf(true, configs.slice(3, 5), () => true)).toBeNull()
    expect(maybeSealed(conversionOf(true, configs.slice(0, 3), () => true)!, Number.MAX_SAFE_INTEGER)).toBe(true)
  })
})

describe('published keys', () => {
  /** Epochs 0–2 anchored by the owner, each anchor above 0 chaining to the one below. */
  async function chain(): Promise<ConfigRow[]> {
    const rows: ConfigRow[] = []
    for (const e of [0, 1, 2]) {
      const keys = await EpochKeys.import(REPO_ID, e, key(e + 1))
      const fields = e === 0 ? { defaultBranch: 'refs/heads/main' } : { defaultBranch: 'refs/heads/main', prevEpoch: e - 1, prevEpochKey: key(e) }
      const enc = await sealDoc(keys, { type: 'config', ownerId: OWNER, epoch: e }, fields, { anchor: true })
      rows.push({ id: key(0x40 + e), owner: OWNER, epoch: e, createdAtBlockHeight: 10 * (e + 1), enc })
    }
    return rows
  }

  it('open what the owner published and every epoch its chain reaches; a key that does not match is an alert', async () => {
    const configs = await chain()
    // an outsider: no key share, so nothing opens yet
    const r = await resolveEpochs({ repoId: REPO_ID, reader: OTHER, memberships: [{ identity: OWNER, role: 'maintainer' }], configs, wraps: [] })
    expect(r.keys.size).toBe(0)
    const conversion = { sealOffEpoch: 2, markerHeight: 40 }
    const bundles = [
      { owner: OWNER, bytes: encodeBundle([entry(1), entry(0, key(9))], '') },
      // someone else's bundle never counts, nor the seal-off epoch itself
      { owner: OTHER, bytes: encodeBundle([entry(0)], '') },
      { owner: OWNER, bytes: encodeBundle([entry(2)], '') },
    ]
    const { keys, alerts } = await publishedKeys(REPO_ID, OWNER, conversion, r.anchors, bundles)
    expect([...keys.keys()]).toEqual([1])
    expect(alerts).toEqual([{ kind: 'publishedKeyMismatch', epoch: 0, author: OWNER }])
    const out = await addPublished(r, REPO_ID, keys, alerts)
    expect([...out.keys.keys()].sort()).toEqual([0, 1])
    expect(out.writeEpoch).toBeNull()
    expect(out.alerts).toEqual(alerts)
    // nothing published: the resolution as it was
    expect(await addPublished(r, REPO_ID, new Map(), [])).toBe(r)
  })
})
