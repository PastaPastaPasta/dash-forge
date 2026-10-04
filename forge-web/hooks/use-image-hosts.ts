'use client'

/**
 * The image hosts the viewer chose to load (D-053): an image anyone could name (in an issue, a
 * comment, a profile's avatar) is not fetched until the viewer asks, because the fetch tells its
 * host the viewer's IP address and when they looked. A choice holds for this session, or (Always
 * allow) in this browser's localStorage; one store for every image on the page.
 */

import { useSyncExternalStore } from 'react'
import { IMAGE_HOSTS_KEY, parseImageHosts } from '@/lib/view/markdown-links'

const EMPTY_HOSTS: readonly string[] = []
const hostListeners = new Set<() => void>()
let hostsRaw: string | null | undefined
let hostsCached: readonly string[] = EMPTY_HOSTS
/** Hosts loaded this session (one click), shared by every image on the page. */
const sessionHosts = new Set<string>()

function readHosts(): readonly string[] {
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(IMAGE_HOSTS_KEY)
  } catch {
    raw = null
  }
  if (raw !== hostsRaw) {
    hostsRaw = raw
    hostsCached = parseImageHosts(raw)
  }
  return hostsCached
}

const notifyHosts = (): void => {
  for (const l of hostListeners) l()
}
const onHostsStorage = (e: StorageEvent): void => {
  if (e.key === IMAGE_HOSTS_KEY) notifyHosts()
}

/** One `storage` listener for the page (another tab's "Always allow"), however many images subscribe. */
function subscribeHosts(l: () => void): () => void {
  if (hostListeners.size === 0) window.addEventListener('storage', onHostsStorage)
  hostListeners.add(l)
  return () => {
    hostListeners.delete(l)
    if (hostListeners.size === 0) window.removeEventListener('storage', onHostsStorage)
  }
}

/** Load `host`'s images: this session, or (`always`) from now on in this browser. */
export function allowHost(host: string, always: boolean): void {
  sessionHosts.add(host)
  if (always) {
    const next = [...new Set([...readHosts(), host])]
    try {
      window.localStorage.setItem(IMAGE_HOSTS_KEY, JSON.stringify(next))
    } catch {
      /* private mode: this session only */
    }
  }
  notifyHosts()
}

/** Whether the viewer chose to load `host`'s images (this session, or always). */
export function useHostAllowed(host: string | null): boolean {
  return useSyncExternalStore(
    subscribeHosts,
    () => host !== null && (sessionHosts.has(host) || readHosts().includes(host)),
    () => false,
  )
}
