import { describe, expect, it } from 'vitest'

import { MODE_TREE } from '../browse'
import { applyTemplate, parseChooserConfig, parseIssueTemplate, parseTemplateFile, templateFiles } from './issue-templates'

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

  it('lists Markdown templates and YAML forms, skipping directories and config', () => {
    const entries = [
      { name: 'b.md', mode: 0o100644, oid: '1' },
      { name: 'a.markdown', mode: 0o100644, oid: '2' },
      { name: 'config.yml', mode: 0o100644, oid: '3' },
      { name: 'config.md', mode: 0o100644, oid: '4' },
      { name: 'dir.md', mode: MODE_TREE, oid: '5' },
      { name: 'form.yml', mode: 0o100644, oid: '6' },
      { name: 'other.yaml', mode: 0o100644, oid: '7' },
      { name: 'notes.txt', mode: 0o100644, oid: '8' },
    ]
    expect(templateFiles(entries).map((e) => e.name)).toEqual(['a.markdown', 'b.md', 'form.yml', 'other.yaml'])
  })

  it('reads a YAML file as a form, and drops one that is not', () => {
    const t = parseTemplateFile('bug.yml', 'name: Bug\ndescription: Broken\nlabels: [bug]\nbody:\n  - type: input\n    attributes:\n      label: Version\n')
    expect(t).toMatchObject({ file: 'bug.yml', name: 'Bug', about: 'Broken', labels: ['bug'], body: '' })
    expect(t?.form?.elements).toHaveLength(1)
    expect(parseTemplateFile('broken.yml', 'name: [')).toBeNull()
    // GitLab's templates are plain Markdown, named after the file.
    expect(parseTemplateFile('Bug.md', '## Summary')).toMatchObject({ name: 'Bug', body: '## Summary' })
  })

  it('reads config.yml: blank issues and web contact links only', () => {
    expect(parseChooserConfig('')).toEqual({ blankIssuesEnabled: true, contactLinks: [] })
    expect(
      parseChooserConfig(
        [
          'blank_issues_enabled: false',
          'contact_links:',
          '  - name: Forum',
          '    url: https://forum.example.org',
          '    about: Ask here',
          '  - name: Bad',
          '    url: javascript:alert(1)',
          '  - name: No about',
          '    url: http://example.org',
        ].join('\n'),
      ),
    ).toEqual({
      blankIssuesEnabled: false,
      contactLinks: [
        { name: 'Forum', url: 'https://forum.example.org', about: 'Ask here' },
        { name: 'No about', url: 'http://example.org', about: '' },
      ],
    })
    expect(parseChooserConfig('{ broken')).toEqual({ blankIssuesEnabled: true, contactLinks: [] })
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
