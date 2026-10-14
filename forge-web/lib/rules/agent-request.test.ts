/** Requests to bots (event kind 27): the request a document makes, the task's bounds, the E813 words. Parity: forge-core `rules::agent_request` tests. */

import { describe, expect, it } from 'vitest'

import { AGENT_REQUEST_KIND, agentRequest, askRefusalWords, checkAsk, isTask, requestAllowed, roleWords, type RequestEvent } from './agent-request'
import { CLIENT_WRITER_EVENT_KINDS, claimedRole, RoleRefusedError } from './roles'
import type { AccessNotice } from '../private/access-notice'

const e: RequestEvent = { id: 'E', repoId: 'R', targetId: 'T', targetNumber: 42, kind: AGENT_REQUEST_KIND, refId: 'B', value: 'fix the failing test', valueHidden: false, actor: 'A', createdAt: 5 }

describe('agentRequest', () => {
  it('names its bot and its task', () => {
    const r = agentRequest('R', e)
    expect(r).toEqual({ id: 'E', targetId: 'T', number: 42, bot: 'B', task: 'fix the failing test', asker: 'A', createdAt: 5 })
    expect(agentRequest('R', { ...e, value: null, valueHidden: true })?.task).toBeNull()
  })

  it('is not one for another repo, no bot, no task, or another kind', () => {
    expect(agentRequest('other', e)).toBeNull()
    expect(agentRequest('R', { ...e, refId: null })).toBeNull()
    expect(agentRequest('R', { ...e, value: null })).toBeNull()
    expect(agentRequest('R', { ...e, kind: 26 })).toBeNull()
    expect(agentRequest('R', { ...e, targetNumber: 0 })).toBeNull()
  })

  it('bounds the task', () => {
    expect(isTask('x'.repeat(121))).toBe(false)
    expect(isTask(' ')).toBe(false)
    expect(isTask('a\nb')).toBe(true)
    expect(isTask('a\u0007b')).toBe(false)
    expect(isTask('é'.repeat(120))).toBe(true)
  })
})

describe('checkAsk', () => {
  const n: AccessNotice = { bot: new Uint8Array(32), may: ['post', 'readOnRequest'], askers: 'writers', threads: [42], processor: null, until: 1000, revokes: [], note: '', extra: {} }

  it('follows the notice', () => {
    expect(checkAsk(n, 'writer', 42, true, 10)).toBeNull()
    expect(checkAsk(null, 'writer', 42, false, 10)).toEqual({ why: 'noAccess' })
    expect(checkAsk({ ...n, may: [] }, 'writer', 42, false, 10)).toEqual({ why: 'noAccess' })
    expect(checkAsk(n, 'writer', 42, false, 1000)).toEqual({ why: 'ended', until: 1000 })
    expect(checkAsk(n, 'triage', 42, false, 10)).toEqual({ why: 'askers', askers: 'writers', role: 'triage' })
    expect(checkAsk(n, 'writer', 7, false, 10)).toEqual({ why: 'thread', number: 7 })
    const postOnly: AccessNotice = { ...n, may: ['post'], askers: 'maintainers', threads: 'all' }
    expect(checkAsk(postOnly, 'maintainer', 7, true, 10)).toEqual({ why: 'noRead' })
    expect(checkAsk(postOnly, 'writer', 7, false, 10)?.why).toBe('askers')
    expect(checkAsk(postOnly, 'maintainer', 7, false, 10)).toBeNull()
    expect(requestAllowed({ id: 'E', targetId: 'T', number: 42, bot: 'B', task: null, asker: 'A', createdAt: 10 }, n, 'writer', true)).toBe(true)
  })

  it('reads as the design says', () => {
    const w = askRefusalWords({ why: 'askers', askers: 'writers', role: 'triage' }, '@ci-bot', 'o/r', '')
    expect(w.message).toBe("@ci-bot can't be asked by people with Triage access in o/r")
    expect(w.fix).toBe("ask a maintainer to change @ci-bot's access, or ask someone with Write access")
    expect(askRefusalWords({ why: 'askers', askers: 'maintainers', role: null }, '@ci-bot', 'o/r', '').message).toBe("@ci-bot can't be asked by people outside o/r's members in o/r")
    expect(askRefusalWords({ why: 'ended', until: 1 }, '@ci-bot', 'o/r', '30 Nov 2026').message).toBe("@ci-bot's access in o/r ended on 30 Nov 2026")
    expect(roleWords('bot')).toBe('the Bot role')
  })
})

describe('a request is a writer’s act', () => {
  it('is kept from triage before signing', () => {
    expect(CLIENT_WRITER_EVENT_KINDS.has(AGENT_REQUEST_KIND)).toBe(true)
    expect(() => claimedRole('event', { kind: AGENT_REQUEST_KIND }, 'triage')).toThrow(RoleRefusedError)
    expect(claimedRole('event', { kind: AGENT_REQUEST_KIND }, 'writer')).toBe(1)
  })
})
