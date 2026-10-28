/**
 * Whether a network has boards (design `docs/design/boards.md` §3): its forge-meta must declare
 * `board` and `card`, not merely exist (testnet's forge-meta v2 has the passkey vault only).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvoSDK } from '@dashevo/evo-sdk'

import { boardsDeployed, bundledContractTypes, declaresBoards, knownBoardsDeployed, resetBoardsDeployed, subscribeBoardsDeployed } from './boards-deployed'

const sdkWith = (fetch: (id: string) => Promise<unknown>): EvoSDK => ({ contracts: { fetch } }) as unknown as EvoSDK

beforeEach(() => resetBoardsDeployed())

describe('boardsDeployed', () => {
  it('needs both board types in the fetched forge-meta', () => {
    expect(declaresBoards({ schemas: { vaultEntry: {}, label: {} } })).toBe(false)
    expect(declaresBoards({ schemas: { board: {}, label: {} } })).toBe(false)
    expect(declaresBoards({ schemas: { board: {}, card: {} } })).toBe(true)
    expect(declaresBoards({ toJSON: () => ({ documentSchemas: { board: {}, card: {} } }) })).toBe(true)
  })

  it('answers no for a three-contract set without reading, and keeps an answer for the session', async () => {
    const fetch = vi.fn(async () => ({ schemas: { board: {}, card: {} } }))
    expect(await boardsDeployed(sdkWith(fetch), undefined)).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
    const told = vi.fn()
    const off = subscribeBoardsDeployed(told)
    expect(knownBoardsDeployed('Meta')).toBeUndefined()
    expect(await Promise.all([boardsDeployed(sdkWith(fetch), 'Meta'), boardsDeployed(sdkWith(fetch), 'Meta')])).toEqual([true, true])
    expect(await boardsDeployed(sdkWith(fetch), 'Meta')).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(knownBoardsDeployed('Meta')).toBe(true)
    expect(told).toHaveBeenCalledTimes(1)
    off()
  })

  it('a forge-meta without the update (testnet v2) has none', async () => {
    expect(await boardsDeployed(sdkWith(async () => ({ schemas: { vaultEntry: {} } })), 'V2')).toBe(false)
    expect(knownBoardsDeployed('V2')).toBe(false)
  })

  it('a bundled snapshot that declares both types answers yes without a request (an update never removes a type)', async () => {
    const fetch = vi.fn(async () => ({ schemas: {} }))
    expect(await boardsDeployed(sdkWith(fetch), 'Snap', async () => ['label', 'board', 'card'])).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
    // a snapshot from before the update (v2): the fetched contract decides
    expect(await boardsDeployed(sdkWith(async () => ({ schemas: { board: {}, card: {} } })), 'Old', async () => ['label', 'vaultEntry'])).toBe(true)
  })

  it('reads the build\'s own snapshot of the network\'s forge-meta', async () => {
    const { NETWORKS, DEFAULT_NETWORK } = await import('../constants')
    const meta = NETWORKS[DEFAULT_NETWORK].v2?.meta
    expect(await bundledContractTypes('NoSuchContract')).toEqual([])
    if (meta !== undefined) expect(await bundledContractTypes(meta)).toEqual(expect.arrayContaining(['board', 'card']))
  })

  it('a failed read is no answer: it throws and is asked again', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('unreachable')).mockResolvedValueOnce({ schemas: { board: {}, card: {} } })
    await expect(boardsDeployed(sdkWith(fetch), 'M')).rejects.toThrow('unreachable')
    expect(knownBoardsDeployed('M')).toBeUndefined()
    expect(await boardsDeployed(sdkWith(fetch), 'M')).toBe(true)
  })
})
