'use client'

/**
 * The repo header's code search box (P1-3), GitHub's "Type / to search" scoped to the repo: Enter
 * opens the repo's code search (`/repo/search`) at the ref the page shows. On a phone it is a
 * button to that page. `/` anywhere in a repo focuses it (or the search page's own box) before
 * the header's jump box takes the key: inside a repo, `/` searches the repo, as on GitHub.
 */

import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { buttonClass } from '@/components/ui/button'
import { repoHref, useParam, type RepoAddress } from '@/hooks/use-query-param'
import { isPageShortcut } from '@/lib/focus'
import { bareRoute } from '@/lib/page-title'
import { cn } from '@/lib/utils'

/** The route of the repo's code search. */
export const CODE_SEARCH_ROUTE = '/repo/search'

/** Marks the field `/` focuses inside a repo (the header's box, or the search page's). */
export const CODE_SEARCH_FIELD = 'data-code-search'

/**
 * `/` inside a repo: focus the visible code search field. Runs in the capture phase, so it acts
 * before the app header's own `/` (the jump box), which then sees the key handled.
 */
export function useSlashToCodeSearch(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isPageShortcut(e, '/')) return
      const field = [...document.querySelectorAll<HTMLInputElement>(`input[${CODE_SEARCH_FIELD}]`)].find((el) => el.getClientRects().length > 0)
      if (field === undefined) return
      e.preventDefault()
      field.focus()
      field.select()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])
}

export function CodeSearchBox({ addr }: { addr: RepoAddress }): JSX.Element | null {
  const router = useRouter()
  const route = bareRoute(usePathname())
  const refParam = useParam('ref')
  const [text, setText] = useState('')
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  useSlashToCodeSearch()
  // The search page has its own, larger box.
  if (route === CODE_SEARCH_ROUTE) return null
  const href = (query: string): string => repoHref(CODE_SEARCH_ROUTE, addr, { ...(query ? { query } : {}), ...(refParam ? { ref: refParam } : {}) })
  const submit = (e: FormEvent): void => {
    e.preventDefault()
    router.push(href(text.trim()))
  }
  return (
    <>
      <form role="search" aria-label="Search this repository's code" onSubmit={submit} className="relative hidden w-56 md:block">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-anvil-500 dark:text-anvil-400" aria-hidden />
        <label htmlFor={`${id}-q`} className="sr-only">
          Search code
        </label>
        <Input
          ref={input}
          id={`${id}-q`}
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setText('')
              input.current?.blur()
            }
          }}
          placeholder="Search code"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          className="h-8 py-1 pl-8 pr-7"
          {...{ [CODE_SEARCH_FIELD]: '' }}
          data-testid="code-search-box"
        />
        <kbd
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-anvil-300 px-1 font-mono text-[10px] text-anvil-500 dark:border-anvil-700 dark:text-anvil-400"
          aria-hidden
        >
          /
        </kbd>
      </form>
      <Link href={href('')} aria-label="Search code" title="Search code" className={cn(buttonClass({ variant: 'outline', size: 'icon' }), 'md:hidden')} data-testid="code-search-link">
        <Search className="h-4 w-4" aria-hidden />
      </Link>
    </>
  )
}
