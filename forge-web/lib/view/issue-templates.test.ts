import { describe, expect, it } from 'vitest'

import { MODE_TREE } from '../browse'
import { parseIssueTemplate, templateFiles } from './issue-templates'

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
