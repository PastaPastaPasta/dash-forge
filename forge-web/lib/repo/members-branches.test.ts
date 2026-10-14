/**
 * Members-only branches in the web (`members-branches.ts`): a member's members-only refs on real
 * tips with the blinds learned (a PR from the branch copies its tip's blind and salt), public names
 * winning, the yes-or-no outsiders get, and the guard on public writes to a listed name.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, it } from 'vitest'

import { base58Encode } from '../auth/base58'
import { EpochKeys, IdSet, bytesToHex, sealMembersRef, type OpenContext, type SealedRefUpdate } from '../private'
import { bytesToBase64, type PlainDocument } from '../sdk'
import { blindBook } from './members-blinds'
import { isListedMembersRef, isMembersOnlyRefRow, membersOnlyRefsExist, membersRefsOf } from './members-branches'
import type { PrivateSession } from './private-session'

const REPO_ID = new Uint8Array(32).fill(0x31)
const OWNER = new Uint8Array(32).fill(0x22)
const A = new Uint8Array(20).fill(1)
const B = new Uint8Array(20).fill(2)
const C = new Uint8Array(20).fill(3)
const FIX = 'refs/heads/sec/fix'
const MAIN = 'refs/heads/main'

const id = (n: number) => base58Encode(new Uint8Array(32).fill(n))
const b64 = (b: Uint8Array) => bytesToBase64(b)

function sealedRow(n: number, createdAt: number, s: SealedRefUpdate): PlainDocument {
  return {
    $id: id(n),
    $ownerId: base58Encode(OWNER),
    $createdAt: createdAt,
    $createdAtBlockHeight: 100,
    vis: 'public',
    epoch: s.epoch,
    refNameHash: b64(s.refNameHash),
    newOid: b64(s.newOid),
    ...(s.prevOid !== undefined ? { prevOid: b64(s.prevOid) } : {}),
    force: s.force,
    enc: b64(s.enc),
  }
}

function publicRow(n: number, createdAt: number, name: string, newOid: Uint8Array): PlainDocument {
  return {
    $id: id(n),
    $ownerId: base58Encode(OWNER),
    $createdAt: createdAt,
    vis: 'public',
    refName: name,
    refNameHash: b64(sha256(new TextEncoder().encode(name))),
    newOid: b64(newOid),
    force: false,
  }
}

async function lane(): Promise<{ session: PrivateSession; keys: EpochKeys }> {
  const keys = await EpochKeys.import(REPO_ID, 0, new Uint8Array(32).fill(7))
  const ctx: OpenContext = {
    keys: new Map([[0, keys]]),
    anchors: new Map([[0, { id: new Uint8Array(32).fill(0xc0), height: 10, statedHeight: 10 }]]),
    members: new IdSet(),
  }
  return { session: { ctx, repoId: REPO_ID } as unknown as PrivateSession, keys }
}

describe('membersRefsOf', () => {
  it("lists a member's members-only branches on real tips and learns the blind each tip was pushed under", async () => {
    const { session, keys } = await lane()
    const first = await sealMembersRef(keys, OWNER, { type: 'refUpdate', name: FIX, newOid: A, force: false })
    const second = await sealMembersRef(keys, OWNER, { type: 'refUpdate', name: FIX, newOid: B, prevOid: A, force: false })
    const tag = await sealMembersRef(keys, OWNER, { type: 'refUpdate', name: 'refs/tags/v1-rc', newOid: C, force: false })
    const rows = { refUpdate: [publicRow(1, 900, MAIN, C), sealedRow(2, 1000, first), sealedRow(3, 1001, second), sealedRow(4, 1002, tag)], protectedRefUpdate: [] }
    const got = await membersRefsOf(rows, session, [])
    expect(got.branches.map((b) => [b.refName, b.audience, b.state.state === 'resolved' ? b.state.oid : null])).toEqual([[FIX, 'members', bytesToHex(B)]])
    expect(got.tags.map((t) => t.refName)).toEqual(['refs/tags/v1-rc'])
    // the public branch is not listed here: the public refs list it, as everyone reads it
    expect(got.branches.some((b) => b.refName === MAIN)).toBe(false)
    expect(got.unreadable).toBe(0)
    expect(got.updates.get(FIX)?.map((u) => u.newOid)).toEqual([bytesToHex(A), bytesToHex(B)])
    // rule C: a PR from sec/fix copies the blind and salt of the update that pushed its tip
    const intro = blindBook(session.ctx).introduced(bytesToHex(B))
    expect(intro !== undefined && bytesToHex(intro.blind)).toBe(bytesToHex(second.newOid))
    expect(intro !== undefined && bytesToHex(intro.salt)).toBe(bytesToHex(second.salt))
    expect(blindBook(session.ctx).realOf(bytesToHex(second.newOid))).toBe(bytesToHex(B))
    // and the web now refuses a public update of the name (D29)
    expect(isListedMembersRef(base58Encode(REPO_ID), FIX)).toBe(true)
    expect(isListedMembersRef(base58Encode(REPO_ID), MAIN)).toBe(false)
  })

  it('leaves out a members-only update of a live public name (D29) and a deleted members-only branch', async () => {
    const { session, keys } = await lane()
    const shadow = await sealMembersRef(keys, OWNER, { type: 'refUpdate', name: MAIN, newOid: A, force: true })
    const made = await sealMembersRef(keys, OWNER, { type: 'refUpdate', name: 'refs/heads/sec/gone', newOid: B, force: false })
    const gone = await sealMembersRef(keys, OWNER, { type: 'refUpdate', name: 'refs/heads/sec/gone', newOid: new Uint8Array(20), prevOid: B, force: false })
    const rows = { refUpdate: [publicRow(1, 900, MAIN, C), sealedRow(2, 1000, shadow), sealedRow(3, 1001, made), sealedRow(4, 1002, gone)], protectedRefUpdate: [] }
    const got = await membersRefsOf(rows, session, [])
    expect(got.branches).toEqual([])
    expect(got.alerts).toEqual([{ id: id(2), kind: 'publicName' }])
  })
})

describe('what an outsider learns', () => {
  it('only whether members-only ref updates exist, never how many', async () => {
    const { keys } = await lane()
    const s = await sealMembersRef(keys, OWNER, { type: 'refUpdate', name: FIX, newOid: A, force: false })
    const pub = publicRow(1, 900, MAIN, C)
    expect(membersOnlyRefsExist({ refUpdate: [pub], protectedRefUpdate: [] })).toBe(false)
    expect(membersOnlyRefsExist({ refUpdate: [pub], protectedRefUpdate: [sealedRow(2, 901, s)] })).toBe(true)
    // a repository made public's private-era update is not a members-only branch
    expect(isMembersOnlyRefRow({ ...sealedRow(3, 902, s), vis: 'private' })).toBe(false)
  })
})
