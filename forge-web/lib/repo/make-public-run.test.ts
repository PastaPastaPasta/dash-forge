/**
 * The run of "Make this repo public" over a fake chain (dg `convert` with 5A's decisions): who may
 * run what, the typed words, the seal-off rotation never run twice for one run, the key read again
 * after it, the second check with Everything, the steps in order, an interrupted run continued,
 * the history left to the owner, and the history's keys taken from the anchors.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'

import { EPOCH_BUNDLE_NOTE, EpochKeys, epochKeyBundles, parseBundle, resolveEpochs, sealDoc, type ConfigRow, type Conversion } from '../private'
import { COPY, MakePublicError, type MakePublicCheck, type MakePublicProgress, type MakePublicRecord, type MakePublicRef } from './make-public'
import type { Inspection } from './make-public-check'
import type { WorkStore } from './make-public-objects'
import { rawKeysBelow, runMakePublicWith, type MakePublicChoice, type MakePublicIo } from './make-public-run'
import type { PrivateSession } from './private-session'

const OWNER = 'Owner1111111111111111111111111111111111111'
const MAINT = 'Maint1111111111111111111111111111111111111'
const MAIN: MakePublicRef = { name: 'refs/heads/main', oid: 'a'.repeat(40) }
const DEV: MakePublicRef = { name: 'refs/heads/dev', oid: 'b'.repeat(40) }

function checkOf(over: Partial<MakePublicCheck> = {}): MakePublicCheck {
  return {
    blockers: [],
    notes: [],
    allRefs: [DEV, MAIN],
    codeRefs: [MAIN],
    deleted: 0,
    forced: 0,
    census: null,
    former: [],
    codeSecrets: [],
    everythingSecrets: [],
    environments: 0,
    oldFormat: [],
    oldFormatUnreadable: false,
    unfetched: 0,
    missingObjects: { codeOnly: 0, everything: 0 },
    size: { codeOnly: { bytes: 1, objects: 1 }, everything: { bytes: 2, objects: 2 } },
    estimate: { codeOnly: { credits: 1, storageCredits: 1 }, everything: { credits: 2, storageCredits: 2 } },
    narrowerBranches: 0,
    minClientVersion: '0.2.0',
    defaultBranch: 'main',
    ...over,
  }
}

const STORE: WorkStore = { oids: new Set(), read: async () => ({ type: 'blob', bytes: new Uint8Array() }), typeOf: async () => null }

/** A chain the run reaches: one repo, state the test sets, every write logged. */
class FakeChain {
  visibility: 'public' | 'private' = 'private'
  conversion: Conversion | null = null
  currentEpoch: number | null = 2
  maintainers = new Set([OWNER, MAINT])
  bundles = new Set<string>()
  publicRefs = new Map<string, string>()
  membersOnly = new Set<string>()
  record: MakePublicRecord | null = null
  checks: MakePublicCheck[] = []
  history: Uint8Array[] = []
  log: string[] = []
  /** What another maintainer does right after this run's rotation. */
  afterRotate: (() => void) | null = null
  /** The next rotation lands, then its answer is lost (a timeout, a closed tab). */
  loseAnswer = false
  /** How many more key reads show the epoch before the current one (a node behind). */
  lagReads = 0
  /** Burned epochs (chain links only). */
  burned: number[] = []
  /** What lands right before the flip, after the key was read for it. */
  beforeFlip: (() => void) | null = null
  blockers: MakePublicError[] = []

  io(me: string): MakePublicIo {
    return {
      me,
      owner: OWNER,
      repoId: 'R',
      repoName: 'ledger',
      readVisibility: async () => this.visibility,
      readConversion: async () => this.conversion,
      ownerBundles: async () => new Set(this.bundles),
      keys: async () => {
        const behind = this.lagReads > 0 && this.currentEpoch !== null
        if (behind) this.lagReads--
        return { maintainer: this.maintainers.has(me), currentEpoch: behind ? (this.currentEpoch as number) - 1 : this.currentEpoch, burned: [...this.burned] }
      },
      inspect: async (o): Promise<Inspection> => {
        this.log.push(`inspect:${o.conversion === null ? 'private' : 'public'}${o.chosen ? ':chosen' : ''}${o.below !== undefined ? `:below${o.below}` : ''}`)
        const check = this.checks.shift() ?? checkOf()
        return { check, blockers: this.blockers, store: STORE, config: null, currentEpoch: this.currentEpoch }
      },
      rotate: async () => {
        this.log.push('rotate')
        this.currentEpoch = (this.currentEpoch ?? -1) + 1
        const epoch = this.currentEpoch
        this.afterRotate?.()
        if (this.loseAnswer) {
          this.loseAnswer = false
          throw new Error('the anchor was posted, then the wait for it timed out')
        }
        return epoch
      },
      canFlip: async () => {
        this.beforeFlip?.()
        return true
      },
      flip: async (b) => {
        this.log.push(`flip:${b}`)
        this.visibility = 'public'
        this.conversion = { sealOffEpoch: this.currentEpoch, markerHeight: null }
      },
      writeConfig: async () => {
        this.log.push('config')
        this.conversion = { sealOffEpoch: this.conversion?.sealOffEpoch ?? null, markerHeight: 50 }
      },
      publicState: async () => ({ publicRefs: new Map(this.publicRefs), membersOnly: new Set(this.membersOnly) }),
      publishCode: async (_i, todo, have) => {
        this.log.push(`code:${todo.map((r) => r.name).join(',')}|have:${have.length}`)
        for (const r of todo) this.publicRefs.set(r.name, r.oid)
      },
      historyBundles: async (sealOff) => {
        this.log.push(`keys-below:${sealOff}`)
        return this.history.map((b) => b.slice())
      },
      storeBundle: async (b) => {
        this.log.push('bundle')
        this.bundles.add(bytesToHex(sha256(b)))
      },
      loadRecord: async () => this.record,
      saveRecord: async (r) => {
        this.record = r
      },
      deleteRecord: async () => {
        this.record = null
      },
      balance: async () => 1_000,
      sleep: async () => undefined,
    }
  }
}

