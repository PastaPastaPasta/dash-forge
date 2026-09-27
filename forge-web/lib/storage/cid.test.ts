import { describe, expect, it } from 'vitest'

import { CID_CHUNK_SIZE, cidV1RawLeaves, isCid } from './cid'

describe('cidV1RawLeaves (parity with forge-core backends/cid.rs)', () => {
  it('derives the well-known empty raw block', () => {
    expect(cidV1RawLeaves(new Uint8Array(0))).toBe('bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku')
  })

  it('derives a single raw leaf', () => {
    expect(cidV1RawLeaves(new TextEncoder().encode('hello'))).toBe('bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq')
  })

  it('makes a dag-pb root past one chunk, deterministically', () => {
    const data = new Uint8Array(CID_CHUNK_SIZE + 1).fill(7)
    const cid = cidV1RawLeaves(data)
    expect(cid.startsWith('bafybei')).toBe(true)
    expect(cidV1RawLeaves(data)).toBe(cid)
    // What `ipfs add --only-hash` returns for these bytes under the pinned parameters.
    expect(cid).toBe('bafybeihldj5jykexbnvf5jx3cm2pjlqqa3hwyc5d6wo2y7ujlk7qjjgzlu')
  })

  it('recognizes CIDs and refuses path smuggling', () => {
    expect(isCid('bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq')).toBe(true)
    expect(isCid('bafy/../../api')).toBe(false)
    expect(isCid('')).toBe(false)
  })
})
