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

export function useOfflineNavigation(): void {
  const router = useRouter()
  useEffect(() => {
    let pending: string | null = null
    const onClick = (e: MouseEvent): void => {
      if (navigator.onLine !== false || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const a = e.target instanceof Element ? e.target.closest('a[href]') : null
      if (!(a instanceof HTMLAnchorElement) || (a.target && a.target !== '_self') || a.hasAttribute('download')) return
      const url = new URL(a.href, window.location.href)
      if (url.origin !== window.location.origin) return
      const href = `${url.pathname}${url.search}${url.hash}`
      if (href === `${window.location.pathname}${window.location.search}${window.location.hash}`) return
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
