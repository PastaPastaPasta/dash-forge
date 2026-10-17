/**
 * The operator's pause end to end (INC-06): the build variables `NEXT_PUBLIC_PAGES_NOTICE=paused`
 * and `_TEXT` reach `assertWritesAllowed`, which refuses a broadcast before anything is signed,
 * on any network (this build reads the default, testnet). An advisory pauses nothing, and a typo
 * in the variable fails the build (the module throws when it loads).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

async function writeModule(env: Record<string, string>) {
  vi.resetModules()
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  return import('./write')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('NEXT_PUBLIC_PAGES_NOTICE', () => {
  it('paused: every broadcast is refused with the operator reason', async () => {
    const { WritesPausedError, assertWritesAllowed, createDocumentIdempotent } = await writeModule({
      NEXT_PUBLIC_PAGES_NOTICE: 'paused',
      NEXT_PUBLIC_PAGES_NOTICE_TEXT: 'A signing bug is being fixed.',
    })
    expect(() => assertWritesAllowed()).toThrow(WritesPausedError)
    expect(() => assertWritesAllowed()).toThrow('Writing is paused: A signing bug is being fixed.')
    await expect(createDocumentIdempotent({} as never, { identityId: 'id-paused' } as never, {} as never)).rejects.toThrow(WritesPausedError)
  })

  it('advisory: writes stay on', async () => {
    const { assertWritesAllowed } = await writeModule({ NEXT_PUBLIC_PAGES_NOTICE: 'advisory' })
    expect(() => assertWritesAllowed()).not.toThrow()
  })

  it('a typo fails the build', async () => {
    await expect(writeModule({ NEXT_PUBLIC_PAGES_NOTICE: 'pause' })).rejects.toThrow(/invalid NEXT_PUBLIC_PAGES_NOTICE "pause"/)
  })
})
