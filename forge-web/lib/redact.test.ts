import { describe, expect, it } from 'vitest'

import { redactSecrets } from './redact'

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
