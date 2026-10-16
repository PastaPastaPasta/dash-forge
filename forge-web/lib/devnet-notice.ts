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
 * {@link FORGE_HOME} ignores it. To pause writes on a live devnet before leaving it, mark its
 * deployment file retired first. Any other value fails the build, so a typo cannot leave the
 * notice silently off.
 *
 * `NEXT_PUBLIC_DEVNET_MOVE_TO` (the Pages variable `PAGES_DEVNET_MOVE_TO`, WEB-16) names where an
 * `upcoming` move goes when it is not another devnet: `testnet`, `mainnet` or `devnet-<name>`;
 * unset keeps "a new devnet". The operator-wide pause and advisory banner, for any network, is a
 * separate switch (`lib/pages-notice.ts`, `NEXT_PUBLIC_PAGES_NOTICE`).
 */

import { ACTIVE_NETWORK, type NetworkConfig } from './constants'
import { DOCS } from './docs-links'
import { PAGES_NOTICE, pagesWritesPausedReason, type PagesNotice } from './pages-notice'

export type DevnetNotice = 'upcoming' | 'moving'

/** A network Forge lives on or is moving to, as copy names it: `devnet sakura`, `testnet`. */
export interface ForgeHome {
  readonly label: string
  /** The Platform it runs, when the copy names it (`Platform v5`). */
  readonly platform: string | null
}

/**
 * Where Forge lives now, the network a retired devnet's `moving` banner and the "contracts
 * missing" state send people to. Still devnet sakura; the testnet switch changes it here, in the
 * same commit that marks `devnet-sakura.json` retired.
 */
export const FORGE_HOME: ForgeHome = { label: 'devnet sakura', platform: 'Platform v5' }

/** Where the banner and the "moving" state send people: what is lost, what is kept, what to do. */
export const DEVNET_MOVE_DOC = DOCS.devnetMove

/** Parse the build variable. Throws on a value that is neither empty nor a known mode. */
export function parseDevnetNotice(raw: string | undefined): DevnetNotice | null {
  const v = raw?.trim().toLowerCase() ?? ''
  if (v === '') return null
  if (v === 'upcoming' || v === 'moving') return v
  throw new Error(`invalid NEXT_PUBLIC_DEVNET_NOTICE "${raw}": expected "upcoming", "moving" or nothing`)
}

/**
 * Parse `NEXT_PUBLIC_DEVNET_MOVE_TO`: where an `upcoming` move goes. Null when unset or empty;
 * throws on anything but `testnet`, `mainnet` or `devnet-<name>` (a typo fails the build).
 */
export function parseMoveTo(raw: string | undefined): ForgeHome | null {
  const v = raw?.trim().toLowerCase() ?? ''
  if (v === '') return null
  if (v === 'testnet' || v === 'mainnet') return { label: v, platform: null }
  const devnet = /^devnet-([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)$/.exec(v)
  if (devnet?.[1] !== undefined) return { label: `devnet ${devnet[1]}`, platform: null }
  throw new Error(`invalid NEXT_PUBLIC_DEVNET_MOVE_TO "${raw}": expected "testnet", "mainnet", "devnet-<name>" or nothing`)
}

// `process.env.NEXT_PUBLIC_*` must be written out literally — Next inlines it at build time.
const CONFIGURED = parseDevnetNotice(process.env.NEXT_PUBLIC_DEVNET_NOTICE)
const MOVE_TO = parseMoveTo(process.env.NEXT_PUBLIC_DEVNET_MOVE_TO)

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

/**
 * What the banner says, per mode; `name` is the devnet's name (`bonsia`). `upcoming` names where
 * Forge goes (`moveTo`; "a new devnet" when the build does not say), `moving` names where it went.
 */
export function devnetNoticeCopy(
  notice: DevnetNotice,
  name: string,
  moveTo: ForgeHome | null = MOVE_TO,
  home: ForgeHome = FORGE_HOME,
): { readonly lead: string; readonly body: string } {
  return notice === 'upcoming'
    ? {
        lead: `${name} is moving to ${moveTo?.label ?? 'a new devnet'} soon.`,
        body: 'Repos, issues, stars and keys on this devnet will be wiped. Mirrors need setting up again with the /mirror wizard, and your own repos will need a re-push from your clone.',
      }
    : {
        lead: `Dash Forge moved to ${home.label}${home.platform === null ? '' : ` (${home.platform})`}; ${name} was retired.`,
        body: `Writing is paused here because nothing written on ${name} would survive. Once the ${home.label} build is live, set up mirrors again with the /mirror wizard and re-push your own repos from your clones.`,
      }
}

/**
 * Why writes are off, or null when they are on: the operator's pause (`lib/pages-notice.ts`, any
 * network) first, else the reason every write button shows while the "moving" notice is up (only
 * ever on a retired devnet).
 */
export function writesPausedReason(notice: DevnetNotice | null = DEVNET_NOTICE, pages: PagesNotice | null = PAGES_NOTICE): string | null {
  return pagesWritesPausedReason(pages) ?? (notice === 'moving' ? `Writing is paused: this devnet was retired and Dash Forge moved to ${FORGE_HOME.label}.` : null)
}

/** localStorage key remembering that `notice` was dismissed (per mode: a new mode shows again). */
export function devnetNoticeDismissKey(notice: DevnetNotice): string {
  return `forge.devnet-notice.dismissed:${notice}`
}