const WORDS = 'make carol/ledger public'
const START = 'start over making carol/ledger public'
const choice = (over: Partial<MakePublicChoice> = {}): MakePublicChoice => ({ mode: 'codeOnly', allowSecrets: [], confirmation: WORDS, repoLabel: 'carol/ledger', ...over })
const steps = (): { events: MakePublicProgress[]; on: (p: MakePublicProgress) => void } => {
  const events: MakePublicProgress[] = []
  return { events, on: (p) => events.push(p) }
}
const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p
  } catch (e) {
    if (e instanceof MakePublicError) return e.code
    throw e
  }
  return undefined
}

describe('who may run what', () => {
  it('refuses anyone but the owner while the repo is private, before anything is read or signed', async () => {
    const chain = new FakeChain()
    expect(await codeOf(runMakePublicWith(chain.io(MAINT), choice(), () => undefined))).toBe('E601')
    chain.maintainers.delete('Stranger')
    expect(await codeOf(runMakePublicWith(chain.io('Stranger'), choice(), () => undefined))).toBe('E601')
    expect(chain.log).toEqual([])
  })

  it('after the flip lets a maintainer finish Code only (naming the refs without a record), never choose Everything', async () => {
    const chain = new FakeChain()
    chain.visibility = 'public'
    chain.conversion = { sealOffEpoch: 2, markerHeight: 50 }
    expect(await codeOf(runMakePublicWith(chain.io(MAINT), choice({ mode: 'everything' }), () => undefined))).toBe('E601')
    // no record of the owner's choice here, and none named
    expect(await codeOf(runMakePublicWith(chain.io(MAINT), choice({ confirmation: '' }), () => undefined))).toBe('E201')
    const out = await runMakePublicWith(chain.io(MAINT), choice({ refs: ['main'], confirmation: WORDS }), () => undefined)
    expect(out.finished).toBe(true)
    expect(chain.log).toEqual(['inspect:public:below2', 'code:refs/heads/main|have:0'])
  })

  it("after history was published, finishes only as Everything; a maintainer's run leaves the history to the owner", async () => {
    const chain = new FakeChain()
    chain.visibility = 'public'
    chain.conversion = { sealOffEpoch: 2, markerHeight: 50 }
    // the first of the owner's two history bundles is recorded: the history has started
    chain.history = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]
    chain.bundles.add(bytesToHex(sha256(new Uint8Array([1, 2, 3]))))
    expect(await codeOf(runMakePublicWith(chain.io(OWNER), choice(), () => undefined))).toBe('E201')
    const s = steps()
    // refs not public yet and no record here: a new publication, so the words are typed
    expect(await codeOf(runMakePublicWith(chain.io(MAINT), choice({ mode: 'everything', confirmation: '' }), () => undefined))).toBe('E802')
    const out = await runMakePublicWith(chain.io(MAINT), choice({ mode: 'everything' }), s.on)
    expect(out.finished).toBe(false)
    expect(s.events.at(-1)).toEqual({ step: 'history', state: 'owner' })
    expect(chain.log).not.toContain('bundle')
  })
})

