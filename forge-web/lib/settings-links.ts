/**
 * Deep links into Settings. A page that tells a member to add their encryption key links to
 * the Members-only and private content card itself, not the top of a long page (QW2-016).
 */

/** The Members-only and private content card's element id on /settings/ (`EncryptionKeyPanel`). */
// The id predates the card's name; kept so existing links keep working.
export const PRIVATE_REPOS_ANCHOR = 'private-repos'

/** Settings → Members-only and private content. */
export const PRIVATE_REPOS_SETTINGS = `/settings/#${PRIVATE_REPOS_ANCHOR}`
