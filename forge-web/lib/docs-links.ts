import { REPO_URL } from './build-info'

/**
 * Where the app's help links go. The user guides render in the app's own docs hub (`/docs/…`,
 * lib/docs/catalog.ts, from the repository's `docs/` at build time), so these are in-app routes:
 * link them with Next's `<Link>`, which keeps the base path of a Pages or IPFS build. The few
 * documents the hub does not list stay on GitHub.
 */

export const DOCS = {
  /** The guides' index. */
  guides: '/docs/',
  quickStart: '/docs/quick-start/',
  install: '/docs/install/',
  identity: '/docs/identity-and-keys/',
  costs: '/docs/costs/',
  movingFromGithub: '/docs/moving-from-github/',
  storage: '/docs/bring-your-own-storage/',
  mirror: '/docs/mirror-a-github-repo/',
  mirrorKeepInSync: '/docs/mirror-a-github-repo/#3-keep-it-in-sync-without-the-action',
  mirrorPrivate: '/docs/mirror-a-github-repo/#into-a-private-repository',
  /** Which rules Dash Platform enforces and which the Forge apps apply (the EnforcedBy chip). */
  enforcement: '/docs/collaborating/#who-enforces-what',
  /** What a move to another network (the last devnet to testnet) loses and keeps, and how to re-push (the devnet notice, /networks). */
  devnetMove: '/docs/devnet-move/',
  /** Which mixed-visibility features are beta, and the limits that apply to all of them (the Beta badge's link). */
  knownLimitations: '/docs/collaborating/#known-limitations',
  /** What the hosted site hides from discovery and what that does and does not mean (not protocol moderation). */
  hostedCuration: '/docs/hosted-curation/',
  /** Every network Forge has run on, and what a devnet reset means. */
  networks: '/docs/networks/',
  /** What to do when a key may be compromised (disable all other keys, replace the encryption key). */
  revokeKeys: '/docs/revoke-keys/',
  /** Running your own storage and keeping pins in sync on a server of yours. */
  selfHost: `${REPO_URL}/blob/master/docs/self-host.md`,
  /** The normative private-repository design (key model, what is sealed, the threat model). */
  privateDesign: `${REPO_URL}/blob/master/docs/security/private-repos.md`,
} as const