describe('a run from the start (the owner)', () => {
  it('runs nothing with no mode chosen', async () => {
    const chain = new FakeChain()
    expect(await codeOf(runMakePublicWith(chain.io(OWNER), choice({ mode: undefined as never }), () => undefined))).toBe('E201')
    expect(chain.log).toEqual([])
  })

  it('needs the typed words and refuses on a blocker, before anything is signed', async () => {
    const chain = new FakeChain()
    expect(await codeOf(runMakePublicWith(chain.io(OWNER), choice({ confirmation: 'make carol/ledger publc' }), () => undefined))).toBe('E802')
    chain.blockers = [new MakePublicError('repair first', 'E310')]
    expect(await codeOf(runMakePublicWith(chain.io(OWNER), choice(), () => undefined))).toBe('E310')
    chain.blockers = []
    chain.checks = [checkOf({ codeSecrets: [{ place: '.env', rule: 'env_file', fingerprint: 'abc', refuses: true }] })]
    expect(await codeOf(runMakePublicWith(chain.io(OWNER), choice(), () => undefined))).toBe('E807')
    expect(chain.log.filter((l) => !l.startsWith('inspect'))).toEqual([])
    expect(chain.record).toBeNull()
  })

  it('seals off, flips, writes the first public settings, publishes the code, then forgets its record', async () => {
    const chain = new FakeChain()
    const s = steps()
    const out = await runMakePublicWith(chain.io(OWNER), choice(), s.on)
    expect(chain.log).toEqual(['inspect:private', 'rotate', 'flip:main', 'config', 'code:refs/heads/main|have:0'])
    expect(s.events.filter((e) => e.state === 'done' || e.state === 'skipped').map((e) => e.step)).toEqual(['sealOff', 'flip', 'config', 'code', 'notify', 'history'])
    expect(out).toEqual({ finished: true, notPublished: [], spentCredits: 0 })
    expect(chain.record).toBeNull()
  })

  it('never rotates twice for one run: a recorded seal-off epoch that is still current is kept, a passed one stops the run', async () => {
    const chain = new FakeChain()
    chain.record = { mode: 'codeOnly', refs: [[MAIN.name, MAIN.oid]], sealOff: 2, startedAt: 1 }
    // an old record alone never stands in for the typed words
    expect(await codeOf(runMakePublicWith(chain.io(OWNER), choice({ confirmation: '' }), () => undefined))).toBe('E802')
    expect(chain.log).toEqual(['inspect:private:chosen:below2'])
    await runMakePublicWith(chain.io(OWNER), choice({ confirmation: '', resume: true }), () => undefined)
    expect(chain.log).not.toContain('rotate')
    expect(chain.log).toContain('flip:main')
    const again = new FakeChain()
    again.record = { mode: 'codeOnly', refs: [[MAIN.name, MAIN.oid]], sealOff: 1, startedAt: 1 }
    expect(await codeOf(runMakePublicWith(again.io(OWNER), choice({ confirmation: '', resume: true }), () => undefined))).toBe('E310')
    expect(again.log).toEqual([])
    expect(again.record?.sealOff).toBe(1)
  })

  it('stops before the flip when someone else changed the key after the seal-off (E310), keeping its record', async () => {
    const chain = new FakeChain()
    chain.afterRotate = () => {
      chain.currentEpoch = (chain.currentEpoch ?? 0) + 1
    }
    expect(await codeOf(runMakePublicWith(chain.io(OWNER), choice(), () => undefined))).toBe('E310')
    expect(chain.log).not.toContain('flip:main')
    expect(chain.visibility).toBe('private')
    expect(chain.record?.sealOff).toBe(3)
  })

  it('with Everything checks again after the seal-off and stops while still private when the gate refuses', async () => {
    const chain = new FakeChain()
    chain.checks = [checkOf(), checkOf({ oldFormat: ['production'] })]
    const e = await runMakePublicWith(chain.io(OWNER), choice({ mode: 'everything' }), () => undefined).catch((x: unknown) => x as MakePublicError)
    expect(e).toBeInstanceOf(MakePublicError)
    expect((e as MakePublicError).code).toBe('E812')
    expect((e as MakePublicError).message).toContain('still private')
    expect(chain.log).toEqual(['inspect:private', 'rotate', 'inspect:private:chosen:below3'])
    expect(chain.visibility).toBe('private')
  })

  it('reads the key again right before the flip: a rotation during the second check stops the run (E310)', async () => {
    const chain = new FakeChain()
    const io = chain.io(OWNER)
    let inspected = 0
    const inner = io.inspect
    const racing: MakePublicIo = {
      ...io,
      inspect: async (o) => {
        inspected++
        // another maintainer rotates while the second check downloads everything
        if (inspected === 2) chain.currentEpoch = (chain.currentEpoch ?? 0) + 1
        return inner(o)
      },
    }
    expect(await codeOf(runMakePublicWith(racing, choice({ mode: 'everything' }), () => undefined))).toBe('E310')
    expect(chain.visibility).toBe('private')
    expect(chain.log).not.toContain('flip:main')
  })

  it("never publishes history at or above its own seal-off epoch, whatever the repo's config states", async () => {
    const chain = new FakeChain()
    chain.visibility = 'public'
    // a later private-stamped config states epoch 5; this browser's run sealed off at 3
    chain.conversion = { sealOffEpoch: 5, markerHeight: 50 }
    chain.publicRefs = new Map([[MAIN.name, MAIN.oid], [DEV.name, DEV.oid]])
    chain.record = { mode: 'everything', refs: [[MAIN.name, MAIN.oid], [DEV.name, DEV.oid]], sealOff: 3, startedAt: 1 }
    chain.history = [new Uint8Array([1])]
    await runMakePublicWith(chain.io(OWNER), choice({ mode: 'everything', confirmation: '', resume: true }), () => undefined)
    // one cutoff for the whole run: the check and the history alike
    expect(chain.log).toEqual(['inspect:public:chosen:below3', 'keys-below:3', 'bundle'])
  })

  it('with Everything publishes every live ref, then only the history bundles not recorded yet', async () => {
    const chain = new FakeChain()
    const recorded = new Uint8Array([9])
    chain.bundles.add(bytesToHex(sha256(recorded)))
    chain.history = [recorded, new Uint8Array([7])]
    // the second check (after the seal-off) finds a branch pushed meanwhile
    const late = { name: 'refs/heads/late', oid: 'c'.repeat(40) }
    chain.checks = [checkOf(), checkOf({ allRefs: [DEV, late, MAIN] })]
    const out = await runMakePublicWith(chain.io(OWNER), choice({ mode: 'everything' }), () => undefined)
    expect(out.finished).toBe(true)
    expect(chain.log).toEqual(['inspect:private', 'rotate', 'inspect:private:chosen:below3', 'flip:main', 'config', 'code:refs/heads/dev,refs/heads/late,refs/heads/main|have:0', 'keys-below:3', 'bundle'])
  })

  it('stops cleanly between steps when aborted, and a second run continues where it stopped', async () => {
    const chain = new FakeChain()
    const abort = new AbortController()
    const err = await runMakePublicWith(chain.io(OWNER), choice(), (p) => p.step === 'sealOff' && p.state === 'done' && abort.abort(), abort.signal).catch((e: unknown) => e)
    expect((err as Error).name).toBe('AbortError')
    expect(chain.log).toEqual(['inspect:private', 'rotate'])
    expect(chain.record?.sealOff).toBe(3)
    // continued: the record's seal-off is current, so no second rotation, and no words are asked
    const out = await runMakePublicWith(chain.io(OWNER), choice({ confirmation: '', resume: true }), () => undefined)
    expect(out.finished).toBe(true)
    expect(chain.log.filter((l) => l === 'rotate')).toHaveLength(1)
  })

  it('never publishes a branch members pushed to after the flip, and says so', async () => {
    const chain = new FakeChain()
    chain.visibility = 'public'
    chain.conversion = { sealOffEpoch: 2, markerHeight: 50 }
    chain.membersOnly.add(DEV.name)
    chain.checks = [checkOf({ codeRefs: [MAIN, DEV] })]
    const out = await runMakePublicWith(chain.io(OWNER), choice(), () => undefined)
    expect(out.notPublished).toEqual([DEV.name])
    expect(chain.log).toEqual(['inspect:public:below2', 'code:refs/heads/main|have:0'])
  })
})

