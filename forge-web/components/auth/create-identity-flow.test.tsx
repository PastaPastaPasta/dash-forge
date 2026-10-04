// @vitest-environment jsdom
/**
 * "Create a new identity": the 12 recovery words are not in the DOM until the person asks to
 * see them (a screen share or a screenshot of the sheet does not carry them), and the backup
 * quiz's answers (words of the phrase) never land in an input's `value` attribute.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Twelve obviously fake words (the quiz only compares strings).
const { WORDS } = vi.hoisted(() => ({ WORDS: Array.from({ length: 12 }, (_, i) => `fakeword${String.fromCharCode(97 + i)}`) }))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ controller: { checkGroup: async () => ({ notice: null }) }, reloadVaults: () => undefined }),
}))
vi.mock('@/lib/auth/create-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/create-identity')>()),
  readCreationJournal: async () => null,
}))
vi.mock('@/lib/auth/connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/connect')>()),
  loadSdkLibrary: async () => undefined,
}))
vi.mock('@/lib/auth/hd', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/hd')>()),
  newMnemonic: async () => WORDS.join(' '),
  quizPositions: () => [0, 5, 11],
}))

const { CreateIdentityFlow } = await import('./create-identity-flow')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function type(el: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
function byText(text: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)
}
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => Promise.resolve())
}
const wordsInDom = (): string[] => WORDS.filter((w) => document.body.innerHTML.includes(w))

beforeEach(async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<CreateIdentityFlow onDone={() => undefined} />))
  await flush()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('CreateIdentityFlow: the recovery words', () => {
  it('are masked until revealed, and can be hidden again', () => {
    expect(host.querySelectorAll('[data-testid="mnemonic-words"] li')).toHaveLength(12)
    expect(wordsInDom()).toEqual([])
    act(() => byText('Reveal recovery phrase')!.click())
    expect(wordsInDom()).toEqual(WORDS)
    act(() => byText('Hide recovery phrase')!.click())
    expect(wordsInDom()).toEqual([])
  })

  it('keeps the quiz answers out of the DOM and still checks them', async () => {
    act(() => byText('I wrote them down')!.click())
    const answers: [string, string][] = [
      ['#quiz-0', WORDS[0]!],
      ['#quiz-5', WORDS[5]!],
      ['#quiz-11', 'wrongfakeword'],
    ]
    for (const [sel, value] of answers) act(() => type(host.querySelector<HTMLInputElement>(sel)!, value))
    for (const [sel, value] of answers) expect(host.querySelector<HTMLInputElement>(sel)!.getAttribute('value') ?? '').not.toContain(value)
    expect(wordsInDom()).toEqual([])
    expect(document.body.innerHTML).not.toContain('wrongfakeword')

    // A wrong word is flagged, not accepted.
    await act(async () => byText('Continue')!.click())
    expect(host.querySelectorAll('[data-testid="quiz-wrong"]')).toHaveLength(1)
    expect(host.querySelector('#quiz-11')).not.toBeNull()

    act(() => type(host.querySelector<HTMLInputElement>('#quiz-11')!, WORDS[11]!))
    expect(host.querySelectorAll('[data-testid="quiz-wrong"]')).toHaveLength(0)
    await act(async () => byText('Continue')!.click())
    expect(host.querySelector('#quiz-11')).toBeNull()
    expect(host.querySelector('#vault-passphrase')).not.toBeNull()
  })

  it('"Show words again" masks the words and starts the quiz empty', () => {
    act(() => byText('I wrote them down')!.click())
    act(() => type(host.querySelector<HTMLInputElement>('#quiz-0')!, WORDS[0]!))
    act(() => byText('Show words again')!.click())
    expect(wordsInDom()).toEqual([])
    act(() => byText('I wrote them down')!.click())
    expect(host.querySelector<HTMLInputElement>('#quiz-0')!.value).toBe('')
    expect(byText('Continue')!.disabled).toBe(true)
  })
})
