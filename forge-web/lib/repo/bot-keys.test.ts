/**
 * Bots' keys for members-only posts (§23) over a fake {@link PostKeyIo}: who is sent a letter and
 * what it carries, who is skipped and why, the trial derivation over the signer's own letters,
 * and what the toasts say.
 */

import { describe, expect, it } from 'vitest'

import { base58Encode } from '../auth/base58'
import { EpochKeys, PostKey, bytesToHex, type PostKeyLetter } from '../private'
import { postKeyLetterCredits } from '../env/write'
import { botsOf } from '../rules/roles'
import { missingPostKeys, postKeyLettersCost, postKeysToasts, sendPostKeys, type PostKeyIo } from './bot-keys'

const id = (b: number): string => base58Encode(new Uint8Array(32).fill(b))
const REPO = new Uint8Array(32).fill(0x11)
const BOT = id(0xb0)
const KEYLESS = id(0xb1)
const OTHER = id(0xb2)

async function keys(epoch = 3): Promise<EpochKeys> {
  return EpochKeys.import(REPO, epoch, new Uint8Array(32).fill(0x42))
}

/** A fake I/O: every bot but {@link KEYLESS} has an encryption key; `failAt` makes that store throw. */
function fakeIo(opts: { failAt?: string; sent?: PostKeyLetter[]; sender?: boolean } = {}) {
  const sealed: { bot: string; letter: PostKeyLetter }[] = []
  const stored: string[] = []
  const io: PostKeyIo = {
    me: id(0xa1),
    sender: async () => (opts.sender === false ? null : { keyId: 4, publicKey: new Uint8Array(33).fill(2) }),
    recipientKey: async (who) => (who === KEYLESS ? null : new Uint8Array(33).fill(3)),
    seal: async (_sender, letters) =>
      letters.map((l) => {
        sealed.push({ bot: base58Encode(l.bot.identityId), letter: { epoch: l.letter.epoch, key: new Uint8Array(l.letter.key) } })
        return new Uint8Array([1, 2, 3])
      }),
    store: async (_bytes, bot) => {
      if (bot === opts.failAt) throw new Error('the node refused the write')
      stored.push(bot)
    },
    sentLetters: async () => (opts.sent ?? []).map((l) => ({ epoch: l.epoch, key: new Uint8Array(l.key) })),
  }
  return { io, sealed, stored }
}

async function postKeyOf(k: EpochKeys, bot: string): Promise<Uint8Array> {
  const post = await PostKey.derive(k, new Uint8Array(32).fill(bot === BOT ? 0xb0 : bot === OTHER ? 0xb2 : 0xb1))
  return post.key()
}

describe("sending bots their keys for members-only posts", () => {
  it('sends each bot its own post key of the epoch, and skips a bot with no encryption key', async () => {
    const k = await keys()
    const { io, sealed, stored } = fakeIo()
    const r = await sendPostKeys(io, k, [BOT, KEYLESS, OTHER])
    expect(r).toEqual({ epoch: 3, sent: [BOT, OTHER], skipped: [KEYLESS] })
    expect(stored).toEqual([BOT, OTHER])
    expect(sealed.map((s) => s.bot)).toEqual([BOT, OTHER])
    // each letter carries W_{e,b} of its own bot: a post key opens only that bot's posts
    expect(bytesToHex(sealed[0]!.letter.key)).toBe(bytesToHex(await postKeyOf(k, BOT)))
    expect(bytesToHex(sealed[1]!.letter.key)).toBe(bytesToHex(await postKeyOf(k, OTHER)))
    expect(sealed.every((s) => s.letter.epoch === 3)).toBe(true)
  })

  it('a failed write stops the run: what was sent stays sent, the rest is reported with why', async () => {
    const { io, stored } = fakeIo({ failAt: OTHER })
    const r = await sendPostKeys(io, await keys(), [BOT, OTHER])
    expect(stored).toEqual([BOT])
    expect(r).toEqual({ epoch: 3, sent: [BOT], skipped: [OTHER], failed: 'the node refused the write' })
  })

  it('without a usable sender key nothing is sealed, and every bot is reported', async () => {
    const { io, sealed } = fakeIo({ sender: false })
    const r = await sendPostKeys(io, await keys(), [BOT])
    expect(sealed).toEqual([])
    expect(r.sent).toEqual([])
    expect(r.skipped).toEqual([BOT])
    expect(r.failed).toBeDefined()
  })

  it('no bots: nothing to do', async () => {
    const { io } = fakeIo()
    expect(await sendPostKeys(io, await keys(), [])).toEqual({ epoch: 3, sent: [], skipped: [] })
  })

  it("finds the bots none of the signer's letters gave this epoch's post key (trial derivation)", async () => {
    const k = await keys()
    const older = await keys(2)
    const sent: PostKeyLetter[] = [
      { epoch: 3, key: await postKeyOf(k, BOT) },
      // OTHER's key, but of an older epoch: it still misses this one
      { epoch: 2, key: await postKeyOf(older, OTHER) },
    ]
    const { io } = fakeIo({ sent })
    expect(await missingPostKeys(io, k, [BOT, OTHER])).toEqual([OTHER])
    expect(await missingPostKeys(io, k, [])).toEqual([])
  })

  it('costs one chunk and one manifest per letter', () => {
    expect(postKeyLettersCost(2).credits).toBe(2 * postKeyLetterCredits())
    expect(postKeyLettersCost(0).credits).toBe(0)
  })

  it('the bots of a member list: Bot rows, each once, but the excluded', () => {
    const rows = [
      { identity: id(1), role: 'maintainer' as const, createdAt: 1 },
      { identity: BOT, role: 'bot' as const, createdAt: 2 },
      { identity: id(3), role: 'reader' as const, createdAt: 3 },
      { identity: OTHER, role: 'bot' as const, createdAt: 4 },
      { identity: BOT, role: 'bot' as const, createdAt: 5 },
    ]
    expect(botsOf(rows)).toEqual([BOT, OTHER])
    expect(botsOf(rows, [OTHER])).toEqual([BOT])
  })

  it('says who got a key and who did not, in plain words', () => {
    const one = postKeysToasts({ epoch: 3, sent: [BOT], skipped: [] })
    expect(one).toHaveLength(1)
    expect(one[0]!.title).toMatch(/^Sent \S+ its key for members-only posts$/)
    expect(postKeysToasts({ epoch: 3, sent: [BOT, OTHER], skipped: [] })[0]!.title).toBe('Sent 2 bots their keys for members-only posts')
    const skipped = postKeysToasts({ epoch: 3, sent: [], skipped: [KEYLESS] })
    expect(skipped[0]!.tone).toBe('warn')
    expect(skipped[0]!.detail).toMatch(/no encryption key yet/)
    const failed = postKeysToasts({ epoch: 3, sent: [BOT], skipped: [OTHER], failed: 'the node refused the write' })
    expect(failed[1]!.detail).toMatch(/send the rest from the repo page/)
    expect(failed[1]!.detail).not.toContain('the node refused')
    expect(postKeysToasts({ epoch: 3, sent: [], skipped: [] })).toEqual([])
    for (const t of [...one, ...skipped, ...failed]) expect(`${t.title} ${t.detail ?? ''}`).not.toMatch(/sealed|lane|epoch|letter|reveal|disclos/i)
  })
})