describe('the history counts only as history (H1)', () => {
  it("an owner who made one comment public has not started Everything: Code only finishes, a maintainer can't choose Everything", async () => {
    const chain = new FakeChain()
    chain.visibility = 'public'
    chain.conversion = { sealOffEpoch: 2, markerHeight: 50 }
    // a kind-7 bundle of the owner's that is not one of the history bundles (a comment made public)
    chain.bundles.add(bytesToHex(sha256(new Uint8Array([0xc0]))))
    chain.history = [new Uint8Array([1, 2, 3])]
    expect(await codeOf(runMakePublicWith(chain.io(MAINT), choice({ mode: 'everything' }), () => undefined))).toBe('E601')
    const s = steps()
    const out = await runMakePublicWith(chain.io(OWNER), choice(), s.on)
    expect(out.finished).toBe(true)
    expect(s.events.at(-1)).toEqual({ step: 'history', state: 'skipped' })
    expect(chain.log).not.toContain('bundle')
  })

  it("Everything after Code only: the owner's run is new (the words and the scan) and publishes the history", async () => {
    const chain = new FakeChain()
    chain.visibility = 'public'
    chain.conversion = { sealOffEpoch: 2, markerHeight: 50 }
    chain.publicRefs = new Map([[MAIN.name, MAIN.oid]])
    chain.bundles.add(bytesToHex(sha256(new Uint8Array([0xc0]))))
    chain.history = [new Uint8Array([1, 2, 3])]
    expect(await codeOf(runMakePublicWith(chain.io(OWNER), choice({ mode: 'everything', confirmation: '' }), () => undefined))).toBe('E802')
    chain.checks = [checkOf({ oldFormat: ['production'] })]
    expect(await codeOf(runMakePublicWith(chain.io(OWNER), choice({ mode: 'everything' }), () => undefined))).toBe('E812')
    const out = await runMakePublicWith(chain.io(OWNER), choice({ mode: 'everything' }), () => undefined)
    expect(out.finished).toBe(true)
    expect(chain.log.filter((l) => !l.startsWith('inspect') && !l.startsWith('keys-below'))).toEqual(['code:refs/heads/dev|have:1', 'bundle'])
  })
})

describe('one cutoff for the whole run (M1)', () => {
  it('while private, a recorded seal-off epoch that is still current bounds the first check too', async () => {
    const chain = new FakeChain()
    chain.record = { mode: 'codeOnly', refs: [[MAIN.name, MAIN.oid]], sealOff: 2, startedAt: 1 }
    await runMakePublicWith(chain.io(OWNER), choice({ confirmation: '', resume: true }), () => undefined)
    expect(chain.log[0]).toBe('inspect:private:chosen:below2')
    // one started again on purpose has no cutoff until its own rotation makes it
    const again = new FakeChain()
    again.record = { mode: 'codeOnly', refs: [[MAIN.name, MAIN.oid]], sealOff: 1, startedAt: 1 }
    await runMakePublicWith(again.io(OWNER), choice({ startOver: true, confirmation: START }), () => undefined)
    expect(again.log[0]).toBe('inspect:private')
  })

  it('once public, the lower of the stated and the recorded seal-off epochs', async () => {
    const chain = new FakeChain()
    chain.visibility = 'public'
    chain.conversion = { sealOffEpoch: 2, markerHeight: 50 }
    chain.record = { mode: 'codeOnly', refs: [[MAIN.name, MAIN.oid]], sealOff: 4, startedAt: 1 }
    await runMakePublicWith(chain.io(OWNER), choice({ confirmation: '', resume: true }), () => undefined)
    expect(chain.log[0]).toBe('inspect:public:chosen:below2')
  })
})

