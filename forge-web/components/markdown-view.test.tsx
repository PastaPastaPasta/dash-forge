// @vitest-environment jsdom
/**
 * MarkdownView in a DOM: images anyone could write stay unloaded until the viewer asks (D-053),
 * and a README's relative images never inflate a blob past the byte cap (review of #82).
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { IMAGE_HOSTS_KEY } from '@/lib/view/markdown-links'
import { imageRepo, png } from '@/lib/view/image-repo-fixture'
import type { MarkdownRepoContext } from './markdown-view'

/** The README image cap (5 MiB), as the review of #82 set it. */
const IMAGE_CAP = 5 * 1024 * 1024

/**
 * The component, freshly imported for each test: the hosts a viewer loaded "this session" live
 * in module state, so a new import is a new session.
 */
let MarkdownView: typeof import('./markdown-view').MarkdownView

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

const newSession = async (): Promise<void> => {
  vi.resetModules()
  MarkdownView = (await import('./markdown-view')).MarkdownView
}

beforeEach(async () => {
  window.localStorage.clear()
  await newSession()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = async (el: JSX.Element): Promise<void> => {
  await act(async () => root.render(el))
}
const imgs = (): HTMLImageElement[] => [...host.querySelectorAll('img')]
const button = (name: RegExp): HTMLButtonElement => {
  const b = [...host.querySelectorAll('button')].find((x) => name.test(x.textContent ?? ''))
  if (b === undefined) throw new Error(`no button ${name}`)
  return b
}

describe('GatedImage (D-053)', () => {
  const SOURCE = '![a](https://img.example/a.png) ![b](https://img.example/b.png) ![c](https://other.example/c.png)'

  it('renders no <img> until the viewer loads that host', async () => {
    await render(<MarkdownView source={SOURCE} />)
    expect(imgs()).toHaveLength(0)
    expect(host.querySelectorAll('[data-testid="gated-image"]')).toHaveLength(3)

    await act(async () => button(/Load images from img\.example/).click())
    // Both images from that host load; the other host still waits.
    expect(imgs().map((i) => i.getAttribute('src'))).toEqual(['https://img.example/a.png', 'https://img.example/b.png'])
    expect(imgs().every((i) => i.getAttribute('referrerpolicy') === 'no-referrer')).toBe(true)
    expect(host.querySelectorAll('[data-testid="gated-image"]')).toHaveLength(1)
  })

  it('listens for another tab\'s "Always allow" once per page, not once per image', async () => {
    const add = vi.spyOn(window, 'addEventListener')
    await render(<MarkdownView source={Array.from({ length: 20 }, (_, i) => `![i${i}](https://img.example/${i}.png)`).join(' ')} />)
    expect(add.mock.calls.filter(([type]) => (type as string) === 'storage')).toHaveLength(1)
    // Another tab allows the host: every waiting image loads.
    window.localStorage.setItem(IMAGE_HOSTS_KEY, JSON.stringify(['img.example']))
    await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: IMAGE_HOSTS_KEY })))
    expect(imgs()).toHaveLength(20)
  })

  it('"Load" is for this session only; "Always allow" is remembered', async () => {
    await render(<MarkdownView source={SOURCE} />)
    await act(async () => button(/Load images from img\.example/).click())
    expect(window.localStorage.getItem(IMAGE_HOSTS_KEY)).toBeNull()

    await act(async () => button(/Always allow/).click())
    expect(JSON.parse(window.localStorage.getItem(IMAGE_HOSTS_KEY) ?? '[]')).toEqual(['other.example'])

    // A new session: only the always-allowed host loads without a click.
    act(() => root.unmount())
    await newSession()
    root = createRoot(host)
    await render(<MarkdownView source={SOURCE} />)
    expect(imgs().map((i) => i.getAttribute('src'))).toEqual(['https://other.example/c.png'])
  })

  it('loads the repo\'s own README images at once, asking for http images over https', async () => {
    await render(<MarkdownView source={'![x](http://i.imgur.com/x.png) <img src="http:\\\\a.example/y.png"> <img src="HTTP:b.example/z.png">'} images="auto" />)
    expect(imgs().map((i) => i.getAttribute('src'))).toEqual(['https://i.imgur.com/x.png', 'https://a.example/y.png', 'https://b.example/z.png'])
  })

  it('shows a link, not a blank box, for an image that fails to load', async () => {
    await render(<MarkdownView source="![Demo](https://gone.example/x.gif)" images="auto" />)
    await act(async () => imgs()[0]?.dispatchEvent(new Event('error')))
    expect(imgs()).toHaveLength(0)
    const link = host.querySelector('[data-testid="image-failed"]')
    expect(link?.getAttribute('href')).toBe('https://gone.example/x.gif')
    expect(link?.textContent).toContain('Demo')
  })
})

