const base = (relay: string, room: string): string => `${relay.replace(/\/$/, '')}/v1/rooms/${encodeURIComponent(room)}/messages`

async function call(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, cache: 'no-store', credentials: 'omit' })
  const text = await response.text()
  if (!response.ok) throw new Error(`the relay answered ${response.status}: ${text.slice(0, 200)}`)
  return JSON.parse(text) as unknown
}

interface Page {
  readonly messages?: readonly { readonly envelope?: unknown }[]
  readonly next?: unknown
  readonly more?: unknown
}

export interface RoomLog {
  readonly messages: unknown[]
  readonly cursor: number
}

export async function pullRoom(relay: string, room: string, from: RoomLog = { messages: [], cursor: 0 }): Promise<RoomLog> {
  const messages = [...from.messages]
  let after = from.cursor
  for (let pages = 0; pages < 200; pages++) {
    const page = (await call(`${base(relay, room)}?after=${after}`)) as Page
    for (const m of page.messages ?? []) if (m && m.envelope !== undefined) messages.push(m.envelope)
    const next = page.next
    if (typeof next !== 'number' || !Number.isSafeInteger(next) || next <= after) break
    after = next
    if (!page.more) break
  }
  return { messages, cursor: after }
}