describe('the seal-off boundary across a concurrent key rotation', () => {
  /** A run that seals off at 3 while another maintainer rotates to 4 right after it. */
  async function afterConcurrentRotation(mode: 'codeOnly' | 'everything' = 'everything'): Promise<FakeChain> {
    const chain = new FakeChain()
    chain.history = [new Uint8Array([1])]
    chain.afterRotate = () => {
      chain.currentEpoch = (chain.currentEpoch ?? 0) + 1
      chain.afterRotate = null
    }
    expect(await codeOf(runMakePublicWith(chain.io(OWNER), choice({ mode }), () => undefined))).toBe('E310')
    expect([chain.record?.sealOff, chain.currentEpoch, chain.visibility]).toEqual([3, 4, 'private'])
    return chain
  }

  it('Finish after a concurrent rotation keeps the original boundary: it stops, never rotating again nor flipping', async () => {
    const chain = await afterConcurrentRotation()
    const e = await runMakePublicWith(chain.io(OWNER), choice({ mode: 'everything', confirmation: '', resume: true }), () => undefined).catch((x: unknown) => x as MakePublicError)
    expect(e).toBeInstanceOf(MakePublicError)
    expect((e as MakePublicError).code).toBe('E310')
    expect((e as MakePublicError).message).toContain('start again')
    // run again with the typed words, it still stops
    expect(await codeOf(runMakePublicWith(chain.io(OWNER), choice({ mode: 'everything' }), () => undefined))).toBe('E310')
    expect(chain.log.filter((l) => l === 'rotate')).toHaveLength(1)
    expect(chain.log).not.toContain('flip:main')
    expect(chain.log).not.toContain('bundle')
    expect(chain.record?.sealOff).toBe(3)
    expect(chain.conversion).toBeNull()
  })

  it('only a new run started on purpose continues: the typed words, then its own seal-off as the boundary', async () => {
    const chain = await afterConcurrentRotation()
    // starting again is never a resume: its own words are asked, the usual ones don't do, and
    // what it adds is said
    expect(await codeOf(runMakePublicWith(chain.io(OWNER), choice({ mode: 'everything', confirmation: '', resume: true, startOver: true }), () => undefined))).toBe('E802')
    const e = await runMakePublicWith(chain.io(OWNER), choice({ mode: 'everything', startOver: true }), () => undefined).catch((x: unknown) => x as MakePublicError)
    expect([(e as MakePublicError).code, (e as MakePublicError).message]).toEqual(['E802', `${COPY.startOver(null, 'everything')} Type "${START}" to continue.`])
    expect(chain.record?.sealOff).toBe(3)
    const out = await runMakePublicWith(chain.io(OWNER), choice({ mode: 'everything', startOver: true, confirmation: START }), () => undefined)
    expect(out.finished).toBe(true)
    expect(chain.log.filter((l) => !l.startsWith('inspect'))).toEqual(['rotate', 'rotate', 'flip:main', 'config', 'code:refs/heads/dev,refs/heads/main|have:0', 'keys-below:5', 'bundle'])
  })

  it('two clients resuming: a maintainer elsewhere is refused while private, the owner here stops, and starting again needs a passed run', async () => {
    const chain = await afterConcurrentRotation('codeOnly')
    // the maintainer's browser has no record of the owner's run
    const here = chain.record
    chain.record = null
    expect(await codeOf(runMakePublicWith(chain.io(MAINT), choice({ confirmation: '', resume: true }), () => undefined))).toBe('E601')
    chain.record = here
    expect(await codeOf(runMakePublicWith(chain.io(OWNER), choice({ confirmation: '', resume: true }), () => undefined))).toBe('E310')
    expect(chain.log.filter((l) => l === 'rotate')).toHaveLength(1)
    // a run that can still be finished is never started again
    const current = new FakeChain()
    current.record = { mode: 'codeOnly', refs: [[MAIN.name, MAIN.oid]], sealOff: 2, startedAt: 1 }
    expect(await codeOf(runMakePublicWith(current.io(OWNER), choice({ startOver: true, confirmation: START }), () => undefined))).toBe('E201')
    // nor one made public already
    current.visibility = 'public'
    current.conversion = { sealOffEpoch: 2, markerHeight: 50 }
    expect(await codeOf(runMakePublicWith(current.io(OWNER), choice({ startOver: true, confirmation: START }), () => undefined))).toBe('E201')
    expect(current.log).toEqual([])
  })

  it('an interrupted run after a second rotation never moves its boundary', async () => {
    const chain = new FakeChain()
    // interrupted right after its seal-off at 3, then two rotations by others
    chain.record = { mode: 'everything', refs: [[MAIN.name, MAIN.oid], [DEV.name, DEV.oid]], sealOff: 3, startedAt: 1 }
    chain.currentEpoch = 5
    for (let i = 0; i < 2; i++) {
      expect(await codeOf(runMakePublicWith(chain.io(OWNER), choice({ mode: 'everything', confirmation: '', resume: true }), () => undefined))).toBe('E310')
    }
    expect(chain.log).toEqual([])
    expect([chain.record?.sealOff, chain.currentEpoch, chain.visibility]).toEqual([3, 5, 'private'])
  })

  it('a client resuming from the chain alone reads the original boundary', async () => {
    // a concurrent rotation, then Finish: never flipped, so the chain states no later boundary
    const rotated = await afterConcurrentRotation()
    await runMakePublicWith(rotated.io(OWNER), choice({ mode: 'everything', confirmation: '', resume: true }), () => undefined).catch(() => undefined)
    expect(rotated.conversion).toBeNull()
    // a run sealed off at 3 and flipped, stopped before the history
    const chain = new FakeChain()
    chain.history = [new Uint8Array([1])]
    const abort = new AbortController()
    await runMakePublicWith(chain.io(OWNER), choice({ mode: 'everything' }), (p) => p.step === 'flip' && p.state === 'done' && abort.abort(), abort.signal).catch(() => undefined)
    expect(chain.conversion?.sealOffEpoch).toBe(3)
    // members rotate after the flip; another browser, with no record, finishes it
    chain.currentEpoch = 6
    chain.record = null
    // a maintainer without the owner's history started can't choose Everything (E601)
    expect(await codeOf(runMakePublicWith(chain.io(MAINT), choice({ mode: 'everything' }), () => undefined))).toBe('E601')
    chain.log.length = 0
    const owner = await runMakePublicWith(chain.io(OWNER), choice({ mode: 'everything' }), () => undefined)
    expect(owner.finished).toBe(true)
    expect(chain.log.filter((l) => l.startsWith('keys-below'))).toEqual(['keys-below:3'])
  })
})

