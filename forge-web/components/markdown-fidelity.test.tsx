// @vitest-environment jsdom
/**
 * FG-2 in a DOM: root-relative README links (L-12), autolinks and imported mentions (L-38,
 * L-39, L-40, L-51, L-67), comment-mode breaks (L-41), footnotes, alerts and mermaid (L-75),
 * and wrapping of long unbroken strings (L-52).
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Store, MODE_TREE } from '@/lib/view/diff-fixtures'
import type { BrowseReader } from '@/lib/browse'
import { LinkifiedText, MarkdownView, type MarkdownRepoContext } from './markdown-view'
import { repoLinks } from './repo/target-href'

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

beforeEach(() => {
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
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 5)))
}
const hrefs = (sel = 'a'): string[] => [...host.querySelectorAll(sel)].map((a) => a.getAttribute('href') ?? '')
const link = (text: string): HTMLAnchorElement => {
  const a = [...host.querySelectorAll('a')].find((x) => x.textContent === text)
  if (a === undefined) throw new Error(`no link "${text}" in ${host.innerHTML}`)
  return a
}

const ADDR = { owner: 'mirror', name: 'dash' }
const MIRROR = repoLinks(ADDR, { host: 'github.com', path: 'dashpay/dash' })
const NATIVE = repoLinks(ADDR, null)
const IMPORTED = 'https://github.com/dashpay/dash/issues/7512'

describe('root-relative README links (L-12)', () => {
  /** A repo whose root holds `doc/` (with build-unix.md), `test/`, `src/test/README.md` and `CONTRIBUTING.md`. */
  const repo = (): MarkdownRepoContext => {
    const s = new Store()
    const tree = s.files({ 'doc/build-unix.md': 'x', 'test/run.py': 'x', 'src/test/README.md': 'x', 'CONTRIBUTING.md': 'x', 'COPYING': 'x' })
    const tip = s.commit(tree)
    return { addr: ADDR, refParam: 'v24.0.0', dir: '', reader: s.reader() as unknown as BrowseReader, tipOid: tip }
  }

  it('resolves "/" against the repo root at the current ref: a folder to the tree view, a file to the blob view', async () => {
    const ctx = repo()
    await render(
      <MarkdownView
        source={'[doc folder](/doc) [build](/doc/build-unix.md) [tests](/src/test/README.md) [functional](/test) [contrib](CONTRIBUTING.md) [license](/COPYING) [up](/doc/../../x)'}
        repo={ctx}
      />,
    )
    await settle()
    expect(link('doc folder').getAttribute('href')).toBe('/repo/tree/?owner=mirror&name=dash&path=doc&ref=v24.0.0')
    expect(link('build').getAttribute('href')).toBe('/repo/blob/?owner=mirror&name=dash&path=doc%2Fbuild-unix.md&ref=v24.0.0')
    expect(link('tests').getAttribute('href')).toBe('/repo/blob/?owner=mirror&name=dash&path=src%2Ftest%2FREADME.md&ref=v24.0.0')
    expect(link('functional').getAttribute('href')).toBe('/repo/tree/?owner=mirror&name=dash&path=test&ref=v24.0.0')
    expect(link('contrib').getAttribute('href')).toContain('/repo/blob/')
    // An extensionless file stays a blob.
    expect(link('license').getAttribute('href')).toBe('/repo/blob/?owner=mirror&name=dash&path=COPYING&ref=v24.0.0')
    // Climbing out of the repo links nowhere; nothing is a bare site path.
    expect(host.textContent).toContain('up')
    expect(hrefs().filter((h) => /^\/(doc|src|test|COPYING)/.test(h))).toEqual([])
  })

  it('resolves "/" from a nested .md file against the root, not its directory', async () => {
    await render(<MarkdownView source="[notes](/doc/release-notes.md) [sib](build-unix.md)" repo={{ addr: ADDR, refParam: '', dir: 'doc' }} />)
    expect(link('notes').getAttribute('href')).toBe('/repo/blob/?owner=mirror&name=dash&path=doc%2Frelease-notes.md')
    expect(link('sib').getAttribute('href')).toBe('/repo/blob/?owner=mirror&name=dash&path=doc%2Fbuild-unix.md')
  })

  it('a "/" link in imported content (no repo file) is the source forge\'s site path', async () => {
    await render(<MarkdownView source="[pr](/dashpay/dash/pull/1)" links={MIRROR} imported={IMPORTED} />)
    expect(link('pr').getAttribute('href')).toBe('https://github.com/dashpay/dash/pull/1')
  })

  it('still refuses unsafe hrefs', async () => {
    await render(<MarkdownView source="[a](javascript:alert(1)) [b](//evil.example/x)" repo={repo()} links={MIRROR} imported={IMPORTED} />)
    expect(hrefs()).toEqual([])
  })
})

