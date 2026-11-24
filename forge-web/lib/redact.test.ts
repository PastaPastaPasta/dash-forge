import { describe, expect, it } from 'vitest'

import { redactSecrets, redactValues } from './redact'

describe('redactSecrets', () => {
  it('scrubs URL userinfo, credential key=value pairs, Authorization values and bearer tokens', () => {
    expect(redactSecrets('GET https://user:pw@host.example/x failed')).toBe('GET https://[redacted]@host.example/x failed')
    expect(redactSecrets('https://b.example/k?X-Amz-Credential=AKIA1%2F2&X-Amz-Date=20260101&X-Amz-Signature=abc')).toBe(
      'https://b.example/k?X-Amz-Credential=[redacted]&X-Amz-Date=20260101&X-Amz-Signature=[redacted]',
    )
    expect(redactSecrets('access_token=abc123 then api-key=zzz')).toBe('access_token=[redacted] then api-key=[redacted]')
    expect(redactSecrets('Authorization: Basic dXNlcjpwYXNz')).toBe('Authorization: [redacted]')
    expect(redactSecrets('sent Bearer eyJhbGciOiJIUzI1NiJ9.x.y')).toBe('sent Bearer [redacted]')
  })

  it('leaves prose and placeholders alone', () => {
    for (const s of ['a basic idea', 'monkey=banana', 'pass token=<token> here', 'HTTP 403 from cdn.example']) expect(redactSecrets(s)).toBe(s)
  })
})

describe('redactValues', () => {
  it("replaces a profile's actual secret values, and the token of an Authorization value", () => {
    expect(redactValues('denied for wJalrXUtnFEMI and dXNlcjpwYXNz', ['wJalrXUtnFEMI', 'Basic dXNlcjpwYXNz', undefined])).toBe('denied for [redacted] and [redacted]')
  })

  it('leaves short values alone', () => {
    expect(redactValues('a key k here', ['k', 'abc'])).toBe('a key k here')
  })
})