describe('a seal-off rotation that landed but was never recorded', () => {
  it('is found again: the resume never rotates a second time, and it is the boundary', async () => {
    const chain = new FakeChain()
    chain.history = [new Uint8Array([1])]
    chain.loseAnswer = true
    await expect(runMakePublicWith(chain.io(OWNER), choice({ mode: 'everything' }), () => undefined)).rejects.toThrow('timed out')
    // the epoch it began from was kept before it was signed
    expect([chain.record?.sealOff, chain.record?.sealOffFrom, chain.currentEpoch]).toEqual([null, 2, 3])
    const out = await runMakePublicWith(chain.io(OWNER), choice({ mode: 'everything', confirmation: '', resume: true }), () => undefined)
    expect(out.finished).toBe(true)
    expect(chain.log.filter((l) => l === 'rotate')).toHaveLength(1)
    expect(chain.log).toContain('keys-below:3')
  })

  it('a node behind it is waited for: the resume still never rotates a second time', async () => {
    const chain = new FakeChain()
    chain.loseAnswer = true
    await runMakePublicWith(chain.io(OWNER), choice(), () => undefined).catch(() => undefined)
    // the first reads still show the epoch the rotation began from
    chain.lagReads = 2
    const out = await runMakePublicWith(chain.io(OWNER), choice({ confirmation: '', resume: true }), () => undefined)
    expect(out.finished).toBe(true)
    expect(chain.log.filter((l) => l === 'rotate')).toHaveLength(1)
    expect(chain.conversion?.sealOffEpoch).toBe(3)
  })

  it('found only after a check made before it: the run stops, publishes nothing, and the next run checks below it', async () => {
    const chain = new FakeChain()
    chain.loseAnswer = true
    await runMakePublicWith(chain.io(OWNER), choice(), () => undefined).catch(() => undefined)
    // a node behind answers every read of the start (past the wait); a member pushed to main
    // under the run's own key change, and the owner names it again
    chain.lagReads = 7
    const late = { name: MAIN.name, oid: 'c'.repeat(40) }
    chain.checks = [checkOf({ codeRefs: [late] })]
    const e = await runMakePublicWith(chain.io(OWNER), choice({ refs: ['main'] }), () => undefined).catch((x: unknown) => x as MakePublicError)
    expect([(e as MakePublicError).code, (e as MakePublicError).message]).toEqual(['E310', COPY.runAgain])
    expect(chain.log.filter((l) => l === 'rotate' || l.startsWith('flip') || l.startsWith('code'))).toEqual(['rotate'])
    expect([chain.record?.sealOff, chain.visibility]).toEqual([3, 'private'])
    expect(chain.publicRefs.size).toBe(0)
    // the resume checks below the boundary it found
    chain.log.length = 0
    await runMakePublicWith(chain.io(OWNER), choice({ confirmation: '', resume: true }), () => undefined)
    expect(chain.log[0]).toBe('inspect:private:chosen:below3')
  })

  it('a record whose rotation may have landed is never set aside by starting again', async () => {
    const chain = new FakeChain()
    chain.loseAnswer = true
    await runMakePublicWith(chain.io(OWNER), choice(), () => undefined).catch(() => undefined)
    chain.currentEpoch = 2
    expect(await codeOf(runMakePublicWith(chain.io(OWNER), choice({ startOver: true, confirmation: START }), () => undefined))).toBe('E201')
    expect(chain.record?.sealOffFrom).toBe(2)
    expect(chain.log.filter((l) => l === 'rotate')).toHaveLength(1)
  })

  it('then another rotation: the run stops at its own boundary, never rotating again', async () => {
    const chain = new FakeChain()
    chain.loseAnswer = true
    await runMakePublicWith(chain.io(OWNER), choice({ mode: 'everything' }), () => undefined).catch(() => undefined)
    chain.currentEpoch = 4
    expect(await codeOf(runMakePublicWith(chain.io(OWNER), choice({ mode: 'everything', confirmation: '', resume: true }), () => undefined))).toBe('E310')
    expect(chain.log.filter((l) => l === 'rotate')).toHaveLength(1)
    expect(chain.visibility).toBe('private')
  })

  it("a burned epoch carries nothing: the first one after it is the run's", async () => {
    const chain = new FakeChain()
    chain.loseAnswer = true
    await runMakePublicWith(chain.io(OWNER), choice(), () => undefined).catch(() => undefined)
    // the rotation burned 3 and anchored 4
    chain.currentEpoch = 4
    chain.burned = [3]
    const out = await runMakePublicWith(chain.io(OWNER), choice({ confirmation: '', resume: true }), () => undefined)
    expect(out.finished).toBe(true)
    expect(chain.log.filter((l) => l === 'rotate')).toHaveLength(1)
    expect(chain.conversion?.sealOffEpoch).toBe(4)
  })

  it('not anchored yet (the key still reads the epoch it began from): the rotation is resumed, then checked below', async () => {
    const chain = new FakeChain()
    chain.record = { mode: 'codeOnly', refs: [[MAIN.name, MAIN.oid]], sealOff: null, sealOffFrom: 2, startedAt: 1 }
    // its check ran before the boundary was known: the run stops once it is
    expect(await codeOf(runMakePublicWith(chain.io(OWNER), choice({ confirmation: '', resume: true }), () => undefined))).toBe('E310')
    expect(chain.record?.sealOff).toBe(3)
    const out = await runMakePublicWith(chain.io(OWNER), choice({ confirmation: '', resume: true }), () => undefined)
    expect(out.finished).toBe(true)
    expect(chain.log.filter((l) => l === 'rotate')).toHaveLength(1)
    expect(chain.log).toContain('inspect:private:chosen:below3')
  })
})

