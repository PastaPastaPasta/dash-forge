import { describe, expect, it } from 'vitest'

import { formBody, initialFormValues, missingAnswers, parseIssueForm } from './issue-forms'

/** GitHub's documented bug report form (docs: "Syntax for issue forms"), trimmed. */
const BUG = `
name: Bug Report
description: File a bug report.
title: "[Bug]: "
labels: ["bug", "triage"]
projects: ["octo-org/1"]
assignees:
  - octocat
body:
  - type: markdown
    attributes:
      value: |
        Thanks for taking the time to fill out this bug report!
  - type: input
    id: contact
    attributes:
      label: Contact Details
      description: How can we get in touch with you if we need more info?
      placeholder: ex. email@example.com
    validations:
      required: false
  - type: textarea
    id: what-happened
    attributes:
      label: What happened?
      description: Also tell us, what did you expect to happen?
      placeholder: Tell us what you see!
      value: "A bug happened!"
    validations:
      required: true
  - type: dropdown
    id: version
    attributes:
      label: Version
      options:
        - 1.0.2 (Default)
        - 1.0.3 (Edge)
      default: 0
    validations:
      required: true
  - type: dropdown
    id: browsers
    attributes:
      label: What browsers are you seeing the problem on?
      multiple: true
      options:
        - Firefox
        - Chrome
  - type: textarea
    id: logs
    attributes:
      label: Relevant log output
      render: shell
  - type: checkboxes
    id: terms
    attributes:
      label: Code of Conduct
      options:
        - label: I agree to follow this project's Code of Conduct
          required: true
        - label: I searched for duplicates
`

describe('YAML issue forms', () => {
  it('reads GitHub’s documented example', () => {
    const f = parseIssueForm(BUG)
    expect(f).not.toBeNull()
    expect(f!.name).toBe('Bug Report')
    expect(f!.about).toBe('File a bug report.')
    expect(f!.title).toBe('[Bug]: ')
    expect(f!.labels).toEqual(['bug', 'triage'])
    expect(f!.assignees).toEqual(['octocat'])
    expect(f!.form.elements.map((e) => `${e.type}:${e.key}`)).toEqual([
      'markdown:field-0',
      'input:contact',
      'textarea:what-happened',
      'dropdown:version',
      'dropdown:browsers',
      'textarea:logs',
      'checkboxes:terms',
    ])
  })

  it('writes the body GitHub writes, from the starting answers', () => {
    const f = parseIssueForm(BUG)!
    const values = initialFormValues(f.form)
    expect(formBody(f.form, values)).toBe(
      [
        '### Contact Details',
        '',
        '_No response_',
        '',
        '### What happened?',
        '',
        'A bug happened!',
        '',
        '### Version',
        '',
        '1.0.2 (Default)',
        '',
        '### What browsers are you seeing the problem on?',
        '',
        '_No response_',
        '',
        '### Relevant log output',
        '',
        '_No response_',
        '',
        '### Code of Conduct',
        '',
        "- [ ] I agree to follow this project's Code of Conduct",
        '- [ ] I searched for duplicates',
      ].join('\n'),
    )
    // A required checkbox is an answer of its own.
    expect(missingAnswers(f.form, values)).toEqual(["I agree to follow this project's Code of Conduct"])
  })

  it('fences a rendered textarea and joins picked options', () => {
    const f = parseIssueForm(BUG)!
    const body = formBody(f.form, {
      ...initialFormValues(f.form),
      'what-happened': '',
      browsers: ['Firefox', 'Chrome'],
      logs: 'panic: boom',
      terms: [true, false],
    })
    expect(body).toContain('### What browsers are you seeing the problem on?\n\nFirefox, Chrome')
    expect(body).toContain('### Relevant log output\n\n```shell\npanic: boom\n```')
    expect(body).toContain("- [X] I agree to follow this project's Code of Conduct\n- [ ] I searched for duplicates")
    expect(missingAnswers(f.form, { ...initialFormValues(f.form), 'what-happened': ' ', version: [], terms: [true, false] })).toEqual(['What happened?', 'Version'])
  })

  it('refuses what is not a form', () => {
    expect(parseIssueForm('name: x')).toBeNull()
    expect(parseIssueForm('{ not yaml')).toBeNull()
    expect(parseIssueForm('body: [{type: input, attributes: {label: A}}]')).toBeNull() // no name
    expect(parseIssueForm('name: x\nbody: [{type: markdown, attributes: {value: hi}}]')).toBeNull() // nothing to answer
    expect(parseIssueForm('name: x\nbody: [{type: input, attributes: {}}]')).toBeNull() // no label
    expect(parseIssueForm('name: x\nbody: [{type: slider, attributes: {label: A}}]')).toBeNull()
    expect(parseIssueForm('name: x\nbody: [{type: input, id: a, attributes: {label: A}}, {type: input, id: a, attributes: {label: B}}]')).toBeNull()
  })

  it('reads labels written as one string', () => {
    expect(parseIssueForm('name: x\nlabels: bug, docs\nbody: [{type: input, attributes: {label: A}}]')!.labels).toEqual(['bug', 'docs'])
  })
})
