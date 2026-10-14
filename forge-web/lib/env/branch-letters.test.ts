/**
 * The narrower branches half of a member change (`branch-letters.ts`, D34) over real seals and an
 * in-memory store of kind-10 letters: adding someone to a branch's group sends them the current
 * generation and they read the branch; removing someone starts a new generation for everyone left,
 * which they never hold; people without an encryption key are named; branches the signer holds no
 * key for, and a ring that can't be read, are said plainly; and the plan's and outcome's sentences.
 */

import { getPublicKey } from '@noble/secp256k1'
import { describe, expect, it } from 'vitest'

import { base58Encode } from '../auth/base58'
import { BranchKey, bytesToHex, foldBranchLetters, sealKeyLetter, type LetterReader, type OwnerKey } from '../private'
import { readBranchRing, type HeldBranches, type RingSources } from '../repo/branch-ring'
import type { PackManifest } from '../repo/packs'
import type { Membership, Role } from '../rules/v2'
import { branchLetterSender, letterCredits, reletterOf, sendBranchLetters, type BranchLetterSender } from './branch-letters'
import { readEnvironments } from './loader'
import { planMemberChange, runMemberChange, type MemberChange, type MemberEnvIO } from './member-change'
import { branchLine, branchNoKeyLines, branchesNotUpdatedLines, letterOutcomeLine } from './plan-view'
import { membersAfter } from './regroup'
import type { EnvSaver } from './write'

const REPO = new Uint8Array(32).fill(0x11)
const REPO_ID = base58Encode(REPO)
const secret = (b: number) => new Uint8Array(32).fill(b)
const party = (b: number) => {
  const bytes = new Uint8Array(32).fill(b + 100)
  return { b, id: base58Encode(bytes), bytes, pub: getPublicKey(secret(b), true) }
}
type Party = ReturnType<typeof party>
const owner = party(1)
const mara = party(2) // a maintainer
const will = party(3) // a writer
const dana = party(5) // joins later
const nokey = party(7) // no encryption key
const everyone = [owner, mara, will, dana, nokey]
const byId = new Map(everyone.map((p) => [p.id, p]))
const name = (id: string) => ['owner', 'mara', 'will', '', 'dana', '', 'nokey'][(byId.get(id)?.b ?? 0) - 1] ?? id
const NAME = 'refs/heads/sec/embargo'
const MAINTAINERS = { group: 'maintainers' as const, also: [] }

async function sha256Hex(b: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(b))))
}

/** A public repo on an in-memory chain: its members and its kind-10 letters. */
class Chain {
  members: Membership[] = [
    { identity: mara.id, role: 'maintainer', createdAt: 1 },
    { identity: will.id, role: 'writer', createdAt: 1 },
  ]
  letters: { m: PackManifest; bytes: Uint8Array }[] = []
  height = 10

  sources(p: Party): RingSources {
    const reader: LetterReader = { identityId: p.bytes, secrets: [secret(p.b)] }
    return {
      manifests: async () => this.letters.map((l) => l.m),
      fetch: async (m) => (this.letters.find((l) => l.m.documentId === m.documentId) as { bytes: Uint8Array }).bytes,
      ownerKeys: async (id): Promise<OwnerKey[]> => {
        const x = byId.get(id)
        return x === undefined || x === nokey ? [] : [{ id: 4, purpose: 1, keyType: 0, data: x.pub }]
      },
      withReader: (use) => use(reader),
    }
  }

  ring(p: Party): Promise<HeldBranches> {
    return readBranchRing(REPO_ID, owner.id, this.members, this.sources(p))
  }

  /** `p` sending letters to this chain, as `sdkBranchLetterSender` does over the SDK. */
  sender(p: Party): BranchLetterSender {
    return branchLetterSender({
      sender: async () => ({ identity: p.id, keyId: 4, publicKey: p.pub }),
      keysOf: async (ids) => new Map(ids.map((id) => [id, byId.has(id) && byId.get(id) !== nokey ? { keyId: 4, publicKey: (byId.get(id) as Party).pub } : null])),
      seal: (slots, letter) => sealKeyLetter(REPO, secret(p.b), 4, p.bytes, slots, letter),
      store: async (sealed) => {
        this.height += 1
        const documentId = `k${this.height}`
        this.letters.push({ m: { packHash: await sha256Hex(sealed), kind: 10, sizeBytes: sealed.length, documentId, uploader: p.id, createdAtBlockHeight: this.height } as unknown as PackManifest, bytes: sealed })
        return documentId
      },
    })
  }

