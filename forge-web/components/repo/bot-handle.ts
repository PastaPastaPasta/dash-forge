/**
 * How the bot-access copy names an identity (`@ci-bot`): its DPNS label, else its short id. Shared
 * by Settings → Bots and runners, the Agents panel and the timeline's request lines.
 */

import { useDpnsName } from '@/hooks/use-dpns-name'
import { shortId } from '@/lib/utils'

/** How the copy names an identity: `@name` (its DPNS label), else its short id. */
export function handleOf(id: string, name: string | null | undefined): string {
  return name ? `@${name.replace(/\.dash$/i, '')}` : shortId(id)
}

/** An identity's handle as the copy writes it, from its DPNS name once read. */
export function useHandle(id: string): string {
  return handleOf(id, useDpnsName(id))
}