describe('anchors (review of #82)', () => {
  it('puts an id on the element itself, so tables and lists stay valid', async () => {
    await render(<MarkdownView source={'<table>\n<tr id="row1"><td id="Cell">x</td></tr>\n</table>\n\n<ul>\n<li id="item">y</li>\n</ul>'} />)
    expect(host.querySelector('tr')?.id).toBe('user-content-row1')
    expect(host.querySelector('td')?.id).toBe('user-content-cell')
    expect(host.querySelector('li')?.id).toBe('user-content-item')
    // Nothing but rows in the table body, nothing but items in the list.
    expect([...(host.querySelector('tbody, table')?.children ?? [])].every((c) => ['TBODY', 'TR'].includes(c.tagName))).toBe(true)
    expect([...(host.querySelector('ul')?.children ?? [])].every((c) => c.tagName === 'LI')).toBe(true)
  })

  it('puts bare <tr> rows in a <tbody>', async () => {
    const errors: unknown[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args))
    await render(<MarkdownView source={'<table>\n<tr><td>a</td></tr>\n<tr><td>b</td></tr>\n</table>'} />)
    spy.mockRestore()
    const table = host.querySelector('table')
    expect([...(table?.children ?? [])].map((c) => c.tagName)).toEqual(['TBODY'])
    expect(table?.querySelectorAll('tbody > tr')).toHaveLength(2)
    expect(errors.filter((e) => /validateDOMNesting|cannot be a child|cannot appear as a child/.test(String(e)))).toEqual([])
  })

  it('makes `<a name>` a target that an in-page link reaches, and keeps `<a href name>` a link', async () => {
    await render(<MarkdownView source={'<a name="install"></a>\n\n[Install](#install) and <a name="up" href="#top">top</a>'} />)
    expect(host.querySelector('a[href="#user-content-install"]')?.textContent).toBe('Install')
    expect(host.querySelector('#user-content-install')).not.toBeNull()
    expect(host.querySelector('#user-content-up')?.getAttribute('href')).toBe('#user-content-top')
    expect(host.querySelector('p:empty')).toBeNull()
  })
})

describe('RepoImage (review of #82)', () => {
  const MIB = 1024 * 1024
  const repoContext = (reader: MarkdownRepoContext['reader'], tipOid: string | undefined): MarkdownRepoContext => ({
    addr: { owner: 'o', name: 'r' },
    refParam: '',
    dir: '',
    reader,
    tipOid,
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20 && host.querySelector('.animate-pulse') !== null; i++) {
      await act(async () => new Promise((r) => setTimeout(r, 10)))
    }
  }

  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:fake')
    URL.revokeObjectURL = vi.fn()
  })

  it('inlines an image under the cap from the repo\'s own objects', async () => {
    const { reader, tipOid } = await imageRepo([{ name: 'logo.png', bytes: png(2048) }])
    await render(<MarkdownView source="![logo](logo.png)" images="auto" repo={repoContext(reader, tipOid)} />)
    await settle()
    expect(host.querySelector('[data-testid="repo-image"]')?.getAttribute('src')).toBe('blob:fake')
  })

  it('refuses a blob over the cap even when its stored size is small (delta-compressed)', async () => {
    const { reader, tipOid, oids } = await imageRepo([{ name: 'big.png', delta: { base: png(1024), size: IMAGE_CAP + MIB } }])
    expect(reader.locate(oids['big.png'] as string)?.length).toBeLessThan(4096)
    const read = vi.spyOn(reader, 'readObject')
    await render(<MarkdownView source="![big](big.png)" images="auto" repo={repoContext(reader, tipOid)} />)
    await settle()
    expect(host.querySelector('[data-testid="repo-image"]')).toBeNull()
    expect(host.querySelector('[data-testid="repo-image-link"]')?.textContent).toBe('big')
    // No read ever produced the 6 MiB blob: it was refused before it was inflated.
    const produced = await Promise.all(read.mock.results.map((r) => Promise.resolve(r.value).then((o: { bytes: Uint8Array }) => o.bytes.length, () => 0)))
    expect(Math.max(...produced)).toBeLessThanOrEqual(IMAGE_CAP)
    expect(read.mock.calls.some(([oid]) => oid === oids['big.png'])).toBe(true)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('links the blob instead of pulsing forever when the page has no reader', async () => {
    await render(<MarkdownView source="![logo](logo.png)" images="auto" repo={repoContext(undefined, undefined)} />)
    expect(host.querySelector('.animate-pulse')).toBeNull()
    expect(host.querySelector('[data-testid="repo-image-link"]')?.textContent).toBe('logo')
  })

  it('does not show the previous image while a new path loads, and reads each tree once', async () => {
    const { reader, tipOid } = await imageRepo([
      { name: 'a.png', bytes: png(100) },
      { name: 'b.png', bytes: png(200) },
      { name: 'c.png', bytes: png(300) },
    ])
    const read = vi.spyOn(reader, 'readObject')
    const ctx = repoContext(reader, tipOid)
    await render(<MarkdownView source="![a](a.png) ![b](b.png) ![c](c.png)" images="auto" repo={ctx} />)
    await settle()
    expect(host.querySelectorAll('[data-testid="repo-image"]')).toHaveLength(3)
    // One commit and one tree read for three images, then one read per blob.
    expect(read.mock.calls.filter(([oid]) => oid === tipOid)).toHaveLength(1)
    expect(read).toHaveBeenCalledTimes(5)

    await render(<MarkdownView source="![a](missing.png)" images="auto" repo={ctx} />)
    expect(host.querySelector('[data-testid="repo-image"]')).toBeNull()
  })
})