  io(p: Party, notHeld = 0): MemberEnvIO {
    return {
      read: () => readEnvironments({ manifests: async () => [], maintainers: async () => [], fetch: async () => new Uint8Array(), ownerKeys: async () => [] }, { repoId: REPO, members: null, withReader: (use) => use(null), hasReader: false }),
      members: async () => [...this.members],
      keys: async (ids) => new Map(ids.map((id) => [id, byId.has(id) && byId.get(id) !== nokey ? 4 : null])),
      branches: { held: () => this.ring(p), notHeld: () => notHeld, ...this.sender(p) },
    }
  }
}

/** A chain with one Maintainers branch, started by the owner for the maintainers. */
async function withBranch(): Promise<Chain> {
  const chain = new Chain()
  await chain.sender(owner).send({ name: NAME, keys: [BranchKey.generate()], audience: MAINTAINERS }, new Set([mara.id]))
  return chain
}

/** Run `change` as the owner, with its plan shown first. */
async function change(chain: Chain, c: MemberChange, notHeld = 0) {
  const plan = await planMemberChange(chain.io(owner, notHeld), c, owner.id, owner.id, false)
  const outcome = await runMemberChange(chain.io(owner, notHeld), {} as EnvSaver, plan, owner.id, async () => {
    chain.members = c.kind === 'grant' ? membersAfter(chain.members, c.member, c.role, true) : c.kind === 'revoke' ? membersAfter(chain.members, c.member, c.role, false) : membersAfter(membersAfter(chain.members, c.member, c.role, false), c.member, c.to as Role, true)
  })
  return { plan, outcome }
}

describe('member changes re-letter narrower branches', () => {
  it('promoting a writer sends them the current key, and they read the branch', async () => {
    const chain = await withBranch()
    expect((await chain.ring(will)).ring.isEmpty).toBe(true)
    const { plan, outcome } = await change(chain, { kind: 'change', member: will.id, role: 'writer', to: 'maintainer' }, 1)
    const [item] = plan.branches.items
    expect(item?.action).toEqual({ kind: 'joiners', people: [will.id] })
    expect(plan.credits).toBe(item?.credits)
    expect(branchLine(item!, name)).toMatch(/^sec\/embargo \(Maintainers only\): send its key to will\. About 0\.\d+ DASH\.$/)
    expect(branchesNotUpdatedLines(plan.branches)).toEqual(["1 branch you don't have access to isn't updated here. The next person to push it updates who can read it."])
    // to everyone the branch is for now, so every holder's record of who holds it stays complete
    expect(outcome.letters.map(letterOutcomeLine)).toEqual(['Sent the key of sec/embargo (Maintainers only) to 3 people.'])
    expect((await chain.ring(owner)).ring.get(NAME)?.holders).toEqual([owner.id, mara.id, will.id].sort())
    const theirs = (await chain.ring(will)).ring.get(NAME)
    expect(theirs?.gen).toBe(0)
    expect(theirs?.keys[0]?.equals((await chain.ring(owner)).ring.get(NAME)?.keys[0] as BranchKey)).toBe(true)
    // nothing more to send once everyone holds it
    expect((await planMemberChange(chain.io(owner), { kind: 'grant', member: will.id, role: 'writer' }, owner.id, owner.id, false)).branches.items).toEqual([])
  })

  it('removing a maintainer starts a new key for the people left, which they never hold', async () => {
    const chain = await withBranch()
    await change(chain, { kind: 'grant', member: dana.id, role: 'maintainer' })
    const { plan, outcome } = await change(chain, { kind: 'revoke', member: mara.id, role: 'maintainer' })
    const [item] = plan.branches.items
    expect(item?.action).toEqual({ kind: 'newGeneration', left: [mara.id] })
    expect(branchLine(item!, name)).toMatch(/^sec\/embargo \(Maintainers only\): a new key for the 2 people left\. About 0\.\d+ DASH\.$/)
    expect(outcome.letters).toEqual([{ kind: 'sent', branch: NAME, audience: MAINTAINERS, to: 2 }])
    const mine = (await chain.ring(owner)).ring.get(NAME)
    expect(mine?.gen).toBe(1)
    expect(mine?.holders).toEqual([owner.id, dana.id].sort())
    // mara keeps what she held, and nothing newer
    expect((await chain.ring(mara)).ring.get(NAME)?.gen).toBe(0)
    expect((await chain.ring(dana)).ring.get(NAME)?.gen).toBe(1)
  })

  it('names who has no encryption key, and says when the keys could not be read', async () => {
    const chain = await withBranch()
    chain.members.push({ identity: nokey.id, role: 'maintainer', createdAt: 2 })
    const plan = await planMemberChange(chain.io(owner), { kind: 'grant', member: dana.id, role: 'maintainer' }, owner.id, owner.id, false)
    const [item] = plan.branches.items
    expect(item?.action).toEqual({ kind: 'joiners', people: [dana.id] })
    expect(branchNoKeyLines(item!, name)).toEqual(["nokey has no encryption key, so can't read sec/embargo until they add one."])
    const io = chain.io(owner, 2)
    const broken: MemberEnvIO = { ...io, branches: { ...io.branches!, held: async () => Promise.reject(new Error('the vault is locked')) } }
    const unread = await planMemberChange(broken, { kind: 'grant', member: dana.id, role: 'maintainer' }, owner.id, owner.id, false)
    expect(unread.branches.items).toEqual([])
    expect(branchesNotUpdatedLines(unread.branches)).toEqual([
      "Branches for fewer people than all members weren't checked: the vault is locked. The next person to push each one updates who can read it.",
      "2 branches you don't have access to aren't updated here. The next person to push each one updates who can read it.",
    ])
  })

  it('a letter that cannot be sent is reported; the change stands', async () => {
    const chain = await withBranch()
    const plan = await planMemberChange(chain.io(owner), { kind: 'grant', member: dana.id, role: 'maintainer' }, owner.id, owner.id, false)
    const failing: BranchLetterSender = { send: async () => Promise.reject(new Error('Platform is busy')) }
    const out = await sendBranchLetters(plan.branches, failing)
    expect(out.map(letterOutcomeLine)).toEqual(["Couldn't send the key of sec/embargo: Platform is busy. The next push of it sends it."])
  })
})

