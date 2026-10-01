/**
 * The "this devnet is moving" notice (WIPE D-16): a build-time switch for the banner that warns users
 * before Forge leaves a devnet, and for the window before the build for the new devnet is live.
 *
 * `NEXT_PUBLIC_DEVNET_NOTICE` (the Pages variable `PAGES_DEVNET_NOTICE`):
 *
 * - unset or empty: no notice;
 * - `upcoming`: a dismissible banner on every page, "this devnet is moving soon";
 * - `moving`: a banner that cannot be dismissed, and writes are paused (each write button says
 *   why), for the window before the build that targets the new devnet is live.
 *
 * The notice is about a devnet: a testnet or mainnet build ignores it. `moving` is honoured only
 * on a devnet whose deployment file is marked `retired` (one Forge has left: moutai, bonsia), so a
 * variable left set after the move can never pause writes on the devnet Forge moved to: a build for
 * {@link CURRENT_DEVNET} ignores it. To pause writes on a live devnet before leaving it, mark its
 * deployment file retired first. Any other value fails the build, so a typo cannot leave the
 * notice silently off.
 */

import { ACTIVE_NETWORK, type NetworkConfig } from './constants'
import { DOCS } from './docs-links'

export type DevnetNotice = 'upcoming' | 'moving'

/** The devnet Forge moved to (from bonsia, retired), and the Platform it runs. */
export const CURRENT_DEVNET = 'sakura'
export const CURRENT_DEVNET_PLATFORM = 'Platform v5'

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

/**
 * The notice this build shows for `config`: null on any network but a devnet, and `moving` only on
 * a retired devnet (a stale `moving` must not freeze the devnet Forge moved to).
 */
export function devnetNoticeFor(config: NetworkConfig, configured: DevnetNotice | null = CONFIGURED): DevnetNotice | null {
  if (config.network !== 'devnet' || config.devnetName === null) return null
  if (configured === 'moving' && config.retired !== true) return null
  return configured
}

/** The notice this build shows (the active network's). */
export const DEVNET_NOTICE: DevnetNotice | null = devnetNoticeFor(ACTIVE_NETWORK)

/** What the banner says, per mode; `name` is the devnet's name (`bonsia`). `moving` names where Forge went. */
export function devnetNoticeCopy(notice: DevnetNotice, name: string): { readonly lead: string; readonly body: string } {
  return notice === 'upcoming'
    ? {
        lead: `${name} is moving to a new devnet soon.`,
        body: 'Repos, issues, stars and keys on this devnet will be wiped. Mirrors need setting up again with the /mirror wizard, and your own repos will need a re-push from your clone.',
      }
    : {
        lead: `Dash Forge moved to devnet ${CURRENT_DEVNET} (${CURRENT_DEVNET_PLATFORM}); ${name} was retired.`,
        body: `Writing is paused here: nothing written on ${name} would survive. Its repos, issues, stars and keys are gone with it; mirrors need setting up again with the /mirror wizard, and your own repos need a re-push from your clone, once the ${CURRENT_DEVNET} build is live.`,
      }
}

/**
 * Why writes are off, or null when they are on: the reason every write button shows while the
 * "moving" notice is up (only ever on a retired devnet).
 */
export function writesPausedReason(notice: DevnetNotice | null = DEVNET_NOTICE): string | null {
  return notice === 'moving' ? `Writing is paused: this devnet was retired and Dash Forge moved to devnet ${CURRENT_DEVNET}.` : null
}

/** localStorage key remembering that `notice` was dismissed (per mode: a new mode shows again). */
export function devnetNoticeDismissKey(notice: DevnetNotice): string {
  return `forge.devnet-notice.dismissed:${notice}`
}
