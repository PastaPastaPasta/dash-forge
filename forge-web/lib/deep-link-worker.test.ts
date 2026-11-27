/**
 * The deep-link Worker: the committed file is the generator's output, and it answers a short
 * URL's 404 with 200 while passing everything else through untouched.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deepLinkWorkerSource } from './deep-link-worker'

const FILE = resolve(__dirname, '../../infra/pages-deep-links/worker.js')

type Worker = { fetch: (r: Request) => Promise<Response> }

async function load(): Promise<Worker> {
  const url = `data:text/javascript;base64,${Buffer.from(deepLinkWorkerSource()).toString('base64')}`
  return ((await import(/* @vite-ignore */ url)) as { default: Worker }).default
}

function origin(status: number, body = '<!doctype html>404 page'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'max-age=600', etag: '"x"' } })),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('deep-link worker', () => {
  it('the committed worker.js is the generated source', () => {
    if (process.env['UPDATE_DEEP_LINK_WORKER'] === '1') writeFileSync(FILE, deepLinkWorkerSource())
    expect(readFileSync(FILE, 'utf8')).toBe(deepLinkWorkerSource())
  })

  it.each(['/alice/project', '/alice.dash/project/issues/7', '/alice/project/tree/main/src', '/alice/project.git', '/github.com/dashpay/platform', '/alice/project/pull/3/files'])(
    'a short URL %s that Pages answers 404 gets 200, with the same body and headers',
    async (path) => {
      origin(404)
      const res = await (await load()).fetch(new Request(`https://forge.example${path}`))
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('<!doctype html>404 page')
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(res.headers.get('cache-control')).toBe('max-age=600')
    },
  )

  it.each(['/nope', '/alice/project/nonsense/x/y', '/_next/static/x.js', '/icons/missing.png', '/explore/x', '/.hidden/x', '/alice/project/issues/abc'])(
    'a path the shim refuses (%s) keeps its 404',
    async (path) => {
      origin(404)
      expect((await (await load()).fetch(new Request(`https://forge.example${path}`))).status).toBe(404)
    },
  )

  it('passes other statuses and methods through untouched', async () => {
    const w = await load()
    origin(200, 'home')
    const ok = await w.fetch(new Request('https://forge.example/'))
    expect([ok.status, await ok.text()]).toEqual([200, 'home'])
    origin(301)
    expect((await w.fetch(new Request('https://forge.example/settings'))).status).toBe(301)
    origin(404)
    expect((await w.fetch(new Request('https://forge.example/alice/project', { method: 'POST' }))).status).toBe(404)
  })

  it('HEAD of a short URL gets 200', async () => {
    origin(404)
    expect((await (await load()).fetch(new Request('https://forge.example/alice/project', { method: 'HEAD' }))).status).toBe(200)
  })
})