describe('the boundary the repo states after the flip', () => {
  it("is not the run's own: the history stops at the run's, and the record is kept", async () => {
    const chain = new FakeChain()
    chain.history = [new Uint8Array([1])]
    // a rotation lands right before the flip, after the key was read for it
    chain.beforeFlip = () => {
      chain.currentEpoch = (chain.currentEpoch ?? 0) + 1
    }
    const out = await runMakePublicWith(chain.io(OWNER), choice({ mode: 'everything' }), () => undefined)
    expect(chain.conversion?.sealOffEpoch).toBe(4)
    expect(out).toMatchObject({ finished: true, boundaryKept: true })
    expect(chain.log).toContain('keys-below:3')
    expect(chain.record?.sealOff).toBe(3)
  })

  it("is the run's own: the record is forgotten", async () => {
    const chain = new FakeChain()
    const out = await runMakePublicWith(chain.io(OWNER), choice(), () => undefined)
    expect(out.boundaryKept).toBeUndefined()
    expect(chain.record).toBeNull()
  })
})

describe("the record's refs (M2)", () => {
  it('refs named that are not the recorded ones are a new choice: the words and the scan', async () => {
    const chain = new FakeChain()
    chain.visibility = 'public'
    chain.conversion = { sealOffEpoch: 2, markerHeight: 50 }
    chain.record = { mode: 'codeOnly', refs: [[MAIN.name, MAIN.oid]], sealOff: 2, startedAt: 1 }
    chain.checks = [checkOf({ codeRefs: [DEV] })]
    expect(await codeOf(runMakePublicWith(chain.io(MAINT), choice({ refs: ['dev'], confirmation: '', resume: true }), () => undefined))).toBe('E802')
    chain.checks = [checkOf({ codeRefs: [DEV], codeSecrets: [{ place: '.env', rule: 'env_file', fingerprint: 'abc', refuses: true }] })]
    expect(await codeOf(runMakePublicWith(chain.io(MAINT), choice({ refs: ['dev'], confirmation: '', resume: true }), () => undefined))).toBe('E807')
    expect(chain.publicRefs.size).toBe(0)
    // the recorded refs named again continue the run without the words
    chain.checks = [checkOf({ codeRefs: [MAIN] })]
    const out = await runMakePublicWith(chain.io(MAINT), choice({ refs: ['main'], confirmation: '', resume: true }), () => undefined)
    expect(out.finished).toBe(true)
    expect(chain.publicRefs.get(MAIN.name)).toBe(MAIN.oid)
  })

  it('code still to publish is scanned even when the run continues its record', async () => {
    const chain = new FakeChain()
    chain.visibility = 'public'
    chain.conversion = { sealOffEpoch: 2, markerHeight: 50 }
    chain.record = { mode: 'codeOnly', refs: [[MAIN.name, MAIN.oid]], sealOff: 2, startedAt: 1 }
    chain.checks = [checkOf({ codeSecrets: [{ place: '.env', rule: 'env_file', fingerprint: 'abc', refuses: true }] })]
    expect(await codeOf(runMakePublicWith(chain.io(OWNER), choice({ confirmation: '', resume: true }), () => undefined))).toBe('E807')
    expect(chain.log).toEqual(['inspect:public:chosen:below2'])
    chain.checks = [checkOf({ codeSecrets: [{ place: '.env', rule: 'env_file', fingerprint: 'abc', refuses: true }] })]
    const out = await runMakePublicWith(chain.io(OWNER), choice({ confirmation: '', resume: true, allowSecrets: ['ABC'] }), () => undefined)
    expect(out.finished).toBe(true)
  })
})

