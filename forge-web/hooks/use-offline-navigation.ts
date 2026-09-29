'use client'

/**
 * Hold in-app link clicks while the browser is offline (L-56). A page whose data this tab has
 * not fetched yet cannot be rendered offline, and Next's fallback is a full page load, which
 * leaves the tab on the browser's own "no internet" page, where nothing recovers. Instead the
 * click is kept, a toast says so, and the page opens once the connection is back (the newest
 * click wins).
 */

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from '@/hooks/use-toasts'
import { isOffline } from '@/lib/online'
import { BASE_PATH } from '@/lib/short-url'

export function useOfflineNavigation(): void {
  const router = useRouter()
  useEffect(() => {
    let pending: string | null = null
    const onClick = (e: MouseEvent): void => {
      if (!isOffline() || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const a = e.target instanceof Element ? e.target.closest('a[href]') : null
      if (!(a instanceof HTMLAnchorElement) || (a.target && a.target !== '_self') || a.hasAttribute('download')) return
      const target = offlineTarget(a.href, window.location.href, BASE_PATH)
      if (target === null) return
      const href = target
      // Before React's handlers (Next's Link would start the navigation that falls back to a reload).
      e.preventDefault()
      e.stopPropagation()
      pending = href
      toast({ title: "You're offline", detail: 'That page opens as soon as your connection is back.' })
    }
    const onOnline = (): void => {
      if (pending === null) return
      const href = pending
      pending = null
      router.push(href)
    }
    document.addEventListener('click', onClick, true)
    window.addEventListener('online', onOnline)
    return () => {
      document.removeEventListener('click', onClick, true)
      window.removeEventListener('online', onOnline)
    }
  }, [router])
}

/**
 * The in-app route a link to `href` opens (for `router.push`, which adds the base path itself),
 * or null when it is not one to hold: another origin, or the same page (only its `#fragment`
 * differs: the browser scrolls, nothing is fetched).
 */
export function offlineTarget(href: string, current: string, basePath: string): string | null {
  const url = new URL(href, current)
  const here = new URL(current)
  if (url.origin !== here.origin || (url.pathname === here.pathname && url.search === here.search)) return null
  const path = basePath !== '' && (url.pathname === basePath || url.pathname.startsWith(`${basePath}/`)) ? url.pathname.slice(basePath.length) || '/' : url.pathname
  return `${path}${url.search}${url.hash}`
}
