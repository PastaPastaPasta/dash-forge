// @vitest-environment jsdom
/**
 * A members-only branch's check run in the Checks tab (private-repos.md §19.9): a member whose
 * session verified the run's blind reads its real name and opened log; everyone else reads the
 * opaque name, and a member whose log does not open reads it with "name not available".
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { OpenContext } from '@/lib/private'
import { blind as blindOf } from '@/lib/private/blind'
import { bytesToHex, hexToBytes } from '@/lib/private/bytes'
import { CheckKeys } from '@/lib/private/members-check'
import type { CheckRun, ChecksSummary } from '@/lib/repo/checks'
import { blindBook } from '@/lib/repo/members-blinds'
import type { PrivateSession } from '@/lib/repo/private-session'
import { ChecksTab } from './pull-tabs'

vi.mock('next/link', () => ({ default: (props: React.ComponentProps<'a'>) => <a {...props} /> }))
vi.mock('@/components/author', () => ({ Author: ({ identityId }: { identityId: string }) => <span>{identityId}</span> }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SALT = new Uint8Array(32).fill(0x5a)
const REAL = new Uint8Array(20).fill(0x0c)
const LOG_URL = 'https://logs.example/run1'
const SUMMARY: ChecksSummary = { passed: 1, failing: 0, pending: 0, total: 1, untrusted: 0, offSource: 0, membersKnown: true }

let host: HTMLDivElement
let root: Root
let served: Uint8Array
let blind: string
let run: CheckRun

beforeEach(async () => {
  const b = (await blindOf(SALT, REAL)) as Uint8Array
  blind = bytesToHex(b)
  const keys = await CheckKeys.of(SALT)
  served = await keys.sealLog(b, 'ci / build', REAL, new TextEncoder().encode('all green\n'))
  run = {
    id: 'run1',
    name: await keys.opaqueName('ci / build'),
    headOid: blind,
    status: 'completed',
    conclusion: 'success',
    detailsUrl: '',
    summary: '',
    reporter: 'runner',
    trusted: true,
    createdAt: 1,
    startedAt: 0,
    completedAt: 0,
    externalId: '',
    logUrl: LOG_URL,
    logSha256: bytesToHex(sha256(served)),
    artifacts: [],
    requiredSource: null,
    fromRequiredSource: true,
  }
  vi.stubGlobal('fetch', async (url: string) => (url === LOG_URL ? new Response(served as BodyInit) : new Response(null, { status: 404 })))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

/** A member session whose blinds hold the run's commit. */
async function member(): Promise<PrivateSession> {
  const ctx = {} as OpenContext
  expect(await blindBook(ctx).learn(hexToBytes(blind), REAL, SALT)).toBe(true)
  return { id: 'session', ctx } as unknown as PrivateSession
}

async function render(members?: PrivateSession): Promise<HTMLElement> {
  await act(async () => root.render(<ChecksTab runs={[run]} summary={SUMMARY} headOid={blind} error={null} onRetry={() => undefined} members={members} />))
  // the log is fetched and opened
  for (let i = 0; i < 20; i++) await act(async () => new Promise((r) => setTimeout(r, 5)))
  return host.querySelector('[data-testid="check-run"]') as HTMLElement
}

describe("a members-only branch's check run", () => {
  it("shows a member the check's real name and its opened log", async () => {
    const row = await render(await member())
    expect(row.dataset.name).toBe('ci / build')
    expect(row.textContent).toContain('ci / build')
    expect(row.textContent).not.toContain(run.name)
    act(() => (row.querySelector('[data-testid="check-log-open"]') as HTMLButtonElement).click())
    expect(row.querySelector('[data-testid="check-log"]')?.textContent).toContain('all green')
  })

  it('shows everyone else the opaque name, as reported', async () => {
    const row = await render()
    expect(row.dataset.name).toBe(run.name)
    expect(row.textContent).not.toContain('ci / build')
    expect(row.querySelector('[data-testid="check-name-unavailable"]')).toBeNull()
    // its log is the sealed bytes: said so, never printed as text
    act(() => (row.querySelector('[data-testid="check-log-open"]') as HTMLButtonElement).click())
    for (let i = 0; i < 20; i++) await act(async () => new Promise((r) => setTimeout(r, 5)))
    expect(row.querySelector('[data-testid="check-log-members-only"]')?.textContent).toBe('This log is for members of this repo only.')
    expect(row.querySelector('pre')).toBeNull()
  })

  it('keeps the opaque name for a member when the log does not hash to the one recorded', async () => {
    served = new Uint8Array(served)
    served[0] = (served[0] as number) ^ 1
    const row = await render(await member())
    expect(row.dataset.name).toBe(run.name)
    expect(row.querySelector('[data-testid="check-name-unavailable"]')?.textContent).toBe('name not available')
    expect(row.querySelector('[data-testid="check-log-open"]')).toBeNull()
  })
})