describe('a node behind (L2)', () => {
  it("never rotates again while a node doesn't show this run's seal-off yet, and says Platform hasn't caught up", async () => {
    const chain = new FakeChain()
    // this browser's run rotated to 3; the node still shows 2
    chain.record = { mode: 'codeOnly', refs: [[MAIN.name, MAIN.oid]], sealOff: 3, startedAt: 1 }
    const e = await runMakePublicWith(chain.io(OWNER), choice({ confirmation: '', resume: true }), () => undefined).catch((x: unknown) => x as MakePublicError)
    expect(e).toBeInstanceOf(MakePublicError)
    expect((e as MakePublicError).message).toContain("Platform hasn't caught up yet")
    expect(chain.log).toEqual([])
    // the node catches up: the rotation is kept
    chain.currentEpoch = 3
    await runMakePublicWith(chain.io(OWNER), choice({ confirmation: '', resume: true }), () => undefined)
    expect(chain.log).not.toContain('rotate')
    expect(chain.log).toContain('flip:main')
  })

  it("a node that doesn't show the run's own rotation after the wait: Platform hasn't caught up, and the next run doesn't rotate", async () => {
    const chain = new FakeChain()
    const io = chain.io(OWNER)
    // the node keeps showing the epoch before the rotation
    const behind: MakePublicIo = { ...io, keys: async () => ({ maintainer: true, currentEpoch: 2 }) }
    const e = await runMakePublicWith(behind, choice(), () => undefined).catch((x: unknown) => x as MakePublicError)
    expect((e as MakePublicError).message).toContain("Platform hasn't caught up yet")
    expect((e as MakePublicError).message).not.toContain('another maintainer')
    expect(chain.record?.sealOff).toBe(3)
    expect(await codeOf(runMakePublicWith(behind, choice({ confirmation: '', resume: true }), () => undefined))).toBe('E310')
    expect(chain.log.filter((l) => l === 'rotate')).toHaveLength(1)
  })
})

describe("the history's keys (forge-core epoch_keys_below)", () => {
  const REPO_ID = new Uint8Array(32).fill(0x11)
  const OWNER_ID = new Uint8Array(32).fill(0x21)
  const K = [0, 1, 2].map((e) => Uint8Array.from({ length: 32 }, (_, i) => e * 0x20 + i))

  async function anchor(epoch: number, keys: EpochKeys, fields: Record<string, unknown>, height: number): Promise<ConfigRow> {
    const id = new Uint8Array(32).fill(0x40 + epoch)
    const enc = await sealDoc(keys, { type: 'config', ownerId: OWNER_ID, epoch }, { defaultBranch: 'main', ...fields }, { anchor: true })
    return { id, owner: OWNER_ID, epoch, createdAtBlockHeight: height, enc }
  }

  it('takes each from the next anchor, the newest from the own wrap, and bundles them as forge-core does', async () => {
    const keys = await Promise.all(K.map((k, e) => EpochKeys.import(REPO_ID, e, k)))
    const configs = [
      await anchor(0, keys[0] as EpochKeys, {}, 10),
      await anchor(1, keys[1] as EpochKeys, { prevEpoch: 0, prevEpochKey: K[0]?.slice() }, 20),
      await anchor(2, keys[2] as EpochKeys, { prevEpoch: 1, prevEpochKey: K[1]?.slice() }, 30),
    ]
    // the owner holds epoch 2 by its own wrap; 1 and 0 by the chain
    const wraps = [{ id: new Uint8Array(32).fill(9), owner: OWNER_ID, memberId: OWNER_ID, epoch: 2, recipientKeyId: 1, keyEnabled: true, keys: keys[2] as EpochKeys }]
    const resolution = await resolveEpochs({ repoId: REPO_ID, reader: OWNER_ID, memberships: [{ identity: OWNER_ID, role: 'maintainer' }], configs, wraps })
    expect([...resolution.keys.keys()].sort()).toEqual([0, 1, 2])
    const session = { resolution, repoId: REPO_ID } as unknown as PrivateSession
    const asked: number[] = []
    const got = await rawKeysBelow(session, 3, async (e) => {
      asked.push(e)
      return (K[e] as Uint8Array).slice()
    })
    expect(asked).toEqual([2])
    expect([...got.keys()]).toEqual([0, 1, 2])
    for (const [e, k] of got) expect(k).toEqual(K[e])
    // below the seal-off epoch only
    expect([...(await rawKeysBelow(session, 2, async () => new Uint8Array(32))).keys()]).toEqual([0, 1])
    const [bundle] = epochKeyBundles(REPO_ID, got)
    const parsed = parseBundle(bundle as Uint8Array)
    expect(parsed.note).toBe(EPOCH_BUNDLE_NOTE)
    expect(parsed.entries.map((x) => x.revision)).toEqual([0, 1, 2])
  })
})
