/**
 * The operator's notice and write pause (GAP-06 / INC-06): a build-time switch that works on
 * every network, for the day a client bug or a bad deploy needs "stop writes, keep reads" without
 * a code change. Set the repository variables and run `pages.yml` by `workflow_dispatch`
 * (`docs/hosting.md`, "Pausing the site"); the new build is live in a few minutes.
 *
 * `NEXT_PUBLIC_PAGES_NOTICE` (the Pages variable `PAGES_NOTICE`):
 *
 * - unset or empty: nothing;
 * - `advisory`: a banner on every page that cannot be dismissed, linking the advisory;
 * - `paused`: the same banner, and writes are off everywhere: `writesPausedReason()` is set, so
 *   every write button says why and `assertWritesAllowed()` refuses each broadcast before anything
 *   is signed or paid.
 *
 * `NEXT_PUBLIC_PAGES_NOTICE_TEXT` (`PAGES_NOTICE_TEXT`) is the reason, a sentence or two shown in
 * the banner and on the write buttons; `NEXT_PUBLIC_PAGES_NOTICE_URL` (`PAGES_NOTICE_URL`) is the
 * advisory's https address (default: the repository's security page). Any other mode, a text over
 * {@link MAX_TEXT} characters or a URL that is not https fails the build, so a typo cannot leave
 * the notice silently off.
 *
 * This is the lever for a bug in the client. A compromised build can ignore its own pause, so for
 * a compromised origin the first step is Cloudflare, not this variable (`docs/hosting.md`).
 */

import { REPO_URL } from './build-info'

export type PagesNoticeMode = 'advisory' | 'paused'

export interface PagesNotice {
  readonly mode: PagesNoticeMode
  /** The operator's reason, or null for the mode's default wording. */
  readonly text: string | null
  /** Where "read the advisory" goes (https). */
  readonly url: string
}

/** The longest reason accepted: it sits in a banner and in every write button's tooltip. */
export const MAX_TEXT = 400

/** Where the banner links when `PAGES_NOTICE_URL` is not set. */
export const DEFAULT_ADVISORY_URL = `${REPO_URL}/security`

/** The raw build variables. */
export interface PagesNoticeEnv {
  readonly mode: string | undefined
  readonly text: string | undefined
  readonly url: string | undefined
}

/** Parse the build variables. Null when no mode is set; throws on a typo, a long text or a non-https URL. */
export function parsePagesNotice(env: PagesNoticeEnv): PagesNotice | null {
  const mode = env.mode?.trim().toLowerCase() ?? ''
  if (mode === '') return null
  if (mode !== 'advisory' && mode !== 'paused') {
    throw new Error(`invalid NEXT_PUBLIC_PAGES_NOTICE "${env.mode}": expected "advisory", "paused" or nothing`)
  }
  const text = env.text?.trim().replace(/\s+/g, ' ') || null
  if (text !== null && text.length > MAX_TEXT) {
    throw new Error(`NEXT_PUBLIC_PAGES_NOTICE_TEXT is ${text.length} characters: at most ${MAX_TEXT}`)
  }
  const rawUrl = env.url?.trim() ?? ''
  let url = DEFAULT_ADVISORY_URL
  if (rawUrl !== '') {
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      throw new Error(`invalid NEXT_PUBLIC_PAGES_NOTICE_URL "${env.url}": expected an https address`)
    }
    if (parsed.protocol !== 'https:') {
      throw new Error(`invalid NEXT_PUBLIC_PAGES_NOTICE_URL "${env.url}": expected an https address`)
    }
    url = parsed.href
  }
  return { mode, text, url }
}

// `process.env.NEXT_PUBLIC_*` must be written out literally — Next inlines each at build time.
/** The notice this build shows, whatever the network. */
export const PAGES_NOTICE: PagesNotice | null = parsePagesNotice({
  mode: process.env.NEXT_PUBLIC_PAGES_NOTICE,
  text: process.env.NEXT_PUBLIC_PAGES_NOTICE_TEXT,
  url: process.env.NEXT_PUBLIC_PAGES_NOTICE_URL,
})

const DEFAULT_PAUSED = "Dash Forge's maintainers paused writes from this site while a problem is fixed. Reading still works."
const DEFAULT_ADVISORY = 'Read the advisory before you unlock or sign anything here.'

/** What the banner says, and what its link is called. */
export function pagesNoticeCopy(notice: PagesNotice): { readonly lead: string; readonly body: string; readonly link: string } {
  return notice.mode === 'paused'
    ? { lead: 'Writing is paused.', body: notice.text ?? DEFAULT_PAUSED, link: 'What happened' }
    : { lead: 'Security notice.', body: notice.text ?? DEFAULT_ADVISORY, link: 'Read the advisory' }
}

/** Why writes are off, or null when they are on: only the `paused` mode turns them off. */
export function pagesWritesPausedReason(notice: PagesNotice | null = PAGES_NOTICE): string | null {
  return notice?.mode === 'paused' ? `Writing is paused: ${notice.text ?? DEFAULT_PAUSED}` : null
}
