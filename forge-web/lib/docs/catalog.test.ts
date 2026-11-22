import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { DOCS } from '../docs-links'
import { parseMarkdown, type Block, type Inline } from '../view'
import { outline } from '../../components/docs/outline'
import { DOC_PAGES, DOCS_INDEX, docBySlug, docRoute, resolveDocHref } from './catalog'
import { splitTitle } from './source'

const ROOT = join(__dirname, '../../..')
const page = (slug: string) => docBySlug(slug)!

describe('the docs catalog', () => {
  it('lists each file and slug once, and every file exists', () => {
    expect(new Set(DOC_PAGES.map((p) => p.slug)).size).toBe(DOC_PAGES.length)
    expect(new Set(DOC_PAGES.map((p) => p.path)).size).toBe(DOC_PAGES.length)
    for (const p of DOC_PAGES) expect(existsSync(join(ROOT, p.path)), p.path).toBe(true)
  })

  it('routes the index to /docs/ and the rest to /docs/<slug>/', () => {
    expect(docRoute(DOCS_INDEX)).toBe('/docs/')
    expect(docRoute(page('costs'), 'what-each-action-costs')).toBe('/docs/costs/#what-each-action-costs')
  })

  it('every in-app help link names a listed page, and a heading that exists on it', () => {
    const fragments = [...Object.values(DOCS), `${DOCS.identity}#what-an-identity-is`, `${DOCS.identity}#replacing-it-after-a-lost-device`, `${DOCS.identity}#passkeys-for-other-devices`]
    for (const href of fragments) {
      if (!href.startsWith('/')) continue
      const [path, fragment = ''] = href.split('#')
      const p = docBySlug(path!.replace(/^\/docs\/?/, '').replace(/\/$/, ''))
      expect(p, href).toBeDefined()
      if (fragment === '') continue
      const ids = outline(splitTitle(readFileSync(join(ROOT, p!.path), 'utf8'), '').body).map((h) => h.id)
      expect(ids, href).toContain(`user-content-${fragment}`)
    }
  })
})

describe('resolveDocHref', () => {
  it('keeps a link to a listed document in the app, with its fragment', () => {
    expect(resolveDocHref(page('quick-start'), 'costs.md')).toEqual({ internal: '/docs/costs/' })
    expect(resolveDocHref(page('quick-start'), 'identity-and-keys.md#limited-keys')).toEqual({ internal: '/docs/identity-and-keys/#limited-keys' })
    expect(resolveDocHref(page('quick-start'), '../errors.md#e601')).toEqual({ internal: '/docs/errors/#e601' })
    expect(resolveDocHref(page('quick-start'), 'README.md#which-network')).toEqual({ internal: '/docs/#which-network' })
    expect(resolveDocHref(page('faq'), 'guides/quick-start.md')).toEqual({ internal: '/docs/quick-start/' })
    expect(resolveDocHref(page('audiences'), '../guides/collaborating.md')).toEqual({ internal: '/docs/collaborating/' })
  })

  it('sends any other repository file to GitHub', () => {
    expect(resolveDocHref(DOCS_INDEX, '../../README.md#document-index')).toEqual({
      external: 'https://github.com/PastaPastaPasta/dash-forge/blob/master/README.md#document-index',
    })
    expect(resolveDocHref(DOCS_INDEX, '../design/ux-dx-spec.md')).toEqual({ external: 'https://github.com/PastaPastaPasta/dash-forge/blob/master/docs/design/ux-dx-spec.md' })
    expect(resolveDocHref(page('quick-start'), '../../crates/')).toEqual({ external: 'https://github.com/PastaPastaPasta/dash-forge/tree/master/crates' })
  })

  it('leaves URLs, mail links, in-page anchors and paths out of the repository to the renderer', () => {
    for (const href of ['https://example.com/x.md', 'mailto:a@b.c', '#limits', '//cdn.example/x', '../../../etc/passwd']) {
      expect(resolveDocHref(page('quick-start'), href), href).toBeNull()
    }
  })

  it('resolves every relative link in every listed document to a file that exists', () => {
    const hrefs = (nodes: readonly (Block | Inline)[]): string[] =>
      nodes.flatMap((n) => {
        const own = 'href' in n && typeof n.href === 'string' ? [n.href] : []
        const kids = Object.values(n).flatMap((v) => (Array.isArray(v) ? hrefs(v.flat(2).filter((x): x is Block | Inline => typeof x === 'object' && x !== null && 't' in x)) : []))
        return [...own, ...kids]
      })
    for (const p of DOC_PAGES) {
      for (const href of hrefs(parseMarkdown(readFileSync(join(ROOT, p.path), 'utf8')))) {
        const r = resolveDocHref(p, href)
        if (r === null || 'internal' in r) continue
        const file = r.external.replace(/^https:\/\/github\.com\/PastaPastaPasta\/dash-forge\/(blob|tree)\/master\//, '').replace(/#.*$/, '')
        expect(existsSync(join(ROOT, file)), `${p.path}: ${href}`).toBe(true)
      }
    }
  })
})

describe('splitTitle', () => {
  it('takes the leading # heading as the title', () => {
    expect(splitTitle('# Quick start\n\nBody', 'x')).toEqual({ title: 'Quick start', body: 'Body' })
  })
  it('keeps a document without one whole, under the catalog title', () => {
    expect(splitTitle('Intro\n# Later', 'Fallback')).toEqual({ title: 'Fallback', body: 'Intro\n# Later' })
  })
})