describe('autolinks (L-39, L-40, L-51)', () => {
  it('#N goes to the number resolver, not straight to the issue route', async () => {
    await render(<MarkdownView source="see #7669" links={NATIVE} />)
    expect(link('#7669').getAttribute('href')).toBe('/repo/number/?owner=mirror&name=dash&number=7669')
  })

  it('in imported content #N is the source\'s number, and other repos go to the source forge', async () => {
    await render(<MarkdownView source="| dashpay/dash#7511 | dashpay/platform#4344 | 1898d8f7ac7 | (#5017) |\n|-|-|-|-|" links={MIRROR} imported={IMPORTED} />)
    expect(link('dashpay/dash#7511').getAttribute('href')).toBe('/repo/number/?owner=mirror&name=dash&number=7511&upstream=1')
    expect(link('dashpay/platform#4344').getAttribute('href')).toBe('https://github.com/dashpay/platform/issues/4344')
    expect(link('dashpay/platform#4344').getAttribute('target')).toBe('_blank')
    expect(link('1898d8f').getAttribute('href')).toBe('/repo/commit/?owner=mirror&name=dash&oid=1898d8f7ac7')
    expect(link('#5017').getAttribute('href')).toContain('number=5017&upstream=1')
  })

  it('leaves references as text where the page gives no links', async () => {
    await render(<MarkdownView source="#12 @alice 1898d8f7ac7" />)
    expect(hrefs()).toEqual([])
  })
})

describe('mentions (L-38)', () => {
  it('an imported @login links to GitHub, never to a Forge profile anyone could register', async () => {
    await render(<MarkdownView source="> Mirrored from github.com/dashpay/dash#6935 by @coffseducation (issue)\n\nthanks @PastaPastaPasta and @coderabbitai[bot]" links={MIRROR} imported={IMPORTED} />)
    expect(link('@coffseducation').getAttribute('href')).toBe('https://github.com/coffseducation')
    expect(link('@PastaPastaPasta').getAttribute('href')).toBe('https://github.com/PastaPastaPasta')
    expect(link('@coderabbitai[bot]').getAttribute('href')).toBe('https://github.com/apps/coderabbitai')
    expect(hrefs().some((h) => h.startsWith('/u/'))).toBe(false)
  })

  it('a native @name links to the Forge profile', async () => {
    await render(<MarkdownView source="thanks @Alice" links={MIRROR} />)
    expect(link('@Alice').getAttribute('href')).toBe('/u/?name=alice')
  })

  it('an imported record naming an arbitrary host is not believed (native links)', async () => {
    await render(<MarkdownView source="@bob" links={NATIVE} imported="https://evil.example/o/r/issues/1" />)
    expect(link('@bob').getAttribute('href')).toBe('/u/?name=bob')
  })
})

describe('commit messages (L-67)', () => {
  it('link #N, commit ids and URLs; a mirror\'s mentions go upstream', async () => {
    await render(<LinkifiedText text={'Merge #7760: fix(qt): x\n\n3ba0805c0e36 fix\nSee https://github.com/dashpay/dash/pull/7760.\nACK @UdjinM6'} links={MIRROR} imported="https://github.com/dashpay/dash" />)
    expect(link('#7760').getAttribute('href')).toContain('/repo/number/')
    expect(link('3ba0805').getAttribute('href')).toContain('/repo/commit/')
    expect(link('https://github.com/dashpay/dash/pull/7760').getAttribute('href')).toBe('https://github.com/dashpay/dash/pull/7760')
    expect(link('@UdjinM6').getAttribute('href')).toBe('https://github.com/UdjinM6')
    // No Markdown: the text is kept as written.
    expect(host.textContent).toContain('Merge #7760: fix(qt): x')
  })
})

