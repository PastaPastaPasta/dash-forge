// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DOCS } from '@/lib/docs-links'
import { BACKEND_COMMAND, SelfHostBackend } from './self-host-backend'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('SelfHostBackend', () => {
  it('is collapsed, with the command and the guide inside', () => {
    act(() => root.render(<SelfHostBackend />))
    const details = host.querySelector('details')!
    expect(details.open).toBe(false)
    expect(details.querySelector('summary')!.textContent).toBe('Run it on a server or NAS')
    expect(details.querySelector('pre')!.textContent).toBe(BACKEND_COMMAND)
    expect(details.querySelector('a')!.getAttribute('href')!.replace(/\/$/, '')).toBe(DOCS.selfHostBackend.replace(/\/$/, ''))
  })

  it('pipes the script the repository serves, with an https name', () => {
    const script = readFileSync(join(__dirname, '../../../backend.sh'), 'utf8')
    const url = /^SCRIPT_URL="([^"]+)"$/m.exec(script)![1]!
    expect(BACKEND_COMMAND).toBe(`curl -fsSL ${url} | sudo sh -s -- --domain ipfs.example.org`)
  })
})
