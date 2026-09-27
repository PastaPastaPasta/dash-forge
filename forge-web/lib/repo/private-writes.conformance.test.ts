/**
 * The shared `private_collab_seal` vectors (`forge-contracts/vectors/`, the CLI's
 * `collab::private::seal_props`) through the web's real sealing path, `sealContent` in
 * `lib/repo/private-writes.ts` (what `sealForRepo` runs after reading the write key), with the
 * vector's fixed nonce. Where `lib/private/conformance.test.ts` pins the reference transform,
 * this pins the code that writes: a document the web posts is byte for byte the CLI's.
 *
 * Props in the vectors: ids and byte arrays are lowercase hex; the public writers hand
 * `sealForRepo` ids as base58 or bytes and byte arrays as bytes, so the runner converts in, and
 * compares hex out.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { EpochKeys, TooLargeError, bytesToHex, hexToBytes, type PrivateDocType } from '../private'
import { sealDocWithNonce } from '../private/testing'
import { sealContent } from './private-writes'

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
type Obj = { [k: string]: Json }

/** Props the writers hand over as bytes (ids and byte arrays), hex in the vectors. */
const BYTE_PROPS = new Set(['targetId', 'patchId', 'sourceRepoId', 'replyTo', 'reviewId', 'headOid', 'commitOid', 'patchManifestHash', 'baseRefNameHash', 'sourceRefNameHash', 'enc'])

const DIR = resolve(process.cwd(), '..', 'forge-contracts', 'vectors')
const FILES = readdirSync(DIR)
  .filter((f) => f.startsWith('private_collab_seal__') && f.endsWith('.json'))
  .sort()

function toWriter(props: Obj): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(props)) out[k] = BYTE_PROPS.has(k) && typeof v === 'string' ? hexToBytes(v) : v
  return out
}

function toJson(props: Record<string, unknown>): Json {
  const out: Obj = {}
  for (const [k, v] of Object.entries(props)) out[k] = v instanceof Uint8Array ? bytesToHex(v) : (v as Json)
  return out
}

describe('the shared private_collab_seal vectors through the web writer', () => {
  it('finds them', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(19)
  })

  for (const f of FILES) {
    const v = JSON.parse(readFileSync(resolve(DIR, f), 'utf8')) as { name: string; input: Obj; expected: Obj }
    it(v.name, async () => {
      const inp = v.input
      const keys = await EpochKeys.import(hexToBytes(inp['repoId'] as string), inp['epoch'] as number, hexToBytes(inp['key'] as string))
      const nonce = hexToBytes(inp['nonce'] as string)
      const run = sealContent(keys, inp['docType'] as PrivateDocType, hexToBytes(inp['ownerId'] as string), toWriter(inp['props'] as Obj), async (k, doc, fields) => (await sealDocWithNonce(k, doc, fields, nonce)).enc)
      if ('error' in v.expected) {
        expect(v.expected['error']).toBe('tooLarge')
        await expect(run).rejects.toBeInstanceOf(TooLargeError)
      } else {
        expect(toJson(await run)).toEqual(v.expected['props'])
      }
    })
  }
})
