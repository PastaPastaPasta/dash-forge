'use client'

/**
 * The page's keyboard shortcuts: `?` opens the list of them, and on a repo page `g` then a letter
 * goes to one of its tabs (`g i` Issues, `g p` Pull requests, as on GitHub). The tab is followed
 * through the link the repo header shows, so it keeps the page's address and `?ref=`.
 */

import { useEffect, useState } from 'react'
import { Dialog } from '@/components/ui/dialog'
import { useMacKeys } from '@/hooks/use-mac-keys'
import { isPageShortcut } from '@/lib/focus'

/** How long `g` waits for its second key. */
export const CHORD_MS = 1500

/** The repo tab each `g` chord goes to. */
export const GO_TO_TAB: Readonly<Record<string, string>> = { c: 'code', i: 'issues', p: 'pulls', b: 'boards', r: 'releases' }

interface Shortcut {
  readonly keys: readonly string[]
  readonly what: string
}

function sections(mod: string): readonly { readonly title: string; readonly items: readonly Shortcut[] }[] {
  return [
    {
      title: 'Anywhere',
      items: [
        { keys: ['/'], what: 'Jump to a repo, a profile, or an issue or PR number (on code pages: search the code)' },
        { keys: ['?'], what: 'Show these shortcuts' },
      ],
    },
    {
      title: 'Repo pages',
      items: [
        { keys: ['g', 'c'], what: 'Code' },
        { keys: ['g', 'i'], what: 'Issues' },
        { keys: ['g', 'p'], what: 'Pull requests' },
        { keys: ['g', 'b'], what: 'Boards, where the network has them' },
        { keys: ['g', 'r'], what: 'Releases' },
        { keys: ['t'], what: 'Find a file (code pages)' },
        { keys: ['y'], what: 'Pin the address to this commit (file pages)' },
      ],
    },
    {
      title: 'Writing issues, pull requests and comments',
      items: [
        { keys: [mod, 'Enter'], what: 'Submit (the cost shows under the field first)' },
        { keys: [mod, 'Shift', 'P'], what: 'Switch between Write and Preview' },
        { keys: [mod, 'B'], what: 'Bold' },
        { keys: [mod, 'I'], what: 'Italic' },
        { keys: [mod, 'E'], what: 'Inline code' },
        { keys: [mod, 'K'], what: 'Link' },
        { keys: ['Esc'], what: 'Cancel an edit' },
      ],
    },
  ]
}

/** Follow the repo header's link to tab `key`; false when the page shows none. */
export function goToRepoTab(key: string): boolean {
  const link = document.querySelector<HTMLAnchorElement>(`a[data-repo-tab="${key}"]`)
  if (link === null) return false
  link.click()
  return true
}

export function KeyboardShortcuts(): JSX.Element {
  const [open, setOpen] = useState(false)
  const mac = useMacKeys()
  useEffect(() => {
    let chord: ReturnType<typeof setTimeout> | null = null
    const endChord = (): void => {
      if (chord !== null) clearTimeout(chord)
      chord = null
    }
    const onKey = (e: KeyboardEvent): void => {
      if (chord !== null) {
        endChord()
        const tab = GO_TO_TAB[e.key]
        if (tab !== undefined && isPageShortcut(e, e.key) && goToRepoTab(tab)) e.preventDefault()
        return
      }
      if (isPageShortcut(e, '?')) {
        e.preventDefault()
        setOpen(true)
        return
      }
      if (isPageShortcut(e, 'g') && document.querySelector('a[data-repo-tab]') !== null) {
        chord = setTimeout(endChord, CHORD_MS)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      endChord()
      document.removeEventListener('keydown', onKey)
    }
  }, [])
  const mod = mac ? '⌘' : 'Ctrl'
  return (
    <Dialog open={open} onClose={() => setOpen(false)} title="Keyboard shortcuts">
      <div className="space-y-5" data-testid="keyboard-shortcuts">
        {sections(mod).map((section) => (
          <section key={section.title}>
            <h3 className="mb-2 text-dense font-medium text-anvil-900 dark:text-anvil-50">{section.title}</h3>
            <dl className="space-y-1.5">
              {section.items.map((item) => (
                <div key={item.what} className="flex items-baseline justify-between gap-4 text-dense">
                  <dt className="text-anvil-600 dark:text-anvil-300">{item.what}</dt>
                  <dd className="flex shrink-0 items-center gap-1">
                    {item.keys.map((k, i) => (
                      <kbd key={i} className="rounded border border-anvil-300 bg-anvil-50 px-1.5 py-0.5 font-sans text-[12px] text-anvil-800 dark:border-anvil-700 dark:bg-anvil-850 dark:text-anvil-100">
                        {k}
                      </kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  )
}
