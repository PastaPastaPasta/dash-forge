import { RELAY_ORIGIN } from './gate'
import { ROOM_PATTERN } from './util'

export interface Invite {
  readonly room: string
  readonly relay: string
  readonly label: string | null
  readonly network: string | null
}

const ROOM_NETWORK = /^(m|t|r|d[a-z0-9][a-z0-9-]*)_[0-9a-f]{32}$/

export function roomNetwork(room: string): string | null {
  const m = ROOM_NETWORK.exec(room)
  if (!m) return null
  const tag = m[1] as string
  if (tag === 'm') return 'mainnet'
  if (tag === 't') return 'testnet'
  if (tag === 'r') return 'local'
  return `devnet-${tag.slice(1)}`
}

export function roomOnNetwork(room: string, network: string): boolean {
  const tag = roomNetwork(room)
  return tag === null ? network === 'testnet' : tag === network
}

export function parseInvite(text: string): Invite | null {
  const t = text.trim()
  if (ROOM_PATTERN.test(t)) return { room: t, relay: RELAY_ORIGIN, label: null, network: roomNetwork(t) }
  let url: URL
  try {
    url = new URL(t)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  const hash = new URLSearchParams(url.hash.slice(1))
  const room = hash.get('room') ?? url.searchParams.get('room')
  if (room === null || !ROOM_PATTERN.test(room)) return null
  const name = hash.get('name')
  return {
    room,
    relay: url.origin,
    label: name ? name.slice(0, 80) : null,
    network: url.searchParams.get('network') ?? roomNetwork(room),
  }
}
