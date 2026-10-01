/**
 * The "this devnet is moving" notice (WIPE D-16): a build-time switch for the banner that warns users
 * before a devnet is re-cut, and for the window between the wipe and the new build.
 *
 * `NEXT_PUBLIC_DEVNET_NOTICE` (the Pages variable `PAGES_DEVNET_NOTICE`):
 *
 * - unset or empty: no notice;
 * - `upcoming`: a dismissible banner on every page, "this devnet is moving soon";
 * - `moving`: a banner that cannot be dismissed, and writes are paused (each write button says
 *   why), for the window between the wipe and the build that targets the new devnet.
 *
 * The notice is about a devnet: a testnet or mainnet build ignores it. Any other value fails the
 * build, so a typo cannot leave the notice silently off.
 */

import { ACTIVE_NETWORK, type NetworkConfig } from './constants'
import { DOCS } from './docs-links'

export type DevnetNotice = 'upcoming' | 'moving'

/** Where the banner and the "moving" state send people: what is lost, what is kept, what to do. */
export const DEVNET_MOVE_DOC = DOCS.devnetMove

/** Parse the build variable. Throws on a value that is neither empty nor a known mode. */
export function parseDevnetNotice(raw: string | undefined): DevnetNotice | null {
  const v = raw?.trim().toLowerCase() ?? ''
  if (v === '') return null
  if (v === 'upcoming' || v === 'moving') return v
  throw new Error(`invalid NEXT_PUBLIC_DEVNET_NOTICE "${raw}": expected "upcoming", "moving" or nothing`)
}

// `process.env.NEXT_PUBLIC_*` must be written out literally — Next inlines it at build time.
const CONFIGURED = parseDevnetNotice(process.env.NEXT_PUBLIC_DEVNET_NOTICE)

/** The notice this build shows for `config` (null on any network but a devnet). */
export function devnetNoticeFor(config: NetworkConfig, configured: DevnetNotice | null = CONFIGURED): DevnetNotice | null {
  return config.network === 'devnet' && config.devnetName !== null ? configured : null
}

/** The notice this build shows (the active network's). */
export const DEVNET_NOTICE: DevnetNotice | null = devnetNoticeFor(ACTIVE_NETWORK)

/** What the banner says, per mode; `name` is the devnet's name (`bonsia`). */
export function devnetNoticeCopy(notice: DevnetNotice, name: string): { readonly lead: string; readonly body: string } {
  return notice === 'upcoming'
    ? {
        lead: `${name} is moving to a new devnet soon.`,
        body: 'Repos, issues, stars and keys on this devnet will be wiped. Mirrors need setting up again with the /mirror wizard, and your own repos will need a re-push from your clone.',
      }
    : {
        lead: `${name} is moving to a new devnet.`,
        body: 'Writing is paused until the new build is live: nothing written here would survive the move. Repos, issues, stars and keys on this devnet are wiped; your own repos will need a re-push from your clone.',
      }
}

/**
 * Why writes are off, or null when they are on: the reason every write button shows while the
 * "moving" notice is up. Reading still works until the wipe.
 */
export function writesPausedReason(notice: DevnetNotice | null = DEVNET_NOTICE): string | null {
  return notice === 'moving' ? 'Writing is paused while this devnet moves to a new one — reading still works.' : null
}

/** localStorage key remembering that `notice` was dismissed (per mode: a new mode shows again). */
export function devnetNoticeDismissKey(notice: DevnetNotice): string {
  return `forge.devnet-notice.dismissed:${notice}`
}
