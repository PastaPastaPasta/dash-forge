import { describe, expect, it } from 'vitest'

import type { GitObject } from '../browse'
import { findMergeBase, loadPullComparison, type ObjectReader } from './pull-diff'

const encoder = new TextEncoder()
const oid = (digit: string): string => digit.repeat(40)

function commit(tree: string, parents: readonly string[] = []): GitObject {
  const parentHeaders = parents.map((parent) => `parent ${parent}\n`).join('')
  return {
    type: 'commit',
    bytes: encoder.encode(
      `tree ${tree}\n${parentHeaders}author Test <test@example.com> 1 +0000\ncommitter Test <test@example.com> 1 +0000\n\ntest\n`,
    ),
  }
}

function tree(name: string, blobOid: string): GitObject {
  const header = encoder.encode(`100644 ${name}\0`)
  const object = new Uint8Array(header.length + 20)
  object.set(header)
  for (let i = 0; i < 20; i++) object[header.length + i] = Number.parseInt(blobOid.slice(i * 2, i * 2 + 2), 16)
  return { type: 'tree', bytes: object }
}

function reader(objects: ReadonlyMap<string, GitObject>): ObjectReader {
  return {
    readObject(value: string): Promise<GitObject> {
      const object = objects.get(value)
      return object ? Promise.resolve(object) : Promise.reject(new Error(`missing ${value}`))
    },
  }
}

describe('findMergeBase', () => {
  it('finds the nearest head-side ancestor shared with the target', async () => {
    const root = oid('1')
    const common = oid('2')
    const base = oid('3')
    const headParent = oid('4')
    const head = oid('5')
    const objects = new Map<string, GitObject>([
      [root, commit(oid('a'))],
      [common, commit(oid('a'), [root])],
      [base, commit(oid('a'), [common])],
      [headParent, commit(oid('a'), [common])],
      [head, commit(oid('a'), [headParent])],
    ])

    await expect(findMergeBase(reader(objects), base, head)).resolves.toBe(common)
  })
})

describe('loadPullComparison', () => {
  it('combines source and target readers and renders a modified text file', async () => {
    const baseBlob = oid('1')
    const headBlob = oid('2')
    const baseTree = oid('3')
    const headTree = oid('4')
    const base = oid('5')
    const head = oid('6')
    const baseObjects = new Map<string, GitObject>([
      [baseBlob, { type: 'blob', bytes: encoder.encode('one\ntwo\n') }],
      [baseTree, tree('notes.txt', baseBlob)],
      [base, commit(baseTree)],
    ])
    const sourceObjects = new Map<string, GitObject>([
      [headBlob, { type: 'blob', bytes: encoder.encode('one\nsecond\n') }],
      [headTree, tree('notes.txt', headBlob)],
      [head, commit(headTree, [base])],
    ])

    const comparison = await loadPullComparison(
      reader(sourceObjects),
      reader(baseObjects),
      base,
      head,
      false,
    )

    expect(comparison.comparedBaseOid).toBe(base)
    expect(comparison.changes).toEqual([
      { path: 'notes.txt', status: 'modified', baseOid: baseBlob, headOid: headBlob, oid: headBlob },
    ])
    expect(comparison.patches[0]?.lines?.map((line) => line.kind)).toEqual([
      'context',
      'deleted',
      'added',
      'context',
    ])
  })

  it('rejects an inexact first-parent fallback for an imported PR', async () => {
    const parent = oid('1')
    const head = oid('2')
    const objects = new Map<string, GitObject>([
      [parent, commit(oid('a'))],
      [head, commit(oid('b'), [parent])],
    ])

    await expect(
      loadPullComparison(reader(objects), reader(objects), oid('9'), head, true),
    ).rejects.toThrow('did not preserve its original target commit')
  })

  it('rejects an imported comparison whose current target already contains the head', async () => {
    const root = oid('1')
    const head = oid('2')
    const target = oid('3')
    const objects = new Map<string, GitObject>([
      [root, commit(oid('a'))],
      [head, commit(oid('b'), [root])],
      [target, commit(oid('c'), [head])],
    ])

    await expect(
      loadPullComparison(reader(objects), reader(objects), target, head, true),
    ).rejects.toThrow('did not preserve its original target commit')
  })
})
