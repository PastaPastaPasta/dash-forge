/**
 * Deep links into Settings. A page that tells a member to add their encryption key links to
 * the Private repos card itself, not the top of a long page (QW2-016).
 */

/** The Private repos card's element id on /settings/ (`EncryptionKeyPanel`). */
export const PRIVATE_REPOS_ANCHOR = 'private-repos'

/** Settings → Private repos. */
export const PRIVATE_REPOS_SETTINGS = `/settings/#${PRIVATE_REPOS_ANCHOR}`
