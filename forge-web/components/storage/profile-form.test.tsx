// @vitest-environment jsdom
/**
 * The storage profile form's secret fields are uncontrolled: a typed credential reaches the
 * profile (so it can be tested and saved) but never the DOM's `value` attribute, and a saved
 * profile's secrets are never put back into the page.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StorageProfile } from '@/lib/storage'
import { ProfileForm } from './profile-form'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const FAKE_KEY_ID = 'FAKEACCESSKEYID0000'
const FAKE_SECRET = 'fake-secret-access-key-not-real'
const FAKE_TOKEN = 'fake-session-token-not-real'

let host: HTMLDivElement
let root: Root

function type(el: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
const field = (key: string): HTMLInputElement => host.querySelector<HTMLInputElement>(`input[name="forge-storage-${key}"]`)!

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('ProfileForm secret fields', () => {
  it('keeps typed secrets out of the DOM and still hands them to the profile', () => {
    const onChange = vi.fn<(p: StorageProfile, problem: string | null) => void>()
    act(() => root.render(<ProfileForm provider="aws" existing={null} onChange={onChange} />))
    const typed: [string, string][] = [
      ['accessKeyId', FAKE_KEY_ID],
      ['secretAccessKey', FAKE_SECRET],
      ['sessionToken', FAKE_TOKEN],
    ]
    for (const [key, value] of typed) {
      act(() => type(field(key), value))
      expect(field(key).getAttribute('value') ?? '').not.toContain(value)
      expect(document.body.innerHTML).not.toContain(value)
    }
    expect(onChange.mock.lastCall![0].secrets).toEqual({ accessKeyId: FAKE_KEY_ID, secretAccessKey: FAKE_SECRET, sessionToken: FAKE_TOKEN })
    // A public field stays controlled (and may show its value).
    act(() => type(field('bucket'), 'my-bucket'))
    expect(field('bucket').value).toBe('my-bucket')
    expect(onChange.mock.lastCall![0].secrets.secretAccessKey).toBe(FAKE_SECRET)
  })

  it('keeps the kubo and pinning service tokens out of the DOM', () => {
    const onChange = vi.fn<(p: StorageProfile, problem: string | null) => void>()
    act(() => root.render(<ProfileForm provider="pinning" existing={null} onChange={onChange} />))
    for (const [key, value] of [
      ['apiAuth', 'Bearer fake-kubo-token-not-real'],
      ['pinningToken', 'fake-pinning-token-not-real'],
    ] as const) {
      act(() => type(field(key), value))
      expect(field(key).getAttribute('value') ?? '').not.toContain(value)
      expect(document.body.innerHTML).not.toContain(value)
      expect(onChange.mock.lastCall![0].secrets[key]).toBe(value)
    }
  })

  it('never puts a saved profile secret back into the form', () => {
    const existing: StorageProfile = {
      name: 'aws',
      settings: { kind: 's3', provider: 'aws', endpoint: 'https://s3.example', region: 'us-east-1', bucket: 'b', pathStyle: true, publicUrl: '', prefix: '' },
      secrets: { accessKeyId: FAKE_KEY_ID, secretAccessKey: FAKE_SECRET },
    }
    act(() => root.render(<ProfileForm provider="aws" existing={existing} onChange={() => undefined} />))
    expect(field('secretAccessKey').value).toBe('')
    expect(document.body.innerHTML).not.toContain(FAKE_SECRET)
    expect(document.body.innerHTML).not.toContain(FAKE_KEY_ID)
  })
})
