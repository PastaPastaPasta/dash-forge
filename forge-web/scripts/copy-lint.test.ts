import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MAX_WORDS, extractFile, lint, violations } from './copy-lint.mjs'

interface Entry {
  file: string
  line: number
  kind: string
  text: string
}

const dir = mkdtempSync(join(tmpdir(), 'copy-lint-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function extract(name: string, src: string): Entry[] {
  const path = join(dir, name)
  writeFileSync(path, src)
  return extractFile(path, dir) as Entry[]
}

const ids = (text: string, kind = 'str'): string[] => violations({ file: 'x', line: 1, kind, text }).map((v: { id: string }) => v.id)

describe('copy lint rules', () => {
  it('flags internal identifiers and banned phrases', () => {
    expect(ids('Folded by FORGE_RULES_V2 from the update log')).toEqual(['code-identifier', 'fold'])
    expect(ids('This repo has no objectLocator yet')).toEqual(['code-identifier'])
    expect(ids('A forge-v2 repo is a repo document')).toEqual(['release-name', 'document'])
    expect(ids('Platform refused it: a client rule')).toEqual(['client-rule', 'banned-phrase'])
    expect(ids('Pushed 3 file(s)')).toEqual(['lazy-plural'])
    expect(ids('See docs/guides/costs.md for prices')).toEqual(['doc-path'])
  })

  it('passes plain product copy', () => {
    expect(ids('Only maintainers can merge into this branch.')).toEqual([])
    expect(ids('Someone changed this while you were editing. Reload and try again.')).toEqual([])
  })

  it(`fails a string over ${MAX_WORDS} words, but not a text node inside a paragraph`, () => {
    const long = Array.from({ length: MAX_WORDS + 1 }, () => 'word').join(' ')
    expect(ids(long)).toEqual(['too-long'])
    expect(ids(long, 'jsx-in-paragraph')).toEqual([])
    expect(ids(Array.from({ length: MAX_WORDS }, () => 'word').join(' '))).toEqual([])
  })
})

describe('copy lint extraction', () => {
  it('reads JSX text, prose attributes and messages, and skips code', () => {
    const found = extract(
      'a.tsx',
      `export function A() {
  const cls = 'flex items-center gap-2'
  if (window.location.pathname.startsWith('/repo with spaces')) throw new Error('This repo was not found here.')
  return <p className={cls} title="Copy the clone command">Hello <b>there</b> reader.</p>
}
`,
    ).map((e) => `${e.kind}:${e.text}`)
    expect(found).toContain('str:This repo was not found here.')
    expect(found).toContain('attr:title:Copy the clone command')
    expect(found).toContain('paragraph:Hello there reader.')
    expect(found.some((f) => f.includes('flex items-center'))).toBe(false)
    expect(found.some((f) => f.includes('repo with spaces'))).toBe(false)
  })

  it('checks the copy in a template interpolation', () => {
    const found = extract('t.ts', "export const s = (n: number) => `Your star is saved${n ? ' and the consensus rule counts it' : ''}.`\n")
    expect(found.map((e) => e.text)).toContain('and the consensus rule counts it')
  })

  it('honours line and file opt-outs', () => {
    const line = extract('b.ts', `// copy-lint-ignore: developer error\nthrow new Error('the packManifest is missing here')\n`)
    expect(line).toEqual([])
    const file = extract('c.ts', `// copy-lint-ignore-file: test helper\nthrow new Error('the packManifest is missing here')\n`)
    expect(file).toEqual([])
  })

  it('lints a tree of source directories', () => {
    mkdirSync(join(dir, 'app'), { recursive: true })
    writeFileSync(join(dir, 'app', 'page.tsx'), `export default () => <p>Loading the starBeat for you</p>\n`)
    const found = lint(dir) as Array<Entry & { id: string }>
    expect(found.map((f) => `${f.file}:${f.id}`)).toEqual(['app/page.tsx:code-identifier'])
  })
})

describe('the shipped web copy', () => {
  it('passes the copy lint', () => {
    const found = (lint() as Array<Entry & { id: string }>).map((f) => `${f.file}:${f.line} [${f.id}] ${f.text.slice(0, 80)}`)
    expect(found).toEqual([])
  })
})
