import { describe, expect, it } from 'vitest'

import { MODE_TREE } from '../browse'
import type { TreeEntry } from './git-objects'
import { locatePullTemplates, namedTemplate } from './pull-templates'

const file = (name: string, oid = name): TreeEntry => ({ name, mode: 0o100644, oid })
const dir = (name: string): TreeEntry => ({ name, mode: MODE_TREE, oid: `tree:${name}` })

/** A directory reader over a fixed listing. */
const listing = (dirs: Record<string, TreeEntry[]>) => async (d: string) => dirs[d] ?? null

describe('PR templates', () => {
  it('takes GitHub’s single template as the default, .github before the root and docs/', async () => {
    const got = await locatePullTemplates(
      listing({
        '': [file('PULL_REQUEST_TEMPLATE.md', 'root'), dir('.github'), dir('docs')],
        '.github': [file('pull_request_template.md', 'gh')],
        docs: [file('pull_request_template.md', 'docs')],
      }),
    )
    expect(got).toEqual({ files: [{ path: '.github/pull_request_template.md', oid: 'gh' }], defaultPath: '.github/pull_request_template.md' })
  })

  it('lists a PULL_REQUEST_TEMPLATE directory, with no default of its own', async () => {
    const got = await locatePullTemplates(
      listing({
        '': [dir('.github')],
        '.github': [dir('PULL_REQUEST_TEMPLATE')],
        '.github/PULL_REQUEST_TEMPLATE': [file('feature.md'), file('bug.md'), file('notes.txt'), dir('nested.md')],
      }),
    )
    expect(got.files.map((f) => f.path)).toEqual(['.github/PULL_REQUEST_TEMPLATE/bug.md', '.github/PULL_REQUEST_TEMPLATE/feature.md'])
    expect(got.defaultPath).toBeNull()
  })

  it('reads GitLab’s merge request templates, Default.md the default when GitHub has none', async () => {
    const gitlab = { '.gitlab/merge_request_templates': [file('Security.md'), file('Default.md')] }
    expect(await locatePullTemplates(listing({ '': [], ...gitlab }))).toEqual({
      files: [
        { path: '.gitlab/merge_request_templates/Default.md', oid: 'Default.md' },
        { path: '.gitlab/merge_request_templates/Security.md', oid: 'Security.md' },
      ],
      defaultPath: '.gitlab/merge_request_templates/Default.md',
    })
    const both = await locatePullTemplates(listing({ '': [file('pull_request_template.md', 'root')], ...gitlab }))
    expect(both.defaultPath).toBe('pull_request_template.md')
    expect(both.files).toHaveLength(3)
  })

  it('finds the template a ?template= link names, by file name or path', () => {
    const ts = [
      { file: '.github/PULL_REQUEST_TEMPLATE/bug.md', name: 'bug', body: 'B' },
      { file: '.gitlab/merge_request_templates/Default.md', name: 'Default', body: 'D' },
    ]
    expect(namedTemplate(ts, 'BUG.md')?.body).toBe('B')
    expect(namedTemplate(ts, '.gitlab/merge_request_templates/default.md')?.body).toBe('D')
    expect(namedTemplate(ts, 'missing.md')).toBeNull()
    expect(namedTemplate(ts, '')).toBeNull()
  })
})
