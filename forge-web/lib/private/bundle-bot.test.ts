/**
 * A bot's members-only post (`enc` v0x05) in a maintainer's make-public bundle: its `K_obj`
 * (`membersObjKey`) opens it for any reader, as a v0x03 post's does (forge-core `bundle::read_revision`).
 */

import { describe, expect, it } from 'vitest'

import { PostKey } from './bot-post'
import { readRevision } from './bundle'
import { V5, membersObjKey, type PrivateDoc } from './doc'
import { privateId } from './ids'
import { EpochKeys } from './keys'
import { sealBotPostWithNonce } from './testing'

const REPO = new Uint8Array(32).fill(0x11)
const BOT = new Uint8Array(32).fill(0xb0)
const MAINTAINER = privateId('c'.repeat(64))
const WRONG_KEY = new Uint8Array(32).fill(0x77)

const doc: PrivateDoc = { type: 'comment', vis: 'public', ownerId: BOT, epoch: 0, targetId: new Uint8Array(32).fill(0x33) }

async function sealed(): Promise<{ enc: Uint8Array; key: Uint8Array }> {
  const keys = await EpochKeys.import(REPO, 0, new Uint8Array(32).fill(0x42))
  const post = await PostKey.derive(keys, BOT)
  const { enc } = await sealBotPostWithNonce(post, doc, { body: 'ran the nightly build' }, new Uint8Array(12).fill(7))
  const key = await membersObjKey(keys, doc, enc)
  expect(key).not.toBeNull()
  return { enc, key: key as Uint8Array }
}

describe('a bot post in a make-public bundle', () => {
  it('opens as public with the entry key of its revision', async () => {
    const { enc, key } = await sealed()
    expect(enc[0]).toBe(V5)
    const { read, alerts } = await readRevision(REPO, doc, 1, enc, [{ by: MAINTAINER, revision: 1, key }])
    expect(alerts).toEqual([])
    expect(read).toMatchObject({ state: 'public', by: MAINTAINER, fields: { body: 'ran the nightly build' } })
  })

  it('flags an entry whose key does not commit to it, and leaves the post unread', async () => {
    const { enc } = await sealed()
    const { read, alerts } = await readRevision(REPO, doc, 1, enc, [{ by: MAINTAINER, revision: 1, key: WRONG_KEY }])
    expect(read).toEqual({ state: 'none' })
    expect(alerts).toEqual([{ by: MAINTAINER, revision: 1 }])
  })
})