describe('reletterOf (forge-core narrow::plan)', () => {
  const letter = { name: NAME, keys: [BranchKey.fromBytes(new Uint8Array(32).fill(1))], audience: MAINTAINERS, to: ['a', 'b'] }
  const b = foldBranchLetters([{ id: 'x', height: 1, sender: 'x', letter }], () => true).branches.get(NAME)!

  it('letters joiners, starts a generation when someone left, and does nothing otherwise', () => {
    expect(reletterOf(b, new Set(['a', 'b']))).toEqual({ kind: 'nothing' })
    expect(reletterOf(b, new Set(['a', 'b', 'c']))).toEqual({ kind: 'joiners', people: ['c'] })
    expect(reletterOf(b, new Set(['a']))).toEqual({ kind: 'newGeneration', left: ['b'] })
    // someone left and someone joined: one new generation for everyone now
    expect(reletterOf(b, new Set(['a', 'c']))).toEqual({ kind: 'newGeneration', left: ['b'] })
  })

  it('refuses a new key past 256 generations, sending nothing', async () => {
    const keys = Array.from({ length: 256 }, (_, i) => BranchKey.fromBytes(new Uint8Array(32).fill(i)))
    const full = foldBranchLetters([{ id: 'x', height: 1, sender: 'x', letter: { ...letter, keys } }], () => true).branches.get(NAME)!
    let sent = 0
    const counting: BranchLetterSender = {
      send: async () => {
        sent++
        return { id: 'k', to: [], skipped: [] }
      },
    }
    const item = { name: NAME, audience: MAINTAINERS, branch: full, action: { kind: 'newGeneration' as const, left: ['b'] }, now: ['a'], noKey: [], credits: 0 }
    const out = await sendBranchLetters({ items: [item], notHeld: 0, unread: null }, counting)
    expect(out).toEqual([{ kind: 'tooManyKeys', branch: NAME, keys: 256 }])
    expect(out.map(letterOutcomeLine)).toEqual(["sec/embargo can't get a new key: it has had 256 already. Publish its work and start a new branch for the people it is for now."])
    expect(sent).toBe(0)
  })

  it('quotes a letter by its recipients, at most 64', () => {
    expect(letterCredits(2)).toBeGreaterThan(letterCredits(1))
    expect(letterCredits(100)).toBe(letterCredits(64))
    expect(letterCredits(0)).toBe(letterCredits(1))
  })
})