describe('comment vs document mode (L-41)', () => {
  it('a comment breaks single newlines; a README does not', async () => {
    await render(<MarkdownView source={'Line one\nline two'} />)
    expect(host.querySelectorAll('br')).toHaveLength(1)
    await render(<MarkdownView source={'Line one\nline two'} repo={{ addr: ADDR, refParam: '', dir: '' }} />)
    expect(host.querySelectorAll('br')).toHaveLength(0)
    await render(<MarkdownView source={'Line one\nline two'} mode="document" />)
    expect(host.querySelectorAll('br')).toHaveLength(0)
  })

  it('a list keeps its continuation lines and nests sub-lists inside the item', async () => {
    await render(<MarkdownView source={'1. item\n   continuation\n2. two\n   - nested'} />)
    const items = host.querySelectorAll('ol > li')
    expect(items).toHaveLength(2)
    expect(items[0]?.textContent).toBe('itemcontinuation')
    expect(items[0]?.querySelectorAll('br')).toHaveLength(1)
    expect(items[1]?.querySelector('ul > li')?.textContent).toBe('nested')
  })

  it('a setext README title is an h2-styled heading with a GitHub anchor', async () => {
    await render(<MarkdownView source={'Dash Core staging tree\n===\n\nWhat is Dash?\n---\n\nx'} repo={{ addr: ADDR, refParam: '', dir: '' }} />)
    expect([...host.querySelectorAll('h2')].map((h) => h.id)).toEqual(['user-content-dash-core-staging-tree', 'user-content-what-is-dash'])
    expect(host.querySelectorAll('hr')).toHaveLength(0)
  })
})

describe('footnotes, alerts, emoji, mermaid (L-75)', () => {
  it('links footnote references and back, with ids unique to each body on the page', async () => {
    await render(
      <>
        <MarkdownView source={'A[^1].\n\n[^1]: note'} />
        <MarkdownView source={'B[^1].\n\n[^1]: other'} />
      </>,
    )
    const refs = [...host.querySelectorAll('a[data-footnote-ref]')]
    expect(refs).toHaveLength(2)
    const [a, b] = refs.map((r) => r.getAttribute('href') ?? '')
    expect(a).not.toBe(b)
    // Each ref points at its own note, and each note's back link at its ref.
    for (const r of refs) {
      const note = host.querySelector(`[id="${(r.getAttribute('href') ?? '').slice(1)}"]`)
      expect(note?.textContent).toMatch(/^(note|other)/)
      expect(note?.querySelector('a[data-footnote-backref]')?.getAttribute('href')).toBe(`#${r.id}`)
    }
  })

  it('renders an alert with its title, and a plain quote otherwise', async () => {
    await render(<MarkdownView source={'> [!WARNING]\n> Careful\n\n> plain'} />)
    const alert = host.querySelector('[data-alert="warning"]')
    expect(alert?.textContent?.trim()).toBe('WarningCareful')
    expect(alert?.getAttribute('role')).toBe('note')
    expect(host.querySelectorAll('blockquote')).toHaveLength(1)
  })

  it('shows emoji for shortcodes', async () => {
    await render(<MarkdownView source=":+1: :rocket:" />)
    expect(host.textContent).toBe('👍 🚀')
  })

  it('shows a mermaid block as its source with a note, and runs nothing', async () => {
    await render(<MarkdownView source={'```mermaid\ngraph TD; A-->B<script>x</script>\n```'} />)
    const fig = host.querySelector('[data-testid="mermaid"]')
    expect(fig?.querySelector('code')?.textContent).toBe('graph TD; A-->B<script>x</script>')
    expect(fig?.textContent).toContain('Mermaid diagram')
    expect(host.querySelector('script, svg[role="img"]')).toBeNull()
  })
})

describe('long unbroken strings wrap (L-52)', () => {
  it('paragraphs, list items and inline code may break anywhere', async () => {
    const magnet = 'magnet:?xt=urn:btih:80dacfd086505afe3bb57b36adb2cc360b2c2431&dn=dashcore-22.1.2&tr=udp%3a%2f%2ftracker.opentrackr.org'
    await render(<MarkdownView source={`- torrent: ${magnet}\n\n\`${magnet}\`\n\n${magnet}`} />)
    for (const el of [host.querySelector('li'), host.querySelector('code'), host.querySelector('p')]) {
      expect(el?.className).toContain('[overflow-wrap:anywhere]')
    }
  })
})

describe('the tree-mode fixture', () => {
  it('names directories with MODE_TREE (sanity for the L-12 lookups)', () => {
    expect(MODE_TREE).toBe(0o040000)
  })
})
