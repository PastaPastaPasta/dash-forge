/**
 * The ancestry "Sync fork" decides on (P1-4): behind (a fast-forward), ahead, diverged and
 * unrelated, with each side's own commits counted, through one reader of both repos' objects.
 */

import { describe, expect, it } from 'vitest'

import { gitOidHex } from '../browse'
import { syncDecision } from '../repo/fork'
import { syncAncestry } from './fork-sync'
import type { ObjectReader } from './tree-nav'

const enc = new TextEncoder()
const TREE = gitOidHex('tree', new Uint8Array(0))

function history(): { reader: ObjectReader; commit: (parents: readonly string[], msg: string) => string } {
  const objects = new Map<string, Uint8Array>()
  let when = 1_600_000_000
  const commit = (parents: readonly string[], msg: string): string => {
    const ident = `A U Thor <a@example.com> ${when++} +0000`
    const bytes = enc.encode([`tree ${TREE}`, ...parents.map((p) => `parent ${p}`), `author ${ident}`, `committer ${ident}`, '', msg, ''].join('\n'))
    const oid = gitOidHex('commit', bytes)
    objects.set(oid, bytes)
    return oid
  }
  const reader: ObjectReader = {
    async readObject(oid: string) {
      const bytes = objects.get(oid)
      if (bytes === undefined) throw new Error(`no object ${oid}`)
      return { type: 'commit', bytes }
    },
  } as ObjectReader
  return { reader, commit }
}

const decide = async (reader: ObjectReader, fork: string, parent: string) => {
  const a = await syncAncestry(reader, fork, parent)
  return { ...a, decision: syncDecision(fork, parent, a.forkInParent, a.parentInFork) }
}

describe('syncAncestry', () => {
  it('a fork behind its parent fast-forwards, and says by how many commits', async () => {
    const { reader, commit } = history()
    const root = commit([], 'root')
    const forkTip = commit([root], 'one')
    const parentTip = commit([commit([forkTip], 'two')], 'three')
    expect(await decide(reader, forkTip, parentTip)).toEqual({ forkInParent: true, parentInFork: false, unrelated: false, behind: 2, ahead: 0, decision: 'fastForward' })
  })

  it('a fork ahead of its parent has nothing to take', async () => {
    const { reader, commit } = history()
    const parentTip = commit([commit([], 'root')], 'one')
    const forkTip = commit([parentTip], 'mine')
    expect(await decide(reader, forkTip, parentTip)).toEqual({ forkInParent: false, parentInFork: true, unrelated: false, behind: 0, ahead: 1, decision: 'ahead' })
  })

  it('both sides moved: diverged, with both counts', async () => {
    const { reader, commit } = history()
    const base = commit([commit([], 'root')], 'base')
    const forkTip = commit([base], 'mine')
    const parentTip = commit([commit([base], 'theirs 1')], 'theirs 2')
    expect(await decide(reader, forkTip, parentTip)).toEqual({ forkInParent: false, parentInFork: false, unrelated: false, behind: 2, ahead: 1, decision: 'diverged' })
  })

  it('no shared history: diverged and unrelated', async () => {
    const { reader, commit } = history()
    const forkTip = commit([], 'a root')
    const parentTip = commit([], 'another root')
    const got = await decide(reader, forkTip, parentTip)
    expect(got.unrelated).toBe(true)
    expect(got.decision).toBe('diverged')
  })
})
