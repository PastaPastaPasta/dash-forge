import { describe, expect, it } from 'vitest'

import { MODE_TREE } from '../browse'
import { applyTemplate, parseIssueTemplate, templateFiles } from './issue-templates'

describe('issue templates', () => {
  it('reads GitHub front matter and the body', () => {
    const t = parseIssueTemplate(
      'bug_report.md',
      ['---', 'name: Bug report', "about: 'Something broke'", 'title: "[bug] "', 'labels: bug, triage', 'assignees: ""', '---', '', '**Steps**', '1.'].join('\n'),
    )
    expect(t).toEqual({ file: 'bug_report.md', name: 'Bug report', about: 'Something broke', title: '[bug] ', labels: ['bug', 'triage'], body: '**Steps**\n1.' })
  })

  it('reads a list of labels', () => {
    const t = parseIssueTemplate('f.md', ['---', 'name: Feature', 'labels:', '  - enhancement', "  - 'good first issue'", '---', 'Body'].join('\n'))
    expect(t.labels).toEqual(['enhancement', 'good first issue'])
    expect(parseIssueTemplate('g.md', '---\nlabels: [a, b]\n---\nx').labels).toEqual(['a', 'b'])
  })

  it('treats a file without front matter as all body, named after the file', () => {
    expect(parseIssueTemplate('question.md', 'Ask away')).toEqual({ file: 'question.md', name: 'question', about: '', title: '', labels: [], body: 'Ask away' })
    expect(parseIssueTemplate('x.md', '---\nname: open front matter').name).toBe('x')
  })

  it('lists markdown files only, skipping directories and config', () => {
    const entries = [
      { name: 'b.md', mode: 0o100644, oid: '1' },
      { name: 'a.markdown', mode: 0o100644, oid: '2' },
      { name: 'config.yml', mode: 0o100644, oid: '3' },
      { name: 'config.md', mode: 0o100644, oid: '4' },
      { name: 'dir.md', mode: MODE_TREE, oid: '5' },
    ]
    expect(templateFiles(entries).map((e) => e.name)).toEqual(['a.markdown', 'b.md'])
  })
})

describe('applyTemplate (QW4-037: the arrow keys pick each template they pass)', () => {
  const bug = { title: '[bug] ', body: '## Steps' }
  const feature = { title: '[feature] ', body: '## Idea' }
  it('fills empty fields, then follows the pick while the text is untouched', () => {
    const first = applyTemplate({ title: '', body: '' }, null, bug)
    expect(first).toEqual(bug)
    expect(applyTemplate(first, bug, feature)).toEqual(feature)
    // Back to "Blank issue": the template's text goes.
    expect(applyTemplate(feature, feature, null)).toEqual({ title: '', body: '' })
  })
  it('keeps whatever the person typed', () => {
    expect(applyTemplate({ title: 'Crash on start', body: '## Steps' }, bug, feature)).toEqual({ title: 'Crash on start', body: '## Idea' })
    expect(applyTemplate({ title: 'Mine', body: 'my words' }, null, bug)).toEqual({ title: 'Mine', body: 'my words' })
  })
})
