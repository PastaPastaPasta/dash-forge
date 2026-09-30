/**
 * Platform chunk reads asked for in the same turn share one query (QW-027, QW-028): a pool of
 * blob reads counting a diff's lines, or a tree walk's parallel reads, each need a chunk or two.
 */

import { describe, expect, it } from 'vitest'

import { chunkQueryCount, clearChunkCache, queueChunkSeqs } from './browse-source'

const answer = (seqs: readonly number[]): Promise<Map<number, Uint8Array>> => Promise.resolve(new Map(seqs.map((s) => [s, Uint8Array.of(s)])))

describe('queueChunkSeqs', () => {
  it('gathers one turn\'s asks of a copy into one query, each asker served its own seqs', async () => {
    clearChunkCache()
    const sent: number[][] = []
    const query = (seqs: readonly number[]) => (sent.push([...seqs]), answer(seqs))
    const [a, b, c] = await Promise.all([queueChunkSeqs('copy', [5], query), queueChunkSeqs('copy', [2, 3], query), queueChunkSeqs('copy', [3], query)])
    expect(sent).toEqual([[2, 3, 5]])
    for (const got of [a, b, c]) expect([...got.keys()]).toEqual([2, 3, 5])
    expect(chunkQueryCount()).toBe(1)
  })

  it('keeps copies apart, and starts a new query rather than grow one past a page', async () => {
    clearChunkCache()
    const sent: number[][] = []
    const query = (seqs: readonly number[]) => (sent.push([...seqs]), answer(seqs))
    const many = Array.from({ length: 90 }, (_, i) => i)
    await Promise.all([
      queueChunkSeqs('one', many, query),
      queueChunkSeqs('two', [1], query),
      // 90 + 20 is over a page (100): its own query.
      queueChunkSeqs('one', Array.from({ length: 20 }, (_, i) => 200 + i), query),
    ])
    expect(sent.map((s) => s.length).sort((x, y) => x - y)).toEqual([1, 20, 90])
  })

  it('a failed query fails its askers, and the next turn asks again', async () => {
    clearChunkCache()
    let fail = true
    const query = (seqs: readonly number[]) => (fail ? Promise.reject(new Error('node down')) : answer(seqs))
    await expect(queueChunkSeqs('copy', [1], query)).rejects.toThrow('node down')
    fail = false
    await expect(queueChunkSeqs('copy', [1], query)).resolves.toEqual(new Map([[1, Uint8Array.of(1)]]))
  })
})
